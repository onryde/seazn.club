// WHERE the package's analytics events are sent from (spec 2026-11-23-online-chess-credits-design.md §14; plan Task 13 step 6): the
// pay door and the three refund doors (a division delete, a competition delete, online play switched off), through the REAL doors
// against a REAL database (skipped without DATABASE_URL). `events.test.ts` owns the PROPS of each kind; this file owns the sending:
// exactly ONE event per action that moved money, sent AFTER the commit, NEVER on a no-op (a replay, a refused payment, a refund of
// nothing, a frozen row, an unpaid row), never for a rolled-back door - and never a failure of PostHog thrown at the organiser.
// The openRound gate's own emission is `external-play/__tests__/open-round-package-events.test.ts` (it needs that suite's rig).
//
// The capture is observed at PostHog's door (`captureServer`), and at the moment it is called a SECOND connection reads whether the
// package's payment is visible: an event sent inside the transaction would see the old row, because nothing has committed.
//
// Expected numbers: the Global Constraints' price table (`gcPrice`: 16→1, 32→2, 64→4, 128→8 credits without cameras) over buckets
// the case put there (this month spent to 0, so a payment draws bought credits and a refund returns them), and the ledger's sign
// convention (a debit positive, a return negative).
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`).
//
// Mutant table (each run once by hand; results in the commit message):
//   E1 the pay door's capture dropped                         -> "the pay door: first payment is ONE `bought` …"
//   E2 the capture moved inside the transaction               -> "… sent after the commit" (the paid row is not yet visible)
//   E3 `paidBefore` pinned to false                           -> "… a later payment is `resized`"
//   E4 the no-op guard dropped (applied false still sent)     -> "… a replay and a refused payment send nothing"
//   E5 each refund door's capture dropped (three mutants)     -> "delete division: …", "online play off: …", "delete competition: …"
//   E6 the collector's "something came back or was forfeited" guard dropped -> "applyPackageDelete collects nothing for a row already refunded"
//   E7 a door's capture dropped from the competition, division or switch-off door (one mutant each) -> that door's case
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Seen = { event: string; distinctId: string; orgId?: string; properties: Record<string, unknown>; committedAtCapture: boolean | null };
const seen = vi.hoisted(() => ({ calls: [] as Seen[], throwOnCapture: false }));

vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return {
    ...actual,
    isServerFeatureEnabled: vi.fn(async () => false),
    captureServer: vi.fn(async (a: { event: string; distinctId: string; orgId?: string; properties?: Record<string, unknown> }) => {
      if (!a.event.startsWith("online_chess_package_")) return;
      if (seen.throwOnCapture) throw new Error("posthog is down");
      // A SECOND connection: what is committed at the moment the event is sent. Null when the event names no package to look up.
      const { sql: pool } = await import("@/lib/db");
      const [r] = await pool<{ paid: boolean }[]>`
        select exists(select 1 from division_online_packages where org_id = ${a.orgId!} and paid_at is not null and refunded_at is null) as paid`;
      seen.calls.push({ event: a.event, distinctId: a.distinctId, orgId: a.orgId, properties: a.properties ?? {}, committedAtCapture: r?.paid ?? null });
    }),
  };
});

import { sql } from "@/lib/db";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { deleteCompetition } from "@/server/usecases/competitions";
import { deleteDivision, patchDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { applyPackageDelete, onlinePackageQuote, payOnlinePackage, type RefundedPackage } from "@/server/usecases/online-package";
import { livePackageById } from "@/server/usecases/online-package/read";
import {
  buy, CLOCK, expectLeafPrices, freeze, gcPrice, liveOf, ocCompetition, ocDivision, ocOrg, pay, refusal, spendTheMonth, type Org,
} from "./_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const ALWAYS = process.env.ONLINE_CHESS_ALWAYS;

beforeAll(() => {
  if (!HAS_DB) return;
  process.env.ONLINE_CHESS_ALWAYS = "1";
  forgetOnlineChessFlagCache();
  expectLeafPrices();
});
beforeEach(() => {
  seen.calls.length = 0;
  seen.throwOnCapture = false;
});
afterAll(async () => {
  if (ALWAYS === undefined) delete process.env.ONLINE_CHESS_ALWAYS;
  else process.env.ONLINE_CHESS_ALWAYS = ALWAYS;
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** An org whose month is spent, holding `pack` bought credits (every payment draws bought credits, every refund returns them). */
async function moneyOrg(pack: number, plan?: "community" | "pro"): Promise<Org> {
  const o = await ocOrg(plan);
  await spendTheMonth(o.orgId);
  await buy(o.orgId, pack);
  return o;
}
const eventsOf = (orgId: string) => seen.calls.filter((c) => c.orgId === orgId);
const OFF = { variant: "classical", onlinePlay: "off", clock: CLOCK };

describe.skipIf(!HAS_DB)("the pay door sends its events after the commit", () => {
  it("the pay door: first payment is ONE `bought`, then a bigger size, a move down and cameras are `resized`, each with its own facts", async () => {
    const o = await moneyOrg(40);
    const c = await ocCompetition(o);
    const d = await ocDivision(o, c);

    await pay(o, d.id, 64);
    expect(eventsOf(o.orgId)).toHaveLength(1);
    const bought = eventsOf(o.orgId)[0]!;
    expect(bought.event).toBe("online_chess_package_bought");
    expect(bought.distinctId, "the organiser who paid").toBe(o.auth.userId);
    expect(bought.properties).toEqual({ size: 64, cameras: false, credits: gcPrice(64), monthly: 0, pack: gcPrice(64), forfeited: 0, plan: "pro", at_round_one: false });

    await pay(o, d.id, 128);
    const up = eventsOf(o.orgId)[1]!;
    expect(up.event, "a later payment is `resized`").toBe("online_chess_package_resized");
    expect(up.properties).toEqual({
      size: 128, cameras: false, credits: gcPrice(128) - gcPrice(64), monthly: 0, pack: gcPrice(128) - gcPrice(64), forfeited: 0, plan: "pro", at_round_one: false,
    });

    await pay(o, d.id, 32);
    const down = eventsOf(o.orgId)[2]!;
    expect(down.event).toBe("online_chess_package_resized");
    expect(down.properties, "a move down returns bought credits: negative, all of them").toEqual({
      size: 32, cameras: false, credits: -(gcPrice(128) - gcPrice(32)), monthly: 0, pack: gcPrice(128) - gcPrice(32), forfeited: 0, plan: "pro", at_round_one: false,
    });

    const before = await liveOf(d.id);
    const shown = await onlinePackageQuote(o.auth, d.id, 32, true);
    await payOnlinePackage(o.auth, d.id, { size: 32, addCameras: true, expectedOwed: shown.owed });
    const cams = eventsOf(o.orgId)[3]!;
    expect(cams.event).toBe("online_chess_package_resized");
    expect(cams.properties).toMatchObject({ size: 32, cameras: true, credits: gcPrice(32, true) - gcPrice(32), pack: gcPrice(32, true) - gcPrice(32) });
    expect(before.cameras_paid, "premise: the cameras were not paid before").not.toBe(true);
    expect(eventsOf(o.orgId), "one event per action: four actions, four events").toHaveLength(4);
  }, 120_000);

  it("… sent after the commit: another connection already sees the payment when the event is sent", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 16);
    expect(eventsOf(o.orgId)).toHaveLength(1);
    expect(eventsOf(o.orgId)[0]!.committedAtCapture, "the paid row was committed when PostHog was called").toBe(true);
  });

  it("… the plan is the org's own plan, and the same facts come out for another plan", async () => {
    const o = await moneyOrg(10, "community");
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 16);
    expect(eventsOf(o.orgId)[0]!.properties.plan).toBe("community");
  });

  it("… a replay and a refused payment send nothing (the second tab, a short balance, a stale total)", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 32);
    expect(eventsOf(o.orgId)).toHaveLength(1);

    const again = await pay(o, d.id, 32); // the row is already at the target: nothing written
    expect(again.applied, "premise: the replay wrote nothing").toBe(false);
    expect(eventsOf(o.orgId), "a replay is no event").toHaveLength(1);

    const stale = await refusal(payOnlinePackage(o.auth, d.id, { size: 64, expectedOwed: 1 }));
    expect(stale.code, "premise: a stale total is refused").toBe(ONLINE_PACKAGE_CODES.quoteChanged);
    const poor = await ocOrg();
    await spendTheMonth(poor.orgId); // the month spent, nothing bought: a 256 cannot be paid
    const pd = await ocDivision(poor, await ocCompetition(poor));
    const short = await refusal(payOnlinePackage(poor.auth, pd.id, { size: 256, expectedOwed: gcPrice(256) }));
    expect(short.status, "premise: a short balance is refused").toBe(402);
    expect(eventsOf(o.orgId), "refused payments are no event").toHaveLength(1);
    expect(eventsOf(poor.orgId)).toHaveLength(0);
  });

  it("… PostHog failing never fails the payment: the organiser's money moved and the door answers", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    seen.throwOnCapture = true;
    const r = await pay(o, d.id, 32);
    expect(r.applied).toBe(true);
    expect((await liveOf(d.id)).paid_at, "the package is paid").not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the refund doors send `refunded` after the commit", () => {
  it("delete division: a paid package is ONE `refunded` event; an unpaid or a frozen package is no event", async () => {
    const o = await moneyOrg(30);
    const c = await ocCompetition(o);

    const paid = await ocDivision(o, c);
    await pay(o, paid.id, 64);
    seen.calls.length = 0;
    await deleteDivision(o.auth, paid.id);
    expect(eventsOf(o.orgId)).toHaveLength(1);
    const e = eventsOf(o.orgId)[0]!;
    expect(e.event).toBe("online_chess_package_refunded");
    expect(e.distinctId).toBe(o.auth.userId);
    expect(e.properties).toEqual({ size: 64, cameras: false, credits: -gcPrice(64), monthly: 0, pack: gcPrice(64), forfeited: 0, plan: "pro", at_round_one: false });

    seen.calls.length = 0;
    const unpaid = await ocDivision(o, c);
    await deleteDivision(o.auth, unpaid.id);
    const frozen = await ocDivision(o, c);
    await pay(o, frozen.id, 32);
    await freeze((await liveOf(frozen.id)).id);
    seen.calls.length = 0;
    await deleteDivision(o.auth, frozen.id);
    expect(eventsOf(o.orgId), "an unpaid or a frozen package is no event (nothing was refunded)").toHaveLength(0);
  }, 120_000);

  it("delete division: a refund that rolls back is no event (another org's division: 404)", async () => {
    const o = await moneyOrg(10);
    const stranger = await moneyOrg(10);
    const d = await ocDivision(stranger, await ocCompetition(stranger));
    await pay(stranger, d.id, 16);
    seen.calls.length = 0;
    const e = await refusal(deleteDivision(o.auth, d.id));
    expect(e.status).toBe(404);
    expect(seen.calls, "nothing was refunded, nothing was sent").toHaveLength(0);
    expect((await liveOf(d.id)).refunded_at, "premise: the stranger's package is untouched").toBeNull();
  });

  it("online play off: a paid package is ONE `refunded` event; switching off again sends nothing", async () => {
    const o = await moneyOrg(30);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 32);
    seen.calls.length = 0;
    await patchDivision(o.auth, d.id, { config: OFF });
    expect(eventsOf(o.orgId)).toHaveLength(1);
    expect(eventsOf(o.orgId)[0]!.event).toBe("online_chess_package_refunded");
    expect(eventsOf(o.orgId)[0]!.properties).toEqual({
      size: 32, cameras: false, credits: -gcPrice(32), monthly: 0, pack: gcPrice(32), forfeited: 0, plan: "pro", at_round_one: false,
    });
    await patchDivision(o.auth, d.id, { config: OFF }); // already off: a second save is a no-op
    expect(eventsOf(o.orgId), "the second save refunds nothing and sends nothing").toHaveLength(1);
  });

  it("delete competition: one `refunded` event per PAID package, none for the unpaid or the frozen", async () => {
    const o = await moneyOrg(60);
    const c = await ocCompetition(o);
    const a = await ocDivision(o, c);
    const b = await ocDivision(o, c);
    const unpaid = await ocDivision(o, c);
    const frozen = await ocDivision(o, c);
    await pay(o, a.id, 32);
    await pay(o, b.id, 64);
    await pay(o, frozen.id, 16);
    await freeze((await liveOf(frozen.id)).id);
    expect((await liveOf(unpaid.id)).paid_at, "premise: one division is unpaid").toBeNull();
    seen.calls.length = 0;
    await deleteCompetition(o.auth, c);
    const events = eventsOf(o.orgId);
    expect(events, "two paid, unfrozen packages: two events").toHaveLength(2);
    expect(events.map((e) => e.event)).toEqual(["online_chess_package_refunded", "online_chess_package_refunded"]);
    expect(events.map((e) => e.properties.size).sort((x, y) => (x as number) - (y as number)), "one per refunded package").toEqual([32, 64]);
    expect(events.map((e) => e.properties.credits).sort((x, y) => (x as number) - (y as number))).toEqual([-gcPrice(64), -gcPrice(32)]);
  }, 120_000);

  it("a refund that forfeits last month's included credits sends the forfeited count", async () => {
    // The month's included credits spent (4 of them on a 64), then the month turns: the refund cannot return an earlier month's included
    // credits (P6), so they are forfeited and counted.
    const { backdateOrgLedger, spendTheMonth: spend } = await import("./_oc-rig");
    const o = await ocOrg();
    const rate = await spend(o.orgId, gcPrice(64));
    expect(rate).toBeGreaterThanOrEqual(gcPrice(64));
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 64); // drawn from this month's included credits
    await backdateOrgLedger(o.orgId); // "the month turned"
    seen.calls.length = 0;
    await deleteDivision(o.auth, d.id);
    expect(eventsOf(o.orgId)).toHaveLength(1);
    expect(eventsOf(o.orgId)[0]!.properties).toMatchObject({ size: 64, credits: 0, monthly: 0, pack: 0, forfeited: gcPrice(64) });
  }, 120_000);
});

describe.skipIf(!HAS_DB)("the refund collector", () => {
  it("applyPackageDelete collects nothing for a row already refunded (a second refund wrote nothing and reports nothing), and one entry for a live paid row", async () => {
    const o = await moneyOrg(10);
    const d = await ocDivision(o, await ocCompetition(o));
    await pay(o, d.id, 16);
    const row = (await livePackageById(sql, (await liveOf(d.id)).id))!;

    const first: RefundedPackage[] = [];
    await sql.begin(async (etx) => {
      await applyPackageDelete(etx, o.orgId, { refund: [row], drop: [] }, first);
    });
    expect(first, "the live paid row: one package, what came back").toEqual([{ size: 16, cameras: false, back: { pack: gcPrice(16), monthly: 0, forfeited: 0 } }]);

    const second: RefundedPackage[] = [];
    await sql.begin(async (etx) => {
      await applyPackageDelete(etx, o.orgId, { refund: [row], drop: [] }, second); // the plan is stale: the row is refunded now
    });
    expect(second, "already refunded: the answer is all zeros and nothing is collected").toEqual([]);
  });
});
