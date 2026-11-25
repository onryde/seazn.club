// Seazn-hosted video, Phase 4 T33g: smoke step 10 of the `seaznHosted` suite (a REAL Seazn Go live on the fake relay: both inputs, one
// Machine, then its Stop) used to run nowhere. It is counted, and run, only where the server has SEAZN_HOSTED_LIVE on, a compositor
// image and SEAZN_VIDEO_ORIGINS AND the smoke process is told LIVE is on with the same image; no smoke job set them, so every run was
// green with the step left out (the suite's EXPECTED_STEPS drops with it: 24 with LIVE on and no image; LIVE off counts 26 too, the two refusal steps standing in for step 10's two, so only the step's own PASS lines tell the worlds apart). ci.yml now starts a FOURTH server from the smoke
// job's own build with the first server's env plus those three, and runs the suite alone against it. Every part of the wiring below, if
// lost, turns the run back into the green one that skipped step 10 (the same shape as composed-smoke-ci-wiring.test.ts):
//   - LIVE or the image or the origins missing on the SERVER: the Seazn start is refused 503/422, and step 10's own check reds, but the
//     greps are what keep a step that never ran from reading as a pass;
//   - LIVE or the image missing in the SMOKE process: the suite counts 24 steps (LIVE on, no image) or 26 (LIVE off), prints "Seazn start
//     not run", and exits 0;
//   - the smoke aimed at the wrong port (the first server has LIVE off);
//   - the grep labels drifting from the labels the suite prints, or the count from the suite's own EXPECTED_STEPS;
//   - LIVE leaking into the first server's env or the job's (the main smoke would then run a LIVE-on world its refusal steps never expect).
// Read from the files themselves: no YAML parser in the repo; the step slicer below is pinned to the workflow's own indentation.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const SMOKE_INDEX = readFileSync(resolve(ROOT, "scripts/smoke/index.ts"), "utf8");
const SUITE = readFileSync(resolve(ROOT, "scripts/smoke/suites/seaznHosted.ts"), "utf8");

const SERVER_STEP = "Start a fourth server with Seazn hosted video LIVE on (T33g)";
const SMOKE_STEP = "Run Seazn-hosted smoke (seaznHosted against the LIVE-on server; step 10 must have RUN)";
const EPOCH_SMOKE_STEP = "Run floor-override smoke (the generic floor lowered, against the third server)";

/** The smoke job's text: from its `name:` to the next job's. */
function smokeJob(): string {
  const start = CI.indexOf("    name: Smoke — build + server + e2e");
  expect(start, "premise: the smoke job exists").toBeGreaterThan(-1);
  const next = CI.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? CI.slice(start) : CI.slice(start, start + 1 + next);
}

/** One step of a job: its `      - name:` line up to the next step or comment block at the step indent, or null. */
function step(job: string, name: string): string | null {
  const lines = job.split("\n");
  const i = lines.findIndex((l) => l === `      - name: ${name}`);
  if (i === -1) return null;
  let j = i + 1;
  while (j < lines.length && !/^ {6}(- |#)/.test(lines[j]!) && !/^ {4}\S/.test(lines[j]!)) j++;
  return lines.slice(i, j).join("\n");
}

/** A step's `env:` map: the `key: value` lines at the step's env indent (10), quotes stripped. */
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

/** The suite's own EXPECTED_STEPS, evaluated for the mode this step runs it in (the expression is the suite's, never retyped here). */
function expectedSteps(live: boolean, startsOnFakes: boolean): number {
  const m = /const EXPECTED_STEPS = ([^;]+);/.exec(SUITE);
  expect(m, "premise: the suite declares EXPECTED_STEPS as one expression").not.toBeNull();
  return new Function("live", "startsOnFakes", `return ${m![1]};`)(live, startsOnFakes) as number;
}

describe("T33g CI smoke: the Seazn-hosted suite's step 10 runs against a LIVE-on server, and the job reds if it did not", () => {
  const job = smokeJob();
  const first = step(job, "Start server");
  const server = step(job, SERVER_STEP);
  const smoke = step(job, SMOKE_STEP);

  it("both steps exist in the smoke job, after the first server, the full smoke and the floor-override smoke", () => {
    expect(first, "premise: the job's own server step").not.toBeNull();
    expect(server, SERVER_STEP).not.toBeNull();
    expect(smoke, SMOKE_STEP).not.toBeNull();
    const order = ["Start server", "Run smoke test", EPOCH_SMOKE_STEP, SERVER_STEP, SMOKE_STEP].map((n) => job.indexOf(`      - name: ${n}\n`));
    expect(order.every((x) => x > -1), `every step found: ${order.join(", ")}`).toBe(true);
    expect([...order].sort((a, b) => a - b), "in that order").toEqual(order);
  });

  it("LIVE, the image and the origins are on the server; LIVE and the SAME image are in the smoke process; neither is on the first server or the job", () => {
    const s = envOf(server!), t = envOf(smoke!), f = envOf(first!);
    expect(s.get("SEAZN_HOSTED_LIVE"), "the server runs LIVE on").toBe("true");
    expect(t.get("SEAZN_HOSTED_LIVE"), "the smoke process is told LIVE is on").toBe("true");
    expect(s.get("RELAY_IMAGE") ?? "", "the server names a compositor image").toMatch(/\S/);
    expect(t.get("RELAY_IMAGE"), "the smoke process picks its Seazn-start branch on the very same image").toBe(s.get("RELAY_IMAGE"));
    expect(s.get("SEAZN_VIDEO_ORIGINS") ?? "", "the server names the host it serves (a bare hostname)").toMatch(/^[a-z0-9.-]+$/i);
    for (const k of ["SEAZN_HOSTED_LIVE", "SEAZN_VIDEO_ORIGINS", "RELAY_IMAGE"]) {
      expect(f.has(k), `the first server leaves ${k} unset (its refusal steps stay witnessed)`).toBe(false);
    }
    expect(job.slice(0, job.indexOf("    steps:")), "and no job-level env reaches it").not.toMatch(/^\s+(SEAZN_HOSTED_LIVE|SEAZN_VIDEO_ORIGINS|RELAY_IMAGE):/m);
    expect(CI.match(/^\s+SEAZN_HOSTED_LIVE:/gm), "LIVE is set on exactly this server and this smoke process in ci.yml").toHaveLength(2);
  });

  it("the smoke is aimed at the fourth server's own port and runs seaznHosted alone; the server boots with every env the first one does", () => {
    const s = envOf(server!), t = envOf(smoke!), f = envOf(first!);
    expect(f.size, "premise: the first server's env read").toBeGreaterThan(3);
    const port = s.get("PORT");
    expect(port, "its own port").toMatch(/^\d+$/);
    expect(["3000", "3001", "3002"], "not another server's").not.toContain(port);
    expect(t.get("SMOKE_BASE")).toBe(`http://localhost:${port}`);
    expect(server!, "health is polled on that port").toContain(`http://localhost:${port}/api/health`);
    expect(t.get("SMOKE_ONLY")).toBe("seaznHosted");
    expect(SMOKE_INDEX, "seaznHosted is a selectable suite").toMatch(/^\s+seaznHosted: \(\) => seaznHostedSuite\(\),$/m);
    let checked = 0;
    for (const [k, v] of f) {
      expect(s.get(k), `the fourth server carries ${k}`).toBe(v);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(f.size);
    expect(server!, "the same build's server").toContain("node apps/web/.next/standalone/apps/web/server.js");
  });

  it("the greps are the gate: step 10's two PASS labels and the done line are the suite's own, and the count is its EXPECTED_STEPS for LIVE on with an image", () => {
    expect(smoke!, "a failing smoke fails the pipe").toContain("set -o pipefail");
    expect(smoke!, "no `if:` could skip it").not.toMatch(/^ {8}if:/m);
    expect(smoke!, "nor is its red forgiven").not.toMatch(/continue-on-error/);
    const greps = [...smoke!.matchAll(/grep -F "([^"]+)" seazn-smoke\.log/g)].map((m) => m[1]!);
    expect(greps, "four greps").toHaveLength(4);
    const live = expectedSteps(true, true);
    expect(live, "premise: step 10's two steps are counted only where it runs").toBe(expectedSteps(true, false) + 2);
    expect(expectedSteps(true, false), "premise: LIVE on with no image counts fewer").toBeLessThan(live);
    // LIVE OFF counts the same total (it keeps the two refusal steps LIVE on drops), so the COUNT alone cannot tell the two worlds apart:
    // the two step-10 PASS lines and the "Seazn start run" done line are what do.
    expect(expectedSteps(false, false), "premise: LIVE off counts the same, so the count proves nothing alone").toBe(live);
    let passes = 0;
    let done = 0;
    for (const g of greps) {
      if (g === `seazn-hosted smoke: ${live} steps (LIVE on, COST off, Seazn start run)`) {
        // The suite's own done() line, with its mode words.
        expect(SUITE, g).toContain("Seazn start ${startsOnFakes ? \"run\" : \"not run\"}");
        expect(SUITE, g).toContain("(LIVE ${live ? \"on\" : \"off\"}, COST ${cost ? \"on\" : \"off\"}, ");
        done++;
      } else if (g === `PASS  seazn-hosted smoke: all ${live} steps ran (ran ${live})`) {
        expect(SUITE, g).toContain("all ${EXPECTED_STEPS} steps ran (ran ${steps})");
        done++;
      } else {
        const m = /^PASS {2}seazn-hosted smoke: (SEAZN START ON THE FAKES: .+)$/.exec(g);
        expect(m, `a PASS line of step 10: ${g}`).not.toBeNull();
        // The label's fixed text is in the suite as a step label (before its first interpolation).
        expect(SUITE, g).toContain(`\`${m![1]}`);
        passes++;
      }
    }
    expect([passes, done], "two step-10 PASS lines, the done line and the count line").toEqual([2, 2]);
  });

  it("the failure log step prints the fourth server's log too", () => {
    const logStep = step(job, "Dev server log (on failure)");
    expect(logStep, "premise: the job has its failure log step").not.toBeNull();
    expect(server!, "the server writes to a file").toContain("> seazn-smoke-server.log 2>&1 &");
    expect(logStep!).toContain("cat seazn-smoke-server.log");
  });
});
