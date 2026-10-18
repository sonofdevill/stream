"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { io, Socket } from "socket.io-client";
import type { TipAlertPayload } from "./api";
import { getSocketUrl } from "./urls";

type Status = "connected" | "disconnected" | "error";

interface SocketState {
  status: Status;
  recentTips: TipAlertPayload[];
  sessionGems: number;
  socket: Socket | null;
}

const SocketContext = createContext<SocketState>({
  status: "disconnected",
  recentTips: [],
  sessionGems: 0,
  socket: null,
});

export function SocketProvider({
  streamerId,
  children,
}: {
  streamerId: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<Status>("disconnected");
  const [recentTips, setRecentTips] = useState<TipAlertPayload[]>([]);
  const [sessionGems, setSessionGems] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!streamerId) return;

    const socketUrl = getSocketUrl();
    const socket = io(socketUrl, {
      path: "/socket.io",
      transports: ["polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("connected");
      socket.emit("join-room", streamerId);
    });
    socket.on("disconnect", () => setStatus("disconnected"));
    socket.on("connect_error", () => setStatus("error"));

    socket.on("TIP_DISPATCHED", (payload: TipAlertPayload) => {
      setRecentTips((prev) => [payload, ...prev].slice(0, 50));
      setSessionGems((prev) => prev + payload.gemAmount);
    });

    return () => {
      socket.disconnect();
    };
  }, [streamerId]);

  return (
    <SocketContext.Provider
      value={{ status, recentTips, sessionGems, socket: socketRef.current }}
    >
      {children}
    </SocketContext.Provider>
  );
}

export function useConnectionStatus() {
  return useContext(SocketContext).status;
}

export function useRecentTips() {
  const ctx = useContext(SocketContext);
  return { tips: ctx.recentTips, sessionGems: ctx.sessionGems };
}

export function useSocket() {
  return useContext(SocketContext);
}
