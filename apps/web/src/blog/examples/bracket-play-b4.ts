// Blog batch 4 (knockouts): the one way the batch's examples PLAY a generated bracket. A bracket comes from the engine's own
// generator (or the app's `generate`, which calls it); each match's winner is a FIXED pick the example states (a seed rule
// plus named upsets), so the example needs no sport and no random draw. The rows are seated from the generator's own feeds
// (`homeFrom` / `awayFrom`), so who meets whom is the engine's wiring, never a typed pairing. Places are the engine's
// `bracketRanks`, the reading every bracket placement in the app goes through (engine-db/competition/bracket-stage.ts).
// Round names are the product's own (`roundRole` -> `roundRoleLabel`, the one place a role becomes text).
import { EngineError, FORFEIT_REASONS } from "@seazn/engine/core";
import { bracketRanks, roundRole, type BracketFixture, type BracketStage, type FinalPlace } from "@seazn/engine/competition";
import type { BracketFixtureGen, GeneratedBracket } from "@seazn/engine/scheduling";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { forEachSport } from "@seazn/engine/testkit";
import { HttpError } from "@/lib/errors";
import { advancingSides, killsLoserEdge } from "@/server/engine-db/fed-seats";
import { templatesForSport } from "@/lib/format-templates";
import { generate } from "@/server/usecases/stages/generators";
import { msg } from "@/lib/messages";
import { roundRoleLabel } from "@/lib/round-role-label";
import type { BracketMatchModel, Claim, DiagramModel } from "./types";

/**
 * The app's own Generate for a bracket stage (`generate`, server/usecases/stages/generators.ts: the producer the Start and
 * Generate writes persist), read back into the generator's shape: the line's key is its id, its 1-based round number its
 * round (0-based), its feeds the keys they name. A refusal comes back as the app's refusal code.
 */
export function appDraw(
  kind: "knockout" | "page_playoff" | "double_elim" | "stepladder",
  cfg: Record<string, unknown>,
  players: readonly string[],
  seeds: ReadonlyMap<string, number>,
): GeneratedBracket | { refused: string } {
  let rows;
  try {
    rows = generate(kind, cfg, players.map((id) => ({ id, seed: seeds.get(id) ?? null, swiss_first_round: null })), new Map());
  } catch (err) {
    if (err instanceof HttpError && err.code !== undefined) return { refused: err.code };
    if (EngineError.is(err)) return { refused: err.code };
    throw err;
  }
  const fixtures: BracketFixtureGen[] = rows.map((g) => ({
    id: g.extKey,
    round: g.roundNo - 1,
    ...(g.lane === undefined ? {} : { bracket: g.lane }),
    ...(g.isFinal === true ? { isFinal: true } : {}),
    ...(g.thirdPlace === true ? { thirdPlace: true } : {}),
    ...(g.conditional === true ? { conditional: true } : {}),
    ...(g.award !== undefined ? { award: g.award } : {}),
    ...(g.award === undefined && g.home !== null ? { home: g.home } : {}),
    ...(g.away !== null ? { away: g.away } : {}),
    ...(g.homeFrom === undefined ? {} : { homeFrom: { fixtureId: g.homeFrom.extKey, side: g.homeFrom.side } }),
    ...(g.awayFrom === undefined ? {} : { awayFrom: { fixtureId: g.awayFrom.extKey, side: g.awayFrom.side } }),
  }));
  return { fixtures, rounds: Math.max(0, ...fixtures.map((f) => f.round)) + 1 };
}

/** Who wins a match the bracket seats: the example's own fixed pick. `null` leaves the line unplayed (a void reset). */
export type Pick = (home: string, away: string, fixture: BracketFixtureGen, played: readonly BracketFixture[]) => string | null | Forfeit;
/** The named side did not play: the other goes through by walkover (`walkedOver: "loser"`, as the app's
 *  `bracketWinnerLoser` books a forfeit). */
export interface Forfeit {
  forfeitedBy: string;
}

/** The better seed (the lower number) wins, except the named upsets, keyed by `fixtureId` or by the pair `a|b` either way round. */
export function betterSeedWins(seeds: ReadonlyMap<string, number>, upsets: Readonly<Record<string, string>> = {}): (home: string, away: string, fixture: BracketFixtureGen) => string {
  return (home, away, fixture) => {
    const named = upsets[fixture.id] ?? upsets[`${home}|${away}`] ?? upsets[`${away}|${home}`];
    if (named !== undefined) return named;
    return (seeds.get(home) ?? Number.MAX_SAFE_INTEGER) <= (seeds.get(away) ?? Number.MAX_SAFE_INTEGER) ? home : away;
  };
}

export interface PlayedLine {
  gen: BracketFixtureGen;
  row: BracketFixture;
  /** The product's name for the round ("Semi-finals", "Qualifier 1", "Grand final (reset)"). */
  roundName: string;
}

/** The stored outcome a played row stands for, in the shape the app's seat fill reads (`MatchOutcome`): a decided line is a
 *  `win`, a forfeit is an `award` naming its loser, a bye an `award` naming none, and anything else decided nothing. */
function recordedOutcome(row: BracketFixture): unknown {
  if (row.walkedOver === "loser") return { kind: "award", winner: row.winner, loser: row.loser, reason: "walkover" };
  if (row.status === "walkover") return { kind: "award", winner: row.winner, loser: null, reason: "bye" };
  if (row.status === "decided") return { kind: "win", winner: row.winner, loser: row.loser };
  return undefined;
}

/** Plays every line of `bracket` in round order. A bye `award` is booked as the generator books it (a walkover with a
 *  winner and no loser); a conditional line (a grand final reset) is played only when `pick` names a winner, else voided. */
export function playBracket(stageKind: BracketStage["kind"], bracket: GeneratedBracket, pick: Pick): PlayedLine[] {
  const byId = new Map<string, BracketFixture>();
  const out: PlayedLine[] = [];
  const order = [...bracket.fixtures].sort((a, b) => a.round - b.round);
  const fed = (ref: BracketFixtureGen["homeFrom"], into: string): string | undefined => {
    if (ref === undefined) return undefined;
    const src = byId.get(ref.fixtureId);
    if (src === undefined) throw new Error(`bracket-play: ${ref.fixtureId} is read before it is played`);
    if (ref.side === "winner") return src.winner;
    // A loser edge sends whoever the APP sends down it: `advancingSides`, the reading `onDecided` fills seats from. A forfeit's
    // loser is out of the tournament and goes nowhere (X-DE-1), so an example that forfeited a line feeding a loser edge would
    // seat a player the product never seats: refused by name, not repaired (the walkover over the dead seat is the cascade's, not this helper's).
    const sent = advancingSides(recordedOutcome(src)).loser;
    if (sent === undefined && src.loser !== undefined) {
      throw new Error(`bracket-play: ${into} would seat ${src.loser} on the loser edge of ${ref.fixtureId}, but ${src.loser} forfeited it and is out: the app sends nobody down a forfeit's loser edge (advancingSides, X-DE-1)`);
    }
    return sent;
  };
  for (const gen of order) {
    const base: BracketFixture = {
      id: gen.id,
      round: gen.round,
      status: "scheduled",
      ...(gen.bracket === undefined ? {} : { bracket: gen.bracket }),
      ...(gen.isFinal === true ? { isFinal: true } : {}),
      ...(gen.thirdPlace === true ? { thirdPlace: true } : {}),
      ...(gen.homeFrom === undefined ? {} : { homeFrom: gen.homeFrom }),
      ...(gen.awayFrom === undefined ? {} : { awayFrom: gen.awayFrom }),
    };
    let row: BracketFixture;
    if (gen.award !== undefined) {
      row = { ...base, status: "walkover", home: gen.award, winner: gen.award };
    } else {
      const home = gen.home ?? fed(gen.homeFrom, gen.id);
      const away = gen.away ?? fed(gen.awayFrom, gen.id);
      if (home === undefined || away === undefined) throw new Error(`bracket-play: ${gen.id} has an empty seat`);
      const picked = pick(home, away, gen, [...byId.values()]);
      if (picked !== null && typeof picked === "object") {
        if (picked.forfeitedBy !== home && picked.forfeitedBy !== away) throw new Error(`bracket-play: ${picked.forfeitedBy} is not seated in ${gen.id}`);
        const winner = picked.forfeitedBy === home ? away : home;
        const row: BracketFixture = { ...base, status: "walkover", home, away, winner, loser: picked.forfeitedBy, walkedOver: "loser" };
        byId.set(gen.id, row);
        out.push({ gen, row, roundName: "" });
        continue;
      }
      const winner = picked;
      if (winner === null) {
        if (gen.conditional !== true) throw new Error(`bracket-play: only a conditional line may go unplayed (${gen.id})`);
        row = { ...base, status: "void", home, away };
      } else {
        if (winner !== home && winner !== away) throw new Error(`bracket-play: ${winner} is not seated in ${gen.id}`);
        row = { ...base, status: "decided", home, away, winner, loser: winner === home ? away : home };
      }
    }
    byId.set(gen.id, row);
    out.push({ gen, row, roundName: "" });
  }
  // Round names: each lane's rounds ranked in order (`laneRoundRank`'s reading), as the bracket view names them.
  const lanes = new Map<string, number[]>();
  for (const { gen } of out) {
    const lane = gen.bracket ?? "";
    lanes.set(lane, [...new Set([...(lanes.get(lane) ?? []), gen.round])].sort((a, b) => a - b));
  }
  for (const line of out) {
    const rounds = lanes.get(line.gen.bracket ?? "")!;
    line.roundName = roundRoleLabel(
      (key, vars) => msg(key, vars),
      roundRole({
        stageKind,
        lane: line.gen.bracket ?? null,
        roundInLane: rounds.indexOf(line.gen.round),
        lastRoundInLane: rounds.length - 1,
        isFinal: line.gen.isFinal === true,
        thirdPlace: line.gen.thirdPlace === true,
        conditional: line.gen.conditional === true,
        extKey: line.gen.id,
      }),
    );
  }
  return out;
}

/** The engine's places for a played bracket. */
export function placesOf(stageKind: BracketStage["kind"], entrants: readonly string[], seeds: ReadonlyMap<string, number>, lines: readonly PlayedLine[]): FinalPlace[] {
  return bracketRanks({ id: `blog-example:${stageKind}`, kind: stageKind, entrants, seeds }, lines.map((l) => l.row));
}

export type BracketModel = Extract<DiagramModel, { kind: "bracket" }>;

export interface BracketModelOptions {
  /** How a seat's player is printed ("Ana (1)"); the diagram's winner and tags are keyed by this string. */
  seat: (player: string) => string;
  /** A short word to print beside a player in one line ("plate"), keyed by player. */
  tags?: (line: PlayedLine) => Record<string, string>;
  /** Stacks this bracket in its own headed block when a figure draws two (`mergeBrackets`). */
  lane?: string;
  /** Keeps the ids of two brackets in one figure apart. */
  idPrefix?: string;
}

/**
 * A played bracket as the diagram's model. The columns are laid out by depth: a line nobody feeds is column 0, every other
 * line is one column right of its deepest feeder, so every feed comes from an earlier column and a losers' bracket sits
 * beside the winners' round it takes losers from, not after it (a double elimination of four is five columns, not six). A
 * voided line (a reset nobody needed) is not drawn. Feeds are the generator's own (`homeFrom` / `awayFrom`), never retyped.
 */
export function bracketModel(title: string, lines: readonly PlayedLine[], opts: BracketModelOptions): BracketModel {
  const prefix = opts.idPrefix ?? "";
  const drawn = lines.filter((l) => l.row.status !== "void");
  const depth = new Map<string, number>();
  for (const l of drawn) {
    const feeds = [l.gen.homeFrom, l.gen.awayFrom].filter((f): f is NonNullable<typeof f> => f !== undefined);
    const behind = feeds.map((f) => {
      const d = depth.get(f.fixtureId);
      if (d === undefined) throw new Error(`bracket-model: ${l.gen.id} is fed by ${f.fixtureId}, which is not drawn before it`);
      return d;
    });
    depth.set(l.gen.id, behind.length === 0 ? 0 : 1 + Math.max(...behind));
  }
  const columns: { labels: string[]; matches: BracketMatchModel[] }[] = [];
  for (const l of drawn) {
    const d = depth.get(l.gen.id)!;
    columns[d] ??= { labels: [], matches: [] };
    if (!columns[d]!.labels.includes(l.roundName)) columns[d]!.labels.push(l.roundName);
    const tags = opts.tags?.(l) ?? {};
    const home = l.row.home === undefined ? null : opts.seat(l.row.home);
    const away = l.row.away === undefined ? null : opts.seat(l.row.away);
    const seatTags: Record<string, string> = {};
    for (const [player, tag] of Object.entries(tags)) seatTags[opts.seat(player)] = tag;
    columns[d]!.matches.push({
      id: `${prefix}${l.gen.id}`,
      home,
      away,
      ...(l.row.winner === undefined ? {} : { winner: opts.seat(l.row.winner) }),
      label: l.roundName,
      ...(opts.lane === undefined ? {} : { lane: opts.lane }),
      ...(l.gen.homeFrom === undefined ? {} : { homeFrom: { id: `${prefix}${l.gen.homeFrom.fixtureId}`, side: l.gen.homeFrom.side } }),
      ...(l.gen.awayFrom === undefined ? {} : { awayFrom: { id: `${prefix}${l.gen.awayFrom.fixtureId}`, side: l.gen.awayFrom.side } }),
      ...(Object.keys(seatTags).length === 0 ? {} : { tags: seatTags }),
    });
  }
  return { kind: "bracket", title, rounds: columns.map((c) => ({ name: c.labels.join(" / "), matches: c.matches })) };
}

/** Two brackets in one figure: column i holds column i of each, every match keeping the lane its bracket named. */
export function mergeBrackets(title: string, ...parts: BracketModel[]): BracketModel {
  const width = Math.max(...parts.map((p) => p.rounds.length));
  const rounds = Array.from({ length: width }, (_, i) => {
    const cols = parts.map((p) => p.rounds[i]).filter((c): c is NonNullable<typeof c> => c !== undefined);
    return { name: cols.map((c) => c.name).join(" / "), matches: cols.flatMap((c) => c.matches) };
  });
  return { kind: "bracket", title, rounds };
}

/** "3rd", "4th", "11th", "21st": an English ordinal for a place. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/**
 * The per-sport sweep for a bracket that takes no sport (the generators read entrants and seeds only): for every sport in
 * the registry (`forEachSport`, count returned), whether the format the post explains is OFFERED to a new division of it,
 * through the builder's own filter (`templatesForSport`, fed the engine's entrant kinds the way the division page feeds it).
 */
export function offeredSweep(templateKey: string): { visited: number; offered: string[]; refused: string[] } {
  const offered: string[] = [];
  const refused: string[] = [];
  const visited = forEachSport(({ key }) => {
    const m = builtinModules.find((x) => x.key === key)!;
    const kinds = effectiveEntrantModel(m.entrantModel ?? null, null).kinds;
    (templatesForSport(key, kinds).some((t) => t.key === templateKey) ? offered : refused).push(key);
  });
  return { visited, offered, refused };
}

/** The two readings of a forfeit the claim asks: who a stored decision sends onward, and whether it leaves its loser edge dead. */
export interface ForfeitRule {
  advancingSides(outcome: unknown): { winner: string | undefined; loser: string | undefined };
  killsLoserEdge(outcome: unknown): boolean;
}
const APP_FORFEIT_RULE: ForfeitRule = { advancingSides, killsLoserEdge };

/**
 * A post that says a forfeit, withdrawal or retirement loser is "out at once, never drops" (double elimination, a third-place
 * match, a Page playoff's Qualifier 2) states the APP's rule: `advancingSides` (fed-seats.ts, what the seat fill reads, X-DE-1)
 * sends the winner of an award and nobody down the loser edge, and `killsLoserEdge` reads that edge as dead. The claim runs it
 * over every reason the ENGINE declares (`FORFEIT_REASONS`), so a new reason is swept without an edit here. `rule` is the seam the
 * teeth test mutates; production passes nothing. A result with no table has nothing to be about, so it fails.
 */
export function forfeitOutClaim(rule: ForfeitRule = APP_FORFEIT_RULE): Claim {
  return {
    says: "a player who forfeits, withdraws, retires or is disqualified is out at once: nobody is sent down their loser edge, so they never drop to a losers' bracket or a third-place match",
    source: "advancingSides (WEB/server/engine-db/fed-seats.ts:146-165, the seat fill's reading) and killsLoserEdge (:121-124, X-DE-1) over FORFEIT_REASONS (ENG/core/types.js:63)",
    check: (r) => {
      if ((r.table?.rows.length ?? 0) === 0) return "no table: the example has nothing to be about";
      let checked = 0;
      for (const reason of FORFEIT_REASONS) {
        const award = { kind: "award", winner: "W", loser: "L", reason };
        const sides = rule.advancingSides(award);
        if (sides.winner !== "W") return `${reason}: the winner is not sent on (${String(sides.winner)})`;
        if (sides.loser !== undefined) return `${reason}: the loser is sent down the loser edge (${sides.loser})`;
        if (!rule.killsLoserEdge(award)) return `${reason}: the loser edge is not read as dead`;
        checked++;
      }
      return (checked > 0 && checked === FORFEIT_REASONS.length) || `checked ${checked} of ${FORFEIT_REASONS.length} reasons`;
    },
  };
}
