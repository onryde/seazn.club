"use client";
// "Updated 12 s ago · Refresh" under the desk's title. The age ticks every second on the browser's clock from the last successful read
// (from the page's own mount until the first one: the server's markup and the first client render both read "0 s"). The button reads
// "Refreshing…" and is disabled while a read is in flight; a failed read says "Couldn't refresh" in place of the age, and the page keeps
// what it had.
import { useEffect, useState } from "react";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { secondsSince, updatedAgo } from "@/lib/match-day/refresh-age";

export function RefreshLine({
  dict, lastOkAt, busy, failed, onRefresh, clock = Date.now,
}: {
  dict: Dict;
  lastOkAt: number | null;
  busy: boolean;
  failed: boolean;
  onRefresh: () => void;
  /** The page's clock in ms: `Date.now`, or a fixed one in a test. Keep it stable between renders. */
  clock?: () => number;
}) {
  const [mountedAt] = useState(() => clock());
  const [nowMs, setNowMs] = useState(mountedAt);
  useEffect(() => {
    const id = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(id);
  }, [clock]);
  const seconds = secondsSince(lastOkAt ?? mountedAt, nowMs);
  return (
    <p data-testid="md-refresh" className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-slate-600">
      <span data-testid="md-refresh-age" data-failed={failed ? "true" : undefined} className={`tabular-nums ${failed ? "font-medium text-amber-800" : ""}`}>
        {failed ? t(dict, "matchDay.refresh.failed") : updatedAgo(dict, seconds)}
      </span>
      <button
        type="button"
        data-testid="md-refresh-button"
        disabled={busy}
        onClick={onRefresh}
        className="inline-flex min-h-11 items-center font-medium text-purple-800 underline underline-offset-2 hover:no-underline disabled:no-underline disabled:opacity-60"
      >
        {busy ? t(dict, "matchDay.refresh.refreshing") : t(dict, "matchDay.refresh.button")}
      </button>
    </p>
  );
}
