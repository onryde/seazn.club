// scripts/check-client-sentry.ts: the build-level pin for browser Sentry (owner decision 2026-10-19: ON, session replay OFF).
//
// The real witness is the script run against a real `next build` (the Turbopack build, CI env, keys blank), which ci.yml's smoke
// job does after `check:build-chunks`; the verdict logic here is proven on small synthetic `.next` trees, both directions:
//   - the healthy tree passes (the init marker in a first-load chunk, the replay marker in none);
//   - each way it can be wrong fails by name: the init absent (the shape of every build before the init moved to
//     instrumentation-client.ts), one marker missing, the init only in a lazy chunk, the replay recorder in a lazy chunk or in
//     a first-load chunk;
//   - the empty cases are failures, not passes (zero first-load files, zero chunks, no build at all).
// The markers are pinned to the product (the scrubber's own declarations; rrweb's option as the installed SDK spells it), so the
// check cannot go on passing against a string the code no longer carries. The CLI is started through a symlink, the way a
// `main-module` idiom fails open (scripts/__tests__/main-module.test.ts).
// Single-sport reason: no sport is involved, this reads bundler output.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { INIT_MARKERS, REPLAY_MARKER, failures, inspectClientBuild } from "../check-client-sentry.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO, "scripts/check-client-sentry.ts");
const scratch = mkdtempSync(join(tmpdir(), "client-sentry-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// One spawn's cap, and the budget derived from it (AGENTS.md class 20).
const SPAWN_MS = 25_000;
const SLACK_MS = 5_000;

/** Text of the init's wiring: the markers plus enough other bytes for gzip to have something to do. */
const FILLER = (n: number) => `/*${"abcdefghij".repeat(n)}*/`;
const INIT = `var a={name:"ScrubScoreTokens"};function f(e){return e.request.query_string}${FILLER(40)}`;

interface Tree {
  /** rootMainFiles + polyfillFiles. */
  firstLoad: Record<string, string>;
  /** Every other chunk. */
  lazy?: Record<string, string>;
}

let n = 0;
/** A synthetic .next dir: build-manifest.json plus static/chunks files. */
function build(tree: Tree): string {
  const dir = join(scratch, `next-${n++}`);
  mkdirSync(join(dir, "static/chunks/nested"), { recursive: true });
  const names = Object.keys(tree.firstLoad);
  writeFileSync(join(dir, "build-manifest.json"), JSON.stringify({ rootMainFiles: names.slice(0, -1), polyfillFiles: names.slice(-1) }));
  for (const [file, text] of [...Object.entries(tree.firstLoad), ...Object.entries(tree.lazy ?? {})]) writeFileSync(join(dir, file), text);
  return dir;
}

const HEALTHY: Tree = {
  firstLoad: { "static/chunks/main.js": `${INIT}${FILLER(10)}`, "static/chunks/runtime.js": FILLER(3), "static/chunks/polyfill.js": FILLER(2) },
  lazy: { "static/chunks/route-a.js": FILLER(5), "static/chunks/nested/route-b.js": "var x=1;" },
};

describe("inspectClientBuild and failures: every way a build can be wrong, and the build that is not", () => {
  it("passes the healthy tree: the init marker in a first-load chunk, the replay marker in none", () => {
    const report = inspectClientBuild(build(HEALTHY));
    expect(failures(report)).toEqual([]);
    expect(report.firstLoadFiles).toEqual(["static/chunks/main.js", "static/chunks/runtime.js", "static/chunks/polyfill.js"]);
    expect(report.chunksScanned, "all five chunks are read, the nested one included").toBe(5);
    expect(report.initMarkers).toEqual({ ScrubScoreTokens: ["static/chunks/main.js"], query_string: ["static/chunks/main.js"] });
    expect(report.replayChunks).toEqual([]);
  });

  it("measures the first-load size as the raw and gzipped bytes of exactly rootMainFiles + polyfillFiles", () => {
    const report = inspectClientBuild(build(HEALTHY));
    const texts = Object.values(HEALTHY.firstLoad);
    expect(report.firstLoadRawBytes).toBe(texts.reduce((sum, t) => sum + Buffer.byteLength(t), 0));
    expect(report.firstLoadGzipBytes).toBe(texts.reduce((sum, t) => sum + gzipSync(Buffer.from(t)).length, 0));
    expect(report.firstLoadGzipBytes, "premise: gzip shrinks this input, so the two numbers differ").toBeLessThan(report.firstLoadRawBytes);
  });

  it("fails a build with no client init anywhere (the shape of every build before the init moved to instrumentation-client.ts)", () => {
    const problems = failures(inspectClientBuild(build({ ...HEALTHY, firstLoad: { "static/chunks/main.js": FILLER(20), "static/chunks/poly.js": FILLER(1) } })));
    expect(problems).toHaveLength(INIT_MARKERS.length);
    for (const marker of INIT_MARKERS) expect(problems.join("\n")).toContain(`"${marker}" is in no first-load chunk`);
  });

  it("fails when only ONE of the init markers is there (each is checked on its own)", () => {
    for (const keep of INIT_MARKERS) {
      const text = `${keep}${FILLER(5)}`;
      const problems = failures(inspectClientBuild(build({ ...HEALTHY, firstLoad: { "static/chunks/main.js": text, "static/chunks/poly.js": "x" } })));
      expect(problems, `only ${keep} present`).toHaveLength(INIT_MARKERS.length - 1);
      expect(problems.join("\n")).not.toContain(`"${keep}" is in no first-load chunk`);
    }
  });

  it("fails an init that is only in a lazy chunk: it must be in the code every page loads", () => {
    const tree: Tree = { firstLoad: { "static/chunks/main.js": FILLER(5), "static/chunks/poly.js": "x" }, lazy: { "static/chunks/late.js": INIT } };
    const problems = failures(inspectClientBuild(build(tree)));
    expect(problems).toHaveLength(INIT_MARKERS.length);
    expect(problems[0]).toContain("is in no first-load chunk");
  });

  it("fails a replay recorder in ANY chunk, a lazy one included, and names it", () => {
    const tree: Tree = { ...HEALTHY, lazy: { ...HEALTHY.lazy, "static/chunks/nested/recorder.js": `var o={${REPLAY_MARKER}:6e4};` } };
    const report = inspectClientBuild(build(tree));
    expect(report.replayChunks).toEqual(["static/chunks/nested/recorder.js"]);
    const problems = failures(report);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("static/chunks/nested/recorder.js");
    expect(problems[0]).toContain(REPLAY_MARKER);
  });

  it("fails a replay recorder inside the first-load chunk too (the init is there, so only the replay marker fails)", () => {
    const tree: Tree = { ...HEALTHY, firstLoad: { ...HEALTHY.firstLoad, "static/chunks/main.js": `${INIT}${REPLAY_MARKER}` } };
    const report = inspectClientBuild(build(tree));
    expect(report.replayChunks).toEqual(["static/chunks/main.js"]);
    expect(failures(report)).toHaveLength(1);
  });

  it("the empty cases are failures: an empty manifest, a build with no chunks", () => {
    const emptyManifest = join(scratch, "empty-manifest");
    mkdirSync(join(emptyManifest, "static/chunks"), { recursive: true });
    writeFileSync(join(emptyManifest, "build-manifest.json"), "{}");
    writeFileSync(join(emptyManifest, "static/chunks/a.js"), FILLER(1));
    const empty = failures(inspectClientBuild(emptyManifest));
    expect(empty.join("\n")).toContain("no first-load files");
    expect(empty.join("\n"), "with nothing first-load, the init markers are not also reported absent").not.toContain("is in no first-load chunk");

    const noChunks = join(scratch, "no-chunks");
    mkdirSync(noChunks, { recursive: true });
    writeFileSync(join(noChunks, "build-manifest.json"), JSON.stringify({ rootMainFiles: [], polyfillFiles: [] }));
    expect(failures(inspectClientBuild(noChunks)).join("\n")).toContain("no .js chunks under static/chunks");
  });

  it("throws, rather than pass, when there is no build at all", () => {
    expect(() => inspectClientBuild(join(scratch, "no-such-build"))).toThrow(/run the production build first/);
  });
});

describe("the CLI, started through a symlink (a main-module check that fails open would exit 0 having checked nothing)", () => {
  const link = join(scratch, "link-check-client-sentry.ts");
  symlinkSync(SCRIPT, link);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", link, ...args], { encoding: "utf8", timeout: SPAWN_MS });

  it("exits 0 on the healthy tree and says what it measured", { timeout: SPAWN_MS + SLACK_MS }, () => {
    const dir = build(HEALTHY);
    const out = run(dir);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("[client-sentry] OK");
    expect(out.stdout).toMatch(/first-load \(3 files.*\): \d+ B raw, \d+ B gzip; 5 chunks scanned/);
  });

  it("exits 1 naming the replay chunk on a tree with a recorder", { timeout: SPAWN_MS + SLACK_MS }, () => {
    const dir = build({ ...HEALTHY, lazy: { "static/chunks/rec.js": REPLAY_MARKER } });
    const out = run(dir);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("static/chunks/rec.js");
  });

  it("exits 1 on a tree with no init, and 2 on no build; --json carries the report and the problems", { timeout: 3 * SPAWN_MS + SLACK_MS }, () => {
    const noInit = build({ firstLoad: { "static/chunks/m.js": FILLER(3), "static/chunks/p.js": "x" } });
    expect(run(noInit).status).toBe(1);
    const asJson = run(noInit, "--json");
    expect(asJson.status).toBe(1);
    const parsed = JSON.parse(asJson.stdout) as { problems: string[]; firstLoadGzipBytes: number; chunksScanned: number };
    expect(parsed.problems).toHaveLength(INIT_MARKERS.length);
    expect(parsed.chunksScanned).toBe(2);
    expect(run(join(scratch, "no-such-build")).status).toBe(2);
  });
});

describe("the markers are the product's own strings (so the check cannot pass against text the code no longer carries)", () => {
  it("the init markers are in the scrubber that the client init passes to Sentry.init", () => {
    const scrubber = readFileSync(join(REPO, "apps/web/src/lib/scrub-score-url.ts"), "utf8");
    expect(INIT_MARKERS.length).toBeGreaterThanOrEqual(2);
    expect(scrubber).toContain('name: "ScrubScoreTokens"');
    for (const marker of INIT_MARKERS) expect(scrubber, marker).toContain(marker);
    const init = readFileSync(join(REPO, "apps/web/src/instrumentation-client.ts"), "utf8");
    expect(init).toContain("scrubScoreTokensIntegration()");
    expect(init).toContain("beforeSend: scrubSentryEvent");
  });

  it("the replay marker is rrweb's own option, in the installed Sentry replay package (a real recorder carries it)", () => {
    const fromWeb = createRequire(join(REPO, "apps/web/package.json"));
    const fromNextjs = createRequire(fromWeb.resolve("@sentry/nextjs"));
    const fromReact = createRequire(fromNextjs.resolve("@sentry/react"));
    const fromBrowser = createRequire(fromReact.resolve("@sentry/browser"));
    const replaySource = readFileSync(fromBrowser.resolve("@sentry/replay"), "utf8");
    expect(replaySource).toContain(REPLAY_MARKER);
  });
});

describe("the check is wired: an npm script, and a CI step in the job that builds and serves the production build", () => {
  it("package.json has the script, pointing at this file", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:client-sentry"]).toBe("node --experimental-strip-types scripts/check-client-sentry.ts");
  });

  it("ci.yml runs it once, after the chunk check and before the smoke run, in the job that stages the standalone build", () => {
    const yml = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
    const steps = yml.split("\n").filter((l) => /^\s+(- name:|run:)/.test(l));
    const at = (needle: string) => steps.findIndex((l) => l.includes(needle));
    expect(yml.match(/run: npm run check:client-sentry/g), "exactly one step runs it").toHaveLength(1);
    const chunks = at("npm run check:build-chunks");
    const sentry = at("npm run check:client-sentry");
    const smoke = at("npm run test:smoke");
    expect(chunks, "premise: the chunk check is a step").toBeGreaterThan(-1);
    expect(sentry, "it comes right after the chunk check").toBeGreaterThan(chunks);
    expect(sentry, "and before the smoke run").toBeLessThan(smoke);
  });
});
