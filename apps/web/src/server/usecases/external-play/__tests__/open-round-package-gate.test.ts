// Online Chess credits, Task 9 (spec docs/superpowers/specs/2026-11-23-online-chess-credits-design.md §7.6 "openRound" and "Pay and
// open", §8.5; decisions 12 and 15; P8, P18, P20): the payment door at "Open round". The FIRST open of any round of an online division
// needs a PAID package that COVERS the division as it stands (places held, Swiss rounds, cameras); otherwise 402 ONLINE_CHESS_UNPAID
// carrying the quote, and nothing is written. Paying can ride on the open (`pay`): the debit, the stamp and the freeze commit together
// or not at all, and a decision that opens nothing pays nothing. Once the package is frozen no round asks anything again.
//
// REAL `openRound` against a REAL migrated database (skipped without DATABASE_URL); the invites go out through the real outbox to a
// stubbed provider. single-sport: online play exists only for `boardgame` (online-play.ts `supportsOnlinePlay`); every other sport is
// refused ROUND_NOT_ONLINE before any of this (open-round.test.ts sweeps the registry for that).
//
// Where the expected numbers come from - never from the gate, the quote or the leaf:
//   * prices: the plan's Global Constraints table (`GC_PRICE`, _oc-rig.ts): 16 -> 1 / 2, 32 -> 2 / 4, 64 -> 4 / 8 (without / with cameras);
//   * included rounds: P1, log2(size) + 2: 16 -> 6, 32 -> 7;
//   * the non-opening results of openRound: `OPEN_ROUND_REFUSALS` plus `already_open`, read from lib/open-round.ts.
//
// Mutant table (each run once by hand from a `cp` backup, the suite's total pinned (27, then 29 with review m4); all killed):
//   G1   an unpaid row opens (the cover check and the freeze dropped)  -> 15, "unpaid: 402 ..." first
//   G2   "paid" judged by paid_at alone, not by cover                  -> the three "paid but not covering" cases
//   G3   the gate (and its payment) moved to the top of the transaction, before the decision -> "... does not open writes no debit"
//   G3b  the payment made before openRound's own refusals, on a transaction of its own -> that sweep, both ROUND_CHANGED cases, P18
//   G4   the freeze skipped                                             -> 11, "paid and covering: opens, frozen_at set" first
//   G6   the frozen check dropped (a frozen row asked again)            -> "round 2 ... round 1 then asks nothing", "later opens", "grandfathered"
//   G7a  the P18 promotion never called                                 -> "paying 32 on the open ... promoted"
//   G7c  the promotion called on every open / G7d on any applied payment -> "paying the stored size promotes nobody"
//   G8   the held > 256 sentence dropped                                -> "held above 256"
//   G9   the missing-row refusal dropped                                -> "no live package"
//   G10  the pay-and-open format gate dropped (beforeCharge)            -> "pay and open on a legacy league ..."
//   G11  `next` never offered                                           -> "Swiss rounds raised ...", "places held grown ..."
//   G12  the payment committed on a transaction of its own (not the open's) -> "a failure AFTER the payment ... rolls it back"
//   M4   the gate put back before the invite fan-out (the money lock held across it) -> "the org money lock is not held ..."
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliverMessage } from "@/server/email-outbox/transport";
import { stubOutboxEnv, type SentInvite } from "@/server/usecases/__tests__/_invite-mail";

const mail = vi.hoisted(() => ({ sent: [] as SentInvite[], fail: new Set<string>() }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { ...actual, externalPlayInviteEmail: h.renderInviteForTest };
});
vi.mock("@/server/email-outbox/transport", async () => {
  const h = await import("@/server/usecases/__tests__/_invite-mail");
  return { deliver: (msg: DeliverMessage) => h.deliverForTest(mail, msg) };
});
beforeEach(() => {
  stubOutboxEnv();
  mail.sent.length = 0;
});

// Staging for the two "the round changed" cases: a hook between the unlocked reads and the locked transaction (the fresh re-check
// refuses BEFORE the gate), and a one-shot throw from the first board's attach (DURING the invite fan-out, inside the transaction,
// before the gate: the payment is taken last). `duringAttach` runs once while the fan-out is under way (review m4's witness).
const race = vi.hoisted(() => ({
  afterSeats: null as null | (() => Promise<void>),
  attachThrows: false,
  duringAttach: null as null | (() => Promise<void>),
}));
vi.mock("../invite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../invite")>();
  return {
    ...actual,
    attachToOpen: async (...args: Parameters<typeof actual.attachToOpen>) => {
      if (race.duringAttach) {
        const hook = race.duringAttach;
        race.duringAttach = null;
        await hook();
      }
      if (race.attachThrows) {
        race.attachThrows = false;
        const { HttpError } = await import("@/lib/errors");
        throw new HttpError(409, "The round changed while it was being opened — try again", "ROUND_CHANGED");
      }
      return actual.attachToOpen(...args);
    },
    boardSeats: async (f: Parameters<typeof actual.boardSeats>[0]) => {
      const seats = await actual.boardSeats(f);
      if (race.afterSeats) {
        const hook = race.afterSeats;
        race.afterSeats = null;
        await hook();
      }
      return seats;
    },
  };
});

// P18's witness: when the promotion runs, what does ANOTHER connection read of the package? Frozen means the open had committed.
const promotion = vi.hoisted(() => ({ calls: [] as { divisionId: string; frozenSeenOutside: boolean }[] }));
vi.mock("@/server/usecases/registrations/promote-into-room", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/registrations/promote-into-room")>();
  return {
    ...actual,
    promoteIntoNewRoom: async (divisionId: string, actorId: string | null) => {
      const { sql: pool } = await import("@/lib/db");
      const [row] = await pool<{ frozen: boolean }[]>`
        select frozen_at is not null as frozen from division_online_packages where division_id = ${divisionId} and refunded_at is null`;
      promotion.calls.push({ divisionId, frozenSeenOutside: row?.frozen === true });
      return actual.promoteIntoNewRoom(divisionId, actorId);
    },
  };
});

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { OPEN_ROUND_REFUSALS } from "@/lib/open-round";
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES, sizeFor, type OnlineSize } from "@/lib/online-chess-package";
import type { AuthCtx } from "@/server/api-v1/auth";
import { openRound } from "../open-round";
import { createEntrants } from "../../entrants";
import { createStages, generateStageFixtures } from "../../stages";
import { startDivision } from "../../schedule";
import { patchDivision } from "../../divisions";
import { createCompetition } from "../../competitions";
import { createDivision } from "../../divisions";
import { onlinePackageQuote, payOnlinePackage, type PackageQuote } from "../../online-package";
import { orgMoneyLockKey } from "../../stream-credits";
import {
  paySeededPackage,
  seedOnlineChessRound,
  seedOnlineSwiss,
  seedOwner,
  seedPlayer,
} from "../../__tests__/_external-play-seed";
import { addMany, fillEntrants, sizeRig } from "../../__tests__/_online-size-rig";
import { expectLeafPrices, freezeGrandfathered, gcPrice, liveOf, packageLedger, spendTheMonth } from "../../online-package/__tests__/_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** P1: the Swiss rounds each size includes, typed from the spec (log2(size) + 2). */
const INCLUDED: Record<OnlineSize, number> = { 16: 6, 32: 7, 64: 8, 128: 9, 256: 10 };
/** The largest size on the ladder, from the spec's decision 5 table (the online cap). */
const LARGEST = 256;

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got an answer");
}
const quoteIn = (e: HttpError): PackageQuote => (e.extra as { quote: PackageQuote }).quote;
const nextIn = (e: HttpError): PackageQuote | null => (e.extra as { next: PackageQuote | null }).next;

const stampsOf = async (stageId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from stage_round_opens where stage_id = ${stageId}`)[0]!.n;
const ledgerCount = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${orgId}`)[0]!.n;
const balanceOf = async (orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select coalesce(sum(delta), 0)::int as n from org_stream_credits where org_id = ${orgId}`)[0]!.n;
/** Every consume or refund the package's own ledger holds, netted: what was taken for it. */
const takenFor = async (packageId: string): Promise<number> =>
  (await packageLedger(packageId)).reduce((n, r) => n - r.delta, 0);

/** What the organiser's receipt shows for `size`, and the pay-and-open body confirming it. */
async function confirmFor(owner: AuthCtx, divisionId: string, size: OnlineSize) {
  const shown = await onlinePackageQuote(owner, divisionId, size);
  expect(shown.refusal, `premise: ${size} can be bought`).toBeNull();
  expect(shown.take, `premise: the balance covers ${size}`).not.toBeNull();
  return { size, expectedOwed: shown.owed };
}

/** An online division whose first stage is a KNOCKOUT of `players` linked players, Generated and Started, its package UNPAID. */
async function seedOnlineKnockout(players: number) {
  const owner = await seedOwner();
  const competition = await createCompetition(owner, {
    name: "T9 KO", visibility: "public", branding: {}, starts_on: "2030-10-01", ends_on: "2030-10-02",
  });
  const division = await createDivision(owner, competition.id, {
    name: "KO Open", sport_key: "boardgame", variant_key: "classical",
    config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
  });
  for (let i = 0; i < players; i++) {
    const p = await seedPlayer(owner.orgId, `K${i + 1}`, `k-${randomUUID().slice(0, 10)}`, true);
    await createEntrants(owner, division.id, [
      { display_name: `K${i + 1}`, kind: "individual", seed: i + 1, members: [{ person_id: p.personId, is_captain: false, roles: [] }] },
    ]);
  }
  const [stage] = await createStages(owner, division.id, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
  await generateStageFixtures(owner, stage!.id);
  await startDivision(owner, division.id);
  return { owner, divisionId: division.id, stageId: stage!.id };
}

describe.skipIf(!HAS_DB)("Open round: the payment door (Online Chess credits §7.6)", () => {
  it("premise: the leaf charges the Global Constraints table, every cell", () => {
    expect(expectLeafPrices()).toBe(10);
  });

  it("unpaid: 402 ONLINE_CHESS_UNPAID carrying the quote for the STORED size; no stamp, no invite, no debit, not frozen", async () => {
    // Decision 15: the organiser CHOSE 64 for a field of 30. The quote is for 64, never the smallest size that holds 30.
    const s = await seedOnlineSwiss({ players: 30, onlineSize: 64, onlinePackage: "unpaid" });
    expect(sizeFor(30), "premise: the smallest size holding 30 is not the chosen one (the witness differs)").toBe(32);
    const ledgerBefore = await ledgerCount(s.orgId);
    const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }));
    expect(e.status).toBe(402);
    expect(e.code).toBe(ONLINE_PACKAGE_CODES.unpaid);
    expect(e.code, "the spec's code, typed").toBe("ONLINE_CHESS_UNPAID");
    const q = quoteIn(e);
    expect(q.size, "the stored size, 64").toBe(64);
    expect(q.held, "30 places held").toBe(30);
    expect(q.owed, "an unpaid row owes the full price of 64 without cameras").toBe(gcPrice(64));
    expect(q.covers, "nothing paid covers nothing").toBe(false);
    expect(q.refusal, "64 can be bought").toBeNull();
    expect(nextIn(e), "the stored size is not refused: no other size is offered").toBeNull();
    expect(await stampsOf(s.stageId), "no stamp").toBe(0);
    expect(mail.sent, "no invite").toEqual([]);
    expect(await ledgerCount(s.orgId), "no ledger row (not even the month's rollover)").toBe(ledgerBefore);
    const p = await liveOf(s.divisionId);
    expect([p.paid_at, p.frozen_at], "still unpaid and changeable").toEqual([null, null]);
  }, 180_000);

  it("paid and covering: opens, frozen_at set, and the open itself takes nothing", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    await payOnlinePackage(s.owner, s.divisionId, await confirmFor(s.owner, s.divisionId, 16));
    const paid = await liveOf(s.divisionId);
    expect(paid.paid_at, "premise: paid through the pay door").not.toBeNull();
    expect(paid.frozen_at, "premise: not frozen by paying").toBeNull();
    const ledgerBefore = await ledgerCount(s.orgId);
    const r = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId });
    expect(r.opened).toBe(true);
    const after = await liveOf(s.divisionId);
    expect(after.frozen_at, "the first open froze the package").not.toBeNull();
    expect(after.frozen_at!.getTime(), "frozen at or after it was paid").toBeGreaterThanOrEqual(paid.paid_at!.getTime());
    expect(await ledgerCount(s.orgId), "the open wrote no ledger row").toBe(ledgerBefore);
    expect(await takenFor(paid.id), "still exactly the price of 16").toBe(gcPrice(16));
    expect(await stampsOf(s.stageId)).toBe(1);
  }, 120_000);

  describe("paid but not covering: refused with the difference, nothing written", () => {
    it("cameras turned on at the stage level after a payment without them: the quote owes the camera difference", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      await payOnlinePackage(s.owner, s.divisionId, await confirmFor(s.owner, s.divisionId, 16));
      expect((await liveOf(s.divisionId)).cameras_paid, "premise: paid without cameras").toBe(false);
      // No stage-level camera door exists (Task 8's tripwire): the spec's case is written as the stage would hold it.
      await sql`update stages set camera_policy = 'required' where id = ${s.stageId}`;
      const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }));
      expect([e.status, e.code]).toEqual([402, "ONLINE_CHESS_UNPAID"]);
      const q = quoteIn(e);
      expect([q.size, q.cameras, q.covers], "the paid size, now with cameras, not covering").toEqual([16, true, false]);
      expect(q.owed, "the difference: 16 with cameras minus 16 without").toBe(gcPrice(16, true) - gcPrice(16));
      expect(e.message, "it says the paid package no longer covers").toMatch(/no longer covers/);
      expect(await stampsOf(s.stageId)).toBe(0);
      expect((await liveOf(s.divisionId)).frozen_at).toBeNull();
      // ...and paying that difference on the open opens it (the camera price is then paid, P19).
      const r = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 16, expectedOwed: q.owed } });
      expect(r.opened).toBe(true);
      const p = await liveOf(s.divisionId);
      expect([p.cameras_paid, p.frozen_at !== null]).toEqual([true, true]);
      expect(await takenFor(p.id), "16 with cameras, in all").toBe(gcPrice(16, true));
    }, 120_000);

    it("Swiss rounds raised past the paid size's included rounds: refused, and the next size's difference is offered", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      await payOnlinePackage(s.owner, s.divisionId, await confirmFor(s.owner, s.divisionId, 16));
      const raised = INCLUDED[16] + 1;
      expect(raised, "premise: 7 rounds is more than 16 includes and what 32 includes").toBe(INCLUDED[32]);
      // The rounds doors refuse this on a paid row (Task 8); the stage holds it the way a pre-gate save left it.
      await sql`update stages set config = config || ${sql.json({ rounds: raised } as never)} where id = ${s.stageId}`;
      const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }));
      expect([e.status, e.code]).toEqual([402, "ONLINE_CHESS_UNPAID"]);
      const q = quoteIn(e);
      expect([q.size, q.rounds, q.refusal, q.covers]).toEqual([16, raised, "rounds", false]);
      const next = nextIn(e);
      expect(next?.size, "the smallest size that includes 7 rounds").toBe(32);
      expect(next?.owed, "the difference: 32 minus the 16 already paid").toBe(gcPrice(32) - gcPrice(16));
      expect(await stampsOf(s.stageId)).toBe(0);
    }, 120_000);

    it("places held grown past the paid size: refused, and the next size's difference is offered", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      await payOnlinePackage(s.owner, s.divisionId, await confirmFor(s.owner, s.divisionId, 16));
      // The entrant doors refuse a 17th on a size of 16 (Task 7); the rows are written as a pre-cap division holds them.
      await fillEntrants(s.divisionId, 16 + 1 - 4);
      const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }));
      const q = quoteIn(e);
      expect([e.code, q.size, q.held, q.refusal, q.covers]).toEqual(["ONLINE_CHESS_UNPAID", 16, 17, "below_held", false]);
      expect([nextIn(e)?.size, nextIn(e)?.owed]).toEqual([32, gcPrice(32) - gcPrice(16)]);
    }, 120_000);
  });

  it("pay and open: one debit, one stamp, frozen, the payer named", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    const body = await confirmFor(s.owner, s.divisionId, 16);
    expect(body.expectedOwed, "an unpaid 16 without cameras").toBe(gcPrice(16));
    const r = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: body });
    expect(r.opened).toBe(true);
    if (r.opened) expect(r.invited, "both boards' four seats").toBe(4);
    const p = await liveOf(s.divisionId);
    expect(p.paid_at, "paid").not.toBeNull();
    expect(p.frozen_at, "frozen").not.toBeNull();
    const [{ paid_by }] = await sql<{ paid_by: string }[]>`select paid_by from division_online_packages where id = ${p.id}`;
    expect(paid_by, "the organiser who opened it paid").toBe(s.ownerUserId);
    expect(await packageLedger(p.id), "ONE consume row, from this month's included credits").toEqual([
      { reason: "consume", bucket: "monthly", delta: -gcPrice(16) },
    ]);
    expect(p.credits_paid).toBe(gcPrice(16));
    expect(await stampsOf(s.stageId), "one stamp").toBe(1);
  }, 120_000);

  it("pay and open where the round does not open writes no debit - one case per non-opening result of openRound", async () => {
    const reasons: string[] = [];
    const check = async (label: string, setup: () => Promise<{ owner: AuthCtx; divisionId: string; stageId: string; roundNo: number; pay: { size: OnlineSize; expectedOwed: number } }>) => {
      const c = await setup();
      const pkg = await liveOf(c.divisionId);
      const ledgerBefore = await ledgerCount(c.owner.orgId);
      const stampsBefore = await stampsOf(c.stageId);
      const r = await openRound({ stageId: c.stageId, roundNo: c.roundNo, actorUserId: c.owner.userId!, pay: c.pay });
      expect(r.opened, `${label}: the round did not open`).toBe(false);
      if (!r.opened) reasons.push(r.reason);
      expect(await ledgerCount(c.owner.orgId), `${label}: no ledger row`).toBe(ledgerBefore);
      expect(await stampsOf(c.stageId), `${label}: no new stamp`).toBe(stampsBefore);
      const after = await liveOf(c.divisionId);
      expect([after.credits_paid, after.size, after.frozen_at?.getTime() ?? null], `${label}: the package is as it was`)
        .toEqual([pkg.credits_paid, pkg.size, pkg.frozen_at?.getTime() ?? null]);
    };
    // Each payment is one the organiser could make right now (the receipt shows it, the balance covers it): only the decision stops it.
    await check("division_not_started", async () => {
      const s = await seedOnlineSwiss({ players: 4, divisionStarted: false, onlinePackage: "unpaid" });
      return { owner: s.owner, divisionId: s.divisionId, stageId: s.stageId, roundNo: 1, pay: await confirmFor(s.owner, s.divisionId, 16) };
    });
    await check("clock_not_playable", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      // A stored clock outside the curated list (pre-gate legacy data): the clock gate refuses only a CHANGE, so it is written by SQL.
      await sql`update divisions set config = config || ${sql.json({ clock: { base: 60, increment: 0 } } as never)} where id = ${s.divisionId}`;
      return { owner: s.owner, divisionId: s.divisionId, stageId: s.stageId, roundNo: 1, pay: await confirmFor(s.owner, s.divisionId, 16) };
    });
    await check("no_fixtures", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      return { owner: s.owner, divisionId: s.divisionId, stageId: s.stageId, roundNo: 99, pay: await confirmFor(s.owner, s.divisionId, 16) };
    });
    await check("not_paired", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      // Round 2's shells exist and are not paired until round 1 is played.
      return { owner: s.owner, divisionId: s.divisionId, stageId: s.stageId, roundNo: 2, pay: await confirmFor(s.owner, s.divisionId, 16) };
    });
    await check("already_open", async () => {
      // The round is open and every seat invited, so the open is `already_open`. The package is put back UNFROZEN and a move up to 32
      // is payable: the worst case, where only the decision ('nothing to do') stands between the call and a debit.
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      const first = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: await confirmFor(s.owner, s.divisionId, 16) });
      expect(first.opened, "premise: round 1 opened").toBe(true);
      await sql`update division_online_packages set frozen_at = null where division_id = ${s.divisionId} and refunded_at is null`;
      return { owner: s.owner, divisionId: s.divisionId, stageId: s.stageId, roundNo: 1, pay: await confirmFor(s.owner, s.divisionId, 32) };
    });
    const expected = [...OPEN_ROUND_REFUSALS, "already_open"];
    expect(reasons.length, "one case per non-opening result").toBe(OPEN_ROUND_REFUSALS.length + 1);
    expect([...reasons].sort(), "every non-opening result, each once").toEqual([...expected].sort());
  }, 300_000);

  describe("the first open is not round 1: any first open meets the gate (P8)", () => {
    it("a knockout first stage: refused unpaid, then paid and opened on the same press", async () => {
      const k = await seedOnlineKnockout(4);
      const e = await refusal(openRound({ stageId: k.stageId, roundNo: 1, actorUserId: k.owner.userId! }));
      expect([e.status, e.code, quoteIn(e).size, quoteIn(e).rounds]).toEqual([402, "ONLINE_CHESS_UNPAID", 16, 0]);
      const r = await openRound({ stageId: k.stageId, roundNo: 1, actorUserId: k.owner.userId!, pay: await confirmFor(k.owner, k.divisionId, 16) });
      expect(r.opened).toBe(true);
      expect((await liveOf(k.divisionId)).frozen_at).not.toBeNull();
    }, 120_000);

    it("round 2 opened before round 1: refused unpaid; paid, it opens and freezes; round 1 then asks nothing", async () => {
      const r2 = await seedOnlineChessRound({ roundNo: 2, fixtures: 1, onlinePackage: "unpaid" });
      const e = await refusal(openRound({ stageId: r2.stageId, roundNo: 2, actorUserId: r2.ownerUserId }));
      expect([e.status, e.code]).toEqual([402, "ONLINE_CHESS_UNPAID"]);
      expect(await stampsOf(r2.stageId)).toBe(0);
      await paySeededPackage(r2.owner, r2.divisionId);
      const opened = await openRound({ stageId: r2.stageId, roundNo: 2, actorUserId: r2.ownerUserId });
      expect(opened.opened).toBe(true);
      const frozenAt = (await liveOf(r2.divisionId)).frozen_at;
      expect(frozenAt, "round 2's open froze it").not.toBeNull();
      // Round 1 (its own boards, the same two players) now asks nothing.
      await sql`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
        values (${r2.stageId}, ${r2.divisionId}, ${r2.orgId}, 1, 1, ${`t9-r1-${randomUUID().slice(0, 8)}`}, 'scheduled',
                ${r2.boards[0]!.away.entrantId}, ${r2.boards[0]!.home.entrantId}, now())`;
      const ledgerBefore = await ledgerCount(r2.orgId);
      expect((await openRound({ stageId: r2.stageId, roundNo: 1, actorUserId: r2.ownerUserId })).opened).toBe(true);
      expect(await ledgerCount(r2.orgId)).toBe(ledgerBefore);
      expect((await liveOf(r2.divisionId)).frozen_at?.getTime(), "the freeze stands as the first open wrote it").toBe(frozenAt!.getTime());
    }, 120_000);
  });

  it("the second and later opens ask nothing, even with zero credits and a package that no longer covers", async () => {
    const s = await seedOnlineChessRound({ fixtures: 2 }); // paid (the seed's default)
    expect((await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId })).opened).toBe(true);
    const frozen = await liveOf(s.divisionId);
    expect(frozen.frozen_at, "premise: the first open froze it").not.toBeNull();
    // Nothing left to pay with, and a package that would not cover the division now (17 held on a size of 16).
    const total = await balanceOf(s.orgId);
    if (total > 0) {
      await sql`insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
                values (${s.orgId}, ${-total}, 'revoke', 'pack', 0, 'test: spent')`;
    }
    expect(await balanceOf(s.orgId), "premise: zero credits").toBe(0);
    await fillEntrants(s.divisionId, 17 - 4);
    // Round 2: the same four players, re-paired.
    for (const [i, [h, a]] of [[s.boards[0]!.home, s.boards[1]!.home], [s.boards[0]!.away, s.boards[1]!.away]].entries()) {
      await sql`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
        values (${s.stageId}, ${s.divisionId}, ${s.orgId}, 2, ${i + 1}, ${`t9-r2-${randomUUID().slice(0, 8)}`}, 'scheduled', ${h.entrantId}, ${a.entrantId}, now())`;
    }
    const ledgerBefore = await ledgerCount(s.orgId);
    const r2 = await openRound({ stageId: s.stageId, roundNo: 2, actorUserId: s.ownerUserId });
    expect(r2.opened, "round 2 opens with nothing asked").toBe(true);
    // A re-press of round 1 (everyone invited: already_open) asks nothing either - and a `pay` on it is not taken.
    const again = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 32, expectedOwed: 2 } });
    expect(again).toMatchObject({ opened: false, reason: "already_open" });
    expect(await ledgerCount(s.orgId), "no ledger row").toBe(ledgerBefore);
    const after = await liveOf(s.divisionId);
    expect([after.size, after.frozen_at?.getTime()], "the package as the first open froze it").toEqual([frozen.size, frozen.frozen_at!.getTime()]);
  }, 180_000);

  it("a grandfathered row (frozen, unpaid: the backfill's) is never asked, with or without a payment on the press", async () => {
    const s = await seedOnlineChessRound({ fixtures: 1, onlinePackage: "unpaid" });
    const row = await liveOf(s.divisionId);
    await freezeGrandfathered(row.id);
    const ledgerBefore = await ledgerCount(s.orgId);
    expect((await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 16, expectedOwed: 1 } })).opened).toBe(true);
    const after = await liveOf(s.divisionId);
    expect([after.paid_at, after.credits_paid], "never paid").toEqual([null, 0]);
    expect(after.frozen_at?.getTime(), "the backfill's freeze, untouched").toBe(row.created_at.getTime());
    expect(await ledgerCount(s.orgId)).toBe(ledgerBefore);
  }, 120_000);

  describe("an upgrade racing the open: whichever commits first wins; the loser is refused, never both", () => {
    it("the upgrade first: the stale pay-and-open (16 at 1 credit) is 409 and opens nothing", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      const tabB = await confirmFor(s.owner, s.divisionId, 16);
      await payOnlinePackage(s.owner, s.divisionId, await confirmFor(s.owner, s.divisionId, 32));
      const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: tabB }));
      expect([e.status, e.code]).toEqual([409, "ONLINE_QUOTE_CHANGED"]);
      expect(await stampsOf(s.stageId)).toBe(0);
      const p = await liveOf(s.divisionId);
      expect([p.size, p.frozen_at, await takenFor(p.id)]).toEqual([32, null, gcPrice(32)]);
    }, 120_000);

    it("the open first: the upgrade is 409 (frozen) and takes nothing", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      const tabA = await confirmFor(s.owner, s.divisionId, 32);
      expect((await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: await confirmFor(s.owner, s.divisionId, 16) })).opened).toBe(true);
      const e = await refusal(payOnlinePackage(s.owner, s.divisionId, tabA));
      expect([e.status, e.code, quoteIn(e).refusal]).toEqual([409, "ONLINE_QUOTE_CHANGED", "frozen"]);
      const p = await liveOf(s.divisionId);
      expect([p.size, p.frozen_at !== null, await takenFor(p.id)]).toEqual([16, true, gcPrice(16)]);
    }, 120_000);

    it("both at once: exactly one wins, and the books match the winner", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      const tabA = await confirmFor(s.owner, s.divisionId, 32);
      const tabB = await confirmFor(s.owner, s.divisionId, 16);
      const [up, open] = await Promise.allSettled([
        payOnlinePackage(s.owner, s.divisionId, tabA),
        openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: tabB }),
      ]);
      const won = [up, open].filter((x) => x.status === "fulfilled");
      expect(won.length, "exactly one of the two").toBe(1);
      const lost = [up, open].find((x) => x.status === "rejected") as PromiseRejectedResult;
      expect([(lost.reason as HttpError).status, (lost.reason as HttpError).code]).toEqual([409, "ONLINE_QUOTE_CHANGED"]);
      const p = await liveOf(s.divisionId);
      if (open.status === "fulfilled") {
        expect([p.size, p.frozen_at !== null, await takenFor(p.id), await stampsOf(s.stageId)]).toEqual([16, true, gcPrice(16), 1]);
      } else {
        expect([p.size, p.frozen_at, await takenFor(p.id), await stampsOf(s.stageId)]).toEqual([32, null, gcPrice(32), 0]);
      }
    }, 120_000);
  });

  it("pay and open with a stale expectedOwed answers 409 with the fresh quote and opens nothing", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    const ledgerBefore = await ledgerCount(s.orgId);
    // The receipt showed cameras (2); the division has none now (1).
    const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 16, expectedOwed: gcPrice(16, true) } }));
    expect([e.status, e.code]).toEqual([409, "ONLINE_QUOTE_CHANGED"]);
    expect(quoteIn(e).owed, "the fresh total").toBe(gcPrice(16));
    expect(await stampsOf(s.stageId)).toBe(0);
    expect(mail.sent).toEqual([]);
    expect(await ledgerCount(s.orgId)).toBe(ledgerBefore);
    expect((await liveOf(s.divisionId)).paid_at).toBeNull();
  }, 120_000);

  it("pay and open on a balance that cannot cover it: 402 ONLINE_CHESS_NO_CREDITS (owed, balance), nothing written", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    await spendTheMonth(s.orgId); // the month's included credits granted and spent: the balance is 0
    const shown = await onlinePackageQuote(s.owner, s.divisionId, 16);
    expect([shown.balance, shown.shortBy], "premise: nothing to pay 16 with").toEqual([0, gcPrice(16)]);
    const ledgerBefore = await ledgerCount(s.orgId);
    const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 16, expectedOwed: shown.owed } }));
    expect([e.status, e.code]).toEqual([402, "ONLINE_CHESS_NO_CREDITS"]);
    expect(e.extra).toMatchObject({ owed: gcPrice(16), balance: 0 });
    expect(await ledgerCount(s.orgId), "nothing written").toBe(ledgerBefore);
    expect(await stampsOf(s.stageId)).toBe(0);
    expect((await liveOf(s.divisionId)).paid_at).toBeNull();
  }, 120_000);

  it("pay and open on a legacy league is refused before any charge (the pay door's format gate), nothing written", async () => {
    const s = await seedOnlineChessRound({ fixtures: 1, onlinePackage: "unpaid" });
    const ledgerBefore = await ledgerCount(s.orgId);
    const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 16, expectedOwed: gcPrice(16) } }));
    expect([e.status, e.code, (e.extra as { kind: string }).kind]).toEqual([422, "ONLINE_FORMAT_NOT_SUPPORTED", "league"]);
    expect(await ledgerCount(s.orgId)).toBe(ledgerBefore);
    expect(await stampsOf(s.stageId)).toBe(0);
  }, 120_000);

  it("every board held for a Lichess link on the first open (P8 kept): the round opens, is paid and frozen, and nobody is invited", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    await sql`delete from user_external_accounts where provider = 'lichess' and user_id in ${sql(s.players.map((p) => p.userId))}`;
    const r = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: await confirmFor(s.owner, s.divisionId, 16) });
    expect(r.opened).toBe(true);
    if (r.opened) {
      expect(r.invited, "nobody invited").toBe(0);
      expect(r.skipped.map((k) => k.reason), "both boards held for a link").toEqual(["lichess_unlinked", "lichess_unlinked"]);
    }
    const p = await liveOf(s.divisionId);
    expect([p.paid_at !== null, p.frozen_at !== null, await takenFor(p.id)]).toEqual([true, true, gcPrice(16)]);
    expect(await stampsOf(s.stageId)).toBe(1);
  }, 120_000);

  describe("a refusal inside the transaction rolls the payment back (ruling: all or nothing)", () => {
    it("ROUND_CHANGED during the invite fan-out (a board's attach refuses): no debit, no stamp, not frozen; the press again opens", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      const body = await confirmFor(s.owner, s.divisionId, 16);
      const ledgerBefore = await ledgerCount(s.orgId);
      race.attachThrows = true;
      const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: body }));
      expect(race.attachThrows, "premise: the staged refusal fired").toBe(false);
      expect([e.status, e.code]).toEqual([409, "ROUND_CHANGED"]);
      expect(await ledgerCount(s.orgId), "the debit and the month's rollover rolled back").toBe(ledgerBefore);
      expect(await stampsOf(s.stageId)).toBe(0);
      const p = await liveOf(s.divisionId);
      expect([p.paid_at, p.frozen_at, p.credits_paid]).toEqual([null, null, 0]);
      // And the press again goes through: nothing was left half-done.
      expect((await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: body })).opened).toBe(true);
    }, 120_000);

    it("a failure AFTER the payment, in the same transaction (the database refuses the freeze): the payment rolls back with the round", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      const body = await confirmFor(s.owner, s.divisionId, 16);
      const row = await liveOf(s.divisionId);
      const ledgerBefore = await ledgerCount(s.orgId);
      // The one step after the payment is the freeze: a trigger refuses it for THIS row only (named per run, dropped after), so the
      // debit is already written on the open's transaction when the open fails.
      const fn = `t9_refuse_freeze_${randomUUID().replaceAll("-", "")}`;
      await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$
        begin
          if new.id = '${row.id}'::uuid and new.frozen_at is not null then raise exception 't9: the freeze is refused'; end if;
          return new;
        end $$`);
      await sql.unsafe(`create trigger ${fn} before update on division_online_packages for each row execute function ${fn}()`);
      let failed: unknown = null;
      try {
        await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: body });
      } catch (e) {
        failed = e;
      } finally {
        await sql.unsafe(`drop trigger ${fn} on division_online_packages`);
        await sql.unsafe(`drop function ${fn}()`);
      }
      expect(String(failed), "premise: the open failed at the freeze").toMatch(/the freeze is refused/);
      expect(await ledgerCount(s.orgId), "no debit, no month's rollover").toBe(ledgerBefore);
      expect(await stampsOf(s.stageId), "no stamp").toBe(0);
      expect(mail.sent, "nobody mailed").toEqual([]);
      const p = await liveOf(s.divisionId);
      expect([p.paid_at, p.frozen_at, p.credits_paid], "unpaid and changeable, as before the press").toEqual([null, null, 0]);
    }, 120_000);

    it("the org money lock is not held while the invites fan out: it is taken last, after them (review m4)", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      const body = await confirmFor(s.owner, s.divisionId, 16);
      const free: boolean[] = [];
      // Another transaction asks for the org's money lock while the open is attaching its first board.
      race.duringAttach = async () => {
        free.push(await sql.begin(async (t) =>
          (await t<{ got: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${orgMoneyLockKey(s.orgId)})) as got`)[0]!.got));
      };
      const r = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: body });
      expect(free, "the fan-out ran, and the money lock was free during it").toEqual([true]);
      expect(r.opened).toBe(true);
      const p = await liveOf(s.divisionId);
      expect([p.paid_at !== null, p.frozen_at !== null, await takenFor(p.id)], "paid and frozen at the end of the same open").toEqual([true, true, gcPrice(16)]);
    }, 120_000);

    it("ROUND_CHANGED at the locked re-check (a board re-paired before the lock): no debit, no stamp", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      const body = await confirmFor(s.owner, s.divisionId, 16);
      const ledgerBefore = await ledgerCount(s.orgId);
      const [{ id: boardId }] = await sql<{ id: string }[]>`
        select id from fixtures where stage_id = ${s.stageId} and round_no = 1 and away_entrant_id is not null order by seq_in_round limit 1`;
      race.afterSeats = async () => {
        await sql`update fixtures set status = 'abandoned' where id = ${boardId!}`;
      };
      const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: body }));
      expect([e.status, e.code]).toEqual([409, "ROUND_CHANGED"]);
      expect(await ledgerCount(s.orgId)).toBe(ledgerBefore);
      expect(await stampsOf(s.stageId)).toBe(0);
      expect((await liveOf(s.divisionId)).paid_at).toBeNull();
    }, 120_000);
  });

  describe("P18: a pay-and-open that moves the size UP promotes the waitlist, after the commit", () => {
    async function rigWithWaitlist() {
      const r = await sizeRig({ size: 16, approval: "auto" });
      await addMany(r, 4);
      const [stage] = await createStages(r.auth, r.division.id, { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null });
      await generateStageFixtures(r.auth, stage!.id);
      await startDivision(r.auth, r.division.id);
      const waiting = [await r.waiting(), await r.waiting()];
      for (const id of waiting) expect(await r.statusOf(id), "premise: waitlisted").toBe("waitlisted");
      promotion.calls.length = 0;
      return { r, stageId: stage!.id, waiting };
    }

    it("paying 32 on the open (16 stored): both waiting are promoted, and the promotion saw the open committed", async () => {
      const { r, stageId, waiting } = await rigWithWaitlist();
      const pay = await confirmFor(r.auth, r.division.id, 32);
      expect((await openRound({ stageId, roundNo: 1, actorUserId: r.auth.userId!, pay })).opened).toBe(true);
      expect(promotion.calls, "the promotion ran once, for this division").toHaveLength(1);
      expect(promotion.calls[0], "it read the package frozen from another connection: after the commit").toEqual({
        divisionId: r.division.id, frozenSeenOutside: true,
      });
      for (const id of waiting) expect(await r.statusOf(id), "promoted into the room 32 made").toBe("confirmed");
    }, 180_000);

    it("paying the stored size (no move up) promotes nobody", async () => {
      const { r, stageId, waiting } = await rigWithWaitlist();
      expect((await openRound({ stageId, roundNo: 1, actorUserId: r.auth.userId!, pay: await confirmFor(r.auth, r.division.id, 16) })).opened).toBe(true);
      expect(promotion.calls, "no promotion").toHaveLength(0);
      for (const id of waiting) expect(await r.statusOf(id)).toBe("waitlisted");
    }, 180_000);
  });

  it("held above 256 (a backfilled 256 that is full): the refusal says so plainly, and offers no size", async () => {
    const s = await seedOnlineChessRound({ fixtures: 1, onlinePackage: "unpaid" });
    // The backfill's shape (V549): a division already over the online cap was given 256 and reads as full.
    await sql`update division_online_packages set size = ${LARGEST} where division_id = ${s.divisionId} and refunded_at is null`;
    expect(Math.max(...ONLINE_SIZES), "premise: 256 is the largest size").toBe(LARGEST);
    const held = LARGEST + 44;
    await fillEntrants(s.divisionId, held - 2);
    const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }));
    expect([e.status, e.code, quoteIn(e).held, quoteIn(e).refusal]).toEqual([402, "ONLINE_CHESS_UNPAID", held, "below_held"]);
    expect(nextIn(e), "no size holds 300").toBeNull();
    expect(e.message, "it names the places, the largest size and how many must go").toBe(
      `${held} places are held, more than Online Chess holds in one division (${LARGEST}): ${held - LARGEST} must leave before round 1 can open`,
    );
  }, 120_000);

  it("an online division with no live package (it cannot happen after the migration) is a named 500 and opens nothing", async () => {
    const s = await seedOnlineChessRound({ fixtures: 1, onlinePackage: "unpaid" });
    await sql`delete from division_online_packages where division_id = ${s.divisionId}`;
    const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }));
    expect([e.status, e.code]).toEqual([500, "online_package_missing"]);
    expect(await stampsOf(s.stageId)).toBe(0);
  }, 120_000);

  describe("sequences", () => {
    it("after a full refund (online switched off, then on again): the new package is asked again, and pays and opens", async () => {
      const s = await seedOnlineSwiss({ players: 4, divisionStarted: false, onlinePackage: "unpaid" });
      await payOnlinePackage(s.owner, s.divisionId, await confirmFor(s.owner, s.divisionId, 16));
      const clock = { base: 900, increment: 10 };
      await patchDivision(s.owner, s.divisionId, { config: { variant: "classical", onlinePlay: "off", clock } });
      await patchDivision(s.owner, s.divisionId, { config: { variant: "classical", onlinePlay: "lichess", clock } });
      const fresh = await liveOf(s.divisionId);
      expect([fresh.paid_at, fresh.frozen_at], "premise: a new, unpaid package").toEqual([null, null]);
      await startDivision(s.owner, s.divisionId);
      const e = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }));
      expect(e.code, "the refunded payment does not count").toBe("ONLINE_CHESS_UNPAID");
      expect((await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: await confirmFor(s.owner, s.divisionId, 16) })).opened).toBe(true);
      const p = await liveOf(s.divisionId);
      expect([p.id !== fresh.id, p.frozen_at !== null, await takenFor(p.id)]).toEqual([false, true, gcPrice(16)]);
    }, 180_000);

    it("after a move down (32 paid, moved to 16): the smaller paid size covers, and the open takes nothing more", async () => {
      const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
      await payOnlinePackage(s.owner, s.divisionId, await confirmFor(s.owner, s.divisionId, 32));
      const down = await onlinePackageQuote(s.owner, s.divisionId, 16);
      await payOnlinePackage(s.owner, s.divisionId, { size: 16, expectedOwed: down.owed });
      const moved = await liveOf(s.divisionId);
      expect([moved.size, await takenFor(moved.id)], "premise: moved down, 16's price kept").toEqual([16, gcPrice(16)]);
      const ledgerBefore = await ledgerCount(s.orgId);
      expect((await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId })).opened).toBe(true);
      expect(await ledgerCount(s.orgId)).toBe(ledgerBefore);
      expect((await liveOf(s.divisionId)).frozen_at).not.toBeNull();
    }, 120_000);
  });
});
