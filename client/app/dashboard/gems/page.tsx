"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Gem, ShoppingCart, CheckCircle, XCircle } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useAuth } from "../../../lib/auth";
import { createCheckoutSession } from "../../../lib/api";

const BUNDLE = {
  id: "100_GEMS",
  gems: 100,
  priceCents: 1150,
  display: "$11.50",
  description: "One-time purchase. Gems never expire.",
};

function BuyGemsContent() {
  const { user } = useAuth();
  const searchParams = useSearchParams();
  const success = searchParams.get("success") === "1";
  const cancelled = searchParams.get("cancelled") === "1";

  const mutation = useMutation({
    mutationFn: createCheckoutSession,
    onSuccess: (data) => {
      window.location.href = data.checkoutUrl;
    },
  });

  const handlePurchase = () => {
    if (!user) return;
    const origin = window.location.origin;
    mutation.mutate({
      viewerId: user.userId,
      bundleId: BUNDLE.id,
      email: user.email,
      successUrl: `${origin}/dashboard/gems?success=1`,
      cancelUrl: `${origin}/dashboard/gems?cancelled=1`,
    });
  };

  return (
    <div>
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur-sm">
        <h2 className="text-lg font-semibold text-white">Buy Gems</h2>
        <p className="text-xs text-zinc-500">
          Purchase Gems to tip your favourite streamers
        </p>
      </header>

      <div className="p-6 max-w-lg">
        {success && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-500/30 bg-green-950/40 px-4 py-3 text-sm text-green-300">
            <CheckCircle className="h-5 w-5 shrink-0 text-green-400" />
            Payment successful! Your Gems will be credited within a few seconds.
          </div>
        )}
        {cancelled && (
          <div className="mb-6 flex items-center gap-3 rounded-xl border border-yellow-500/30 bg-yellow-950/40 px-4 py-3 text-sm text-yellow-300">
            <XCircle className="h-5 w-5 shrink-0 text-yellow-400" />
            Payment cancelled — no charge was made.
          </div>
        )}
        {mutation.isError && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Failed to start checkout. Please try again."}
          </div>
        )}

        <div className="rounded-2xl border border-purple-500/20 bg-gradient-to-b from-purple-950/40 to-zinc-900/60 p-6 shadow-lg">
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/20">
                <Gem className="h-6 w-6 text-purple-400" />
              </div>
              <div>
                <p className="font-semibold text-white">100 Gems Bundle</p>
                <p className="text-xs text-zinc-500">{BUNDLE.description}</p>
              </div>
            </div>
            <p className="text-2xl font-bold text-white">{BUNDLE.display}</p>
          </div>

          <div className="mb-5 space-y-2 rounded-lg bg-zinc-800/40 px-4 py-3 text-xs text-zinc-400">
            <div className="flex justify-between">
              <span>Gems granted</span>
              <span className="font-medium text-purple-300">100 Gems</span>
            </div>
            <div className="flex justify-between">
              <span>1 Gem</span>
              <span className="text-zinc-300">= $0.10 USDT</span>
            </div>
            <div className="flex justify-between border-t border-zinc-700 pt-2 mt-2">
              <span>Total</span>
              <span className="font-semibold text-white">{BUNDLE.display} USD</span>
            </div>
          </div>

          <button
            onClick={handlePurchase}
            disabled={mutation.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
          >
            {mutation.isPending ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Redirecting to Stripe...
              </>
            ) : (
              <>
                <ShoppingCart className="h-4 w-4" />
                Purchase with Stripe — {BUNDLE.display}
              </>
            )}
          </button>

          <p className="mt-3 text-center text-xs text-zinc-600">
            Secured by Stripe · 3D Secure enforced · No charge until confirmed
          </p>
        </div>

        <p className="mt-4 text-xs text-zinc-600">
          This is a test-mode integration. Use Stripe test card{" "}
          <span className="font-mono text-zinc-500">4242 4242 4242 4242</span>{" "}
          with any future expiry and any CVC.
        </p>
      </div>
    </div>
  );
}

export default function BuyGemsPage() {
  return (
    <Suspense>
      <BuyGemsContent />
    </Suspense>
  );
}
