// Sponsor x live-stream matrix, LAYER L1 (docs/superpowers/specs/2026-11-12-sponsor-stream-matrix-design.md, G1 + G2):
// a table-driven, DB-backed suite that drives the REAL seam
//
//   deal usecase -> `applyDealsToSponsor` -> the `sponsors` row -> `resolveSponsors` (card source) -> `loadSponsorPlan`
//   -> the overlay payload (`loadOverlayLiveData`, both doors)            and the public page's own strip reader
//
// with nothing hand-built on either end (AGENTS.md class 1): every sponsor, package and deal is made by the real usecases
// (createSponsor, createSponsorPackage, createDeal, markDealPaid, endDealNow, writeOffDeal, archiveSponsor, sweepSponsorDeals),
// an online deal is paid through the REAL billing dispatcher (`runEvent`, payment_intent.succeeded), and the plan is read back
// through the loader the overlay polls. Only the network seams are replaced: Stripe, the outbox transport, Sentry.
//
// WHAT A CELL IS. One cell is a combination of the axes in stream-matrix-cells.ts (plan x tier x deal state x payment x scope x
// stream flag). The cell list is generated - pairwise, every single-axis edge, and two full interaction families (state x payment, and
// plan x tier x scope for offline and online) - and the suite reports how many it checked.
// A combination the plan cannot make is NOT skipped: the plan REFUSES the deal (402 naming the feature) and the refusal is the
// cell's checked answer - and what a refusal leaves behind (nothing) is checked with it.
//
// WHAT IS CHECKED PER CELL (all four from the oracle, stream-matrix-oracle.ts - never from the code under test):
//   airs        the sponsor is a ticked card in the overlay payload of a fixture of THIS competition (relay and public door alike)
//   aired tier  the tier on that card, after the no-`sponsors.tiers` flattening to partner (ruling R13)
//   weight      its share of the rotation: one poll over exactly 2 full cycles of majors hands it 2 x SPONSOR_TIER_WEIGHTS[tier]
//               airings, and the control sponsor (a partner, on every cell) 2 x the partner weight - and every break got a card
//   public page the sponsor is on the competition's public strip (`resolveSponsors` with the page's own `tiered` flag), with the
//               tier the strip shows
// plus the premises that prove the script reached the cell it names: the deal's status and money (spec D2, §8a), the sponsor
// row the deal wrote (§5.3), a refusal writing nothing, and the archive.
//
// THE SEQUENCES (G2, TEST-STRATEGY rule 1) follow the cells: a live deal ends; a queued deal is promoted; a sponsor is archived
// and unarchived under a break that was already assigned; a deal is written off; the plan changes (a downgrade, an upgrade, a
// pass); a frozen break whose sponsor is unticked after a downgrade; an `end_current` swap; the empty case; a second poll. "Another sport" is not applicable (sponsors read no sport key);
// its substitute here is another PLAN, and every cell runs on all three.
//
// Real Postgres; skipped without DATABASE_URL (a skipped suite is a FAILURE to read: the run must show 0 pending).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const stripe = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), expire: vi.fn(), refund: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: stripe.create, retrieve: stripe.retrieve, expire: stripe.expire } },
    refunds: { create: stripe.refund },
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: "re_matrix" })) }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
// The overlay loader's fold cache, passed through (seam.test.ts's own mock): nothing is cached across polls.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import type Stripe from "stripe";
import { cricket } from "@seazn/engine/sports/cricket";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { GoLiveRule, PaymentMethod } from "@/lib/sponsor-deals";
import { SPONSOR_TIERS, SPONSOR_TIER_WEIGHTS, type SponsorTier } from "@/lib/sponsor-tiers";
import type { BreakOpened, SponsorPlan } from "@/lib/sponsor-plan";
import type { AuthCtx } from "@/server/api-v1/auth";
import { loadOverlayLiveData } from "@/server/overlay/load";
import { runEvent } from "@/server/usecases/billing-events";
import { createCompetition } from "@/server/usecases/competitions";
import {
  archiveSponsor, createSponsor, createSponsorPackage, patchSponsor, resolveSponsors, unarchiveSponsor,
} from "@/server/usecases/sponsors";
import { createDeal, endDealNow, markDealPaid, sweepSponsorDeals, writeOffDeal } from "@/server/usecases/sponsor-deals";
import { stubOutboxEnv } from "@/server/usecases/__tests__/_invite-mail";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { loadSponsorPlan } from "../assign";
import {
  AXES, BASELINE, NO_PAYMENT, PAYMENTS, PLANS, SCOPES, STATES, STREAMS, cellId, generateCells, pairsOf,
  type Cell, type Payment, type Plan,
} from "./stream-matrix-cells";
import { cycleLength, expectedFor, type Expected, type PlanGrants } from "./stream-matrix-oracle";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const RUN = uniq();
const ORIGIN = "https://matrix.test";
const PRICE_CENTS = 25_000;
const DAY_MS = 86_400_000;
/** The widest seq: a poll's fold saw every seq a test names (a fresh door), as assign.test.ts's own helper says. */
const ALL_SEQS = 2 ** 31 - 1;
const made = { eventIds: [] as string[] };

beforeEach(() => {
  stubOutboxEnv();
  stripe.create.mockReset().mockImplementation(async () => ({
    id: `cs_${uniq()}`, url: `https://checkout.stripe.test/${uniq()}`, expires_at: Math.floor(Date.now() / 1000) + 86_400,
  }));
  stripe.retrieve.mockReset().mockImplementation(async (id: string) => ({ id, status: "open" }));
  stripe.expire.mockReset().mockImplementation(async (id: string) => ({ id, status: "expired" }));
  stripe.refund.mockReset().mockImplementation(async () => ({ id: `re_${uniq()}` }));
});

afterAll(async () => {
  if (!HAS_DB) return;
  if (made.eventIds.length > 0) await sql`delete from billing_events where id = any(${made.eventIds}::text[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The declarations the oracle reads: `plan_entitlements`, the migrations' own data.
// ---------------------------------------------------------------------------------------------------------------------------------
let grants!: PlanGrants;
async function loadGrants(): Promise<PlanGrants> {
  const rows = await sql<{ plan_key: string; feature_key: string; bool_value: boolean | null }[]>`
    select plan_key, feature_key, bool_value from plan_entitlements
     where plan_key in ('community', 'pro', 'event_pass') and feature_key in ('sponsors.tiers', 'sponsors.monetize')`;
  // Anti-vacuity: 3 plans x 2 features. A missing row would read as "false" and make every gate look refused.
  expect(rows.length, "premise: plan_entitlements holds the six sponsor rows the oracle reads").toBe(6);
  const at = (plan: string, feature: string): boolean => {
    const r = rows.find((x) => x.plan_key === plan && x.feature_key === feature);
    expect(r, `premise: ${plan} x ${feature} row exists`).toBeDefined();
    return r!.bool_value === true;
  };
  const per = (feature: string) => ({ community: at("community", feature), pro: at("pro", feature), event_pass: at("event_pass", feature) });
  return { tiers: per("sponsors.tiers"), monetize: per("sponsors.monetize") };
}
if (HAS_DB) beforeAll(async () => { grants = await loadGrants(); });

// ---------------------------------------------------------------------------------------------------------------------------------
// The rig: an org that starts on Pro (so a competition, a started division, packages of every tier and a Connect account can be
// made), with its competition C (a fixture on it is THE stream), another competition C', and the plan flipped to the cell's.
// ---------------------------------------------------------------------------------------------------------------------------------
interface Rig {
  orgId: string;
  auth: AuthCtx;
  /** THE competition: the stream's fixture is in it. */
  competitionId: string;
  /** Another competition of the same org. */
  otherCompetitionId: string;
  fixtureId: string;
  /** The control: a partner, whole org, ticked on the stream, on every cell. */
  refId: string;
}

async function buildRig(): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const s = uniq();
  // A Connect account that can take charges: online selling needs one (409 connect_required otherwise); the PLAN gate is what a cell tests.
  await sql`update organizations set stripe_account_id = ${`acct_${s}`}, stripe_charges_enabled = true where id = ${auth.orgId}`;
  const { divisionId, fixtureId } = await startedDivisionWithFixture(auth);
  const [d] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${divisionId}`;
  const other = await createCompetition(auth, { ends_on: "2030-12-31", name: `Other Cup ${s}`, visibility: "public", branding: {} });
  return { orgId: auth.orgId, auth, competitionId: d!.competition_id, otherCompetitionId: other.id, fixtureId, refId: "" };
}

/** Flip the org to the cell's plan. `pass`: a community org holding an Event Pass on one competition (THE one, unless `passOn`). */
async function setPlan(rig: Rig, plan: Plan, passOn: "this" | "other" = "this"): Promise<void> {
  await sql`delete from competition_passes where org_id = ${rig.orgId}`;
  if (plan === "pro") await setOrgPlan(rig.orgId, "pro");
  else {
    await setOrgPlan(rig.orgId, "community");
    if (plan === "pass") {
      const on = passOn === "this" ? rig.competitionId : rig.otherCompetitionId;
      await sql`insert into competition_passes (competition_id, org_id) values (${on}, ${rig.orgId})`;
    }
  }
  await invalidateOrgEntitlements(rig.orgId);
}

/** The control sponsor, made by the real usecases on whatever plan the org is on now (a partner on the whole org is free). */
async function addControl(rig: Rig): Promise<void> {
  const ref = await createSponsor(rig.auth, { name: `Control ${uniq()}`, tier: "partner", status: "active" });
  await patchSponsor(rig.auth, ref.id, { on_stream: true });
  rig.refId = ref.id;
}

/** A package of `tier`, any competition. A package is a placement (the gate), so it is made while the org is still on Pro. */
async function makePackage(rig: Rig, tier: SponsorTier, onStream: boolean): Promise<string> {
  const p = await createSponsorPackage(rig.auth, {
    name: `Pkg ${tier} ${uniq()}`, price_cents: PRICE_CENTS, currency: "gbp", tier, competition_id: null, includes_on_stream: onStream,
  });
  return p.id;
}

const scopeIdOf = (rig: Rig, scope: Cell["scope"]): string | null =>
  scope === "org" ? null : scope === "this" ? rig.competitionId : rig.otherCompetitionId;

type Attempt<T> = { ok: true; value: T } | { ok: false; err: HttpError };
async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, err: e };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Deals, made by the real usecases. How each payment value is reached (spec §5.2's table): the recipe, not an expectation.
// ---------------------------------------------------------------------------------------------------------------------------------
type Shape = "live" | "waiting";
interface Path { method: PaymentMethod; rule: GoLiveRule; then: "webhook" | "mark" | null }
const PATHS: Record<Shape, Record<Payment, Path>> = {
  live: {
    online_paid: { method: "online", rule: "on_payment", then: "webhook" },
    offline_paid: { method: "offline", rule: "on_payment", then: "mark" },
    complimentary: { method: "complimentary", rule: "immediate", then: null },
    awaiting: { method: "offline", rule: "immediate", then: null },
  },
  waiting: {
    online_paid: { method: "online", rule: "on_approval", then: "webhook" },
    offline_paid: { method: "offline", rule: "on_approval", then: "mark" },
    complimentary: { method: "complimentary", rule: "on_approval", then: null },
    awaiting: { method: "offline", rule: "on_payment", then: null },
  },
};

let evSeq = 0;
/** payment_intent.succeeded as the signed webhook hands it to the dispatcher, with the metadata the deal's checkout stamps. */
function paymentSucceeded(rig: Rig, dealId: string): Stripe.Event {
  const id = `evt_matrix_${RUN}_${++evSeq}`;
  made.eventIds.push(id);
  return {
    id, object: "event", type: "payment_intent.succeeded", created: Math.floor(Date.now() / 1000), livemode: false,
    data: {
      object: {
        id: `pi_matrix_${RUN}_${uniq()}`, object: "payment_intent", amount: PRICE_CENTS, amount_received: PRICE_CENTS, currency: "gbp",
        status: "succeeded", metadata: { kind: "sponsor", order_id: dealId, org_id: rig.orgId },
      },
    },
  } as unknown as Stripe.Event;
}

interface OpenOpts {
  shape: Shape;
  payment: Payment;
  /** Override the recipe's method/rule (the sequences' own deals). */
  recipe?: Pick<Path, "method" | "rule"> & { then?: Path["then"] };
  scopeId: string | null;
  /** Give the deal an end date (tomorrow), so the sweep can run it out. */
  endsSoon?: boolean;
  endCurrent?: boolean;
}

/** Add a deal to `sponsorId` with `packageId` along the recipe, paying it when the recipe says. Answers the deal's id. */
async function openDeal(rig: Rig, sponsorId: string, packageId: string, o: OpenOpts): Promise<string> {
  const base = PATHS[o.shape][o.payment];
  const path = o.recipe ? { ...o.recipe, then: o.recipe.then ?? null } : base;
  // Tomorrow (UTC; the rig's org has no timezone), not today: a midnight roll between this clock and the database's can never read as a day that has passed. The sweep below runs three days on, past either.
  const endsOn = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
  const { deal } = await createDeal(
    rig.auth,
    sponsorId,
    {
      package_id: packageId,
      competition_id: o.scopeId,
      payment_method: path.method,
      go_live: path.rule,
      sponsor_email: path.method === "online" ? `pay-${uniq()}@test.local` : null,
      ends_on: o.endsSoon ? endsOn : null,
      end_current: o.endCurrent ?? false,
    },
    ORIGIN,
  );
  if (path.then === "webhook") expect(await runEvent(paymentSucceeded(rig, deal.id)), "premise: the dispatcher ran the payment").toBe(true);
  if (path.then === "mark") await markDealPaid(rig.auth, deal.id);
  return deal.id;
}

/** A complimentary deal that goes live at once: valid on every plan when partner + whole org, the sequences' workhorse. */
const liveDeal = (rig: Rig, sponsorId: string, packageId: string, scopeId: string | null = null, endCurrent = false) =>
  openDeal(rig, sponsorId, packageId, {
    shape: "live", payment: "complimentary", scopeId, endCurrent, recipe: { method: "complimentary", rule: "immediate" },
  });

async function handSponsor(rig: Rig, tier: SponsorTier = "partner", o: { competitionId?: string | null; tick?: boolean } = {}): Promise<string> {
  const s = await createSponsor(rig.auth, { name: `Hand ${tier} ${uniq()}`, tier, competition_id: o.competitionId ?? null, status: "active" });
  if (o.tick !== false) await patchSponsor(rig.auth, s.id, { on_stream: true });
  return s.id;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The stream, read the way the product reads it.
// ---------------------------------------------------------------------------------------------------------------------------------
/** The size cricket DECLARES for a break kind (engine's own naturalBreaks): the rotation polls hand the planner majors, so no
 *  cooldown or dial rule thins them (those are assign.test.ts's). */
const MAJOR_KIND = (() => {
  const k = cricket.naturalBreaks?.kinds.find((d) => d.size === "major");
  if (k === undefined) throw new Error("cricket declares no major break kind");
  return k.kind;
})();

interface Spin {
  plan: SponsorPlan;
  /** Airings per sponsor over EVERY break the plan carries. */
  all: Map<string, number>;
  /** Airings per sponsor over the breaks of THIS spin only (seq >= from): what a rotation window of `cycles` full cycles hands out. */
  fresh: Map<string, number>;
  /** How many breaks this spin offered. */
  offered: number;
}

/** One writing poll of the plan (`loadSponsorPlan`, the loader the overlay calls) over majors seq 1..from-1+n, all fresh. Breaks
 *  below `from` are the ones an earlier spin already froze; the `fresh` count is over the new ones. */
async function spin(rig: Rig, from: number, n: number): Promise<Spin> {
  const now = Date.now();
  const breaks: BreakOpened[] = Array.from({ length: from - 1 + n }, (_, i) => ({
    seq: i + 1, kind: MAJOR_KIND, size: "major", at: new Date(now - 2_000 + i).toISOString(),
  }));
  const plan = await loadSponsorPlan(
    { fixtureId: rig.fixtureId, orgId: rig.orgId, competitionId: rig.competitionId, breaks, windowSeqs: breaks.map((b) => b.seq), complete: true, foldedThrough: ALL_SEQS },
    { now },
  );
  const all = new Map<string, number>();
  const fresh = new Map<string, number>();
  const sponsorOfCard = new Map((plan?.cards ?? []).map((c) => [c.id, c.sponsorId]));
  for (const a of plan?.airings ?? []) {
    const sponsorId = sponsorOfCard.get(a.cardId);
    if (sponsorId === undefined) throw new Error(`airing ${a.momentId} names card ${a.cardId}, which the plan does not carry`);
    all.set(sponsorId, (all.get(sponsorId) ?? 0) + 1);
    if (a.seq >= from) fresh.set(sponsorId, (fresh.get(sponsorId) ?? 0) + 1);
  }
  return { plan, all, fresh, offered: n };
}

interface Strip { onPage: boolean; tier: SponsorTier | null }
/** The competition's public sponsor strip, as its page reads it: the page's own two lines (`hasFeature` on the competition, then `resolveSponsors`). */
async function publicStrip(rig: Rig, sponsorId: string | null): Promise<Strip> {
  const tiered = await hasFeature(rig.orgId, "sponsors.tiers", rig.competitionId);
  const strip = await resolveSponsors(rig.orgId, rig.competitionId, { tiered });
  const row = strip.find((s) => s.id === sponsorId);
  return { onPage: row !== undefined, tier: row?.tier ?? null };
}

/** The overlay payload's sponsor cards at a door. The fixture has no events: the carousel's ticked cards are the whole plan. */
async function overlayCards(rig: Rig, door: "relay" | "public") {
  const live = await loadOverlayLiveData(rig.fixtureId, door === "relay" ? { relay: true } : {});
  return live.sponsorPlan?.cards ?? [];
}

const dealRow = async (dealId: string) =>
  (await sql<{ deal_status: string; status: string; ended_reason: string | null; written_off_at: Date | null }[]>`
    select deal_status, status, ended_reason, written_off_at from sponsor_orders where id = ${dealId}`)[0]!;
const sponsorRow = async (id: string) =>
  (await sql<{ status: string; tier: string; competition_id: string | null; on_stream: boolean; archived_at: Date | null }[]>`
    select status, tier, competition_id, on_stream, archived_at from sponsors where id = ${id}`)[0]!;
const dealCount = async (orgId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsor_orders where org_id = ${orgId}`)[0]!.n;
const assignmentCount = async (fixtureId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsor_assignments where fixture_id = ${fixtureId}`)[0]!.n;

/** The tiers a poll's cycle holds, for the window length: the control (partner) plus each airing sponsor's aired tier. */
const windowFor = (tiers: readonly SponsorTier[], cycles = 2): number => cycles * cycleLength(tiers);

// ---------------------------------------------------------------------------------------------------------------------------------
// The generated cells.
// ---------------------------------------------------------------------------------------------------------------------------------
const GEN = generateCells();
/** What each cell observed, keyed by its id: the closing test judges the whole run from it. */
const observed = new Map<string, { expected: Expected; cell: Cell }>();

describe("L1 cell generator - pairwise plus single-axis edges (pure; no database)", () => {
  /** Recomputed here, not read from the generator: every pair of values of two axes, the 'n/a' payment excluded. */
  const declared = AXES.map(([name, values]) => ({ name, values: [...values] as string[] }));
  const requiredPairs = (): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < declared.length; i++)
      for (let j = i + 1; j < declared.length; j++)
        for (const a of declared[i]!.values)
          for (const b of declared[j]!.values) out.add(`${declared[i]!.name}=${a}|${declared[j]!.name}=${b}`);
    // The ONE unreachable pair family, by definition: a cell with no deal (state none) has no payment. Dropped by name, not by count.
    for (const pay of PAYMENTS) out.delete(`state=none|payment=${pay}`);
    return out;
  };

  it("every declared pair of axis values is held by a generated cell (count reported), and none is vacuous", () => {
    const required = requiredPairs();
    // Every pair of two axes' values from the axes' own sizes (3,4,7,4,3,2 -> 213), less the four 'state=none' x payment pairs.
    const sizes = declared.map((a) => a.values.length);
    let expectedPairs = -PAYMENTS.length;
    for (let i = 0; i < sizes.length; i++) for (let j = i + 1; j < sizes.length; j++) expectedPairs += sizes[i]! * sizes[j]!;
    expect(required.size, "the reachable pair space").toBe(expectedPairs);
    expect(expectedPairs, "213 declared pairs less the 4 unreachable").toBe(209);
    expect(GEN.pairsRequired, "the generator's own count agrees with the axes'").toBe(expectedPairs);
    const held = new Set(GEN.cells.flatMap(pairsOf));
    const missing = [...required].filter((p) => !held.has(p));
    expect(missing, `pairs no generated cell holds (of ${required.size})`).toEqual([]);
    // The floor a pairwise suite cannot go under: the two biggest axes' product (state 7 x payment-or-tier 4).
    expect(GEN.cells.length, "generated cells").toBeGreaterThanOrEqual(28);
    console.log(`[stream-matrix] generated ${GEN.cells.length} cells (${GEN.pairwiseCells} pairwise + ${GEN.edgeCellsAdded} single-axis edges + ${GEN.familyCellsAdded} interaction-family cells) covering ${required.size} value pairs`);
  });

  it("every value of every axis appears, and each is also met alone: a cell that differs from the baseline in that axis only", () => {
    const ids = new Set(GEN.cells.map(cellId));
    expect(ids.size, "cells are distinct").toBe(GEN.cells.length);
    let edges = 0;
    for (const [name, values] of AXES) {
      for (const v of values) {
        expect(GEN.cells.some((c) => c[name] === v), `${name}=${v} appears`).toBe(true);
        if (BASELINE[name] === v) continue;
        const one = { ...BASELINE, [name]: v } as Cell;
        if (one.state === "none") one.payment = NO_PAYMENT;
        expect(ids.has(cellId(one)), `single-axis edge ${name}=${v} from the baseline`).toBe(true);
        edges++;
      }
    }
    expect(ids.has(cellId(BASELINE)), "the baseline itself").toBe(true);
    // 2 + 3 + 6 + 3 + 2 + 1 non-baseline values.
    expect(edges, "single-axis edges checked").toBe(PLANS.length - 1 + (SPONSOR_TIERS.length - 1) + (STATES.length - 1) + (PAYMENTS.length - 1) + (SCOPES.length - 1) + (STREAMS.length - 1));
  });

  it("the interaction families are all present: every state x payment on the accepting baseline, and every plan x tier x scope for offline and online (count reported)", () => {
    const ids = new Set(GEN.cells.map(cellId));
    let checked = 0;
    for (const state of STATES)
      for (const payment of PAYMENTS) {
        const c = { ...BASELINE, state, payment } as Cell;
        if (state === "none") c.payment = NO_PAYMENT;
        expect(ids.has(cellId(c)), `state x payment: ${state} x ${payment}`).toBe(true);
        checked++;
      }
    for (const plan of PLANS)
      for (const tier of SPONSOR_TIERS)
        for (const scope of SCOPES)
          for (const payment of ["offline_paid", "online_paid"] as const) {
            expect(ids.has(cellId({ ...BASELINE, plan, tier, scope, payment })), `plan x tier x scope: ${plan} ${tier} ${scope} ${payment}`).toBe(true);
            checked++;
          }
    expect(checked, "family cells checked: 7 x 4 + 3 x 4 x 3 x 2").toBe(STATES.length * PAYMENTS.length + PLANS.length * SPONSOR_TIERS.length * SCOPES.length * 2);
  });

  it("a cell with no deal has no payment: 'none' never pairs with a payment value", () => {
    const none = GEN.cells.filter((c) => c.state === "none");
    expect(none.length, "cells in the 'none' state").toBeGreaterThan(0);
    for (const c of none) expect(c.payment).toBe(NO_PAYMENT);
    for (const c of GEN.cells.filter((x) => x.state !== "none")) expect((PAYMENTS as readonly string[]).includes(c.payment)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("L1 cells - every generated combination, driven through the real seam", () => {
  it.each(GEN.cells.map((c) => [cellId(c), c] as const))("%s", async (_id, cell) => {
    const exp = expectedFor(cell, grants);
    const rig = await buildRig();
    const scopeId = scopeIdOf(rig, cell.scope);
    const pkg = cell.state === "none" ? null : await makePackage(rig, cell.tier, cell.stream === "on");
    const basePkg = cell.state === "scheduled" ? await makePackage(rig, "partner", true) : null;
    await setPlan(rig, cell.plan);
    await addControl(rig);

    // ---- the script ----------------------------------------------------------------------------------------------------------
    // `as`: both are assigned inside the attempt's closure, which control-flow narrowing cannot see.
    let sponsorId = null as string | null;
    let dealId = null as string | null;
    let created: Attempt<unknown>;
    let writeOff: Attempt<unknown> | null = null;
    if (cell.state === "none") {
      created = await attempt(async () => {
        const s = await createSponsor(rig.auth, { name: `Hand ${uniq()}`, tier: cell.tier, competition_id: scopeId, status: "active" });
        sponsorId = s.id;
        if (cell.stream === "on") await patchSponsor(rig.auth, s.id, { on_stream: true });
      });
    } else {
      sponsorId = (await createSponsor(rig.auth, { name: `Cell ${uniq()}`, tier: "partner", status: "active" })).id;
      if (cell.state === "scheduled") {
        // The sponsor's live deal: partner, the whole org, on the stream. Valid on every plan, so it is never what is refused.
        const baseline = await liveDeal(rig, sponsorId, basePkg!);
        expect((await dealRow(baseline)).deal_status, "premise: the baseline deal is live (spec §8a: the one the queue waits behind)").toBe("live");
      }
      const shape = cell.state === "waiting" ? "waiting" : "live";
      created = await attempt(async () => {
        dealId = await openDeal(rig, sponsorId!, pkg!, {
          shape, payment: cell.payment as Payment, scopeId, endsSoon: cell.state === "written_off",
        });
      });
      if (created.ok && dealId !== null) {
        if (cell.state === "ended" || cell.state === "archived") await endDealNow(rig.auth, dealId);
        if (cell.state === "written_off") {
          // The term runs out unpaid (the sweep, as the hourly job does), then the club tries to waive what is owed.
          const swept = await sweepSponsorDeals(new Date(Date.now() + 3 * DAY_MS), { orgIds: [rig.orgId] });
          expect(swept, "premise: the sweep examined and expired exactly the one deal").toMatchObject({ checked: 1, expired: 1, failed: 0 });
          writeOff = await attempt(() => writeOffDeal(rig.auth, dealId!));
        }
      }
      if (cell.state === "archived") await archiveSponsor(rig.auth, sponsorId!);
    }

    // ---- the refusal, and what it leaves behind ------------------------------------------------------------------------------
    if (exp.refusal === null) {
      if (!created.ok) throw created.err;
    } else {
      expect(created.ok, `the plan must refuse: ${exp.refusal.featureKey}`).toBe(false);
      if (!created.ok) expect(created.err).toMatchObject({ status: exp.refusal.status, featureKey: exp.refusal.featureKey });
      // A refusal writes nothing: no deal of the cell's own exists (the scheduled cell keeps its baseline's one).
      expect(await dealCount(rig.orgId), "a refused deal wrote no row").toBe(cell.state === "scheduled" ? 1 : 0);
    }

    // ---- the premises: the script reached the cell it names -----------------------------------------------------------------
    if (exp.deal !== null) {
      expect(dealId, "the deal was made").not.toBeNull();
      const row = await dealRow(dealId!);
      expect(row.deal_status, "deal status (spec D2, §8a)").toBe(exp.deal.status);
      expect(row.status, "deal money (spec D2)").toBe(exp.deal.paymentStatus);
    } else if (cell.state !== "none") {
      expect(dealId, "no deal of the cell's own exists").toBeNull();
    }
    if (exp.writeOff !== null) {
      expect(writeOff, "the write-off was attempted").not.toBeNull();
      if (exp.writeOff.accepted) {
        expect(writeOff!.ok, "the club may waive an unpaid offline invoice that ran out").toBe(true);
        const row = await dealRow(dealId!);
        expect(row).toMatchObject({ ended_reason: "written_off" });
        expect(row.written_off_at, "the waiver is stamped").not.toBeNull();
      } else {
        expect(writeOff!.ok).toBe(false);
        if (!writeOff!.ok) expect(writeOff!.err).toMatchObject(exp.writeOff.refusal!);
        expect((await dealRow(dealId!)).ended_reason, "a refused waiver changed nothing").toBe("expired");
      }
    }
    if (sponsorId !== null) {
      const row = await sponsorRow(sponsorId);
      expect(row.archived_at !== null, "archived").toBe(exp.archived);
      // Spec §5.3: a LIVE deal's tier, scope and stream flag are on the sponsor's row, and it is active.
      if (cell.state === "live" && exp.refusal === null) {
        expect(row).toMatchObject({ status: "active", tier: cell.tier, competition_id: scopeId, on_stream: cell.stream === "on" });
      }
      if (cell.state === "none" && exp.refusal === null) {
        expect(row).toMatchObject({ status: "active", tier: cell.tier, competition_id: scopeId, on_stream: cell.stream === "on" });
      }
    }

    // ---- the observation: airs, aired tier, weight, public page ------------------------------------------------------------
    const idOfCell = sponsorId ?? "no-such-sponsor";
    const relay = await overlayCards(rig, "relay");
    const publicDoor = await overlayCards(rig, "public");
    const control = relay.find((c) => c.sponsorId === rig.refId);
    expect(control, "premise: the control sponsor is on the stream, so a missing card is the cell's and not 'rotation off'").toMatchObject({
      tier: "partner", onStream: true,
    });
    const card = relay.find((c) => c.sponsorId === idOfCell && c.onStream);
    expect(card !== undefined, "airs: a ticked card in the overlay payload").toBe(exp.airs);
    expect(card?.tier ?? null, "aired tier (after the no-sponsors.tiers flattening)").toBe(exp.airedTier);
    // OBS (the public door) and the composed page (the relay door) air the same cards.
    expect(publicDoor.map((c) => `${c.sponsorId}:${c.tier}:${c.onStream}`).sort(), "both doors serve the same cards").toEqual(
      relay.map((c) => `${c.sponsorId}:${c.tier}:${c.onStream}`).sort(),
    );

    // The rotation: two full cycles of the tiers the oracle says are on the stream.
    const cycle = windowFor(["partner", ...(exp.airedTier === null ? [] : [exp.airedTier])]);
    const sp = await spin(rig, 1, cycle);
    expect(sp.plan?.airings.length, "every break was handed a card").toBe(cycle);
    // The sequence's second call: the same polled again answers the same and writes no second assignment.
    const again = await spin(rig, 1, cycle);
    expect([...again.all.entries()].sort(), "a second poll answers the same").toEqual([...sp.all.entries()].sort());
    expect(await assignmentCount(rig.fixtureId), "a second poll wrote nothing").toBe(cycle);
    expect(sp.fresh.get(idOfCell) ?? 0, `weight: 2 cycles x SPONSOR_TIER_WEIGHTS[${exp.airedTier}]`).toBe(exp.weight === null ? 0 : 2 * exp.weight);
    expect(sp.fresh.get(rig.refId) ?? 0, "the control's weight: 2 cycles x the partner weight").toBe(2 * SPONSOR_TIER_WEIGHTS.partner);

    const strip = await publicStrip(rig, sponsorId);
    expect(strip.onPage, "on the competition's public sponsor strip").toBe(exp.onPublicPage);
    expect(strip.tier, "the tier the strip shows").toBe(exp.publicTier);

    observed.set(cellId(cell), { expected: exp, cell });
  });

  // Judges the whole run from what the cells above recorded: vitest runs a file's tests in order, so this is meaningful only on a
  // whole-file run (a `-t` filter leaves cells unrun and this red, by design: a partial run must not read as "checked everything").
  it("every generated cell was checked, and the run was not vacuous (counts reported)", () => {
    const checked = observed.size;
    expect(checked, "cells checked == cells generated").toBe(GEN.cells.length);
    expect(checked).toBeGreaterThan(GEN.pairwiseCells - 1);
    const all = [...observed.values()];
    const refused = all.filter((o) => o.expected.refusal !== null).length;
    const airing = all.filter((o) => o.expected.airs).length;
    const silent = all.filter((o) => !o.expected.airs).length;
    const onPage = all.filter((o) => o.expected.onPublicPage).length;
    const writtenOff = all.filter((o) => o.expected.writeOff?.accepted === true).length;
    const writeOffRefused = all.filter((o) => o.expected.writeOff?.accepted === false).length;
    // Every arm the oracle distinguishes is met at least once, or the cell list proves less than it claims.
    for (const [label, n] of Object.entries({ refused, airing, silent, onPage, writtenOff, writeOffRefused })) {
      expect(n, `${label} cells`).toBeGreaterThan(0);
    }
    for (const plan of PLANS) expect(all.some((o) => o.cell.plan === plan && o.expected.airs), `an airing cell on ${plan}`).toBe(true);
    for (const plan of PLANS) expect(all.some((o) => o.cell.plan === plan && o.expected.refusal !== null), `a refused cell on ${plan}`).toBe(plan !== "pro");
    for (const tier of SPONSOR_TIERS) expect(all.some((o) => o.expected.airedTier === tier), `a cell aired as ${tier}`).toBe(true);
    console.log(`[stream-matrix] checked ${checked}/${GEN.cells.length} cells: ${refused} refused, ${airing} airing, ${silent} not airing, ${onPage} on the public strip, ${writtenOff} written off, ${writeOffRefused} write-offs refused`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// G2 - the transitions a club causes MID-STREAM, through the same seam. One org each, polled before and after each step.
// ---------------------------------------------------------------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("L1 sequences (G2) - a deal ends, a queued deal is promoted, archive, write-off, a plan change", () => {
  it("a live deal ends: the sponsor leaves the plan, and a break it was already handed airs nothing (it is never handed to the control)", async () => {
    const rig = await buildRig();
    const gold = await makePackage(rig, "gold", true);
    await addControl(rig);
    const x = (await createSponsor(rig.auth, { name: `X ${uniq()}`, tier: "partner", status: "active" })).id;
    const dealId = await liveDeal(rig, x, gold);
    expect((await sponsorRow(x)).tier, "premise: the live gold deal wrote its tier on the row").toBe("gold");

    const n1 = windowFor(["gold", "partner"]);
    const before = await spin(rig, 1, n1);
    expect(before.fresh.get(x), "gold weight over 2 cycles").toBe(2 * SPONSOR_TIER_WEIGHTS.gold);
    expect(before.fresh.get(rig.refId)).toBe(2 * SPONSOR_TIER_WEIGHTS.partner);
    expect(await assignmentCount(rig.fixtureId), "one frozen assignment per break").toBe(n1);

    await endDealNow(rig.auth, dealId);
    const afterEnd = await spin(rig, n1 + 1, windowFor(["partner"]));
    expect(afterEnd.plan?.cards.some((c) => c.sponsorId === x), "the ended sponsor is no card").toBe(false);
    expect(afterEnd.all.get(x) ?? 0, "its frozen breaks air nothing now").toBe(0);
    expect(afterEnd.all.get(rig.refId), "the control's own frozen breaks stay").toBe(before.fresh.get(rig.refId)! + 2 * SPONSOR_TIER_WEIGHTS.partner);
    // The frozen breaks were NOT re-handed to the control: assignments only grew by the new window.
    expect(await assignmentCount(rig.fixtureId), "no assignment was moved or deleted").toBe(n1 + windowFor(["partner"]));
    expect((await publicStrip(rig, x)).onPage, "gone from the public strip").toBe(false);
    expect((await sponsorRow(x)).tier, "the deal's reset: partner again").toBe("partner");
    // A second poll of the same breaks answers the same (the sequence's second call).
    const again = await spin(rig, n1 + 1, windowFor(["partner"]));
    expect([...again.all.entries()].sort()).toEqual([...afterEnd.all.entries()].sort());
    expect(await assignmentCount(rig.fixtureId), "a second poll wrote nothing").toBe(n1 + windowFor(["partner"]));
  });

  it("a deal queued behind a live one is promoted when it ends: the sponsor enters the plan with the QUEUED deal's own tier", async () => {
    const rig = await buildRig();
    const partnerPkg = await makePackage(rig, "partner", true);
    const goldPkg = await makePackage(rig, "gold", true);
    await addControl(rig);
    const s = (await createSponsor(rig.auth, { name: `S ${uniq()}`, tier: "partner", status: "active" })).id;
    const a = await liveDeal(rig, s, partnerPkg);
    const b = await liveDeal(rig, s, goldPkg, rig.competitionId);
    expect([(await dealRow(a)).deal_status, (await dealRow(b)).deal_status], "premise: A is live, B queued (spec §8a)").toEqual(["live", "scheduled"]);

    // While A is live the stream shows A's placement: partner, whole org. Nothing of B has arrived.
    const w1 = windowFor(["partner", "partner"]);
    const queued = await spin(rig, 1, w1);
    expect((await overlayCards(rig, "relay")).find((c) => c.sponsorId === s)?.tier, "queued: A's tier").toBe("partner");
    expect(queued.fresh.get(s), "queued: partner weight").toBe(2 * SPONSOR_TIER_WEIGHTS.partner);
    expect(await sponsorRow(s)).toMatchObject({ tier: "partner", competition_id: null });

    await endDealNow(rig.auth, a);
    expect((await dealRow(b)).deal_status, "A ended: B was promoted").toBe("live");
    expect(await sponsorRow(s)).toMatchObject({ status: "active", tier: "gold", competition_id: rig.competitionId, on_stream: true });
    const w2 = windowFor(["gold", "partner"]);
    const promoted = await spin(rig, w1 + 1, w2);
    expect((await overlayCards(rig, "relay")).find((c) => c.sponsorId === s)?.tier, "promoted: B's tier").toBe("gold");
    expect(promoted.fresh.get(s), "promoted: gold weight over 2 cycles").toBe(2 * SPONSOR_TIER_WEIGHTS.gold);
    expect((await publicStrip(rig, s)).tier, "the public strip shows B's tier too").toBe("gold");

    await endDealNow(rig.auth, b);
    expect((await overlayCards(rig, "relay")).some((c) => c.sponsorId === s), "B ended: the sponsor leaves").toBe(false);
  });

  it("archive takes a sponsor off a stream that is already live, and unarchive puts its frozen break back; an archived sponsor takes no edit and no deal", async () => {
    const rig = await buildRig();
    const goldPkg = await makePackage(rig, "gold", true);
    await addControl(rig);
    const x = await handSponsor(rig, "gold");
    const n1 = windowFor(["gold", "partner"]);
    const live = await spin(rig, 1, n1);
    expect(live.fresh.get(x), "live: gold weight").toBe(2 * SPONSOR_TIER_WEIGHTS.gold);
    const xBefore = live.all.get(x)!;

    const archived = await archiveSponsor(rig.auth, x);
    expect(archived.archived_at, "archived").not.toBeNull();
    const gone = await spin(rig, n1 + 1, windowFor(["partner"]));
    expect(gone.plan?.cards.some((c) => c.sponsorId === x), "archived: no card").toBe(false);
    expect(gone.all.get(x) ?? 0, "archived: its already-frozen breaks air nothing").toBe(0);
    expect((await publicStrip(rig, x)).onPage, "archived: not on the public strip").toBe(false);
    // Second call: idempotent, the FIRST archived_at kept; and the archived sponsor takes no edit and no deal (409 sponsor_archived).
    expect((await archiveSponsor(rig.auth, x)).archived_at).toEqual(archived.archived_at);
    expect(await attempt(() => patchSponsor(rig.auth, x, { name: `Renamed ${uniq()}` }))).toMatchObject({ ok: false, err: { status: 409, code: "sponsor_archived" } });
    expect(
      await attempt(() => openDeal(rig, x, goldPkg, { shape: "live", payment: "complimentary", scopeId: null, recipe: { method: "complimentary", rule: "immediate" } })),
    ).toMatchObject({ ok: false, err: { status: 409, code: "sponsor_archived" } });

    await unarchiveSponsor(rig.auth, x);
    const back = await spin(rig, n1 + windowFor(["partner"]) + 1, windowFor(["gold", "partner"]));
    expect(back.plan?.cards.find((c) => c.sponsorId === x), "unarchived: its card is back, as it was (gold, ticked)").toMatchObject({ tier: "gold", onStream: true });
    expect(back.all.get(x), "unarchived: the frozen breaks air again, and the new window adds a full gold share").toBe(xBefore + 2 * SPONSOR_TIER_WEIGHTS.gold);
    expect((await publicStrip(rig, x)).onPage, "unarchived: back on the public strip").toBe(true);
  });

  it("a sponsor a live deal holds cannot be archived and keeps airing; once the deal ends it can, and unarchiving it brings back an INACTIVE sponsor (not on the stream)", async () => {
    const rig = await buildRig();
    const pkg = await makePackage(rig, "silver", true);
    await addControl(rig);
    const x = (await createSponsor(rig.auth, { name: `X ${uniq()}`, tier: "partner", status: "active" })).id;
    const dealId = await liveDeal(rig, x, pkg);
    expect(await attempt(() => archiveSponsor(rig.auth, x)), "a live deal holds the sponsor").toMatchObject({ ok: false, err: { status: 409, code: "sponsor_has_current_deal" } });
    expect((await sponsorRow(x)).archived_at, "the refusal wrote nothing").toBeNull();
    expect((await overlayCards(rig, "relay")).find((c) => c.sponsorId === x)?.tier, "still airing").toBe("silver");

    await endDealNow(rig.auth, dealId);
    await archiveSponsor(rig.auth, x);
    await unarchiveSponsor(rig.auth, x);
    expect(await sponsorRow(x), "unarchive writes archived_at only: the sponsor is as the ended deal left it").toMatchObject({ status: "inactive", archived_at: null });
    expect((await overlayCards(rig, "relay")).some((c) => c.sponsorId === x), "unarchived, but its deal ended: not on the stream").toBe(false);
    expect((await publicStrip(rig, x)).onPage).toBe(false);
  });

  it("write-off: an unpaid offline deal that ran out holds the sponsor until it is waived; the waiver changes nothing on the stream; a live unpaid deal cannot be waived", async () => {
    const rig = await buildRig();
    const pkg = await makePackage(rig, "partner", true);
    await addControl(rig);
    const x = (await createSponsor(rig.auth, { name: `X ${uniq()}`, tier: "partner", status: "active" })).id;
    const dealId = await openDeal(rig, x, pkg, { shape: "live", payment: "awaiting", scopeId: null, endsSoon: true });
    expect(await dealRow(dealId)).toMatchObject({ deal_status: "live", status: "pending" });
    expect((await overlayCards(rig, "relay")).some((c) => c.sponsorId === x), "live and unpaid: airs (the deal's status decides, not its money)").toBe(true);
    expect(await attempt(() => writeOffDeal(rig.auth, dealId)), "nothing is due on a live deal").toMatchObject({ ok: false, err: { status: 409, code: "deal_nothing_due" } });
    expect((await overlayCards(rig, "relay")).some((c) => c.sponsorId === x), "the refused waiver changed nothing").toBe(true);

    const swept = await sweepSponsorDeals(new Date(Date.now() + 3 * DAY_MS), { orgIds: [rig.orgId] });
    expect(swept).toMatchObject({ checked: 1, expired: 1, failed: 0 });
    expect(await dealRow(dealId)).toMatchObject({ deal_status: "ended", ended_reason: "expired", status: "pending" });
    expect((await overlayCards(rig, "relay")).some((c) => c.sponsorId === x), "expired: off the stream").toBe(false);
    expect(await attempt(() => archiveSponsor(rig.auth, x)), "owed money still holds the sponsor (archive spec D9)").toMatchObject({ ok: false, err: { status: 409, code: "sponsor_has_current_deal" } });

    await writeOffDeal(rig.auth, dealId);
    expect(await dealRow(dealId)).toMatchObject({ deal_status: "ended", ended_reason: "written_off", status: "pending" });
    expect((await overlayCards(rig, "relay")).some((c) => c.sponsorId === x), "written off: still off the stream").toBe(false);
    expect((await publicStrip(rig, x)).onPage, "written off: still off the public strip").toBe(false);
    expect(await attempt(() => writeOffDeal(rig.auth, dealId)), "second call: nothing is due any more").toMatchObject({ ok: false, err: { status: 409, code: "deal_nothing_due" } });
    await archiveSponsor(rig.auth, x);
    expect((await sponsorRow(x)).archived_at, "settled: the sponsor can be archived").not.toBeNull();
  });

  it("the plan changes under a live stream: four sponsors, one per tier - Pro, then a downgrade, an upgrade, a pass, and the pass gone", async () => {
    const rig = await buildRig();
    const pkgs = new Map<SponsorTier, string>();
    for (const t of SPONSOR_TIERS) pkgs.set(t, await makePackage(rig, t, true));
    const sponsors = new Map<SponsorTier, string>();
    for (const t of SPONSOR_TIERS) {
      const s = (await createSponsor(rig.auth, { name: `${t} ${uniq()}`, tier: "partner", status: "active" })).id;
      await liveDeal(rig, s, pkgs.get(t)!);
      sponsors.set(t, s);
    }
    let from = 1;
    let checks = 0;
    /** Spin 2 cycles under whatever plan the org is on, and check every sponsor's card tier and weight against `tiersOn`. */
    const phase = async (label: string, tiersOn: boolean) => {
      const aired = (t: SponsorTier): SponsorTier => (tiersOn ? t : "partner");
      const n = windowFor(SPONSOR_TIERS.map(aired));
      const r = await spin(rig, from, n);
      from += n;
      expect(r.plan?.airings.filter((a) => a.seq >= from - n).length, `${label}: every break got a card`).toBe(n);
      const cards = await overlayCards(rig, "relay");
      const strip = await resolveSponsors(rig.orgId, rig.competitionId, { tiered: await hasFeature(rig.orgId, "sponsors.tiers", rig.competitionId) });
      for (const t of SPONSOR_TIERS) {
        const id = sponsors.get(t)!;
        expect(cards.find((c) => c.sponsorId === id)?.tier, `${label}: ${t} sponsor's card tier`).toBe(aired(t));
        expect(r.fresh.get(id), `${label}: ${t} sponsor's weight (2 cycles)`).toBe(2 * SPONSOR_TIER_WEIGHTS[aired(t)]);
        expect(strip.find((s) => s.id === id)?.tier, `${label}: ${t} sponsor on the public strip`).toBe(aired(t));
        // The ROW is never rewritten by a plan change: the flattening is a read, so an upgrade gets the tier back.
        expect((await sponsorRow(id)).tier, `${label}: ${t} sponsor's row`).toBe(t);
        checks++;
      }
    };
    await phase("pro", true);
    await setPlan(rig, "free");
    await phase("downgraded to free", false);
    await setPlan(rig, "pro");
    await phase("upgraded back to pro", true);
    await setPlan(rig, "pass");
    await phase("free + a pass on THIS competition", true);
    await setPlan(rig, "pass", "other");
    await phase("free + a pass on ANOTHER competition", false);
    expect(checks, "sponsor x phase checks").toBe(SPONSOR_TIERS.length * 5);
  });

  it("a break already handed to a sponsor that is then unticked on a downgraded plan still airs, and its card shows the FLATTENED tier (ruling R13), not the leftover row's", async () => {
    // The assigned-card path is its own reader of the tier (`activeSponsorCards`, card-source.ts): the ticked path flattens inside
    // `resolveSponsors`, so a cell never reaches this one - only a frozen break whose sponsor is no longer ticked does.
    const rig = await buildRig();
    await addControl(rig);
    const x = await handSponsor(rig, "title");
    const n1 = windowFor(["title", "partner"]);
    const before = await spin(rig, 1, n1);
    expect(before.plan?.cards.find((c) => c.sponsorId === x), "premise: on Pro the title card is a title").toMatchObject({ tier: "title", onStream: true });
    expect(before.fresh.get(x), "premise: title weight over 2 cycles").toBe(2 * SPONSOR_TIER_WEIGHTS.title);

    await setPlan(rig, "free");
    await patchSponsor(rig.auth, x, { on_stream: false }); // no tier, no scope: ungated on every plan
    expect(await sponsorRow(x), "the row keeps its tier through the downgrade").toMatchObject({ tier: "title", on_stream: false, status: "active" });
    const after = await spin(rig, n1 + 1, windowFor(["partner"]));
    expect(after.all.get(x), "its frozen breaks still air after the untick (spec §3.2)").toBe(before.fresh.get(x));
    expect(after.plan?.cards.find((c) => c.sponsorId === x), "the card is unticked, and flattened to partner").toMatchObject({ tier: "partner", onStream: false });
    expect(after.fresh.get(x) ?? 0, "no NEW break goes to an unticked sponsor").toBe(0);
  });

  it("an Event Pass on ANOTHER competition: this stream's tiers stay flat, a deal for this competition is refused, a deal for the pass's own competition is made but is not on this stream", async () => {
    const rig = await buildRig();
    const goldPkg = await makePackage(rig, "gold", true);
    await addControl(rig);
    await setPlan(rig, "pass", "other");
    const partnerSponsor = (await createSponsor(rig.auth, { name: `P ${uniq()}`, tier: "partner", status: "active" })).id;
    const goldHere = await attempt(() => openDeal(rig, partnerSponsor, goldPkg, { shape: "live", payment: "complimentary", scopeId: rig.competitionId, recipe: { method: "complimentary", rule: "immediate" } }));
    expect(goldHere, "a gold deal for THIS competition needs a pass on it").toMatchObject({ ok: false, err: { status: 402, featureKey: "sponsors.tiers" } });
    const goldElsewhere = await attempt(() => openDeal(rig, partnerSponsor, goldPkg, { shape: "live", payment: "complimentary", scopeId: rig.otherCompetitionId, recipe: { method: "complimentary", rule: "immediate" } }));
    expect(goldElsewhere.ok, "a gold deal for the pass's own competition is accepted").toBe(true);
    expect((await overlayCards(rig, "relay")).some((c) => c.sponsorId === partnerSponsor), "scoped to the other competition: not on this stream").toBe(false);
    expect((await publicStrip(rig, partnerSponsor)).onPage, "nor on this competition's strip").toBe(false);
  });

  it("an end_current swap: the new deal ends the live one in one transaction, and the stream shows the NEW tier with no gap", async () => {
    const rig = await buildRig();
    const gold = await makePackage(rig, "gold", true);
    const silver = await makePackage(rig, "silver", true);
    await addControl(rig);
    const x = (await createSponsor(rig.auth, { name: `X ${uniq()}`, tier: "partner", status: "active" })).id;
    const first = await liveDeal(rig, x, gold);
    expect((await overlayCards(rig, "relay")).find((c) => c.sponsorId === x)?.tier).toBe("gold");
    const second = await liveDeal(rig, x, silver, null, true);
    expect([(await dealRow(first)).deal_status, (await dealRow(second)).deal_status], "A ended, B live (never two live)").toEqual(["ended", "live"]);
    expect((await overlayCards(rig, "relay")).find((c) => c.sponsorId === x)?.tier, "the stream shows B's tier").toBe("silver");
    const r = await spin(rig, 1, windowFor(["silver", "partner"]));
    expect(r.fresh.get(x), "silver weight over 2 cycles").toBe(2 * SPONSOR_TIER_WEIGHTS.silver);
  });

  it("the empty cases: no sponsor at all, and a sponsor that is not on the stream, serve NO plan (rotation off) - the public strip is unaffected", async () => {
    const rig = await buildRig();
    expect(await overlayCards(rig, "relay"), "no sponsors: no cards").toEqual([]);
    expect((await spin(rig, 1, 2)).plan, "no sponsors: no plan").toBeNull();
    // A deal that does NOT include the stream: live and public, never ticked, and it does not turn the rotation on (R12).
    const off = await makePackage(rig, "partner", false);
    const x = (await createSponsor(rig.auth, { name: `X ${uniq()}`, tier: "partner", status: "active" })).id;
    await liveDeal(rig, x, off);
    expect(await sponsorRow(x)).toMatchObject({ status: "active", on_stream: false });
    expect(await overlayCards(rig, "relay"), "an off-stream sponsor is no card").toEqual([]);
    expect((await publicStrip(rig, x)).onPage, "but it is on the public strip").toBe(true);
    expect(await assignmentCount(rig.fixtureId), "nothing was assigned").toBe(0);
  });
});
