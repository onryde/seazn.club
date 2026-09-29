// R5 (Task 14b, owner ruling 2026-09-29): a production build (server.js runs NODE_ENV=production) with RELAY_DRIVERS
// unset now DISABLES streaming — createSession answers 503 ingest_unavailable. Every harness that boots a production
// server for a suite that streams (e2e's stream-overlay spec and Phone tab, smoke's stream-overlay suite) must say
// RELAY_DRIVERS=fake explicitly, or those suites go red on a 503 that looks like an outage.
//
// Swept by BEHAVIOUR, not by file or step name (AGENTS.md class 16; Task 14b review M3): EVERY workflow under
// .github/workflows is read, every line that boots a production server (a `node … server.js`, or `next start`) is found,
// and the env map of the step that owns it must carry the explicit fake. A dev server (`npm run dev`, help-shots.yml)
// runs NODE_ENV=development, where an unset RELAY_DRIVERS is already fake, so it is not a production boot. bench.yml
// boots one and is exempt BY NAME with its reason — and the exemption is itself checked, so it cannot outlive its boot.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");
/** Workflows whose production server never streams, each with its reason. */
const EXEMPT: Readonly<Record<string, string>> = {
  "bench.yml": "the scheduler bench drives placement and never starts a stream",
};
const BOOT = /\bnode\b.*\bserver\.js\b|\bnext start\b/;

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
  it("EVERY workflow: each production server boot's step env carries RELAY_DRIVERS: fake, and never an ENV_NAME that would refuse it — bench.yml exempt by name", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
    let swept = 0;
    let checked = 0;
    let exempted = 0;
    for (const wf of files) {
      const steps = bootSteps(readFileSync(resolve(WORKFLOWS, wf), "utf8"));
      swept++;
      if (wf in EXEMPT) {
        expect(steps.length, `${wf} is exempt (${EXEMPT[wf]}) but boots no production server — drop the exemption`).toBeGreaterThan(0);
        exempted += steps.length;
        continue;
      }
      for (const { line, step } of steps) {
        expect(step, `${wf}:${line}`).toMatch(/^\s+RELAY_DRIVERS: fake\s*$/m);
        // An explicit fake is refused on a named deployment (config.ts relayDriverMode): stg/prod here would stop the boot.
        expect(step, `${wf}:${line}`).not.toMatch(/^\s+ENV_NAME:\s*["']?(stg|prod)\b/m);
        checked++;
      }
    }
    expect(swept, "no workflow was read").toBeGreaterThan(0);
    expect(swept).toBe(files.length);
    expect(Object.keys(EXEMPT).every((f) => files.includes(f)), "an exemption names a workflow that no longer exists").toBe(true);
    expect(exempted, "bench.yml's boot was seen and excused").toBeGreaterThan(0);
    // 3 e2e jobs (parallel, serial, mobile) + ci's smoke server, today; a floor, so a NEW boot is swept, not excused.
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("the detector is live: a step without the line is caught", () => {
    const text = "      - name: Start server\n        env:\n          LOG_LEVEL: warn\n        run: |\n          node apps/web/.next/standalone/apps/web/server.js > x 2>&1 &\n";
    const [only] = bootSteps(text);
    expect(only).toBeDefined();
    expect(only!.step).not.toMatch(/^\s+RELAY_DRIVERS: fake\s*$/m);
    // Any production boot shape is a boot, not just the standalone path the repo uses today; a dev server and a comment
    // are not.
    let found = 0;
    for (const run of ["node .next/standalone/server.js &", "node --env-file=.env server.js", "npx next start -p 3000"]) {
      expect(bootSteps(`      - name: Boot\n        run: ${run}\n`), run).toHaveLength(1);
      found++;
    }
    expect(found).toBe(3);
    expect(bootSteps("      - name: Boot\n        run: npm run dev > dev-server.log 2>&1 &\n"), "a dev server").toHaveLength(0);
    expect(bootSteps("      - name: Boot\n        # node apps/web/.next/standalone/apps/web/server.js\n        run: true\n"), "a comment").toHaveLength(0);
  });

  it("scripts/ci-local.sh (the local mirror of these jobs) boots server.js with the fake default", () => {
    const script = readFileSync(resolve(ROOT, "scripts/ci-local.sh"), "utf8");
    const boot = script.split("\n").find((l) => /node server\.js/.test(l) && !/^\s*#/.test(l) && !/echo/.test(l));
    expect(boot, "ci-local.sh boots no server.js — the premise of this test moved").toBeDefined();
    expect(boot).toMatch(/RELAY_DRIVERS="\$\{RELAY_DRIVERS:-fake\}"/);
  });
});
