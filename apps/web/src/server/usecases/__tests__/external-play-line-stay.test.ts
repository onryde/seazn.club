// Capacity tests 15 (the place survives the pass), through the REAL claim (`claimRoomSeat` -> `seatPlayer` -> the gate -> the T7
// adapter) against the in-memory RealtimeKit (spec §8.1, §5.7.3, §5.7.8). A camera that comes on late is `cameraOn` on the fixture's
// peer report - never a hand-set row; the stay rows are only READ back. The bucket holds a stated level and refills nothing
// (`fund`), so a shortfall is never hidden by a refill.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { LINE_ABANDON_AFTER_MS, MINT_TO_READ_MS } from "@/components/public-site/match-room/room-snapshot";
import { LINE_RECHECK_COST, LINE_RELEASE_GRACE_MS, LINE_RESERVATION } from "@/server/external-play/seat-line";
import { LINE_DEADLINE_GRACE_MS, boardCap } from "@/server/external-play/window";
import { stayRow } from "./_external-play-line";
import { CAMERA_ON_EVENTS } from "./_external-play-rtk-fake";
import {
  DEADLINE,
  MIN,
  OPENED,
  availability,
  cameraOn,
  claimRoom,
  dropWorlds,
  fund,
  inWindow,
  joinAt,
  seedBoard,
  world,
  type Board,
  type World,
} from "./_external-play-line-route";

const DB = !!process.env.DATABASE_URL;
const L = LINE_RESERVATION;
const R = LINE_RECHECK_COST;
const SEC = 1_000;

afterEach(dropWorlds);
afterAll(async () => {
  if (DB) await sql.end();
});

/** `side`'s first two claims at `at` and `at + 1 s`: the mint, a browser that joins with a camera ON, and the seat. The line is
 *  idle and the bucket funded, so this is today's path. Leaves the player SEATED and COUNTED. */
async function seatAndCount(w: World, b: Board, side: "home" | "away", at: Date): Promise<void> {
  await fund(w.key, 300);
  const minted = await claimRoom(w, b, side, at);
  expect(minted.seat, `${side}: the mint answers camera_required with a token`).toMatchObject({ seated: false, reason: "camera_required" });
  joinAt(w, minted.seat, at, CAMERA_ON_EVENTS);
  const seated = await claimRoom(w, b, side, new Date(at.getTime() + SEC));
  expect(seated.seat?.seated, `${side}: seated`).toBe(true);
}

describe.skipIf(!DB)("a place survives the pass: mint, then read, through the real route (test 15)", () => {
  it("(a)(b) a mint DEFERRED by the budget is `queued`; once funded the claim is admitted and answers the real camera_required with a token, the stay stays in line and funded across the read, a later arrival is blocked (not overtaking), and the read needs no second admission", async () => {
    const w = world();
    const b = await seedBoard();
    const base = inWindow(2 * MIN);
    await seatAndCount(w, b, "away", base);

    // The mint is deferred: the budget is empty. The answer is `queued`, and nothing reached the vendor.
    await fund(w.key, 0);
    const calls0 = w.rtk.http.length;
    const t1 = new Date(base.getTime() + 10 * SEC);
    const queued = await claimRoom(w, b, "home", t1);
    expect(queued.seat, "a deferred mint is queued").toMatchObject({ seated: false, reason: "queued", participant: null });
    expect(queued.seat && "line" in queued.seat ? queued.seat.line.position : null, "alone in the line").toBe(1);
    expect(w.rtk.http.length, "the deferred mint made no vendor request").toBe(calls0);
    const waiting = await stayRow(b.fixtureId, b.home.personId);
    expect(waiting?.queued_at, "held: the place is the first claim").toEqual(t1);
    expect(waiting?.last_gate).toBe("held");
    expect(waiting?.admitted_at).toBeNull();

    // Funded for exactly one COMPLETING stay (the board's other side is counted): the stay is admitted and the claim runs.
    await fund(w.key, L + R);
    const t2 = new Date(base.getTime() + 13 * SEC);
    const minted = await claimRoom(w, b, "home", t2);
    expect(minted.seat, "the real answer of a minting claim: camera_required, with a token to join").toMatchObject({
      seated: false,
      reason: "camera_required",
    });
    expect(minted.seat && "participant" in minted.seat ? minted.seat.participant : null, "the token").not.toBeNull();
    const admitted = await stayRow(b.fixtureId, b.home.personId);
    expect(admitted?.admitted_at, "admitted at this claim").toEqual(t2);
    expect(admitted?.completing, "the board's other side is counted").toBe(true);
    expect(admitted?.last_gate, "the pass").toBe("passed");
    expect([admitted?.ended_at, admitted?.served_at], "a camera_required does not end the stay").toEqual([null, null]);
    expect(admitted?.first_claim_at, "the arrival is the FIRST claim").toEqual(t1);

    // (a) Between the mint and the read a later arrival X is blocked: the pool holds one token under X's reservation ONLY IF the
    // admitted stay's reservation is still counted. Zero vendor requests, and X is held (a waiting stay), not overtaking.
    await fund(w.key, 2 * L + R - 1);
    const x = await seedBoard();
    const callsBefore = w.rtk.http.length;
    const xAnswer = await claimRoom(w, x, "home", new Date(base.getTime() + 14 * SEC));
    expect(xAnswer.seat, "X is queued behind the admitted stay").toMatchObject({ seated: false, reason: "queued" });
    expect(w.rtk.http.length, "X spent nothing").toBe(callsBefore);
    expect((await stayRow(x.fixtureId, x.home.personId))?.admitted_at, "X is not admitted").toBeNull();

    // (b) The browser joins; the camera comes on; the READ claim arrives MINT_TO_READ_MS after the mint's answer.
    joinAt(w, minted.seat, t2);
    const readAt = new Date(t2.getTime() + MINT_TO_READ_MS);
    cameraOn(w, minted.seat, new Date(readAt.getTime() - 4 * SEC));
    await fund(w.key, 10);
    expect(MINT_TO_READ_MS, "the read is inside the release grace (so the stay is live), by the constants").toBeLessThan(LINE_RELEASE_GRACE_MS);
    const read = await claimRoom(w, b, "home", readAt);
    expect(read.seat?.seated, "seated at the read").toBe(true);
    const served = await stayRow(b.fixtureId, b.home.personId);
    expect(served?.admitted_at, "no second admission: the admission is the mint's").toEqual(t2);
    expect(served?.served_at, "served by the seat").not.toBeNull();
    expect(read.create, "both sides counted: the game is asked for").toHaveBeenCalledTimes(1);
    expect(w.rtk.adapter.filter((c) => c === "addParticipant:player").length, "one participant minted in the whole stay").toBe(2);
  }, 60_000);

  it("(c) past the deadline and inside the cap the READ is admitted, seated, dated first_claim_at, counted, and the game is created", async () => {
    const w = world();
    const b = await seedBoard();
    await seatAndCount(w, b, "away", inWindow(2 * MIN));
    // Arrival 20 s before the deadline, held; admitted 3 s after; the read 31.5 s after that lands PAST the deadline.
    const arrival = new Date(DEADLINE.getTime() - 20 * SEC);
    await fund(w.key, 0);
    const first = await claimRoom(w, b, "home", arrival);
    expect(first.seat).toMatchObject({ reason: "queued" });
    await fund(w.key, L + R);
    const mintAt = new Date(arrival.getTime() + 3 * SEC);
    const minted = await claimRoom(w, b, "home", mintAt);
    expect(minted.seat).toMatchObject({ reason: "camera_required" });
    joinAt(w, minted.seat, mintAt);
    const readAt = new Date(mintAt.getTime() + MINT_TO_READ_MS);
    expect(readAt.getTime(), "premise: the read is PAST the deadline").toBeGreaterThan(DEADLINE.getTime());
    expect(readAt.getTime(), "premise: and inside the cap").toBeLessThan(boardCap(boardOfOpened()).getTime());
    cameraOn(w, minted.seat, new Date(readAt.getTime() - 4 * SEC));
    await fund(w.key, 10);
    const read = await claimRoom(w, b, "home", readAt);
    expect(read.seat?.seated, "seated past the deadline: the player came in time").toBe(true);
    expect((await availability(b.fixtureId, b.home.personId))?.checked_in_at, "dated at the ARRIVAL, inside the window").toEqual(arrival);
    expect(read.snapshot.you.checkedIn, "and it counts").toBe(true);
    expect(read.snapshot.phase, "the room is still open for this player").toBe("open");
    expect(read.create, "the game is created at the read").toHaveBeenCalledTimes(1);
  }, 60_000);
});

function boardOfOpened() {
  // The scenes' batch-0 anchor for the round opened at OPENED.
  return boardAnchorOfOpened;
}
import { boardAnchor } from "@/server/external-play/window";
const boardAnchorOfOpened = boardAnchor(OPENED, 0, false);

void [LINE_ABANDON_AFTER_MS, LINE_DEADLINE_GRACE_MS];
