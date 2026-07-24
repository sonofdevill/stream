"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Gem,
  Clock,
  Wallet,
  Wifi,
  WifiOff,
  Send,
  TrendingUp,
} from "lucide-react";
import { dispatchTestAlert, type TipAlertPayload } from "../../lib/api";
import { useAlertHealth, useBalance } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { useSocket } from "../../lib/socket";

// ── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-zinc-800/60 ${className}`} />;
}

// ── Toast Banner ─────────────────────────────────────────────────────────────

function Banner({
  message,
  type,
  onClose,
}: {
  message: string;
  type: "success" | "error";
  onClose: () => void;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-lg border px-4 py-2.5 text-sm ${
        type === "success"
          ? "border-green-500/30 bg-green-950/60 text-green-300"
          : "border-red-500/30 bg-red-950/60 text-red-300"
      }`}
    >
      <span>{message}</span>
      <button onClick={onClose} className="ml-4 opacity-60 hover:opacity-100">
        x
      </button>
    </div>
  );
}

// ── Metric Card ──────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  accent: string;
}) {
  return (
    <div className={`rounded-xl border bg-gradient-to-br p-5 ${accent}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
          {label}
        </p>
        <Icon className="h-4 w-4 text-zinc-500" />
      </div>
      <p className="mt-3 text-3xl font-bold text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

// ── Tip Table ────────────────────────────────────────────────────────────────

function TipTable({ tips }: { tips: TipAlertPayload[] }) {
  if (tips.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-10 text-center text-sm text-zinc-500">
        No tips yet. Use the Testing Suite above to send one.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 bg-zinc-900/80 text-left text-xs uppercase tracking-wider text-zinc-500">
            <th className="px-4 py-3 font-medium">Viewer</th>
            <th className="px-4 py-3 font-medium">Amount</th>
            <th className="px-4 py-3 font-medium">Message</th>
            <th className="px-4 py-3 font-medium text-right">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/50">
          {tips.map((tip, i) => (
            <tr key={`${tip.tipId}-${i}`} className="bg-zinc-950/50 hover:bg-zinc-800/20">
              <td className="px-4 py-3 font-medium text-white">{tip.viewerUsername}</td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/15 px-2.5 py-0.5 text-xs font-semibold text-purple-300">
                  <Gem className="h-3 w-3" />
                  {tip.gemAmount.toLocaleString()}
                </span>
              </td>
              <td className="max-w-[200px] truncate px-4 py-3 text-zinc-400">
                {tip.customMessage ?? "—"}
              </td>
              <td className="px-4 py-3 text-right">
                <span className="inline-flex items-center gap-1 text-xs text-green-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                  Delivered
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Testing Suite ────────────────────────────────────────────────────────────

function TestingSuite({
  streamerId,
  onResult,
}: {
  streamerId: string;
  onResult: (msg: string, type: "success" | "error") => void;
}) {
  const [viewer, setViewer] = useState("TestViewer");
  const [gems, setGems] = useState(100);
  const [msg, setMsg] = useState("Hello from dashboard!");

  const mutation = useMutation({
    mutationFn: dispatchTestAlert,
    onSuccess: () => onResult("Test alert dispatched!", "success"),
    onError: (err: Error) => onResult(`Failed: ${err.message}`, "error"),
  });

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-4 flex items-center gap-2">
        <Send className="h-4 w-4 text-purple-400" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
          Testing Suite
        </h3>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-zinc-500">Viewer Name</label>
          <input
            value={viewer}
            onChange={(e) => setViewer(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-purple-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-500">Gem Amount</label>
          <input
            type="number"
            value={gems}
            onChange={(e) => setGems(Number(e.target.value))}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-purple-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-zinc-500">Message</label>
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-purple-500"
          />
        </div>
      </div>
      <button
        disabled={mutation.isPending}
        onClick={() =>
          mutation.mutate({
            tipId: `test-${Date.now()}`,
            streamerId,
            viewerUsername: viewer,
            gemAmount: gems,
            customMessage: msg || null,
          })
        }
        className="mt-4 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
      >
        {mutation.isPending ? "Sending..." : "Send Test Alert"}
      </button>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const STREAMER_ID = "UUID_STREAMER_TEST";

export default function OverviewPage() {
  const { user } = useAuth();
  const { status, recentTips, sessionGems } = useSocket();
  const healthQuery = useAlertHealth();
  const balanceQuery = useBalance(user?.role === "STREAMER" ? user.userId : null);
  const [banner, setBanner] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const balance = balanceQuery.data;

  return (
    <div>
      {/* Header */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur-sm">
        <div>
          <h2 className="text-lg font-semibold text-white">Dashboard</h2>
          <p className="text-xs text-zinc-500">
            Welcome back, {user?.username ?? "Admin"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              healthQuery.data?.status === "ok"
                ? "bg-green-400"
                : healthQuery.isLoading
                  ? "bg-yellow-400 animate-pulse"
                  : "bg-red-400"
            }`}
          />
          <span className="text-xs text-zinc-400">
            {healthQuery.data?.status === "ok" ? "Backend Online" : healthQuery.isLoading ? "Checking..." : "Backend Offline"}
          </span>
        </div>
      </header>

      <div className="space-y-6 p-6">
        {banner && (
          <Banner
            message={banner.msg}
            type={banner.type}
            onClose={() => setBanner(null)}
          />
        )}

        {/* Metrics Grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {balanceQuery.isLoading && user?.role === "STREAMER" ? (
            <>
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </>
          ) : (
            <>
              <MetricCard
                label="Total Gems (Session)"
                value={sessionGems.toLocaleString()}
                sub="Since page load"
                icon={TrendingUp}
                accent="from-purple-500/20 to-purple-600/5 border-purple-500/20"
              />
              <MetricCard
                label="Pending Balance"
                value={balance?.pendingBalance?.toLocaleString() ?? sessionGems.toLocaleString()}
                sub="14-day clearance window"
                icon={Clock}
                accent="from-amber-500/20 to-amber-600/5 border-amber-500/20"
              />
              <MetricCard
                label="Available Balance"
                value={balance?.availableBalance?.toLocaleString() ?? "0"}
                sub="Ready for USDT payout"
                icon={Wallet}
                accent="from-green-500/20 to-green-600/5 border-green-500/20"
              />
              <MetricCard
                label="Socket Status"
                value={status === "connected" ? "Live" : "Offline"}
                sub={status === "connected" ? "Real-time tips active" : "Check connection"}
                icon={status === "connected" ? Wifi : WifiOff}
                accent="from-blue-500/20 to-blue-600/5 border-blue-500/20"
              />
            </>
          )}
        </div>

        {/* Testing Suite */}
        <TestingSuite
          streamerId={STREAMER_ID}
          onResult={(msg, type) => {
            setBanner({ msg, type });
            setTimeout(() => setBanner(null), 4000);
          }}
        />

        {/* Recent Tips */}
        <div>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-300">
            Recent Tips
          </h3>
          <TipTable tips={recentTips} />
        </div>
      </div>
    </div>
  );
}
