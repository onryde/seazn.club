// R2005: e2e/overlay-compositor.spec.ts drives the overlay page as the compositor's CEF sees it, which needs a COMPOSED
// session — and a server whose env names no compositor image refuses every composed create 503 composed_unavailable
// (drivers.ts `composedUnavailable()`). Locally that is a loud red; in CI it would be the same red on every run, so
// the wiring is pinned here where a scoped gate reads it: the e2e-parallel job's `Start server` step names an image,
// the job's `rest` slice selects the spec (it is not carved into any other leg), and the spec still starts composed
// sessions (so the image is still load-bearing). Read from the files themselves — no YAML parser in the repo; the
// step slicer is pinned to the workflow's own indentation, as composed-smoke-ci-wiring.test.ts's is.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import type * as TS from "typescript";

// `typescript` through createRequire, as `_help-copy.ts` loads it (a static import pulls the compiler into every
// collection of this file's module graph).
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const WEB = resolve(import.meta.dirname, "../../../..");
const ROOT = resolve(WEB, "../..");
const E2E = readFileSync(resolve(ROOT, ".github/workflows/e2e.yml"), "utf8");
const SPEC = readFileSync(resolve(WEB, "e2e/overlay-compositor.spec.ts"), "utf8");
const PW = readFileSync(resolve(WEB, "playwright.config.ts"), "utf8");

function job(name: string, next: string): string {
  const start = E2E.indexOf(`\n  ${name}:\n`);
  const end = E2E.indexOf(`\n  ${next}:\n`);
  expect(start, `premise: ${name} exists`).toBeGreaterThan(-1);
  expect(end, `premise: ${next} follows it`).toBeGreaterThan(start);
  return E2E.slice(start, end);
}

/** One step of a job (`      - name: …` up to the next step at the same indent), or null. */
function step(text: string, name: string): string | null {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l === `      - name: ${name}`);
  if (i === -1) return null;
  let j = i + 1;
  while (j < lines.length && !/^ {6}- /.test(lines[j]!) && !/^ {4}\S/.test(lines[j]!)) j++;
  return lines.slice(i, j).join("\n");
}

/** A step's `env:` map — the `key: value` lines at the step's env indent (10), comments skipped, quotes stripped. */
function envOf(stepText: string): Map<string, string> {
  const lines = stepText.split("\n");
  const at = lines.findIndex((l) => l === "        env:");
  const env = new Map<string, string>();
  if (at === -1) return env;
  for (const l of lines.slice(at + 1)) {
    if (/^ {10}#/.test(l) || l.trim() === "") continue;
    const m = /^ {10}([A-Z0-9_]+):\s*(.*)$/.exec(l);
    if (!m) break;
    env.set(m[1]!, m[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return env;
}

/** `source` with every comment blanked (offsets kept). Every TOKEN is visited, not only nodes: a comment after a block's
 *  last statement is the leading trivia of its `}` token, which `forEachChild` never reaches (the house's
 *  `_help-copy.ts` stripper walks nodes, so it would keep `restoreSecret();\n  // await endRelaySessions();\n}`). */
function codeOf(source: string, fileName: string): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = source.split("");
  const blank = (r: TS.CommentRange) => {
    for (let i = r.pos; i < r.end; i++) if (out[i] !== "\n") out[i] = " ";
  };
  const visit = (n: TS.Node): void => {
    for (const r of ts.getLeadingCommentRanges(source, n.getFullStart()) ?? []) blank(r);
    for (const r of ts.getTrailingCommentRanges(source, n.getEnd()) ?? []) blank(r);
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(sf);
  return out.join("");
}

/** `await endRelaySessions()` inside an `afterAll(` — read from comment-blanked code. */
const TEARDOWN = /afterAll\([\s\S]*?await endRelaySessions\(\)/;

describe("R2005 e2e wiring: the composed overlay spec runs against a server that can start a composed session", () => {
  it("e2e-parallel's Start server names a compositor image, beside the fake drivers that never pull it", () => {
    const server = step(job("e2e-parallel", "e2e-serial"), "Start server");
    expect(server, "premise: e2e-parallel starts its own server").not.toBeNull();
    const env = envOf(server!);
    // Anti-vacuity: the env slicer read the step's whole env block, not its first line.
    expect(env.size, "env keys read from the step").toBeGreaterThan(5);
    expect(env.get("RELAY_DRIVERS"), "premise: the fake drivers (a dummy image is never pulled)").toBe("fake");
    expect(env.get("RELAY_IMAGE") ?? "", "an image the server admits composed sessions on").toMatch(/\S/);
  });

  it("the spec is in e2e-parallel's rest slice: not serial, not heavy, not a walkthrough, not mobile", () => {
    const heavy = /const PARALLEL_HEAVY =\s*(\/[^\n]*\/);/.exec(PW)?.[1];
    const serial = /const SERIAL_SPECS =\s*(\/[^\n]*\/);/.exec(PW)?.[1];
    expect(heavy, "premise: playwright.config.ts declares PARALLEL_HEAVY").toBeDefined();
    expect(serial, "premise: playwright.config.ts declares SERIAL_SPECS").toBeDefined();
    const path = "/repo/apps/web/e2e/overlay-compositor.spec.ts";
    let checked = 0;
    for (const [what, src] of [
      ["PARALLEL_HEAVY", heavy!],
      ["SERIAL_SPECS", serial!],
    ] as const) {
      const body = src.slice(1, src.lastIndexOf("/"));
      expect(new RegExp(body).test(path), `${what} does not select the spec`).toBe(false);
      checked++;
    }
    expect(/[\\/]e2e[\\/]walkthrough[\\/]/.test(path) || /mobile\.spec\.ts/.test(path), "not a walkthrough, not mobile").toBe(false);
    expect(checked, "carve-outs checked").toBe(2);
  });

  it("the spec still starts COMPOSED sessions, so the image is load-bearing", () => {
    expect(SPEC).toMatch(/mode: "composed"/);
  });

  // A RUNNING composed session reserves two matches of the one recording pool, which is the whole database's
  // (`storageReservations`). The vitest rig seats them raw; a file that leaves one live refuses every later composed
  // start on that database `storage_exhausted` — the e2e above on a shared local database, or another suite in CI.
  // Read with comments BLANKED (review round 1, item 6): a commented-out `// await endRelaySessions();` is no teardown,
  // and a call named only in prose seats nothing. Blanked by the TypeScript scanner (`codeOf`), not a regex. The raw
  // text pre-filters (blanking can only REMOVE a match), so only the few candidate files are parsed.
  it("every test file that seats a relay session through the rig ends them in its teardown", () => {
    const files = readdirSync(resolve(WEB, "src"), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.test\.tsx?$/.test(f))
      .map((f) => ({ rel: f, raw: readFileSync(resolve(WEB, "src", f), "utf8") }))
      .filter((f) => /\brelaySession\(/.test(f.raw) && /_relay-overlay-rig/.test(f.raw))
      .map((f) => ({ rel: f.rel, code: codeOf(f.raw, f.rel) }));
    const seaters = files.filter((f) => /\brelaySession\(/.test(f.code) && /_relay-overlay-rig/.test(f.code));
    expect(seaters.length, `files seating rig sessions: ${seaters.map((f) => f.rel).join(", ")}`).toBeGreaterThan(0);
    const leaky = seaters.filter((f) => !TEARDOWN.test(f.code));
    expect(leaky.map((f) => f.rel), "await endRelaySessions() in afterAll").toEqual([]);
  });

  it("the scan's own reader: a commented-out call is no teardown; a live one is", () => {
    const live = "afterAll(async () => {\n  restoreSecret();\n  await endRelaySessions();\n});\n";
    const cases: [string, boolean][] = [
      [live, true],
      [live.replace("  await endRelaySessions();", "  // await endRelaySessions();"), false],
      [live.replace("  await endRelaySessions();", "  /* await endRelaySessions(); */"), false],
      ["// afterAll(async () => { await endRelaySessions(); });\n", false],
      ['afterAll(async () => {\n  const s = "await endRelaySessions()";\n  await endRelaySessions();\n});\n', true],
    ];
    let checked = 0;
    for (const [src, holds] of cases) {
      expect(TEARDOWN.test(codeOf(src, "case.test.ts")), src).toBe(holds);
      checked++;
    }
    expect(checked).toBe(5);
  });
});
