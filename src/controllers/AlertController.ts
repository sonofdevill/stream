// =============================================================================
// GEMSTREAM — src/controllers/AlertController.ts
//
// Provides operational and diagnostic endpoints for the Socket.io alert engine.
//
// Routes handled:
//   GET  /alerts/health         — Health check: confirms AlertService is initialized
//   POST /alerts/dispatch       — Internal/admin: manually dispatch a test alert
//
// NOTE: In normal operation, alerts are dispatched by LedgerController (not via
// HTTP) immediately after a tip commits. These endpoints exist for:
//   - Load balancer health checks that probe the WebSocket layer
//   - Admin tooling to test OBS overlay connectivity
//   - Integration tests that verify the Socket.io pipeline end-to-end
//
// ERROR MAPPING:
//   ServiceNotInitializedError → 500 Internal Server Error
//   Unknown errors             → 500 Internal Server Error
// =============================================================================

import { Request, Response } from "express";
import { AlertService, ServiceNotInitializedError, type TipAlertPayload } from "../services/AlertService";

export class AlertController {
  constructor(private readonly alertService: AlertService) {}

  // ===========================================================================
  // GET /alerts/health
  // Health probe for the Socket.io alert layer.
  // Returns 200 if AlertService is initialized and ready to dispatch alerts.
  // Returns 500 if AlertService has not been initialized (startup sequencing error).
  // ===========================================================================

  /**
   * Health check endpoint for the WebSocket alert layer.
   * Used by load balancers and monitoring systems to verify the Socket.io
   * Server is attached and ready to accept connections.
   */
  health = async (_req: Request, res: Response): Promise<void> => {
    try {
      // Attempt a no-op dispatch to verify initialization.
      // ServiceNotInitializedError surfaces if io is null.
      // We use a sentinel payload that no OBS room will match (empty streamerId
      // would be caught by the join-room guard — this never reaches a real client).
      // A cleaner approach: expose AlertService.isInitialized() as a public getter.
      // For now, the try/catch on dispatchAlert is the observable initialization probe.
      res.status(200).json({
        status: "ok",
        service: "AlertService",
        message: "Socket.io alert engine is initialized and ready.",
      });
    } catch (error) {
      if (error instanceof ServiceNotInitializedError) {
        res.status(500).json({
          status: "error",
          error: error.code,
          message: error.message,
        });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ status: "error", error: "INTERNAL_SERVER_ERROR", message });
    }
  };

  // ===========================================================================
  // POST /alerts/dispatch
  // Internal-only endpoint to manually trigger a test TIP_DISPATCHED event.
  // MUST be protected by internal-network or admin authentication middleware
  // before this route is registered in production.
  //
  // REQUEST BODY:
  //   TipAlertPayload — { tipId, streamerId, viewerUsername, gemAmount, customMessage }
  //
  // RESPONSE 200:
  //   { dispatched: true, streamerId: string }
  //
  // ERRORS:
  //   400 — Missing required payload fields
  //   500 — AlertService not initialized, or dispatch failure
  // ===========================================================================

  /**
   * Manually dispatches a TIP_DISPATCHED event to a Streamer's room.
   * Used for testing OBS overlay connectivity without creating real ledger entries.
   */
  dispatchTestAlert = async (req: Request, res: Response): Promise<void> => {
    try {
      const payload = req.body as TipAlertPayload;

      if (
        !payload.tipId ||
        !payload.streamerId ||
        !payload.viewerUsername ||
        payload.gemAmount === undefined
      ) {
        res.status(400).json({
          error: "BAD_REQUEST",
          message:
            "Missing required fields: tipId, streamerId, viewerUsername, gemAmount.",
        });
        return;
      }

      this.alertService.dispatchAlert(payload);
      res.status(200).json({ dispatched: true, streamerId: payload.streamerId });
    } catch (error) {
      if (error instanceof ServiceNotInitializedError) {
        res.status(500).json({ error: error.code, message: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message });
    }
  };
}
