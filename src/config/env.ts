import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  STRIPE_SECRET_KEY: z.string().min(1, "STRIPE_SECRET_KEY is required"),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, "STRIPE_WEBHOOK_SECRET is required"),
  POLYGON_RPC_URL: z.string().url("POLYGON_RPC_URL must be a valid URL"),
  HOT_WALLET_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "HOT_WALLET_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key"),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters for HS256 signing"),
  /** Single origin allowed for dashboard REST API (strict CORS). */
  DASHBOARD_ORIGIN: z.string().url("DASHBOARD_ORIGIN must be a valid URL"),
  /** Comma-separated origins for Socket.io (dashboard + OBS overlay). */
  ALLOWED_ORIGINS: z.string().min(1, "ALLOWED_ORIGINS is required"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/** Parse and validate process.env. Throws on first invalid/missing value. */
export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[GemStream] Environment validation failed:\n" + formatZodError(parsed.error));
    process.exit(1);
  }
  return parsed.data;
}

/** Validated environment — call validateEnv() at startup before use. */
export function getEnv(): Env {
  if (!cached) {
    cached = validateEnv();
  }
  return cached;
}

export function getAllowedOrigins(): string[] {
  return getEnv()
    .ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
