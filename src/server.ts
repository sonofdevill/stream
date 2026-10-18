import http from "http";
import express from "express";
import { validateEnv } from "./config/env";
import { corsMiddleware } from "./middleware/cors";
import { registerRoutes, prisma, ledgerService } from "./routes/index";

const env = validateEnv();
const app = express();
const httpServer = http.createServer(app);

app.use(corsMiddleware);
registerRoutes(app, httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`[GemStream] Server listening on port ${env.PORT}`);
  console.log(`[GemStream] Dashboard CORS origin: ${env.DASHBOARD_ORIGIN}`);

  // Run maturation immediately on startup to clear any backlog, then every hour.
  async function runMaturationCron() {
    try {
      const result = await ledgerService.maturePendingTips({ asOf: new Date(), batchSize: 100 });
      if (result.maturedCount > 0 || result.failedTipIds.length > 0) {
        console.log(
          `[Cron:Maturation] matured=${result.maturedCount} failed=${result.failedTipIds.length}`
        );
      }
    } catch (err) {
      console.error("[Cron:Maturation] Unexpected error:", err);
    }
  }

  runMaturationCron();
  setInterval(runMaturationCron, 60 * 60 * 1000); // every hour
});

async function gracefulShutdown(signal: string) {
  console.log(`[GemStream] ${signal} received — shutting down`);
  httpServer.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
