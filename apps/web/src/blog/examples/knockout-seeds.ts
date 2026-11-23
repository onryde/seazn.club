// Post #16, "How are seeds placed in a knockout bracket, and who gets the byes?". Six seeded players are drawn into a
// knockout by the app's own generator (`generate("knockout", …)`, the one Generate calls, which hands the engine's
// `generateSingleElim` the field and its seeds), and the line order of a 16-line bracket is read from the engine's
// `seedPositions`. The fixture is only the names and their seeds, in sign-up order, with seeds that are neither that order nor
// the alphabet's (swiss-claims.ts seedsIndistinguishable); the lines, the byes and the first-round matches come out of the
// generator, and each match is printed on the lines the engine's seed order gives it.
//
// Every sport: the knockout draw reads no sport (the generator takes the field, its seeds and the stage's options, never
// the sport), and the example-wide claim sweeps the registry for the knockout format being offered to each. Only a wholly
// seeded field is drawn here: an unseeded entrant is placed by a draw (a root knockout) or in sign-up order (double
// elimination, stepladder, page playoff), which the post says in words.
import { seedPositions } from "@seazn/engine/scheduling";
import { forEachSport } from "@seazn/engine/testkit";
import { generate } from "@/server/usecases/stages/generators";
import { BYE_CELL, capitalised, captionClaim, col, guarded, numberWord, offeredInEverySportClaim, seedReader, type Seeded } from "./swiss-claims";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const KNOCKOUT_SEEDS_ID = "knockout-seeds";

/** The fixture: the players in sign-up order, each with the seed the organiser gave. */
export const KNOCKOUT_FIXTURE: readonly Seeded[] = [
  { name: "Cy", seed: 4 },
  { name: "Fay", seed: 1 },
  { name: "Ben", seed: 5 },
  { name: "Ana", seed: 2 },
  { name: "Dev", seed: 6 },
  { name: "Eve", seed: 3 },
];
const seedOf = seedReader(KNOCKOUT_FIXTURE);
const BYE = BYE_CELL;
const COLUMNS = ["First-round match", "Top line", "Bottom line"];
const LARGE = 16;

/** `fixture` is a parameter so a test can build the same example on other seeds and see the table move. */
export function buildKnockoutSeeds(fixture: readonly Seeded[] = KNOCKOUT_FIXTURE): ExampleResult {
  const seed = seedReader(fixture);
  const nameOf = (id: string) => {
    const hit = fixture.find((p) => p.name.toLowerCase() === id);
    if (hit === undefined) throw new Error(`knockout-seeds: the draw placed '${id}', who is not in the field`);
    return hit.name;
  };
  const label = (id: string | null | undefined) => (id === null || id === undefined ? BYE : `${nameOf(id)} (seed ${seed(nameOf(id))})`);
  const field = fixture.map((p) => ({ id: p.name.toLowerCase(), seed: p.seed, swiss_first_round: null }));
  const fixtures = generate("knockout", {}, field, new Map());
  const first = fixtures.filter((f) => f.roundNo === 1).sort((a, b) => a.seqInRound - b.seqInRound);
  const lines = first.length * 2;
  // The engine's own seed order: the seed on each line of the bracket. A seed past the field is an empty line (a bye).
  const order = seedPositions(lines);
  const rows = first.map((f, i) => {
    const placed: (string | null)[] = [null, null];
    for (const id of [f.home, f.away]) {
      if (id === null || id === undefined) continue;
      const slot = order.indexOf(seed(nameOf(id))) - 2 * i;
      if (slot !== 0 && slot !== 1) throw new Error(`knockout-seeds: the draw seats ${nameOf(id)} in match ${i + 1}, whose lines hold seeds ${order[2 * i]} and ${order[2 * i + 1]}`);
      placed[slot] = id;
    }
    return [i + 1, label(placed[0]), label(placed[1])];
  });
  const byeHolders = first
    .filter((f) => f.away === null || f.home === null)
    .map((f) => nameOf((f.home ?? f.away)!))
    .sort((a, b) => seed(a) - seed(b));
  const facts = {
    fieldSize: fixture.length,
    bracketSize: lines,
    byeCount: lines - fixture.length,
    byeHolders: byeHolders.join(" and "),
    lineOrder16: seedPositions(LARGE).join(", "),
    largeSize: LARGE,
    sportCount: forEachSport(() => undefined),
  };
  return {
    facts,
    table: {
      caption: `${capitalised(numberWord(facts.fieldSize))} seeded players in a knockout: the bracket has ${numberWord(facts.bracketSize)} lines, and the ${numberWord(facts.byeCount)} empty ones are byes for the top ${numberWord(facts.byeCount)} seeds.`,
      columns: COLUMNS,
      rows,
    },
    text: rows.map((row) => `Match ${row[0]}: ${row[1]} against ${row[2]}.`),
  };
}

// ---- claims: each checks the draw against the seeding rule it names, never against the generator ----

interface Line {
  match: number;
  top: string;
  bottom: string;
}
function linesOf(r: ExampleResult): Line[] {
  const [m, t, b] = COLUMNS.map((c) => col(r, c));
  return (r.table?.rows ?? []).map((row) => ({ match: Number(row[m!]), top: String(row[t!]), bottom: String(row[b!]) }));
}
const seedIn = (cell: string): number | null => (cell === BYE ? null : Number(/\(seed (\d+)\)$/.exec(cell)?.[1] ?? Number.NaN));
const nameIn = (cell: string): string => /^(.+) \(seed \d+\)$/.exec(cell)?.[1] ?? cell;
const nextPow2 = (n: number) => 2 ** Math.ceil(Math.log2(n));
/** The standard seeding property, at every round: the top 2^k seeds sit in 2^k different sections of size n / 2^k. */
function sectionsProblem(order: (number | null)[], n: number): string | null {
  for (let parts = 2; parts <= n; parts *= 2) {
    const size = n / parts;
    const sectionOf = new Map<number, number>();
    order.forEach((s, i) => {
      if (s !== null) sectionOf.set(s, Math.floor(i / size));
    });
    const top = Array.from({ length: Math.min(parts, n) }, (_, i) => i + 1).filter((s) => sectionOf.has(s));
    const used = new Set(top.map((s) => sectionOf.get(s)));
    if (used.size !== top.length) return `the top ${parts} seeds share a section of ${size} lines`;
  }
  return null;
}

const claims: Claim[] = [
  {
    says: "the bracket has the smallest power of two lines that holds the field, and every empty line is a bye",
    source: "single-elimination arithmetic: a bracket of 2^k lines, byes = lines - entrants",
    check: guarded((r) => {
      const lines = linesOf(r);
      if (lines.length === 0) return "no matches";
      const n = lines.length * 2;
      const real = lines.flatMap((l) => [l.top, l.bottom]).filter((c) => c !== BYE).length;
      if (real !== KNOCKOUT_FIXTURE.length) return `${real} players in the table, the fixture has ${KNOCKOUT_FIXTURE.length}`;
      if (n !== nextPow2(KNOCKOUT_FIXTURE.length)) return `${n} lines for ${KNOCKOUT_FIXTURE.length} players, the rule gives ${nextPow2(KNOCKOUT_FIXTURE.length)}`;
      const byes = n - real;
      return (Number(r.facts.byeCount) === byes && Number(r.facts.bracketSize) === n && Number(r.facts.fieldSize) === real) || "the post's counts disagree with the draw";
    }),
  },
  {
    says: "the seed printed beside each name is that player's seed in the fixture",
    source: "the example's fixture (the seeds the organiser gave), read back from the table",
    check: guarded((r) => {
      let n = 0;
      for (const l of linesOf(r)) {
        for (const cell of [l.top, l.bottom]) {
          if (cell === BYE) continue;
          if (seedIn(cell) !== seedOf(nameIn(cell))) return `match ${l.match}: '${cell}', the fixture has seed ${seedOf(nameIn(cell))}`;
          n++;
        }
      }
      return n === KNOCKOUT_FIXTURE.length || `${n} players checked, the fixture has ${KNOCKOUT_FIXTURE.length}`;
    }),
  },
  {
    says: "the byes go to the top seeds, one each, and a bye never meets a bye",
    source: "standard knockout seeding: the byes are given to the highest seeds (the organiser may choose them instead)",
    check: guarded((r) => {
      const lines = linesOf(r);
      if (lines.length === 0) return "no matches";
      const holders: number[] = [];
      for (const l of lines) {
        if (l.top === BYE && l.bottom === BYE) return `match ${l.match} is two byes`;
        if (l.top === BYE || l.bottom === BYE) holders.push(seedIn(l.top === BYE ? l.bottom : l.top)!);
      }
      const want = Array.from({ length: lines.length * 2 - KNOCKOUT_FIXTURE.length }, (_, i) => i + 1);
      if (want.length === 0) return "the field fills the bracket, so there is no bye to check";
      return JSON.stringify(holders.sort((a, b) => a - b)) === JSON.stringify(want) || `byes went to seeds ${holders.join(", ")}`;
    }),
  },
  {
    says: "the post names the bye holders: the players whose first-round opponent is a bye, best seed first",
    source: "the committed table and the example's fixture",
    check: guarded((r) => {
      const named = linesOf(r)
        .filter((l) => l.top === BYE || l.bottom === BYE)
        .map((l) => nameIn(l.top === BYE ? l.bottom : l.top))
        .sort((a, b) => seedOf(a) - seedOf(b));
      if (named.length === 0) return "no bye holder in the table";
      return String(r.facts.byeHolders) === named.join(" and ") || `the post names '${String(r.facts.byeHolders)}', the table gives '${named.join(" and ")}'`;
    }),
  },
  {
    says: "each first-round match pairs seed k with seed (lines + 1 - k): the strongest against the weakest",
    source: "standard knockout seeding: in round one the seeds pair so each pair adds to the bracket size plus one",
    check: guarded((r) => {
      const lines = linesOf(r);
      if (lines.length === 0) return "no matches";
      const n = lines.length * 2;
      for (const l of lines) {
        const seeds = [seedIn(l.top), seedIn(l.bottom)];
        const real = seeds.filter((s): s is number => s !== null);
        // Two players: their seeds add to n + 1. One player and a bye: the seed they would have met does not exist.
        const ok = real.length === 2 ? real[0]! + real[1]! === n + 1 : real.length === 1 && n + 1 - real[0]! > KNOCKOUT_FIXTURE.length;
        if (!ok) return `match ${l.match}: seeds ${seeds.map((s) => s ?? BYE).join(" and ")}`;
      }
      return true;
    }),
  },
  {
    says: "each match sits on the two lines the engine's seed order gives it: its top line is line 2m - 1, its bottom line 2m, and a line whose seed is past the field is a bye",
    source: "the engine's seedPositions (the seed on each line of a bracket of this size, line 1 first)",
    check: guarded((r) => {
      const lines = linesOf(r);
      if (lines.length === 0) return "no matches";
      const order = seedPositions(lines.length * 2);
      for (const [i, l] of lines.entries()) {
        if (l.match !== i + 1) return `match ${l.match} is listed ${i + 1}th`;
        for (const [slot, cell] of [l.top, l.bottom].entries()) {
          const want = order[2 * i + slot]!;
          const got = seedIn(cell);
          if (want > KNOCKOUT_FIXTURE.length ? got !== null : got !== want) return `match ${l.match}, ${slot === 0 ? "top" : "bottom"} line: the seed order puts seed ${want} there, the table has '${cell}'`;
        }
      }
      return true;
    }),
  },
  {
    says: "seeds 1 and 2 are in opposite halves, so they can meet only in the final; the top four are in four different quarters",
    source: "standard knockout seeding: the top 2^k seeds are placed in 2^k different sections",
    check: guarded((r) => {
      const lines = linesOf(r);
      if (lines.length === 0) return "no matches";
      const order = lines.flatMap((l) => [seedIn(l.top), seedIn(l.bottom)]);
      return sectionsProblem(order, order.length) ?? true;
    }),
  },
  {
    says: "the 16-line order the post prints puts seed 1 first and seed 2 last, pairs to 17 in every first-round match, and keeps the top seeds apart at every round",
    source: "standard knockout seeding, checked on the printed order itself",
    check: guarded((r) => {
      const order = String(r.facts.lineOrder16).split(", ").map(Number);
      const n = Number(r.facts.largeSize);
      if (order.length !== n || new Set(order).size !== n || order.some((s) => !(s >= 1 && s <= n))) return `not a permutation of 1..${n}: ${order.join(", ")}`;
      if (order[0] !== 1 || order[n - 1] !== 2) return "seed 1 is not first, or seed 2 not last";
      for (let i = 0; i < n; i += 2) if (order[i]! + order[i + 1]! !== n + 1) return `lines ${i + 1} and ${i + 2} hold ${order[i]} and ${order[i + 1]}`;
      return sectionsProblem(order, n) ?? true;
    }),
  },
  captionClaim("the caption's counts are the post's: the field, the lines and the byes", (f) => [
    `${capitalised(numberWord(Number(f.fieldSize)))} seeded players`,
    `${numberWord(Number(f.bracketSize))} lines`,
    `the ${numberWord(Number(f.byeCount))} empty ones are byes for the top ${numberWord(Number(f.byeCount))} seeds`,
  ]),
  offeredInEverySportClaim("knockout", "knockout", "sportCount"),
];

export const knockoutSeeds: BlogExample = {
  id: KNOCKOUT_SEEDS_ID,
  kind: "engine",
  sports: "all",
  build: () => buildKnockoutSeeds(),
  claims,
};
