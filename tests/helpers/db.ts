import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

/** Wipes transactional tables between tests while preserving schema. */
export async function resetDatabase(client = getTestPrisma()): Promise<void> {
  await client.$executeRawUnsafe(`
    TRUNCATE TABLE
      "TipEvent",
      "FiatDepositLog",
      "PayoutLog",
      "ProcessedWebhooks",
      "User"
    RESTART IDENTITY CASCADE;
  `);
}

export interface SeedUsers {
  viewer: { id: string; email: string; username: string };
  streamer: { id: string; email: string; username: string };
}

export async function seedViewerAndStreamer(
  client = getTestPrisma()
): Promise<SeedUsers> {
  const viewer = await client.user.create({
    data: {
      email: "viewer@test.gemstream.io",
      username: "TestViewer",
      role: "VIEWER",
      gemBalance: 0,
    },
    select: { id: true, email: true, username: true },
  });

  const streamer = await client.user.create({
    data: {
      email: "streamer@test.gemstream.io",
      username: "TestStreamer",
      role: "STREAMER",
      pendingBalance: 0,
      availableBalance: 0,
      walletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
    },
    select: { id: true, email: true, username: true },
  });

  return { viewer, streamer };
}
