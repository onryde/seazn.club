// `--entry` end to end: CLI -> runSuite -> runTinySuite, and CLI -> the
// written report's `entryMode`.
//
// This file exists because both halves of that flag shipped separately, were
// typed, and were unit green, while NOTHING joined them. `bench.ts` parsed
// `--entry` into `BenchConfig` (task 6); `runTinySuite` accepted `cliEntry`
// and resolved it (task 9); `report.ts:306` gated "Registration at volume" on
// `report.entryMode`. The two forwarding lines in between did not exist, so a
// `--entry registration` run took each division's own declared `entry`
// regardless, and the report's volume section could never render. That is the
// inert seam — AGENTS.md recurring failure class 1 — and no existing test
// could see it, because every test on either side supplied `cliEntry` itself.
//
// Lives in its own file rather than in `bench-cli.test.ts` because it must
// mock `../suites/tiny.ts`, and that file's own sentinel test needs the REAL
// `runTinySuite` to prove the sql/transport forward.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuiteReport } from "../report.ts";

const seen: { cliEntry?: unknown; called: number } = { called: 0 };

function emptySuiteReport(): SuiteReport {
  return { key: "_tiny", gate: "green", steps: [] } as unknown as SuiteReport;
}

vi.mock("../suites/tiny.ts", () => ({
  // B06a: `lib/suites/registry.ts` imports the pack path alongside the runner,
  // so a mock of this module owes both exports — a partial mock now fails
  // collection rather than one test.
  TINY_PACK_PATH: "/fake/packs/_tiny.json",
  runTinySuite: vi.fn(async (input: { cliEntry?: unknown }) => {
    seen.called += 1;
    seen.cliEntry = "cliEntry" in input ? input.cliEntry : "__ABSENT__";
    return emptySuiteReport();
  }),
}));

const { parseCliArgs, runSuite } = await import("../../bench.ts");

function config(argv: string[]) {
  return parseCliArgs(["--suite", "_tiny", "--base", "http://bench.example", "--wipe", ...argv]);
}

const stubSql = {} as Parameters<typeof runSuite>[2];

describe("--entry reaches runTinySuite (the forward that did not exist)", () => {
  beforeEach(() => {
    seen.called = 0;
    seen.cliEntry = undefined;
  });

  // The two values are asserted separately rather than as "some value came
  // through", so a forward hardcoded to one constant cannot pass. Reachability
  // is satisfied by ANY value; this pins WHICH.
  it.each([
    ["registration", "registration"],
    ["admin", "admin"],
  ])("--entry %s arrives at runTinySuite as cliEntry=%s", async (flag, expected) => {
    await runSuite("_tiny", config(["--entry", flag]), stubSql);
    expect(seen.called, "runTinySuite was never called").toBe(1);
    expect(seen.cliEntry).toBe(expected);
  });

  // The negative half. Without it, a forward that always passed
  // `cliEntry: "registration"` would satisfy one of the cases above and change
  // the meaning of every run that did not ask for it.
  it("no --entry flag forwards NO cliEntry, so each division keeps its declared entry", async () => {
    await runSuite("_tiny", config([]), stubSql);
    expect(seen.called).toBe(1);
    expect(seen.cliEntry).toBe("__ABSENT__");
  });
});
