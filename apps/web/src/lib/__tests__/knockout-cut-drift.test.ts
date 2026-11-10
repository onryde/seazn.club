import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { StageKind } from "@seazn/engine/core";
import {
  KNOCKOUT_CUT_DRIFT_PLURAL_KEY,
  knockoutCutDrift,
  knockoutCutDriftOf,
  knockoutCutDriftStageIds,
  knockoutCutDriftText,
  type KnockoutCutDrift,
} from "@/lib/knockout-cut-drift";

// W4 T14 (X-QM-4, RB4-Q5) — the pure half of the desk warning. The server reads the inputs (`getKnockoutCutDrift`, proven on
// Postgres in knockout-source-correction.test.ts); this proves what is done with them, EMPTY CASE FIRST.

describe("knockoutCutDrift — who a correction moved across the line", () => {
  it("nothing frozen, or nothing started: no warning", () => {
    expect(knockoutCutDrift([], ["a"], true)).toBeNull();
    expect(knockoutCutDrift(["a", "b"], ["a", "c"], false)).toBeNull();
  });

  it("the same people in another order: no warning (a flipped final moves nobody across the line)", () => {
    expect(knockoutCutDrift(["a", "b"], ["b", "a"], true)).toBeNull();
  });

  it("nobody out: no warning (a departed qualifier's place is no correction; the sentence needs someone to replace)", () => {
    expect(knockoutCutDrift(["a", "b", "c"], ["a", "b", "c", "e"], true)).toBeNull();
  });

  it("names who is out and who is in, in the order handed in", () => {
    expect(knockoutCutDrift(["a", "b", "c", "d"], ["a", "b", "c", "e"], true)).toEqual({ out: ["d"], in: ["e"] });
  });
});

describe("knockoutCutDriftOf / knockoutCutDriftStageIds — one predicate for the warning and for the attention list", () => {
  const drift: KnockoutCutDrift = { out: ["c"], in: ["d"] };
  const ko = { id: "k1", kind: "knockout" };

  it("nothing supplied: no warning and no attention", () => {
    expect(knockoutCutDriftOf(ko, true, undefined)).toBeNull();
    expect(knockoutCutDriftOf(ko, true, {})).toBeNull();
    expect(knockoutCutDriftStageIds([ko], true, undefined)).toEqual([]);
    expect(knockoutCutDriftStageIds([], true, { k1: drift })).toEqual([]);
  });

  it("an organiser's knockout carries it; a viewer does not", () => {
    expect(knockoutCutDriftOf(ko, true, { k1: drift })).toEqual(drift);
    expect(knockoutCutDriftOf(ko, false, { k1: drift })).toBeNull();
    expect(knockoutCutDriftStageIds([ko], false, { k1: drift })).toEqual([]);
  });

  it("every other stage kind never carries it, whatever the map holds (swept off the engine's own kinds)", () => {
    const others = StageKind.options.filter((k) => k !== "knockout");
    expect(others.length, "anti-vacuity: the engine declares other kinds").toBeGreaterThan(0);
    for (const kind of others) {
      expect(knockoutCutDriftOf({ id: "k1", kind }, true, { k1: drift }), kind).toBeNull();
    }
  });

  it("the attention list is exactly the stages that carry it, in the order handed in", () => {
    const stages = [{ id: "a", kind: "knockout" }, { id: "s", kind: "swiss" }, { id: "b", kind: "knockout" }, { id: "c", kind: "knockout" }];
    expect(knockoutCutDriftStageIds(stages, true, { c: drift, a: drift, s: drift })).toEqual(["a", "c"]);
  });
});

describe("knockoutCutDriftText", () => {
  const plural = (key: string, count: number, vars?: Record<string, string | number>) => `${key}|${count}|${vars?.in}|${vars?.out}`;

  it("says the names with the locale's own conjunction, counting who comes in; an unknown id reads '?', never the id", () => {
    const names = { a: "Ana", b: "Bo", c: "Cy" };
    expect(knockoutCutDriftText({ out: ["c"], in: ["a", "b"] }, names, "en", plural)).toBe(`${KNOCKOUT_CUT_DRIFT_PLURAL_KEY}|2|Ana and Bo|Cy`);
    expect(knockoutCutDriftText({ out: ["c"], in: ["a", "b"] }, names, "fr", plural)).toBe(`${KNOCKOUT_CUT_DRIFT_PLURAL_KEY}|2|Ana et Bo|Cy`);
    expect(knockoutCutDriftText({ out: ["zz"], in: ["a"] }, names, "en", plural)).toBe(`${KNOCKOUT_CUT_DRIFT_PLURAL_KEY}|1|Ana|?`);
  });

  it("every locale declares both plural forms, naming both lists", () => {
    const locales = ["en", "es", "fr", "nl"];
    let checked = 0;
    for (const locale of locales) {
      const dict = JSON.parse(readFileSync(resolve(process.cwd(), `src/dictionaries/${locale}/ui.json`), "utf8")) as Record<string, string>;
      for (const form of ["one", "other"]) {
        const value = dict[`${KNOCKOUT_CUT_DRIFT_PLURAL_KEY}.${form}`];
        expect(value, `${locale}.${form}`).toBeTruthy();
        expect(value, `${locale}.${form} names who comes in`).toContain("{in}");
        expect(value, `${locale}.${form} names who goes out`).toContain("{out}");
        checked++;
      }
    }
    expect(checked, "anti-vacuity: four locales, two forms").toBe(8);
  });
});
