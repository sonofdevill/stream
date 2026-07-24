"use client";

import { useState, useMemo } from "react";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Filter,
  Gem,
} from "lucide-react";
import { useSocket } from "../../../lib/socket";
import type { TipAlertPayload } from "../../../lib/api";

type StatusFilter = "all" | "delivered" | "pending";

const PAGE_SIZE = 10;

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    delivered: "bg-green-500/15 text-green-400 border-green-500/20",
    pending: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
    failed: "bg-red-500/15 text-red-400 border-red-500/20",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        styles[status] ?? styles.pending
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === "delivered"
            ? "bg-green-400"
            : status === "failed"
              ? "bg-red-400"
              : "bg-yellow-400"
        }`}
      />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function TransactionsPage() {
  const { recentTips: tips } = useSocket();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    let result = tips;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.viewerUsername.toLowerCase().includes(q) ||
          t.customMessage?.toLowerCase().includes(q) ||
          t.tipId.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== "all") {
      // In real app, tips would have a status field; here all are "delivered"
      if (statusFilter === "pending") result = [];
    }
    return result;
  }, [tips, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(page, totalPages - 1);
  const paginated = filtered.slice(
    safeCurrentPage * PAGE_SIZE,
    (safeCurrentPage + 1) * PAGE_SIZE
  );

  return (
    <div>
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 px-6 py-4 backdrop-blur-sm">
        <h2 className="text-lg font-semibold text-white">Transaction History</h2>
        <p className="text-xs text-zinc-500">
          {filtered.length} transaction{filtered.length !== 1 ? "s" : ""}
        </p>
      </header>

      <div className="p-6">
        {/* Controls */}
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
            {(["all", "delivered", "pending"] as StatusFilter[]).map((f) => (
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
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
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
                    {tips.length === 0
                      ? "No transactions yet. Send a test alert from the Overview tab."
                      : "No results match your filter."}
                  </td>
                </tr>
              ) : (
                paginated.map((tip, i) => (
                  <tr
                    key={`${tip.tipId}-${i}`}
                    className="bg-zinc-950/50 transition-colors hover:bg-zinc-800/20"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                      {tip.tipId.slice(0, 16)}...
                    </td>
                    <td className="px-4 py-3 font-medium text-white">
                      {tip.viewerUsername}
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
                      <StatusBadge status="delivered" />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
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
