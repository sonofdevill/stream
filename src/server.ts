import http from "http";
import express from "express";
import { validateEnv } from "./config/env";
import { corsMiddleware } from "./middleware/cors";
import { registerRoutes, prisma } from "./routes/index";

const env = validateEnv();
const app = express();
const httpServer = http.createServer(app);

app.use(corsMiddleware);
registerRoutes(app, httpServer);

httpServer.listen(env.PORT, () => {
  console.log(`[GemStream] Server listening on port ${env.PORT}`);
  console.log(`[GemStream] Dashboard CORS origin: ${env.DASHBOARD_ORIGIN}`);
});

async function gracefulShutdown(signal: string) {
  console.log(`[GemStream] ${signal} received — shutting down`);
  httpServer.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
