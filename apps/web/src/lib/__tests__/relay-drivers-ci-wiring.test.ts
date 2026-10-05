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
//
// Capture QR v2 (owner, 2026-10-04): the panel's phone-camera option sits behind the PostHog flag `capture-qr-v2` with
// `fallback: false`, and a CI server has no PostHog — so without the override every spec and walkthrough would see the
// option hidden. The same production boots therefore carry CAPTURE_QR_V2_ALWAYS: "1" (exactly "1": the panel context
// reads no other value as on). Staging and prod never set it.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
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
        expect(env.CAPTURE_QR_V2_ALWAYS, `${wf}:${line} shows the phone-camera option (capture-qr-v2 override)`).toBe("1");
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
      // PR #904: like CI, a per-run generated KEK (never a literal) and the walkthrough's fake connect delay.
      expect(boot).toMatch(/RELAY_KEK="\$\{RELAY_KEK:-\$\(openssl rand -hex 32\)\}"/);
      expect(boot).toMatch(/FAKE_INGEST_CONNECT_AFTER_MS="\$\{FAKE_INGEST_CONNECT_AFTER_MS:-\d+\}"/);
      // Capture QR v2: the flag's override, as CI's boots carry it.
      expect(boot).toMatch(/CAPTURE_QR_V2_ALWAYS="\$\{CAPTURE_QR_V2_ALWAYS:-1\}"/);
    }
  });
});

// B8 review m-3: "staging and prod never set it" was a comment. It is a sweep now, by behaviour: every file that
// configures or ships a deployed app — each Fly config (`fly*.toml`, whose `[env]` IS the deployed environment), each
// Dockerfile, each workflow that drives `flyctl`, and any committed staging/production env file — must not name the
// override at all (a comment naming it is one edit from live, so the token anywhere fails). The override would show the
// phone-camera option to every club, bypassing the flag's rollout.
describe("capture-qr-v2: the CI override never reaches a deployed environment", () => {
  const OVERRIDE = "CAPTURE_QR_V2_ALWAYS";
  /** Directories that hold no deploy config of ours (dependencies, builds, tool state). */
  const SKIP = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage", "test-results", "playwright-report", ".claude", ".superpowers"]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(resolve(dir, e.name), out); }
      else if (e.isFile()) out.push(resolve(dir, e.name));
    }
    return out;
  }
  const isFly = (f: string) => /^fly[^/]*\.toml$/.test(f.split("/").pop()!);
  const isDocker = (f: string) => /^Dockerfile/.test(f.split("/").pop()!);
  /** A committed env file for a deployed environment: `.env.stg`, `.env.staging`, `.env.prod`, `.env.production…`. */
  const isDeployEnv = (f: string) => /^\.env\.(?:stg|staging|prod|production)\b/i.test(f.split("/").pop()!);
  /** A workflow that ships to Fly: a non-comment line drives `flyctl` (a comment ABOUT flyctl does not deploy). */
  const isDeployWorkflow = (text: string) => text.split("\n").some((l) => !/^\s*#/.test(l) && /\bflyctl\b/.test(l));
  const names = (text: string) => text.includes(OVERRIDE);

  it("no Fly config, Dockerfile, deploy workflow or staging/production env file names CAPTURE_QR_V2_ALWAYS — and each kind was found", () => {
    const files = walk(ROOT);
    const fly = files.filter(isFly);
    const docker = files.filter(isDocker);
    const envs = files.filter(isDeployEnv);
    const workflows = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).map((f) => resolve(WORKFLOWS, f))
      .filter((f) => isDeployWorkflow(readFileSync(f, "utf8")));
    const checked = [...fly, ...docker, ...envs, ...workflows];
    for (const f of checked) expect(names(readFileSync(f, "utf8")), `${relative(ROOT, f)} names ${OVERRIDE}`).toBe(false);
    // Anti-vacuity, per kind: today fly.toml + fly.stg.toml + services/placement/fly.toml (and db/flyway.toml), the web
    // and placement Dockerfiles, and stg / prod / placement-stg / placement-prod. No staging/production env file is
    // committed (their values live in Fly secrets), so that kind may be empty — the detector below proves it would bite.
    expect(fly.map((f) => relative(ROOT, f)), "the web app's two Fly configs").toEqual(expect.arrayContaining(["fly.toml", "fly.stg.toml"]));
    expect(docker.map((f) => relative(ROOT, f)), "the web app's Dockerfile").toContain("Dockerfile");
    expect(workflows.map((f) => f.split("/").pop()).sort(), "the deploy workflows").toEqual(expect.arrayContaining(["prod.yml", "stg.yml"]));
    expect(workflows.map((f) => f.split("/").pop()), "e2e boots servers but deploys nothing").not.toContain("e2e.yml");
    expect(checked.length).toBeGreaterThanOrEqual(2 + 1 + 2);
  });

  it("the detector is live: the token anywhere in such a file is caught, each kind is recognised, and look-alikes are not", () => {
    let caught = 0;
    for (const text of ["[env]\n  CAPTURE_QR_V2_ALWAYS = \"1\"\n", "ENV CAPTURE_QR_V2_ALWAYS=1\n", "# CAPTURE_QR_V2_ALWAYS: \"1\"\n", "          CAPTURE_QR_V2_ALWAYS: '1'\n"]) {
      expect(names(text), text).toBe(true);
      caught++;
    }
    expect(caught).toBe(4);
    expect(names("[env]\n  PORT = \"3000\"\n"), "the positive pair: a clean file").toBe(false);
    expect(["/r/fly.toml", "/r/fly.stg.toml", "/r/services/placement/fly.toml"].every(isFly)).toBe(true);
    expect(["/r/Dockerfile", "/r/services/placement/Dockerfile", "/r/Dockerfile.stg"].every(isDocker)).toBe(true);
    expect(["/r/.env.stg", "/r/.env.staging", "/r/.env.prod", "/r/.env.production.local"].every(isDeployEnv)).toBe(true);
    expect(["/r/.env.example", "/r/.env.local", "/r/apps/web/.env.example"].some(isDeployEnv), "local templates are not deploy env files").toBe(false);
    expect(isDeployWorkflow("      - run: flyctl deploy -c fly.toml\n")).toBe(true);
    expect(isDeployWorkflow("# `flyctl deploy` would rebuild\n      - run: node server.js\n"), "a comment about flyctl ships nothing").toBe(false);
  });
});
