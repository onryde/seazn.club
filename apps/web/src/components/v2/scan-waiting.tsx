"use client";

// Scorer sheets §4.5.2 — a side is still TBD. No stream is mounted (there is
// no pad yet), so the page re-renders itself every POLL_MS — only while this
// screen exists — and on tab return (G1's floor, the same hook). It re-renders
// the SERVER page rather than fetching "metadata": a device link may read only
// /state and /events (doc 13 §7), and the pad it is waiting to mount needs each
// side's members and lineup, which only the page loads (P6). A revoked link
// lands on the page's own Dead-link screen on the next refresh.
//
// Every word arrives as a prop, already in the scorer's language (Task 6
// review I2). This screen looks nothing up: a dictionary provider around it
// would ride along on every one of those refreshes — the whole merged `ui`
// dictionary, to say three sentences.
import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTabReturn } from "@/components/v2/use-tab-return";
import { POLL_MS } from "@/components/v2/scorepad/use-fixture-stream";

export interface ScanWaitingCopy {
  waitingFor: string;
  vs: string;
  hint: string;
}

export function ScanWaiting({
  home,
  away,
  matchRef,
  meta,
  copy,
  pollMs = POLL_MS,
}: {
  home: string;
  away: string;
  /** The match, as the schedule board names it ("QF·1"). */
  matchRef: string;
  /** Court, time, division — whichever are known, in that order. */
  meta: readonly string[];
  copy: ScanWaitingCopy;
  pollMs?: number;
}) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  useEffect(() => {
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);
  useTabReturn(refresh, true);

  return (
    <section
      data-testid="scan-waiting"
      aria-live="polite"
      className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-6 text-center"
    >
      {/* Wraps rather than truncates: at 320 a one-line meta cut the match ref
          off, and the ref is the part a scorer checks against the sheet. */}
      <p data-testid="scan-waiting-meta" className="break-words text-[11px] uppercase tracking-widest text-slate-400">
        {meta.map((part) => `${part} · `).join("")}
        <span data-testid="scan-waiting-ref" className="whitespace-nowrap">
          {matchRef}
        </span>
      </p>
      <p className="mt-3 text-sm text-slate-300">{copy.waitingFor}</p>
      <p className="mt-1 flex min-w-0 flex-wrap items-baseline justify-center gap-x-2 text-base font-semibold text-slate-100">
        <strong className="min-w-0 break-words">{home}</strong>
        <span className="text-[10px] uppercase tracking-widest text-slate-400">{copy.vs}</span>
        <strong className="min-w-0 break-words">{away}</strong>
      </p>
      <p className="mt-4 text-xs text-slate-400">{copy.hint}</p>
    </section>
  );
}
