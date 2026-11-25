// The Streaming half of Settings → Credits: server/usecases/stream-credits-tab.ts — the balance split, "N of M free
// used this month", the buy/availability state and the first page of history. Real Postgres; skipped without
// DATABASE_URL. The ledger is written by the real writers (grant via the page's own read, consume, the R2008 refund,
// purchase); only the deployment/entitlement question (`relayOffer`) is doubled, because it reads PostHog-free env
// state a unit test cannot move.
//
// Mutant table:
//   T1 gate the grant   call `relayCredits` whatever the offer says           → "a deployment that cannot stream, or a plan without it, GRANTS nothing"
//   T2 bucket           drop `c.bucket = 'monthly'` from the used query         → "a match paid from a BOUGHT credit is not a free one used"
//   T3 refund netting   drop the correlated refund subtraction                  → "the platform's refund hands the free credit back to the meter"
//   T4 period           drop `created_at >= periodStart` from the used query    → "last month's free credit used is not this month's"
//   T5 cap              `Math.max(allowance, granted)` → `allowance`             → "after a mid-month downgrade the meter still counts the credits the month was granted"
//   T6 audience         delete `assertCanReadStreamHistory`                     → "an API key and another org are refused"
//   T7 upper clamp      drop `Math.min(freeAllowance, …)` from freeUsed          → "the meter never reads past its own scale"
//   T8 lower clamp      drop `Math.max(0, …)` from freeUsed                       → "a refund written twice against one match cannot take the meter below nothing"
//   T9 chess offer      `streamCreditsOffer` ignores the Online Chess flag                → "only Online Chess offered: the tab is on, and grants the month"
//   T10 flag asked late  ask the flag before the streaming facts                           → "the flag is asked only when streaming does not already admit"
//   T11 package netting  drop the per-package refund term from the used query              → "a package paid from the free credits is one used; the refund hands it back"
//   T14 package period   drop `created_at >= periodStart` from the package term              → "last month's package credits are not this month's"
//   T12 package bound    `least(refunded, consumed)` → `refunded`                          → "a refund booked against a package with no consume this month cannot take the meter below its other matches"
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { consumeForSession, recordPurchase, refundConsumeForSession } from "@/server/usecases/stream-credits";
import { deleteDivision } from "@/server/usecases/divisions";
import { forgetOnlineChessFlagCache } from "@/server/usecases/external-play/online-chess-flag";
import { ocCompetition, ocDivision, ocOrg, pay } from "@/server/usecases/online-package/__tests__/_oc-rig";

const { relayOfferMock } = vi.hoisted(() => ({
  relayOfferMock: vi.fn<(orgId: string) => Promise<{ entitled: boolean; relayEntitled: boolean; relayDisabled: boolean; composedAvailable: boolean }>>(),
}));
// Bare factory on purpose: the real module drags the overlay page loader, PostHog and the panel's component types.
vi.mock("@/server/stream-panel-context", () => ({ relayOffer: (orgId: string) => relayOfferMock(orgId) }));

import { getStreamCreditsTab } from "../stream-credits-tab";

const HAS_DB = !!process.env.DATABASE_URL;
const auth = (orgId: string, via: AuthCtx["via"] = "session"): AuthCtx => ({ orgId, via, userId: null, role: "viewer", keyId: via === "api_key" ? randomUUID() : null });
const ON = { entitled: true, relayEntitled: true, relayDisabled: false, composedAvailable: true };

/** The Online Chess flag (`onlineChessOffered`): the vitest environment forces it ON for everyone (`ONLINE_CHESS_ALWAYS=1`), which
 *  would make every "streaming is off, so nothing is offered" case below a sale. Each test starts with it OFF; one that needs a
 *  club offered Online Chess says so. PostHog is not configured here, so OFF is the helper's own fallback, not a stub of it. */
const chessOffered = (on: boolean): void => {
  vi.stubEnv("ONLINE_CHESS_ALWAYS", on ? "1" : "");
};

beforeEach(() => {
  relayOfferMock.mockReset();
  relayOfferMock.mockResolvedValue(ON);
  forgetOnlineChessFlagCache();
  chessOffered(false);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The community plan's declared monthly stream credits, READ from the catalogue (V426), never typed. */
async function communityRate(): Promise<number> {
  const [r] = await sql<{ n: number | null }[]>`
    select int_value as n from plan_entitlements where plan_key = 'community' and feature_key = 'streaming.credits.monthly'`;
  return r?.n ?? 0;
}

describe.skipIf(!HAS_DB)("getStreamCreditsTab", () => {
  it("a fresh org's first read GRANTS the month's free credits once and reports them as 0 of N used — balance, split and history agree", async () => {
    const rate = await communityRate();
    expect(rate, "community streams on a free monthly credit").toBeGreaterThan(0);
    const r = await streamRig();
    const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(view.offer).toBe("on");
    expect([view.total, view.monthly, view.pack]).toEqual([rate, rate, 0]);
    expect([view.freeAllowance, view.freeUsed]).toEqual([rate, 0]);
    expect(view.freeResetsInDays).toBeGreaterThanOrEqual(0);
    expect(view.freeResetsInDays).toBeLessThanOrEqual(31);
    expect(view.history.rows.map((x) => [x.kind, x.delta])).toEqual([["monthlyGrant", rate]]);
    // a second read grants nothing more
    const again = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(again.history.rows).toHaveLength(1);
  });

  it("a match streamed on the free credit is 1 used; the platform's refund of it hands it back to the meter", async () => {
    const r = await streamRig();
    const fx = r.fixtureIds[0]!;
    const s = await r.session(fx);
    await getStreamCreditsTab(auth(r.orgId), r.orgId);   // the grant
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx, sessionId: s }));
    const used = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(used.freeUsed).toBe(1);
    expect(used.monthly).toBe(used.freeAllowance - 1);
    await sql.begin((tx) => refundConsumeForSession(tx, { orgId: r.orgId, sessionId: s, fixtureId: fx, note: "R2008 test" }, new Date()));
    const refunded = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(refunded.freeUsed, "T3: the refund nets the consume it reverses").toBe(0);
    expect(refunded.monthly).toBe(refunded.freeAllowance);
  });

  it("a match paid from a BOUGHT credit is not a free one used (T2) — and the bought credits sit in `pack`, untouched by the free meter", async () => {
    const rate = await communityRate();
    const r = await streamRig({ fixtures: 2 });
    const [fx0, fx1] = r.fixtureIds as [string, string];
    const s0 = await r.session(fx0);
    const s1 = await r.session(fx1);
    await recordPurchase({ orgId: r.orgId, delta: 3, stripeEventId: `cs_${randomUUID()}` });
    await getStreamCreditsTab(auth(r.orgId), r.orgId);   // the grant
    // The rig seats two fixtures: one match on the free credit (monthly is drawn first), one on the bought pack. A
    // catalogue that grows the community rate past 1 needs a wider rig — said by name, not by a wrong count.
    expect(rate, "this test seats exactly one free match").toBeLessThanOrEqual(1);
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx0, sessionId: s0 }));
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx1, sessionId: s1 }));
    const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(view.freeUsed).toBe(rate);        // not rate + 1
    expect([view.monthly, view.pack]).toEqual([0, 2]);
    expect(view.total).toBe(2);
    // The clamp to the allowance would hide a bought-credit match counted as a free one (two used of one allowed reads as
    // one of one). A top-up the org was given earlier this month under a richer plan lifts the allowance past the count,
    // so the unclamped number shows: one free match used, never two. (T2: drop the bucket filter → 2; T7 is the clamp.)
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, idempotency_key)
      values (${r.orgId}, 4, 'grant', 'monthly', ${view.total + 4}, ${`stream-monthly:${r.orgId}:top-up-test`})`;
    const toppedUp = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(toppedUp.freeAllowance, "the allowance is past the count, so the clamp cannot hide it").toBe(rate + 4);
    expect(toppedUp.freeUsed, "one match on a free credit, one on a bought one").toBe(rate);
  });

  it("a refund written twice against one match cannot take the meter below nothing (T8)", async () => {
    const r = await streamRig();
    const fx = r.fixtureIds[0]!;
    const s = await r.session(fx);
    await getStreamCreditsTab(auth(r.orgId), r.orgId);   // the grant
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx, sessionId: s }));
    await sql.begin((tx) => refundConsumeForSession(tx, { orgId: r.orgId, sessionId: s, fixtureId: fx, note: "R2008 test" }, new Date()));
    // A second credit-back against the same match (a staff refund linked to it): net used is 1 - 2 = -1 before the clamp.
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, session_id, balance_after)
      values (${r.orgId}, 1, 'refund', 'monthly', ${s}, 0)`;
    const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(view.freeUsed).toBe(0);
  });

  it("the meter never reads past its own scale: more free matches on the ledger than the month granted is 'all used', not 'N of M' with N > M (T7)", async () => {
    const r = await streamRig();
    const first = await getStreamCreditsTab(auth(r.orgId), r.orgId);   // this month's grant: M
    // Hand-written: no writer spends a free credit the month did not grant, so the surplus can only be written raw.
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after)
      select ${r.orgId}, -1, 'consume', 'monthly', 0 from generate_series(1, ${first.freeAllowance + 2}::int)`;
    const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(view.freeAllowance).toBeGreaterThan(0);
    expect(view.freeUsed).toBe(view.freeAllowance);
  });

  it("last month's free credit used is not this month's (T4)", async () => {
    const r = await streamRig();
    await getStreamCreditsTab(auth(r.orgId), r.orgId);   // this month's grant
    // A consume from the monthly bucket dated well before the UTC month began: hand-written because a clock cannot be
    // moved under the writer; the balance is not under test here.
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, created_at)
      values (${r.orgId}, -1, 'consume', 'monthly', 0, now() - interval '70 days')`;
    const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(view.freeUsed).toBe(0);
  });

  it("after a mid-month downgrade the meter still counts the credits the month was granted (T5)", async () => {
    const rate = await communityRate();
    const r = await streamRig();
    await getStreamCreditsTab(auth(r.orgId), r.orgId);   // grants `rate`
    // a top-up the org was given earlier this month under a richer plan, still on the ledger after the downgrade
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, idempotency_key)
      values (${r.orgId}, 4, 'grant', 'monthly', ${rate + 4}, ${`stream-monthly:${r.orgId}:top-up-test`})`;
    const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(view.freeAllowance).toBe(rate + 4);
  });

  it("a deployment that cannot stream, or a plan without it, GRANTS nothing and offers no purchase (T1)", async () => {
    for (const [name, offer, expected] of [
      ["no relay on this deployment", { ...ON, relayDisabled: true }, "unavailable"],
      ["the plan lacks the relay", { ...ON, relayEntitled: false }, "notIncluded"],
      ["the plan lacks the overlay", { ...ON, entitled: false, relayEntitled: false }, "notIncluded"],
    ] as const) {
      relayOfferMock.mockResolvedValue(offer);
      const r = await streamRig();
      const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
      expect(view.offer, name).toBe(expected);
      expect(view.freeAllowance, name).toBe(0);
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${r.orgId}`;
      expect(n!.n, `${name}: the read wrote no row`).toBe(0);
    }
  });

  it("an org that cannot buy still SEES the credits it holds and its history", async () => {
    relayOfferMock.mockResolvedValue({ ...ON, relayEntitled: false });
    const r = await streamRig();
    await recordPurchase({ orgId: r.orgId, delta: 5, stripeEventId: `cs_${randomUUID()}` });
    const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect([view.offer, view.total, view.pack, view.history.rows.length]).toEqual(["notIncluded", 5, 5, 1]);
  });

  it("the history page is the reader's: a cursor from the first page returns the older rows (positive pair: no cursor = the newest)", async () => {
    const r = await streamRig();
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, created_at)
      select ${r.orgId}, 1, 'purchase', 'pack', g + 1, now() - interval '2 hours' + g * interval '1 minute' from generate_series(0, 29) g`;
    const first = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    // 30 purchases + this read's monthly grant = 31; the default page is 25
    expect(first.history.rows).toHaveLength(25);
    expect(first.history.nextCursor).not.toBeNull();
    const second = await getStreamCreditsTab(auth(r.orgId), r.orgId, { cursor: first.history.nextCursor! });
    expect(second.history.rows).toHaveLength(6);
    expect(second.history.nextCursor).toBeNull();
    const ids = [...first.history.rows, ...second.history.rows].map((x) => x.id);
    expect(new Set(ids).size).toBe(31);
  });

  it("an API key, a device link and another organisation are refused before anything is read or granted (T6)", async () => {
    const a = await streamRig();
    const b = await streamRig();
    for (const via of ["api_key", "device_link"] as const) {
      await expect(getStreamCreditsTab(auth(a.orgId, via), a.orgId)).rejects.toMatchObject({ status: 403 });
    }
    await expect(getStreamCreditsTab(auth(a.orgId), b.orgId)).rejects.toMatchObject({ status: 404 });
    for (const org of [a.orgId, b.orgId]) {
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_credits where org_id = ${org}`;
      expect(n!.n, "a refused read granted nothing").toBe(0);
    }
    expect(relayOfferMock, "the gate runs before the offer is even asked").not.toHaveBeenCalled();
  });
  it("only Online Chess offered: the tab is on, grants the month and offers packs — whichever way phone streaming is off (T9); neither offered, nothing (the T1 pair)", async () => {
    const rate = await communityRate();
    expect(rate, "premise: the month's free credit exists").toBeGreaterThan(0);
    const cases = [
      ["no relay on this deployment", { ...ON, relayDisabled: true }],
      ["the plan lacks the relay", { ...ON, relayEntitled: false }],
      ["the plan lacks the overlay", { ...ON, entitled: false, relayEntitled: false }],
    ] as const;
    let checked = 0;
    for (const [name, offer] of cases) {
      relayOfferMock.mockResolvedValue(offer);
      chessOffered(true);
      const r = await streamRig();
      const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
      expect(view.offer, `${name}: chess offered`).toBe("on");
      expect([view.freeAllowance, view.total, view.monthly], `${name}: the month is granted`).toEqual([rate, rate, rate]);
      expect(view.history.rows.map((x) => x.kind), name).toEqual(["monthlyGrant"]);
      // the pair: the SAME org and facts with the flag off is the refusal the tab always gave, and grants nothing more
      chessOffered(false);
      forgetOnlineChessFlagCache();
      const r2 = await streamRig();
      const refused = await getStreamCreditsTab(auth(r2.orgId), r2.orgId);
      expect(refused.offer, `${name}: chess not offered`).not.toBe("on");
      expect(refused.freeAllowance, name).toBe(0);
      checked += 1;
    }
    expect(checked).toBe(cases.length);
  });

  it("the flag is asked only when streaming does not already admit (T10), and for the ORG — the rail, which has no person, must reach the same answer", async () => {
    const asks: { orgId: string; userId: string | null }[] = [];
    const flag = await import("@/server/usecases/external-play/online-chess-flag");
    const spy = vi.spyOn(flag, "onlineChessOffered").mockImplementation(async (asker) => {
      asks.push({ orgId: asker.orgId, userId: asker.userId });
      return false;
    });
    try {
      const on = await streamRig();
      await getStreamCreditsTab(auth(on.orgId), on.orgId);
      expect(asks, "streaming admits, so no PostHog call on the common path").toEqual([]);
      relayOfferMock.mockResolvedValue({ ...ON, relayEntitled: false });
      const off = await streamRig();
      await getStreamCreditsTab(auth(off.orgId), off.orgId);
      expect(asks).toEqual([{ orgId: off.orgId, userId: null }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a package paid from the free credits is a free credit used; a move down and a refund hand them back — nets by package, never by session (T11)", async () => {
    chessOffered(true);   // the pay door's own gate
    const o = await ocOrg();
    const compId = await ocCompetition(o);
    const d = await ocDivision(o, compId);
    const start = await getStreamCreditsTab(o.auth, o.orgId);   // the month's grant
    expect(start.freeUsed).toBe(0);
    expect(start.freeAllowance, "premise: the plan's month covers a 32-player package (2 credits)").toBeGreaterThanOrEqual(2);

    await pay(o, d.id, 32);   // decision 5: 16 players cost 1 credit, so 32 cost 2 — drawn from the month's credits first
    const paid = await getStreamCreditsTab(o.auth, o.orgId);
    expect(paid.freeUsed, "two included credits went on the package").toBe(2);

    await pay(o, d.id, 16);   // a move down: 1 credit comes back, in the month it was spent
    const down = await getStreamCreditsTab(o.auth, o.orgId);
    expect(down.freeUsed, "one of the two came back").toBe(1);
    expect(down.monthly).toBe(start.monthly - 1);

    await deleteDivision(o.auth, d.id);   // the full return
    const gone = await getStreamCreditsTab(o.auth, o.orgId);
    expect(gone.freeUsed, "the refund hands the free credit back to the meter").toBe(0);
    expect(gone.monthly).toBe(start.monthly);
  });

  it("a refund booked against a package with no consume this month cannot take the meter below its other matches (T12)", async () => {
    const r = await streamRig();
    const fx = r.fixtureIds[0]!;
    const s = await r.session(fx);
    await getStreamCreditsTab(auth(r.orgId), r.orgId);   // the grant
    await sql.begin((tx) => consumeForSession(tx, { orgId: r.orgId, fixtureId: fx, sessionId: s }));
    // A package refund with NO consume of the package this month (a refund of last month's credit, which the writer forbids, so
    // it can only be written raw): netted against the whole month it would cancel a MATCH's free credit.
    const [pkg] = await sql<{ id: string }[]>`
      insert into division_online_packages (org_id, division_id, division_name, size, cameras_paid, credits_paid, paid_at, paid_by)
      values (${r.orgId}, null, 'Gone Open', 16, false, 1, now() - interval '70 days', gen_random_uuid()) returning id`;
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, online_package_id, package_size, balance_after)
      values (${r.orgId}, 1, 'refund', 'monthly', ${pkg!.id}, 16, 0)`;
    const view = await getStreamCreditsTab(auth(r.orgId), r.orgId);
    expect(view.freeUsed, "the stream's free credit is still used").toBe(1);
  });
  it("last month's package credits are not this month's (T14) — the same row dated this month is (the positive pair)", async () => {
    const r = await streamRig();
    await getStreamCreditsTab(auth(r.orgId), r.orgId);   // the grant
    const [pkg] = await sql<{ id: string }[]>`
      insert into division_online_packages (org_id, division_id, division_name, size, cameras_paid, credits_paid, paid_at, paid_by)
      values (${r.orgId}, null, 'Old Open', 16, false, 1, now() - interval '70 days', gen_random_uuid()) returning id`;
    // A package's consume dated well before the UTC month began: hand-written because a clock cannot be moved under the writer.
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, online_package_id, package_size, balance_after, created_at)
      values (${r.orgId}, -1, 'consume', 'monthly', ${pkg!.id}, 16, 0, now() - interval '70 days')`;
    expect((await getStreamCreditsTab(auth(r.orgId), r.orgId)).freeUsed, "last month's").toBe(0);
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, online_package_id, package_size, balance_after)
      values (${r.orgId}, -1, 'consume', 'monthly', ${pkg!.id}, 16, 0)`;
    expect((await getStreamCreditsTab(auth(r.orgId), r.orgId)).freeUsed, "this month's").toBe(1);
  });
});
