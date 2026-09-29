// R5 (Task 14b, owner ruling 2026-09-29): a production build (server.js runs NODE_ENV=production) with RELAY_DRIVERS
// unset now DISABLES streaming — createSession answers 503 ingest_unavailable. Every harness that boots a production
// server for a suite that streams (e2e's stream-overlay spec and Phone tab, smoke's stream-overlay suite) must say
// RELAY_DRIVERS=fake explicitly, or those suites go red on a 503 that looks like an outage.
//
// Swept by BEHAVIOUR, not by step name (AGENTS.md class 16): every line that boots the standalone server.js in the
// streaming workflows is found, and the env map of the step that owns it must carry the explicit fake. bench.yml boots
// one too and is exempt BY NAME with its reason — the bench drives the scheduler and never starts a stream.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const STREAMING = ["e2e.yml", "ci.yml"] as const;
const BOOT = /node apps\/web\/\.next\/standalone\/apps\/web\/server\.js/;

/** For each server.js boot line: the lines of the step that owns it (from its `- name:` down to the boot). */
function bootSteps(text: string): { line: number; step: string }[] {
  const lines = text.split("\n");
  return lines.flatMap((l, i) => {
    if (!BOOT.test(l) || /^\s*#/.test(l)) return [];
    let start = i;
    while (start > 0 && !/^\s+- name:/.test(lines[start]!)) start--;
    return [{ line: i + 1, step: lines.slice(start, i + 1).join("\n") }];
  });
}

describe("R5: every production server a streaming suite boots runs the fake relay drivers EXPLICITLY", () => {
  it("e2e.yml and ci.yml: each server.js boot's step env carries RELAY_DRIVERS: fake, and never an ENV_NAME that would refuse it", () => {
    let checked = 0;
    for (const wf of STREAMING) {
      const steps = bootSteps(readFileSync(resolve(ROOT, ".github/workflows", wf), "utf8"));
      expect(steps.length, `${wf} boots no server.js — the premise of this test moved`).toBeGreaterThan(0);
      for (const { line, step } of steps) {
        expect(step, `${wf}:${line}`).toMatch(/^\s+RELAY_DRIVERS: fake\s*$/m);
        // An explicit fake is refused on a named deployment (config.ts relayDriverMode): stg/prod here would stop the boot.
        expect(step, `${wf}:${line}`).not.toMatch(/^\s+ENV_NAME:\s*["']?(stg|prod)\b/m);
        checked++;
      }
    }
    // 3 e2e jobs (parallel, serial, mobile) + ci's smoke server, today; a floor, so a NEW boot is swept, not excused.
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("the detector is live: a step without the line is caught", () => {
    const text = "      - name: Start server\n        env:\n          LOG_LEVEL: warn\n        run: |\n          node apps/web/.next/standalone/apps/web/server.js > x 2>&1 &\n";
    const [only] = bootSteps(text);
    expect(only).toBeDefined();
    expect(only!.step).not.toMatch(/^\s+RELAY_DRIVERS: fake\s*$/m);
  });

  it("scripts/ci-local.sh (the local mirror of these jobs) boots server.js with the fake default", () => {
    const script = readFileSync(resolve(ROOT, "scripts/ci-local.sh"), "utf8");
    const boot = script.split("\n").find((l) => /node server\.js/.test(l) && !/^\s*#/.test(l) && !/echo/.test(l));
    expect(boot, "ci-local.sh boots no server.js — the premise of this test moved").toBeDefined();
    expect(boot).toMatch(/RELAY_DRIVERS="\$\{RELAY_DRIVERS:-fake\}"/);
  });
});
