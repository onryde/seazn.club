// The one failure the required `viewerPlan` prop cannot catch by itself.
//
// Making the prop required means `tsc` enumerates every paywall in the app —
// nobody can add a `<UpgradeGate>` without answering "what plan does this
// viewer hold". What `tsc` cannot see is an answer of `"unknown"` written by a
// call site that could have looked it up: the types are satisfied, the build
// is green, and the paywall quietly goes back to selling Pro to a Pro org.
//
// That is not hypothetical. All three routes this value was introduced FOR —
// app/directory, app/clubs/[id], app/import — turned out to hold an
// `auth.orgId` from `requirePageAuth()`, and app/directory was already handing
// it to `hasFeature()` a few lines above its own gate. The premise came from a
// survey answering "is this route under app/o/[orgSlug]", which is a different
// question, and it reached a dispatch brief as though it were the answer to
// this one. All three resolve the real plan now.
//
// So the rule this file pins is simply: no production call site passes
// "unknown". Re-introducing one must be a deliberate act that edits this list
// and says why, not a shortcut somebody takes at 5pm.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// `new URL("../..", …)` yields a DIRECTORY url, so `fileURLToPath` returns it
// with a trailing slash. Paths are made relative with `relative()` rather than
// `slice(SRC.length + 1)` for that reason: the arithmetic version silently ate
// the first character of every path, which the walk itself could not notice —
// the content scan below reads file CONTENTS and would have kept working,
// while `ALLOWED_UNKNOWN` could never have matched an entry again. Caught by
// the `toContain` half of the anti-vacuity check, not by anything else.
const SRC = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Routes allowed to answer `"unknown"`, with the reason each cannot resolve a
 * plan. EMPTY, deliberately — see the header. A path added here owes a
 * sentence saying which auth boundary it sits outside.
 */
const ALLOWED_UNKNOWN: ReadonlyArray<{ file: string; because: string }> = [];

/** Every `.ts`/`.tsx` under `apps/web/src`, tests excluded — a test file is not
 *  a production call site and the gate's own suite deliberately drives the
 *  `"unknown"` arm. */
function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      productionFiles(path, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const FILES = productionFiles(SRC);
const rel = (path: string) => relative(SRC, path);

/**
 * A call site ANSWERING "unknown", in every spelling JSX accepts.
 *
 * Anchored on the PROP rather than the bare word: "unknown" appears in
 * unrelated error handling all over this tree, and a rule that matched that
 * would report hundreds of offenders and be deleted within the day.
 *
 * Hoisted out of the scan so it can be tested against samples. A content
 * regex IS the whole rule here, and one narrowed to match nothing reports a
 * clean tree forever while examining every file — a vacuity this file's other
 * guards cannot see, because the walk and the call-site count both stay
 * healthy while it happens.
 *
 * WIDENED after review. The first version was `viewerPlan=` followed by a
 * DOUBLE-quoted literal, which two legal spellings walked straight through:
 * `viewerPlan={'unknown'}` and `viewerPlan = "unknown"`. Neither is exotic —
 * JSX permits whitespace around `=`, this repo's eslint config carries no
 * `quotes`/`jsx-quotes` rule, and no Prettier check runs in CI, so nothing
 * downstream would have normalised either one. A guard that its own subject
 * can sidestep by pressing a different quote key is decoration.
 *
 * Tolerating whitespace also catches a shape worth catching for its own sake:
 * `viewerPlan = "unknown"` inside a props destructure is a DEFAULT VALUE, and
 * a default is the exact failure making this prop required was meant to
 * prevent.
 *
 * The limit it cannot pass, stated rather than papered over: a text scan
 * cannot see indirection. `const p = "unknown"` passed as `viewerPlan={p}`,
 * or a spread, evades any regex. Nothing shaped like that exists today, and
 * the honest claim for this file is "no call site SAYS unknown", not "no call
 * site MEANS unknown".
 */
const UNKNOWN_ANSWER =
  /viewerPlan\s*=\s*(?:"unknown"|'unknown'|\{\s*(?:"unknown"|'unknown'|`unknown`)\s*\})/;

describe("viewerPlan coverage", () => {
  it("scans a real tree — this rule is worthless against an empty file list", () => {
    // ANTI-VACUITY, and the specific shape it guards: if the walk above ever
    // returns nothing (a moved directory, a changed URL base), every assertion
    // below passes by examining zero files. Both halves are checked — that
    // files were found at all, and that the file which DEFINES the prop is
    // among them, so the scan is pointed at the right tree and not merely at
    // a large one.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.map(rel)).toContain(join("components", "upgrade-gate.tsx"));
  });

  it("has at least one real call site, so the scan is looking at live code", () => {
    // The positive pair for the negative below. Without it, "no call site says
    // unknown" is satisfied by a tree with no call sites at all — which is
    // exactly what a broken scan looks like.
    const callSites = FILES.filter((path) => readFileSync(path, "utf8").includes("viewerPlan"));
    expect(callSites.length).toBeGreaterThan(20);
  });

  it("no production call site answers 'unknown'", () => {
    const allowed = new Set(ALLOWED_UNKNOWN.map((a) => a.file));
    const offenders = FILES.filter((path) => {
      if (allowed.has(rel(path))) return false;
      return UNKNOWN_ANSWER.test(readFileSync(path, "utf8"));
    }).map(rel);

    expect(
      offenders,
      offenders.length > 0
        ? `these call sites answer "unknown" without being listed in ALLOWED_UNKNOWN — ` +
            `each one either resolves a plan it already has in scope, or owes a line saying ` +
            `which auth boundary it sits outside:\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([]);
  });

  it("its scan can actually SEE an offender — proven, not assumed", () => {
    // Kills the mutant that matters: a regex quietly narrowed to match nothing
    // leaves "no production call site answers unknown" passing over 1226 real
    // files, with every other assertion in this file still green.
    for (const spelling of [
      '<X viewerPlan="unknown" />',
      '<X viewerPlan={"unknown"} />',
      '<X viewerPlan={ "unknown" } />',
      // The two a reviewer found walking through the first version, plus the
      // backtick form and a props DEFAULT — which is its own defect.
      "<X viewerPlan={'unknown'} />",
      '<X viewerPlan = "unknown" />',
      "<X viewerPlan={`unknown`} />",
      'function C({ viewerPlan = "unknown" }) {}',
    ]) {
      expect(UNKNOWN_ANSWER.test(spelling), spelling).toBe(true);
    }
    // …and does NOT fire on the two shapes that are not an answer of unknown:
    // a threaded value, and the word in ordinary error handling.
    expect(UNKNOWN_ANSWER.test("<X viewerPlan={viewerPlan} />")).toBe(false);
    expect(UNKNOWN_ANSWER.test('} catch { return "unknown"; }')).toBe(false);
  });

  it("every allowance carries its reason", () => {
    // States the empty case rather than skipping it: with no allowances this
    // loop body never runs, and a rule whose only assertion is inside an empty
    // loop reports green for a list nobody has checked.
    expect(ALLOWED_UNKNOWN.length).toBe(0);
    for (const { file, because } of ALLOWED_UNKNOWN) {
      expect(because.trim().length, `${file} is allowed "unknown" with no reason given`).toBeGreaterThan(20);
      expect(FILES.map(rel), `${file} is allowed but no longer exists`).toContain(file);
    }
  });
});
