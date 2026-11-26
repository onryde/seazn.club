// The request side of a HELD card (`schedule/held.ts`). The placement service takes every `existing` row as
// a fixed interval under a no-overlap constraint, per court and per entrant (each as long as the match plus
// the rest that row owes), so two rows that collide with each other make its model INFEASIBLE. Those two
// constraints are the oracle here. No database and no solver.
import { describe, expect, it } from "vitest";
import type { SolveBuildInput } from "@seazn/engine/scheduling";
import { spareHeldRows } from "../schedule/held";

type Row = SolveBuildInput["existing"][number];

const MIN = 60_000;
const MATCH = 30;
const FLOOR = Date.UTC(2026, 10, 26, 12, 0);
/** A start `minutes` after the floor (negative: before it, as every held row is). */
const at = (minutes: number): number => FLOOR + minutes * MIN;

function row(fixtureId: string, minutes: number, court: string, entrantIds: string[] = [], extra: Partial<Row> = {}): Row {
  return { fixtureId, court, startAtMs: at(minutes), entrantIds, ruleGroupIndices: [0], ...extra } as Row;
}

function request(rows: Row[], rest = 0, over: { gap?: number; roundGap?: number } = {}): SolveBuildInput {
  return {
    fixtures: [{ fixtureId: "free", ...(over.roundGap !== undefined ? { roundGapMinutes: over.roundGap } : {}) }],
    existing: rows,
    ruleGroups: [{ fixtureIds: ["free"], minRestMinutes: rest }],
    constraints: { matchMinutes: MATCH, gapMinutes: over.gap ?? 0 },
  } as unknown as SolveBuildInput;
}

const ids = (rows: readonly Row[]) => new Set(rows.map((r) => r.fixtureId));
const byId = (input: SolveBuildInput, id: string) => input.existing.find((r) => r.fixtureId === id)!;
const spare = (input: SolveBuildInput, held = ids(input.existing)) => spareHeldRows(input, held, FLOOR);

/** Pairs of rows the service could not hold at once. Returns how many pairs it looked at, too. */
function collisions(rows: readonly Row[], rest: number, gap = 0) {
  const found: string[] = [];
  let pairs = 0;
  const hit = (a: Row, b: Row, length: number) =>
    a.startAtMs < b.startAtMs + length * MIN && b.startAtMs < a.startAtMs + length * MIN;
  for (const [i, a] of rows.entries()) {
    for (const b of rows.slice(i + 1)) {
      pairs++;
      if (a.court === b.court && hit(a, b, MATCH + gap)) found.push(`court ${a.fixtureId}/${b.fixtureId}`);
      if ((a.entrantIds ?? []).some((e) => (b.entrantIds ?? []).includes(e)) && hit(a, b, MATCH + rest)) {
        found.push(`entrant ${a.fixtureId}/${b.fixtureId}`);
      }
    }
  }
  return { found, pairs };
}

describe("spareHeldRows", () => {
  it("returns the request itself when no row is held", () => {
    const input = request([row("a", -600, "C1"), row("b", -600, "C1")]);
    expect(spare(input, new Set())).toBe(input);
    expect(spare(input, new Set(["not-on-the-wire"]))).toBe(input);
  });

  it("parks finished rows apart, and keeps their day, round, court and players", () => {
    const input = request(
      [
        row("a", -600, "C1", ["e1", "e2"], { dayIndex: 0, roundNo: 1 }),
        row("b", -600, "C1", ["e3", "e4"], { dayIndex: 0, roundNo: 1 }),
        row("c", -590, "C2", ["e1", "e3"], { dayIndex: 0, roundNo: 2 }),
      ],
      60,
    );
    expect(collisions(input.existing, 60).found.length).toBeGreaterThan(0);
    const out = spare(input);
    expect(collisions(out.existing, 60)).toEqual({ found: [], pairs: 3 });
    let checked = 0;
    for (const before of input.existing) {
      const after = byId(out, before.fixtureId);
      expect({ ...after, startAtMs: 0 }).toEqual({ ...before, startAtMs: 0 });
      // Still before the floor, so it orders the rounds the same.
      expect(after.startAtMs).toBeLessThan(Math.min(...input.existing.map((r) => r.startAtMs)));
      expect(after.startAtMs).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("never parks a row on a row it was not asked to touch", () => {
    const other = row("sibling", -700, "C1", ["e9"]);
    const input = request([other, row("a", -600, "C1"), row("b", -600, "C1")]);
    const out = spare(input, new Set(["a", "b"]));
    expect(byId(out, "sibling")).toBe(other);
    expect(collisions(out.existing, 0)).toEqual({ found: [], pairs: 3 });
  });

  it("keeps the match that holds the court longest where it is", () => {
    const input = request([row("early", -20, "C1"), row("late", -10, "C1")]);
    const out = spare(input);
    expect(byId(out, "late").startAtMs).toBe(at(-10));
    expect(byId(out, "early").startAtMs).toBeLessThan(at(-20));
    expect(collisions(out.existing, 0).found).toEqual([]);
  });

  it("keeps a shared player on the one match that holds them longest", () => {
    const input = request([row("early", -20, "C1", ["e1", "e2"]), row("late", -10, "C2", ["e1", "e3"])]);
    const out = spare(input);
    expect(byId(out, "early")).toMatchObject({ startAtMs: at(-20), entrantIds: ["e2"] });
    expect(byId(out, "late")).toMatchObject({ startAtMs: at(-10), entrantIds: ["e1", "e3"] });
    expect(collisions(out.existing, 0).found).toEqual([]);
  });

  it("keeps a player off a held match that collides with a row it was not asked to touch", () => {
    const input = request([row("sibling", -10, "C2", ["e1"]), row("a", -20, "C1", ["e1", "e2"])]);
    const out = spare(input, new Set(["a"]));
    expect(byId(out, "a")).toMatchObject({ startAtMs: at(-20), entrantIds: ["e2"] });
  });

  // A finished match still binds while something it owes runs past the floor.
  for (const [name, rest, over] of [
    ["a rest", 60, {}],
    ["a court gap", 0, { gap: 60 }],
    ["a round gap", 0, { roundGap: 60 }],
  ] as const) {
    it(`leaves a finished match where it is while ${name} still runs`, () => {
      // Ended 15 minutes before the floor, with an hour owed after it.
      const input = request([row("a", -45, "C1", ["e1"])], rest, over);
      expect(byId(spare(input), "a").startAtMs).toBe(at(-45));
      // Ended 61 minutes before: nothing left to hold.
      const spent = request([row("a", -91, "C1", ["e1"])], rest, over);
      expect(byId(spare(spent), "a").startAtMs).toBeLessThan(at(-91));
    });
  }

  it("sends nothing the service cannot hold, and frees no court early, across many boards", () => {
    // A fixed linear congruential generator: the same boards every run.
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    let boards = 0;
    let pairs = 0;
    let clashingBefore = 0;
    for (let i = 0; i < 300; i++) {
      const rest = [0, 15, 60][next(3)]!;
      const gap = [0, 10][next(2)]!;
      const rows = Array.from({ length: 2 + next(8) }, (_, j) => {
        const a = next(5);
        return row(`f${j}`, -5 * (1 + next(40)), `C${1 + next(2)}`, [`e${a}`, `e${(a + 1 + next(4)) % 5}`]);
      });
      const input = request(rows, rest, { gap });
      const out = spare(input);
      if (collisions(rows, rest, gap).found.length > 0) clashingBefore++;
      const after = collisions(out.existing, rest, gap);
      expect(after.found).toEqual([]);
      pairs += after.pairs;
      // From the floor on, each court is taken for exactly as long as it was.
      const busyUntil = (list: readonly Row[], court: string) =>
        Math.max(FLOOR, ...list.filter((r) => r.court === court).map((r) => r.startAtMs + (MATCH + gap) * MIN));
      for (const court of ["C1", "C2"]) expect(busyUntil(out.existing, court)).toBe(busyUntil(rows, court));
      boards++;
    }
    expect(boards).toBe(300);
    expect(pairs).toBeGreaterThan(1000);
    expect(clashingBefore).toBeGreaterThan(100);
  });
});
