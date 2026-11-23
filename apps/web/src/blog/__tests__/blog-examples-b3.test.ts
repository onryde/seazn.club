// Batch 3 (Swiss and seeding, blog-examples-b3): the claims of the five Swiss and seeding examples have teeth. Each mutant below corrupts one
// thing in a committed golden and must be caught by the claim that names that rule. A claim nothing fails is decoration
// (AGENTS.md class 3), and a mutant that no claim catches would show up here as a zero-kill failure.
//
// blog-examples.test.ts already proves every claim PASSES on the golden and that the golden regenerates; this file proves the
// claims can FAIL. Every sweep reports how many mutants it ran, and a sweep that ran none is a failure (TEST-STRATEGY).
import { describe, expect, it } from "vitest";
import { pairKey, pairRound } from "@seazn/engine/scheduling";
import { builtinModules } from "@seazn/engine/sports";
import { blogExample } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import { KNOCKOUT_FIXTURE, buildKnockoutSeeds } from "@/blog/examples/knockout-seeds";
import { SWISS_BYE_ROUNDS_FIXTURE, buildSwissByeRounds } from "@/blog/examples/swiss-bye";
import { floatRuleProblem, seededLabel, seedsIndistinguishable, type PairedRound, type Seeded } from "@/blog/examples/swiss-claims";
import { SWISS_LATE_FIXTURE, buildSwissLate } from "@/blog/examples/swiss-late-and-withdraw";
import { SWISS_PAIRING_FIXTURE, buildSwissPairing } from "@/blog/examples/swiss-pairing";
import { runSwiss } from "@/blog/examples/swiss-run";
import type { ExampleResult } from "@/blog/examples/types";
import { sportLabel } from "@/blog/labels";

const example = (id: string) => {
  const e = blogExample(id);
  if (!e) throw new Error(`no example '${id}'`);
  return e;
};
const golden = (id: string): ExampleResult => structuredClone(BLOG_GOLDENS[id]!);
/** The `says` of every claim of an example that the result fails. */
const failing = (id: string, r: ExampleResult): string[] => example(id).claims.filter((c) => c.check(r) !== true).map((c) => c.says);
const rows = (r: ExampleResult) => r.table!.rows;
/** The row of a result whose first cell starts with `name` (a player's seeded label, or a plain name). */
const rowOf = (r: ExampleResult, name: string) => {
  const hit = rows(r).find((row) => String(row[0]).startsWith(`${name} (`) || row[0] === name);
  if (hit === undefined) throw new Error(`no row for '${name}'`);
  return hit;
};
/** A player's table label under a fixture (name and seed), and the name of whoever holds a seed. */
const labelIn = (fixture: readonly Seeded[]) => (name: string) => seededLabel(name, fixture.find((p) => p.name === name)!.seed);
const nameAtSeed = (fixture: readonly Seeded[], seed: number) => fixture.find((p) => p.seed === seed)!.name;

interface Mutant {
  id: string;
  name: string;
  /** Part of the `says` of the claim this mutant must trip. */
  trips: string;
  mutate: (r: ExampleResult) => void;
}

const pl = labelIn(SWISS_PAIRING_FIXTURE);
const bl = labelIn(SWISS_BYE_ROUNDS_FIXTURE);
const kl = (name: string) => `${name} (seed ${KNOCKOUT_FIXTURE.find((p) => p.name === name)!.seed})`;
/** Makes `name` White in every round of the swiss-pairing table (a player who is Black swaps sides with their opponent). */
const alwaysWhite = (r: ExampleResult, name: string) => {
  for (const row of rows(r)) if (String(row[3]).startsWith(`${name} (`)) [row[2], row[3]] = [row[3]!, row[2]!];
};

const MUTANTS: Mutant[] = [
  // ---- swiss-pairing (columns: Round, Board, White, Black, Points before, Result; names carry their seed) ----
  { id: "swiss-pairing", name: "board 1 of round 1 pairs seeds 4 and 5, not 1 and 4", trips: "round 1 pairs the top half against the bottom half", mutate: (r) => (rows(r)[0]![3] = pl(nameAtSeed(SWISS_PAIRING_FIXTURE, 5))) },
  { id: "swiss-pairing", name: "round 1 board 2 flips colours, so the higher seed has Black on none of the boards", trips: "round 1's colours alternate", mutate: (r) => { const row = rows(r)[1]!; [row[2], row[3]] = [row[3]!, row[2]!]; } },
  { id: "swiss-pairing", name: "round 3 board 1 repeats round 1 board 1", trips: "nobody plays the same opponent twice", mutate: (r) => { rows(r)[6]![2] = rows(r)[0]![2]!; rows(r)[6]![3] = rows(r)[0]![3]!; } },
  { id: "swiss-pairing", name: "the seed-2 player has White in all three rounds", trips: "every player's colours stay within the limits", mutate: (r) => alwaysWhite(r, nameAtSeed(SWISS_PAIRING_FIXTURE, 2)) },
  { id: "swiss-pairing", name: "a round-2 'points before' cell is wrong", trips: "the points each player takes into a round", mutate: (r) => (rows(r)[3]![4] = "1, 2") },
  {
    // The mutant keeps the round's count of boards that pair different scores (two) and breaks the rule "from the top": both
    // leaders float, where the leaders could have met. The old "fewest mixed boards" claim could not see this.
    id: "swiss-pairing",
    name: "round 2 floats both leaders into the half-point group instead of pairing them, with the same number of mixed boards",
    trips: "each round from round 2 floats as few players out of each score group",
    mutate: (r) => {
      const [ana, eve, dev, fay, cy, ben] = ["Ana", "Eve", "Dev", "Fay", "Cy", "Ben"].map((x) => pl(x));
      rows(r)[3]!.splice(2, 4, eve!, dev!, "1, ½", "1 — 0");
      rows(r)[4]!.splice(2, 4, ana!, fay!, "1, ½", "1 — 0");
      rows(r)[5]!.splice(2, 4, cy!, ben!, "0, 0", "1 — 0");
    },
  },
  { id: "swiss-pairing", name: "the post names the wrong pair as level at the top", trips: "the post's round-2 sentence is true", mutate: (r) => (r.facts.r2TopPair = "Ana and Cy") },
  { id: "swiss-pairing", name: "the post gives the leaders the wrong score", trips: "the post's round-2 sentence is true", mutate: (r) => (r.facts.r2TopScore = "½") },
  { id: "swiss-pairing", name: "the post names the wrong pair as the drawn one", trips: "the post's drawn pair are the only players", mutate: (r) => (r.facts.r1DrawPair = "Ana and Ben") },
  { id: "swiss-pairing", name: "the post gives the drawn pair the wrong score", trips: "the post's drawn pair are the only players", mutate: (r) => (r.facts.r1DrawScore = "1") },
  { id: "swiss-pairing", name: "the post says seven players", trips: "rounds and boards are numbered in order", mutate: (r) => (r.facts.playerCount = 7) },
  { id: "swiss-pairing", name: "a seed printed beside a name is not the fixture's", trips: "the seed printed beside each name", mutate: (r) => (rows(r)[0]![2] = "Eve (1)") },
  { id: "swiss-pairing", name: "the diagram draws another player on board 1", trips: "the diagram draws the table's own round", mutate: (r) => { if (r.diagram?.kind === "swissRound") r.diagram.pairings[0]!.first = pl("Dev"); } },
  { id: "swiss-pairing", name: "the diagram marks a level board as a float", trips: "the diagram draws the table's own round", mutate: (r) => { if (r.diagram?.kind === "swissRound") r.diagram.pairings[0]!.float = true; } },
  { id: "swiss-pairing", name: "the caption counts seven players", trips: "the caption's counts are the post's", mutate: (r) => (r.table!.caption = r.table!.caption.replace("Six", "Seven")) },
  { id: "swiss-pairing", name: "the sport count is not the registry's", trips: "the Swiss format is offered for every sport", mutate: (r) => (r.facts.sportCount = 10) },
  // ---- swiss-bye-rounds (columns: Round, Bye goes to, Boards, Points before the round, The bye earns) ----
  { id: "swiss-bye-rounds", name: "round 1's bye goes to seed 4", trips: "round 1's goes to the lowest seed", mutate: (r) => (rows(r)[0]![1] = bl(nameAtSeed(SWISS_BYE_ROUNDS_FIXTURE, 4))) },
  { id: "swiss-bye-rounds", name: "round 4's bye goes to round 1's holder again", trips: "nobody gets the bye twice", mutate: (r) => (rows(r)[3]![1] = rows(r)[0]![1]!) },
  { id: "swiss-bye-rounds", name: "round 3's bye goes to seed 1, level on the lowest score but the higher seed", trips: "the lowest-scoring player who has not had one", mutate: (r) => (rows(r)[2]![1] = bl(nameAtSeed(SWISS_BYE_ROUNDS_FIXTURE, 1))) },
  { id: "swiss-bye-rounds", name: "a bye earns half a point", trips: "a bye earns a full point", mutate: (r) => (rows(r)[1]![4] = "½") },
  { id: "swiss-bye-rounds", name: "a player's score jumps by two between rounds", trips: "the scores before each round are the earlier rounds' points", mutate: (r) => (rows(r)[2]![3] = String(rows(r)[2]![3]).replace(/Ana 1$/, "Ana 3")) },
  { id: "swiss-bye-rounds", name: "the post names the wrong players as level in round 2", trips: "the players the post names as level on the lowest score", mutate: (r) => (r.facts.r2Lowest = "Ben") },
  { id: "swiss-bye-rounds", name: "round 3 has no earlier holder level on the lowest score, so it cannot tell a repeat from a first bye", trips: "an earlier bye holder is level on the lowest score and a lower seed", mutate: (r) => (rows(r)[2]![3] = "Eve 1, Dev 1, Ben 2, Cy 2, Ana 2") },
  { id: "swiss-bye-rounds", name: "the post names round 1's holder as round 3's", trips: "an earlier bye holder is level on the lowest score and a lower seed", mutate: (r) => (r.facts.r3Bye = r.facts.r1Bye!) },
  { id: "swiss-bye-rounds", name: "the post names the wrong round-1 holder", trips: "the post's named holders and counts are the table's", mutate: (r) => (r.facts.r1Bye = "Eve") },
  { id: "swiss-bye-rounds", name: "the post names the wrong round-2 holder", trips: "the post's named holders and counts are the table's", mutate: (r) => (r.facts.r2Bye = "Cy") },
  { id: "swiss-bye-rounds", name: "the post gives round 1's holder the wrong seed", trips: "the post's named holders and counts are the table's", mutate: (r) => (r.facts.r1ByeSeed = 4) },
  { id: "swiss-bye-rounds", name: "the post says the cap is 1", trips: "a bye's stand-in opponent in the Buchholz", mutate: (r) => (r.facts.byeBuchholzCap = "1") },
  { id: "swiss-bye-rounds", name: "a round pairs two players who already met", trips: "nobody meets the same opponent twice", mutate: (r) => (rows(r)[2]![2] = "Eve v Ben, Ana v Cy") },
  { id: "swiss-bye-rounds", name: "a bye holder's printed seed is wrong", trips: "the seed printed beside each bye holder", mutate: (r) => (rows(r)[0]![1] = "Ana (1)") },
  { id: "swiss-bye-rounds", name: "the points are not listed best seed first", trips: "the points are listed best seed first", mutate: (r) => (rows(r)[1]![3] = "Ana 1, Ben 0, Cy 1, Dev 0, Eve 1") },
  { id: "swiss-bye-rounds", name: "the diagram's bye is another player", trips: "the diagram draws the table's own round", mutate: (r) => { if (r.diagram?.kind === "swissRound") r.diagram.byes = [bl("Eve")]; } },
  { id: "swiss-bye-rounds", name: "the caption counts six players", trips: "the caption's counts are the post's", mutate: (r) => (r.table!.caption = r.table!.caption.replace("Five", "Six")) },
  // ---- swiss-late-and-withdraw (columns: Player, Round 1..4, Total; rows best seed first) ----
  { id: "swiss-late-and-withdraw", name: "a total is a point too high", trips: "every total is the sum of the player's rounds", mutate: (r) => { const row = rowOf(r, "Ana"); row[5] = "2½"; } },
  { id: "swiss-late-and-withdraw", name: "the late player has a game in round 1", trips: "a late player is in no round before their first", mutate: (r) => (rowOf(r, "Gil")[1] = "Drew with Ana") },
  { id: "swiss-late-and-withdraw", name: "the leaver's round 1 win is struck", trips: "a player who leaves keeps every result already played", mutate: (r) => { const row = rowOf(r, "Fay"); row[1] = "Left"; row[5] = "0"; } },
  { id: "swiss-late-and-withdraw", name: "the post names the wrong walkover winner", trips: "the board the leaver was already paired on is won by the opponent", mutate: (r) => (r.facts.walkoverWinner = "Ben") },
  { id: "swiss-late-and-withdraw", name: "a round-3 game is on one row and not the other", trips: "nobody meets the same opponent twice", mutate: (r) => (rowOf(r, "Dev")[3] = "Drew with Ana") },
  { id: "swiss-late-and-withdraw", name: "the post gives the leaver the wrong total", trips: "the post's facts are the grid's", mutate: (r) => (r.facts.leaverTotal = "2") },
  { id: "swiss-late-and-withdraw", name: "the post gives the wrong field after the leaver goes", trips: "the post's facts are the grid's", mutate: (r) => (r.facts.fieldAfterLeaving = 7) },
  { id: "swiss-late-and-withdraw", name: "the post gives the wrong number of players still in", trips: "the post's facts are the grid's", mutate: (r) => (r.facts.regularsAfterLeaving = 6) },
  { id: "swiss-late-and-withdraw", name: "the post gives the late player the wrong total", trips: "the post's facts are the grid's", mutate: (r) => (r.facts.lateTotal = "2") },
  {
    // The three-board round where the late player joins and the leaver is gone. Round 3 here pairs 2 + 1 + 1 players across scores,
    // and an arrangement with only two mixed boards exists (the old "fewest mixed boards" rule would have demanded it).
    id: "swiss-late-and-withdraw",
    name: "round 3 pairs the arrangement with the fewest mixed boards, which the top-down rule does not allow",
    trips: "each round from round 2 floats as few players out of each score group",
    mutate: (r) => {
      const [cy, eve, dev, ana, ben, gil] = ["Cy", "Eve", "Dev", "Ana", "Ben", "Gil"].map((x) => rowOf(r, x));
      cy![3] = "Beat Ana";
      ana![3] = "Lost to Cy";
      eve![3] = "Beat Dev";
      dev![3] = "Lost to Eve";
      ben![3] = "Beat Gil";
      gil![3] = "Lost to Ben";
    },
  },
  { id: "swiss-late-and-withdraw", name: "a seed printed beside a player is not the fixture's", trips: "the seed printed beside each player", mutate: (r) => (rowOf(r, "Gil")[0] = "Gil (1)") },
  { id: "swiss-late-and-withdraw", name: "the diagram leaves out another player", trips: "the diagram draws the grid's own round", mutate: (r) => { if (r.diagram?.kind === "swissRound") r.diagram.notSeated = [{ name: "Eve (2)", why: "left" }]; } },
  { id: "swiss-late-and-withdraw", name: "the caption says the leaver goes after round 3", trips: "the caption's counts and names are the post's", mutate: (r) => (r.table!.caption = r.table!.caption.replace("once round 2", "once round 3")) },
  { id: "swiss-late-and-withdraw", name: "the sport count is not the registry's", trips: "the Swiss format is offered for every sport", mutate: (r) => (r.facts.sportCount = 10) },
  // ---- knockout-seeds (columns: First-round match, Top line, Bottom line) ----
  { id: "knockout-seeds", name: "a match is missing, so six players sit in a six-line bracket", trips: "the bracket has the smallest power of two lines", mutate: (r) => rows(r).pop() },
  { id: "knockout-seeds", name: "seed 6 holds a bye instead of seed 1", trips: "the byes go to the top seeds", mutate: (r) => (rows(r)[0]![1] = kl(nameAtSeed(KNOCKOUT_FIXTURE, 6))) },
  { id: "knockout-seeds", name: "seed 5 plays seed 6 and not seed 4", trips: "each first-round match pairs seed k with seed", mutate: (r) => (rows(r)[1]![2] = kl(nameAtSeed(KNOCKOUT_FIXTURE, 6))) },
  { id: "knockout-seeds", name: "seeds 1 and 2 sit in the same half", trips: "seeds 1 and 2 are in opposite halves", mutate: (r) => { const t = rows(r)[1]!.slice(1); rows(r)[1]!.splice(1, 2, ...rows(r)[3]!.slice(1)); rows(r)[3]!.splice(1, 2, ...t); } },
  { id: "knockout-seeds", name: "a match's two sides are printed the wrong way round", trips: "each match sits on the two lines the engine's seed order gives it", mutate: (r) => { const row = rows(r)[3]!; [row[1], row[2]] = [row[2]!, row[1]!]; } },
  { id: "knockout-seeds", name: "the post names the wrong bye holders", trips: "the post names the bye holders", mutate: (r) => (r.facts.byeHolders = "Fay and Ben") },
  { id: "knockout-seeds", name: "a seed printed beside a name is not the fixture's", trips: "the seed printed beside each name", mutate: (r) => (rows(r)[0]![1] = "Fay (seed 2)") },
  { id: "knockout-seeds", name: "the post says seven players", trips: "the bracket has the smallest power of two lines", mutate: (r) => (r.facts.fieldSize = 7) },
  { id: "knockout-seeds", name: "the caption says four lines", trips: "the caption's counts are the post's", mutate: (r) => (r.table!.caption = r.table!.caption.replace("eight lines", "four lines")) },
  { id: "knockout-seeds", name: "the printed 16-line order swaps seeds 1 and 2", trips: "the 16-line order the post prints", mutate: (r) => (r.facts.lineOrder16 = "2, 16, 9, 8, 5, 12, 13, 4, 3, 14, 11, 6, 7, 10, 15, 1") },
  { id: "knockout-seeds", name: "the printed 16-line order puts a seed in two places", trips: "the 16-line order the post prints", mutate: (r) => (r.facts.lineOrder16 = "1, 16, 9, 8, 5, 12, 13, 4, 3, 14, 11, 6, 7, 10, 15, 15") },
  { id: "knockout-seeds", name: "the sport count is not the registry's", trips: "the knockout format is offered for every sport", mutate: (r) => (r.facts.sportCount = 10) },
];

describe("batch 3 claims have teeth: each mutant is caught by the claim that names its rule", () => {
  it("every example passes untouched, so a mutant's failure is the mutant's", () => {
    let checked = 0;
    for (const id of new Set(MUTANTS.map((m) => m.id))) {
      expect(failing(id, golden(id)), `${id}: the unmutated golden`).toEqual([]);
      checked++;
    }
    expect(checked, "examples checked").toBe(4); // the four examples with a grid; swiss-bye is swept per sport below
  });

  it("every mutant trips the claim that names its rule", () => {
    let killed = 0;
    for (const m of MUTANTS) {
      const r = golden(m.id);
      m.mutate(r);
      const failed = failing(m.id, r);
      expect(failed.some((says) => says.includes(m.trips)), `${m.id}: '${m.name}' should trip '${m.trips}', tripped: ${JSON.stringify(failed)}`).toBe(true);
      killed++;
    }
    expect(killed, "mutants run").toBe(MUTANTS.length);
    expect(killed).toBeGreaterThanOrEqual(25);
  });

  it("swiss-bye: corrupting either value cell of any sport's rows trips that sport's claims, and no other sport's", () => {
    const e = example("swiss-bye");
    const base = golden("swiss-bye");
    expect(failing("swiss-bye", base), "the unmutated golden").toEqual([]);
    const rowsOf = (r: ExampleResult, key: string) => rows(r).filter((row) => row[0] === sportLabel(key) || String(row[0]).startsWith(`${sportLabel(key)} (`));
    let mutants = 0;
    let variantRows = 0;
    for (const m of builtinModules) {
      const count = rowsOf(base, m.key).length;
      expect(count, `${m.key}: rows`).toBeGreaterThan(0);
      if (count > 1) variantRows += count - 1;
      for (let i = 0; i < count; i++)
        for (const col of [1, 2]) {
          const mutant = structuredClone(base);
          const row = rowsOf(mutant, m.key)[i]!;
          row[col] = `${String(row[col])}9`;
          expect(e.claims.filter((c) => c.sport === m.key && c.check(mutant) !== true).length, `${m.key} row ${i} column ${col}`).toBeGreaterThan(0);
          expect(e.claims.filter((c) => c.sport !== undefined && c.sport !== m.key && c.check(mutant) !== true).length, `${m.key}: a neighbour's claim fired`).toBe(0);
          mutants++;
        }
      // A variant row that is not there is caught by the sport's "own row exactly when" claim.
      if (count > 1) {
        const dropped = structuredClone(base);
        const gone = rowsOf(dropped, m.key)[count - 1]!;
        dropped.table!.rows = rows(dropped).filter((r) => r !== gone);
        expect(e.claims.filter((c) => c.sport === m.key && c.check(dropped) !== true).length, `${m.key}: a variant row removed`).toBeGreaterThan(0);
        mutants++;
      }
    }
    // The table is one row per sport plus one per variant whose bye is worth something else: the extras are what it swept.
    expect(variantRows, "variant rows swept").toBe(rows(base).length - builtinModules.length);
    expect(variantRows, "variant rows swept").toBeGreaterThanOrEqual(2);
    expect(mutants, "mutants run").toBeGreaterThan(builtinModules.length * 2);
  });

  it("swiss-bye: the sport-wide claims trip too: a sport missing from the table, a wrong indoor volleyball bye, a wrong sport count", () => {
    const e = example("swiss-bye");
    const dropped = golden("swiss-bye");
    dropped.table!.rows = rows(dropped).filter((row) => !String(row[0]).startsWith(sportLabel("tennis")));
    expect(e.claims.filter((c) => c.sport === undefined && c.check(dropped) !== true).map((c) => c.says).join("|")).toContain("every sport of the registry");
    const volleyball = golden("swiss-bye");
    volleyball.facts.volleyballIndoorBye = "2";
    expect(e.claims.filter((c) => c.check(volleyball) !== true).map((c) => c.says).join("|")).toContain("indoor volleyball's bye earns the 3-0 win's points");
    const count = golden("swiss-bye");
    count.facts.sportCount = 10;
    expect(e.claims.filter((c) => c.check(count) !== true).map((c) => c.says).join("|")).toContain("the Swiss format is offered for every sport");
  });
});

// The post says the bye goes to the lowest-placed player who has not had one "as long as everyone else can still be paired".
// That is FIDE C.04.3's completion criterion [C4] (the rest of the field must be pairable) ahead of the lowest-score
// preference. The oracle below is the rule itself, brute force: the first candidate from the bottom whose removal leaves a
// rematch-free pairing of everyone else. It never calls the engine.
describe("the bye goes to the lowest player whose sitting out leaves the others pairable", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const standings = ids.map((entrantId, i) => ({ entrantId, score: 0, rank: i + 1 }));
  const pairable = (rest: string[], met: Set<string>): boolean => {
    if (rest.length === 0) return true;
    const [first, ...others] = rest as [string, ...string[]];
    return others.some((o) => !met.has(pairKey(first, o)) && pairable(others.filter((x) => x !== o), met));
  };
  const oracle = (met: Set<string>, had: Set<string>): string | undefined =>
    [...ids].reverse().filter((c) => !had.has(c)).find((c) => pairable(ids.filter((x) => x !== c), met));

  it("matches the rule over histories where the lowest player can and cannot sit out", () => {
    const histories: { name: string; played: [string, string][]; byes: string[]; expected: string }[] = [
      { name: "nobody has met: the lowest sits out", played: [], byes: [], expected: "e" },
      { name: "a has met b, c and d: e sitting out would strand a, so d does", played: [["a", "b"], ["a", "c"], ["a", "d"]], byes: [], expected: "d" },
      { name: "e has had a bye already: d is next", played: [], byes: ["e"], expected: "d" },
    ];
    let checked = 0;
    for (const h of histories) {
      const met = new Set(h.played.map(([x, y]) => pairKey(x, y)));
      const had = new Set(h.byes);
      expect(oracle(met, had), `${h.name}: the rule`).toBe(h.expected);
      const result = pairRound(standings, { played: met, colours: new Map(), byes: had }, { chess: false });
      if (!result.ok) throw new Error(`${h.name}: refused (${result.reason})`);
      expect(result.bye, h.name).toBe(h.expected);
      for (const p of result.pairings) expect(met.has(pairKey(p.home, p.away)), `${h.name}: ${p.home} v ${p.away} is a rematch`).toBe(false);
      checked++;
    }
    expect(checked, "histories checked").toBe(histories.length);
    // The second history is the one with teeth: the lowest player is NOT the answer, so "always the lowest" would fail it.
    expect(histories[1]!.expected).not.toBe(ids[ids.length - 1]);
  });
});

// ---- the fixtures: seeds that tell a pairing that reads the seed from one that reads the list or the names ----
//
// An engine pairing that ignored `rank` survived all 34 tests of the first version, because every player's seed was their
// place in the list, in the alphabet and in their id. Each fixture is in sign-up order with seeds that are none of those.

const FIXTURES: { id: string; fixture: readonly Seeded[]; build: (f: readonly Seeded[]) => ExampleResult }[] = [
  { id: "swiss-pairing", fixture: SWISS_PAIRING_FIXTURE, build: buildSwissPairing },
  { id: "swiss-bye-rounds", fixture: SWISS_BYE_ROUNDS_FIXTURE, build: buildSwissByeRounds },
  { id: "swiss-late-and-withdraw", fixture: SWISS_LATE_FIXTURE, build: buildSwissLate },
  { id: "knockout-seeds", fixture: KNOCKOUT_FIXTURE, build: buildKnockoutSeeds },
];

/** The table with every seed taken out of the labels, so two builds on other seeds are compared on who meets whom. */
const withoutSeeds = (r: ExampleResult) => JSON.stringify(rows(r).map((row) => row.map((c) => String(c).replace(/ \((seed )?\d+\)/g, ""))));

describe("the fixtures' seeds are neither the sign-up order nor the alphabet's, and the examples move with them", () => {
  it("every fixture passes the check, and the check fails each way a fixture can be blind", () => {
    let checked = 0;
    for (const f of FIXTURES) {
      expect(seedsIndistinguishable(f.fixture), `${f.id}: its seeds`).toBeNull();
      checked++;
    }
    expect(checked, "fixtures checked").toBe(FIXTURES.length);
    const names = ["Cy", "Ana", "Ben"];
    const listOrder = names.map((name, i) => ({ name, seed: i + 1 }));
    expect(seedsIndistinguishable(listOrder), "seeds in sign-up order").toContain("place in the sign-up list");
    const alphabet = [...names].sort().map((name, i) => ({ name, seed: i + 1 })).reverse();
    expect(seedsIndistinguishable(alphabet), "seeds in alphabetical order").toContain("place in the alphabet");
    expect(seedsIndistinguishable([{ name: "Cy", seed: 2 }, { name: "Ana", seed: 2 }]), "a repeated seed").toContain("not 1..2 once each");
    expect(seedsIndistinguishable([]), "an empty fixture").toContain("empty");
  });

  it("building each example on seeds taken from the sign-up order, or from the alphabet, changes who meets whom", () => {
    let differed = 0;
    for (const f of FIXTURES) {
      const base = withoutSeeds(f.build(f.fixture));
      const alphabet = [...f.fixture].map((p) => p.name).sort();
      const alt: [string, Seeded[]][] = [
        ["the sign-up order", f.fixture.map((p, i) => ({ name: p.name, seed: i + 1 }))],
        ["the alphabet", f.fixture.map((p) => ({ name: p.name, seed: alphabet.indexOf(p.name) + 1 }))],
      ];
      for (const [what, fixture] of alt) {
        expect(withoutSeeds(f.build(fixture)), `${f.id}: seeds taken from ${what} must not give the same table`).not.toBe(base);
        differed++;
      }
    }
    expect(differed, "builds compared").toBe(FIXTURES.length * 2);
  });

  it("the committed goldens are what the fixtures build (the engine's own pairing, not a copy)", () => {
    let matched = 0;
    for (const f of FIXTURES) {
      expect(JSON.parse(JSON.stringify(f.build(f.fixture))), f.id).toEqual(BLOG_GOLDENS[f.id]);
      matched++;
    }
    expect(matched).toBe(FIXTURES.length);
  });
});

// ---- the float rule: from the top, not over the whole round ----

describe("the float oracle takes the score groups from the top and refuses a rematch", () => {
  const ids = (names: string) => names.split(" ");
  /** The late-and-withdraw example's third round, with the scores and the history it was paired from (the post's inputs). */
  const history = (): PairedRound[] => [
    { round: 1, score: new Map(ids("fay ben eve ana dev cy").map((p) => [p, 0])), pairs: [["fay", "ben"], ["eve", "ana"], ["dev", "cy"]], bye: null },
    { round: 2, score: new Map([["fay", 1], ["cy", 1], ["eve", 0.5], ["ana", 0.5], ["dev", 0], ["ben", 0]]), pairs: [["fay", "cy"], ["eve", "ben"], ["dev", "ana"]], bye: null },
  ];
  const score3 = new Map([["cy", 2], ["eve", 1.5], ["dev", 1], ["ana", 0.5], ["ben", 0], ["gil", 0]]);
  const topDown: [string, string][] = [["cy", "eve"], ["ana", "gil"], ["ben", "dev"]];
  const fewestMixed: [string, string][] = [["cy", "ana"], ["eve", "dev"], ["ben", "gil"]];
  const mixed = (pairs: [string, string][]) => pairs.filter(([a, b]) => score3.get(a) !== score3.get(b)).length;

  it("accepts the top-down pairing of that round, which has MORE mixed boards than another legal one", () => {
    expect(mixed(topDown), "mixed boards, top-down").toBe(3);
    expect(mixed(fewestMixed), "mixed boards, fewest over the round").toBe(2);
    const result = floatRuleProblem([...history(), { round: 3, score: score3, pairs: topDown, bye: null }]);
    expect(result.problem).toBeNull();
    expect(result.checked, "rounds compared").toBe(2);
  });

  it("refuses the arrangement with the fewest mixed boards, because it floats the leader and the next group too", () => {
    const result = floatRuleProblem([...history(), { round: 3, score: score3, pairs: fewestMixed, bye: null }]);
    expect(result.problem).toContain("round 3");
    expect(result.problem).toContain("the fewest possible are");
  });

  it("refuses a pairing that meets someone for the second time, and a round that seats the wrong players", () => {
    const rematch = floatRuleProblem([...history(), { round: 3, score: score3, pairs: [["cy", "fay"], ["eve", "gil"], ["ana", "ben"]], bye: null }]);
    expect(rematch.problem).not.toBeNull();
    const wrongField = floatRuleProblem([...history(), { round: 3, score: score3, pairs: [["cy", "eve"], ["ana", "gil"]], bye: null }]);
    expect(wrongField.problem).toContain("the boards seat");
  });

  it("the three Swiss goldens each have a round the oracle compared, and the late one is a round where the two rules disagree", () => {
    let compared = 0;
    for (const id of ["swiss-pairing", "swiss-bye-rounds", "swiss-late-and-withdraw"]) {
      const claim = example(id).claims.find((c) => c.says.includes("floats as few players out of each score group"));
      expect(claim, `${id}: the float claim`).toBeDefined();
      expect(claim!.check(golden(id)), id).toBe(true);
      compared++;
    }
    expect(compared).toBe(3);
    const late = golden("swiss-late-and-withdraw");
    const r3 = (name: string) => String(rowOf(late, name)[3]);
    // Round 3 of the committed grid is the round of the unit case above: Cy v Eve, Ana v Gil, Ben v Dev.
    expect(r3("Cy")).toBe("Lost to Eve");
    expect(r3("Ana")).toBe("Beat Gil");
    expect(r3("Ben")).toBe("Drew with Dev");
  });
});

// ---- every printed fact, cell and diagram label is read by some claim ----
//
// The first version printed 11 facts (who sits out, who is level, how many are left) that no claim read: corrupting one left
// every claim green. Each value of each example is corrupted in turn; a value no claim notices is listed below with the reason,
// and a listed value that a claim now notices fails the test (the list cannot go stale).

/** Values nothing checks, each with the reason it is copy and not a fact. `<example id> <path>`. */
const UNCHECKED: Record<string, string> = {
  "swiss-bye table.caption": "one sentence with no number or name in it ('what a Swiss bye is worth in each sport'); every cell under it is claimed",
  "swiss-late-and-withdraw diagram.notSeated.0.why": "the sentence beside the checked name of the player the round leaves out (the name itself is claimed)",
};

function corrupt(v: unknown): unknown {
  if (typeof v === "number") return v + 1;
  if (typeof v === "boolean") return !v;
  // Reversed behind a `~`: a longer phrase no longer contains what a claim looks for, and a short cell ("1", "½") still changes.
  return `~${[...String(v)].reverse().join("")}`;
}

/** Every leaf path of a value, as [path, value] pairs; arrays by index. */
function leaves(v: unknown, path: string[] = []): [string[], unknown][] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, String(i)]));
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, [...path, k]));
  return [[path, v]];
}
function setAt(root: unknown, path: string[], value: unknown): void {
  let at = root as Record<string, unknown>;
  for (const k of path.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[path[path.length - 1]!] = value;
}

describe("a corrupted fact, cell or diagram label is caught by some claim", () => {
  const SWEPT = ["swiss-pairing", "swiss-bye", "swiss-bye-rounds", "swiss-late-and-withdraw", "knockout-seeds"];

  it("sweeps every value of every example, and the unchecked list is exactly the values nothing reads", () => {
    const survivors: string[] = [];
    let swept = 0;
    const perKind = { facts: 0, table: 0, diagram: 0 };
    for (const id of SWEPT) {
      const base = golden(id);
      expect(failing(id, base), `${id}: the unmutated golden`).toEqual([]);
      // `text` is never rendered (types.ts): the leak sweep reads it, nothing a reader sees depends on it.
      const parts = { facts: base.facts, table: base.table, diagram: base.diagram };
      for (const [part, value] of Object.entries(parts)) {
        for (const [path, v] of leaves(value)) {
          // The diagram's `kind` names the drawing component; the type union fixes its values.
          if (part === "diagram" && path[0] === "kind") continue;
          const mutant = golden(id);
          setAt(mutant as unknown as Record<string, unknown>, [part, ...path], corrupt(v));
          swept++;
          perKind[part as keyof typeof perKind]++;
          if (failing(id, mutant).length === 0) survivors.push(`${id} ${part}.${path.join(".")}`);
        }
      }
    }
    expect(swept, "values swept").toBeGreaterThan(250);
    expect(perKind.facts, "facts swept").toBeGreaterThan(40);
    expect(perKind.table, "table cells swept").toBeGreaterThan(150);
    expect(perKind.diagram, "diagram values swept").toBeGreaterThan(30);
    expect(survivors.sort(), "values no claim reads (each needs a claim, or a reason in UNCHECKED)").toEqual(Object.keys(UNCHECKED).sort());
  });
});

// ---- a player who wins a board without playing cannot take a later bye ----

describe("a walkover win bars the bye later, through the app's history and the engine's pairing", () => {
  it("round 3 of a Swiss where the leaver's opponent would otherwise take the bye gives it to the next player", () => {
    const ents = ["p1", "p2", "p3", "p4", "p5", "p6"].map((id, i) => ({ id, name: id.toUpperCase(), seed: i + 1 }));
    // The fixture: the player named first wins every board; p6 leaves once round 1 is paired, so p3 wins that board without playing.
    const run = runSwiss({ stageId: "blog-example:walkover-then-bye", sportKey: "boardgame", rounds: 3, entrants: ents, result: () => "home", withdrawnAfterPairing: { entrant: "p6", round: 1 } });
    const walked = run.rounds[0]!.boards.find((b) => b.walkoverTo !== undefined);
    expect(walked, "round 1 has a walked-over board").toBeDefined();
    const winner = walked!.walkoverTo!;
    const [two, three] = [run.rounds[1]!, run.rounds[2]!];
    expect(three.field.length % 2, "round 3 has an odd field, so one player sits out").toBe(1);
    // The rule, from FIDE C.04.3: the bye goes to the lowest score among those who have not had one, the lowest seed among those level.
    const had = new Set([two.bye!.entrant]);
    const eligible = three.field.filter((id) => !had.has(id));
    const low = Math.min(...eligible.map((id) => two.after.get(id) ?? 0));
    const unbarred = eligible.filter((id) => (two.after.get(id) ?? 0) === low).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0]!;
    expect(unbarred, "but for the bar, the walkover winner is the one the rule would pick").toBe(winner);
    expect(three.bye!.entrant, "the bye goes to the next player").not.toBe(winner);
    // The control: the same round, paired by the engine from the same history with the winner NOT barred, gives the bye to the winner.
    expect(three.paired.history.byes?.has(winner), "the app's history bars the winner").toBe(true);
    const unbarredHistory = { ...three.paired.history, byes: new Set([...(three.paired.history.byes ?? [])].filter((x) => x !== winner)) };
    const control = pairRound(three.paired.standings, unbarredHistory, { chess: true });
    expect(control.ok && control.bye, "the same round without the bar").toBe(winner);
  });
});
