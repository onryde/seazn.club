// Quick match home (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3; plan 2 Task 5, mockup
// home.html "All matches"): every match in play order, the ones still to play first, then the ones marked Not played, then
// the finished ones at the bottom (plan 4 D8), each with its match number (D12: the 1-based index among non-bye matches,
// the number "match n of total" says too).
//
// A SERVER component that takes its words already resolved (`MatchView`, built by home.tsx): nothing here reads a
// dictionary, a token or a database. A row's Score control is a slot (`score`), filled by plan 2 Task 6 (the page's
// `QuickMatchScoreForm`, described by the row's `matchSidesId`); a row that waits (a side still unknown, C18), is finished
// or is Not played never gets one. Long side names wrap rather than push the row wider than a 320px screen (`min-w-0` on
// every flex child, `[overflow-wrap:anywhere]` on the text).
//
// The row's ⋯ menu (plan 4 Task 4; spec 2026-11-12 §6, Option A; owner 2026-11-13): ONE menu per row, a slot (`rowMenu`)
// the page fills with `QuickMatchRowMenu`. What it offers is decided here, by the row's phase, in one exhaustive switch
// (`rowMenuItems`): a match still to play its Score and "Not played" (a league match only: a bracket needs a winner); a
// finished one "Edit result" (no longer a loud button on every finished row); a Not played one "Put back" (until the
// league finishes). A row with nothing to offer draws no menu, so no ⋯ ever opens on an empty panel.
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

/** The confirm sheet's words for one match (plan 4 D6, D7), built by home.tsx in the viewer's language. */
export interface SkipCopy {
  /** "Skip A v B?" */
  title: string;
  /** The sheet's body: `quickMatch.skip.bodyLast` when skipping this match finishes the league (it then cannot be put back),
   *  `quickMatch.skip.body` otherwise. */
  body: string;
  /** A live match's line: its score that will not count ("8–5 is already scored…") once a score stands, else that it has
   *  started with nothing scored (FR4 m1: a match only Started reads "0 — 0"); null for a match not in play. */
  partial: string | null;
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
  /** settled, and the pad will still reopen it (its result has not moved the match on): the row's menu offers "Edit result". */
  editable: boolean;
  /** A league match still to play (ready or live: spec §6, "only unplayed or in-progress"): its menu offers "Not played".
   *  Never a knockout's (a bracket needs a winner), never a settled or waiting one. */
  skippable: boolean;
  /** Not played, and the league has not finished (§6: "Put back" is hidden once it has): its menu offers "Put back". */
  putBack: boolean;
  /** The confirm sheet's words: set exactly when `skippable`. */
  skipCopy: SkipCopy | null;
}

/** The page's Score control for one match: the hero's, or a playable row's. */
export type ScoreSlot = (fixture: { id: string; live: boolean }, place: "hero" | "row") => ReactNode;

/** One thing a row's ⋯ menu offers. */
export type RowMenuItem = { kind: "score" } | { kind: "skip"; copy: SkipCopy } | { kind: "edit" } | { kind: "putBack" };
/** What the page needs to draw one row's menu: the match, its two sides as the row names them (the ⋯ button's accessible
 *  name says which match), and what to offer, in order. Never empty. */
export interface RowMenuRequest {
  fixtureId: string;
  home: string;
  away: string;
  items: RowMenuItem[];
}
export type RowMenuSlot = (request: RowMenuRequest) => ReactNode;

/** A phase no switch here knows: the union grew and a branch was not written. tsc refuses the call first (`never`). */
function unknownPhase(phase: never): never {
  throw new Error(`quick match list: no branch for the phase ${JSON.stringify(phase)}`);
}

/** What a row's ⋯ menu offers, by its phase (owner 2026-11-13: one menu per row). Empty: no menu. */
export function rowMenuItems(m: MatchView): RowMenuItem[] {
  switch (m.phase) {
    case "ready":
    case "live":
      return m.skippable && m.skipCopy !== null ? [{ kind: "score" }, { kind: "skip", copy: m.skipCopy }] : [];
    case "settled":
      return m.editable ? [{ kind: "edit" }] : [];
    case "notPlayed":
      return m.putBack ? [{ kind: "putBack" }] : [];
    case "waiting":
      return [];
    default:
      return unknownPhase(m.phase);
  }
}

/** The id of a row's sides line ("A v B"): a row's Score control is described by it, so each of the list's "Score" buttons
 *  names its own match to a screen reader (plan 2 Task 6). */
export const matchSidesId = (fixtureId: string): string => `qm-match-sides-${fixtureId}`;

/** The red-dot Live mark, shared by the list and the draw. */
export function QuickMatchLiveBadge({ label }: { label: string }) {
  return (
    <span data-testid="qm-live" className="inline-flex items-center gap-1.5 text-xs font-semibold text-cream">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[color:var(--mk-live)] motion-safe:animate-pulse" />
      {label}
    </span>
  );
}

/** Where a phase sits in the list (plan 4 D8): still to play first, then Not played, then finished. A record over the whole
 *  union, so a new phase does not compile until it is placed. */
const LIST_PLACE: Readonly<Record<QuickMatchPhase, number>> = { live: 0, ready: 0, waiting: 0, notPlayed: 1, settled: 2 };

/** The list's order: still to play (live, ready, waiting) in play order, then the Not played ones in play order, then the
 *  finished ones in play order. */
export function listOrder(matches: readonly MatchView[]): MatchView[] {
  // tsc places every phase (the Record over the union). A phase from outside it at runtime would drop out of the filter
  // below, the list one row short and no error, so it refuses by the switches' own name (T4 review m6).
  for (const m of matches) if (!Object.hasOwn(LIST_PLACE, m.phase)) unknownPhase(m.phase as never);
  return [0, 1, 2].flatMap((place) => matches.filter((m) => LIST_PLACE[m.phase] === place));
}

export function QuickMatchList({
  title,
  matches,
  versus,
  waits,
  liveLabel,
  notPlayedLabel,
  score,
  rowMenu,
}: {
  title: string;
  matches: readonly MatchView[];
  versus: string;
  waits: string;
  liveLabel: string;
  /** The Not played row's mark (`quickMatch.home.notPlayed`). */
  notPlayedLabel: string;
  score?: ScoreSlot;
  rowMenu?: RowMenuSlot;
}) {
  return (
    <section aria-labelledby="qm-all-title" className="min-w-0">
      <h2 id="qm-all-title" className="app-display mb-2 text-xs font-semibold tracking-[0.18em] text-[#b7aede]">
        {title}
      </h2>
      <ol className="flex min-w-0 flex-col gap-1.5">
        {listOrder(matches).map((m) => (
          <QuickMatchRow
            key={m.id}
            match={m}
            versus={versus}
            waits={waits}
            liveLabel={liveLabel}
            notPlayedLabel={notPlayedLabel}
            score={score}
            rowMenu={rowMenu}
          />
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
  notPlayedLabel,
  score,
  rowMenu,
}: {
  match: MatchView;
  versus: string;
  waits: string;
  liveLabel: string;
  notPlayedLabel: string;
  score?: ScoreSlot;
  rowMenu?: RowMenuSlot;
}) {
  const settled = m.phase === "settled";
  const notPlayed = m.phase === "notPlayed";
  const items = rowMenuItems(m);
  const menu =
    rowMenu && items.length > 0
      ? rowMenu({ fixtureId: m.id, home: m.home.label, away: m.away.label, items })
      : null;
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
          : notPlayed
            ? "border-dashed border-[#4a3a80] bg-transparent"
            : "border-[#3b2a6e] bg-[rgba(36,22,80,0.75)]",
      ].join(" ")}
    >
      <span
        data-testid="qm-match-no"
        className="app-display w-5 flex-none text-center text-sm font-bold tabular-nums text-[#8d7fc0]"
      >
        {m.n}
      </span>
      <div className="min-w-0 flex-1">
        <p
          id={matchSidesId(m.id)}
          data-testid="qm-match-sides"
          className={`text-sm leading-snug [overflow-wrap:anywhere] ${settled ? "text-[#d9d2f2]" : notPlayed ? "text-[#b7aede]" : "text-cream"}`}
        >
          {settled && m.result !== null ? (
            m.result
          ) : (
            <>
              {seatText(m.home)} <span className="text-[#b7aede]">{versus}</span> {seatText(m.away)}
            </>
          )}
        </p>
        {/* Finished: the score under its result line (the mockup's row), so the row's end holds only its ⋯. */}
        {settled && m.score !== null ? (
          <p
            data-testid="qm-match-score"
            className="app-display mt-0.5 text-sm tracking-[0.04em] text-[#b7aede] [overflow-wrap:anywhere]"
          >
            {m.score}
          </p>
        ) : null}
        {notPlayed ? (
          <p className="mt-1">
            <span
              data-testid="qm-not-played"
              className="inline-flex items-center rounded-full border border-dashed border-[#6b5aa6] px-2 py-0.5 text-[11px] font-semibold leading-none text-[#b7aede]"
            >
              {notPlayedLabel}
            </span>
          </p>
        ) : null}
      </div>
      {rowEnd(m, waits, liveLabel, menu, score)}
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

/** The row's end: what the match's phase offers, its ⋯ menu last. */
function rowEnd(m: MatchView, waits: string, liveLabel: string, menu: ReactNode, score?: ScoreSlot): ReactNode {
  switch (m.phase) {
    case "live":
      return (
        <span className="flex min-w-0 flex-none flex-col items-end gap-1 text-right">
          <QuickMatchLiveBadge label={liveLabel} />
          {m.score !== null ? (
            <span
              data-testid="qm-match-score"
              className="app-display text-sm tracking-[0.04em] text-[#b7aede] [overflow-wrap:anywhere]"
            >
              {m.score}
            </span>
          ) : null}
          {actions(score?.({ id: m.id, live: true }, "row"), menu)}
        </span>
      );
    case "ready":
      return actions(score?.({ id: m.id, live: false }, "row"), menu);
    case "waiting":
      return <span className="flex-none text-xs text-[#b7aede]">{waits}</span>;
    case "settled":
    case "notPlayed":
      return actions(null, menu);
    default:
      return unknownPhase(m.phase);
  }
}

/** A row's controls side by side: its Score (if any), then its ⋯ menu (if any). Nothing to offer, nothing drawn. */
function actions(scoreControl: ReactNode, menu: ReactNode): ReactNode {
  if (!scoreControl && !menu) return null;
  return (
    <span className="flex flex-none items-center gap-2">
      {scoreControl}
      {menu}
    </span>
  );
}
