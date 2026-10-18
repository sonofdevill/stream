"use client";

import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Copy,
  Check,
  Wallet,
  Monitor,
  Sparkles,
  Clock,
  Eye,
} from "lucide-react";
import { dispatchTestAlert, updateWallet } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

function isValidPolygonAddress(addr: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function WidgetConfigurator({ streamerId }: { streamerId: string }) {
  const [overlayUrl, setOverlayUrl] = useState("");
  const [duration, setDuration] = useState(6);
  const [previewVisible, setPreviewVisible] = useState(false);

  useEffect(() => {
    setOverlayUrl(`${window.location.origin}/overlay?streamerId=${streamerId}`);
  }, [streamerId]);

  const testMutation = useMutation({
    mutationFn: dispatchTestAlert,
    onSuccess: () => {
      setPreviewVisible(true);
      setTimeout(() => setPreviewVisible(false), duration * 1000);
    },
  });

  return (
    <div className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="flex items-center gap-2">
        <Monitor className="h-4 w-4 text-purple-400" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
          Widget Configurator
        </h3>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-400">
          OBS Browser Source URL
        </label>
        <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5">
          <code className="flex-1 truncate text-xs text-green-400 font-mono">
            {overlayUrl}
          </code>
          <CopyButton text={overlayUrl} />
        </div>
        <p className="mt-1 text-xs text-zinc-600">
          Add this as a Browser Source in OBS (1920×1080, transparent background).
        </p>
      </div>

      <div>
        <label className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-400">
          <Clock className="h-3.5 w-3.5" />
          Alert Display Duration
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={2}
            max={15}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="flex-1 accent-purple-500"
          />
          <span className="w-12 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1 text-center text-sm text-white">
            {duration}s
          </span>
        </div>
      </div>

      <div>
        <label className="mb-1.5 flex items-center gap-2 text-xs font-medium text-zinc-400">
          <Eye className="h-3.5 w-3.5" />
          Alert Preview
        </label>
        <div className="relative overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 p-4 min-h-[120px] flex items-center justify-center">
          {previewVisible ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-purple-500/30 bg-gradient-to-b from-purple-950/90 to-indigo-950/90 px-8 py-5 shadow-[0_0_30px_rgba(139,92,246,0.25)]">
              <Sparkles className="h-6 w-6 text-amber-400" />
              <p className="text-sm font-bold text-white">
                <span className="text-amber-300">PreviewUser</span>{" "}
                tipped{" "}
                <span className="text-purple-300">250 Gems</span>
              </p>
              <p className="text-xs italic text-purple-200/80">&ldquo;Test preview!&rdquo;</p>
            </div>
          ) : (
            <p className="text-xs text-zinc-600">
              Click &ldquo;Test Alert&rdquo; to preview the animation
            </p>
          )}
        </div>
        <button
          disabled={testMutation.isPending}
          onClick={() =>
            testMutation.mutate({
              tipId: `preview-${Date.now()}`,
              streamerId,
              viewerUsername: "PreviewUser",
              gemAmount: 250,
              customMessage: "Test preview!",
            })
          }
          className="mt-3 rounded-lg bg-purple-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
        >
          {testMutation.isPending ? "Sending..." : "Test Alert"}
        </button>
      </div>
    </div>
  );
}

function WalletManager({ initialAddress }: { initialAddress?: string | null }) {
  const [address, setAddress] = useState(initialAddress ?? "");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: (addr: string) => updateWallet(addr),
  });

  const handleSave = () => {
    setError("");
    mutation.reset();

    if (!address) {
      setError("Wallet address is required.");
      return;
    }
    if (!isValidPolygonAddress(address)) {
      setError("Invalid Polygon address. Must be 0x followed by 40 hex characters.");
      return;
    }

    mutation.mutate(address);
  };

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <div className="flex items-center gap-2">
        <Wallet className="h-4 w-4 text-green-400" />
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300">
          Payout Wallet
        </h3>
      </div>

      <p className="text-xs text-zinc-500">
        USDT payouts are sent to this Polygon (MATIC) address. Minimum payout: 500 Gems ($50 USDT).
      </p>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-zinc-400">
          Polygon Wallet Address
        </label>
        <input
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setError("");
            mutation.reset();
          }}
          placeholder="0x..."
          className={`w-full rounded-lg border bg-zinc-800 px-3 py-2.5 text-sm font-mono text-white outline-none transition-colors ${
            error
              ? "border-red-500 focus:border-red-400"
              : mutation.isSuccess
                ? "border-green-500 focus:border-green-400"
                : "border-zinc-700 focus:border-purple-500"
          }`}
        />
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
        {mutation.isError && (
          <p className="mt-1 text-xs text-red-400">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Failed to save. Please try again."}
          </p>
        )}
        {mutation.isSuccess && (
          <p className="mt-1 flex items-center gap-1 text-xs text-green-400">
            <Check className="h-3 w-3" /> Wallet address saved
          </p>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={mutation.isPending}
        className="rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:opacity-50"
      >
        {mutation.isPending ? "Saving..." : "Save Address"}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();

  // Admin uses the test streamer ID for demo purposes.
  // Real streamers use their own userId as the room/streamer identifier.
  const streamerId =
    user?.role === "ADMIN" ? "UUID_STREAMER_TEST" : (user?.userId ?? "UUID_STREAMER_TEST");

  return (
    <div>
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur-sm">
        <h2 className="text-lg font-semibold text-white">Settings</h2>
        <p className="text-xs text-zinc-500">
          {user?.role === "ADMIN" ? "Admin" : "Streamer"} configuration
        </p>
      </header>

      <div className="space-y-6 p-6">
        <WidgetConfigurator streamerId={streamerId} />
        <WalletManager initialAddress={user?.walletAddress} />
      </div>
    </div>
  );
}
