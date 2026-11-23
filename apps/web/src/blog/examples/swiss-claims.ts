// Batch 3's shared claim helpers for the Swiss posts' examples. Pure readers of a committed result: they parse what a
// table cell says and never call the code that built it.
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { forEachSport } from "@seazn/engine/testkit";
import { templatesForSport } from "@/lib/format-templates";
import type { Cell, Claim, ExampleResult } from "./types";

/** "1½" -> 1.5, "½" -> 0.5, "2" -> 2: a chess score as the table prints it. NaN for anything else. */
export function scoreOf(cell: Cell): number {
  const s = String(cell).trim();
  const m = /^(\d*)(½?)$/.exec(s);
  if (m === null || s.length === 0) return Number.NaN;
  return (m[1] === "" ? 0 : Number(m[1])) + (m[2] === "½" ? 0.5 : 0);
}

/** The column index of a header, or a thrown error naming it (a claim reports a missing column as a failure). */
export function col(result: ExampleResult, name: string): number {
  const i = result.table?.columns.indexOf(name) ?? -1;
  if (i < 0) throw new Error(`no column '${name}'`);
  return i;
}

/** Runs a check that may throw on a malformed result, and reports the throw as the claim's failure. */
export function guarded(check: (r: ExampleResult) => boolean | string): Claim["check"] {
  return (r) => {
    try {
      return check(r);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
}

/** Every sport in the registry, and whether the builder offers it a format whose stages include `stageKind`. */
export function offeredEverywhere(templateKey: string): { visited: number; missing: string[] } {
  const missing: string[] = [];
  const visited = forEachSport(({ module }) => {
    const kinds = effectiveEntrantModel(module.entrantModel, null).kinds;
    if (!templatesForSport(module.key, kinds).some((t) => t.key === templateKey)) missing.push(module.key);
  });
  return { visited, missing };
}

/** The example-wide claim: the format is offered for every sport in the registry, and the sweep counted them. */
export function offeredInEverySportClaim(templateKey: string, label: string, countFact: string): Claim {
  return {
    says: `the ${label} format is offered for every sport in the registry, and the post's sport count is the registry's`,
    source: "the formats the division builder offers a sport (templatesForSport over the sport's own entrant model), swept with forEachSport",
    check(result) {
      const { visited, missing } = offeredEverywhere(templateKey);
      if (visited === 0) return "the sweep visited no sport";
      if (missing.length > 0) return `not offered for ${missing.join(", ")}`;
      return Number(result.facts[countFact]) === visited || `${countFact} is ${String(result.facts[countFact])}, the registry has ${visited}`;
    },
  };
}

/** The table's own cell for a seeded player: the name and, in brackets, the seed the organiser gave. */
export const seededLabel = (name: string, seed: number) => `${name} (${seed})`;

/** Reads a `seededLabel` cell back; a cell that is not one throws (a claim reports a throw as its failure). */
export function parseSeededLabel(cell: Cell): { name: string; seed: number } {
  const m = /^(.+) \((\d+)\)$/.exec(String(cell));
  if (m === null) throw new Error(`'${String(cell)}' is not 'Name (seed)'`);
  return { name: m[1]!, seed: Number(m[2]) };
}

/** A fixture player: the name the table prints and the seed the organiser gave. */
export interface Seeded {
  name: string;
  seed: number;
}

/** The seed of a printed name, read from the fixture. A name the fixture does not hold throws (a claim reports a throw as its failure). */
export function seedReader(fixture: readonly Seeded[]): (name: string) => number {
  const by = new Map(fixture.map((p) => [p.name, p.seed]));
  return (name) => {
    const seed = by.get(name);
    if (seed === undefined) throw new Error(`no seed for '${name}' in the fixture`);
    return seed;
  };
}

/**
 * Why a fixture's seeds could not tell a pairing that reads the seed from one that reads the sign-up list or the names
 * (the blind spot the engine mutant that ignored `rank` slipped through): `null` when every player's seed differs from
 * their place in the list AND from their place in the alphabet, and the seeds are 1..n once each.
 * The fixture is given in sign-up order.
 */
export function seedsIndistinguishable(fixture: readonly Seeded[]): string | null {
  const n = fixture.length;
  if (n === 0) return "the fixture is empty";
  const sorted = fixture.map((p) => p.seed).sort((a, b) => a - b);
  if (sorted.some((s, i) => s !== i + 1)) return `the seeds are not 1..${n} once each: ${sorted.join(", ")}`;
  const alphabet = fixture.map((p) => p.name).sort((a, b) => a.localeCompare(b));
  for (const [i, p] of fixture.entries()) {
    if (p.seed === i + 1) return `${p.name}'s seed ${p.seed} is their place in the sign-up list`;
    if (p.seed === alphabet.indexOf(p.name) + 1) return `${p.name}'s seed ${p.seed} is their place in the alphabet`;
  }
  return null;
}

/**
 * The cell an example prints for a board with a bye (an odd field's engine-paired bye, never a withdrawn player's seat). One
 * declaration for the three examples that print it: the repo-wide bye-render guard (R116-4) counts each quoted "Bye" as a render
 * site, and this one is exempt there with its reason.
 */
export const BYE_CELL = "Bye";

// ---- the float rule, as an oracle that never calls the engine ----

/** One paired round as a post prints it: each player's score going in, who plays whom, and who sits out. */
export interface PairedRound {
  round: number;
  score: Map<string, number>;
  pairs: [string, string][];
  bye: string | null;
}

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Every perfect matching of `players` that repeats no pair in `met`, as a generator (a field of eight has 105 at most). */
function* matchings(players: string[], met: ReadonlySet<string>): Generator<[string, string][]> {
  if (players.length === 0) {
    yield [];
    return;
  }
  const [first, ...rest] = players as [string, ...string[]];
  for (const other of rest) {
    if (met.has(key(first, other))) continue;
    for (const tail of matchings(
      rest.filter((p) => p !== other),
      met,
    ))
      yield [[first, other], ...tail];
  }
}

/** Per score group, highest score first: how many boards seat one of the group's players against a lower score (a float down). */
function floatProfile(score: ReadonlyMap<string, number>, pairs: readonly [string, string][]): number[] {
  const groups = [...new Set(score.values())].sort((a, b) => b - a);
  return groups.map((g) =>
    pairs.filter(([a, b]) => {
      const [x, y] = [score.get(a)!, score.get(b)!];
      return Math.max(x, y) === g && x !== y;
    }).length,
  );
}

/** Compares two profiles from the top group down: negative when `a` floats fewer out of the highest group where they differ. */
const compareProfiles = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

/**
 * The float rule, the way the engine words it (swiss.js header: it pairs each score group top-down and moves the fewest players
 * to the next group): over every rematch-free way to seat the round's players, the one this round has floats the fewest out
 * of the highest score group, then out of the next, and so on down. It is NOT the fewest mixed boards over the whole round:
 * a lower group can end up with more floats because the group above is settled first.
 *
 * `rounds` is every round in order; a round's pairs join the rematch history for the next. Returns null when each round after the
 * first pairs that way, else why not. `checked` counts the rounds the oracle compared (zero is a failure for the caller).
 */
export function floatRuleProblem(rounds: readonly PairedRound[]): { problem: string | null; checked: number } {
  const met = new Set<string>();
  let checked = 0;
  for (const r of [...rounds].sort((a, b) => a.round - b.round)) {
    if (r.round > 1) {
      const seated = [...r.score.keys()].filter((p) => p !== r.bye).sort();
      const seatedHere = new Set(r.pairs.flat());
      if (seated.length !== seatedHere.size || seated.some((p) => !seatedHere.has(p))) return { problem: `round ${r.round}: the boards seat ${[...seatedHere].sort().join(", ")}, the field minus the bye is ${seated.join(", ")}`, checked };
      const mine = floatProfile(r.score, r.pairs);
      let best: number[] | null = null;
      for (const m of matchings(seated, met)) {
        const p = floatProfile(r.score, m);
        if (best === null || compareProfiles(p, best) < 0) best = p;
      }
      if (best === null) return { problem: `round ${r.round}: no rematch-free pairing exists`, checked };
      if (compareProfiles(mine, best) !== 0) return { problem: `round ${r.round}: floats out of each score group, top down, are ${mine.join(", ")}; the fewest possible are ${best.join(", ")}`, checked };
      checked++;
    }
    for (const [a, b] of r.pairs) {
      if (met.has(key(a, b))) return { problem: `round ${r.round}: ${a} and ${b} have met before`, checked };
      met.add(key(a, b));
    }
  }
  return { problem: null, checked };
}

// ---- captions ----

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"];
/** A small count in words ("six"); the claim side's own list, so a caption built from another one is checked against this. */
export const numberWord = (n: number): string => WORDS[n] ?? String(n);
export const capitalised = (s: string): string => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`;

/**
 * A caption's counts and names are the result's own facts: the caption says each phrase `phrases` returns (built from the
 * result's facts, with this file's own number words), so a caption typed beside a changed example fails here.
 */
export function captionClaim(says: string, phrases: (facts: ExampleResult["facts"]) => string[]): Claim {
  return {
    says,
    source: "the example's own facts (the counts and names the post prints), read back into its caption",
    check: guarded((r) => {
      const caption = r.table?.caption ?? "";
      const wanted = phrases(r.facts);
      if (wanted.length === 0) return "no phrase to look for";
      for (const w of wanted) if (!caption.includes(w)) return `the caption '${caption}' does not say '${w}'`;
      return true;
    }),
  };
}
