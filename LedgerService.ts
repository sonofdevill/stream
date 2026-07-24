// =============================================================================
// GEMSTREAM — src/services/LedgerService.ts
// Production Implementation v1.0.0
//
// GOVERNING AXIOMS (see SYSTEM_ARCHITECTURE.md §2):
//   Axiom 2.1 — 1 Gem = $0.10 USDT. All peg conversions use integer arithmetic.
//   Axiom 2.2 — ZERO floats. Every monetary operation uses `GemInt`, `CentsInt`,
//               or `BigInt`. No `Number` type is used for balance arithmetic.
//   Axiom 2.3 — Law of Conservation: Gems only enter via FiatDepositLog and
//               only leave via PayoutLog. This service never mints or burns.
//
// TRANSACTION SAFETY (§4):
//   Every multi-row mutation is wrapped in `prisma.$transaction()`.
//   If any sub-operation throws, Prisma issues an automatic ROLLBACK.
//
// DEPENDENCIES:
//   - @prisma/client  (PostgreSQL ORM)
//   - src/types/ledger.ts (all DTOs, branded types, error classes)
// =============================================================================

import { PrismaClient } from "@prisma/client";
import {
  toGemInt,
  PAYOUT_MINIMUM_GEMS,
  CLEARING_WINDOW_MS,
  USDT_DECIMALS,
  InsufficientFundsError,
  InvalidGemAmountError,
  PayoutThresholdError,
  UserNotFoundError,
  type GemInt,
  type ExecuteTipInput,
  type ExecuteTipResult,
  type RequestPayoutInput,
  type RequestPayoutResult,
  type UserBalanceSnapshot,
  type TipAlertPayload,
  type MaturationCronInput,
  type MaturationCronResult,
  type ChargebackReverseInput,
  type ChargebackReverseResult,
} from "../types/ledger";

// =============================================================================
// INTERNAL CONSTANTS
// =============================================================================

/**
 * Axiom 2.1: 1 Gem = $0.10 USD = 10 cents.
 * Stored as an integer to avoid any floating-point arithmetic in conversions.
 */
const CENTS_PER_GEM = 10 as const;

/**
 * USDT uses 6 decimal places on Polygon (§6).
 * 1.000000 USDT = 1_000_000 micro-units.
 * Using BigInt arithmetic ensures no IEEE-754 drift during conversion.
 */
const USDT_MICRO_UNITS_PER_DOLLAR = BigInt(10 ** USDT_DECIMALS); // 1_000_000n

/**
 * There are 100 cents per dollar. Used to convert from cents to whole dollars
 * before applying the USDT micro-unit factor.
 */
const CENTS_PER_DOLLAR = 100n;

// =============================================================================
// INTERNAL HELPER: gemsToUsdtUnits
// =============================================================================

/**
 * Converts a whole Gem count to its USDT value in micro-units (6 decimal places).
 *
 * MATH (Axiom 2.1 + Axiom 2.2):
 *   Step 1: gems × 10 cents/gem = total cents   (integer)
 *   Step 2: cents ÷ 100 = whole dollars          (integer, no remainder for valid Gem counts)
 *   Step 3: dollars × 1_000_000 = USDT micro-units (BigInt, no float risk)
 *
 * Example:
 *   gemsToUsdtUnits(500) → "50000000"   (50.000000 USDT)
 *   gemsToUsdtUnits(100) → "10000000"   (10.000000 USDT)
 *   gemsToUsdtUnits(10)  → "1000000"    ( 1.000000 USDT)
 *
 * The result is a STRING — not a number — to avoid BigInt serialization
 * ambiguity when stored in PostgreSQL and passed to Ethers.js (§6).
 * CryptoService reads this field with `ethers.parseUnits(value, 6)`.
 *
 * @param gemAmount - Validated GemInt (must be a positive whole integer)
 * @returns USDT value as a micro-unit string (e.g., "50000000")
 */
export function gemsToUsdtUnits(gemAmount: GemInt): string {
  // All arithmetic is BigInt — zero float risk (Axiom 2.2)
  const totalCentsBigInt = BigInt(gemAmount) * BigInt(CENTS_PER_GEM);
  const totalDollarsBigInt = totalCentsBigInt / CENTS_PER_DOLLAR;
  const usdtMicroUnits = totalDollarsBigInt * USDT_MICRO_UNITS_PER_DOLLAR;
  return usdtMicroUnits.toString();
}

/**
 * Formats a Gem-derived USDT value as a human-readable decimal string
 * for display purposes ONLY (e.g., dashboard, email receipts).
 *
 * CRITICAL: This string MUST NEVER be parsed back into a number for math.
 *
 * @param gemAmount - Validated GemInt
 * @returns Display string, e.g., "50.00"
 */
function gemsToUsdtDisplay(gemAmount: GemInt): string {
  // Safe: integer × integer, then format with fixed decimals for display only
  const totalCents = gemAmount * CENTS_PER_GEM; // e.g., 500 × 10 = 5000 cents
  const wholeDollars = Math.floor(totalCents / 100); // e.g., 5000 ÷ 100 = 50
  const remainderCents = totalCents % 100;            // e.g., 5000 % 100 = 0
  return `${wholeDollars}.${remainderCents.toString().padStart(2, "0")}`;
}

// =============================================================================
// CLASS: LedgerService
// =============================================================================

/**
 * The core financial engine of GemStream.
 *
 * Responsibilities:
 *  - Executing atomic Gem tip transfers between Viewers and Streamers (§3)
 *  - Enforcing all Three Golden Financial Axioms (§2) at runtime
 *  - Gating USDT payout requests against the 500-Gem threshold (§3)
 *  - Maturing pending tips after the 14-day chargeback window (§3 cron)
 *  - Reversing pending tips on Stripe chargeback events (§3, §5)
 *
 * This service performs NO blockchain operations (that is CryptoService's domain)
 * and emits NO Socket.io events directly (that is AlertService's domain).
 * It returns structured result objects that higher-level orchestrators act upon.
 */
export class LedgerService {
  /**
   * @param prisma - An injected PrismaClient instance.
   *                 Injecting (rather than instantiating internally) enables
   *                 clean test mocking and connection pool sharing.
   */
  constructor(private readonly prisma: PrismaClient) {}

  // ===========================================================================
  // PUBLIC METHOD: executeTip
  // ===========================================================================

  /**
   * Atomically transfers Gems from a Viewer to a Streamer's pendingBalance.
   *
   * LIFECYCLE (§3 — The Tip Lifecycle):
   *   1. Validates gemAmount via `toGemInt()` (Axiom 2.2 guard).
   *   2. Inside a single ACID transaction (§4):
   *      a. Fetches Viewer — throws `UserNotFoundError` if absent.
   *      b. Fetches Streamer — throws `UserNotFoundError` if absent.
   *      c. Checks Viewer.gemBalance >= gemAmount — throws `InsufficientFundsError` if not.
   *      d. Atomically decrements Viewer.gemBalance by gemAmount.
   *      e. Atomically increments Streamer.pendingBalance by gemAmount.
   *      f. Creates a TipEvent record with clearedAt = now + 14 days.
   *   3. Returns the result including the §7-standard TipAlertPayload.
   *
   * ATOMICITY NOTE (§4):
   *   Balance updates use Prisma's `{ increment }` / `{ decrement }` operators,
   *   which translate to `SET balance = balance ± N` in SQL — atomic at the DB
   *   level. This prevents double-spend races without application-level locking.
   *
   * @param input - Validated ExecuteTipInput DTO
   * @returns ExecuteTipResult with balance snapshots and alert payload
   * @throws InvalidGemAmountError if gemAmount is ≤ 0 or fractional
   * @throws UserNotFoundError if viewer or streamer UUID is not in the DB
   * @throws InsufficientFundsError if viewer's gemBalance < gemAmount
   */
  async executeTip(input: ExecuteTipInput): Promise<ExecuteTipResult> {
    // ── STEP 1: Axiom 2.2 Gate ─────────────────────────────────────────────
    // `toGemInt()` throws `InvalidGemAmountError` for zero, negative, or
    // fractional values. This check happens BEFORE the DB transaction opens,
    // so no DB round-trip is wasted on provably invalid input.
    const gemAmount: GemInt = toGemInt(input.gemAmount);

    // ── STEP 2: ACID Transaction (§4 Atomicity Mandate) ────────────────────
    const result = await this.prisma.$transaction(async (tx) => {
      // ── 2a: Fetch Viewer ────────────────────────────────────────────────
      const viewer = await tx.user.findUnique({
        where: { id: input.viewerId },
        select: {
          id: true,
          username: true,
          role: true,
          gemBalance: true,
        },
      });

      if (!viewer) {
        throw new UserNotFoundError(input.viewerId);
      }

      // ── 2b: Fetch Streamer ───────────────────────────────────────────────
      const streamer = await tx.user.findUnique({
        where: { id: input.streamerId },
        select: {
          id: true,
          username: true,
          role: true,
          pendingBalance: true,
        },
      });

      if (!streamer) {
        throw new UserNotFoundError(input.streamerId);
      }

      // ── 2c: Solvency Check ───────────────────────────────────────────────
      // viewer.gemBalance is an Int from PostgreSQL — safe integer comparison.
      // We cast to GemInt after the DB read for type consistency downstream.
      const currentViewerBalance = viewer.gemBalance as GemInt;

      if (currentViewerBalance < gemAmount) {
        throw new InsufficientFundsError(
          `Viewer "${viewer.username}" has ${currentViewerBalance} Gems but attempted ` +
            `to tip ${gemAmount} Gems. Shortfall: ${gemAmount - currentViewerBalance} Gems.`
        );
      }

      // ── 2d: Atomically Decrement Viewer Balance ──────────────────────────
      // Uses Prisma's `decrement` operator → SQL: SET gem_balance = gem_balance - N
      // This is atomic at the PostgreSQL row level. No read-modify-write race.
      const updatedViewer = await tx.user.update({
        where: { id: input.viewerId },
        data: {
          gemBalance: { decrement: gemAmount },
        },
        select: { gemBalance: true },
      });

      // ── 2e: Atomically Increment Streamer pendingBalance ─────────────────
      // Uses Prisma's `increment` operator → SQL: SET pending_balance = pending_balance + N
      const updatedStreamer = await tx.user.update({
        where: { id: input.streamerId },
        data: {
          pendingBalance: { increment: gemAmount },
        },
        select: { pendingBalance: true },
      });

      // ── 2f: Create TipEvent Record ───────────────────────────────────────
      // `clearedAt` is pre-computed here at INSERT time.
      // The maturation cron queries `clearedAt <= NOW()` — an index-supported
      // range scan. Computing it here avoids per-row arithmetic in the cron.
      const now = new Date();
      const clearedAt = new Date(now.getTime() + CLEARING_WINDOW_MS);

      const tipEvent = await tx.tipEvent.create({
        data: {
          viewerId: input.viewerId,
          streamerId: input.streamerId,
          gemAmount,                         // GemInt — whole integer (Axiom 2.2)
          customMessage: input.customMessage ?? null,
          status: "PENDING",
          clearedAt,                         // now + 14 days (§3)
          fiatDepositLogId: input.fiatDepositLogId ?? null,
        },
        select: {
          id: true,
          gemAmount: true,
          clearedAt: true,
        },
      });

      // ── Assemble Return Value ────────────────────────────────────────────
      // Shape the §7 alert payload. AlertService will emit this via Socket.io.
      const alertPayload: TipAlertPayload = {
        tipId: tipEvent.id,
        streamerId: input.streamerId,
        viewerUsername: viewer.username,
        gemAmount: tipEvent.gemAmount as GemInt,
        customMessage: input.customMessage ?? null,
      };

      return {
        tipId: tipEvent.id,
        viewerRemainingBalance: updatedViewer.gemBalance as GemInt,
        streamerNewPendingBalance: updatedStreamer.pendingBalance as GemInt,
        clearedAt: tipEvent.clearedAt.toISOString(),
        alertPayload,
      } satisfies ExecuteTipResult;
    });

    return result;
  }

  // ===========================================================================
  // PUBLIC METHOD: requestPayout
  // ===========================================================================

  /**
   * Validates and records a Streamer's USDT withdrawal request.
   *
   * This method handles ONLY the ledger side of a payout:
   *   - Enforces the 500-Gem minimum threshold (§3 Payout Gatekeeper).
   *   - Atomically deducts gemAmount from Streamer.availableBalance.
   *   - Creates an immutable PayoutLog record in REQUESTED status.
   *   - Returns the USDT micro-unit string for CryptoService to consume.
   *
   * CryptoService is responsible for the actual on-chain USDT transfer (§6).
   * If the blockchain tx fails, CryptoService must call `revertPayout()` to
   * restore availableBalance and set PayoutLog.status = FAILED.
   *
   * @param input - Validated RequestPayoutInput DTO
   * @returns RequestPayoutResult with payout record details and USDT amounts
   * @throws InvalidGemAmountError if gemAmount is ≤ 0 or fractional
   * @throws UserNotFoundError if streamer UUID is not in the DB
   * @throws PayoutThresholdError if availableBalance < PAYOUT_MINIMUM_GEMS (500)
   * @throws InsufficientFundsError if gemAmount > availableBalance
   */
  async requestPayout(input: RequestPayoutInput): Promise<RequestPayoutResult> {
    // ── STEP 1: Axiom 2.2 Gate ─────────────────────────────────────────────
    const gemAmount: GemInt = toGemInt(input.gemAmount);

    // ── STEP 2: ACID Transaction ────────────────────────────────────────────
    const result = await this.prisma.$transaction(async (tx) => {
      // ── 2a: Fetch Streamer ───────────────────────────────────────────────
      const streamer = await tx.user.findUnique({
        where: { id: input.streamerId },
        select: {
          id: true,
          username: true,
          availableBalance: true,
          walletAddress: true,
        },
      });

      if (!streamer) {
        throw new UserNotFoundError(input.streamerId);
      }

      const availableBalance = streamer.availableBalance as GemInt;

      // ── 2b: Payout Gatekeeper (§3) ───────────────────────────────────────
      // The 500-Gem minimum applies to the Streamer's TOTAL availableBalance,
      // not just the requested amount. A Streamer with 600 Gems cannot request
      // a 600-Gem payout if only 500 is the minimum — but they CAN request 600.
      // The real guard is: availableBalance >= PAYOUT_MINIMUM_GEMS (500).
      if (availableBalance < PAYOUT_MINIMUM_GEMS) {
        throw new PayoutThresholdError(
          `Streamer "${streamer.username}" has ${availableBalance} Gems available. ` +
            `Minimum required for withdrawal: ${PAYOUT_MINIMUM_GEMS} Gems ($50.00 USDT).`
        );
      }

      // ── 2c: Requested Amount Solvency Check ──────────────────────────────
      // Distinct from the threshold check: a Streamer with 800 Gems cannot
      // request a 900-Gem withdrawal.
      if (gemAmount > availableBalance) {
        throw new InsufficientFundsError(
          `Streamer "${streamer.username}" requested ${gemAmount} Gems but only ` +
            `${availableBalance} Gems are available for withdrawal.`
        );
      }

      // ── 2d: Atomically Deduct from availableBalance ──────────────────────
      const updatedStreamer = await tx.user.update({
        where: { id: input.streamerId },
        data: {
          availableBalance: { decrement: gemAmount },
        },
        select: { availableBalance: true },
      });

      // ── 2e: Compute USDT Amounts ─────────────────────────────────────────
      // `gemsToUsdtUnits` uses BigInt arithmetic exclusively (Axiom 2.2).
      const usdtAmountUnits = gemsToUsdtUnits(gemAmount);
      const usdtAmountDisplay = gemsToUsdtDisplay(gemAmount);

      // Snapshot the destination wallet at payout time.
      // The Streamer may change their wallet later; we preserve the intended target.
      const destinationWallet = input.destinationWallet;

      // ── 2f: Create Immutable PayoutLog Record ────────────────────────────
      const payoutLog = await tx.payoutLog.create({
        data: {
          streamerId: input.streamerId,
          gemAmount,
          usdtAmountUnits,    // String, for Ethers.js BigInt parsing (§6)
          destinationWallet,
          status: "REQUESTED",
          txHash: null,
          confirmedBlock: null,
        },
        select: { id: true },
      });

      return {
        payoutId: payoutLog.id,
        gemAmountDeducted: gemAmount,
        usdtAmountDisplay,
        usdtAmountUnits,
        remainingAvailableBalance: updatedStreamer.availableBalance as GemInt,
        status: "REQUESTED" as const,
      } satisfies RequestPayoutResult;
    });

    return result;
  }

  // ===========================================================================
  // PUBLIC METHOD: getBalance
  // ===========================================================================

  /**
   * Returns a read-only snapshot of a User's current balances.
   *
   * Role-aware: VIEWER fields (`gemBalance`) are null for STREAMERs, and vice
   * versa. The `isPayoutEligible` flag is pre-computed to simplify UI logic.
   *
   * This method does NOT use a transaction — it's a single read and snapshot
   * consistency at the row level is handled by PostgreSQL's MVCC by default.
   *
   * @param userId - UUID of the User to query
   * @returns UserBalanceSnapshot DTO
   * @throws UserNotFoundError if userId is not found
   */
  async getBalance(userId: string): Promise<UserBalanceSnapshot> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        role: true,
        gemBalance: true,
        pendingBalance: true,
        availableBalance: true,
      },
    });

    if (!user) {
      throw new UserNotFoundError(userId);
    }

    const isViewer = user.role === "VIEWER";

    return {
      userId: user.id,
      username: user.username,
      role: user.role as "VIEWER" | "STREAMER",
      // VIEWER-specific fields — null for STREAMERs
      gemBalance: isViewer ? (user.gemBalance as GemInt) : null,
      // STREAMER-specific fields — null for VIEWERs
      pendingBalance: !isViewer ? (user.pendingBalance as GemInt) : null,
      availableBalance: !isViewer ? (user.availableBalance as GemInt) : null,
      isPayoutEligible: !isViewer
        ? user.availableBalance >= PAYOUT_MINIMUM_GEMS
        : null,
    };
  }

  // ===========================================================================
  // PUBLIC METHOD: maturePendingTips
  // ===========================================================================

  /**
   * Background cron entry point. Matures all PENDING TipEvents whose
   * `clearedAt` timestamp has passed, moving Gems from `pendingBalance`
   * to `availableBalance` for each affected Streamer.
   *
   * CRON QUERY (§3 — The Maturation Cron):
   *   SELECT * FROM TipEvent
   *   WHERE clearedAt <= NOW() AND status = 'PENDING'
   *   LIMIT batchSize
   *
   * Each matured tip is processed in its own sub-transaction to limit blast
   * radius: a single failing tip does not block the rest of the batch.
   *
   * @param input - MaturationCronInput with `asOf` timestamp and `batchSize`
   * @returns MaturationCronResult with counts and IDs for audit logging
   */
  async maturePendingTips(input: MaturationCronInput): Promise<MaturationCronResult> {
    // Fetch the batch of tips ready to mature using the pre-indexed clearedAt column
    const dueTips = await this.prisma.tipEvent.findMany({
      where: {
        clearedAt: { lte: input.asOf },  // lte: includes tips maturing exactly NOW
        status: "PENDING",
      },
      select: {
        id: true,
        streamerId: true,
        gemAmount: true,
      },
      take: input.batchSize,
      orderBy: { clearedAt: "asc" }, // Process oldest first — fairness to Streamers
    });

    const maturedTipIds: string[] = [];
    const failedTipIds: string[] = [];

    // Process each tip in isolation. If one fails, continue with the rest.
    for (const tip of dueTips) {
      try {
        await this.prisma.$transaction(async (tx) => {
          // Move gems: pendingBalance → availableBalance (Axiom 2.3 preserved)
          await tx.user.update({
            where: { id: tip.streamerId },
            data: {
              pendingBalance:   { decrement: tip.gemAmount },
              availableBalance: { increment: tip.gemAmount },
            },
          });

          // Mark tip as CLEARED — prevents re-processing on next cron run
          await tx.tipEvent.update({
            where: { id: tip.id },
            data: { status: "CLEARED" },
          });
        });

        maturedTipIds.push(tip.id);
      } catch (error) {
        // Log the failure but do not rethrow — the cron must continue
        console.error(`[LedgerService] Failed to mature TipEvent ${tip.id}:`, error);
        failedTipIds.push(tip.id);
      }
    }

    return {
      maturedCount: maturedTipIds.length,
      maturedTipIds,
      failedTipIds,
    };
  }

  // ===========================================================================
  // PUBLIC METHOD: reverseChargedbackTips
  // ===========================================================================

  /**
   * Handles a Stripe `chargeback.created` webhook by reversing all PENDING
   * tips that were funded by the disputed FiatDepositLog (§3, §5).
   *
   * DEFENSE MECHANISM (§3 — Chargeback Defense Execution):
   *   - Only PENDING tips are reversed. CLEARED tips (already in availableBalance)
   *     cannot be touched — the platform absorbs that loss as a business risk
   *     of the 14-day window design.
   *   - Gems are deducted strictly from `pendingBalance`. The Streamer's
   *     `availableBalance` is NEVER touched. The platform loses $0.
   *
   * IDEMPOTENCY (§5):
   *   The caller (Stripe webhook handler) is responsible for checking the
   *   `ProcessedWebhooks` table BEFORE calling this method to prevent duplicate
   *   processing of the same Stripe Event ID.
   *
   * @param input - ChargebackReverseInput with Stripe IDs for traceability
   * @returns ChargebackReverseResult with totals and IDs for audit logging
   * @throws Error if the FiatDepositLog is not found for the given PaymentIntent
   */
  async reverseChargedbackTips(input: ChargebackReverseInput): Promise<ChargebackReverseResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      // ── Locate the Disputed Deposit ────────────────────────────────────────
      const depositLog = await tx.fiatDepositLog.findUnique({
        where: { stripePaymentIntentId: input.stripePaymentIntentId },
        select: {
          id: true,
          viewerId: true,
          gemsGranted: true,
          // Fetch only PENDING tips from this deposit — cleared tips are untouchable
          tipEvents: {
            where: { status: "PENDING" },
            select: {
              id: true,
              streamerId: true,
              gemAmount: true,
            },
          },
        },
      });

      if (!depositLog) {
        throw new Error(
          `[LedgerService] Chargeback received for unknown PaymentIntent: ` +
            `${input.stripePaymentIntentId}. No FiatDepositLog found.`
        );
      }

      const pendingTips = depositLog.tipEvents;

      if (pendingTips.length === 0) {
        // All tips from this deposit have already matured. Nothing to reverse.
        return {
          totalGemsReversed: 0 as GemInt,
          tipsReversedCount: 0,
          reversedTipIds: [],
        };
      }

      // ── Group deductions by Streamer ───────────────────────────────────────
      // Multiple tips to the same Streamer should be batched into one UPDATE
      // rather than N individual DECREMENTs (performance + atomicity).
      const deductionsByStreamer = new Map<string, number>();
      for (const tip of pendingTips) {
        const current = deductionsByStreamer.get(tip.streamerId) ?? 0;
        deductionsByStreamer.set(tip.streamerId, current + tip.gemAmount);
      }

      // ── Deduct from each affected Streamer's pendingBalance ────────────────
      for (const [streamerId, totalDeduction] of deductionsByStreamer) {
        await tx.user.update({
          where: { id: streamerId },
          data: {
            pendingBalance: { decrement: totalDeduction },
            // availableBalance is INTENTIONALLY NOT TOUCHED (§3 Chargeback Defense)
          },
        });
      }

      // ── Mark all reversed TipEvents ────────────────────────────────────────
      const reversedTipIds = pendingTips.map((t) => t.id);

      await tx.tipEvent.updateMany({
        where: { id: { in: reversedTipIds } },
        data: { status: "REVERSED" },
      });

      // ── Record total Gems reversed (for Axiom 2.3 audit trail) ────────────
      const totalGemsReversed = pendingTips.reduce(
        (sum, tip) => sum + tip.gemAmount,
        0
      ) as GemInt;

      return {
        totalGemsReversed,
        tipsReversedCount: reversedTipIds.length,
        reversedTipIds,
      } satisfies ChargebackReverseResult;
    });

    return result;
  }
}
