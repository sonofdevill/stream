// =============================================================================
// GEMSTREAM — src/types/ledger.ts
// Strict TypeScript Data Transfer Objects (DTOs) for the Ledger Layer
//
// GOVERNING AXIOMS (see SYSTEM_ARCHITECTURE.md §2):
//   Axiom 2.2 — All monetary values and Gem counts are `number` typed here,
//               but MUST represent whole integers only. The `GemInt` brand type
//               below enforces this at the type level; runtime validation is the
//               responsibility of LedgerService before any DB write.
//
// USAGE CONTRACT:
//   - These interfaces define the BOUNDARY between API controllers → services.
//   - No raw Prisma model types leak out of the service layer.
//   - Every DTO with a monetary field uses `GemInt` or `CentsInt`, never `Float`.
// =============================================================================

// =============================================================================
// BRANDED PRIMITIVE TYPES (Axiom 2.2 enforcement at the type system level)
//
// TypeScript's `number` type cannot distinguish a float from an integer at
// compile time. Branded types create a nominal distinction that forces callers
// to explicitly validate and cast — preventing accidental float usage.
//
// Usage:
//   const gems: GemInt = 50 as GemInt;   // ✅ Only after integer validation
//   const gems: GemInt = 1.5;            // ❌ Type error — will not compile
// =============================================================================

/** Whole-number Gem count. NEVER a float. 1 Gem = $0.10 USDT (Axiom 2.1). */
export type GemInt = number & { readonly __brand: "GemInt" };

/** USD value in whole cents. NEVER a float. $11.50 = 1150 CentsInt (§5). */
export type CentsInt = number & { readonly __brand: "CentsInt" };

/**
 * Runtime factory: validates that `n` is a safe, positive whole integer,
 * then casts it to GemInt. Throws if the value is fractional or negative.
 * LedgerService MUST use this before any balance arithmetic.
 */
export function toGemInt(n: number): GemInt {
  if (!Number.isInteger(n)) {
    throw new InvalidGemAmountError(
      `Axiom 2.2 Violation: Gem amount must be a whole integer. Received: ${n}`
    );
  }
  if (n <= 0) {
    throw new InvalidGemAmountError(
      `Axiom 2.2 Violation: Gem amount must be >= 1. Received: ${n}`
    );
  }
  return n as GemInt;
}

/**
 * Runtime factory: validates that `n` is a safe, positive whole integer,
 * then casts it to CentsInt.
 */
export function toCentsInt(n: number): CentsInt {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `Axiom 2.2 Violation: Fiat amount must be a positive whole integer (cents). Received: ${n}`
    );
  }
  return n as CentsInt;
}

// =============================================================================
// DOMAIN CONSTANTS
// =============================================================================

/** Minimum Gems required in availableBalance to trigger a payout (§3). */
export const PAYOUT_MINIMUM_GEMS: GemInt = 500 as GemInt;

/** Clearance window in milliseconds: exactly 14 days (§3). */
export const CLEARING_WINDOW_MS: number = 14 * 24 * 60 * 60 * 1000; // 1,209,600,000 ms

/** USDT has 6 decimal places. 1 USDT = 1_000_000 units. */
export const USDT_DECIMALS: number = 6;

// =============================================================================
// CUSTOM ERROR CLASSES
// Named errors enable precise catch blocks in controllers and test assertions.
// =============================================================================

/** Thrown when a tip or payout is attempted with insufficient Gem balance. */
export class InsufficientFundsError extends Error {
  public readonly code = "INSUFFICIENT_FUNDS";
  constructor(message: string) {
    super(message);
    this.name = "InsufficientFundsError";
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

/** Thrown when a Gem amount is ≤ 0, fractional, or otherwise invalid. */
export class InvalidGemAmountError extends Error {
  public readonly code = "INVALID_GEM_AMOUNT";
  constructor(message: string) {
    super(message);
    this.name = "InvalidGemAmountError";
    Object.setPrototypeOf(this, InvalidGemAmountError.prototype);
  }
}

/** Thrown when a payout is requested but availableBalance < 500 Gems (§3). */
export class PayoutThresholdError extends Error {
  public readonly code = "PAYOUT_THRESHOLD_NOT_MET";
  constructor(message: string) {
    super(message);
    this.name = "PayoutThresholdError";
    Object.setPrototypeOf(this, PayoutThresholdError.prototype);
  }
}

/** Thrown when a User entity is not found in the database. */
export class UserNotFoundError extends Error {
  public readonly code = "USER_NOT_FOUND";
  constructor(userId: string) {
    super(`User not found: ${userId}`);
    this.name = "UserNotFoundError";
    Object.setPrototypeOf(this, UserNotFoundError.prototype);
  }
}

// =============================================================================
// DTO: ExecuteTipInput
// Input contract for LedgerService.executeTip()
// =============================================================================
export interface ExecuteTipInput {
  /** UUID of the Viewer initiating the tip. */
  viewerId: string;

  /** UUID of the Streamer receiving the tip. */
  streamerId: string;

  /**
   * Whole Gems to transfer. MUST be >= 1.
   * Use `toGemInt()` factory to validate before passing here.
   */
  gemAmount: GemInt;

  /**
   * Optional message displayed in the OBS alert widget (§7).
   * Max 280 characters. Sanitization is the API layer's responsibility.
   */
  customMessage?: string;

  /**
   * ID of the FiatDepositLog that funded these Gems.
   * Linking tips to deposits enables surgical chargeback clawback (§3).
   * May be omitted for Gems from bonus/promotional grants (future feature).
   */
  fiatDepositLogId?: string;
}

// =============================================================================
// DTO: ExecuteTipResult
// Output contract for LedgerService.executeTip()
// =============================================================================
export interface ExecuteTipResult {
  /** UUID of the newly created TipEvent record. */
  tipId: string;

  /** Viewer's remaining Gem balance after the tip (whole integer). */
  viewerRemainingBalance: GemInt;

  /** Streamer's new pendingBalance after receiving the tip (whole integer). */
  streamerNewPendingBalance: GemInt;

  /**
   * ISO-8601 timestamp when this tip will mature from pending → available.
   * = createdAt + 14 days.
   */
  clearedAt: string;

  /** Payload forwarded to AlertService for the OBS widget (§7). */
  alertPayload: TipAlertPayload;
}

// =============================================================================
// DTO: TipAlertPayload
// Strict shape of the Socket.io event payload emitted after a successful tip.
// See SYSTEM_ARCHITECTURE.md §7 for the canonical JSON standard.
// =============================================================================
export interface TipAlertPayload {
  tipId: string;
  streamerId: string;
  viewerUsername: string;
  gemAmount: GemInt;
  customMessage: string | null;
}

// =============================================================================
// DTO: UserBalanceSnapshot
// Read-only view of a User's current balances. Returned by getBalance() queries.
// Used by the dashboard and the payout eligibility gatekeeper.
// =============================================================================
export interface UserBalanceSnapshot {
  userId: string;
  username: string;
  role: "VIEWER" | "STREAMER";

  // ── VIEWER FIELD ──────────────────────────────────────────────────────────
  /** Whole Gems available to tip. VIEWER only; null for STREAMERs. */
  gemBalance: GemInt | null;

  // ── STREAMER FIELDS (§3) ──────────────────────────────────────────────────
  /**
   * Gems received but within the 14-day chargeback window.
   * STREAMER only; null for VIEWERs.
   */
  pendingBalance: GemInt | null;

  /**
   * Gems past the chargeback window, eligible for USDT withdrawal.
   * STREAMER only; null for VIEWERs.
   */
  availableBalance: GemInt | null;

  /**
   * Whether the Streamer currently meets the payout threshold (>= 500 Gems).
   * STREAMER only; null for VIEWERs.
   */
  isPayoutEligible: boolean | null;
}

// =============================================================================
// DTO: RequestPayoutInput
// Input contract for LedgerService.requestPayout()
// =============================================================================
export interface RequestPayoutInput {
  /** UUID of the Streamer requesting the withdrawal. */
  streamerId: string;

  /**
   * Whole Gems to withdraw. Minimum: 500 (§3 Payout Gatekeeper).
   * Must not exceed availableBalance.
   * Use `toGemInt()` factory to validate before passing here.
   */
  gemAmount: GemInt;

  /**
   * EVM-compatible Polygon wallet address for USDT delivery.
   * Must be a valid checksummed address (validation in service layer).
   */
  destinationWallet: string;
}

// =============================================================================
// DTO: RequestPayoutResult
// Output contract for LedgerService.requestPayout()
// The actual on-chain tx is executed by the separate CryptoService.
// LedgerService only creates the PayoutLog record and locks the balance.
// =============================================================================
export interface RequestPayoutResult {
  /** UUID of the newly created PayoutLog record. */
  payoutId: string;

  /** Gems deducted from availableBalance. */
  gemAmountDeducted: GemInt;

  /**
   * USDT value as a decimal string for display purposes only.
   * e.g. "50.00" for 500 Gems. Never used for math — use usdtAmountUnits.
   */
  usdtAmountDisplay: string;

  /**
   * USDT in micro-units (6 decimal places) as a string for BigInt/Ethers.js.
   * 500 Gems → $50.00 USDT → "50000000". CryptoService reads this field.
   */
  usdtAmountUnits: string;

  /** Streamer's availableBalance after the deduction. */
  remainingAvailableBalance: GemInt;

  /** Current payout status (always "REQUESTED" on creation). */
  status: "REQUESTED";
}

// =============================================================================
// DTO: MaturationCronInput
// Input for the background cron job that matures PENDING tips (§3).
// =============================================================================
export interface MaturationCronInput {
  /**
   * Process tips with clearedAt <= this timestamp.
   * The cron passes `new Date()` on each scheduled run.
   */
  asOf: Date;

  /**
   * Maximum tips to process per cron invocation (pagination safety).
   * Prevents a thundering-herd of DB writes if a backlog accumulates.
   */
  batchSize: number;
}

// =============================================================================
// DTO: MaturationCronResult
// Output summary from the maturation cron run.
// =============================================================================
export interface MaturationCronResult {
  /** Number of TipEvents successfully matured in this batch. */
  maturedCount: number;

  /** UUIDs of all TipEvents processed in this run (for audit logging). */
  maturedTipIds: string[];

  /** Any tip IDs that failed to mature (should trigger an alert). */
  failedTipIds: string[];
}

// =============================================================================
// DTO: ChargebackReverseInput
// Input for the chargeback handler that claws back PENDING Gems (§3).
// =============================================================================
export interface ChargebackReverseInput {
  /**
   * The Stripe PaymentIntent ID from the chargeback webhook.
   * Used to locate the FiatDepositLog and all associated TipEvents.
   */
  stripePaymentIntentId: string;

  /** Stripe Event ID — must be stored in ProcessedWebhooks for idempotency (§5). */
  stripeEventId: string;
}

// =============================================================================
// DTO: ChargebackReverseResult
// Output from a chargeback reversal operation.
// =============================================================================
export interface ChargebackReverseResult {
  /** Total Gems clawed back from Streamer pendingBalances. */
  totalGemsReversed: GemInt;

  /** Number of TipEvents set to REVERSED status. */
  tipsReversedCount: number;

  /** UUIDs of reversed TipEvents (for audit log). */
  reversedTipIds: string[];
}
