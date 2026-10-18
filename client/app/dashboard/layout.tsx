"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Settings,
  History,
  ScrollText,
  LogOut,
  Wifi,
  WifiOff,
  AlertTriangle,
  ChevronRight,
  Gem,
} from "lucide-react";
import { AuthProvider, useAuth } from "../../lib/auth";
import { SocketProvider, useConnectionStatus } from "../../lib/socket";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

const STREAMER_ID = "UUID_STREAMER_TEST";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/gems", label: "Buy Gems", icon: Gem },
  { href: "/dashboard/transactions", label: "Transactions", icon: History },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
  { href: "/dashboard/logs", label: "System Logs", icon: ScrollText },
] as const;

function ConnectionDot() {
  const status = useConnectionStatus();
  const color =
    status === "connected"
      ? "bg-green-400"
      : status === "error"
        ? "bg-red-400"
        : "bg-yellow-400";
  const Icon =
    status === "connected"
      ? Wifi
      : status === "error"
        ? AlertTriangle
        : WifiOff;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      <Icon className="h-3.5 w-3.5" />
      <span className="capitalize">{status}</span>
    </div>
  );
}

function AdminShell({ children }: { children: ReactNode }) {
  const { user, logout, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !user) router.push("/login");
  }, [isLoading, user, router]);

  if (isLoading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
      </div>
    );
  }

  const isAdmin = user.role === "ADMIN";

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
        {/* Logo */}
        <div className="flex items-center gap-2.5 border-b border-zinc-800 px-5 py-4">
          <span className="text-xl">💎</span>
          <h1 className="text-lg font-bold text-white">GemStream</h1>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV.map((item) => {
            if (item.href === "/dashboard/logs" && !isAdmin) return null;
            const active = pathname === item.href;
            return (
              <button
                key={item.href}
                onClick={() => router.push(item.href)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-purple-500/15 text-purple-300"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
                {active && (
                  <ChevronRight className="ml-auto h-3.5 w-3.5 text-purple-400" />
                )}
              </button>
            );
          })}
        </nav>

        {/* Socket Status */}
        <div className="border-t border-zinc-800 p-3">
          <ConnectionDot />
        </div>

        {/* User / Logout */}
        <div className="border-t border-zinc-800 p-3">
          <div className="flex items-center gap-3 rounded-lg px-3 py-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-500/20 text-xs font-bold text-purple-300">
              {user.username?.charAt(0).toUpperCase() ?? "U"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">
                {user.username}
              </p>
              <p className="truncate text-xs text-zinc-500">{user.role}</p>
            </div>
            <button
              onClick={logout}
              className="text-zinc-500 transition-colors hover:text-red-400"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SocketProvider streamerId={STREAMER_ID}>
          <AdminShell>{children}</AdminShell>
        </SocketProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
