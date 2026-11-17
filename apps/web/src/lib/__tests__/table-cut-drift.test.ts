import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import {
  TABLE_CUT_DRIFT_KINDS,
  TABLE_CUT_DRIFT_PLURAL_KEY,
  tableCutDrift,
  tableCutDriftOf,
  tableCutDriftStageIds,
  tableCutDriftText,
  type TableCutDrift,
} from "@/lib/table-cut-drift";

// W5 Task 11 (X-CUT-4 <- RB5-K6, the table half of FX-G16) - the pure half of the desk warning "a correction in a completed league
// or group after the knockout it feeds started: the bracket stands, the desk warns". The server reads the inputs
// (`getTableCutDrift`, proven on Postgres in table-source-correction.test.ts); this proves what is done with them, EMPTY CASE
// FIRST.

describe("X-CUT-4 tableCutDrift - who a correction moved across the line", () => {
  it("drift is null with no difference: nothing frozen, nothing started, the same people, nobody out, nobody in", () => {
    expect(tableCutDrift([], ["a"], true), "empty frozen cut").toBeNull();
    expect(tableCutDrift(["a", "b"], ["a", "c"], false), "destination not started").toBeNull();
    expect(tableCutDrift(["a", "b"], ["b", "a"], true), "same people, another order").toBeNull();
    expect(tableCutDrift(["a", "b", "c"], ["a", "b", "c", "e"], true), "nobody out").toBeNull();
    expect(tableCutDrift(["a", "b", "c"], ["a", "b"], true), "nobody in").toBeNull();
  });

  it("names who is out and who is in, in the order handed in", () => {
    expect(tableCutDrift(["a", "b", "c", "d"], ["a", "b", "c", "e"], true)).toEqual({ out: ["d"], in: ["e"] });
  });
});

describe("X-CUT-4 tableCutDriftOf / tableCutDriftStageIds - one predicate for the warning and for the attention list", () => {
  const drift: TableCutDrift = { out: ["c"], in: ["d"] };

  it("only a league or a group carries it, swept off the engine's own stage kinds", () => {
    expect([...TABLE_CUT_DRIFT_KINDS].sort()).toEqual(["group", "league"]);
    let carried = 0;
    let refused = 0;
    for (const kind of StageKind.options) {
      const got = tableCutDriftOf({ id: "s1", kind }, true, { s1: drift });
      if (TABLE_CUT_DRIFT_KINDS.has(kind)) {
        expect(got, kind).toEqual(drift);
        carried++;
      } else {
        expect(got, kind).toBeNull();
        refused++;
      }
    }
    expect(carried, "anti-vacuity: both kinds were checked").toBe(2);
    expect(refused, "anti-vacuity: the other kinds were checked").toBeGreaterThan(0);
  });

  it("nothing supplied, nothing for this stage, or a viewer: no warning and no attention", () => {
    const league = { id: "s1", kind: "league" };
    expect(tableCutDriftOf(league, true, undefined)).toBeNull();
    expect(tableCutDriftOf(league, true, {})).toBeNull();
    expect(tableCutDriftOf(league, true, { other: drift })).toBeNull();
    expect(tableCutDriftOf(league, false, { s1: drift })).toBeNull();
    expect(tableCutDriftStageIds([league], false, { s1: drift })).toEqual([]);
    expect(tableCutDriftStageIds([], true, { s1: drift })).toEqual([]);
  });

  it("the attention list is exactly the stages that carry it, in the order handed in", () => {
    const stages = [
      { id: "a", kind: "league" },
      { id: "k", kind: "knockout" },
      { id: "b", kind: "group" },
      { id: "c", kind: "league" },
    ];
    expect(tableCutDriftStageIds(stages, true, { c: drift, a: drift, k: drift })).toEqual(["a", "c"]);
  });
});

describe("X-CUT-4 tableCutDriftText", () => {
  const plural = (key: string, count: number, vars?: Record<string, string | number>) => `${key}|${count}|${vars?.in}|${vars?.out}`;

  it("says the names with the locale's own conjunction, counting who comes in; an unknown id reads '?', never the id", () => {
    const names = { a: "Ana", b: "Bo", c: "Cy" };
    expect(tableCutDriftText({ out: ["c"], in: ["a", "b"] }, names, "en", plural)).toBe(`${TABLE_CUT_DRIFT_PLURAL_KEY}|2|Ana and Bo|Cy`);
    expect(tableCutDriftText({ out: ["c"], in: ["a", "b"] }, names, "fr", plural)).toBe(`${TABLE_CUT_DRIFT_PLURAL_KEY}|2|Ana et Bo|Cy`);
    expect(tableCutDriftText({ out: ["zz"], in: ["a"] }, names, "en", plural)).toBe(`${TABLE_CUT_DRIFT_PLURAL_KEY}|1|Ana|?`);
  });

  it("every locale declares both plural forms, naming both lists", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"]) {
      const dict = JSON.parse(readFileSync(resolve(process.cwd(), `src/dictionaries/${locale}/ui.json`), "utf8")) as Record<string, string>;
      for (const form of ["one", "other"]) {
        const value = dict[`${TABLE_CUT_DRIFT_PLURAL_KEY}.${form}`];
        expect(value, `${locale}.${form}`).toBeTruthy();
        expect(value, `${locale}.${form} names who comes in`).toContain("{in}");
        expect(value, `${locale}.${form} names who goes out`).toContain("{out}");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: four locales, two forms").toBe(8);
  });
});
