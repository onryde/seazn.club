// Capacity tests 19 (abandonment and release at the boundary) and 35 (a dead-camera admitted stay ends at ADMIT_HOLD_MS, not
// before), spec §8.1, §5.7.3, §5.7.5. The boundary pairs are gate-level (one clock, a bucket pinned to a stated level); test 35
// is driven through the REAL claim and the in-memory RealtimeKit, with a camera that never reports (`pending` for ever).
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import {
  CAMERA_EVIDENCE_BACKOFF_MS,
  CAMERA_EVIDENCE_DEADLINE_MS,
  CAMERA_JOIN_ALLOWANCE_MS,
  CAMERA_PROMPT_ALLOWANCE_MS,
  LINE_POLL_MS,
  MINT_TO_READ_MS,
  SEAT_RETRY_MS,
} from "@/components/public-site/match-room/room-snapshot";
import {
  ADMIT_HOLD_MS,
  LINE_ABANDON_AFTER_MS,
  LINE_RELEASE_GRACE_MS,
  LINE_RESERVATION,
  ownStayInLine,
} from "@/server/external-play/seat-line";
import { configureRealtimeKit } from "./_external-play-rtk-fake";
import { claimAt, clearBucket, holdReservation, holdWaiting, putStay, sceneAt, seedBoard as sceneBoard, setBucket, stayRow, stubBucket } from "./_external-play-line";
import {
  DEADLINE,
  MIN,
  OPENED,
  SEC,
  cameraOn,
  claimRoom,
  dropWorlds,
  fund,
  inWindow,
  joinAt,
  seatAndCount,
  seedBoard,
  world,
} from "./_external-play-line-route";
import { boardAnchor } from "@/server/external-play/window";

const DB = !!process.env.DATABASE_URL;
const L = LINE_RESERVATION;
const ANCHOR = boardAnchor(OPENED, 0, false);

const keys: string[] = [];
function scene(): string {
  configureRealtimeKit();
  const key = stubBucket();
  keys.push(key);
  return key;
}
afterEach(async () => {
  await dropWorlds();
  if (DB) for (const k of keys.splice(0)) await clearBucket(k);
  vi.unstubAllEnvs();
});
beforeEach(() => {
  configureRealtimeKit();
});
afterAll(async () => {
  if (DB) await sql.end();
});

describe.skipIf(!DB)("abandonment and release at the boundary (test 19)", () => {
  it("HELD: silent for LINE_ABANDON_AFTER_MS - 1 ms still counts in the positions behind it, at LINE_ABANDON_AFTER_MS it does not", async () => {
    const results: { when: string; kind: string }[] = [];
    for (const [when, ms, kind] of [
      ["1 ms before", LINE_ABANDON_AFTER_MS - 1, "queued"],
      ["at", LINE_ABANDON_AFTER_MS, "go"],
    ] as const) {
      const key = scene();
      await holdWaiting(key, sceneAt(0), sceneAt(0)); // somebody waiting, last heard from at 0
      const behind = await sceneBoard();
      const got = await claimAt(key, behind, "home", sceneAt(ms));
      results.push({ when, kind: got.kind });
      expect(got.kind, `the arrival ${when} the abandon threshold`).toBe(kind);
      if (got.kind === "queued") expect(got.line.position, "the silent-but-counted stay is ahead of it").toBe(2);
    }
    expect(results.length, "boundary instants checked").toBe(2);
  });

  it("PASSED: silent for LINE_RELEASE_GRACE_MS - 1 ms still holds its place and its reservation, at LINE_RELEASE_GRACE_MS it does not", async () => {
    const outcomes: string[] = [];
    for (const ms of [LINE_RELEASE_GRACE_MS - 1, LINE_RELEASE_GRACE_MS]) {
      const key = scene();
      const held = await holdReservation(key, sceneAt(0));
      await setBucket(key, L, sceneAt(ms)); // exactly the one reservation promised
      const place = await ownStayInLine({ fixtureId: held.fixtureId, personId: held.home.personId, at: sceneAt(ms) });
      const candidate = await sceneBoard();
      const got = await claimAt(key, candidate, "home", sceneAt(ms));
      outcomes.push(`${ms}:${place}:${got.kind}`);
      // Inside the grace: in line, and the candidate waits for the pool. At it: gone, and the line is idle.
      expect([place, got.kind]).toEqual(ms < LINE_RELEASE_GRACE_MS ? [true, "queued"] : [false, "go"]);
    }
    expect(outcomes.length).toBe(2);
  });

  it("a stay that polls at the slowest back-off step, and one whose read comes MINT_TO_READ_MS after the mint's answer, keep their place (the first claim stands)", async () => {
    const slowest = Math.max(...CAMERA_EVIDENCE_BACKOFF_MS);
    // The floors, computed here from the exported client declarations (never typed): the grace outlasts the slowest gap between
    // two claims of a live stay, plus one poll.
    const mintToRead = CAMERA_PROMPT_ALLOWANCE_MS + CAMERA_JOIN_ALLOWANCE_MS + SEAT_RETRY_MS;
    expect(MINT_TO_READ_MS, "the exported MINT_TO_READ_MS is the sum of its three declarations").toBe(mintToRead);
    expect(LINE_RELEASE_GRACE_MS, "the grace floor").toBeGreaterThanOrEqual(Math.max(slowest, mintToRead) + LINE_POLL_MS);
    expect(ADMIT_HOLD_MS, "the hold is at least the grace").toBeGreaterThanOrEqual(LINE_RELEASE_GRACE_MS);
    const key = scene();
    await setBucket(key, 10_000, new Date(Date.now() + 3_600_000));
    const a = await sceneBoard();
    const polls: number[] = [0];
    for (let i = 1; i <= 12; i += 1) polls.push(i * slowest);
    polls.push(polls.at(-1)! + MINT_TO_READ_MS);
    for (const ms of polls) await claimAt(key, a, "home", sceneAt(ms), { anchor: ANCHOR });
    const row = await stayRow(a.fixtureId, a.home.personId);
    expect(row?.first_claim_at, "never restarted: its arrival is the first claim").toEqual(sceneAt(0));
    expect(polls.length, "claims made").toBe(14);
  });
});

describe.skipIf(!DB)("a dead-camera admitted stay ends at ADMIT_HOLD_MS, not before (test 35)", () => {
  it("D keeps claiming inside the grace with a camera that never reports: at admitted_at + ADMIT_HOLD_MS - 1 ms it is still admitted, still counted, still protected after the deadline and W is still queued; at the hold it is ended, the pool has risen by its reservation and W is admitted and runs; D's next press after the deadline is window_closed", async () => {
    expect(ADMIT_HOLD_MS, "computed from the exported constants, never typed").toBe(
      MINT_TO_READ_MS + CAMERA_EVIDENCE_DEADLINE_MS + Math.max(...CAMERA_EVIDENCE_BACKOFF_MS),
    );
    expect(ADMIT_HOLD_MS, "at least the release grace").toBeGreaterThanOrEqual(LINE_RELEASE_GRACE_MS);
    const w = world();
    const d = await seedBoard();
    const wBoard = await seedBoard();
    // D mints on the idle line and joins; its camera never reports.
    const t0 = new Date(DEADLINE.getTime() - 60 * SEC);
    await fund(w.key, 1000);
    const minted = await claimRoom(w, d, "home", t0);
    joinAt(w, minted.seat, new Date(t0.getTime() + SEC));
    // W waits behind D (a stay somebody else holds), D's first read finds the budget dry: D is HELD.
    await fund(w.key, 0);
    await putStay({ fixtureId: wBoard.fixtureId, personId: wBoard.home.personId, budgetKey: w.key, firstClaimAt: new Date(t0.getTime() + 2 * SEC), seenAt: new Date(t0.getTime() + 2 * SEC), gate: "held", queuedAt: new Date(t0.getTime() + 2 * SEC) });
    const held = await claimRoom(w, d, "home", new Date(t0.getTime() + 5 * SEC));
    expect(held.seat).toMatchObject({ reason: "queued" });
    // D is admitted at A.
    const A = new Date(t0.getTime() + 10 * SEC);
    await fund(w.key, 1000);
    const admitted = await claimRoom(w, d, "home", A);
    expect(admitted.seat, "admitted: the read finds a camera still starting").toMatchObject({ seated: false });
    expect((await stayRow(d.fixtureId, d.home.personId))?.admitted_at, "admitted at A").toEqual(A);

    // D keeps claiming (never silent) up to the boundary. W polls too.
    const wPoll = (at: Date) => claimRoom(w, wBoard, "home", at);
    let t = A.getTime();
    let dClaims = 0;
    while (t + 8 * SEC < A.getTime() + ADMIT_HOLD_MS - 1) {
      t += 8 * SEC;
      await fund(w.key, 1000);
      await claimRoom(w, d, "home", new Date(t));
      dClaims += 1;
      await fund(w.key, 2 * L - 1);
      expect((await wPoll(new Date(t + 1))).seat, `W waits at A + ${(t + 1 - A.getTime()) / 1000} s`).toMatchObject({ reason: "queued" });
    }
    expect(dClaims, "anti-vacuity: D kept claiming").toBeGreaterThan(3);

    // 1 ms before the hold's end.
    const before = new Date(A.getTime() + ADMIT_HOLD_MS - 1);
    await fund(w.key, 1000);
    const dBefore = await claimRoom(w, d, "home", before);
    expect(dBefore.seat, "D is still admitted: not restarted, not window_closed (protected after the deadline)").not.toMatchObject({ reason: "window_closed" });
    expect(before.getTime(), "premise: past the deadline").toBeGreaterThan(DEADLINE.getTime());
    expect((await stayRow(d.fixtureId, d.home.personId))?.admitted_at, "its admission stands").toEqual(A);
    await fund(w.key, 2 * L - 1);
    expect((await wPoll(before)).seat, "W is still queued: D's reservation is still counted").toMatchObject({ reason: "queued" });
    expect(await ownStayInLine({ fixtureId: d.fixtureId, personId: d.home.personId, at: before })).toBe(true);

    // At the hold's end.
    const atHold = new Date(A.getTime() + ADMIT_HOLD_MS);
    expect(await ownStayInLine({ fixtureId: d.fixtureId, personId: d.home.personId, at: atHold }), "D is no longer in line").toBe(false);
    await fund(w.key, 2 * L - 1);
    const wRun = await wPoll(atHold);
    expect(wRun.seat, "W is admitted with the freed tokens and RUNS (its mint answers camera_required with a token)").toMatchObject({ reason: "camera_required" });
    expect((await stayRow(wBoard.fixtureId, wBoard.home.personId))?.admitted_at, "W's admission is at the hold's end").toEqual(atHold);
    // D's next press, after the deadline: a new stay, unprotected.
    const dAfter = await claimRoom(w, d, "home", atHold);
    expect(dAfter.seat, "after the deadline D takes the normal rules").toMatchObject({ reason: "window_closed" });
  }, 180_000);

  it("the hold ends BEFORE the deadline: the dead stay's next press is a new stay at the back, QUEUED behind a waiting stay, and says `left: camera` once (spec 35, the variant)", async () => {
    const w = world();
    const d = await seedBoard();
    const wBoard = await seedBoard();
    // Early enough that the hold's end (A + ADMIT_HOLD_MS) falls well inside the board's window.
    const t0 = new Date(DEADLINE.getTime() - 3 * MIN);
    await fund(w.key, 1000);
    const minted = await claimRoom(w, d, "home", t0);
    joinAt(w, minted.seat, new Date(t0.getTime() + SEC));
    await fund(w.key, 0);
    const wAt = new Date(t0.getTime() + 2 * SEC);
    await putStay({ fixtureId: wBoard.fixtureId, personId: wBoard.home.personId, budgetKey: w.key, firstClaimAt: wAt, seenAt: wAt, gate: "held", queuedAt: wAt });
    expect((await claimRoom(w, d, "home", new Date(t0.getTime() + 5 * SEC))).seat, "D is held").toMatchObject({ reason: "queued" });
    const A = new Date(t0.getTime() + 10 * SEC);
    await fund(w.key, 1000);
    await claimRoom(w, d, "home", A);
    expect((await stayRow(d.fixtureId, d.home.personId))?.admitted_at, "admitted at A").toEqual(A);
    // D keeps claiming (never silent) with a camera that never reports, up to the hold.
    let t = A.getTime();
    let dClaims = 0;
    while (t + 8 * SEC < A.getTime() + ADMIT_HOLD_MS - 1) {
      t += 8 * SEC;
      await fund(w.key, 1000);
      await claimRoom(w, d, "home", new Date(t));
      dClaims += 1;
      // W keeps polling too (a silent stay would lapse), and is held behind D's reservation.
      await fund(w.key, 2 * L - 1);
      expect((await claimRoom(w, wBoard, "home", new Date(t + 1))).seat, `W waits at A + ${(t + 1 - A.getTime()) / 1000} s`).toMatchObject({ reason: "queued" });
    }
    expect(dClaims, "anti-vacuity: D kept claiming").toBeGreaterThan(3);
    const atHold = new Date(A.getTime() + ADMIT_HOLD_MS);
    expect(atHold.getTime(), "premise: the hold ends INSIDE the window, before the deadline").toBeLessThan(DEADLINE.getTime());
    // A second waiting stay, behind W and ahead of whatever D becomes; W is admitted with D's freed tokens and the pool is then short.
    await holdWaiting(w.key, new Date(t0.getTime() + 3 * SEC), new Date(atHold.getTime() - SEC));
    await fund(w.key, 2 * L - 1);
    expect((await claimRoom(w, wBoard, "home", atHold)).seat, "W takes the freed tokens and runs").toMatchObject({ reason: "camera_required" });
    // D presses again: a NEW stay, at the back (after the second waiting stay), with the reason it left.
    await fund(w.key, L);
    const again = await claimRoom(w, d, "home", atHold);
    expect(again.seat, "queued behind the waiting stay, not window_closed (the window is still open) and not admitted").toMatchObject({ reason: "queued", line: { left: "camera" } });
    expect((again.seat as { line: { position: number } }).line.position, "behind the waiting stay").toBe(2);
    expect((await stayRow(d.fixtureId, d.home.personId))?.first_claim_at, "a NEW stay").toEqual(atHold);
    const next = await claimRoom(w, d, "home", new Date(atHold.getTime() + 3 * SEC));
    expect(next.seat, "the reason is said once").toMatchObject({ reason: "queued", line: { left: null } });
  }, 180_000);

  it("the margin: a stay whose verdict read is the LAST step of the schedule, falling at ADMIT_HOLD_MS - 1 ms, is still admitted and protected and is served at that read", async () => {
    const w = world();
    const m = await seedBoard();
    await seatAndCount(w, m, "away", inWindow(2 * MIN));
    // The budget is dry: M's mint is deferred and M is HELD (in line), polling every 10 s until the pool can pay.
    await fund(w.key, 0);
    const A = new Date(DEADLINE.getTime() - 10 * SEC);
    const held = await claimRoom(w, m, "home", new Date(A.getTime() - 30 * SEC));
    expect(held.seat).toMatchObject({ reason: "queued" });
    for (const back of [20, 10]) await claimRoom(w, m, "home", new Date(A.getTime() - back * SEC));
    // M is admitted at A and mints.
    await fund(w.key, 100_000);
    const minted = await claimRoom(w, m, "home", A);
    expect(minted.seat, "admitted: the mint").toMatchObject({ reason: "camera_required" });
    expect((await stayRow(m.fixtureId, m.home.personId))?.admitted_at, "admitted at A").toEqual(A);
    // M's first read comes as late as the allowance allows; the verdict read is the last step of the schedule after it.
    const firstRead = new Date(A.getTime() + MINT_TO_READ_MS - 1);
    const lastRead = new Date(A.getTime() + ADMIT_HOLD_MS - 1);
    const lastStep = CAMERA_EVIDENCE_DEADLINE_MS + Math.max(...CAMERA_EVIDENCE_BACKOFF_MS);
    expect(lastRead.getTime() - firstRead.getTime(), "premise: the last read is the deadline plus the longest step after the first").toBe(lastStep);
    joinAt(w, minted.seat, new Date(firstRead.getTime() - 1_500)); // the SDK joined SEAT_RETRY_MS before the read; no report yet
    // The room's schedule: after the k-th read, wait cameraEvidenceDelayMs(k).
    const times = [firstRead.getTime()];
    for (const step of CAMERA_EVIDENCE_BACKOFF_MS) times.push(times.at(-1)! + step);
    times.push(lastRead.getTime());
    expect(times.at(-1), "the schedule ends at the last read").toBe(lastRead.getTime());
    const answers: string[] = [];
    for (const at of times) {
      if (at === lastRead.getTime()) cameraOn(w, minted.seat, new Date(at - SEC)); // the camera comes on just before the last read
      await fund(w.key, 100_000);
      const got = await claimRoom(w, m, "home", new Date(at));
      answers.push(got.seat?.seated ? "seated" : got.seat ? String(got.seat.reason) : "none");
    }
    expect(answers.at(-1), "M is served at the read that falls at ADMIT_HOLD_MS - 1 ms").toBe("seated");
    expect(answers.slice(0, -1).every((x) => x !== "seated" && x !== "window_closed" && x !== "queued"), `before it: not served, not ended, not restarted (${answers.join(",")})`).toBe(true);
    expect(lastRead.getTime(), "premise: past the deadline - protected").toBeGreaterThan(DEADLINE.getTime());
    expect((await stayRow(m.fixtureId, m.home.personId))?.served_at, "served").not.toBeNull();
  }, 180_000);
});
