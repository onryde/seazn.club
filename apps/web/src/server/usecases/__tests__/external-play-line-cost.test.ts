// Capacity test 14 (c): the reservation covers a WHOLE stay (spec §8.1, the re-review 2's I-B, §5.6.8), and - check-in capacity plan 2,
// Task 7 - the line's STAMPED price is what that stay really spends (owner ruling R1, 2026-11-17). Each stay is driven through the
// real claim (`claimRoomSeat` -> `seatPlayer` -> the T7 adapter) against the in-memory RealtimeKit, on the room's own schedule
// (`cameraEvidenceDelayMs`), and the FIXTURE SERVER's own request count for that stay is compared with a cost computed here from the
// schedule and the fixture's counts - never from a `LINE_*` constant, which it must then equal. The price table is HAND-DERIVED in
// the plan's Global Constraints and typed here; the stamp the gate wrote (`fixture_seat_line.reservation`) is read back from the
// ledger and must equal the realized cost of the stay it priced.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
import { takeRealtimeKitCall } from "@/server/external-play/video/budget";
import {
  ADMIT_HOLD_MS,
  LINE_CLAIM_COST,
  LINE_END_ROOM_CALLS,
  LINE_FALLBACK_READ_CALLS,
  LINE_LOCK_TIMEOUT_MS,
  LINE_MINT_PARTICIPANT_CALLS,
  LINE_MINT_ROOM_CALLS,
  LINE_READ_CALLS,
  LINE_RELEASE_GRACE_MS,
  LINE_RESERVATION_MAX,
  LINE_RESERVATION_MIN,
  LINE_SESSION_PROBE_CALLS,
  LINE_TOKEN_CALLS,
  lineCompletingLevel,
  lineRecheckCost,
  lineReservation,
  type StayMint,
} from "@/server/external-play/seat-line";
import { LINE_POLL_MS, LINE_POLL_MIN_MS } from "@/components/public-site/match-room/room-snapshot";
import { SEAT_RECHECK_TRUST_MS, presenceFallbackCount, seatPlayer, seatReadCalls, PRESENCE_FALLBACK_MS } from "../external-play/preflight";
import { premintExternalPlay } from "../external-play/premint";
import { CAMERA_ON_EVENTS } from "./_external-play-rtk-fake";
import { stayRow } from "./_external-play-line";
import {
  MIN,
  cameraOn,
  claimRoom,
  dropWorlds,
  fund,
  inWindow,
  joinAt,
  joinWithPresence,
  pageReportsLive,
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
type Stay = {
  name: string;
  reads: number;
  realized: number;
  verdict: string;
  seated: boolean;
  verdictAt: Date;
  /** The vendor requests of the stay's FIRST claim, by kind (the fixture server's own log). */
  first: Record<string, number>;
  /** What the gate stamped on the stay (`fixture_seat_line.reservation` / `recheck_cost`), read back from the ledger. */
  stamp: [number | null, number | null];
};
type Drive = {
  /** The one-read proof flag (EXTERNAL_PLAY_PRESENCE_PROOF=1): the vendor's join webhook is delivered (the real producer) and the page
   *  says its camera is live, so every claim on the schedule makes its read. */
  proof?: boolean;
  /** Runs after the bucket is funded and before the stay's first claim: the pre-mint pass, an earlier pairing's rooms, an earlier stay. */
  prepare?: (w: World, b: Board) => Promise<void>;
  /** When the stay's first claim is made (default: two minutes into the window). */
  mintAt?: Date;
};

const kinds = (log: string[]): Record<string, number> => ({
  create: count(log, ROUTES.create),
  add: count(log, ROUTES.add),
  end: count(log, ROUTES.end),
  token: count(log, ROUTES.token),
  session: count(log, ROUTES.session),
  participants: count(log, ROUTES.participants),
  peerReport: count(log, ROUTES.peerReport),
});
const only = (o: Partial<Record<string, number>>): Record<string, number> => ({
  create: 0, add: 0, end: 0, token: 0, session: 0, participants: 0, peerReport: 0, ...o,
});

/** One stay, from its mint to its verdict, claim by claim on the schedule. The camera turns on `warmupMs` after the join (or
 *  never); `vendorAheadMs` is how far the vendor's clock runs ahead of ours (the join is read as later by that much). */
async function driveStay(w: World, b: Board, c: Case, o: Drive = {}): Promise<Stay> {
  await fund(w.key, 100_000);
  await o.prepare?.(w, b);
  const before = w.rtk.http.length;
  const mintAt = o.mintAt ?? inWindow(2 * MIN);
  const minted = await claimRoom(w, b, "home", mintAt);
  const first = kinds(w.rtk.http.slice(before));
  expect(minted.seat, `${c.name}: the mint answers camera_required with a token`).toMatchObject({ seated: false, reason: "camera_required" });
  const joined = new Date(mintAt.getTime() + 5 * SEC);
  const joinedByVendor = new Date(joined.getTime() + (c.vendorAheadMs ?? 0));
  if (o.proof) await joinWithPresence(w, b, "home", minted.seat, joinedByVendor);
  else joinAt(w, minted.seat, joinedByVendor);
  let on = false;
  for (let k = 1; k <= 12; k++) {
    const at = new Date(joined.getTime() + readOffsetMs(k));
    if (c.warmupMs !== "never" && !on && readOffsetMs(k) >= c.warmupMs) {
      cameraOn(w, minted.seat, at);
      on = true;
    }
    if (o.proof) await pageReportsLive(b, "home", at);
    const got = await claimRoom(w, b, "home", at);
    if (got.seat?.seated || got.seat?.reason !== "camera_starting") {
      const row = await stayRow(b.fixtureId, b.home.personId);
      return {
        name: c.name,
        reads: k,
        realized: w.rtk.http.length - before,
        verdict: got.seat?.seated ? "seated" : String(got.seat?.reason),
        seated: got.seat?.seated === true,
        verdictAt: at,
        first,
        stamp: [row!.reservation, row!.recheck_cost],
      };
    }
  }
  throw new Error(`${c.name}: no verdict in 12 reads`);
}

describe.skipIf(!DB)("a whole stay costs what the reservation says (test 14 (c))", () => {
  it("8 cameras on the room's schedule (the proof flag OFF, today's three-call read): each stay's realized requests EQUAL the cost computed from the schedule and the fixture's counts, none exceeds the greatest price, and the worst case reaches it", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "");
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
    expect(
      { mint: LINE_MINT_ROOM_CALLS + LINE_MINT_PARTICIPANT_CALLS, read: LINE_FALLBACK_READ_CALLS, token: LINE_TOKEN_CALLS },
      "LINE_*_CALLS equal the fixture's counts (flag off: the full read)",
    ).toEqual(fixture);

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

    for (const s of stays) expect(s.realized, `${s.name}: the price covers it`).toBeLessThanOrEqual(LINE_RESERVATION_MAX);
    expect(Math.max(...stays.map((s) => s.realized)), "the worst case reaches the greatest price, so a price above it is noticed").toBe(LINE_RESERVATION_MAX);
    expect(LINE_RESERVATION_MAX, "the greatest price is built from the counts and the room's polls: the mint, five polls of a starting camera, the seating read and the token").toBe(
      LINE_MINT_ROOM_CALLS + LINE_MINT_PARTICIPANT_CALLS + LINE_FALLBACK_READ_CALLS * CAMERA_EVIDENCE_MAX_POLLS + (LINE_FALLBACK_READ_CALLS + LINE_TOKEN_CALLS),
    );
  }, 120_000);

  it("P1 - the client re-claims a refused seat SEAT_RETRIES times after a dead camera's verdict, and each re-claim costs vendor calls the price does NOT cover: measured, listed, and bounded by the grace (proof flag off)", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "");
    const w = world();
    const b = await seedBoard();
    const dead = await driveStay(w, b, { name: "a camera that never comes on", warmupMs: "never" });
    expect(dead.verdict, "premise: the verdict is the camera refusal, the answer that sets the client re-claiming").toBe("camera_required");
    expect(dead.realized, "premise: the stay itself cost its price exactly (the table's 18, under the greatest price)").toBeLessThanOrEqual(LINE_RESERVATION_MAX);

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
    expect(stayTotal, "the re-claims take the stay PAST its price: the overspend is real and is not covered (seat-line.ts lists it)").toBeGreaterThan(LINE_RESERVATION_MAX);
    // The listed figure (the comment beside the price table): SEAT_RETRIES x (one read + one token), from the declared counts.
    expect(overspend, "SEAT_RETRIES x (a read and a token)").toBe(SEAT_RETRIES * (LINE_FALLBACK_READ_CALLS + LINE_TOKEN_CALLS));
    // It all lands inside the release grace, so the stay's silence after it still ends its reservation on the grace's clock.
    expect(SEAT_RETRIES * SEAT_RETRY_MS, "the re-claims finish well inside the release grace").toBeLessThan(LINE_RELEASE_GRACE_MS);
  }, 120_000);

  it("the largest ONE claim (a minting claim on a re-paired board: two stale meetings ended, a create, an add) is LINE_CLAIM_COST, and the least price is at least that; the re-verify costs lineRecheckCost(readCalls) (m4)", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "");
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
    expect(LINE_RESERVATION_MIN, "even the least price covers the largest claim").toBeGreaterThanOrEqual(log.length);

    // The re-verify (T9's recheck): home is seated, then re-read after the trust window by the server alone.
    joinAt(w, minted.seat, inWindow(2 * MIN + 5 * SEC), CAMERA_ON_EVENTS);
    const s0 = w.rtk.http.length;
    const seated = await claimRoom(w, b, "home", inWindow(2 * MIN + 6 * SEC));
    expect(seated.seat?.seated).toBe(true);
    const seatCalls = w.rtk.http.length - s0;
    expect(kinds(w.rtk.http.slice(s0)), "the seating claim (flag off): the full read and the token handed with the seat").toEqual(only({ session: 1, participants: 1, peerReport: 1, token: 1 }));
    const r0 = w.rtk.http.length;
    const later = inWindow(2 * MIN + 6 * SEC + SEAT_RECHECK_TRUST_MS + SEC);
    const recheck = await seatPlayer({ fixtureId: b.fixtureId, personId: b.home.personId, recheck: true }, { now: later, video: w.rtk.video });
    expect(recheck.seated, "the re-verify finds the camera on").toBe(true);
    expect(w.rtk.http.length - r0, "the re-verify is one read").toBe(3);
    expect(lineRecheckCost(LINE_FALLBACK_READ_CALLS), "the re-verify's price (flag off) is at least its count").toBeGreaterThanOrEqual(w.rtk.http.length - r0);
    expect(lineRecheckCost(seatReadCalls()), "premise: seatReadCalls() is the flag-off read price here").toBe(LINE_FALLBACK_READ_CALLS);
    expect(lineCompletingLevel(LINE_FALLBACK_READ_CALLS), "the completing level (flag off) is the seating claim's measured spend plus the re-verify's: 4 + 3").toBe(seatCalls + (w.rtk.http.length - r0));
  }, 60_000);

  it("the fixture vendor's own counts, each EQUAL to its declared constant: room create 1, participant add 1, token 1, proof read 1, full read 3, session probe 1, endMeeting 2", async () => {
    // Measured from stays driven through the real claim; the expected numbers are the counts, typed.
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "");
    const off = world();
    const offBoard = await seedBoard();
    await fund(off.key, 100_000);
    const m0 = off.rtk.http.length;
    const mint = await claimRoom(off, offBoard, "home", inWindow(2 * MIN));
    const mintCalls = kinds(off.rtk.http.slice(m0));
    expect(mintCalls, "a minting claim: the room's create and the participant's add - the add carries the token").toEqual(only({ create: 1, add: 1 }));
    joinAt(off, mint.seat, inWindow(2 * MIN + 5 * SEC));
    const r0 = off.rtk.http.length;
    await claimRoom(off, offBoard, "home", inWindow(2 * MIN + 5 * SEC));
    const fullRead = kinds(off.rtk.http.slice(r0));
    expect(fullRead, "a full read (flag off): the live session, its participants, the peer report").toEqual(only({ session: 1, participants: 1, peerReport: 1 }));
    const t0 = off.rtk.http.length;
    await claimRoom(off, offBoard, "home", inWindow(2 * MIN + 5 * SEC + 3 * SEC)); // a camera still starting, a second read: no token is spent by a read
    expect(count(off.rtk.http.slice(t0), ROUTES.token), "a read of a starting camera spends no token").toBe(0);

    // The session probe: a first claim for a player whose participant is on file and who has joined nothing (flag off): the live-session
    // read finds no session. Then the token the answer hands.
    const probeBoard = await seedBoard();
    const probeW = world();
    await fund(probeW.key, 100_000);
    await claimRoom(probeW, probeBoard, "home", inWindow(2 * MIN)); // makes the room and the participant
    const p0 = probeW.rtk.http.length;
    await claimRoom(probeW, probeBoard, "home", inWindow(2 * MIN + 2 * LINE_RELEASE_GRACE_MS)); // a NEW stay, nothing joined
    const probeCalls = kinds(probeW.rtk.http.slice(p0));
    expect(probeCalls, "the first claim of a `none` stay with the flag off: the probe that finds nobody, and the token").toEqual(only({ session: 1, token: 1 }));

    // The proof read: one peer report (flag on, presence on file, the page live).
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "1");
    const on = world();
    const onBoard = await seedBoard();
    await fund(on.key, 100_000);
    const onMint = await claimRoom(on, onBoard, "home", inWindow(2 * MIN));
    await joinWithPresence(on, onBoard, "home", onMint.seat, inWindow(2 * MIN + 5 * SEC));
    await pageReportsLive(onBoard, "home", inWindow(2 * MIN + 5 * SEC));
    const q0 = on.rtk.http.length;
    await claimRoom(on, onBoard, "home", inWindow(2 * MIN + 5 * SEC));
    const proofRead = kinds(on.rtk.http.slice(q0));
    expect(proofRead, "a proof read (flag on): the peer report alone").toEqual(only({ peerReport: 1 }));

    // endMeeting: a re-paired board's two stale rooms (one board, both sides), kicked and set inactive each.
    const endW = world();
    const endBoard = await seedBoard();
    await fund(endW.key, 100_000);
    for (const [side, meeting] of [["home", `stale-${endBoard.fixtureId}-h`], ["away", `stale-${endBoard.fixtureId}-a`]] as const) {
      await sql`
        insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
        values (${endBoard.fixtureId}, ${side}, ${endBoard.orgId}, ${meeting}, ${RETIRED_PAIR}, ${RETIRED_PAIR})`;
    }
    const e0 = endW.rtk.http.length;
    await claimRoom(endW, endBoard, "home", inWindow(2 * MIN));
    const retire = kinds(endW.rtk.http.slice(e0));

    const measured = {
      mintRoom: mintCalls.create,
      mintParticipant: mintCalls.add,
      token: probeCalls.token,
      proofRead: proofRead.peerReport,
      fullRead: fullRead.session + fullRead.participants + fullRead.peerReport,
      probe: probeCalls.session,
      endRoom: retire.end / 2,
    };
    expect(measured, "the fixture's counts, typed").toEqual({ mintRoom: 1, mintParticipant: 1, token: 1, proofRead: 1, fullRead: 3, probe: 1, endRoom: 2 });
    expect(
      {
        mintRoom: LINE_MINT_ROOM_CALLS,
        mintParticipant: LINE_MINT_PARTICIPANT_CALLS,
        token: LINE_TOKEN_CALLS,
        proofRead: LINE_READ_CALLS,
        fullRead: LINE_FALLBACK_READ_CALLS,
        probe: LINE_SESSION_PROBE_CALLS,
        endRoom: LINE_END_ROOM_CALLS,
      },
      "each declared constant equals what the fixture server counted",
    ).toEqual(measured);
    expect(LINE_CLAIM_COST, "the largest claim: two rooms retired, a create and an add").toBe(2 * measured.endRoom + measured.mintRoom + measured.mintParticipant);
    expect(Object.keys(measured).length, "anti-vacuity: 7 counts measured").toBe(7);
  }, 60_000);

  it("THE PRICE TABLE, MEASURED (owner ruling R1): 8 stays, each kind x each flag state, driven through the real claim to a late verdict - the realized calls are the stamped price (and + 4 for an earlier pairing's rooms)", async () => {
    // The stay kind is what its FIRST claim meets; every stay is the late-verdict schedule (a camera that never comes on, the vendor's
    // clock half a second ahead): SIX reads, the longest a stay runs. Hand-derived price = first claim + 6 reads + the verdict's token:
    //   flag on  (a read is one call):   room 1+6+1 = 8   none 1+6+1 = 8    all 2+6+1 = 9
    //   flag off (a read is three calls): room 1+18+1 = 20  none 2+18+1 = 21  all 2+18+1 = 21
    // The earlier-pairing stay is an `all` stay whose first claim also ENDS two stale rooms (2 x 2 calls) - the design's uncovered +4.
    const late: Case = { name: "late verdict", warmupMs: "never", vendorAheadMs: 500 };
    /** `room`: the room is the pre-mint job's own row - made BEFORE the round opened, by the pass itself. */
    const premint = async (w: World, b: Board) => {
      vi.stubEnv("EXTERNAL_PLAY_PREMINT", "1");
      const report = await premintExternalPlay({
        orgIds: [b.orgId],
        serialise: false,
        wait: async () => {},
        offered: async () => true,
        rtk: { fetch: w.rtk.fetch, budget: (k) => takeRealtimeKitCall(k) },
      });
      expect(report.roomsMade, "premise: the pass made this board's two rooms").toBe(2);
      // The round opens now (the organiser's open): the claim finds the pass's room waiting.
      await sql`
        insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by, staggered)
        values (${b.stageId}, ${b.orgId}, 1, ${inWindow(0)}, ${b.ownerUserId}, false)`;
    };
    /** `none`: an EARLIER stay of this player made the room and the participant, then went silent past its grace. */
    const earlierStay = async (w: World, b: Board) => {
      const t = inWindow(2 * MIN);
      expect((await claimRoom(w, b, "home", t)).seat, "premise: the earlier stay's claim mints").toMatchObject({ reason: "camera_required" });
    };
    /** `all` with an earlier pairing's rooms: both sides' rooms stamped for another pairing. */
    const stale = async (_w: World, b: Board) => {
      for (const [side, meeting] of [["home", `stale-${b.fixtureId}-h`], ["away", `stale-${b.fixtureId}-a`]] as const) {
        await sql`
          insert into fixture_video_meetings (fixture_id, side, org_id, meeting_id, home_entrant_id, away_entrant_id)
          values (${b.fixtureId}, ${side}, ${b.orgId}, ${meeting}, ${RETIRED_PAIR}, ${RETIRED_PAIR})`;
      }
    };
    type Row = {
      name: string;
      kind: StayMint;
      proof: boolean;
      prepare?: (w: World, b: Board) => Promise<void>;
      round?: "unopened";
      mintAt?: Date;
      /** The vendor requests of the stay's first claim, by kind. */
      first: Record<string, number>;
      price: number;
      realized: number;
    };
    const lapsed = inWindow(2 * MIN + 2 * LINE_RELEASE_GRACE_MS);
    const rows: Row[] = [
      { name: "room, flag on", kind: "room", proof: true, prepare: premint, round: "unopened", first: only({ add: 1 }), price: 8, realized: 8 },
      { name: "none, flag on", kind: "none", proof: true, prepare: earlierStay, mintAt: lapsed, first: only({ token: 1 }), price: 8, realized: 8 },
      { name: "all, flag on", kind: "all", proof: true, first: only({ create: 1, add: 1 }), price: 9, realized: 9 },
      { name: "all with an earlier pairing's rooms, flag on", kind: "all", proof: true, prepare: stale, first: only({ end: 4, create: 1, add: 1 }), price: 9, realized: 9 + 4 },
      { name: "room, flag off", kind: "room", proof: false, prepare: premint, round: "unopened", first: only({ add: 1 }), price: 20, realized: 20 },
      { name: "none, flag off", kind: "none", proof: false, prepare: earlierStay, mintAt: lapsed, first: only({ session: 1, token: 1 }), price: 21, realized: 21 },
      { name: "all, flag off", kind: "all", proof: false, first: only({ create: 1, add: 1 }), price: 21, realized: 21 },
      { name: "all with an earlier pairing's rooms, flag off", kind: "all", proof: false, prepare: stale, first: only({ end: 4, create: 1, add: 1 }), price: 21, realized: 21 + 4 },
    ];
    const stays: Stay[] = [];
    for (const r of rows) {
      vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", r.proof ? "1" : "");
      expect(seatReadCalls(), `${r.name}: premise - the read price the gate is asked with`).toBe(r.proof ? LINE_READ_CALLS : LINE_FALLBACK_READ_CALLS);
      const w = world();
      const b = await seedBoard(r.round === "unopened" ? { roundOpenedAt: undefined } : {});
      stays.push(await driveStay(w, b, { ...late, name: r.name }, { proof: r.proof, prepare: r.prepare, mintAt: r.mintAt }));
    }
    expect(stays.length, "anti-vacuity: 8 stays driven").toBe(8);
    expect(new Set(rows.map((r) => `${r.kind}/${r.proof}/${r.prepare === stale}`)).size, "the 8 are distinct (kind x flag x pairing)").toBe(8);

    for (const [i, r] of rows.entries()) {
      const s = stays[i]!;
      expect(s.verdict, `${r.name}: a camera that never comes on ends in the camera refusal`).toBe("camera_required");
      expect(s.reads, `${r.name}: the late verdict - SIX reads, the longest schedule a stay runs`).toBe(CAMERA_EVIDENCE_MAX_POLLS + 1);
      expect(s.first, `${r.name}: the first claim's requests are what its kind meets`).toEqual(r.first);
      expect(s.realized, `${r.name}: the stay's realized calls`).toBe(r.realized);
      expect(s.stamp[0], `${r.name}: the gate stamped the price the stay was priced at`).toBe(r.price);
      expect(s.stamp[1], `${r.name}: and the re-verify's cost (one read with the flag, three without)`).toBe(r.proof ? LINE_READ_CALLS : LINE_FALLBACK_READ_CALLS);
      expect(lineReservation(r.kind, r.proof ? LINE_READ_CALLS : LINE_FALLBACK_READ_CALLS), `${r.name}: the code's price agrees with the hand count`).toBe(r.price);
      // What the price does not cover is exactly the retirement of the earlier pairing's rooms and nothing else.
      expect(s.realized - r.price, `${r.name}: the excess over the price`).toBe(r.prepare === stale ? 2 * LINE_END_ROOM_CALLS : 0);
    }
    // The three kinds' realized calls, by flag state (the brief's table): [room, none, all].
    expect([stays[0], stays[1], stays[2]].map((s) => s!.realized), "flag on: [room, none, all]").toEqual([8, 8, 9]);
    expect([stays[4], stays[5], stays[6]].map((s) => s!.realized), "flag off: [room, none, all]").toEqual([20, 21, 21]);
    expect(Math.min(...stays.filter((_, i) => i !== 3 && i !== 7).map((s) => s.realized)), "the least realized stay is LINE_RESERVATION_MIN").toBe(LINE_RESERVATION_MIN);
    expect(Math.max(...stays.filter((_, i) => i !== 3 && i !== 7).map((s) => s.realized)), "the greatest priced stay is LINE_RESERVATION_MAX").toBe(LINE_RESERVATION_MAX);
  }, 180_000);

  it("with the proof flag the re-verify is ONE read (lineRecheckCost(LINE_READ_CALLS)), measured; the seating claim's own read and token are the completing level's first two terms (measured)", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "1");
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 100_000);
    const minted = await claimRoom(w, b, "home", inWindow(2 * MIN));
    await joinWithPresence(w, b, "home", minted.seat, inWindow(2 * MIN + 5 * SEC), { events: CAMERA_ON_EVENTS });
    await pageReportsLive(b, "home", inWindow(2 * MIN + 6 * SEC));
    const s0 = w.rtk.http.length;
    const seated = await claimRoom(w, b, "home", inWindow(2 * MIN + 6 * SEC));
    expect(seated.seat?.seated, "the seating claim seats").toBe(true);
    const seatCalls = w.rtk.http.length - s0;
    expect(kinds(w.rtk.http.slice(s0)), "the seating claim: one peer-report read and the token handed with the seat").toEqual(only({ peerReport: 1, token: 1 }));
    const r0 = w.rtk.http.length;
    const later = inWindow(2 * MIN + 6 * SEC + SEAT_RECHECK_TRUST_MS + SEC);
    const recheck = await seatPlayer({ fixtureId: b.fixtureId, personId: b.home.personId, recheck: true }, { now: later, video: w.rtk.video });
    expect(recheck.seated, "the re-verify finds the camera on").toBe(true);
    expect(w.rtk.http.length - r0, "the re-verify is one read").toBe(1);
    expect(lineRecheckCost(LINE_READ_CALLS), "the declared re-verify price equals the measured one").toBe(w.rtk.http.length - r0);
    expect(lineCompletingLevel(LINE_READ_CALLS), "the completing level (flag on) is the seating claim's measured spend plus the re-verify's: 2 + 1").toBe(seatCalls + (w.rtk.http.length - r0));
  }, 60_000);

  it("m5 (T6 review): the counted fallback is NOT once per page - a live page that never joins falls back on every press >= PRESENCE_FALLBACK_MS apart, each costs the probe and a fresh token, and the stamp never moves", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "1");
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 100_000);
    const t0 = inWindow(2 * MIN);
    const minted = await claimRoom(w, b, "home", t0);
    expect(minted.seat, "the mint hands the page its token").toMatchObject({ reason: "camera_required" });
    const stamped = await stayRow(b.fixtureId, b.home.personId);
    expect([stamped!.reservation, stamped!.recheck_cost], "premise: the stay was priced `all`, flag on").toEqual([9, 1]);
    await pageReportsLive(b, "home", new Date(t0.getTime() + SEC)); // the page says live; no join webhook ever arrives and nobody joins
    const f0 = presenceFallbackCount();
    const presses: { calls: Record<string, number>; reason: string }[] = [];
    for (let n = 1; n <= 3; n++) {
      const c0 = w.rtk.http.length;
      const got = await claimRoom(w, b, "home", new Date(t0.getTime() + SEC + n * PRESENCE_FALLBACK_MS + n * SEC));
      presses.push({ calls: kinds(w.rtk.http.slice(c0)), reason: got.seat && "reason" in got.seat ? got.seat.reason : "seated" });
    }
    expect(presses.length, "anti-vacuity: three presses").toBe(3);
    expect(presenceFallbackCount() - f0, "three presses, THREE fallbacks - never once per page").toBe(3);
    for (const [i, p] of presses.entries()) {
      expect(p, `press ${i + 1}: the session probe that finds nobody, and a fresh token for the refusal`).toEqual({ calls: only({ session: 1, token: 1 }), reason: "camera_required" });
    }
    const after = await stayRow(b.fixtureId, b.home.personId);
    expect([after!.reservation, after!.recheck_cost], "the stamp is not re-priced by the fallbacks: what they spend is OUTSIDE the price").toEqual([9, 1]);
    expect(after!.first_claim_at, "premise: still the one stay").toEqual(stamped!.first_claim_at);
  }, 60_000);

  it("a fallback READ of a page that DID join (its webhook lost) costs LINE_FALLBACK_READ_CALLS, and the claims after it take the one-call path: the overspend is (LINE_FALLBACK_READ_CALLS - LINE_READ_CALLS) per fallback", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "1");
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 100_000);
    const t0 = inWindow(2 * MIN);
    const minted = await claimRoom(w, b, "home", t0);
    joinAt(w, minted.seat, new Date(t0.getTime() + 5 * SEC)); // the browser joined; the join webhook was lost: no presence row
    await pageReportsLive(b, "home", new Date(t0.getTime() + 2 * SEC));
    const f0 = presenceFallbackCount();
    const c0 = w.rtk.http.length;
    const fell = await claimRoom(w, b, "home", new Date(t0.getTime() + 2 * SEC + PRESENCE_FALLBACK_MS));
    expect(fell.seat, "the fallback finds a camera still starting").toMatchObject({ seated: false, reason: "camera_starting" });
    expect(presenceFallbackCount() - f0, "one fallback").toBe(1);
    expect(kinds(w.rtk.http.slice(c0)), "the fallback is the full read").toEqual(only({ session: 1, participants: 1, peerReport: 1 }));
    expect(w.rtk.http.length - c0, "LINE_FALLBACK_READ_CALLS").toBe(LINE_FALLBACK_READ_CALLS);
    const c1 = w.rtk.http.length;
    const next = await claimRoom(w, b, "home", new Date(t0.getTime() + 3 * SEC + PRESENCE_FALLBACK_MS));
    expect(next.seat, "the next claim still finds it starting").toMatchObject({ reason: "camera_starting" });
    expect(w.rtk.http.length - c1, "the read the fallback recorded makes the next claim a one-call read").toBe(LINE_READ_CALLS);
    expect(presenceFallbackCount() - f0, "and it is not another fallback").toBe(1);
    expect(LINE_FALLBACK_READ_CALLS - LINE_READ_CALLS, "the overspend of one fallback over the price's own read").toBe(2);
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
