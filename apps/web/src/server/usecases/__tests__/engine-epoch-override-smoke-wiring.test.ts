// Engine-split spec 5.6 (override review I2): the engine-epoch FLOOR OVERRIDE is proven through a REAL server in CI. The usecase
// tests drive the gate in-process; nothing else boots a standalone build with ENGINE_EPOCH_FLOOR_OVERRIDE set, so a lever that
// instrumentation.ts never wired would pass all of them. ci.yml starts a THIRD server from the smoke job's own build with the
// generic floor lowered by one, and runs the `epochFloorOverride` smoke suite alone against it. Every part of the wiring below, if
// lost, leaves the run GREEN while it proves nothing (the same shape as R2004's composed-smoke wiring, composed-smoke-ci-wiring.test.ts):
//   - the override on the server but not in the smoke process (or the other way round): the suite's first step reds, but a
//     step that never ran is invisible, so the greps name the suite's own labels and its own step count;
//   - the override typed as a number: it goes stale on the next bump and either lowers nothing or becomes a boot throw;
//   - LOG_LEVEL left at the job's `error`: the boot's warning is never written, and the ACTIVE grep waits out its bound and reds
//     for a reason that reads as "the lever is broken";
//   - the compiled instrumentation.js missing from the standalone tree (Turbopack's tracing drops it; the Dockerfile overlays it):
//     register() is then silently skipped, the boot report never runs, and the ACTIVE grep reds as if the lever were broken;
//   - the override in the FIRST server's env (or a job-level env): the main smoke would then run with a lowered floor and the
//     lever's default-off claim would be witnessed nowhere.
// Read from the files themselves - no YAML parser in the repo; the step slicer below is pinned to the workflow's own indentation.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
// The smoke script is split (scripts/smoke/): the SMOKE_ONLY registry is in its entry, the suite, its step count and its labels
// in the suite's own file, and "who calls it" is a question about every file of the script (main(), the entry, every suite).
const SMOKE_INDEX = readFileSync(resolve(ROOT, "scripts/smoke/index.ts"), "utf8");
const SMOKE = readFileSync(resolve(ROOT, "scripts/smoke/suites/epochFloorOverride.ts"), "utf8");
const SMOKE_FILES = readdirSync(resolve(ROOT, "scripts/smoke"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
const SMOKE_ALL = SMOKE_FILES.map((f) => readFileSync(resolve(ROOT, "scripts/smoke", f), "utf8")).join("\n");
const DOCKERFILE = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
const OVERRIDE_SRC = readFileSync(resolve(ROOT, "apps/web/src/server/usecases/engine-epoch-override.ts"), "utf8");
const SCORING_SRC = readFileSync(resolve(ROOT, "apps/web/src/server/usecases/scoring.ts"), "utf8");

const SERVER_STEP = "Start a third server with the generic epoch floor lowered by one (ENGINE_EPOCH_FLOOR_OVERRIDE)";
const SMOKE_STEP = "Run floor-override smoke (the generic floor lowered, against the third server)";
const COMPOSED_SMOKE_STEP = "Run composed smoke (captureV2 against the compositor-image server)";

/** The smoke job's text: from its `name:` to the next job's. */
function smokeJob(): string {
  const start = CI.indexOf("    name: Smoke — build + server + e2e");
  expect(start, "premise: the smoke job exists").toBeGreaterThan(-1);
  const next = CI.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? CI.slice(start) : CI.slice(start, start + 1 + next);
}

/** One step of a job: its `      - name:` line up to the next step OR the next comment block at the step indent (a comment
 *  between steps belongs to the step after it, not to this one), or null. */
function step(job: string, name: string): string | null {
  const lines = job.split("\n");
  const i = lines.findIndex((l) => l === `      - name: ${name}`);
  if (i === -1) return null;
  let j = i + 1;
  while (j < lines.length && !/^ {6}(- |#)/.test(lines[j]!) && !/^ {4}\S/.test(lines[j]!)) j++;
  return lines.slice(i, j).join("\n");
}

/** The steps (their `- ` header lines, in order, de-duplicated) that carry `needle` on any line of their own. A comment block between
 *  steps belongs to no step, and a step without a `name:` is still counted. */
function stepsCarrying(job: string, needle: string): { owners: string[]; steps: number } {
  const lines = job.split("\n");
  const owners: string[] = [];
  let current: string | null = null;
  let steps = 0;
  for (const l of lines) {
    if (/^ {6}- /.test(l)) {
      current = l;
      steps++;
    } else if (/^ {6}#/.test(l)) current = null;
    else if (/^ {4}\S/.test(l)) current = null;
    if (current !== null && l.includes(needle) && !owners.includes(current)) owners.push(current);
  }
  return { owners, steps };
}

/** A step's `env:` map - the `key: value` lines at the step's env indent (10), quotes stripped. */
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

describe("engine-split 5.6 CI smoke: the floor override is witnessed against a third server that boots with it", () => {
  const job = smokeJob();
  const first = step(job, "Start server");
  const server = step(job, SERVER_STEP);
  const smoke = step(job, SMOKE_STEP);

  it("both steps exist in the smoke job, after the first server, the full smoke and the composed smoke", () => {
    expect(first, "premise: the job's own server step").not.toBeNull();
    expect(server, SERVER_STEP).not.toBeNull();
    expect(smoke, SMOKE_STEP).not.toBeNull();
    const order = ["Start server", "Run smoke test", COMPOSED_SMOKE_STEP, SERVER_STEP, SMOKE_STEP].map((n) => job.indexOf(`      - name: ${n}\n`));
    expect(order.every((x) => x > -1), `every step found: ${order.join(", ")}`).toBe(true);
    expect([...order].sort((a, b) => a - b), "in that order").toEqual(order);
  });

  it("the third server is on its OWN port, the smoke is aimed at it, runs the suite alone, and the server boots with every env the first one does (LOG_LEVEL aside)", () => {
    const s = envOf(server!), t = envOf(smoke!), f = envOf(first!);
    expect(f.size, "premise: the first server's env read").toBeGreaterThan(3);
    const port = s.get("PORT");
    expect(port, "the third server's own port").toMatch(/^\d+$/);
    // 3000 is the job's server; 3001 is the R2004 composed server (ci.yml). Reading the latter from its own step keeps this honest.
    const composedPort = envOf(step(job, "Start a second server with a compositor image (R2004)")!).get("PORT");
    expect(composedPort, "premise: the composed server's port").toMatch(/^\d+$/);
    expect([port, "3000", composedPort], "three servers, three ports").not.toContain(undefined);
    expect(new Set([port, "3000", composedPort]).size, "three distinct ports").toBe(3);
    expect(t.get("SMOKE_BASE"), "the smoke's base").toBe(`http://localhost:${port}`);
    expect(server!, "health is polled on that port").toContain(`http://localhost:${port}/api/health`);
    expect(t.get("SMOKE_ONLY")).toBe("epochFloorOverride");
    expect(SMOKE_INDEX, "epochFloorOverride is a selectable suite").toMatch(/^\s+epochFloorOverride: \(\) => epochFloorOverrideSuite\(\),$/m);
    let checked = 0;
    for (const [k, v] of f) {
      if (k === "LOG_LEVEL") continue; // the one deliberate difference, pinned in the next test
      expect(s.get(k), `the third server carries ${k}`).toBe(v);
      checked++;
    }
    expect(checked, "anti-vacuity: every env but LOG_LEVEL was compared").toBe(f.size - 1);
    expect(server!, "the same build's server").toContain("node apps/web/.next/standalone/apps/web/server.js");
  });

  it("the third server logs at warn (the job's error would never write the boot's warning), and the first server stays at error", () => {
    expect(envOf(server!).get("LOG_LEVEL")).toBe("warn");
    expect(envOf(first!).get("LOG_LEVEL")).toBe("error");
  });

  it("the override is DERIVED from the engine's own table, exported before the server starts, handed to the smoke process, and set nowhere else", () => {
    // Derived: one below foldEpochOf(<sport>), never a typed number.
    const derive = /floor=\$\(node --input-type=module -e "import \{ foldEpochOf \} from '@seazn\/engine\/sport'; console\.log\(foldEpochOf\('([a-z_]+)'\) - 1\)"\)/.exec(server!);
    expect(derive, "the floor is computed from foldEpochOf").not.toBeNull();
    const sport = derive![1]!;
    expect(server!).toContain(`export ENGINE_EPOCH_FLOOR_OVERRIDE="${sport}=\${floor}"`);
    expect(server!, "no typed override value").not.toMatch(/ENGINE_EPOCH_FLOOR_OVERRIDE=["']?[a-z_]+=\d/);
    // Exported BEFORE the server starts (the server reads it at boot), and handed to the smoke step through a STEP OUTPUT (the smoke
    // process asserts it is the value the server booted with). Not through GITHUB_ENV: that would put it in every later step of the job.
    const exportAt = server!.indexOf('export ENGINE_EPOCH_FLOOR_OVERRIDE="');
    const startAt = server!.indexOf("node apps/web/.next/standalone/apps/web/server.js");
    expect(exportAt, "exported").toBeGreaterThan(-1);
    expect(startAt, "started").toBeGreaterThan(exportAt);
    // The compiled instrumentation.js is overlaid BEFORE the server starts (the Dockerfile's own COPY): the standalone tree as traced
    // has none, and Next silently skips register() without it, so the ACTIVE line the next greps wait for would never be written.
    const overlay = "cp -R apps/web/.next/server/. apps/web/.next/standalone/apps/web/.next/server/";
    const overlayAt = server!.indexOf(overlay);
    expect(overlayAt, "the compiled server dir is overlaid onto the standalone tree").toBeGreaterThan(-1);
    expect(startAt, "before the server starts").toBeGreaterThan(overlayAt);
    expect(DOCKERFILE, "and it is the one production does").toContain("COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/server ./apps/web/.next/server");
    expect(server!).toContain('echo "override=${ENGINE_EPOCH_FLOOR_OVERRIDE}" >> "$GITHUB_OUTPUT"');
    const id = /^ {8}id: ([a-z0-9-]+)$/m.exec(server!)?.[1];
    expect(id, "the server step has an id for its output").toBeDefined();
    expect(envOf(smoke!).get("ENGINE_EPOCH_FLOOR_OVERRIDE"), "the smoke step's own env takes it from that output").toBe(`\${{ steps.${id}.outputs.override }}`);
    expect(
      CI.split("\n").filter((l) => l.includes("ENGINE_EPOCH_FLOOR_OVERRIDE") && l.includes("GITHUB_ENV")),
      "never through the job environment",
    ).toHaveLength(0);
    // The sport is the one the smoke suite drives, and the ACTIVE / OVERRIDDEN greps name it.
    expect(SMOKE, "the suite drives the same sport").toContain(`const SPORT = "${sport}";`);
    expect(server!).toContain(`'"sport":"${sport}"'`);
    expect(smoke!).toContain(`'"sport":"${sport}"'`);
    // Set nowhere else: not the job's env, not the first server, not the composed server, not the smoke step's own env.
    expect(job.slice(0, job.indexOf("    steps:")), "no job-level override").not.toContain("ENGINE_EPOCH_FLOOR_OVERRIDE");
    expect(first!, "the first server runs with the lever off").not.toContain("ENGINE_EPOCH_FLOOR_OVERRIDE");
    expect(step(job, "Start a second server with a compositor image (R2004)")!, "the composed server too").not.toContain("ENGINE_EPOCH_FLOOR_OVERRIDE");
    expect(step(job, "Run smoke test")!, "the full smoke too").not.toContain("ENGINE_EPOCH_FLOOR_OVERRIDE");
    // Exactly the two steps that need it carry it - nothing before, nothing after (the job's later steps run the gallery and other
    // servers' checks, and none of them may see a lowered floor).
    const { owners, steps } = stepsCarrying(job, "ENGINE_EPOCH_FLOOR_OVERRIDE");
    expect(steps, "premise: the job's steps were read").toBeGreaterThan(10);
    expect(owners, "only the server step and the smoke step").toEqual([`      - name: ${SERVER_STEP}`, `      - name: ${SMOKE_STEP}`]);
  });

  it("the greps are the gate: each names a label smoke.ts prints, a log code the server really emits, and the step count is the suite's own", () => {
    expect(smoke!, "a failing smoke fails the pipe").toContain("set -o pipefail");
    const labels = [...smoke!.matchAll(/grep -F "PASS {2}epoch floor override: ([^"]+)" epoch-override-smoke\.log/g)].map((m) => m[1]!);
    expect(labels, "two label greps (the lever's own admit, and the count)").toHaveLength(2);
    const [count] = /const EPOCH_FLOOR_STEPS = (\d+);/.exec(SMOKE)?.slice(1) ?? [];
    expect(count, "premise: smoke.ts declares its step count").toMatch(/^\d+$/);
    // The count is not just declared: the suite's steps are the ones it counts (each `step(` call outside the helper's own definition).
    // The suite is the last declaration of its own file, so it runs to the end of that file.
    const suite = SMOKE.slice(SMOKE.indexOf("async function epochFloorOverrideSuite"));
    const stepCalls = [...suite.matchAll(/^\s*step\(/gm)].length;
    expect(stepCalls, "the declared count is the number of step() calls").toBe(Number(count));
    let checked = 0;
    for (const g of labels) {
      if (g.startsWith("all ")) {
        expect(g, "the count grep is the script's own count").toBe(`all ${count} steps ran (ran ${count})`);
      } else {
        // The label's fixed prefix (before its first interpolation) is in smoke.ts as a step label.
        expect(SMOKE, g).toContain(`\`${g}`);
      }
      checked++;
    }
    expect(checked, "both label greps were read").toBe(2);
    // The lever's own admit is a second grep on the same line, and that tail is the label's own ending.
    expect(smoke!).toContain('| grep -F "is ADMITTED: 201, seq 1"');
    expect(SMOKE).toContain("is ADMITTED: 201, seq 1`");

    // The server-log greps: the codes are the ones the code emits.
    expect(server!).toContain(`'"code":"ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE"'`);
    expect(OVERRIDE_SRC, "the boot emits it").toContain(`code: "ENGINE_EPOCH_FLOOR_OVERRIDE_ACTIVE"`);
    expect(smoke!).toContain(`'"code":"ENGINE_EPOCH_FLOOR_OVERRIDDEN"'`);
    expect(SCORING_SRC, "the gate emits it").toContain(`code: "ENGINE_EPOCH_FLOOR_OVERRIDDEN"`);
  });

  it("the full smoke is unchanged: main() never calls the suite (it is registered, and only registered)", () => {
    // Not vacuous: the scan reads main(), the entry and the suite's own file, among every file of the script.
    expect(SMOKE_FILES, `smoke files read: ${SMOKE_FILES.length}`).toEqual(expect.arrayContaining(["main.ts", "index.ts", "suites/epochFloorOverride.ts"]));
    expect(SMOKE_FILES.length, "every suite file, not just those three").toBeGreaterThan(3);
    const uses = [...SMOKE_ALL.matchAll(/epochFloorOverrideSuite\(/g)].length;
    // The declaration and the registry entry; a third would be a call from main() or another suite.
    expect(uses, "declaration + registry only").toBe(2);
  });

  it("the server log is printed when the job fails", () => {
    const failure = step(job, "Dev server log (on failure)");
    expect(failure, "premise: the on-failure log step").not.toBeNull();
    expect(failure!).toContain("cat epoch-override-server.log");
    expect(server!, "the log that step prints is the one the server writes").toContain("> epoch-override-server.log 2>&1 &");
  });
});
