"use client";

import { useState, useEffect, useRef } from "react";
import { Terminal, Pause, Play, Trash2 } from "lucide-react";
import { useAuth } from "../../../lib/auth";
import { useSocket } from "../../../lib/socket";
import type { TipAlertPayload } from "../../../lib/api";

interface LogEntry {
  id: number;
  ts: string;
  level: "info" | "warn" | "error" | "event";
  source: string;
  message: string;
}

let logId = 0;

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function levelColor(level: LogEntry["level"]): string {
  switch (level) {
    case "info":
      return "text-blue-400";
    case "warn":
      return "text-yellow-400";
    case "error":
      return "text-red-400";
    case "event":
      return "text-green-400";
  }
}

export default function LogsPage() {
  const { user } = useAuth();
  const { status, socket } = useSocket();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const addLog = (
    level: LogEntry["level"],
    source: string,
    message: string
  ) => {
    if (paused) return;
    setLogs((prev) =>
      [
        ...prev,
        { id: ++logId, ts: timestamp(), level, source, message },
      ].slice(-200)
    );
  };

  // Socket events → log entries
  useEffect(() => {
    if (!socket) return;

    const onConnect = () => addLog("info", "Socket.io", "Connected to backend");
    const onDisconnect = (reason: string) =>
      addLog("warn", "Socket.io", `Disconnected: ${reason}`);
    const onError = (err: Error) =>
      addLog("error", "Socket.io", `Connection error: ${err.message}`);
    const onTip = (p: TipAlertPayload) =>
      addLog(
        "event",
        "AlertService",
        `TIP_DISPATCHED → ${p.viewerUsername} sent ${p.gemAmount} Gems (tipId=${p.tipId})`
      );

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onError);
    socket.on("TIP_DISPATCHED", onTip);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onError);
      socket.off("TIP_DISPATCHED", onTip);
    };
  }, [socket, paused]);

  // Initial boot log
  useEffect(() => {
    addLog("info", "System", "Live log viewer initialized");
    addLog("info", "System", `Socket status: ${status}`);
    if (user) addLog("info", "Auth", `Authenticated as ${user.role}: ${user.email}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, paused]);

  if (user?.role !== "ADMIN") {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-500">Admin access required.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-green-400" />
          <h2 className="text-lg font-semibold text-white">System Logs</h2>
          <span className="ml-2 rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
            {logs.length} entries
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaused(!paused)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              paused
                ? "border-yellow-500/30 bg-yellow-950/30 text-yellow-400"
                : "border-zinc-700 text-zinc-400 hover:text-white"
            }`}
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => setLogs([])}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:text-red-400"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto bg-zinc-950 p-4 font-mono text-xs leading-6"
      >
        {logs.length === 0 ? (
          <p className="text-zinc-600">Waiting for events...</p>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className="flex gap-3 hover:bg-zinc-900/50 px-2 -mx-2 rounded">
              <span className="shrink-0 text-zinc-600">{entry.ts}</span>
              <span className={`shrink-0 w-12 uppercase font-bold ${levelColor(entry.level)}`}>
                {entry.level}
              </span>
              <span className="shrink-0 text-zinc-500">[{entry.source}]</span>
              <span className="text-zinc-300">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
