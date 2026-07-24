import request from "supertest";
import type Stripe from "stripe";
import { CLEARING_WINDOW_MS } from "../src/types/ledger";
import { signToken } from "../src/middleware/auth";
import { AlertService } from "../src/services/AlertService";
import { createTestApp } from "./helpers/createTestApp";
import {
  disconnectTestPrisma,
  getTestPrisma,
  resetDatabase,
  seedViewerAndStreamer,
} from "./helpers/db";

const TIP_EVENT_NAME = "TIP_DISPATCHED";

describe("Donation Flow (integration)", () => {
  const prisma = getTestPrisma();
  let alertService: AlertService;
  let mockStripe: Stripe;
  let mockConstructEvent: jest.Mock;
  let mockEmit: jest.Mock;
  let mockTo: jest.Mock;

  beforeEach(async () => {
    await resetDatabase(prisma);

    mockEmit = jest.fn();
    mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
    mockConstructEvent = jest.fn();

    alertService = new AlertService();
    Object.defineProperty(alertService, "io", {
      value: { to: mockTo },
      writable: true,
      configurable: true,
    });

    mockStripe = {
      webhooks: { constructEvent: mockConstructEvent },
    } as unknown as Stripe;
  });

  afterAll(async () => {
    await disconnectTestPrisma();
  });

  it("credits Gems via Stripe webhook, tips streamer into pendingBalance, and emits TIP_DISPATCHED to the streamer room", async () => {
    const { viewer, streamer } = await seedViewerAndStreamer(prisma);
    const tipAmount = 50;
    const bundleGems = 100;
    const stripeEventId = "evt_donation_integration_001";
    const paymentIntentId = "pi_donation_integration_001";

    mockConstructEvent.mockReturnValue({
      id: stripeEventId,
      type: "checkout.session.completed",
      data: {
        object: {
          payment_intent: paymentIntentId,
          metadata: {
            viewerId: viewer.id,
            bundleId: "100_GEMS",
            gemsGranted: String(bundleGems),
          },
        },
      },
    });

    const webhookPayload = {
      id: stripeEventId,
      type: "checkout.session.completed",
    };
    const rawBody = Buffer.from(JSON.stringify(webhookPayload));

    const { app } = createTestApp({ prisma, stripe: mockStripe, alertService });

    const webhookRes = await request(app)
      .post("/stripe/webhook")
      .set("stripe-signature", "sig_test_valid")
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(webhookRes.status).toBe(200);
    expect(webhookRes.body).toMatchObject({
      received: true,
      outcome: "processed",
      stripeEventId,
      gemsGranted: bundleGems,
      viewerId: viewer.id,
    });

    expect(mockConstructEvent).toHaveBeenCalledTimes(1);
    expect(mockConstructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      "sig_test_valid",
      process.env.STRIPE_WEBHOOK_SECRET
    );

    const viewerAfterDeposit = await prisma.user.findUniqueOrThrow({
      where: { id: viewer.id },
    });
    expect(viewerAfterDeposit.gemBalance).toBe(bundleGems);

    const depositLog = await prisma.fiatDepositLog.findFirstOrThrow({
      where: { viewerId: viewer.id },
    });
    expect(depositLog.gemsGranted).toBe(bundleGems);
    expect(depositLog.amountPaidCents).toBe(1150);
    expect(depositLog.stripePaymentIntentId).toBe(paymentIntentId);

    const viewerToken = signToken({
      userId: viewer.id,
      email: viewer.email,
      role: "VIEWER",
    });

    const tipBefore = Date.now();
    const tipRes = await request(app)
      .post("/ledger/tip")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({
        viewerId: viewer.id,
        streamerId: streamer.id,
        gemAmount: tipAmount,
        customMessage: "Great stream!",
        fiatDepositLogId: depositLog.id,
      });

    expect(tipRes.status).toBe(201);
    expect(tipRes.body).toMatchObject({
      viewerRemainingBalance: bundleGems - tipAmount,
      streamerNewPendingBalance: tipAmount,
      alertPayload: {
        streamerId: streamer.id,
        viewerUsername: viewer.username,
        gemAmount: tipAmount,
        customMessage: "Great stream!",
      },
    });

    // AlertService must target the streamer's Socket.io room only.
    expect(mockTo).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith(streamer.id);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      TIP_EVENT_NAME,
      expect.objectContaining({
        streamerId: streamer.id,
        viewerUsername: viewer.username,
        gemAmount: tipAmount,
        customMessage: "Great stream!",
        tipId: expect.any(String),
      })
    );

    const [viewerFinal, streamerFinal, tipEvent] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: viewer.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: streamer.id } }),
      prisma.tipEvent.findFirstOrThrow({ where: { streamerId: streamer.id } }),
    ]);

    // Conservation: viewer spent exactly tipAmount; streamer holds it in pending (14-day fortress).
    expect(viewerFinal.gemBalance).toBe(bundleGems - tipAmount);
    expect(streamerFinal.pendingBalance).toBe(tipAmount);
    expect(streamerFinal.availableBalance).toBe(0);

    expect(tipEvent.status).toBe("PENDING");
    expect(tipEvent.gemAmount).toBe(tipAmount);
    expect(tipEvent.fiatDepositLogId).toBe(depositLog.id);

    const clearedAtMs = tipEvent.clearedAt.getTime();
    const expectedClearMs = tipBefore + CLEARING_WINDOW_MS;
    expect(clearedAtMs).toBeGreaterThanOrEqual(expectedClearMs - 5_000);
    expect(clearedAtMs).toBeLessThanOrEqual(expectedClearMs + 60_000);
  });

  it("skips duplicate Stripe webhook deliveries without double-crediting the viewer", async () => {
    const { viewer } = await seedViewerAndStreamer(prisma);
    const stripeEventId = "evt_donation_idempotent_001";

    mockConstructEvent.mockReturnValue({
      id: stripeEventId,
      type: "checkout.session.completed",
      data: {
        object: {
          payment_intent: "pi_idempotent_001",
          metadata: {
            viewerId: viewer.id,
            bundleId: "100_GEMS",
            gemsGranted: "100",
          },
        },
      },
    });

    const rawBody = Buffer.from(JSON.stringify({ id: stripeEventId }));
    const { app } = createTestApp({ prisma, stripe: mockStripe, alertService });

    const first = await request(app)
      .post("/stripe/webhook")
      .set("stripe-signature", "sig_test")
      .send(rawBody);
    const second = await request(app)
      .post("/stripe/webhook")
      .set("stripe-signature", "sig_test")
      .send(rawBody);

    expect(first.body.outcome).toBe("processed");
    expect(second.body.outcome).toBe("skipped");

    const viewerFinal = await prisma.user.findUniqueOrThrow({ where: { id: viewer.id } });
    expect(viewerFinal.gemBalance).toBe(100);

    const depositCount = await prisma.fiatDepositLog.count({ where: { viewerId: viewer.id } });
    expect(depositCount).toBe(1);
  });
});
