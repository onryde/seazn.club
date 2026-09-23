// Guards the `--exclude` passthrough in check-vitest-collection.ts.
//
// ci.yml splits src/server + src/lib across smoke-db and smoke-db-usecases by
// excluding complementary halves of src/server/usecases/__tests__. Each job then
// reconciles its OWN half, which only works if the reconciliation narrows the
// `vitest list` oracle by the same glob the run was narrowed by. Without the
// passthrough every file the other job owns is reported as "listed but not run",
// so a correct run goes red — and a gate that reds on correct runs gets deleted
// rather than fixed. These tests are what stop the passthrough being dropped as
// an unused-looking flag.
//
// Exercises the real script against a real path (src/server/public-site) rather
// than injecting a fake listing: a seam bypassing `vitest list` would leave
// the production path — the one that shells out — untested, and a list on this
// path costs ~0.6s, so there is nothing to buy.
//
// The partition itself (exhaustive, disjoint) is guarded separately by
// smoke-db-shard-partition.test.ts. This file only proves the flag is wired.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from THIS FILE, not cwd: a cwd-relative root reads whichever checkout
// the runner happens to sit in, which in a worktree is a different tree.
const REPO_ROOT = join(import.meta.dirname, "../..");
const SCRIPT = "scripts/check-vitest-collection.ts";

// The files `vitest list --filesOnly src/server/public-site` selects, and the
// one a `c*` glob removes. Named explicitly so that adding or removing a file
// in that directory fails loudly rather than quietly changing what is proven.
// Spectator W2 made this a LIST rather than a single file: the wave added four
// test files to that directory whose names begin with "c", so the `c*` glob now
// removes five, not one. The name is kept plural-agnostic on purpose — what the
// gate proves is the arithmetic between listing and execution, and that only
// holds if this set really is everything `c*` matches.
const C_GLOBBED = [
  "src/server/public-site/__tests__/champion.test.ts",
  "src/server/public-site/__tests__/competition-hub-db.test.ts",
  "src/server/public-site/__tests__/competition-hub-field-filter.test.ts",
  "src/server/public-site/__tests__/competition-hub-schema.test.ts",
  "src/server/public-site/__tests__/competition-hub.test.ts",
  "src/server/public-site/__tests__/consent.test.ts",
];
const CONSENT = C_GLOBBED[C_GLOBBED.length - 1]!;
const REST = [
  // P9: added with the public court/venue-name coverage. This list is
  // deliberately explicit so a new file in that directory fails HERE rather
  // than quietly changing what the gate proves — which is exactly what
  // happened, and is the list working.
  "src/server/public-site/__tests__/data-court-venue-names.test.ts",
  "src/server/public-site/__tests__/pass-scope-public-realtime.test.ts",
  "src/server/public-site/__tests__/player-stats-public.test.ts",
  "src/server/public-site/__tests__/revalidate.test.ts",
  // Spectator W1: the match-centre document and the two panels folded from the
  // ledger. Same story as P9 — this gate reddened the moment they landed, which
  // is the explicit list doing its job.
  "src/server/public-site/__tests__/match-centre.test.ts",
  "src/server/public-site/__tests__/match-centre-dictionary.test.ts",
  "src/server/public-site/__tests__/match-centre-parity.test.ts",
  "src/server/public-site/__tests__/public-lineups.test.ts",
  "src/server/public-site/__tests__/timeline.test.ts",
  // Spectator W2: the hub document, its schema, the pure ladders' consumers,
  // the standings view, the leader boards and the standings timestamp fix.
  // The four "c*" files this wave added live in C_GLOBBED above, not here —
  // the glob removes them from the listing, so counting them twice would make
  // the narrowed and unnarrowed numbers disagree with what the script prints.
  "src/server/public-site/__tests__/data-standings-timestamp.test.ts",
  "src/server/public-site/__tests__/describe-format.test.ts",
  // PR 2 of the four-PR split: the W2 dictionary coverage test. It does not
  // begin with "c", so it belongs here rather than in C_GLOBBED — and this
  // gate reddened in CI the moment it landed, which is the explicit list
  // doing exactly what the comments above promise.
  "src/server/public-site/__tests__/hub-dictionary.test.ts",
  "src/server/public-site/__tests__/leaders.test.ts",
  "src/server/public-site/__tests__/public-leaders.test.ts",
  "src/server/public-site/__tests__/standings-view.test.ts",
  // Stream overlay W1: the venue zone `getPublicFixture` now returns, which the
  // overlay's start label is formatted in. Does not begin with "c", so it
  // belongs here — and this gate reddened in CI the moment it landed, third
  // wave running, which is the explicit list doing what its comments promise.
  "src/server/public-site/__tests__/public-fixture-venue-tz.test.ts",
  // Spectator poster/division branch: the match-centre feeder label and its
  // loader read, the message params, the start time, and the public fixture's
  // format label. None begins with "c", so all five belong here rather than in
  // C_GLOBBED — and this gate reddened in CI the moment they landed, fourth
  // wave running, which is the explicit list doing what its comments promise.
  "src/server/public-site/__tests__/match-centre-feeder-label.test.ts",
  "src/server/public-site/__tests__/match-centre-load-feeder-read.test.ts",
  "src/server/public-site/__tests__/match-centre-msg-params.test.ts",
  "src/server/public-site/__tests__/match-centre-start-time.test.ts",
  "src/server/public-site/__tests__/public-fixture-format-label.test.ts",
  // W2 final review wave (stats refresh, cricket margin, privacy hotfix, the
  // scoring SCAN->DEL cleanup): none begin with "c", so all nine belong here
  // rather than in C_GLOBBED. This gate reddened the moment they landed,
  // fifth wave running, which is the explicit list doing its job again.
  "src/server/public-site/__tests__/division-doc-cache-keys.test.ts",
  "src/server/public-site/__tests__/fixture-doc-cache-keys.test.ts",
  "src/server/public-site/__tests__/match-centre-margin.test.ts",
  "src/server/public-site/__tests__/org-home-live-db.test.ts",
  "src/server/public-site/__tests__/player-card-policy-db.test.ts",
  "src/server/public-site/__tests__/player-matches-cache-keys.test.ts",
  "src/server/public-site/__tests__/public-player-matches.test.ts",
  "src/server/public-site/__tests__/variant-label.test.ts",
  "src/server/public-site/__tests__/youth-name-policy-db.test.ts",
  // Swiss withdrawal walkthrough (V412 — the public view now publishes a
  // departed entrant so the standings can still NAME her). Two files landed:
  // `competition-hub-field-filter` begins with "c" and is in C_GLOBBED above,
  // this one does not and belongs here. Sixth wave running, and the gate
  // reddened in CI the moment they landed — note it reds only HERE, in the
  // repo-root scripts suite, which a green `cd apps/web && vitest` cannot see.
  "src/server/public-site/__tests__/public-entrants-departed.test.ts",
  // Draw feeder labels: the namer's feed map is scoped per stage, so a
  // cross-stage edge cannot name a public seat after its own stage's
  // coordinates. Begins with "p", so it belongs here rather than in
  // C_GLOBBED. Seventh wave running — and it reddened this gate on the
  // wave's own full run, which is the list doing what its comments promise.
  "src/server/public-site/__tests__/public-round-namer-cross-stage-feed.test.ts",
  // Standings popovers + qualification status (PR #849): the Pts-ratio note
  // and the qualification builder, its pool helper and their DB suites. None
  // begin with "c", so all five belong here. Eighth wave running.
  "src/server/public-site/__tests__/division-qualification.test.ts",
  "src/server/public-site/__tests__/public-stages-qualification-db.test.ts",
  "src/server/public-site/__tests__/qualification-view-db.test.ts",
  "src/server/public-site/__tests__/qualification-view.test.ts",
  "src/server/public-site/__tests__/standings-ratio-note.test.ts",
];
const EXCLUDE_C = "**/public-site/__tests__/c*";

// Derived from REST, never typed twice. The counts are not what this file
// proves — the `excluding` line, the two drift reports and the exit status are —
// but a hand-copied literal beside a list that grows means every new file in
// that directory reds this gate TWICE: once at the list (intended) and once at
// a number that has no independent meaning (pure toil). The addend is
// `C_GLOBBED.length` — every file `c*` removes from the listing, which was one
// until Spectator W2 added four more.
const NARROWED = `listed=${REST.length} executed=${REST.length}`;
const UNNARROWED = `listed=${REST.length + C_GLOBBED.length} executed=${REST.length}`;

const dir = mkdtempSync(join(tmpdir(), "collection-exclude-test-"));

/** A minimal vitest JSON reporter payload naming exactly these files. */
const resultsFile = (label: string, files: string[]): string => {
  const p = join(dir, `${label}.json`);
  writeFileSync(p, JSON.stringify({ testResults: files.map((name) => ({ name })) }));
  return p;
};

const run = (args: string[]): { status: number; output: string } => {
  try {
    const output = execFileSync("node", ["--experimental-strip-types", SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

describe("check-vitest-collection --exclude", () => {
  it("narrows the listing so a partial run reconciles clean", () => {
    const results = resultsFile("narrowed", REST);
    const { status, output } = run([
      "--results", results, "--exclude", EXCLUDE_C, "--", "src/server/public-site",
    ]);
    expect(output).toContain(NARROWED);
    expect(output).toContain(`excluding ${EXCLUDE_C}`);
    expect(status).toBe(0);
  });

  it("without the flag, that SAME run is a failure — so the flag is load-bearing", () => {
    // The negative control. If this ever passes, the passthrough has stopped
    // mattering and the two-job split is no longer being reconciled per half.
    const results = resultsFile("unnarrowed", REST);
    const { status, output } = run(["--results", results, "--", "src/server/public-site"]);
    expect(output).toContain(UNNARROWED);
    // One per file the `c*` glob removes from the listing — five since
    // Spectator W2, one before it. Derived, so the next file added to that
    // directory moves the list and this number together.
    expect(output).toContain(`LISTED BUT NOT RUN (${C_GLOBBED.length})`);
    expect(output).toContain(CONSENT);
    expect(status).toBe(1);
  });

  it("still catches a file that ran but was excluded from the listing", () => {
    // The gate must stay two-sided. Excluding a file from the listing while the
    // run executed it anyway is the mirror-image drift — the globs said one half
    // and the run did something else — and must not read as clean.
    const results = resultsFile("over-ran", [CONSENT, ...REST]);
    const { status, output } = run([
      "--results", results, "--exclude", EXCLUDE_C, "--", "src/server/public-site",
    ]);
    expect(output).toContain("RAN BUT NOT LISTED (1)");
    expect(output).toContain(CONSENT);
    expect(status).toBe(1);
  });

  it("ignores an empty --exclude instead of forwarding it", () => {
    // An unset shell variable reaches the script as `--exclude ''`. Forwarded,
    // that matches nothing and silently widens the listing back to the full set
    // while the command line still LOOKS narrowed — the same green-for-the-wrong-
    // reason this whole file exists to prevent. Dropped, the caller gets the
    // honest unnarrowed failure below.
    const results = resultsFile("empty-glob", REST);
    const { status, output } = run([
      "--results", results, "--exclude", "", "--", "src/server/public-site",
    ]);
    expect(output).toContain(UNNARROWED);
    expect(output).not.toContain("excluding");
    expect(status).toBe(1);
  });
});
