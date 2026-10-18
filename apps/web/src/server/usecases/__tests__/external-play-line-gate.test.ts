// Capacity tests 16 (service ends after the create), 20 (one entry), 24 (the create is not gated) and 25 (deferred mints queue),
// through the REAL claim (`claimRoomSeat` -> `seatPlayer` -> the gate -> the T7 adapter) against the in-memory RealtimeKit
// (spec §8.1, §5.7). The bucket holds a stated level and refills nothing (`fund`), so a shortfall is never hidden by a refill;
// a stay somebody else already holds in the line is `holdWaiting` (setup state - a second player cannot be built otherwise).
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { LINE_RECHECK_COST, LINE_RESERVATION } from "@/server/external-play/seat-line";
import { SEAT_RECHECK_TRUST_MS, seatPlayer } from "../external-play/preflight";
import { CAMERA_ON_EVENTS } from "./_external-play-rtk-fake";
import { claimAt, holdWaiting, stayRow } from "./_external-play-line";
import {
  MIN,
  SEC,
  claimRoom,
  dropWorlds,
  fund,
  inWindow,
  joinAt,
  seatAndCount,
  seedBoard,
  world,
  OPENED,
} from "./_external-play-line-route";
import { boardAnchor } from "@/server/external-play/window";

const DB = !!process.env.DATABASE_URL;
const L = LINE_RESERVATION;
const R = LINE_RECHECK_COST;
const ANCHOR = boardAnchor(OPENED, 0, false);

afterEach(dropWorlds);
afterAll(async () => {
  if (DB) await sql.end();
});

const wireLine = (seat: Awaited<ReturnType<typeof claimRoom>>["seat"]) => (seat && "line" in seat ? seat.line : null);

describe.skipIf(!DB)("service ends after the create, under the window (test 16)", () => {
  it("a COMPLETING claim keeps its funded reservation through the create: a waiting stay polling between the seat and the opponent's re-verify is queued, the re-verify finds its tokens, and only then is the stay served", async () => {
    const w = world();
    const b = await seedBoard();
    await seatAndCount(w, b, "away", inWindow(2 * MIN));
    // HOME mints on the idle line, joins with its camera on.
    await fund(w.key, 300);
    const t1 = inWindow(5 * MIN);
    const minted = await claimRoom(w, b, "home", t1);
    expect(minted.seat).toMatchObject({ reason: "camera_required" });
    joinAt(w, minted.seat, new Date(t1.getTime() + SEC), CAMERA_ON_EVENTS);
    // A stay WAITING behind HOME (it arrived later), so the line is active when HOME's read comes.
    const waiter = await holdWaiting(w.key, new Date(t1.getTime() + 2 * SEC), new Date(t1.getTime() + 3 * SEC));

    // The bucket holds 2 x LINE_RESERVATION once the seat read and its token (4 requests) have been spent.
    const t2 = new Date(t1.getTime() + 3 * SEC);
    const seatReadCost = 4;
    await fund(w.key, 2 * L + seatReadCost);

    const inside: { servedAtDuringCreate: Date | null | undefined; waiter: string; waiterAdmitted: Date | null | undefined; callsDuringPoll: number; recheck: boolean; recheckCalls: number } = {
      servedAtDuringCreate: undefined,
      waiter: "",
      waiterAdmitted: undefined,
      callsDuringPoll: -1,
      recheck: false,
      recheckCalls: -1,
    };
    const read = await claimRoom(w, b, "home", t2, {
      create: async () => {
        // The seat is done and the game is not created yet: HOME's reservation (the seat's and the opponent's re-verify) is held.
        inside.servedAtDuringCreate = (await stayRow(b.fixtureId, b.home.personId))?.served_at;
        // The waiting stay polls NOW.
        const calls0 = w.rtk.http.length;
        const got = await claimAt(w.key, waiter, "home", t2, { anchor: ANCHOR });
        inside.waiter = got.kind;
        inside.waiterAdmitted = (await stayRow(waiter.fixtureId, waiter.home.personId))?.admitted_at;
        inside.callsDuringPoll = w.rtk.http.length - calls0;
        // The opponent's re-verify (T9's recheck), at a time its last pass is no longer trusted: a real read of 3.
        const c1 = w.rtk.http.length;
        const later = new Date(t2.getTime() + SEAT_RECHECK_TRUST_MS + SEC);
        const re = await seatPlayer({ fixtureId: b.fixtureId, personId: b.away.personId, recheck: true }, { now: later, video: w.rtk.video, line: { at: later } });
        inside.recheck = re.seated;
        inside.recheckCalls = w.rtk.http.length - c1;
        return { created: true as const, gameId: "g-16" };
      },
    });
    expect(read.seat?.seated, "HOME is seated").toBe(true);
    expect(read.create, "the game is created at once").toEqual({ created: true, gameId: "g-16" });
    expect(inside.servedAtDuringCreate, "the stay is NOT served until the create is done").toBeNull();
    expect(inside.waiter, "the waiting stay is held, not admitted, while the reservation (the seat's and the re-verify's) is out").toBe("queued");
    expect(inside.waiterAdmitted, "no admission").toBeNull();
    expect(inside.callsDuringPoll, "the held poll made no vendor request").toBe(0);
    expect(inside.recheck, "the re-verify finds its tokens and the camera").toBe(true);
    expect(inside.recheckCalls, "the re-verify costs LINE_RECHECK_COST").toBe(R);
    expect((await stayRow(b.fixtureId, b.home.personId))?.served_at, "served only after the whole claim").not.toBeNull();
  }, 60_000);
});

describe.skipIf(!DB)("reload, a second tab and a never-held stay are one entry (test 20)", () => {
  it("two first claims racing at once make ONE row; a reload keeps the first claim and the position", async () => {
    const w = world();
    const b = await seedBoard();
    await fund(w.key, 0);
    const t = inWindow(2 * MIN);
    const [x, y] = await Promise.all([claimRoom(w, b, "home", t), claimRoom(w, b, "home", t)]);
    for (const got of [x, y]) expect(got.seat, "the dry budget holds both tabs").toMatchObject({ seated: false, reason: "queued" });
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from fixture_seat_line where fixture_id = ${b.fixtureId} and person_id = ${b.home.personId}`;
    expect(rows[0]!.n, "one row for two tabs").toBe(1);
    const reload = await claimRoom(w, b, "home", new Date(t.getTime() + 5 * SEC));
    expect(wireLine(reload.seat)?.position, "same position after a reload").toBe(1);
    expect((await stayRow(b.fixtureId, b.home.personId))?.first_claim_at, "same first claim").toEqual(t);
    expect([wireLine(x.seat)?.position, wireLine(y.seat)?.position], "both tabs see place 1").toEqual([1, 1]);
  }, 60_000);

  it("a stay the budget never held keeps its first_claim_at across its claims (3 claims, each inside the grace), and a player first held on the THIRD claim is ordered by their FIRST - ahead of a player who arrived between", async () => {
    const w = world();
    const x = await seedBoard();
    const y = await seedBoard();
    await fund(w.key, 300);
    const t0 = inWindow(2 * MIN);
    const minted = await claimRoom(w, x, "home", t0);
    expect(minted.seat).toMatchObject({ reason: "camera_required" });
    joinAt(w, minted.seat, new Date(t0.getTime() + SEC));
    const read1 = await claimRoom(w, x, "home", new Date(t0.getTime() + 2 * SEC));
    expect(read1.seat, "a camera still starting").toMatchObject({ reason: "camera_starting" });
    let claims = 2;
    const mid = await stayRow(x.fixtureId, x.home.personId);
    expect(mid?.first_claim_at, "claims 1 and 2: the first claim stands").toEqual(t0);
    expect(mid?.queued_at, "never held").toBeNull();

    // Y arrives between X's second and third claims, and the budget is dry.
    await fund(w.key, 0);
    const yClaim = await claimRoom(w, y, "home", new Date(t0.getTime() + 5 * SEC));
    expect(yClaim.seat, "Y is held").toMatchObject({ reason: "queued" });
    // X's THIRD claim: held now, for the first time.
    const third = await claimRoom(w, x, "home", new Date(t0.getTime() + 10 * SEC));
    claims += 1;
    expect(third.seat, "X is held on its third claim").toMatchObject({ seated: false, reason: "queued" });
    expect(claims, "claims made by X (reported)").toBe(3);
    expect((await stayRow(x.fixtureId, x.home.personId))?.first_claim_at, "X is still ordered by its FIRST claim").toEqual(t0);
    expect(wireLine(third.seat)?.position, "X is ahead of Y").toBe(1);
    const yAgain = await claimRoom(w, y, "home", new Date(t0.getTime() + 12 * SEC));
    expect(wireLine(yAgain.seat)?.position, "Y is behind X").toBe(2);
  }, 60_000);
});

describe.skipIf(!DB)("the create is not gated (test 24)", () => {
  it("with the line non-empty, the create's re-verify of both seated players never meets the gate and is seated", async () => {
    const w = world();
    const b = await seedBoard();
    const t = inWindow(3 * MIN);
    await seatAndCount(w, b, "away", t);
    await seatAndCount(w, b, "home", new Date(t.getTime() + 20 * SEC));
    // The line is non-empty: somebody is waiting.
    await holdWaiting(w.key, new Date(t.getTime() + 30 * SEC), new Date(t.getTime() + 31 * SEC));
    const now = new Date(t.getTime() + 32 * SEC);
    let gated = 0;
    const seats = [];
    for (const side of ["home", "away"] as const) {
      seats.push(
        await seatPlayer(
          { fixtureId: b.fixtureId, personId: b[side].personId, recheck: true },
          {
            now,
            video: w.rtk.video,
            line: {
              at: now,
              afterRead: () => {
                gated += 1;
              },
            },
          },
        ),
      );
    }
    expect(seats.map((s) => s.seated), "both re-verified players are seated").toEqual([true, true]);
    expect(gated, "the create's re-verify made no pass through the gate").toBe(0);
    expect(seats.length, "re-verifies driven").toBe(2);
  }, 60_000);
});

describe.skipIf(!DB)("deferred mints queue too (test 25)", () => {
  it("a deferred MINT and a deferred READ are both `queued`, in arrival order, and counted apart; the next arrival is behind them", async () => {
    const w = world();
    const [bx, ba, bc, bd] = [await seedBoard(), await seedBoard(), await seedBoard(), await seedBoard()];
    const t = inWindow(2 * MIN);
    await fund(w.key, 300);
    // B minted on an idle line, then the budget ran dry.
    const minted = await claimRoom(w, bx, "home", t);
    expect(minted.seat).toMatchObject({ reason: "camera_required" });
    joinAt(w, minted.seat, new Date(t.getTime() + SEC));
    await fund(w.key, 0);
    const answers: { who: string; kind: "mint" | "read"; position: number | undefined; reason: string }[] = [];
    const record = (who: string, kind: "mint" | "read", seat: Awaited<ReturnType<typeof claimRoom>>["seat"]) =>
      answers.push({ who, kind, position: wireLine(seat)?.position, reason: seat && !seat.seated ? seat.reason : "seated" });
    const a = await claimRoom(w, ba, "home", new Date(t.getTime() + SEC));
    record("a", "mint", a.seat);
    const bRead = await claimRoom(w, bx, "home", new Date(t.getTime() + 2 * SEC));
    record("b", "read", bRead.seat);
    const c = await claimRoom(w, bc, "home", new Date(t.getTime() + 3 * SEC));
    record("c", "mint", c.seat);
    expect(answers.map((x) => x.reason), "every deferral is `queued`, none is camera_starting").toEqual(["queued", "queued", "queued"]);
    expect(answers.filter((x) => x.kind === "mint").length, "deferred mints").toBe(2);
    expect(answers.filter((x) => x.kind === "read").length, "deferred reads").toBe(1);
    // b arrived first (its mint), then a, then c: the order holds whatever the polling order.
    const poll = async (board: typeof bx, at: number) => wireLine((await claimRoom(w, board, "home", new Date(t.getTime() + at))).seat)?.position;
    const positions = { c: await poll(bc, 6 * SEC), a: await poll(ba, 7 * SEC), b: await poll(bx, 8 * SEC) };
    expect(positions, "b first, then a, then c - whatever order they poll in").toEqual({ b: 1, a: 2, c: 3 });
    const d = await claimRoom(w, bd, "home", new Date(t.getTime() + 9 * SEC));
    expect(wireLine(d.seat)?.position, "the next arrival is behind all three").toBe(4);
  }, 60_000);

  it("the ADMITTED counterpart: a stay admitted and then deferred mid-claim is answered camera_starting with no line and no token, keeps its admission and its reservation, is not in the waiting count beside a never-admitted stay at position 1, and its next funded claim runs without a second admission", async () => {
    const w = world();
    const a = await seedBoard();
    const wait = await seedBoard();
    const t0 = inWindow(2 * MIN);
    await fund(w.key, 0);
    const first = await claimRoom(w, a, "home", t0);
    expect(first.seat, "A is held first").toMatchObject({ reason: "queued" });
    const second = await claimRoom(w, wait, "home", new Date(t0.getTime() + 2 * SEC));
    expect(wireLine(second.seat)?.position, "W is behind A").toBe(2);

    // The pool admits A; exempt traffic then takes the tokens before A's mint (the gate's own seam, between its read and its decision).
    await fund(w.key, 2 * L);
    const admitAt = new Date(t0.getTime() + 5 * SEC);
    const drained = await claimRoom(w, a, "home", admitAt, {
      line: {
        at: admitAt,
        afterRead: async () => {
          await fund(w.key, 0);
        },
      },
    });
    expect(drained.seat, "the admitted stay's deferral is camera_starting").toMatchObject({ seated: false, reason: "camera_starting", participant: null });
    expect("line" in (drained.seat ?? {}), "no `line` key at all").toBe(false);
    const admitted = await stayRow(a.fixtureId, a.home.personId);
    expect(admitted?.admitted_at, "admission kept").toEqual(admitAt);
    expect(admitted?.last_gate, "it passed the gate").toBe("passed");
    expect([admitted?.ended_at, admitted?.served_at], "not ended").toEqual([null, null]);

    // Beside it, the never-admitted stay waits at position 1: the two answers differ and A is not in the waiting count.
    const beside = await claimRoom(w, wait, "home", new Date(admitAt.getTime() + SEC));
    expect(wireLine(beside.seat)?.position, "W is first among the WAITING").toBe(1);
    expect(beside.seat, "queued").toMatchObject({ reason: "queued" });
    expect(drained.seat && "reason" in drained.seat && drained.seat.reason, "the two answers differ").not.toBe(beside.seat && "reason" in beside.seat && beside.seat.reason);

    // Refilled: A's next claim runs, and needs no second admission.
    await fund(w.key, 2 * L);
    const next = await claimRoom(w, a, "home", new Date(admitAt.getTime() + 3 * SEC));
    expect(next.seat, "A's claim runs: the mint answers camera_required with a token").toMatchObject({ reason: "camera_required" });
    expect((await stayRow(a.fixtureId, a.home.personId))?.admitted_at, "no second admission").toEqual(admitAt);
  }, 60_000);
});
