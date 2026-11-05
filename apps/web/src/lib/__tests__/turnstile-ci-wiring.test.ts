// Cloudflare Turnstile and the servers CI boots. A production server (server.js runs NODE_ENV=production) ENFORCES the bot check
// unless its ENV_NAME names a developer's machine or CI (server/turnstile.ts `turnstileMode`), so a harness server that forgot
// ENV_NAME answers 403 TURNSTILE_FAILED to every magic-link sign-in, funnel start and registration it drives, and every suite
// behind them goes red on something that reads like an outage. The mirror image is worse and silent: a DEPLOYED app carrying a
// skipping ENV_NAME would never check anyone.
//
// Swept by BEHAVIOUR, not by file or step name (AGENTS.md class 16): EVERY workflow under .github/workflows is read and every
// production-server boot in it is judged by the env of the step that owns it. bench.yml is NOT exempt here, unlike in
// relay-drivers-ci-wiring.test.ts: it never streams, but its ONLY auth path is the magic-link POST (tools/bench/lib/http.ts),
// which is a guarded route. The verdict comes from `turnstileMode` itself, never a list typed here.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { turnstileMode } from "@/server/turnstile";
import { BOOT, bootSteps } from "./_ci-boot-steps";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");
const workflowFiles = () => readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();

describe("every production server CI boots skips the bot check, because it is a harness", () => {
  it("EVERY workflow, bench.yml included: each production boot's OWN step env makes turnstileMode answer skip", () => {
    const files = workflowFiles();
    let swept = 0;
    let checked = 0;
    const checkedIn = new Set<string>();
    for (const wf of files) {
      swept++;
      for (const { line, env } of bootSteps(readFileSync(resolve(WORKFLOWS, wf), "utf8"))) {
        expect(
          turnstileMode({ NODE_ENV: "production", ENV_NAME: env.ENV_NAME, TURNSTILE_SECRET: env.TURNSTILE_SECRET }),
          `${wf}:${line} boots a production server with ENV_NAME=${JSON.stringify(env.ENV_NAME)}: it would enforce the bot check against a harness that has no token`,
        ).toBe("skip");
        // And it must not hand the harness a live secret either: a harness that holds one is one edit from enforcing it.
        expect(env.TURNSTILE_SECRET, `${wf}:${line} puts a Turnstile secret in a CI step`).toBeUndefined();
        checked++;
        checkedIn.add(wf);
      }
    }
    expect(swept, "no workflow was read").toBeGreaterThan(0);
    expect(swept).toBe(files.length);
    expect(checkedIn.has("bench.yml"), "bench.yml's boot must be judged, not excused: its only auth path is the guarded magic-link POST").toBe(true);
    expect(checkedIn.has("e2e.yml") && checkedIn.has("ci.yml"), "e2e's and smoke's boots were judged").toBe(true);
    // 3 e2e jobs + ci's smoke server + bench + matrix-truth + ci's two extra servers, today; a floor, so a NEW boot is swept.
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("the detector is live: a boot step that forgot ENV_NAME is caught (the negative pair)", () => {
    const [bad] = bootSteps("      - name: Start server\n        env:\n          LOG_LEVEL: warn\n        run: |\n          node apps/web/.next/standalone/apps/web/server.js &\n");
    expect(bad).toBeDefined();
    expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: bad!.env.ENV_NAME })).toBe("enforce");
    const [good] = bootSteps("      - name: Start server\n        env:\n          ENV_NAME: ci\n        run: |\n          node apps/web/.next/standalone/apps/web/server.js &\n");
    expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: good!.env.ENV_NAME })).toBe("skip");
  });
});

describe("no deployed app skips the bot check", () => {
  const SKIP = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage", "test-results", "playwright-report", ".claude", ".superpowers"]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(resolve(dir, e.name), out); }
      else if (e.isFile()) out.push(resolve(dir, e.name));
    }
    return out;
  }
  const base = (f: string) => f.split("/").pop()!;
  const isFly = (f: string) => /^fly[^/]*\.toml$/.test(base(f));
  const isDocker = (f: string) => /^Dockerfile/.test(base(f));
  const isDeployEnv = (f: string) => /^\.env\.(?:stg|staging|prod|production)\b/i.test(base(f));
  /** A workflow that ships to Fly: a non-comment line drives `flyctl`. */
  const isDeployWorkflow = (text: string) => text.split("\n").some((l) => !/^\s*#/.test(l) && /\bflyctl\b/.test(l));
  /** `ENV_NAME = "ci"` (toml), `ENV ENV_NAME=ci` (Dockerfile), `ENV_NAME: ci` (workflow), `ENV_NAME=ci` (env file): the value. */
  const ENV_ASSIGN = /\bENV_NAME\b\s*[=:]\s*["']?([A-Za-z0-9_-]*)/;

  it("an unnamed production server and a stg/prod one both ENFORCE; only local and ci skip (the predicate, by its own verdicts)", () => {
    let checked = 0;
    for (const name of [undefined, "", "stg", "prod", "production", "staging"]) {
      expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: name }), `ENV_NAME=${JSON.stringify(name)}`).toBe("enforce");
      checked++;
    }
    for (const name of ["local", "ci"]) {
      expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: name }), `ENV_NAME=${name}`).toBe("skip");
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("no Fly config, Dockerfile, deploy workflow or staging/production env file assigns an ENV_NAME that makes a production server skip (each kind found)", () => {
    const files = walk(ROOT);
    const fly = files.filter(isFly);
    const docker = files.filter(isDocker);
    const envs = files.filter(isDeployEnv);
    const workflows = workflowFiles().map((f) => resolve(WORKFLOWS, f)).filter((f) => isDeployWorkflow(readFileSync(f, "utf8")));
    expect(fly.length, "no fly*.toml found: the premise of this test moved").toBeGreaterThanOrEqual(2);
    expect(docker.length, "no Dockerfile found").toBeGreaterThan(0);
    expect(workflows.length, "no deploy workflow found").toBeGreaterThan(0);
    let assignments = 0;
    for (const f of [...fly, ...docker, ...envs, ...workflows]) {
      for (const [i, l] of readFileSync(f, "utf8").split("\n").entries()) {
        if (/^\s*#/.test(l)) continue;
        const m = ENV_ASSIGN.exec(l);
        if (!m) continue;
        assignments++;
        expect(
          turnstileMode({ NODE_ENV: "production", ENV_NAME: m[1] }),
          `${relative(ROOT, f)}:${i + 1} names ENV_NAME=${m[1]}: a deployed app would skip the bot check`,
        ).toBe("enforce");
      }
    }
    // Today none of them assigns ENV_NAME (it is a Fly secret per deployment), so `assignments` is 0 by the truth of the tree and
    // the sweep's proof of life is the three `toBeGreaterThan` above (the files were read) plus the detector test below.
    expect(assignments, "a deployed config now assigns ENV_NAME: it was judged above, and this line wants a human to look at it").toBeLessThanOrEqual(0);
  });

  // The break-glass `TURNSTILE=off` is an OPERATOR's switch, set as a Fly secret on a running machine when Cloudflare is down.
  // A file in the repo that sets it would ship the check off to every deploy (or hide a harness that forgot ENV_NAME), so none may:
  // swept over the Fly configs, the Dockerfile, deploy env files and EVERY workflow (not only the ones that deploy).
  /** `TURNSTILE = "off"` (toml), `TURNSTILE=off` (env file, shell), `TURNSTILE: off` (workflow): the value. */
  const SWITCH_ASSIGN = /(?<![A-Za-z0-9_])TURNSTILE\s*[=:]\s*["']?\s*([^\s"'#,;]*)/;
  /** The Dockerfile's space form: `ENV TURNSTILE off`. */
  const SWITCH_DOCKER = /^\s*ENV\s+TURNSTILE\s+["']?([^\s"']+)/i;
  const switchValue = (line: string) => SWITCH_ASSIGN.exec(line)?.[1] ?? SWITCH_DOCKER.exec(line)?.[1];

  it("no Fly config, Dockerfile, deploy env file or workflow sets TURNSTILE (and none could turn the check off)", () => {
    const files = walk(ROOT);
    const fly = files.filter(isFly);
    const docker = files.filter(isDocker);
    const envs = files.filter(isDeployEnv);
    const workflows = workflowFiles().map((f) => resolve(WORKFLOWS, f));
    expect(fly.length, "no fly*.toml found: the premise of this test moved").toBeGreaterThanOrEqual(2);
    expect(docker.length, "no Dockerfile found").toBeGreaterThan(0);
    expect(workflows.length, "no workflow found").toBeGreaterThan(0);
    let read = 0;
    let assignments = 0;
    for (const f of [...fly, ...docker, ...envs, ...workflows]) {
      read++;
      for (const [i, l] of readFileSync(f, "utf8").split("\n").entries()) {
        if (/^\s*#/.test(l)) continue;
        const value = switchValue(l);
        if (value === undefined) continue;
        assignments++;
        expect(
          turnstileMode({ NODE_ENV: "production", ENV_NAME: "prod", TURNSTILE: value }),
          `${relative(ROOT, f)}:${i + 1} sets TURNSTILE=${value}: the bot check would be off on every deploy that carries it`,
        ).toBe("enforce");
      }
    }
    expect(read, "files read").toBe(fly.length + docker.length + envs.length + workflows.length);
    expect(assignments, "a repo file now sets TURNSTILE: it was judged above, and this line wants a human to look at it").toBeLessThanOrEqual(0);
  });

  it("the switch detector is live: it reads TURNSTILE in each syntax, and not a neighbouring variable", () => {
    let read = 0;
    for (const [line, value] of [
      ['    TURNSTILE = "off"', "off"],
      ["TURNSTILE=off", "off"],
      ["          TURNSTILE: off", "off"],
      ["  TURNSTILE: 'OFF'", "OFF"],
      ["ENV TURNSTILE off", "off"],
      ["ENV TURNSTILE=off", "off"],
    ] as const) {
      expect(switchValue(line), line).toBe(value);
      read++;
    }
    for (const line of ["TURNSTILE_SECRET=off", "NEXT_PUBLIC_TURNSTILE_SITE_KEY=off", "ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_HOSTNAMES: off", "ENV TURNSTILE_SECRET off"]) {
      expect(switchValue(line), line).toBeUndefined();
      read++;
    }
    expect(read).toBe(11);
    // And the verdict it feeds: a deployed config that carried the first line WOULD fail the sweep above.
    expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: "prod", TURNSTILE: switchValue('    TURNSTILE = "off"') })).toBe("skip");
  });

  it("the detector is live: an assignment in each syntax is read, with its value", () => {
    let read = 0;
    for (const [line, value] of [['    ENV_NAME = "ci"', "ci"], ["ENV ENV_NAME=local", "local"], ["          ENV_NAME: ci", "ci"], ["ENV_NAME=stg", "stg"]] as const) {
      expect(ENV_ASSIGN.exec(line)?.[1], line).toBe(value);
      read++;
    }
    expect(read).toBe(4);
    // And the verdict it feeds: a deployed config that carried the first line WOULD fail the sweep above.
    expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: ENV_ASSIGN.exec('    ENV_NAME = "ci"')![1] })).toBe("skip");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The same fault, one step earlier: a person (or an agent) following a DOCUMENTED local recipe boots a production server by hand.
// Swept by behaviour: every file under the recipe roots whose text boots one (`node … server.js`, `next start`, `npm start`) is
// either a recipe that names a skipping ENV_NAME or a reviewed prose mention. A new recipe that is neither fails.
// ---------------------------------------------------------------------------------------------------------------------------
const RECIPE_FILES = [
  "README.md",
  "docs/runbooks/e2e-local.md",
  "docs/runbooks/pad-gallery.md",
  "apps/web/e2e/global-setup.ts",
  "apps/web/e2e/walkthrough/event-pass.spec.ts",
  "scripts/ci-local.sh",
  "scripts/realtime-gate.sh",
];
/** Files that match BOOT only as prose ("the next start", "next start does not serve standalone"): no command a person would paste. */
const PROSE_ONLY = [
  "apps/web/e2e/helpers.ts",
  "apps/web/e2e/overlay-compositor.spec.ts",
  "apps/web/e2e/public-cache-headers.spec.ts",
  "apps/web/e2e/walkthrough/stream-credits.spec.ts",
  "apps/web/e2e/walkthrough/stream-relay.spec.ts",
  "apps/web/playwright.config.ts",
];
const RECIPE_ROOTS = ["README.md", "docs/runbooks", "scripts", "apps/web/e2e", "apps/web/playwright.config.ts", "apps/web/playwright.load.config.ts"];
const NAMED_ENV = /\bENV_NAME=(\w+)/g;

function textFiles(path: string): string[] {
  const abs = resolve(ROOT, path);
  if (!statSync(abs).isDirectory()) return /\.(ts|tsx|md|sh|mjs|js)$/.test(abs) ? [path] : [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name.startsWith(".") ? [] : textFiles(`${path}/${e.name}`),
  );
}

describe("every documented local boot recipe names a skipping ENV_NAME", () => {
  it("each recipe file sets ENV_NAME to a value turnstileMode skips on, and no recipe names an enforcing one", () => {
    let checked = 0;
    for (const f of RECIPE_FILES) {
      const names = [...readFileSync(resolve(ROOT, f), "utf8").matchAll(NAMED_ENV)].map((m) => m[1]!);
      expect(names.length, `${f} is a boot recipe with no ENV_NAME=...: a production server it starts refuses every public POST`).toBeGreaterThan(0);
      for (const n of names) expect(turnstileMode({ NODE_ENV: "production", ENV_NAME: n }), `${f} names ENV_NAME=${n}`).toBe("skip");
      checked++;
    }
    expect(checked, "recipes judged").toBe(RECIPE_FILES.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("discovery: every file under the recipe roots that boots a production server is a judged recipe or a reviewed prose mention", () => {
    const files = [...new Set(RECIPE_ROOTS.flatMap(textFiles))].sort();
    const booting = files.filter((f) => readFileSync(resolve(ROOT, f), "utf8").split("\n").some((l) => BOOT.test(l)));
    expect(files.length, "the walker found the recipe roots").toBeGreaterThan(50);
    expect(booting.length, "boot mentions found").toBeGreaterThan(0);
    const judged = new Set([...RECIPE_FILES, ...PROSE_ONLY]);
    expect(booting.filter((f) => !judged.has(f)), "a file boots a server and is neither a recipe nor reviewed prose: add ENV_NAME=local to it, or list it").toEqual([]);
    // Both lists must still be live: a recipe file that stopped booting anything, or a prose file that was cleaned, is stale.
    expect([...RECIPE_FILES, ...PROSE_ONLY].filter((f) => !booting.includes(f)), "listed but no longer a boot mention").toEqual([]);
  });

  it("the file walker reads a directory, a single file and ignores a non-text file (it is not vacuous)", () => {
    expect(textFiles("docs/runbooks").some((f) => f.endsWith("e2e-local.md"))).toBe(true);
    expect(textFiles("README.md")).toEqual(["README.md"]);
    expect(textFiles("docs/runbooks/relay-health-review.sql")).toEqual([]);
  });
});
