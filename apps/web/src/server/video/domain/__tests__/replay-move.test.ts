// Seazn-hosted video Task 24: the replay move's pure decisions — the transition table (`nextReplayStep`), the backoff a
// failure earns (`replayFailure`), the Cloudflare delete gate (`cfDeleteGate`), the copy check (`verifyReplayCopy`, the owner's
// "clean and good": recommendation 2026-11-21 G-C) and what one poll of the host means (`pollOutcome`).
//
// Every expected value is the plan's or the recommendation's literal, typed here (TEST-STRATEGY: never derive an expected value
// from the code under test): 30 min stale fetch, 15 min poll backstop, 60 min after verification, min(2^attempts, 60) minutes of
// backoff, a 30-day retry window, ±2 s, the 240/360/480/720 rungs. No DB and no network: this file needs neither.
import { describe, expect, it } from "vitest";
import {
  REPLAY_ROW_STATES, type ReplayRow, type ReplayStep, cfDeleteGate, nextReplayStep, pollOutcome, replayFailure, requiredRung,
  verifyReplayCopy,
} from "../replay-move";

const MIN = 60_000;
const NOW = new Date("2026-11-22T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const later = (ms: number) => new Date(NOW.getTime() + ms);

function row(over: Partial<ReplayRow> = {}): ReplayRow {
  return {
    state: "found", stateAt: ago(MIN), recordedAt: ago(60 * MIN), bunnyVideoId: null, verifiedAt: null, cfDeletedAt: null,
    bunnyCleanedAt: null, cfDurationSeconds: 3600, cfHeight: 1080, attempts: 0, ...over,
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
      expect(nextReplayStep(r, NOW), name).toEqual(expected);
      reached.add(r.state);
      checked++;
    }
    expect(checked, "rows checked").toBe(CASES.length);
    expect(checked).toBeGreaterThan(0);
    expect([...reached].sort(), "every state the schema holds is in the sweep").toEqual([...REPLAY_ROW_STATES].sort());
    expect(REPLAY_ROW_STATES, "the schema's list, typed from V542").toEqual(["found", "downloading", "fetching", "encoding", "playable", "failed", "deleted"]);
  });

  it("an unknown state (a row read from a database that grew a state) is refused by name, never guessed", () => {
    expect(nextReplayStep(row({ state: "verifying" as ReplayRow["state"] }), NOW)).toEqual({ kind: "refuse", reason: "unknown_state" });
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

  it("swept over every state whose step makes a provider call: the failure never moves the state, only the clock", () => {
    // The step of each state, and whether it calls a provider. A `wait`, `settled`, `refuse` or `give_up` makes no call.
    const CALLING = new Set(["create_download", "refetch", "poll_state", "delete_cf", "retry", "cleanup"]);
    let calling = 0;
    for (const state of REPLAY_ROW_STATES) {
      const r = row({ state, attempts: 3, ...(state === "encoding" || state === "playable" ? { bunnyVideoId: "g1" } : {}),
        ...(state === "playable" ? { verifiedAt: ago(61 * MIN) } : {}), ...(state === "fetching" ? { stateAt: ago(31 * MIN) } : {}) });
      const step = nextReplayStep(r, NOW);
      if (!CALLING.has(step.kind)) continue;
      expect(replayFailure(r, NOW), `${state} (${step.kind})`).toEqual({ attempts: 4, nextAttemptAt: later(8 * MIN) });
      calling++;
    }
    // found, downloading, fetching (stale), encoding, playable (due), failed (retry), deleted (cleanup): seven.
    expect(calling, "states whose step calls a provider").toBe(7);
  });
});

describe("cfDeleteGate — the Cloudflare copy is deleted only at or after verified_at + 60 min, and never without a verification", () => {
  it("59 min: not due (wait until 60); 60 min: due; no verified_at: never", () => {
    expect(cfDeleteGate({ verifiedAt: ago(59 * MIN) }, NOW)).toEqual({ due: false, until: later(1 * MIN) });
    expect(cfDeleteGate({ verifiedAt: ago(60 * MIN) }, NOW)).toEqual({ due: true });
    expect(cfDeleteGate({ verifiedAt: ago(61 * MIN) }, NOW)).toEqual({ due: true });
    expect(cfDeleteGate({ verifiedAt: null }, NOW)).toEqual({ due: false, until: null });
  });
});

describe("verifyReplayCopy — 'clean and good' (recommendation 2026-11-21, G-C): playable, ±2 s of the Cloudflare duration, the required rung listed", () => {
  const RUNGS_720 = [240, 360, 480, 720];
  const ok = { ok: true };
  it("length: a 3600 s recording passes at 3598 and 3602 and fails at 3597 and 3603 (the `length` reason)", () => {
    const r = { cfDurationSeconds: 3600, cfHeight: 1080 };
    const at = (lengthSeconds: number) => verifyReplayCopy(r, { state: "playable", lengthSeconds, heights: RUNGS_720 });
    expect([at(3598), at(3600), at(3602)]).toEqual([ok, ok, ok]);
    expect([at(3597), at(3603)]).toEqual([{ ok: false, reason: "length" }, { ok: false, reason: "length" }]);
  });
  it("rendition: a 1080p source needs 720 ([240,360,480,720] passes, [240,360,480] fails); a 480p source needs 480; the list's order is not read", () => {
    const at = (cfHeight: number, heights: number[]) => verifyReplayCopy({ cfDurationSeconds: 100, cfHeight }, { state: "playable", lengthSeconds: 100, heights });
    expect(at(1080, RUNGS_720)).toEqual(ok);
    expect(at(1080, [720, 240, 480, 360]), "unordered, as the host lists them").toEqual(ok);
    expect(at(1080, [240, 360, 480])).toEqual({ ok: false, reason: "rendition" });
    expect(at(480, [240, 360, 480])).toEqual(ok);
    expect(at(720, [240, 360, 480])).toEqual({ ok: false, reason: "rendition" });
    expect(at(500, [240, 360, 480]), "a 500 px source: the largest rung not above it is 480").toEqual(ok);
  });
  it("the required rung is the largest of 240/360/480/720 not above the source; a source under 240, or none, has none", () => {
    expect([1080, 720, 719, 480, 360, 240, 239, null].map((h) => requiredRung(h))).toEqual([720, 720, 480, 480, 360, 240, null, null]);
  });
  it("a null on either side fails: no Cloudflare duration, no Cloudflare height, no host length; and a copy not playable fails `state`", () => {
    const copy = { state: "playable" as const, lengthSeconds: 100, heights: RUNGS_720 };
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
