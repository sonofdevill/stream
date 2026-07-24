import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getEnv } from "../config/env";

const JWT_ALGORITHM = "HS256" as const;
const JWT_EXPIRY = "24h";

export interface JwtPayload {
  userId: string;
  email: string;
  role: "VIEWER" | "STREAMER" | "ADMIN";
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

function jwtSecret(): string {
  return getEnv().JWT_SECRET;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, jwtSecret(), {
    expiresIn: JWT_EXPIRY,
    algorithm: JWT_ALGORITHM,
  });
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, jwtSecret(), {
    algorithms: [JWT_ALGORITHM],
  });

  if (typeof decoded === "string" || !decoded || typeof decoded !== "object") {
    throw new jwt.JsonWebTokenError("Invalid token payload");
  }

  const { userId, email, role } = decoded as Record<string, unknown>;
  if (
    typeof userId !== "string" ||
    typeof email !== "string" ||
    (role !== "VIEWER" && role !== "STREAMER" && role !== "ADMIN")
  ) {
    throw new jwt.JsonWebTokenError("Malformed token claims");
  }

  return { userId, email, role };
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing or invalid token." });
    return;
  }

  const token = header.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Missing or invalid token." });
    return;
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "UNAUTHORIZED", message: "Token expired or invalid." });
  }
}

export function requireRole(...roles: JwtPayload["role"][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Insufficient permissions." });
      return;
    }
    next();
  };
}

/** Ensures the authenticated user owns the resource or holds an elevated role. */
export function requireSelfOrRole(paramKey: string, ...roles: JwtPayload["role"][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "Authentication required." });
      return;
    }

    const resourceId = req.params[paramKey];
    if (req.user.userId === resourceId || roles.includes(req.user.role)) {
      next();
      return;
    }

    res.status(403).json({ error: "FORBIDDEN", message: "Cannot access this resource." });
  };
}
