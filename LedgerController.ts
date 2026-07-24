// =============================================================================
// GEMSTREAM — src/controllers/LedgerController.ts
//
// Exposes the core tip and balance operations from LedgerService over HTTP.
//
// Routes handled:
//   POST /ledger/tip            — Execute a Gem tip from Viewer to Streamer
//   GET  /ledger/balance/:userId — Read a User's current balance snapshot
//   POST /ledger/chargeback      — Process a Stripe chargeback reversal
//
// ERROR MAPPING:
//   InvalidGemAmountError   → 400 Bad Request
//   InsufficientFundsError  → 400 Bad Request
//   UserNotFoundError       → 404 Not Found
//   Unknown errors          → 500 Internal Server Error
// =============================================================================

import { Request, Response } from "express";
import { LedgerService } from "../services/LedgerService";
import { AlertService, type TipAlertPayload } from "../services/AlertService";
import {
  InvalidGemAmountError,
  InsufficientFundsError,
  UserNotFoundError,
  type GemInt,
} from "../types/ledger";

export class LedgerController {
  /**
   * @param ledgerService - Core financial ledger operations
   * @param alertService  - Real-time OBS alert dispatch (§7)
   *                        Injected here because tip execution and alert dispatch
   *                        are orchestrated together at the controller layer.
   *                        LedgerService returns the alert payload; the controller
   *                        passes it to AlertService without coupling the services.
   */
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly alertService: AlertService
  ) {}

  // ===========================================================================
  // POST /ledger/tip
  // Atomically transfers Gems from a Viewer to a Streamer's pendingBalance
  // and dispatches the OBS alert.
  //
  // REQUEST BODY:
  //   { viewerId: string, streamerId: string, gemAmount: number,
  //     customMessage?: string, fiatDepositLogId?: string }
  //
  // RESPONSE 201:
  //   ExecuteTipResult — balance snapshots, clearedAt, alertPayload
  //
  // ERRORS:
  //   400 — Zero/negative/fractional gemAmount (InvalidGemAmountError)
  //   400 — Viewer has insufficient Gems (InsufficientFundsError)
  //   404 — Viewer or Streamer UUID not found (UserNotFoundError)
  //   500 — Database or transaction failure
  // ===========================================================================

  /**
   * Executes an atomic Gem tip from a Viewer to a Streamer.
   * On success, dispatches the `TIP_DISPATCHED` event to the Streamer's
   * OBS browser source via AlertService (§7).
   */
  executeTip = async (req: Request, res: Response): Promise<void> => {
    try {
      const { viewerId, streamerId, gemAmount, customMessage, fiatDepositLogId } = req.body as {
        viewerId: string;
        streamerId: string;
        gemAmount: number;
        customMessage?: string;
        fiatDepositLogId?: string;
      };

      if (!viewerId || !streamerId || gemAmount === undefined) {
        res.status(400).json({
          error: "BAD_REQUEST",
          message: "Missing required fields: viewerId, streamerId, gemAmount.",
        });
        return;
      }

      const result = await this.ledgerService.executeTip({
        viewerId,
        streamerId,
        gemAmount: gemAmount as GemInt, // toGemInt() validates inside executeTip
        customMessage,
        fiatDepositLogId,
      });

      // Dispatch the OBS alert after the DB transaction commits (§7 decoupling).
      // Alert failure is non-fatal — the tip is already committed to PostgreSQL.
      // A missed alert is a UX degradation, not a financial error.
      try {
        this.alertService.dispatchAlert(result.alertPayload as TipAlertPayload);
      } catch (alertError) {
        console.error(
          `[LedgerController] Alert dispatch failed for tipId=${result.tipId}:`,
          alertError
        );
        // Do NOT rethrow — the HTTP response reflects ledger state, not alert state
      }

      res.status(201).json(result);
    } catch (error) {
      if (error instanceof InvalidGemAmountError) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof InsufficientFundsError) {
        res.status(400).json({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof UserNotFoundError) {
        res.status(404).json({ error: error.code, message: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message });
    }
  };

  // ===========================================================================
  // GET /ledger/balance/:userId
  // Returns a read-only snapshot of a User's current balances.
  //
  // RESPONSE 200:
  //   UserBalanceSnapshot — role-aware balance fields, isPayoutEligible
  //
  // ERRORS:
  //   404 — userId not found (UserNotFoundError)
  //   500 — Database failure
  // ===========================================================================

  /**
   * Returns a role-aware balance snapshot for the given User.
   * VIEWER fields are null for STREAMER accounts and vice versa.
   */
  getBalance = async (req: Request, res: Response): Promise<void> => {
    try {
      const { userId } = req.params;

      if (!userId) {
        res.status(400).json({
          error: "BAD_REQUEST",
          message: "Missing required path parameter: userId.",
        });
        return;
      }

      const snapshot = await this.ledgerService.getBalance(userId);
      res.status(200).json(snapshot);
    } catch (error) {
      if (error instanceof UserNotFoundError) {
        res.status(404).json({ error: error.code, message: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message });
    }
  };

  // ===========================================================================
  // POST /ledger/chargeback
  // Processes a Stripe chargeback by reversing PENDING tips tied to the
  // disputed payment. Called by an internal webhook handler or admin tool.
  //
  // REQUEST BODY:
  //   { stripePaymentIntentId: string, stripeEventId: string }
  //
  // RESPONSE 200:
  //   ChargebackReverseResult — reversed tip count and IDs
  //
  // ERRORS:
  //   400 — Missing required fields
  //   500 — Reversal failure
  // ===========================================================================

  /**
   * Processes a Stripe chargeback event by clawing back PENDING Gems from
   * affected Streamer pendingBalances. The Streamer's availableBalance is
   * never touched — only PENDING tips (within the 14-day window) are reversed.
   */
  handleChargeback = async (req: Request, res: Response): Promise<void> => {
    try {
      const { stripePaymentIntentId, stripeEventId } = req.body as {
        stripePaymentIntentId: string;
        stripeEventId: string;
      };

      if (!stripePaymentIntentId || !stripeEventId) {
        res.status(400).json({
          error: "BAD_REQUEST",
          message: "Missing required fields: stripePaymentIntentId, stripeEventId.",
        });
        return;
      }

      const result = await this.ledgerService.reverseChargedbackTips({
        stripePaymentIntentId,
        stripeEventId,
      });

      res.status(200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message });
    }
  };
}
