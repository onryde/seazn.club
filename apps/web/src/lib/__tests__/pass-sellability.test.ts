// WHICH EVENT PASS RUNGS ARE ON SALE — the authority, and the dormancy it buys.
//
// Owner decision 2026-09-05: the L rung comes OFF SALE. Pro is cheaper than L
// in money at every volume for a one-month competition ($44.99 one-time against
// $14.99/mo, and L's platform fee is the same 4% as M), so L's only real edge is
// capacity — 512 entrants per division against Pro's 256. A buyer comparing on
// price is therefore misled by a rung that reads as a savings product while
// being a capacity product. Rather than write copy explaining that, the rung
// comes off sale.
//
// HIDDEN, NOT DELETED — the R13 precedent (the extra-seat add-on, design
// §1 R13: "keep code and price dormant"). The `plans` row, the
// `plan_entitlements` matrix, the `stripe-plans.json` seed entry, the Stripe
// price, `PASS_CREDIT_GRANT.event_pass_l` and every resolution path stay
// exactly as they are. An org that already holds an L pass must keep working
// unchanged, and that half is what the second describe below exists for: it is
// the requirement most likely to break silently, because nothing a customer can
// reach exercises it any more.
//
// The authority is ONE list. `SELLABLE_PASS_KEYS` sits beside `PASS_KEYS` in
// lib/currency.ts — selling surfaces read the sellable list, resolution keeps
// reading the full one — mirroring `PUBLICLY_READABLE_VISIBILITIES`
// (usecases/entitlement-freeze.ts), which was introduced last week for exactly
// this reason. A scattered `key !== "event_pass_l"` in six files is the thing
// this replaces: two implementations that happen to agree today are the defect
// this repo keeps paying for, not the symptom.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ALL_PLAN_KEYS,
  HIDDEN_PASS_KEYS,
  PASS_KEYS,
  SELLABLE_PASS_KEYS,
  isPassKey,
  isSellablePassKey,
  passPrice,
  SUPPORTED_CURRENCIES,
} from "@/lib/currency";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import { PASS_RUNG_NAME_KEY, passActiveLabel } from "@/lib/pass-ladder";
import stripePlans from "@/config/stripe-plans.json";
import enUi from "@/dictionaries/en/ui.json";
import { sql } from "@/lib/db";
import { getLimit, hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

describe("SELLABLE_PASS_KEYS — the one list of rungs on sale", () => {
  it("is a non-empty subset of PASS_KEYS, in the same order", () => {
    // Non-empty is not decoration: an empty sellable list would make every
    // "no surface offers L" assertion below pass vacuously, on a product that
    // sells no pass at all.
    expect(SELLABLE_PASS_KEYS.length).toBeGreaterThan(0);
    expect(new Set(SELLABLE_PASS_KEYS).size).toBe(SELLABLE_PASS_KEYS.length);
    for (const key of SELLABLE_PASS_KEYS) {
      expect(PASS_KEYS, `${key} must still be a real rung`).toContain(key);
    }
    // Ladder order carries meaning — `passLadderOptions` renders smallest-first
    // and the picker pre-selects the first element — so the sellable list is a
    // FILTER of the ladder, never a re-ordering of it.
    expect([...SELLABLE_PASS_KEYS]).toEqual(PASS_KEYS.filter((k) => isSellablePassKey(k)));
  });

  it("hides event_pass_l and sells event_pass — the owner decision, both halves", () => {
    // The negative…
    expect(SELLABLE_PASS_KEYS).not.toContain("event_pass_l");
    expect(isSellablePassKey("event_pass_l")).toBe(false);
    // …and its positive pair. Without this the assertions above are satisfied
    // by a product that sells nothing.
    expect(SELLABLE_PASS_KEYS).toContain("event_pass");
    expect(isSellablePassKey("event_pass")).toBe(true);
  });

  it("hidden is not deleted — the L rung is still a rung everywhere resolution looks", () => {
    // `isPassKey` is what the checkout route's validation, the webhook and the
    // reconcile paths read a rung back out of Stripe metadata with. Hiding the
    // rung must not make a HELD pass unrecognisable.
    expect(isPassKey("event_pass_l")).toBe(true);
    expect(PASS_KEYS).toContain("event_pass_l");
    expect(ALL_PLAN_KEYS).toContain("event_pass_l");
    // HIDDEN_PASS_KEYS is the complement, derived rather than typed, so the two
    // lists cannot disagree about a rung.
    expect([...HIDDEN_PASS_KEYS]).toEqual(PASS_KEYS.filter((k) => !isSellablePassKey(k)));
    expect(HIDDEN_PASS_KEYS).toContain("event_pass_l");
    // A rung is on sale or hidden, never both and never neither.
    expect(SELLABLE_PASS_KEYS.length + HIDDEN_PASS_KEYS.length).toBe(PASS_KEYS.length);
  });

  it("keeps the hidden rung's catalogue price — the seed and Stripe stay dormant, not archived", () => {
    // R13's shape: the price is KEPT so the rung can be put back on sale
    // without a repricing, and so a pass already sold can still be refunded and
    // reconciled against its own amount. W4 owns the Stripe sync; nothing here
    // archives anything.
    const seeded = (stripePlans.passes ?? []).map((p) => p.key);
    for (const key of PASS_KEYS) {
      expect(seeded, `${key} must keep its stripe-plans.json entry`).toContain(key);
    }
    // …and it must still be PRICEABLE in every currency, or a held L pass's
    // receipt and its refund have no amount to name.
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(passPrice(currency, "event_pass_l"), `L in ${currency}`).toBeGreaterThan(0);
    }
  });

  it("every SELLABLE rung is one we can actually charge for", () => {
    // The list decides what a buy surface offers, so a rung named here with no
    // price seed would put a dead button in front of a customer.
    const seeded = new Map((stripePlans.passes ?? []).map((p) => [p.key, p]));
    for (const key of SELLABLE_PASS_KEYS) {
      expect(seeded.has(key), `${key} has no stripe-plans.json price`).toBe(true);
      for (const currency of SUPPORTED_CURRENCIES) {
        expect(passPrice(currency, key), `${key} in ${currency}`).toBeGreaterThan(0);
      }
    }
  });
});

// ── Dormancy ────────────────────────────────────────────────────────────────
//
// Everything below is about an org that ALREADY HOLDS an L pass. Nothing a
// customer can reach sells one any more, so nothing a customer can reach
// exercises these paths either — which is exactly why they are the ones that
// rot. Every assertion here passed before the rung was hidden and must go on
// passing after it.
describe.skipIf(!HAS_DB)("an org holding an L pass keeps everything it bought", () => {
  let orgId = "";
  let compId = "";

  beforeAll(async () => {
    const s = uniq();
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`dormant-l-${s}@test.local`}, 'Dormant L Owner', true) returning id`;
    const [{ id: org }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, created_by)
      values (${"Dormant L " + s}, ${"dormant-l-" + s}, ${ownerId}) returning id`;
    orgId = org;
    // The resolvers take a different LEFT JOIN arm without a subscriptions row,
    // so seed one the way lib/auth.ts would.
    await sql`
      with _seed_sub as (
        insert into subscriptions (owner_user_id, plan_key, status)
        values (${ownerId}, 'community', 'active') returning id
      )
      update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
    const [{ id: comp }] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug)
      values (${orgId}, ${"Dormant L Cup " + s}, ${"dormant-l-cup-" + s}) returning id`;
    compId = comp;
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${compId}, ${orgId}, 'event_pass_l')`;
    await invalidateOrgEntitlements(orgId);
  });

  afterAll(async () => {
    if (orgId) await sql`delete from organizations where id = ${orgId}`;
  });

  it("still resolves L's OWN caps, not M's and not the org's plan", async () => {
    // Read from the matrix rather than typed here, so a legitimate reprice of
    // the rung moves the expectation with it instead of leaving this suite
    // asserting yesterday's numbers — and so the two sides cannot both be
    // wrong in the same direction.
    const [entrants] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = 'event_pass_l' and feature_key = 'entrants.per_division.max'`;
    const [divisions] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = 'event_pass_l' and feature_key = 'divisions.per_competition.max'`;
    const [mEntrants] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
       where plan_key = 'event_pass' and feature_key = 'entrants.per_division.max'`;
    // Anti-vacuity: the two rungs must differ on this axis, or "resolves L's
    // own cap" is satisfied by resolving M's.
    expect(entrants!.int_value).not.toBe(mEntrants!.int_value);

    expect(await getLimit(orgId, "entrants.per_division.max", compId)).toBe(entrants!.int_value);
    expect(await getLimit(orgId, "divisions.per_competition.max", compId)).toBe(
      divisions!.int_value,
    );
    // …and the org's own community plan is NOT what answered — the pass is
    // doing the lifting.
    expect(await getLimit(orgId, "entrants.per_division.max")).not.toBe(entrants!.int_value);
  });

  it("still lifts the flag features the rung grants", async () => {
    // `realtime` is community-false / pass-true, the established probe key for
    // the pass in entitlements-sql-parity.test.ts.
    expect(await hasFeature(orgId, "realtime", compId)).toBe(true);
    expect(await hasFeature(orgId, "realtime")).toBe(false);
  });

  it("keeps its own credit grant, distinct from M's", () => {
    expect(PASS_CREDIT_GRANT.event_pass_l).toBeGreaterThan(0);
    expect(PASS_CREDIT_GRANT.event_pass_l).not.toBe(PASS_CREDIT_GRANT.event_pass);
    // Keyed by every rung, hidden ones included: a `Record<PassKey, number>`
    // narrowed to the sellable set would deny a held L pass its top-up.
    expect(Object.keys(PASS_CREDIT_GRANT).sort()).toEqual([...PASS_KEYS].sort());
  });

  it("still NAMES its rung on the held ticket — 'Event Pass L active', not a bare family name", () => {
    // The held signal is the one surface that must go on naming L. An org that
    // paid for L and is shown the M-shaped "Event Pass active" is being told
    // it holds the other product, on the only screen that says which it holds.
    // So `PASS_RUNG_NAME_KEY` stays keyed by every rung and `upgrade.rung.l`
    // stays in the dictionary — hiding the rung removes it from what a customer
    // can BUY, never from what a customer already OWNS.
    expect(PASS_RUNG_NAME_KEY.event_pass_l).toBeTruthy();
    const label = passActiveLabel(enUi, "event_pass_l");
    expect(label).not.toContain("{rung}");
    expect(label).not.toBe(passActiveLabel(enUi, "event_pass"));
    expect(label).toContain("L");
  });
});
