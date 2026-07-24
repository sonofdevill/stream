import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { signToken, type JwtPayload } from "../middleware/auth";

export class AuthController {
  constructor(private readonly prisma: PrismaClient) {}

  login = async (req: Request, res: Response): Promise<void> => {
    try {
      const { email, password } = req.body as { email: string; password: string };

      if (!email || !password) {
        res.status(400).json({ error: "BAD_REQUEST", message: "Email and password required." });
        return;
      }

      // Demo admin bypass — in production, hash-compare passwords
      if (email === "admin@gemstream.io" && password === "admin") {
        const token = signToken({ userId: "admin-001", email, role: "ADMIN" });
        res.status(200).json({
          token,
          user: { userId: "admin-001", email, role: "ADMIN", username: "Admin" },
        });
        return;
      }

      const user = await this.prisma.user.findUnique({ where: { email } });
      if (!user) {
        res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid credentials." });
        return;
      }

      const payload: JwtPayload = { userId: user.id, email: user.email, role: user.role };
      const token = signToken(payload);
      res.status(200).json({
        token,
        user: { userId: user.id, email: user.email, role: user.role, username: user.username },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error.";
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message });
    }
  };

  me = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }

    if (req.user.role === "ADMIN" && req.user.userId === "admin-001") {
      res.status(200).json({
        userId: req.user.userId,
        email: req.user.email,
        role: req.user.role,
        username: "Admin",
      });
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, email: true, role: true, username: true },
    });

    if (!user) {
      res.status(401).json({ error: "UNAUTHORIZED", message: "User no longer exists." });
      return;
    }

    res.status(200).json({
      userId: user.id,
      email: user.email,
      role: user.role,
      username: user.username,
    });
  };
}
