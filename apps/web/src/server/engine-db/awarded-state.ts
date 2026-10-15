import "server-only";
import type postgres from "postgres";
import { isDeepStrictEqual } from "node:util";
import {
  EngineError,
  foldMatchWithStoppage,
  outcomeOf,
  summaryOf,
  type EventEnvelope,
  type ForfeitAward,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { unseatedForfeitLoser } from "@/lib/forfeit-tag";
import { FORMAT_FIT_REASONS } from "@/lib/rule-errors";
import { resolveModule } from "./registry";
import { loadLineupPair } from "./lineups";
import { resolveFixtureCfg, stageForfeitAward } from "./fixture-cfg";
import { foldFrom, loadFoldInputs } from "./fold";

type Tx = postgres.TransactionSql;

/** A fixture's ledger as the award reads it: its tip, and how many recorded events still stand (no void took them
 *  back; voids are not voidable, events.test.ts PROMPT-02) — `fed-seats.ts` `readNode`'s `live_events`. */
export async function ledgerOf(tx: Tx, fixtureId: string): Promise<{ tip: number; standing: number }> {
  const [ledger] = await tx<{ tip: number; standing: number }[]>`
    select coalesce(max(e.seq), 0)::int as tip,
           (count(*) filter (where e.type <> 'core.void' and not exists (
              select 1 from score_events v where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)))::int as standing
    from score_events e where e.fixture_id = ${fixtureId}`;
  return ledger!;
}

/** `awardedMatchState`'s refusal when the walkover, folded under a cfg, decides something other than the stored award
 *  — named, so a caller asking "does this cfg still score the award?" (the format correction, `fixture-rules.ts`) can
 *  tell "it would change the result" from a broken assumption. */
export class AwardFoldMismatch extends Error {
  constructor(
    readonly decided: MatchOutcome | null,
    readonly stored: MatchOutcome,
  ) {
    super(`awardedMatchState: the walkover folds to ${JSON.stringify(decided)}, not the stored ${JSON.stringify(stored)}`);
    this.name = "AwardFoldMismatch";
  }
}

/**
 * R116-2 (W2b Task 16; owner ruling 116, T13's one credited score, X-WO-1) — the state and score of a match decided by
 * an award that NO EVENT recorded: ruling 116's walkover over a withdrawn winner's dead seat (`awardSeededByes`).
 *
 * "Like any other walkover" includes its score, so it is the engine's own walkover, not a second calculation: the fold
 * of the award's event — `core.forfeit{by: loser, reason}`, exactly what an ordinary withdrawal walkover records — over
 * this fixture's cfg and sides, held in memory only (the ledger stays empty: nobody played, X-PS-1). The module's
 * summary reads the credit from its own `forfeitCredit` (football's `displayedGoals`, the set kernel's
 * `displayedSets`, …), and the state is the walkover's in every detail (its phase, its method). The fold's decision
 * must BE the stored award, or the score would describe a different result: that is refused, not written.
 *
 * `forfeitAward` (W2c Task 16b): the award the fixture's stage points rule offers (`stageForfeitAward`). An award no event
 * records sits in a bracket stage, which holds no points rule (RULE_NOT_SETTABLE `points`), so no door writes one with an
 * award today - the input is carried so that the row is still the fold the table's rule would credit if one ever did
 * (`__tests__/forfeit-award-callers.test.ts` reaches it with a rule written by raw SQL).
 */
export function awardedMatchState(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  outcome: MatchOutcome,
  at: { fixtureId: string; recordedAt: string },
  forfeitAward?: ForfeitAward,
): { state: unknown; summary: ScoreSummary } {
  if (outcome.kind !== "award") {
    throw new Error(`awardedMatchState: a "${outcome.kind}" is no award, and only an award is decided without play`);
  }
  if (outcome.loser === null) {
    throw new Error("awardedMatchState: a bye has no loser, and a bye credits no score");
  }
  const forfeit: EventEnvelope = {
    id: `awarded:${at.fixtureId}`,
    fixtureId: at.fixtureId,
    seq: 1,
    type: "core.forfeit",
    payload: { by: outcome.loser, reason: outcome.reason },
    recordedAt: at.recordedAt,
    recordedBy: null,
  };
  // W2c Task 16b: the stage rule's walkover award (a walkover nobody played is the case it exists for), when the stage has one.
  const folded = foldMatchWithStoppage(module, cfg as never, lineups, [forfeit], forfeitAward === undefined ? undefined : { forfeitAward });
  const decided = outcomeOf(module, folded);
  if (!isDeepStrictEqual(decided, outcome)) throw new AwardFoldMismatch(decided, outcome);
  return { state: folded.state, summary: summaryOf(module, folded) };
}

/** An award with a loser: the only decision without play that credits a score (a bye names no loser). */
export const isScoredAward = (o: MatchOutcome | null): o is Extract<MatchOutcome, { kind: "award" }> & { loser: string } =>
  o !== null && o.kind === "award" && o.loser !== null;

/** `awardFit`'s verdict. `FIXTURE_FORMAT_LOCKED`: no fit applies to the stored award. `FORMAT_DOES_NOT_FIT_PLAY`: the
 *  corrected format would not keep it, for `reason`. */
export type AwardFitVerdict =
  | { ok: true }
  | { ok: false; code: "FIXTURE_FORMAT_LOCKED" }
  | { ok: false; code: "FORMAT_DOES_NOT_FIT_PLAY"; reason: string };

/**
 * W2c Task 14 (fix rounds 1–2, X-SR-5 for a match decided WITHOUT play) — does a format correction keep an award no
 * event records? Pure: the award's own walkover fold (`awardedMatchState`) under the format it plays now and under the
 * corrected one, and nothing else (`fixture-rules.ts` (7a) is the one caller).
 *
 *  - A bye (no loser) or no award at all credits no score: no fit applies (`FIXTURE_FORMAT_LOCKED`).
 *  - The CURRENT fold must reproduce the stored award, or there is nothing to fit against: the engine refusing the
 *    forfeit, or the fold deciding another award, is `FIXTURE_FORMAT_LOCKED` too — a named refusal, never a 500.
 *  - Under the corrected format: the engine refusing the forfeit is `FORMAT_DOES_NOT_FIT_PLAY` with its own message;
 *    the fold deciding another award is the "result" reason; a different credited score is the "score" reason.
 *  - Anything else thrown is a module bug, not a verdict, and propagates.
 */
/** Does the stored award hold under `cfg`? Its walkover folded there (`awardedMatchState`), or the reason it will not
 *  hold: the engine refusing the forfeit (its own message) or the fold deciding another award (the "result" reason). A
 *  module bug (a plain Error) is no verdict and propagates. The format correction asks it of the corrected cfg
 *  (`awardFit`); a FORMAT SAVE asks only this (batch-3 I1, `award-rewrite.ts`): the save moves the credited score with
 *  it, so the old fold is no question there. */
export function awardFoldsUnder(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  outcome: MatchOutcome,
  at: { fixtureId: string; recordedAt: string },
  forfeitAward?: ForfeitAward,
): { ok: true; state: ReturnType<typeof awardedMatchState> } | { ok: false; reason: string } {
  try {
    return { ok: true, state: awardedMatchState(module, cfg, lineups, outcome, at, forfeitAward) };
  } catch (err) {
    if (EngineError.is(err)) return { ok: false, reason: err.message };
    if (err instanceof AwardFoldMismatch) return { ok: false, reason: FORMAT_FIT_REASONS.result };
    throw err;
  }
}

export function awardFit(
  module: AnySportModule,
  currentCfg: unknown,
  correctedCfg: unknown,
  lineups: LineupPair,
  outcome: MatchOutcome,
  at: { fixtureId: string; recordedAt: string },
  forfeitAward?: ForfeitAward,
): AwardFitVerdict {
  if (!isScoredAward(outcome)) return { ok: false, code: "FIXTURE_FORMAT_LOCKED" };
  let was;
  try {
    was = awardedMatchState(module, currentCfg, lineups, outcome, at, forfeitAward);
  } catch (err) {
    if (EngineError.is(err) || err instanceof AwardFoldMismatch) return { ok: false, code: "FIXTURE_FORMAT_LOCKED" };
    throw err;
  }
  const now = awardFoldsUnder(module, correctedCfg, lineups, outcome, at, forfeitAward);
  if (!now.ok) return { ok: false, code: "FORMAT_DOES_NOT_FIT_PLAY", reason: now.reason };
  if (now.state.summary.headline !== was.summary.headline)
    return { ok: false, code: "FORMAT_DOES_NOT_FIT_PLAY", reason: FORMAT_FIT_REASONS.score };
  return { ok: true };
}

/**
 * Writes `awardedMatchState` for one fixture into `match_states` — the cache every public read joins for `summary`
 * (`public_fixtures_v`) — at the ledger's tip: no event is recorded for it (X-PS-1: the stats reader reads the
 * ledger, so the tie stays no match played; the forfeit is folded, never appended). The tip is 0 for a tie nobody
 * touched; for one whose every event a void took back (Start, then Undo) it is that ledger's last seq, the token
 * every append is checked against (`getFixtureState`'s `last_seq`), which every `last_seq` writer takes from the
 * ledger. Under the fixture's own resolved cfg (`resolveFixtureCfg`, the fold's) and
 * with her in her dead seat for the fold's sides — she is the award's loser, never seated (X-WD-3); `unseatedForfeitLoser`
 * is the one reader of whose seat it is.
 *
 * Called from the write that awards the tie. A reset of that award (`fed-seats.ts` `writePlan`) drops the row with it
 * (`clearAwardedMatchState`), so over an EMPTY ledger a row already here is a broken assumption, refused by name
 * rather than overwriting a cache some other write made. Over a ledger every void took back, the row is that ledger's
 * fold (the take-back's append wrote it), which holds no play: the award takes it over, and its reset re-folds that
 * ledger into it (Loop R M-17, class 13 — refusing it refused the arriving side's decider) — over the award's sides,
 * not the take-back's (Loop R2 N-3, `clearAwardedMatchState`). A recorded event that still stands is
 * play, and an award recorded without an event never overwrites play: refused by name. (A revived walkover — a voided
 * double walkover's dead seat — never needs the clear: its dead seat's feeder has no winner, so its award is a bye and
 * wrote no row.)
 */
export async function writeAwardedMatchState(
  tx: Tx,
  fixtureId: string,
  opts: {
    /** W2c Task 14 (fix round 1, I1): the award's OWN row, re-written under the fixture's cfg as it now resolves — a
     *  format correction (`fixture-rules.ts`) changed it and proved the award still scores the same way. Only an award
     *  with no standing play reaches here (refused below like any other), so the row replaced is the award's. */
    rewrite?: boolean;
  } = {},
): Promise<void> {
  const award = await loadAward(tx, fixtureId);
  if (award.ledger.standing > 0) {
    throw new Error(`writeAwardedMatchState: ${fixtureId} holds ${award.ledger.standing} recorded event(s) no void took back, and an award recorded without an event never overwrites play`);
  }
  const { state, summary } = awardedMatchState(
    award.module,
    award.cfg,
    award.lineups,
    award.outcome,
    { fixtureId, recordedAt: new Date().toISOString() },
    award.forfeitAward,
  );
  const written = await tx`
    insert into match_states (fixture_id, last_seq, state, summary)
    values (${fixtureId}, ${award.ledger.tip}, ${tx.json(state as never)}, ${tx.json(summary as never)})
    on conflict (fixture_id) do update set
      last_seq = excluded.last_seq, state = excluded.state, summary = excluded.summary, updated_at = now()
      where ${award.ledger.tip > 0 || opts.rewrite === true}
    returning fixture_id`;
  if (written.length === 0) {
    throw new Error(`writeAwardedMatchState: ${fixtureId} already holds a match state, and an award recorded without an event never overwrites one`);
  }
}

/** What an award with no play is folded from (`writeAwardedMatchState`'s inputs, one reader): its module, the
 *  fixture's own resolved cfg (`resolveFixtureCfg`, the fold's), its sides — her dead seat included
 *  (`unseatedForfeitLoser`) — and its ledger. Throws on a fixture that is no award over two sides. */
export async function loadAward(
  tx: Tx,
  fixtureId: string,
): Promise<{
  module: AnySportModule;
  cfg: unknown;
  lineups: LineupPair;
  outcome: MatchOutcome;
  ledger: { tip: number; standing: number };
  /** W2c Task 16b - the walkover award the fixture's stage rule offers (`stageForfeitAward`); absent for none. */
  forfeitAward?: ForfeitAward;
}> {
  const [fixture] = await tx<
    {
      division_id: string;
      stage_id: string;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
      config_snapshot: unknown;
      rules_override: unknown;
      outcome: MatchOutcome | null;
    }[]
  >`
    select division_id, stage_id, home_entrant_id, away_entrant_id, config_snapshot, rules_override, outcome
    from fixtures where id = ${fixtureId}`;
  if (!fixture) throw new Error(`writeAwardedMatchState: no fixture ${fixtureId}`);
  const home = fixture.home_entrant_id ?? unseatedForfeitLoser(fixture, "home");
  const away = fixture.away_entrant_id ?? unseatedForfeitLoser(fixture, "away");
  if (home === null || away === null || fixture.outcome === null) {
    throw new Error(`writeAwardedMatchState: ${fixtureId} is no award over a side that holds no seat`);
  }
  const [division] = await tx<{ config: unknown; sport_key: string; module_version: string }[]>`
    select config, sport_key, module_version from divisions where id = ${fixture.division_id}`;
  const [stage] = await tx<{ kind: string; config: Record<string, unknown> | null }[]>`
    select kind, config from stages where id = ${fixture.stage_id}`;
  if (!division) throw new Error(`writeAwardedMatchState: no division for ${fixtureId}`);
  const sportModule = resolveModule(division.sport_key, division.module_version);
  const cfg = resolveFixtureCfg(fixture, division.config, stage, sportModule);
  const ledger = await ledgerOf(tx, fixtureId);
  const lineups = await loadLineupPair(tx, fixtureId, home, away);
  const forfeitAward = stageForfeitAward(stage, sportModule);
  return { module: sportModule, cfg, lineups, outcome: fixture.outcome, ledger, ...(forfeitAward === undefined ? {} : { forfeitAward }) };
}

/**
 * R116-2 — the other half of `writeAwardedMatchState`: a write that puts an awarded tie back to `scheduled` (her feeder
 * voided, a dead seat revived) takes its score with it, or the re-opened tie would show the old walkover's credit as if
 * still decided — and the re-award would collide with it. A row with NO ledger behind it goes: that is the one the
 * award wrote, since every other `match_states` row is a fold of recorded events (append, rebuild) and stays theirs.
 *
 * Loop R M-17: over a ledger every void took back, the award took over that ledger's row (`writeAwardedMatchState`),
 * so the reset re-folds the ledger into it rather than dropping it — a ledger with no row reads `last_seq` 0
 * (`getFixtureState`), and every append to it would then be refused SEQ_CONFLICT.
 *
 * Loop R2 N-3: the row is a CACHE, and this re-folds it over the sides it names NOW (its summary's `perSide`, home then
 * away — her seat and the arriving side's may both be released by now, so the seats cannot say). After a takeover
 * those are the AWARD's sides: her and whoever walked over her, who need not be the side the take-back was recorded
 * with (the arriving line re-decided the other way). So the reset row is that ledger's fold — at its tip, crediting no
 * play — but not necessarily the row the take-back wrote: it can name a different arriving side. No column holds the
 * take-back's sides once the award has written over them, and none is owed: the names are never fold input — every
 * append re-folds the whole ledger over whoever is seated then (append-event.ts), and is checked against `last_seq`,
 * which this writes from the ledger. A row over play that still stands is that play's fold, and stays.
 */
export async function clearAwardedMatchState(tx: Tx, fixtureId: string): Promise<void> {
  await tx`
    delete from match_states m
    where m.fixture_id = ${fixtureId}
      and not exists (select 1 from score_events e where e.fixture_id = m.fixture_id)`;
  const ledger = await ledgerOf(tx, fixtureId);
  if (ledger.standing > 0) return;
  const [row] = await tx<{ summary: ScoreSummary }[]>`select summary from match_states where fixture_id = ${fixtureId}`;
  if (!row) return;
  const sides = row.summary.perSide;
  if (sides.length !== 2 || !sides[0]!.entrantId || !sides[1]!.entrantId) {
    throw new Error(`clearAwardedMatchState: ${fixtureId}'s row names ${sides.length} side(s), not the two it was folded over`);
  }
  const inputs = await loadFoldInputs(tx, fixtureId, { home: sides[0]!.entrantId, away: sides[1]!.entrantId });
  if (inputs === null) throw new Error(`clearAwardedMatchState: ${fixtureId}'s ledger of ${ledger.tip} event(s) did not load`);
  const folded = foldFrom(fixtureId, inputs);
  await tx`
    update match_states
    set last_seq = ${folded.lastSeq}, state = ${tx.json(folded.state as never)}, summary = ${tx.json(folded.summary as never)},
        updated_at = now()
    where fixture_id = ${fixtureId}`;
}
