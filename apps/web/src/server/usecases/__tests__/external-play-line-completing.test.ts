// Capacity tests 36 (two admitted stays warm up concurrently) and 37 (`completing` is funded where it becomes known), through the
// REAL claim against the in-memory RealtimeKit and the REAL bucket (spec §8.1, §5.7.3). The bucket holds a stated level and refills
// nothing (`fund`), so a shortfall is never hidden by a refill; "exempt traffic" is the test setting the level lower.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import {
  CAMERA_EVIDENCE_BACKOFF_MS,
  cameraEvidenceDelayMs,
} from "@/components/public-site/match-room/room-snapshot";
import { LINE_RECHECK_COST, LINE_RESERVATION } from "@/server/external-play/seat-line";
import { STRANDED_CREATE_AFTER_MS } from "../external-play/sweep";
import { SEAT_RECHECK_TRUST_MS, seatPlayer } from "../external-play/preflight";
import { holdReservation, putStay, stayRow } from "./_external-play-line";
import {
  MIN,
  SEC,
  availability,
  cameraOn,
  claimRoom,
  dropWorlds,
  fund,
  inWindow,
  joinAt,
  level,
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
/** The scenario's own parameter (not a product declaration): how long a camera takes to come on after its join. */
const CAMERA_WARMUP_S = 10;

afterEach(dropWorlds);
afterAll(async () => {
  if (DB) await sql.end();
});

/** The reservations held, summed from the RAW rows with the rulebook's numbers: an admitted stay that is neither served nor ended. */
async function reservedFromRows(key: string): Promise<{ stays: number; reserved: number }> {
  const rows = await sql<{ completing: boolean }[]>`
    select completing from fixture_seat_line where budget_key = ${key} and admitted_at is not null and served_at is null and ended_at is null`;
  return { stays: rows.length, reserved: rows.reduce((n, r) => n + L + (r.completing ? R : 0), 0) };
}

describe.skipIf(!DB)("two admitted stays warm up concurrently and are served without waiting on each other (test 36)", () => {
  it("A and B are admitted before either is served; each stay's served - admitted is under 2 x the warm-up (about its own, not the sum), they are served within a warm-up of each other, and two are in flight at the maximum", async () => {
    const w = world();
    const a = await seedBoard();
    const b = await seedBoard();
    const T = inWindow(3 * MIN);
    // The line is made active by a stay somebody holds (admitted, with its reservation).
    await holdReservation(w.key, T);
    // Each is funded for both: the pool after the held stay's reservation holds 2 x LINE_RESERVATION at each admission.
    const stays: { name: "A" | "B"; board: Board; mintAt: Date }[] = [
      { name: "A", board: a, mintAt: new Date(T.getTime() + SEC) },
      { name: "B", board: b, mintAt: new Date(T.getTime() + 2 * SEC) },
    ];
    const minted = new Map<string, Awaited<ReturnType<typeof claimRoom>>>();
    const inFlight: number[] = [];
    for (const s of stays) {
      await fund(w.key, 3 * L);
      const got = await claimRoom(w, s.board, "home", s.mintAt);
      expect(got.seat, `${s.name}: admitted and minted`).toMatchObject({ reason: "camera_required" });
      minted.set(s.name, got);
      const live = await sql<{ n: number }[]>`
        select count(*)::int as n from fixture_seat_line
         where person_id in (${a.home.personId}, ${b.home.personId}) and admitted_at is not null and served_at is null`;
      inFlight.push(live[0]!.n);
    }
    expect(inFlight, "the table is read at every admission: both in flight at the second").toEqual([1, 2]);
    // Both browsers join (cameras pending); each turns on CAMERA_WARMUP_S later. Events happen in time order.
    const joins = new Map<string, Date>();
    for (const s of stays) {
      const joined = new Date(s.mintAt.getTime() + 2 * SEC);
      joinAt(w, minted.get(s.name)!.seat, joined);
      joins.set(s.name, joined);
    }
    // Each stay reads on the room's schedule.
    const offsets = [0];
    for (let k = 1; k < 8; k++) offsets.push(offsets.at(-1)! + cameraEvidenceDelayMs(k));
    const events = stays
      .flatMap((s) => offsets.map((o) => ({ s, at: new Date(joins.get(s.name)!.getTime() + o * 1) })))
      .sort((x, y) => x.at.getTime() - y.at.getTime());
    const on = new Set<string>();
    const servedAt = new Map<string, Date>();
    for (const e of events) {
      if (servedAt.has(e.s.name)) continue;
      if (!on.has(e.s.name) && e.at.getTime() - joins.get(e.s.name)!.getTime() >= CAMERA_WARMUP_S * SEC) {
        cameraOn(w, minted.get(e.s.name)!.seat, new Date(e.at.getTime() - SEC));
        on.add(e.s.name);
      }
      await fund(w.key, 1000);
      const got = await claimRoom(w, e.s.board, "home", e.at);
      if (got.seat?.seated) servedAt.set(e.s.name, e.at);
    }
    expect([...servedAt.keys()].sort(), "both are served").toEqual(["A", "B"]);
    const rowA = await stayRow(a.fixtureId, a.home.personId);
    const rowB = await stayRow(b.fixtureId, b.home.personId);
    const spanA = rowA!.served_at!.getTime() - rowA!.admitted_at!.getTime();
    const spanB = rowB!.served_at!.getTime() - rowB!.admitted_at!.getTime();
    expect(Math.max(spanA, spanB), "each stay takes about its own warm-up, not the sum").toBeLessThan(2 * CAMERA_WARMUP_S * SEC);
    expect(Math.abs(rowA!.served_at!.getTime() - rowB!.served_at!.getTime()), "served within a warm-up of each other").toBeLessThan(CAMERA_WARMUP_S * SEC);
    expect(Math.max(...inFlight), "the maximum in flight, read from the table at every admission").toBe(2);
    expect(rowA!.admitted_at!.getTime(), "A is admitted before B is served").toBeLessThan(rowB!.served_at!.getTime());
    expect(rowB!.admitted_at!.getTime(), "B is admitted before A is served").toBeLessThan(rowA!.served_at!.getTime());
  }, 120_000);
});

describe.skipIf(!DB)("`completing` is funded where it becomes known (test 37)", () => {
  /** A held stay makes the line active (its reservation is out), the bucket holds exactly what the candidate needs above it. */
  async function candidate(opts: { other: "open" | "counted" | "none"; shortBy: number }) {
    const w = world();
    const board = await seedBoard();
    const t = inWindow(3 * MIN);
    if (opts.other === "open") {
      // AWAY has an OPEN stay: it minted on the idle line and has not been seated, so it is not counted.
      await fund(w.key, 300);
      const m = await claimRoom(w, board, "away", t);
      expect(m.seat, "AWAY's stay is open").toMatchObject({ reason: "camera_required" });
    } else if (opts.other === "counted") {
      await seatAndCount(w, board, "away", t);
    }
    await holdReservation(w.key, new Date(t.getTime() + 5 * SEC));
    const need = L + (opts.other === "none" ? 0 : R);
    await fund(w.key, L + need - opts.shortBy);
    const got = await claimRoom(w, board, "home", new Date(t.getTime() + 8 * SEC));
    return { w, board, got, need };
  }

  it("(a) at admission: a candidate whose other side has an OPEN stay, one whose other side is COUNTED with no open stay, and one with neither are admitted with completing true, true, false - and with the bucket one token short, none is admitted (3 cases, reported)", async () => {
    const cases = [
      { other: "open", completing: true },
      { other: "counted", completing: true },
      { other: "none", completing: false },
    ] as const;
    let driven = 0;
    for (const c of cases) {
      const ok = await candidate({ other: c.other, shortBy: 0 });
      const row = await stayRow(ok.board.fixtureId, ok.board.home.personId);
      expect(row?.admitted_at, `${c.other}: admitted when funded for exactly its reservation`).not.toBeNull();
      expect(row?.completing, `${c.other}: completing`).toBe(c.completing);
      expect(ok.got.seat, `${c.other}: the claim ran`).toMatchObject({ reason: "camera_required" });
      const short = await candidate({ other: c.other, shortBy: 1 });
      const held = await stayRow(short.board.fixtureId, short.board.home.personId);
      expect(held?.admitted_at, `${c.other}: one token short is not admitted`).toBeNull();
      expect(short.got.seat, `${c.other}: queued`).toMatchObject({ reason: "queued" });
      driven += 1;
    }
    expect(driven, "cases driven").toBe(3);
  }, 120_000);

  it("(b) the late flip: a stay admitted with completing false flips to true at the OPPONENT's first gated claim, and the pool falls by exactly LINE_RECHECK_COST at that claim (read before and after; it may go negative and a later waiting stay is queued until it recovers)", async () => {
    const w = world();
    const board = await seedBoard();
    const t = inWindow(3 * MIN);
    await holdReservation(w.key, new Date(t.getTime() + SEC));
    await fund(w.key, 2 * L);
    const minted = await claimRoom(w, board, "home", new Date(t.getTime() + 2 * SEC));
    expect(minted.seat, "HOME is admitted and mints").toMatchObject({ reason: "camera_required" });
    expect((await stayRow(board.fixtureId, board.home.personId))?.completing, "admitted with its opponent absent").toBe(false);
    // The bucket holds exactly the two reservations: the pool is zero.
    await fund(w.key, 2 * L);
    const before = await reservedFromRows(w.key);
    const poolBefore = (await level(w.key)) - before.reserved;
    expect(poolBefore, "premise: the pool is zero").toBe(0);

    // The opponent's first gated claim arrives (it is held: the pool cannot pay it).
    const opp = await claimRoom(w, board, "away", new Date(t.getTime() + 4 * SEC));
    expect(opp.seat, "the opponent is held, and spends nothing").toMatchObject({ reason: "queued" });
    const after = await reservedFromRows(w.key);
    const poolAfter = (await level(w.key)) - after.reserved;
    expect((await stayRow(board.fixtureId, board.home.personId))?.completing, "HOME's stay is now completing").toBe(true);
    expect(poolBefore - poolAfter, "the pool fell by exactly LINE_RECHECK_COST at the opponent's claim").toBe(R);
    expect(poolAfter, "and is negative").toBeLessThan(0);
    // A later waiting stay is queued until the pool recovers.
    const later = await seedBoard();
    const queued = await claimRoom(w, later, "home", new Date(t.getTime() + 6 * SEC));
    expect(queued.seat, "a later stay waits").toMatchObject({ reason: "queued" });
  }, 60_000);

  /** HOME (admitted, completing - AWAY is counted) seats at its `k`-th read with the exact funding of its reservation; returns the
   *  create's answer and the opponent's re-verify cost. The held stay's tokens were taken by exempt traffic. */
  async function seatAtRead(k: number) {
    const w = world();
    const board = await seedBoard();
    const t = inWindow(3 * MIN);
    await seatAndCount(w, board, "away", t);
    await holdReservation(w.key, new Date(t.getTime() + 5 * SEC));
    await fund(w.key, L + L + R); // the held stay's L and the candidate's L + R
    const mintAt = new Date(t.getTime() + 10 * SEC);
    const minted = await claimRoom(w, board, "home", mintAt);
    expect(minted.seat, "admitted and minted").toMatchObject({ reason: "camera_required" });
    expect((await stayRow(board.fixtureId, board.home.personId))?.completing, "completing: AWAY is counted").toBe(true);
    // Exempt traffic takes the rest: only the candidate's own unspent funding is left (its L + R less the mint's 2).
    await fund(w.key, L + R - 2);
    // The vendor's clock runs 8.5 s ahead, so no read is a verdict before the camera comes on.
    const joined = new Date(mintAt.getTime() + 2 * SEC);
    joinAt(w, minted.seat, new Date(joined.getTime() + 8_500));
    const offsets = [0];
    for (let i = 1; i < k; i++) offsets.push(offsets.at(-1)! + cameraEvidenceDelayMs(i));
    let verify: { seated: boolean; calls: number } | null = null;
    let created: unknown = null;
    for (const [i, off] of offsets.entries()) {
      const at = new Date(joined.getTime() + off);
      if (i === offsets.length - 1) cameraOn(w, minted.seat, new Date(at.getTime() - SEC));
      const got = await claimRoom(w, board, "home", at, {
        create: async () => {
          const c0 = w.rtk.http.length;
          const later = new Date(at.getTime() + SEAT_RECHECK_TRUST_MS + SEC);
          const re = await seatPlayer({ fixtureId: board.fixtureId, personId: board.away.personId, recheck: true }, { now: later, video: w.rtk.video, line: { at: later } });
          verify = { seated: re.seated, calls: w.rtk.http.length - c0 };
          created = re.seated ? { created: true as const, gameId: `g-${k}` } : { created: false as const, reason: "not_ready" as const };
          return created as never;
        },
      });
      expect(i === offsets.length - 1 ? got.seat?.seated : got.seat?.seated === true, `read ${i + 1}`).toBe(i === offsets.length - 1);
    }
    return { w, board, verify: verify as { seated: boolean; calls: number } | null, created, left: await level(w.key) };
  }

  it("(c) the re-verify is funded: HOME seats at its 3rd read and at its 5th, and at the 6th - the last the reservation covers - the opponent's re-verify reads equal LINE_RECHECK_COST, none is deferred and the game is created at once", async () => {
    // The first read count whose whole stay (mint, reads, the seating read and token, and the re-verify) exceeds the reservation.
    const mint = 2;
    const read = 3;
    const token = 1;
    const spend = (k: number) => mint + read * k + token + R;
    const lastFunded = (() => {
      let k = 1;
      while (spend(k + 1) <= L + R) k += 1;
      return k;
    })();
    expect(lastFunded, "the last read the reservation covers, derived from the fixture's counts").toBe(6);
    expect(CAMERA_EVIDENCE_BACKOFF_MS.length, "anti-vacuity").toBeGreaterThan(0);
    const seats: number[] = [];
    for (const k of [3, 5, lastFunded]) {
      const r = await seatAtRead(k);
      expect(r.verify, `read ${k}: the create asked for the re-verify`).not.toBeNull();
      expect(r.verify!.seated, `read ${k}: the re-verify is not deferred`).toBe(true);
      expect(r.verify!.calls, `read ${k}: the opponent's re-verify reads equal LINE_RECHECK_COST`).toBe(R);
      expect(r.created, `read ${k}: the game is created at once`).toEqual({ created: true, gameId: `g-${k}` });
      seats.push(k);
    }
    expect(seats.length, "seats driven").toBe(3);
  }, 180_000);

  it("(d) the residual is named: a seat on the first read the reservation no longer covers, with the bucket at zero, defers the re-verify; the game is created by the sweep's stranded-board arm and counted as a late create (1)", async () => {
    const k = 7; // spend(7) = 2 + 21 + 1 + 3 = 27 > L + R: derived in (c)
    const r = await seatAtRead(k);
    expect(r.verify, "the create asked for the re-verify").not.toBeNull();
    expect(r.verify!.seated, "the re-verify is deferred: the bucket is at zero").toBe(false);
    expect(r.created, "no game inline").toEqual({ created: false, reason: "not_ready" });
    expect(r.left, "the bucket is at zero").toBe(0);
    // The check-in is counted; the sweep's stranded-board arm creates the game on its next pass.
    const stamped = (await availability(r.board.fixtureId, r.board.home.personId))?.checked_in_at;
    expect(stamped, "HOME's check-in is stamped").toBeTruthy();
    let lateCreates = 0;
    const pass = await sweepBoard(r.board, new Date(stamped!.getTime() + STRANDED_CREATE_AFTER_MS + 1_000), {
      createGameIfReady: async () => {
        lateCreates += 1;
        return { created: true, gameId: "g-late" };
      },
    });
    expect(pass.report.failed, "the pass failed nowhere").toBe(0);
    expect(lateCreates, "the late-create count: the gap is measured, not silent").toBe(1);
    void putStay;
    void (null as unknown as World);
  }, 120_000);
});
