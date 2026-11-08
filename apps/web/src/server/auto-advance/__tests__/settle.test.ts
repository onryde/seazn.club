// Swiss auto-advance, plan Task 5 (decision D8; controller ruling, AGENTS.md class 20): the settle window, and the one
// door a CI run has to shorten it.
//
// `resolveSettleMs` answers the spec's 60 s (§4.2, "AUTO_ADVANCE_SETTLE_MS = 60_000"; G3) unless BOTH of these hold:
//   - the explicit e2e flag `E2E_PROD_TARGET=1` is set (e2e.yml sets it at job level, so the CI server and its
//     Playwright runner both read it; nothing that ships does — pinned below);
//   - `E2E_AUTO_ADVANCE_SETTLE_MS` is a whole number of milliseconds in [2000, 60000].
// So a stray override var on a deployed machine can never shorten the production settle, and the override can only
// ever SHORTEN it (its ceiling is the default).
//
// The default is pinned as a typed literal from the spec, never read back off the live value or the code under test:
// an override in this process's own env cannot move what this file expects. Pure: no DB, no network.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTO_ADVANCE_SETTLE_MS } from "@/lib/auto-advance";
import { SETTLE_MS_ENV_VAR, SETTLE_OVERRIDE_FLAG, resolveSettleMs } from "../settle";

/** Spec §4.2: "60 s is a constant, not a setting (`AUTO_ADVANCE_SETTLE_MS = 60_000`)". */
const SPEC_SETTLE_MS = 60_000;
/** The names the brief and the plan (D8) give: the override, and the e2e flag that alone lets it act. */
const OVERRIDE = "E2E_AUTO_ADVANCE_SETTLE_MS";
const FLAG = "E2E_PROD_TARGET";

type Env = Record<string, string | undefined>;

const flagged = (value: string | undefined): Env =>
  value === undefined ? { [FLAG]: "1" } : { [FLAG]: "1", [OVERRIDE]: value };

describe("resolveSettleMs (plan D8)", () => {
  it("names the variables the plan names", () => {
    expect(SETTLE_MS_ENV_VAR).toBe(OVERRIDE);
    expect(SETTLE_OVERRIDE_FLAG).toBe(FLAG);
  });

  it("default is the spec's 60 s with the var unset (pinned on the DEFAULT, not the live value)", () => {
    expect(AUTO_ADVANCE_SETTLE_MS, "the declared constant").toBe(SPEC_SETTLE_MS);
    expect(resolveSettleMs({}), "nothing set").toBe(SPEC_SETTLE_MS);
    expect(resolveSettleMs({ [FLAG]: "1" }), "the flag alone moves nothing").toBe(SPEC_SETTLE_MS);
  });

  it("in-range override is honoured, with the e2e flag set", () => {
    let checked = 0;
    for (const ms of [2_000, 3_000, 5_000, 59_999, 60_000]) {
      expect(resolveSettleMs(flagged(String(ms))), String(ms)).toBe(ms);
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("an override with the flag off is ignored: a stray env var alone never shortens the settle", () => {
    let checked = 0;
    for (const flag of [undefined, "", "0", "true", "yes", "01", " 1"]) {
      const env: Env = flag === undefined ? { [OVERRIDE]: "5000" } : { [FLAG]: flag, [OVERRIDE]: "5000" };
      // The wrong answer (the override, 5 s) differs from the right one (the default, 60 s).
      expect(resolveSettleMs(env), `flag ${JSON.stringify(flag)}`).toBe(SPEC_SETTLE_MS);
      checked++;
    }
    expect(checked).toBe(7);
  });

  it("out-of-range, non-integer or empty falls back to 60 s (the Number(\"\") === 0 trap included)", () => {
    let checked = 0;
    for (const raw of ["", " ", "0", "1999", "60001", "600000", "-3000", "1e4", "5000.5", "5000ms", "NaN", "Infinity", "0x1388", " 5000", "5000 ", "５０００"]) {
      expect(resolveSettleMs(flagged(raw)), JSON.stringify(raw)).toBe(SPEC_SETTLE_MS);
      checked++;
    }
    expect(checked).toBe(16);
  });
});

/** Repo root: up out of __tests__ / auto-advance / server / src / web / apps. */
const REPO_ROOT = resolve(import.meta.dirname, "../../../../../..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "target", "coverage", ".turbo", "out"]);

/** Every Dockerfile and fly*.toml in the repo, found by walking it (a new service is covered without a hand list). */
function shippedConfigs(): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (/^Dockerfile/.test(entry.name) || /^fly.*\.toml$/.test(entry.name)) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(REPO_ROOT, 0);
  return found.sort();
}

/** The workflows that deploy, chosen by what they run (flyctl / fly deploy), not by their names. */
function deployWorkflows(): string[] {
  const dir = join(REPO_ROOT, ".github/workflows");
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f))
    .filter((p) => /flyctl|fly deploy|superfly\//.test(readFileSync(p, "utf8")))
    .sort();
}

const rel = (p: string) => relative(REPO_ROOT, p);

describe("the settle override reaches nothing that ships", () => {
  it("no deploy config sets the override, and none sets the e2e flag", () => {
    const envExamples = [".env.example", "apps/web/.env.example"].map((p) => join(REPO_ROOT, p));
    const shipped = [...shippedConfigs(), ...deployWorkflows(), join(REPO_ROOT, "apps/cron-worker/wrangler.json")];
    const names = [...shipped, ...envExamples].map(rel);
    // Anti-vacuity: the scan holds the configs that actually build, ship and document the app.
    for (const must of ["Dockerfile", "fly.toml", "fly.stg.toml", ".github/workflows/prod.yml", ".github/workflows/stg.yml", "apps/cron-worker/wrangler.json", ".env.example", "apps/web/.env.example"]) {
      expect(names, `the scan covers ${must}`).toContain(must);
    }
    // The override is named nowhere in them, not even commented out: a commented example is one keystroke from shipped.
    const overrideOffenders = [...shipped, ...envExamples].filter((p) => readFileSync(p, "utf8").includes(OVERRIDE)).map(rel);
    expect(overrideOffenders, `${names.length} configs scanned; none may name ${OVERRIDE}`).toEqual([]);
    // The flag: no shipped config SETS it (an uncommented line naming it). The env examples document it commented out,
    // for local e2e runs, and are held to the same uncommented-line rule.
    const setsFlag = (p: string) =>
      readFileSync(p, "utf8")
        .split("\n")
        .some((line) => line.includes(FLAG) && !line.trimStart().startsWith("#"));
    const flagOffenders = [...shipped, ...envExamples].filter(setsFlag).map(rel);
    expect(flagOffenders, `${names.length} configs scanned; none may set ${FLAG}`).toEqual([]);
    expect(names.length).toBeGreaterThan(0);
  });
});
