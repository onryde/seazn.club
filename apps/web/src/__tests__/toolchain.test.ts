import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

/**
 * The Node floor is stated in four places that have no way to check each other:
 * the root `engines` field, every `setup-node` step, the Dockerfile base images,
 * and `@types/node`. They drifted before this test existed — the dev machine ran
 * v26.4.0 while CI and prod ran 22, so every local verification executed on a
 * runtime nothing else used.
 */
const NODE_MAJOR = 26;

describe("toolchain: node floor", () => {
  it("root package.json declares the engines floor", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(`>=${NODE_MAJOR}`);
  });

  it("every setup-node step pins the same major", () => {
    const dir = join(REPO_ROOT, ".github/workflows");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        const m = /^\s*node-version:\s*(\S+)\s*$/.exec(line);
        // YAML permits `node-version: 26` and `node-version: "26"` alike. Compare
        // the value, not the quoting — otherwise this drifts into policing a
        // formatting convention and fails on a correct edit.
        const pinned = m?.[1].replace(/^["']|["']$/g, "");
        if (pinned !== undefined && pinned !== String(NODE_MAJOR)) {
          offenders.push(`${file}:${i + 1} -> ${pinned}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("both Dockerfile stages use the same major", () => {
    const text = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
    const bases = [...text.matchAll(/^FROM\s+node:(\S+?)-alpine/gm)].map(
      (m) => m[1],
    );
    expect(bases.length).toBe(2);
    expect(bases).toEqual([String(NODE_MAJOR), String(NODE_MAJOR)]);
  });

  it("@types/node tracks the runtime major in every TS workspace", () => {
    for (const ws of ["apps/web", "packages/engine", "apps/cron-worker"]) {
      const pkg = JSON.parse(
        readFileSync(join(REPO_ROOT, ws, "package.json"), "utf8"),
      ) as { devDependencies?: Record<string, string> };
      expect(
        pkg.devDependencies?.["@types/node"],
        `${ws} @types/node`,
      ).toBe(`^${NODE_MAJOR}`);
    }
  });
});

describe("toolchain: compile target", () => {
  it("apps/web targets ES2022, matching the engine", () => {
    const stripJsonComments = (s: string) =>
      s.replace(/^\s*\/\/.*$/gm, "");
    const web = JSON.parse(
      stripJsonComments(
        readFileSync(join(REPO_ROOT, "apps/web/tsconfig.json"), "utf8"),
      ),
    ) as { compilerOptions: { target: string } };
    const engine = JSON.parse(
      stripJsonComments(
        readFileSync(join(REPO_ROOT, "packages/engine/tsconfig.json"), "utf8"),
      ),
    ) as { compilerOptions: { target: string } };
    expect(web.compilerOptions.target).toBe("ES2022");
    expect(web.compilerOptions.target).toBe(engine.compilerOptions.target);
  });
});

describe("toolchain: suppression policy", () => {
  /**
   * Both halves of the rule are load-bearing and they fail differently.
   *
   * `"ts-ignore": true` is the ban itself. `"ts-expect-error":
   * "allow-with-description"` is what keeps the escape hatch usable — set it to
   * `true` as well and every suppression is illegal, which does not make the
   * codebase safer, it makes people delete the rule. Asserting only the first
   * half lets the second be weakened or dropped in silence.
   */
  for (const cfg of [
    "apps/web/eslint.config.mjs",
    "packages/engine/eslint.config.mjs",
  ]) {
    it(`${cfg} bans @ts-ignore and keeps @ts-expect-error described`, () => {
      const text = readFileSync(join(REPO_ROOT, cfg), "utf8");
      const rule =
        /["']@typescript-eslint\/ban-ts-comment["']\s*:\s*\[\s*["']error["']\s*,\s*(\{[\s\S]*?\})/.exec(
          text,
        );
      expect(rule, `${cfg}: no ban-ts-comment rule found`).not.toBeNull();
      const options = rule![1];
      expect(options, cfg).toMatch(/["']ts-ignore["']\s*:\s*true/);
      expect(options, cfg).toMatch(
        /["']ts-expect-error["']\s*:\s*["']allow-with-description["']/,
      );
    });
  }
});

import { execFileSync } from "node:child_process";

describe("toolchain: which compiler gates types", () => {
  /**
   * Both packages declare `bin.tsc`, so `node_modules/.bin/tsc` resolves to
   * whichever installed last. Verified real: in a scratch install v7 won
   * `.bin/tsc` while v6 won `.bin/tsserver`. Every typecheck script therefore
   * names an explicit path, and this test is what stops a silent swap back.
   */
  const NATIVE = join(REPO_ROOT, "node_modules/typescript-native/bin/tsc");

  it("the aliased binary is TypeScript 7", () => {
    const out = execFileSync(process.execPath, [NATIVE, "--version"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/Version 7\./);
  });

  it("the bare specifier is still TypeScript 6, for lint and the editor", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "node_modules/typescript/package.json"), "utf8"),
    ) as { version: string };
    expect(pkg.version.startsWith("6.")).toBe(true);
  });

  it("no typecheck script invokes bare tsc", () => {
    const offenders: string[] = [];
    for (const p of ["package.json", "apps/web/package.json", "packages/engine/package.json"]) {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8")) as {
        scripts?: Record<string, string>;
      };
      for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
        if (!name.startsWith("typecheck")) continue;
        if (/(^|[^-\w/])tsc(\s|$)/.test(body)) offenders.push(`${p} :: ${name} -> ${body}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("toolchain: no V8 heap ceiling for typecheck", () => {
  /**
   * The 6 GB ceiling existed only because apps/web's tsc peaked ~2.8 GB against
   * the runner's ~2 GB default V8 heap. TS 7 is a Go binary — the flag has no
   * effect on it — so carrying the ceiling forward would be cargo cult, and
   * worse, would mask a regression back to a V8 compiler.
   */
  /**
   * Assert the flag is not SET — not that the string never appears anywhere.
   * The first version matched the whole file, which forbade *documenting* the
   * flag: the CI comment explaining why never to reintroduce it had to refer to
   * it obliquely, so the warning most likely to prevent the regression was the
   * one thing the test outlawed. A test that suppresses its own rationale is
   * too broad.
   */
  /**
   * The container job exists to catch one specific failure: the TypeScript 7 Go
   * binary building cleanly into the alpine image and then being unable to
   * execute, which `docker build` alone cannot detect because SKIP_TYPECHECK=1
   * means it never invokes tsc.
   *
   * CI/Stage/Prod split into separate workflow files (2026-08-11): ci.yml runs
   * ONLY on pull_request now, and the deploy jobs live in stg.yml/prod.yml
   * (renamed from stage.yml the same day, to match the repo's existing "stg"
   * convention — fly.stg.toml, stg.seazn.club, the placement-stg Fly app),
   * which run on push/tag. `needs:` only resolves within ONE workflow run, so
   * a deploy job in a different file literally cannot `needs:` a job defined
   * here — there is no syntax for it.
   *
   * The PREVIOUS same-file `needs: [..., container]` on `deploy-staging`
   * (asserted here before this split) never actually gated the push trigger
   * either: `deploy-staging` only ran when `github.event_name == 'push'`, and
   * every job it needed — including `container` — carried
   * `if: github.event_name == 'pull_request'`. So in the one run where
   * deploy-staging's own `if` was true, everything it needed was `skipped`,
   * never `failure`, and `!contains(needs.*.result, 'failure')` was trivially
   * satisfied regardless of whether the PR's own run had passed. The real
   * enforcement was always GitHub's required-status-checks branch protection
   * on the PR, which this test cannot see from the filesystem either way.
   *
   * What's still real to assert: `container` carries no leftover per-job
   * `if:` guard (dead code now the whole workflow is PR-only), and no deploy
   * workflow declares a `needs:` — since cross-workflow `needs:` is a SILENT
   * no-op in GitHub Actions (the job simply never runs, no validation error),
   * a stray one here is worth catching rather than trusting it "looks right".
   */
  it("container has no dead per-job guard; no deploy workflow declares needs:", () => {
    const ci = readFileSync(
      join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    const job = ci.slice(ci.indexOf("\n  container:"));
    const header = job.slice(0, job.indexOf("steps:"));
    expect(header).not.toContain("github.event_name");

    for (const file of [
      "stg.yml",
      "prod.yml",
      "placement-stg.yml",
      "placement-prod.yml",
    ]) {
      const text = readFileSync(
        join(REPO_ROOT, ".github/workflows", file),
        "utf8",
      );
      expect(
        text,
        `${file} must not declare needs: — cross-workflow needs: is a silent no-op, not a validation error`,
      ).not.toMatch(/^\s*needs:/m);
    }
  });

  /**
   * `actions/setup-node` enables pnpm caching BY ITSELF once package.json
   * declares a `packageManager` — no `cache:` input required, and passing none
   * does not opt out. Its post step then shells to pnpm to locate the store and
   * fails the whole job if that directory does not exist:
   *
   *     Path Validation Error: Path(s) specified in the action for caching
   *     do(es) not exist, hence no cache is being saved.
   *
   * This is nasty because it fails AFTER every step of the job has succeeded.
   * The security job's audit passed and the job still went red; a bootstrap
   * job could baseline the database and then still report failure. So any
   * job that sets up node must either install (which creates the store) or
   * create the directory itself.
   */
  it("every setup-node job either installs or creates the pnpm store", () => {
    const dir = join(REPO_ROOT, ".github/workflows");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(join(dir, file), "utf8");
      const jobsAt = text.indexOf("\njobs:");
      if (jobsAt < 0) continue;
      // Job keys sit at exactly two spaces of indent under `jobs:`.
      const body = text.slice(jobsAt);
      const lines = body.split("\n");
      let current = "";
      let buffer: string[] = [];
      const flush = () => {
        if (!current) return;
        const block = buffer.join("\n");
        if (!/uses:\s*actions\/setup-node/.test(block)) return;
        const stripped = block
          .split("\n")
          .filter((l) => !/^\s*#/.test(l))
          .join("\n");
        if (!/pnpm install/.test(stripped) && !/pnpm store path/.test(stripped)) {
          offenders.push(`${file} :: ${current}`);
        }
      };
      for (const line of lines) {
        const m = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
        if (m) {
          flush();
          current = m[1];
          buffer = [];
        } else {
          buffer.push(line);
        }
      }
      flush();
    }
    expect(offenders).toEqual([]);
  });

  it("ci.yml sets no V8 heap ceiling on any active step", () => {
    const active = readFileSync(
      join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    )
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => /max-old-space-size/.test(line));
    expect(active).toEqual([]);
  });
});

describe("toolchain: Turbopack build cache is opt-in and env-gated", () => {
  /**
   * Next 16's `experimental.turbopackFileSystemCacheForBuild` is off by
   * default and "experimental for production builds", so every `next build`
   * compiled from zero — a one-file change cost the same 48s compile as a
   * clean tree, and 5.5min under load. Local seazn-env builds now opt in via
   * NEXT_BUILD_FS_CACHE=1; CI, Docker and the deploy workflows leave it unset
   * and stay cold. Both halves are asserted because either alone is inert:
   * turbo runs in strict env mode and strips any variable not listed in
   * `build.env` before next.config.js ever sees it.
   */
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function buildCacheFlag(): Promise<unknown> {
    vi.resetModules();
    const mod = (await import("../../next.config.js")) as {
      nextConfig: { experimental?: { turbopackFileSystemCacheForBuild?: unknown } };
    };
    return mod.nextConfig.experimental?.turbopackFileSystemCacheForBuild;
  }

  it("next.config.js leaves the cache OFF when NEXT_BUILD_FS_CACHE is unset", async () => {
    vi.stubEnv("NEXT_BUILD_FS_CACHE", "");
    expect(await buildCacheFlag()).toBe(false);
  });

  it("next.config.js turns the cache ON only for NEXT_BUILD_FS_CACHE=1", async () => {
    vi.stubEnv("NEXT_BUILD_FS_CACHE", "1");
    expect(await buildCacheFlag()).toBe(true);
    vi.stubEnv("NEXT_BUILD_FS_CACHE", "true");
    expect(await buildCacheFlag()).toBe(false);
  });

  it("turbo.json hashes NEXT_BUILD_FS_CACHE into the build task, beside SKIP_TYPECHECK", () => {
    // turbo.json carries `//` comment lines; the only `//` inside a string is
    // the $schema URL, which a line-anchored strip never touches.
    const jsonc = readFileSync(join(REPO_ROOT, "turbo.json"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    const turbo = JSON.parse(jsonc) as { tasks: { build: { env?: string[] } } };
    expect(turbo.tasks.build.env).toContain("NEXT_BUILD_FS_CACHE");
    expect(turbo.tasks.build.env).toContain("SKIP_TYPECHECK");
  });
});


function rootManifest(): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
}

describe("toolchain: pnpm workspace", () => {
  it("declares the workspace and uses the workspace protocol", () => {
    const ws = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    expect(ws).toContain("apps/*");
    expect(ws).toContain("packages/*");
    const web = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps/web/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    // `"*"` makes pnpm hit the registry for a private package and fail with
    // "No authorization header" — it must be the workspace protocol.
    expect(web.dependencies["@seazn/engine"]).toBe("workspace:*");
  });

  /**
   * The hoist patterns must live here rather than in `.npmrc`, and the reason
   * is not tidiness. npm parses `.npmrc` too and does not know these keys, so
   * with them there every `npm run` in the repo — around 30 deliberate
   * task-runner calls across ci.yml, e2e.yml, help-shots.yml, sim-nightly.yml
   * and the root scripts — printed `Unknown project config
   * "public-hoist-pattern". This will stop working in the next major version of
   * npm`. A warning today, a hard failure at npm 12, on steps that do not
   * install anything. pnpm reads this file and npm never looks at it.
   */
  it("carries the hoist patterns, and .npmrc does not", () => {
    const ws = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
    const active = ws
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(active).toMatch(/^publicHoistPattern:/m);
    for (const p of ["pdfkit", "exceljs"]) {
      expect(active, `hoist pattern for ${p}`).toMatch(
        new RegExp(`^\\s*-\\s*${p}\\s*$`, "m"),
      );
    }

    // Not a ban on `.npmrc` itself — a registry or auth line there is fine.
    // Only the pnpm-specific keys are, because those are the ones npm rejects.
    let npmrc = "";
    try {
      npmrc = readFileSync(join(REPO_ROOT, ".npmrc"), "utf8");
    } catch {
      return; // absent is the expected state
    }
    const offenders = npmrc
      .split("\n")
      .filter((line) => !/^\s*[#;]/.test(line))
      .filter((line) => /^\s*(public-hoist-pattern|hoist-pattern|shamefully-hoist|node-linker)\b/.test(line));
    expect(offenders).toEqual([]);
  });

  it("root declares every dependency its scripts import", () => {
    /**
     * Root scripts run from the repo root under --experimental-strip-types and
     * import from packages the root manifest never declared — under npm they
     * resolved by hoisting out of apps/web and packages/engine. pnpm's strict
     * linker gives root only what root declares, so every one of those scripts
     * breaks unless they are named here.
     *
     * This list is DERIVED, not guessed: grep every `from` / `import(` /
     * `require(` specifier under scripts/, strip the keyword and the quotes,
     * drop anything starting `node:` or `.`, then sort -u. Use `grep -a` — files
     * here report as "Binary file … matches" and a bare grep hides the lines,
     * which is exactly how a specifier gets missed. Re-derive rather than trust
     * this list whenever scripts/ grows.
     *
     * Two of these are invisible to a casual read of the manifests, and both
     * were hoisting artefacts: `playwright` is a TRANSITIVE dep (apps/web
     * declares `@playwright/test`) that scripts/help-shots.ts requires by name,
     * and `@seazn/engine` is a workspace package that scripts/sync-sports.ts
     * imports as `@seazn/engine/sports` while only apps/web depended on it.
     */
    const root = rootManifest();
    const declared = new Set([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.devDependencies ?? {}),
    ]);
    for (const dep of [
      "@anthropic-ai/sdk",
      "@seazn/engine",
      "bcryptjs",
      "exceljs",
      "playwright",
      "postgres",
      "stripe",
      "zod",
    ]) {
      expect(declared.has(dep), `root must declare ${dep}`).toBe(true);
    }
  });

  it("what the deploy job's --prod install needs is a real dependency", () => {
    /**
     * ci.yml's deploy-staging job installs with `--prod`, then runs
     * `sync:sports` (postgres + @seazn/engine/sports) and `stripe:sync`
     * (postgres + stripe) from the repo ROOT. Under `npm ci --omit=dev` those
     * three arrived anyway, hoisted out of apps/web's PRODUCTION dependencies.
     * pnpm --prod honours the section they are declared in, so parking them in
     * devDependencies — where every other root script dep correctly lives —
     * would drop them from the deploy install and ERR_MODULE_NOT_FOUND every
     * staging release.
     */
    const root = rootManifest();
    const prod = new Set(Object.keys(root.dependencies ?? {}));
    for (const dep of ["@seazn/engine", "postgres", "stripe"]) {
      expect(prod.has(dep), `root dependencies must include ${dep}`).toBe(true);
    }
  });

  it("root declares what its own typecheck paths reach for", () => {
    /**
     * `typecheck:scripts` runs `node node_modules/typescript-native/bin/tsc`
     * from the repo root, and tsconfig.scripts.json sets `"types": ["node"]`,
     * resolved relative to the tsconfig — i.e. ROOT node_modules. Under npm
     * both arrived by hoisting from the two workspaces. Under pnpm the root
     * gets only what the root declares, so an undeclared compiler or @types
     * turns every typecheck script into ENOENT / TS2688.
     *
     * `typescript` (bare, 6.x) belongs here for a different reason: an editor
     * opened at the repo root resolves tsserver from `./node_modules/typescript`
     * and nothing else does. Hoisting used to supply it; under pnpm the root
     * would silently have no language service at all.
     */
    const declared = new Set(Object.keys(rootManifest().devDependencies ?? {}));
    for (const dep of ["@types/node", "typescript", "typescript-native"]) {
      expect(declared.has(dep), `root must declare ${dep}`).toBe(true);
    }
  });
});

describe("toolchain: every install site is pnpm", () => {
  const WORKFLOW_DIR = join(REPO_ROOT, ".github/workflows");
  const workflows = () =>
    readdirSync(WORKFLOW_DIR)
      .filter((f) => f.endsWith(".yml"))
      .map((f) => [f, readFileSync(join(WORKFLOW_DIR, f), "utf8")] as const);

  it("no workflow still installs, audits or caches with npm", () => {
    /**
     * The cutover is one-shot — npm errors EUNSUPPORTEDPROTOCOL on
     * `workspace:*`, and package-lock.json is gone — so a leftover `npm ci`
     * does not degrade, it fails the job outright. `cache: npm` is the quiet
     * one: setup-node looks for a package-lock.json to hash, finds none, and
     * the step still succeeds while caching nothing at all.
     */
    const offenders: string[] = [];
    for (const [file, text] of workflows()) {
      for (const [i, line] of text.split("\n").entries()) {
        if (/^\s*#/.test(line)) continue;
        if (/\bnpm (ci|install|audit)\b/.test(line) || /cache:\s*['"]?npm['"]?\s*$/.test(line)) {
          offenders.push(`${file}:${i + 1} ->${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every workflow that installs also sets pnpm up first", () => {
    /**
     * Node 26 dropped corepack, so there is no bundled shim to activate:
     * without pnpm/action-setup the runner has no pnpm at all. It must also
     * come BEFORE setup-node, because `cache: pnpm` asks pnpm for its store
     * path and fails if pnpm is not yet on PATH.
     */
    const offenders: string[] = [];
    for (const [file, text] of workflows()) {
      if (!/\bpnpm (install|audit)\b/.test(text)) continue;
      const setup = text.indexOf("pnpm/action-setup");
      if (setup === -1) {
        offenders.push(`${file}: installs with pnpm but never sets it up`);
        continue;
      }
      const node = text.indexOf("actions/setup-node");
      if (node !== -1 && node < setup) {
        offenders.push(`${file}: setup-node precedes pnpm/action-setup`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no workflow keys a cache on the deleted npm lockfile", () => {
    const offenders: string[] = [];
    for (const [file, text] of workflows()) {
      for (const [i, line] of text.split("\n").entries()) {
        if (/^\s*#/.test(line)) continue;
        if (line.includes("package-lock.json")) offenders.push(`${file}:${i + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Dockerfile installs with pnpm and copies what pnpm reads", () => {
    /**
     * `pnpm-workspace.yaml` is the one that fails silently, and it is the
     * reason this assertion names files rather than just the install command.
     * Besides the workspace globs it carries the public-hoist patterns for the
     * public-hoist patterns for the serverExternalPackages; leave it out of the
     * image and `pnpm install` succeeds, `next build` succeeds, and the
     * standalone server cannot resolve pdfkit at runtime — exactly the failure the
     * local build was fixed for, reintroduced only in production.
     */
    const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).not.toMatch(/^\s*RUN[^\n#]*\bnpm ci\b/m);
    for (const f of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      expect(dockerfile, `Dockerfile must COPY ${f}`).toMatch(
        new RegExp(`^COPY[^\\n]*${f.replace(".", "\\.")}`, "m"),
      );
    }
  });
});
