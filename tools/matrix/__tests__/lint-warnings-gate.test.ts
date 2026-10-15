// ESLint zero-warnings programme (L4, owner ruling 2026-10-14): the warnings
// were fixed for real, and `--max-warnings 0` holds them there. ESLint's exit
// code ignores warnings by default, so without the flag the next warning merges
// silently and the count drifts back up (it was 73 when the CI gate was first
// written "errors only"). This pins the three places the flag has to be:
//   1. every workspace `lint` script, and the root `lint:scripts` — the only
//      two ways CI reaches eslint (`npx turbo run lint`, `npm run lint:scripts`);
//   2. no workflow calls eslint any other way, which would bypass them;
//   3. the flag, read back out of the real script, turns a real warning into a
//      non-zero exit (with the flag removed the same input exits 0).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnBudget } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");
type Manifest = { scripts?: Record<string, string> };

/** Every `lint` script the repo's CI can reach: each pnpm workspace's own, plus the root `lint:scripts`. */
function lintScripts(): [string, string][] {
  const out: [string, string][] = [];
  for (const dir of ["apps", "packages", "tools"]) {
    for (const name of readdirSync(resolve(REPO, dir))) {
      const manifest = resolve(REPO, dir, name, "package.json");
      if (!existsSync(manifest)) continue;
      const lint = (JSON.parse(readFileSync(manifest, "utf8")) as Manifest).scripts?.lint;
      if (lint !== undefined) out.push([`${dir}/${name} lint`, lint]);
    }
  }
  const root = (JSON.parse(read("package.json")) as Manifest).scripts ?? {};
  expect(root["lint:scripts"], "root lint:scripts is the gate for scripts/ and tools/").toBeDefined();
  out.push(["root lint:scripts", root["lint:scripts"]!]);
  return out;
}

/** The flag in its two spellings. `--max-warnings=0` and `--max-warnings 0` mean the same to eslint. */
const GATE = /(?:^|\s)--max-warnings(?:=|\s+)0(?=\s|$)/;

describe("--max-warnings 0 is on every lint script", () => {
  it("scans the scripts it claims to: the four lint workspaces and the scripts/tools gate", () => {
    const names = lintScripts().map(([n]) => n);
    expect(names).toEqual(
      expect.arrayContaining(["apps/web lint", "packages/engine lint", "packages/reference lint", "packages/scheduler lint", "root lint:scripts"]),
    );
  });

  it("every one runs eslint with the gate", () => {
    let checked = 0;
    for (const [name, script] of lintScripts()) {
      checked++;
      expect(script, `${name}: not an eslint call`).toMatch(/^eslint\b/);
      expect(script, `${name}: eslint without --max-warnings 0 — a warning would merge`).toMatch(GATE);
    }
    expect(checked, "anti-vacuity: scripts judged").toBeGreaterThanOrEqual(5);
  });

  it("the gate matcher refuses the near misses", () => {
    for (const ok of ["eslint --max-warnings 0", "eslint --max-warnings=0 scripts tools", "eslint scripts --max-warnings 0"]) expect(ok).toMatch(GATE);
    for (const bad of ["eslint", "eslint --max-warnings 1", "eslint --max-warnings 10", "eslint --max-warnings=-1", "eslint --max-warnings", "eslint --no-max-warnings 0"]) {
      expect(bad, bad).not.toMatch(GATE);
    }
  });
});

describe("CI reaches eslint only through those scripts", () => {
  it("no workflow line runs eslint directly; the two lint steps are the scripts", () => {
    const dir = resolve(REPO, ".github/workflows");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(files.length, "anti-vacuity: workflow files scanned").toBeGreaterThan(0);
    const direct: string[] = [];
    for (const f of files) {
      for (const [i, line] of readFileSync(resolve(dir, f), "utf8").split("\n").entries()) {
        const code = line.trim();
        if (code.startsWith("#") || !/\beslint\b/.test(code)) continue;
        // A step's display name ("- name: eslint") is not a call.
        if (/^-?\s*name:/.test(code)) continue;
        direct.push(`${f}:${i + 1}: ${code}`);
      }
    }
    expect(direct, "a direct eslint call bypasses the --max-warnings 0 in the lint scripts").toEqual([]);

    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("run: npx turbo run lint");
    expect(ci).toContain("run: npm run lint:scripts");
  });
});

describe("the flag does what the pin claims", () => {
  // A component whose only finding is a react-hooks/set-state-in-effect WARNING
  // (the rule is "warn" in apps/web/eslint.config.mjs) — no error rides along.
  const PLANTED = [
    '"use client";',
    'import { useEffect, useState } from "react";',
    "export function Planted() {",
    "  const [n, setN] = useState(0);",
    "  useEffect(() => {",
    "    setN(1);",
    "  }, []);",
    "  return <p>{n}</p>;",
    "}",
    "",
  ].join("\n");
  const CLEAN = ['export function Clean() {', "  return <p>ok</p>;", "}", ""].join("\n");

  const web = resolve(REPO, "apps/web");
  /** The args of apps/web's REAL lint script, after the `eslint` word — so the test follows the script, not a copy of it. */
  const scriptArgs = (): string[] => {
    const script = (JSON.parse(readFileSync(resolve(web, "package.json"), "utf8")) as Manifest).scripts!.lint!;
    return script.split(/\s+/).slice(1);
  };
  const lint = (args: string[], input: string) =>
    spawnSync(resolve(web, "node_modules/.bin/eslint"), [...args, "--format", "json", "--stdin", "--stdin-filename", "src/__planted__.tsx"], {
      cwd: web, input, encoding: "utf8", timeout: 25_000,
    });
  const messages = (stdout: string) =>
    (JSON.parse(stdout) as { messages: { ruleId: string | null; severity: number }[] }[])[0]!.messages;

  it("a planted warning exits non-zero under the real script's flags, and exits 0 without them", () => {
    const gated = lint(scriptArgs(), PLANTED);
    const planted = messages(gated.stdout);
    expect(planted.map((m) => [m.ruleId, m.severity]), "PREMISE: the planted input is exactly one WARNING").toEqual([["react-hooks/set-state-in-effect", 1]]);
    expect(gated.status, `with ${scriptArgs().join(" ")}: ${gated.stderr}`).toBe(1);

    const ungated = lint([], PLANTED);
    expect(messages(ungated.stdout).map((m) => m.ruleId), "same warning is reported").toEqual(["react-hooks/set-state-in-effect"]);
    expect(ungated.status, "control: without the flag a warning does not fail the run").toBe(0);
  }, spawnBudget(2));

  it("clean code still passes the gate (the flag is not a blanket failure)", () => {
    const r = lint(scriptArgs(), CLEAN);
    expect(messages(r.stdout)).toEqual([]);
    expect(r.status).toBe(0);
  }, spawnBudget(1));
});
