// Quick match home (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3; plan 2 Task 5, mockup
// home.html "All matches"): every match in play order, the ones still to play first and the finished ones at the bottom,
// each with its match number (D12: the 1-based index among non-bye matches, the number "match n of total" says too).
//
// A SERVER component that takes its words already resolved (`MatchView`, built by home.tsx): nothing here reads a
// dictionary, a token or a database. A row's Score control is a slot (`score`), filled by plan 2 Task 6; a row that
// waits (a side still unknown, C18) or is finished never gets one. Long side names wrap rather than push the row wider
// than a 320px screen (`min-w-0` on every flex child, `[overflow-wrap:anywhere]` on the text).
import type { ReactNode } from "react";
import type { QuickMatchPhase } from "@/server/usecases/quick-match-home";

/** One seat as the list and the draw print it (home.tsx resolves the words). */
export interface SeatView {
  /** The side's name, or null while the seat waits on a feeder's result. */
  name: string | null;
  /** The name, or the words for a waiting seat, naming its feeder as the feeder's card does (`winnerOfLabel`): "Winner of
   *  the semi-final" (a lone one), "Winner of quarter-final 2" (numbered), "Winner of match n" only for a round with no name. */
  label: string;
  /** This side won the match. */
  winner: boolean;
}

export interface MatchView {
  id: string;
  /** D12's match number. */
  n: number;
  phase: QuickMatchPhase;
  home: SeatView;
  away: SeatView;
  /** live: the score as it stands; settled: the sets, or the sport's own headline; null otherwise. */
  score: string | null;
  /** settled: the whole-sentence result ("A beat B", "A drew with B"); null otherwise. */
  result: string | null;
  /** The hero's match: marked in the list as the mockup's lime edge. */
  next: boolean;
}

export type ScoreSlot = (fixture: { id: string; live: boolean }, place: "hero" | "row") => ReactNode;

/** The red-dot Live mark, shared by the list and the draw. */
export function QuickMatchLiveBadge({ label }: { label: string }) {
  return (
    <span data-testid="qm-live" className="inline-flex items-center gap-1.5 text-xs font-semibold text-cream">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[color:var(--mk-live)] motion-safe:animate-pulse" />
      {label}
    </span>
  );
}

/** The list's order: still to play (live, ready, waiting) in play order, then the finished ones in play order. */
export function listOrder(matches: readonly MatchView[]): MatchView[] {
  return [...matches.filter((m) => m.phase !== "settled"), ...matches.filter((m) => m.phase === "settled")];
}

export function QuickMatchList({
  title,
  matches,
  versus,
  waits,
  liveLabel,
  score,
}: {
  title: string;
  matches: readonly MatchView[];
  versus: string;
  waits: string;
  liveLabel: string;
  score?: ScoreSlot;
}) {
  return (
    <section aria-labelledby="qm-all-title" className="min-w-0">
      <h2 id="qm-all-title" className="app-display mb-2 text-xs font-semibold tracking-[0.18em] text-[#b7aede]">
        {title}
      </h2>
      <ol className="flex min-w-0 flex-col gap-1.5">
        {listOrder(matches).map((m) => (
          <QuickMatchRow key={m.id} match={m} versus={versus} waits={waits} liveLabel={liveLabel} score={score} />
        ))}
      </ol>
    </section>
  );
}

export function QuickMatchRow({
  match: m,
  versus,
  waits,
  liveLabel,
  score,
}: {
  match: MatchView;
  versus: string;
  waits: string;
  liveLabel: string;
  score?: ScoreSlot;
}) {
  const settled = m.phase === "settled";
  return (
    <li
      data-testid="qm-match"
      data-fixture-id={m.id}
      data-state={m.phase}
      data-next={m.next ? "true" : undefined}
      className={[
        "flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5",
        m.next
          ? "border-[color:var(--mk-lime)] bg-[#241650] shadow-[inset_3px_0_0_var(--mk-lime)]"
          : "border-[#3b2a6e] bg-[rgba(36,22,80,0.75)]",
      ].join(" ")}
    >
      <span
        data-testid="qm-match-no"
        className="app-display w-5 flex-none text-center text-sm font-bold tabular-nums text-[#8d7fc0]"
      >
        {m.n}
      </span>
      <p
        data-testid="qm-match-sides"
        className={`min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere] ${settled ? "text-[#d9d2f2]" : "text-cream"}`}
      >
        {settled && m.result !== null ? (
          m.result
        ) : (
          <>
            {seatText(m.home)} <span className="text-[#b7aede]">{versus}</span> {seatText(m.away)}
          </>
        )}
      </p>
      {rowEnd(m, waits, liveLabel, score)}
    </li>
  );
}

// Plain functions, not components (the score page's `scanColumn` convention): the row's element tree then holds what
// they render, where the server render and its test both see it.
function seatText(seat: SeatView): ReactNode {
  return seat.name === null ? (
    <span className="text-[#b7aede]">{seat.label}</span>
  ) : (
    <span className="font-semibold">{seat.name}</span>
  );
}

function rowEnd(m: MatchView, waits: string, liveLabel: string, score?: ScoreSlot): ReactNode {
  const scoreText = (
    <span
      data-testid="qm-match-score"
      className="app-display text-sm tracking-[0.04em] text-[#b7aede] [overflow-wrap:anywhere]"
    >
      {m.score}
    </span>
  );
  switch (m.phase) {
    case "live":
      return (
        <span className="flex min-w-0 max-w-[45%] flex-none flex-col items-end gap-1 text-right">
          <QuickMatchLiveBadge label={liveLabel} />
          {m.score !== null ? scoreText : null}
          {score?.({ id: m.id, live: true }, "row")}
        </span>
      );
    case "ready":
      return score ? <span className="flex-none">{score({ id: m.id, live: false }, "row")}</span> : null;
    case "waiting":
      return <span className="flex-none text-xs text-[#b7aede]">{waits}</span>;
    case "settled":
      return m.score === null ? null : <span className="min-w-0 max-w-[45%] flex-none text-right">{scoreText}</span>;
  }
}
