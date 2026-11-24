// The Swiss posts' example harness (examples/swiss-run.ts) pairs every round on the history the APP sends to the engine, and
// since the float-history fix (#1291, swiss-gen.ts `swissFloatHistory`) that history carries `floats`: how many earlier rounds
// each entrant floated DOWN in. A harness that leaves `floats` out pairs the late rounds the way the app did before that fix,
// so a post can print boards the product no longer seats (the final review saw round 3 of #15 move).
//
// The expected values here are NOT the app's function run again. They come from two other places:
//   - the boards the post itself prints: a board whose two sides came into the round on different points floated its
//     stronger side down once (the points are the `before` pair each printed board carries);
//   - the engine's own declaration, `SwissRound.floated` ("entrants that downfloated this round (merge into history.floats)",
//     its testkit producer adds 1 per listed id per round): what the engine itself listed for each earlier round.
// The runs are the posts' own: every `runSwiss` the three Swiss examples make, recorded through a pass-through mock.
import { describe, expect, it, vi } from "vitest";
import { buildSwissByeRounds } from "@/blog/examples/swiss-bye";
import { buildSwissLate } from "@/blog/examples/swiss-late-and-withdraw";
import { buildSwissPairing } from "@/blog/examples/swiss-pairing";
import type { SwissRun } from "@/blog/examples/swiss-run";

const { runs } = vi.hoisted(() => ({ runs: [] as import("@/blog/examples/swiss-run").SwissRun[] }));

vi.mock("@/blog/examples/swiss-run", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/blog/examples/swiss-run")>();
  return {
    ...real,
    runSwiss: (input: Parameters<typeof real.runSwiss>[0]) => {
      const run = real.runSwiss(input);
      runs.push(run);
      return run;
    },
  };
});

const sorted = (m: ReadonlyMap<string, number> | undefined): [string, number][] =>
  [...(m ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/** What the printed boards of the rounds before `round` say: the side that came in on more points floated down. */
function fromPrintedBoards(run: SwissRun, round: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of run.rounds.filter((x) => x.round < round)) {
    for (const b of r.boards) {
      const [home, away] = b.before;
      if (home === away) continue;
      const down = home > away ? b.home : b.away;
      out.set(down, (out.get(down) ?? 0) + 1);
    }
  }
  return out;
}

/** What the engine itself listed as floated, round by round, before `round`. */
function fromEngineLists(run: SwissRun, round: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of run.rounds.filter((x) => x.round < round)) for (const id of r.paired.floated) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

describe("every round of the Swiss posts is paired on the float history the app sends", () => {
  it("each round's history carries floats equal to the printed boards' and to the engine's own lists", () => {
    runs.length = 0;
    buildSwissPairing();
    buildSwissByeRounds();
    buildSwissLate();
    // The three posts' examples, each one run (a fourth would be an example this test does not know about).
    expect(runs.length, "runs recorded").toBe(3);
    let rounds = 0;
    let floatedEntrants = 0;
    let engineListed = 0;
    for (const [i, run] of runs.entries()) {
      for (const round of run.rounds) {
        const floats = round.paired.history.floats;
        expect(floats, `run ${i} round ${round.round}: the history carries a floats map`).toBeDefined();
        expect(sorted(floats), `run ${i} round ${round.round}: floats are the printed boards' downfloats`).toEqual(sorted(fromPrintedBoards(run, round.round)));
        expect(sorted(floats), `run ${i} round ${round.round}: floats are what the engine listed as floated in earlier rounds`).toEqual(sorted(fromEngineLists(run, round.round)));
        rounds++;
        floatedEntrants += floats!.size;
        engineListed += round.paired.floated.length;
      }
    }
    expect(rounds, "rounds checked").toBeGreaterThanOrEqual(10);
    // Anti-vacuity: an empty map equals an empty map, so the runs must float somebody down for the equality to mean anything.
    expect(engineListed, "downfloats the engine listed over the runs").toBeGreaterThan(0);
    expect(floatedEntrants, "entrants with a float on some round's history").toBeGreaterThan(0);
  });

  it("round 1 has nothing to carry (an empty map, not an absent one) and a later round carries a nonzero count", () => {
    runs.length = 0;
    buildSwissLate();
    expect(runs.length).toBe(1);
    const [run] = runs;
    expect(run!.rounds[0]!.paired.history.floats?.size, "round 1").toBe(0);
    const counts = run!.rounds.flatMap((r) => [...(r.paired.history.floats?.values() ?? [])]);
    expect(counts.length, "entries over rounds 2 onward").toBeGreaterThan(0);
    expect(Math.min(...counts), "a float count is at least 1").toBeGreaterThanOrEqual(1);
  });
});
