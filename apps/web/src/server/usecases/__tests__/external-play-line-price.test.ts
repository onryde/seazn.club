// Check-in capacity plan 2, Task 7 - the line's STAMPED price (spec §6.4; owner ruling R1, 2026-11-17; review finding 7), through the
// REAL gate and the REAL claim. The table's own arithmetic is seat-line-price.test.ts (pure) and the realized call counts per stay kind
// and flag state are external-play-line-cost.test.ts (the fixture vendor's own log); this file owns what the line DOES with a price:
//   - the stamp is written at a stay's FIRST claim, by `passTheLine`'s ask (`stayMintOf`, `seatReadCalls`) and by `queueDeferred`'s,
//     is never re-priced inside a stay (a later claim sees its own mint already made), and is new for a restarted stay;
//   - a row from before the stamp (either column null) is priced at the maximum and still reads admitted and live;
//   - the pool, the estimate and the idle completing level follow the stamped prices, not a constant;
//   - `upsertStay` writes the pair together or not at all (M6).
// Every expected number is hand-derived from the table in the Global Constraints and typed here; `lineReservation` is compared only in
// the cost suite. The bucket PINNED to a stated level a long way ahead refills nothing, so a shortfall is never hidden.
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { LINE_POLL_MS } from "@/components/public-site/match-room/room-snapshot";
import { RTK_BUDGET_REFILL_PER_S } from "@/server/external-play/video/budget";
import {
  LINE_FALLBACK_READ_CALLS,
  LINE_RELEASE_GRACE_MS,
  LINE_RESERVATION_MAX,
  endStay,
  lineActive,
  upsertStay,
  type GateAnswer,
} from "@/server/external-play/seat-line";
import { stayMintOf } from "../external-play/preflight";
import { configureRealtimeKit } from "./_external-play-rtk-fake";
import { claimAt, clearBucket, holdReservation, putStay, sceneAt, seedBoard, setBucket, stayRow, stubBucket } from "./_external-play-line";
import { MIN, SEC, claimRoom, dropWorlds, fund, inWindow, seedBoard as routeBoard, world } from "./_external-play-line-route";

const DB = !!process.env.DATABASE_URL;
const keys: string[] = [];
/** A fresh bucket - and so a fresh line - for one gate scene. */
function scene(): string {
  configureRealtimeKit();
  const key = stubBucket();
  keys.push(key);
  return key;
}
/** The bucket holds `tokens` and refills nothing for the whole scene (stamped a long way after every claim's clock). */
const pin = (key: string, tokens: number) => setBucket(key, tokens, sceneAt(3_600_000));

beforeEach(() => {
  configureRealtimeKit();
});
afterEach(async () => {
  await dropWorlds();
  if (DB) for (const k of keys.splice(0)) await clearBucket(k);
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (DB) await sql.end();
});

const kindOf = (a: GateAnswer) => (a.kind === "go" ? `go:${a.decision}` : a.kind);
const priceOf = async (fixtureId: string, personId: string) => {
  const r = await stayRow(fixtureId, personId);
  return r === null ? null : [r.reservation, r.recheck_cost];
};

describe.skipIf(!DB)("the stamp: a stay is priced at its FIRST claim, by what that claim will meet, through the real claim", () => {
  it("proof flag ON: a first claim with nothing on file is stamped [9, 1]; the player's own mint then makes a fresh stay price 8, but a later claim of the SAME stay re-prices nothing; a restarted stay gets a new stamp [8, 1]", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "1");
    const w = world();
    const b = await routeBoard();
    await fund(w.key, 100_000);
    const who = { fixtureId: b.fixtureId, side: "home" as const, personId: b.home.personId };
    const t0 = inWindow(2 * MIN);

    expect(await stayMintOf(sql, who), "premise: nothing is on file, so the first claim is priced `all`").toBe("all");
    expect((await claimRoom(w, b, "home", t0)).seat, "the first claim mints and answers the way in").toMatchObject({ reason: "camera_required" });
    const first = await stayRow(b.fixtureId, b.home.personId);
    expect([first!.reservation, first!.recheck_cost], "all (create + add = 2) + 6 reads + the token = 9; a re-verify is one read").toEqual([9, 1]);

    // The claim made the player's room and participant: a stay priced NOW would be `none` (8). The stay already stamped must not move.
    expect(await stayMintOf(sql, who), "premise: re-pricing now would say `none`").toBe("none");
    expect((await claimRoom(w, b, "home", new Date(t0.getTime() + 3 * SEC))).seat).toMatchObject({ reason: "camera_required" });
    const second = await stayRow(b.fixtureId, b.home.personId);
    expect(second!.first_claim_at, "premise: still the SAME stay (not restarted)").toEqual(first!.first_claim_at);
    expect([second!.reservation, second!.recheck_cost], "a second claim of the same stay re-prices nothing: the `all` stay keeps 9, not none's 8").toEqual([9, 1]);

    // The stay goes silent past its grace: the next claim starts a NEW stay, and its first claim prices what it meets - `none`.
    const t2 = new Date(t0.getTime() + 2 * LINE_RELEASE_GRACE_MS);
    await claimRoom(w, b, "home", t2);
    const third = await stayRow(b.fixtureId, b.home.personId);
    expect(third!.first_claim_at, "premise: a new stay").toEqual(t2);
    expect([third!.reservation, third!.recheck_cost], "a restarted stay gets a NEW stamp: none (the token) + 6 reads + the token = 8").toEqual([8, 1]);
  }, 60_000);

  it("proof flag OFF: nothing on file is stamped [21, 3] (today's price), a restarted `none` stay [21, 3] too (the probe that finds nobody is paid for)", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "");
    const w = world();
    const b = await routeBoard();
    await fund(w.key, 100_000);
    const t0 = inWindow(2 * MIN);
    await claimRoom(w, b, "home", t0);
    expect(await priceOf(b.fixtureId, b.home.personId), "all: 2 + 6 x 3 + 1 = 21; a re-verify is the three-call read").toEqual([21, 3]);
    await claimRoom(w, b, "home", new Date(t0.getTime() + 2 * LINE_RELEASE_GRACE_MS));
    expect(await priceOf(b.fixtureId, b.home.personId), "none: (the probe + the token) 2 + 6 x 3 + 1 = 21").toEqual([21, 3]);
  }, 60_000);

  it("SEQUENCE: a stay stamped with the flag ON, the flag flipped OFF, a second claim - the stamp is unchanged; a NEW stay is priced off", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "1");
    const w = world();
    const b = await routeBoard();
    const other = await routeBoard();
    await fund(w.key, 100_000);
    const t0 = inWindow(2 * MIN);
    await claimRoom(w, b, "home", t0);
    expect(await priceOf(b.fixtureId, b.home.personId), "stamped with the flag on").toEqual([9, 1]);

    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "");
    await claimRoom(w, b, "home", new Date(t0.getTime() + 3 * SEC));
    expect(await priceOf(b.fixtureId, b.home.personId), "the flag flipped, the same stay: the stamp is the stay's own").toEqual([9, 1]);

    await claimRoom(w, other, "home", new Date(t0.getTime() + 4 * SEC));
    expect(await priceOf(other.fixtureId, other.home.personId), "a new stay with the flag off is priced off: all at 3 calls a read").toEqual([21, 3]);
  }, 60_000);

  it("a claim cut short by the budget MID-CLAIM keeps the stamp the gate wrote: the room was made, the stay is queued, and it is not re-priced `room`", async () => {
    vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", "1");
    const w = world();
    const b = await routeBoard();
    // One token: the gate lets the idle claim through, the meeting's create is made, the participant's add is refused by the budget.
    await fund(w.key, 1);
    const t0 = inWindow(2 * MIN);
    const got = await claimRoom(w, b, "home", t0);
    expect(got.seat, "the deferral mid-claim queues the stay").toMatchObject({ seated: false, reason: "queued" });
    expect(w.rtk.http.length, "premise: exactly the room's create was made").toBe(1);
    expect(await stayMintOf(sql, { fixtureId: b.fixtureId, side: "home", personId: b.home.personId }), "premise: re-pricing now would say `room` (8)").toBe("room");
    expect(await priceOf(b.fixtureId, b.home.personId), "the gate priced it `all` before the room existed: 9").toEqual([9, 1]);
  }, 60_000);

  it("queueDeferred's OWN ask carries the price (the stay the gate never saw): a deferral settled for a new stay is stamped by `stayMintOf` and `seatReadCalls`, 4 cells", async () => {
    // The only way to reach `settleDeferral` with no stay is a `camera_starting` the budget cut short on a claim the gate never
    // gated; the seat is stubbed to say exactly that, so the ask queueDeferred builds is the one that stamps. Everything else is real.
    const cells = [
      { proof: "1", withRoom: false, want: [9, 1], why: "all, flag on" },
      { proof: "1", withRoom: true, want: [8, 1], why: "room, flag on" },
      { proof: "", withRoom: false, want: [21, 3], why: "all, flag off" },
      { proof: "", withRoom: true, want: [20, 3], why: "room, flag off: 1 + 6 x 3 + 1" },
    ];
    let checked = 0;
    for (const c of cells) {
      vi.stubEnv("EXTERNAL_PLAY_PRESENCE_PROOF", c.proof);
      const w = world();
      const b = await routeBoard();
      await fund(w.key, 100_000);
      if (c.withRoom) await w.rtk.video.ensureMeeting(b.fixtureId, "home");
      const deferred = async () => ({ seated: false as const, reason: "camera_starting" as const, participant: null, budgetDeferred: true as const });
      const got = await claimRoom(w, b, "home", inWindow(2 * MIN), { seat: deferred } as never);
      expect(got.seat, `${c.why}: queued by the deferral`).toMatchObject({ seated: false, reason: "queued" });
      expect(await priceOf(b.fixtureId, b.home.personId), c.why).toEqual(c.want);
      checked += 1;
    }
    expect(checked, "cells driven").toBe(4);
  }, 60_000);
});

describe.skipIf(!DB)("a row from before the stamp (a column null): it is priced at the maximum, and still reads admitted and live", () => {
  it("an ADMITTED, completing stay with recheck_cost NULL (stamped 9) reserves 9 + the unstamped recheck 3: it is live, it is admitted at its own claim, and the pool is short by exactly 12", async () => {
    // Pool arithmetic: a bucket of T holds T - 12 for the next claim, whose need is 8 (a `room` stay, flag on, not completing).
    for (const [tokens, want] of [[19, "queued"], [20, "go:admit"]] as const) {
      const key = scene();
      await holdReservation(key, sceneAt(0), true, { reservation: 9, recheckCost: null });
      await pin(key, tokens);
      const x = await seedBoard();
      const a = await claimAt(key, x, "home", sceneAt(1_000), { mint: "room", readCalls: 1 });
      expect(kindOf(a), `bucket ${tokens}: 9 + coalesce(null, 3) = 12 reserved, need 8`).toBe(want);
    }
  });

  it("the same stay with recheck_cost STAMPED 1 reserves 10: the value differs from the null case (17 queues, 18 admits), so the coalesce is witnessed", async () => {
    for (const [tokens, want] of [[17, "queued"], [18, "go:admit"]] as const) {
      const key = scene();
      await holdReservation(key, sceneAt(0), true, { reservation: 9, recheckCost: 1 });
      await pin(key, tokens);
      const x = await seedBoard();
      const a = await claimAt(key, x, "home", sceneAt(1_000), { mint: "room", readCalls: 1 });
      expect(kindOf(a), `bucket ${tokens}: 9 + 1 = 10 reserved, need 8`).toBe(want);
    }
  });

  it("it reads ADMITTED at its own claim (a null recheck_cost must not make an admitted stay read as not admitted), and the line is active for it", async () => {
    const key = scene();
    const s = await holdReservation(key, sceneAt(0), true, { reservation: 9, recheckCost: null });
    await pin(key, 100);
    expect(await lineActive({ budgetKey: key, at: sceneAt(500) }), "the line is active: an admitted live stay holds a reservation").toBe(true);
    const own = await claimAt(key, s, "home", sceneAt(1_000), { mint: "none", readCalls: 1 });
    expect(kindOf(own), "an admitted stay keeps its admission (not `go:idle`, which is what a stay read as NOT admitted would get)").toBe("go:admitted");
  });

  it("a row with BOTH columns null (every stay at deploy) reserves the unpriced maximum, 21 + 3 completing", async () => {
    for (const [tokens, want] of [[45 - 1, "queued"], [45, "go:admit"]] as const) {
      const key = scene();
      await holdReservation(key, sceneAt(0), true); // unstamped: 21 + 3 = 24; a 21-priced `all` flag-off claim needs 21
      await pin(key, tokens);
      const x = await seedBoard();
      const a = await claimAt(key, x, "home", sceneAt(1_000)); // askOf's default: all, 3 calls a read = 21
      expect(kindOf(a), `bucket ${tokens}`).toBe(want);
    }
  });
});

describe.skipIf(!DB)("the pool and the estimate follow the stamped prices", () => {
  it("a pool of 17 with an 8-priced stay ahead (8 + its recheck 1 reserved: 9): an 8-priced claim is admitted at once (9 + 8 = 17) and a 9-priced one is held (9 + 9 = 18)", async () => {
    // "Ahead" is an ADMITTED stay: only an admitted stay holds a reservation in the pool (a waiting one blocks the tail instead).
    let checked = 0;
    for (const [mint, want] of [["room", "go:admit"], ["all", "queued"]] as const) {
      const key = scene();
      await holdReservation(key, sceneAt(0), true, { reservation: 8, recheckCost: 1 });
      await pin(key, 17);
      const x = await seedBoard();
      const a = await claimAt(key, x, "home", sceneAt(1_000), { mint, readCalls: 1 });
      expect(kindOf(a), `${mint} (flag on): bucket 17, 9 reserved`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(2);
  });

  it("the stay ahead NOT completing reserves 8 alone: the same pool of 17 admits the 9-priced claim too (8 + 9 = 17)", async () => {
    const key = scene();
    await holdReservation(key, sceneAt(0), false, { reservation: 8, recheckCost: 1 });
    await pin(key, 17);
    const x = await seedBoard();
    expect(kindOf(await claimAt(key, x, "home", sceneAt(1_000), { mint: "all", readCalls: 1 }))).toBe("go:admit");
  });

  it("three waiting stays priced 9 (all, flag on), 8 (room, flag on) and 21 (all, flag off) ahead of a fourth: etaS = ceil((10 + 9 + 24 + its own need 8 - pool 4) / refill + poll)", async () => {
    const key = scene();
    await holdReservation(key, sceneAt(0)); // an admitted stay reserving 21: the line is active
    await pin(key, 25); // pool = 25 - 21 = 4: every claim below is held
    const ahead = [
      { mint: "all", readCalls: 1, stamp: [9, 1] },
      { mint: "room", readCalls: 1, stamp: [8, 1] },
      { mint: "all", readCalls: 3, stamp: [21, 3] },
    ] as const;
    const boards = [];
    for (const [i, p] of ahead.entries()) {
      const b = await seedBoard();
      boards.push(b);
      const a = await claimAt(key, b, "home", sceneAt(1_000 + i * 1_000), { mint: p.mint, readCalls: p.readCalls });
      expect(kindOf(a), `place ${i + 1}: held`).toBe("queued");
      expect(await priceOf(b.fixtureId, b.home.personId), `place ${i + 1}: stamped by its first claim`).toEqual(p.stamp);
    }
    const d = await seedBoard();
    const a = await claimAt(key, d, "home", sceneAt(4_000), { mint: "room", readCalls: 1 });
    expect(a.kind).toBe("queued");
    if (a.kind !== "queued") throw new Error("unreachable");
    expect(a.line.position, "behind the three").toBe(4);
    // Hand: places ahead (9+1) + (8+1) + (21+3) = 43; its own need 8; pool 4 -> 47 tokens at 2 a second = 23.5 s; the fourth place polls
    // at the near cadence, 3 s: 26.5, rounded up.
    expect(RTK_BUDGET_REFILL_PER_S, "premise: the refill the hand count uses").toBe(2);
    expect(LINE_POLL_MS, "premise: the near cadence the hand count uses").toBe(3_000);
    expect(a.line.etaS).toBe(27);
    // The wrong answers' constants: the old position pricing (3 x 24 + 21 - 4 = 89 tokens -> 44.5 + 3 = 48) and a flat 'none' price
    // for every place (3 x 9 + 8 - 4 = 31 -> 15.5 + 3 = 19) both differ.
    expect(Math.ceil((3 * 24 + 21 - 4) / 2 + 3), "premise: the old pricing says 48").toBe(48);
    expect(Math.ceil((3 * 9 + 8 - 4) / 2 + 3), "premise: pricing every place as the cheapest says 19").toBe(19);
  });

  it("a WAITING stay ahead with a null stamp is promised at the unpriced maximum, column by column: both null 21 + 3, only the recheck null 9 + 3, only the reservation null 21 + 1 - and a fully stamped one 9 + 1 for contrast", async () => {
    // The estimate's `aheadReserved` coalesces each column on its own (`readStanding`'s ahead sum): a row from before the stamp, or one
    // with a single column null, must not drop out of the sum (a NULL addend makes the whole row's term NULL, and `sum` skips it).
    expect([LINE_RESERVATION_MAX, LINE_FALLBACK_READ_CALLS], "premise: the unpriced maximum and the unpriced re-verify the hand count uses").toEqual([21, 3]);
    expect(RTK_BUDGET_REFILL_PER_S, "premise: the refill the hand count uses").toBe(2);
    expect(LINE_POLL_MS, "premise: the near cadence the hand count uses").toBe(3_000);
    // etaS = ceil((promised ahead + own need 8 - pool 4) / 2 + 3 s). The fourth claim is a `room` stay (need 8, flag on), not completing.
    const CASES = [
      { label: "both columns null", stamp: [null, null], promised: 24, etaS: 17 }, // (24 + 8 - 4) / 2 + 3 = 17
      { label: "only recheck_cost null", stamp: [9, null], promised: 12, etaS: 11 }, // (12 + 8 - 4) / 2 + 3 = 11
      { label: "only reservation null", stamp: [null, 1], promised: 22, etaS: 16 }, // (22 + 8 - 4) / 2 + 3 = 16
      { label: "fully stamped (contrast)", stamp: [9, 1], promised: 10, etaS: 10 }, // (10 + 8 - 4) / 2 + 3 = 10
    ] as const;
    let checked = 0;
    for (const c of CASES) {
      const key = scene();
      await holdReservation(key, sceneAt(0)); // an admitted, unstamped stay reserving 21: the line is active
      await pin(key, 25); // pool = 25 - 21 = 4: the claim below is held
      const ahead = await seedBoard();
      await putStay({
        fixtureId: ahead.fixtureId,
        personId: ahead.home.personId,
        budgetKey: key,
        firstClaimAt: sceneAt(1_000),
        gate: "held",
        queuedAt: sceneAt(1_000),
        reservation: c.stamp[0],
        recheckCost: c.stamp[1],
      });
      expect(await priceOf(ahead.fixtureId, ahead.home.personId), `${c.label}: premise: the row is stored as seeded`).toEqual([...c.stamp]);
      const d = await seedBoard();
      const a = await claimAt(key, d, "home", sceneAt(2_000), { mint: "room", readCalls: 1 });
      expect(a.kind, `${c.label}: held`).toBe("queued");
      if (a.kind !== "queued") throw new Error("unreachable");
      expect(a.line.position, `${c.label}: behind the one`).toBe(2);
      expect(a.line.etaS, `${c.label}: ${c.promised} promised ahead`).toBe(c.etaS);
      checked += 1;
    }
    expect(checked, "cases checked").toBe(4);
    // The four estimates are four different numbers: no case is satisfied by another's value.
    expect(new Set(CASES.map((c) => c.etaS)).size).toBe(4);
  });
});

describe.skipIf(!DB)("the idle completing level follows the read price (the defect the old level's comment records must not return under either)", () => {
  it("proof flag OFF (3 calls a read): a completing claim is held below 7 and admitted at 7; flag ON (1 call a read): held below 3 and admitted at 3", async () => {
    let checked = 0;
    for (const [readCalls, tokens, want] of [
      [3, 6, "queued"],
      [3, 7, "go:idle"],
      [1, 2, "queued"],
      [1, 3, "go:idle"],
      [1, 6, "go:idle"], // held under the flag-off level (7), admitted under the flag-on one
      [3, 3, "queued"], // admitted under the flag-on level (3), held under the flag-off one
    ] as const) {
      const key = scene();
      await pin(key, tokens);
      const b = await seedBoard();
      const a = await claimAt(key, b, "home", sceneAt(1_000), { readCalls, otherCounted: true });
      expect(kindOf(a), `readCalls ${readCalls}, bucket ${tokens}`).toBe(want);
      checked += 1;
    }
    expect(checked, "cases driven").toBe(6);
  });

  it("a level of the recheck cost ALONE is held under both read prices (1 token flag on, 3 tokens flag off)", async () => {
    for (const [readCalls, recheck] of [[1, 1], [3, 3]] as const) {
      const key = scene();
      await pin(key, recheck);
      const b = await seedBoard();
      expect(kindOf(await claimAt(key, b, "home", sceneAt(1_000), { readCalls, otherCounted: true })), `readCalls ${readCalls}`).toBe("queued");
    }
  });
});

describe.skipIf(!DB)("upsertStay writes the price pair together or not at all (M6)", () => {
  it("every path leaves both columns set (never one): insert, a claim of the same stay, a restart, a row from before the stamp, and a row with one column null", async () => {
    const key = scene();
    const b = await seedBoard();
    const ids = { fixtureId: b.fixtureId, personId: b.home.personId, budgetKey: key };
    const at = (s: number) => sceneAt(s * 1_000);
    const up = (s: number, price: [number, number]) => upsertStay(sql, { ...ids, now: at(s), arrival: at(s), reservation: price[0], recheckCost: price[1] });
    const pair = async () => {
      const r = (await stayRow(b.fixtureId, b.home.personId))!;
      return { reservation: r.reservation, recheckCost: r.recheck_cost };
    };
    const legacy = (seen: number, price: { reservation: number | null; recheckCost: number | null }) =>
      putStay({ ...ids, firstClaimAt: at(seen), seenAt: at(seen), gate: "passed", ...price });
    let paths = 0;
    const both = (got: { reservation: number | null; recheckCost: number | null }, want: { reservation: number; recheckCost: number }, label: string) => {
      expect(got, label).toEqual(want);
      expect(got.reservation === null, `${label}: both or neither`).toBe(got.recheckCost === null);
      paths += 1;
    };

    await up(0, [9, 1]);
    both(await pair(), { reservation: 9, recheckCost: 1 }, "insert");
    const again = await up(1, [8, 3]);
    expect(again.restarted, "premise: the same stay").toBe(false);
    both(await pair(), { reservation: 9, recheckCost: 1 }, "a claim of the same stay re-prices neither");

    await endStay({ ...ids, how: "served", at: at(2) });
    const restarted = await up(3, [8, 3]);
    expect(restarted.restarted, "premise: a served stay restarts").toBe(true);
    both(await pair(), { reservation: 8, recheckCost: 3 }, "a restart stamps both anew");

    await legacy(10, { reservation: null, recheckCost: null });
    both({ reservation: null, recheckCost: null }, { reservation: null as never, recheckCost: null as never }, "premise: the row is from before the stamp");
    await up(11, [8, 1]);
    both(await pair(), { reservation: 8, recheckCost: 1 }, "a row from before the stamp is stamped by its next claim");

    await legacy(20, { reservation: 9, recheckCost: null });
    await up(21, [8, 3]);
    both(await pair(), { reservation: 9, recheckCost: 3 }, "reservation set, recheck null: the set one stays, the null one is stamped");

    await legacy(30, { reservation: null, recheckCost: 3 });
    await up(31, [8, 1]);
    both(await pair(), { reservation: 8, recheckCost: 3 }, "recheck set, reservation null: the set one stays, the null one is stamped");

    expect(paths, "paths checked (the premise row counts once)").toBe(7);
  });
});

