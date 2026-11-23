// Batch 3's Swiss harness: plays a small Swiss stage the way the app pairs one, for the Swiss posts' examples
// (#13 how-swiss-pairing-works, #14 swiss-chess-bye, #15 joining-or-leaving-a-swiss). Every step is the app's or the
// engine's own code, never a copy of it:
//   - the field of each round: `swissFieldForRound` (a late entrant is in the field from its first round only);
//   - the history (who met, colours, who may no longer take the bye): `buildSwissHistory`, over rows shaped as stored, and
//     the float history the Pair has sent since #1291 (how many earlier rounds each entrant floated DOWN in):
//     `swissFloatHistory`, the app's own derivation, over the same rows. The one thing the harness cannot call is
//     `stageTablePointsBefore`, which reads the table each earlier round started from out of the database: the run holds that table
//     itself (its running points, paid by `payout` and `awardByeDelta` as `stageTablePoints` folds them) and snapshots it as each
//     round begins. blog-swiss-floats.test.ts holds the result to the printed boards and to the engine's own `floated` lists;
//   - the score each round is paired on: the stage's table points, every game paid by the web's one rules loader
//     (`tableRulesOf`) and the engine's `payout`, the bye by the app's own bye credit (`awardByeDelta`);
//   - the constraints `swissGen` sends: chess colours for chess (`isChessSport`), the look-ahead above the safe maximum
//     (`swissRoundsGuidance`), the final round's topscorer line (`maxRoundPoints`), round 1's colour lot (`swissColourLot`);
//   - the pairing itself: the engine's `pairRound`;
//   - every game: a real match, played through the testkit's seeded walk and read back through the app's read fold
//     (`foldFrom`, so the outcome and the headline are outcomeOf and summaryOf, as a stored fixture's are).
// The fixture (who is seeded where, and which side wins each board) is the example's input; every number the posts show
// (scores, who has the bye, who plays whom) comes out of the run.
import type { MatchOutcome } from "@seazn/engine/core";
import { decidedInFor, forfeitShaped, payout, setsToWinOf, pointsText, withdrawTableEntrant, type FixtureResult, type TableFixture } from "@seazn/engine/competition";
import { pairRound, type SwissStanding } from "@seazn/engine/scheduling";
import { resolvePositions, type AnySportModule } from "@seazn/engine/sport";
import { buildWalk, lineupFromCatalog } from "@seazn/engine/testkit";
import { applyRoundOneColourLot, swissColourLot, swissDrawSeed } from "@/lib/swiss-draw";
import { isChessSport } from "@/lib/chess-individual-only-rule";
import { swissRoundsGuidance } from "@/lib/swiss-rounds";
import { byeAward } from "@/lib/fixture-bye";
import { foldFrom } from "@/server/engine-db/fold";
import { tableRulesOf, type LoadedTableRules } from "@/server/engine-db/table-rules";
import { liveCfg } from "@/server/engine-db/fixture-cfg";
import { maxRoundPoints } from "@/server/engine-db/swiss-max-round-points";
import { awardByeDelta } from "@/server/engine-db/competition";
import { buildSwissHistory, swissFieldForRound, swissFloatHistory } from "@/server/usecases/stages/swiss-gen";
import type { ActiveEntrant, SwissExistingFixture } from "@/server/usecases/stages/types";
import type { DiagramModel } from "./types";
import { moduleOf, startingCfg } from "./kit";

const MAX_SEEDS = 20000;
const MAX_EVENTS = 3000;

export type BoardResult = "home" | "away" | "draw";

export interface SwissRunEntrant {
  id: string;
  name: string;
  seed: number;
  /** The first round the entrant is in the field for (a late entrant); absent = from round 1. */
  firstRound?: number;
}

export interface SwissRunInput {
  stageId: string;
  sportKey: string;
  rounds: number;
  entrants: readonly SwissRunEntrant[];
  /** Which side wins each board: the fixture's own input, never a result number. */
  result(round: number, board: number, home: string, away: string): BoardResult;
  /** Entrants who leave after a round, before the next one is paired. */
  withdrawnAfter?: Readonly<Record<string, number>>;
  /** An entrant who leaves once a round is PAIRED, before it is played: the engine's withdrawal rule for a Swiss stage
   *  (`withdrawTableEntrant`) decides what happens to that board, and later rounds pair without them. */
  withdrawnAfterPairing?: { entrant: string; round: number };
}

export interface SwissRunBoard {
  board: number;
  home: string;
  away: string;
  /** Each side's table points before the round, in the table's own units. */
  before: [number, number];
  result: BoardResult;
  headline: string;
  /** Set when the board was walked over by the withdrawal rule: who it was walked over to. */
  walkoverTo?: string;
}

export interface SwissRunRound {
  round: number;
  field: string[];
  boards: SwissRunBoard[];
  bye: { entrant: string; before: number; paid: number } | null;
  /** Table points after the round, every entrant who has been in a field so far. */
  after: Map<string, number>;
  /** What the round was paired from: the app's history (who met, colours, who may no longer take the bye, and the float history) and
   *  the standings the engine saw. A test re-pairs the round from them with one thing changed, to show what that thing did.
   *  `floated` is the engine's own list of who floated down on THIS round (`SwissRound.floated`), the declaration the float history
   *  of the rounds after it is checked against (blog-swiss-floats.test.ts). */
  paired: { standings: SwissStanding[]; history: Parameters<typeof pairRound>[1]; floated: string[] };
}

export interface SwissRun {
  module: AnySportModule;
  cfg: unknown;
  rules: LoadedTableRules;
  unit: "whole" | "half";
  chess: boolean;
  rounds: SwissRunRound[];
  /** The withdrawal rule's verdict, when an entrant left a paired round (`withdrawTableEntrant`'s event). */
  withdrawal: { mode: string; played: number; scheduled: number; walkovers: number } | null;
  name(id: string): string;
  points(n: number): string;
}

/** A Swiss stage's table rules, read by the web's one loader over a new stage on this division cfg. */
export function swissRules(module: AnySportModule, cfg: unknown, stageId: string): LoadedTableRules {
  return tableRulesOf(
    { stageId, kind: "swiss", status: "pending", stageConfig: null, pin: null, pinnedAt: null, divisionConfig: cfg, divisionTiebreakers: null },
    module,
  );
}

/** What a Swiss bye pays its holder, by the app's own bye credit (the row the standings fold books for a bye). */
export function byeDelta(module: AnySportModule, cfg: unknown, rules: LoadedTableRules, holder: string) {
  return awardByeDelta(module, byeAward(holder) as MatchOutcome, cfg, { kind: "swiss" }, rules.points, holder);
}

interface Played {
  outcome: MatchOutcome;
  paid: FixtureResult;
  headline: string;
}

/** One real match to the wanted result, read back through the app's read fold. */
function play(module: AnySportModule, cfg: unknown, rules: LoadedTableRules, home: string, away: string, want: BoardResult): Played {
  const catalog = resolvePositions(module, cfg as never);
  const lineups = { home: lineupFromCatalog(catalog, home), away: lineupFromCatalog(catalog, away) };
  for (let seed = 1; seed <= MAX_SEEDS; seed++) {
    const { events, states } = buildWalk(module, cfg as never, lineups, seed, MAX_EVENTS);
    if (states.length === 0) continue;
    const folded = foldFrom(`blog-swiss:${home}:${away}:${seed}`, { sportKey: module.key, module, cfg, lineups, envelopes: events, stageKind: "swiss" } as never);
    const o = folded.outcome;
    // Only a played match: a walk can also end in a forfeit, which is not the result asked for.
    if (o === null || forfeitShaped(o)) continue;
    const ok =
      want === "draw" ? o.kind === "draw" : o.kind === "win" && o.winner === (want === "home" ? home : away) && decidedInFor(module, o) === "regulation";
    if (!ok) continue;
    const delta = module.standingsDelta(o, cfg as never, { kind: "swiss" }, folded.state);
    const pair: FixtureResult = [delta[0], delta[1]];
    const paid = payout(o, decidedInFor(module, o), pair, true, rules.points, module.awardScoreKeys, setsToWinOf(module, cfg));
    return { outcome: o, paid, headline: folded.summary.headline };
  }
  throw new Error(`swiss-run: ${module.key}: no seed up to ${MAX_SEEDS} plays ${home} v ${away} to '${want}'`);
}

/** A board the withdrawal rule walks over: the leaver's side forfeits on an empty ledger, as the withdrawal cascade writes
 *  it (`core.forfeit{by, reason: "withdrew"}`), read back through the app's read fold and paid as nothing played. */
export function walkover(module: AnySportModule, cfg: unknown, rules: LoadedTableRules, home: string, away: string, leaver: string): Played {
  const catalog = resolvePositions(module, cfg as never);
  const lineups = { home: lineupFromCatalog(catalog, home), away: lineupFromCatalog(catalog, away) };
  const envelope = { id: "e-0", fixtureId: "blog-swiss-walkover", seq: 0, type: "core.forfeit", payload: { by: leaver, reason: "withdrew" }, recordedAt: "2026-01-01T00:00:00.000Z", recordedBy: "blog" };
  const folded = foldFrom(`blog-swiss-walkover:${home}:${away}`, { sportKey: module.key, module, cfg, lineups, envelopes: [envelope], stageKind: "swiss" } as never);
  const o = folded.outcome;
  if (o === null || !forfeitShaped(o)) throw new Error(`swiss-run: the walkover of ${home} v ${away} did not fold to a forfeit`);
  const delta = module.standingsDelta(o, cfg as never, { kind: "swiss" }, folded.state);
  const pair: FixtureResult = [delta[0], delta[1]];
  const paid = payout(o, decidedInFor(module, o), pair, false, rules.points, module.awardScoreKeys, setsToWinOf(module, cfg));
  return { outcome: o, paid, headline: folded.summary.headline };
}

export function runSwiss(input: SwissRunInput): SwissRun {
  const sportModule = moduleOf(input.sportKey);
  const cfg = startingCfg(sportModule);
  const rules = swissRules(sportModule, cfg, input.stageId);
  const unit = rules.points.unit;
  const names = new Map(input.entrants.map((e) => [e.id, e.name]));
  const name = (id: string) => names.get(id) ?? id;
  const chess = isChessSport(sportModule.key);
  const existing: SwissExistingFixture[] = [];
  const total = new Map<string, number>();
  const rounds: SwissRunRound[] = [];
  const withdrawn: Record<string, number> = { ...(input.withdrawnAfter ?? {}) };
  const late = input.withdrawnAfterPairing;
  if (late !== undefined) withdrawn[late.entrant] = late.round;
  const playedFacts = new Map<string, boolean>();
  const results = new Map<string, FixtureResult>();
  let withdrawal: SwissRun["withdrawal"] = null;
  const merged = liveCfg(cfg, { kind: "swiss", config: { rounds: input.rounds } }, sportModule);
  // The table each round STARTED from (round -> points going in): what `stageTablePointsBefore` hands `swissFloatHistory` for each earlier
  // round the Pair reads. The run's running `total` is that table (every game paid by `payout`, the bye by `awardByeDelta`, as
  // `stageTablePoints` folds them), so a snapshot taken as each round begins is the cut the app reads from the database.
  const pointsBefore = new Map<number, ReadonlyMap<string, number>>();

  for (let r = 1; r <= input.rounds; r++) {
    // The active list as the app selects it: withdrawn entrants are gone, the order is the seeding order.
    const active: ActiveEntrant[] = [...input.entrants]
      .filter((e) => withdrawn[e.id] === undefined || withdrawn[e.id]! >= r)
      .sort((a, b) => a.seed - b.seed)
      .map((e) => ({ id: e.id, seed: e.seed, swiss_first_round: e.firstRound ?? null }));
    const field = swissFieldForRound(active, r);
    const { played, colours, byes } = buildSwissHistory(existing, field, playedFacts);
    pointsBefore.set(r, new Map(total));
    // The app's own derivation, over the rows paired so far: one float for the stronger side of every earlier two-seated board whose
    // sides came in on different points (a bye is no board, a walked-over board was one when it was paired).
    const floats = swissFloatHistory(existing, r, pointsBefore);
    // One object: the history the engine pairs from is the history the run records (a test re-pairs from it).
    const history: Parameters<typeof pairRound>[1] = { played, colours, byes, floats };
    const standings: SwissStanding[] = field.map((e) => ({ entrantId: e.id, score: total.get(e.id) ?? 0, rank: e.seed ?? 0 }));
    const lookAhead = r < input.rounds && input.rounds > swissRoundsGuidance(field.length).safeMax;
    const most = maxRoundPoints(rules.points, sportModule, merged);
    const finalMax = chess && r === input.rounds && input.rounds > 1 && most > 0 ? (input.rounds - 1) * most : undefined;
    const paired = pairRound(standings, history, { chess, ...(lookAhead ? { lookAhead: true } : {}), ...(finalMax !== undefined ? { finalRoundMaxScore: finalMax } : {}) });
    if (!paired.ok) throw new Error(`swiss-run: round ${r} refused: ${paired.reason}`);
    const pairings = r === 1 && chess ? applyRoundOneColourLot(paired.pairings, swissColourLot(swissDrawSeed(input.stageId))) : paired.pairings;
    // An entrant leaving this paired round: the engine's withdrawal rule over their decided and paired boards.
    const walkovers = new Map<string, string>();
    if (late !== undefined && late.round === r) {
      const mine = pairings.map((p, i) => ({ p, id: `r${r}b${i + 1}` })).filter(({ p }) => p.home === late.entrant || p.away === late.entrant);
      const playedRows: TableFixture[] = existing
        .filter((f) => results.has(f.id))
        .map((f) => ({ id: f.id, roundNo: f.round_no, status: "decided", result: results.get(f.id)! }) as TableFixture);
      const verdict = withdrawTableEntrant({ id: input.stageId, kind: "swiss" }, late.entrant, {
        played: playedRows,
        pending: mine.map(({ p, id }) => ({ id, opponent: p.home === late.entrant ? p.away : p.home })),
      });
      for (const u of verdict.updates) if (u.status === "walkover" && u.walkoverTo !== undefined) walkovers.set(u.fixtureId, u.walkoverTo);
      const ev = verdict.events[0] as { mode?: string; played?: number; scheduled?: number };
      withdrawal = { mode: String(ev.mode), played: Number(ev.played), scheduled: Number(ev.scheduled), walkovers: walkovers.size };
    }
    const boards: SwissRunBoard[] = [];
    for (const [i, p] of pairings.entries()) {
      const id = `r${r}b${i + 1}`;
      const to = walkovers.get(id);
      const want: BoardResult = to !== undefined ? (to === p.home ? "home" : "away") : input.result(r, i + 1, p.home, p.away);
      const g = to !== undefined ? walkover(sportModule, cfg, rules, p.home, p.away, to === p.home ? p.away : p.home) : play(sportModule, cfg, rules, p.home, p.away, want);
      results.set(id, g.paid);
      if (to !== undefined) playedFacts.set(id, false);
      const before: [number, number] = [total.get(p.home) ?? 0, total.get(p.away) ?? 0];
      for (const d of g.paid) total.set(d.entrantId, (total.get(d.entrantId) ?? 0) + d.points);
      existing.push({
        id,
        ext_key: null,
        round_no: r,
        seq_in_round: i + 1,
        status: "decided",
        home_entrant_id: p.home,
        away_entrant_id: p.away,
        outcome: g.outcome,
        scheduled_at: null,
      } as SwissExistingFixture);
      boards.push({ board: i + 1, home: p.home, away: p.away, before, result: want, headline: g.headline, ...(to !== undefined ? { walkoverTo: to } : {}) });
    }
    let bye: SwissRunRound["bye"] = null;
    if (paired.bye !== undefined) {
      const before = total.get(paired.bye) ?? 0;
      const credit = byeDelta(sportModule, cfg, rules, paired.bye);
      total.set(paired.bye, before + credit.points);
      existing.push({
        id: `r${r}bye`,
        ext_key: null,
        round_no: r,
        seq_in_round: pairings.length + 1,
        status: "forfeited",
        home_entrant_id: paired.bye,
        away_entrant_id: null,
        outcome: byeAward(paired.bye),
        scheduled_at: null,
      } as SwissExistingFixture);
      bye = { entrant: paired.bye, before, paid: credit.points };
    }
    for (const e of field) if (!total.has(e.id)) total.set(e.id, 0);
    rounds.push({ round: r, field: field.map((e) => e.id), boards, bye, after: new Map(total), paired: { standings, history, floated: paired.floated } });
  }
  return { module: sportModule, cfg, rules, unit, chess, rounds, withdrawal, name, points: (n: number) => pointsText(n, unit) };
}

/**
 * One round of a run as the Swiss round grid draws it (`DiagramModel` `swissRound`): every board, side and score is read
 * off the run's own round, never typed. `label` is how the example names a player (the table's own cell), `result` how it
 * prints a board's result (the table's own cell).
 */
export function roundDiagram(
  run: SwissRun,
  roundNo: number,
  title: string,
  label: (id: string) => string,
  opts: { result?: (b: SwissRunBoard) => string; notSeated?: { name: string; why: string }[] } = {},
): Extract<DiagramModel, { kind: "swissRound" }> {
  const round = run.rounds.find((r) => r.round === roundNo);
  if (round === undefined) throw new Error(`swiss-run: no round ${roundNo} to draw`);
  return {
    kind: "swissRound",
    title,
    round: roundNo,
    pairings: round.boards.map((b) => ({
      board: b.board,
      first: label(b.home),
      second: label(b.away),
      firstScore: run.points(b.before[0]),
      secondScore: run.points(b.before[1]),
      result: (opts.result ?? ((x) => x.headline))(b),
      ...(run.chess ? { firstWhite: true } : {}),
      float: b.before[0] !== b.before[1],
    })),
    byes: round.bye === null ? [] : [label(round.bye.entrant)],
    ...(opts.notSeated !== undefined && opts.notSeated.length > 0 ? { notSeated: opts.notSeated } : {}),
  };
}
