import { execSync } from "child_process";
import path from "path";

export default async function globalSetup(): Promise<void> {
  const root = path.resolve(__dirname, "..");
  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    "postgresql://gemstream:gemstream@127.0.0.1:5432/gemstream_test?schema=public";

  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
    stdio: "inherit",
  });
}
