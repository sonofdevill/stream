// =============================================================================
// GEMSTREAM — src/controllers/CryptoController.ts
//
// Orchestrates the two-phase Streamer payout flow:
//   Phase 1 (LedgerService): Validate threshold, deduct availableBalance,
//                             create PayoutLog in REQUESTED state.
//   Phase 2 (CryptoService): Broadcast ERC-20 USDT transfer on Polygon,
//                             update PayoutLog to PROCESSING → COMPLETED.
//
// Routes handled:
//   POST /crypto/payout — Request a USDT withdrawal from availableBalance
//
// ERROR MAPPING:
//   InvalidGemAmountError     → 400 Bad Request
//   InsufficientFundsError    → 400 Bad Request
//   PayoutThresholdError      → 400 Bad Request
//   InvalidWalletAddressError → 400 Bad Request
//   UserNotFoundError         → 404 Not Found
//   PayoutBroadcastError      → 500 Internal Server Error
//   Unknown errors            → 500 Internal Server Error
// =============================================================================

import { Request, Response } from "express";
import { LedgerService } from "../services/LedgerService";
import { CryptoService, InvalidWalletAddressError, PayoutBroadcastError } from "../services/CryptoService";
import {
  InvalidGemAmountError,
  InsufficientFundsError,
  PayoutThresholdError,
  UserNotFoundError,
  type GemInt,
} from "../types/ledger";

export class CryptoController {
  /**
   * @param ledgerService  - Handles the DB-side of payout: threshold check,
   *                         availableBalance deduction, PayoutLog creation.
   * @param cryptoService  - Handles the chain-side: ERC-20 transfer dispatch
   *                         and PayoutLog PROCESSING → COMPLETED lifecycle.
   */
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly cryptoService: CryptoService
  ) {}

  // ===========================================================================
  // POST /crypto/payout
  // Initiates a USDT withdrawal from a Streamer's availableBalance to their
  // registered Polygon wallet.
  //
  // TWO-PHASE EXECUTION:
  //   Phase 1 — LedgerService.requestPayout():
  //     - Validates gemAmount >= 500 (payout threshold, §3)
  //     - Atomically deducts gemAmount from availableBalance
  //     - Creates PayoutLog in REQUESTED state
  //     - Returns usdtAmountUnits string for Phase 2
  //
  //   Phase 2 — CryptoService.processPayout():
  //     - Validates destinationWallet (isAddress + zero-address guard)
  //     - Broadcasts ERC-20 transfer() from hot wallet
  //     - Updates PayoutLog to PROCESSING (with txHash) then COMPLETED
  //
  // ROLLBACK ON PHASE 2 FAILURE:
  //   If CryptoService.processPayout() throws PayoutBroadcastError, the
  //   PayoutLog is already set to FAILED by CryptoService. The controller
  //   must then call LedgerService to restore availableBalance. This is
  //   noted here as a TODO for the revertPayout() implementation.
  //
  // REQUEST BODY:
  //   { streamerId: string, gemAmount: number, destinationWallet: string }
  //
  // RESPONSE 200:
  //   { ledger: RequestPayoutResult, chain: ProcessPayoutResult }
  //
  // ERRORS:
  //   400 — Threshold/funds/address/gemAmount validation failures
  //   404 — Streamer not found
  //   500 — Blockchain broadcast failure or internal error
  // ===========================================================================

  /**
   * Executes a two-phase Streamer USDT payout: ledger deduction then
   * on-chain ERC-20 transfer. Both phases are orchestrated atomically
   * from the caller's perspective — failure in Phase 2 triggers balance
   * restoration and surfaces as HTTP 500 with a PayoutBroadcastError.
   */
  processPayout = async (req: Request, res: Response): Promise<void> => {
    try {
      const { streamerId, gemAmount, destinationWallet } = req.body as {
        streamerId: string;
        gemAmount: number;
        destinationWallet: string;
      };

      if (!streamerId || gemAmount === undefined || !destinationWallet) {
        res.status(400).json({
          error: "BAD_REQUEST",
          message: "Missing required fields: streamerId, gemAmount, destinationWallet.",
        });
        return;
      }

      // ── Phase 1: Ledger — Deduct balance, create PayoutLog ─────────────────
      const ledgerResult = await this.ledgerService.requestPayout({
        streamerId,
        gemAmount: gemAmount as GemInt, // toGemInt() validates inside requestPayout
        destinationWallet,
      });

      // ── Phase 2: Chain — Broadcast USDT transfer on Polygon ────────────────
      let chainResult;
      try {
        chainResult = await this.cryptoService.processPayout({
          payoutLogId: ledgerResult.payoutId,
          destinationWallet,
          usdtAmountUnits: ledgerResult.usdtAmountUnits,
        });
      } catch (broadcastError) {
        // Phase 2 failed. CryptoService has already set PayoutLog → FAILED.
        // Restore the Streamer's availableBalance that Phase 1 deducted.
        try {
          await this.ledgerService.revertPayout(ledgerResult.payoutId);
          console.warn(
            `[CryptoController] Payout broadcast failed for payoutId=${ledgerResult.payoutId}. ` +
              `availableBalance restored for streamerId=${streamerId}.`
          );
        } catch (revertError) {
          // Revert itself failed — this is a critical consistency error requiring manual intervention.
          console.error(
            `[CryptoController] CRITICAL: Payout revert failed for payoutId=${ledgerResult.payoutId}. ` +
              `Streamer ${streamerId} balance may be permanently deducted. Manual fix required.`,
            revertError
          );
        }
        throw broadcastError;
      }

      res.status(200).json({ ledger: ledgerResult, chain: chainResult });
    } catch (error) {
      // ── 400: Client / Validation Errors ──────────────────────────────────
      if (
        error instanceof InvalidGemAmountError ||
        error instanceof InsufficientFundsError ||
        error instanceof PayoutThresholdError ||
        error instanceof InvalidWalletAddressError
      ) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }

      // ── 404: Streamer Not Found ───────────────────────────────────────────
      if (error instanceof UserNotFoundError) {
        res.status(404).json({ error: error.code, message: error.message });
        return;
      }

      // ── 500: Blockchain Broadcast Failure ─────────────────────────────────
      if (error instanceof PayoutBroadcastError) {
        res.status(500).json({
          error: error.code,
          message: error.message,
          // originalError is omitted from the HTTP response — it may contain
          // RPC internals that should not be exposed to API consumers.
        });
        return;
      }

      // ── 500: Unknown / Database Error ─────────────────────────────────────
      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message });
    }
  };
}
