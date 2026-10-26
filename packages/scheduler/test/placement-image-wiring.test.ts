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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

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
/** A directory of executable shell shims, one per entry (name -> script body), to put at the front of a child's PATH. */
function shimDir(files: Record<string, string>): string {
  const dir = fresh("shims");
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

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

describe("placement-image.sh without jq", () => {
  // jq is the script's one non-POSIX dependency. A runner without it must fail with a message that names it, not with
  // `jq: command not found` from the middle of a command substitution (which the tag check would then misreport as a bad pin).
  const BASH = "/bin/bash";
  it.each([["ref"], ["pull"]])("%s mode: refuses with an ::error:: naming jq, before reading the pin or touching docker", (mode) => {
    expect(existsSync(BASH), "the control below needs an absolute bash").toBe(true);
    const empty = shimDir({});
    const docker = fresh("docker.log");
    const r = spawnSync(BASH, [SCRIPT, mode], {
      cwd: SCRATCH,
      encoding: "utf8",
      env: { PATH: empty, PLACEMENT_VENDORED_JSON: pinWith(GOOD_TAG), DOCKER_LOG: docker },
    });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::.*\bjq\b/);
    expect(r.stdout).toBe("");
    expect(existsSync(docker), "docker was never reached").toBe(false);
  });

  it("the control: the same invocation with jq on PATH succeeds", () => {
    const jqDir = shimDir({});
    const jq = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
    expect(jq, "jq is installed").not.toBe("");
    symlinkSync(jq, join(jqDir, "jq"));
    const dirname = spawnSync("sh", ["-c", "command -v dirname"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(dirname, join(jqDir, "dirname"));
    const r = spawnSync(BASH, [SCRIPT, "ref"], { cwd: SCRATCH, encoding: "utf8", env: { PATH: jqDir, PLACEMENT_VENDORED_JSON: pinWith(GOOD_TAG) } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`${IMAGE}:${GOOD_TAG}\n`);
  });
});

describe("placement-image.sh pull", () => {
  const TAG = "c".repeat(40);
  const REF = `${IMAGE}:${TAG}`;
  // A docker that records its argv, one call per line. It can be told to fail one subcommand for good (DOCKER_FAIL_ON) or to
  // fail the first N `pull`s and then succeed (DOCKER_PULL_FAILS: a transient registry error). `image inspect` prints a
  // RepoDigests-shaped line so the test can see the script surface it. A `sleep` that only records, so no case waits.
  const SHIMS = shimDir({
    docker: [
      "#!/bin/sh",
      'echo "$*" >> "$DOCKER_LOG"',
      'if [ "$1" = "pull" ] && [ -n "${DOCKER_PULL_FAILS:-}" ]; then',
      '  n=$(cat "$DOCKER_LOG.pulls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$DOCKER_LOG.pulls"',
      '  [ "$n" -le "$DOCKER_PULL_FAILS" ] && exit 1',
      "  exit 0",
      "fi",
      '[ "$1" = "$DOCKER_FAIL_ON" ] && exit 1',
      'if [ "$1" = "image" ]; then echo \'["ghcr.io/onryde/seazn-placement@sha256:feedface"]\'; fi',
      "exit 0",
      "",
    ].join("\n"),
    sleep: '#!/bin/sh\necho "$*" >> "$SLEEP_LOG"\nexit 0\n',
  });

  interface PullOpts {
    /** A docker subcommand that always fails. */
    failOn?: string;
    /** The first N pulls fail, then pulls succeed. */
    pullFails?: number;
    /** PLACEMENT_PULL_BACKOFF_S; "0" by default so no case waits, null leaves it unset (the script's own default). */
    backoff?: string | null;
  }
  function pull(pin: string, { failOn = "", pullFails, backoff = "0" }: PullOpts = {}) {
    const log = fresh("docker.log");
    const sleepLog = fresh("sleep.log");
    const env = envWith({
      PLACEMENT_VENDORED_JSON: pin,
      PATH: `${SHIMS}:${process.env.PATH ?? ""}`,
      DOCKER_LOG: log,
      SLEEP_LOG: sleepLog,
      DOCKER_FAIL_ON: failOn,
      ...(pullFails === undefined ? {} : { DOCKER_PULL_FAILS: String(pullFails) }),
      ...(backoff === null ? {} : { PLACEMENT_PULL_BACKOFF_S: backoff }),
    });
    if (backoff === null) delete env.PLACEMENT_PULL_BACKOFF_S;
    const r = spawnSync("bash", [SCRIPT, "pull"], { cwd: SCRATCH, encoding: "utf8", env });
    expect(r.error).toBeUndefined();
    const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls: lines(log), sleeps: lines(sleepLog) };
  }
  const TAIL = [`tag ${REF} placement-service:ci`, `image inspect --format {{json .RepoDigests}} ${REF}`];

  it("pulls the pinned reference, retags it placement-service:ci, then prints what was pulled", () => {
    const out = pull(pinWith(TAG));
    expect(out.code, out.stderr).toBe(0);
    expect(out.calls).toEqual([`pull ${REF}`, ...TAIL]);
    expect(out.sleeps, "no retry, so no wait").toEqual([]);
    expect(out.stdout, "the pulled digest reaches the log").toContain("sha256:feedface");
  });

  // A registry hiccup must not red a whole job, but a retry must also be BOUNDED and must not paper over a real failure.
  it("retries a pull that fails once: two pulls, one wait between them, then the retag", () => {
    const out = pull(pinWith(TAG), { pullFails: 1 });
    expect(out.code, out.stderr).toBe(0);
    expect(out.calls).toEqual([`pull ${REF}`, `pull ${REF}`, ...TAIL]);
    expect(out.sleeps).toEqual(["0"]);
  });

  it("retries twice: the third attempt is the last one it makes, and it succeeds", () => {
    const out = pull(pinWith(TAG), { pullFails: 2 });
    expect(out.code, out.stderr).toBe(0);
    expect(out.calls).toEqual([`pull ${REF}`, `pull ${REF}`, `pull ${REF}`, ...TAIL]);
    expect(out.sleeps).toEqual(["0", "0"]);
  });

  it("gives up after exactly three pulls, with an ::error:: and no retag: a pull that always fails stays a failure", () => {
    const out = pull(pinWith(TAG), { failOn: "pull" });
    expect(out.code, "a failed docker call must fail the script").not.toBe(0);
    expect(out.calls, "three attempts, then nothing").toEqual([`pull ${REF}`, `pull ${REF}`, `pull ${REF}`]);
    expect(out.sleeps, "a wait between attempts, none after the last").toEqual(["0", "0"]);
    expect(out.stderr).toMatch(/::error::.*pull.*3 attempts/);
  });

  it("three failed pulls and a fourth that would succeed: still a failure (the bound is real)", () => {
    const out = pull(pinWith(TAG), { pullFails: 3 });
    expect(out.code).not.toBe(0);
    expect(out.calls.filter((c) => c.startsWith("pull ")).length, "pull attempts").toBe(3);
    expect(out.calls.filter((c) => c.startsWith("tag ") || c.startsWith("image ")), "nothing after a given-up pull").toEqual([]);
  });

  it("does NOT retry the retag: a failed `docker tag` is the last call", () => {
    const out = pull(pinWith(TAG), { failOn: "tag" });
    expect(out.code).not.toBe(0);
    expect(out.calls).toEqual([`pull ${REF}`, `tag ${REF} placement-service:ci`]);
  });

  it.each([
    ["unset: the default is 5 seconds", null, "5"],
    ["PLACEMENT_PULL_BACKOFF_S=7", "7", "7"],
  ] as [string, string | null, string][])("backoff %s", (_label, backoff, expected) => {
    const out = pull(pinWith(TAG), { failOn: "pull", backoff });
    expect(out.sleeps).toEqual([expected, expected]);
  });

  it.each([["abc"], ["1.5"], ["-1"], ["5 5"]])("refuses PLACEMENT_PULL_BACKOFF_S=%j with an ::error:: before touching docker", (backoff) => {
    const out = pull(pinWith(TAG), { backoff });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/::error::.*PLACEMENT_PULL_BACKOFF_S/);
    expect(out.calls, "docker was never called").toEqual([]);
  });

  it("refuses a malformed pin BEFORE touching docker", () => {
    const out = pull(pinWith("abcdef0"));
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/::error::/);
    expect(out.calls, "docker was never called").toEqual([]);
  });
});

describe("placement-image.sh verify-pin", () => {
  const COMMIT = "9684aa96d17c1f4c546c1df09d5e20a885091978";
  const URL = `https://raw.githubusercontent.com/onryde/seazn.club.placement/${COMMIT}/proto/scheduler.proto`;
  const PROTO = 'syntax = "proto3";\npackage scheduler;\n';
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
  // A curl that records its argv and answers from CURL_RESULTS: comma-separated, one per call, the last repeats. An entry is
  // STATUS or STATUS:EXIT. The shim prints the status the way `--write-out %{http_code}` does, writes CURL_BODY to the
  // `--output` file when the status is 200, and exits EXIT (default 0; 7 for status 000, a dropped connection). It is
  // proven against the real network once per change (see the task report), not in this suite.
  const SHIMS = shimDir({
    curl: [
      "#!/bin/sh",
      'echo "$*" >> "$CURL_LOG"',
      'n=$(wc -l < "$CURL_LOG" | tr -d " ")',
      'entry=$(echo "$CURL_RESULTS" | cut -d, -f"$n")',
      'if [ -z "$entry" ]; then entry=$(echo "$CURL_RESULTS" | awk -F, \'{print $NF}\'); fi',
      'status=${entry%%:*}',
      'code=0; case "$entry" in *:*) code=${entry##*:} ;; esac',
      '[ "$status" = "000" ] && code=7',
      'out=""; prev=""',
      'for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done',
      'if [ "$status" = "200" ] && [ -n "$out" ]; then cat "$CURL_BODY" > "$out"; fi',
      'printf "%s" "$status"',
      'exit "$code"',
      "",
    ].join("\n"),
    sleep: '#!/bin/sh\necho "$*" >> "$SLEEP_LOG"\nexit 0\n',
  });
  const pinOf = (over: Record<string, unknown> = {}): string =>
    pinFile(JSON.stringify({ placementCommit: COMMIT, sha256: sha(PROTO), imageTag: COMMIT, ...over }, null, 2) + "\n");

  interface VerifyOpts {
    /** What the shim serves on a 200. */
    body?: string;
    /** PLACEMENT_PULL_BACKOFF_S; "0" by default so no case waits, null leaves it unset (the script's own default). */
    backoff?: string | null;
  }
  function verify(pin: string, results: string, { body = PROTO, backoff = "0" }: VerifyOpts = {}) {
    const curlLog = fresh("curl.log");
    const sleepLog = fresh("sleep.log");
    const bodyFile = fresh("body");
    writeFileSync(bodyFile, body);
    const env = envWith({
      PLACEMENT_VENDORED_JSON: pin,
      PATH: `${SHIMS}:${process.env.PATH ?? ""}`,
      CURL_LOG: curlLog,
      CURL_RESULTS: results,
      CURL_BODY: bodyFile,
      SLEEP_LOG: sleepLog,
      ...(backoff === null ? {} : { PLACEMENT_PULL_BACKOFF_S: backoff }),
    });
    if (backoff === null) delete env.PLACEMENT_PULL_BACKOFF_S;
    const r = spawnSync("bash", [SCRIPT, "verify-pin"], { cwd: SCRATCH, encoding: "utf8", env });
    expect(r.error).toBeUndefined();
    const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, curls: lines(curlLog), sleeps: lines(sleepLog) };
  }

  it("accepts a pin whose sha256 is the sha256 of the proto served at placementCommit, fetching exactly that URL once", () => {
    const out = verify(pinOf(), "200");
    expect(out.code, out.stderr).toBe(0);
    expect(out.curls).toHaveLength(1);
    expect(out.curls[0], "the raw URL at the pinned commit").toContain(URL);
    expect(out.stdout).toContain(COMMIT);
    expect(out.stdout).toContain(sha(PROTO));
  });

  it("refuses a pin that lies: the commit's proto hashes to something else; ::error:: names both hashes and the commit, no retry", () => {
    const served = `${PROTO}// edited after the pin\n`;
    const out = verify(pinOf(), "200", { body: served });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/::error::/);
    expect(out.stderr, "the hash the pin claims").toContain(sha(PROTO));
    expect(out.stderr, "the hash the commit actually has").toContain(sha(served));
    expect(out.stderr).toContain(COMMIT);
    expect(out.stderr, "the likely causes are named").toMatch(/stale|unpushed|hand/);
    expect(out.curls, "a mismatch is not transient").toHaveLength(1);
    expect(out.stdout, "no success line on a lie").toBe("");
  });

  it("an empty 200 body is a mismatch, not a pass", () => {
    const out = verify(pinOf(), "200", { body: "" });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(sha(""));
  });

  it("a 404 is permanent: fails at once (one fetch, no wait) saying the commit is not on the placement repo", () => {
    const out = verify(pinOf(), "404");
    expect(out.code).toBe(1);
    expect(out.curls).toHaveLength(1);
    expect(out.sleeps).toEqual([]);
    expect(out.stderr).toMatch(/::error::.*404/);
    expect(out.stderr).toContain(COMMIT);
    expect(out.stderr).toMatch(/not pushed|hand/);
  });

  it.each([["503"], ["000"], ["429"], ["200:18"]])("a transient %s then a 200 succeeds: two fetches, one wait between them", (first) => {
    const out = verify(pinOf(), `${first},200`);
    expect(out.code, out.stderr).toBe(0);
    expect(out.curls).toHaveLength(2);
    expect(out.sleeps).toEqual(["0"]);
  });

  it("a transient failure that never clears gives up after exactly three fetches with an ::error:: (and no wait after the last)", () => {
    const out = verify(pinOf(), "503");
    expect(out.code).toBe(1);
    expect(out.curls).toHaveLength(3);
    expect(out.sleeps).toEqual(["0", "0"]);
    expect(out.stderr).toMatch(/::error::.*3 attempts.*503/);
  });

  it("a 200 whose transfer was cut short (curl exits non-zero) is NOT a fetched file: retried, never compared, never read as a lying pin", () => {
    // The body the shim leaves WOULD hash to the pinned value, so a script that trusted the status alone would pass this.
    const out = verify(pinOf(), "200:18");
    expect(out.code).toBe(1);
    expect(out.curls).toHaveLength(3);
    expect(out.stderr).toMatch(/::error::.*3 attempts.*curl exit 18/);
    expect(out.stderr, "not reported as a hash mismatch").not.toMatch(/pin lies/);
  });

  it("a mismatch after a transient failure is still a mismatch (the retry does not skip the comparison)", () => {
    const out = verify(pinOf({ sha256: sha("something else") }), "503,200");
    expect(out.code).toBe(1);
    expect(out.curls).toHaveLength(2);
    expect(out.stderr).toContain(sha("something else"));
  });

  it("the backoff is the pull's: PLACEMENT_PULL_BACKOFF_S, default 5, validated before any fetch", () => {
    expect(verify(pinOf(), "503", { backoff: null }).sleeps).toEqual(["5", "5"]);
    expect(verify(pinOf(), "503", { backoff: "7" }).sleeps).toEqual(["7", "7"]);
    const bad = verify(pinOf(), "200", { backoff: "soon" });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/::error::.*PLACEMENT_PULL_BACKOFF_S/);
    expect(bad.curls).toEqual([]);
  });

  it.each([
    ["a placementCommit with uppercase", { placementCommit: COMMIT.toUpperCase() }],
    ["a 39-character placementCommit", { placementCommit: COMMIT.slice(1) }],
    ["no placementCommit", { placementCommit: undefined }],
    ["a placementCommit that is a branch name", { placementCommit: "main" }],
    ["a sha256 with uppercase", { sha256: sha(PROTO).toUpperCase() }],
    ["a 63-character sha256", { sha256: sha(PROTO).slice(1) }],
    ["no sha256", { sha256: undefined }],
  ] as [string, Record<string, unknown>][])("refuses %s with an ::error:: before any fetch", (_label, over) => {
    const out = verify(pinOf(over), "200");
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/::error::/);
    expect(out.curls, "curl was never called").toEqual([]);
  });

  it("refuses a missing curl with an ::error:: naming it", () => {
    // A PATH holding only jq and dirname (what the script needs before it reaches curl): `command -v curl` finds nothing.
    const tool = (name: string): string => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    const bare = shimDir({});
    symlinkSync(tool("jq"), join(bare, "jq"));
    symlinkSync(tool("dirname"), join(bare, "dirname"));
    const r = spawnSync("/bin/bash", [SCRIPT, "verify-pin"], { cwd: SCRATCH, encoding: "utf8", env: { PATH: bare, PLACEMENT_VENDORED_JSON: pinOf() } });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/::error::.*\bcurl\b/);
  });

  it("refuses a missing pin file with an ::error:: and never fetches", () => {
    const out = verify(join(SCRATCH, "no-such-dir", "VENDORED.json"), "200");
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/::error::.*does not exist/);
    expect(out.curls).toEqual([]);
  });

  it("reads placementCommit and sha256 only: a pin with no imageTag still verifies (that field belongs to ref and pull)", () => {
    const out = verify(pinFile(JSON.stringify({ placementCommit: COMMIT, sha256: sha(PROTO) })), "200");
    expect(out.code, out.stderr).toBe(0);
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
/** Job-level keys that skip a job, make its red non-blocking or move its steps: `if:` and `continue-on-error:` (a skipped job
 *  reads as green, and so does everything that `needs` it), `defaults:` (a working-directory there moves every step). Anchored
 *  to the job's key column, so a step's own `if:` (8 spaces), a `run:` body line and a comment never match. */
const JOB_SILENCERS = /^ {4}(?:if|continue-on-error|defaults):/gm;
const silencersOf = (j: Job): string[] => j.text.match(JOB_SILENCERS) ?? [];

/** Every job of one workflow: the 2-space `id:` lines under the top-level `jobs:`. */
const jobsOf = (file: string): Job[] => parseJobs(file, readFileSync(join(WORKFLOWS, file), "utf8"));
/** The same, from workflow TEXT: the negative self-tests parse a mutated copy of the real file. */
function parseJobs(file: string, source: string): Job[] {
  const lines = stripComments(source).split("\n");
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
const ALL_JOBS = WORKFLOW_FILES.flatMap((f) => jobsOf(f));

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
    const found = ALL_JOBS.filter(runsPlacement).map(key).sort();
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

  it("no workflow uses a `context: services/placement` build action or types a tag; none of the seven blocks uses build-push-action or setup-buildx-action", () => {
    let jobsScanned = 0;
    for (const file of WORKFLOW_FILES) {
      const text = stripComments(readFileSync(join(WORKFLOWS, file), "utf8"));
      // A file that parses to no jobs, or to no text, is "scanned" for nothing: that is a red, not a pass.
      expect(text.length, `${file}: text scanned`).toBeGreaterThan(0);
      const jobs = jobsOf(file).length;
      expect(jobs, `${file}: jobs parsed`).toBeGreaterThan(0);
      jobsScanned += jobs;
      expect(text, `${file}: a typed placement tag`).not.toMatch(/\/seazn-placement:[0-9a-f]{7,}/);
      // Only the build-push-action `context:` form is checked. It is not a guard against re-adding the service: other
      // spellings (`docker build services/placement`) are not looked for, by owner ruling (engine-split 2a, no re-add guard).
      expect(text, `${file}: a \`context: services/placement\` build action`).not.toMatch(/context:\s*services\/placement/);
    }
    expect(jobsScanned, "jobs scanned across every workflow").toBe(ALL_JOBS.length);
    expect(jobsScanned, "and that is a real number of jobs").toBeGreaterThan(30);
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
});

describe("ci.yml: placement-pin resolves the reference, scheduler-live runs the live tests against it", () => {
  const PIN = (): Job => job("ci.yml", "placement-pin");
  const LIVE = (): Job => job("ci.yml", "scheduler-live");
  const RESOLVE = "Resolve the pinned placement image";

  it("placement-pin verifies the pin against the placement repo in its own unsilenced step, after the checkout and BEFORE it resolves the reference", () => {
    const steps = stepsOf(PIN());
    const verify = steps.filter((x) => x.runLine === "bash packages/scheduler/scripts/placement-image.sh verify-pin");
    expect(verify, "verify-pin steps").toHaveLength(1);
    expect(verify[0]!.name).toBe("Verify the pin against the placement repo");
    expect(verify[0]!.keys, "nothing on the step can skip or soften it").toEqual(["name", "run"]);
    expect(steps.map((x) => x.name ?? "(uses)")).toEqual(["(uses)", "Verify the pin against the placement repo", RESOLVE]);
    expect(steps[0]!.text, "the first step is the checkout").toContain("actions/checkout@");
  });

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

  it("neither placement-pin nor scheduler-live can be skipped, made non-blocking or moved at the JOB level (`if:`, `continue-on-error:`, `defaults:`)", () => {
    // A skipped placement-pin skips scheduler-live with it (a `needs` job that did not run), and a skipped job reads as green:
    // the only job that talks to a real solver would vanish without a red. Step-level keys are pinned step by step, below.
    let jobs = 0;
    for (const j of [PIN(), LIVE()]) {
      expect(silencersOf(j), `${key(j)} carries a job-level key that can skip or soften it`).toEqual([]);
      jobs++;
    }
    expect(jobs, "jobs checked").toBe(2);
  });

  it("the judge and the wait step carry no key beyond name, env, run", () => {
    expect(stepNamed(LIVE(), "Assert the suite RAN, and passed").keys).toEqual(["name", "env", "run"]);
    expect(stepNamed(LIVE(), "Wait for the placement service").keys).toEqual(["name", "env", "run"]);
  });

  describe("the job-level check refuses each way to silence the two jobs (negative self-test on a mutated copy of the real ci.yml)", () => {
    const REAL = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
    const after = (anchor: string, insert: string): string => {
      expect(REAL.split(anchor).length - 1, `anchor occurs once: ${anchor.trim()}`).toBe(1);
      return REAL.replace(anchor, () => `${anchor}${insert}`);
    };
    const PIN_HEAD = "    name: Resolve the pinned placement image\n";
    const LIVE_HEAD = "    name: Scheduler ↔ live placement service (real gRPC, no mocks)\n";
    const PIN_LAST = '          echo "image=$ref" >> "$GITHUB_OUTPUT"\n';
    const LIVE_LAST = '          echo "integration suite ran against the live service: $passed passed, 0 skipped"\n';
    const MUTED: [label: string, jobId: string, yml: () => string][] = [
      ["`if: false` on placement-pin", "placement-pin", () => after(PIN_HEAD, "    if: false\n")],
      ["`continue-on-error: true` on placement-pin", "placement-pin", () => after(PIN_HEAD, "    continue-on-error: true\n")],
      ["`defaults:` on placement-pin", "placement-pin", () => after(PIN_HEAD, "    defaults:\n      run:\n        working-directory: apps/web\n")],
      ["`if:` on placement-pin, written AFTER its steps", "placement-pin", () => after(PIN_LAST, "    if: github.event_name == 'push'\n")],
      ["`continue-on-error:` on placement-pin, written AFTER its steps", "placement-pin", () => after(PIN_LAST, "    continue-on-error: true\n")],
      ["`if: false` on scheduler-live", "scheduler-live", () => after(LIVE_HEAD, "    if: false\n")],
      ["`continue-on-error: true` on scheduler-live", "scheduler-live", () => after(LIVE_HEAD, "    continue-on-error: true\n")],
      ["`defaults:` on scheduler-live", "scheduler-live", () => after(LIVE_HEAD, "    defaults:\n      run:\n        working-directory: apps/web\n")],
      ["`if:` on scheduler-live, written AFTER its steps", "scheduler-live", () => after(LIVE_LAST, "    if: false\n")],
    ];
    it.each(MUTED)("flags %s", (_label, jobId, yml) => {
      const mutated = parseJobs("ci.yml", yml()).find((j) => j.id === jobId);
      expect(mutated, `the mutated file still has job ${jobId}`).toBeDefined();
      expect(silencersOf(mutated!), "silencing keys found").toHaveLength(1);
    });

    it("anti-vacuity: the table is not empty, and the unmutated file is clean for both jobs", () => {
      expect(MUTED.length).toBeGreaterThanOrEqual(9);
      let clean = 0;
      for (const id of ["placement-pin", "scheduler-live"]) {
        expect(silencersOf(parseJobs("ci.yml", REAL).find((j) => j.id === id)!), id).toEqual([]);
        clean++;
      }
      expect(clean).toBe(2);
    });

    it("does not flag what silences nothing: a comment, a step's own `if:`", () => {
      const pinOf = (yml: string) => parseJobs("ci.yml", yml).find((j) => j.id === "placement-pin")!;
      expect(silencersOf(pinOf(after(PIN_HEAD, "    # continue-on-error: true\n    # if: false\n")))).toEqual([]);
      const stepIf = pinOf(after("      - name: Verify the pin against the placement repo\n", "        if: false\n"));
      expect(stepIf.text, "the fixture really put an `if:` on the step").toMatch(/^ {8}if: false$/m);
      expect(silencersOf(stepIf), "a step-level `if:` is the step pin's business, not the job check's").toEqual([]);
    });
  });

  // The readiness gate, EXECUTED with shims for `timeout` (the probe), `sleep` and `docker`. Its clauses are the ones a text match
  // cannot hold: that it GIVES UP (`exit 1`), after exactly the loop bound, and that it stops at the first success (`break`).
  describe("the wait step's script, executed", () => {
    const CONTAINER = "feedbeef-service-container-id";
    const BOUND = 15; // the loop the pre-split placement CI workflow ran: `seq 1 15`, one second apart, the figure its own message gives
    const SHIMS = shimDir({
      // Succeeds on the TIMEOUT_OK_ON-th probe and never before; unset means never.
      timeout: [
        "#!/bin/sh",
        'echo "timeout $*" >> "$CALL_LOG"',
        'n=$(grep -c "^timeout " "$CALL_LOG")',
        '[ -n "${TIMEOUT_OK_ON:-}" ] && [ "$n" -eq "$TIMEOUT_OK_ON" ] && exit 0',
        "exit 1",
        "",
      ].join("\n"),
      sleep: '#!/bin/sh\necho "sleep $*" >> "$CALL_LOG"\nexit 0\n',
      docker: '#!/bin/sh\necho "docker $*" >> "$CALL_LOG"\nexit 0\n',
    });
    function wait(okOn?: number) {
      const body = runBody(stepNamed(LIVE(), "Wait for the placement service"));
      const log = fresh("wait.log");
      const r = spawnSync("bash", ["-e", "-c", body], {
        cwd: SCRATCH,
        encoding: "utf8",
        env: envWith({ PATH: `${SHIMS}:${process.env.PATH ?? ""}`, CALL_LOG: log, PLACEMENT_CONTAINER: CONTAINER, ...(okOn === undefined ? {} : { TIMEOUT_OK_ON: String(okOn) }) }),
      });
      expect(r.error).toBeUndefined();
      const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      const out = r.stdout + r.stderr;
      return {
        code: r.status,
        probes: calls.filter((c) => c.startsWith("timeout ")),
        sleeps: calls.filter((c) => c.startsWith("sleep ")),
        docker: calls.filter((c) => c.startsWith("docker ")),
        errors: out.split("\n").filter((l) => l.startsWith("::error::")),
      };
    }

    it("a service that never answers: exactly the loop bound of probes, then ::error:: and the service's logs, and exit 1", () => {
      const out = wait();
      expect(out.code, "gives up: the step must FAIL").toBe(1);
      expect(out.probes.length, "probes made").toBe(BOUND);
      expect(out.probes.every((c) => c.includes("/dev/tcp/127.0.0.1/50051")), "each probe is a TCP open to the service port").toBe(true);
      expect(out.sleeps, "a one-second wait after each failed probe").toEqual(Array(BOUND).fill("sleep 1"));
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0]).toMatch(new RegExp(`50051.*${String(BOUND)}s`));
      expect(out.docker, "the logs of the container the runner gave the service").toEqual([`docker logs ${CONTAINER}`]);
    });

    it("a service that answers on the 3rd probe: stops there (no further probe or wait), prints nothing red, reads no logs", () => {
      const out = wait(3);
      expect(out.code).toBe(0);
      expect(out.probes.length, "probes made").toBe(3);
      expect(out.sleeps, "waits between the failed probes only").toHaveLength(2);
      expect(out.errors).toEqual([]);
      expect(out.docker).toEqual([]);
    });

    it("a service that answers on the last probe is still ready (the bound is inclusive)", () => {
      const out = wait(BOUND);
      expect(out.code).toBe(0);
      expect(out.probes.length).toBe(BOUND);
      expect(out.errors).toEqual([]);
    });

    it("a service that answers at once: one probe and no wait", () => {
      const out = wait(1);
      expect(out).toMatchObject({ code: 0, errors: [], docker: [], sleeps: [] });
      expect(out.probes.length).toBe(1);
    });
  });

  it("the suite step never fails the job by itself (the judge does), and keeps its id, working directory and env", () => {
    const suite = stepNamed(LIVE(), "Run the integration suite against the live service");
    // `continue-on-error` is what lets the judge run after a red vitest and print the container's logs; without it a red
    // suite ends the job before the judge speaks. The judge, not vitest's exit code, is the gate.
    expect(suite.text).toMatch(/^ {8}continue-on-error: true\s*$/m);
    expect(suite.keys).toEqual(["name", "id", "continue-on-error", "working-directory", "env", "run"]);
    expect(suite.text).toMatch(/^ {8}working-directory: packages\/scheduler\s*$/m);
    const names = stepsOf(LIVE()).map((x) => x.name);
    expect(names.indexOf("Assert the suite RAN, and passed"), "the judge comes after the suite").toBe(names.indexOf("Run the integration suite against the live service") + 1);
  });
});
