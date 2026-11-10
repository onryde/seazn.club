// The rulebook's plate field, FOLDED from the engine's own single-elimination draw (RB4-D1: "better seed wins"), never read
// off `estimatePlateField`. A test oracle: play every real line of `generateSingleElim` with the better seed winning, and
// count the entrants whose FIRST real match was a loss (a bye is no match: the engine's `award` lines).
import { generateSingleElim } from "@seazn/engine/scheduling";

export function foldFirstLosses(n: number): number {
  if (n < 2) return 0;
  const ids = Array.from({ length: n }, (_, i) => `e${i + 1}`);
  const seed = new Map(ids.map((id, i) => [id, i + 1] as const));
  const { fixtures } = generateSingleElim({ entrants: ids, seeds: seed });
  const winnerOf = new Map<string, string>();
  const played = new Set<string>();
  let firstLosses = 0;
  type Line = { home?: string; homeFrom?: { fixtureId: string }; away?: string; awayFrom?: { fixtureId: string } };
  const seat = (f: Line, side: "home" | "away"): string | undefined => {
    const direct = side === "home" ? f.home : f.away;
    if (direct !== undefined) return direct;
    const from = side === "home" ? f.homeFrom : f.awayFrom;
    return from === undefined ? undefined : winnerOf.get(from.fixtureId);
  };
  for (const f of [...fixtures].sort((a, b) => a.round - b.round)) {
    const home = seat(f, "home");
    const away = seat(f, "away");
    const award = (f as { award?: string }).award;
    if (award !== undefined) {
      winnerOf.set(f.id, award); // a bye: no match, nobody's first
      continue;
    }
    if (home === undefined || away === undefined) throw new Error(`fold: ${f.id} of ${n} has an unresolved seat`);
    const [better, worse] = seed.get(home)! < seed.get(away)! ? [home, away] : [away, home];
    winnerOf.set(f.id, better);
    if (!played.has(worse)) firstLosses++;
    played.add(better);
    played.add(worse);
  }
  return firstLosses;
}
