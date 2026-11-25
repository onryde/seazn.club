// Online Chess credits, Task 13 (spec docs/superpowers/specs/2026-11-23-online-chess-credits-design.md §14): the analytics event of
// "Pay and open". The payment ridden on the open's press is the one place a package is paid INSIDE openRound's transaction, so its
// event is sent only after that transaction commits, carries `at_round_one: true`, and is not sent for an open that paid nothing
// (a paid package opening, a frozen row ignoring a `pay`, a re-press), nor for an open that was refused and rolled back.
// The event's PROPS are `online-package/__tests__/events.test.ts`'s; the pay door's and the refund doors' emission is
// `online-package/__tests__/events-doors.test.ts`'s. This file is the gate's.
//
// REAL `openRound` against a REAL migrated database (skipped without DATABASE_URL); the invites go out through the real outbox to a
// stubbed provider (the gate suite's own stubs). Expected numbers are the spec's price table (`gcPrice`: 16 -> 1, 32 -> 2 credits).
// single-sport: online play exists only for `boardgame` (online-play.ts `supportsOnlinePlay`).
//
// Mutant table (each run once by hand; results in the commit message):
//   G1 the gate's event dropped                                   -> "pay and open: ONE `bought` …"
//   G2 `atRoundOne` pinned to false                               -> "pay and open: ONE `bought` …"
//   G3 the capture moved inside the transaction (before commit)   -> "… sent after the open committed"
//   G4 `paidBefore` pinned to false in the gate                   -> "pay and open on a paid package: `resized` …"
//   G5 the frozen-row guard's null event replaced by the event    -> "a `pay` on a frozen row … sends nothing"
import { randomUUID } from "node:crypto";
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

type Seen = { event: string; distinctId: string; orgId?: string; properties: Record<string, unknown>; frozenAtCapture: boolean | null };
const seen = vi.hoisted(() => ({ calls: [] as Seen[] }));
const builder = vi.hoisted(() => ({ corrupt: false }));

// A pay result whose bucket split is missing: what `payEvent` cannot make an event from. The gate calls `payEvent` INSIDE the open's own
// transaction, so a builder that throws would roll back a good "Pay and open". The REAL builder runs on it (the wrapper only corrupts its
// input).
vi.mock("@/server/usecases/online-package/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/usecases/online-package/events")>();
  return {
    ...actual,
    payEvent: (r: Parameters<typeof actual.payEvent>[0], a: Parameters<typeof actual.payEvent>[1]) =>
      actual.payEvent(builder.corrupt && r.applied ? ({ ...r, quote: { ...r.quote, take: null, back: null } } as typeof r) : r, a),
  };
});
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return {
    ...actual,
    captureServer: vi.fn(async (a: { event: string; distinctId: string; orgId?: string; properties?: Record<string, unknown> }) => {
      if (!a.event.startsWith("online_chess_package_")) return;
      // A SECOND connection: is the open committed (the package frozen) at the moment the event is sent?
      const { sql: pool } = await import("@/lib/db");
      const [r] = await pool<{ frozen: boolean }[]>`
        select exists(select 1 from division_online_packages where org_id = ${a.orgId!} and frozen_at is not null) as frozen`;
      seen.calls.push({ event: a.event, distinctId: a.distinctId, orgId: a.orgId, properties: a.properties ?? {}, frozenAtCapture: r?.frozen ?? null });
    }),
  };
});
beforeEach(() => {
  stubOutboxEnv();
  mail.sent.length = 0;
  seen.calls.length = 0;
  builder.corrupt = false;
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { openRound } from "../open-round";
import { onlinePackageQuote, payOnlinePackage } from "../../online-package";
import { seedOnlineChessRound, seedOnlineSwiss } from "../../__tests__/_external-play-seed";
import { expectLeafPrices, gcPrice, liveOf } from "../../online-package/__tests__/_oc-rig";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got an answer");
}
const eventsOf = (orgId: string) => seen.calls.filter((c) => c.orgId === orgId);

describe.skipIf(!HAS_DB)("Open round: the payment's analytics event (Online Chess credits §14)", () => {
  it("premise: the leaf charges the price table", () => {
    expect(expectLeafPrices()).toBe(10);
  });

  it("pay and open: ONE `bought`, at_round_one true, the open's own debit - sent after the open committed", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    const shown = await onlinePackageQuote(s.owner, s.divisionId, 16);
    expect(shown.take, "premise: the balance covers 16").not.toBeNull();
    const r = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 16, expectedOwed: shown.owed } });
    expect(r.opened, "premise: the round opened").toBe(true);

    expect(eventsOf(s.orgId), "one payment, one event").toHaveLength(1);
    const e = eventsOf(s.orgId)[0]!;
    expect(e.event).toBe("online_chess_package_bought");
    expect(e.distinctId, "the organiser who pressed Pay and open").toBe(s.ownerUserId);
    // The month's included credits pay first (P4): 16 costs 1.
    expect(e.properties).toEqual({ size: 16, cameras: false, credits: gcPrice(16), monthly: gcPrice(16), pack: 0, forfeited: 0, plan: "pro", at_round_one: true });
    expect(e.frozenAtCapture, "sent after the open committed (the package is already frozen for another connection)").toBe(true);
  }, 120_000);

  it("pay and open on a PAID package at a bigger size: `resized`, at_round_one true, the difference only", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    await payOnlinePackage(s.owner, s.divisionId, { size: 16, expectedOwed: (await onlinePackageQuote(s.owner, s.divisionId, 16)).owed });
    seen.calls.length = 0; // the pay door's own `bought` is events-doors.test.ts's
    const shown = await onlinePackageQuote(s.owner, s.divisionId, 32);
    expect(shown.owed, "premise: 32 less the 16 already paid").toBe(gcPrice(32) - gcPrice(16));
    await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 32, expectedOwed: shown.owed } });
    expect(eventsOf(s.orgId)).toHaveLength(1);
    expect(eventsOf(s.orgId)[0]!.event).toBe("online_chess_package_resized");
    expect(eventsOf(s.orgId)[0]!.properties).toMatchObject({ size: 32, credits: gcPrice(32) - gcPrice(16), at_round_one: true });
  }, 120_000);

  it("an open that paid nothing sends nothing: a paid package opening, then a `pay` on the frozen row, then a re-press", async () => {
    const s = await seedOnlineChessRound({ fixtures: 2 }); // a paid package (the seed's default)
    const first = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId });
    expect(first.opened, "premise: the open went through").toBe(true);
    expect(seen.calls, "a paid package opening takes nothing").toHaveLength(0);
    expect((await liveOf(s.divisionId)).frozen_at, "premise: the first open froze it").not.toBeNull();
    // A re-press of round 1 decides "nothing" before the gate is asked, whatever `pay` it carries.
    const again = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 32, expectedOwed: gcPrice(32) } });
    expect(again).toMatchObject({ opened: false, reason: "already_open" });
    expect(seen.calls, "a re-press sends nothing").toHaveLength(0);
    // Round 2 DOES open, so the gate is asked of the frozen row, and a `pay` the press carries is ignored there: nothing is taken, no event.
    for (const [i, [h, a]] of [[s.boards[0]!.home, s.boards[1]!.home], [s.boards[0]!.away, s.boards[1]!.away]].entries()) {
      await sql`
        insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round, ext_key, status, home_entrant_id, away_entrant_id, scheduled_at)
        values (${s.stageId}, ${s.divisionId}, ${s.orgId}, 2, ${i + 1}, ${`t13-r2-${randomUUID().slice(0, 8)}`}, 'scheduled', ${h.entrantId}, ${a.entrantId}, now())`;
    }
    const r2 = await openRound({ stageId: s.stageId, roundNo: 2, actorUserId: s.ownerUserId, pay: { size: 32, expectedOwed: gcPrice(32) } });
    expect(r2.opened, "premise: round 2 opened, so the gate was asked").toBe(true);
    if (r2.opened) expect(r2.payment, "premise: the frozen row ignored the payment").toMatchObject({ applied: false, credits: 0 });
    expect(seen.calls, "a `pay` on a frozen row sends nothing").toHaveLength(0);
  }, 120_000);

  it("an event that cannot be BUILT does not roll back a good Pay and open: the payment stands, the round opens, the package freezes, no event", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    const shown = await onlinePackageQuote(s.owner, s.divisionId, 16);
    builder.corrupt = true;
    const r = await openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 16, expectedOwed: shown.owed } });
    expect(r.opened, "the open committed (the builder's failure was inside its transaction)").toBe(true);
    const row = await liveOf(s.divisionId);
    expect(row.paid_at, "the payment stands").not.toBeNull();
    expect(row.frozen_at, "the package froze with the open").not.toBeNull();
    expect(seen.calls, "no half-made event was sent").toHaveLength(0);
    expect(r.opened && r.payment, "the open still reports what it took").toMatchObject({ applied: true, credits: shown.owed });
  }, 120_000);

  it("a refused open sends nothing: a stale total (409) and an unpaid package with no `pay` (402) roll everything back", async () => {
    const s = await seedOnlineSwiss({ players: 4, onlinePackage: "unpaid" });
    const noPay = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId }));
    expect([noPay.status, noPay.code]).toEqual([402, ONLINE_PACKAGE_CODES.unpaid]);
    const stale = await refusal(openRound({ stageId: s.stageId, roundNo: 1, actorUserId: s.ownerUserId, pay: { size: 16, expectedOwed: gcPrice(16) + 1 } }));
    expect(stale.code).toBe(ONLINE_PACKAGE_CODES.quoteChanged);
    expect((await liveOf(s.divisionId)).paid_at, "premise: nothing was paid").toBeNull();
    expect(seen.calls, "refused opens are no event").toHaveLength(0);
  }, 120_000);
});
