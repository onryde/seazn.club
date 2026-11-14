import "server-only";
// The day read for a Match Day code (capture S4 design §5, §9.3; MD-1 Task 3): what a phone holding the code lists — the
// courts in the code's scope, each with its Now match, its Next matches and today's finished ones; the matches with no
// court (a whole-competition code only, owner 2026-11-07); and the approvals waiting (§7). Read-only and polled every 15 s
// by every phone holding a code, so it takes no lock and runs one tenant transaction.
//
// Built from the desk's read model, never a copy of it: `readBoard` (match-day.ts) decides each court's state, its Now and
// its queue, and the round codes are the board's (`readRounds`). Its "finished today" arm is asked for here only.
//
// Scope is a FILTER over that board, decided per match by `inScope` — the one predicate the open (Task 4) and the approvals
// (Task 6) judge by too, so the list never offers a match the open would refuse (Review Focus 2: the open re-checks it,
// it never trusts the list).
//
// Never in the answer: the code's token, any scoring link, any secret. Names and times only.
import type postgres from "postgres";
import type { ProgressionSpec } from "@seazn/engine/competition";
import { withTenant } from "@/lib/db";
import { fixtureAwaitsSeedDraw, stageOwesDraw } from "@/lib/division-phase";
import { DEFAULT_LOCALE, getDictionary } from "@/lib/i18n";
import { compactScore, scoreLine } from "@/lib/match-day/view";
import { levelWords, type LevelWords } from "@/lib/score/levels";
import { resolveSeedingSourceStage, seedingSourceReady } from "@/lib/seeding-source-ready";
import { isSwissBoardSeated, nextUnseatedSwissRound } from "@/lib/swiss-shell";
import type { Dict } from "@/lib/i18n-constants";
import { readBoard, type Board, type FixtureRow } from "./match-day";
import { IN_PLAY } from "./match-day-call";
import { readMatchDayNames } from "./match-day-names";
import { readRounds, roundOf } from "./match-day-rounds";
import type { MatchDayCodeRow } from "./match-day-codes";
import { DECIDED } from "./stages";
import type { MatchDayCourtState } from "@/lib/match-day/types";

type Tx = postgres.TransactionSql;

export type MatchDayCodeRowView = {
  fixture_id: string;
  sport_key: string;
  division_name: string;
  round_label: string | null;
  /** The match as the desk and the schedule board tag it: "SF·1", "SF·2", "F" for a round of one match, the round's `R{n}`
   *  where the board codes no round (F-T8-3, owner 2026-11-13). Additive to `round_label`. */
  round_tag: string | null;
  /** A side's name; null while the seat has no entrant (a later knockout round). */
  home: string | null;
  away: string | null;
  /** What the desk prints for a seat with no entrant ("Winner of Group A", "Winner of SF·1"), in English like the round codes;
   *  null when the seat has an entrant or the web has no label for it (F-T8-4). */
  home_slot: string | null;
  away_slot: string | null;
  status: "upcoming" | "in_play" | "finished";
  scheduled_at: string | null;
  /** The short score as the Match Day desk shows it in a row (`compactScore(scoreLine(…))`, lib/match-day/view.ts): a set
   *  sport's sets won · games · live points ("1–1 · 14–9"), the sport's own headline otherwise; the same form once finished.
   *  Never the engine's full headline, which carries every set's score and pushes the names off a 320 dp phone row (the
   *  controller's ruling, MD-1 follow-up). Null before the engine has published a summary. */
  summary: string | null;
};

/** `round`: a Swiss approval's round awaiting pairing (the phone's "Round 4 pairings are ready"); null for a draw. */
export type MatchDayApproval = {
  kind: "swiss" | "draw";
  stage_id: string;
  division_name: string;
  label: string;
  round: number | null;
  /** `stage_complete`: a draw whose source stages are all decided but not yet completed on the desk (F-T8-2): listed so the
   *  phone says "complete the stage on the web desk", with no button; the approval routes refuse it still. Null for a ready
   *  draw and for a Swiss approval. */
  waiting: "stage_complete" | null;
};

export type MatchDayCodeCourt = {
  court_id: string;
  court_name: string;
  venue_name: string;
  state: MatchDayCourtState;
  now: MatchDayCodeRowView | null;
  next: MatchDayCodeRowView[];
  finished: MatchDayCodeRowView[];
};

export type MatchDayCodeView = {
  competition: { id: string; name: string };
  scope: { kind: "competition" | "venue" | "courts"; label: string };
  day: string;
  tz: string;
  opens_at: string;
  expires_at: string;
  can_approve: boolean;
  /** "Call matches to courts" (Task 8e): the code may call a match to a court and Undo the call. */
  can_call: boolean;
  courts: MatchDayCodeCourt[];
  no_court: MatchDayCodeRowView[];
  online: MatchDayCodeRowView[];
  approvals: MatchDayApproval[];
};

/** What `inScope` judges a match by: where it is and when it is. `venue_id` is its COURT's venue (null with no court). */
export type ScopeFixture = {
  competition_id: string;
  court_id: string | null;
  venue_id: string | null;
  status: string;
  scheduled_at: Date | null;
  finished_at: Date | null;
  /** The match's stage's status: a no-court match is the day's only in an active stage (the desk's "no court yet"). */
  stage_status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** Its division is not archived: the desk's no-court lists draw from live divisions only. */
  division_live: boolean;
  /** A call still holds on it (`liveCallSql`): it is called onto its court and not started. It is on that court NOW, so a code
   *  that covers the court covers it whatever its date (F-T8-15: a call moves `scheduled_at` to the call time, and the day
   *  after, the court's state still says called). Absent reads as not called. */
  called?: boolean;
};

const SCHEDULED = "scheduled";
const ACTIVE_STAGE = "active";
const within = (d: Date | null, from: Date, to: Date): boolean =>
  d !== null && new Date(d).getTime() >= from.getTime() && new Date(d).getTime() < to.getTime();

/**
 * Whether a code covers a match (capture S4 design §3; owner 2026-11-07), judged at the moment of asking. It admits
 * exactly what the day read can list, so the open never mints a link for a match the list never offered (MD-1 fix I1):
 *  - the code's competition only, in a live (not archived) division: the day read lists live divisions only, on a court
 *    or none (final review I2);
 *  - WHERE: a whole-competition code covers every match, a court or none; a venue code its venue's courts; a courts code
 *    exactly its courts. A match with no court is covered by a whole-competition code only;
 *  - a match on a court, WHEN: in play (today's whatever its plan, match-day.ts ruling m5), or called onto it and not started
 *    (it is on the court now, whatever its date, F-T8-15), or planned or finished within the code's day, `[opens_at, expires_at)`;
 *  - a match with no court: the desk's two no-court lists (match-day.ts `readBoard`) — in play, or ready (`scheduled`, an active stage, both seats filled) and planned no later than the day's end or not
 *    at all.
 */
export function inScope(code: MatchDayCodeRow, f: ScopeFixture): boolean {
  if (f.competition_id !== code.competitionId || !f.division_live) return false;
  const scope = code.scope;
  if (scope.kind === "venue" && (f.court_id === null || f.venue_id !== scope.venueId)) return false;
  if (scope.kind === "courts" && (f.court_id === null || !scope.courtIds.includes(f.court_id))) return false;
  if (f.court_id === null) return noCourtListed(code, f);
  if (f.status === IN_PLAY || f.called === true) return true;
  return within(f.scheduled_at, code.opensAt, code.expiresAt) || within(f.finished_at, code.opensAt, code.expiresAt);
}

/** A no-court match as `readBoard` lists it: `playingNoCourt` or `noCourt` (match-day.ts), the day bounded by the code. */
function noCourtListed(code: MatchDayCodeRow, f: ScopeFixture): boolean {
  if (f.status === IN_PLAY) return true;
  return (
    f.status === SCHEDULED &&
    f.stage_status === ACTIVE_STAGE &&
    f.home_entrant_id !== null &&
    f.away_entrant_id !== null &&
    (f.scheduled_at === null || new Date(f.scheduled_at).getTime() < code.expiresAt.getTime())
  );
}

/**
 * Whether a code covers a stage, for an approval (§7 "an approval waiting in the code's scope"; the plan's Task 6 rule):
 * a whole-competition code covers every stage of its competition; a narrowed code a stage with at least one match in its
 * scope (`inScope`, the day included).
 */
export function stageInScope(code: MatchDayCodeRow, competitionId: string, fixtures: readonly ScopeFixture[]): boolean {
  if (competitionId !== code.competitionId) return false;
  if (code.scope.kind === "competition") return true;
  return fixtures.some((f) => inScope(code, f));
}

/** A board row as `inScope` judges it (the day read's, and the code's candidates', match-day-code-call.ts): `venue_id` is its
 *  court's venue on the board, the division live when the board lists it. */
export function scopeFixtureOf(code: MatchDayCodeRow, board: Pick<Board, "courts" | "liveDivisions">, r: FixtureRow): ScopeFixture {
  const venue = r.court_id === null ? undefined : board.courts.find((c) => c.court_id === r.court_id)?.venue_id;
  return {
    competition_id: code.competitionId,
    court_id: r.court_id,
    venue_id: venue ?? null,
    status: r.status,
    scheduled_at: r.scheduled_at,
    finished_at: r.finished_at,
    stage_status: r.stage_status,
    home_entrant_id: r.home_entrant_id,
    away_entrant_id: r.away_entrant_id,
    division_live: board.liveDivisions.has(r.division_id),
    called: r.called_at !== null,
  };
}

/** A row's short score: the desk's own one-line form (court-list.tsx's row score), or null before any summary. */
function shortScore(r: Pick<FixtureRow, "summary">, words: LevelWords): string | null {
  const line = scoreLine(r);
  return line === null ? null : compactScore(line, words);
}

const statusOf = (status: string): MatchDayCodeRowView["status"] =>
  status === SCHEDULED ? "upcoming" : status === IN_PLAY ? "in_play" : "finished";

const isoOrNull = (d: Date | null): string | null => (d === null ? null : new Date(d).toISOString());

interface StageRow {
  id: string;
  division_id: string;
  division_name: string;
  kind: string;
  name: string;
  seq: number;
  status: string;
  timing: string | null;
  progression: unknown;
}

interface StageFixtureRow {
  id: string;
  stage_id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: unknown;
  away_slot_label: unknown;
  outcome: unknown;
  ext_key: string | null;
  court_id: string | null;
  venue_id: string | null;
  scheduled_at: Date | null;
  finished_at: Date | null;
}

/**
 * Swiss: the stage's next round is waiting to be paired — the desk's own `swissHasUnseated` (stages-panel.tsx, through
 * `nextUnseatedSwissRound`, the predicate stage-rail.tsx's "Pair next" reads) — AND the pairing would be accepted now
 * (§7's banner: "Round 3 complete · Round 4 pairings are ready"). That second half is the pairing gate's own rule
 * (stages.ts, round > 1): every SEATED board of the round before is `DECIDED` (decided, finalized or forfeited). An
 * abandoned board holds the round until the organiser settles it, as the gate says, so it holds the approval too. A stage
 * with no round seated yet is the desk's first Generate, not an approval.
 */
function swissWaiting(fixtures: readonly StageFixtureRow[]): boolean {
  const next = nextUnseatedSwissRound(fixtures);
  if (next === null || next < 2) return false;
  const seatedPrev = fixtures.filter((f) => f.round_no === next - 1 && isSwissBoardSeated(f));
  return seatedPrev.length > 0 && seatedPrev.every((f) => DECIDED.has(f.status));
}

/** Every source stage of a draw has fixtures and every one is `DECIDED`, the Swiss gate's own set (a played, finalized or forfeited
 *  match; an abandoned one holds the stage as it holds a Swiss round). A draw with no resolvable source is not waiting on one. */
function sourcesDecided(
  stages: readonly StageRow[],
  target: StageRow,
  sources: Pick<ProgressionSpec, "sources">["sources"],
  fixtures: readonly StageFixtureRow[],
): boolean {
  if (sources.length === 0) return false;
  return sources.every((src) => {
    const from = resolveSeedingSourceStage(stages, target, src.stage);
    const own = from === undefined ? [] : fixtures.filter((f) => f.stage_id === from.id);
    return own.length > 0 && own.every((f) => DECIDED.has(f.status));
  });
}

/** The approvals waiting in the code's scope (§7), in the competition's division order then stage order. Listed whatever
 *  the code's "can approve draws" tick: without it the phone shows the banner with no button (§7, "my call"). A division
 *  whose schedule is locked lists none: a locked schedule is a desk matter (the controller's ruling, MD-1 Task 6 fix
 *  round 2), and the approval routes answer it MD_NO_APPROVE. */
async function readApprovals(tx: Tx, code: MatchDayCodeRow): Promise<MatchDayApproval[]> {
  const stages = await tx<StageRow[]>`
    select s.id, s.division_id, d.name as division_name, s.kind, s.name, s.seq, s.status,
           s.progression ->> 'timing' as timing, s.progression
      from stages s join divisions d on d.id = s.division_id
     where d.competition_id = ${code.competitionId} and d.archived_at is null and not d.schedule_locked
     order by d.created_at, d.id, s.seq, s.id`;
  const open = stages.filter((s) => s.status !== "complete" && (s.kind === "swiss" || s.timing === "setup"));
  if (open.length === 0) return [];
  // The source stages' fixtures too: a draw is waiting on its groups' last results, and a source stage is not open (or is
  // complete) by the time it is asked about.
  const wanted = new Set(open.map((s) => s.id));
  for (const s of open) {
    if (s.timing !== "setup" || s.progression === null) continue;
    for (const src of (s.progression as unknown as Pick<ProgressionSpec, "sources">).sources) {
      const from = resolveSeedingSourceStage(stages, s, src.stage);
      if (from !== undefined) wanted.add(from.id);
    }
  }
  const fixtures = await tx<StageFixtureRow[]>`
    select f.id, f.stage_id, f.round_no, f.status, f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
           f.outcome, f.ext_key, f.court_id, c.venue_id, f.scheduled_at, f.finished_at
      from fixtures f left join courts c on c.id = f.court_id
     where f.stage_id in ${tx([...wanted])}`;
  const out: MatchDayApproval[] = [];
  for (const s of open) {
    const own = fixtures.filter((f) => f.stage_id === s.id);
    const divisionStages = stages.filter((x) => x.division_id === s.division_id);
    const sources = s.progression === null ? [] : (s.progression as unknown as Pick<ProgressionSpec, "sources">).sources;
    const spec = s.progression === null ? null : { sources };
    const sourceReady = spec !== null && seedingSourceReady(divisionStages, s, spec);
    const owesDraw =
      s.timing === "setup" &&
      stageOwesDraw(
        { id: s.id, timing: s.timing, sourceReady: true },
        own.map((f) => ({ stageId: f.stage_id, awaitsSeedDraw: fixtureAwaitsSeedDraw(f) })),
      );
    const draw = owesDraw && sourceReady;
    const waitingDraw = owesDraw && !sourceReady && sourcesDecided(divisionStages, s, sources, fixtures);
    const swiss = s.kind === "swiss" && swissWaiting(own);
    if (!draw && !waitingDraw && !swiss) continue;
    // The query reads live divisions only (`archived_at is null`), so every one of these matches is a live division's.
    const judged = own.map((f) => ({ ...f, competition_id: code.competitionId, stage_status: s.status, division_live: true }));
    if (!stageInScope(code, code.competitionId, judged)) continue;
    out.push({
      kind: draw || waitingDraw ? "draw" : "swiss",
      stage_id: s.id,
      division_name: s.division_name,
      label: s.name,
      round: draw || waitingDraw ? null : nextUnseatedSwissRound(own),
      waiting: waitingDraw ? "stage_complete" : null,
    });
  }
  return out;
}

/** The scope's words (§5 "Header: the competition, the code's scope and the day"): the competition's name, the venue's, or
 *  the courts' names in the board's order. */
async function scopeLabel(tx: Tx, code: MatchDayCodeRow, compName: string, courtNames: ReadonlyMap<string, string>, order: readonly string[]): Promise<string> {
  const scope = code.scope;
  if (scope.kind === "competition") return compName;
  if (scope.kind === "venue") {
    const [v] = await tx<{ name: string }[]>`select name from venues where id = ${scope.venueId}`;
    return v?.name ?? "";
  }
  const ranked = [...scope.courtIds].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib) || (a < b ? -1 : 1);
  });
  return ranked.map((id) => courtNames.get(id) ?? "").filter((n) => n !== "").join(", ");
}

/** The phone's row for each of `rows` (the day read's, and the code's candidates', match-day-code-call.ts): the board's round
 *  codes and the desk's tags and seat labels, read once for all of them. */
export async function codeRowViews(
  tx: Tx,
  rows: readonly FixtureRow[],
  dict: Dict,
  words: LevelWords,
): Promise<(r: FixtureRow) => MatchDayCodeRowView> {
  const rounds = await readRounds(tx, rows, dict);
  const names = await readMatchDayNames(tx, rows, dict);
  return (r) => ({
    fixture_id: r.id,
    sport_key: r.sport_key,
    division_name: r.division_name,
    round_label: roundOf(rounds, r.id).code,
    round_tag: names.get(r.id)?.tag ?? null,
    home: r.home,
    away: r.away,
    home_slot: names.get(r.id)?.homeSlot ?? null,
    away_slot: names.get(r.id)?.awaySlot ?? null,
    status: statusOf(r.status),
    scheduled_at: isoOrNull(r.scheduled_at),
    summary: shortScore(r, words),
  });
}

/**
 * The day read (§9.3) for a code `resolveMatchDayCode` has accepted at `now`. Reads under the code's org (its issuer
 * vouches for it, `matchDayActor`), in the competition's own words; round codes in English (the phone localises around
 * them; the board's codes are "R2", "QF").
 */
export async function getMatchDayForCode(code: MatchDayCodeRow, now: Date): Promise<MatchDayCodeView> {
  const dict = await getDictionary(DEFAULT_LOCALE, "ui");
  // The live level's marks (TB, MTB, Ad) in English, as the round codes are: the desk reads them from the public dictionary.
  const words = levelWords(await getDictionary(DEFAULT_LOCALE, "public"));
  return withTenant(code.orgId, async (tx) => {
    const board = await readBoard(tx, code.competitionId, now, { noCourt: code.scope.kind === "competition", finished: true });
    const covers = (r: FixtureRow): boolean => inScope(code, scopeFixtureOf(code, board, r));
    const scope = code.scope;
    const courts = board.courts
      .filter((c) => scope.kind === "competition" || (scope.kind === "venue" ? c.venue_id === scope.venueId : scope.courtIds.includes(c.court_id)))
      .map((c) => ({
        c,
        now: c.current !== null && covers(c.current) ? c.current : null,
        next: c.queue.map((q) => q.row).filter(covers),
        finished: board.finished.filter((r) => r.court_id === c.court_id && covers(r)),
      }));
    const noCourt = scope.kind === "competition" ? [...board.playingNoCourt, ...board.noCourt].filter(covers) : [];
    const shown = [...courts.flatMap((x) => [...(x.now ? [x.now] : []), ...x.next, ...x.finished]), ...noCourt];
    const rowView = await codeRowViews(tx, shown, dict, words);
    const label = await scopeLabel(tx, code, board.comp.name, board.courtNames, board.courts.map((c) => c.court_id));
    const approvals = await readApprovals(tx, code);
    return {
      competition: { id: board.comp.id, name: board.comp.name },
      scope: { kind: scope.kind, label },
      day: code.day,
      tz: code.tz,
      opens_at: code.opensAt.toISOString(),
      expires_at: code.expiresAt.toISOString(),
      can_approve: code.canApprove,
      can_call: code.canCall,
      courts: courts.map(({ c, now: current, next, finished }) => ({
        court_id: c.court_id,
        court_name: c.court_name,
        venue_name: c.venue_name,
        state: c.state,
        now: current === null ? null : rowView(current),
        next: next.map(rowView),
        finished: finished.map(rowView),
      })),
      no_court: noCourt.map(rowView),
      // The web's all-in-one read model (2026-11-05) lists online chess boards with the hall; until it lands there is
      // nothing to list here (§9: "follows the web's newer read model if it has landed by then").
      online: [],
      approvals,
    };
  });
}
