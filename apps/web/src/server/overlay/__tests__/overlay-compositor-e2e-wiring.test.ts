// R2005: e2e/overlay-compositor.spec.ts drives the overlay page as the compositor's CEF sees it, which needs a COMPOSED
// session — and a server whose env names no compositor image refuses every composed create 503 composed_unavailable
// (drivers.ts `composedUnavailable()`). Locally that is a loud red; in CI it would be the same red on every run, so
// the wiring is pinned here where a scoped gate reads it: the e2e-parallel job's `Start server` step names an image,
// the job's `rest` slice selects the spec (it is not carved into any other leg), and the spec still starts composed
// sessions (so the image is still load-bearing). Read from the files themselves — no YAML parser in the repo; the
// step slicer is pinned to the workflow's own indentation, as composed-smoke-ci-wiring.test.ts's is.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
});
