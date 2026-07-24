// =============================================================================
// GEMSTREAM — src/services/StripeService.ts
// Production Implementation v1.0.0
//
// GOVERNING AXIOMS (see SYSTEM_ARCHITECTURE.md §2, §5):
//   Axiom 2.2 — All fiat amounts are Integer cents. $11.50 = 1150. No floats.
//   §5 3D-Secure  — `request_three_d_secure: 'any'` is MANDATORY on every session.
//   §5 Idempotency — Duplicate Stripe Event IDs are detected and skipped inside
//                    the transaction to prevent TOCTOU double-grants.
//   §5 Signature   — `stripe.webhooks.constructEvent` with the raw Buffer is
//                    ALWAYS the first operation in handleWebhook. No exceptions.
//
// DEPENDENCIES:
//   - stripe           (official Stripe Node SDK)
//   - @prisma/client   (PostgreSQL ORM)
//   - src/types/ledger.ts (GemInt, toGemInt, Axiom 2.2 runtime guards)
//
// ENVIRONMENT VARIABLES REQUIRED:
//   STRIPE_SECRET_KEY        — Stripe API secret (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET    — Stripe webhook signing secret (whsec_...)
// =============================================================================

import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import { toGemInt, type GemInt } from "../types/ledger";

// =============================================================================
// GEM BUNDLE CATALOGUE
//
// The single source of truth for all purchasable Gem bundles.
// This map is the bridge between the Stripe checkout (fiat) and the ledger (Gems).
//
// AXIOM 2.2 COMPLIANCE:
//   `priceCents` is always a whole integer. $11.50 → 1150. Never 11.5 or 11.50.
//   `gemsGranted` is always a whole integer. No fractional Gems exist.
//
// When adding new bundles, only this map needs updating — createCheckoutSession
// and handleWebhook resolve bundle details by ID from this single definition.
// =============================================================================

interface GemBundle {
  /** Human-readable label for the Stripe line item */
  name: string;
  /** Whole Gems credited to Viewer.gemBalance on purchase (Axiom 2.2) */
  gemsGranted: number;
  /**
   * Price charged to the Viewer in integer USD cents (Axiom 2.2).
   * Includes Stripe fee absorption and SaaS margin (§5 Package Buffer Pricing).
   * 100 Gems → $10.00 ledger value → sold at $11.50 → priceCents = 1150.
   */
  priceCents: number;
}

const GEM_BUNDLES: Readonly<Record<string, GemBundle>> = {
  "100_GEMS": {
    name: "100 Gems Bundle",
    gemsGranted: 100,
    priceCents: 1150, // $11.50 USD — absorbs Stripe fee (2.9% + $0.30) + margin (§5)
  },
  // Future bundles (e.g., "500_GEMS", "1000_GEMS") are added here only.
} as const;

// =============================================================================
// INPUT / OUTPUT DTOs
// These mirror the interfaces in StripeService.test.ts exactly.
// =============================================================================

export interface CreateCheckoutSessionInput {
  /** UUID of the Viewer purchasing the bundle */
  viewerId: string;
  /** Gem bundle identifier, must be a key in GEM_BUNDLES */
  bundleId: string;
  /** Viewer's email for Stripe-generated receipts */
  email: string;
  /** Absolute URL for post-payment redirect on success */
  successUrl: string;
  /** Absolute URL for post-payment redirect on cancellation */
  cancelUrl: string;
}

export interface CreateCheckoutSessionResult {
  /** Stripe-hosted checkout URL. Redirect the Viewer here immediately. */
  checkoutUrl: string;
  /** Stripe Session ID for client-side `stripe.redirectToCheckout()` */
  sessionId: string;
}

export interface HandleWebhookResult {
  /** "processed" on first delivery; "skipped" on duplicate Event ID */
  outcome: "processed" | "skipped";
  stripeEventId: string;
  /** Gems granted to the Viewer — present only when outcome === "processed" */
  gemsGranted?: number;
  /** Viewer who received the Gems — present only when outcome === "processed" */
  viewerId?: string;
}

// =============================================================================
// CLASS: StripeService
// =============================================================================

/**
 * Manages GemStream's fiat on-ramp via Stripe Checkout (§5).
 *
 * Responsibilities:
 *  - Creating 3DS-enforced Checkout Sessions for Gem bundle purchases
 *  - Verifying and processing `checkout.session.completed` webhooks
 *  - Enforcing idempotency via the `ProcessedWebhooks` table (§5)
 *  - Atomically crediting Viewer Gem balances upon confirmed payment
 *  - Creating immutable `FiatDepositLog` records to anchor Gem grants (Axiom 2.3)
 *
 * This service does NOT handle the crypto off-ramp (CryptoService's domain)
 * or tip execution (LedgerService's domain).
 */
export class StripeService {
  private readonly stripe: Stripe;

  /**
   * @param prisma  - Injected PrismaClient for testability and connection sharing.
   * @param stripe  - Optional injected Stripe instance. When omitted (production),
   *                  the service self-initialises using `STRIPE_SECRET_KEY`.
   *                  Injection is used exclusively by the test suite.
   */
  constructor(
    private readonly prisma: PrismaClient,
    stripe?: Stripe
  ) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (stripe) {
      this.stripe = stripe;
    } else if (key) {
      this.stripe = new Stripe(key, {
        apiVersion: "2025-02-24.acacia",
        typescript: true,
      });
    } else {
      console.warn("[StripeService] STRIPE_SECRET_KEY not set — Stripe features disabled");
      this.stripe = null as unknown as Stripe;
    }
  }

  // ===========================================================================
  // PUBLIC METHOD: createCheckoutSession
  // ===========================================================================

  /**
   * Creates a Stripe Checkout Session for a Gem bundle purchase.
   *
   * CRITICAL BEHAVIOURS:
   *
   * 1. **3D-Secure Enforcement (§5 Mandatory):**
   *    `payment_method_options.card.request_three_d_secure` is set to `'any'`.
   *    This triggers 3DS for every card payment, shifting chargeback liability
   *    from GemStream to the card issuer. Omitting this is a financial risk
   *    the architecture explicitly prohibits.
   *
   * 2. **Integer Cents (Axiom 2.2):**
   *    `unit_amount` is the `priceCents` integer from `GEM_BUNDLES` — never
   *    a float. Stripe's API expects integer cents; $11.50 = 1150.
   *
   * 3. **Metadata for Webhook Correlation:**
   *    `viewerId`, `bundleId`, and `gemsGranted` are embedded in session metadata.
   *    When `checkout.session.completed` fires, `handleWebhook` reads this
   *    metadata to associate the payment with the correct Viewer and Gem grant.
   *    Without this metadata, the webhook handler has no way to credit Gems.
   *
   * @param input - CreateCheckoutSessionInput DTO
   * @returns Stripe checkout URL and session ID for client-side redirect
   * @throws Error if bundleId is not found in GEM_BUNDLES
   * @throws Stripe.errors.StripeError on Stripe API failure
   */
  async createCheckoutSession(
    input: CreateCheckoutSessionInput
  ): Promise<CreateCheckoutSessionResult> {
    // ── Bundle Lookup ─────────────────────────────────────────────────────────
    const bundle = GEM_BUNDLES[input.bundleId];

    if (!bundle) {
      throw new Error(
        `[StripeService] Unknown bundleId: "${input.bundleId}". ` +
          `Valid bundles: ${Object.keys(GEM_BUNDLES).join(", ")}`
      );
    }

    // ── Create Stripe Checkout Session ────────────────────────────────────────
    const session = await this.stripe.checkout.sessions.create({
      // One-time payment — NOT a subscription (§5, Test 1.5)
      mode: "payment",

      // Viewer email pre-fills the Stripe-hosted form and appears on receipts
      customer_email: input.email,

      // ── Line Item (Axiom 2.2: unit_amount is integer cents) ──────────────
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: bundle.priceCents, // Integer cents — e.g., 1150 for $11.50
            product_data: {
              name: bundle.name,           // e.g., "100 Gems Bundle"
              description: `${bundle.gemsGranted} Gems — valid for tipping on GemStream`,
            },
          },
        },
      ],

      // ── §5 CRITICAL: 3D-Secure Mandate ───────────────────────────────────
      // `request_three_d_secure: 'any'` forces 3DS authentication on every
      // card payment regardless of issuer risk assessment. This is a non-
      // negotiable requirement: it shifts liability to the issuer, meaning
      // authenticated chargebacks are denied at the network level, protecting
      // GemStream's chargeback rate and the 14-day clearing fortress (§3).
      payment_method_options: {
        card: {
          request_three_d_secure: "any",
        },
      },

      // ── Post-Payment Redirects ────────────────────────────────────────────
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,

      // ── Webhook Correlation Metadata ─────────────────────────────────────
      // These three fields are the ONLY link between this Checkout Session
      // and the Viewer/Gem grant when `checkout.session.completed` fires.
      // Stripe metadata values are always strings — gemsGranted is stringified
      // here and parsed back to integer inside handleWebhook.
      metadata: {
        viewerId: input.viewerId,
        bundleId: input.bundleId,
        gemsGranted: String(bundle.gemsGranted),
      },
    });

    // Stripe guarantees `url` is non-null for Checkout Sessions
    if (!session.url) {
      throw new Error(
        `[StripeService] Stripe returned a session without a URL. Session ID: ${session.id}`
      );
    }

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  }

  // ===========================================================================
  // PUBLIC METHOD: handleWebhook
  // ===========================================================================

  /**
   * Processes an inbound Stripe webhook event.
   *
   * OPERATION ORDER (strictly enforced — see §5 and test comments):
   *
   *   1. **Signature Verification (FIRST — always)**
   *      `stripe.webhooks.constructEvent()` with the raw `Buffer` and
   *      `process.env.STRIPE_WEBHOOK_SECRET`. Any tampered or replayed
   *      request throws immediately. Zero DB access on failure.
   *
   *   2. **Event Type Guard**
   *      Only `checkout.session.completed` triggers ledger writes.
   *      All other event types return `outcome: 'skipped'` silently —
   *      Stripe must receive a 2xx response to stop retrying.
   *
   *   3. **ACID Transaction (§4)**
   *      Inside `prisma.$transaction`, in order:
   *        a. Idempotency check — `ProcessedWebhooks.findUnique(stripeEventId)`
   *           If found: return `outcome: 'skipped'` immediately (no writes).
   *        b. `ProcessedWebhooks.create` — claims the Event ID as processed.
   *        c. `FiatDepositLog.create` — immutable audit record (Axiom 2.3).
   *        d. `User.update { gemBalance: { increment } }` — atomic Gem credit.
   *      If any step throws, all four roll back automatically.
   *
   * WHY THE IDEMPOTENCY CHECK IS INSIDE THE TRANSACTION:
   *   An out-of-transaction check creates a TOCTOU window: two simultaneous
   *   Stripe retries could both read `null` from ProcessedWebhooks, pass the
   *   guard, and both proceed to grant Gems. PostgreSQL's row-level locking
   *   inside the transaction ensures exactly one write wins; the other either
   *   sees the existing record or hits the unique constraint on `stripeEventId`.
   *
   * WHY THE RAW BUFFER MATTERS:
   *   Stripe's HMAC is computed over the exact raw request bytes. If the body
   *   is parsed to JSON and re-serialised before this call, key ordering and
   *   whitespace differences corrupt the HMAC and every valid webhook fails.
   *   The Express route mounting this handler MUST use:
   *   `express.raw({ type: 'application/json' })` — not `express.json()`.
   *
   * @param rawBody   - The raw HTTP request body as a `Buffer` (not parsed JSON)
   * @param signature - The value of the `Stripe-Signature` request header
   * @returns HandleWebhookResult — `outcome: 'processed'` or `'skipped'`
   * @throws Stripe.errors.StripeSignatureVerificationError on bad signature
   */
  async handleWebhook(
    rawBody: Buffer,
    signature: string
  ): Promise<HandleWebhookResult> {
    // ── STEP 1: Signature Verification — MUST BE FIRST (§5) ──────────────────
    //
    // This call throws `StripeSignatureVerificationError` if:
    //   - The signature header is missing or malformed
    //   - The HMAC doesn't match (tampered body or wrong secret)
    //   - The timestamp is outside Stripe's tolerance window (replay attack)
    //
    // We do NOT catch this error. It propagates to the Express error handler,
    // which returns HTTP 400 — telling Stripe the delivery was invalid (not
    // retryable), as opposed to HTTP 500 which would trigger retries.
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET ?? ""
    );

    // ── STEP 2: Event Type Guard ──────────────────────────────────────────────
    //
    // GemStream only grants Gems on confirmed, paid checkout sessions.
    // All other event types (payment_intent.created, customer.updated, etc.)
    // are silently skipped. Returning a resolved promise here signals to the
    // Express route handler to respond with HTTP 200 — stopping Stripe retries.
    if (event.type !== "checkout.session.completed") {
      return {
        outcome: "skipped",
        stripeEventId: event.id,
      };
    }

    // ── STEP 3: Extract Payload ───────────────────────────────────────────────
    //
    // The session object was set up by createCheckoutSession. The metadata
    // fields are the only authoritative link back to the Viewer and bundle.
    const session = event.data.object as Stripe.Checkout.Session;
    const { viewerId, bundleId, gemsGranted: gemsGrantedStr } = session.metadata ?? {};

    if (!viewerId || !bundleId || !gemsGrantedStr) {
      // This indicates a session was completed that wasn't created by StripeService
      // (e.g., a manually created Stripe session in the dashboard). Log and skip
      // rather than throw — we don't want Stripe to retry a structurally invalid event.
      console.error(
        `[StripeService] checkout.session.completed event ${event.id} is missing ` +
          `required metadata fields (viewerId, bundleId, gemsGranted). Skipping.`
      );
      return {
        outcome: "skipped",
        stripeEventId: event.id,
      };
    }

    // ── Axiom 2.2: Parse gemsGranted as a safe integer ───────────────────────
    // Stripe metadata values are always strings. `toGemInt` validates that the
    // parsed value is a positive whole integer before any ledger write occurs.
    const gemsGranted: GemInt = toGemInt(parseInt(gemsGrantedStr, 10));

    // Resolve the bundle for `amountPaidCents` — needed for FiatDepositLog.
    // If the bundle no longer exists in our catalogue, use 0 as a sentinel
    // (the record is still valuable for audit even without the price).
    const bundle = GEM_BUNDLES[bundleId];
    const amountPaidCents = bundle?.priceCents ?? 0;

    const stripePaymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : (session.payment_intent?.id ?? "");

    // ── STEP 4: ACID Transaction (§4 Atomicity Mandate) ──────────────────────
    const result = await this.prisma.$transaction(async (tx) => {
      // ── 4a: Idempotency Check (INSIDE transaction — TOCTOU prevention) ────
      //
      // By reading and writing ProcessedWebhooks within the same transaction,
      // PostgreSQL's row-level locking ensures that two concurrent webhook
      // deliveries cannot both pass this check and both grant Gems.
      // The second concurrent tx either reads the row written by the first,
      // or races to insert and loses on the unique constraint — both outcomes
      // result in exactly one Gem grant.
      const alreadyProcessed = await tx.processedWebhooks.findUnique({
        where: { stripeEventId: event.id },
      });

      if (alreadyProcessed) {
        // Return a sentinel object. The outer method maps this to `outcome: 'skipped'`.
        return { skipped: true as const, stripeEventId: event.id };
      }

      // ── 4b: Claim the Event ID ────────────────────────────────────────────
      //
      // Written BEFORE the Gem grant. If the Gem grant subsequently fails,
      // the entire transaction rolls back — including this write — so the
      // event remains unprocessed and Stripe's next retry will succeed.
      await tx.processedWebhooks.create({
        data: { stripeEventId: event.id },
      });

      // ── 4c: Create Immutable FiatDepositLog (Axiom 2.3) ──────────────────
      //
      // This record is the paper trail anchoring the Gem grant to a real,
      // confirmed Stripe payment. LedgerService's chargeback handler uses
      // `stripePaymentIntentId` to locate this log and reverse associated tips.
      await tx.fiatDepositLog.create({
        data: {
          viewerId,
          gemsGranted,                 // GemInt — whole integer (Axiom 2.2)
          amountPaidCents,             // Integer cents — e.g., 1150 (Axiom 2.2)
          stripePaymentIntentId,       // Links to Stripe charge for chargeback sweep
          stripeEventId: event.id,     // Links to ProcessedWebhooks for audit
        },
      });

      // ── 4d: Atomically Increment Viewer's Gem Balance ─────────────────────
      //
      // Uses Prisma's `{ increment }` operator → SQL: SET gem_balance = gem_balance + N
      // This is a single atomic UPDATE — not a read-modify-write. Two concurrent
      // top-ups for the same Viewer will both apply correctly without a race
      // condition, because each is an independent atomic increment at the DB level.
      await tx.user.update({
        where: { id: viewerId },
        data: {
          gemBalance: { increment: gemsGranted },
        },
      });

      return {
        skipped: false as const,
        stripeEventId: event.id,
        gemsGranted,
        viewerId,
      };
    });

    // ── Map transaction result to public return type ──────────────────────────
    if (result.skipped) {
      return {
        outcome: "skipped",
        stripeEventId: result.stripeEventId,
      };
    }

    return {
      outcome: "processed",
      stripeEventId: result.stripeEventId,
      gemsGranted: result.gemsGranted,
      viewerId: result.viewerId,
    };
  }
}
