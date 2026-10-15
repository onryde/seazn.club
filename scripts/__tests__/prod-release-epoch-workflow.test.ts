// .github/workflows/prod.yml's release-time epoch report (owner-approved 2026-10-15), held by TEXT and then RUN. A production tag deploys
// whatever it points at, and the server refuses a score write from a capture app whose FOLD_EPOCH for the sport is lower than the engine's
// (426 ENGINE_OUTDATED), so the step that names the sports a tag locks out is only worth having if it (a) exists, (b) runs before anything
// irreversible, and (c) can NEVER fail or hold up the deploy. Those are the pins. The report itself is packages/engine/scripts/release-epoch-report.ts,
// whose decisions are held in packages/engine/test/release-epoch-report{,-cli}.test.ts; this file holds the wiring around it and RUNS the
// step's own shell against scratch repositories shaped like a tag-triggered checkout (detached HEAD, one commit deep, one tag), so the step and
// the script cannot drift apart.
//
// There is no YAML library at the repo root (and none is added: W1d review I8), so the parse accepts exactly ONE layout, the one prod.yml is
// written in, and a reshaped file reds a pin rather than parsing into something vacuous. Every pin is held to a failing input (MUTANTS below:
// the workflow text with that one property broken, which the pin must name).
//
// Single-sport reason: no sport is involved - this is a CI-wiring file; the scratch tables are the real one with one or two sports edited.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOW = ".github/workflows/prod.yml";
const JOB = "deploy-prod";
const SCRIPT = "packages/engine/scripts/release-epoch-report.ts";
const TABLE = "packages/engine/src/sport/fold-epoch.ts";
const FILES = [SCRIPT, "packages/engine/scripts/lib/main-module.ts", "packages/engine/package.json"];
const TEXT = readFileSync(path.join(ROOT, WORKFLOW), "utf8");
const SPAWN_MS = 30_000;
const spawnBudget = (n: number) => n * SPAWN_MS + 5_000;

// ------------------------------------------------------------------------------------------------------------------ the parse

type Step = {
  /** Index of the step among the job's steps. */
  at: number;
  name: string | null;
  uses: string | null;
  /** The step's own keys (`name`, `run`, `continue-on-error`, ...), in order. */
  keys: string[];
  /** The scalar value of each key whose value is on its own line (`continue-on-error: true`). */
  values: Record<string, string>;
  /** The `run:` script, dedented ("" for a step with none). */
  run: string;
  /** All of the step's non-comment text. */
  text: string;
};

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => /^\s*#/.test(line);

/** The steps of one job, in order. Throws unless the job exists exactly once (a parse that finds nothing must not pass every pin). */
function stepsOf(text: string, job: string): Step[] {
  const lines = text.split("\n");
  const heads = lines.flatMap((l, i) => (l === `  ${job}:` ? [i] : []));
  if (heads.length !== 1) throw new Error(`expected exactly one "  ${job}:" job, found ${heads.length}`);
  let end = heads[0] + 1;
  while (end < lines.length && !/^ {2}[a-z][\w-]*:\s*$/.test(lines[end]) && !/^\S/.test(lines[end])) end++;
  const body = lines.slice(heads[0] + 1, end);
  const stepsAt = body.indexOf("    steps:");
  if (stepsAt === -1) throw new Error(`job ${job} has no "    steps:" key`);
  const raw: string[][] = [];
  for (const l of body.slice(stepsAt + 1)) {
    if (/^ {6}- /.test(l)) raw.push([l]);
    else if (raw.length > 0) raw[raw.length - 1].push(l);
  }
  if (raw.length === 0) throw new Error(`job ${job} holds no step`);
  return raw.map((r, at) => {
    const lines2 = r.filter((l) => !isComment(l));
    lines2[0] = lines2[0].replace(/^ {6}- /, "        ");
    const keys = lines2.flatMap((l) => /^ {8}([\w-]+):/.exec(l)?.slice(1) ?? []);
    const scalar = (k: string) => lines2.map((l) => new RegExp(`^ {8}${k}: ?(.*)$`).exec(l)?.[1]).find((v) => v !== undefined);
    const values: Record<string, string> = {};
    for (const k of keys) {
      const v = scalar(k);
      if (v !== undefined && v !== "" && v !== "|") values[k] = v.replace(/\s+#.*$/, "").trim();
    }
    const runAt = lines2.indexOf("        run: |");
    const run: string[] = [];
    if (runAt !== -1) {
      for (const l of lines2.slice(runAt + 1)) {
        if (l.trim() !== "" && indentOf(l) < 10) break;
        run.push(l.slice(10));
      }
    } else if (values.run !== undefined) run.push(values.run);
    return { at, name: values.name ?? null, uses: values.uses ?? null, keys, values, run: run.join("\n").trimEnd(), text: lines2.join("\n") };
  });
}

/** Every pin, as a named failure: the empty list is the workflow as it must be. */
function pins(text: string): string[] {
  const failed: string[] = [];
  const check = (name: string, ok: boolean) => { if (!ok) failed.push(name); };
  let steps: Step[];
  try {
    steps = stepsOf(text, JOB);
  } catch (e) {
    return [`unreadable: ${(e as Error).message}`];
  }
  const mine = steps.filter((s) => s.run.includes("release-epoch-report.ts"));
  check("exactly one step runs the report", mine.length === 1);
  const step = mine[0];
  if (step === undefined) return failed;
  const codeOnly = text.split("\n").filter((l) => !isComment(l)).join("\n");
  check("the report step is the only place the script is named (in no other step or job)", codeOnly.split("release-epoch-report.ts").length === step.text.split("release-epoch-report.ts").length);

  // it can never gate or hold up the deploy
  check("continue-on-error is exactly true", step.values["continue-on-error"] === "true");
  check("a timeout bounds how long it can delay the deploy (1 to 5 minutes)", /^[1-5]$/.test(step.values["timeout-minutes"] ?? ""));
  check("nothing else decides whether it runs or what it needs (no if:, env:, shell:, working-directory:, with:)", JSON.stringify(step.keys) === JSON.stringify(["name", "continue-on-error", "timeout-minutes", "run"]));
  check("no expression is substituted into the shell", !step.run.includes("${{"));

  // it runs where the deploy cannot have started: after node is set up, before the first step that touches production
  const setupNode = steps.findIndex((s) => (s.uses ?? "").startsWith("actions/setup-node@"));
  check("it runs after actions/setup-node (the script needs Node with type stripping)", setupNode !== -1 && step.at > setupNode);
  // (what a step RUNS or USES: setup-node's trailing comment names scripts/flyway.sh, and a step's text would match it)
  const irreversible = steps.filter((s) => /flyway\.sh|sync:sports|stripe:sync|flyctl deploy|flyctl auth docker/.test(s.run) || (s.uses ?? "").startsWith("docker/build-push-action@"));
  check("the steps it must precede were found (migrate, catalog, stripe, build, deploy)", irreversible.length >= 5);
  check("it runs before every step that migrates, builds or deploys", irreversible.every((s) => s.at > step.at));

  // what it runs
  check("it resolves the previous release tag from HEAD^, over v*.*.* tags only", step.run.includes("git describe --tags --abbrev=0 --match 'v*.*.*' HEAD^"));
  check("it fetches the v* tags and their history first (the checkout is one commit deep; a refspec takes one wildcard)", step.run.includes("git fetch --quiet --unshallow origin '+refs/tags/v*:refs/tags/v*'") && step.run.includes("git fetch --quiet origin '+refs/tags/v*:refs/tags/v*'"));
  check("it runs the engine's script under strip-types, from the previous tag to HEAD, annotating and summarising",
    step.run.includes(`node --experimental-strip-types ${SCRIPT} --from "$prev" --to HEAD --annotate --summary "$GITHUB_STEP_SUMMARY"`));
  check("the first release (no previous tag) is reported, not an error", /if \[ -z "\$prev" \]; then[\s\S]*exit 0\s*fi/.test(step.run));
  return failed;
}

// ------------------------------------------------------------------------------------------------------------------ the pins

describe("prod.yml: the release-time epoch report is wired so that it can only inform", () => {
  it("reads the job it asserts about (never an empty set)", () => {
    const steps = stepsOf(TEXT, JOB);
    expect(steps.length).toBeGreaterThan(8);
    expect(steps.filter((s) => s.run.includes("release-epoch-report.ts"))).toHaveLength(1);
    expect(existsSync(path.join(ROOT, SCRIPT))).toBe(true);
  });

  it("holds every pin", () => {
    expect(pins(TEXT)).toEqual([]);
  });

  const swap = (from: string, to: string) => (t: string) => {
    const n = t.split(from).length - 1;
    if (n !== 1) throw new Error(`mutant: expected exactly one "${from}", found ${n}`);
    return t.replace(from, to);
  };
  /** The report step's whole block (its `- name:` line through the line before the next step), moved to just before `anchor`. */
  const moveStepBefore = (anchor: string) => (t: string) => {
    const lines = t.split("\n");
    const head = lines.findIndex((l) => l.startsWith("      - name: Report FOLD_EPOCH bumps"));
    let end = head + 1;
    while (end < lines.length && !/^ {6}- /.test(lines[end]) && !/^ {2}[a-z]/.test(lines[end])) end++;
    const block = lines.splice(head, end - head);
    const at = lines.findIndex((l) => l.includes(anchor));
    if (head === -1 || at === -1) throw new Error("mutant: step or anchor not found");
    lines.splice(at, 0, ...block);
    return lines.join("\n");
  };
  const MUTANTS: Array<[string, (t: string) => string, RegExp]> = [
    ["continue-on-error removed", swap("        continue-on-error: true\n        timeout-minutes", "        timeout-minutes"), /continue-on-error is exactly true/],
    ["continue-on-error false", swap("continue-on-error: true", "continue-on-error: false"), /continue-on-error is exactly true/],
    ["the timeout removed", swap("        timeout-minutes: 3\n", ""), /a timeout bounds/],
    ["an unbounded timeout", swap("timeout-minutes: 3", "timeout-minutes: 360"), /a timeout bounds/],
    ["the step made conditional", swap("        timeout-minutes: 3\n", "        timeout-minutes: 3\n        if: github.ref_type == 'branch'\n"), /nothing else decides/],
    ["the step given an env", swap("        timeout-minutes: 3\n", "        timeout-minutes: 3\n        env:\n          X: y\n"), /nothing else decides/],
    ["an expression in the shell", swap('--from "$prev"', '--from "${{ github.ref_name }}"'), /no expression is substituted/],
    ["moved before node is set up", moveStepBefore("uses: actions/setup-node@"), /after actions\/setup-node/],
    ["moved between the pending-migrations check and the migration", moveStepBefore("- name: Migrate production database (Flyway)"), /before every step that migrates/],
    ["moved after the deploy", moveStepBefore("- name: Report machine count"), /before every step that migrates/],
    ["describe over every tag", swap("--match 'v*.*.*'", "--match 'v*'"), /resolves the previous release tag/],
    ["describe from HEAD, not HEAD^", swap("'v*.*.*' HEAD^", "'v*.*.*' HEAD"), /resolves the previous release tag/],
    ["no tag fetch", swap("          else\n            git fetch --quiet origin '+refs/tags/v*:refs/tags/v*'\n", "          else\n            true\n"), /fetches the v\* tags/],
    ["no unshallow of the one-commit-deep checkout", swap("git fetch --quiet --unshallow origin", "git fetch --quiet origin"), /fetches the v\* tags/],
    ["no --annotate", swap(" --annotate --summary", " --summary"), /runs the engine's script/],
    ["no --summary", swap(' --annotate --summary "$GITHUB_STEP_SUMMARY"', " --annotate"), /runs the engine's script/],
    ["the script path wrong", swap("node --experimental-strip-types packages/engine/scripts/release-epoch-report.ts", "node --experimental-strip-types packages/engine/scripts/release-epoch-report.mjs"), /exactly one step runs the report/],
    ["the first release left to fall through to the script", swap('"$msg" >> "$GITHUB_STEP_SUMMARY"\n            exit 0\n', '"$msg" >> "$GITHUB_STEP_SUMMARY"\n'), /first release/],
  ];
  for (const [name, mutate, expected] of MUTANTS) {
    it(`a pin names the mutant: ${name}`, () => {
      const failed = pins(mutate(TEXT));
      expect(failed.length, `nothing noticed: ${name}`).toBeGreaterThan(0);
      expect(failed.join("\n")).toMatch(expected);
    });
  }
  it("holds the pin table to at least a dozen mutants", () => {
    expect(MUTANTS.length).toBeGreaterThanOrEqual(12);
  });
});

// ------------------------------------------------------------------------------------------------------------------ the step, run

const step = (() => {
  const found = stepsOf(TEXT, JOB).filter((s) => s.run.includes("release-epoch-report.ts"));
  if (found.length !== 1) throw new Error("the report step is not unique; the pins say why");
  return found[0];
})();

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") || k.startsWith("GITHUB_")) delete env[k];
  return env;
};
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=epoch@example.invalid", "-c", "user.name=Epoch", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: cleanEnv(), timeout: SPAWN_MS });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let scratch = "";
let origin = "";
const REAL_TABLE = readFileSync(path.join(ROOT, TABLE), "utf8");
/** The sports there are, from the golden corpora on disk (the epoch guard holds them equal to the table's keys). */
const SPORTS = (readdirSync(path.join(ROOT, "packages/engine/src/sports"), { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json")).length;

/** A table with one sport's epoch edited (the real table's first `sport: n`, inside the FOLD_EPOCH literal). */
const withEpoch = (sport: string, n: number): string => {
  const out = REAL_TABLE.replace(new RegExp(`\\b${sport}: \\d+`), `${sport}: ${n}`);
  if (out === REAL_TABLE && n !== 1) throw new Error(`${sport} has no entry in the table`);
  return out;
};

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "prod-release-epoch-"));
  origin = path.join(scratch, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  for (const k of [["gc.auto", "0"], ["maintenance.auto", "false"]]) git(origin, "config", k[0], k[1]);
  for (const f of FILES) {
    mkdirSync(path.dirname(path.join(origin, f)), { recursive: true });
    cpSync(path.join(ROOT, f), path.join(origin, f));
  }
  const commit = (message: string, table: string | null, tag?: string) => {
    const file = path.join(origin, TABLE);
    rmSync(file, { force: true });
    if (table !== null) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, table);
    }
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "--allow-empty", "-m", message);
    if (tag !== undefined) git(origin, "tag", tag);
  };
  commit("first release, before fold-epoch.ts existed", null, "v1.0.0");
  commit("fold-epoch.ts arrives", REAL_TABLE, "v1.0.1");
  commit("an ordinary merge", REAL_TABLE + "\n");
  git(origin, "tag", "v9"); //                                   not a release tag: `v*.*.*` must not match it, and `v*` would
  git(origin, "tag", "not-a-release");
  commit("football's rule changes", withEpoch("football", 2), "v1.0.2");
  commit("tennis and badminton change", withEpoch("football", 2).replace(/\btennis: \d+/, "tennis: 2").replace(/\bbadminton: \d+/, "badminton: 4"), "v1.0.3-beta");
}, 60_000);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** What actions/checkout leaves for a tag push: a clone one commit deep, detached at the tag, holding only that tag. */
let rigs = 0;
function checkoutOf(tag: string): string {
  const dir = path.join(scratch, `checkout-${++rigs}-${tag}`);
  const r = spawnSync("git", ["-c", "protocol.file.allow=always", "-c", "advice.detachedHead=false", "clone", "-q", "--depth", "1", "--branch", tag, `file://${origin}`, dir], { encoding: "utf8", env: cleanEnv(), timeout: SPAWN_MS });
  if (r.status !== 0) throw new Error(`clone ${tag}: ${r.stderr}`);
  expect(git(dir, "rev-parse", "--is-shallow-repository"), "the rig is a shallow checkout like CI's").toBe("true");
  expect(git(dir, "tag", "--list"), "the rig holds only the tag being deployed").toBe(tag);
  return dir;
}
/** The step's `run:` script, exactly as prod.yml has it, under `bash -e` as GitHub runs it. */
function runStep(dir: string, tag: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const summary = path.join(scratch, `summary-${++rigs}.md`);
  writeFileSync(summary, "");
  const r = spawnSync("bash", ["-e", "-c", step.run], { cwd: dir, encoding: "utf8", timeout: SPAWN_MS * 2, env: { ...cleanEnv(), GITHUB_REF_NAME: tag, GITHUB_STEP_SUMMARY: summary, ...extraEnv } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines: r.stdout.split("\n").filter((l) => l !== ""), summary: readFileSync(summary, "utf8") };
}
const raisedLine = (sport: string, a: number, b: number): string =>
  `${sport}: FOLD_EPOCH ${a} -> ${b} — capture apps older than this engine will be refused for ${sport} (426 ENGINE_OUTDATED)`;

describe("prod.yml: the epoch-report step, run against a checkout shaped like a tag push", () => {
  it("the rig has the tags and tables it claims (a rig with none would pass every scenario below for the wrong reason)", () => {
    expect(git(origin, "tag", "--list").split("\n").sort()).toEqual(["not-a-release", "v1.0.0", "v1.0.1", "v1.0.2", "v1.0.3-beta", "v9"]);
    expect(SPORTS).toBeGreaterThan(1);
    expect(withEpoch("football", 2)).not.toBe(REAL_TABLE);
  });

  it("deploying v1.0.2 names the sport its tag raised since v1.0.1, skipping the untagged merge and the non-release tags between them", () => {
    const dir = checkoutOf("v1.0.2");
    const r = runStep(dir, "v1.0.2");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines).toEqual([
      raisedLine("football", 1, 2),
      `${SPORTS} sport(s) compared between v1.0.1 and HEAD: 1 FOLD_EPOCH raised, 0 lowered, 0 FOLD_MINOR changed, 0 added, 0 removed`,
      `::warning::${raisedLine("football", 1, 2)}`,
    ]);
    expect(r.summary).toBe(`### Engine fold epoch: v1.0.1 -> HEAD\n\n- ${raisedLine("football", 1, 2)}\n- ${r.lines[1]}\n`);
  }, spawnBudget(4));

  it("deploying v1.0.3-beta (a prerelease tag) names every sport that rose since v1.0.2, one ::warning:: each", () => {
    const dir = checkoutOf("v1.0.3-beta");
    const r = runStep(dir, "v1.0.3-beta");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines.filter((l) => l.startsWith("::warning::"))).toEqual([`::warning::${raisedLine("badminton", 1, 4)}`, `::warning::${raisedLine("tennis", 1, 2)}`]);
    expect(r.summary).toContain("### Engine fold epoch: v1.0.2 -> HEAD");
    expect(r.summary).toContain(`- ${raisedLine("badminton", 1, 4)}`);
  }, spawnBudget(4));

  it("a previous release from before fold-epoch.ts is one line and no warning, in the log and in the summary", () => {
    const dir = checkoutOf("v1.0.1");
    const r = runStep(dir, "v1.0.1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("no FOLD_EPOCH at v1.0.0; nothing to compare\n");
    expect(r.summary).toBe("### Engine fold epoch: v1.0.0 -> HEAD\n\n- no FOLD_EPOCH at v1.0.0; nothing to compare\n");
  }, spawnBudget(4));

  it("the first release ever has no previous tag: said so, in the log and the summary, exit 0", () => {
    const dir = checkoutOf("v1.0.0");
    const r = runStep(dir, "v1.0.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("no previous v*.*.* tag before v1.0.0; nothing to compare\n");
    expect(r.summary).toBe("### Engine fold epoch\n\n- no previous v*.*.* tag before v1.0.0; nothing to compare\n");
  }, spawnBudget(3));

  it("a checkout that already has its history (not shallow) works too: nothing is unshallowed, the tags are still fetched", () => {
    const dir = path.join(scratch, "full-clone");
    const c = spawnSync("git", ["-c", "protocol.file.allow=always", "-c", "advice.detachedHead=false", "clone", "-q", "--branch", "main", `file://${origin}`, dir], { encoding: "utf8", env: cleanEnv(), timeout: SPAWN_MS });
    expect(c.status, c.stderr).toBe(0);
    git(dir, "checkout", "-q", "--detach", git(origin, "rev-parse", "v1.0.2^{commit}"));
    expect(git(dir, "rev-parse", "--is-shallow-repository")).toBe("false");
    for (const t of git(dir, "tag", "--list").split("\n").filter((x) => x !== "")) git(dir, "tag", "-d", t); // like a checkout that fetched no tags
    expect(git(dir, "tag", "--list"), "the rig starts with no tag").toBe("");
    const r = runStep(dir, "v1.0.2");
    expect(r.status, r.stderr).toBe(0);
    expect(r.lines[0]).toBe(raisedLine("football", 1, 2));
  }, spawnBudget(4));

  it("a failing script surfaces as a failing step (which continue-on-error then keeps from failing the job), not as a silent pass", () => {
    const dir = checkoutOf("v1.0.2");
    const r = runStep(dir, "v1.0.2", { TMPDIR: path.join(scratch, "no-such-tmp") });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("the reporter itself crashed");
  }, spawnBudget(4));
});
