import "server-only";
// W4 T14 (FX-G16, X-QM-4, RB4-Q5, signed S3): the reads behind a correction inside a completed knockout source. Before the
// destination starts the proposal goes stale and its seats go back (stages/seed-stale.ts `correctBracketDependent`); after, the bracket
// stands and the desk warns (`getKnockoutCutDrift`, the Swiss read's sibling: swiss-cut-drift.ts).
//
// Both ask the same thing of a proposal's slate: is the cut it names still the cut? Two readings, one per state of the source:
//   - DECIDED: today's cut, by the proposal's own machinery (`sourcesToTables` + `resolveProgression`), so a rank cut and a
//     `roundLosers` plate, a lucky loser and a shortfall all read as a re-proposal would.
//   - UNDECIDED (mid-correction: nothing reopens a stage, so it reads `complete` with a line taken back): the stored ranks are
//     the ones about to change, so what is left is who is still PROVEN by a decided result. A cut at a whole round is that
//     round's seats (four qualifiers are the four semi-finalists), so a void of the final moves nobody and the void of the
//     quarter-final that put her through takes her seat back at once (FX-G18). `null`: this take cannot be judged until
//     the source is decided again, and the slate stands until then.
//
// A departed entrant on a slate is no correction: her seat is the lucky loser's (or a walkover), so she is left out of both
// sides of the comparison.
//
// The two questions differ on ORDER (owner's ruling, RB4-Q3: the bracket seeds by rank). A decided slate stands only if it
// names the same people in the same seed order: before the destination starts a re-seed costs nothing and the organiser would
// otherwise play the wrong seeding (a flipped final). Who a correction moved after it starts is people alone: the same four are
// the same four, nobody is named, the Swiss reading.
import type postgres from "postgres";
import { type ProgressionSpec } from "@seazn/engine/competition";
import { resolveStoredProgression } from "./stored-progression";
import type { AuthCtx } from "@/server/api-v1/auth";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { knockoutCutDrift, type KnockoutCutDrift } from "@/lib/knockout-cut-drift";
import { bracketStageIsDecided, bracketWinnerLoser } from "@/server/engine-db/competition";
import { log } from "@/server/logger";
import { stageHasStarted } from "./fixture-started-sql";
import { resolveProgressionSource, sourcesToTables } from "./stage-seeding";
import { departedEntrantIds, setupDependentsOf } from "./stages";
import { isFirstLossProgression, reseedPlateQualifiers } from "./plate-field";

export type { KnockoutCutDrift };

type Tx = postgres.TransactionSql;

/** A `timing: "setup"` stage drawing from a knockout: what these reads need of it. */
export interface BracketDependent {
  id: string;
  division_id: string;
  seq: number;
  kind: string;
  progression: ProgressionSpec;
}

/** The part of a stored proposal these reads compare. */
interface Slate {
  qualifiers: readonly { rank: number; entrantId: string; source: { stageId: string } }[];
}

/** The slate's people from `sourceStageId`, in seed order (a stored qualifier's `rank` is its seed). */
const onSource = (slate: Slate, sourceStageId: string) =>
  slate.qualifiers
    .filter((q) => q.source.stageId === sourceStageId)
    .sort((a, b) => a.rank - b.rank)
    .map((q) => q.entrantId);

/** Today's cut for `dependent`, in seed order, less anyone departed. As it stands, what a re-proposal would offer;
 *  `withoutLuckyLoser`, what the results alone make it. */
async function cutToday(tx: Tx, dependent: BracketDependent, opts: { withoutLuckyLoser?: boolean } = {}): Promise<string[]> {
  const { shapes, tables, resolved } = await sourcesToTables(tx, dependent, dependent.progression.sources, opts);
  const resolvedToday = resolveStoredProgression(dependent.progression, shapes, tables, dependent.kind as never, resolved.map((r) => r.kind));
  // W4 T8 (X-SD-11): a plate's seed order is the draw's (main-draw seeds on the fold), as its proposal stored it.
  const qualifiers = isFirstLossProgression(dependent.progression)
    ? await reseedPlateQualifiers(tx, { id: dependent.id, config: await configOf(tx, dependent.id) }, resolvedToday.qualifiers)
    : resolvedToday.qualifiers;
  const departed = await departedEntrantIds(tx, dependent.division_id);
  return [...qualifiers].sort((a, b) => a.seed - b.seed).map((q) => q.entrantId).filter((id) => !departed.has(id));
}

async function configOf(tx: Tx, stageId: string): Promise<Record<string, unknown>> {
  const [row] = await tx<{ config: Record<string, unknown> | null }[]>`select config from stages where id = ${stageId}`;
  return row?.config ?? {};
}

interface BracketLine {
  round_no: number;
  is_final: boolean;
  third_place: boolean;
  outcome: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/** Who `take` is proven to name while the source is undecided, with the lines of its rank cuts' round (where a lucky loser's
 *  vacancy would be), or null when it cannot tell (see the header). */
export function provenBy(
  lines: readonly BracketLine[],
  take: readonly { kind: string; from?: unknown; to?: unknown; round?: unknown }[],
): { proven: Set<string>; cutLines: BracketLine[] } | null {
  const proven = new Set<string>();
  const cutLines: BracketLine[] = [];
  const add = (id: string | null | undefined) => {
    if (id !== null && id !== undefined) proven.add(id);
  };
  const main = lines.filter((l) => !l.third_place);
  for (const t of take) {
    if (t.kind === "roundLosers") {
      for (const l of main.filter((x) => x.round_no === t.round)) add(bracketWinnerLoser(l.outcome, l.home_entrant_id, l.away_entrant_id).loser);
    } else if (t.kind === "rankRange" && t.from === 1 && typeof t.to === "number") {
      if (t.to === 1) {
        for (const l of main.filter((x) => x.is_final)) {
          add(bracketWinnerLoser(l.outcome, l.home_entrant_id, l.away_entrant_id).winner);
          cutLines.push(l);
        }
        continue;
      }
      const rounds = [...new Set(main.map((l) => l.round_no))];
      const cutRound = rounds.find((r) => main.filter((l) => l.round_no === r).length * 2 === t.to);
      if (cutRound === undefined) return null;
      for (const l of main.filter((x) => x.round_no === cutRound)) {
        cutLines.push(l);
        add(l.home_entrant_id);
        add(l.away_entrant_id);
      }
    } else if (t.kind === "firstLosses") {
      // X-PL-6: a first loss is the loser of an entrant's FIRST real match, so whether a decided line is one depends on byes
      // and forfeits across the whole draw (RB4-P1/P2) — not on this line's round alone, and a bye holder's first match is
      // in round two. Nobody is PROVEN while the source is undecided: the slate stands until it is decided again.
      return null;
    } else {
      return null;
    }
  }
  return { proven, cutLines };
}

async function provenCut(tx: Tx, dependent: BracketDependent, sourceStageId: string, departed: ReadonlySet<string>): Promise<Set<string> | null> {
  const takes: { kind: string }[] = [];
  for (const s of dependent.progression.sources) {
    const source = await resolveProgressionSource(tx, { division_id: dependent.division_id, seq: dependent.seq }, s.stage);
    if (source.id === sourceStageId) takes.push(...s.take);
  }
  const lines = await tx<BracketLine[]>`
    select round_no, coalesce(is_final, false) as is_final, coalesce(third_place, false) as third_place, outcome, home_entrant_id, away_entrant_id
      from fixtures where stage_id = ${sourceStageId}`;
  const read = provenBy(lines, takes);
  if (read === null) return null;
  const { proven, cutLines } = read;
  // A lucky loser on a slate holds a place no seat in the cut's round proves. Her own defeat does, while it stands, and only
  // where she has a vacancy to fill: someone who has left still seated in that round. Without one a defeat proves nothing but
  // the defeat, as with a finalist whose line flipped (a void that never passes through undecided) and now holds no place.
  const gone = (id: string | null) => id !== null && departed.has(id);
  if (!cutLines.some((l) => gone(l.home_entrant_id) || gone(l.away_entrant_id))) return proven;
  for (const l of lines) {
    const { loser } = bracketWinnerLoser(l.outcome, l.home_entrant_id, l.away_entrant_id);
    if (loser !== null && loser !== undefined) proven.add(loser);
  }
  return proven;
}

/**
 * Does `slate`'s part of the cut still stand? EMPTY CASE FIRST: a slate with nobody left to judge (every entrant departed)
 * has nothing a correction could take away, and stands. A sibling source that is not ready cannot be judged: it stands.
 */
export async function slateStands(tx: Tx, dependent: BracketDependent, slate: Slate, sourceStageId: string, decided: boolean): Promise<boolean> {
  const departed = await departedEntrantIds(tx, dependent.division_id);
  const named = onSource(slate, sourceStageId).filter((id) => !departed.has(id));
  if (named.length === 0) return true;
  try {
    if (!decided) {
      const proven = await provenCut(tx, dependent, sourceStageId, departed);
      return proven === null || named.every((id) => proven.has(id));
    }
    // Everyone else in today's cut is left out: a lucky loser beside the slate's people, or another source's qualifiers.
    const onSlate = new Set(named);
    const today = (await cutToday(tx, dependent)).filter((id) => onSlate.has(id));
    return today.length === named.length && today.every((id, i) => id === named[i]);
  } catch (err) {
    if (err instanceof HttpError && err.code === "SEEDING_SOURCE_INCOMPLETE") return true;
    throw err;
  }
}

/**
 * Who a correction moved across a completed knockout's cut after the destination started, or null (no warning). Null for: a
 * stage that is not a complete knockout, one nothing draws from at setup, a destination that has not started (the correction
 * re-proposes it instead: `stageHasStarted`, the same reading the un-fill refuses on, so no start falls between the two), a
 * source mid-correction (today's cut is not known yet), and a cut that today's results still make. 404 for an unknown stage
 * or another organisation's (RLS).
 *
 * A started destination with no confirmed proposal on record is a breach of "seats come from a confirm": unlike the Swiss
 * read it is logged and reads as no warning, because this runs on every render of the division's Fixtures tab, and the desk
 * is what the organiser would fix it from. A display read: takes no lock, writes nothing.
 */
export async function getKnockoutCutDrift(auth: AuthCtx, sourceStageId: string): Promise<KnockoutCutDrift | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [source] = await tx<{ id: string; division_id: string; kind: string; status: string }[]>`
      select id, division_id, kind, status from stages where id = ${sourceStageId}`;
    if (!source) throw new HttpError(404, "stage not found");
    if (source.kind !== "knockout" || source.status !== "complete") return null;
    if (!(await bracketStageIsDecided(tx, source.id))) return null;
    for (const dependent of await setupDependentsOf(tx, source.id, source.division_id)) {
      if (!(await stageHasStarted(tx, dependent.id))) continue;
      const [confirmed] = await tx<{ computed: Slate }[]>`
        select computed from stage_seed_proposals where stage_id = ${dependent.id} and status = 'confirmed'
        order by confirmed_at desc nulls last, id limit 1`;
      if (!confirmed) {
        log.error({ event: "knockout_cut_drift_no_confirmed_cut", stageId: dependent.id, source: source.id }, "knockout_cut_drift_no_confirmed_cut");
        continue;
      }
      const frozen = onSource(confirmed.computed, source.id);
      const departed = await departedEntrantIds(tx, source.division_id);
      const seats = await tx<{ id: string }[]>`
        select distinct s.id from fixtures f
          cross join lateral (values (f.home_entrant_id), (f.away_entrant_id)) as s(id)
         where f.stage_id = ${dependent.id} and s.id is not null`;
      const seated = new Set(seats.map((r) => r.id));
      const frozenSet = new Set(frozen);
      // A withdrawal is no correction: read as the results make it, or the lucky loser a departure would offer reads as moved
      // across the cut when her seat was already played. And someone seated who is not on the frozen cut already took a place
      // the cut owes: a lucky loser a correction made a true qualifier is no one to name as coming in.
      const today = (await cutToday(tx, dependent, { withoutLuckyLoser: true })).filter((id) => frozenSet.has(id) || !seated.has(id));
      const drift = knockoutCutDrift(frozen.filter((id) => !departed.has(id)), today, true);
      if (drift !== null) return drift;
    }
    return null;
  });
}
