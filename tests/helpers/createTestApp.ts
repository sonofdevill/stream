import http from "http";
import express, { type Application } from "express";
import { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";

import { LedgerService } from "../../src/services/LedgerService";
import { StripeService } from "../../src/services/StripeService";
import { AlertService } from "../../src/services/AlertService";
import { StripeController } from "../../src/controllers/StripeController";
import { LedgerController } from "../../src/controllers/LedgerController";
import { authMiddleware } from "../../src/middleware/auth";

export interface TestAppDeps {
  prisma: PrismaClient;
  stripe: Stripe;
  alertService: AlertService;
}

export interface TestApp {
  app: Application;
  httpServer: http.Server;
  deps: TestAppDeps;
}

/**
 * Minimal Express app for integration tests — mirrors production route wiring
 * with injectable Stripe and AlertService dependencies.
 */
export function createTestApp(deps: TestAppDeps): TestApp {
  const { prisma, stripe, alertService } = deps;

  const ledgerService = new LedgerService(prisma);
  const stripeService = new StripeService(prisma, stripe);
  const stripeController = new StripeController(stripeService);
  const ledgerController = new LedgerController(ledgerService, alertService);

  const app = express();
  const httpServer = http.createServer(app);

  // Stripe webhook must receive raw body (same invariant as production).
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }),
    stripeController.handleWebhook
  );

  app.use(express.json());

  app.post("/ledger/tip", authMiddleware, ledgerController.executeTip);

  return { app, httpServer, deps };
}
