// Capacity tests 27 (the cap), 28 (a counted check-in is never re-stamped, the room's claim AND the QR scan) and 15 (c) (a place past the deadline), through the
// REAL claim, the REAL sweep and the REAL create (spec §8.1, §5.7.8). Every instant is derived from `DEADLINE_AFTER_MS` and
// `LINE_DEADLINE_GRACE_MS` (via window.ts's `boardCap`), never typed. The vendor is the in-memory RealtimeKit behind the REAL
// bucket; a camera that comes on late is `cameraOn` on its peer report, never a hand-set row.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { checkinClosesAt } from "@/components/public-site/match-room/room-snapshot";
import { LINE_DEADLINE_GRACE_MS, boardAnchor, boardCap } from "@/server/external-play/window";
import { LINE_RESERVATION, answerBusy, gateClaim, settleDeferral } from "@/server/external-play/seat-line";
import { checkInToFixture, stampFixtureCheckIn } from "../me";
import { createGameIfReady } from "../external-play/create-game";
import { askOf, putStay, stayRow } from "./_external-play-line";
import { CAMERA_ON_EVENTS } from "./_external-play-rtk-fake";
import {
  DEADLINE,
  MIN,
  OPENED,
  SEC,
  availability,
  claimRoom,
  dropWorlds,
  fixtureStatus,
  fund,
  inWindow,
  joinAt,
  pollStay,
  seatAndCount,
  seedBoard,
  sweepBoard,
  world,
  type Board,
  type World,
} from "./_external-play-line-route";

const DB = !!process.env.DATABASE_URL;
const L = LINE_RESERVATION;
const ANCHOR = boardAnchor(OPENED, 0, false);
const CAP = boardCap(ANCHOR);

afterEach(async () => {
  await dropWorlds();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (DB) await sql.end();
});

type Scene = { w: World; b: Board; arrival: Date };

/** HOME mints just before the deadline on a funded bucket (the stay passes on an idle line) and joins with its camera ON; then
 *  the budget runs dry: HOME's reads are deferred, HOME is IN LINE and polls every 10 s up to `until`. AWAY is seated and counted
 *  early iff `awayCounted`. The funded claim that admits and seats HOME is the test's own. */
async function homeInLine(o: { awayCounted: boolean; until: Date }): Promise<Scene> {
  const w = world();
  const b = await seedBoard();
  if (o.awayCounted) await seatAndCount(w, b, "away", inWindow(2 * MIN));
  await fund(w.key, 2 * L);
  const arrival = new Date(DEADLINE.getTime() - 25 * SEC);
  const minted = await claimRoom(w, b, "home", arrival);
  expect(minted.seat, "the mint answers camera_required").toMatchObject({ seated: false, reason: "camera_required" });
  joinAt(w, minted.seat, new Date(arrival.getTime() + SEC), CAMERA_ON_EVENTS);
  await fund(w.key, 0);
  const { last, claims } = await pollStay(w, b, "home", new Date(DEADLINE.getTime() - 20 * SEC), o.until);
  expect(claims, "anti-vacuity: the stay polled").toBeGreaterThan(3);
  expect(last.seat, "the dry budget holds the stay in line").toMatchObject({ seated: false, reason: "queued" });
  return { w, b, arrival };
}

/** The bucket refilled: HOME's next claim is admitted, runs, and (its camera being on) is seated. */
async function admitAndSeat(s: Scene, at: Date) {
  await fund(s.w.key, 2 * L);
  return claimRoom(s.w, s.b, "home", at);
}

describe.skipIf(!DB)("the cap, through the real claim (test 27, 15 (c))", () => {
  it("the seat pair: a protected player (in line, arrived in time) is admitted, seated, DATED at the arrival, counted, and the create runs at cap - 1 ms; at the cap the same read is window_closed and nothing runs", async () => {
    const pair: Record<string, { seated: boolean | undefined; reason: string | undefined; creates: number; phase: string; stamp: Date | null }> = {};
    for (const [name, readAt] of [
      ["cap - 1 ms", new Date(CAP.getTime() - 1)],
      ["the cap", CAP],
    ] as const) {
      const s = await homeInLine({ awayCounted: true, until: new Date(CAP.getTime() - 10 * SEC) });
      const read = await admitAndSeat(s, readAt);
      pair[name] = {
        seated: read.seat?.seated,
        reason: read.seat && !read.seat.seated ? read.seat.reason : undefined,
        creates: read.spies.create.mock.calls.length,
        phase: read.snapshot.phase,
        stamp: (await availability(s.b.fixtureId, s.b.home.personId))?.checked_in_at ?? null,
      };
      if (name === "cap - 1 ms") {
        expect(await availability(s.b.fixtureId, s.b.home.personId), "dated at the ARRIVAL, inside the window").toMatchObject({ checked_in_at: s.arrival });
        const stay = await stayRow(s.b.fixtureId, s.b.home.personId);
        expect(stay?.served_at, "served by the seat").not.toBeNull();
      }
    }
    expect(Object.keys(pair).length, "pairs checked").toBe(2);
    expect(pair["cap - 1 ms"], "at cap - 1 ms").toMatchObject({ seated: true, creates: 1, phase: "open" });
    expect(pair["the cap"], "at the cap").toMatchObject({ seated: false, reason: "window_closed", creates: 0, phase: "closed" });
    expect(pair["the cap"]!.stamp, "no check-in is written at the cap").toBeNull();
  }, 240_000);

  it("the no-show pair: a board with a protected player is SKIPPED until the cap (nothing forfeited, its room stays up); the absent opponent is forfeited when the protected player is served (the next pass), not before; and at the cap a player still in line takes the walkover", async () => {
    // (1) skipped one millisecond before the cap.
    const s = await homeInLine({ awayCounted: false, until: new Date(CAP.getTime() - 5 * SEC) });
    const before = await sweepBoard(s.b, new Date(CAP.getTime() - 1));
    expect(before.report.scanned, "the sweep looked at the board").toBeGreaterThanOrEqual(1);
    expect(before.report.noShows, "cap - 1 ms: skipped").toBe(0);
    expect(await fixtureStatus(s.b.fixtureId), "cap - 1 ms: nobody forfeited").toBe("scheduled");
    expect(before.ended, "cap - 1 ms: the room is not torn down").toEqual([]);

    // (2) the protected player is served: the NEXT pass (still before the cap) forfeits the absent opponent.
    const t = await homeInLine({ awayCounted: false, until: new Date(CAP.getTime() - 60 * SEC) });
    const skipped = await sweepBoard(t.b, new Date(CAP.getTime() - 50 * SEC));
    expect(skipped.report.noShows, "while the player is in line: skipped").toBe(0);
    const served = await admitAndSeat(t, new Date(CAP.getTime() - 45 * SEC));
    expect(served.seat?.seated, "HOME is served").toBe(true);
    const next = await sweepBoard(t.b, new Date(CAP.getTime() - 44 * SEC));
    expect(next.report.noShows, "the next pass forfeits the absent opponent").toBe(1);
    expect(await fixtureStatus(t.b.fixtureId)).toBe("forfeited");

    // (3) at the cap, a player STILL in line takes the normal walkover.
    const u = await homeInLine({ awayCounted: false, until: new Date(CAP.getTime() - 5 * SEC) });
    const atCap = await sweepBoard(u.b, CAP);
    expect(atCap.report.noShows, "at the cap: judged").toBe(1);
    expect(await fixtureStatus(u.b.fixtureId), "at the cap a player still in line takes the walkover").toBe("forfeited");
  }, 400_000);

  it("a player who FIRST arrives after the deadline gets window_closed, line or no line", async () => {
    const s = await homeInLine({ awayCounted: false, until: new Date(DEADLINE.getTime() + 20 * SEC) });
    const late = await seedBoard();
    const got = await claimRoom(s.w, late, "home", new Date(DEADLINE.getTime() + 25 * SEC));
    expect(got.seat, "the line is active and the arrival is late").toMatchObject({ seated: false, reason: "window_closed" });
    expect(await stayRow(late.fixtureId, late.home.personId), "no stay was made for it").toBeNull();
  }, 120_000);

  it("the create pair: owed past the deadline iff BOTH check-ins count, and until the cap - the real createGameIfReady refuses at the cap and goes on (to the play grant) one millisecond before it", async () => {
    vi.stubEnv("ONLINE_CHESS_ALWAYS", "1");
    const both = await seedBoard({ linked: false });
    // Both stamped inside the window (the dated check-in of a seat granted at arrival).
    for (const side of ["home", "away"] as const) {
      await stampFixtureCheckIn(both[side].personId, both.fixtureId, both.orgId, { at: inWindow(3 * MIN) });
    }
    const outcomes = [
      { name: "deadline + 1 ms", at: new Date(DEADLINE.getTime() + 1), owed: true },
      { name: "cap - 1 ms", at: new Date(CAP.getTime() - 1), owed: true },
      { name: "the cap", at: CAP, owed: false },
    ];
    let checked = 0;
    for (const o of outcomes) {
      const got = await createGameIfReady(both.fixtureId, { now: o.at });
      expect(got, o.name).toMatchObject({ created: false, reason: o.owed ? "lichess_link_required" : "not_ready" });
      checked += 1;
    }
    expect(checked, "instants checked").toBe(3);

    // One side counted alone owes nothing past the deadline - the control (the wrong answer is not the right one's constant).
    const one = await seedBoard({ linked: false });
    await stampFixtureCheckIn(one.home.personId, one.fixtureId, one.orgId, { at: inWindow(3 * MIN) });
    const alone = await createGameIfReady(one.fixtureId, { now: new Date(DEADLINE.getTime() + 1) });
    expect(alone, "one counted check-in does not owe the create").toMatchObject({ created: false, reason: "not_ready" });
    expect(CAP.getTime() - DEADLINE.getTime(), "the cap is the deadline plus the line's grace").toBe(LINE_DEADLINE_GRACE_MS);
  }, 120_000);
});

describe.skipIf(!DB)("a counted check-in is never re-stamped (test 28)", () => {
  it("stampFixtureCheckIn with a window KEEPS a stamp inside it and replaces one outside; with no window the primitive re-stamps (its callers choose: the room's claim and the QR scan of an opened round both hand it the window, below)", async () => {
    const b = await seedBoard();
    const win = { opensAt: ANCHOR.at, deadline: DEADLINE };
    const first = new Date(DEADLINE.getTime() - 5 * MIN);
    await stampFixtureCheckIn(b.home.personId, b.fixtureId, b.orgId, { at: first, window: win });
    // Inside the window: kept, whatever `at` says.
    const kept = await stampFixtureCheckIn(b.home.personId, b.fixtureId, b.orgId, { at: new Date(DEADLINE.getTime() + MIN), window: win });
    expect(new Date(kept.checked_in_at!), "a stamp inside the window is kept").toEqual(first);
    // Outside the window (an old stamp from before it opened): replaced.
    await sql`update fixture_availability set checked_in_at = ${new Date(ANCHOR.at.getTime() - MIN)} where fixture_id = ${b.fixtureId} and person_id = ${b.home.personId}`;
    const moved = await stampFixtureCheckIn(b.home.personId, b.fixtureId, b.orgId, { at: first, window: win });
    expect(new Date(moved.checked_in_at!), "a stamp outside the window is replaced").toEqual(first);
    // No window: the primitive's own contract (a fixture whose round was never opened has no window to hand) - re-stamped.
    const restamped = await stampFixtureCheckIn(b.home.personId, b.fixtureId, b.orgId, { at: new Date(first.getTime() + MIN) });
    expect(new Date(restamped.checked_in_at!), "with no window the primitive re-stamps").toEqual(new Date(first.getTime() + MIN));
    // The window's edges are the window's own: the stamp AT the deadline is outside it.
    await sql`update fixture_availability set checked_in_at = ${DEADLINE} where fixture_id = ${b.fixtureId} and person_id = ${b.home.personId}`;
    const edge = await stampFixtureCheckIn(b.home.personId, b.fixtureId, b.orgId, { at: first, window: win });
    expect(new Date(edge.checked_in_at!), "a stamp AT the deadline is outside the window").toEqual(first);
    // ...and the stamp AT the opening is inside it (the window is [opensAt, deadline), window.ts roomPhase).
    await sql`update fixture_availability set checked_in_at = ${win.opensAt} where fixture_id = ${b.fixtureId} and person_id = ${b.home.personId}`;
    const lower = await stampFixtureCheckIn(b.home.personId, b.fixtureId, b.orgId, { at: first, window: win });
    expect(new Date(lower.checked_in_at!), "a stamp AT the opening is inside the window and is kept").toEqual(win.opensAt);
  });

  it("a seated re-claim past the deadline leaves checked_in_at unchanged (both players counted, so the board is still open to them)", async () => {
    const w = world();
    const b = await seedBoard();
    await seatAndCount(w, b, "away", inWindow(2 * MIN));
    await seatAndCount(w, b, "home", inWindow(3 * MIN));
    const stamped = (await availability(b.fixtureId, b.home.personId))?.checked_in_at;
    expect(stamped, "premise: home is counted inside the window").toBeTruthy();
    const again = await claimRoom(w, b, "home", new Date(DEADLINE.getTime() + MIN));
    expect(again.seat?.seated, "re-seated past the deadline: both counted, the create is owed").toBe(true);
    expect((await availability(b.fixtureId, b.home.personId))?.checked_in_at, "the stamp did not move").toEqual(stamped);
  }, 60_000);

  // The QR self check-in (`checkInToFixture`, POST /api/checkin/[token]) is the OTHER writer of the stamp. It runs on the real clock, and
  // these boards' round opened at OPENED (a fixed past instant), so a scan here is always "after the deadline": that is asserted, not assumed.
  it("[reader:qr-checkin] the QR scan hands the board's window: a COUNTED check-in survives a scan after the deadline in an opened round; a fixture whose round was never opened keeps the re-stamp (2 cases, reported)", async () => {
    expect(Date.now(), "premise: the real clock is past this round's deadline, so every scan below is a late scan").toBeGreaterThan(DEADLINE.getTime());
    let checked = 0;

    // (1) An opened round: HOME is counted inside the window; the late scan keeps that stamp.
    const opened = await seedBoard();
    const counted = inWindow(3 * MIN);
    await stampFixtureCheckIn(opened.home.personId, opened.fixtureId, opened.orgId, { at: counted });
    const scanned = await checkInToFixture(opened.home.userId, opened.fixtureId);
    expect(new Date(scanned!.checked_in_at!), "the late scan kept the counted check-in").toEqual(counted);
    expect((await availability(opened.fixtureId, opened.home.personId))?.checked_in_at, "and so does the row").toEqual(counted);
    checked += 1;

    // (2) The control: no stamp row for the round, so no window - the scan re-stamps as it always did (a different answer from (1),
    // so (1) is not satisfied by a scan that never writes).
    const never = await seedBoard({ roundOpenedAt: undefined });
    const old = new Date(Date.now() - 60 * MIN);
    await stampFixtureCheckIn(never.home.personId, never.fixtureId, never.orgId, { at: old });
    const before = Date.now();
    const re = await checkInToFixture(never.home.userId, never.fixtureId);
    expect(new Date(re!.checked_in_at!).getTime(), "never opened: re-stamped to the scan's own instant").toBeGreaterThanOrEqual(before - 2_000);
    checked += 1;

    expect(checked, "cases driven").toBe(2);
  }, 60_000);

  it("the sequence: HOME checks in on time through the real claim, the QR is scanned after the deadline, the no-show sweep runs - HOME gets the walkover (AWAY forfeits), not a forfeit by both", async () => {
    const w = world();
    const b = await seedBoard();
    await seatAndCount(w, b, "home", inWindow(3 * MIN));
    const stamped = (await availability(b.fixtureId, b.home.personId))?.checked_in_at;
    expect(stamped, "premise: HOME is counted inside the window").toBeTruthy();
    expect(Date.now(), "premise: the scan below is after the deadline").toBeGreaterThan(DEADLINE.getTime());

    await checkInToFixture(b.home.userId, b.fixtureId);
    expect((await availability(b.fixtureId, b.home.personId))?.checked_in_at, "the late scan did not move the counted check-in").toEqual(stamped);

    const pass = await sweepBoard(b, new Date(DEADLINE.getTime() + MIN));
    expect(pass.report.noShows, "the sweep judged the board").toBe(1);
    expect(await fixtureStatus(b.fixtureId)).toBe("forfeited");
    const written = await sql<{ payload: { by: string; reason: string } }[]>`
      select payload from score_events where fixture_id = ${b.fixtureId} and type = 'core.forfeit' order by seq`;
    expect(
      written.map((e) => e.payload),
      "ONE walkover, against the absent AWAY - the player who came is not forfeited with them",
    ).toEqual([{ by: b.away.entrantId, reason: "walkover" }]);
  }, 120_000);
});

// Final review M-1: the window is judged on the APP's clock (claimRoomSeat's `now`) and a stay's `first_claim_at` was stamped on
// the DATABASE's clock at gate time, with the room's preamble between them (two room reads, the door read, the limiter, the stale
// bridge reset, the online-chess flag, the grant read - tenths of a second, more under the load in which the line forms). A claim
// judged `open` a moment before the deadline could therefore open a stay dated AFTER it: the card promised the cap, and the next
// poll answered `window_closed` because protection condition 2 is `first_claim_at < deadline`. The same class of defect as the
// check-in stamp (05e73438a), left on the line's order key. The gate now takes the judged instant as the stay's ARRIVAL.
//
// Two clocks, kept apart on purpose (the scenes' own rule): `now` is the claim's judged instant, `line.at` is the gate's clock - the
// database's, in production. Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only.
describe.skipIf(!DB)("the stay is dated where the window was judged (final review M-1)", () => {
  /** HOME's first claim on a dry bucket: judged at `judged`, the gate running on `gate`. The mint is deferred, so the stay is held. */
  async function firstClaim(judged: Date, gate: Date) {
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 0);
    const got = await claimRoom(w, b, "home", judged, { line: { at: gate } });
    return { w, b, got };
  }

  it("judged 1 ms before the deadline, gated after it (the app's clock behind the database's): the stay is dated at the judged instant, so it is protected and the NEXT poll is not window_closed", async () => {
    const judged = new Date(DEADLINE.getTime() - 1);
    const gate = new Date(DEADLINE.getTime() + SEC);
    expect(gate.getTime(), "premise: the two clocks DIFFER and straddle the deadline").toBeGreaterThan(DEADLINE.getTime());
    const { w, b, got } = await firstClaim(judged, gate);
    expect(got.seat, "premise: the dry bucket holds the claim in line").toMatchObject({ seated: false, reason: "queued" });
    const stay = await stayRow(b.fixtureId, b.home.personId);
    expect(stay?.first_claim_at, "the arrival is where the window was judged, not where the database's clock read at gate time").toEqual(judged);
    expect(stay?.last_seen_at, "liveness stays on the gate's clock").toEqual(gate);
    expect(stay!.first_claim_at.getTime(), "protection condition 2: arrived before the deadline").toBeLessThan(DEADLINE.getTime());
    // The player's next poll, after the deadline on a single clock, is held - not told the window is closed.
    const next = await claimRoom(w, b, "home", new Date(gate.getTime() + 5 * SEC));
    expect(next.seat, "the next poll is held in line").toMatchObject({ seated: false, reason: "queued" });
    expect(next.snapshot.phase, "the board still reads open to the protected player").toBe("open");
  }, 60_000);

  it("the pair: judged AT the deadline is window_closed with no stay at all (nothing to date), and the clocks agreeing 1 ms before it keeps the stay too", async () => {
    // (1) AT the deadline: the seat refuses before the gate is ever reached.
    const at = await firstClaim(DEADLINE, new Date(DEADLINE.getTime() + SEC));
    expect(at.got.seat, "judged at the deadline").toMatchObject({ seated: false, reason: "window_closed" });
    expect(await stayRow(at.b.fixtureId, at.b.home.personId), "no stay was opened").toBeNull();
    // (2) One clock, 1 ms before: unchanged by the fix.
    const judged = new Date(DEADLINE.getTime() - 1);
    const agree = await firstClaim(judged, judged);
    expect((await stayRow(agree.b.fixtureId, agree.b.home.personId))?.first_claim_at).toEqual(judged);
  }, 60_000);

  it("the other direction (the app's clock AHEAD of the database's): the arrival is never later than the gate's own clock, so no stay is dated after it was last seen", async () => {
    const judged = new Date(DEADLINE.getTime() - 1);
    const gate = new Date(DEADLINE.getTime() - 5 * SEC);
    const { b, got } = await firstClaim(judged, gate);
    expect(got.seat, "premise: held in line").toMatchObject({ seated: false, reason: "queued" });
    const stay = await stayRow(b.fixtureId, b.home.personId);
    expect(stay?.first_claim_at, "least(judged, the gate's clock)").toEqual(gate);
    expect(stay!.queued_at!.getTime(), "the ledger's own check: queued_at >= first_claim_at").toBeGreaterThanOrEqual(stay!.first_claim_at.getTime());
  }, 60_000);

  it("every way a stay can be OPENED honours the judged instant - the gate, the busy answer, and the mid-claim deferral (which restarts a stay the claim just served) - at the gate's own clock a second later", async () => {
    const judged = new Date(DEADLINE.getTime() - 1);
    const gate = new Date(DEADLINE.getTime() + SEC);
    const w = world();
    await fund(w.key, 0);
    const arrivals: Record<string, Date | undefined> = {};
    // The gate and the busy answer: no stay yet, so each creates one.
    for (const [name, open] of [
      ["gateClaim", (a: ReturnType<typeof askOf>) => gateClaim(a)],
      ["answerBusy", (a: ReturnType<typeof askOf>) => answerBusy(a)],
    ] as const) {
      const b = await seedBoard();
      await open(askOf(w.key, b, "home", gate, { anchor: ANCHOR, arrival: judged }));
      arrivals[name] = (await stayRow(b.fixtureId, b.home.personId))?.first_claim_at;
    }
    // The deferral: the stay was served a moment ago, so settling it starts a NEW one (spec §5.7.5, restart on served).
    const served = await seedBoard();
    await putStay({
      fixtureId: served.fixtureId, personId: served.home.personId, budgetKey: w.key,
      firstClaimAt: new Date(judged.getTime() - 60 * SEC), servedAt: new Date(judged.getTime() - 30 * SEC), gate: "passed",
    });
    await settleDeferral(askOf(w.key, served, "home", gate, { anchor: ANCHOR, arrival: judged }));
    arrivals.settleDeferral = (await stayRow(served.fixtureId, served.home.personId))?.first_claim_at;
    expect(arrivals, "each opening path dated its stay at the judged instant").toEqual({ gateClaim: judged, answerBusy: judged, settleDeferral: judged });
  }, 60_000);

  it("the room hands the judged instant to the deferral too: a claim whose seat is cut short by the budget, on a stay it just restarted, is dated where the window was judged", async () => {
    const judged = new Date(DEADLINE.getTime() - 1);
    const gate = new Date(DEADLINE.getTime() + SEC);
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 0);
    // A stay already served: the deferral's upsert restarts it. The seat is stubbed to the budget's cut-short answer so the claim
    // goes straight to the room's `queueDeferred` (the gate has nothing to say about a stay it never saw).
    await putStay({
      fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: w.key,
      firstClaimAt: new Date(judged.getTime() - 60 * SEC), servedAt: new Date(judged.getTime() - 30 * SEC), gate: "passed",
    });
    const deferred = { seated: false, reason: "camera_starting", participant: null, budgetDeferred: true };
    const got = await claimRoom(w, b, "home", judged, { line: { at: gate }, seat: (async () => deferred) as never });
    expect(got.seat, "premise: the deferral queued the restarted stay").toMatchObject({ seated: false, reason: "queued" });
    expect((await stayRow(b.fixtureId, b.home.personId))?.first_claim_at).toEqual(judged);
  }, 60_000);
});

// Final review M-3, the producer's side: the snapshot a PROTECTED viewer is handed past the deadline reads `open` (spec §5.7.8) and the
// room's check-in card counted down to a deadline that had passed ("closes in 0:00"). The room now asks `checkinClosesAt` of exactly
// this snapshot - driven here through the REAL claim, never a fixture, because a snapshot typed into a test proves the test.
describe.skipIf(!DB)("a protected viewer's snapshot names the board's cap as where the check-in closes (final review M-3)", () => {
  it("held in line past the deadline: phase open, serverNow past the deadline, and the closing time is the cap - the unprotected viewer's is the deadline", async () => {
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 0);
    const arrival = new Date(DEADLINE.getTime() - 20 * SEC);
    const first = await claimRoom(w, b, "home", arrival);
    expect(first.seat, "premise: held in line").toMatchObject({ seated: false, reason: "queued" });
    expect(checkinClosesAt(first.snapshot), "inside the window: the deadline").toBe(DEADLINE.toISOString());

    const past = new Date(DEADLINE.getTime() + MIN);
    // The player keeps the page open: a poll every 10 s, so the stay stays live right up to a minute past the deadline.
    const { last: next, claims } = await pollStay(w, b, "home", new Date(arrival.getTime() + 10 * SEC), past);
    expect(claims, "anti-vacuity: the stay polled across the deadline").toBeGreaterThan(5);
    expect(next.seat, "premise: still held in line").toMatchObject({ seated: false, reason: "queued" });
    expect(next.snapshot.phase, "premise: still open for the protected viewer").toBe("open");
    expect(Date.parse(next.snapshot.serverNow), "premise: composed past the deadline").toBeGreaterThan(DEADLINE.getTime());
    expect(Date.parse(next.snapshot.deadline!), "premise: the wire still carries the deadline").toBe(DEADLINE.getTime());
    expect(checkinClosesAt(next.snapshot), "the protected viewer's check-in closes at the cap").toBe(CAP.toISOString());
    expect(CAP.getTime() - DEADLINE.getTime(), "premise: the cap is the grace past the deadline").toBe(LINE_DEADLINE_GRACE_MS);

    // The pair: AWAY never came, holds no stay, and is closed out past the deadline - their closing time stays the deadline.
    const away = await claimRoom(w, b, "away", past);
    expect(away.snapshot.phase, "premise: closed for the viewer nothing protects").toBe("closed");
    expect(checkinClosesAt(away.snapshot)).toBe(DEADLINE.toISOString());
  }, 60_000);
});
