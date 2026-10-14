// scripts/__tests__/test-parity.test.ts
import { describe, expect, it } from "vitest";
import { diffIds, testIds } from "../test-parity.mjs";

type T = { path: string[]; status?: string };
const report = (root: string, files: Record<string, T[]>) => ({
  numTotalTests: Object.values(files).reduce((n, t) => n + t.length, 0),
  testResults: Object.entries(files).map(([name, tests]) => ({
    name: `${root}/${name}`,
    assertionResults: tests.map(({ path, status = "skipped" }) => ({ ancestorTitles: path.slice(0, -1), title: path.at(-1)!, status })),
  })),
});

describe("test-parity", () => {
  it("names a test by root-relative file, describe chain and title", () => {
    const r = report("/x/packages/engine", { "src/a.test.ts": [{ path: ["A", "b"] }] });
    expect(testIds(r, "/x/packages/engine")).toEqual(["src/a.test.ts › A › b"]);
  });

  it("keeps a test that is skipped in its own file (it.skip / skipIf), not only filter-skipped ones", () => {
    const r = report("/x", { "a.test.ts": [{ path: ["live"], status: "skipped" }, { path: ["todo"], status: "todo" }] });
    expect(testIds(r, "/x")).toEqual(["a.test.ts › live", "a.test.ts › todo"]);
  });

  it("reports nothing unaccounted when both sides hold the same ids under different roots", () => {
    const a = testIds(report("/mono/packages/engine", { "t.test.ts": [{ path: ["x"] }] }), "/mono/packages/engine");
    const b = testIds(report("/engine", { "t.test.ts": [{ path: ["x"] }] }), "/engine");
    expect(diffIds(a, b, { entries: [] }).unaccounted).toEqual([]);
  });

  it("flags an id that vanished without a ledger entry", () => {
    expect(diffIds(["f › a", "f › b"], ["f › a"], { entries: [] }).unaccounted).toEqual(["f › b"]);
  });

  it("accepts a rehome whose target exists after, and only that one", () => {
    const ledger = { entries: [{ id: "f › b", fate: "rehomed" as const, to: "g › b", reason: "reads apps/web" }] };
    expect(diffIds(["f › a", "f › b", "f › c"], ["f › a", "g › b"], ledger).unaccounted).toEqual(["f › c"]);
  });

  it("refuses a rehome whose target does not exist after (a deleted test passing as moved)", () => {
    const ledger = { entries: [{ id: "f › b", fate: "rehomed" as const, to: "g › b", reason: "x" }] };
    expect(diffIds(["f › b"], [], ledger).unaccounted).toEqual(["f › b", "LEDGER-TARGET-MISSING g › b"]);
  });

  it("flags an id that appeared from nowhere, and accepts it as `added`", () => {
    expect(diffIds(["f › a"], ["f › a", "f › new"], { entries: [] }).unaccounted).toEqual(["f › new"]);
    expect(diffIds(["f › a"], ["f › a", "f › new"], { entries: [{ id: "f › new", fate: "added", reason: "new guard" }] }).unaccounted).toEqual([]);
  });

  it("refuses an empty report rather than passing it", () => {
    expect(() => testIds({ numTotalTests: 0, testResults: [] }, "/x")).toThrow(/zero tests/);
  });
});
