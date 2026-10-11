// W2b Task 10 (finding 2; spec §5.1 "every caller enumerated"; Appendix A X-RS-1) — the engine closed the forfeit
// vocabulary (`FORFEIT_REASONS`) and moved the reason to `award.reason`. The server refuses a `core.forfeit` whose
// reason is outside it, so a free-text reason ("no-show", "retired hurt") left in an e2e spec, a smoke script or a bench
// pack builder is a write the product now refuses 422. This scan reads every file in those scopes that names
// `core.forfeit` and checks each payload literal's reason against the engine's own declaration — never a list typed
// here. It is COUNTED: an empty file list or a regex that never matches is a failure, not a pass.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { FORFEIT_REASONS } from "@seazn/engine/core";

const ROOT = new URL("../../../../../", import.meta.url).pathname; // repo root from apps/web/src/server/__tests__
/** This file names both patterns itself (the shape fixtures below, the retired methods in the grep), so it is the one
 *  file the scans leave out. */
const SELF = new URL(import.meta.url).pathname.slice(ROOT.length);
const SCOPES = ["apps/web/src", "apps/web/e2e", "scripts", "tools/bench/packs/build-packs", `:!${SELF}`];

/** `git grep` exits 1 when nothing matches: that is "no hits", read as `[]`. Any other exit (a bad pathspec, not a
 *  repo) is a broken scan and throws, so a scan that cannot run never reads as clean. */
function gitGrep(args: string[]): string[] {
  try {
    return execFileSync("git", ["grep", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

const files = gitGrep(["-l", "-e", "core.forfeit", "--", ...SCOPES, ":!*.golden.json"]);
/** A `core.forfeit` literal followed by its payload's `reason` literal, in every shape this repo writes one: an
 *  envelope (`type: "core.forfeit", payload: {…}`), a positional call (`post(id, "core.forfeit", {…})`), a stream
 *  tuple (`["core.forfeit", {…}]`) and a keyed sample (`"core.forfeit": {…}`). The gap may not cross another quoted
 *  event type, so a reason-less forfeit never borrows the next event's reason (an abandon's "rain"). The brief's
 *  envelope-only regex read 33 payloads and missed 7 free-text reasons in the other three shapes. */
const PAYLOAD = /["'`]core\.forfeit["'`](?:(?!["'`][a-z]+\.[a-z_.]+["'`])[\s\S]){0,240}?reason:\s*["'`]([^"'`]+)["'`]/g;
const reasonsIn = (text: string): string[] => [...text.matchAll(PAYLOAD)].map((m) => m[1]!);

describe("X-RS-1: every forfeit this repo writes outside the engine uses the closed vocabulary", () => {
  it("X-RS-1: the scan reads every call shape, and never borrows a neighbouring event's reason", () => {
    const shapes = {
      envelope: `{ type: "core.forfeit", payload: { by: fx.away, reason: "no-show" } }`,
      positional: `post(f.id, "core.forfeit", { by: f.away_entrant_id, reason: "no-show" })`,
      tuple: `stream(start(), ["core.forfeit", { by: "H", reason: "no-show" }])`,
      keyed: `const SAMPLES = { "core.forfeit": { by: "e1", reason: "no-show" } };`,
    };
    let read = 0;
    for (const [shape, text] of Object.entries(shapes)) {
      expect(reasonsIn(text), shape).toEqual(["no-show"]);
      read++;
    }
    expect(read).toBe(4);
    // The negative pair: a forfeit with no reason beside an abandon with one reads nothing.
    expect(reasonsIn(`stream(start(), ["core.forfeit", { by: "H" }], ["core.abandon", { reason: "rain" }])`)).toEqual([]);
  });

  it("X-RS-1: no core.forfeit payload literal carries a reason outside FORFEIT_REASONS; the scan is not vacuous", () => {
    let payloads = 0;
    const bad: string[] = [];
    for (const f of files) {
      for (const reason of reasonsIn(readFileSync(ROOT + f, "utf8"))) {
        payloads++;
        if (!(FORFEIT_REASONS as readonly string[]).includes(reason)) bad.push(`${f}: ${reason}`);
      }
    }
    expect(SELF, "the scans leave out exactly this file").toBe("apps/web/src/server/__tests__/forfeit-vocabulary-scan.test.ts");
    expect(files.length, `files scanned: ${files.length}`).toBeGreaterThan(0);
    expect(payloads, `payload literals checked: ${payloads} across ${files.length} files`).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("X-RS-1: the retired chess forfeit methods are written nowhere outside the engine and legacy fixtures", () => {
    const hits = gitGrep(["-n", "-e", 'method: "double_forfeit"', "-e", 'method: "forfeit"', "--", ...SCOPES]);
    // Not vacuous: the grep sees the legacy rows it exempts (pre-W2b streams, D15's refusal witnesses).
    expect(hits.length, `retired-method lines found: ${hits.length}`).toBeGreaterThan(0);
    expect(hits.filter((h) => !/legacy/i.test(h))).toEqual([]); // a deliberate legacy-replay test names itself "legacy"
  });

  it("X-RS-1: the grep wrapper reads no match as [] and a broken grep as a failure, never as a clean scan", () => {
    expect(gitGrep(["-l", "-e", "x-rs-1-no-file-holds-this-token", "--", "scripts"])).toEqual([]);
    expect(() => gitGrep(["--x-rs-1-not-a-git-grep-option"])).toThrow();
  });
});
