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
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { turnstileMode } from "@/server/turnstile";
import { bootSteps } from "./_ci-boot-steps";

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
