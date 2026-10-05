// W1d Task 8 (D1b; ruling 60: "a missed week must still be visible"): the non-blocking PR annotation. The expected
// dates and day counts are written out by hand from the calendar (2026-10-04 is NOW; 9 days before it is 2026-09-25), never
// derived from staleness() or from the constant it compares with.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhFailed, REPO_SHAPE, RUN_PROJECTION, WEEKLY_EVENTS, downloadMerged, realGh, successfulRuns, weeklySuccesses, type GhRunner } from "../ci/gh.ts";
import { commandData, main, staleness, type StalenessDeps } from "../ci/staleness.ts";
import { findSecrets } from "../lib/redact.ts";
import { SPAWN_MS, SpawnMeter } from "./spawn-budget.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

const NOW = new Date("2026-10-04T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const run = (event: string, daysAgo: number, conclusion = "success") => ({ conclusion, event, created_at: ago(daysAgo) });

// W1d T8->T9 (f): the RUN_PROJECTION test runs a real `jq`, which is on every GitHub-hosted runner and not on every desk. A
// missing jq must not red a developer's local run for an environment reason — and must never turn the ONLY witness of the
// projection into a silent pass. So the skip is by NAME (vitest reports it as pending) and LOUD (a warning that says
// what was skipped), and it is allowed only off CI: where CI is set, the test runs, and a missing jq reds it as the
// environment fault it is.
const HAS_JQ = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;
const SKIP_JQ = !HAS_JQ && process.env.CI === undefined;
if (SKIP_JQ) process.stderr.write("staleness.test: jq is not installed and CI is unset — SKIPPING 1 test (the real-jq RUN_PROJECTION test); CI runs it\n");

describe("staleness (D1b): the newest SUCCESSFUL scheduled/dispatched run against --max-days", () => {
  it("empty case first: no run at all is stale, and says `never`", () => {
    const s = staleness([], NOW, 8);
    expect(s.stale).toBe(true);
    expect(s.newest).toBeNull();
    expect(s.message).toMatch(/never/);
  });

  it("no successful schedule/dispatch run ever -> stale with `never`, whatever else the list holds", () => {
    const others = [run("pull_request", 1), run("push", 1), run("schedule", 1, "failure"), run("workflow_dispatch", 2, "cancelled"), run("schedule", 3, "")];
    const s = staleness(others, NOW, 8);
    expect(s.stale).toBe(true);
    expect(s.newest).toBeNull();
    expect(s.message).toMatch(/never/);
    expect(others).toHaveLength(5); // anti-vacuity: the list was not empty
  });

  it("the newest success 9 days ago -> stale, naming the date (2026-09-25) and the days", () => {
    const s = staleness([run("schedule", 9)], NOW, 8);
    expect(s.stale).toBe(true);
    expect(s.newest).toBe("2026-09-25T12:00:00.000Z");
    expect(s.message).toContain("2026-09-25");
    expect(s.message).toContain("9 days ago");
    expect(s.message).toContain("limit is 8");
    expect(s.message).not.toMatch(/never/);
  });

  it("7 days -> not stale, and the message is `last success <date>`", () => {
    const s = staleness([run("schedule", 7)], NOW, 8);
    expect(s.stale).toBe(false);
    expect(s.newest).toBe("2026-09-27T12:00:00.000Z");
    expect(s.message).toBe("last success 2026-09-27");
  });

  it("the boundary: exactly 8 days is not yet overdue, one millisecond past it is", () => {
    expect(staleness([{ conclusion: "success", event: "schedule", created_at: new Date(NOW.getTime() - 8 * DAY).toISOString() }], NOW, 8).stale).toBe(false);
    expect(staleness([{ conclusion: "success", event: "schedule", created_at: new Date(NOW.getTime() - 8 * DAY - 1).toISOString() }], NOW, 8).stale).toBe(true);
    // The limit is the parameter's: the same 9-day-old run is fine under 10, and stale under 8.
    expect(staleness([run("schedule", 9)], NOW, 10).stale).toBe(false);
    expect(staleness([run("schedule", 9)], NOW, 8).stale).toBe(true);
  });

  it("a dispatch counts as much as a schedule", () => {
    expect(WEEKLY_EVENTS).toEqual(["schedule", "workflow_dispatch"]);
    expect(staleness([run("workflow_dispatch", 2)], NOW, 8)).toMatchObject({ stale: false, message: "last success 2026-10-02" });
    expect(staleness([run("schedule", 2)], NOW, 8)).toMatchObject({ stale: false });
  });

  it("a successful pull_request run does not count (smoke scope is not the weekly run)", () => {
    // A fresh PR success beside a stale weekly success: still stale, and the newest is the weekly one.
    const s = staleness([run("pull_request", 0), run("schedule", 9)], NOW, 8);
    expect(s.stale).toBe(true);
    expect(s.newest).toBe(ago(9));
    // …and a PR success alone is no weekly run at all.
    expect(staleness([run("pull_request", 0)], NOW, 8).newest).toBeNull();
  });

  it("a failed run newer than the last success does not reset the clock", () => {
    const s = staleness([run("schedule", 1, "failure"), run("workflow_dispatch", 2, "cancelled"), run("schedule", 9)], NOW, 8);
    expect(s.stale).toBe(true);
    expect(s.newest).toBe(ago(9));
    expect(s.message).toContain("9 days ago");
  });

  it("the newest of several is the one judged, whatever order the list comes in", () => {
    const list = [run("schedule", 20), run("schedule", 3), run("workflow_dispatch", 12)];
    for (const order of [list, [...list].reverse(), [list[1], list[0], list[2]]]) {
      expect(staleness(order, NOW, 8)).toMatchObject({ stale: false, newest: ago(3) });
    }
  });

  it("a created_at that is no date counts for nothing; a run dated in the future (clock skew) is not stale", () => {
    expect(staleness([{ conclusion: "success", event: "schedule", created_at: "garbage" }], NOW, 8).newest).toBeNull();
    expect(staleness([{ conclusion: "success", event: "schedule", created_at: "garbage" }, run("schedule", 3)], NOW, 8).newest).toBe(ago(3));
    expect(staleness([run("schedule", -1)], NOW, 8).stale).toBe(false);
  });

  it("weeklySuccesses (the filter summary.ts shares) keeps only success runs of the two events, newest first", () => {
    const rows = [run("schedule", 5), run("pull_request", 1), run("schedule", 1, "failure"), run("workflow_dispatch", 2), run("push", 0)];
    const kept = weeklySuccesses(rows);
    expect(kept.map((r) => r.event)).toEqual(["workflow_dispatch", "schedule"]);
    expect(kept).toHaveLength(2);
  });
});

describe("commandData: a workflow command's data is escaped as the runner reads it back", () => {
  it("escapes %, CR and LF, in that order of safety (a % is escaped once, not twice)", () => {
    expect(commandData("a%b\r\nc")).toBe("a%25b%0D%0Ac");
    expect(commandData("100%\n")).toBe("100%25%0A");
    expect(commandData("plain")).toBe("plain");
  });
});

/** A gh that answers like the workflow-runs endpoint: only the runs of the `event=` the URL names (GitHub filters on the server,
 *  and the code under test asks for each weekly event separately), all of them when it names none. It records every call.
 *  It does not run the `--jq` projection: the projection has its own test, through a real jq. */
function fakeGh(runs: unknown[]): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args) => {
      calls.push([...args]);
      const event = new URL(`https://api.example.test/${args[1] ?? ""}`).searchParams.get("event");
      const rows = event === null ? runs : runs.filter((r) => (r as { event: string }).event === event);
      return { status: 0, stdout: JSON.stringify({ total_count: rows.length, workflow_runs: rows }), stderr: "" };
    },
  };
}
const RUNS_URL = (event: string): string => `repos/acme/seazn/actions/workflows/matrix-truth.yml/runs?event=${event}&status=success&per_page=10`;
const wire = (event: string, daysAgo: number, conclusion: string | null = "success", id = 1) => ({ id, event, conclusion, created_at: ago(daysAgo), name: "extra field GitHub adds" });

describe("main (the CLI): one line, exit 0 whatever GitHub says; exit 2 only for usage", () => {
  const io = { out: "", err: "" };
  beforeEach(() => {
    io.out = ""; io.err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { io.out += String(s); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { io.err += String(s); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const deps = (gh: GhRunner, env: Record<string, string | undefined> = { GITHUB_REPOSITORY: "acme/seazn" }): StalenessDeps => ({ gh, env, now: () => NOW });

  it("a fresh weekly run prints the plain line, no warning, exit 0 — and asks for the workflow's successful runs", () => {
    const { gh, calls } = fakeGh([wire("schedule", 6)]);
    expect(main(["--max-days", "8"], deps(gh))).toBe(0);
    expect(io.out).toBe("matrix truth run: last success 2026-09-28\n");
    expect(io.out).not.toContain("::warning");
    expect(calls).toEqual([["api", RUNS_URL("schedule"), "--jq", RUN_PROJECTION], ["api", RUNS_URL("workflow_dispatch"), "--jq", RUN_PROJECTION]]);
  });

  it("a stale run prints the ::warning title line (and still exits 0: D1 never fails a PR)", () => {
    expect(main(["--max-days", "8"], deps(fakeGh([wire("schedule", 9)]).gh))).toBe(0);
    expect(io.out.startsWith("::warning title=Matrix truth run is stale::")).toBe(true);
    expect(io.out).toContain("2026-09-25");
    expect(io.out.split("\n").filter((l) => l !== "")).toHaveLength(1);
  });

  it("no run at all is the same warning, saying never", () => {
    expect(main(["--max-days", "8"], deps(fakeGh([]).gh))).toBe(0);
    expect(io.out).toMatch(/^::warning title=Matrix truth run is stale::.*never/);
  });

  it("only a PR success and a newer failure -> the weekly signal is still stale (end to end, through the wire shape)", () => {
    const { gh } = fakeGh([wire("pull_request", 0, "success", 5), wire("schedule", 1, "failure", 4), wire("schedule", 9, "success", 3)]);
    expect(main(["--max-days", "8"], deps(gh))).toBe(0);
    expect(io.out).toContain("title=Matrix truth run is stale");
    expect(io.out).toContain("2026-09-25");
  });

  it("a gh failure warns by name, redacts the reason, and exits 0 (an API failure warns rather than fails)", () => {
    const secret = `${"sk"}_live_${"ABCDEFGH12345678"}`;
    // gh echoes the token it was given when a call is refused; GITHUB_TOKEN is a ghs_. Assembled at run time (public repo).
    const ghToken = `${"gh"}s_${"Zm9vYmFyYmF6cXV4Q2hvb3NlQWJDZDEyMzQ1"}`;
    const gh: GhRunner = () => ({ status: 1, stdout: "", stderr: `HTTP 403: rate limit, token=${secret}\nHTTP 401 for ${ghToken}` });
    expect(main(["--max-days", "8"], deps(gh))).toBe(0);
    expect(io.out.startsWith("::warning::")).toBe(true);
    expect(io.out).toMatch(/could not be checked/);
    expect(io.out).toContain("HTTP 403");
    expect(io.out).not.toContain(secret);
    expect(io.out).not.toContain(ghToken);
    expect(io.out).not.toContain(ghToken.slice(4)); // nor the body alone
    expect(findSecrets(io.out)).toEqual([]);
    expect(io.out).not.toContain("title=Matrix truth run is stale"); // an unknown is not a staleness claim
  });

  it("an answer that is not JSON, or not a run list, warns and exits 0", () => {
    for (const stdout of ["<html>rate limited</html>", "{}", JSON.stringify({ workflow_runs: [{ id: "x" }] }), JSON.stringify({ workflow_runs: "nope" })]) {
      io.out = "";
      expect(main(["--max-days", "8"], deps(() => ({ status: 0, stdout, stderr: "" }))), stdout).toBe(0);
      expect(io.out, stdout).toMatch(/^::warning::.*could not be checked/);
    }
  });

  it("a missing or malformed GITHUB_REPOSITORY warns and exits 0 WITHOUT calling gh", () => {
    const calls: string[][] = [];
    const gh: GhRunner = (a) => { calls.push([...a]); return { status: 0, stdout: "{}", stderr: "" }; };
    for (const repo of [undefined, "", "noslash", "a/b/c", "../x", "a/..", "acme/seazn?x=1", "acme/seazn\n::error::x"]) {
      io.out = "";
      expect(main(["--max-days", "8"], deps(gh, { GITHUB_REPOSITORY: repo })), String(repo)).toBe(0);
      expect(io.out, String(repo)).toMatch(/^::warning::.*GITHUB_REPOSITORY/);
      // Each says its OWN reason: nothing set is not the same fault as a value that is no owner/name.
      expect(io.out, String(repo)).toMatch(repo === undefined || repo === "" ? /GITHUB_REPOSITORY: is not set/ : /GITHUB_REPOSITORY: is not owner\/name/);
      expect(io.out.split("\n").filter((l) => l !== ""), String(repo)).toHaveLength(1);
    }
    expect(calls).toEqual([]);
  });

  it("usage is exit 2, nothing on stdout, the usage on stderr: no --max-days, zero, negative, fractional, text, an unknown flag, a positional", () => {
    const gh = fakeGh([]).gh;
    const bad = [[], ["--max-days"], ["--max-days", "0"], ["--max-days", "-3"], ["--max-days", "1.5"], ["--max-days", "abc"], ["--max-days", "08"], ["--max-days", "8", "--bogus", "1"], ["--max-days", "8", "extra"]];
    for (const argv of bad) {
      io.out = ""; io.err = "";
      expect(main(argv, deps(gh)), argv.join(" ")).toBe(2);
      expect(io.out, argv.join(" ")).toBe("");
      expect(io.err, argv.join(" ")).toMatch(/usage: staleness\.ts/);
    }
    expect(bad).toHaveLength(9);
  });

  it("a bare `--` (pnpm 10 forwards one) is no argument", () => {
    expect(main(["--", "--max-days", "8"], deps(fakeGh([wire("schedule", 1)]).gh))).toBe(0);
    expect(io.out).toBe("matrix truth run: last success 2026-10-03\n");
  });

  it("the max-days it is given is the limit it judges by (8 vs 10 on a 9-day-old run)", () => {
    expect(main(["--max-days", "10"], deps(fakeGh([wire("schedule", 9)]).gh))).toBe(0);
    expect(io.out).toBe("matrix truth run: last success 2026-09-25\n");
  });
});

describe("gh.ts: the thin wrapper", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("realGh with no gh on the PATH is status 1 with the reason on stderr, never a throw and never network", () => {
    vi.stubEnv("PATH", "");
    const r = realGh(["--version"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/ENOENT|gh/);
  });

  it("realGh redacts what gh prints on stderr BEFORE a caller sees it (its own layer, apart from GhFailed's)", () => {
    // A fake `gh` that fails the way a real one does: the request echoed, a token in it. Synthetic, built at run time.
    const secret = `${"sk"}_live_${"ABCDEFGH12345678"}`;
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
    try {
      writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "HTTP 401: bad credentials, api_key=${secret}" >&2\nexit 1\n`);
      chmodSync(join(dir, "gh"), 0o755);
      vi.stubEnv("PATH", dir);
      const r = realGh(["api", "repos/acme/seazn"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("HTTP 401"); // the fake ran: this is its output, not a spawn fault
      expect(r.stderr).not.toContain(secret);
      expect(findSecrets(r.stderr)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("successfulRuns asks once per WEEKLY event — filtered by event and by success on the server, a small page, projected by --jq — and never for a pull_request run", () => {
    // Class: a flat per_page=100 answer is ~12 KB a run, and past ~85 runs it outgrew spawnSync's 1 MiB buffer and went dark.
    expect(WEEKLY_EVENTS).toEqual(["schedule", "workflow_dispatch"]);
    const { gh, calls } = fakeGh([wire("schedule", 1, null, 7), wire("pull_request", 0, "success", 8), wire("workflow_dispatch", 2, "success", 9)]);
    const out = successfulRuns(gh, "acme/seazn");
    expect(calls).toEqual([["api", RUNS_URL("schedule"), "--jq", RUN_PROJECTION], ["api", RUNS_URL("workflow_dispatch"), "--jq", RUN_PROJECTION]]);
    expect(calls.some((c) => c.join(" ").includes("pull_request"))).toBe(false);
    // The null conclusion maps to empty; the pull_request row the fake holds is never returned because it was never asked for.
    expect(out).toEqual([
      { id: 7, conclusion: "", event: "schedule", created_at: ago(1) },
      { id: 9, conclusion: "success", event: "workflow_dispatch", created_at: ago(2) },
    ]);
  });

  it("each weekly event is its own call: a run of only one event is found, and a failure of either call names its event", () => {
    // Drop either call and one of these reds: the newest success may be a schedule run or a manual dispatch.
    expect(staleness(successfulRuns(fakeGh([wire("workflow_dispatch", 2)]).gh, "acme/seazn"), NOW, 8).stale).toBe(false);
    expect(staleness(successfulRuns(fakeGh([wire("schedule", 2)]).gh, "acme/seazn"), NOW, 8).stale).toBe(false);
    for (const failing of WEEKLY_EVENTS) {
      const gh: GhRunner = (a) => (a[1].includes(`event=${failing}&`) ? { status: 1, stdout: "", stderr: "HTTP 502" } : { status: 0, stdout: '{"workflow_runs": []}', stderr: "" });
      let e: unknown;
      try { successfulRuns(gh, "acme/seazn"); } catch (x) { e = x; }
      expect(e, failing).toBeInstanceOf(GhFailed);
      expect((e as GhFailed).message, failing).toContain(`(${failing} runs)`);
    }
  });

  it("a run's re-run attempt rides through when the answer carries it, and is not required when it does not", () => {
    const withAttempt = { ...wire("schedule", 1, "success", 3), run_attempt: 2 };
    const { gh } = fakeGh([withAttempt, wire("workflow_dispatch", 2, "success", 4)]);
    expect(successfulRuns(gh, "acme/seazn")).toEqual([
      { id: 3, conclusion: "success", event: "schedule", created_at: ago(1), run_attempt: 2 },
      { id: 4, conclusion: "success", event: "workflow_dispatch", created_at: ago(2) },
    ]);
  });

  it.skipIf(SKIP_JQ)("RUN_PROJECTION, run by a real jq over a fat answer, keeps the envelope and exactly the five fields of each run", () => {
    const nested = { id: 1, node_id: "R_x", full_name: "acme/seazn", owner: { login: "acme", id: 2, url: "https://api.example.test/users/acme" }, html_url: "https://example.test/acme/seazn" };
    const fatRun = (id: number, event: string, attempt: number) => ({
      id, name: "Matrix truth", head_branch: "main", head_sha: "a".repeat(40), event, status: "completed", conclusion: "success", workflow_id: 5, run_number: id,
      run_attempt: attempt, created_at: ago(id), updated_at: ago(id), actor: nested, triggering_actor: nested, repository: nested, head_repository: nested, pull_requests: [],
    });
    const fat = { total_count: 2, workflow_runs: [fatRun(3, "schedule", 1), fatRun(4, "workflow_dispatch", 2)] };
    const r = spawnSync("jq", ["-c", RUN_PROJECTION], { input: JSON.stringify(fat), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { workflow_runs: Record<string, unknown>[] };
    expect(Object.keys(out)).toEqual(["workflow_runs"]);
    expect(out.workflow_runs).toEqual([
      { id: 3, conclusion: "success", event: "schedule", created_at: ago(3), run_attempt: 1 },
      { id: 4, conclusion: "success", event: "workflow_dispatch", created_at: ago(4), run_attempt: 2 },
    ]);
    expect(r.stdout.length).toBeLessThan(JSON.stringify(fat).length / 4);
    // …and the code that reads the projection takes it as it is.
    const gh: GhRunner = () => ({ status: 0, stdout: r.stdout, stderr: "" });
    expect(successfulRuns(gh, "acme/seazn").map((w) => w.id)).toEqual([3, 4, 3, 4]); // one answer per event call, the same fake both times
  });

  it("a REAL realGh returns an answer of more than 1 MiB whole (spawnSync's default buffer truncates it with ENOBUFS), and successfulRuns reads it through the real runner", () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-gh-big-"));
    try {
      const pad = "x".repeat(1_500_000);
      const answer = (event: string, id: number): string => JSON.stringify({ workflow_runs: [{ id, conclusion: "success", event, created_at: ago(2), run_attempt: 1, padding: pad }] });
      writeFileSync(join(dir, "schedule.json"), answer("schedule", 11));
      writeFileSync(join(dir, "dispatch.json"), answer("workflow_dispatch", 22));
      // `$2` is the URL (args are: api <url> --jq <projection>). Each event gets its own answer; anything else is a failure.
      writeFileSync(join(dir, "gh"), `#!/bin/sh\ncase "$2" in\n  *event=schedule\\&*) cat "${dir}/schedule.json" ;;\n  *event=workflow_dispatch\\&*) cat "${dir}/dispatch.json" ;;\n  *) echo "unexpected url: $2" >&2; exit 1 ;;\nesac\n`);
      chmodSync(join(dir, "gh"), 0o755);
      vi.stubEnv("PATH", `${dir}:/bin:/usr/bin`);
      const raw = realGh(["api", RUNS_URL("schedule"), "--jq", RUN_PROJECTION]);
      expect(raw.status, raw.stderr).toBe(0);
      expect(raw.stdout.length).toBeGreaterThan(1024 * 1024); // anti-vacuity: the fake really answered past the default buffer
      expect((JSON.parse(raw.stdout) as { workflow_runs: { id: number }[] }).workflow_runs[0].id).toBe(11);
      const runs = successfulRuns(realGh, "acme/seazn");
      expect(runs.map((w) => `${w.id}:${w.event}`).sort()).toEqual(["11:schedule", "22:workflow_dispatch"]);
      const s = staleness(runs, NOW, 8);
      expect(s).toMatchObject({ stale: false, message: "last success 2026-10-02" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("REPO_SHAPE takes owner/name only", () => {
    for (const ok of ["acme/seazn", "onryde/seazn.club", "a-b/c_d"]) expect(REPO_SHAPE.test(ok), ok).toBe(true);
    for (const no of ["", "a", "a/b/c", "a b/c", "a/b\n", "a/b?x"]) expect(REPO_SHAPE.test(no), JSON.stringify(no)).toBe(false);
  });

  it("downloadMerged names the run, the artifact, the target and the repo; a failure is a GhFailed with the redacted reason", () => {
    const calls: string[][] = [];
    const ok: GhRunner = (a) => { calls.push([...a]); return { status: 0, stdout: "", stderr: "" }; };
    downloadMerged(ok, "acme/seazn", 4242, "/tmp/prev");
    expect(calls).toEqual([["run", "download", "4242", "-n", "merged", "-D", "/tmp/prev", "--repo", "acme/seazn"]]);
    const secret = `${"sk"}_live_${"ABCDEFGH12345678"}`;
    const bad: GhRunner = () => ({ status: 1, stdout: "", stderr: `no artifact\nname=merged api_key=${secret}` });
    let e: unknown;
    try { downloadMerged(bad, "acme/seazn", 4242, "/tmp/prev"); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(GhFailed);
    expect((e as GhFailed).message).toContain("gh run download 4242");
    expect((e as GhFailed).message).not.toContain(secret);
    expect((e as GhFailed).message).not.toContain("\n");
  });

  it("a GhFailed message is one short line even for a huge, multi-line stderr", () => {
    const e = new GhFailed("gh api", `${"x".repeat(2000)}\n${"y".repeat(100)}`);
    expect(e.message.length).toBeLessThan(330);
    expect(e.message).not.toContain("\n");
  });
});

describe("staleness.ts as its package script, a real process", () => {
  const meter = new SpawnMeter(2);
  beforeEach(() => meter.reset());
  const spawn = (extra: readonly string[], env: Record<string, string>) => {
    meter.tick();
    const words = (scripts["matrix:staleness"] ?? "").split(" ");
    expect(words[0]).toBe("node");
    // PATH empty: no gh to find, so the real process takes its API-failure path and never reaches the network.
    return spawnSync(process.execPath, [...words.slice(1), ...extra], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: "", ...env } });
  };

  it("with no gh it still exits 0 and warns on stdout, naming what failed (D1 is non-blocking)", { timeout: meter.budget }, () => {
    const r = spawn(["--max-days", "8"], { GITHUB_REPOSITORY: "acme/seazn" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^::warning::matrix truth staleness could not be checked/);
    expect(r.stdout.split("\n").filter((l) => l !== "")).toHaveLength(1);
  });

  it("a usage error is exit 2 through the script, with nothing on stdout", { timeout: meter.budget }, () => {
    const r = spawn([], { GITHUB_REPOSITORY: "acme/seazn" });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/usage: staleness\.ts/);
  });
});
