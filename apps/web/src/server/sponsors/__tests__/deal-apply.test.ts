// Sponsor deals, Task 5 (plan 2026-11-07-sponsor-deals D7/D8, spec §5.3 and §8a): `applyDealsToSponsor` is the ONE owner of
// what a sponsor's deals do to its row. Real Postgres: every case drives the real function in a real transaction, the way
// its callers will (console usecases under withTenant, the webhook and the sweep on the privileged connection), and reads
// the sponsor back from the table and through the public resolver.
//
// Expected values come from the plan's D-table and the spec, typed here: a live deal → the sponsor takes the deal's
// snapshot and `active` (`pending` while parked); open deals only → `inactive`, nothing else touched; the transition into
// all-ended → inactive, and partner / whole org / off the stream ONLY when a deal wrote the placement (controller ruling (g):
// `placement_from_deal_id`, set by the live write); every other all-ended apply writes nothing (F7).
//
// The sequence (TEST-STRATEGY rule 1): the empty case first; a second call; after a void (the deal ended, then a late event
// on it); the queue (promotion). "Another sport" is not applicable — sponsors read no sport (plan §3); its substitute,
// another PLAN, is the downgrade case (Pro → community).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, withTenant, type Tx } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { patchSponsor, resolveSponsors } from "@/server/usecases/sponsors";
import { applyDealsToSponsor, type ApplyOutcome } from "../deal-apply";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[] };

interface World {
  orgId: string;
  auth: AuthCtx;
  /** Competition C: the deals' scope. */
  compId: string;
  /** Another competition of the same org: the positive pair of every scoped read. */
  otherCompId: string;
  packageId: string;
}

async function world(plan: "pro" | "community" = "pro"): Promise<World> {
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values ('Apply Org', ${`apply-${uniq()}`}) returning id`;
  made.orgIds.push(orgId);
  if (plan === "pro") await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Apply Cup', ${`apply-cup-${uniq()}`}) returning id`;
  const [{ id: otherCompId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, 'Other Cup', ${`other-cup-${uniq()}`}) returning id`;
  const [{ id: packageId }] = await sql<{ id: string }[]>`
    insert into sponsor_packages (org_id, competition_id, name, price_cents, currency, tier)
    values (${orgId}, ${null}, 'Gold', 25000, 'gbp', 'gold') returning id`;
  return { orgId, auth: { orgId, via: "session", userId: null, role: "owner", keyId: null }, compId, otherCompId, packageId };
}

type SponsorFields = { tier: string; competition_id: string | null; status: string; on_stream: boolean };

/** A sponsor with HAND-SET fields, as the club set them before any deal (a no-deal sponsor is under manual control). */
async function sponsor(w: World, f: Partial<SponsorFields> = {}): Promise<string> {
  const v: SponsorFields = { tier: "partner", competition_id: null, status: "active", on_stream: false, ...f };
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, tier, status, on_stream)
    values (${w.orgId}, ${v.competition_id}, ${`Acme ${uniq()}`}, ${v.tier}, ${v.status}, ${v.on_stream}) returning id`;
  return row!.id;
}

type Deal = Record<string, string | number | boolean | Date | null>;

/** A coherent deal: an online, on-payment deal awaiting payment, gold on C, off the stream. `over` changes it. */
function deal(w: World, sponsorId: string, over: Deal = {}): Deal {
  return {
    org_id: w.orgId, package_id: w.packageId, sponsor_name: "Acme", sponsor_email: "billing@acme.test",
    amount_cents: 25000, currency: "gbp", status: "pending", sponsor_id: sponsorId,
    deal_status: "awaiting_payment", payment_method: "online", go_live: "on_payment",
    tier: "gold", includes_on_stream: false, package_name: "Gold", competition_id: w.compId,
    ended_at: null, ended_reason: null,
    ...over,
  };
}
const T0 = new Date("2031-03-01T10:00:00.000Z");
const T1 = new Date("2031-03-02T10:00:00.000Z");
const T2 = new Date("2031-03-03T10:00:00.000Z");
const LIVE: Deal = { deal_status: "live", status: "paid", paid_at: T0, live_at: T0 };
const SCHEDULED: Deal = { deal_status: "scheduled", status: "paid", paid_at: T0 };

async function insertDeal(row: Deal): Promise<string> {
  const [r] = await sql<{ id: string }[]>`insert into sponsor_orders ${sql(row as Record<string, never>)} returning id`;
  return r!.id;
}

/** The deal a caller moved out of live (or open) into ended, in ITS transaction, before it applies. */
async function endDeal(tx: Tx, dealId: string, reason = "ended_now"): Promise<void> {
  await tx`update sponsor_orders set deal_status = 'ended', ended_at = now(), ended_reason = ${reason} where id = ${dealId}`;
}

type Applied = { outcome: ApplyOutcome; promotedDealId: string | null };

/** A console caller (F2): under the tenant, the sponsor locked FIRST, then its deal moves, then the one owner applies. */
async function applyAsConsole(
  w: World,
  sponsorId: string,
  o: { before?: (tx: Tx) => Promise<void>; endedDealId?: string | null; now?: Date } = {},
): Promise<Applied> {
  return withTenant(w.orgId, async (tx) => {
    await tx`select 1 from sponsors where id = ${sponsorId} for update`;
    await o.before?.(tx);
    return applyDealsToSponsor(tx, sponsorId, null, { now: o.now ?? T1, endedDealId: o.endedDealId ?? null });
  });
}

/** The webhook / sweep caller: the privileged connection, no tenant. */
async function applyAsWebhook(sponsorId: string, o: { endedDealId?: string | null; now?: Date } = {}): Promise<Applied> {
  return sql.begin(async (tx) => {
    await tx`select 1 from sponsors where id = ${sponsorId} for update`;
    return applyDealsToSponsor(tx, sponsorId, null, { now: o.now ?? T1, endedDealId: o.endedDealId ?? null });
  }) as Promise<Applied>;
}

/** The whole sponsors row, byte for byte (every column, including the ones apply never names). */
const rowBytes = async (id: string): Promise<string> =>
  (await sql<{ row: string }[]>`select to_jsonb(s)::text as row from sponsors s where s.id = ${id}`)[0]!.row;

const fields = async (id: string): Promise<SponsorFields> =>
  (await sql<SponsorFields[]>`select tier, competition_id, status, on_stream from sponsors where id = ${id}`)[0]!;

/** Placement provenance (ruling (g)): the deal whose snapshot the sponsor carries, or null when the club placed it by hand. */
const provenance = async (id: string): Promise<string | null> =>
  (await sql<{ p: string | null }[]>`select placement_from_deal_id as p from sponsors where id = ${id}`)[0]!.p;

const dealState = async (id: string) =>
  (await sql<{ deal_status: string; live_at: Date | null }[]>`select deal_status, live_at from sponsor_orders where id = ${id}`)[0]!;

const listed = async (orgId: string, compId: string, opts: { onStream?: boolean } = {}): Promise<string[]> =>
  (await resolveSponsors(orgId, compId, opts)).map((s) => s.id);

const orgStreamRows = async (orgId: string) =>
  sql<{ enabled: boolean; frequency: string }[]>`
    select enabled, frequency from sponsor_stream_settings where org_id = ${orgId} and competition_id is null`;

afterAll(async () => {
  if (!HAS_DB) return;
  // Deals RESTRICT their org's package, sponsor and competition, so they go first; the org delete cascades the rest.
  if (made.orgIds.length > 0) {
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

describe.skipIf(!HAS_DB)("applyDealsToSponsor — the one owner of a deal's effect on its sponsor (D8)", () => {
  // ---- the empty case first ----------------------------------------------------------------------------------------
  it("empty: a sponsor with no deals keeps its hand-set gold, C, active and on-stream values byte-equal (no_deals)", async () => {
    const w = await world();
    const id = await sponsor(w, { tier: "gold", competition_id: w.compId, status: "active", on_stream: true });
    const before = await rowBytes(id);

    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "no_deals", promotedDealId: null });
    expect(await rowBytes(id), "a no-deal sponsor is under manual control: nothing written").toBe(before);
    expect(await orgStreamRows(w.orgId), "and no stream row made on its behalf").toHaveLength(0);
    // The second call is the same empty answer.
    await expect(applyAsWebhook(id)).resolves.toEqual({ outcome: "no_deals", promotedDealId: null });
    expect(await rowBytes(id)).toBe(before);
  });

  it("a sponsor whose only rows are legacy deals is a no-deal sponsor (D6: apply ignores legacy rows)", async () => {
    const w = await world();
    const id = await sponsor(w, { tier: "gold", competition_id: w.compId, status: "active" });
    await insertDeal(deal(w, id, {
      deal_status: "ended", ended_reason: "legacy", ended_at: T0, status: "paid", paid_at: T0,
      payment_intent_id: `pi_legacy_${uniq()}`,
    }));
    const before = await rowBytes(id);

    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "no_deals", promotedDealId: null });
    expect(await rowBytes(id)).toBe(before);
  });

  // ---- a live deal ------------------------------------------------------------------------------------------------
  it("a live gold deal on C with On stream: the sponsor is active / gold / C / on stream, the org's stream row exists, C lists it and another competition does not", async () => {
    const w = await world();
    const id = await sponsor(w, { tier: "partner", competition_id: null, status: "inactive", on_stream: false });
    await insertDeal(deal(w, id, { ...LIVE, tier: "gold", competition_id: w.compId, includes_on_stream: true }));
    expect(await orgStreamRows(w.orgId), "premise: the org has no stream row yet").toHaveLength(0);

    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "live", promotedDealId: null });
    expect(await fields(id)).toEqual({ tier: "gold", competition_id: w.compId, status: "active", on_stream: true });
    // R12 / spec D12: the first sponsor on the stream turns the org's rotation on, enabled at Normal.
    expect(await orgStreamRows(w.orgId)).toEqual([{ enabled: true, frequency: "normal" }]);
    expect(await listed(w.orgId, w.compId), "C's public strip lists it").toContain(id);
    expect(await listed(w.orgId, w.compId, { onStream: true }), "and C's stream rotation").toContain(id);
    expect(await listed(w.orgId, w.otherCompId), "another competition does not: the deal's scope is C").not.toContain(id);
  });

  it("an existing org stream row the club switched off stays off when an on-stream deal goes live", async () => {
    const w = await world();
    await sql`insert into sponsor_stream_settings (org_id, competition_id, enabled, frequency)
              values (${w.orgId}, ${null}, false, 'busy')`;
    const id = await sponsor(w, { status: "inactive" });
    await insertDeal(deal(w, id, { ...LIVE, includes_on_stream: true }));

    await applyAsConsole(w, id);
    expect(await orgStreamRows(w.orgId), "a deal never overwrites the club's own dial").toEqual([{ enabled: false, frequency: "busy" }]);
  });

  it("a parked live deal (an open dispute) holds the sponsor at pending, off every public read; unparked, it comes back", async () => {
    const w = await world();
    const id = await sponsor(w, { status: "active" });
    const dealId = await insertDeal(deal(w, id, { ...LIVE, disputed_at: T1, parked_at: T1 }));

    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "parked", promotedDealId: null });
    expect(await fields(id)).toEqual({ tier: "gold", competition_id: w.compId, status: "pending", on_stream: false });
    expect(await listed(w.orgId, w.compId), "a parked sponsor is hidden").not.toContain(id);

    // The positive pair: the dispute closes won, the park lifts, and the same apply puts it back.
    await sql`update sponsor_orders set parked_at = null, disputed_at = null where id = ${dealId}`;
    await expect(applyAsWebhook(id)).resolves.toEqual({ outcome: "live", promotedDealId: null });
    expect((await fields(id)).status).toBe("active");
    expect(await listed(w.orgId, w.compId)).toContain(id);
  });

  // ---- open deals only: the ruling case ---------------------------------------------------------------------------
  it("RULING (§8a, owner '1 Ok'): a visible no-deal sponsor is hidden when a deal waiting to go live is added — tier, scope and stream untouched — and shows again, same id, once it is live", async () => {
    const w = await world();
    const id = await sponsor(w, { tier: "partner", competition_id: null, status: "active", on_stream: false });
    expect(await listed(w.orgId, w.compId), "premise: a no-deal sponsor shows as soon as it is added").toContain(id);

    const dealId = await insertDeal(deal(w, id, { tier: "gold", competition_id: w.compId, includes_on_stream: true }));
    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "hidden_open", promotedDealId: null });
    expect(await fields(id), "hidden, and ONLY hidden: the open deal's snapshot is not applied yet")
      .toEqual({ tier: "partner", competition_id: null, status: "inactive", on_stream: false });
    expect(await listed(w.orgId, w.compId)).not.toContain(id);

    // Mark as paid (Task 6 drives the real action): the deal goes live, and the sponsor takes its snapshot.
    await sql`update sponsor_orders set deal_status = 'live', status = 'paid', paid_at = ${T1}, live_at = ${T1} where id = ${dealId}`;
    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "live", promotedDealId: null });
    expect(await fields(id)).toEqual({ tier: "gold", competition_id: w.compId, status: "active", on_stream: true });
    expect(await listed(w.orgId, w.compId), "shown again, the same sponsor").toContain(id);
  });

  it("every open status hides its sponsor: draft, awaiting payment, awaiting approval (count reported)", async () => {
    const w = await world();
    // D2's lifecycle, minus live, ended and scheduled (a scheduled deal is promoted, below).
    const OPEN: Deal[] = [
      { deal_status: "draft" },
      { deal_status: "awaiting_payment", payment_method: "offline" },
      { deal_status: "awaiting_approval", status: "paid", paid_at: T0, go_live: "on_approval" },
    ];
    let checked = 0;
    for (const over of OPEN) {
      const id = await sponsor(w, { status: "active" });
      await insertDeal(deal(w, id, over));
      await expect(applyAsConsole(w, id), String(over.deal_status)).resolves.toEqual({ outcome: "hidden_open", promotedDealId: null });
      expect((await fields(id)).status, String(over.deal_status)).toBe("inactive");
      checked++;
    }
    expect(checked, "open statuses checked").toBe(3);
  });

  // ---- all ended -----------------------------------------------------------------------------------------------------
  it("all ended, ON the transition, after a deal WROTE the placement (it was live): inactive, partner, whole org, off the stream — ended_all, provenance cleared", async () => {
    const w = await world();
    const id = await sponsor(w, { tier: "partner", competition_id: null, status: "inactive", on_stream: false });
    const dealId = await insertDeal(deal(w, id, { ...LIVE, tier: "gold", competition_id: w.compId, includes_on_stream: true }));
    // The live write (End now, expiry, a refund, a lost dispute all come after one): the deal's snapshot and its provenance.
    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "live", promotedDealId: null });
    expect(await provenance(id), "the live write records the deal (ruling (g))").toBe(dealId);

    await expect(applyAsConsole(w, id, { before: (tx) => endDeal(tx, dealId), endedDealId: dealId }))
      .resolves.toEqual({ outcome: "ended_all", promotedDealId: null });
    expect(await fields(id)).toEqual({ tier: "partner", competition_id: null, status: "inactive", on_stream: false });
    expect(await provenance(id), "cleared with the reset").toBeNull();
    expect(await listed(w.orgId, w.compId)).not.toContain(id);
  });

  it("RULING (g): all ended, ON the transition, of a deal that never went live on a HAND-placed sponsor: inactive only — its gold, C and stream are the club's and stay (ended_all)", async () => {
    const w = await world();
    let checked = 0;
    // Every open status the transition can come from (D2's lifecycle minus live and ended).
    for (const over of [{ deal_status: "draft" }, {}, { deal_status: "awaiting_approval", status: "paid", paid_at: T0, go_live: "on_approval" }, SCHEDULED] as Deal[]) {
      const label = String(over.deal_status ?? "awaiting_payment");
      const id = await sponsor(w, { tier: "gold", competition_id: w.compId, status: "active", on_stream: true });
      const dealId = await insertDeal(deal(w, id, { ...over, tier: "silver", competition_id: null, includes_on_stream: false, ends_at: T0 }));
      // `ends_at` T0 is behind the apply's clock (T1): a scheduled deal is past its end, so it is never promoted (F19) and
      // ending it is the transition from open.
      await expect(
        applyAsConsole(w, id, { before: (tx) => endDeal(tx, dealId), endedDealId: dealId }),
        label,
      ).resolves.toEqual({ outcome: "ended_all", promotedDealId: null });
      expect(await fields(id), label).toEqual({ tier: "gold", competition_id: w.compId, status: "inactive", on_stream: true });
      expect(await provenance(id), label).toBeNull();
      expect(await listed(w.orgId, w.compId), label).not.toContain(id);
      checked++;
    }
    expect(checked, "open statuses checked").toBe(4);
  });

  it("F7 (spec §10 Q3): after every deal ended, the club switches the sponsor back on by hand, and a later apply on the old deal (a dispute closing, a refund of the ended deal) leaves the row byte-equal", async () => {
    const w = await world();
    const id = await sponsor(w, { status: "inactive" });
    const dealId = await insertDeal(deal(w, id, { ...LIVE, payment_intent_id: `pi_${uniq()}` }));
    await applyAsConsole(w, id);
    await expect(applyAsConsole(w, id, { before: (tx) => endDeal(tx, dealId), endedDealId: dealId }))
      .resolves.toMatchObject({ outcome: "ended_all" });
    expect(await fields(id), "premise: the transition reset the sponsor").toMatchObject({ status: "inactive", tier: "partner" });

    // Manual control again (D9: once every deal has ended): on, and gold, by hand.
    await expect(patchSponsor(w.auth, id, { status: "active", tier: "gold" })).resolves.toMatchObject({ status: "active", tier: "gold" });
    const switchedOn = await rowBytes(id);

    // A late event on the ended deal re-runs apply with NO transition (Task 8 drives the real dispute close / refund).
    await sql`update sponsor_orders set disputed_at = ${T2}, dispute_id = ${`dp_${uniq()}`} where id = ${dealId}`;
    await expect(applyAsWebhook(id)).resolves.toEqual({ outcome: "no_deals", promotedDealId: null });
    expect(await rowBytes(id), "the club's hand switch-back-on survives").toBe(switchedOn);
    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "no_deals", promotedDealId: null });
    expect(await rowBytes(id), "and on a second late apply").toBe(switchedOn);
    expect(await listed(w.orgId, w.compId)).toContain(id);
  });

  // ---- the queue: promotion (Review Focus 5) ----------------------------------------------------------------------------
  it("promotion: live A plus scheduled B; ending A puts the EARLIEST scheduled deal live (live_at = now) and the sponsor takes B's snapshot", async () => {
    const w = await world();
    const id = await sponsor(w, { status: "inactive" });
    const a = await insertDeal(deal(w, id, { ...LIVE, tier: "gold", competition_id: w.compId, includes_on_stream: true }));
    // Inserted first but created LATER: the queue goes by created_at, never by insertion order.
    const later = await insertDeal(deal(w, id, { ...SCHEDULED, tier: "title", competition_id: w.otherCompId, created_at: T1 }));
    const b = await insertDeal(deal(w, id, { ...SCHEDULED, tier: "silver", competition_id: null, created_at: T0 }));
    await expect(applyAsConsole(w, id)).resolves.toEqual({ outcome: "live", promotedDealId: null });
    expect(await fields(id), "premise: A is on the sponsor").toMatchObject({ tier: "gold", competition_id: w.compId, on_stream: true });

    await expect(applyAsConsole(w, id, { before: (tx) => endDeal(tx, a), endedDealId: a, now: T2 }))
      .resolves.toEqual({ outcome: "live", promotedDealId: b });
    expect(await dealState(b)).toEqual({ deal_status: "live", live_at: T2 });
    expect((await dealState(later)).deal_status, "the later one keeps waiting").toBe("scheduled");
    expect((await dealState(a)).deal_status).toBe("ended");
    expect(await fields(id), "B's snapshot").toEqual({ tier: "silver", competition_id: null, status: "active", on_stream: false });
    expect(await listed(w.orgId, w.otherCompId), "B is org-wide: every competition lists it now").toContain(id);
  });

  it("F19: the queue skips a scheduled deal whose own ends_at has passed and promotes the next eligible one (whoever ended the live deal)", async () => {
    const w = await world();
    const id = await sponsor(w, { status: "inactive" });
    const a = await insertDeal(deal(w, id, { ...LIVE, tier: "gold", competition_id: w.compId }));
    // B heads the queue (created first) but its end date (T1) is behind the apply's clock (T2): it must be passed over.
    const b = await insertDeal(deal(w, id, { ...SCHEDULED, tier: "silver", competition_id: null, created_at: T0, ends_at: T1 }));
    const c = await insertDeal(deal(w, id, { ...SCHEDULED, tier: "title", competition_id: w.otherCompId, created_at: T1, ends_at: new Date(T2.getTime() + 86_400_000) }));
    await applyAsConsole(w, id);

    await expect(applyAsConsole(w, id, { before: (tx) => endDeal(tx, a), endedDealId: a, now: T2 }))
      .resolves.toEqual({ outcome: "live", promotedDealId: c });
    expect(await dealState(b), "B is passed over, never live").toEqual({ deal_status: "scheduled", live_at: null });
    expect((await dealState(c)).deal_status).toBe("live");
    expect(await fields(id), "the sponsor takes C's snapshot").toEqual({ tier: "title", competition_id: w.otherCompId, status: "active", on_stream: false });
  });

  it("F19: when every scheduled deal is past its end nothing is promoted: the sponsor is hidden (open deals wait), not reset; the boundary ends_at = now counts as past", async () => {
    const w = await world();
    const id = await sponsor(w, { status: "inactive" });
    const a = await insertDeal(deal(w, id, { ...LIVE, tier: "gold", competition_id: w.compId }));
    const b = await insertDeal(deal(w, id, { ...SCHEDULED, tier: "silver", competition_id: null, created_at: T1, ends_at: T2 })); // ends exactly at now
    await applyAsConsole(w, id);

    await expect(applyAsConsole(w, id, { before: (tx) => endDeal(tx, a), endedDealId: a, now: T2 }))
      .resolves.toEqual({ outcome: "hidden_open", promotedDealId: null });
    expect(await dealState(b)).toEqual({ deal_status: "scheduled", live_at: null });
    expect(await fields(id), "hidden behind the open deal; the reset waits for the LAST open deal to end").toMatchObject({ status: "inactive", tier: "gold" });

    // The same deal one millisecond before its end is eligible: the boundary is `<=`, and the skip is not blanket.
    const w2 = await world();
    const id2 = await sponsor(w2, { status: "inactive" });
    const a2 = await insertDeal(deal(w2, id2, { ...LIVE, tier: "gold", competition_id: w2.compId }));
    const b2 = await insertDeal(deal(w2, id2, { ...SCHEDULED, tier: "silver", competition_id: null, created_at: T1, ends_at: new Date(T2.getTime() + 1) }));
    await applyAsConsole(w2, id2);
    await expect(applyAsConsole(w2, id2, { before: (tx) => endDeal(tx, a2), endedDealId: a2, now: T2 }))
      .resolves.toEqual({ outcome: "live", promotedDealId: b2 });
  });

  // ---- a second call -------------------------------------------------------------------------------------------------
  it("second call: apply twice gives the identical row, and never rewrites live_at (nor promotes again)", async () => {
    const w = await world();
    const id = await sponsor(w, { status: "inactive" });
    const live = await insertDeal(deal(w, id, LIVE));
    await applyAsConsole(w, id, { now: T1 });
    const first = await rowBytes(id);
    await expect(applyAsWebhook(id, { now: T2 })).resolves.toEqual({ outcome: "live", promotedDealId: null });
    expect(await rowBytes(id)).toBe(first);
    expect((await dealState(live)).live_at, "live_at is the deal's own, never the apply's clock").toEqual(T0);

    // The same after a promotion: the second apply finds B live and leaves it.
    const b = await insertDeal(deal(w, id, SCHEDULED));
    await applyAsConsole(w, id, { before: (tx) => endDeal(tx, live), endedDealId: live, now: T1 });
    const promoted = await rowBytes(id);
    await expect(applyAsConsole(w, id, { now: T2 })).resolves.toEqual({ outcome: "live", promotedDealId: null });
    expect(await rowBytes(id)).toBe(promoted);
    expect(await dealState(b)).toEqual({ deal_status: "live", live_at: T1 });
  });

  // ---- another plan: the downgrade (Review Focus 4) -------------------------------------------------------------------
  it("downgrade keeps a live tiered deal live, public strip un-tiered: Pro gold deal live, then community — apply keeps active/gold and resolveSponsors(tiered: false) shows it as partner", async () => {
    const w = await world("pro");
    const id = await sponsor(w, { status: "inactive" });
    await insertDeal(deal(w, id, { ...LIVE, tier: "gold", competition_id: w.compId }));
    await applyAsConsole(w, id);

    await setOrgPlan(w.orgId, "community");
    await invalidateOrgEntitlements(w.orgId);
    await expect(applyAsWebhook(id)).resolves.toEqual({ outcome: "live", promotedDealId: null });
    expect(await fields(id), "the deal is not the plan's to undo").toEqual({ tier: "gold", competition_id: w.compId, status: "active", on_stream: false });
    const untiered = (await resolveSponsors(w.orgId, w.compId, { tiered: false })).find((s) => s.id === id);
    expect(untiered?.tier, "the public strip collapses it").toBe("partner");
    const tiered = (await resolveSponsors(w.orgId, w.compId)).find((s) => s.id === id);
    expect(tiered?.tier, "the positive pair: the collapse is the resolver's, the row stays gold").toBe("gold");
  });

  // ---- assumptions are guards ---------------------------------------------------------------------------------------------
  it("refuses an endedDealId that is not an ENDED deal of this sponsor (a live one, another sponsor's, a legacy row), writing nothing", async () => {
    const w = await world();
    const id = await sponsor(w, { tier: "gold", status: "active" });
    const liveId = await insertDeal(deal(w, id, LIVE));
    const otherSponsor = await sponsor(w);
    const othersEnded = await insertDeal(deal(w, otherSponsor, { deal_status: "ended", ended_at: T0, ended_reason: "ended_now" }));
    const legacyId = await insertDeal(deal(w, id, { deal_status: "ended", ended_at: T0, ended_reason: "legacy" }));
    await applyAsConsole(w, id);
    const before = await rowBytes(id);

    let checked = 0;
    for (const [label, endedDealId] of [["live", liveId], ["another sponsor's", othersEnded], ["legacy", legacyId]] as const) {
      await expect(applyAsConsole(w, id, { endedDealId }), label).rejects.toThrow(/endedDealId/);
      checked++;
    }
    expect(checked, "refusals checked").toBe(3);
    expect(await rowBytes(id)).toBe(before);
  });

  it("refuses a sponsor that is not there (or is another org's, under the tenant)", async () => {
    const w = await world();
    const elsewhere = await world();
    const theirs = await sponsor(elsewhere);
    await expect(applyAsConsole(w, randomUUID())).rejects.toThrow(/no sponsor/);
    await expect(applyAsConsole(w, theirs), "RLS: another org's sponsor is not there").rejects.toThrow(/no sponsor/);
  });
});
