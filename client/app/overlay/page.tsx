"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { getSocketUrl } from "../../lib/urls";

interface TipPayload {
  tipId: string;
  streamerId: string;
  viewerUsername: string;
  gemAmount: number;
  customMessage: string | null;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

const DISPLAY_DURATION_MS = 6000;
const FADE_DURATION_MS = 500;

export default function OverlayPage() {
  const [tip, setTip] = useState<TipPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [debugMsg, setDebugMsg] = useState("Initializing...");
  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";

    const params = new URLSearchParams(window.location.search);
    const streamerId = params.get("streamerId");

    if (!streamerId) {
      const msg = "Missing ?streamerId= query parameter";
      console.error("[Overlay]", msg);
      setDebugMsg(msg);
      setStatus("error");
      return;
    }

    const socketUrl = getSocketUrl();
    setDebugMsg(`Connecting to ${socketUrl}...`);

    const socket = io(socketUrl, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;
    (window as unknown as Record<string, unknown>).__socket = socket;

    socket.on("connect", () => {
      console.info("[Overlay] Connected, joining room:", streamerId);
      setDebugMsg(`Connected (${socket.id}), joined room: ${streamerId}`);
      setStatus("connected");
      socket.emit("join-room", streamerId);
    });

    socket.on("disconnect", (reason) => {
      console.warn("[Overlay] Disconnected:", reason);
      setDebugMsg(`Disconnected: ${reason}`);
      setStatus("disconnected");
    });

    socket.on("connect_error", (err) => {
      console.error("[Overlay] Connection error:", err.message);
      setDebugMsg(`Connection error: ${err.message}`);
      setStatus("error");
    });

    socket.on("TIP_DISPATCHED", (payload: TipPayload) => {
      console.info("[Overlay] Tip received:", payload.tipId);
      setDebugMsg(`Tip received: ${payload.gemAmount} gems from ${payload.viewerUsername}`);

      if (timerRef.current) clearTimeout(timerRef.current);

      setTip(payload);
      setVisible(true);

      timerRef.current = setTimeout(() => {
        setVisible(false);
        timerRef.current = setTimeout(() => setTip(null), FADE_DURATION_MS);
      }, DISPLAY_DURATION_MS);
    });

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      socket.disconnect();
    };
  }, []);

  const statusColor =
    status === "connected"
      ? "bg-green-500"
      : status === "error"
        ? "bg-red-500"
        : "bg-yellow-500";

  return (
    <div className="relative h-screen w-screen overflow-hidden" style={{ background: "transparent" }}>
      {/* Debug status bar — remove after confirming it works */}
      <div className="absolute bottom-2 left-2 flex items-center gap-2 rounded bg-black/70 px-3 py-1 text-xs text-white">
        <span className={`inline-block h-2 w-2 rounded-full ${statusColor}`} />
        <span>{debugMsg}</span>
      </div>

      {tip && (
        <div
          className={`absolute top-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 rounded-2xl border border-purple-500/30 bg-gradient-to-b from-purple-950/90 to-indigo-950/90 px-10 py-8 shadow-[0_0_40px_rgba(139,92,246,0.3)] backdrop-blur-md transition-all ${
            visible ? "scale-100 opacity-100" : "scale-90 opacity-0"
          }`}
          style={{
            transitionDuration: `${FADE_DURATION_MS}ms`,
            transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <div className="text-4xl">💎</div>

          <p className="text-center text-2xl font-bold tracking-tight text-white">
            <span className="bg-gradient-to-r from-amber-300 to-yellow-400 bg-clip-text text-transparent">
              {tip.viewerUsername}
            </span>{" "}
            tipped{" "}
            <span className="bg-gradient-to-r from-purple-300 to-fuchsia-400 bg-clip-text text-transparent">
              {tip.gemAmount.toLocaleString()} Gems
            </span>
          </p>

          {tip.customMessage && (
            <p className="max-w-sm text-center text-lg leading-relaxed text-purple-100/90 italic">
              &ldquo;{tip.customMessage}&rdquo;
            </p>
          )}

          <div className="absolute -inset-px -z-10 rounded-2xl bg-gradient-to-r from-purple-500/20 via-fuchsia-500/20 to-indigo-500/20 blur-xl" />
        </div>
      )}
    </div>
  );
}
