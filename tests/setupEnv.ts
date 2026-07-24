/**
 * Loads required environment variables before any application modules import env validation.
 * Must run via Jest setupFiles (not setupFilesAfterEnv).
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://gemstream:gemstream@127.0.0.1:5432/gemstream_test?schema=public";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_integration";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_integration";
process.env.POLYGON_RPC_URL = process.env.POLYGON_RPC_URL ?? "https://rpc-amoy.polygon.technology";
process.env.HOT_WALLET_PRIVATE_KEY =
  process.env.HOT_WALLET_PRIVATE_KEY ??
  "0x0000000000000000000000000000000000000000000000000000000000000001";
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? "gemstream-test-jwt-secret-min-32-chars!!";
process.env.DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://localhost:3001";
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?? "http://localhost:3001";
process.env.PORT = process.env.PORT ?? "4000";
