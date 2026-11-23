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

interface Mutant {
  id: string;
  name: string;
  /** Part of the `says` of the claim this mutant must trip. */
  trips: string;
  mutate: (r: ExampleResult) => void;
}

const MUTANTS: Mutant[] = [
  // ---- swiss-pairing (columns: Round, Board, White, Black, Points before, Result) ----
  { id: "swiss-pairing", name: "board 1 of round 1 pairs seeds 4 and 5, not 1 and 4", trips: "round 1 pairs the top half against the bottom half", mutate: (r) => (rows(r)[0]![3] = "Eve") },
  { id: "swiss-pairing", name: "round 1 board 2 flips colours, so the higher seed has Black on none of the boards", trips: "round 1's colours alternate", mutate: (r) => { const row = rows(r)[1]!; [row[2], row[3]] = [row[3]!, row[2]!]; } },
  { id: "swiss-pairing", name: "Ana and Dev meet again in round 3", trips: "nobody plays the same opponent twice", mutate: (r) => { rows(r)[8]![2] = "Ana"; rows(r)[8]![3] = "Dev"; } },
  { id: "swiss-pairing", name: "Dev has White in all three rounds", trips: "every player's colours stay within the limits", mutate: (r) => { const row = rows(r)[3]!; [row[2], row[3]] = [row[3]!, row[2]!]; } },
  { id: "swiss-pairing", name: "a round-2 'points before' cell is wrong", trips: "the points each player takes into a round", mutate: (r) => (rows(r)[3]![4] = "1, 2") },
  { id: "swiss-pairing", name: "round 2 pairs Fay with Eve and Dev with Ana, three boards across scores where two are enough", trips: "each round from round 2 pairs as few players outside their own score", mutate: (r) => { rows(r)[3]!.splice(2, 3, "Fay", "Eve", "1, ½"); rows(r)[4]!.splice(2, 3, "Dev", "Ana", "1, 0"); } },
  { id: "swiss-pairing", name: "the sport count is not the registry's", trips: "the Swiss format is offered for every sport", mutate: (r) => (r.facts.sportCount = 10) },
  // ---- swiss-bye-rounds (columns: Round, Bye goes to, Points before the round, The bye earns) ----
  { id: "swiss-bye-rounds", name: "round 1's bye goes to seed 4", trips: "round 1's goes to the lowest seed", mutate: (r) => (rows(r)[0]![1] = "Dev") },
  { id: "swiss-bye-rounds", name: "Eve has the bye twice", trips: "nobody gets the bye twice", mutate: (r) => (rows(r)[3]![1] = "Eve") },
  { id: "swiss-bye-rounds", name: "round 3's bye goes to Ana, who is level on the lowest score but the higher seed", trips: "the lowest-scoring player who has not had one", mutate: (r) => (rows(r)[2]![1] = "Ana") },
  { id: "swiss-bye-rounds", name: "a bye earns half a point", trips: "a bye earns a full point", mutate: (r) => (rows(r)[1]![3] = "½") },
  { id: "swiss-bye-rounds", name: "Eve's score jumps by two between rounds", trips: "the scores before each round are the earlier rounds' points", mutate: (r) => (rows(r)[2]![2] = "Ana 1, Ben 1, Cy 1, Dev 2, Eve 3") },
  { id: "swiss-bye-rounds", name: "the post names the wrong players as level in round 2", trips: "the players the post names as level on the lowest score", mutate: (r) => (r.facts.r2Lowest = "Ben") },
  { id: "swiss-bye-rounds", name: "round 3 has no earlier holder level on the lowest score, so it cannot tell a repeat from a first bye", trips: "an earlier bye holder is level on the lowest score and a lower seed", mutate: (r) => (rows(r)[2]![2] = "Ana 1, Ben 1, Cy 2, Dev 2, Eve 2") },
  { id: "swiss-bye-rounds", name: "the post names Ana as round 3's holder", trips: "an earlier bye holder is level on the lowest score and a lower seed", mutate: (r) => (r.facts.r3Bye = "Ana") },
  // ---- swiss-late-and-withdraw (columns: Player, Round 1..4, Total) ----
  { id: "swiss-late-and-withdraw", name: "Ana's total is a point too high", trips: "every total is the sum of the player's rounds", mutate: (r) => (rows(r)[0]![5] = "4") },
  { id: "swiss-late-and-withdraw", name: "the late player has a game in round 1", trips: "a late player is in no round before their first", mutate: (r) => (rows(r)[6]![1] = "Drew with Ana") },
  { id: "swiss-late-and-withdraw", name: "the leaver's round 1 win is struck", trips: "a player who leaves keeps every result already played", mutate: (r) => { rows(r)[5]![1] = "Left"; rows(r)[5]![5] = "0"; } },
  { id: "swiss-late-and-withdraw", name: "the post names the wrong walkover winner", trips: "the board the leaver was already paired on is won by the opponent", mutate: (r) => (r.facts.walkoverWinner = "Ben") },
  { id: "swiss-late-and-withdraw", name: "a round-3 game is on one row and not the other", trips: "nobody meets the same opponent twice", mutate: (r) => (rows(r)[2]![3] = "Drew with Dev") },
  { id: "swiss-late-and-withdraw", name: "the sport count is not the registry's", trips: "the Swiss format is offered for every sport", mutate: (r) => (r.facts.sportCount = 10) },
  // ---- knockout-seeds (columns: First-round match, Top line, Bottom line) ----
  { id: "knockout-seeds", name: "a match is missing, so six players sit in a six-line bracket", trips: "the bracket has the smallest power of two lines", mutate: (r) => rows(r).pop() },
  { id: "knockout-seeds", name: "seed 6 holds a bye instead of seed 1", trips: "the byes go to the top seeds", mutate: (r) => (rows(r)[0]![1] = "Fay (seed 6)") },
  { id: "knockout-seeds", name: "seed 4 plays seed 6 and not seed 5", trips: "each first-round match pairs seed k with seed", mutate: (r) => (rows(r)[1]![2] = "Fay (seed 6)") },
  { id: "knockout-seeds", name: "seeds 1 and 2 sit in the same half", trips: "seeds 1 and 2 are in opposite halves", mutate: (r) => { const t = rows(r)[1]!.slice(1); rows(r)[1]!.splice(1, 2, ...rows(r)[3]!.slice(1)); rows(r)[3]!.splice(1, 2, ...t); } },
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
