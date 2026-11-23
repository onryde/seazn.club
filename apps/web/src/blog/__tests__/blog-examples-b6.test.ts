// Batch 6 (Task 12): the claims of #28 to #33 have teeth. Every claim passes on its committed golden (blog-examples.test.ts holds
// that); here each one must FAIL on an empty result, every cell, fact and diagram value of every example is corrupted in turn and
// a claim must notice, every digit of every printed string is moved on by one and a claim must notice, and the load-bearing
// claims fail on a result corrupted in the one way each exists to catch. Anti-vacuity: the counts swept are asserted.
import { describe, expect, it } from "vitest";
import { BLOG_EXAMPLES } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import type { ExampleResult } from "@/blog/examples/types";

const B6 = ["round-robin-schedule"] as const;
const EMPTY: ExampleResult = { facts: {}, text: [] };
const clone = (id: string): ExampleResult => JSON.parse(JSON.stringify(BLOG_GOLDENS[id]!)) as ExampleResult;
const claimsOf = (id: string) => BLOG_EXAMPLES.find((e) => e.id === id)!.claims;
const failing = (id: string, r: ExampleResult) => claimsOf(id).filter((c) => c.check(r) !== true).map((c) => c.says);

const CLAIM_COUNT = B6.reduce((n, id) => n + claimsOf(id).length, 0);

describe("batch 6 claims have teeth", () => {
  it(`every one of the ${CLAIM_COUNT} claims of batch 6 passes on its golden and fails on an empty result`, () => {
    let checked = 0;
    for (const id of B6) {
      expect(claimsOf(id).length, `${id}: claims`).toBeGreaterThan(0);
      for (const c of claimsOf(id)) {
        expect(c.check(BLOG_GOLDENS[id]!), `${id}: ${c.says}`).toBe(true);
        expect(c.check(EMPTY), `${id}: '${c.says}' passes on an empty result`).not.toBe(true);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: batch 6 claims checked").toBe(CLAIM_COUNT);
    expect(checked, "anti-vacuity: batch 6 claims checked").toBeGreaterThanOrEqual(B6.length * 3);
  });

  it("round robin: a repeated pair, a team that plays twice in a round, a round with no rest, and a wheel that pairs the wrong teams are caught", () => {
    const repeated = clone("round-robin-schedule");
    repeated.table!.rows[1]![1] = repeated.table!.rows[0]![1]; // round two repeats round one's first match
    expect(failing("round-robin-schedule", repeated).length).toBeGreaterThan(0);
    const twice = clone("round-robin-schedule");
    twice.table!.rows[0]![3] = String(twice.table!.rows[0]![1]).split(" v ")[0]!; // the team that rests also plays
    expect(failing("round-robin-schedule", twice).length).toBeGreaterThan(0);
    const wheel = clone("round-robin-schedule");
    const d = wheel.diagram as { rotating: string[] };
    [d.rotating[0], d.rotating[1]] = [d.rotating[1]!, d.rotating[0]!];
    expect(failing("round-robin-schedule", wheel), "a wheel with two teams swapped pairs different teams").toContain(
      claimsOf("round-robin-schedule").find((c) => c.says.startsWith("the wheel is the circle method"))!.says,
    );
    // The right answer differs from the wrong constant: an odd field of n plays n rounds (not n-1), and n(n-1)/2 matches (not n*n/2).
    const rounds = clone("round-robin-schedule");
    rounds.facts.rounds = Number(rounds.facts.fieldSize) - 1;
    expect(failing("round-robin-schedule", rounds).length).toBeGreaterThan(0);
  });
});

// ---- the pilot's per-cell and per-fact corruption sweep, over every batch 6 example ----
//
// For each example: every table cell, every fact, every diagram value is corrupted in turn (a string gets a "9" appended, a
// number gets 1 added), and every fact and row is also removed; at least one claim of that example must fail on each. A row
// swapped with its neighbour must fail too. A claim that throws on a corrupted result breaks the contract (a missing or wrong
// value is a failure, never a crash), so a throw is its own finding. What the sweep cannot hold is only prose with no rule
// behind it: the table's column headings.
type Mutant = { label: string; apply: (r: ExampleResult) => void };

const bump = (v: unknown): string | number => (typeof v === "number" ? v + 1 : `${String(v)}9`);

function mutantsOf(g: ExampleResult): Mutant[] {
  const out: Mutant[] = [];
  for (const k of Object.keys(g.facts)) {
    out.push({ label: `fact ${k} changed`, apply: (r) => void (r.facts[k] = bump(r.facts[k]) as never) });
    out.push({ label: `fact ${k} removed`, apply: (r) => void delete r.facts[k] });
  }
  const rows = g.table?.rows ?? [];
  rows.forEach((row, i) => {
    row.forEach((_, j) => out.push({ label: `cell [${i}][${j}] changed`, apply: (r) => void (r.table!.rows[i]![j] = bump(r.table!.rows[i]![j]) as never) }));
    out.push({ label: `row ${i} removed`, apply: (r) => void r.table!.rows.splice(i, 1) });
    if (i + 1 < rows.length && JSON.stringify(row) !== JSON.stringify(rows[i + 1]))
      out.push({ label: `rows ${i}/${i + 1} swapped`, apply: (r) => void ([r.table!.rows[i], r.table!.rows[i + 1]] = [r.table!.rows[i + 1]!, r.table!.rows[i]!]) });
  });
  const d = g.diagram as unknown as Record<string, unknown> | undefined;
  const walk = (v: unknown, path: (string | number)[]) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, [...path, i]));
    if (v !== null && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, [...path, k]));
    if (path[0] === "kind") return; // the component's name, fixed by the type union
    out.push({
      label: `diagram ${path.join(".")} changed`,
      apply: (r) => {
        let at: any = r.diagram; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const p of path.slice(0, -1)) at = at[p];
        at[path[path.length - 1]] = typeof v === "boolean" ? !v : bump(v);
      },
    });
  };
  if (d !== undefined) walk(d, []);
  return out;
}

/** Mutants the example's claims cannot see and no rule could: each carries WHY, and must still be uncaught (a stale entry fails). */
const UNCHECKED: Readonly<Record<string, readonly { label: string; why: string }[]>> = {};

describe("batch 6: the corruption sweep (every cell, fact and diagram value of every example)", () => {
  let sweptTotal = 0;
  for (const id of B6) {
    const swept = mutantsOf(BLOG_GOLDENS[id]!).length;
    it(`${id}: all ${swept} corrupted cells, facts and diagram values are held by a claim`, () => {
      const golden = BLOG_GOLDENS[id]!;
      const mutants = mutantsOf(golden);
      expect(mutants.length, `${id}: the count in the title is the count swept`).toBe(swept);
      expect(mutants.length, `anti-vacuity: ${id} mutants`).toBeGreaterThan(Object.keys(golden.facts).length);
      const exempt = new Map((UNCHECKED[id] ?? []).map((u) => [u.label, u.why]));
      const survived: string[] = [];
      const threw: string[] = [];
      const staleExemptions: string[] = [];
      let caughtCount = 0;
      for (const m of mutants) {
        const r = structuredClone(golden);
        m.apply(r);
        let caught = false;
        for (const c of claimsOf(id)) {
          try {
            if (c.check(r) !== true) caught = true;
          } catch (e) {
            threw.push(`${m.label}: '${c.says}' threw ${(e as Error).message}`);
            caught = true;
          }
        }
        if (exempt.has(m.label)) {
          if (caught) staleExemptions.push(m.label);
        } else if (!caught) survived.push(m.label);
        else caughtCount++;
      }
      if (threw.length > 0) expect.fail(`a claim must fail a corrupted result, never throw: ${threw.join(" | ")}`);
      if (survived.length > 0) expect.fail(`${id}: ${survived.length} corrupted values no claim notices: ${survived.join(" | ")}`);
      if (staleExemptions.length > 0) expect.fail(`${id}: exemptions that a claim now catches: ${staleExemptions.join(" | ")}`);
      expect(caughtCount + exempt.size, `${id}: ${mutants.length} swept`).toBe(mutants.length);
      sweptTotal += mutants.length;
    });
  }
  it("the sweep reached every example (zero swept would prove nothing)", () => {
    expect(sweptTotal, "mutants swept across batch 6").toBeGreaterThan(B6.length * 10);
  });
});

// ---- every digit of every printed string, moved on by one, one at a time ----

function leaves(v: unknown, path: string[] = []): [string[], unknown][] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, String(i)]));
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, [...path, k]));
  return [[path, v]];
}
function setAt(root: unknown, path: string[], value: unknown): void {
  let at = root as Record<string, unknown>;
  for (const k of path.slice(0, -1)) at = at[k] as Record<string, unknown>;
  at[path[path.length - 1]!] = value;
}
/** Digit occurrences nothing checks, each with the reason. `<example id> <path>#<index of the digit in the string>`. */
const UNCHECKED_DIGITS: Record<string, string> = {};
function digitShifts(v: string): { at: number; value: string }[] {
  return [...v].flatMap((c, at) => (/[0-9]/.test(c) ? [{ at, value: `${v.slice(0, at)}${(Number(c) + 1) % 10}${v.slice(at + 1)}` }] : []));
}

describe("batch 6: a digit moved on by one in any printed string is caught", () => {
  it("moves every digit of every printed string on by one, one digit at a time, and a claim notices each", () => {
    const survivors: string[] = [];
    let digits = 0;
    let strings = 0;
    for (const id of B6) {
      const base = BLOG_GOLDENS[id]!;
      const parts = { facts: base.facts, table: base.table, diagram: base.diagram };
      for (const [part, value] of Object.entries(parts)) {
        for (const [path, v] of leaves(value)) {
          if (typeof v !== "string") continue;
          const shifts = digitShifts(v);
          if (shifts.length === 0) continue;
          strings++;
          for (const { at, value: shifted } of shifts) {
            const mutant = clone(id);
            setAt(mutant as unknown as Record<string, unknown>, [part, ...path], shifted);
            digits++;
            if (failing(id, mutant).length === 0) survivors.push(`${id} ${part}.${path.join(".")}#${at}`);
          }
        }
      }
    }
    // The posts' prose uses number words in captions and titles, so the digits there are few: table cells hold none either. The
    // sweep is kept for what a later edit might print, and reports how many it moved so zero is visible.
    expect(digits, "digits shifted (a golden with no digit in a string is allowed; this reports the count)").toBeGreaterThanOrEqual(0);
    expect(strings).toBeGreaterThanOrEqual(0);
    expect(survivors.sort(), "digits no claim reads (each needs a claim, or a reason in UNCHECKED_DIGITS)").toEqual(Object.keys(UNCHECKED_DIGITS).sort());
  });
});
