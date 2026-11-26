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

/** How long a row keeps its players from the next match: the longest rest of the groups it is in. */
const restOn = (input: SolveBuildInput, r: Row): number =>
  Math.max(0, ...(r.ruleGroupIndices ?? []).map((i) => input.ruleGroups![i]!.minRestMinutes ?? 0));

/** `collisions` over a whole request, each row owing its own rest. */
function clashes(input: SolveBuildInput) {
  const gap = input.constraints.gapMinutes;
  const found: string[] = [];
  let pairs = 0;
  const hit = (a: Row, aLength: number, b: Row, bLength: number) =>
    a.startAtMs < b.startAtMs + bLength * MIN && b.startAtMs < a.startAtMs + aLength * MIN;
  for (const [i, a] of input.existing.entries()) {
    for (const b of input.existing.slice(i + 1)) {
      pairs++;
      if (a.court === b.court && hit(a, MATCH + gap, b, MATCH + gap)) found.push(`court ${a.fixtureId}/${b.fixtureId}`);
      if (
        (a.entrantIds ?? []).some((e) => (b.entrantIds ?? []).includes(e)) &&
        hit(a, MATCH + restOn(input, a), b, MATCH + restOn(input, b))
      ) {
        found.push(`entrant ${a.fixtureId}/${b.fixtureId}`);
      }
    }
  }
  return { found, pairs };
}

/** The time from the floor on that `intervals` cover, as merged [from, to] minute pairs, flattened. */
function fromFloor(intervals: [number, number][]): number[] {
  const out: number[] = [];
  for (const [from, to] of intervals
    .map(([a, b]): [number, number] => [Math.max(a, FLOOR), b])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])) {
    const start = (from - FLOOR) / MIN;
    const end = (to - FLOOR) / MIN;
    if (out.length > 0 && start <= out.at(-1)!) out[out.length - 1] = Math.max(out.at(-1)!, end);
    else out.push(start, end);
  }
  return out;
}

const courtBusy = (input: SolveBuildInput, court: string) =>
  fromFloor(
    input.existing
      .filter((r) => r.court === court)
      .map((r) => [r.startAtMs, r.startAtMs + (MATCH + input.constraints.gapMinutes) * MIN]),
  );

const playerBusy = (input: SolveBuildInput, player: string) =>
  fromFloor(
    input.existing
      .filter((r) => (r.entrantIds ?? []).includes(player))
      .map((r) => [r.startAtMs, r.startAtMs + (MATCH + restOn(input, r)) * MIN]),
  );

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

  // The held match still holds its court past the floor by the gap, so it is brought forward to end where the
  // next one starts. Its player's earlier match was clear of it where it was, and is not where it goes.
  it("keeps a player off a match that was brought forward onto another of theirs", () => {
    const input = request(
      [row("held", -35, "C1", ["p"]), row("next", 0, "C1", ["q"]), row("earlier", -69, "C2", ["p"])],
      0,
      { gap: 10 },
    );
    expect(clashes(input)).toEqual({ found: ["court held/next"], pairs: 3 });
    const out = spare(input, new Set(["held"]));
    expect(byId(out, "held").startAtMs).toBe(at(-40));
    expect(clashes(out)).toEqual({ found: [], pairs: 3 });
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

  // Rest differs per rule group, so the row that REACHES furthest is not the row that holds the court.
  const unequal = (rows: Row[], rests: number[]) =>
    ({
      ...request(rows),
      ruleGroups: rests.map((minRestMinutes) => ({ fixtureIds: ["free"], minRestMinutes })),
    }) as SolveBuildInput;

  it("keeps the court taken by the running match when an earlier one owes a longer rest", () => {
    const input = unequal(
      [row("long-rest", -35, "C1", ["e1"], { ruleGroupIndices: [1] }), row("running", -10, "C1", ["e2"])],
      [0, 120],
    );
    const out = spare(input);
    expect(courtBusy(out, "C1")).toEqual(courtBusy(input, "C1"));
    expect(playerBusy(out, "e1")).toEqual(playerBusy(input, "e1"));
    expect(clashes(out).found).toEqual([]);
  });

  it("keeps a player busy for the held match when an earlier, shorter row it did not touch has them too", () => {
    const input = request([row("sibling", -45, "C2", ["e1"]), row("a", -20, "C1", ["e1", "e2"])]);
    const out = spare(input, new Set(["a"]));
    expect(playerBusy(input, "e1").length).toBeGreaterThan(0);
    expect(playerBusy(out, "e1")).toEqual(playerBusy(input, "e1"));
    expect(clashes(out).found).toEqual([]);
  });

  for (const [name, heldAt, otherAt] of [
    ["the held one started first", -20, -10],
    ["the held one started last", -10, -20],
    ["the other one has yet to start", -10, 5],
  ] as const) {
    it(`sends a running held match and another row on its court apart: ${name}`, () => {
      const input = request([row("held", heldAt, "C1", ["e1"]), row("other", otherAt, "C1", ["e2"])]);
      expect(clashes(input).found).toHaveLength(1);
      const out = spare(input, new Set(["held"]));
      expect(clashes(out).found).toEqual([]);
      expect(courtBusy(out, "C1")).toEqual(courtBusy(input, "C1"));
      for (const player of ["e1", "e2"]) expect(playerBusy(out, player)).toEqual(playerBusy(input, player));
    });
  }

  it("holds a player until the later of the held match's rest and a row that starts inside it", () => {
    const input = request([row("held", -20, "C1", ["e1"]), row("sibling", 20, "C2", ["e1"])], 60);
    const out = spare(input, new Set(["held"]));
    expect(playerBusy(input, "e1")).toEqual([0, 110]);
    expect(playerBusy(out, "e1")).toEqual([0, 110]);
    expect(clashes(out).found).toEqual([]);
  });

  it("with unequal rest and rows it did not touch, frees nothing early and sends no clash", () => {
    let seed = 11;
    const next = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const RESTS = [0, 15, 60, 120];
    const seen = { boards: 0, courts: 0, players: 0, busy: 0, clashingBefore: 0, mixed: 0, addedRows: 0, broughtForward: 0 };
    for (let i = 0; i < 600; i++) {
      const gap = [0, 10][next(2)]!;
      const make = (id: string, earliest: number, span: number): Row => {
        const a = next(6);
        return row(id, earliest + 5 * next(span), `C${1 + next(2)}`, [`e${a}`, `e${(a + 1 + next(5)) % 6}`], {
          ruleGroupIndices: [next(RESTS.length)],
        });
      };
      const shape = (rows: Row[]) => ({ ...unequal(rows, RESTS), constraints: { matchMinutes: MATCH, gapMinutes: gap } }) as SolveBuildInput;
      const held = Array.from({ length: 1 + next(6) }, (_, j) => make(`held${j}`, -150, 30));
      // Rows the pass was not asked to touch do not collide among themselves; they may with a held one.
      const others: Row[] = [];
      for (let j = 0; j < 5; j++) {
        const candidate = make(`other${j}`, -150, 60);
        if (clashes(shape([...others, candidate])).found.length === 0) others.push(candidate);
      }
      const rows = [...others, ...held].sort(() => next(3) - 1);
      const input = shape(rows);
      const out = spareHeldRows(input, ids(held), FLOOR);
      if (clashes(input).found.length > 0) seen.clashingBefore++;
      if (others.length > 0) seen.mixed++;
      seen.addedRows += out.existing.length - rows.length;
      seen.broughtForward += rows.filter((before) => {
        const now = byId(out, before.fixtureId).startAtMs;
        return now < before.startAtMs && out.existing.some((o) => o.court === before.court && o.startAtMs >= FLOOR && o.startAtMs === now + (MATCH + gap) * MIN);
      }).length;
      expect(clashes(out).found, `board ${i}`).toEqual([]);
      for (const court of ["C1", "C2"]) {
        expect(courtBusy(out, court), `board ${i} ${court}`).toEqual(courtBusy(input, court));
        seen.courts++;
        seen.busy += courtBusy(input, court).length;
      }
      for (let e = 0; e < 6; e++) {
        expect(playerBusy(out, `e${e}`), `board ${i} e${e}`).toEqual(playerBusy(input, `e${e}`));
        seen.players++;
        seen.busy += playerBusy(input, `e${e}`).length;
      }
      seen.boards++;
    }
    expect(seen).toMatchObject({ boards: 600, courts: 1200, players: 3600 });
    expect(seen.busy).toBeGreaterThan(1000);
    expect(seen.clashingBefore).toBeGreaterThan(200);
    expect(seen.mixed).toBeGreaterThan(500);
    // Both rewrites that are not plain parking were reached.
    expect(seen.addedRows).toBeGreaterThan(50);
    expect(seen.broughtForward).toBeGreaterThan(20);
  });

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
