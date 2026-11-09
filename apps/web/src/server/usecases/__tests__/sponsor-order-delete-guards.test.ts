// Sponsor orders are money records; V299 flips their org/package FKs from
// CASCADE to RESTRICT after a live stg incident (2026-07-19): deleting a
// throwaway org hard-cascaded away a paid + disputed £10 order — the app's
// only record of the charge, and the dispute became permanently unmatchable.
// No app surface hard-deletes orgs or packages (both soft-flip), so the only
// paths that ever fired the cascade are scripts and direct SQL — exactly what
// a DB-level RESTRICT is for. deleteCompetition (which legitimately cascades
// its comp-scoped packages) now sweeps intent-less orders itself and refuses
// while payment-touched rows remain. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, deleteCompetition } from "@/server/usecases/competitions";
import { createDeal, endDealNow } from "@/server/usecases/sponsor-deals";
import {
  buildSponsorDisputeEvidence,
  listSponsorRows,
  patchSponsor,
  refundSponsorOrder,
} from "@/server/usecases/sponsors";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrgWithComp(): Promise<{
  auth: AuthCtx;
  orgId: string;
  compId: string;
}> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug)
    values (${"Restrict " + suffix}, ${"restrict-" + suffix}) returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = {
    orgId,
    via: "session",
    userId: null,
    role: "owner",
    keyId: null,
  };
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `Cup ${uniq()}`,
    visibility: "private",
    branding: {},
  });
  return { auth, orgId, compId: comp.id };
}

async function seedPackage(orgId: string, compId: string | null): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${compId}, 'Gold', 25000, 'gbp', 'gold') returning id`;
  return id;
}

type OrderSeed = {
  status?: "paid" | "pending" | "refunded";
  intent?: string | null;
  disputedAt?: Date | null;
  /** The deal's sponsor; a fresh one in the package's scope when omitted. */
  sponsorId?: string;
};

/** A deal-shaped order (sponsor deals F4/F5): every deal column explicit, an online on-payment deal snapshotting its package, and
 *  always a sponsor (sponsor_orders_sponsor_or_legacy). The money status picks the lifecycle: `paid` is a LIVE deal (parked when
 *  disputed, its sponsor `pending`), `pending` one AWAITING PAYMENT (its sponsor hidden until live), `refunded` an ENDED one (a lost
 *  dispute when disputed). */
async function seedOrder(orgId: string, packageId: string, o: OrderSeed = {}): Promise<string> {
  const status = o.status ?? "paid";
  const disputedAt = o.disputedAt ?? null;
  const [pkg] = await sql<{ competition_id: string | null; tier: string; name: string }[]>`
    select competition_id, tier, name from sponsor_packages where id = ${packageId}`;
  const sponsorStatus = status === "paid" ? (disputedAt ? "pending" : "active") : "inactive";
  const sponsorId = o.sponsorId ?? (await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, tier, status)
    values (${orgId}, ${pkg!.competition_id}, ${`S ${uniq()}`}, ${pkg!.tier}, ${sponsorStatus}) returning id`)[0]!.id;
  const deal = status === "paid" ? "live" : status === "pending" ? "awaiting_payment" : "ended";
  const now = new Date();
  const [{ id }] = await sql<{ id: string }[]>`
    insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email,
                                amount_cents, currency, status, payment_intent_id,
                                paid_at, disputed_at, sponsor_id,
                                deal_status, payment_method, go_live, live_at, parked_at, ended_at, ended_reason,
                                tier, includes_on_stream, package_name, competition_id)
    values (${orgId}, ${packageId}, 'S', 's@x.test', 25000, 'gbp',
            ${status}, ${o.intent === undefined ? "pi_" + uniq() : o.intent},
            ${o.intent === null ? null : now}, ${disputedAt}, ${sponsorId},
            ${deal}, 'online', 'on_payment', ${deal === "live" ? now : null}, ${deal === "live" ? disputedAt : null},
            ${deal === "ended" ? now : null}, ${deal === "ended" ? (disputedAt ? "dispute_lost" : "refunded") : null},
            ${pkg!.tier}, false, ${pkg!.name}, ${pkg!.competition_id})
    returning id`;
  return id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("sponsor order delete protection (V299)", () => {
  it("raw org delete with a paid sponsor order is refused by the DB", async () => {
    const { orgId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    await seedOrder(orgId, pkg);
    await expect(sql`delete from organizations where id = ${orgId}`).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("raw package delete with a paid sponsor order is refused by the DB", async () => {
    const { orgId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    await seedOrder(orgId, pkg);
    await expect(sql`delete from sponsor_packages where id = ${pkg}`).rejects.toMatchObject({
      code: "23503",
    });
  });

  // Sponsor deals D18 (Task 10): a deal-shaped order that is awaiting payment with no intent used to be swept here as an
  // "intent-less order". It is a DEAL now (non-legacy), and the competition delete refuses while one is scoped to it; the
  // abandoned-checkout sweep belongs to the legacy shape (the next test).
  it("deleteCompetition 409s while a session-less awaiting-payment deal is scoped to it, sweeping nothing", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const orderId = await seedOrder(orgId, pkg, {
      status: "pending",
      intent: null,
    });
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409 });
    expect(await sql`select 1 from competitions where id = ${compId}`).toHaveLength(1);
    expect(await sql`select 1 from sponsor_orders where id = ${orderId}`, "the deal was not swept").toHaveLength(1);
  });

  // Sponsor deals review I1 (2026-11-09): the deals delta made every pre-deals order an ended LEGACY deal and re-created the
  // tenant's prune policy. A pre-deals abandoned checkout (pending, no intent, undisputed, no sponsor, exactly as the deals
  // migration leaves one) must still be swept here, or the package delete below it fails its RESTRICT key.
  it("deleteCompetition still sweeps a legacy abandoned checkout along with its packages", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const [{ id: orderId }] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  payment_intent_id, disputed_at, sponsor_id,
                                  deal_status, payment_method, go_live, ended_at, ended_reason,
                                  tier, includes_on_stream, package_name, competition_id)
      values (${orgId}, ${pkg}, 'S', 's@x.test', 25000, 'gbp', 'pending', null, null, null,
              'ended', 'online', 'on_payment', now(), 'legacy', 'gold', false, 'Gold', ${compId})
      returning id`;
    await expect(deleteCompetition(auth, compId)).resolves.toBeUndefined();
    const [comp] = await sql`select 1 from competitions where id = ${compId}`;
    expect(comp).toBeUndefined();
    const [order] = await sql`select 1 from sponsor_orders where id = ${orderId}`;
    expect(order).toBeUndefined();
  });

  it("deleteCompetition 409s while a refunded order holds payment history", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    await seedOrder(orgId, pkg, { status: "refunded" });
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("deleteCompetition 409s while a disputed order exists", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    await seedOrder(orgId, pkg, { status: "refunded", disputedAt: new Date() });
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("a dispute-parked placement reads dispute_parked and refuses manual re-activation", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const [{ id: sponsorId }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status)
      values (${orgId}, ${compId}, 'Parked Co', 'gold', 'pending') returning id`;
    await seedOrder(orgId, pkg, { disputedAt: new Date(), sponsorId });
    const rows = await listSponsorRows(orgId);
    expect(rows.find((r) => r.id === sponsorId)).toMatchObject({
      dispute_parked: true,
    });
    await expect(patchSponsor(auth, sponsorId, { status: "active" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("dispute"),
    });
    // Editing anything else on the parked placement stays allowed.
    await expect(patchSponsor(auth, sponsorId, { name: "Parked Co Ltd" })).resolves.toMatchObject({
      name: "Parked Co Ltd",
    });
  });

  it("a lost dispute reads dispute_lost on the placement row", async () => {
    const { orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const [{ id: sponsorId }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status)
      values (${orgId}, ${compId}, 'Lost Co', 'gold', 'inactive') returning id`;
    const orderId = await seedOrder(orgId, pkg, {
      status: "refunded",
      disputedAt: new Date(),
      sponsorId,
    });
    await sql`update sponsor_orders set dispute_id = 'dp_lost_test' where id = ${orderId}`;
    const rows = await listSponsorRows(orgId);
    expect(rows.find((r) => r.id === sponsorId)).toMatchObject({
      dispute_lost: true,
      dispute_parked: false,
    });
  });

  it("evidence pack carries order, receipt, placement proof and dispute id", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const [{ id: sponsorId }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status, click_count)
      values (${orgId}, ${compId}, 'Evidence Co', 'gold', 'pending', 7) returning id`;
    const orderId = await seedOrder(orgId, pkg, { disputedAt: new Date(), sponsorId });
    await sql`update sponsor_orders set dispute_id = 'dp_ev_test' where id = ${orderId}`;
    const pack = await buildSponsorDisputeEvidence(auth, orderId, "https://ev.test");
    expect(pack.html).toContain("Gold"); // package
    expect(pack.html).toContain("s@x.test"); // customer email
    expect(pack.html).toContain("dp_ev_test"); // dispute id
    expect(pack.html).toContain("parked by this dispute"); // placement state
    expect(pack.html).toContain(">7<"); // click count as delivery proof
    expect(pack.html).toContain("https://ev.test/live/"); // absolute public page
    expect(pack.html).toMatch(/Receipt email/); // reconstruction section
    await expect(
      buildSponsorDisputeEvidence(auth, randomUUID(), "https://ev.test"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refunding a disputed order 409s in our own words, before Stripe", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const orderId = await seedOrder(orgId, pkg, { disputedAt: new Date() });
    // Keyless test env: reaching getStripe() would throw a config error, so a
    // clean 409 also proves the guard fired before any Stripe call. The
    // message must be ours — no raw Stripe text (charge ids) leaks.
    await expect(refundSponsorOrder(auth, orderId)).rejects.toMatchObject({
      status: 409,
      message: expect.not.stringContaining("ch_"),
    });
  });
});

// Sponsor deals D18 (Task 10; plan §4 item 3): deleting a competition a deal is scoped to — or that a deal-governed sponsor sits
// on — is a 409 with the archive hint, never a 500 (sponsor_orders.competition_id and .sponsor_id are RESTRICT, so the
// `sponsors.competition_id` cascade would otherwise die on 23503). Legacy orders are outside it: an abandoned checkout is still
// swept, and a paid one is still the older money guard's.
describe.skipIf(!HAS_DB)("deleteCompetition and sponsor deals (D18)", () => {
  const ORIGIN = "https://delete-guards.test";
  const HINT = "competition has sponsor deals — a deal is kept as history; archive it instead";

  async function sponsorIn(orgId: string, compId: string | null): Promise<string> {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status)
      values (${orgId}, ${compId}, ${`Deal Co ${uniq()}`}, 'partner', 'active') returning id`;
    return id;
  }
  /** A complimentary, straight-away deal through the real create. */
  async function dealOn(auth: AuthCtx, sponsorId: string, packageId: string, competitionId: string | null): Promise<string> {
    const made = await createDeal(
      auth,
      sponsorId,
      { package_id: packageId, competition_id: competitionId, payment_method: "complimentary", go_live: "immediate", sponsor_email: null, ends_on: null, end_current: false },
      ORIGIN,
    );
    return made.deal.id;
  }
  const exists = async (table: "competitions" | "sponsors" | "sponsor_orders", id: string): Promise<boolean> =>
    (await sql`select 1 from ${sql(table)} where id = ${id}`).length === 1;

  it("empty first: a competition with no sponsors at all deletes", async () => {
    const { auth, compId } = await seedOrgWithComp();
    await expect(deleteCompetition(auth, compId)).resolves.toBeUndefined();
    expect(await exists("competitions", compId)).toBe(false);
  });

  it("a complimentary deal on a package of this competition is a 409 with the hint, and is NOT swept (the guard decides before the sweep)", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    const sponsor = await sponsorIn(orgId, null);
    const dealId = await dealOn(auth, sponsor, pkg, compId);
    // The widened prune policy would let the sweep delete this session-less, unpaid deal through its package join.
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409, message: HINT });
    expect(await exists("competitions", compId)).toBe(true);
    expect(await exists("sponsor_orders", dealId), "the deal survives").toBe(true);
    expect(await exists("sponsors", sponsor)).toBe(true);
  });

  it("a complimentary deal scoped to it from an org-wide package is a 409, not the 500 the RESTRICT key gave", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    const sponsor = await sponsorIn(orgId, null);
    const dealId = await dealOn(auth, sponsor, pkg, compId);
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409, message: HINT });
    expect(await exists("sponsor_orders", dealId)).toBe(true);
    expect(await exists("competitions", compId)).toBe(true);
  });

  it("an org-wide deal whose sponsor was hand-scoped to the competition is a 409: the cascade would delete a sponsor its deal holds", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    const sponsor = await sponsorIn(orgId, null);
    // Offline, when paid: the deal waits (the sponsor is hidden), so the club may still scope the sponsor by hand.
    const made = await createDeal(
      auth,
      sponsor,
      { package_id: pkg, competition_id: null, payment_method: "offline", go_live: "on_payment", sponsor_email: null, ends_on: null, end_current: false },
      ORIGIN,
    );
    await sql`update sponsors set competition_id = ${compId} where id = ${sponsor}`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409, message: HINT });
    expect(await exists("sponsors", sponsor)).toBe(true);
    expect(await exists("sponsor_orders", made.deal.id)).toBe(true);
  });

  it("an ENDED deal still counts (history keeps its sponsor): a hand-scoped sponsor whose only deal has ended is a 409", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    const sponsor = await sponsorIn(orgId, null);
    const dealId = await dealOn(auth, sponsor, pkg, null);
    await endDealNow(auth, dealId);
    expect((await sql`select 1 from sponsor_orders where id = ${dealId} and deal_status = 'ended'`).length, "premise: it ended").toBe(1);
    await sql`update sponsors set competition_id = ${compId} where id = ${sponsor}`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409, message: HINT });
  });

  it("an ENDED deal scoped to the competition still blocks it, though its sponsor went back to the whole org (a deal is history)", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    const sponsor = await sponsorIn(orgId, null);
    const dealId = await dealOn(auth, sponsor, pkg, compId);
    await endDealNow(auth, dealId);
    const [after] = await sql<{ competition_id: string | null }[]>`select competition_id from sponsors where id = ${sponsor}`;
    expect(after!.competition_id, "premise: ending the deal reset the sponsor to the whole org").toBeNull();
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409, message: HINT });
    expect(await exists("sponsor_orders", dealId)).toBe(true);
  });

  it("a sponsor scoped to the competition with NO deal is deleted with it (today's cascade)", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const sponsor = await sponsorIn(orgId, compId);
    await expect(deleteCompetition(auth, compId)).resolves.toBeUndefined();
    expect(await exists("competitions", compId)).toBe(false);
    expect(await exists("sponsors", sponsor), "the cascade took the deal-less sponsor").toBe(false);
  });

  it("a deal scoped to ANOTHER competition does not block this delete, and is left intact", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const other = await createCompetition(auth, { ends_on: "2030-12-31", name: `Other ${uniq()}`, visibility: "private", branding: {} });
    const pkg = await seedPackage(orgId, null);
    const sponsor = await sponsorIn(orgId, null);
    const dealId = await dealOn(auth, sponsor, pkg, other.id);
    await expect(deleteCompetition(auth, compId)).resolves.toBeUndefined();
    expect(await exists("competitions", compId)).toBe(false);
    expect(await exists("competitions", other.id)).toBe(true);
    expect(await exists("sponsor_orders", dealId)).toBe(true);
  });

  it("a PAID deal on a package of this competition still answers in the money guard's words (payments-hardening.spec.ts pins them)", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    await seedOrder(orgId, pkg, { status: "paid" });
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("sponsorship payment records"),
    });
  });

  it("a PAID deal scoped to the competition from an org-wide package (invisible to the package-join money guard) is the deals 409, not a 500", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    const [{ id: sponsorId }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, tier, status)
      values (${orgId}, ${compId}, ${`Paid Co ${uniq()}`}, 'gold', 'active') returning id`;
    await sql`
      insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  payment_intent_id, paid_at, sponsor_id,
                                  deal_status, payment_method, go_live, live_at,
                                  tier, includes_on_stream, package_name, competition_id)
      values (${orgId}, ${pkg}, 'S', 's@x.test', 25000, 'gbp', 'paid', ${"pi_" + uniq()}, now(), ${sponsorId},
              'live', 'online', 'on_payment', now(), 'gold', false, 'Gold', ${compId})`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409, message: HINT });
  });

  // The brief wrote the sponsor-side arm with the same "not legacy" filter as the scope-side one. A legacy order that names a sponsor
  // (V493: only a PAID one ever did; an abandoned checkout has none) holds that sponsor by the RESTRICT key exactly as a deal does,
  // so excluding it left a 23503 / 500 here, the very failure D18 exists to remove.
  it("a legacy PAID order holding a sponsor scoped to the competition (org-wide package) is a 409, not the 500 its RESTRICT key gave", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, null);
    const sponsor = await sponsorIn(orgId, compId);
    await sql`
      insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  payment_intent_id, paid_at, sponsor_id,
                                  deal_status, payment_method, go_live, ended_at, ended_reason,
                                  tier, includes_on_stream, package_name, competition_id)
      values (${orgId}, ${pkg}, 'S', 's@x.test', 25000, 'gbp', 'paid', ${"pi_" + uniq()}, now(), ${sponsor},
              'ended', 'online', 'on_payment', now(), 'legacy', 'gold', false, 'Gold', null)`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({ status: 409, message: HINT });
    expect(await exists("sponsors", sponsor)).toBe(true);
  });

  it("a PAID legacy order is not a deal: the older money guard still answers, in its own words", async () => {
    const { auth, orgId, compId } = await seedOrgWithComp();
    const pkg = await seedPackage(orgId, compId);
    await sql`
      insert into sponsor_orders (org_id, package_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  payment_intent_id, paid_at, sponsor_id,
                                  deal_status, payment_method, go_live, ended_at, ended_reason,
                                  tier, includes_on_stream, package_name, competition_id)
      values (${orgId}, ${pkg}, 'S', 's@x.test', 25000, 'gbp', 'paid', ${"pi_" + uniq()}, now(), null,
              'ended', 'online', 'on_payment', now(), 'legacy', 'gold', false, 'Gold', ${compId})`;
    await expect(deleteCompetition(auth, compId)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("sponsorship payment records"),
    });
  });
});
