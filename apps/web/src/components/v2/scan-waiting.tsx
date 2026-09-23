"use client";

// Scorer sheets §4.5.2 — a side is still TBD. No stream is mounted (there is
// no pad yet), so the page re-renders itself every POLL_MS — only while this
// screen exists — and on tab return (G1's floor, the same hook). It re-renders
// the SERVER page rather than fetching "metadata": a device link may read only
// /state and /events (doc 13 §7), and the pad it is waiting to mount needs each
// side's members and lineup, which only the page loads (P6). A revoked link
// lands on the page's own Dead-link screen on the next refresh.
import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { useTabReturn } from "@/components/v2/use-tab-return";
import { POLL_MS } from "@/components/v2/scorepad/use-fixture-stream";

export function ScanWaiting({
  home,
  away,
  meta,
  pollMs = POLL_MS,
}: {
  home: string;
  away: string;
  meta: string;
  pollMs?: number;
}) {
  const msg = useMsg();
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
      {meta && <p className="truncate text-[11px] uppercase tracking-widest text-slate-400">{meta}</p>}
      <p className="mt-3 text-sm text-slate-300">{msg("device.scan.waitingFor")}</p>
      <p className="mt-1 flex min-w-0 flex-wrap items-baseline justify-center gap-x-2 text-base font-semibold text-slate-100">
        <strong className="min-w-0 break-words">{home}</strong>
        <span className="text-[10px] uppercase tracking-widest text-slate-400">{msg("schedule.vs")}</span>
        <strong className="min-w-0 break-words">{away}</strong>
      </p>
      <p className="mt-4 text-xs text-slate-400">{msg("device.scan.waitingHint")}</p>
    </section>
  );
}
