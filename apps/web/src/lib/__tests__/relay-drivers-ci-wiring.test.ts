// R5 (Task 14b, owner ruling 2026-09-29): a production build (server.js runs NODE_ENV=production) with RELAY_DRIVERS
// unset now DISABLES streaming — createSession answers 503 ingest_unavailable. Every harness that boots a production
// server for a suite that streams (e2e's stream-overlay spec and Phone tab, smoke's stream-overlay suite) must say
// RELAY_DRIVERS=fake explicitly, or those suites go red on a 503 that looks like an outage. And (m2, lane-close fix,
// ruled 2026-09-29) under production an explicit fake also needs ENV_NAME named as one of FAKE_DRIVER_ENV_NAMES — an
// unnamed production server fails its boot check and answers 500 to every request — so each of those steps says
// ENV_NAME: ci beside it.
//
// Swept by BEHAVIOUR, not by file or step name (AGENTS.md class 16; Task 14b review M3): EVERY workflow under
// .github/workflows is read, every line that boots a production server (a `node … server.js`, `next start`, or an
// `npm`/`pnpm` start script) is found, and the env map of the step that OWNS it — the step's own `env:` key, never a
// neighbouring step's and never another key's children — must carry the explicit fake and an allowed ENV_NAME. A dev
// server (`npm run dev`, help-shots.yml) runs NODE_ENV=development, where an unset RELAY_DRIVERS is already fake, so it
// is not a production boot. bench.yml boots one and is exempt BY NAME with its reason — and the exemption is itself
// checked, so it cannot outlive its boot.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { FAKE_DRIVER_ENV_NAMES } from "@/server/relay/config";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");
/** Workflows whose production server never streams, each with its reason. */
const EXEMPT: Readonly<Record<string, string>> = {
  "bench.yml": "the scheduler bench drives placement and never starts a stream",
};
// `start` as a whole script name: `npm run start:placement` is some other script, not the web server.
const BOOT = /\bnode\b.*\bserver\.js\b|\bnext start\b|\b(?:npm|pnpm)\s+(?:run\s+)?start(?![\w:-])/;
/** A step's first line: a sequence item opening on one of a step's own keys. */
const STEP_START = /^(\s*)- (?:name|run|uses|id|if|env|with|shell|working-directory|timeout-minutes|continue-on-error):/;
const indentOf = (l: string): number => l.length - l.trimStart().length;
const skippable = (l: string): boolean => l.trim() === "" || /^\s*#/.test(l);

type BootStep = { line: number; env: Record<string, string> };

/** For each production-server boot line: the env map of the step that owns it, read from THAT step's `env:` key. */
function bootSteps(text: string): BootStep[] {
  const lines = text.split("\n");
  return lines.flatMap((l, i) => {
    if (!BOOT.test(l) || /^\s*#/.test(l)) return [];
    let start = i;
    while (start >= 0 && !STEP_START.test(lines[start]!)) start--;
    if (start < 0) return [{ line: i + 1, env: {} }];
    // The step's keys sit two columns right of its `- `; it ends at the first real line left of them.
    const keyIndent = indentOf(lines[start]!) + 2;
    const body = [lines[start]!.replace(/^(\s*)- /, (_, s: string) => `${s}  `)];
    for (let j = start + 1; j < lines.length && (skippable(lines[j]!) || indentOf(lines[j]!) >= keyIndent); j++) body.push(lines[j]!);
    // Guard: the boot line must lie inside the step found for it, or the attribution is someone else's.
    expect(start + body.length, `line ${i + 1} lies outside the step that starts at line ${start + 1}`).toBeGreaterThan(i);
    const env: Record<string, string> = {};
    const at = body.findIndex((b) => indentOf(b) === keyIndent && /^\s*env:\s*$/.test(b));
    if (at >= 0) {
      let childIndent: number | null = null;
      for (const b of body.slice(at + 1)) {
        if (skippable(b)) continue;
        if (indentOf(b) <= keyIndent) break;
        childIndent ??= indentOf(b);
        const m = indentOf(b) === childIndent ? /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(b) : null;
        if (m) env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
      }
    }
    return [{ line: i + 1, env }];
  });
}

describe("R5: every production server a streaming suite boots runs the fake relay drivers EXPLICITLY", () => {
  it("EVERY workflow: each production server boot's OWN step env carries RELAY_DRIVERS: fake and an ENV_NAME from FAKE_DRIVER_ENV_NAMES — bench.yml exempt by name", () => {
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
      for (const { line, env } of steps) {
        expect(env.RELAY_DRIVERS, `${wf}:${line}`).toBe("fake");
        // m2: under production (server.js) an explicit fake refuses an unset ENV_NAME and any name outside the allowed
        // list (config.ts relayDriverMode) — the list is read from config, so stg/prod are refused by construction.
        expect(FAKE_DRIVER_ENV_NAMES, `${wf}:${line} ENV_NAME=${JSON.stringify(env.ENV_NAME)}`).toContain(env.ENV_NAME);
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

  it("the detector is live: a step without the lines is caught, and each boot is judged by its OWN step's env", () => {
    const [only] = bootSteps("      - name: Start server\n        env:\n          LOG_LEVEL: warn\n        run: |\n          node apps/web/.next/standalone/apps/web/server.js > x 2>&1 &\n");
    expect(only).toBeDefined();
    expect(only!.env).toEqual({ LOG_LEVEL: "warn" });
    // Attribution (m10): the lines in a NEIGHBOURING step's env, another key's children, or the run script are not
    // this step's env. The previous detector walked back to the nearest `- name:` and grepped the text, so each passed.
    const misattributed: [string, string][] = [
      ["an unnamed step after a step that has them", "      - name: Prepare\n        env:\n          RELAY_DRIVERS: fake\n          ENV_NAME: ci\n        run: echo ok\n      - run: node apps/web/.next/standalone/apps/web/server.js &\n"],
      ["a `uses:` step's `with:` children", "      - name: Boot\n        uses: some/action@v1\n        with:\n          RELAY_DRIVERS: fake\n          ENV_NAME: ci\n          cmd: pnpm start\n"],
      ["nested under a child of env, not a child of it", "      - name: Boot\n        env:\n          OUTER:\n            RELAY_DRIVERS: fake\n            ENV_NAME: ci\n        run: node server.js &\n"],
    ];
    let judged = 0;
    for (const [name, text] of misattributed) {
      const found = bootSteps(text);
      expect(found, name).toHaveLength(1);
      expect(found[0]!.env.RELAY_DRIVERS, name).toBeUndefined();
      expect(found[0]!.env.ENV_NAME, name).toBeUndefined();
      judged++;
    }
    expect(judged).toBe(misattributed.length);
    // The positive pair: the same lines in the boot's own step, quoted or not, a comment among them, are read.
    const [own] = bootSteps("      - run: node server.js &\n        env:\n          # why\n          RELAY_DRIVERS: \"fake\"\n          ENV_NAME: 'ci'\n");
    expect(own!.env).toEqual({ RELAY_DRIVERS: "fake", ENV_NAME: "ci" });
    // Any production boot shape is a boot, not just the standalone path the repo uses today; a dev server, another
    // script that merely starts with "start", and a comment are not.
    let found = 0;
    for (const run of ["node .next/standalone/server.js &", "node --env-file=.env server.js", "npx next start -p 3000", "npm start", "pnpm start", "npm run start --workspace apps/web", "pnpm run start &"]) {
      expect(bootSteps(`      - name: Boot\n        run: ${run}\n`), run).toHaveLength(1);
      found++;
    }
    expect(found).toBe(7);
    let refused = 0;
    for (const run of ["npm run dev > dev-server.log 2>&1 &", "pnpm run start:placement", "npm run starter", "pnpm test"]) {
      expect(bootSteps(`      - name: Boot\n        run: ${run}\n`), run).toHaveLength(0);
      refused++;
    }
    expect(refused).toBe(4);
    expect(bootSteps("      - name: Boot\n        # node apps/web/.next/standalone/apps/web/server.js\n        run: true\n"), "a comment").toHaveLength(0);
  });

  it("scripts/ci-local.sh (the local mirror of these jobs) boots server.js with the fake default AND ENV_NAME=ci, as CI's steps do", () => {
    const script = readFileSync(resolve(ROOT, "scripts/ci-local.sh"), "utf8");
    const boots = script.split("\n").filter((l) => /node server\.js/.test(l) && !/^\s*#/.test(l) && !/echo/.test(l));
    expect(boots.length, "ci-local.sh boots no server.js — the premise of this test moved").toBeGreaterThan(0);
    for (const boot of boots) {
      expect(boot).toMatch(/RELAY_DRIVERS="\$\{RELAY_DRIVERS:-fake\}"/);
      expect(boot).toMatch(/\bENV_NAME=ci\b/);
      expect(FAKE_DRIVER_ENV_NAMES).toContain("ci");
    }
  });
});
