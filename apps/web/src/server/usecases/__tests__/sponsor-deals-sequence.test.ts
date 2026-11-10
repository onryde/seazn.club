// Sponsor deals, Task 11 (plan 2026-11-07-sponsor-deals; TEST-STRATEGY rule 10): the model-based sequence test. fast-check
// generates ordered sequences of deal actions, drives each one through the REAL usecases (createDeal, sendDealInvoice,
// markDealPaid, approveDeal, endDealNow, refundDeal, patchSponsor, deleteSponsor, sweepSponsorDeals) and the REAL billing
// dispatcher (`runEvent`: payment, refund and dispute webhooks) over real Postgres, and checks after EVERY step:
//   - the eight invariants of the Task 11 brief (I1–I8, below), on the database as it stands;
//   - that the code agrees with a model that holds its OWN state, built from the spec and the plan's decisions — never from
//     the code under test — deal by deal and sponsor by sponsor (M1–M6, below).
// The net under everything Tasks 1–10 built: a usecase that disagrees with lib/sponsor-deals.ts, the spec §5.2 table or D8 is
// a failing sequence, shrunk to its shortest form.
//
// Where each expected value comes from:
//   - deal transitions: the spec §5.2 table (Online / Offline / Complimentary × When paid / Straight away / After I approve;
//     Refund / End now / ends_at → Ended; a dispute hides the sponsor until resolved), D2 (an online deal is a draft until its
//     invoice is sent; `scheduled` = the rule is met but the sponsor has a live deal) and §8a (one live deal per sponsor; the
//     queue goes live when the current deal ends by ANY exit), typed below as SPEC_* (never `initialStatus` / `statusAfter*`);
//   - which console action a deal OFFERS: lib/sponsor-deals.ts `allowedActions` (controller ruling F12: the T2 domain is the
//     declaration; the usecases are the code under test). A refused action is an HttpError: 409 not offered, 422
//     `on_payment_needs_payment`; a DealRuleError reaching this test is a failure;
//   - what a deal does to its sponsor: D8, typed as `modelApply` (empty case first; the all-ended reset ONLY on the transition,
//     F7), and D9 (what a deal locks), typed as `patchRefusals`;
//   - the plan gates: spec §10 Q1 (a tier other than partner, or a scope, needs `sponsors.tiers`), spec §8 (online selling needs
//     `sponsors.monetize`), and the plan matrix (Pro both org-wide; community neither; an Event Pass both on ITS competition
//     only), typed as `needsTiers` / `planGrants`;
//   - the Stripe session rule (D14, F3, F37): an open session is expired before any end, re-mint or delete; a completed one is
//     money in flight (Mark as paid and Send refuse 409 `deal_paid_online`; End now carries on; delete refuses);
//   - a deal's snapshot (F36): the model records the package's tier and On-stream flag at the moment of `createDeal`, from the
//     packages this test declared (PACKAGES), so I8 compares the deal against a value the code under test did not produce.
//
// Invariants after every step (the brief's I1–I8, F7 and F36 folded in):
//   I1 at most one live deal per sponsor;
//   I2 a sponsor with a live or open deal is `active` ⇔ it has a live, unparked deal. A sponsor whose deals have ALL ended (or
//      that has none) is under manual control (spec §10 Q3): a step that keeps it there leaves its row byte-equal unless the step
//      was an accepted patchSponsor on it; the step that moves it INTO all-ended writes the D8 reset (inactive, partner, whole
//      org, off the stream);
//   I3 a sponsor with a live deal carries that deal's snapshot: tier, competition_id, on_stream;
//   I4 the org's sponsor row count never changes, except by an accepted deleteSponsor (anti-goal 1: no payment inserts one);
//   I5 no live deal is go_live='on_approval' with approved_at null;
//   I6 no live deal is go_live='on_payment' with its money still unpaid;
//   I7 a deal whose money is refunded has ended;
//   I8 every deal's snapshot tier and includes_on_stream equal what the model recorded from its package at creation.
// Model checks after every step:
//   M1 the accept / refuse verdict, the refusal's HTTP status (and code where the plan names one), and a refused step leaves the
//      sponsor tables (`sponsors`, `sponsor_orders`, `sponsor_packages`, `sponsor_stream_settings`) byte-equal (the billing
//      ledger is outside: runEvent writes it, F36);
//   M2 every deal's lifecycle, money, end reason, park, dispute flag, approval, intent, stored session, scope, method, rule and
//      end date; M3 every sponsor's status, tier, scope and on_stream; M4 the org's stream-settings row;
//   M5 Stripe: every session's status is the model's; no deal holds two open sessions; no ended or deleted deal holds an open
//      one (two payable sessions never coexist, D14);
//   M6 the owner alerts a payment raises (deal_ended, duplicate_payment), and the sweep's counts.
//
// Commands: createDeal (every method × rule, sponsor 0/1, the three packages, whole org or C, an end date or none, end_current
// on or off), sendDealInvoice, markDealPaid, approveDeal, endDealNow, refundDeal, patchSponsor (status on/off, tier, on_stream:
// F7's switch-back-on), the sponsor completing Checkout at Stripe (the webhook still on its way), payment_intent.succeeded
// (first delivery, a redelivery, and a second intent: F3), charge.refunded, charge.dispute.created / closed won / closed lost,
// sweepSponsorDeals(now + k days), deleteSponsor, and a downgrade to community. "Another sport" is not applicable (sponsors
// read no sport key); its substitute is another plan: every world is Pro, community, or community with an Event Pass on C (the
// packages and sponsors are made on Pro first: the state a downgrade leaves), and C is either never finished (no divisions)
// or finished (its derived phase).
//
// Anti-vacuity: the property reports its runs, the steps it checked (≥ 100, else a failure), and a count per command kind
// (executed, accepted, refused, skipped); a kind executed zero times is a failure. The named scenarios below drive the cases
// the brief names (late payment on an ended deal, a duplicate intent, end_current, the queue, the sweep, delete, every plan)
// through the same runner, and each asserts the counters it exists to reach. They are not optional: the random sequences reach
// a promotion in about 1 run in 80, and two chains almost never — F7's (the last deal ends → the hand switch-back-on → a late
// event on that sponsor) and F19's (a queued deal past its own end when the live one ends). 2000 random runs broke neither
// chain's mutant; the scenarios kill both. The seed is pinned (CI reproducibility); `SPONSOR_DEALS_MODEL_RUNS` / `SPONSOR_DEALS_MODEL_SEED=random` run a larger local sample.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

// Stripe, as a small stateful world: a Checkout session is open until the code expires it or the sponsor completes it here.
// Idempotency keys behave as Stripe's do (the same key answers the same session), so a re-mint under an old key is visible.
const W = vi.hoisted(() => ({
  sessions: new Map<string, { deal: string; org: string; status: "open" | "complete" | "expired" }>(),
  byKey: new Map<string, string>(),
  tails: [] as (() => Promise<unknown>)[],
  alerts: [] as { reason: string; dealId: string }[],
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: async (params: { metadata?: { order_id?: string; org_id?: string } }, opts?: { idempotencyKey?: string }) => {
          const key = opts?.idempotencyKey;
          const known = key ? W.byKey.get(key) : undefined;
          const id = known ?? `cs_model_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          if (!known) {
            W.sessions.set(id, { deal: params.metadata?.order_id ?? "?", org: params.metadata?.org_id ?? "?", status: "open" });
            if (key) W.byKey.set(key, id);
          }
          return { id, url: `https://checkout.stripe.test/${id}`, expires_at: Math.floor(Date.now() / 1000) + 86_400 };
        },
        retrieve: async (id: string) => {
          const s = W.sessions.get(id);
          if (!s) throw new Error(`stripe stub: no such session ${id}`);
          return { id, status: s.status };
        },
        expire: async (id: string) => {
          const s = W.sessions.get(id);
          if (!s || s.status !== "open") throw new Error(`stripe stub: session ${id} is not open (${s?.status ?? "missing"})`);
          s.status = "expired";
          return { id, status: "expired" };
        },
      },
    },
    refunds: { create: async () => ({ id: `re_model_${crypto.randomUUID()}` }) },
  }),
}));
vi.mock("@/server/email-outbox/transport", () => ({ deliver: vi.fn(async () => ({ ok: true, providerId: `re_model_${crypto.randomUUID()}` })) }));
// The owner alert for a payment the club may owe back (sponsors.ts `alertDealPayment`) rides on Sentry until Task 23.
vi.mock("@/lib/sentry", () => ({
  captureError: (_err: unknown, ctx?: { route?: string; extra?: { reason?: string; dealId?: string } }) => {
    if (ctx?.route === "billing.sponsor_payment") W.alerts.push({ reason: ctx.extra?.reason ?? "?", dealId: ctx.extra?.dealId ?? "?" });
  },
}));
// `deferred` is Next's `after()`: here a queue each step drains before it is checked, so tail work never races the next step.
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    W.tails.push(task);
  },
}));
vi.mock("@/server/public-site/revalidate", async (orig) => ({
  ...(await orig<typeof import("@/server/public-site/revalidate")>()),
  fireOrgRevalidate: () => {},
}));

import type Stripe from "stripe";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import {
  allowedActions,
  DealRuleError,
  GO_LIVE_RULES,
  PAYMENT_METHODS,
  type DealAction,
  type DealStatus,
  type EndReason,
  type GoLiveRule,
  type PaymentMethod,
  type PaymentStatus,
  type SponsorDeal,
} from "@/lib/sponsor-deals";
import type { SponsorTier } from "@/lib/sponsor-tiers";
import type { AuthCtx } from "@/server/api-v1/auth";
import { stubOutboxEnv } from "./_invite-mail";
import { runEvent } from "../billing-events";
import { createSponsor, createSponsorPackage, deleteSponsor, patchSponsor, type PatchSponsorInput } from "../sponsors";
import {
  approveDeal,
  createDeal,
  endDealNow,
  markDealPaid,
  refundDeal,
  sendDealInvoice,
  sweepSponsorDeals,
  type SweepResult,
} from "../sponsor-deals";
import { competitionPhase, getCompetitionDesk } from "../competition-desk";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = randomUUID().slice(0, 8);
const uniq = () => randomUUID().slice(0, 8);
const made = { orgIds: [] as string[], userIds: [] as string[], eventIds: [] as string[] };
const ORIGIN = "https://model.test";
const DAY = 86_400_000;
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

/** The property's size: the brief's 30 runs, pinned seed. `SPONSOR_DEALS_MODEL_RUNS=200 SPONSOR_DEALS_MODEL_SEED=random` is the
 *  larger local sample. */
const RUNS = Number(process.env.SPONSOR_DEALS_MODEL_RUNS ?? 30);
const SEED = process.env.SPONSOR_DEALS_MODEL_SEED === "random" ? Date.now() % 2_147_483_647 : Number(process.env.SPONSOR_DEALS_MODEL_SEED ?? 20_261_109);

beforeEach(() => {
  stubOutboxEnv();
});

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from billing_events where id = any(${made.eventIds}::text[])`;
  if (made.orgIds.length > 0) {
    await sql`delete from email_outbox where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from sponsor_orders where org_id = any(${made.orgIds}::uuid[])`;
    await sql`delete from organizations where id = any(${made.orgIds}::uuid[])`;
  }
  if (made.userIds.length > 0) {
    await sql`delete from subscriptions where owner_user_id = any(${made.userIds}::uuid[])`;
    await sql`delete from users where id = any(${made.userIds}::uuid[])`;
  }
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// =================================================================================================================================
// The declarations the model is built from (never the code under test)
// =================================================================================================================================

type Plan = "pro" | "community" | "event_pass";

/** The three packages of every world (the brief): one includes On stream, one is scoped to competition C. Distinct tiers, so a
 *  deal that carried the wrong package's snapshot cannot match by accident. */
const PACKAGES: readonly { tier: SponsorTier; scopedToC: boolean; onStream: boolean }[] = [
  { tier: "partner", scopedToC: false, onStream: false },
  { tier: "gold", scopedToC: false, onStream: true },
  { tier: "silver", scopedToC: true, onStream: false },
];

/** Spec §5.2: "Complimentary: No payment states. 'When paid' is not offered." Online and offline offer all three rules. */
const SPEC_RULES: Readonly<Record<PaymentMethod, readonly GoLiveRule[]>> = {
  online: ["on_payment", "immediate", "on_approval"],
  offline: ["on_payment", "immediate", "on_approval"],
  complimentary: ["immediate", "on_approval"],
};

/** Spec §10 Q1 (owner, 2026-11-07) and the plan's premise 2: a tier other than partner, or a competition scope, needs
 *  `sponsors.tiers`. */
const needsTiers = (tier: SponsorTier, scoped: boolean): boolean => tier !== "partner" || scoped;

/** The plan matrix for `sponsors.tiers` and `sponsors.monetize` alike (spec §8; pass-scope-sponsors-write.test.ts): Pro has both
 *  org-wide, community neither, and an Event Pass both on ITS competition only. */
const planGrants = (plan: Plan, scoped: boolean): boolean => plan === "pro" || (plan === "event_pass" && scoped);

/** Where a new deal starts (spec §5.2, D2, §8a). Straight away: live at once, or queued behind the sponsor's live deal. Online:
 *  a draft until its invoice is sent. Offline: awaiting payment. Complimentary (after approval only): awaiting approval. */
function specInitial(m: PaymentMethod, r: GoLiveRule, otherLive: boolean): DealStatus {
  if (r === "immediate") return otherLive ? "scheduled" : "live";
  if (m === "online") return "draft";
  if (m === "offline") return "awaiting_payment";
  return "awaiting_approval";
}

/** The payment landed (spec §5.2: "Awaiting payment → Paid → Live", or "→ Awaiting approval"). A deal already live, queued or
 *  ended does not move; any other state cannot take a payment (null: the rule refuses it). */
function specAfterPaid(d: { status: DealStatus; rule: GoLiveRule }, otherLive: boolean): DealStatus | null {
  if (d.status === "awaiting_payment") {
    if (d.rule === "on_payment") return otherLive ? "scheduled" : "live";
    if (d.rule === "on_approval") return "awaiting_approval";
    return null;
  }
  if (d.status === "live" || d.status === "scheduled" || d.status === "ended") return d.status;
  return null;
}

/** D2: sending the invoice moves a draft to awaiting payment; anything else it is sent on stays where it is. */
const specAfterSend = (s: DealStatus): DealStatus => (s === "draft" ? "awaiting_payment" : s);

// =================================================================================================================================
// Commands
// =================================================================================================================================

type PatchKind = "on" | "off" | "gold" | "partner" | "streamOn" | "streamOff";
const PATCHES: Readonly<Record<PatchKind, PatchSponsorInput>> = {
  on: { status: "active" },
  off: { status: "inactive" },
  gold: { tier: "gold" },
  partner: { tier: "partner" },
  streamOn: { on_stream: true },
  streamOff: { on_stream: false },
};

type Cmd =
  | { k: "create"; s: number; p: number; scoped: boolean; m: PaymentMethod; r: GoLiveRule; ends: number | null; endCurrent: boolean }
  | { k: "send"; d: number }
  | { k: "markPaid"; d: number }
  | { k: "approve"; d: number }
  | { k: "endNow"; d: number }
  | { k: "refund"; d: number }
  | { k: "patch"; s: number; f: PatchKind }
  | { k: "checkout"; d: number }
  | { k: "paid"; d: number; again: boolean }
  | { k: "refunded"; d: number }
  | { k: "dispute"; d: number; phase: "created" | "won" | "lost" }
  | { k: "sweep"; days: number }
  | { k: "age"; days: number }
  | { k: "delete"; s: number }
  | { k: "downgrade" };
type Kind = Cmd["k"];
const KINDS: readonly Kind[] = [
  "create", "send", "markPaid", "approve", "endNow", "refund", "patch", "checkout", "paid", "refunded", "dispute", "sweep",
  "age", "delete", "downgrade",
];

const ix = fc.nat({ max: 23 });
const createArb: fc.Arbitrary<Cmd> = fc.record({
  k: fc.constant("create" as const),
  s: fc.constantFrom(0, 1),
  p: fc.constantFrom(0, 1, 2),
  scoped: fc.boolean(),
  // Online twice over: its deals carry the Stripe paths (Checkout, payment, refund and dispute events).
  m: fc.constantFrom<PaymentMethod>(...PAYMENT_METHODS, "online"),
  r: fc.constantFrom(...GO_LIVE_RULES),
  ends: fc.constantFrom<number | null>(null, null, 1, 3, 8),
  endCurrent: fc.boolean(),
});
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 6, arbitrary: createArb },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("send" as const), d: ix }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("markPaid" as const), d: ix }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("approve" as const), d: ix }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("endNow" as const), d: ix }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("refund" as const), d: ix }) },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("patch" as const),
      s: fc.constantFrom(0, 1),
      f: fc.constantFrom<PatchKind>("on", "off", "gold", "partner", "streamOn", "streamOff"),
    }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("checkout" as const), d: ix }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("paid" as const), d: ix, again: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("refunded" as const), d: ix }) },
  {
    weight: 3,
    arbitrary: fc.record({ k: fc.constant("dispute" as const), d: ix, phase: fc.constantFrom<"created" | "won" | "lost">("created", "won", "lost") }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("sweep" as const), days: fc.constantFrom(0, 2, 4, 9) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("age" as const), days: fc.constantFrom(2, 4, 9) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("delete" as const), s: fc.constantFrom(0, 1) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("downgrade" as const) }) },
);

/** 1–14 commands (the brief): 1–4 deals made first, so the actions after them have deals to act on (a command with no target
 *  is skipped and checks nothing), then 0–10 of any kind, creates included. */
const seqArb: fc.Arbitrary<Cmd[]> = fc
  .tuple(fc.array(createArb, { minLength: 1, maxLength: 4 }), fc.array(cmdArb, { minLength: 0, maxLength: 10 }))
  .map(([made, rest]) => [...made, ...rest]);

interface WorldSpec {
  plan: Plan;
  /** C's derived phase: finished (every division decided), or never (no divisions: `setting_up` forever). */
  finished: boolean;
}
const worldArb: fc.Arbitrary<WorldSpec> = fc.record({
  plan: fc.oneof(
    { weight: 3, arbitrary: fc.constant<Plan>("pro") },
    { weight: 2, arbitrary: fc.constant<Plan>("event_pass") },
    { weight: 1, arbitrary: fc.constant<Plan>("community") },
  ),
  finished: fc.boolean(),
});

// =================================================================================================================================
// The model
// =================================================================================================================================

type SessionStatus = "open" | "complete" | "expired";
interface SponsorFields {
  status: "active" | "pending" | "inactive";
  tier: SponsorTier;
  competition_id: string | null;
  on_stream: boolean;
}
interface MSponsor {
  id: string;
  alive: boolean;
  row: SponsorFields;
}
interface MDeal {
  /** "" until the step that made it has read the id the code gave it. */
  id: string;
  seq: number;
  sponsor: number;
  method: PaymentMethod;
  rule: GoLiveRule;
  competition_id: string | null;
  status: DealStatus;
  payment: PaymentStatus;
  endedReason: EndReason | null;
  approved: boolean;
  parked: boolean;
  disputed: boolean;
  /** payment_intent_id on the row. */
  intent: string | null;
  /** checkout_session_id on the row. */
  session: string | null;
  endsAt: number | null;
  email: string | null;
  /** F36: the package's tier and On-stream flag at the moment of createDeal, recorded by the model. */
  snapshot: { tier: SponsorTier; on_stream: boolean };
  /** The one dispute a charge can carry (Stripe). */
  dispute: { id: string; state: "open" | "won" | "lost" } | null;
  /** The sponsor completed Checkout at Stripe; the payment webhook is still on its way. */
  pendingIntent: string | null;
  duplicate: boolean;
}
interface Model {
  plan: Plan;
  finished: boolean;
  orgId: string;
  compId: string;
  sponsors: MSponsor[];
  /** The org's deals (a deleted sponsor's are gone with it), in creation order. */
  deals: MDeal[];
  /** The model's view of this world's Checkout sessions. */
  sessions: Map<string, SessionStatus>;
  seq: number;
  deletes: number;
  /** The org-wide sponsor_stream_settings row exists (R12: the first on-stream tick or deal turns the rotation on). */
  streamRow: boolean;
  /** Owner alerts this step should raise. */
  alerts: { reason: string; dealId: string }[];
}

const isOpenStatus = (s: DealStatus): boolean => s !== "live" && s !== "ended";
const dealsOf = (m: Model, sp: number): MDeal[] => m.deals.filter((d) => d.sponsor === sp).sort((a, b) => a.seq - b.seq);
const otherLive = (m: Model, d: MDeal): boolean => m.deals.some((x) => x.sponsor === d.sponsor && x !== d && x.status === "live");
const unpaid = (d: MDeal): boolean => d.payment === "pending" || d.payment === "failed";

/** What lib/sponsor-deals.ts `allowedActions` (the T2 declaration, F12) offers on the MODEL's deal. */
function offered(d: MDeal): DealAction[] {
  return allowedActions({
    deal_status: d.status,
    payment_method: d.method,
    payment_status: d.payment,
    disputed_at: d.disputed ? "2026-01-01T00:00:00.000Z" : null,
    ended_reason: d.endedReason,
  } as SponsorDeal);
}

/** Coverage counters the scenarios assert (and the property reports). */
const cover = {
  latePayment: 0,
  duplicatePayment: 0,
  redelivery: 0,
  endCurrentSwap: 0,
  promotion: 0,
  transitionReset: 0,
  switchBackOn: 0,
  manualHeldOnLateEvent: 0,
  parkedLive: 0,
  sweepExpired: 0,
  sweepFinished: 0,
  sweepPromoted: 0,
  deferredFinishedPromotion: 0,
  refused402: 0,
  refused404: 0,
  refused409: 0,
  refused422: 0,
  paidOnlineRefusal: 0,
  sessionCarriedOver: 0,
};
type Cover = keyof typeof cover;

/**
 * D8, typed (the order matters): no deal → nothing; no live deal → the earliest scheduled deal whose own end has not passed goes
 * live (§8a queue; F19); a live deal → the sponsor takes its snapshot, `active` or `pending` while parked; else an open deal →
 * `inactive` and nothing else; else every deal has ended → the reset, written ONLY when `ended` names the deal this step moved
 * into ended (F7). Answers the deal it promoted.
 */
function modelApply(m: Model, sp: number, now: number, ended: MDeal | null, viaSweep = false): MDeal | null {
  const deals = dealsOf(m, sp);
  if (deals.length === 0) return null;
  let live = deals.find((d) => d.status === "live") ?? null;
  let promoted: MDeal | null = null;
  if (live === null) {
    const next = deals.find((d) => d.status === "scheduled" && !(d.endsAt !== null && d.endsAt <= now));
    if (next) {
      next.status = "live";
      live = next;
      promoted = next;
      cover.promotion++;
      // The parked item (controller): a deal scoped to a FINISHED competition, promoted by a step that is not the sweep, is
      // live until the next sweep ends it. Counted, never refused.
      if (!viaSweep && m.finished && next.competition_id !== null && next.endsAt === null) cover.deferredFinishedPromotion++;
    }
  }
  const row = m.sponsors[sp]!.row;
  if (live !== null) {
    row.status = live.parked ? "pending" : "active";
    if (live.parked) cover.parkedLive++;
    row.tier = live.snapshot.tier;
    row.competition_id = live.competition_id;
    row.on_stream = live.snapshot.on_stream;
    if (live.snapshot.on_stream) m.streamRow = true;
    return promoted;
  }
  if (deals.some((d) => isOpenStatus(d.status))) {
    row.status = "inactive";
    return null;
  }
  if (ended !== null) {
    Object.assign(row, { status: "inactive", tier: "partner", competition_id: null, on_stream: false } satisfies SponsorFields);
    cover.transitionReset++;
  }
  return null;
}

/** The session rule (D14, F3, F37) on the model: an open session is expired and forgotten; a completed one is money in flight
 *  (the caller refuses, or carries on with it still stored); none is none. */
function modelRetire(m: Model, d: MDeal): "none" | "retired" | "complete" {
  if (d.session === null) return "none";
  const st = m.sessions.get(d.session);
  if (st === "complete") return "complete";
  if (st === "open") m.sessions.set(d.session, "expired");
  d.session = null;
  return "retired";
}

const sessionComplete = (m: Model, d: MDeal): boolean => d.session !== null && m.sessions.get(d.session) === "complete";

function end(d: MDeal, reason: EndReason): void {
  d.status = "ended";
  d.endedReason = reason;
}

/** charge.refunded, the console refund's Stripe path and the offline refund alike (spec §5.2 Refund → Ended (refunded)). */
function modelRefundFlip(m: Model, d: MDeal, now: number): void {
  const wasOpen = d.status !== "ended";
  d.payment = "refunded";
  end(d, "refunded");
  modelApply(m, d.sponsor, now, wasOpen ? d : null);
}

// =================================================================================================================================
// The world: one org, competition C, three packages, two sponsors — made through the real usecases
// =================================================================================================================================

interface World {
  orgId: string;
  compId: string;
  auth: AuthCtx;
  packageIds: string[];
  sponsorIds: string[];
}

/** A competition whose derived phase is `finished` — the sweep test's rig (a real league whose fixtures are stored decided),
 *  its phase ASKED OF THE DESK so a rig that stopped producing it fails here. */
async function finishedCompetition(auth: AuthCtx): Promise<string> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: `Model Cup ${uniq()}`, visibility: "private", branding: {} });
  const division = await createDivision(auth, comp.id, { name: "Open", slug: "open", sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 4 }, (_, i) => ({ kind: "individual" as const, display_name: `E${i + 1}`, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {}, progression: null });
  await generateStageFixtures(auth, stage!.id);
  await sql`update divisions set status = 'active' where id = ${division.id}`;
  await sql`update fixtures set status = 'decided' where division_id = ${division.id}`;
  await sql`update stages set status = 'complete' where id = ${stage!.id}`;
  const kind = competitionPhase(await getCompetitionDesk(auth, comp.id)).kind;
  if (kind !== "finished") throw new Error(`rig premise: C should be finished, the desk says ${kind}`);
  return comp.id;
}

async function buildWorld(spec: WorldSpec): Promise<{ w: World; m: Model }> {
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified) values (${`model-${uniq()}@test.local`}, 'Deal Editor', true) returning id`;
  made.userIds.push(userId);
  const s = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, created_by, stripe_account_id, stripe_charges_enabled)
    values (${`Model ${s}`}, ${`model-${s}`}, ${userId}, ${`acct_${s}`}, true) returning id`;
  made.orgIds.push(orgId);
  await setOrgPlan(orgId, "pro");
  await invalidateOrgEntitlements(orgId);
  const auth: AuthCtx = { orgId, via: "session", userId, role: "owner", keyId: null };
  const compId = spec.finished
    ? await finishedCompetition(auth)
    : (
        await sql<{ id: string }[]>`
          insert into competitions (org_id, name, slug) values (${orgId}, 'Model Cup', ${`model-cup-${s}`}) returning id`
      )[0]!.id;
  const packageIds: string[] = [];
  for (const p of PACKAGES) {
    const row = await createSponsorPackage(auth, {
      name: `Pkg ${p.tier} ${uniq()}`,
      price_cents: 25_000,
      currency: "gbp",
      tier: p.tier,
      competition_id: p.scopedToC ? compId : null,
      includes_on_stream: p.onStream,
    });
    // Premise: the package holds what this test declared (the model's snapshot source, F36).
    if (row.tier !== p.tier || row.includes_on_stream !== p.onStream) throw new Error(`rig premise: package ${row.id} is not ${JSON.stringify(p)}`);
    packageIds.push(row.id);
  }
  const sponsorIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const row = await createSponsor(auth, {
      name: `Harbourside Building Supplies and Timber Co ${i}`,
      url: "https://harbourside.example/",
      logo_path: null,
      tier: "partner",
      competition_id: null,
      status: "active",
    });
    sponsorIds.push(row.id);
  }
  // The plan, after the packages and sponsors (the state a downgrade leaves): community, or community with an Event Pass on C.
  if (spec.plan !== "pro") {
    await setOrgPlan(orgId, "community");
    if (spec.plan === "event_pass") {
      await sql`insert into competition_passes (competition_id, org_id) values (${compId}, ${orgId}) on conflict (competition_id) do nothing`;
    }
    await invalidateOrgEntitlements(orgId);
  }
  const m: Model = {
    plan: spec.plan,
    finished: spec.finished,
    orgId,
    compId,
    sponsors: sponsorIds.map((id) => ({ id, alive: true, row: { status: "active", tier: "partner", competition_id: null, on_stream: false } })),
    deals: [],
    sessions: new Map(),
    seq: 0,
    deletes: 0,
    streamRow: false,
    alerts: [],
  };
  return { w: { orgId, compId, auth, packageIds, sponsorIds }, m };
}

// =================================================================================================================================
// The database, read back after every step
// =================================================================================================================================

interface DealDb {
  id: string;
  sponsor_id: string | null;
  deal_status: DealStatus;
  status: PaymentStatus;
  payment_method: PaymentMethod;
  go_live: GoLiveRule;
  tier: SponsorTier;
  includes_on_stream: boolean;
  competition_id: string | null;
  ended_reason: EndReason | null;
  parked: boolean;
  disputed: boolean;
  approved: boolean;
  payment_intent_id: string | null;
  checkout_session_id: string | null;
  ends_at: Date | null;
}
interface SponsorDb extends SponsorFields {
  id: string;
  bytes: string;
}
interface Snap {
  deals: DealDb[];
  sponsors: Map<string, SponsorDb>;
  /** The four sponsor tables of the org, byte for byte. */
  tables: string;
  streamRow: boolean;
}

async function snapshot(orgId: string): Promise<Snap> {
  const deals = await sql<DealDb[]>`
    select id, sponsor_id, deal_status, status, payment_method, go_live, tier, includes_on_stream, competition_id, ended_reason,
           parked_at is not null as parked, disputed_at is not null as disputed, approved_at is not null as approved,
           payment_intent_id, checkout_session_id, ends_at
      from sponsor_orders where org_id = ${orgId} order by created_at, id`;
  const sponsors = await sql<SponsorDb[]>`
    select id, status, tier, competition_id, on_stream, to_jsonb(s)::text as bytes from sponsors s where s.org_id = ${orgId}`;
  const [t] = await sql<{ tables: string; stream: boolean }[]>`
    select concat_ws(' | ',
             (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from sponsors x where x.org_id = ${orgId})::text,
             (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from sponsor_orders x where x.org_id = ${orgId})::text,
             (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from sponsor_packages x where x.org_id = ${orgId})::text,
             (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) from sponsor_stream_settings x where x.org_id = ${orgId})::text
           ) as tables,
           exists(select 1 from sponsor_stream_settings where org_id = ${orgId} and competition_id is null and enabled) as stream`;
  return { deals, sponsors: new Map(sponsors.map((r) => [r.id, r])), tables: t!.tables, streamRow: t!.stream };
}

// =================================================================================================================================
// The runner
// =================================================================================================================================

class ModelBreak extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelBreak";
  }
}

const stats = {
  runs: 0,
  stepsChecked: 0,
  kinds: Object.fromEntries(KINDS.map((k) => [k, { executed: 0, accepted: 0, refused: 0, skipped: 0 }])) as Record<
    Kind,
    { executed: number; accepted: number; refused: number; skipped: number }
  >,
};

type Refusal = { status: number; code?: string };
type Attempt<T> = { ok: true; value: T } | { ok: false; err: unknown };
async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, err };
  }
}
const describeErr = (err: unknown): string =>
  err instanceof HttpError ? `HttpError ${err.status} ${err.code ?? ""} "${err.message}"` : err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/**
 * M1: the verdict. `applicable` is every refusal that applies, in the order the plan declares (createDeal's steps 1–6, F16's
 * 402-before-409 for a patch, F12's not-offered 409 before Stripe). The code must refuse with the first, except a 404 for a
 * target that is gone, which the plan does not order. Answers whether the step was refused.
 */
function verdict(label: string, res: Attempt<unknown>, applicable: readonly Refusal[]): boolean {
  if (applicable.length === 0) {
    if (!res.ok) throw new ModelBreak(`${label}: the model accepts it; the code refused: ${describeErr(res.err)}`);
    return false;
  }
  if (res.ok) throw new ModelBreak(`${label}: the model refuses it (${JSON.stringify(applicable)}); the code accepted it`);
  const err = res.err;
  if (err instanceof DealRuleError) throw new ModelBreak(`${label}: a DealRuleError escaped the usecase boundary (F12): ${err.code}`);
  if (!(err instanceof HttpError)) throw new ModelBreak(`${label}: refused with a non-HTTP error (a 500): ${describeErr(err)}`);
  const first = applicable.find((r) => r.status !== 404);
  const ok =
    (err.status === 404 && applicable.some((r) => r.status === 404)) ||
    (first !== undefined && err.status === first.status && (first.code === undefined || err.code === first.code));
  if (!ok) throw new ModelBreak(`${label}: refused ${describeErr(err)}; the model expected ${JSON.stringify(first ?? applicable[0])}`);
  const key = `refused${err.status}` as Cover;
  if (key in cover) cover[key]++;
  if (err.code === "deal_paid_online") cover.paidOnlineRefusal++;
  return true;
}

/** The session the code minted for a deal during this step (the stub's newest one the model has not seen). */
function adoptMinted(m: Model, d: MDeal, label: string): void {
  const fresh = [...W.sessions.entries()].filter(([id, s]) => s.deal === d.id && !m.sessions.has(id));
  if (fresh.length !== 1) throw new ModelBreak(`${label}: expected exactly one Checkout session minted for deal ${d.id}, found ${fresh.length}`);
  const [id] = fresh[0]!;
  d.session = id;
  m.sessions.set(id, "open");
}

let evSeq = 0;
function ev(type: string, object: Record<string, unknown>): Stripe.Event {
  const id = `evt_model_${RUN}_${++evSeq}`;
  made.eventIds.push(id);
  return { id, object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } } as unknown as Stripe.Event;
}
async function deliver(label: string, event: Stripe.Event): Promise<void> {
  const res = await attempt(() => runEvent(event));
  if (!res.ok) throw new ModelBreak(`${label}: the webhook threw (Stripe would retry forever): ${describeErr(res.err)}`);
  if (res.value !== true) throw new ModelBreak(`${label}: the dispatcher did not claim a fresh event`);
}
const newIntent = () => `pi_model_${RUN}_${uniq()}`;

/** A step's outcome, for the per-step checks. */
interface Step {
  ran: boolean;
  refused: boolean;
  /** The sponsor an accepted patchSponsor wrote (its row may change under manual control). */
  patched: string | null;
  /** The sponsors whose deals this step moved or received an event on. */
  touched: Set<string>;
  sweep?: { want: SweepResult; got: SweepResult };
}

function dealTarget(m: Model, d: number, pool: MDeal[] = m.deals): MDeal | null {
  return pool.length === 0 ? null : pool[d % pool.length]!;
}

async function exec(w: World, m: Model, c: Cmd, label: string): Promise<Step> {
  const step: Step = { ran: true, refused: false, patched: null, touched: new Set() };
  const now = Date.now();
  const skip = (): Step => ({ ...step, ran: false });
  switch (c.k) {
    case "create": {
      const sp = m.sponsors[c.s]!;
      const pkg = PACKAGES[c.p]!;
      const scope = c.scoped ? m.compId : null;
      // createDeal's declared order (plan Task 6, steps 1–6): the scope inside the package's, the placement, online selling,
      // the rule. A gone sponsor is a 404. The end date is always today or later here, and Connect is live.
      const refusals: Refusal[] = [];
      if (!sp.alive) refusals.push({ status: 404 });
      if (pkg.scopedToC && !c.scoped) refusals.push({ status: 422, code: "scope_outside_package" });
      if (needsTiers(pkg.tier, c.scoped) && !planGrants(m.plan, c.scoped)) refusals.push({ status: 402 });
      if (c.m === "online" && !planGrants(m.plan, c.scoped)) refusals.push({ status: 402 });
      if (!SPEC_RULES[c.m].includes(c.r)) refusals.push({ status: 422, code: "on_payment_needs_payment" });
      const endsOn = c.ends === null ? null : new Date(now + c.ends * DAY).toISOString().slice(0, 10);
      const email = c.m === "online" ? `pay-${uniq()}@test.local` : null;
      const res = await attempt(() =>
        createDeal(
          w.auth,
          sp.id,
          {
            package_id: w.packageIds[c.p]!,
            competition_id: scope,
            payment_method: c.m,
            go_live: c.r,
            sponsor_email: email,
            ends_on: endsOn,
            end_current: c.endCurrent,
          },
          ORIGIN,
        ),
      );
      if (verdict(label, res, refusals)) return { ...step, refused: true };
      if (!res.ok) throw new Error("unreachable");
      step.touched.add(sp.id);
      let ended: MDeal | null = null;
      const live = dealsOf(m, c.s).find((d) => d.status === "live") ?? null;
      if (c.endCurrent && live !== null) {
        if (modelRetire(m, live) === "complete") cover.sessionCarriedOver++;
        end(live, "ended_now");
        ended = live;
        cover.endCurrentSwap++;
      }
      const d: MDeal = {
        id: res.value.deal.id,
        seq: ++m.seq,
        sponsor: c.s,
        method: c.m,
        rule: c.r,
        competition_id: scope,
        status: specInitial(c.m, c.r, live !== null && ended === null),
        payment: c.m === "complimentary" ? "none" : "pending",
        endedReason: null,
        approved: false,
        parked: false,
        disputed: false,
        intent: null,
        session: null,
        endsAt: endsOn === null ? null : Date.parse(`${endsOn}T00:00:00Z`) + DAY,
        email,
        snapshot: { tier: pkg.tier, on_stream: pkg.onStream },
        dispute: null,
        pendingIntent: null,
        duplicate: false,
      };
      m.deals.push(d);
      modelApply(m, c.s, now, ended);
      if (c.m === "online") {
        // F11: an online deal sends its invoice at once — a session minted, a draft now awaits payment.
        adoptMinted(m, d, label);
        d.status = specAfterSend(d.status);
        modelApply(m, c.s, now, null);
      }
      return step;
    }
    case "send": {
      const d = dealTarget(m, c.d);
      if (!d) return skip();
      const acts = offered(d);
      const refusals: Refusal[] = [];
      // Plan Task 7: "Otherwise 409 deal_not_invoiceable (Task 6's allowedActions check, F12)".
      if (!acts.includes("send_invoice") && !acts.includes("resend_invoice")) refusals.push({ status: 409, code: "deal_not_invoiceable" });
      if (!planGrants(m.plan, d.competition_id !== null)) refusals.push({ status: 402 });
      if (sessionComplete(m, d)) refusals.push({ status: 409, code: "deal_paid_online" });
      const res = await attempt(() => sendDealInvoice(w.auth, d.id, ORIGIN));
      if (verdict(label, res, refusals)) return { ...step, refused: true };
      step.touched.add(m.sponsors[d.sponsor]!.id);
      // The stored session is reused while Stripe calls it open (F32); with none stored, one is minted.
      if (d.session === null) adoptMinted(m, d, label);
      d.status = specAfterSend(d.status);
      modelApply(m, d.sponsor, now, null);
      return step;
    }
    case "markPaid": {
      const d = dealTarget(m, c.d);
      if (!d) return skip();
      // Plan Task 6: "Payment must be unpaid ..., else 409 deal_already_paid"; any other state it is not offered on is a 409.
      const refusals: Refusal[] = [];
      if (!offered(d).includes("mark_paid")) {
        refusals.push(d.payment === "paid" || d.payment === "refunded" ? { status: 409, code: "deal_already_paid" } : { status: 409 });
      }
      if (sessionComplete(m, d)) refusals.push({ status: 409, code: "deal_paid_online" });
      const next = specAfterPaid(d, otherLive(m, d));
      if (next === null) refusals.push({ status: 409 });
      const res = await attempt(() => markDealPaid(w.auth, d.id));
      if (verdict(label, res, refusals)) return { ...step, refused: true };
      step.touched.add(m.sponsors[d.sponsor]!.id);
      modelRetire(m, d);
      d.payment = "paid";
      d.intent = null;
      d.status = next!;
      modelApply(m, d.sponsor, now, null);
      return step;
    }
    case "approve": {
      const d = dealTarget(m, c.d);
      if (!d) return skip();
      // Plan Task 6: "awaiting_approval only, else 409 deal_not_awaiting_approval".
      const refusals: Refusal[] = offered(d).includes("approve") ? [] : [{ status: 409, code: "deal_not_awaiting_approval" }];
      const res = await attempt(() => approveDeal(w.auth, d.id));
      if (verdict(label, res, refusals)) return { ...step, refused: true };
      step.touched.add(m.sponsors[d.sponsor]!.id);
      d.approved = true;
      d.status = otherLive(m, d) ? "scheduled" : "live";
      modelApply(m, d.sponsor, now, null);
      return step;
    }
    case "endNow": {
      const d = dealTarget(m, c.d);
      if (!d) return skip();
      // Plan Task 6: "endDealNow twice → the second answers 409 deal_ended".
      const refusals: Refusal[] = offered(d).includes("end_now") ? [] : [{ status: 409, code: "deal_ended" }];
      const res = await attempt(() => endDealNow(w.auth, d.id));
      if (verdict(label, res, refusals)) return { ...step, refused: true };
      step.touched.add(m.sponsors[d.sponsor]!.id);
      if (modelRetire(m, d) === "complete") cover.sessionCarriedOver++;
      end(d, "ended_now");
      modelApply(m, d.sponsor, now, d);
      return step;
    }
    case "refund": {
      const d = dealTarget(m, c.d);
      if (!d) return skip();
      const refusals: Refusal[] = offered(d).includes("refund") ? [] : [{ status: 409 }];
      const res = await attempt(() => refundDeal(w.auth, d.id));
      if (verdict(label, res, refusals)) return { ...step, refused: true };
      step.touched.add(m.sponsors[d.sponsor]!.id);
      modelRefundFlip(m, d, now);
      return step;
    }
    case "patch": {
      const sp = m.sponsors[c.s]!;
      const patch = PATCHES[c.f];
      const deals = dealsOf(m, c.s);
      const hasLive = deals.some((d) => d.status === "live");
      const hasOpen = deals.some((d) => isOpenStatus(d.status));
      // D9 + F16: a tier the plan does not grant is 402 FIRST (judged on the competition the sponsor sits on); then a live deal
      // locks tier, scope, stream and status, and an open deal holds status. A gone sponsor is a 404.
      // A patch is judged on what it INTRODUCES (sponsors.ts assertTierAllowed): a partner tier introduces nothing gated; a
      // higher tier is judged on the competition the sponsor sits on.
      const refusals: Refusal[] = [];
      if (!sp.alive) refusals.push({ status: 404 });
      if (patch.tier !== undefined && patch.tier !== "partner") {
        const onC = sp.row.competition_id !== null;
        if (needsTiers(patch.tier, onC) && !planGrants(m.plan, onC)) refusals.push({ status: 402 });
      }
      // Plan Task 5 (D9, F16): the dispute park's 409 stays (a parked, pending sponsor keeps saying why: no code); then a live
      // deal → 409 sponsor_locked_by_deal; an open deal plus status → 409 sponsor_has_open_deal.
      if (patch.status !== undefined && sp.row.status === "pending" && deals.some((d) => d.payment === "paid" && d.disputed)) {
        refusals.push({ status: 409 });
      }
      if (hasLive) refusals.push({ status: 409, code: "sponsor_locked_by_deal" });
      else if (hasOpen && patch.status !== undefined) refusals.push({ status: 409, code: "sponsor_has_open_deal" });
      const allEnded = deals.length > 0 && !hasLive && !hasOpen;
      const res = await attempt(() => patchSponsor(w.auth, sp.id, patch));
      if (verdict(label, res, refusals)) return { ...step, refused: true };
      Object.assign(sp.row, patch);
      if (patch.on_stream === true) m.streamRow = true;
      if (c.f === "on" && allEnded) cover.switchBackOn++;
      step.patched = sp.id;
      return step;
    }
    case "checkout": {
      // The sponsor completes Checkout at Stripe. No usecase runs: the webhook is still on its way (Review Focus 1's window).
      const pool = m.deals.filter((d) => d.method === "online" && !d.duplicate && d.pendingIntent === null && d.session !== null && m.sessions.get(d.session) === "open");
      const d = dealTarget(m, c.d, pool);
      if (!d) return skip();
      W.sessions.get(d.session!)!.status = "complete";
      m.sessions.set(d.session!, "complete");
      d.pendingIntent = newIntent();
      return step;
    }
    case "paid": {
      // payment_intent.succeeded. The in-flight payment if the sponsor completed Checkout; else, on an unpaid deal with an open
      // session, the sponsor pays now; on a paid (or refunded) deal, a redelivery of its intent or a second intent (F3).
      const pool = m.deals.filter(
        (d) =>
          d.method === "online" &&
          !d.duplicate &&
          (d.pendingIntent !== null || (unpaid(d) && d.session !== null && m.sessions.get(d.session) === "open") || !unpaid(d)),
      );
      const d = dealTarget(m, c.d, pool);
      if (!d) return skip();
      let intent: string;
      if (d.pendingIntent !== null) {
        intent = d.pendingIntent;
        d.pendingIntent = null;
      } else if (unpaid(d)) {
        W.sessions.get(d.session!)!.status = "complete";
        m.sessions.set(d.session!, "complete");
        intent = newIntent();
      } else {
        intent = c.again && d.intent !== null ? d.intent : newIntent();
      }
      step.touched.add(m.sponsors[d.sponsor]!.id);
      if (!unpaid(d)) {
        if (dealsOf(m, d.sponsor).some((x) => x.intent === intent)) {
          cover.redelivery++;
        } else {
          // F3: a second, different payment — its own ended, paid, refundable row with the deal's snapshot; the deal and its
          // sponsor stay as they were; the owner is alerted.
          m.deals.push({
            ...d,
            id: "",
            seq: ++m.seq,
            method: "online",
            status: "ended",
            payment: "paid",
            endedReason: "duplicate_payment",
            approved: false,
            parked: false,
            disputed: false,
            intent,
            session: null,
            endsAt: null,
            snapshot: { ...d.snapshot },
            dispute: null,
            pendingIntent: null,
            duplicate: true,
          });
          m.alerts.push({ reason: "duplicate_payment", dealId: d.id });
          cover.duplicatePayment++;
        }
      } else {
        const late = d.status === "ended";
        const next = late ? null : specAfterPaid(d, otherLive(m, d));
        d.payment = "paid";
        d.intent = intent;
        if (next !== null) {
          d.status = next;
          modelApply(m, d.sponsor, now, null);
        } else {
          // Review Focus 1: money on an ended deal is recorded and refundable; the deal stays ended, its sponsor untouched.
          m.alerts.push({ reason: late ? "deal_ended" : "deal_not_payable", dealId: d.id });
          if (late) cover.latePayment++;
        }
      }
      await deliver(
        label,
        ev("payment_intent.succeeded", {
          id: intent,
          object: "payment_intent",
          amount: 25_000,
          amount_received: 25_000,
          currency: "gbp",
          status: "succeeded",
          metadata: { kind: "sponsor", order_id: d.id, org_id: m.orgId },
        }),
      );
      const dup = m.deals.find((x) => x.duplicate && x.id === "" && x.intent === intent);
      if (dup) {
        const [row] = await sql<{ id: string }[]>`select id from sponsor_orders where payment_intent_id = ${intent}`;
        dup.id = row?.id ?? "(no row)";
      }
      return step;
    }
    case "refunded": {
      // charge.refunded (a refund made in the Stripe dashboard): only a PAID row on that intent flips.
      const d = dealTarget(m, c.d, m.deals.filter((x) => x.intent !== null));
      if (!d) return skip();
      step.touched.add(m.sponsors[d.sponsor]!.id);
      if (d.payment === "paid") modelRefundFlip(m, d, now);
      await deliver(label, ev("charge.refunded", { id: `ch_${uniq()}`, object: "charge", payment_intent: d.intent, refunded: true, amount: 25_000, amount_refunded: 25_000 }));
      return step;
    }
    case "dispute": {
      // One dispute per charge (Stripe): created → closed won | lost. A closed dispute is only ever redelivered as its outcome;
      // a `created` after the close is out-of-order delivery, out of this model's scope (skipped).
      const pool = m.deals.filter((x) => x.intent !== null && !(c.phase === "created" && x.dispute !== null && x.dispute.state !== "open"));
      const d = dealTarget(m, c.d, pool);
      if (!d) return skip();
      step.touched.add(m.sponsors[d.sponsor]!.id);
      const phase = d.dispute !== null && d.dispute.state !== "open" ? d.dispute.state : c.phase;
      const disputeId = d.dispute?.id ?? `dp_model_${RUN}_${uniq()}`;
      if (phase === "created") {
        const first = d.dispute === null;
        d.dispute = { id: disputeId, state: "open" };
        d.disputed = true;
        // Spec §5.2: "Dispute opened → the sponsor is hidden until the dispute is resolved" — the deal is parked (D8).
        if (first) {
          d.parked = true;
          modelApply(m, d.sponsor, now, null);
        }
      } else if (phase === "won") {
        d.dispute = { id: disputeId, state: "won" };
        d.disputed = false;
        if (d.payment === "paid") {
          d.parked = false;
          modelApply(m, d.sponsor, now, null);
        }
      } else {
        // Lost: the money is written off and the deal ends (dispute_lost); the reset only when this ended a live or open deal.
        d.dispute = { id: disputeId, state: "lost" };
        const wasOpen = d.status !== "ended";
        d.payment = "refunded";
        end(d, "dispute_lost");
        modelApply(m, d.sponsor, now, wasOpen ? d : null);
      }
      const status = phase === "created" ? "needs_response" : phase;
      await deliver(
        label,
        ev(phase === "created" ? "charge.dispute.created" : "charge.dispute.closed", {
          id: disputeId,
          object: "dispute",
          payment_intent: d.intent,
          amount: 25_000,
          status,
        }),
      );
      return step;
    }
    case "sweep": {
      const at = now + c.days * DAY;
      // D20, F19, §8a: every live or open deal is examined; one past its end is ended `expired`; one scoped to a finished C with
      // no end date is ended `competition_finished`; deals still waiting go before live ones; apply promotes the next scheduled
      // deal whose own end has not passed (at the sweep's `now`).
      const rows = m.deals.filter((d) => d.status !== "ended").sort((a, b) => a.seq - b.seq);
      const want: SweepResult = { checked: rows.length, expired: 0, finished: 0, promoted: 0, failed: 0 };
      const due: { d: MDeal; reason: "expired" | "competition_finished" }[] = [];
      for (const d of rows) {
        if (d.endsAt !== null && d.endsAt <= at) due.push({ d, reason: "expired" });
        else if (d.endsAt === null && d.competition_id !== null && m.finished) due.push({ d, reason: "competition_finished" });
      }
      due.sort((a, b) => Number(a.d.status === "live") - Number(b.d.status === "live"));
      for (const { d, reason } of due) {
        step.touched.add(m.sponsors[d.sponsor]!.id);
        if (modelRetire(m, d) === "complete") cover.sessionCarriedOver++;
        const last = !m.deals.some((x) => x.sponsor === d.sponsor && x !== d && x.status !== "ended");
        end(d, reason);
        const promoted = modelApply(m, d.sponsor, at, last ? d : null, true);
        if (reason === "expired") want.expired++;
        else want.finished++;
        if (promoted) want.promoted++;
      }
      const res = await attempt(() => sweepSponsorDeals(new Date(at), { orgIds: [m.orgId] }));
      if (!res.ok) throw new ModelBreak(`${label}: the sweep threw: ${describeErr(res.err)}`);
      cover.sweepExpired += want.expired;
      cover.sweepFinished += want.finished;
      cover.sweepPromoted += want.promoted;
      step.sweep = { want, got: res.value };
      return step;
    }
    case "age": {
      // Time passes with no sweep (a cron outage): every end date moves k days nearer, which for the usecases that read the real
      // clock IS the clock moving on. A world step, like Checkout: no usecase runs. It is what makes F19 reachable by a console
      // writer — a scheduled deal past its own end is never promoted, whoever ends the live deal ahead of it.
      // Whole 24-hour days, never `days =>`: Postgres applies a day interval to the session zone's wall clock, so a step across a
      // DST change would move the date 23 or 25 hours while the model moves it k × 24 h (the regression case below).
      await sql`update sponsor_orders set ends_at = ends_at - make_interval(hours => ${c.days * 24}) where org_id = ${m.orgId} and ends_at is not null`;
      for (const d of m.deals) if (d.endsAt !== null) d.endsAt -= c.days * DAY;
      return step;
    }
    case "delete": {
      const sp = m.sponsors[c.s]!;
      const deals = dealsOf(m, c.s);
      // Money history (paid or refunded) refuses FIRST; then a completed session (money in flight) refuses; else every open
      // session is expired and the sponsor goes with its deals.
      const refusals: Refusal[] = [];
      if (!sp.alive) refusals.push({ status: 404 });
      if (deals.some((d) => d.payment === "paid" || d.payment === "refunded")) refusals.push({ status: 409, code: "sponsor_has_deal_history" });
      if (deals.some((d) => sessionComplete(m, d))) refusals.push({ status: 409, code: "sponsor_has_open_checkout" });
      const res = await attempt(() => deleteSponsor(w.auth, sp.id));
      if (verdict(label, res, refusals)) return { ...step, refused: true };
      for (const d of deals) modelRetire(m, d);
      m.deals = m.deals.filter((d) => d.sponsor !== c.s);
      sp.alive = false;
      m.deletes++;
      return step;
    }
    case "downgrade": {
      // Review Focus 4: the org drops to community (and loses its pass). A live tiered deal stays live.
      await setOrgPlan(m.orgId, "community");
      await sql`delete from competition_passes where org_id = ${m.orgId}`;
      await invalidateOrgEntitlements(m.orgId);
      m.plan = "community";
      return step;
    }
  }
}

/** I1–I8 and M2–M6 on the database after a step; the per-step checks (M1's byte-equality, I2's manual control) on the pair. */
function check(label: string, m: Model, before: Snap, after: Snap, step: Step | null): void {
  const fails: string[] = [];
  const f = (msg: string) => fails.push(msg);

  // --- I1–I8 on the database as it stands --------------------------------------------------------------------------------------
  const bySponsor = new Map<string, DealDb[]>();
  for (const d of after.deals) {
    if (d.sponsor_id === null) continue;
    const list = bySponsor.get(d.sponsor_id) ?? [];
    list.push(d);
    bySponsor.set(d.sponsor_id, list);
  }
  for (const [sid, row] of after.sponsors) {
    const deals = bySponsor.get(sid) ?? [];
    const lives = deals.filter((d) => d.deal_status === "live");
    if (lives.length > 1) f(`I1: sponsor ${sid} has ${lives.length} live deals`);
    const governed = deals.some((d) => d.deal_status !== "ended");
    if (governed) {
      const shown = lives.some((d) => !d.parked);
      if ((row.status === "active") !== shown) f(`I2: sponsor ${sid} is ${row.status} but ${shown ? "has" : "has no"} live unparked deal`);
    }
    const live = lives[0];
    if (live && (row.tier !== live.tier || row.competition_id !== live.competition_id || row.on_stream !== live.includes_on_stream)) {
      f(`I3: sponsor ${sid} shows ${row.tier}/${row.competition_id}/${row.on_stream}; its live deal is ${live.tier}/${live.competition_id}/${live.includes_on_stream}`);
    }
  }
  const alive = m.sponsors.filter((s) => s.alive).length;
  if (after.sponsors.size !== 2 - m.deletes) f(`I4: the org has ${after.sponsors.size} sponsor rows; 2 made, ${m.deletes} deleted`);
  if (alive !== 2 - m.deletes) f(`model: ${alive} sponsors alive, ${m.deletes} deleted`);
  for (const d of after.deals) {
    if (d.deal_status === "live" && d.go_live === "on_approval" && !d.approved) f(`I5: deal ${d.id} is live on After-I-approve and was never approved`);
    if (d.deal_status === "live" && d.go_live === "on_payment" && (d.status === "pending" || d.status === "failed")) {
      f(`I6: deal ${d.id} is live on When-paid with its money ${d.status}`);
    }
    if (d.status === "refunded" && d.deal_status !== "ended") f(`I7: deal ${d.id} is refunded but ${d.deal_status}`);
    const md = m.deals.find((x) => x.id === d.id);
    if (md && (d.tier !== md.snapshot.tier || d.includes_on_stream !== md.snapshot.on_stream)) {
      f(`I8: deal ${d.id} carries ${d.tier}/${d.includes_on_stream}; its package was ${md.snapshot.tier}/${md.snapshot.on_stream} at creation`);
    }
  }

  // --- M2: deals, model vs database ----------------------------------------------------------------------------------------------
  const dbIds = new Set(after.deals.map((d) => d.id));
  for (const md of m.deals) if (!dbIds.has(md.id)) f(`M2: the model holds deal ${md.id || "(unnamed)"} (${md.status}); the database does not`);
  for (const d of after.deals) {
    const md = m.deals.find((x) => x.id === d.id);
    if (!md) {
      f(`M2: the database holds deal ${d.id} (${d.deal_status}/${d.status}/${d.ended_reason}); the model does not`);
      continue;
    }
    const want = {
      sponsor_id: m.sponsors[md.sponsor]!.id,
      deal_status: md.status,
      status: md.payment,
      ended_reason: md.endedReason,
      parked: md.parked,
      disputed: md.disputed,
      approved: md.approved,
      payment_intent_id: md.intent,
      checkout_session_id: md.session,
      competition_id: md.competition_id,
      payment_method: md.method,
      go_live: md.rule,
      ends_at: md.endsAt,
    };
    const got = { ...d, ends_at: d.ends_at === null ? null : new Date(d.ends_at).getTime() };
    for (const key of Object.keys(want) as (keyof typeof want)[]) {
      if (got[key] !== want[key]) f(`M2: deal ${d.id} ${key} is ${JSON.stringify(got[key])}; the model says ${JSON.stringify(want[key])}`);
    }
  }

  // --- M3, M4: sponsors and the stream row ------------------------------------------------------------------------------------
  for (const sp of m.sponsors) {
    const row = after.sponsors.get(sp.id);
    if (!sp.alive) {
      if (row) f(`M3: sponsor ${sp.id} was deleted; its row is still there`);
      continue;
    }
    if (!row) {
      f(`M3: sponsor ${sp.id} is gone; the model holds it`);
      continue;
    }
    for (const key of ["status", "tier", "competition_id", "on_stream"] as const) {
      if (row[key] !== sp.row[key]) f(`M3: sponsor ${sp.id} ${key} is ${JSON.stringify(row[key])}; the model says ${JSON.stringify(sp.row[key])}`);
    }
  }
  if (after.streamRow !== m.streamRow) f(`M4: the org's stream-settings row ${after.streamRow ? "exists" : "is missing"}; the model says ${m.streamRow}`);

  // --- M5: Stripe ----------------------------------------------------------------------------------------------------------------
  const openPerDeal = new Map<string, number>();
  for (const [id, s] of W.sessions) {
    if (s.org !== m.orgId) continue;
    const want = m.sessions.get(id);
    if (want !== s.status) f(`M5: session ${id} of deal ${s.deal} is ${s.status} at Stripe; the model says ${want ?? "unknown"}`);
    if (s.status === "open") openPerDeal.set(s.deal, (openPerDeal.get(s.deal) ?? 0) + 1);
  }
  for (const [deal, n] of openPerDeal) {
    if (n > 1) f(`M5: deal ${deal} has ${n} open Checkout sessions (two payable links, D14)`);
    const db = after.deals.find((d) => d.id === deal);
    if (!db) f(`M5: deal ${deal} is gone but its Checkout session is still open (a later payment would record nothing)`);
    else if (db.deal_status === "ended") f(`M5: deal ${deal} has ended but its Checkout session is still open`);
  }

  // --- M6: owner alerts ------------------------------------------------------------------------------------------------------------
  const got = W.alerts.map((a) => `${a.reason}:${a.dealId}`).sort();
  const want = m.alerts.map((a) => `${a.reason}:${a.dealId}`).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) f(`M6: owner alerts ${JSON.stringify(got)}; the model says ${JSON.stringify(want)}`);
  if (step?.sweep && JSON.stringify(step.sweep.got) !== JSON.stringify(step.sweep.want)) {
    f(`M6: the sweep answered ${JSON.stringify(step.sweep.got)}; the model says ${JSON.stringify(step.sweep.want)}`);
  }

  // --- Per step: a refusal writes nothing; manual control (I2, F7); the transition into all-ended (D8) ------------------------
  if (step?.refused && before.tables !== after.tables) f(`M1: a refused step changed the sponsor tables`);
  if (step) {
    const governedIn = (s: Snap, sid: string) => s.deals.some((d) => d.sponsor_id === sid && d.deal_status !== "ended");
    for (const [sid, row] of after.sponsors) {
      const prev = before.sponsors.get(sid);
      if (!prev) continue;
      const manualBefore = !governedIn(before, sid);
      const manualAfter = !governedIn(after, sid);
      if (manualBefore && manualAfter) {
        if (step.patched !== sid && prev.bytes !== row.bytes) f(`I2: sponsor ${sid} is under manual control and a step that is not a patch rewrote it: ${prev.bytes} → ${row.bytes}`);
        else if (step.touched.has(sid) && after.deals.some((d) => d.sponsor_id === sid)) cover.manualHeldOnLateEvent++;
      } else if (!manualBefore && manualAfter) {
        const reset = { status: "inactive", tier: "partner", competition_id: null, on_stream: false };
        const shape = { status: row.status, tier: row.tier, competition_id: row.competition_id, on_stream: row.on_stream };
        if (JSON.stringify(shape) !== JSON.stringify(reset)) f(`I2/D8: sponsor ${sid}'s last deal ended and its row is ${JSON.stringify(shape)}, not the reset`);
      }
    }
  }

  if (fails.length > 0) throw new ModelBreak(`${label}:\n  - ${fails.join("\n  - ")}`);
}

const drain = async (): Promise<void> => {
  while (W.tails.length > 0) {
    const run = W.tails.splice(0);
    for (const t of run) await t();
  }
};

/** Build a world, then run the commands through the real code, checking everything after every step. */
async function runSequence(spec: WorldSpec, cmds: readonly Cmd[]): Promise<number> {
  stats.runs++;
  const { w, m } = await buildWorld(spec);
  W.alerts.length = 0;
  let before = await snapshot(w.orgId);
  check(`[${spec.plan}${spec.finished ? ", C finished" : ""}] step 0 (the world)`, m, before, before, null);
  const trace: string[] = [];
  let checked = 0;
  for (const [i, c] of cmds.entries()) {
    const label = `[${spec.plan}${spec.finished ? ", C finished" : ""}] step ${i + 1} ${JSON.stringify(c)}`;
    W.alerts.length = 0;
    m.alerts = [];
    let step: Step;
    try {
      step = await exec(w, m, c, label);
      await drain();
      const after = await snapshot(w.orgId);
      if (step.ran) check(label, m, before, after, step);
      before = after;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ModelBreak(`${msg}\n  after: ${trace.join(" → ") || "(nothing)"}`);
    }
    const k = stats.kinds[c.k];
    if (!step.ran) {
      k.skipped++;
      trace.push(`${c.k}(skipped)`);
      continue;
    }
    k.executed++;
    if (step.refused) k.refused++;
    else k.accepted++;
    checked++;
    trace.push(`${c.k}${step.refused ? "(refused)" : ""}`);
  }
  stats.stepsChecked += checked;
  return checked;
}

/** Run one hand-written sequence and assert the coverage counters it exists to reach moved. */
async function scenario(spec: WorldSpec, cmds: readonly Cmd[], reaches: readonly Cover[]): Promise<void> {
  const at = { ...cover };
  const steps = await runSequence(spec, cmds);
  expect(steps, "anti-vacuity: the scenario executed every step").toBe(cmds.length);
  for (const c of reaches) expect(cover[c] - at[c], `the scenario reaches ${c}`).toBeGreaterThan(0);
}

// =================================================================================================================================
// Named scenarios: the cases the brief names, through the same runner and the same checks
// =================================================================================================================================

const C = (over: Partial<Extract<Cmd, { k: "create" }>> = {}): Cmd => ({
  k: "create", s: 0, p: 0, scoped: false, m: "offline", r: "on_payment", ends: null, endCurrent: false, ...over,
});

describe.skipIf(!HAS_DB)("sponsor deals, model-based: named scenarios (DB)", () => {
  it("Review Focus 1 + F7: the sponsor pays at Stripe, the club ends the deal, switches the sponsor back on by hand, and the late payment, its dispute and its refund never rewrite it", async () => {
    await scenario(
      { plan: "pro", finished: false },
      [
        C({ m: "online" }),
        { k: "checkout", d: 0 },
        { k: "markPaid", d: 0 }, // money in flight: 409 deal_paid_online
        { k: "send", d: 0 }, // 409 deal_paid_online
        { k: "endNow", d: 0 }, // the completed session is carried over; the sponsor's last deal ended: the reset
        { k: "patch", s: 0, f: "on" }, // the hand switch-back-on (spec §10 Q3)
        { k: "paid", d: 0, again: false }, // the late payment: recorded, the deal stays ended, deal_ended alert
        { k: "dispute", d: 0, phase: "created" },
        { k: "dispute", d: 0, phase: "won" },
        { k: "refund", d: 0 }, // refundable after a won dispute
        { k: "refunded", d: 0 }, // the dashboard's event for the same refund: a no-op
      ],
      ["sessionCarriedOver", "paidOnlineRefusal", "transitionReset", "switchBackOn", "latePayment", "manualHeldOnLateEvent"],
    );
  }, 120_000);

  it("Review Focus 5 + F3: the queue, a second intent, a redelivery, and end_current swapping the live deal for a new one", async () => {
    await scenario(
      { plan: "pro", finished: false },
      [
        C({ s: 1, p: 1, scoped: true, m: "online", r: "immediate" }), // live at once, awaiting payment
        C({ s: 1, p: 0 }), // offline When-paid: awaiting payment (the sponsor keeps the live deal's snapshot)
        { k: "markPaid", d: 1 }, // the rule is met behind a live deal: scheduled
        { k: "paid", d: 0, again: false }, // the sponsor pays the live deal
        { k: "paid", d: 0, again: false }, // a second intent: its own ended, paid row
        { k: "paid", d: 0, again: true }, // the first intent redelivered: nothing
        C({ s: 1, p: 2, scoped: true, m: "complimentary", r: "immediate", endCurrent: true }), // the live deal ends; this goes live
        { k: "endNow", d: 3 }, // the queue: the scheduled offline deal goes live
        { k: "refund", d: 1 }, // offline refund ends the last live deal: the reset
        { k: "refunded", d: 1 }, // (the rows with an intent: the paid live deal, the duplicate) the duplicate refunded at Stripe
        { k: "approve", d: 1 }, // 409
      ],
      ["promotion", "duplicatePayment", "redelivery", "endCurrentSwap", "transitionReset", "refused409"],
    );
  }, 120_000);

  it("the sweep: ends a finished competition's deal, then an expired live one (no promotion of a past-end deal), then the last open one", async () => {
    await scenario(
      { plan: "pro", finished: true },
      [
        C({ m: "complimentary", r: "immediate", ends: 1 }), // live, ends in two days
        C({ p: 2, scoped: true, m: "complimentary", r: "immediate" }), // queued; C is finished and it has no end date
        C({ ends: 3 }), // offline When-paid, awaiting payment
        { k: "sweep", days: 0 }, // the queued deal on finished C ends (competition_finished)
        { k: "sweep", days: 2 }, // the live deal expires; nothing to promote; the open deal hides the sponsor
        { k: "sweep", days: 9 }, // the open deal expires: the sponsor's last deal ended — the reset
        { k: "sweep", days: 9 }, // a second call: nothing
      ],
      ["sweepFinished", "sweepExpired", "transitionReset"],
    );
  }, 180_000);

  it("the parked item, counted: a queued deal on a finished competition goes live when the club ends the deal ahead of it, until the next sweep", async () => {
    await scenario(
      { plan: "pro", finished: true },
      [
        C({ m: "complimentary", r: "immediate" }),
        C({ p: 2, scoped: true, m: "complimentary", r: "immediate" }),
        { k: "endNow", d: 0 },
        { k: "sweep", days: 0 },
      ],
      ["deferredFinishedPromotion", "sweepFinished"],
    );
  }, 180_000);

  it("F19, whoever ends the live deal: days pass with no sweep, the club ends the live deal, and the queued deal past its own end stays queued (hidden) until the sweep ends it", async () => {
    await scenario(
      { plan: "pro", finished: false },
      [
        C({ m: "complimentary", r: "immediate" }), // live
        C({ p: 1, m: "complimentary", r: "immediate", ends: 1 }), // queued, ends in two days
        C({ s: 1, m: "complimentary", r: "immediate" }), // the control: sponsor 1, live
        C({ s: 1, p: 1, m: "complimentary", r: "immediate", ends: 8 }), // queued, its end still ahead after the outage
        { k: "age", days: 4 }, // the sweep does not run for four days
        { k: "endNow", d: 0 }, // sponsor 0: the queued deal is past its end: NOT promoted, the sponsor hidden behind it
        { k: "endNow", d: 2 }, // sponsor 1: the queued deal is not past its end: promoted
        { k: "sweep", days: 0 }, // sponsor 0's queued deal ends `expired`: the reset
      ],
      ["promotion", "sweepExpired", "transitionReset"],
    );
  }, 120_000);

  it("another plan — community: tiers, scopes and online selling answer 402; the rule and the scope 422; a lock 409; a gone sponsor 404", async () => {
    await scenario(
      { plan: "community", finished: false },
      [
        C({ p: 1, m: "offline", r: "immediate" }), // gold: 402
        C({ m: "online" }), // online selling: 402
        C({ scoped: true }), // a scope: 402
        C({ p: 2 }), // the C-only package on the whole org: 422 scope_outside_package
        C({ m: "complimentary", r: "on_payment" }), // 422 on_payment_needs_payment
        C({ r: "on_approval" }), // offline, after approval: awaiting payment
        { k: "patch", s: 0, f: "on" }, // an open deal holds status: 409
        { k: "patch", s: 0, f: "gold" }, // 402 before any lock (F16)
        { k: "markPaid", d: 0 }, // awaiting approval (anti-goal 2: still hidden)
        { k: "approve", d: 0 }, // live
        { k: "patch", s: 0, f: "streamOn" }, // a live deal locks it: 409
        { k: "delete", s: 0 }, // money history: 409
        { k: "delete", s: 1 }, // a sponsor with no deal goes
        C({ s: 1 }), // 404
        { k: "patch", s: 1, f: "on" }, // 404
      ],
      ["refused402", "refused422", "refused409", "refused404"],
    );
  }, 120_000);

  it("another plan — an Event Pass on C: a gold online deal on C sells, a disputed approval goes live parked, a lost dispute resets; after a downgrade C is 402", async () => {
    await scenario(
      { plan: "event_pass", finished: false },
      [
        C({ p: 1, scoped: true, m: "online", r: "on_approval" }), // gold on C, online: the pass grants both
        C({ p: 1, r: "immediate" }), // gold on the whole org: 402
        { k: "paid", d: 0, again: false }, // awaiting approval
        { k: "dispute", d: 0, phase: "created" }, // parked
        { k: "approve", d: 0 }, // live, parked: the sponsor is pending
        { k: "patch", s: 0, f: "off" }, // 409
        { k: "dispute", d: 0, phase: "lost" }, // ended dispute_lost: the reset
        { k: "refund", d: 0 }, // 409: lost to a dispute
        { k: "downgrade" },
        C({ s: 1, p: 2, scoped: true, r: "immediate" }), // silver on C: 402 without the pass
      ],
      ["parkedLive", "transitionReset", "refused402", "refused409"],
    );
  }, 120_000);

  it("delete: a completed Checkout refuses (money in flight), money history refuses, a sponsor with an open link goes and the link is closed", async () => {
    await scenario(
      { plan: "pro", finished: false },
      [
        C({ m: "online" }),
        { k: "checkout", d: 0 },
        { k: "delete", s: 0 }, // 409 sponsor_has_open_checkout
        { k: "paid", d: 0, again: false }, // live
        { k: "delete", s: 0 }, // 409 sponsor_has_deal_history
        C({ s: 1, m: "online", r: "immediate" }), // live, awaiting payment, an open link
        { k: "delete", s: 1 }, // goes; its open session is expired
        { k: "sweep", days: 9 },
      ],
      ["refused409"],
    );
  }, 120_000);

  it("Review Focus 4: a downgrade keeps an approved gold deal's path open — approval, the sponsor's tier, and the sweep never re-ask the plan", async () => {
    await scenario(
      { plan: "pro", finished: false },
      [
        C({ p: 1, m: "complimentary", r: "on_approval", ends: 3 }),
        { k: "downgrade" },
        { k: "approve", d: 0 }, // live gold, on the stream
        { k: "patch", s: 0, f: "partner" }, // a live deal locks the tier: 409
        { k: "send", d: 0 }, // not online: 409
        { k: "sweep", days: 4 }, // expired: the reset
      ],
      ["transitionReset", "refused409"],
    );
  }, 120_000);
});

// =================================================================================================================================
// Regression cases: every shrunk counterexample, named, with its seed (TEST-STRATEGY rule 10). The model has found no defect in
// the code under test; the one counterexample so far was the harness's own.
// =================================================================================================================================

describe.skipIf(!HAS_DB)("sponsor deals, model-based: regression cases (DB)", () => {
  // Found by the property at 2000 runs, seed 1115884138 (path "152:0:0:0:0:0:1:3:7") and again at seed 1115901084: shrunk to
  // create(ends in a day) → age 9 → age 9, the second age crossing 2026-10-25 (BST ends). `age` moved ends_at by
  // `make_interval(days => k)`, which Postgres applies in the SESSION time zone's wall clock, so a step across a DST change moved
  // it 23 or 25 hours; the model moves it k × 24 h. A harness defect, not the code's: the usecases never shift an end date. The
  // walk below is 225 days of outage, longer than any gap between DST changes in a zone that keeps DST (Europe/London's longest
  // is ~217 days), so it crosses at least one from any start date on such a database (the seazn-env DBs run Europe/London); on
  // a UTC database it has nothing to cross and checks the same arithmetic.
  it("regression: `age` moves an end date by whole 24-hour days, so an outage that crosses a DST change agrees with the model", async () => {
    await scenario(
      { plan: "pro", finished: false },
      [C({ m: "online", ends: 1 }), ...Array.from({ length: 25 }, (): Cmd => ({ k: "age", days: 9 }))],
      [],
    );
  }, 120_000);
});

// =================================================================================================================================
// The property
// =================================================================================================================================

describe.skipIf(!HAS_DB)("sponsor deals, model-based: random sequences (DB)", () => {
  it(`${RUNS} random worlds × 1–14 commands: I1–I8 and the model hold after every step`, async () => {
    const at = { runs: stats.runs, steps: stats.stepsChecked, kinds: structuredClone(stats.kinds), cover: { ...cover } };
    await fc.assert(
      fc.asyncProperty(worldArb, seqArb, async (spec, cmds) => {
        await runSequence(spec, cmds);
      }),
      { numRuns: RUNS, seed: SEED, endOnFailure: false },
    );
    const runs = stats.runs - at.runs;
    const steps = stats.stepsChecked - at.steps;
    const kinds = Object.fromEntries(
      KINDS.map((k) => [
        k,
        {
          executed: stats.kinds[k].executed - at.kinds[k].executed,
          accepted: stats.kinds[k].accepted - at.kinds[k].accepted,
          refused: stats.kinds[k].refused - at.kinds[k].refused,
          skipped: stats.kinds[k].skipped - at.kinds[k].skipped,
        },
      ]),
    );
    const reached = Object.fromEntries((Object.keys(cover) as Cover[]).map((c) => [c, cover[c] - at.cover[c]]));
    const report = JSON.stringify({ seed: SEED, runs, stepsChecked: steps, kinds, cover: reached });
    console.log(`[sponsor-deals-model] ${report}`);
    if (process.env.SPONSOR_DEALS_MODEL_REPORT) writeFileSync(process.env.SPONSOR_DEALS_MODEL_REPORT, report);
    // Anti-vacuity: the property ran, checked enough steps, and executed every command kind.
    expect(runs, "every run was a property run").toBe(RUNS);
    expect(steps, "stepsChecked across the run").toBeGreaterThanOrEqual(RUNS >= 30 ? 100 : 1);
    for (const k of KINDS) expect(kinds[k]!.executed, `command kind ${k} executed`).toBeGreaterThan(0);
  }, 900_000);
});
