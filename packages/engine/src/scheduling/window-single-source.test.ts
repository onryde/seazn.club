// P9.5 (D5b.5) — the anti-fork guard.
//
// "One function, both sides" was asserted about window handling once already
// and was not true: `_RULES.md` §3 and the portfolio `_INDEX.md` both claimed
// `usableWindows`/`capacity.ts` made a placer/verifier fork impossible, while
// `usableWindows` did not exist at all and the start-window rule was written
// out TWICE in calendar.ts — once for the placer (`windowFor`, taking a
// SchedulableFixture) and once for the verifier (`startWindowFor`, taking an
// Assignment). Same rule, two shapes, two copies, free to drift.
//
// A convention cannot hold that line, so this file enforces it. These are
// source-structural assertions on purpose: a behavioural test can only compare
// the implementations that EXIST, and the failure being guarded against is
// someone adding a third.
//
// Read via `import.meta.url`, never a cwd-relative path — the shell's working
// directory resets between tool calls in this repo, and a test that resolves
// its own source relative to cwd silently reads the wrong tree.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string): string => readFileSync(new URL(file, import.meta.url), "utf8");

const calendar = source("./calendar.ts");
const buildGrid = source("./build-grid.ts");

/** Occurrences of a regex, ignoring the file's comment lines — a rule quoted
 *  in prose is documentation, not a second implementation. */
function countInCode(text: string, re: RegExp): number {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .match(re)!.length;
}

describe("start windows have exactly one implementation", () => {
  it("matches a start window against its target in ONE place in calendar.ts", () => {
    // The predicate that decides whether a `startWindows` entry applies to a
    // fixture. Two copies of this is the fork P9.5 exists to close.
    const targetMatch = /w\.target\.kind === "entrant"/g;

    expect(countInCode(calendar, targetMatch)).toBe(1);
  });

  it("folds notBefore/notAfter bounds in ONE place in calendar.ts", () => {
    const foldBefore = /notBefore = Math\.max\(notBefore, w\.notBefore\)/g;
    const foldAfter = /notAfter = Math\.min\(notAfter, w\.notAfter\)/g;

    expect(countInCode(calendar, foldBefore)).toBe(1);
    expect(countInCode(calendar, foldAfter)).toBe(1);
  });
});

describe("court availability has exactly one implementation", () => {
  it("does not reintroduce a private window computation in build-grid.ts", () => {
    // `admits` may consult usable windows; it may not compute them. Any of
    // these appearing here means the lattice grew its own copy again.
    expect(buildGrid).not.toMatch(/court_hours|courtHours|court_exceptions|courtExceptions/);
    expect(buildGrid).not.toMatch(/function\s+usableWindows/);
  });

  it("keeps usableWindows the only exported producer of court windows", () => {
    const courtWindows = source("./court-windows.ts");
    const exportedFns = [...courtWindows.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);

    expect(exportedFns).toEqual(["usableWindows"]);
  });
});
