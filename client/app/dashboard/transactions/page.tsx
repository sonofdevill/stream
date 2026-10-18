"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Filter,
  Gem,
  RefreshCw,
} from "lucide-react";
import { useSocket } from "../../../lib/socket";
import { useAuth } from "../../../lib/auth";
import { getTips, type TipHistoryEntry } from "../../../lib/api";

const DASHBOARD_STREAMER_ID = "UUID_STREAMER_TEST";
const PAGE_SIZE = 10;

type StatusFilter = "all" | "PENDING" | "CLEARED" | "REVERSED";

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    CLEARED: "bg-green-500/15 text-green-400 border-green-500/20",
    PENDING: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
    REVERSED: "bg-red-500/15 text-red-400 border-red-500/20",
    delivered: "bg-green-500/15 text-green-400 border-green-500/20",
  };
  const label: Record<string, string> = {
    CLEARED: "Cleared",
    PENDING: "Pending",
    REVERSED: "Reversed",
    delivered: "Delivered",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        styles[status] ?? styles.PENDING
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === "CLEARED" || status === "delivered"
            ? "bg-green-400"
            : status === "REVERSED"
              ? "bg-red-400"
              : "bg-yellow-400"
        }`}
      />
      {label[status] ?? status}
    </span>
  );
}

export default function TransactionsPage() {
  const { user } = useAuth();
  const { recentTips } = useSocket();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(0);

  const streamerId =
    user?.role === "ADMIN" ? DASHBOARD_STREAMER_ID : (user?.userId ?? DASHBOARD_STREAMER_ID);

  const { data: dbTips = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ["tips", streamerId],
    queryFn: () => getTips(streamerId, 200),
    staleTime: 30_000,
  });

  // Merge real-time socket tips with DB history, deduplicate by ID.
  // Socket tips (just-received) are prepended so they appear first even
  // before the DB query re-fetches.
  const allTips = useMemo<TipHistoryEntry[]>(() => {
    const dbIds = new Set(dbTips.map((t) => t.id));
    const socketAsTipHistory: TipHistoryEntry[] = recentTips
      .filter((t) => !dbIds.has(t.tipId))
      .map((t) => ({
        id: t.tipId,
        viewerId: "",
        streamerId: t.streamerId,
        gemAmount: t.gemAmount,
        customMessage: t.customMessage,
        status: "PENDING" as const,
        clearedAt: "",
        createdAt: new Date().toISOString(),
        viewer: { username: t.viewerUsername },
      }));
    return [...socketAsTipHistory, ...dbTips];
  }, [recentTips, dbTips]);

  const filtered = useMemo(() => {
    let result = allTips;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.viewer?.username.toLowerCase().includes(q) ||
          t.customMessage?.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== "all") {
      result = result.filter((t) => t.status === statusFilter);
    }
    return result;
  }, [allTips, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(page, totalPages - 1);
  const paginated = filtered.slice(
    safeCurrentPage * PAGE_SIZE,
    (safeCurrentPage + 1) * PAGE_SIZE
  );

  return (
    <div>
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Transaction History</h2>
            <p className="text-xs text-zinc-500">
              {filtered.length} transaction{filtered.length !== 1 ? "s" : ""}
              {isLoading && " · Loading..."}
            </p>
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:text-white disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </header>

      <div className="p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search by viewer, message, or ID..."
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-2 pl-9 pr-3 text-sm text-white placeholder-zinc-600 outline-none focus:border-purple-500"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 p-0.5">
            <Filter className="ml-2 h-3.5 w-3.5 text-zinc-500" />
            {(["all", "PENDING", "CLEARED", "REVERSED"] as StatusFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => {
                  setStatusFilter(f);
                  setPage(0);
                }}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === f
                    ? "bg-purple-500/20 text-purple-300"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {f === "all" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/80 text-left text-xs uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3 font-medium">Tip ID</th>
                <th className="px-4 py-3 font-medium">Viewer</th>
                <th className="px-4 py-3 font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Message</th>
                <th className="px-4 py-3 font-medium text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-zinc-500">
                    {isLoading
                      ? "Loading transactions..."
                      : allTips.length === 0
                        ? "No transactions yet."
                        : "No results match your filter."}
                  </td>
                </tr>
              ) : (
                paginated.map((tip) => (
                  <tr
                    key={tip.id}
                    className="bg-zinc-950/50 transition-colors hover:bg-zinc-800/20"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {tip.id.slice(0, 16)}…
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
                      {tip.viewer?.username ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/15 px-2.5 py-0.5 text-xs font-semibold text-purple-300">
                        <Gem className="h-3 w-3" />
                        {tip.gemAmount.toLocaleString()}
                      </span>
                    </td>
                    <td className="max-w-[180px] truncate px-4 py-3 text-zinc-400">
                      {tip.customMessage ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <StatusBadge status={tip.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
          <span>
            Page {safeCurrentPage + 1} of {totalPages}
          </span>
          <div className="flex gap-1">
            <button
              disabled={safeCurrentPage === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-lg border border-zinc-700 p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              disabled={safeCurrentPage >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-zinc-700 p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
