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
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string): string => readFileSync(new URL(file, import.meta.url), "utf8");

const calendar = source("./calendar.ts");
const buildGrid = source("./build-grid.ts");

// P10 §2: this guard used to read only files inside packages/engine, so a
// fourth window-rule copy in apps/web (`venues.ts`'s `resolveCourtDay`)
// survived P9.5's de-forking invisibly. Scan the other workspace too.
const webSource = (file: string): string =>
  readFileSync(new URL(`../../../../apps/web/src/${file}`, import.meta.url), "utf8");

describe("apps/web has no second window rule", () => {
  it("venues.ts resolves court days through the engine, not its own copy", () => {
    const src = webSource("server/usecases/venues.ts");
    expect(src).not.toMatch(/function resolveCourtDay/);
    expect(src).toMatch(/usableWindows/);
  });

  // The check above guards the NAME `resolveCourtDay`, which a rename or an
  // arrow-function rewrite walks straight past (P10 review finding 1 — the
  // commit that added it claimed "the next copy cannot hide", and that was an
  // overclaim). This one guards the RULE, structurally, the way `countInCode`
  // does for start windows below.
  //
  // The marker is weekday-equality over court hours: resolving which of a
  // court's weekly ranges apply to a given day is the first step of the window
  // rule and has no other reason to exist server-side. Scoped to `server/` and
  // `lib/` deliberately — `components/v2/venues-panel.tsx` filters by weekday
  // too, and legitimately: P8's editor EDITS a court's hours, it never resolves
  // them against a fixture. Editing is not the rule.
  it("no server or lib file resolves a court's weekday hours itself", () => {
    const roots = ["server", "lib"];
    const offenders: string[] = [];
    for (const root of roots) {
      const dir = new URL(`../../../../apps/web/src/${root}/`, import.meta.url);
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
        if (name.includes(".test.")) continue;
        const path = `${entry.parentPath}/${name}`;
        if (path.includes("__tests__")) continue;
        if (countInCode(readFileSync(path, "utf8"), /weekday\s*===?/g) > 0) {
          offenders.push(path.slice(path.indexOf("apps/web/")));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Occurrences of a regex, ignoring the file's comment lines — a rule quoted
 *  in prose is documentation, not a second implementation.
 *
 *  `?? 0`, never `!`: when a guarded pattern disappears ENTIRELY — a rename,
 *  which is precisely the regression this file exists to catch — `.match`
 *  returns null, and a non-null assertion would kill the test with a TypeError
 *  instead of reporting `expected 0 to be 1`. The guard has to fail legibly in
 *  the case it was written for. */
function countInCode(text: string, re: RegExp): number {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .match(re)?.length ?? 0;
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
