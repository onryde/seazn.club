// Every placement image in seazn.club CI comes from ONE pin (engine-split phase 2a, Task W2).
//
// The placement service lives in its own repo now. This repo vendors its proto and pins the image built from the very commit the
// proto was copied at (`VENDORED.json`'s `imageTag`). Two things must stay true or CI tests the wrong thing without saying so:
//
//   * the seven jobs that run `placement-service:ci` get it by PULLING the pinned `ghcr.io/onryde/seazn-placement:<sha>` (and
//     retagging it), through the one script `scripts/placement-image.sh` — none builds it from source and none types a tag;
//   * the scheduler's live tests (placement-integration, repair-decompose-cpsat-integration) run in ci.yml's `scheduler-live`
//     job, against that same pinned image as a service container.
//
// Three groups: the script EXECUTED (a refusal that only reads well is not a refusal), the workflows' text (a pull step that
// nobody runs is the inert-seam shape), and the two new ci.yml jobs. The expected job set comes from the plan's facts table —
// the jobs that exist today — never from the scan under test.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// Every case below spawns bash (and jq, and a docker shim), several in a row; on a loaded runner the 5s default is not enough and
// a timeout reads as a failure of the thing under test. The budget lives here, with the tests it is for.
vi.setConfig({ testTimeout: 30_000 });

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "../..");
const SCRIPT = join(PACKAGE, "scripts/placement-image.sh");
const REAL_PIN = join(PACKAGE, "VENDORED.json");
const WORKFLOWS = join(REPO, ".github/workflows");
const IMAGE = "ghcr.io/onryde/seazn-placement";

const SCRATCH = mkdtempSync(join(tmpdir(), "placement-image-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
let counter = 0;
const fresh = (name: string): string => join(SCRATCH, `${String(++counter)}-${name}`);

// ---------------------------------------------------------------------------------------------------------------------
// The script, executed.
// ---------------------------------------------------------------------------------------------------------------------

const GOOD_TAG = "0123456789abcdef0123456789abcdef01234567";

/** Env for a script run: the caller's env minus any inherited pin override, plus `extra`. */
function envWith(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PLACEMENT_VENDORED_JSON;
  return { ...env, ...extra };
}
function run(args: string[], extra: Record<string, string> = {}, cwd: string = SCRATCH) {
  const r = spawnSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf8", env: envWith(extra) });
  expect(r.error, "bash must be runnable: a script that cannot run proves nothing").toBeUndefined();
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** A pin file holding `body` verbatim; returns its path. */
function pinFile(body: string): string {
  const path = fresh("VENDORED.json");
  writeFileSync(path, body);
  return path;
}
const pinWith = (imageTag: unknown): string =>
  pinFile(JSON.stringify({ placementCommit: GOOD_TAG, sha256: "0".repeat(64), imageTag }, null, 2) + "\n");

describe("placement-image.sh ref", () => {
  it("anti-vacuity: jq is installed (every case below would otherwise fail for the wrong reason)", () => {
    expect(spawnSync("jq", ["--version"], { encoding: "utf8" }).status).toBe(0);
    expect(existsSync(SCRIPT), "the script exists").toBe(true);
  });

  it("prints the pinned reference, exactly, and nothing else", () => {
    const out = run(["ref"], { PLACEMENT_VENDORED_JSON: pinWith("a".repeat(40)) });
    expect(out).toEqual({ code: 0, stdout: `${IMAGE}:${"a".repeat(40)}\n`, stderr: "" });
  });

  it("on the REAL pin: the reference ends with VENDORED.json's imageTag (read from the file, from any working directory)", () => {
    const tag = (JSON.parse(readFileSync(REAL_PIN, "utf8")) as { imageTag: string }).imageTag;
    expect(tag, "the pin this test reads is itself well-formed").toMatch(/^[0-9a-f]{40}$/);
    const out = run(["ref"], {}, SCRATCH);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toBe(`${IMAGE}:${tag}\n`);
  });

  it("finds VENDORED.json NEXT TO THE SCRIPT, not under the repo it was written in or the caller's directory", () => {
    const pkg = fresh("pkg");
    mkdirSync(join(pkg, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(pkg, "scripts/placement-image.sh"));
    writeFileSync(join(pkg, "VENDORED.json"), JSON.stringify({ placementCommit: "b".repeat(40), sha256: "0".repeat(64), imageTag: "b".repeat(40) }));
    const r = spawnSync("bash", [join(pkg, "scripts/placement-image.sh"), "ref"], { cwd: SCRATCH, encoding: "utf8", env: envWith() });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${IMAGE}:${"b".repeat(40)}\n`);
  });

  // Each refusal is a pin a person could plausibly commit, and each must print `::error::` on STDERR with nothing on stdout:
  // the caller is `ref="$(bash …placement-image.sh ref)"`, so anything on stdout would be captured into the reference, and an
  // `::error::` printed there would never reach the log.
  const REFUSED: [label: string, path: () => string][] = [
    ["a missing file", () => join(SCRATCH, "no-such-dir", "VENDORED.json")],
    ["a pin with no imageTag", () => pinFile(JSON.stringify({ placementCommit: GOOD_TAG, sha256: "0".repeat(64) }))],
    ["a 7-character tag", () => pinWith("abcdef0")],
    ["an uppercase 40-character tag", () => pinWith("ABCDEF0123456789ABCDEF0123456789ABCDEF01")],
    ["a 41-character tag", () => pinWith(`${GOOD_TAG}a`)],
    ["a 40-character tag with a trailing newline", () => pinWith(`${GOOD_TAG}\n`)],
    ["an empty string", () => pinWith("")],
    ["a moving tag", () => pinWith("latest")],
    ["a number", () => pinWith(1234567890)],
    ["a null", () => pinWith(null)],
    ["a file that is not JSON", () => pinFile("imageTag: 0123456789abcdef0123456789abcdef01234567\n")],
    ["an empty file", () => pinFile("")],
  ];
  it.each(REFUSED)("refuses %s", (_label, path) => {
    const out = run(["ref"], { PLACEMENT_VENDORED_JSON: path() });
    expect(out.code, `accepted it; stdout=${out.stdout}`).toBe(1);
    expect(out.stderr).toMatch(/::error::/);
    expect(out.stdout, "nothing may reach stdout, where `$(…)` would capture it as the reference").toBe("");
  });

  it("anti-vacuity: the refusal table is not empty and the control (a good tag) is accepted", () => {
    expect(REFUSED.length).toBeGreaterThanOrEqual(12);
    expect(run(["ref"], { PLACEMENT_VENDORED_JSON: pinWith(GOOD_TAG) }).code).toBe(0);
  });

  it.each([["no mode", []], ["an unknown mode", ["build"]], ["two modes", ["ref", "pull"]]] as [string, string[]][])(
    "refuses %s with ::error::",
    (_label, args) => {
      const out = run(args, { PLACEMENT_VENDORED_JSON: pinWith(GOOD_TAG) });
      expect(out.code).toBe(1);
      expect(out.stderr).toMatch(/::error::/);
      expect(out.stdout).toBe("");
    },
  );
});

describe("placement-image.sh pull", () => {
  const TAG = "c".repeat(40);
  const REF = `${IMAGE}:${TAG}`;
  const SHIM_DIR = fresh("shim");
  mkdirSync(SHIM_DIR);
  // A docker that records its argv, one call per line, and can be told to fail one subcommand. `image inspect` prints a
  // RepoDigests-shaped line so the test can see the script surface it.
  writeFileSync(
    join(SHIM_DIR, "docker"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$DOCKER_LOG"',
      '[ "$1" = "$DOCKER_FAIL_ON" ] && exit 1',
      'if [ "$1" = "image" ]; then echo \'["ghcr.io/onryde/seazn-placement@sha256:feedface"]\'; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(SHIM_DIR, "docker"), 0o755);

  function pull(pin: string, failOn = "") {
    const log = fresh("docker.log");
    const r = spawnSync("bash", [SCRIPT, "pull"], {
      cwd: SCRATCH,
      encoding: "utf8",
      env: envWith({ PLACEMENT_VENDORED_JSON: pin, PATH: `${SHIM_DIR}:${process.env.PATH ?? ""}`, DOCKER_LOG: log, DOCKER_FAIL_ON: failOn }),
    });
    expect(r.error).toBeUndefined();
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls };
  }

  it("pulls the pinned reference, retags it placement-service:ci, then prints what was pulled", () => {
    const out = pull(pinWith(TAG));
    expect(out.code, out.stderr).toBe(0);
    expect(out.calls).toEqual([
      `pull ${REF}`,
      `tag ${REF} placement-service:ci`,
      `image inspect --format {{json .RepoDigests}} ${REF}`,
    ]);
    expect(out.stdout, "the pulled digest reaches the log").toContain("sha256:feedface");
  });

  it.each([["pull"], ["tag"]])("stops when `docker %s` fails: no later docker call runs", (failOn) => {
    const out = pull(pinWith(TAG), failOn);
    expect(out.code, "a failed docker call must fail the script").not.toBe(0);
    expect(out.calls.at(-1), "the failing call is the last one made").toMatch(new RegExp(`^${failOn} `));
    if (failOn === "pull") expect(out.calls.filter((c) => c.startsWith("tag ") || c.startsWith("image ")), "no retag after a failed pull").toEqual([]);
    if (failOn === "tag") expect(out.calls.filter((c) => c.startsWith("image ")), "no inspect after a failed retag").toEqual([]);
  });

  it("refuses a malformed pin BEFORE touching docker", () => {
    const out = pull(pinWith("abcdef0"));
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/::error::/);
    expect(out.calls, "docker was never called").toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The workflows' text.
// ---------------------------------------------------------------------------------------------------------------------

/** Comment lines out (a `#` line in a workflow, or in a `run:` body, asserts nothing). */
const stripComments = (text: string): string =>
  text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
/** `\`-continued lines joined, so a multi-line `docker run … \ … placement-service:ci` is one line. */
const joinContinuations = (text: string): string => text.replace(/\\\n[ \t]*/g, " ");

interface Job {
  file: string;
  id: string;
  /** The job's lines, comments stripped, newline-joined (continuations NOT joined: step keys are read from these). */
  text: string;
}
const key = (job: Job): string => `${job.file}:${job.id}`;

/** Every job of one workflow: the 2-space `id:` lines under the top-level `jobs:`. */
function jobsOf(file: string): Job[] {
  const lines = stripComments(readFileSync(join(WORKFLOWS, file), "utf8")).split("\n");
  const from = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (from < 0) return [];
  const jobs: Job[] = [];
  let cur: { id: string; lines: string[] } | undefined;
  const flush = () => {
    if (cur) jobs.push({ file, id: cur.id, text: cur.lines.join("\n") });
  };
  for (const line of lines.slice(from + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key ends the jobs section
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      flush();
      cur = { id: m[1]!, lines: [] };
    } else cur?.lines.push(line);
  }
  flush();
  return jobs;
}

const WORKFLOW_FILES = readdirSync(WORKFLOWS)
  .filter((f) => f.endsWith(".yml"))
  .sort();
/** The three workflows that still build or deploy the frozen in-tree placement service (W3 deletes all three): each names
 *  `services/placement` and builds its own image from it, so they are outside both "builds from source" and "pulls the pin".
 *  Named, with a test that every exemption is real, so the list cannot quietly widen or outlive the files. */
const FROZEN_TREE_WORKFLOWS = ["placement-ci.yml", "placement-prod.yml", "placement-stg.yml"];
const ALL_JOBS = WORKFLOW_FILES.flatMap((f) => jobsOf(f));
const PINNED_JOBS = ALL_JOBS.filter((j) => !FROZEN_TREE_WORKFLOWS.includes(j.file));

/** The jobs that docker-run the CI placement image: facts, from the plan's table — not from the scan under test. */
const RUNNERS = [
  "ci.yml:smoke-db",
  "ci.yml:smoke-db-usecases",
  "ci.yml:smoke-e2e",
  "e2e.yml:e2e-parallel",
  "e2e.yml:e2e-serial",
  "e2e.yml:e2e-mobile",
  "bench.yml:bench",
];
/** Of those, the one whose image step runs in the background (a `wait:` joins it): unchanged from before the pin. */
const BACKGROUND_PULL = ["ci.yml:smoke-e2e"];
const PULL_COMMAND = "bash packages/scheduler/scripts/placement-image.sh pull";
const PLACEMENT_RUN = /\bdocker run\b[^\n]*\bplacement-service:ci\b/;

const runsPlacement = (job: Job): boolean => PLACEMENT_RUN.test(joinContinuations(job.text));
const job = (file: string, id: string): Job => {
  const found = ALL_JOBS.find((j) => j.file === file && j.id === id);
  expect(found, `no job ${file}:${id}`).toBeDefined();
  return found!;
};

interface Step {
  name?: string;
  id?: string;
  keys: string[];
  /** The step's lines, newline-joined. */
  text: string;
  /** `run:` value when it is a one-liner. */
  runLine?: string;
}
/** The steps of a job: each starts at a 6-space `- ` line; its keys sit at column 8 (the header line carries the first). */
function stepsOf(j: Job): Step[] {
  const lines = j.text.split("\n");
  const steps: Step[] = [];
  let cur: string[] | undefined;
  const flush = () => {
    if (!cur) return;
    const keys = cur.flatMap((l, i) => {
      const m = i === 0 ? /^ {6}- ([A-Za-z][A-Za-z0-9_-]*):/.exec(l) : /^ {8}([A-Za-z][A-Za-z0-9_-]*):/.exec(l);
      return m ? [m[1]!] : [];
    });
    const text = cur.join("\n");
    const pick = (k: string) => new RegExp(`^(?: {6}- | {8})${k}:[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim();
    steps.push({ name: pick("name"), id: pick("id"), keys, text, runLine: (() => { const r = pick("run"); return r && r !== "|" ? r : undefined; })() });
  };
  let inSteps = false;
  for (const line of lines) {
    if (/^ {4}steps:\s*$/.test(line)) {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;
    if (/^ {0,5}\S/.test(line)) {
      flush();
      cur = undefined;
      inSteps = false;
      continue;
    }
    if (/^ {6}- /.test(line)) {
      flush();
      cur = [line];
    } else cur?.push(line);
  }
  flush();
  return steps;
}
const stepNamed = (j: Job, name: string): Step => {
  const hits = stepsOf(j).filter((s) => s.name === name);
  expect(hits.length, `step "${name}" in ${key(j)} (occurrences)`).toBe(1);
  return hits[0]!;
};
/** The body of a step's `run: |` block, de-indented. */
function runBody(step: Step): string {
  const lines = step.text.split("\n");
  const at = lines.findIndex((l) => /^ {8}run:\s*\|\s*$/.test(l));
  expect(at, `step "${step.name}" has a \`run: |\` block`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && !l.startsWith(" ".repeat(10))) break;
    body.push(l.replace(/^ {10}/, ""));
  }
  return body.join("\n");
}

describe("the workflows: every placement image comes from the pin", () => {
  it("scans every workflow (anti-vacuity), and finds exactly the seven jobs that docker-run the CI placement image", () => {
    expect(WORKFLOW_FILES.length, "workflow files scanned").toBeGreaterThan(10);
    expect(ALL_JOBS.length, "jobs found").toBeGreaterThan(30);
    const found = PINNED_JOBS.filter(runsPlacement).map(key).sort();
    expect(found.length, "jobs found that run placement-service:ci").toBe(RUNNERS.length);
    expect(found).toEqual([...RUNNERS].sort());
  });

  it("each of the seven pulls the pin BEFORE its first docker run of the image, in one unsilenced step", () => {
    let checked = 0;
    for (const id of RUNNERS) {
      const [file, jobId] = id.split(":") as [string, string];
      const j = job(file, jobId);
      const joined = joinContinuations(j.text);
      const pulls = joined.split(PULL_COMMAND).length - 1;
      expect(pulls, `${id}: occurrences of the pull command`).toBe(1);
      const pullAt = joined.indexOf(PULL_COMMAND);
      const runAt = joined.search(PLACEMENT_RUN);
      expect(runAt, `${id}: runs the image`).toBeGreaterThan(-1);
      expect(pullAt, `${id}: the pull must come before the first docker run`).toBeLessThan(runAt);

      const step = stepsOf(j).find((s) => s.runLine === PULL_COMMAND);
      expect(step, `${id}: the pull is a step whose \`run\` is exactly the command`).toBeDefined();
      expect(step!.name, `${id}: the step's name`).toBe("Pull the pinned placement image");
      // `if:` or `continue-on-error:` would let the job reach `docker run` without the pull: on a reused runner that runs a stale
      // `placement-service:ci`, silently. `env:`/`working-directory:` change what the script reads or where it runs.
      expect(
        step!.keys.filter((k) => !["name", "id", "background", "run"].includes(k)),
        `${id}: the pull step carries a key that can skip, soften or move it`,
      ).toEqual([]);
      checked++;
    }
    expect(checked, "jobs checked").toBe(7);
  });

  it("a BACKGROUND pull is joined by a `wait:` that names it before the container starts, and only smoke-e2e backgrounds it", () => {
    const backgrounded: string[] = [];
    for (const id of RUNNERS) {
      const [file, jobId] = id.split(":") as [string, string];
      const j = job(file, jobId);
      const found = stepsOf(j).find((s) => s.runLine === PULL_COMMAND);
      expect(found, `${id}: has a pull step`).toBeDefined();
      const step = found!;
      if (/^ {8}background:\s*true\s*$/m.test(step.text)) backgrounded.push(id);
      if (!/^ {8}background:\s*true\s*$/m.test(step.text)) continue;
      expect(step.id, `${id}: a background step needs an id for its wait`).toBeTruthy();
      const joined = joinContinuations(j.text);
      // Parse the id lists rather than regex-match the id inside the brackets: `placement-image` would satisfy a `\bimage\b` test.
      const waitAt = [...joined.matchAll(/^\s+wait:\s*\[([^\]]*)\]/gm)].find((m) => m[1]!.split(",").map((n) => n.trim()).includes(step.id!))?.index ?? -1;
      expect(waitAt, `${id}: no \`wait:\` names the pull's id "${step.id!}"`).toBeGreaterThan(-1);
      expect(waitAt, `${id}: the wait comes after the pull`).toBeGreaterThan(joined.indexOf(PULL_COMMAND));
      expect(waitAt, `${id}: and before the container starts`).toBeLessThan(joined.search(PLACEMENT_RUN));
    }
    expect(backgrounded.sort()).toEqual(BACKGROUND_PULL);
  });

  it("every id a `wait:` names in the seven jobs is a step in that job (the pull step kept its id)", () => {
    let waits = 0;
    for (const id of RUNNERS) {
      const [file, jobId] = id.split(":") as [string, string];
      const j = job(file, jobId);
      const ids = new Set(stepsOf(j).flatMap((s) => (s.id ? [s.id] : [])));
      for (const m of j.text.matchAll(/^\s+wait:\s*\[([^\]]*)\]/gm)) {
        for (const name of m[1]!.split(",").map((s) => s.trim())) {
          expect(ids.has(name), `${id}: wait names "${name}", which is no step id here`).toBe(true);
          waits++;
        }
      }
    }
    expect(waits, "wait ids checked (smoke-e2e: 2, e2e: 3 each)").toBe(2 + 3 + 3 + 3);
  });

  it("no workflow builds the placement image from source or types a tag; the seven blocks carry no build tooling", () => {
    let scanned = 0;
    for (const file of WORKFLOW_FILES) {
      const text = stripComments(readFileSync(join(WORKFLOWS, file), "utf8"));
      scanned++;
      expect(text, `${file}: a typed placement tag`).not.toMatch(/\/seazn-placement:[0-9a-f]{7,}/);
      if (!FROZEN_TREE_WORKFLOWS.includes(file)) expect(text, `${file}: builds placement from source`).not.toMatch(/context:\s*services\/placement/);
    }
    expect(scanned, "workflows scanned").toBe(WORKFLOW_FILES.length);
    let blocks = 0;
    for (const id of RUNNERS) {
      const [file, jobId] = id.split(":") as [string, string];
      const text = job(file, jobId).text;
      expect(text, `${id}: build-push-action`).not.toContain("build-push-action");
      expect(text, `${id}: nothing left uses buildx, so its setup step is dead weight`).not.toContain("setup-buildx-action");
      blocks++;
    }
    expect(blocks).toBe(7);
  });

  it("every exemption is real: each frozen-tree workflow exists and still builds placement from source (delete the exemption with the file, W3)", () => {
    let checked = 0;
    for (const file of FROZEN_TREE_WORKFLOWS) {
      expect(WORKFLOW_FILES, `the exempt workflow ${file} exists`).toContain(file);
      expect(stripComments(readFileSync(join(WORKFLOWS, file), "utf8")), `${file} builds from services/placement`).toMatch(/context:\s*services\/placement/);
      checked++;
    }
    expect(checked).toBe(3);
    const exemptJobs = FROZEN_TREE_WORKFLOWS.flatMap((f) => jobsOf(f)).length;
    expect(exemptJobs, "they have jobs").toBeGreaterThan(0);
    expect(PINNED_JOBS.length, "the exemption removes only those files' jobs").toBe(ALL_JOBS.length - exemptJobs);
  });
});

describe("ci.yml: placement-pin resolves the reference, scheduler-live runs the live tests against it", () => {
  const PIN = (): Job => job("ci.yml", "placement-pin");
  const LIVE = (): Job => job("ci.yml", "scheduler-live");
  const RESOLVE = "Resolve the pinned placement image";

  it("placement-pin assigns the reference BEFORE echoing it (a failed script must fail the step), and exports it as `image`", () => {
    const step = stepNamed(PIN(), RESOLVE);
    const body = runBody(step);
    const assign = body.indexOf('ref="$(bash packages/scheduler/scripts/placement-image.sh ref)"');
    expect(assign, "the reference is assigned from the script").toBeGreaterThan(-1);
    const echo = body.indexOf('echo "image=$ref" >> "$GITHUB_OUTPUT"');
    expect(echo, "and then written to the step output").toBeGreaterThan(assign);
    expect(body, "never `echo \"image=$(…)\"`: bash -e does not see a command substitution's failure there").not.toMatch(
      /echo [^\n]*\$\(bash packages\/scheduler\/scripts\/placement-image\.sh/,
    );
    expect(step.keys, "nothing on the step can skip or soften it").toEqual(["name", "id", "run"]);
    expect(PIN().text, "the job exports the step's output under the name scheduler-live consumes").toMatch(
      new RegExp(`^ {4}outputs:\\s*\\n {6}image: \\$\\{\\{ steps\\.${step.id!}\\.outputs\\.image \\}\\}\\s*$`, "m"),
    );
    expect(PIN().text).toMatch(/^ {4}runs-on: ubuntu-latest\s*$/m);
    expect(stepsOf(PIN())[0]!.text, "the script and the pin are read from a checkout").toContain("actions/checkout@");
  });

  it("the placement-pin step, EXECUTED: a good pin writes `image=<ref>`; a bad pin fails the step and writes nothing", () => {
    const body = runBody(stepNamed(PIN(), RESOLVE));
    const exec = (pin?: string) => {
      const out = fresh("github-output");
      writeFileSync(out, "");
      const r = spawnSync("bash", ["-e", "-c", body], {
        cwd: REPO,
        encoding: "utf8",
        env: envWith({ GITHUB_OUTPUT: out, ...(pin ? { PLACEMENT_VENDORED_JSON: pin } : {}) }),
      });
      expect(r.error).toBeUndefined();
      return { code: r.status, stderr: r.stderr, written: readFileSync(out, "utf8") };
    };
    const tag = (JSON.parse(readFileSync(REAL_PIN, "utf8")) as { imageTag: string }).imageTag;
    const good = exec();
    expect(good, good.stderr).toMatchObject({ code: 0, written: `image=${IMAGE}:${tag}\n` });
    const bad = exec(pinWith("abcdef0"));
    expect(bad.code, "a malformed pin must fail the step").not.toBe(0);
    expect(bad.written, "and must not write a (possibly empty) image output").toBe("");
    expect(bad.stderr).toMatch(/::error::/);
  });

  it("scheduler-live needs placement-pin and runs the pinned image as the `placement` service with the integration secret", () => {
    const text = LIVE().text;
    expect(text).toMatch(/^ {4}needs: placement-pin\s*$/m);
    const services = text.split("\n");
    const at = services.findIndex((l) => /^ {4}services:\s*$/.test(l));
    expect(at, "the job has services").toBeGreaterThan(-1);
    const end = services.findIndex((l, i) => i > at && /^ {4}\S/.test(l));
    const block = services.slice(at, end < 0 ? undefined : end).join("\n");
    expect(block).toMatch(/^ {6}placement:\s*$/m);
    expect(block, "the service image is placement-pin's output, nothing typed").toMatch(/^ {8}image: \$\{\{ needs\.placement-pin\.outputs\.image \}\}\s*$/m);
    expect(block).toMatch(/^ {10}- 50051:50051\s*$/m);
    expect(block).toMatch(/^ {10}PLACEMENT_LOG_LEVEL: WARNING\s*$/m);
    const serviceSecret = /^ {10}PLACEMENT_SERVICE_SECRET: (\S+)\s*$/m.exec(block)?.[1];
    // The same literal on both sides, or a mismatch folds into a greedy board and reads as "placement lost on merit".
    const suite = stepNamed(LIVE(), "Run the integration suite against the live service");
    const clientSecret = /^ {10}PLACEMENT_SERVICE_SECRET: (\S+)\s*$/m.exec(suite.text)?.[1];
    expect(serviceSecret, "the service's secret").toBe("ci-integration-secret");
    expect(clientSecret, "the client's secret is the same literal").toBe(serviceSecret);
  });

  it("scheduler-live's steps address the service container by id, never by a name no one gave it", () => {
    const steps = stepsOf(LIVE());
    const names = steps.map((s) => s.name).filter(Boolean);
    expect(names).toEqual([
      "Wait for the placement service",
      "Run the integration suite against the live service",
      "Assert the suite RAN, and passed",
    ]);
    expect(LIVE().text, "no `docker logs placement-integration`: this job starts no container of that name").not.toMatch(/docker (logs|rm)[^\n]*\bplacement-integration\b/);
    let using = 0;
    for (const s of steps) {
      if (!s.text.includes("$PLACEMENT_CONTAINER")) continue;
      using++;
      expect(s.text, `step "${s.name}" reads $PLACEMENT_CONTAINER`).toMatch(/^ {10}PLACEMENT_CONTAINER: \$\{\{ job\.services\.placement\.id \}\}\s*$/m);
      // An expression inside a script body would not survive the executed judge (`bash -c`), and is injection-shaped anyway.
      expect(runBody(s), `step "${s.name}": no \${{ }} in the script body`).not.toContain("${{");
    }
    expect(using, "steps that read the container id").toBe(2);
  });

  it("the judge and the job cannot be skipped or made non-blocking, and the judge has no key beyond name, env, run", () => {
    const judge = stepNamed(LIVE(), "Assert the suite RAN, and passed");
    expect(judge.keys).toEqual(["name", "env", "run"]);
    expect(LIVE().text, "no job-level if / continue-on-error / defaults").not.toMatch(/^ {4}(if|continue-on-error|defaults):/m);
    const wait = stepNamed(LIVE(), "Wait for the placement service");
    expect(wait.keys).toEqual(["name", "env", "run"]);
  });
});
