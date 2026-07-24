// =============================================================================
// GEMSTREAM — src/services/CryptoService.ts
// Production Implementation v1.0.0
//
// GOVERNING ARCHITECTURE (see SYSTEM_ARCHITECTURE.md §6):
//   Network:      Polygon PoS Mainnet (Chain ID: 137) / Amoy Testnet (80002)
//   Token:        ERC-20 USDT @ 0xc2132D05D31c914a87C6611C10748AEb04B58e8F
//   Web3 Engine:  Ethers.js v6
//   Hot Wallet:   Platform EOA — private key injected via HOT_WALLET_PRIVATE_KEY
//   Gas:          Platform pays native MATIC gas as cost of business (§6)
//
// AXIOM COMPLIANCE:
//   Axiom 2.2 — `usdtAmountUnits` is a string representation of a uint256 value.
//               It is converted to BigInt (never Number) before the ERC-20 call.
//               No floating-point arithmetic touches any monetary value in this file.
//
// LIFECYCLE CONTRACT:
//   1. Validate destination wallet (isAddress + zero-address guard)
//   2. Broadcast transfer() → update PayoutLog to PROCESSING with txHash
//   3. Await on-chain confirmation (tx.wait()) → update PayoutLog to COMPLETED
//   4. On ANY failure at steps 2 or 3 → update PayoutLog to FAILED, throw PayoutBroadcastError
//
// DEPENDENCIES:
//   - ethers           (v6 — JsonRpcProvider, Wallet, Contract, isAddress)
//   - @prisma/client   (PayoutLog status lifecycle writes)
//
// ENVIRONMENT VARIABLES REQUIRED:
//   POLYGON_RPC_URL         — Polygon JSON-RPC endpoint (e.g., https://polygon-rpc.com)
//   HOT_WALLET_PRIVATE_KEY  — Platform hot wallet private key (0x-prefixed 32-byte hex)
// =============================================================================

import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Canonical ERC-20 USDT contract address on Polygon PoS Mainnet (§6).
 * This value is hardcoded by architectural specification — it must never be
 * sourced from an environment variable, as an accidental override would route
 * funds to a wrong token contract with no recovery path.
 */
const POLYGON_USDT_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" as const;

/**
 * EVM zero address. Sending tokens here burns them irreversibly.
 * `ethers.isAddress()` returns true for this address (it is syntactically valid),
 * so it requires an explicit secondary guard — see validateDestinationWallet().
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Minimal ERC-20 ABI — only the `transfer` function is needed for payout dispatch.
 * Including the full token ABI would bloat the bundle without adding safety.
 * The `transfer(address to, uint256 amount)` signature is defined by EIP-20
 * and is stable across all compliant token implementations.
 *
 * NOTE: `uint256` in Solidity maps to BigInt in ethers.js v6. The caller
 * MUST pass a BigInt for `amount` — passing a Number or string will throw
 * an ABI encoding error at runtime.
 */
const ERC20_TRANSFER_ABI: readonly string[] = [
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

// =============================================================================
// CUSTOM ERROR CLASSES
// =============================================================================

/**
 * Thrown when `destinationWallet` fails address validation.
 * Covers two failure modes:
 *   1. Syntactically invalid EVM address (ethers.isAddress returns false)
 *   2. Zero address (0x000...000) — valid syntax, invalid destination
 *
 * The caller (payout orchestrator) must catch this and mark the PayoutLog
 * as FAILED without retrying — the address must be corrected by the Streamer.
 */
export class InvalidWalletAddressError extends Error {
  public readonly code = "INVALID_WALLET_ADDRESS" as const;
  constructor(address: string, reason: string) {
    super(
      `[CryptoService] InvalidWalletAddressError: "${address}" — ${reason}`
    );
    this.name = "InvalidWalletAddressError";
    Object.setPrototypeOf(this, InvalidWalletAddressError.prototype);
  }
}

/**
 * Thrown when the on-chain USDT transfer fails at any stage after address
 * validation. Covers three distinct blockchain failure modes:
 *   1. Pre-broadcast: contract.transfer() throws (RPC error, gas estimation failure)
 *   2. Post-broadcast EVM reversion: tx.wait() resolves with receipt.status === 0
 *   3. Post-broadcast timeout: tx.wait() rejects (provider disconnect, timeout)
 *
 * In all three cases, CryptoService has already updated the PayoutLog to FAILED
 * before throwing. The caller must then invoke LedgerService.revertPayout() to
 * restore the Streamer's availableBalance.
 *
 * `originalError` preserves the underlying ethers.js / RPC error for logging.
 */
export class PayoutBroadcastError extends Error {
  public readonly code = "PAYOUT_BROADCAST_FAILED" as const;
  public readonly originalError: unknown;

  constructor(payoutLogId: string, reason: string, originalError: unknown) {
    super(
      `[CryptoService] PayoutBroadcastError for PayoutLog ${payoutLogId}: ${reason}`
    );
    this.name = "PayoutBroadcastError";
    this.originalError = originalError;
    Object.setPrototypeOf(this, PayoutBroadcastError.prototype);
  }
}

// =============================================================================
// INPUT / OUTPUT DTOs
// =============================================================================

export interface ProcessPayoutInput {
  /** UUID of the PayoutLog record in the database */
  payoutLogId: string;
  /**
   * Polygon wallet address of the Streamer receiving USDT.
   * Must pass `ethers.isAddress()` and must not be the zero address.
   */
  destinationWallet: string;
  /**
   * USDT value in 6-decimal micro-units, stored as a string (Axiom 2.2 + §6).
   * Built by LedgerService.gemsToUsdtUnits() — e.g., "50000000" for $50.00 USDT.
   * Converted to BigInt internally before the ERC-20 call — never parsed as Number.
   */
  usdtAmountUnits: string;
}

export interface ProcessPayoutResult {
  /** Polygon transaction hash (0x...) of the confirmed USDT transfer */
  txHash: string;
  /** Block number at which the transfer was confirmed on Polygon */
  confirmedBlock: number;
  /** PayoutLog UUID — echoed back for the orchestrator's convenience */
  payoutLogId: string;
}

// =============================================================================
// CLASS: CryptoService
// =============================================================================

/**
 * GemStream's Web3 payout engine. Bridges the internal Gem ledger to the
 * Polygon blockchain by dispatching ERC-20 USDT transfers from the platform's
 * hot wallet to Streamer-owned wallets (§6).
 *
 * This service handles ONLY the on-chain execution layer:
 *   - Validating destination addresses before touching the network
 *   - Broadcasting the ERC-20 transfer from the hot wallet
 *   - Awaiting on-chain confirmation and recording the result
 *   - Marking PayoutLog records through their PROCESSING → COMPLETED / FAILED lifecycle
 *
 * It does NOT handle the ledger side of payouts (that is LedgerService.requestPayout()
 * and LedgerService.revertPayout()) and does NOT interact with Stripe.
 */
export class CryptoService {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly hotWallet: ethers.Wallet;
  private readonly usdtContract: ethers.Contract;

  /**
   * @param prisma    - Injected PrismaClient for PayoutLog lifecycle writes.
   * @param provider  - Optional injected JsonRpcProvider (test injection point).
   * @param wallet    - Optional injected Wallet (test injection point).
   * @param contract  - Optional injected Contract (test injection point).
   *
   * In production all three ethers primitives are self-initialised from env vars.
   * The optional injection parameters exist solely for test mocking — they allow
   * the test suite to pass mock instances without module-level patching beyond
   * the top-level `jest.mock("ethers")`.
   */
  constructor(
    private readonly prisma: PrismaClient,
    provider?: ethers.JsonRpcProvider,
    wallet?: ethers.Wallet,
    contract?: ethers.Contract
  ) {
    // ── Provider: Polygon RPC connection ──────────────────────────────────────
    // Sourced from POLYGON_RPC_URL — never hardcoded. An incorrect URL would
    // silently route transactions to a different network or fail at broadcast.
    this.provider =
      provider ??
      new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL ?? "");

    // ── Wallet: platform hot wallet signer ────────────────────────────────────
    // The private key is injected via HOT_WALLET_PRIVATE_KEY (§6).
    // NEVER hardcode a private key. The wallet is connected to the provider
    // at construction time — a disconnected Wallet cannot broadcast transactions.
    this.hotWallet =
      wallet ??
      new ethers.Wallet(
        process.env.HOT_WALLET_PRIVATE_KEY ?? "",
        this.provider
      );

    // ── Contract: ERC-20 USDT on Polygon ─────────────────────────────────────
    // The contract address IS hardcoded — this is intentional and correct (§6).
    // An env-variable override would be a critical attack surface: a misconfigured
    // deployment could drain the hot wallet to an attacker-controlled contract.
    // The hot wallet is the signer — it pays gas and authorises the transfer.
    this.usdtContract =
      contract ??
      new ethers.Contract(
        POLYGON_USDT_ADDRESS,
        ERC20_TRANSFER_ABI,
        this.hotWallet
      );
  }

  // ===========================================================================
  // PRIVATE METHOD: validateDestinationWallet
  // ===========================================================================

  /**
   * Validates a Polygon destination wallet address before any network call.
   *
   * TWO INDEPENDENT GUARDS:
   *
   * Guard 1 — Syntactic validity via `ethers.isAddress()`:
   *   Rejects malformed strings (missing 0x prefix, wrong length, bad checksum).
   *   A syntactically invalid address would cause `contract.transfer()` to throw
   *   an ABI encoding error, wasting gas on a guaranteed failure.
   *
   * Guard 2 — Zero address explicit rejection:
   *   `ethers.isAddress("0x000...000")` returns `true` — the zero address is
   *   syntactically valid EVM bytecode. However, USDT transferred to the zero
   *   address is permanently unrecoverable. This guard catches what Guard 1 misses.
   *
   * @param address - Raw destination wallet string from the payout request
   * @throws InvalidWalletAddressError on syntactic invalidity or zero address
   */
  private validateDestinationWallet(address: string): void {
    // Guard 1: syntactic EVM address validation
    if (!ethers.isAddress(address)) {
      throw new InvalidWalletAddressError(
        address,
        "not a valid EVM address (failed ethers.isAddress check)"
      );
    }

    // Guard 2: zero address rejection
    // Must run AFTER isAddress — comparing a malformed string to ZERO_ADDRESS
    // would pass this check while the address is still invalid.
    if (address.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new InvalidWalletAddressError(
        address,
        "zero address (0x000...000) cannot receive tokens — funds would be permanently lost"
      );
    }
  }

  // ===========================================================================
  // PUBLIC METHOD: processPayout
  // ===========================================================================

  /**
   * Dispatches a USDT transfer on Polygon from the platform hot wallet to a
   * Streamer's wallet, and manages the PayoutLog lifecycle through to confirmation.
   *
   * EXECUTION SEQUENCE:
   *
   *   [Pre-flight]
   *   1. Validate `destinationWallet` — throws `InvalidWalletAddressError` before
   *      touching the network if the address is invalid or zero.
   *
   *   [Broadcast]
   *   2. Call `contract.transfer(destinationWallet, BigInt(usdtAmountUnits))`.
   *      `usdtAmountUnits` is converted to BigInt here — NEVER to Number (Axiom 2.2).
   *   3. Update PayoutLog → status: PROCESSING, txHash: tx.hash.
   *      This intermediate state is recorded immediately after broadcast so that
   *      if the process crashes before confirmation, the txHash is preserved for
   *      manual operator recovery.
   *
   *   [Confirmation]
   *   4. Call `tx.wait()` to poll Polygon until the transaction is included in a block.
   *   5. Inspect `receipt.status`: 1 = success, 0 = EVM reversion (gas consumed,
   *      transfer did not execute). Status 0 is treated as a hard failure.
   *   6. Update PayoutLog → status: COMPLETED, confirmedBlock: receipt.blockNumber.
   *
   *   [Failure (any stage after pre-flight)]
   *   7. Update PayoutLog → status: FAILED.
   *   8. Throw `PayoutBroadcastError` with the original error attached.
   *      The orchestrator catches this and calls LedgerService.revertPayout()
   *      to restore the Streamer's availableBalance.
   *
   * NOTE ON CONCURRENCY:
   *   This method does not implement nonce management. In production, a nonce
   *   manager (or serialised payout queue) must ensure the hot wallet does not
   *   broadcast concurrent transactions with the same nonce.
   *
   * @param input - ProcessPayoutInput DTO
   * @returns ProcessPayoutResult with txHash, confirmedBlock, and payoutLogId
   * @throws InvalidWalletAddressError if address validation fails (pre-flight)
   * @throws PayoutBroadcastError if the on-chain transfer fails at any stage
   */
  async processPayout(input: ProcessPayoutInput): Promise<ProcessPayoutResult> {
    const { payoutLogId, destinationWallet, usdtAmountUnits } = input;

    // ── STEP 1: Pre-flight Address Validation ─────────────────────────────────
    // Runs before any DB or network call. An invalid address is a client error,
    // not a transient failure — it must not update the PayoutLog to FAILED
    // (which would prevent retry) but should instead surface as a validation error
    // for the caller to handle (e.g., prompt the Streamer to update their wallet).
    this.validateDestinationWallet(destinationWallet);

    // ── STEP 2: Convert Amount to BigInt (Axiom 2.2) ─────────────────────────
    // `usdtAmountUnits` arrives as a string to avoid PostgreSQL BigInt serialisation
    // ambiguity (§6 schema decision). It must be a BigInt for the uint256 ABI type.
    // Using Number() here would violate Axiom 2.2 and risk silent precision loss
    // for large uint256 values above 2^53.
    const transferAmount: bigint = BigInt(usdtAmountUnits);

    // ── STEPS 3–6: Blockchain Execution with Full Error Coverage ─────────────
    // A single try/catch wraps the entire on-chain lifecycle. Every failure path
    // (broadcast failure, EVM reversion, confirmation timeout) converges on the
    // same cleanup: mark PayoutLog FAILED, then throw PayoutBroadcastError.
    try {
      // ── STEP 3: Broadcast the ERC-20 Transfer ───────────────────────────────
      // `contract.transfer()` submits the transaction to the Polygon mempool and
      // returns immediately with a TransactionResponse containing the tx hash.
      // The transaction is NOT yet confirmed at this point.
      const tx = await this.usdtContract.transfer(
        destinationWallet,
        transferAmount
      );

      // ── STEP 4: Persist PROCESSING State (Crash-Safety Anchor) ────────────
      // Writing PROCESSING + txHash immediately after broadcast ensures that if
      // this process dies before tx.wait() resolves, an operator can look up
      // the txHash on Polygonscan to determine the true on-chain outcome.
      // This record also enables monitoring tools to alert on txs that are
      // broadcast but never confirmed (stuck in mempool).
      await this.prisma.payoutLog.update({
        where: { id: payoutLogId },
        data: {
          status: "PROCESSING",
          txHash: tx.hash,
        },
      });

      // ── STEP 5: Await On-Chain Confirmation ───────────────────────────────
      // `tx.wait()` polls the Polygon RPC until the transaction is included in
      // a block and returns a TransactionReceipt. It will reject if:
      //   - The provider connection is lost during polling
      //   - A configured timeout is exceeded
      // It resolves (not rejects) for EVM reverted transactions — we inspect
      // `receipt.status` explicitly to distinguish success from reversion.
      const receipt = await tx.wait();

      // ── STEP 6: Inspect EVM Execution Status ──────────────────────────────
      // `receipt.status === 0` means the EVM executed the transaction (gas was
      // consumed and a block was mined) but the transfer call reverted internally.
      // Common causes: USDT contract paused, insufficient token allowance (not
      // applicable for EOA transfers), or a contract-level revert condition.
      // This is a definitive failure — the Streamer did not receive funds.
      if (!receipt || receipt.status === 0) {
        const revertReason =
          receipt
            ? `EVM reversion in block ${receipt.blockNumber} (receipt.status === 0)`
            : "tx.wait() resolved with a null receipt";

        // Mark FAILED before throwing — the throw exits this try block,
        // which would bypass the FAILED update if it were in the catch block only.
        await this.prisma.payoutLog.update({
          where: { id: payoutLogId },
          data: { status: "FAILED" },
        });

        throw new PayoutBroadcastError(payoutLogId, revertReason, null);
      }

      // ── STEP 7: Persist COMPLETED State ────────────────────────────────────
      // The transfer is confirmed on-chain. Record the block number as the
      // immutable audit anchor — it can be independently verified on Polygonscan.
      await this.prisma.payoutLog.update({
        where: { id: payoutLogId },
        data: {
          status: "COMPLETED",
          confirmedBlock: receipt.blockNumber,
        },
      });

      // ── Return Success ─────────────────────────────────────────────────────
      return {
        txHash: receipt.hash,
        confirmedBlock: receipt.blockNumber,
        payoutLogId,
      };
    } catch (error) {
      // ── Unified Failure Handler ────────────────────────────────────────────
      // Re-thrown PayoutBroadcastErrors (from the status === 0 branch above)
      // are passed through immediately — the FAILED update has already run.
      if (error instanceof PayoutBroadcastError) {
        throw error;
      }

      // All other errors: network failures, provider disconnects, gas estimation
      // failures, nonce conflicts, ABI encoding errors, etc.
      // Update the PayoutLog to FAILED so the payout is not left in REQUESTED
      // or PROCESSING state, which would block retry logic and reconciliation.
      try {
        await this.prisma.payoutLog.update({
          where: { id: payoutLogId },
          data: { status: "FAILED" },
        });
      } catch (dbError) {
        // If the FAILED update itself fails (e.g., DB connection lost), log it
        // but do not let this secondary failure suppress the primary error.
        // The monitoring layer must detect PayoutLogs stuck in PROCESSING.
        console.error(
          `[CryptoService] CRITICAL: Failed to update PayoutLog ${payoutLogId} ` +
            `to FAILED after broadcast error. Manual intervention required.`,
          dbError
        );
      }

      // Wrap in PayoutBroadcastError so the orchestrator has a single named
      // error type to catch, without losing the original RPC/ethers error.
      throw new PayoutBroadcastError(
        payoutLogId,
        error instanceof Error ? error.message : "unknown error",
        error
      );
    }
  }
}
