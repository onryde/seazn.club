// Spectator surface W1, Task 10 — the court-slab scorebug at the top of the
// match centre (W0 option A). Classes copied from `live-score.tsx:143` (the
// court card shell) and its score type scale — phone `text-2xl`, `md:text-4xl`
// (the brief's own token sheet; the legacy scoreboard used a single
// `text-5xl sm:text-6xl` because it never had a tab rail competing for the
// fold). Every `Msg` (`statusLine`) is resolved client-side via `t()` — the
// document carries a dictionary key + params, never pre-rendered copy, so a
// live poll/realtime push that changes which sentence applies re-resolves it
// in the viewer's own locale on the same tick, the same reasoning
// `renderDecidedOutcome` already established for the legacy scoreboard.
//
// Review fix round 1 (IMPORTANT 4, 5):
// - The freshness line now derives from `header.updatedAt` (the document's
//   OWN timestamp) ticked every second by `useNow()`, not the hook's
//   `updatedAt` (which resets to `Date.now()` on every render-causing event
//   and so could only ever read "0s ago"). This also means no `Date.now()`
//   call happens during render any more (it moves into `useNow`'s effect and
//   one-time lazy `useState` initializer), which incidentally clears the
//   `react-hooks/purity` warning this file used to carry and document.
// - The status chip switches EXHAUSTIVELY on `header.status` — `in_play` →
//   the LIVE pill, `decided` → the result chip, `scheduled` → the same chip
//   with different text, `other` (postponed/abandoned/walkover/cancelled) →
//   NO chip at all (the server's own `header.statusLine` Msg is expected to
//   name the reason — a later task's copy, not this component's job to
//   guess at). `header.live` no longer selects which chip renders; it is
//   read ONLY to decide whether the live pill's dot pulses (a fixture can be
//   `in_play` with play temporarily stopped — a rain delay, a drinks break —
//   without that meaning "not live" in the status-enum sense).
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchCentreHeaderT } from "@/server/public-site/match-centre-schema";
import { useNow } from "./use-now";

export interface CourtCardProps {
  header: MatchCentreHeaderT;
  dict: PublicDict;
}

export function CourtCard({ header, dict }: CourtCardProps) {
  const now = useNow();
  const seconds = Math.max(0, Math.floor((now - Date.parse(header.updatedAt)) / 1000));
  const inPlay = header.status === "in_play";
  return (
    <div
      data-testid="mc-court-card"
      className="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg"
    >
      <div className="p-5 sm:p-6">
        {inPlay ? (
          <p
            data-testid="mc-live-pill"
            className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-300"
          >
            <span
              className={`h-2 w-2 rounded-full bg-emerald-400 ${header.live ? "animate-live-pulse" : ""}`}
            />
            {t(dict, "matchCentre.status.live")}
          </p>
        ) : header.status === "decided" || header.status === "scheduled" ? (
          <p
            data-testid="mc-result-chip"
            className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-court-muted"
          >
            {t(dict, header.status === "decided" ? "matchCentre.status.decided" : "matchCentre.status.scheduled")}
          </p>
        ) : null /* "other" — no chip; header.statusLine below names the reason */}
        <div className="space-y-2">
          {header.sides.map((side, i) => {
            const idx = i as 0 | 1;
            const batting = header.battingIndex === idx;
            return (
              <div
                key={side.entrantId}
                className={`flex items-baseline justify-between gap-3 tabular-nums ${batting ? "font-bold" : ""}`}
              >
                <span className="truncate font-display text-xl font-semibold uppercase tracking-wide sm:text-2xl">
                  {side.short || side.name}
                </span>
                <span className="shrink-0 text-right">
                  <span
                    data-testid={`mc-score-${idx}`}
                    className="font-display text-2xl font-bold tabular-nums md:text-4xl"
                  >
                    {header.scoreLines[idx] ?? "—"}
                  </span>
                  {header.subLines[idx] ? (
                    <span className="ml-1.5 text-xs text-court-muted">{header.subLines[idx]}</span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
        {header.statusLine ? (
          <p data-testid="mc-status-line" className="mt-3 text-sm text-court-muted">
            {t(dict, header.statusLine.key, header.statusLine.params)}
          </p>
        ) : null}
        {header.rateLine ? (
          <p data-testid="mc-rate-line" className="mt-1 text-xs text-court-muted">
            {header.rateLine}
          </p>
        ) : null}
        <p data-testid="mc-updated-at" className="mt-3 text-[11px] text-court-muted/70">
          {t(dict, "matchCentre.updatedAgo", { seconds })}
        </p>
      </div>
      <div aria-hidden className={`h-1 ${inPlay ? "bg-emerald-400" : "bg-accent"}`} />
    </div>
  );
}
