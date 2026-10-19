// Capacity test 14 (c): the reservation covers a WHOLE stay (spec §8.1, the re-review 2's I-B, §5.6.8). Each stay is driven through
// the real claim (`claimRoomSeat` -> `seatPlayer` -> the T7 adapter) against the in-memory RealtimeKit, on the room's own schedule
// (`cameraEvidenceDelayMs`), and the FIXTURE SERVER's own request count for that stay is compared with a cost computed here from the
// schedule and the fixture's counts - never from a `LINE_*` constant, which it must then equal.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import {
  CAMERA_EVIDENCE_BACKOFF_MS,
  CAMERA_EVIDENCE_DEADLINE_MS,
  CAMERA_EVIDENCE_MAX_POLLS,
  MINT_TO_READ_MS,
  SEAT_RETRIES,
  SEAT_RETRY_MS,
  cameraEvidenceDelayMs,
} from "@/components/public-site/match-room/room-snapshot";
import { RETIRED_PAIR } from "@/server/external-play/video/realtimekit";
import {
  ADMIT_HOLD_MS,
  LINE_CLAIM_COST,
  LINE_LOCK_TIMEOUT_MS,
  LINE_MINT_CALLS,
  LINE_READ_CALLS,
  LINE_RECHECK_COST,
  LINE_RELEASE_GRACE_MS,
  LINE_RESERVATION,
  LINE_TOKEN_CALLS,
} from "@/server/external-play/seat-line";
import { LINE_POLL_MS, LINE_POLL_MIN_MS } from "@/components/public-site/match-room/room-snapshot";
import { SEAT_RECHECK_TRUST_MS, seatPlayer } from "../external-play/preflight";
import { CAMERA_ON_EVENTS } from "./_external-play-rtk-fake";
import {
  MIN,
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
const SEC = 1_000;

afterEach(dropWorlds);
afterAll(async () => {
  if (DB) await sql.end();
});

/** The fixture server's own vocabulary: how many requests of each kind a log holds. */
const ROUTES = {
  create: /^POST \/meetings$/,
  add: /^POST \/meetings\/[^/]+\/participants$/,
  end: /^(POST \/meetings\/[^/]+\/active-session\/kick-all|PATCH \/meetings\/[^/]+)$/,
  token: /^POST \/meetings\/[^/]+\/participants\/[^/]+\/token$/,
  session: /^GET \/meetings\/[^/]+\/active-session$/,
  participants: /^GET \/sessions\/[^/]+\/participants$/,
  peerReport: /^GET \/sessions\/peer-report\/[^/]+$/,
};
const count = (log: string[], re: RegExp) => log.filter((l) => re.test(l)).length;

/** The offset from the browser's join of the k-th read (1-based) on the room's schedule: the first read at the join, then each
 *  after the back-off step the previous read earned. */
function readOffsetMs(k: number): number {
  let t = 0;
  for (let i = 1; i < k; i++) t += cameraEvidenceDelayMs(i);
  return t;
}

type Case = { name: string; warmupMs: number | "never"; vendorAheadMs?: number };
type Stay = { name: string; reads: number; realized: number; verdict: string; seated: boolean; verdictAt: Date };

/** One stay, from its mint to its verdict, claim by claim on the schedule. The camera turns on `warmupMs` after the join (or
 *  never); `vendorAheadMs` is how far the vendor's clock runs ahead of ours (the join is read as later by that much). */
async function driveStay(w: World, b: Board, c: Case): Promise<Stay> {
  await fund(w.key, 100_000);
  const before = w.rtk.http.length;
  const mintAt = inWindow(2 * MIN);
  const minted = await claimRoom(w, b, "home", mintAt);
  expect(minted.seat, `${c.name}: the mint answers camera_required with a token`).toMatchObject({ seated: false, reason: "camera_required" });
  const joined = new Date(mintAt.getTime() + 5 * SEC);
  joinAt(w, minted.seat, new Date(joined.getTime() + (c.vendorAheadMs ?? 0)));
  let on = false;
  for (let k = 1; k <= 12; k++) {
    const at = new Date(joined.getTime() + readOffsetMs(k));
    if (c.warmupMs !== "never" && !on && readOffsetMs(k) >= c.warmupMs) {
      cameraOn(w, minted.seat, at);
      on = true;
    }
    const got = await claimRoom(w, b, "home", at);
    if (got.seat?.seated || got.seat?.reason !== "camera_starting") {
      return {
        name: c.name,
        reads: k,
        realized: w.rtk.http.length - before,
        verdict: got.seat?.seated ? "seated" : String(got.seat?.reason),
        seated: got.seat?.seated === true,
        verdictAt: at,
      };
    }
  }
  throw new Error(`${c.name}: no verdict in 12 reads`);
}

describe.skipIf(!DB)("a whole stay costs what the reservation says (test 14 (c))", () => {
  it("8 cameras on the room's schedule: each stay's realized requests EQUAL the cost computed from the schedule and the fixture's counts, none exceeds LINE_RESERVATION, and the worst case reaches it", async () => {
    // The fixture's own counts, measured from a probe stay (never typed, never a LINE_* constant).
    const probeW = world();
    const probeBoard = await seedBoard();
    await fund(probeW.key, 100_000);
    const m0 = probeW.rtk.http.length;
    const probeMint = await claimRoom(probeW, probeBoard, "home", inWindow(2 * MIN));
    const mintLog = probeW.rtk.http.slice(m0);
    joinAt(probeW, probeMint.seat, inWindow(2 * MIN + 5 * SEC));
    const r0 = probeW.rtk.http.length;
    const startingRead = await claimRoom(probeW, probeBoard, "home", inWindow(2 * MIN + 5 * SEC));
    expect(startingRead.seat, "the probe's read finds a camera still starting").toMatchObject({ reason: "camera_starting" });
    const readLog = probeW.rtk.http.slice(r0);
    cameraOn(probeW, probeMint.seat, inWindow(2 * MIN + 6 * SEC));
    const s0 = probeW.rtk.http.length;
    const seat = await claimRoom(probeW, probeBoard, "home", inWindow(2 * MIN + 6 * SEC));
    expect(seat.seat?.seated, "the probe's third claim seats").toBe(true);
    const seatLog = probeW.rtk.http.slice(s0);

    const fixture = { mint: mintLog.length, read: readLog.length, token: count(seatLog, ROUTES.token) };
    expect(mintLog.map((l) => l.replace(/\/meetings\/[^/]+/, "/meetings/:id")), "a mint is the meeting's create and the participant's add").toEqual([
      "POST /meetings",
      "POST /meetings/:id/participants",
    ]);
    expect(count(readLog, ROUTES.session) + count(readLog, ROUTES.participants) + count(readLog, ROUTES.peerReport), "a read is the live session, its participants, the peer report").toBe(fixture.read);
    expect(fixture, "the fixture's counts").toEqual({ mint: 2, read: 3, token: 1 });
    // The declared counts equal the fixture's own (the first of the two things this test is for).
    expect({ mint: LINE_MINT_CALLS, read: LINE_READ_CALLS, token: LINE_TOKEN_CALLS }, "LINE_*_CALLS equal the fixture's counts").toEqual(fixture);

    // The schedule: the first read at the join, each next after the back-off step the previous earned.
    const readsToSee = (warmupMs: number) => {
      for (let k = 1; k <= 12; k++) if (readOffsetMs(k) >= warmupMs) return k;
      throw new Error("no read sees it");
    };
    const readsToVerdict = (aheadMs: number) => {
      for (let k = 1; k <= 12; k++) if (readOffsetMs(k) - aheadMs >= CAMERA_EVIDENCE_DEADLINE_MS) return k;
      throw new Error("no read reaches the deadline");
    };
    const cost = (reads: number) => fixture.mint + reads * fixture.read + fixture.token;

    const cases: Case[] = [
      ...[0, 1, 3, 5, 10, 15].map((s): Case => ({ name: `camera on after ${s} s`, warmupMs: s * SEC })),
      { name: "a camera that never comes on", warmupMs: "never" },
      // The verdict one back-off step late: the vendor's clock runs half a second ahead, so the read AT the deadline still reads
      // a wait under it and the next read (one back-off step later) is the verdict.
      { name: "a camera that never comes on, verdict one back-off step late", warmupMs: "never", vendorAheadMs: 500 },
    ];
    const stays: Stay[] = [];
    for (const c of cases) stays.push(await driveStay(world(), await seedBoard(), c));
    expect(stays.length, "anti-vacuity: 8 stays driven").toBe(8);

    const expectedReads = [...[0, 1, 3, 5, 10, 15].map((s) => readsToSee(s * SEC)), readsToVerdict(0), readsToVerdict(500)];
    expect(
      stays.map((s) => ({ name: s.name, reads: s.reads, realized: s.realized })),
      "each stay's realized requests are the schedule's cost",
    ).toEqual(stays.map((s, i) => ({ name: s.name, reads: expectedReads[i]!, realized: cost(expectedReads[i]!) })));
    expect(
      stays.map((s) => s.realized),
      "the table (spec §5.6.8)",
    ).toEqual([6, 9, 12, 15, 18, 18, 18, 21]);
    expect(stays.slice(0, 6).every((s) => s.seated), "the six warm-ups end in a seat").toBe(true);
    expect(stays.slice(6).map((s) => s.verdict), "the two dead cameras end in the camera refusal").toEqual(["camera_required", "camera_required"]);
    expect(stays[7]!.reads, "the late verdict is a read past the deadline's, one step later").toBe(stays[6]!.reads + 1);

    for (const s of stays) expect(s.realized, `${s.name}: the reservation covers it`).toBeLessThanOrEqual(LINE_RESERVATION);
    expect(Math.max(...stays.map((s) => s.realized)), "the worst case reaches the reservation, so a reservation above it is noticed").toBe(LINE_RESERVATION);
    expect(LINE_RESERVATION, "the reservation is built from the three counts and the room's polls").toBe(
      LINE_MINT_CALLS + LINE_READ_CALLS * CAMERA_EVIDENCE_MAX_POLLS + (LINE_READ_CALLS + LINE_TOKEN_CALLS),
    );
  }, 120_000);

  it("P1 - the client re-claims a refused seat SEAT_RETRIES times after a dead camera's verdict, and each re-claim costs vendor calls the reservation does NOT cover: measured, listed, and bounded by the grace", async () => {
    const w = world();
    const b = await seedBoard();
    const dead = await driveStay(w, b, { name: "a camera that never comes on", warmupMs: "never" });
    expect(dead.verdict, "premise: the verdict is the camera refusal, the answer that sets the client re-claiming").toBe("camera_required");
    expect(dead.realized, "premise: the stay itself cost its reservation exactly (the table's 18, under LINE_RESERVATION)").toBeLessThanOrEqual(LINE_RESERVATION);

    // The room's own schedule (room-shell.tsx: a refusal for want of a camera, the camera live): SEAT_RETRIES more claims, SEAT_RETRY_MS apart.
    const perReclaim: { reads: number; tokens: number; mints: number; other: number; total: number }[] = [];
    for (let n = 1; n <= SEAT_RETRIES; n++) {
      const c0 = w.rtk.http.length;
      const again = await claimRoom(w, b, "home", new Date(dead.verdictAt.getTime() + n * SEAT_RETRY_MS));
      expect(again.seat, `re-claim ${n}: the refusal stands`).toMatchObject({ seated: false, reason: "camera_required" });
      const log = w.rtk.http.slice(c0);
      const reads = count(log, ROUTES.session) + count(log, ROUTES.participants) + count(log, ROUTES.peerReport);
      const tokens = count(log, ROUTES.token);
      const mints = count(log, ROUTES.create) + count(log, ROUTES.add);
      perReclaim.push({ reads, tokens, mints, other: log.length - reads - tokens - mints, total: log.length });
    }
    expect(perReclaim.length, "anti-vacuity: the client's whole re-claim budget was driven").toBe(SEAT_RETRIES);
    // What a re-claim is, from the fixture's own log: one read (its three requests) and a fresh token, never a mint.
    for (const r of perReclaim) expect(r, "a re-claim is a read and a token").toEqual({ reads: 3, tokens: 1, mints: 0, other: 0, total: 4 });

    const overspend = perReclaim.reduce((a, r) => a + r.total, 0);
    const stayTotal = w.rtk.http.length; // every request this world's fixture has seen: the stay and its re-claims
    expect(stayTotal, "the stay's whole spend is its schedule's cost plus the re-claims").toBe(dead.realized + overspend);
    expect(stayTotal, "the re-claims take the stay PAST its reservation: the overspend is real and is not covered (seat-line.ts lists it)").toBeGreaterThan(LINE_RESERVATION);
    // The listed figure (the comment beside LINE_RESERVATION): SEAT_RETRIES x (one read + one token), from the declared counts.
    expect(overspend, "SEAT_RETRIES x (a read and a token)").toBe(SEAT_RETRIES * (LINE_READ_CALLS + LINE_TOKEN_CALLS));
    // It all lands inside the release grace, so the stay's silence after it still ends its reservation on the grace's clock.
    expect(SEAT_RETRIES * SEAT_RETRY_MS, "the re-claims finish well inside the release grace").toBeLessThan(LINE_RELEASE_GRACE_MS);
  }, 120_000);

  it("the largest ONE claim (a minting claim on a re-paired board: two stale meetings ended, a create, an add) is LINE_CLAIM_COST, and the reservation is at least that; the re-verify costs LINE_RECHECK_COST (m4)", async () => {
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 100_000);
    // Both players' meetings were made for another pairing (re-paired): stamped with the nil pair, which no entrant has.
    for (const [side, meeting] of [["home", `stale-${b.fixtureId}-h`], ["away", `stale-${b.fixtureId}-a`]] as const) {
      await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
        values (${b.fixtureId}, ${side}, ${b.orgId}, ${meeting}, ${RETIRED_PAIR}, ${RETIRED_PAIR})`;
    }
    const before = w.rtk.http.length;
    const minted = await claimRoom(w, b, "home", inWindow(2 * MIN));
    expect(minted.seat, "the re-paired board's mint").toMatchObject({ reason: "camera_required" });
    const log = w.rtk.http.slice(before);
    expect(count(log, ROUTES.end), "two stale meetings, each kicked and set inactive").toBe(4);
    expect(count(log, ROUTES.create) + count(log, ROUTES.add), "its own meeting and the participant").toBe(2);
    expect(log.length, "the whole claim, measured at the fixture server").toBe(6);
    expect(LINE_CLAIM_COST, "the declared maximum of one claim equals the measured one").toBe(log.length);
    expect(LINE_RESERVATION, "the reservation covers the largest claim").toBeGreaterThanOrEqual(log.length);

    // The re-verify (T9's recheck): home is seated, then re-read after the trust window by the server alone.
    joinAt(w, minted.seat, inWindow(2 * MIN + 5 * SEC), CAMERA_ON_EVENTS);
    const seated = await claimRoom(w, b, "home", inWindow(2 * MIN + 6 * SEC));
    expect(seated.seat?.seated).toBe(true);
    const r0 = w.rtk.http.length;
    const later = inWindow(2 * MIN + 6 * SEC + SEAT_RECHECK_TRUST_MS + SEC);
    const recheck = await seatPlayer({ fixtureId: b.fixtureId, personId: b.home.personId, recheck: true }, { now: later, video: w.rtk.video });
    expect(recheck.seated, "the re-verify finds the camera on").toBe(true);
    expect(w.rtk.http.length - r0, "the re-verify is one read").toBe(3);
    expect(LINE_RECHECK_COST, "LINE_RECHECK_COST is at least the re-verify's count").toBeGreaterThanOrEqual(w.rtk.http.length - r0);
  }, 60_000);

  it("the line's time constants keep their floors: the release grace, the admit hold and the lock timeout, derived from the room's declarations", () => {
    const longestBackoff = Math.max(...CAMERA_EVIDENCE_BACKOFF_MS);
    expect(CAMERA_EVIDENCE_BACKOFF_MS.length, "anti-vacuity: the back-off table has steps").toBeGreaterThan(0);
    expect(LINE_RELEASE_GRACE_MS, "a pass outlives the longest honest gap before the next claim").toBeGreaterThanOrEqual(
      Math.max(longestBackoff, MINT_TO_READ_MS) + LINE_POLL_MS,
    );
    expect(ADMIT_HOLD_MS, "the dead-camera bound is never under the grace").toBeGreaterThanOrEqual(LINE_RELEASE_GRACE_MS);
    expect(ADMIT_HOLD_MS, "the dead-camera bound is the mint-to-read gap, the server's wait and one step").toBe(
      MINT_TO_READ_MS + CAMERA_EVIDENCE_DEADLINE_MS + longestBackoff,
    );
    expect(LINE_LOCK_TIMEOUT_MS, "a busy claim answers before the client's next poll").toBeLessThan(LINE_POLL_MIN_MS);
  });
});
