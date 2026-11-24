// P18 (Online Chess credits, Task 7; spec 2026-11-23-online-chess-credits-design.md P18, §7.4 items 2 and 3, §11): "Moving up a size
// promotes the waitlist into the new room, by the same automatic promotion a freed place triggers." After a move UP COMMITS - the
// pay door (`payOnlinePackage`) or the unpaid size save (`patchDivision`) - the oldest waitlisted registrants are promoted into the
// places the new size made, and into no more than that. REAL doors against a REAL migrated database; skipped without DATABASE_URL.
//
// Where the expected numbers come from - never from promote-into-room.ts or the cap module:
//   * the sizes are the ladder 16 / 32 / 64 (spec §5.2) and the room is plain arithmetic: size - places held;
//   * what a promotion DOES to an entry is the existing rule of the waitlist (`promotionSeats`): an auto-approval division with no fee
//     seats the registrant at once (status `confirmed`); a manual-approval one moves it to `pending` for the organiser;
//   * the order is oldest first: the order the registrants joined the waitlist in, typed by the test's own creation order.
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`); every other sport has no size to move.
//
// Mutant table (each run once by hand against these tests; results are in the commit message):
//   P1  the pay door does not call the promotion                    -> "16 full + 3 waitlisted, a move up to 32 promotes all 3"
//   P2  the promotion ignores the room check (promotes everyone)    -> "room for two: the oldest two, the third waits", "a capacity below the size"
//   P3  a move DOWN or an unchanged size also promotes              -> "only a move up promotes" (>= instead of > survives without the first-payment line)
//   P4  the unpaid size save does not call the promotion            -> "the unpaid size save promotes too"
//   P5  the seat gate dropped (an unlinked registrant promoted)     -> "a registrant the seat gate turns away is passed over"
//   P6  the promotion fires although the payment was refused       -> "a refused payment promotes nobody"
//   P7  the pay door's error swallow dropped                        -> "a failed promotion never fails the payment"
//   P8  the passed-over set not shared between places               -> "a registrant the seat gate turns away is passed over"
//   P9  the announcement is not in a `finally` (a throw skips it)    -> "a later place that throws"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async () => false) };
});
const sentry = vi.hoisted(() => ({ captured: [] as unknown[] }));
vi.mock("@/lib/sentry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry")>();
  return { ...actual, captureError: vi.fn((err: unknown) => void sentry.captured.push(err)) };
});

// Fault injection for "a later place throws": the ledger write of the Nth PROMOTION fails, so that place's transaction rolls back
// while the places before it stay committed. Armed per test (`failOnPromotion` = which promotion), counted per armed run.
const inject = vi.hoisted(() => ({ failOnPromotion: 0, seen: 0 }));
vi.mock("@/server/usecases/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/audit")>();
  return {
    ...actual,
    audit: vi.fn(async (...args: Parameters<typeof actual.audit>) => {
      if (args[3] === "registration.promoted" && inject.failOnPromotion > 0 && ++inject.seen === inject.failOnPromotion) {
        throw new Error("injected: the ledger write of a later promotion fails");
      }
      return actual.audit(...args);
    }),
  };
});
// Every public-page revalidation, by division (the real one still runs, and finds no Next request here).
const revalidated = vi.hoisted(() => ({ divisions: [] as string[] }));
vi.mock("@/server/public-site/revalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/public-site/revalidate")>();
  return {
    ...actual,
    fireDivisionRevalidate: vi.fn((divisionId: string, competitionId?: string) => {
      revalidated.divisions.push(divisionId);
      return actual.fireDivisionRevalidate(divisionId, competitionId);
    }),
  };
});

import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import { patchDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import { promoteIntoNewRoom } from "@/server/usecases/registrations/promote-into-room";
import { SETTINGS_BASE } from "@/server/usecases/__tests__/_registration-fixtures";
import { entrantRows, fillEntrants, heldOf, outcomeOf, sizeRig, type SizeRig } from "@/server/usecases/__tests__/_online-size-rig";
import { promoteWaitlistAfterMoveUp } from "..";
import { buy, pay, spendTheMonth, type Org } from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

beforeAll(() => {
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

const orgOf = (r: SizeRig): Org => ({ orgId: r.orgId, auth: r.auth });
/** `n` waitlisted registrants, oldest first, in the order created. */
async function queue(r: SizeRig, n: number, linked = true): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await r.waiting(linked));
  return ids;
}
const statuses = async (r: SizeRig, ids: string[]): Promise<string[]> => Promise.all(ids.map((id) => r.statusOf(id)));
const auditRows = async (divisionId: string, type: string): Promise<{ registration_id: string; reason: string | null }[]> =>
  (await sql<{ registration_id: string; reason: string | null }[]>`
    select payload->>'registration_id' as registration_id, payload->>'reason' as reason
      from competition_events
     where type = ${type} and payload->>'registration_id' in (select id::text from registrations where division_id = ${divisionId})
     order by created_at, id`);

describe.skipIf(!HAS_DB)("a move up promotes the waitlist into the new room (P18)", () => {
  it.each([
    ["auto", "confirmed"], // a free entry on automatic approval is seated at once
    ["manual", "pending"], // on manual approval it waits for the organiser, as a freed place leaves it today
  ] as const)("%s approval: 16 full + 3 waitlisted, a move up to 32 promotes all 3 (%s), oldest first, with the ledger row and the registrant's notice", async (approval, promotedStatus) => {
    const r = await sizeRig({ size: 16, approval });
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 16);
    const waiting = await queue(r, 3);
    expect(await statuses(r, waiting), "premise: all three wait").toEqual(["waitlisted", "waitlisted", "waitlisted"]);
    const result = await pay(orgOf(r), r.division.id, 32);
    expect(result.applied, "the payment applied").toBe(true);
    expect(await statuses(r, waiting), "all three were promoted").toEqual([promotedStatus, promotedStatus, promotedStatus]);
    // Oldest first: the audit ledger names them in the order they were promoted.
    const promoted = await auditRows(r.division.id, "registration.promoted");
    expect(promoted.map((p) => p.registration_id), "promoted in the order they joined the queue").toEqual(waiting);
    expect(promoted.every((p) => p.reason === "online_size_up"), "each says why").toBe(true);
    // The registrants are told: one promoted notice each, on the outbox.
    const [{ n: notices }] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_outbox where kind = 'registration_promoted' and ref_id in ${sql(waiting)}`;
    expect(notices, "one notice per promoted registrant").toBe(3);
    if (approval === "auto") expect(await heldOf(r.division.id), "16 + 3 seated").toBe(19);
  }, 120_000);

  it("room for two: the oldest two are promoted, the third waits (the room is the new size minus the places held)", async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 16);
    // 16 held, the size moves to 32: room for 16. Fill 14 more of it by hand so exactly 2 places are left.
    await fillEntrants(r.division.id, 14);
    const waiting = await queue(r, 3);
    await pay(orgOf(r), r.division.id, 32);
    expect(await statuses(r, waiting), "30 held + 2 promoted = 32; the youngest waits").toEqual(["pending", "pending", "waitlisted"]);
    expect(await heldOf(r.division.id), "full at 32, never past").toBe(32);
  }, 120_000);

  it("the empty case: nobody waiting, a move up promotes nobody and says nothing", async () => {
    const r = await sizeRig({ size: 16, approval: "auto" });
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 16);
    expect((await pay(orgOf(r), r.division.id, 32)).applied).toBe(true);
    expect(await auditRows(r.division.id, "registration.promoted"), "no promotion was written").toEqual([]);
    expect(await promoteIntoNewRoom(r.division.id, null), "called directly with an empty queue").toEqual([]);
    // A division with no registration settings at all has no waitlist to promote.
    const none = await sizeRig({ size: 16 });
    await sql`delete from registration_settings where division_id = ${none.division.id}`;
    expect(await promoteIntoNewRoom(none.division.id, null)).toEqual([]);
  }, 120_000);

  it("only a move up promotes: a move down, a re-send of the same size and a refused payment promote nobody; the next move up does", async () => {
    const r = await sizeRig({ size: 64, approval: "manual" });
    await buy(r.orgId, 60);
    await fillEntrants(r.division.id, 20);
    const [w] = await queue(r, 1); // waiting although there is room: it joined when the division was full, then 44 places were freed by hand
    // The FIRST payment of the size the row already has is applied (the row turns paid) but is no move up: no new room, no promotion.
    expect((await pay(orgOf(r), r.division.id, 64)).applied, "premise: the first payment is applied").toBe(true);
    expect(await r.statusOf(w!), "paying for the size it already had promotes nobody").toBe("waitlisted");
    // A move DOWN to 32 (20 held fit): never a promotion, though 12 places are free.
    expect((await pay(orgOf(r), r.division.id, 32)).applied, "the move down applied").toBe(true);
    expect(await r.statusOf(w!), "a move down promotes nobody").toBe("waitlisted");
    // The same size again: nothing is written (applied false), nothing is promoted.
    expect((await pay(orgOf(r), r.division.id, 32)).applied, "the re-send writes nothing").toBe(false);
    expect(await r.statusOf(w!), "a re-send promotes nobody").toBe("waitlisted");
    // The next move up (back to 64) is the one that promotes.
    expect((await pay(orgOf(r), r.division.id, 64)).applied).toBe(true);
    expect(await r.statusOf(w!), "the move up promotes").toBe("pending");
  }, 120_000);

  it("a refused payment promotes nobody (the promotion follows the COMMIT of a move up): no credits, a 402, and the waitlist and the size stand even with places free", async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await spendTheMonth(r.orgId, 0); // this month's included credits spent, none bought: the payment cannot be covered
    await fillEntrants(r.division.id, 10); // 6 places are free, so a promotion that fired anyway WOULD seat the registrant
    const [w] = await queue(r, 1);
    const refused = await outcomeOf(() => pay(orgOf(r), r.division.id, 256));
    expect(refused, "the payment is refused for credits").toMatchObject({ kind: "refused", status: 402 });
    expect(await r.statusOf(w!), "nobody was promoted").toBe("waitlisted");
    expect(await r.sizeNow(), "the size did not move").toBe(16);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("the promotion honours every other line: the registration capacity, the plan, the seat gate", () => {
  it("a capacity below the size is the organiser's promise: capacity 16 stays 16 after a move up to 32, and the waitlist is not promoted past it", async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await buy(r.orgId, 40);
    await putRegistrationSettings(r.auth, r.division.id, {
      ...SETTINGS_BASE, payment_method: "offline", fee_cents: 0, capacity: 16, approval: "manual", allow_free_agents: false,
    } as never);
    const held = await r.holders(16); // 16 sign-ups, each with its entrant: the capacity's own count
    const waiting = await queue(r, 2);
    expect(held.length, "premise: capacity 16 is full").toBe(16);
    const result = await pay(orgOf(r), r.division.id, 32);
    expect(result.capacityLoweredTo, "the move up lowers no capacity").toBeNull();
    const [{ capacity }] = await sql<{ capacity: number }[]>`select capacity from registration_settings where division_id = ${r.division.id}`;
    expect(capacity, "the capacity stays what the organiser promised").toBe(16);
    expect(await statuses(r, waiting), "16 of capacity 16: nobody is promoted past it").toEqual(["waitlisted", "waitlisted"]);
  }, 120_000);

  it("a plan below the new size still caps the promotion: plan 18 with 16 held and 3 waiting promotes two (18), the third waits", async () => {
    const r = await sizeRig({ size: 16, approval: "manual", plan: 18 });
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 16);
    const waiting = await queue(r, 3);
    await pay(orgOf(r), r.division.id, 32);
    expect(await statuses(r, waiting), "min(plan 18, size 32) - 16 held = 2 places").toEqual(["pending", "pending", "waitlisted"]);
  }, 120_000);

  it("a registrant the seat gate turns away is passed over (a Lichess link that plays is needed): the next in line takes the place, the skipped one keeps its place in the queue and is told why", async () => {
    const r = await sizeRig({ size: 16, approval: "auto" });
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 16);
    const unlinked = await r.waiting(false);
    const linked = await r.waiting(true);
    await pay(orgOf(r), r.division.id, 32);
    expect(await r.statusOf(unlinked), "no link, no seat: still waitlisted").toBe("waitlisted");
    expect(await r.statusOf(linked), "the next in line is seated").toBe("confirmed");
    const skipped = await auditRows(r.division.id, "registration.promotion_skipped");
    expect(skipped.map((s) => s.registration_id), "the skip is on the ledger, as a freed place leaves it").toEqual([unlinked]);
  }, 120_000);
});

describe.skipIf(!HAS_DB)("a later place that throws still announces the places that committed", () => {
  const noticesFor = async (ids: string[]): Promise<number> =>
    (await sql<{ n: number }[]>`select count(*)::int as n from email_outbox where kind = 'registration_promoted' and ref_id in ${sql(ids)}`)[0]!.n;
  const arm = (nth: number) => {
    inject.failOnPromotion = nth;
    inject.seen = 0;
    revalidated.divisions.length = 0;
  };
  afterEach(() => {
    inject.failOnPromotion = 0;
    inject.seen = 0;
  });

  it("the second promotion fails: the first stays promoted AND is mailed AND the public pages are revalidated; the error reaches the caller; the others wait", async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 16);
    const waiting = await queue(r, 3);
    // The size moves WITHOUT the pay door's wrapper (which would swallow the error), so the caller sees what the loop threw.
    await sql`update division_online_packages set size = 32 where division_id = ${r.division.id}`;
    arm(2);
    await expect(promoteIntoNewRoom(r.division.id, null)).rejects.toThrow(/injected: the ledger write of a later promotion fails/);
    expect(await statuses(r, waiting), "place 1 committed; place 2 rolled back whole; place 3 never reached").toEqual(["pending", "waitlisted", "waitlisted"]);
    expect(await auditRows(r.division.id, "registration.promoted"), "one ledger row: the committed place's").toHaveLength(1);
    expect(await noticesFor([waiting[0]!]), "the committed registrant is told").toBe(1);
    expect(await noticesFor([waiting[1]!, waiting[2]!]), "nobody who is still waiting is told they were promoted").toBe(0);
    expect(revalidated.divisions.filter((d) => d === r.division.id), "the public pages are revalidated once for the committed promotion").toHaveLength(1);
  }, 120_000);

  it("the first promotion fails: nothing committed, so nothing is announced (the empty case of the finally)", async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 16);
    const waiting = await queue(r, 2);
    await sql`update division_online_packages set size = 32 where division_id = ${r.division.id}`;
    arm(1);
    await expect(promoteIntoNewRoom(r.division.id, null)).rejects.toThrow(/injected/);
    expect(await statuses(r, waiting)).toEqual(["waitlisted", "waitlisted"]);
    expect(await noticesFor(waiting), "no promotion, no notice").toBe(0);
    expect(revalidated.divisions.filter((d) => d === r.division.id), "and no revalidation").toHaveLength(0);
  }, 120_000);

  it("through the pay door: the payment still applies and nothing is thrown, the failure is logged and reported, and the committed places are mailed", async () => {
    const r = await sizeRig({ size: 16, approval: "auto" });
    await buy(r.orgId, 40);
    await fillEntrants(r.division.id, 16);
    const waiting = await queue(r, 3);
    const logged = vi.spyOn(log, "error");
    sentry.captured.length = 0;
    arm(3); // two places promote, the third fails
    try {
      const result = await pay(orgOf(r), r.division.id, 32);
      expect(result.applied, "the payment applied despite the failed promotion").toBe(true);
      expect(await r.sizeNow(), "the size moved").toBe(32);
      expect(await statuses(r, waiting), "two seated, the third waits").toEqual(["confirmed", "confirmed", "waitlisted"]);
      expect(await noticesFor(waiting.slice(0, 2)), "both committed registrants are told").toBe(2);
      expect(await noticesFor([waiting[2]!])).toBe(0);
      expect(revalidated.divisions.filter((d) => d === r.division.id), "revalidated once for the two").toHaveLength(1);
      expect(logged.mock.calls.length, "the failure is logged once").toBe(1);
      expect(sentry.captured.length, "and reported once").toBe(1);
    } finally {
      logged.mockRestore();
    }
  }, 120_000);
});

describe.skipIf(!HAS_DB)("the unpaid size save promotes too, and a failed promotion never fails what it follows", () => {
  it("patchDivision naming a larger size on an unpaid row promotes; the same size re-sent, or a smaller one, does not", async () => {
    const r = await sizeRig({ size: 16, approval: "manual" });
    await fillEntrants(r.division.id, 16);
    const waiting = await queue(r, 2);
    await patchDivision(r.auth, r.division.id, { online_size: 16 } as never);
    expect(await statuses(r, waiting), "the same size re-sent: nobody promoted").toEqual(["waitlisted", "waitlisted"]);
    await patchDivision(r.auth, r.division.id, { online_size: 32 } as never);
    expect(await r.sizeNow(), "the size moved").toBe(32);
    expect(await statuses(r, waiting), "the unpaid size save promoted both").toEqual(["pending", "pending"]);
    // A smaller size (held 18 fits 32 only; so first make room by moving nobody): 18 held > 16, so the move down is refused whole.
    const refused = await outcomeOf(() => patchDivision(r.auth, r.division.id, { online_size: 16 } as never));
    expect(refused, "18 held do not fit 16").toMatchObject({ kind: "refused", status: 422, code: "ONLINE_SIZE_FULL" });
    expect(await entrantRows(r.division.id), "nothing was removed").toBe(16);
  }, 120_000);

  it("a failed promotion never fails the payment: the helper logs, reports to Sentry and returns", async () => {
    const logged = vi.spyOn(log, "error");
    sentry.captured.length = 0;
    try {
      // Not a division id at all: the promotion's first read is refused by the database.
      await expect(promoteWaitlistAfterMoveUp("not-a-uuid", null)).resolves.toBeUndefined();
      expect(logged.mock.calls.length, "logged once at error level").toBe(1);
      expect(sentry.captured.length, "and reported to Sentry once").toBe(1);
    } finally {
      logged.mockRestore();
    }
  });
});
