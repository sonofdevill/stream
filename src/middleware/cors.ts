import { Request, Response, NextFunction } from "express";
import { getEnv } from "../config/env";

const ALLOWED_METHODS = "GET,POST,PUT,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Content-Type,Authorization";
const MAX_AGE_SECONDS = 86_400;

/**
 * Strict CORS for dashboard REST traffic.
 * Only the configured DASHBOARD_ORIGIN receives Access-Control-* headers.
 * Stripe webhooks (no browser Origin) and same-origin server-to-server calls pass through.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const dashboardOrigin = getEnv().DASHBOARD_ORIGIN;
  const origin = req.headers.origin;

  if (origin) {
    if (origin !== dashboardOrigin) {
      res.status(403).json({
        error: "CORS_FORBIDDEN",
        message: "Origin not permitted.",
      });
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", dashboardOrigin);
    res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.setHeader("Access-Control-Max-Age", String(MAX_AGE_SECONDS));
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
}
