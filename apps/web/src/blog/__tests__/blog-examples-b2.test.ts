// Blog batch 2 (tie-breaks, posts #7 to #12): the claims of each example have teeth. Every table CELL (one at a time, not a
// column at a time: a column passes when any one of its rows is caught, which hides the rows nothing reads), every fact a
// post can print, and each table's caption is corrupted, and some claim of that example must then fail. What no claim covers
// is listed by name below, with the reason, so a new uncovered cell is a red rather than a silent gap.
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { defaultOrderOf, forEachSport } from "@seazn/engine/testkit";
import { BLOG_EXAMPLES } from "@/blog/examples";
import { BLOG_GOLDENS } from "@/blog/examples/goldens";
import { C } from "@/blog/examples/set-ratio-or-difference";
import { threeWayPhrases } from "@/blog/examples/three-way-tie";
import type { ExampleResult } from "@/blog/examples/types";

const BATCH_2 = ["level-on-points", "three-way-tie", "net-run-rate", "set-ratio-or-difference", "buchholz-sonneborn-berger", "buchholz-bye", "drawing-lots"];

/**
 * Cells and facts no claim reads, by example: `cell:<column>:<row's first cell>` or `fact:<key>`. Each is either copy (a name,
 * a label the table repeats from a claimed cell) or a figure the post never prints.
 */
const UNCLAIMED: Record<string, readonly string[]> = {
  "level-on-points": [],
  "three-way-tie": [],
  "net-run-rate": [],
  "set-ratio-or-difference": [],
  "buchholz-sonneborn-berger": [],
  "buchholz-bye": [],
  "drawing-lots": [],
};

const clone = (r: ExampleResult): ExampleResult => JSON.parse(JSON.stringify(r)) as ExampleResult;
const fails = (id: string, r: ExampleResult) => BLOG_EXAMPLES.find((e) => e.id === id)!.claims.some((c) => c.check(r) !== true);

/** A wrong value of the same shape: another row's value in that column where one differs, else a plainly wrong one. */
function wrong(value: unknown, others: unknown[]): unknown {
  const other = others.find((o) => o !== value && String(o) !== String(value));
  if (other !== undefined) return other;
  if (typeof value === "number") return value + 7;
  return `${String(value)}?wrong`;
}

/** A value's shape: its type and its text with digits masked and an ordinal suffix folded ("1st" and "3rd" match; "+1" and "+4" match). */
const shape = (v: unknown) => `${typeof v}:${String(v).replace(/\d+/g, "#").replace(/(st|nd|rd|th)$/, "~")}`;
/** The other facts of the same shape, so a corrupted fact is a plausible wrong value (another place, another score). */
const sameShape = (v: unknown, all: unknown[]) => all.filter((o) => shape(o) === shape(v));

describe("blog batch 2: every example is registered with a golden", () => {
  it("the seven batch 2 examples are registered, each with a golden", () => {
    for (const id of BATCH_2) {
      expect(BLOG_EXAMPLES.some((e) => e.id === id), id).toBe(true);
      expect(BLOG_GOLDENS[id], id).toBeDefined();
    }
    expect(BATCH_2.length).toBe(7);
  });

  it("the per-sport examples sweep the whole registry", () => {
    const visited = forEachSport(() => {});
    expect(visited).toBe(builtinModules.length);
    let checked = 0;
    for (const id of ["level-on-points", "three-way-tie", "set-ratio-or-difference", "buchholz-sonneborn-berger", "drawing-lots"]) {
      const e = BLOG_EXAMPLES.find((x) => x.id === id)!;
      const sports = new Set(e.claims.map((c) => c.sport).filter((s) => s !== undefined));
      expect(sports.size, `${id}: sports with a claim`).toBe(visited);
      expect(BLOG_GOLDENS[id]!.facts.sportCount, `${id}: sportCount`).toBe(visited);
      checked++;
    }
    expect(checked).toBe(5);
  });
});

describe("blog batch 2: the claims have teeth", () => {
  for (const id of BATCH_2) {
    it(`${id}: the golden passes, and corrupting any cell, fact or the caption fails a claim`, () => {
      const golden = BLOG_GOLDENS[id]!;
      expect(fails(id, golden), `${id}: the golden itself passes`).toBe(false);
      const uncaught: string[] = [];
      let checked = 0;
      const table = golden.table!;
      for (let col = 0; col < table.columns.length; col++) {
        for (let row = 0; row < table.rows.length; row++) {
          const bad = clone(golden);
          bad.table!.rows[row]![col] = wrong(table.rows[row]![col], table.rows.map((x) => x[col])) as string | number;
          checked++;
          if (!fails(id, bad)) uncaught.push(`cell:${table.columns[col]}:${String(table.rows[row]![0])}`);
        }
      }
      // The caption: a figure or a name in it that the table does not say is a claim the table cannot back.
      expect(table.caption.length, `${id}: the golden has a caption`).toBeGreaterThan(20);
      const badCaption = clone(golden);
      badCaption.table!.caption = `${table.caption} (and a team that is not in it)`;
      checked++;
      if (!fails(id, badCaption)) uncaught.push("caption");
      for (const key of Object.keys(golden.facts)) {
        const bad = clone(golden);
        bad.facts[key] = wrong(golden.facts[key], sameShape(golden.facts[key], Object.values(golden.facts))) as string | number;
        checked++;
        if (!fails(id, bad)) uncaught.push(`fact:${key}`);
      }
      expect(checked, `${id}: corruptions tried`).toBeGreaterThan(table.columns.length * table.rows.length);
      expect(uncaught.sort(), `${id}: cells and facts no claim reads`).toEqual([...UNCLAIMED[id]!].sort());
    });
  }
});

describe("blog batch 2: the guards inside the claims are reached", () => {
  it("net-run-rate: an example in which no innings ends early cannot witness the all-out rule, and the claim says so", () => {
    const golden = BLOG_GOLDENS["net-run-rate"]!;
    const claim = BLOG_EXAMPLES.find((e) => e.id === "net-run-rate")!.claims.find((c) => c.says.startsWith("a side bowled out counts"))!;
    expect(claim.check(golden), "the golden passes this claim").toBe(true);
    // Every innings written with wickets in hand and none ending early: nobody was bowled out, so the all-out rule is unseen.
    const noAllOut = clone(golden);
    noAllOut.facts.tigersBeatLions = "114/7 (20) — 113/9 (20)";
    noAllOut.facts.bearsBeatTigers = "105/9 (20) — 42/9 (20)";
    expect(String(claim.check(noAllOut))).toContain("not witnessed");
    // A side bowled out early but no chase that ends early: the rule that a chase counts the overs it used is unseen.
    const noEarlyChase = clone(golden);
    noEarlyChase.facts.tigersBeatLions = "114/7 (20) — 113 (12)";
    expect(String(claim.check(noEarlyChase))).toContain("not witnessed");
  });

  it("set-ratio-or-difference: a table whose place columns list the players alphabetically fails the guard claim", () => {
    const golden = BLOG_GOLDENS["set-ratio-or-difference"]!;
    const claim = BLOG_EXAMPLES.find((e) => e.id === "set-ratio-or-difference")!.claims.find((c) => c.says.startsWith("neither place column"))!;
    expect(claim.check(golden), "the golden passes this claim").toBe(true);
    // Rename the players so that, in each place column, the order of the places is the order of the alphabet: the same table, but one
    // an alphabetical sort would also pass. The claim must refuse it, in either column.
    for (const col of [C.own, C.ratioOrder]) {
      const bad = clone(golden);
      const rows = [...bad.table!.rows].sort((a, b) => Number(String(a[col]).replace(/\D+/g, "")) - Number(String(b[col]).replace(/\D+/g, "")));
      rows.forEach((row, i) => {
        row[C.player] = ["Ana", "Ben", "Cy", "Dev"][i]!;
      });
      expect(String(claim.check(bad)), `column ${col}`).toContain("alphabetical");
    }
  });

  it("three-way-tie: a fact that names the wrong shape of head-to-head fails the sport's claim, for every sport", () => {
    const golden = BLOG_GOLDENS["three-way-tie"]!;
    const claims = BLOG_EXAMPLES.find((e) => e.id === "three-way-tie")!.claims.filter((c) => c.says.endsWith("the three-way words describe the sport's declared league order"));
    expect(claims.length, "anti-vacuity: one such claim per sport").toBe(builtinModules.length);
    let checked = 0;
    for (const c of claims) {
      const key = `${c.sport}ThreeWay`;
      expect(c.check(golden), `${key}: the golden passes`).toBe(true);
      for (const swap of ["re-applied to any smaller group it leaves level", "head-to-head only between two", "a direct encounter: the points each tied player scored against the others", "started again among only those still level"]) {
        if (String(golden.facts[key]).includes(swap)) continue;
        const bad = clone(golden);
        bad.facts[key] = swap;
        expect(c.check(bad), `${key} = '${swap}'`).not.toBe(true);
        checked++;
      }
      // Each half of the claim alone: a phrase the declared order needs is missing, and a phrase it does not do is added.
      const { has, lacks } = threeWayPhrases(defaultOrderOf(builtinModules.find((m) => m.key === c.sport)!, "league"), c.sport!);
      expect(has.length, `${key}: phrases the order needs`).toBeGreaterThan(0);
      expect(lacks.length, `${key}: phrases the order does not do`).toBeGreaterThan(0);
      for (const p of has) {
        const missing = clone(golden);
        missing.facts[key] = String(golden.facts[key]).replace(p, "x");
        expect(c.check(missing), `${key} without '${p}'`).not.toBe(true);
        checked++;
      }
      for (const p of lacks) {
        const extra = clone(golden);
        extra.facts[key] = `${String(golden.facts[key])} ${p}`;
        expect(c.check(extra), `${key} plus '${p}'`).not.toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(builtinModules.length * 3);
  });
});
