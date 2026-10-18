// Capacity tests 27 (the cap), 28 (a counted check-in is never re-stamped) and 15 (c) (a place past the deadline), through the
// REAL claim, the REAL sweep and the REAL create (spec §8.1, §5.7.8). Every instant is derived from `DEADLINE_AFTER_MS` and
// `LINE_DEADLINE_GRACE_MS` (via window.ts's `boardCap`), never typed. The vendor is the in-memory RealtimeKit behind the REAL
// bucket; a camera that comes on late is `cameraOn` on its peer report, never a hand-set row.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { LINE_DEADLINE_GRACE_MS, boardAnchor, boardCap } from "@/server/external-play/window";
import { LINE_RECHECK_COST, LINE_RESERVATION } from "@/server/external-play/seat-line";
import { stampFixtureCheckIn } from "../me";
import { createGameIfReady } from "../external-play/create-game";
import { stayRow } from "./_external-play-line";
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
const R = LINE_RECHECK_COST;
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
  it("stampFixtureCheckIn with a window KEEPS a stamp inside it and replaces one outside; with no window (the QR path) it re-stamps as it always did", async () => {
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
    // No window: today's behaviour - re-stamped.
    const restamped = await stampFixtureCheckIn(b.home.personId, b.fixtureId, b.orgId, { at: new Date(first.getTime() + MIN) });
    expect(new Date(restamped.checked_in_at!), "the QR path (no window) re-stamps").toEqual(new Date(first.getTime() + MIN));
    // The window's edges are the window's own: the stamp AT the deadline is outside it.
    await sql`update fixture_availability set checked_in_at = ${DEADLINE} where fixture_id = ${b.fixtureId} and person_id = ${b.home.personId}`;
    const edge = await stampFixtureCheckIn(b.home.personId, b.fixtureId, b.orgId, { at: first, window: win });
    expect(new Date(edge.checked_in_at!), "a stamp AT the deadline is outside the window").toEqual(first);
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
});
