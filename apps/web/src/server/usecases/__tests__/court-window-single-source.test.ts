// The app's half of the anti-fork guard for court windows (P9.5 / P10 §2; moved here from
// packages/engine/src/scheduling/window-single-source.test.ts by engine-split 1d-3).
//
// The engine owns the window rule (`usableWindows`, court-windows.ts) and its own half of the guard stays beside it: those tests read only
// engine files. These three tests read apps/web (two moved, one witnesses the scan itself on a scratch copy of its layout), so they live
// with apps/web and keep working when the engine leaves the repo (2b).
//
// P10 §2: the guard used to read only files inside packages/engine, so a fourth window-rule copy in apps/web (`venues.ts`'s
// `resolveCourtDay`) survived P9.5's de-forking invisibly. Scan this workspace too.
//
// Read via `import.meta.url`, never a cwd-relative path: the shell's working directory resets between tool calls in this repo.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const webSource = (file: string): string => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

/** Occurrences of a regex, ignoring the file's comment lines — a rule quoted in prose is documentation, not a second implementation.
 *
 *  `?? 0`, never `!`: when a guarded pattern disappears ENTIRELY — a rename, which is precisely the regression this file exists to
 *  catch — `.match` returns null, and a non-null assertion would kill the test with a TypeError instead of reporting
 *  `expected 0 to be 1`. The guard has to fail legibly in the case it was written for. */
function countInCode(text: string, re: RegExp): number {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .match(re)?.length ?? 0;
}

/** A comparison of a `weekday` with something: `==`, `===`, `!=`, `!==`, the weekday on either side. A presence check (`!= undefined`,
 *  `!== null`, in either order) compares nothing to a day, so it is not the marker. Strict `=== undefined` stays flagged, as it always was.
 *  (`(?<![!=])` stops the `==` inside `!==` being read as a loose-equality comparison of its own.) */
const WEEKDAY =
  /weekday\s*(?:===?|!==?(?![=\s]*(?:undefined|null)\b))|(?:(?<![!=])===?|(?<!\b(?:undefined|null)\s*)!==?)\s*[\w$.?[\]()]*\bweekday\b/g;

/** Files under server/ and lib/ that compare a `weekday` and are NOT a court-hours rule, each with why. The allowlist is a guard of its own:
 *  an entry whose file no longer matches is stale and fails the scan, so it cannot outlive the line it excuses. Paths are relative to src/. */
const WEEKDAY_ALLOWLIST: Readonly<Record<string, string>> = {
  "lib/capacity-input.ts": "resolves a `fixture_on_weekday` HARD CONSTRAINT to the one bucket date it names; no court hours are read",
};
/** The trees the weekday marker is scanned in (see the long comment on the second test below). */
const ROOTS = ["server", "lib"];

/** Anti-vacuity for the scan: a root that contributed no file makes "no offenders" mean nothing. Throws, so the floor has a test of its own. */
function assertScanned(scanned: Record<string, number>): void {
  for (const root of ROOTS) expect(scanned[root], `files scanned under ${root}/`).toBeGreaterThan(0);
}

/** Every non-test source file under `srcDir`'s ROOTS, how many there were per root, and those that resolve a weekday themselves (paths
 *  relative to `srcDir`): `offenders` are the matches nobody excused, `allowed` the matches on the allowlist, `stale` the allowlist entries
 *  that matched nothing (a file that is gone counts). Tests, `__tests__` helpers and comment lines are skipped: they quote the rule or
 *  fabricate it, they do not implement it. */
function weekdayScan(
  srcDir: URL,
  allowlist: Readonly<Record<string, string>>,
): { scanned: Record<string, number>; offenders: string[]; allowed: string[]; stale: string[] } {
  const base = fileURLToPath(srcDir);
  const matched: string[] = [];
  const scanned: Record<string, number> = {};
  for (const root of ROOTS) {
    scanned[root] = 0;
    for (const entry of readdirSync(new URL(`${root}/`, srcDir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (name.includes(".test.")) continue;
      const path = `${entry.parentPath}/${name}`;
      if (path.includes("__tests__")) continue;
      scanned[root]!++;
      if (countInCode(readFileSync(path, "utf8"), WEEKDAY) > 0) matched.push(relative(base, path));
    }
  }
  const excused = Object.keys(allowlist);
  return {
    scanned,
    offenders: matched.filter((f) => !excused.includes(f)),
    allowed: matched.filter((f) => excused.includes(f)),
    stale: excused.filter((f) => !matched.includes(f)),
  };
}

describe("apps/web has no second window rule", () => {
  it("venues.ts resolves court days through the engine, not its own copy", () => {
    const src = webSource("server/usecases/venues.ts");
    expect(src.length, "venues.ts was read").toBeGreaterThan(0);
    expect(src).not.toMatch(/function resolveCourtDay/);
    expect(src).toMatch(/usableWindows/);
  });

  // The check above guards the NAME `resolveCourtDay`, which a rename or an
  // arrow-function rewrite walks straight past (P10 review finding 1 — the
  // commit that added it claimed "the next copy cannot hide", and that was an
  // overclaim). This one guards the RULE, structurally, the way `countInCode`
  // does for start windows in the engine's half.
  //
  // The marker is a weekday comparison over court hours (`==`/`!=` in either operand order; a presence check is not one): resolving which of a
  // court's weekly ranges apply to a given day is the first step of the window
  // rule and has no other reason to exist server-side. Scoped to `server/` and
  // `lib/` deliberately — `components/v2/venues-panel.tsx` filters by weekday
  // too, and legitimately: P8's editor EDITS a court's hours, it never resolves
  // them against a fixture. Editing is not the rule.
  it("no server or lib file resolves a court's weekday hours itself", () => {
    const { scanned, offenders, allowed, stale } = weekdayScan(new URL("../../../", import.meta.url), WEEKDAY_ALLOWLIST);
    // anti-vacuity: a scan that found no file under a root has scanned nothing, and an empty list would read as a clean tree
    assertScanned(scanned);
    // ... and the matcher can say yes: the same counter finds the marker in code, in either operand order and negated, and ignores
    // comments and presence checks
    const marker = [
      "const day = court.hours.filter((h) => h.weekday === d);",
      "h.weekday == d",
      "h.weekday !== d",
      "h.weekday != d",
      "d === h.weekday",
      "d == h.weekday",
      "d !== h.weekday",
      "d != h.weekday",
      "h?.weekday === d",
      "weekday === undefined",
    ];
    for (const line of marker) expect(countInCode(line, WEEKDAY), `marker in: ${line}`).toBe(1);
    const notMarker = [
      "// h.weekday === d is the rule, quoted in prose\n * weekday == 1\n/* h.weekday === d */",
      "d.weekday !== undefined ? { weekday: d.weekday } : {}",
      "d.weekday != null",
      "d.weekday !== null",
      "undefined !== d.weekday",
      "null != d.weekday",
      "const isWeekday = d === weekdayOfYmd(ymd)",
    ];
    for (const line of notMarker) expect(countInCode(line, WEEKDAY), `not a marker: ${line}`).toBe(0);
    // the allowlist is a guard: every entry still matches, and the count is on the failure line
    const entries = Object.keys(WEEKDAY_ALLOWLIST).sort();
    expect(stale, `stale allowlist entries (${entries.length} on the allowlist)`).toEqual([]);
    expect(allowed.sort(), `allowlisted files that still match (${allowed.length} of ${entries.length})`).toEqual(entries);
    expect(entries.length, "allowlisted files").toBeGreaterThan(0);
    expect(offenders.map((o) => `apps/web/src/${o}`)).toEqual([]);
  });

  it("the scan's anti-vacuity floor refuses a root that read no file", () => {
    expect(() => assertScanned({ server: 0, lib: 3 })).toThrow();
    expect(() => assertScanned({ server: 3, lib: 0 })).toThrow();
    expect(() => assertScanned({ server: 3 })).toThrow(); // a root the scan never reported is not a root it read
    expect(() => assertScanned({ server: 1, lib: 1 })).not.toThrow();
  });

  // The positive pair of the scan above (a scan nothing can fail is not a guard): a scratch src/ in which every exclusion and every root is
  // witnessed by its own file, so dropping one rule, or one root, or widening to another tree, fails here by name.
  describe("the weekday scan itself, on a scratch src/", () => {
    const OFFENDER = "export const f = (h: { weekday: number }, d: number) => h.weekday === d;\n";
    const files: Record<string, string> = {
      "server/bad.ts": OFFENDER,
      "server/nested/deeper/bad.tsx": OFFENDER,
      "lib/bad.ts": OFFENDER,
      "server/loose.ts": "export const f = (h: { weekday: number }, d: number) => h.weekday == d;\n", // loose equality is the same rule
      "server/reversed.ts": "export const f = (h: { weekday: number }, d: number) => d === h.weekday;\n", // operand order is not a defence
      "server/not-equal.ts": "export const f = (h: { weekday: number }, d: number) => h.weekday !== d;\n", // the complement is the same rule
      "lib/not-equal-reversed.ts": "export const f = (h: { weekday: number }, d: number) => d !== h.weekday;\n",
      // presence checks compare nothing to a day: not the marker, in either operand order
      "lib/presence.ts":
        "export const a = (d: { weekday?: number }) => (d.weekday !== undefined ? { weekday: d.weekday } : {});\n" +
        "export const b = (d: { weekday?: number }) => d.weekday != null;\n" +
        "export const c = (d: { weekday?: number }) => undefined !== d.weekday;\n",
      // an allowlisted file: excused while it still matches...
      "lib/allowed.ts": "export const f = (ymd: string, h: { weekday: number }) => weekdayOfYmd(ymd) === h.weekday;\n",
      // ...and an allowlisted file that no longer matches is stale (so is one that is gone: server/gone.ts is never written)
      "lib/clean.ts": "export const clean = 1;\n",
      "server/ok.ts": "export const ok = 1;\n",
      // the rule quoted in prose, in each comment style: documentation, not a second implementation
      "server/prose.ts": "// h.weekday === d is the rule, quoted\n/* h.weekday === d */\n/**\n * h.weekday === d\n */\nexport const p = 1;\n",
      "server/bad.test.ts": OFFENDER,
      "server/__tests__/helper.ts": OFFENDER,
      "lib/notes.md": "weekday === d\n",
      "components/editor.tsx": OFFENDER, // editing a court's hours is not resolving them: outside the roots
    };
    // Created in beforeAll, never at collect time: `-t` filters and `vitest list` collect without running, and would leak a tmpdir each.
    let scratch = "";
    beforeAll(() => {
      scratch = mkdtempSync(join(tmpdir(), "court-window-scan-"));
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(scratch, "src", rel)), { recursive: true });
        writeFileSync(join(scratch, "src", rel), text);
      }
    });
    afterAll(() => {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });

    it("flags exactly the code that resolves weekday hours under server/ and lib/, nested files and .tsx included, and counts per root", () => {
      const allowlist = { "lib/allowed.ts": "scratch: excused", "lib/clean.ts": "scratch: stale", "server/gone.ts": "scratch: stale, absent" };
      const { scanned, offenders, allowed, stale } = weekdayScan(pathToFileURL(join(scratch, "src") + sep), allowlist);
      expect(offenders.sort()).toEqual([
        "lib/bad.ts",
        "lib/not-equal-reversed.ts",
        "server/bad.ts",
        "server/loose.ts",
        "server/nested/deeper/bad.tsx",
        "server/not-equal.ts",
        "server/reversed.ts",
      ]);
      expect(allowed).toEqual(["lib/allowed.ts"]);
      expect(stale.sort()).toEqual(["lib/clean.ts", "server/gone.ts"]);
      // server: bad.ts, nested/deeper/bad.tsx, loose.ts, reversed.ts, not-equal.ts, ok.ts, prose.ts; lib: bad.ts, not-equal-reversed.ts,
      // presence.ts, allowed.ts, clean.ts. Tests, __tests__, .md and components/ are not counted.
      expect(scanned).toEqual({ server: 7, lib: 5 });
    });
  });
});
