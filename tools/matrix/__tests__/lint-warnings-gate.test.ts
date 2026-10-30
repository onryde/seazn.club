// ESLint zero-warnings programme (L4, owner ruling 2026-10-14): the warnings
// were fixed for real, and `--max-warnings 0` holds them there. ESLint's exit
// code ignores warnings by default, so without the flag the next warning merges
// silently and the count drifts back up (it was 73 when the CI gate was first
// written "errors only"). This pins every place the flag has to be, and every
// way it can be quietly undone:
//   1. every workspace `lint` script, and the root `lint:scripts` — the only two
//      ways CI reaches eslint — carry `--max-warnings 0` EXACTLY ONCE. ESLint
//      takes the LAST occurrence, so `--max-warnings 0 --max-warnings 100`
//      exits 0 on a warning: "contains the flag" is not the property, "the flag
//      that wins is 0" is;
//   2. the two CI steps are whole-line `npx turbo run lint` / `npm run
//      lint:scripts` with no key beside them (`continue-on-error`, `if`, `env`)
//      and none on their job — turbo forwards `-- --max-warnings 100`, a shell
//      forwards `|| true`, and either one turns the gate off;
//   3. no workflow calls eslint any other way, which would bypass both;
//   4. the flags, read back out of each real script, turn a real warning into a
//      non-zero exit in EVERY lint workspace (and the same input exits 0
//      without them) — the proof that the config each workspace lints with does
//      not make the flag inert.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { spawnBudget } from "./spawn-budget.ts";
import { jobsOf, stepOf } from "./workflow-text.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");
type Manifest = { scripts?: Record<string, string> };

/** Every `lint` script the repo's CI can reach: each pnpm workspace's own, plus the root `lint:scripts`. */
function lintScripts(): { label: string; cwd: string; script: string }[] {
  const out: { label: string; cwd: string; script: string }[] = [];
  for (const dir of ["apps", "packages", "tools"]) {
    for (const name of readdirSync(resolve(REPO, dir))) {
      const manifest = resolve(REPO, dir, name, "package.json");
      if (!existsSync(manifest)) continue;
      const lint = (JSON.parse(readFileSync(manifest, "utf8")) as Manifest).scripts?.lint;
      if (lint !== undefined) out.push({ label: `${dir}/${name}`, cwd: `${dir}/${name}`, script: lint });
    }
  }
  const root = (JSON.parse(read("package.json")) as Manifest).scripts ?? {};
  expect(root["lint:scripts"], "root lint:scripts is the gate for scripts/ and tools/").toBeDefined();
  out.push({ label: "root lint:scripts", cwd: ".", script: root["lint:scripts"]! });
  return out;
}

/** The scripts as they stand. Each is a whole-script pin: a reshaped script reds here and is re-judged by a person.
 *  Engine split 2b (reverse inventory row 31): packages/engine left the workspace with its lint script; its gate is the engine
 *  repository's. The two anti-vacuity floors below each counted it, and each is lowered by exactly that one workspace. */
const EXPECTED: Record<string, string> = {
  "apps/web": "eslint --max-warnings 0",
  "packages/reference": "eslint --max-warnings 0",
  "packages/scheduler": "eslint --max-warnings 0",
  "root lint:scripts": "eslint --max-warnings 0 scripts tools",
};

/** Why a lint script does NOT hold the gate, or null when it does: a bare `eslint` command, no shell syntax that can
 *  swallow its exit code or add a second command, and exactly ONE `--max-warnings` whose value is 0 (either spelling —
 *  ESLint reads `--max-warnings 0` and `--max-warnings=0` alike, and the LAST one wins, so a second one is a bypass). */
function gateProblem(script: string): string | null {
  if (!/^[A-Za-z0-9_./@=-]+( [A-Za-z0-9_./@=-]+)*$/.test(script)) return "shell syntax (|, &, ;, $, quotes, redirects) that can swallow or replace eslint's exit code";
  const tokens = script.split(" ");
  if (tokens[0] !== "eslint") return "does not start with `eslint`";
  const values: string[] = [];
  tokens.forEach((t, i) => {
    if (t === "--max-warnings") values.push(tokens[i + 1] ?? "");
    else if (t.startsWith("--max-warnings=")) values.push(t.slice("--max-warnings=".length));
  });
  if (values.length !== 1) return `${values.length} --max-warnings flags (eslint takes the last one); exactly one is allowed`;
  if (values[0] !== "0") return `--max-warnings is ${values[0] === "" ? "empty" : values[0]}, not 0`;
  return null;
}

describe("--max-warnings 0 is on every lint script, exactly once", () => {
  it("scans the scripts it claims to: the three lint workspaces and the scripts/tools gate, and each is its pinned whole script", () => {
    const found = Object.fromEntries(lintScripts().map((s) => [s.label, s.script]));
    expect(found).toEqual(EXPECTED);
  });

  it("every discovered lint script holds the gate (also covers a workspace added later)", () => {
    let checked = 0;
    for (const { label, script } of lintScripts()) {
      checked++;
      expect(gateProblem(script), `${label}: \`${script}\``).toBeNull();
    }
    expect(checked, "anti-vacuity: scripts judged").toBeGreaterThanOrEqual(4);
  });

  it("the matcher refuses every bypass and accepts the two spellings of the gate", () => {
    const ok = ["eslint --max-warnings 0", "eslint --max-warnings=0 scripts tools", "eslint scripts --max-warnings 0"];
    for (const s of ok) expect(gateProblem(s), s).toBeNull();
    const bad = [
      "eslint",
      "eslint --max-warnings 1",
      "eslint --max-warnings 10",
      "eslint --max-warnings=-1",
      "eslint --max-warnings",
      "eslint --no-max-warnings 0",
      // the last flag wins: all three exit 0 on a warning
      "eslint --max-warnings 0 --max-warnings 100",
      "eslint --max-warnings=0 --max-warnings=100",
      "eslint --max-warnings 100 --max-warnings 0",
      // the shell swallows or replaces the exit code
      "eslint --max-warnings 0 || true",
      "eslint --max-warnings 0; true",
      "eslint --max-warnings 0 | cat",
      "eslint --max-warnings 0 && echo ok",
      "echo; eslint --max-warnings 0",
      "node eslint --max-warnings 0",
    ];
    for (const s of bad) expect(gateProblem(s), s).not.toBeNull();
  });
});

describe("CI reaches eslint only through those scripts, and nothing can turn the step advisory", () => {
  const ci = read(".github/workflows/ci.yml");
  const STEPS: [string, string][] = [
    ["eslint", "        run: npx turbo run lint"],
    ["eslint (scripts/)", "        run: npm run lint:scripts"],
  ];

  it.each(STEPS)("the `%s` step is a name and one whole-line run, nothing else", (name, runLine) => {
    const step = stepOf(ci, name);
    expect(step.keys, "a key beside `run` (continue-on-error, if, env, shell, timeout…) can change what the step does").toEqual(["name", "run"]);
    const lines = step.body.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    expect(lines, "the run line is the whole command: no `-- --max-warnings 100` for turbo to forward, no `|| true`").toEqual([runLine]);
  });

  it("both steps are in one job, and that job cannot be skipped or made advisory", () => {
    const owners = Object.entries(jobsOf(ci)).filter(([, text]) => STEPS.every(([name]) => text.includes(`      - name: ${name}\n`)));
    expect(owners.map(([n]) => n), "exactly one job runs both gates").toHaveLength(1);
    const [jobName, text] = owners[0]!;
    const lines = text.split("\n");
    const stepsAt = lines.indexOf("    steps:");
    expect(stepsAt, `${jobName}: has a steps: key`).toBeGreaterThan(0);
    // The job's own keys, before its steps. `if:`/`continue-on-error:` here skip the gate or ignore its result.
    for (const l of lines.slice(1, stepsAt).filter((x) => x.trim() !== "" && !x.trim().startsWith("#"))) {
      expect(l, `${jobName}: job-level key`).not.toMatch(/^ {4}(if|continue-on-error|defaults):/);
    }
  });

  it("no workflow runs eslint directly — a direct call bypasses the lint scripts' --max-warnings 0", () => {
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
    expect(direct).toEqual([]);
  });
});

describe("the flag does what the pins claim, in EVERY lint workspace", () => {
  // A real warning, raised through the real config: the rule is switched to "warn" by an inline config comment, which
  // every one of these configs honours (probed, not assumed — the unused-directive route is an ERROR in the engine's).
  const PLANTED = ['/* eslint no-debugger: "warn" */', "debugger;", "export const planted = 1;", ""].join("\n");
  const CLEAN = ["export const clean = 1;", ""].join("\n");

  /** Where each workspace's probe is linted from: a file its own config reaches (the type-aware configs refuse an
   *  unknown path). A new lint workspace owes an entry here, or the test below refuses it by name. */
  const PROBE_FILE: Record<string, string> = {
    "apps/web": "src/__planted__.ts",
    "packages/reference": "src/index.ts",
    "packages/scheduler": "src/index.ts",
    "root lint:scripts": "scripts/seed-demo-templates.ts",
  };
  /** The root script lints two trees under two configs; its second probe proves the `tools/` one. */
  const EXTRA_PROBES: [string, string][] = [["root lint:scripts", "tools/matrix/judge.ts"]];

  /** The args of a REAL lint script after the `eslint` word, minus the path arguments (stdin supplies the file). */
  function flagsOf(script: string): string[] {
    const tokens = script.split(" ").slice(1);
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (!t.startsWith("--")) continue;
      out.push(t);
      if (t === "--max-warnings") out.push(tokens[++i] ?? "");
    }
    return out;
  }
  const lint = (cwd: string, args: string[], file: string, input: string) =>
    spawnSync(resolve(REPO, cwd, "node_modules/.bin/eslint"), [...args, "--format", "json", "--stdin", "--stdin-filename", file], {
      cwd: resolve(REPO, cwd),
      input,
      encoding: "utf8",
      timeout: 25_000,
      // Single-run mode (CI=true) lints the type-aware configs' file ON DISK and ignores stdin.
      env: { ...process.env, TSESTREE_SINGLE_RUN: "false" },
    });
  const messages = (stdout: string) =>
    (JSON.parse(stdout) as { messages: { ruleId: string | null; severity: number }[] }[])[0]!.messages;

  const probes = lintScripts().flatMap((s) => {
    const file = PROBE_FILE[s.label];
    const more = EXTRA_PROBES.filter(([l]) => l === s.label).map(([, f]) => f);
    return [file, ...more].map((f) => ({ ...s, file: f }));
  });

  it("every lint script has a probe file (a new lint workspace must add one)", () => {
    const unmapped = lintScripts().filter((s) => PROBE_FILE[s.label] === undefined).map((s) => s.label);
    expect(unmapped).toEqual([]);
    expect(probes.length, "anti-vacuity: probes").toBeGreaterThanOrEqual(5);
    // apps/web's probe is a path that need not exist (its config is not type-aware); the others must be real files.
    for (const p of probes.filter((x) => x.label !== "apps/web")) {
      expect(existsSync(resolve(REPO, p.cwd, p.file!)), `${p.label}: ${p.file} is a real file its config reaches`).toBe(true);
    }
  });

  it.each(probes.map((p) => [`${p.label} (${p.file})`, p] as const))(
    "%s: a planted warning exits 1 under the real script's flags, and 0 without them",
    (_name, p) => {
      const args = flagsOf(p.script);
      expect(args, "PREMISE: the script yields its gate flag").toEqual(["--max-warnings", "0"]);
      const gated = lint(p.cwd, args, p.file!, PLANTED);
      expect(messages(gated.stdout).map((m) => [m.ruleId, m.severity]), `PREMISE: exactly one WARNING (${gated.stderr})`).toEqual([["no-debugger", 1]]);
      expect(gated.status, `with ${args.join(" ")}: ${gated.stderr}`).toBe(1);

      const ungated = lint(p.cwd, [], p.file!, PLANTED);
      expect(messages(ungated.stdout).map((m) => m.ruleId), "control: the same warning is reported").toEqual(["no-debugger"]);
      expect(ungated.status, "control: without the flag a warning does not fail the run").toBe(0);
    },
    spawnBudget(2),
  );

  it("clean code still passes the gate (the flag is not a blanket failure)", () => {
    const web = lintScripts().find((s) => s.label === "apps/web")!;
    const r = lint(web.cwd, flagsOf(web.script), PROBE_FILE["apps/web"]!, CLEAN);
    expect(messages(r.stdout)).toEqual([]);
    expect(r.status).toBe(0);
  }, spawnBudget(1));

  it("apps/web: the React-Compiler rule the programme cleared is a WARNING the gate fails on (real rule, real shape)", () => {
    const web = lintScripts().find((s) => s.label === "apps/web")!;
    const REAL = [
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
    const r = lint(web.cwd, flagsOf(web.script), "src/__planted__.tsx", REAL);
    expect(messages(r.stdout).map((m) => [m.ruleId, m.severity])).toEqual([["react-hooks/set-state-in-effect", 1]]);
    expect(r.status).toBe(1);
  }, spawnBudget(1));
});
