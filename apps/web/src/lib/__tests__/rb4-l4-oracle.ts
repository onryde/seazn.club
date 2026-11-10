// W4 app-A Task 8 (FX-G2), shared with Task 10 (X-LE-4) — THE oracle for "which bye line does a newcomer take"
// (pre-flight C3 + D8, controller ruling 3: ONE oracle, exported for T10). Rulebook RB4-L4 (rulebook-W4-knockout.md):
// a newcomer takes the bye of the LOWEST-SEEDED holder, ties broken by the LATER draw position.
//
// Read over the STORED bye lines, never a fresh generate of n + 1: `swissRoundOneOrder`'s Fisher–Yates shuffle depends on
// the list's length (lib/swiss-draw.ts), so a fresh draw of n + 1 moves the holders that are already seated.
//
// Written independently of the code under test (lib/bracket-reconcile.ts `chooseByeLine` and the server's draw-position
// read): "lowest-seeded" is restated here from the rulebook (an unseeded holder ranks below every seeded one; among the
// seeded, the larger number is the lower seed), and a line's draw position is read off the ENGINE's own bracket — a
// bracket of the stored size whose entrants are named by their fold slot, so round-1 line k holds the two slots the fold
// gives it, and its draw position is the top one (the smaller number: the slot a bye's holder occupies).
import { generateSingleElim } from "@seazn/engine/scheduling";

/** A stored round-1 bye line: its fixture id, its holder, and its `seq_in_round` (1-based). */
export interface StoredByeLine {
  lineId: string;
  holderId: string;
  seq: number;
}

/** Line `seq`'s draw position in a bracket of `size` (a power of two): the top fold slot of the engine's round-1 line
 *  `seq`. Read from `generateSingleElim` over `size` entrants named "1".."size", seeded 1..size. */
export function engineLineDrawPosition(size: number, seq: number): number {
  const entrants = Array.from({ length: size }, (_, i) => String(i + 1));
  const bracket = generateSingleElim({ entrants, seeds: new Map(entrants.map((e) => [e, Number(e)])) });
  const line = bracket.fixtures.find((f) => f.id === `se-r0-i${seq - 1}`);
  if (line === undefined || line.home === undefined || line.away === undefined) {
    throw new Error(`oracle: the engine's bracket of ${size} has no two-sided round-1 line ${seq}`);
  }
  return Math.min(Number(line.home), Number(line.away));
}

/** RB4-L4's answer: the line id a newcomer takes, or null when no stored bye line is left. `seeds` holds every holder's
 *  CURRENT seed (null = unseeded); `round1Lines` is how many round-1 lines the stored bracket has. */
export function rb4L4ExpectedLine(
  byeLines: readonly StoredByeLine[],
  seeds: ReadonlyMap<string, number | null>,
  round1Lines: number,
): string | null {
  if (byeLines.length === 0) return null;
  const size = round1Lines * 2;
  // The rank of "how low a seed": unseeded lowest of all, then the larger seed number.
  const lowness = (holder: string): number => {
    if (!seeds.has(holder)) throw new Error(`oracle: no seed given for holder ${holder}`);
    const s = seeds.get(holder)!;
    return s === null ? Number.POSITIVE_INFINITY : s;
  };
  const ranked = [...byeLines].sort(
    (a, b) => lowness(b.holderId) - lowness(a.holderId) || engineLineDrawPosition(size, b.seq) - engineLineDrawPosition(size, a.seq),
  );
  return ranked[0]!.lineId;
}
