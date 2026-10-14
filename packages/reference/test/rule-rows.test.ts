// rule-rows.ts reads the engine's rule tables through the published testkit (engine-split 1d review M1). Three things to hold:
// it hands back what the testkit parsed (not a second parse), it strips `.md` from the file name, and it refuses to answer from nothing.
import { allRows } from "@seazn/engine/testkit";
import { describe, expect, it } from "vitest";
import { readRuleRows, rowById } from "./rule-rows.ts";

describe("rule-rows reads the engine's rules through the testkit", () => {
  it("answers one row per testkit row, in order, with the file name minus `.md` (the real tables)", () => {
    const real = allRows();
    const rows = readRuleRows();
    expect(real.length, "rows the testkit parsed").toBeGreaterThan(0);
    expect(rows.map((r) => r.id)).toEqual(real.map((r) => r.id));
    expect(rows.map((r) => r.file)).toEqual(real.map((r) => r.file.replace(/\.md$/, "")));
    expect(rows.every((r) => !r.file.includes("."))).toBe(true);
    expect(rowById(rows, "X-BR-1").rule.length).toBeGreaterThan(0); // a row the families read by id is there
  });

  it("a stubbed reader is mapped the same way, and its status and rule text pass through untouched", () => {
    const rows = readRuleRows(() => [{ id: "ZZ-AA-1", rule: "a rule", status: "signed 1 2026-01-01", file: "zz.md" }]);
    expect(rows).toEqual([{ id: "ZZ-AA-1", rule: "a rule", status: "signed 1 2026-01-01", file: "zz" }]);
  });

  it("empty case: a reader that finds no row is a refusal, not an empty answer", () => {
    expect(() => readRuleRows(() => [])).toThrow(/read no rule row/);
  });
});
