// W5 follow-ups C (owner 2026-11-23, Option A "by round"): the organiser's Fixtures run sheet for a BIG division. The page ships the
// rows of the rounds a person reads now and, for every other round of a league or group stage, only its TALLY - the numbers the stage
// card and the round bar say about it - so the server never sends a folded round's rows (perf report P2, "pack StagesPanel.fixtures").
// A folded round's rows load when its bar is opened (`load-run-sheet-round.ts`).
//
// Which rounds ship rows: Option A's (`planRounds`: live, next, the part-played frontier) and, for an organiser, every round that holds
// something that wants them - a held match (`needs_decision`, or awaiting its settle), a match owing its result, a match timed today.
// So the Needs result and Today chips, and every held row, are exact over what was shipped; only Unscheduled reaches into folded rounds,
// through the tally. Brackets, Swiss and americano stages ship whole: their cards read every round (the Swiss pairing menu, the legend).
// Pure and client-safe.
import { dayKeyInTz } from "@seazn/engine/scheduling/tz";
import { isResultMissing, isUnscheduledFixture } from "@/lib/division-phase";
import { isCatchUpRoundExtKey } from "@/lib/roundrobin-late-entry";
import { bucketCounts, fixtureBucket, pagesByRound, planRounds } from "@/lib/round-paging";
import { countsAsMatch, isBye, type MatchLineRow } from "@/lib/run-sheet-groups";
import { stageCounts } from "@/lib/stage-card/summaries";

/** Stage kinds whose folded rounds ship as a tally. Every other kind ships every row. */
export const RUN_SHEET_PAGED_STAGE_KINDS: ReadonlySet<string> = new Set(["league", "group"]);

/** A row as the page holds it (`FixtureRow`: its slot labels may be absent) - read as a `MatchLineRow` through `asLine`. */
export type PagedRunSheetRow = Omit<MatchLineRow, "home_slot_label" | "away_slot_label"> & {
  home_slot_label?: unknown;
  away_slot_label?: unknown;
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  scheduled_at: string | null;
};

/** What the page knows about one folded round instead of its rows. Every figure is the folded rows' share of a number the stage card
 *  or the round bar computes over its rows, by the same predicate. */
export interface FoldedRunSheetRound {
  stageId: string;
  round: number;
  /** Every row of the round, byes included (`stageFixtures.length`'s share). */
  rows: number;
  /** Rows that are no bye (`stageNonByeCount`'s share). */
  nonBye: number;
  /** The round bar's "N of M done" (`roundDone`): M counts `countsAsMatch` rows, N their `stageCounts` played bucket. */
  done: number;
  total: number;
  /** `stageCounts` over every row of the round (the card's Complete gate). */
  counts: { played: number; inPlay: number; unplayed: number };
  /** No-bye rows still to be given a time (`isUnscheduledFixture`): the card's "N to schedule" and the Unscheduled chip. */
  unscheduled: number;
  /** No-bye rows past `scheduled` (the card's "matches begun"). */
  begun: number;
  /** Rows with a live match or a result (`fixtureBucket` not "upcoming"): a stage holding one is not deletable. */
  played: number;
  /** The round's first and last kickoff - where its bar sits among the stage's rounds (`stageRoundSections` reads by kickoff). */
  firstAt: string | null;
  lastAt: string | null;
  /** W5 T23: a round appended for a late player's catch-up matches. */
  catchUp: boolean;
}

export interface RunSheetWindowContext {
  /** Fixture ids awaiting their settle (the page's `listFixturesAwaitingSettle`). */
  held: ReadonlySet<string>;
  nowMs: number;
  matchMinutes: number;
  /** The venue zone the run sheet's "today" is read in. */
  tz: string;
}

const asLine = (f: PagedRunSheetRow): MatchLineRow => ({ ...f, home_slot_label: f.home_slot_label ?? null, away_slot_label: f.away_slot_label ?? null });

/** Does this row want the organiser now, so its round must ship? */
function wantsAttention(f: PagedRunSheetRow, ctx: RunSheetWindowContext, today: string): boolean {
  if (fixtureBucket(f.status) === "live") return true;
  if (f.status === "needs_decision" || ctx.held.has(f.id)) return true;
  if (isBye(asLine(f))) return false;
  if (isResultMissing({ status: f.status, scheduledAt: f.scheduled_at, matchMinutes: ctx.matchMinutes }, ctx.nowMs)) return true;
  return f.scheduled_at !== null && dayKeyInTz(Date.parse(f.scheduled_at), ctx.tz) === today;
}

/** A folded round's tally, over exactly its rows. */
export function foldedRoundOf(stageId: string, round: number, rows: readonly PagedRunSheetRow[], held: ReadonlySet<string>): FoldedRunSheetRound {
  const counted = rows.filter((f) => countsAsMatch(asLine(f)));
  const realRows = rows.filter((f) => !isBye(asLine(f)));
  const times = rows.map((f) => f.scheduled_at).filter((t): t is string => t !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    stageId,
    round,
    rows: rows.length,
    nonBye: realRows.length,
    done: stageCounts(counted, held).played,
    total: counted.length,
    counts: stageCounts(rows, held),
    unscheduled: realRows.filter((f) => isUnscheduledFixture({ status: f.status, scheduledAt: f.scheduled_at })).length,
    begun: realRows.filter((f) => f.status !== "scheduled").length,
    played: rows.filter((f) => fixtureBucket(f.status) !== "upcoming").length,
    firstAt: times[0] ?? null,
    lastAt: times.at(-1) ?? null,
    catchUp: rows.some((f) => isCatchUpRoundExtKey(f.ext_key ?? null)),
  };
}

/**
 * The run sheet's rows for the page: every row of a small division; for a big one (`pagesByRound`), every row except those of a
 * league or group stage's folded rounds, which become `folded` tallies, in stage then round order.
 */
export function windowRunSheet<F extends PagedRunSheetRow>(
  fixtures: readonly F[],
  stages: readonly { id: string; kind: string }[],
  ctx: RunSheetWindowContext,
): { shipped: F[]; folded: FoldedRunSheetRound[] } {
  if (!pagesByRound(fixtures.length)) return { shipped: [...fixtures], folded: [] };
  const today = dayKeyInTz(ctx.nowMs, ctx.tz);
  const foldedIds = new Set<string>();
  const folded: FoldedRunSheetRound[] = [];
  for (const stage of stages) {
    if (!RUN_SHEET_PAGED_STAGE_KINDS.has(stage.kind)) continue;
    const byRound = new Map<number, F[]>();
    for (const f of fixtures) if (f.stage_id === stage.id) byRound.set(f.round_no, [...(byRound.get(f.round_no) ?? []), f]);
    const rounds = [...byRound.entries()].sort(([a], [b]) => a - b);
    if (rounds.length === 0) continue;
    // A late entrant's catch-up round never moves the frontier (review C2, `planRounds`).
    const plan = planRounds(
      rounds.map(([round, rows]) => ({
        key: String(round),
        buckets: bucketCounts(rows, (f) => f.status),
        catchUp: rows.some((f) => isCatchUpRoundExtKey(f.ext_key ?? null)),
      })),
    );
    rounds.forEach(([round, rows], i) => {
      if (plan[i]!.open || rows.some((f) => wantsAttention(f, ctx, today))) return;
      for (const f of rows) foldedIds.add(f.id);
      folded.push(foldedRoundOf(stage.id, round, rows, ctx.held));
    });
  }
  return { shipped: fixtures.filter((f) => !foldedIds.has(f.id)), folded };
}

/** A stage's folded rounds added up - the share of every per-stage figure the shipped rows do not hold. */
export function foldedTally(folded: readonly FoldedRunSheetRound[], stageId: string) {
  const mine = folded.filter((r) => r.stageId === stageId);
  const sum = (pick: (r: FoldedRunSheetRound) => number) => mine.reduce((n, r) => n + pick(r), 0);
  return {
    rounds: mine,
    rows: sum((r) => r.rows),
    nonBye: sum((r) => r.nonBye),
    done: sum((r) => r.done),
    unscheduled: sum((r) => r.unscheduled),
    begun: sum((r) => r.begun),
    played: sum((r) => r.played),
    counts: { played: sum((r) => r.counts.played), inPlay: sum((r) => r.counts.inPlay), unplayed: sum((r) => r.counts.unplayed) },
  };
}

/** The run-sheet filters a folded round's bar can answer from its tally. Needs result and Today never reach one: a round holding
 *  such a row ships (`wantsAttention`). */
export function foldedRoundShows(r: Pick<FoldedRunSheetRound, "unscheduled">, filter: string): boolean {
  return filter === "all" || (filter === "unscheduled" && r.unscheduled > 0);
}

/** A stage's round sections with its folded rounds put back among them: a round not loaded yet is a section with no rows that carries
 *  its tally, a loaded one is already a section (its rows joined the blocks). Read in `stageRoundSections`' order - earliest kickoff
 *  first (a folded round's `firstAt`), the untimed ones after, the round number breaking every tie. */
export function withFoldedRounds<S extends { round: number; fixtures: readonly { scheduled_at: string | null }[] }>(
  sections: readonly S[],
  folded: readonly FoldedRunSheetRound[],
  loaded: ReadonlySet<number>,
): (S | { round: number; fixtures: never[]; folded: FoldedRunSheetRound })[] {
  const pending = folded.filter((r) => !loaded.has(r.round)).map((r) => ({ round: r.round, fixtures: [] as never[], folded: r }));
  const earliest = (s: S | (typeof pending)[number]): number => {
    const at = "folded" in s ? s.folded.firstAt : (s.fixtures[0]?.scheduled_at ?? null);
    return at === null ? Number.POSITIVE_INFINITY : Date.parse(at);
  };
  return [...sections, ...pending].sort((a, b) => {
    const ea = earliest(a);
    const eb = earliest(b);
    if (ea !== eb) return ea < eb ? -1 : 1;
    return a.round - b.round;
  });
}
