// B05 T5a — the ROUND COUNT half of the real circle-method round robin
// (`packages/engine/src/scheduling/roundrobin.ts#generateRoundRobin`), for
// the fake `/generate` handler every `sql`-passing `tiny-suite-*.test.ts`
// file hand-rolls. Every one of those fakes previously assumed exactly ONE
// real fixture per leg (`Array.from({length: legs}, ...)`) — true only for
// the two entrants `_tiny.json` declared until now. `_tiny.json` growing a
// THIRD streamed division (`d-tiebreak`, 3 entrants) needs a fake `/generate`
// that knows a round robin over an ODD field plays one MORE round than an
// even one (the pivot's bye consumes a round the even case doesn't have) —
// `n` real entrants over `legs` legs play `legs * roundsPerLeg` total
// fixtures, `roundsPerLeg` being `n-1` (even) or `n` (odd, one bye round per
// leg). Home/away and court packing are NOT reproduced here — these fakes
// never read them back (`bindStreamFixtures` matches a stream to a fixture
// by `(divisionRef, ext_key)` alone; see `seed.ts`'s own header) — only the
// COUNT and the `rr-r{round}-c1` ids, which the real engine also produces
// whenever there is exactly one real game per round (true for every `n<=3`
// this bench pack uses; a 4+-entrant division would need per-round COURT
// packing this helper does not attempt, and is out of scope until one
// exists).
export function roundRobinRoundCount(entrantCount: number, legs: number): number {
  if (entrantCount < 2) return 0;
  const roundsPerLeg = entrantCount % 2 === 0 ? entrantCount - 1 : entrantCount;
  return legs * roundsPerLeg;
}
