// Seazn-hosted video Task 24: the replay move's pure decisions — the transition table (`nextReplayStep`), the backoff a
// failure earns (`replayFailure`), the Cloudflare delete gate (`cfDeleteGate`), the copy check (`verifyReplayCopy`, the owner's
// "clean and good": recommendation 2026-11-21 G-C) and what one poll of the host means (`pollOutcome`).
//
// Every expected value is the plan's or the recommendation's literal, typed here (TEST-STRATEGY: never derive an expected value
// from the code under test): 30 min stale fetch, 15 min poll backstop, 60 min after verification, min(2^attempts, 60) minutes of
// backoff, a 30-day retry window, ±2 s, the 240/360/480/720/1080 rungs (1080 added by Task 48; the programme profile's own height is read from relay config). No DB and no network: this file needs neither.
import { describe, expect, it } from "vitest";
import { relayOutputProfile } from "@/server/relay/config";
import {
  type LiveMeasure, REPLAY_PARKED_AT, REPLAY_ROW_STATES, type ReplayRow, type ReplayStep, cfDeleteGate, liveMeasureGate, nextReplayStep,
  parseReplayCopyTitle, pollOutcome, replayCopyTitle, replayFailure, replayFailureOutcome, requiredRung, verifyReplayCopy,
} from "../replay-move";

const MIN = 60_000;
const NOW = new Date("2026-11-22T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);
/** SEAZN_HOSTED_COST off: the daily pass measures nothing, so the Cloudflare delete never waits for a measure (I1). Every case before
 *  the I1 block runs with it, so G-D's 60 min is the only gate they meet. */
const OFF: LiveMeasure = { measured: false };

function row(over: Partial<ReplayRow> = {}): ReplayRow {
  return {
    state: "found", stateAt: ago(MIN), recordedAt: ago(60 * MIN), bunnyVideoId: null, verifiedAt: null, cfDeletedAt: null,
    bunnyCleanedAt: null, deletedAt: null, cfDurationSeconds: 3600, cfHeight: 1080, attempts: 0, ...over,
  };
}

describe("nextReplayStep — the transition table, swept over every state", () => {
  // [name, row, expected step]. Each state has at least one row; the sweep counts them and every state must be reached.
  const CASES: [string, ReplayRow, ReplayStep][] = [
    ["found → create the download", row({ state: "found" }), { kind: "create_download" }],
    ["downloading → ask for the download again (until ready)", row({ state: "downloading" }), { kind: "create_download" }],
    ["fetching, no guid, 29 min old → wait for the stale mark (30 min after state_at)", row({ state: "fetching", stateAt: ago(29 * MIN) }), { kind: "wait", until: later(1 * MIN) }],
    ["fetching, no guid, exactly 30 min old → refetch", row({ state: "fetching", stateAt: ago(30 * MIN) }), { kind: "refetch" }],
    ["fetching, no guid, 31 min old → refetch", row({ state: "fetching", stateAt: ago(31 * MIN) }), { kind: "refetch" }],
    ["fetching WITH a guid → refused by name (the guid is written only with the move to encoding)", row({ state: "fetching", bunnyVideoId: "g1" }), { kind: "refuse", reason: "fetching_holds_video" }],
    ["encoding → poll the host", row({ state: "encoding", bunnyVideoId: "g1" }), { kind: "poll_state" }],
    ["playable, verified 59 min ago → wait for verified + 60 min, never delete_cf", row({ state: "playable", bunnyVideoId: "g1", verifiedAt: ago(59 * MIN) }), { kind: "wait", until: later(1 * MIN) }],
    ["playable, verified exactly 60 min ago → delete_cf", row({ state: "playable", bunnyVideoId: "g1", verifiedAt: ago(60 * MIN) }), { kind: "delete_cf" }],
    ["playable, Cloudflare copy deleted → settled", row({ state: "playable", bunnyVideoId: "g1", verifiedAt: ago(90 * MIN), cfDeletedAt: ago(20 * MIN) }), { kind: "settled" }],
    ["playable with NO verified_at (V542's CHECK forbids it) → refused by name, never a delete", row({ state: "playable", bunnyVideoId: "g1" }), { kind: "refuse", reason: "playable_unverified" }],
    ["failed, recorded 29 days ago → retry from found", row({ state: "failed", recordedAt: ago(29 * 24 * 60 * MIN) }), { kind: "retry" }],
    ["failed, recorded exactly 30 days ago → give up (the Cloudflare copy's own life is over)", row({ state: "failed", recordedAt: ago(30 * 24 * 60 * MIN) }), { kind: "give_up" }],
    ["deleted, verified 70 min ago, Cloudflare copy still there → cleanup, deleting it", row({ state: "deleted", bunnyVideoId: "g1", verifiedAt: ago(70 * MIN) }), { kind: "cleanup", cf: "delete" }],
    ["deleted, verified 10 min ago → cleanup now, the Cloudflare delete waits for verified + 60 min", row({ state: "deleted", bunnyVideoId: "g1", verifiedAt: ago(10 * MIN) }), { kind: "cleanup", cf: "wait", until: later(50 * MIN) }],
    ["deleted, never verified → cleanup the host side only; the Cloudflare copy is never deleted from here", row({ state: "deleted", bunnyVideoId: "g1" }), { kind: "cleanup", cf: "skip" }],
    ["deleted, Cloudflare copy already gone → cleanup the host side only", row({ state: "deleted", verifiedAt: ago(90 * MIN), cfDeletedAt: ago(5 * MIN) }), { kind: "cleanup", cf: "skip" }],
    ["deleted and cleaned → settled", row({ state: "deleted", bunnyCleanedAt: ago(MIN) }), { kind: "settled" }],
  ];

  it("each row's step is the table's; every state is reached; the sweep counted what it checked", () => {
    let checked = 0;
    const reached = new Set<string>();
    for (const [name, r, expected] of CASES) {
      expect(nextReplayStep(r, NOW, OFF), name).toEqual(expected);
      reached.add(r.state);
      checked++;
    }
    expect(checked, "rows checked").toBe(CASES.length);
    expect(checked).toBeGreaterThan(0);
    expect([...reached].sort(), "every state the schema holds is in the sweep").toEqual([...REPLAY_ROW_STATES].sort());
    expect(REPLAY_ROW_STATES, "the schema's list, typed from V542").toEqual(["found", "downloading", "fetching", "encoding", "playable", "failed", "deleted"]);
  });

  it("an unknown state (a row read from a database that grew a state) is refused by name, never guessed", () => {
    expect(nextReplayStep(row({ state: "verifying" as ReplayRow["state"] }), NOW, OFF)).toEqual({ kind: "refuse", reason: "unknown_state" });
  });
});

describe("replayFailure — every state × a provider that throws gives the same backoff: attempts + 1, next = now + min(2^attempts, 60) min", () => {
  it("the backoff ladder (the plan's figures): 1, 2, 4, 8, 16, 32, 60, 60 minutes", () => {
    const ladder = [1, 2, 4, 8, 16, 32, 60, 60];
    let checked = 0;
    ladder.forEach((minutes, attempts) => {
      expect(replayFailure({ attempts }, NOW), `attempts ${attempts}`).toEqual({ attempts: attempts + 1, nextAttemptAt: later(minutes * MIN) });
      checked++;
    });
    expect(checked).toBe(8);
  });

  // Review I2 (2026-11-22): the window `failed` has is every state's. A step that keeps failing in any other state — a broken
  // recording's download answering `error`, a Cloudflare 404 after its own 30-day deletion, a host refusing the fetch — used to
  // back off for ever. The expected outcomes are the ruling's, typed: inside 30 days from the recording, the state stays and only
  // the clock moves; from 30 days, the row is parked (never due again) — the move's own states as `failed`, while a playable row
  // keeps `playable` (its verified copy is never hidden) and a deleted one keeps `deleted` (an organiser's delete is never undone).
  it("replayFailureOutcome, swept over every state: inside the 30-day window the state stays and the backoff applies; from 30 days the row is parked — as failed, except playable and deleted, which keep their state", () => {
    const DAY = 24 * 60 * MIN;
    const PARKED = new Date("9999-12-31T00:00:00.000Z");
    const PARKED_AS: Record<string, string> = {
      found: "failed", downloading: "failed", fetching: "failed", encoding: "failed", failed: "failed", playable: "playable", deleted: "deleted",
    };
    // Each state's window opens at its own anchor (re-review N1): a deleted row's at its delete, every other state's at the
    // recording. The sweep puts both at the same instant, so each state is measured from the anchor it reads.
    const at = (state: string, ms: number) => ({ recordedAt: ago(ms), ...(state === "deleted" ? { deletedAt: ago(ms) } : {}) });
    let checked = 0;
    for (const state of REPLAY_ROW_STATES) {
      const inside = replayFailureOutcome(row({ state, attempts: 3, ...at(state, 30 * DAY - 1) }), NOW);
      expect(inside, `${state}, 1 ms inside the window`).toEqual({ kind: "backoff", state, attempts: 4, nextAttemptAt: later(8 * MIN) });
      const past = replayFailureOutcome(row({ state, attempts: 3, ...at(state, 30 * DAY) }), NOW);
      expect(past, `${state}, exactly 30 days`).toEqual({ kind: "give_up", state: PARKED_AS[state], attempts: 4, nextAttemptAt: PARKED });
      checked += 2;
    }
    expect(checked, "states × {inside, past}").toBe(14);
    expect(Object.keys(PARKED_AS).sort(), "PREMISE: the table names every state").toEqual([...REPLAY_ROW_STATES].sort());
    // The window is the one `failed`'s step reads: the same instant gives up in both.
    expect(nextReplayStep(row({ state: "failed", recordedAt: ago(30 * DAY) }), NOW, OFF).kind).toBe("give_up");
    expect(nextReplayStep(row({ state: "failed", recordedAt: ago(30 * DAY - 1) }), NOW, OFF).kind).toBe("retry");
    expect(REPLAY_PARKED_AT).toEqual(PARKED);
  });

  // Re-review N1 (2026-11-22): a deleted row's Bunny copy has no 30-day life, and an organiser deletes a replay long after it was
  // recorded. Its cleanup retries are counted from its own delete (`deleted_at`; `state_at` when that is missing), never from the
  // recording — or an old replay deleted today would be parked on its first transient fault, its copy left on the host.
  it("re-review N1: a DELETED row's window opens at its delete — an old replay deleted a minute ago backs off; deleted 30 days ago it is parked; with no deleted_at, its state_at is the anchor", () => {
    const DAY = 24 * 60 * MIN;
    const old = { state: "deleted" as const, attempts: 0, recordedAt: ago(60 * DAY) };
    const CASES: [string, ReplayRow, string][] = [
      ["recorded 60 d ago, deleted 1 min ago", row({ ...old, deletedAt: ago(MIN) }), "backoff"],
      ["recorded 60 d ago, deleted 30 d - 1 ms ago", row({ ...old, deletedAt: ago(30 * DAY - 1) }), "backoff"],
      ["recorded 60 d ago, deleted exactly 30 d ago", row({ ...old, deletedAt: ago(30 * DAY) }), "give_up"],
      ["recorded 60 d ago, no deleted_at, state_at 1 min ago", row({ ...old, deletedAt: null, stateAt: ago(MIN) }), "backoff"],
      ["recorded 60 d ago, no deleted_at, state_at 30 d ago", row({ ...old, deletedAt: null, stateAt: ago(30 * DAY) }), "give_up"],
      // Every other state ignores deleted_at and state_at: the recording is its anchor.
      ["a playable row recorded 30 d ago, with a fresh state_at", row({ state: "playable", recordedAt: ago(30 * DAY), stateAt: ago(MIN), deletedAt: ago(MIN) }), "give_up"],
    ];
    let checked = 0;
    for (const [name, r, kind] of CASES) {
      const o = replayFailureOutcome(r, NOW);
      expect(o.kind, name).toBe(kind);
      expect(o.state, `${name}: a deleted row stays deleted, parked or not`).toBe(r.state);
      checked++;
    }
    expect(checked, "rows").toBe(6);
  });

  // Task 31b (the Task 24 re-review 2 carry): a row parked as `failed` while it still HOLDS a host copy (a failed copy whose removal
  // failed, or an encoding row parked mid-move) was never due again, so nothing removed the copy — stored and billed for ever. Past
  // the window such a row is due after the backoff instead, where `failed`'s give_up removes the copy and only then parks it. A
  // playable row keeps its copy parked (it is the product) and a deleted one keeps its own cleanup's window: both park as before.
  it("Task 31b: past the window, a row that would park as FAILED while holding a copy is due after the backoff (its copy is removed first); playable and deleted with a copy park as before", () => {
    const DAY = 24 * 60 * MIN;
    const PARKED = new Date("9999-12-31T00:00:00.000Z");
    const at = (state: string) => ({ recordedAt: ago(30 * DAY), ...(state === "deleted" ? { deletedAt: ago(30 * DAY) } : {}) });
    const EXPECTED: Record<string, { state: string; nextAttemptAt: Date }> = {
      found: { state: "failed", nextAttemptAt: later(8 * MIN) }, downloading: { state: "failed", nextAttemptAt: later(8 * MIN) },
      fetching: { state: "failed", nextAttemptAt: later(8 * MIN) }, encoding: { state: "failed", nextAttemptAt: later(8 * MIN) },
      failed: { state: "failed", nextAttemptAt: later(8 * MIN) },
      playable: { state: "playable", nextAttemptAt: PARKED }, deleted: { state: "deleted", nextAttemptAt: PARKED },
    };
    let checked = 0;
    for (const state of REPLAY_ROW_STATES) {
      const held = replayFailureOutcome(row({ state, attempts: 3, bunnyVideoId: "g1", ...at(state) }), NOW);
      expect(held, `${state} holding a copy`).toEqual({ kind: "give_up", attempts: 4, ...EXPECTED[state] });
      const none = replayFailureOutcome(row({ state, attempts: 3, bunnyVideoId: null, ...at(state) }), NOW);
      expect(none.nextAttemptAt, `${state} holding nothing: parked`).toEqual(PARKED);
      checked += 2;
    }
    expect(checked, "states × {holding, not}").toBe(14);
    expect(Object.keys(EXPECTED).sort(), "PREMISE: the table names every state").toEqual([...REPLAY_ROW_STATES].sort());
  });
});

describe("cfDeleteGate — the Cloudflare copy is deleted only at or after verified_at + 60 min, and never without a verification", () => {
  it("59 min: not due (wait until 60); 60 min: due; no verified_at: never", () => {
    expect(cfDeleteGate({ verifiedAt: ago(59 * MIN) }, NOW, OFF)).toEqual({ due: false, until: later(1 * MIN) });
    expect(cfDeleteGate({ verifiedAt: ago(60 * MIN) }, NOW, OFF)).toEqual({ due: true });
    expect(cfDeleteGate({ verifiedAt: ago(61 * MIN) }, NOW, OFF)).toEqual({ due: true });
    expect(cfDeleteGate({ verifiedAt: null }, NOW, OFF)).toEqual({ due: false, until: null });
  });
});

// Phase 3 review I1 and the controller's ruling (2026-11-24): Cloudflare keys a match's live minutes by its RECORDING uid, and
// whether its analytics still answer for a deleted video is unmeasured — so with SEAZN_HOSTED_COST on (the daily pass measures
// Cloudflare minutes) the copy is kept until its session's Cloudflare minutes are measured through the session's END DAY
// (`live_measured_through` >= the end's UTC date). The gate never waits for a measure that cannot come: with COST off nothing
// measures; the live read selects only ENDED sessions, and only those that ended within 31 days. Until it opens, the row is asked
// again at the later of the end day's close (no daily read can have covered it before) and 60 minutes on. Every number is the
// ruling's or the plan's, typed here: the end DAY, 31 days, 60 minutes.
describe("I1: with SEAZN_HOSTED_COST on, the Cloudflare delete also waits until the session's Cloudflare minutes are measured through its end day", () => {
  const DAY = 24 * 60 * MIN;
  /** The session ended at 10:00 UTC on 2026-11-22 (NOW's day): its end day closes at 2026-11-23T00:00Z. */
  const ENDED = new Date("2026-11-22T10:00:00.000Z");
  const DAY_CLOSES = new Date("2026-11-23T00:00:00.000Z");
  const at = (iso: string) => new Date(iso);
  const on = (over: Partial<{ sessionEndedAt: Date | null; measuredThrough: Date | null }> = {}): LiveMeasure =>
    ({ measured: true, sessionEndedAt: ENDED, measuredThrough: null, ...over });

  it("liveMeasureGate, swept: COST off never waits; COST on waits until measured through the end day, never for a session with no end or one the live read has stopped selecting", () => {
    const CASES: [string, LiveMeasure, Date, ReturnType<typeof liveMeasureGate>][] = [
      ["SEAZN_HOSTED_COST off: nothing measures, so the delete never waits for a measure", OFF, NOW, { due: true }],
      ["COST on, never measured, the end day still open at 12:00: waits for its close (00:00), later than 60 min on", on(), NOW, { due: false, until: DAY_CLOSES }],
      ["COST on, never measured, 23:30 on the end day: its close is under 60 min away, so 60 min on", on(), at("2026-11-22T23:30:00.000Z"), { due: false, until: at("2026-11-23T00:30:00.000Z") }],
      ["COST on, never measured, 04:00 the next day (the end day closed): asked again 60 min on", on(), at("2026-11-23T04:00:00.000Z"), { due: false, until: at("2026-11-23T05:00:00.000Z") }],
      ["measured through the day BEFORE the end day: waits", on({ measuredThrough: at("2026-11-21T00:00:00.000Z") }), at("2026-11-23T04:00:00.000Z"), { due: false, until: at("2026-11-23T05:00:00.000Z") }],
      ["measured through the END DAY exactly: due", on({ measuredThrough: at("2026-11-22T00:00:00.000Z") }), at("2026-11-23T04:20:00.000Z"), { due: true }],
      ["measured through a later day: due", on({ measuredThrough: at("2026-11-23T00:00:00.000Z") }), at("2026-11-24T04:20:00.000Z"), { due: true }],
      ["a session with no end: the live read selects only ended sessions, so nothing will measure it — due", on({ sessionEndedAt: null }), NOW, { due: true }],
      ["ended exactly 31 days ago, never measured: the live read still selects it — waits", on(), new Date(ENDED.getTime() + 31 * DAY), { due: false, until: new Date(ENDED.getTime() + 31 * DAY + 60 * MIN) }],
      ["ended 31 days and 1 ms ago, never measured: the live read never selects it again — due", on(), new Date(ENDED.getTime() + 31 * DAY + 1), { due: true }],
    ];
    let checked = 0;
    for (const [name, live, now, expected] of CASES) {
      expect(liveMeasureGate(live, now), name).toEqual(expected);
      checked++;
    }
    expect(checked, "cases").toBe(10);
  });

  it("through the transition table: a playable or deleted row past verified + 60 min waits for the measure, then deletes; the 60 min still comes first, and a row never verified still never earns a delete", () => {
    const T = at("2026-11-22T12:00:00.000Z");   // = NOW
    const notYet = on();
    const done = on({ measuredThrough: at("2026-11-22T00:00:00.000Z") });
    const CASES: [string, ReplayRow, LiveMeasure, ReplayStep][] = [
      ["playable, verified 60 min ago, COST on, not measured → wait for the end day's close, never delete_cf",
        row({ state: "playable", bunnyVideoId: "g1", verifiedAt: ago(60 * MIN) }), notYet, { kind: "wait", until: DAY_CLOSES }],
      ["playable, verified 60 min ago, measured through the end day → delete_cf",
        row({ state: "playable", bunnyVideoId: "g1", verifiedAt: ago(60 * MIN) }), done, { kind: "delete_cf" }],
      ["playable, verified 60 min ago, COST off → delete_cf (G-D alone)",
        row({ state: "playable", bunnyVideoId: "g1", verifiedAt: ago(60 * MIN) }), OFF, { kind: "delete_cf" }],
      ["playable, verified 59 min ago, already measured → the 60 min first: wait for verified + 60",
        row({ state: "playable", bunnyVideoId: "g1", verifiedAt: ago(59 * MIN) }), done, { kind: "wait", until: later(1 * MIN) }],
      ["deleted, verified 70 min ago, COST on, not measured → cleanup now; the Cloudflare delete waits for the end day's close",
        row({ state: "deleted", bunnyVideoId: "g1", verifiedAt: ago(70 * MIN) }), notYet, { kind: "cleanup", cf: "wait", until: DAY_CLOSES }],
      ["deleted, verified 70 min ago, measured through the end day → cleanup, deleting the Cloudflare copy",
        row({ state: "deleted", bunnyVideoId: "g1", verifiedAt: ago(70 * MIN) }), done, { kind: "cleanup", cf: "delete" }],
      ["deleted, never verified, COST on → cleanup the host side only; the Cloudflare copy is never deleted from here",
        row({ state: "deleted", bunnyVideoId: "g1" }), notYet, { kind: "cleanup", cf: "skip" }],
      ["deleted, Cloudflare copy already gone, COST on, not measured → nothing to wait for",
        row({ state: "deleted", verifiedAt: ago(90 * MIN), cfDeletedAt: ago(5 * MIN) }), notYet, { kind: "cleanup", cf: "skip" }],
    ];
    let checked = 0;
    for (const [name, r, live, expected] of CASES) {
      expect(nextReplayStep(r, T, live), name).toEqual(expected);
      expect(T.getTime(), "PREMISE: the table's clock is NOW").toBe(NOW.getTime());
      checked++;
    }
    expect(checked, "rows").toBe(8);
  });
});

describe("verifyReplayCopy — 'clean and good' (recommendation 2026-11-21, G-C): playable, ±2 s of the Cloudflare duration, the required rung listed", () => {
  const RUNGS_720 = [240, 360, 480, 720];
  const RUNGS_1080 = [...RUNGS_720, 1080];
  const ok = { ok: true };
  // The programme profile the compositor streams at (RELAY_OUTPUT_PROFILE): a recording's height is its profile's, never a typed 720/1080.
  const PROFILE_720 = relayOutputProfile({ RELAY_OUTPUT_PROFILE: "720p" }).height;
  const PROFILE_1080 = relayOutputProfile({ RELAY_OUTPUT_PROFILE: "1080p" }).height;
  it("length: a 3600 s recording passes at 3598 and 3602 and fails at 3597 and 3603 (the `length` reason)", () => {
    const r = { cfDurationSeconds: 3600, cfHeight: 1080 };
    const at = (lengthSeconds: number) => verifyReplayCopy(r, { state: "playable", lengthSeconds, heights: RUNGS_1080 });
    expect([at(3598), at(3600), at(3602)]).toEqual([ok, ok, ok]);
    expect([at(3597), at(3603)]).toEqual([{ ok: false, reason: "length" }, { ok: false, reason: "length" }]);
  });
  it("Task 48: the rung is the source PROFILE's own height — a 1080 profile needs a 1080 copy (a 720 ladder fails `rendition`), a 720 profile still verifies at 720 (the regression), and neither passes on a ladder that stops short", () => {
    expect(PROFILE_1080, "PREMISE: the two profiles differ").toBeGreaterThan(PROFILE_720);
    const at = (cfHeight: number, heights: number[]) => verifyReplayCopy({ cfDurationSeconds: 100, cfHeight }, { state: "playable", lengthSeconds: 100, heights });
    expect(at(PROFILE_720, RUNGS_720), "a 720 profile replay still verifies").toEqual(ok);
    expect(at(PROFILE_720, RUNGS_1080), "and a library that also made 1080 changes nothing for it").toEqual(ok);
    expect(at(PROFILE_720, [240, 360, 480])).toEqual({ ok: false, reason: "rendition" });
    expect(at(PROFILE_1080, RUNGS_1080)).toEqual(ok);
    expect(at(PROFILE_1080, [1080, 240]), "the rungs below the top are not required, only the source's own").toEqual(ok);
    expect(at(PROFILE_1080, RUNGS_720), "a 1080 source with a 720-top copy is not clean").toEqual({ ok: false, reason: "rendition" });
  });
  it("rendition: a 1080p source needs 1080 (the ladder is not capped at 720); a 480p source needs 480; the list's order is not read", () => {
    const at = (cfHeight: number, heights: number[]) => verifyReplayCopy({ cfDurationSeconds: 100, cfHeight }, { state: "playable", lengthSeconds: 100, heights });
    expect(at(1080, RUNGS_1080)).toEqual(ok);
    expect(at(1080, [720, 1080, 240, 480, 360]), "unordered, as the host lists them").toEqual(ok);
    expect(at(1080, [240, 360, 480])).toEqual({ ok: false, reason: "rendition" });
    expect(at(480, [240, 360, 480])).toEqual(ok);
    expect(at(720, [240, 360, 480])).toEqual({ ok: false, reason: "rendition" });
    expect(at(500, [240, 360, 480]), "a 500 px source: the largest rung not above it is 480").toEqual(ok);
  });
  it("the required rung is the largest of 240/360/480/720/1080 not above the source; a source under 240, or none, has none", () => {
    expect([1440, 1080, 1079, 720, 719, 480, 360, 240, 239, null].map((h) => requiredRung(h))).toEqual([1080, 1080, 720, 720, 480, 480, 360, 240, null, null]);
  });
  it("a null on either side fails: no Cloudflare duration, no Cloudflare height, no host length; and a copy not playable fails `state`", () => {
    const copy = { state: "playable" as const, lengthSeconds: 100, heights: RUNGS_1080 };
    expect(verifyReplayCopy({ cfDurationSeconds: null, cfHeight: 1080 }, copy)).toEqual({ ok: false, reason: "length" });
    expect(verifyReplayCopy({ cfDurationSeconds: 100, cfHeight: null }, copy)).toEqual({ ok: false, reason: "rendition" });
    expect(verifyReplayCopy({ cfDurationSeconds: 100, cfHeight: 200 }, copy), "a source under 240 px").toEqual({ ok: false, reason: "rendition" });
    expect(verifyReplayCopy({ cfDurationSeconds: 100, cfHeight: 1080 }, { ...copy, lengthSeconds: null })).toEqual({ ok: false, reason: "length" });
    expect(verifyReplayCopy({ cfDurationSeconds: 100, cfHeight: 1080 }, { ...copy, state: "processing" })).toEqual({ ok: false, reason: "state" });
    // A null read as 0 would pass a 1-second comparison: the null is a failure, never a zero.
    expect(verifyReplayCopy({ cfDurationSeconds: null, cfHeight: 1080 }, { ...copy, lengthSeconds: 1 })).toEqual({ ok: false, reason: "length" });
    expect(verifyReplayCopy({ cfDurationSeconds: 1, cfHeight: 1080 }, { ...copy, lengthSeconds: null })).toEqual({ ok: false, reason: "length" });
  });
});

describe("pollOutcome — what one poll of an encoding copy means", () => {
  const r = row({ state: "encoding", bunnyVideoId: "g1", cfDurationSeconds: 120, cfHeight: 720 });
  it("processing: poll again 15 min later (the backstop); playable and clean: verified now, Cloudflare delete due 60 min later", () => {
    expect(pollOutcome(r, { state: "processing", lengthSeconds: null, heights: [] }, NOW)).toEqual({ kind: "processing", nextAttemptAt: later(15 * MIN) });
    expect(pollOutcome(r, { state: "playable", lengthSeconds: 121, heights: [240, 720] }, NOW))
      .toEqual({ kind: "verified", verifiedAt: NOW, lengthSeconds: 121, nextAttemptAt: later(60 * MIN) });
  });
  it("playable but not clean, and the host's own failure, both take the failed path (with the reason); absent goes back to found", () => {
    expect(pollOutcome(r, { state: "playable", lengthSeconds: 130, heights: [720] }, NOW)).toEqual({ kind: "failed", reason: "length" });
    expect(pollOutcome(r, { state: "playable", lengthSeconds: 120, heights: [360] }, NOW)).toEqual({ kind: "failed", reason: "rendition" });
    expect(pollOutcome(r, { state: "failed", lengthSeconds: null, heights: [] }, NOW)).toEqual({ kind: "failed", reason: "host_failed" });
    expect(pollOutcome(r, { state: "absent", lengthSeconds: null, heights: [] }, NOW)).toEqual({ kind: "lost" });
  });
});

describe("replayCopyTitle / parseReplayCopyTitle — the copy's title, the plan's form `seazn:{sessionId}:{cfVideoId}` (Task 27 reads it back)", () => {
  const SID = "3b2f6c1e-8a4d-4e6b-9c2a-1f0e5d7c9b8a";
  it("EMPTY CASE FIRST: no title, an empty one, and every title not of the form name nothing", () => {
    const others: (string | null)[] = [
      null, "", "Club promo reel", "seazn:", `seazn:${SID}`, `seazn:${SID}:`, `seazn:not-a-uuid:v-1`, `xseazn:${SID}:v-1`,
      `seazn:${SID}:v-1:extra`, `seazn:${SID}:v 1`, ` seazn:${SID}:v-1`, `seazn:${SID}:v-1\n`, `SEAZN-${SID}-v-1`,
    ];
    let checked = 0;
    for (const t of others) {
      expect(parseReplayCopyTitle(t), JSON.stringify(t)).toBeNull();
      checked++;
    }
    expect(checked).toBe(13);
  });
  it("the producer writes the plan's literal form, and the reader names that session and recording back", () => {
    expect(replayCopyTitle(SID, "cf-0a1b2c")).toBe(`seazn:${SID}:cf-0a1b2c`);
    expect(parseReplayCopyTitle(`seazn:${SID}:cf-0a1b2c`)).toEqual({ sessionId: SID, cfVideoId: "cf-0a1b2c" });
    expect(parseReplayCopyTitle(replayCopyTitle(SID, "v-3-x"))).toEqual({ sessionId: SID, cfVideoId: "v-3-x" });
  });
});
