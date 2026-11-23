// Blog batch 4 (knockouts): the claims of the five examples have teeth. Each test corrupts the committed golden the way a
// wrong rule would and asserts that a claim notices, and that the untouched golden passes. The harness itself
// (regenerate, every claim passes, leak scan) is blog-examples.test.ts; this file proves those claims are not decoration.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { blogExample } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";
import { sportLabel } from "@/blog/labels";

const B4 = ["third-place-match", "knockout-match-ends-level"];

function failing(id: string, r: ExampleResult): string[] {
  return blogExample(id)!.claims.filter((c) => c.check(r) !== true).map((c) => c.says);
}
function mutate(id: string, f: (r: ExampleResult) => void): ExampleResult {
  const r = structuredClone(BLOG_GOLDENS[id]!);
  f(r);
  return r;
}
const rowWhere = (r: ExampleResult, col: number, value: string) => r.table!.rows.find((row) => String(row[col]) === value || String(row[col]).startsWith(`${value} (`))!;

describe("batch 4 examples are registered, pass on their goldens, and say why they are 'all'", () => {
  it("each is registered with claims, sweeps every sport, and passes", () => {
    let checked = 0;
    for (const id of B4) {
      const e = blogExample(id);
      expect(e, id).not.toBeNull();
      expect(e!.sports, id).toBe("all");
      expect(e!.claims.length, `${id}: claims`).toBeGreaterThanOrEqual(5);
      expect(failing(id, BLOG_GOLDENS[id]!), id).toEqual([]);
      expect(BLOG_GOLDENS[id]!.facts.sportCount, `${id}: sports swept`).toBe(builtinModules.length);
      checked++;
    }
    expect(checked).toBe(B4.length);
  });
});

describe("third-place-match", () => {
  const id = "third-place-match";
  it("a shared 3rd placed 4th, a 4th place in the shared bracket, or a play-off decided by seed is caught", () => {
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Dev")[2] = "4th"; })).length).toBeGreaterThan(0);
    // "1-2-3-3-4": the wrong constant for the place after a shared third.
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Eli")[2] = "4th"; r.facts.nextPlaceAfterShared = "4th"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Cy")[3] = "3rd"; rowWhere(r, 0, "Dev")[3] = "4th"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Gus")[2] = "6th"; })).length).toBeGreaterThan(0);
  });
  it("a play-off allowed at three players, an extra match count or a sport left out is caught", () => {
    expect(failing(id, mutate(id, (r) => { r.facts.smallestPlayoffField = 3; }))).toHaveLength(1);
    expect(failing(id, mutate(id, (r) => { r.facts.matchesPlayoff = Number(r.facts.matchesShared) + 2; }))).toHaveLength(1);
    expect(failing(id, mutate(id, (r) => { r.facts.sportsOffered = builtinModules.length - 1; }))).toHaveLength(1);
  });
});

describe("knockout-match-ends-level", () => {
  const id = "knockout-match-ends-level";
  it("every sport's row is claimed: a wrong decider or a wrong 'still level' answer is caught by that sport's own claims", () => {
    const e = blogExample(id)!;
    let corrupted = 0;
    const visited = forEachSport(({ key }) => {
      const label = sportLabel(key);
      for (const [col, value] of [[1, "Coin toss"], [2, "Maybe"]] as const) {
        const r = mutate(id, (x) => { rowWhere(x, 0, label)[col] = value; });
        const own = e.claims.filter((c) => c.sport === key && c.check(r) !== true);
        expect(own.length, `${key} column ${col}`).toBeGreaterThan(0);
        corrupted++;
      }
    });
    expect(visited).toBe(builtinModules.length);
    expect(corrupted).toBe(builtinModules.length * 2);
  });
  it("a youth shoot-out typed as the adult count, a missing kick number, or a league preset with deciders is caught", () => {
    expect(failing(id, mutate(id, (r) => { r.facts.footballYouthKicks = r.facts.footballKicks!; }))).toHaveLength(1);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Football")[1] = "Extra time, penalties"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.footballLeagueRulesPreset = 2; }))).toHaveLength(1);
    expect(failing(id, mutate(id, (r) => { r.table!.rows = r.table!.rows.filter((row) => row[0] !== "Tennis"); })).length).toBeGreaterThan(0);
  });
});

describe(() => {
  const id = "page-playoff-and-stepladder";
  it("a Page playoff that knocks out the Qualifier 1 loser, pairs 1 v 3, or keeps the Eliminator loser is caught", () => {
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 1, "Qualifier 2")[2] = "Ben (2) v Cy (3)"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 1, "Qualifier 1")[2] = "Ana (1) v Cy (3)"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 1, "Final")[2] = "Ben (2) v Dev (4)"; })).length).toBeGreaterThan(0);
  });
  it("a stepladder with a missing rung, or a top seed playing twice, is caught", () => {
    expect(failing(id, mutate(id, (r) => { r.table!.rows = r.table!.rows.filter((row) => row[1] !== "Rung 2"); })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.stepTopMatches = 2; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.pageField = 5; })).length).toBeGreaterThan(0);
  });
});

describe(() => {
  const id = "double-elimination-explained";
  it("a player out after one defeat, a winners' loser who never plays again, or a reset after the unbeaten player won is caught", () => {
    expect(failing(id, mutate(id, (r) => { r.table!.rows = r.table!.rows.filter((row) => row[1] !== "Losers' round 1"); })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.table!.rows = r.table!.rows.filter((row) => row[1] !== "Grand final (reset)"); })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 1, "Grand final")[3] = "Ana (1)"; })).length).toBeGreaterThan(0);
    // The wrong constant: without the reset the runner-up is NOT out after two defeats.
    expect(failing(id, mutate(id, (r) => { r.facts.noResetRunnerUpDefeats = 2; }))).toHaveLength(1);
  });
});

describe(() => {
  const id = "what-is-a-plate";
  it("a walkover loser in the plate, the bye holder left out, or a later loser drawn in is caught", () => {
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Fay")[4] = "Yes"; })).length).toBeGreaterThan(0);
    // The wrong constant: a round-one-losers-only plate leaves out the bye holder.
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Ana")[4] = "No"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { rowWhere(r, 0, "Ben")[4] = "Yes"; })).length).toBeGreaterThan(0);
    expect(failing(id, mutate(id, (r) => { r.facts.sportsOffered = 0; }))).toHaveLength(1);
  });
});

describe("no batch 4 claim is vacuous: an empty result fails every one of them", () => {
  it("claims never pass on an empty result", () => {
    let checked = 0;
    for (const id of B4) {
      const e = blogExample(id)!;
      for (const c of e.claims) {
        expect(c.check({ facts: {}, text: [] }), `${id}: ${c.says}`).not.toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(B4.length * 5);
  });
});
