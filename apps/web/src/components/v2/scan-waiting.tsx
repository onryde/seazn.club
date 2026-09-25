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
//
// Owner fix 2026-09-24: the same screen also waits on the DIVISION's start
// (`waitingOn: "division_start"`, "Not started yet"). A sheet scanned before
// the organiser presses Start used to open on Confirm, whose Start the scoring
// door refused. Same refresh, so it moves on to Confirm by itself; the page
// reads the division's status in that same render (`scanScreen`).
import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTabReturn } from "@/components/v2/use-tab-return";
import { POLL_MS } from "@/components/v2/scorepad/use-fixture-stream";

export interface ScanWaitingCopy {
  /** The line above the names: "Waiting for" — or, waiting on the division's
   *  start, the screen's headline ("Not started yet"). */
  lead: string;
  vs: string;
  /** The line under the names — for the division's start, why, and that the
   *  screen moves on by itself. */
  hint: string;
}

/** What the screen is waiting on: a TBD side ("sides", §4.5.2), or the
 *  organiser's start of the division (the scoring door is closed until then). */
export type ScanWaitingOn = "sides" | "division_start";

export function ScanWaiting({
  home,
  away,
  matchRef,
  meta,
  copy,
  waitingOn = "sides",
  pollMs = POLL_MS,
}: {
  home: string;
  away: string;
  /** The match, as the schedule board names it ("QF·1"). */
  matchRef: string;
  /** Court, time, division — whichever are known, in that order. */
  meta: readonly string[];
  copy: ScanWaitingCopy;
  waitingOn?: ScanWaitingOn;
  pollMs?: number;
}) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  useEffect(() => {
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);
  useTabReturn(refresh, true);
  const notStarted = waitingOn === "division_start";

  return (
    <section
      data-testid={notStarted ? "scan-not-started" : "scan-waiting"}
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
      {notStarted ? (
        <h1 data-testid="scan-not-started-title" className="mt-3 text-lg font-semibold text-slate-100">
          {copy.lead}
        </h1>
      ) : (
        <p className="mt-3 text-sm text-slate-300">{copy.lead}</p>
      )}
      <p className="mt-1 flex min-w-0 flex-wrap items-baseline justify-center gap-x-2 text-base font-semibold text-slate-100">
        <strong className="min-w-0 break-words">{home}</strong>
        <span className="text-[10px] uppercase tracking-widest text-slate-400">{copy.vs}</span>
        <strong className="min-w-0 break-words">{away}</strong>
      </p>
      <p className={notStarted ? "mt-4 text-sm text-slate-300" : "mt-4 text-xs text-slate-400"}>{copy.hint}</p>
    </section>
  );
}
