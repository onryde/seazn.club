// Sponsor deals, Task 5 (plan 2026-11-07-sponsor-deals D9, F16; spec §8a "what a live deal locks"): while a sponsor has a
// live deal, its tier, scope, stream tick and visibility come from the deal, so a PATCH of any of them answers 409
// `sponsor_locked_by_deal`; while it has a deal waiting to go live, a status PATCH answers 409 `sponsor_has_open_deal`.
// Name, link and logo stay editable, and once every deal has ended the sponsor is back under manual control. The lock is
// patchSponsor's own unconditional sponsor row lock (F16), so a deal going live in another transaction is seen.
//
// And the delete guard: a sponsor whose deals hold any history (money, a dispute, a deal that went live or ended, a legacy
// order) answers 409 `sponsor_has_deal_history`, never a 23503; one whose deals never got past waiting is deleted with them.
//
// A Pro org throughout (F16): on community the plan gate answers a tier PATCH with 402 before the transaction, and one case
// pins exactly that order. Real Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createSponsor, deleteSponsor, listSponsorRows, patchSponsor, type PatchSponsorInput } from "../sponsors";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[] };

interface Org {
  orgId: string;
  auth: AuthCtx;
  compId: string;
  packageId: string;
}

async function org(plan: "pro" | "community" = "pro"): Promise<Org> {
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Lock Org', ${`lock-${uniq()}`}) returning id`;
  made.orgIds.push(orgId);
  if (plan === "pro") await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Lock Cup', ${`lock-cup-${uniq()}`}) returning id`;
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${null}, 'Partner', 25000, 'gbp', 'partner') returning id`;
  return { orgId, auth: { orgId, via: "session", userId: null, role: "owner", keyId: null }, compId, packageId };
}

async function sponsor(o: Org, status = "active"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, status) values (${o.orgId}, ${`Acme ${uniq()}`}, 'partner', ${status}) returning id`;
  return row!.id;
}

type Deal = Record<string, string | number | boolean | Date | null>;

/** A coherent deal on the org-wide partner package: online, on payment, awaiting payment. `over` changes it. */
function deal(o: Org, sponsorId: string, over: Deal = {}): Deal {
  return {
    org_id: o.orgId, package_id: o.packageId, sponsor_name: "Acme", sponsor_email: "billing@acme.test",
    amount_cents: 25000, currency: "gbp", status: "pending", sponsor_id: sponsorId,
    deal_status: "awaiting_payment", payment_method: "online", go_live: "on_payment",
    tier: "partner", includes_on_stream: false, package_name: "Partner", competition_id: null,
    ended_at: null, ended_reason: null,
    ...over,
  };
}
const T0 = new Date("2031-03-01T10:00:00.000Z");
const LIVE: Deal = { deal_status: "live", status: "paid", paid_at: T0, live_at: T0, payment_intent_id: null };
const ENDED: Deal = { deal_status: "ended", ended_at: T0, ended_reason: "ended_now" };
const LEGACY: Deal = { deal_status: "ended", ended_at: T0, ended_reason: "legacy", status: "paid", paid_at: T0 };

async function insertDeal(row: Deal): Promise<string> {
  const [r] = await sql<{ id: string }[]>`insert into sponsor_orders ${sql(row as Record<string, never>)} returning id`;
  return r!.id;
}

const rowBytes = async (id: string): Promise<string | null> =>
  (await sql<{ row: string }[]>`select to_jsonb(s)::text as row from sponsors s where s.id = ${id}`)[0]?.row ?? null;
const dealCount = async (sponsorId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsor_orders where sponsor_id = ${sponsorId}`)[0]!.n;

/** What a call refused with: the HttpError's status and code (a DB error's code is its SQLSTATE). A call that succeeded
 *  answers `no_refusal`, so the caller's labelled expect names which case let it through. */
async function refusal(fn: () => Promise<unknown>): Promise<{ status: number | undefined; code: string | undefined }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { status: e.status, code: e.code };
  }
  return { status: undefined, code: "no_refusal" };
}

/** The backends waiting on a lock held by backend `pid` (exact: a wait on anything else is not counted). */
const waitersOf = async (pid: number): Promise<number> =>
  (await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database() and ${pid}::int = any(pg_blocking_pids(pid))`)[0]!.n;

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.orgIds.length > 0) {
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** D9's locked fields, typed from the plan (never read from the code under test), each with a value that CHANGES the
 *  no-deal sponsor (partner, whole org, off the stream, active). */
const lockedPatches = (o: Org): [string, PatchSponsorInput][] => [
  ["tier", { tier: "gold" }],
  ["competition_id", { competition_id: o.compId }],
  ["on_stream", { on_stream: true }],
  ["status", { status: "inactive" }],
];

describe.skipIf(!HAS_DB)("a live deal locks its sponsor's tier, scope, stream and visibility (D9)", () => {
  it("each locked field with a live deal answers 409 sponsor_locked_by_deal and writes nothing; the same PATCH on a no-deal sponsor is applied (count reported)", async () => {
    const o = await org();
    let checked = 0;
    for (const [field, patch] of lockedPatches(o)) {
      const locked = await sponsor(o);
      await insertDeal(deal(o, locked, LIVE));
      const before = await rowBytes(locked);
      expect(await refusal(() => patchSponsor(o.auth, locked, patch)), field).toEqual({ status: 409, code: "sponsor_locked_by_deal" });
      expect(await rowBytes(locked), `${field}: nothing written`).toBe(before);

      const free = await sponsor(o);
      await expect(patchSponsor(o.auth, free, patch), `${field}: a no-deal sponsor is under manual control`).resolves.toMatchObject(patch);
      checked++;
    }
    expect(checked, "locked fields checked").toBe(4);
  });

  it("name, url and logo stay editable while a deal is live (count reported)", async () => {
    const o = await org();
    const id = await sponsor(o);
    await insertDeal(deal(o, id, LIVE));
    const EDITABLE: [string, PatchSponsorInput][] = [
      ["name", { name: "Acme Holdings" }],
      ["url", { url: "https://acme.example/" }],
      ["logo_path", { logo_path: "logos/acme.png" }],
    ];
    let checked = 0;
    for (const [field, patch] of EDITABLE) {
      await expect(patchSponsor(o.auth, id, patch), field).resolves.toMatchObject(patch);
      checked++;
    }
    expect(checked, "editable fields checked").toBe(3);
  });

  it("a deal waiting to go live locks status only (409 sponsor_has_open_deal); tier, scope and stream stay editable (count reported)", async () => {
    const o = await org();
    const OPEN: Deal[] = [
      { deal_status: "draft" },
      { deal_status: "awaiting_payment", payment_method: "offline" },
      { deal_status: "awaiting_approval", status: "paid", paid_at: T0, go_live: "on_approval" },
    ];
    let checked = 0;
    for (const over of OPEN) {
      const id = await sponsor(o, "inactive");
      await insertDeal(deal(o, id, over));
      for (const status of ["active", "inactive", "pending"] as const) {
        expect(await refusal(() => patchSponsor(o.auth, id, { status })), `${over.deal_status} → ${status}`)
          .toEqual({ status: 409, code: "sponsor_has_open_deal" });
      }
      await expect(patchSponsor(o.auth, id, { tier: "silver", competition_id: o.compId, on_stream: true }), String(over.deal_status))
        .resolves.toMatchObject({ tier: "silver", competition_id: o.compId, on_stream: true });
      checked++;
    }
    expect(checked, "open statuses checked").toBe(3);
  });

  it("once every deal has ended (or the only rows are legacy), the sponsor is back under manual control", async () => {
    const o = await org();
    const ended = await sponsor(o, "inactive");
    await insertDeal(deal(o, ended, ENDED));
    await expect(patchSponsor(o.auth, ended, { status: "active", tier: "gold", on_stream: true }))
      .resolves.toMatchObject({ status: "active", tier: "gold", on_stream: true });

    const legacy = await sponsor(o, "inactive");
    await insertDeal(deal(o, legacy, LEGACY));
    await expect(patchSponsor(o.auth, legacy, { status: "active", competition_id: o.compId }))
      .resolves.toMatchObject({ status: "active", competition_id: o.compId });
  });

  it("community, once: a gold tier PATCH on a live-deal sponsor answers 402 — the plan gate precedes the deal lock; a status PATCH there is the lock's 409", async () => {
    const o = await org("community");
    const id = await sponsor(o);
    await insertDeal(deal(o, id, LIVE));
    expect(await refusal(() => patchSponsor(o.auth, id, { tier: "gold" }))).toMatchObject({ status: 402 });
    // The positive pair: a field no plan gates reaches the lock, on community too.
    expect(await refusal(() => patchSponsor(o.auth, id, { status: "inactive" }))).toEqual({ status: 409, code: "sponsor_locked_by_deal" });
  });

  it("the lock is unconditional (F16): a tier PATCH waits on a sponsor lock held by another transaction, and once a deal goes live under that lock it answers 409", async () => {
    const o = await org();
    const id = await sponsor(o);
    const before = await rowBytes(id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let holderPid = 0;
    let ready!: () => void;
    const holding = new Promise<void>((r) => (ready = r));
    // A deal writer (F2): the sponsor first, then its deal goes live, committed only when the gate opens.
    const holder = sql.begin(async (tx) => {
      await tx`select 1 from sponsors where id = ${id} for update`;
      await tx`insert into sponsor_orders ${tx(deal(o, id, LIVE) as Record<string, never>)}`;
      holderPid = (await tx<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
      ready();
      await gate;
    });
    holder.catch(() => undefined);
    try {
      await holding;
      const patching = refusal(() => patchSponsor(o.auth, id, { tier: "gold" }));
      patching.catch(() => undefined);
      const deadline = Date.now() + 10_000;
      let waiting = 0;
      while (Date.now() < deadline && (waiting = await waitersOf(holderPid)) === 0) await new Promise((r) => setTimeout(r, 25));
      expect(waiting, "the PATCH waits on the holder's sponsor lock").toBe(1);
      release();
      await holder;
      expect(await patching, "it read the deals AFTER taking the lock").toEqual({ status: 409, code: "sponsor_locked_by_deal" });
      expect(await rowBytes(id), "nothing written").toBe(before);
    } finally {
      release();
      await holder.catch(() => undefined);
    }
  });

  it("a PATCH of another org's sponsor is a 404 (RLS), and a missing one too", async () => {
    const o = await org();
    const theirs = await sponsor(await org());
    expect(await refusal(() => patchSponsor(o.auth, theirs, { name: "Mine now" }))).toMatchObject({ status: 404 });
    expect(await refusal(() => patchSponsor(o.auth, randomUUID(), { name: "Nobody" }))).toMatchObject({ status: 404 });
  });
});

describe.skipIf(!HAS_DB)("the console row carries its deal summary (pickRowDeal, computed in TS)", () => {
  it("empty first: a no-deal sponsor lists deal null, unlocked, no open deal, no billing email — and a created one says the same", async () => {
    const o = await org();
    const created = await createSponsor(o.auth, { name: "Fresh Co", tier: "partner", status: "active" });
    const SUMMARY_NONE = { deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: null };
    expect(created).toMatchObject(SUMMARY_NONE);
    expect((await listSponsorRows(o.orgId)).find((r) => r.id === created.id)).toMatchObject(SUMMARY_NONE);
  });

  it("a live deal with a queued one: the row shows the live deal, locked, with an open deal, and the latest billing email; a legacy row is never the row's deal", async () => {
    const o = await org();
    const id = await sponsor(o);
    await insertDeal(deal(o, id, { ...LEGACY, sponsor_email: "old@acme.test", created_at: new Date("2030-01-01T00:00:00Z") }));
    const live = await insertDeal(deal(o, id, { ...LIVE, sponsor_email: "first@acme.test", created_at: new Date("2030-06-01T00:00:00Z") }));
    await insertDeal(deal(o, id, { deal_status: "scheduled", status: "paid", paid_at: T0, sponsor_email: "latest@acme.test", created_at: new Date("2030-09-01T00:00:00Z") }));

    const row = (await listSponsorRows(o.orgId)).find((r) => r.id === id)!;
    expect(row.deal).toMatchObject({ id: live, deal_status: "live", payment_status: "paid", live_at: T0.toISOString(), invoice_number: null });
    expect(row).toMatchObject({ locked_by_deal: true, has_open_deal: true, last_billing_email: "latest@acme.test" });
    // The PATCH answer carries the same summary (the console re-renders the row from it).
    await expect(patchSponsor(o.auth, id, { name: "Acme Renamed" })).resolves.toMatchObject({ locked_by_deal: true, has_open_deal: true });

    const legacyOnly = await sponsor(o);
    await insertDeal(deal(o, legacyOnly, { ...LEGACY, sponsor_email: "legacy@acme.test" }));
    expect((await listSponsorRows(o.orgId)).find((r) => r.id === legacyOnly)).toMatchObject({
      deal: null, locked_by_deal: false, has_open_deal: false, last_billing_email: "legacy@acme.test",
    });
  });
});

/** Product ruling (controller, 2026-11-09, on Task 5's concern 2): a deal holds its sponsor ONLY when it carries money or
 *  document history — money paid or refunded, an invoice number (Task 20, F10: no deal has one yet), a stored Checkout
 *  session (F3: still a payable link until Task 7 expires it), or a pre-deals legacy order (F16: the RESTRICT key covers
 *  it). Every other deal goes with its sponsor, in the same transaction. Typed here from the ruling, never read from the
 *  code under test. */
const COMPLIMENTARY: Deal = { payment_method: "complimentary", status: "none", go_live: "immediate" };
const DELETABLE: [string, Deal][] = [
  ["a draft", { deal_status: "draft" }],
  ["an offline deal awaiting payment", { deal_status: "awaiting_payment", payment_method: "offline" }],
  ["an online deal awaiting payment, no session stored", {}],
  ["an online deal whose payment failed", { status: "failed", payment_intent_id: `pi_failed_${uniq()}` }],
  ["a live complimentary deal (money none)", { ...COMPLIMENTARY, deal_status: "live", live_at: T0 }],
  ["an ended complimentary deal", { ...COMPLIMENTARY, ...ENDED }],
  ["a complimentary deal awaiting approval", { ...COMPLIMENTARY, go_live: "on_approval", deal_status: "awaiting_approval" }],
  ["a live deal still unpaid (offline, immediate)", { deal_status: "live", live_at: T0, payment_method: "offline", go_live: "immediate" }],
  ["a scheduled unpaid deal", { deal_status: "scheduled", payment_method: "offline", go_live: "immediate" }],
  ["an ended deal that never took money", ENDED],
];
const HISTORY: [string, Deal][] = [
  ["a paid deal", LIVE],
  ["a refunded deal", { ...ENDED, ended_reason: "refunded", status: "refunded", paid_at: T0, payment_intent_id: `pi_refunded_${uniq()}` }],
  ["a legacy order (F16: the RESTRICT key covers it)", LEGACY],
  ["an online deal holding a Checkout session (F3, until Task 7 expires it)", { checkout_session_id: `cs_test_${uniq()}`, checkout_url: "https://checkout.stripe.test/x" }],
];

describe.skipIf(!HAS_DB)("deleting a sponsor: money or document history holds it (409); every other deal goes with it", () => {
  it("no deals: deleted", async () => {
    const o = await org();
    const id = await sponsor(o);
    await expect(deleteSponsor(o.auth, id)).resolves.toBeUndefined();
    expect(await rowBytes(id)).toBeNull();
  });

  it("RULING: a sponsor whose only deal is an ended complimentary one is deleted, and its deal is gone", async () => {
    const o = await org();
    const id = await sponsor(o, "inactive");
    await insertDeal(deal(o, id, { ...COMPLIMENTARY, ...ENDED }));
    await expect(deleteSponsor(o.auth, id)).resolves.toBeUndefined();
    expect(await rowBytes(id)).toBeNull();
    expect(await dealCount(id)).toBe(0);
  });

  it("every deal without money or document history goes with its sponsor: drafts, unpaid, failed, complimentary, live or ended (count reported)", async () => {
    const o = await org();
    let checked = 0;
    for (const [label, over] of DELETABLE) {
      const id = await sponsor(o, "inactive");
      await insertDeal(deal(o, id, over));
      expect(await refusal(() => deleteSponsor(o.auth, id)), label).toEqual({ status: undefined, code: "no_refusal" });
      expect(await rowBytes(id), `${label}: the sponsor is gone`).toBeNull();
      expect(await dealCount(id), `${label}: and its deal with it`).toBe(0);
      checked++;
    }
    expect(checked, "deletable kinds checked").toBe(DELETABLE.length);
    expect(checked).toBe(10);
  });

  it("several deletable deals on one sponsor all go with it, in one transaction", async () => {
    const o = await org();
    const id = await sponsor(o);
    for (const [, over] of DELETABLE.slice(0, 6)) await insertDeal(deal(o, id, over));
    expect(await dealCount(id), "premise").toBe(6);
    await expect(deleteSponsor(o.auth, id)).resolves.toBeUndefined();
    expect(await dealCount(id)).toBe(0);
  });

  it("money or document history answers 409 sponsor_has_deal_history — paid, refunded, legacy, a stored session — never a 23503, and deletes nothing (count reported)", async () => {
    const o = await org();
    let checked = 0;
    for (const [label, over] of HISTORY) {
      const id = await sponsor(o, "inactive");
      await insertDeal(deal(o, id, over));
      expect(await refusal(() => deleteSponsor(o.auth, id)), label).toEqual({ status: 409, code: "sponsor_has_deal_history" });
      expect(await rowBytes(id), `${label}: the sponsor stays`).not.toBeNull();
      expect(await dealCount(id), `${label}: and its deal`).toBe(1);
      checked++;
    }
    expect(checked, "history kinds checked").toBe(HISTORY.length);
    expect(checked).toBe(4);
  });

  it("one deal of history holds the sponsor even beside deletable ones, and they all stay", async () => {
    const o = await org();
    const id = await sponsor(o);
    await insertDeal(deal(o, id, { deal_status: "draft" }));
    await insertDeal(deal(o, id, { ...COMPLIMENTARY, ...ENDED }));
    await insertDeal(deal(o, id, LIVE));
    expect(await refusal(() => deleteSponsor(o.auth, id))).toEqual({ status: 409, code: "sponsor_has_deal_history" });
    expect(await dealCount(id)).toBe(3);
  });

  it("another org's sponsor (RLS) and a missing one are 404", async () => {
    const o = await org();
    const theirs = await sponsor(await org());
    expect(await refusal(() => deleteSponsor(o.auth, theirs))).toMatchObject({ status: 404 });
    expect(await refusal(() => deleteSponsor(o.auth, randomUUID()))).toMatchObject({ status: 404 });
    expect(await rowBytes(theirs)).not.toBeNull();
  });
});
