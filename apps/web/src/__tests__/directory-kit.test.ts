import { describe, it, expect } from "vitest";
import { participantCsv, uniqueName } from "../../e2e/directory-kit";

// The kit under test lives at `e2e/directory-kit.ts`; this test does NOT.
//
// The task brief asked for `e2e/__tests__/directory-kit.test.ts`. Measured on
// this tree, that path is collected by NEITHER runner and breaks one of them:
//
//   * vitest.config.ts excludes `e2e/**` outright ("Playwright specs (e2e/)
//     run under `playwright test`, not vitest"), so `npx vitest run
//     e2e/__tests__/directory-kit.test.ts` reported
//     numTotalTestSuites 0 / numTotalTests 0 — no collection failure to see,
//     just nothing collected, exit 1.
//   * Playwright's `parallel` project carries no explicit testMatch, so its
//     DEFAULT one (`**/*.@(spec|test).?(c|m)[jt]s?(x)`) matches a `.test.ts`
//     anywhere under `testDir: "./e2e"`. `npx playwright test --list` then
//     tried to load this file as a spec and aborted the entire listing with
//     `Total: 0 tests in 0 files` — every project, not just walkthrough. Once
//     the kit existed it would have failed one step later instead, on
//     `import ... from "vitest"` outside a vitest process.
//
// So the file moved to where vitest already collects. The kit itself stays at
// `e2e/` (importable from both, selected as a spec by neither) — importing
// across the boundary is fine, since vitest's `exclude` governs which files
// are COLLECTED as tests, not which may be imported.

describe("participantCsv", () => {
  it("emits a header row the importer recognises", () => {
    const csv = participantCsv([{ club: "Harbour", team: "Harbour U13", player: "Ada" }]);
    expect(csv.split("\n")[0]).toBe("Club,Team,Player");
  });

  it("emits one row per entry and no trailing newline", () => {
    const csv = participantCsv([
      { club: "A", team: "A1", player: "P1" },
      { club: "B", team: "B1", player: "P2" },
    ]);
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv.endsWith("\n")).toBe(false);
  });

  // A club name carrying a comma must not become two columns. Without quoting,
  // "Harbour, West" shifts Team into Player and the import silently plans the
  // wrong entities rather than failing.
  it("quotes a field containing a comma", () => {
    const csv = participantCsv([{ club: "Harbour, West", team: "T", player: "P" }]);
    expect(csv.split("\n")[1]).toBe('"Harbour, West",T,P');
  });

  it("escapes an embedded double quote by doubling it", () => {
    const csv = participantCsv([{ club: 'The "Reds"', team: "T", player: "P" }]);
    expect(csv.split("\n")[1]).toBe('"The ""Reds""",T,P');
  });
});

describe("uniqueName", () => {
  it("keeps the label as a prefix so a spec can still read the row", () => {
    expect(uniqueName("Court A")).toMatch(/^Court A /);
  });

  // Two calls in the same process must not collide: every count in these specs
  // is scoped by this string.
  it("does not repeat across calls", () => {
    const seen = new Set(Array.from({ length: 200 }, () => uniqueName("x")));
    expect(seen.size).toBe(200);
  });
});
