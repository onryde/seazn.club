// R2004 (PR #981 review, CI smoke): the smoke job's server names no RELAY_IMAGE, so `Run smoke test` witnesses only a
// composed Go live's 503. Two later steps start a SECOND server from the same build with a compositor image and run
// captureV2 alone against it, so the composed 201 and its Stop are witnessed over real HTTP. This file pins the wiring
// those two steps depend on — every part of which, if lost, turns the run back into the 503 branch while it still exits
// 0: the image on BOTH processes (the server admits on it; the smoke process picks its branch on it), the smoke aimed
// at the second server's port, the second server carrying every env the first one boots with, and greps that name
// labels and a step count the smoke script really prints. Read from the files themselves — no YAML parser in the repo;
// the step slicer below is pinned to the workflow's own indentation.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../../..");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const SMOKE = readFileSync(resolve(ROOT, "scripts/smoke.ts"), "utf8");

const SERVER_STEP = "Start a second server with a compositor image (R2004)";
const SMOKE_STEP = "Run composed smoke (captureV2 against the compositor-image server)";

/** The smoke job's text: from its `name:` to the next job's. */
function smokeJob(): string {
  const start = CI.indexOf("    name: Smoke — build + server + e2e");
  expect(start, "premise: the smoke job exists").toBeGreaterThan(-1);
  const next = CI.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? CI.slice(start) : CI.slice(start, start + 1 + next);
}

/** One step of a job (`      - name: …` up to the next step at the same indent), or null. */
function step(job: string, name: string): string | null {
  const lines = job.split("\n");
  const i = lines.findIndex((l) => l === `      - name: ${name}`);
  if (i === -1) return null;
  let j = i + 1;
  while (j < lines.length && !/^ {6}- /.test(lines[j]!) && !/^ {4}\S/.test(lines[j]!)) j++;
  return lines.slice(i, j).join("\n");
}

/** A step's `env:` map — the `key: value` lines at the step's env indent (10), quotes stripped. */
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

describe("R2004 CI smoke: the composed Go live is witnessed against a second server that names a compositor image", () => {
  const job = smokeJob();
  const first = step(job, "Start server");
  const server = step(job, SERVER_STEP);
  const smoke = step(job, SMOKE_STEP);

  it("both steps exist in the smoke job, after the first server's Start and after the full smoke", () => {
    expect(first, "premise: the job's own server step").not.toBeNull();
    expect(server, SERVER_STEP).not.toBeNull();
    expect(smoke, SMOKE_STEP).not.toBeNull();
    const order = ["Start server", "Run smoke test", SERVER_STEP, SMOKE_STEP].map((n) => job.indexOf(`      - name: ${n}\n`));
    expect(order.every((x) => x > -1), `every step found: ${order.join(", ")}`).toBe(true);
    expect([...order].sort((a, b) => a - b), "in that order").toEqual(order);
  });

  it("the image is set on BOTH processes, to the same value; the first server names none (its 503 branch stays witnessed)", () => {
    const s = envOf(server!), t = envOf(smoke!);
    expect(s.get("RELAY_IMAGE"), "the second server").toMatch(/\S/);
    expect(t.get("RELAY_IMAGE"), "the smoke process picks its composed branch on it").toBe(s.get("RELAY_IMAGE"));
    expect(envOf(first!).has("RELAY_IMAGE"), "the first server stays imageless").toBe(false);
    expect(job.slice(0, job.indexOf("    steps:")), "and no job-level image reaches it").not.toMatch(/^\s+RELAY_IMAGE:/m);
  });

  it("the smoke is aimed at the second server's port, runs captureV2 alone, and the second server boots with every env the first one does", () => {
    const s = envOf(server!), t = envOf(smoke!), f = envOf(first!);
    expect(f.size, "premise: the first server's env read").toBeGreaterThan(3);
    const port = s.get("PORT");
    expect(port, "the second server's own port").toMatch(/^\d+$/);
    expect(port).not.toBe("3000");
    expect(t.get("SMOKE_BASE"), "the smoke's base").toBe(`http://localhost:${port}`);
    expect(server!, "health is polled on that port").toContain(`http://localhost:${port}/api/health`);
    expect(t.get("SMOKE_ONLY")).toBe("captureV2");
    expect(SMOKE, "captureV2 is a selectable suite").toMatch(/^\s+captureV2: \(\) => captureV2Suite\(\),$/m);
    let checked = 0;
    for (const [k, v] of f) {
      expect(s.get(k), `the second server carries ${k}`).toBe(v);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(f.size);
    expect(server!, "the same build's server").toContain("node apps/web/.next/standalone/apps/web/server.js");
  });

  it("the greps are the gate: each names a label smoke.ts prints, and the step count is the script's own composed count", () => {
    const greps = [...smoke!.matchAll(/grep -F "PASS {2}capture-v2 smoke: ([^"]+)" composed-smoke\.log/g)].map((m) => m[1]!);
    expect(greps, "three greps").toHaveLength(3);
    expect(smoke!, "a failing smoke fails the pipe").toContain("set -o pipefail");
    const [count] = /process\.env\.RELAY_IMAGE \? (\d+) : (\d+);/.exec(SMOKE)?.slice(1) ?? [];
    expect(count, "premise: smoke.ts declares its composed step count").toMatch(/^\d+$/);
    let checked = 0;
    for (const g of greps) {
      if (g.startsWith("all ")) {
        expect(g, "the count grep is the script's composed count").toBe(`all ${count} steps ran (ran ${count})`);
      } else {
        // The label's fixed prefix (before its first interpolation) is in smoke.ts as a step label.
        expect(SMOKE, g).toContain(`\`${g}`);
      }
      checked++;
    }
    expect(checked).toBe(3);
  });
});
