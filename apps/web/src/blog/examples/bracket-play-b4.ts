// Blog batch 4 (knockouts): the one way the batch's examples PLAY a generated bracket. A bracket comes from the engine's own
// generator (or the app's `generate`, which calls it); each match's winner is a FIXED pick the example states (a seed rule
// plus named upsets), so the example needs no sport and no random draw. The rows are seated from the generator's own feeds
// (`homeFrom` / `awayFrom`), so who meets whom is the engine's wiring, never a typed pairing. Places are the engine's
// `bracketRanks`, the reading every bracket placement in the app goes through (engine-db/competition/bracket-stage.ts).
// Round names are the product's own (`roundRole` -> `roundRoleLabel`, the one place a role becomes text).
import { EngineError } from "@seazn/engine/core";
import { bracketRanks, roundRole, type BracketFixture, type BracketStage, type FinalPlace } from "@seazn/engine/competition";
import type { BracketFixtureGen, GeneratedBracket } from "@seazn/engine/scheduling";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { forEachSport } from "@seazn/engine/testkit";
import { HttpError } from "@/lib/errors";
import { templatesForSport } from "@/lib/format-templates";
import { generate } from "@/server/usecases/stages/generators";
import { msg } from "@/lib/messages";
import { roundRoleLabel } from "@/lib/round-role-label";

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

/** Plays every line of `bracket` in round order. A bye `award` is booked as the generator books it (a walkover with a
 *  winner and no loser); a conditional line (a grand final reset) is played only when `pick` names a winner, else voided. */
export function playBracket(stageKind: BracketStage["kind"], bracket: GeneratedBracket, pick: Pick): PlayedLine[] {
  const byId = new Map<string, BracketFixture>();
  const out: PlayedLine[] = [];
  const order = [...bracket.fixtures].sort((a, b) => a.round - b.round);
  const fed = (ref: BracketFixtureGen["homeFrom"]): string | undefined => {
    if (ref === undefined) return undefined;
    const src = byId.get(ref.fixtureId);
    if (src === undefined) throw new Error(`bracket-play: ${ref.fixtureId} is read before it is played`);
    return ref.side === "winner" ? src.winner : src.loser;
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
      const home = gen.home ?? fed(gen.homeFrom);
      const away = gen.away ?? fed(gen.awayFrom);
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
