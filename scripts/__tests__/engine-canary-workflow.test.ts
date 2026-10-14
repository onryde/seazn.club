// Engine-split Task 1b-4 (D16): .github/workflows/engine-canary.yml, held by TEXT. There is no YAML library at the repo root, so the
// parse below accepts exactly ONE layout (the one the workflow is written in) and a reshaped file reds a pin rather than parsing
// into something vacuous.
//
// Why a pin table and not a handful of regexes: a publish workflow is outward-facing and runs only after a merge, so the first
// time anyone sees it misbehave is on the registry. Every property that decides WHAT is published, WHERE, UNDER WHICH TAG and WITH
// WHICH CREDENTIAL is a named pin, and each pin is held to a failing input (MUTANTS below: the workflow text with that one property
// broken, which the pin must name). The version a canary gets is computed by packages/engine/pack-proof/canary.mjs, whose
// decisions are held in packages/engine/test/canary.test.ts; this file holds the wiring around it and RUNS the one workflow step
// that derives the version, so the step and the script cannot drift apart.
//
// Single-sport reason: no sport is involved - this is a CI-wiring file.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOW = ".github/workflows/engine-canary.yml";
const CLI = "node packages/engine/pack-proof/canary.mjs";
const TARBALL = "${{ runner.temp }}/engine-canary/onryde-seazn-engine-${{ steps.version.outputs.version }}.tgz";

// ------------------------------------------------------------------------------------------------------------------ the parse

type Step = {
  /** The step's lines, the `- ` of its first line replaced by two spaces so every step key sits at 8 spaces. */
  lines: string[];
  name: string | null;
  id: string | null;
  uses: string | null;
  /** The `run:` script, dedented; a one-line `run: x` is just `x`. */
  run: string | null;
  /** The step's top-level keys. */
  keys: string[];
  with: Record<string, string>;
  env: Record<string, string>;
};
type Job = { name: string; lines: string[]; needs: string | null; permissions: string[] | null; keys: string[]; steps: Step[] };
type Workflow = { code: string[]; on: string[]; permissions: string[]; concurrency: string[]; jobs: Record<string, Job> };

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => /^\s*#/.test(line);

/** A column-0 block (`on:`, `permissions:`, `concurrency:`): its key line and every indented line after it, comments dropped. */
function topBlock(lines: string[], key: string): string[] {
  const at = lines.indexOf(`${key}:`);
  if (at === -1) return [];
  let end = at + 1;
  while (end < lines.length && (lines[end] === "" || lines[end].startsWith(" ") || isComment(lines[end]))) end++;
  return lines.slice(at, end).filter((l) => l.trim() !== "" && !isComment(l));
}

/** A key of a map at `indent` spaces: its `key: value` lines (indent+2), as a record. */
function mapOf(lines: string[], key: string, indent: number): Record<string, string> {
  const at = lines.indexOf(`${" ".repeat(indent)}${key}:`);
  if (at === -1) return {};
  const out: Record<string, string> = {};
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === "" || isComment(l)) continue;
    if (indentOf(l) <= indent) break;
    const m = /^ *([\w-]+): ?(.*)$/.exec(l);
    if (m !== null) out[m[1]] = m[2];
  }
  return out;
}

function parseStep(raw: string[]): Step {
  const lines = raw.filter((l) => !isComment(l));
  lines[0] = lines[0].replace(/^ {6}- /, "        ");
  const keys = lines.flatMap((l) => /^ {8}([\w-]+):/.exec(l)?.slice(1) ?? []);
  const scalar = (k: string) => lines.map((l) => new RegExp(`^ {8}${k}: ?(.*)$`).exec(l)?.[1]).find((v) => v !== undefined) ?? null;
  let run: string | null = null;
  const runAt = lines.findIndex((l) => /^ {8}run:/.test(l));
  if (runAt !== -1) {
    const first = /^ {8}run: ?(.*)$/.exec(lines[runAt])![1];
    if (first === "|") {
      const body: string[] = [];
      for (const l of lines.slice(runAt + 1)) {
        if (l.trim() !== "" && indentOf(l) < 10) break;
        body.push(l.slice(10));
      }
      run = `${body.join("\n").trimEnd()}\n`;
    } else {
      run = first;
    }
  }
  return { lines, name: scalar("name"), id: scalar("id"), uses: scalar("uses"), run, keys, with: mapOf(lines, "with", 8), env: mapOf(lines, "env", 8) };
}

function parseJob(name: string, text: string): Job {
  const lines = text.split("\n").filter((l) => !isComment(l));
  const stepsAt = lines.indexOf("    steps:");
  if (stepsAt === -1) throw new Error(`job ${name} has no steps`);
  const head = lines.slice(0, stepsAt);
  const raw = lines.slice(stepsAt + 1);
  const starts = raw.flatMap((l, i) => (l.startsWith("      - ") ? [i] : []));
  if (starts.length === 0) throw new Error(`job ${name} holds no step`);
  const permissionsAt = head.indexOf("    permissions:");
  return {
    name,
    lines,
    needs: head.map((l) => /^ {4}needs: ?(.*)$/.exec(l)?.[1]).find((v) => v !== undefined) ?? null,
    permissions: permissionsAt === -1 ? null : Object.entries(mapOf(head, "permissions", 4)).map(([k, v]) => `${k}: ${v}`),
    keys: head.flatMap((l) => /^ {4}([\w-]+):/.exec(l)?.slice(1) ?? []),
    steps: starts.map((from, n) => parseStep(raw.slice(from, starts[n + 1] ?? raw.length))),
  };
}

function parse(text: string): Workflow {
  const lines = text.split("\n");
  const at = lines.indexOf("jobs:");
  if (at === -1) throw new Error("no `jobs:` key");
  const body = lines.slice(at + 1);
  const starts = body.flatMap((l, i) => (/^ {2}[a-z][\w-]*:$/.test(l) ? [i] : []));
  if (starts.length === 0) throw new Error("`jobs:` holds no job");
  const jobs: Record<string, Job> = {};
  starts.forEach((from, n) => {
    const name = body[from].trim().slice(0, -1);
    if (Object.hasOwn(jobs, name)) throw new Error(`job "${name}" is declared twice`);
    jobs[name] = parseJob(name, body.slice(from, starts[n + 1] ?? body.length).join("\n"));
  });
  return { code: lines.filter((l) => l.trim() !== "" && !isComment(l)), on: topBlock(lines, "on"), permissions: topBlock(lines, "permissions"), concurrency: topBlock(lines, "concurrency"), jobs };
}

// ----------------------------------------------------------------------------------------------------------------------- pins

type Verdict = { problems: string[]; checked: number };
const pinsOf = (root: { packageManager: string }): Record<string, (wf: Workflow) => Verdict> => {
  const pnpmPin = /^pnpm@(\d+\.\d+\.\d+)$/.exec(root.packageManager)?.[1];
  if (pnpmPin === undefined) throw new Error(`the root packageManager is not pnpm@x.y.z: ${root.packageManager}`);

  const verdict = () => {
    const v: Verdict = { problems: [], checked: 0 };
    return {
      v,
      is: (ok: boolean, problem: string) => {
        v.checked++;
        if (!ok) v.problems.push(problem);
      },
    };
  };
  const stepsOf = (wf: Workflow) => Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => ({ job: j.name, step: s })));
  const scripts = (wf: Workflow) => stepsOf(wf).flatMap(({ step }) => (step.run === null ? [] : [step.run]));
  const named = (job: Job | undefined, name: string) => job?.steps.find((s) => s.name === name);

  return {
    // The only trigger is a push to main that touches the engine. A pull_request / workflow_dispatch / schedule trigger would publish
    // unreviewed or off-main code under the `canary` tag.
    trigger: (wf) => {
      const { v, is } = verdict();
      is(JSON.stringify(wf.on) === JSON.stringify(["on:", "  push:", "    branches: [main]", '    paths: ["packages/engine/**"]']), `on: is not exactly a push to main with paths packages/engine/** (${JSON.stringify(wf.on)})`);
      return v;
    },
    // Least privilege: the workflow default reads; ONLY the publish job writes packages; nothing anywhere can write contents or mint an id token.
    permissions: (wf) => {
      const { v, is } = verdict();
      is(JSON.stringify(wf.permissions) === JSON.stringify(["permissions:", "  contents: read"]), `top-level permissions are not exactly contents: read (${JSON.stringify(wf.permissions)})`);
      is(JSON.stringify(wf.jobs.publish?.permissions) === JSON.stringify(["contents: read", "packages: write"]), `the publish job's permissions are not exactly contents: read + packages: write (${JSON.stringify(wf.jobs.publish?.permissions)})`);
      for (const [name, job] of Object.entries(wf.jobs)) {
        if (name !== "publish") is(job.permissions === null || JSON.stringify(job.permissions) === JSON.stringify(["contents: read"]), `job ${name} holds more than contents: read`);
      }
      const writes = wf.code.filter((l) => /:\s*write\s*$/.test(l));
      is(writes.length === 1 && writes[0].trim() === "packages: write", `exactly one "write" grant, packages: write, was expected; found ${JSON.stringify(writes)}`);
      is(!wf.code.some((l) => /id-token|contents: write/.test(l)), "id-token or contents: write appears");
      return v;
    },
    // pnpm packs and publishes: `publishConfig.exports` is applied by pnpm only, so `npm publish` ships exports -> src. One publish, of the tarball that was checked.
    "pnpm-publish": (wf) => {
      const { v, is } = verdict();
      const lines = scripts(wf).flatMap((s) => s.split("\n"));
      is(!lines.some((l) => /(^|[\s;&|(])(npm|npx|yarn)\s/.test(l)), "a run line calls npm/npx/yarn");
      const publishes = lines.filter((l) => /\bpublish\b/.test(l));
      is(publishes.length === 1, `expected exactly one publish command, found ${publishes.length}`);
      is(publishes[0]?.startsWith('pnpm publish "$TARBALL" ') === true, `the publish command is not \`pnpm publish "$TARBALL" ...\`: ${publishes[0]}`);
      return v;
    },
    // The dist-tag is `canary`, never `latest` (and not omitted: npm's default tag IS latest).
    tag: (wf) => {
      const { v, is } = verdict();
      const publish = scripts(wf).flatMap((s) => s.split("\n")).find((l) => /\bpublish\b/.test(l)) ?? "";
      const tokens = publish.split(/\s+/);
      is(tokens.filter((t) => t === "--tag").length === 1, "the publish command does not carry exactly one --tag");
      is(tokens[tokens.indexOf("--tag") + 1] === "canary", `--tag is not followed by canary: ${publish}`);
      is(!tokens.includes("latest") && !publish.includes("--tag=latest"), "the publish command names latest");
      return v;
    },
    // The version is derived by the script (unique and monotonic per commit), handed on as a step output, and never typed here.
    version: (wf) => {
      const { v, is } = verdict();
      const publish = wf.jobs.publish;
      const derive = named(publish, "Derive the canary version");
      is(derive?.id === "version", "the derive step is not id: version");
      is(derive?.run?.split("\n").includes(`version="$(${CLI} version)"`) === true, "the derive step does not assign the script's output with `version=\"$(...)\"` (inside `echo $(...)` a failing script would still exit 0)");
      is(derive?.run?.split("\n").includes('echo "version=${version}" >> "$GITHUB_OUTPUT"') === true, "the derive step does not write version= to GITHUB_OUTPUT");
      const set = named(publish, "Set the version on the runner's checkout");
      is(set?.env.VERSION === "${{ steps.version.outputs.version }}", "the set-version step's VERSION is not the derive step's output");
      is(set?.run === `${CLI} set-version "$VERSION"`, `the set-version step does not run the script: ${set?.run}`);
      is(!wf.code.some((l) => /0\.0\.0-canary|GITHUB_SHA|GITHUB_RUN_NUMBER|npm pkg/.test(l)), "the workflow spells the version scheme or edits package.json itself (that is canary.mjs's job)");
      return v;
    },
    // Publish is gated on the pack proof passing, and nothing can skip the proof or the tarball check.
    gate: (wf) => {
      const { v, is } = verdict();
      is(wf.jobs.publish?.needs === "proof", `publish does not need: proof (${wf.jobs.publish?.needs})`);
      for (const [name, job] of Object.entries(wf.jobs)) {
        is(!job.keys.some((k) => ["if", "continue-on-error", "defaults"].includes(k)), `job ${name} has an if/continue-on-error/defaults key (an if: always() would run publish after a red proof)`);
        for (const s of job.steps) is(!s.keys.some((k) => ["if", "continue-on-error", "working-directory"].includes(k)), `a step of ${name} has an if/continue-on-error/working-directory key: ${s.name ?? s.uses ?? s.run}`);
      }
      const proof = wf.jobs.proof?.steps.filter((s) => s.run === "node packages/engine/pack-proof/run.mjs") ?? [];
      is(proof.length === 1, `the proof job runs the pack proof ${proof.length} times, expected once`);
      is(named(wf.jobs.publish, "Check the tarball before it leaves the runner")?.run === `${CLI} check "$TARBALL" "$VERSION"`, "the tarball check step does not run canary.mjs check");
      return v;
    },
    // Inside the publish job: install, build, set the version, pack, check, publish. Each step uses what the one before made.
    order: (wf) => {
      const { v, is } = verdict();
      const heads = (wf.jobs.publish?.steps ?? []).map((s) => s.name ?? s.uses ?? s.run ?? "");
      const at = (n: string) => heads.indexOf(n);
      const sequence = ["Derive the canary version", "Build dist", "Set the version on the runner's checkout", "Pack", "Check the tarball before it leaves the runner", "Publish"];
      is(sequence.every((n) => at(n) !== -1), `a publish-job step is missing: ${JSON.stringify(heads)}`);
      is(sequence.every((n, i) => i === 0 || at(sequence[i - 1]) < at(n)), `the publish job's steps are out of order: ${JSON.stringify(heads)}`);
      is(heads.findIndex((h) => h.startsWith("pnpm install --frozen-lockfile")) < at("Build dist") && heads.findIndex((h) => h.startsWith("pnpm install --frozen-lockfile")) !== -1, "the install does not come before the build");
      return v;
    },
    concurrency: (wf) => {
      const { v, is } = verdict();
      is(JSON.stringify(wf.concurrency) === JSON.stringify(["concurrency:", "  group: engine-canary", "  cancel-in-progress: false"]), `concurrency is not one engine-canary group that queues (${JSON.stringify(wf.concurrency)})`);
      return v;
    },
    // Node 26 and the repo's pinned pnpm in every job; the publish job targets GitHub Packages for the @onryde scope.
    toolchain: (wf) => {
      const { v, is } = verdict();
      for (const [name, job] of Object.entries(wf.jobs)) {
        is(job.lines.includes("    runs-on: ubuntu-latest"), `job ${name} is not on the literal ubuntu-latest runner`);
        const pnpm = job.steps.find((s) => s.uses === "pnpm/action-setup@v4");
        is(pnpm?.with.version === pnpmPin, `job ${name}: pnpm/action-setup version is ${pnpm?.with.version}, the root pin is ${pnpmPin}`);
        const node = job.steps.find((s) => s.uses === "actions/setup-node@v5");
        is(node?.with["node-version"] === "26", `job ${name}: node-version is ${node?.with["node-version"]}, expected 26`);
        const installs = job.steps.filter((s) => s.run?.startsWith("pnpm install"));
        is(installs.length === 1 && installs[0].run?.includes("--frozen-lockfile") === true, `job ${name}: expected one frozen pnpm install`);
        is(job.steps.findIndex((s) => s.uses === "pnpm/action-setup@v4") < job.steps.findIndex((s) => s.uses === "actions/setup-node@v5"), `job ${name}: setup-node comes before pnpm/action-setup`);
      }
      const node = wf.jobs.publish?.steps.find((s) => s.uses === "actions/setup-node@v5");
      is(node?.with["registry-url"] === "https://npm.pkg.github.com", `publish registry-url is ${node?.with["registry-url"]}`);
      is(node?.with.scope === '"@onryde"', `publish scope is ${node?.with.scope}`);
      is(node?.with["package-manager-cache"] === "false", "the publish job restores the package-manager cache (a privileged job reads no cache)");
      return v;
    },
    // The engine is selected by PATH, never by name (a name filter that matches nothing is a green no-op), and an empty match fails.
    "path-filter": (wf) => {
      const { v, is } = verdict();
      const lines = scripts(wf).flatMap((s) => s.split("\n")).filter((l) => /(^|\s)(--filter|-F)\b/.test(l));
      is(lines.length >= 3, `expected at least 3 filtered commands (install, build, pack), found ${lines.length}`);
      for (const l of lines) {
        is(/ --filter \.\/packages\/engine(\.\.\.)?( |$)/.test(l), `a filter that is not ./packages/engine: ${l}`);
        is(l.includes(" --fail-if-no-match"), `a filter without --fail-if-no-match: ${l}`);
      }
      return v;
    },
    // The token reaches exactly one place: the publish step's NODE_AUTH_TOKEN. It is never echoed, traced, set at job level or left in a git config.
    token: (wf) => {
      const { v, is } = verdict();
      for (const s of scripts(wf)) is(!(s.includes("echo") && s.includes("TOKEN")), `a run block holds both echo and TOKEN:\n${s}`);
      for (const s of scripts(wf)) is(!/set -[a-z]*x|xtrace|printenv|\benv\b *(\||$)/m.test(s), `a run block traces or dumps the environment:\n${s}`);
      const holders = wf.code.filter((l) => /secrets\.|github\.token/.test(l));
      is(holders.length === 1 && holders[0].trim() === "NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}", `the token is referenced somewhere other than the one NODE_AUTH_TOKEN line: ${JSON.stringify(holders)}`);
      is(named(wf.jobs.publish, "Publish")?.env.NODE_AUTH_TOKEN === "${{ secrets.GITHUB_TOKEN }}", "the Publish step does not carry NODE_AUTH_TOKEN");
      is(!wf.code.some((l) => /^(env| {4}env):/.test(l)), "a workflow- or job-level env: block exists (env belongs to steps)");
      const checkouts = stepsOf(wf).filter(({ step }) => step.uses?.startsWith("actions/checkout@"));
      is(checkouts.length === Object.keys(wf.jobs).length && checkouts.every(({ step }) => step.with["persist-credentials"] === "false"), "a checkout leaves the job token in .git/config (persist-credentials is not false)");
      return v;
    },
    // Nothing here writes to the repository: no commit, tag, push or release (the committed package.json version is never changed).
    "no-repo-write": (wf) => {
      const { v, is } = verdict();
      for (const s of scripts(wf)) is(!/\bgit (push|commit|tag|add|checkout|reset)\b|\bgh (release|api|pr|workflow)\b/.test(s), `a run block writes to the repo or calls gh:\n${s}`);
      return v;
    },
    // The tarball that is checked is the tarball that is published: one path, in the directory pack wrote to, named for the derived version.
    "tarball-identity": (wf) => {
      const { v, is } = verdict();
      const check = named(wf.jobs.publish, "Check the tarball before it leaves the runner");
      const publish = named(wf.jobs.publish, "Publish");
      const pack = named(wf.jobs.publish, "Pack");
      is(check?.env.TARBALL === TARBALL && publish?.env.TARBALL === TARBALL, `the check and publish steps do not both carry TARBALL=${TARBALL}`);
      is(check?.env.VERSION === "${{ steps.version.outputs.version }}", "the check step's VERSION is not the derive step's output");
      is(pack?.run?.includes('--pack-destination "$RUNNER_TEMP/engine-canary"') === true, "pack does not write to $RUNNER_TEMP/engine-canary");
      return v;
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------------- mutants

/** `text` with `from` replaced by `to`, which must exist exactly once (a mutant that matched nothing would be a silent no-op). */
const swap = (from: string, to: string) => (text: string) => {
  const parts = text.split(from);
  if (parts.length !== 2) throw new Error(`the mutant's target occurs ${parts.length - 1} times, expected 1: ${from}`);
  return parts.join(to);
};

/** The step named `name` moved to sit just before the step named `before`, in the publish job (a reordered workflow, not a renamed one). */
const moveBefore = (name: string, before: string) => (text: string) => {
  const lines = text.split("\n");
  const head = (n: string) => lines.indexOf(`      - name: ${n}`);
  const from = head(name);
  const to = head(before);
  if (from === -1 || to === -1) throw new Error(`step not found: ${name} / ${before}`);
  let end = from + 1;
  while (end < lines.length && !lines[end].startsWith("      - ") && (lines[end] === "" || lines[end].startsWith("        ") || lines[end].startsWith("#"))) end++;
  const block = lines.slice(from, end);
  const rest = [...lines.slice(0, from), ...lines.slice(end)];
  const at = rest.indexOf(`      - name: ${before}`);
  return [...rest.slice(0, at), ...block, ...rest.slice(at)].join("\n");
};

const MUTANTS: { pin: string; label: string; apply: (text: string) => string }[] = [
  { pin: "trigger", label: "also triggers on pull_request", apply: swap("on:\n  push:", "on:\n  pull_request:\n  push:") },
  { pin: "trigger", label: "also triggers on workflow_dispatch", apply: swap("on:\n  push:", "on:\n  workflow_dispatch:\n  push:") },
  { pin: "trigger", label: "path filter widened to packages/**", apply: swap('paths: ["packages/engine/**"]', 'paths: ["packages/**"]') },
  { pin: "trigger", label: "branch filter widened", apply: swap("branches: [main]", "branches: [main, 'feat/**']") },
  { pin: "permissions", label: "workflow-level packages: write", apply: swap("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  packages: write\n") },
  { pin: "permissions", label: "the proof job also gets packages: write", apply: swap("  proof:\n", "  proof:\n    permissions:\n      contents: read\n      packages: write\n") },
  { pin: "permissions", label: "contents: write on the publish job", apply: swap("      contents: read\n      packages: write", "      contents: write\n      packages: write") },
  { pin: "pnpm-publish", label: "npm publish instead of pnpm publish", apply: swap('pnpm publish "$TARBALL"', 'npm publish "$TARBALL"') },
  { pin: "pnpm-publish", label: "publish the folder, not the checked tarball", apply: swap('pnpm publish "$TARBALL"', "pnpm publish packages/engine") },
  { pin: "tag", label: "--tag latest", apply: swap("--tag canary", "--tag latest") },
  { pin: "tag", label: "no --tag (npm's default tag is latest)", apply: swap(" --tag canary", "") },
  { pin: "version", label: "the derive step swallows a failing script", apply: swap(`version="$(${CLI} version)"\n          echo "version=\${version}"`, `echo "version=$(${CLI} version)"`) },
  { pin: "version", label: "the workflow edits package.json itself", apply: swap(`${CLI} set-version "$VERSION"`, 'npm pkg set version="0.0.0-canary.${GITHUB_SHA::9}"') },
  { pin: "gate", label: "publish no longer needs the proof", apply: swap("    needs: proof\n", "") },
  { pin: "gate", label: "publish runs even after a red proof", apply: swap("    needs: proof\n", "    needs: proof\n    if: always()\n") },
  { pin: "gate", label: "the pack proof is advisory", apply: swap("        run: node packages/engine/pack-proof/run.mjs", "        continue-on-error: true\n        run: node packages/engine/pack-proof/run.mjs") },
  { pin: "gate", label: "the pack proof is removed", apply: swap("node packages/engine/pack-proof/run.mjs", "echo skipped") },
  { pin: "gate", label: "the tarball check is skipped on some events", apply: swap("      - name: Check the tarball before it leaves the runner\n", "      - name: Check the tarball before it leaves the runner\n        if: github.event_name == 'never'\n") },
  { pin: "order", label: "publish before the check", apply: moveBefore("Publish", "Check the tarball before it leaves the runner") },
  { pin: "order", label: "pack before the build", apply: moveBefore("Pack", "Build dist") },
  { pin: "concurrency", label: "a running publish is cancelled by the next push", apply: swap("cancel-in-progress: false", "cancel-in-progress: true") },
  { pin: "concurrency", label: "another group", apply: swap("group: engine-canary", "group: engine-canary-${{ github.sha }}") },
  { pin: "toolchain", label: "Node 24", apply: swap("          node-version: 26\n          registry-url", "          node-version: 24\n          registry-url") },
  { pin: "toolchain", label: "another pnpm", apply: swap("          version: 10.34.5\n      # No package-manager cache", "          version: 10.33.0\n      # No package-manager cache") },
  { pin: "toolchain", label: "publish to npmjs", apply: swap("registry-url: https://npm.pkg.github.com", "registry-url: https://registry.npmjs.org") },
  { pin: "toolchain", label: "the publish job restores a cache", apply: swap("          package-manager-cache: false\n", "") },
  { pin: "toolchain", label: "a self-hosted runner", apply: swap("  publish:\n    name: Publish the canary\n    needs: proof\n    runs-on: ubuntu-latest", "  publish:\n    name: Publish the canary\n    needs: proof\n    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}") },
  { pin: "path-filter", label: "the build selects the engine by name", apply: swap("pnpm --filter ./packages/engine --fail-if-no-match run build:dist", "pnpm --filter @onryde/seazn-engine --fail-if-no-match run build:dist") },
  { pin: "path-filter", label: "pack without --fail-if-no-match", apply: swap("pnpm --filter ./packages/engine --fail-if-no-match pack", "pnpm --filter ./packages/engine pack") },
  { pin: "token", label: "the token is echoed", apply: swap(`${CLI} check "$TARBALL" "$VERSION"`, `echo "$NODE_AUTH_TOKEN"; ${CLI} check "$TARBALL" "$VERSION"`) },
  { pin: "token", label: "set -x in a run block", apply: swap(`run: ${CLI} set-version "$VERSION"`, `run: set -x; ${CLI} set-version "$VERSION"`) },
  { pin: "token", label: "the token moves to job-level env", apply: swap("    permissions:\n      contents: read\n      packages: write\n", "    permissions:\n      contents: read\n      packages: write\n    env:\n      NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n") },
  { pin: "token", label: "the proof job's checkout keeps the credential", apply: swap("      - uses: actions/checkout@v5\n        with:\n          persist-credentials: false\n      - uses: pnpm/action-setup@v4\n        with:\n          version: 10.34.5\n      - uses: actions/setup-node@v5\n        with:\n          node-version: 26\n          cache: pnpm", "      - uses: actions/checkout@v5\n      - uses: pnpm/action-setup@v4\n        with:\n          version: 10.34.5\n      - uses: actions/setup-node@v5\n        with:\n          node-version: 26\n          cache: pnpm") },
  { pin: "no-repo-write", label: "tags the commit", apply: swap(`run: ${CLI} check "$TARBALL" "$VERSION"`, `run: |\n          ${CLI} check "$TARBALL" "$VERSION"\n          git tag "v$VERSION"`) },
  { pin: "tarball-identity", label: "publish a different tarball than the checked one", apply: swap("        env:\n          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          TARBALL: ${{ runner.temp }}/engine-canary/onryde-seazn-engine-${{ steps.version.outputs.version }}.tgz", "        env:\n          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          TARBALL: ${{ runner.temp }}/engine-canary/other.tgz") },
];

// -------------------------------------------------------------------------------------------------------------------- the tests

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const text = read(WORKFLOW);
const rootPkg = JSON.parse(read("package.json")) as { packageManager: string };
const PINS = pinsOf(rootPkg);
const wf = parse(text);

describe("engine-canary.yml (engine-split Task 1b-4, D16)", () => {
  it("parses into the jobs and steps the pins judge (never an empty set)", () => {
    expect(Object.keys(wf.jobs)).toEqual(["proof", "publish"]);
    expect(wf.jobs.proof!.steps.length).toBeGreaterThanOrEqual(5);
    expect(wf.jobs.publish!.steps.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(PINS).length).toBeGreaterThanOrEqual(12);
  });

  it("every pin holds on the real workflow, and each pin judged something", () => {
    let checked = 0;
    for (const [name, pin] of Object.entries(PINS)) {
      const verdict = pin(wf);
      expect(verdict.problems, name).toEqual([]);
      expect(verdict.checked, `${name} checked nothing`).toBeGreaterThan(0);
      checked += verdict.checked;
    }
    expect(checked).toBeGreaterThan(60);
  });

  it("every pin is held to a failing input: each mutant changes the text and is named by its pin", () => {
    for (const pin of Object.keys(PINS)) expect(MUTANTS.filter((m) => m.pin === pin).length, `${pin} has no mutant`).toBeGreaterThan(0);
    expect(MUTANTS.length).toBeGreaterThanOrEqual(30);
    for (const m of MUTANTS) {
      const mutated = m.apply(text);
      expect(mutated, `${m.pin}: ${m.label} did not change the text`).not.toBe(text);
      const verdict = PINS[m.pin]!(parse(mutated));
      expect(verdict.problems.length, `${m.pin}: "${m.label}" was not caught`).toBeGreaterThan(0);
    }
  });

  it("runs the pack proof in the same way as ci.yml's engine-pack job and the engine's own pack:proof script", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("        run: node packages/engine/pack-proof/run.mjs");
    const engine = JSON.parse(read("packages/engine/package.json")) as { version: string; scripts: Record<string, string>; files: string[] };
    expect(engine.scripts["pack:proof"]).toBe("node pack-proof/run.mjs");
    expect(wf.jobs.proof!.steps.some((s) => s.run === "node packages/engine/pack-proof/run.mjs")).toBe(true);
  });

  it("never changes the committed version: package.json carries a plain release version, not a canary (the version is set on the runner only)", () => {
    const engine = JSON.parse(read("packages/engine/package.json")) as { version: string; files: string[] };
    expect(engine.version).toMatch(/^\d+\.\d+\.\d+$/);
    // canary.mjs is tooling for this workflow, not part of what is published
    expect(engine.files).not.toContain("pack-proof");
    expect(engine.files.some((f) => f.includes("canary"))).toBe(false);
  });

  describe("the derive step, run for real (bash -e, as GitHub runs a step)", () => {
    const script = wf.jobs.publish!.steps.find((s) => s.id === "version")!.run!;
    const run = (env: Record<string, string>) => {
      const dir = mkdtempSync(path.join(tmpdir(), "canary-step-"));
      try {
        const out = path.join(dir, "github-output");
        writeFileSync(out, "");
        const r = spawnSync("bash", ["-e", "-c", script], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, ...env } });
        return { status: r.status, stderr: r.stderr, output: readFileSync(out, "utf8") };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("writes exactly one `version=<canary>` line from the run number and the commit sha", () => {
      const r = run({ GITHUB_RUN_NUMBER: "1234", GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.output).toBe("version=0.0.0-canary.1234.g012345678\n");
    });

    it("a second run on a LATER run number of the SAME commit gets a different, higher version", () => {
      const first = run({ GITHUB_RUN_NUMBER: "99", GITHUB_SHA: "abcdef0123456789abcdef0123456789abcdef01" });
      const later = run({ GITHUB_RUN_NUMBER: "100", GITHUB_SHA: "abcdef0123456789abcdef0123456789abcdef01" });
      expect([first.status, later.status]).toEqual([0, 0]);
      expect(first.output).toBe("version=0.0.0-canary.99.gabcdef012\n");
      expect(later.output).toBe("version=0.0.0-canary.100.gabcdef012\n");
    });

    it("fails the step, and writes no `version=` line, when the script cannot derive a version", () => {
      const unusable: Record<string, string>[] = [{}, { GITHUB_RUN_NUMBER: "7" }, { GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567" }, { GITHUB_RUN_NUMBER: "0", GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567" }, { GITHUB_RUN_NUMBER: "7", GITHUB_SHA: "not-a-sha" }];
      expect(unusable.length).toBe(5);
      for (const env of unusable) {
        const r = run(env);
        expect(r.status, JSON.stringify(env)).not.toBe(0);
        expect(r.output, JSON.stringify(env)).toBe("");
      }
    });
  });
});
