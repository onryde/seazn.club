// Post #16, "How are seeds placed in a knockout bracket, and who gets the byes?". Six seeded players are drawn into a
// knockout by the app's own generator (`generate("knockout", …)`, the one Generate calls, which hands the engine's
// `generateSingleElim` the field and its seeds), and the line order of a 16-line bracket is read from the engine's
// `seedPositions`. The fixture is only the names and their seeds; the lines, the byes and the first-round matches come out
// of the generator.
//
// Every sport: the knockout draw reads no sport (the generator takes the field, its seeds and the stage's options, never
// the sport), and the example-wide claim sweeps the registry for the knockout format being offered to each.
import { seedPositions } from "@seazn/engine/scheduling";
import { forEachSport } from "@seazn/engine/testkit";
import { generate } from "@/server/usecases/stages/generators";
import { col, guarded, offeredInEverySportClaim } from "./swiss-claims";
import type { BlogExample, Claim, ExampleResult } from "./types";

export const KNOCKOUT_SEEDS_ID = "knockout-seeds";

const PLAYERS = ["Ana", "Ben", "Cy", "Dev", "Eve", "Fay"] as const;
const BYE = "Bye";
const COLUMNS = ["First-round match", "Top line", "Bottom line"];
const LARGE = 16;

const seedOf = (name: string) => PLAYERS.indexOf(name as (typeof PLAYERS)[number]) + 1;
const label = (id: string | null | undefined) => {
  if (id === null || id === undefined) return BYE;
  const name = PLAYERS.find((p) => p.toLowerCase() === id);
  if (name === undefined) throw new Error(`knockout-seeds: the draw placed '${id}', who is not in the field`);
  return `${name} (seed ${seedOf(name)})`;
};

function build(): ExampleResult {
  const field = PLAYERS.map((n, i) => ({ id: n.toLowerCase(), seed: i + 1, swiss_first_round: null }));
  const fixtures = generate("knockout", {}, field, new Map());
  const first = fixtures.filter((f) => f.roundNo === 1).sort((a, b) => a.seqInRound - b.seqInRound);
  const rows = first.map((f, i) => [i + 1, label(f.home), label(f.away)]);
  const byeHolders = first.filter((f) => f.away === null || f.home === null).map((f) => label(f.home ?? f.away).replace(/ \(.*\)$/, ""));
  const lines = first.length * 2;
  return {
    facts: {
      fieldSize: PLAYERS.length,
      bracketSize: lines,
      byeCount: lines - PLAYERS.length,
      byeHolders: byeHolders.sort((a, b) => seedOf(a) - seedOf(b)).join(" and "),
      lineOrder16: seedPositions(LARGE).join(", "),
      largeSize: LARGE,
      sportCount: forEachSport(() => undefined),
    },
    table: { caption: "Six seeded players in a knockout: the bracket has eight lines, and the two empty ones are byes for the top two seeds.", columns: COLUMNS, rows },
    text: first.map((f, i) => `Match ${i + 1}: ${label(f.home)} against ${label(f.away)}.`),
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
      const n = lines.length * 2;
      if (n !== nextPow2(PLAYERS.length)) return `${n} lines for ${PLAYERS.length} players, the rule gives ${nextPow2(PLAYERS.length)}`;
      const byes = lines.flatMap((l) => [l.top, l.bottom]).filter((c) => c === BYE).length;
      if (byes !== n - PLAYERS.length) return `${byes} byes, the rule gives ${n - PLAYERS.length}`;
      return (Number(r.facts.byeCount) === byes && Number(r.facts.bracketSize) === n) || "the post's counts disagree with the draw";
    }),
  },
  {
    says: "the byes go to the top seeds, one each, and a bye never meets a bye",
    source: "standard knockout seeding: the byes are given to the highest seeds (the organiser may choose them instead)",
    check: guarded((r) => {
      const lines = linesOf(r);
      const holders: number[] = [];
      for (const l of lines) {
        if (l.top === BYE && l.bottom === BYE) return `match ${l.match} is two byes`;
        if (l.top === BYE || l.bottom === BYE) holders.push(seedIn(l.top === BYE ? l.bottom : l.top)!);
      }
      const want = Array.from({ length: lines.length * 2 - PLAYERS.length }, (_, i) => i + 1);
      return JSON.stringify(holders.sort((a, b) => a - b)) === JSON.stringify(want) || `byes went to seeds ${holders.join(", ")}`;
    }),
  },
  {
    says: "each first-round match pairs seed k with seed (lines + 1 - k): the strongest against the weakest",
    source: "standard knockout seeding: in round one the seeds pair so each pair adds to the bracket size plus one",
    check: guarded((r) => {
      const lines = linesOf(r);
      const n = lines.length * 2;
      for (const l of lines) {
        const seeds = [seedIn(l.top), seedIn(l.bottom)];
        const real = seeds.filter((s): s is number => s !== null);
        // Two players: their seeds add to n + 1. One player and a bye: the seed they would have met does not exist.
        const ok = real.length === 2 ? real[0]! + real[1]! === n + 1 : real.length === 1 && n + 1 - real[0]! > PLAYERS.length;
        if (!ok) return `match ${l.match}: seeds ${seeds.map((s) => s ?? BYE).join(" and ")}`;
      }
      return lines.length > 0 || "no matches";
    }),
  },
  {
    says: "seeds 1 and 2 are in opposite halves, so they can meet only in the final; the top four are in four different quarters",
    source: "standard knockout seeding: the top 2^k seeds are placed in 2^k different sections",
    check: guarded((r) => {
      const lines = linesOf(r);
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
  offeredInEverySportClaim("knockout", "knockout", "sportCount"),
];

export const knockoutSeeds: BlogExample = {
  id: KNOCKOUT_SEEDS_ID,
  kind: "engine",
  sports: "all",
  build,
  claims,
};
