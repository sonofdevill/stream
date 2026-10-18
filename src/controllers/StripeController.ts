// =============================================================================
// GEMSTREAM — src/controllers/StripeController.ts
//
// Handles two distinct Stripe interaction surfaces:
//   POST /stripe/checkout   — Creates a Checkout Session and returns the URL
//   POST /stripe/webhook    — Receives and processes Stripe webhook events
//
// WEBHOOK CRITICAL REQUIREMENT (§5):
//   The webhook route MUST be mounted with `express.raw({ type: 'application/json' })`
//   BEFORE `express.json()` in the middleware chain. Stripe's HMAC is computed over
//   the exact raw request bytes — JSON parsing changes whitespace and key ordering,
//   corrupting the HMAC and causing every valid webhook to fail verification.
//   See routes/index.ts for the correct mounting order.
// =============================================================================

import { Request, Response } from "express";
import {
  StripeService,
  type CreateCheckoutSessionInput,
} from "../services/StripeService";

export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  // ===========================================================================
  // POST /stripe/checkout
  // Creates a Stripe Checkout Session for a Gem bundle purchase.
  //
  // REQUEST BODY:
  //   { viewerId: string, bundleId: string, email: string,
  //     successUrl: string, cancelUrl: string }
  //
  // RESPONSE 201:
  //   { checkoutUrl: string, sessionId: string }
  //
  // ERRORS:
  //   400 — Missing required fields or unknown bundleId
  //   500 — Stripe API failure
  // ===========================================================================

  /**
   * Creates a 3DS-enforced Stripe Checkout Session for a Gem bundle purchase.
   * Returns the hosted checkout URL for the client to redirect the Viewer to.
   */
  createCheckoutSession = async (req: Request, res: Response): Promise<void> => {
    try {
      const { viewerId, bundleId, email, successUrl, cancelUrl } = req.body as CreateCheckoutSessionInput;

      // Basic presence validation — StripeService validates business logic
      if (!viewerId || !bundleId || !email || !successUrl || !cancelUrl) {
        res.status(400).json({
          error: "BAD_REQUEST",
          message: "Missing required fields: viewerId, bundleId, email, successUrl, cancelUrl.",
        });
        return;
      }

      const result = await this.stripeService.createCheckoutSession({
        viewerId,
        bundleId,
        email,
        successUrl,
        cancelUrl,
      });

      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message });
    }
  };

  // ===========================================================================
  // POST /stripe/webhook
  // Receives Stripe webhook events and processes confirmed payments.
  //
  // IMPORTANT: This route must receive a raw Buffer body (not parsed JSON).
  //            Mount it with express.raw({ type: 'application/json' }) in routes.
  //
  // REQUEST HEADERS:
  //   stripe-signature: <Stripe-Signature header value>
  //
  // REQUEST BODY:
  //   Raw Buffer — the unmodified HTTP request body bytes
  //
  // RESPONSE 200:
  //   { received: true, outcome: "processed" | "skipped", stripeEventId: string }
  //
  // ERRORS:
  //   400 — Invalid Stripe signature (StripeSignatureVerificationError)
  //   500 — Internal processing failure
  // ===========================================================================

  /**
   * Processes inbound Stripe webhook events.
   *
   * Always returns 200 for valid signatures (even on skipped/idempotent events)
   * so Stripe stops retrying. Returns 400 only for invalid signatures —
   * Stripe treats non-2xx as transient failures and retries indefinitely.
   */
  handleWebhook = async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers["stripe-signature"] as string;

    if (!signature) {
      res.status(400).json({
        error: "BAD_REQUEST",
        message: "Missing Stripe-Signature header.",
      });
      return;
    }

    try {
      // req.body is a Buffer here because this route is mounted with express.raw()
      const result = await this.stripeService.handleWebhook(
        req.body as Buffer,
        signature
      );

      res.status(200).json({ received: true, ...result });
    } catch (error) {
      // Stripe SDK sets error.type (not error.name) for signature errors
      const errorType = (error as { type?: string }).type;

      if (errorType === "StripeSignatureVerificationError") {
        // Bad signature = reject with 400 (not retryable by Stripe)
        res.status(400).json({
          error: "INVALID_SIGNATURE",
          message: "Stripe webhook signature verification failed.",
        });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message });
    }
  };
}
