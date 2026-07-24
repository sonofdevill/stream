// =============================================================================
// GEMSTREAM — src/routes/index.ts
// Express Router — Central Route Registration
//
// DEPENDENCY INJECTION FLOW:
//   PrismaClient (singleton)
//     ↓
//   Services (LedgerService, StripeService, CryptoService, AlertService)
//     ↓
//   Controllers (LedgerController, StripeController, CryptoController, AlertController)
//     ↓
//   Express Routers (mounted here)
//
// WEBHOOK MIDDLEWARE CRITICAL NOTE (§5):
//   The Stripe webhook route is mounted with `express.raw({ type: 'application/json' })`
//   BEFORE the global `express.json()` middleware runs. Express middleware evaluation
//   is order-dependent: the first matching middleware wins. By mounting the raw parser
//   on the specific webhook path first, that route receives a Buffer body. All other
//   routes receive the JSON-parsed body from the global middleware below.
//
// MOUNTING ORDER (must not be changed):
//   1. /stripe/webhook  → express.raw()   ← FIRST: captures raw Buffer for HMAC
//   2. express.json()                      ← THEN: parses all other route bodies
//   3. /stripe/checkout → StripeController
//   4. /ledger/*        → LedgerController
//   5. /crypto/*        → CryptoController
//   6. /alerts/*        → AlertController
// =============================================================================

import express, { Router, type Application } from "express";
import { PrismaClient } from "@prisma/client";
import { Server as HttpServer } from "http";

// ── Services ─────────────────────────────────────────────────────────────────
import { LedgerService } from "../services/LedgerService";
import { StripeService } from "../services/StripeService";
import { CryptoService } from "../services/CryptoService";
import { AlertService } from "../services/AlertService";

// ── Controllers ───────────────────────────────────────────────────────────────
import { StripeController } from "../controllers/StripeController";
import { LedgerController } from "../controllers/LedgerController";
import { CryptoController } from "../controllers/CryptoController";
import { AlertController } from "../controllers/AlertController";

// =============================================================================
// SINGLETON DEPENDENCIES
//
// PrismaClient is instantiated once and shared across all services.
// A new PrismaClient per-request would exhaust the PostgreSQL connection pool.
// =============================================================================

const prisma = new PrismaClient();

// =============================================================================
// SERVICE INSTANTIATION (Dependency Injection)
//
// Services are stateless singletons — they hold no per-request state.
// AlertService is instantiated here but initialized later (requires http.Server).
// =============================================================================

const alertService = new AlertService();
const ledgerService = new LedgerService(prisma);
const stripeService = new StripeService(prisma);
const cryptoService = new CryptoService(prisma);

// =============================================================================
// CONTROLLER INSTANTIATION
// =============================================================================

const stripeController = new StripeController(stripeService);
const ledgerController = new LedgerController(ledgerService, alertService);
const cryptoController = new CryptoController(ledgerService, cryptoService);
const alertController = new AlertController(alertService);

// =============================================================================
// registerRoutes()
//
// Called once at application startup with the Express app and http.Server.
// The http.Server is required to attach Socket.io (AlertService.initialize).
//
// Usage in server entry point (e.g., src/server.ts):
//   import http from "http";
//   import express from "express";
//   import { registerRoutes } from "./routes/index";
//
//   const app = express();
//   const httpServer = http.createServer(app);
//   registerRoutes(app, httpServer);
//   httpServer.listen(3000);
// =============================================================================

export function registerRoutes(app: Application, httpServer: HttpServer): void {
  // ── Initialize AlertService with the http.Server ──────────────────────────
  // Must happen before any route that could trigger dispatchAlert().
  // Allowed origins are loaded from environment variables — never wildcard.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  alertService.initialize(httpServer, allowedOrigins);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1: STRIPE WEBHOOK — MUST BE REGISTERED BEFORE express.json()
  //
  // express.raw() captures the raw request Buffer on this specific path.
  // Registering this after express.json() would mean the body is already
  // parsed to an object — Stripe's HMAC verification would then fail because
  // the byte sequence no longer matches the original request.
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }),
    stripeController.handleWebhook
  );

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2: GLOBAL JSON BODY PARSER
  //
  // Applied to all routes EXCEPT /stripe/webhook (already handled above).
  // express.json() parses application/json request bodies into req.body.
  // ══════════════════════════════════════════════════════════════════════════

  app.use(express.json());

  // ══════════════════════════════════════════════════════════════════════════
  // STRIPE ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  const stripeRouter = Router();

  /**
   * POST /stripe/checkout
   * Creates a 3DS-enforced Checkout Session for a Gem bundle purchase.
   * Returns the Stripe-hosted checkout URL.
   */
  stripeRouter.post("/checkout", stripeController.createCheckoutSession);

  app.use("/stripe", stripeRouter);

  // ══════════════════════════════════════════════════════════════════════════
  // LEDGER ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  const ledgerRouter = Router();

  /**
   * POST /ledger/tip
   * Atomically transfers Gems from Viewer to Streamer's pendingBalance.
   * Triggers OBS alert via AlertService on success.
   */
  ledgerRouter.post("/tip", ledgerController.executeTip);

  /**
   * GET /ledger/balance/:userId
   * Returns a role-aware balance snapshot for the given User UUID.
   */
  ledgerRouter.get("/balance/:userId", ledgerController.getBalance);

  /**
   * POST /ledger/chargeback
   * Internal endpoint: processes a Stripe chargeback by reversing PENDING tips
   * tied to the disputed PaymentIntent. Gems clawed back from pendingBalance only.
   */
  ledgerRouter.post("/chargeback", ledgerController.handleChargeback);

  app.use("/ledger", ledgerRouter);

  // ══════════════════════════════════════════════════════════════════════════
  // CRYPTO ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  const cryptoRouter = Router();

  /**
   * POST /crypto/payout
   * Two-phase Streamer USDT withdrawal:
   *   Phase 1: LedgerService deducts availableBalance, creates PayoutLog.
   *   Phase 2: CryptoService broadcasts ERC-20 transfer on Polygon.
   * Requires availableBalance >= 500 Gems (§3 payout gatekeeper).
   */
  cryptoRouter.post("/payout", cryptoController.processPayout);

  app.use("/crypto", cryptoRouter);

  // ══════════════════════════════════════════════════════════════════════════
  // ALERT ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  const alertRouter = Router();

  /**
   * GET /alerts/health
   * Health probe for the Socket.io alert layer.
   * Returns 200 when AlertService is initialized and ready.
   */
  alertRouter.get("/health", alertController.health);

  /**
   * POST /alerts/dispatch
   * Internal/admin: manually dispatch a TIP_DISPATCHED test event.
   * MUST be protected by admin authentication middleware before production use.
   */
  alertRouter.post("/dispatch", alertController.dispatchTestAlert);

  app.use("/alerts", alertRouter);

  // ══════════════════════════════════════════════════════════════════════════
  // GLOBAL ERROR HANDLER
  //
  // Express requires a 4-argument function signature for error handlers.
  // This catches any error not handled by individual route try/catch blocks
  // (e.g., synchronous middleware errors, unhandled promise rejections that
  // escape to Express's next(err) flow).
  // ══════════════════════════════════════════════════════════════════════════

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      console.error("[GemStream] Unhandled error reached global handler:", err);
      res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      });
    }
  );
}

// =============================================================================
// NAMED EXPORTS
// Expose services for use in src/server.ts if needed (e.g., graceful shutdown).
// =============================================================================

export { prisma, alertService, ledgerService, stripeService, cryptoService };
