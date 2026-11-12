// Sponsors on a composed stream, across plans, with the deals changing MID-STREAM — layer L2 of the sponsor x live-stream matrix
// (docs/superpowers/specs/2026-11-12-sponsor-stream-matrix-design.md). The vitest layer (server/sponsors/__tests__/stream-matrix*.ts)
// proves every cell of deal state x payment x plan x tier x scope at the plan; this file proves the same seam in a RUNNING stream: a
// deal written through the product API reaches the plan the compositor's page reads, the rotation follows it, the page airs it, the
// heartbeat records it and the Overview counts it - and each change made while the stream is live moves all of those again.
//
//   O1  OBS (passthrough, no compositor): a break card shows on the page and NOTHING is recorded - Times shown stays 0. This is
//       today's behaviour (spec "Why" 3: airings ride only a composed heartbeat), named as such; it is not a promise.
//   J1  Free (community): partner-only. A paid-by-hand deal with a queued successor, a complimentary deal, a hand-ticked sponsor, all three
//       on the carousel before anything changes; the gold/tiered placements are refused (402 sponsors.tiers). One full rotation cycle
//       (three breaks) gives each its weight; the queued deal takes over; a deal ends and a sponsor is archived (both leave the
//       carousel); the archived sponsor returns and airs again.
//   J2  Pass (a competition pass on A only): a gold deal scoped to A is served as gold on A, and the OTHER competition's plan PREVIEW
//       (the door that never writes) carries no gold sponsor; org-wide gold and anything scoped to B is refused. A full cycle (four
//       breaks), the successor deal, an ended complimentary deal, archive and a returning sponsor that airs again.
//   J3  Pro: title (complimentary), gold (paid by hand, queued silver successor), silver (ONLINE, paid by a signed Stripe webhook while
//       live: the joiner airs), partner (unpaid, expires, is written off). Four breaks across the changes, their positions strictly
//       consecutive from 0.
//   J4  Pro, the club's PLAN changes while the stream is live: downgraded to Free, every card the plan serves is a partner and the stored
//       tier rows are untouched; back on Pro the tiers return. A hand-ticked sponsor is archived and returns.
//
// Every sponsor that leaves has aired before it leaves (a lap of the carousel first), and every joiner airs after it joins: an absence
// is only evidence where the same sponsor was shown while it was on the roster.
//
// THE ONLY STAND-IN is the compositor, at its HTTP boundary (helpers/sponsor-relay-standin.ts, as sponsors-journey.spec.ts): a real
// composed session, its real overlay page, the page's own `seazn:sponsor:*` console lines turned into heartbeat `airings`, a
// keep-alive beat, every body validated against the vendored contract. The online deal's payment is the signed
// `payment_intent.succeeded` the real webhook route takes (sponsor-deals-api.spec.ts's stand-in: a community CI server has no
// Connect, so the pending online deal is written by SQL the way Send invoice leaves it). No airing is built by hand: each is a
// line the page printed, and the expected counts are the test's own tally of those lines.
//
// WHAT IS READ, and where each expectation comes from (TEST-STRATEGY: never from the code under test):
//   - who airs: the plan on the relay door (`relayPlan`) - ticked cards and their tiers. The tiers come from the packages the
//     test bought; the roster from the deals and ticks it wrote.
//   - the rotation share: SPONSOR_TIER_WEIGHTS (the declaration). A FULL cycle (as many consecutive breaks as the weights sum to)
//     gives every card exactly its weight - no algorithm needed. A PARTIAL window is held to what a declaration does say: the card
//     dealt is a ticked one and the positions the database wrote run consecutively from 0 (assign.ts: max + 1, none = 0). Which of two
//     equal-weight cards comes first is the planner's own order, which nothing declares, so no per-break order is asserted.
//   - who is on the carousel AFTER a change: the page's own start lines past the change plus the page's catch-up. The carousel is a
//     fixed rotation over the ticked cards (carouselStep: the next index, mod the list), so a lap of as many showings as the roster
//     has cards shows every sponsor on it once - and none that left.
//   - what was recorded: `sponsor_airings` against the tally of the lines the heartbeats carried; Times shown on the Overview.
//
// ONE SPORT (volleyball), on purpose: the plan, the rotation and the carousel never read the sport - it only supplies a set end that
// opens a major break (declared by the engine, `declaredMajorBreak`) - so a second sport would buy nothing but pool time.
// SERIAL: after the first red the rest of this file does not run, so a red count here is a FLOOR - re-run after each fix until a
// whole pass completes (as mobile.spec.ts).
//
// NOT DRIVEN, named plainly: a real Stripe Checkout (no Connect on CI), a frame's storage (a stub on CI: sponsors-journey J4), and
// the stg run (layer L3).
//
// THE POOL HOLD IS AN ARITHMETIC CLIFF, not a flake: the longest journey is declared at 325 s (POOL_HOLD below: one 55 s cycle plus
// 270 s of streaming) against the pool's 330 s limit (POOL_HOLD_CYCLES = 6 cycles of 55 s at CI's 10 s connect delay), and
// takeWholePool refuses a hold past the limit - so a journey that grows past 5 s of declared streaming fails EVERY run, not some.
// If one grows, raise POOL_HOLD_CYCLES 6 -> 7 in e2e/helpers/stream-slot-pool.ts (385 s; it also lengthens every pool member's
// slot wait, which is sized from the limit) - or split the journey, as J4 was split from J3.
import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import {
  apiJson,
  grantCompetitionPassSql,
  invalidateOrgEntitlements,
  planFlagSql,
  releaseSeededOrgSql,
  setOrgPlanBySql,
  withDb,
} from "../helpers";
import { sendEvent } from "../overlay-kit";
import { sponsorsUrl } from "../settings-support";
import { postSignedEvent, stripeEvent, stripeUid } from "../_stripe-events";
import { dealStatus, newDeal, newSponsor } from "../helpers/sponsor-deals";
import { FAKE_CONNECT_MS, POOL_SLOT_WAIT_MS, POLL_WAIT_MS, cycleMs, holdsStreamSlot, releaseStreamSlot, takeWholePool } from "../helpers/stream-slot-pool";
import {
  beatOk,
  composedSession,
  compositorPage,
  contractHeartbeatAiringsMax,
  disposeStandInPhones,
  endStandInSessions,
  previewPlan,
  relayPlan,
  seedStandInFixture,
  seedStandInOrg,
  type CompositorPage,
  type StandInFixture,
  type StandInOrg,
  type StandInSession,
  type StandInSessionRef,
} from "../helpers/sponsor-relay-standin";
import { OVERLAY_MOMENT_FOLD_MS, OVERLAY_MOMENT_HOLD_MS } from "../../src/components/overlay/moment-timing";
import { POLL_MS } from "../../src/components/public-site/match-centre/use-live-fixture";
import { SCENE_CAROUSEL_MS, SPONSOR_STYLE_BY_SIZE, type SponsorPlan, type SponsorPlanAiring } from "../../src/lib/sponsor-plan";
import { SPONSOR_TIER_WEIGHTS, type SponsorTier } from "../../src/lib/sponsor-tiers";

// --- the clocks (AGENTS.md #20): every wait is derived from the constant that sets its pace -----------------------------------
/** A navigation, and a tap or read, as the walkthrough README budgets them. */
const NAV_MS = 20_000;
const ACT_MS = 5_000;
/** What an org, its fixtures and its deals cost before the pool is asked for (stream-overlay.spec.ts's own allowance). */
const SEED_MS = 180_000;
/** From the plan serving a change until the page has caught up: one poll of its own (POLL_WAIT_MS is the compositor page's
 *  STREAM_POLL_MS plus slack), then the showing in flight ends and the next is drawn from the new list. */
const CATCH_UP_MS = POLL_WAIT_MS + SCENE_CAROUSEL_MS;
/** Showings after the catch-up that count as evidence of who is on the carousel when the roster is one card (two: one would pass by luck). */
const EVIDENCE_SHOWINGS = 2;
/** A window of the page's carousel in which `showings` cards start: after a change in the roster it first catches up (CATCH_UP_MS) -
 *  `settled` is a roster that has not changed, so nothing to catch up on - then a showing is SCENE_CAROUSEL_MS, plus a tap of slack. As
 *  many showings as the roster has cards reach each card once (the carousel is a fixed rotation, carouselStep). */
const lapMs = (showings: number, settled = false): number => (settled ? 0 : CATCH_UP_MS) + showings * SCENE_CAROUSEL_MS + ACT_MS;
/** A change in the stream: the write, the plan following it, the heartbeat. */
const CHANGE_MS = 2 * ACT_MS + POLL_WAIT_MS;
/** A break: the score event and the plan that carries its card (the writing poll). */
const BREAK_MS = POLL_WAIT_MS;
/** A change a journey proves a carousel window after: its writes (three at most), the plan, the window, the heartbeat. */
const evidenceStepMs = (showings: number): number => 3 * ACT_MS + POLL_WAIT_MS + lapMs(showings) + ACT_MS;
/** The live beat and the page. */
const START_MS = ACT_MS + NAV_MS;
/** The final heartbeat and its read. */
const END_MS = 2 * ACT_MS;
/** Each journey's STREAMING time after the session is up, from what it does (a volleyball best-of-five has at most four set ends that
 *  open a break). The first lap is a SETTLED one: a roster nothing has changed, shown once from the page's first showing. */
const JOURNEY_STREAM_MS = {
  free: START_MS + lapMs(3, true) + 3 * BREAK_MS + CHANGE_MS + evidenceStepMs(EVIDENCE_SHOWINGS) + CHANGE_MS + lapMs(2) + BREAK_MS + END_MS,
  pass: START_MS + lapMs(3, true) + 4 * BREAK_MS + CHANGE_MS + evidenceStepMs(EVIDENCE_SHOWINGS) + CHANGE_MS + lapMs(2) + END_MS,
  pro: START_MS + CHANGE_MS + lapMs(4) + 2 * BREAK_MS + CHANGE_MS + evidenceStepMs(3) + 2 * BREAK_MS + END_MS,
  plan: START_MS + lapMs(3, true) + 2 * CHANGE_MS + evidenceStepMs(EVIDENCE_SHOWINGS) + CHANGE_MS + lapMs(3) + END_MS,
} as const;
/** The longest journey: the most a test of this file holds the pool after the session is up. The pool's limit is POOL_HOLD_CYCLES cycles
 *  and the session's own create-to-stop cycle is one of them, so this must stay under the other five: at CI's 10 s connect delay (set on
 *  the server and on the Playwright step alike) that is 5 x 55 s. A LOCAL run at the default delay has a smaller limit, and
 *  takeWholePool refuses it by name - set FAKE_INGEST_CONNECT_AFTER_MS=10000 as CI does. */
const STREAM_MS = Math.max(...Object.values(JOURNEY_STREAM_MS));
/** The longest this file holds the stream pool: the session's create-to-stop cycle, then the journey. */
const POOL_HOLD = { file: "sponsor-stream-matrix.spec.ts", holdMs: cycleMs(FAKE_CONNECT_MS) + STREAM_MS } as const;
/** What a journey does after the pool is let go: the Overview read (three reloads) and the reads around it. */
const AFTER_MS = 3 * NAV_MS + 5 * ACT_MS;
const JOURNEY_TIMEOUT_MS = SEED_MS + POOL_SLOT_WAIT_MS + POOL_HOLD.holdMs + AFTER_MS;
/** OBS's break card: a poll to reach the page (15 s, not the compositor's 5), the set's own moments ahead of it, the card's fold in.
 *  stream-overlay.spec.ts's "the break card on OBS" budget, from the same constants. */
const OBS_MOMENT_CYCLE_MS = OVERLAY_MOMENT_FOLD_MS * 2 + OVERLAY_MOMENT_HOLD_MS;
const OBS_CARD_MS = POLL_MS + 4 * OBS_MOMENT_CYCLE_MS + OVERLAY_MOMENT_FOLD_MS + 5_000;
/** What a chunk of airings stays under the contract's bound by (the bound is read off the vendored contract, not typed here). */
const AIRINGS_HEADROOM = 4;
/** Items one heartbeat may carry: the contract's own bound (`$defs/heartbeat` airings `maxItems`), less the headroom. */
const airingsPerBeat = (): number => {
  const perBeat = contractHeartbeatAiringsMax() - AIRINGS_HEADROOM;
  if (perBeat <= 0) throw new Error(`the contract bounds a heartbeat's airings at ${perBeat + AIRINGS_HEADROOM}, no more than the ${AIRINGS_HEADROOM} items of headroom a chunk keeps`);
  return perBeat;
};

/** The whole pool, taken before the phone pairs (a composed session reserves two matches of recording, R2004). */
const reserve = async () => {
  if (!holdsStreamSlot()) await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: 1 });
};

// Serial: the pool is the reason (each journey takes the WHOLE pool; two workers would only wait on each other for a hold), not
// a dependence. Every journey seeds an org of its own, so a red in one leaves the next nothing to inherit.
test.describe.configure({ mode: "serial" });

const sessions: StandInSessionRef[] = [];
const orgs: StandInOrg[] = [];

test.afterEach(async () => {
  try {
    await disposeStandInPhones();
  } finally {
    try {
      await endStandInSessions(sessions);
    } finally {
      await releaseStreamSlot();
    }
  }
});

test.afterAll(async () => {
  // Not `releaseStandInOrg`: it deletes the org's sponsors rows, and `sponsor_orders.sponsor_id` is `on delete restrict`, so an org
  // that holds deals could not be released that way. The org is soft-deleted, as releaseSeededOrgSql does.
  // One org's failed release must not leave the next one behind: each is tried, and the failures are named together at the end.
  const failed: string[] = [];
  for (const org of orgs) {
    try {
      await org.ctx.close().catch(() => {});
      await releaseSeededOrgSql(org.orgId, org.userId);
    } catch (error) {
      failed.push(`${org.orgSlug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  expect(failed, "every seeded org was released").toEqual([]);
});

// --- seeding, through the product ---------------------------------------------------------------------------------------------
async function seedOrg(browser: Browser, prefix: string): Promise<StandInOrg> {
  const org = await seedStandInOrg(browser, prefix);
  orgs.push(org);
  // As sponsors-journey.spec.ts: a seen product tour, so no modal covers the pages this journey opens.
  const tour = await org.page.request.post("/api/tour", { data: {} });
  expect(tour.status(), "setup: the tour is marked seen").toBeLessThan(300);
  return org;
}

/** The one sport and variant every journey streams (see the header for why one): the fixture is seeded on them and the break premise is read from them. */
const STREAM_SPORT = "volleyball";
const STREAM_VARIANT = "indoor";

const volleyball = (org: StandInOrg, label: string): Promise<StandInFixture> =>
  seedStandInFixture(org, { label: `${label} ${org.orgSlug}`, sportKey: STREAM_SPORT, variantKey: STREAM_VARIANT, home: `${label} Home VC`, away: `${label} Away VC` });

/** Seeded on Pro (a division and a fixture are not this journey's subject), then moved to `community` through the billing group, the
 *  way setOrgPlanBySql does it, and the entitlement cache dropped so the next read is the new plan's. */
async function downgrade(org: StandInOrg): Promise<void> {
  await setOrgPlanBySql({ orgId: org.orgId }, "community");
  await invalidateOrgEntitlements(org.page.request, org.orgId);
}

/** The way back to Pro: the billing group moved and the entitlement cache dropped, so the next read is Pro's. */
async function upgrade(org: StandInOrg): Promise<void> {
  await setOrgPlanBySql({ orgId: org.orgId }, "pro");
  await invalidateOrgEntitlements(org.page.request, org.orgId);
}

/** A package that puts its sponsor on the stream (`includes_on_stream`: the deal's snapshot ticks it, spec sponsor-deals D4). */
async function streamPackage(request: APIRequestContext, orgId: string, tier: SponsorTier, competitionId: string | null = null): Promise<string> {
  const res = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/sponsor-packages`, "POST", {
    name: `${tier} stream board${competitionId === null ? "" : " (one competition)"}`,
    price_cents: 25_000,
    currency: "gbp",
    tier,
    competition_id: competitionId,
    includes_on_stream: true,
  });
  expect(res.status, `a ${tier} stream package: ${JSON.stringify(res.error)}`).toBe(201);
  return res.data!.id;
}

/** A write the plan refuses (402), and the feature the refusal names (the envelope's `feature_key`, which `apiJson` drops). */
async function refused(request: APIRequestContext, path: string, body: unknown): Promise<{ status: number; featureKey: string | undefined }> {
  const res = await request.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, data: body, maxRetries: 1 });
  const json = (await res.json().catch(() => ({}))) as { error?: { feature_key?: string } };
  return { status: res.status(), featureKey: json.error?.feature_key };
}

async function expectTiersRefused(request: APIRequestContext, orgId: string, tier: SponsorTier, competitionId: string | null, why: string): Promise<void> {
  const res = await refused(request, `/api/v1/orgs/${orgId}/sponsor-packages`, {
    name: `refused ${tier}`, price_cents: 25_000, currency: "gbp", tier, competition_id: competitionId, includes_on_stream: true,
  });
  expect(res, `${why}: refused, naming the feature`).toEqual({ status: 402, featureKey: "sponsors.tiers" });
}

async function payByHand(request: APIRequestContext, orgId: string, dealId: string, why: string): Promise<void> {
  const res = await apiJson<{ deal_status: string; payment_status: string }>(request, `/api/v1/orgs/${orgId}/sponsor-deals/${dealId}/mark-paid`, "POST");
  expect(res.status, `${why}: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data, why).toMatchObject({ deal_status: "live", payment_status: "paid" });
}

async function endNow(request: APIRequestContext, orgId: string, dealId: string, why: string): Promise<void> {
  const res = await apiJson<{ deal_status: string }>(request, `/api/v1/orgs/${orgId}/sponsor-deals/${dealId}/end`, "POST");
  expect(res.status, `${why}: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data?.deal_status, `${why}: the deal is ended`).toBe("ended");
}

async function tick(request: APIRequestContext, orgId: string, sponsorId: string, why: string): Promise<void> {
  const res = await apiJson<{ on_stream: boolean }>(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}`, "PATCH", { on_stream: true });
  expect(res.status, `${why}: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data?.on_stream, why).toBe(true);
}

async function archive(request: APIRequestContext, orgId: string, sponsorId: string, why: string): Promise<void> {
  const res = await apiJson<{ archived_at: string | null }>(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/archive`, "POST");
  expect(res.status, `${why}: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data?.archived_at, `${why}: archived`).not.toBeNull();
}

async function unarchive(request: APIRequestContext, orgId: string, sponsorId: string, why: string): Promise<void> {
  const res = await apiJson<{ archived_at: string | null }>(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/archive`, "DELETE");
  expect(res.status, `${why}: ${JSON.stringify(res.error)}`).toBe(200);
  expect(res.data?.archived_at, `${why}: back`).toBeNull();
}

/** The archive a LIVE deal's sponsor is refused (409), with its pair - the sponsor stays unarchived. */
async function expectArchiveRefused(request: APIRequestContext, orgId: string, sponsorId: string, why: string): Promise<void> {
  const res = await apiJson(request, `/api/v1/orgs/${orgId}/sponsors/${sponsorId}/archive`, "POST");
  expect(res.status, `${why}: a sponsor holding a live deal is not archived`).toBe(409);
  const [row] = await withDb((sql) => sql<{ archived: boolean }[]>`select archived_at is not null as archived from sponsors where id = ${sponsorId}`);
  expect(row?.archived, `${why}: and it is still unarchived`).toBe(false);
}

// --- the rotation, as a declaration says it ------------------------------------------------------------------------------------
/** The size-major break the sport's engine module declares (the kind a set's end opens): never a name typed here. */
function declaredMajorBreak(sport: string): string {
  const kind = builtinModules.find((m) => m.key === sport)?.naturalBreaks?.kinds.find((k) => k.size === "major")?.kind;
  if (kind === undefined) throw new Error(`${sport} declares no major natural break`);
  return kind;
}

/** The most set ends of `sport`'s `variant` that can each open a major break while the match is undecided, from the engine's own
 *  declaration: the longest reachable result (`reachableSetScores`, "3-2" for a best-of-five) is decided by its LAST set, which opens no
 *  break, so it is one fewer than the sets that result takes. */
function maxMajorBreaks(sport: string, variant: string): number {
  const mod = builtinModules.find((m) => m.key === sport);
  if (mod?.reachableSetScores === undefined) throw new Error(`${sport} declares no reachable set scores`);
  const overrides = mod.variants[variant];
  if (overrides === undefined) throw new Error(`${sport} declares no variant ${variant}`);
  const sets = mod.reachableSetScores(mod.configSchema.parse(overrides)).map((score) => score.split("-").reduce((sum, side) => sum + Number(side), 0));
  if (sets.length === 0) throw new Error(`${sport} (${variant}) declares no reachable set score`);
  return Math.max(...sets) - 1;
}

/** The premise of a journey that opens `needed` set-end breaks: the fixture can open that many. A fixture that cannot would fail on a
 *  break that never comes, which reads as a rotation defect - so the arithmetic is refused here, by name. */
function expectBreaksAvailable(needed: number, why: string): void {
  const available = maxMajorBreaks(STREAM_SPORT, STREAM_VARIANT);
  expect(needed, `premise: ${why} opens breaks (anti-vacuity)`).toBeGreaterThan(0);
  expect(needed, `premise: ${why} needs ${needed} set-end breaks, but a ${STREAM_SPORT} (${STREAM_VARIANT}) match can open at most ${available} while it is undecided`).toBeLessThanOrEqual(available);
}

/** A FULL cycle of the rotation: as many consecutive breaks as the roster's tier weights sum to (SPONSOR_TIER_WEIGHTS, the declaration). */
const breaksInCycle = (roster: Roster): number => Object.values(roster).reduce((sum, tier) => sum + SPONSOR_TIER_WEIGHTS[tier], 0);

/** Who wins set `n` (0-based): the sides alternate, so a best-of-five stays undecided through its four set ends (2-2). */
const winnerAt = (n: number): "home" | "away" => (n % 2 === 0 ? "home" : "away");

type Roster = Record<string, SponsorTier>;

/** The ticked cards a plan serves, by sponsor, with the tier each is served at. `plan.cards` also carries an unticked card an airing
 *  still names (`onStream: false`): that one is not on the rotation or the carousel, so it is not on the roster. */
function rosterOf(plan: SponsorPlan): Roster {
  return plan === null ? {} : Object.fromEntries(plan.cards.filter((c) => c.onStream).map((c) => [c.sponsorId, c.tier]));
}

/** EVERY card a plan carries, ticked or not, with the tier it is served at - the roster's unfiltered twin. */
function cardTiersOf(plan: SponsorPlan): Roster {
  return plan === null ? {} : Object.fromEntries(plan.cards.map((c) => [c.sponsorId, c.tier]));
}

/** `sponsors.tier` of the given sponsors: the stored tier the planner reads, and flattens AT THE READ when the plan has no `sponsors.tiers`. */
async function tierRows(orgId: string, ids: readonly string[]): Promise<Roster> {
  const rows = await withDb((sql) => sql<{ id: string; tier: SponsorTier }[]>`select id, tier from sponsors where org_id = ${orgId}`);
  return Object.fromEntries(rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r.tier]));
}

// --- the stream under test ---------------------------------------------------------------------------------------------------
interface Rig {
  org: StandInOrg;
  fx: StandInFixture;
  s: StandInSession;
  cef: CompositorPage;
  /** The page's console index the heartbeats have carried up to. */
  cursor: number;
  /** The test's own tally of the start lines it has posted, by sponsor: what `sponsor_airings` and Times shown must read. */
  aired: Map<string, number>;
  /** The sponsor behind each card id the stream's plans have carried (`plan.cards`: card.id -> card.sponsorId), as stream-matrix.test.ts
   *  maps it: the page and an airing name CARDS, and a card id is not assumed to be its sponsor's id. */
  sponsorOfCard: Map<string, string>;
}

function learnCards(rig: Rig, plan: SponsorPlan): void {
  for (const card of plan?.cards ?? []) rig.sponsorOfCard.set(card.id, card.sponsorId);
}

/** The sponsors behind the card ids the page named. A card the rig has not met is looked up on the live plan once; one that no plan
 *  carries is refused by name (an airing that cannot be attributed proves nothing). */
async function sponsorsOfCards(rig: Rig, cardIds: readonly string[]): Promise<string[]> {
  if (cardIds.some((id) => !rig.sponsorOfCard.has(id))) learnCards(rig, await relayPlan(rig.s));
  return cardIds.map((id) => {
    const sponsorId = rig.sponsorOfCard.get(id);
    if (sponsorId === undefined) throw new Error(`the page named card ${id}, which no plan this stream served carries`);
    return sponsorId;
  });
}

/** A composed session on the fixture, the compositor's page on Starting soon (its carousel airs the ticked cards), and a beat that
 *  reports `live`: a session that never reports it is cancelled 60 s after going live on CI (`composedNeverLive`,
 *  PHONE_LOST_LIVE_MINUTES=1), and the page is held on Starting soon so that its showings keep coming. */
async function withStream(browser: Browser, org: StandInOrg, fx: StandInFixture, body: (rig: Rig) => Promise<void>): Promise<void> {
  const s = await composedSession(org, fx, reserve, sessions);
  const cef = await compositorPage(browser, s, "waiting");
  try {
    await beatOk(s, { state: "playing", programmePhase: "live" }, "the first beat, reporting live");
    await body({ org, fx, s, cef, cursor: 0, aired: new Map(), sponsorOfCard: new Map() });
  } finally {
    await cef.context.close().catch(() => {});
  }
}

const airedInDb = async (orgId: string): Promise<Record<string, number>> =>
  Object.fromEntries(
    (await withDb((sql) => sql<{ sponsor_id: string | null; n: number }[]>`
      select sponsor_id, count(*)::int as n from sponsor_airings where org_id = ${orgId} group by sponsor_id`)).map((r) => [String(r.sponsor_id), r.n]),
  );

/** The page's lines since the last beat, as a heartbeat: tallied by the test, sent in chunks, and `sponsor_airings` read back and
 *  compared to the tally - the heartbeat after a change, and the proof it recorded exactly what the page showed. */
async function flush(rig: Rig, what: string): Promise<void> {
  const upto = rig.cef.mark();
  const lines = rig.cef.sponsorLines(rig.cursor).filter((l) => l.at < upto);
  rig.cursor = upto;
  const starts = lines.filter((l) => l.kind === "start");
  for (const sponsorId of await sponsorsOfCards(rig, starts.map((l) => String(l.json.cardId)))) rig.aired.set(sponsorId, (rig.aired.get(sponsorId) ?? 0) + 1);
  const airings = lines.map((l) => l.airing);
  if (airings.length === 0) await beatOk(rig.s, { state: "playing", programmePhase: "live" }, `${what}: the heartbeat (nothing new on the page)`);
  const perBeat = airingsPerBeat();
  for (let i = 0; i < airings.length; i += perBeat) {
    await beatOk(rig.s, { state: "playing", programmePhase: "live", airings: airings.slice(i, i + perBeat) }, `${what}: the heartbeat carrying the page's showings`);
  }
  const want = Object.fromEntries([...rig.aired].filter(([, n]) => n > 0));
  expect(await airedInDb(rig.org.orgId), `${what}: sponsor_airings is exactly what the page showed and the heartbeats carried`).toEqual(want);
}

/** The plan the stream serves, polled until its roster (ticked sponsors and the tiers they are served at) is `want`. Returns the
 *  moment it was first seen: the carousel's evidence is measured from it. */
async function expectRoster(read: () => Promise<SponsorPlan>, want: Roster, message: string): Promise<number> {
  await expect.poll(async () => rosterOf(await read()), { message, timeout: POLL_WAIT_MS }).toEqual(want);
  return Date.now();
}

const sceneShowings = (cef: CompositorPage, sinceMs: number) =>
  cef.sponsorLines().filter((l) => l.kind === "start" && l.json.source === "scene" && Date.parse(String(l.json.at)) >= sinceMs);

/** Who is on the carousel after a change: once the page has caught up, as many showings as the roster has cards (at least
 *  EVIDENCE_SHOWINGS) are shown - the carousel is a fixed rotation, so that is a lap - and every sponsor of `onAir` is among them
 *  and none else. The count first (anti-vacuity: a page that showed nothing proves nothing). Not for a roster that did not change: that
 *  is `expectAiredOnPage`. */
async function expectCarousel(rig: Rig, changedAt: number, onAir: readonly string[], message: string): Promise<void> {
  const since = changedAt + CATCH_UP_MS;
  const showings = Math.max(EVIDENCE_SHOWINGS, onAir.length);
  await expect
    .poll(() => sceneShowings(rig.cef, since).length, { message: `${message}: the page showed ${showings} carousel cards once it had caught up`, timeout: lapMs(showings) })
    .toBeGreaterThanOrEqual(showings);
  const shown = new Set(await sponsorsOfCards(rig, sceneShowings(rig.cef, since).map((l) => String(l.json.cardId))));
  expect([...shown].filter((id) => !onAir.includes(id)), `${message}: carousel cards of sponsors that must not air`).toEqual([]);
  expect(onAir.filter((id) => !shown.has(id)), `${message}: sponsors on the roster that the carousel did not show in a lap`).toEqual([]);
}

/** Before anything changes: every sponsor ticked onto the stream has had a carousel showing on the page, counted from the page's first
 *  showing. This is the positive pair of every later absence - a sponsor that leaves HAD aired - and the first lap of the rotation. */
async function expectAiredOnPage(rig: Rig, ids: readonly string[], message: string): Promise<void> {
  const shown = async () => new Set(await sponsorsOfCards(rig, sceneShowings(rig.cef, 0).map((l) => String(l.json.cardId))));
  await expect
    .poll(async () => { const seen = await shown(); return ids.filter((id) => !seen.has(id)); }, { message: `${message}: a carousel showing for every ticked sponsor`, timeout: lapMs(ids.length, true) })
    .toEqual([]);
}

interface BreakPick {
  momentId: string;
  position: number;
  sponsorId: string;
}

/** One set ends (a major natural break): the plan that carries its card is read until it names it, the position the database wrote
 *  for it is read back, and the sponsor it went to is checked to be one of the ticked cards the plan served at that moment. WHICH of
 *  them is not asserted per break (equal weights tie in the planner's own order, which nothing declares): the share is asserted over
 *  a full cycle (expectFullCycle), and the positions over a journey. */
async function openBreak(rig: Rig, winner: "home" | "away", message: string): Promise<BreakPick> {
  const known = new Set((await relayPlan(rig.s))?.airings.map((a) => a.momentId) ?? []);
  await sendEvent(rig.org.page.request, rig.fx.fixtureId, "volleyball.set.summary", winner === "home" ? { home: 25, away: 20 } : { home: 20, away: 25 });
  const got: { airing?: SponsorPlanAiring; cards?: string[] } = {};
  await expect
    .poll(
      async () => {
        const plan = await relayPlan(rig.s);
        const airing = plan?.airings.find((a) => !known.has(a.momentId));
        if (plan === null || airing === undefined) return "no new airing yet";
        got.airing = airing;
        learnCards(rig, plan);
        got.cards = plan.cards.filter((c) => c.onStream).map((c) => c.id);
        return airing.breakKind;
      },
      { message: `${message}: the plan carries the set's break card`, timeout: POLL_WAIT_MS },
    )
    .toBe(declaredMajorBreak(STREAM_SPORT));
  const airing = got.airing!;
  const cards = got.cards!;
  expect(airing, `${message}: a major break airs a banner for its declared hold`).toMatchObject(SPONSOR_STYLE_BY_SIZE.major);
  const [row] = await withDb((sql) => sql<{ position: number | null; source: string }[]>`
    select position, source from sponsor_assignments where fixture_id = ${rig.fx.fixtureId} and moment_id = ${airing.momentId}`);
  expect(row, `${message}: the break's assignment was written`).toBeDefined();
  expect(row!.source, `${message}: by the rotation`).toBe("rotation");
  expect(row!.position, `${message}: at a position`).not.toBeNull();
  expect(cards, `${message}: the card dealt is one of the ${cards.length} ticked cards`).toContain(airing.cardId);
  const [sponsorId] = await sponsorsOfCards(rig, [airing.cardId]);
  return { momentId: airing.momentId, position: row!.position!, sponsorId: sponsorId! };
}

/** The positions the database wrote run consecutively from 0 (assign.ts: max + 1, none = 0) - only for an org whose first break this is,
 *  which each journey guards before it opens one. A stuck position repeats a card; a skipped one hands a break to nobody. */
function expectPositionsFromZero(picks: readonly BreakPick[], message: string): void {
  expect(picks.length, `${message}: anti-vacuity - positions were read`).toBeGreaterThan(0);
  expect(picks.map((p) => p.position), `${message}: strictly consecutive positions, from 0`).toEqual(picks.map((_, i) => i));
}

/** A FULL cycle: as many consecutive breaks as the weights sum to, so every card holds exactly its weight - read off the declaration,
 *  with no rotation algorithm in the expectation. */
function expectFullCycle(picks: readonly BreakPick[], roster: Roster, message: string): void {
  const total = breaksInCycle(roster);
  expect(picks.length, `${message}: one break per unit of weight`).toBe(total);
  expectPositionsFromZero(picks, message);
  const held = Object.fromEntries(Object.keys(roster).map((id) => [id, picks.filter((p) => p.sponsorId === id).length]));
  const weights = Object.fromEntries(Object.entries(roster).map(([id, tier]) => [id, SPONSOR_TIER_WEIGHTS[tier]]));
  expect(held, `${message}: each sponsor held exactly its tier's weight of the cycle`).toEqual(weights);
}

/** The Overview, in the browser: Times shown per sponsor, after a reload until it reads what was recorded. */
async function expectOverview(org: StandInOrg, want: Record<string, number>, message: string): Promise<void> {
  const times = (id: string) => org.page.getByTestId(`sponsor-overview-row-${id}`).getByTestId("sponsor-overview-times");
  await expect
    .poll(
      async () => {
        await org.page.goto(sponsorsUrl(org.orgSlug, "overview"));
        const read: Record<string, string> = {};
        for (const id of Object.keys(want)) read[id] = (await times(id).textContent({ timeout: ACT_MS }).catch(() => null))?.trim() ?? "no row";
        return read;
      },
      { message, timeout: 3 * NAV_MS, intervals: [1_000, 2_000, 4_000] },
    )
    .toEqual(Object.fromEntries(Object.entries(want).map(([id, n]) => [id, String(n)])));
}

/** What every journey ends with: the last showings beaten in, then every sponsor that was ever on the roster has aired and been
 *  recorded - the leavers among them (their absence means something only because they were shown) - and nobody else has. */
async function finish(rig: Rig, sponsors: readonly string[], what: string): Promise<void> {
  await flush(rig, `${what}: the last showings`);
  expect(sponsors.length, `${what}: anti-vacuity - sponsors were named`).toBeGreaterThan(0);
  expect(sponsors.filter((id) => (rig.aired.get(id) ?? 0) === 0), `${what}: sponsors that were on the stream and never aired`).toEqual([]);
  expect([...rig.aired.keys()].filter((id) => !sponsors.includes(id)), `${what}: only sponsors of this club aired`).toEqual([]);
}

async function endAndReadOverview(rig: Rig, sponsors: readonly string[], what: string): Promise<void> {
  await rig.cef.context.close().catch(() => {});
  await endStandInSessions(sessions);
  await releaseStreamSlot();
  await expectOverview(rig.org, Object.fromEntries(sponsors.map((id) => [id, rig.aired.get(id) ?? 0])), `${what}: Times shown on the Overview is what the heartbeats recorded, per sponsor`);
}

// =====================================================================================================================
// O1 — OBS: the card shows, nothing is recorded
// =====================================================================================================================
test("O1 OBS, no compositor: the break card shows on the page and NOTHING is recorded - Times shown stays 0 (today's behaviour, spec Why 3)", async ({ browser }) => {
  test.setTimeout(SEED_MS + OBS_CARD_MS + 3 * NAV_MS + 5 * ACT_MS);
  const org = await seedOrg(browser, "ssm-obs");
  const fx = await volleyball(org, "Obs");
  const api = org.page.request;
  const names = [`Obs Harbour Timber ${org.orgSlug}`, `Obs Ridge Cycles ${org.orgSlug}`];
  const ids: string[] = [];
  for (const name of names) {
    const id = await newSponsor(api, org.orgId, name);
    await tick(api, org.orgId, id, `${name} ticked onto the stream`);
    ids.push(id);
  }
  const viewer = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const anon = await viewer.newPage();
    await anon.goto(`/overlay/fixtures/${fx.fixtureId}?style=bar`);
    await expect(anon.getByTestId("ovl-side-home"), "the overlay page drew the match").toBeVisible({ timeout: NAV_MS });
    expect(await anon.getByTestId("ovl-sponsor-card").count(), "no card before a set ends").toBe(0);
    await sendEvent(api, fx.fixtureId, "volleyball.set.summary", { home: 25, away: 20 });
    const card = anon.getByTestId("ovl-sponsor-card");
    await expect(card, "the set's end airs a sponsor card on the OBS page").toHaveAttribute("data-phase", "hold", { timeout: OBS_CARD_MS });
    await expect(card, "the card is one of the ticked sponsors").toContainText(new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
  } finally {
    await viewer.close();
  }
  // Not vacuous: the break WAS assigned (the OBS page's own poll wrote it), and still nothing was recorded as aired.
  const [assigned] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from sponsor_assignments where org_id = ${org.orgId}`);
  expect(assigned?.n, "the break was handed a card").toBe(1);
  const [recorded] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from sponsor_airings where org_id = ${org.orgId}`);
  expect(recorded?.n, "no airing is recorded without a composed heartbeat").toBe(0);
  await expectOverview(org, Object.fromEntries(ids.map((id) => [id, 0])), "OBS: Times shown stays 0 for every sponsor");
});

// =====================================================================================================================
// J1 — Free (community)
// =====================================================================================================================
test("J1 Free: partner-only deals reach the composed stream and air, a queued deal takes over mid-stream, a deal ends and a sponsor is archived, the archived sponsor returns and airs again", async ({ browser }) => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const org = await seedOrg(browser, "ssm-free");
  const fx = await volleyball(org, "Free");
  await downgrade(org);
  const api = org.page.request;
  const o = org.orgId;
  expect(await planFlagSql("sponsors.tiers", "community"), "premise: Free has no sponsors.tiers").toBe(false);

  // The plan refuses what Free cannot place - and takes the same call one cell over.
  await expectTiersRefused(api, o, "gold", null, "Free: a gold package");
  await expectTiersRefused(api, o, "partner", fx.competitionId, "Free: a package scoped to one competition");
  const goldSponsor = await refused(api, `/api/v1/orgs/${o}/sponsors`, { name: "Refused Gold", url: "https://refused.example/", tier: "gold" });
  expect(goldSponsor, "Free: a gold sponsor by hand is refused, naming the feature").toEqual({ status: 402, featureKey: "sponsors.tiers" });
  const partnerPkg = await streamPackage(api, o, "partner");

  // Three partners: a deal paid by hand (with a queued successor), a complimentary deal, a hand-ticked sponsor.
  const fa = await newSponsor(api, o, "Fern Auto Repairs");
  const fb = await newSponsor(api, o, "Fell Bakery");
  const fh = await newSponsor(api, o, "Fox Hardware");
  const faFirst = await newDeal(api, o, fa, { package_id: partnerPkg });
  expect(await dealStatus(api, o, faFirst), "premise: unpaid, so not live").toBe("awaiting_payment");
  await payByHand(api, o, faFirst, "Fern's deal marked paid");
  const faNext = await newDeal(api, o, fa, { package_id: partnerPkg, go_live: "immediate" });
  expect(await dealStatus(api, o, faNext), "premise: behind the live deal, so queued").toBe("scheduled");
  const fbDeal = await newDeal(api, o, fb, { package_id: partnerPkg, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(api, o, fbDeal), "premise: a complimentary deal goes live at once").toBe("live");
  await tick(api, o, fh, "Fox ticked by hand");
  const all = [fa, fb, fh];

  await withStream(browser, org, fx, async (rig) => {
    const three: Roster = { [fa]: "partner", [fb]: "partner", [fh]: "partner" };
    await expectRoster(() => relayPlan(rig.s), three, "Free: the plan serves the three partners");
    const [fresh] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from sponsor_assignments where org_id = ${o}`);
    expect(fresh?.n, "guard: a fresh org has handed no break a card, so the rotation starts clean").toBe(0);
    // Before anything changes all three air: what Fell and Fox are shown to be when they leave below.
    await expectAiredOnPage(rig, all, "Free: before the changes");

    // One whole cycle (weights 1+1+1): as many breaks as the weights sum to, one card each - and the break after the changes below.
    const cycle = breaksInCycle(three);
    expectBreaksAvailable(cycle + 1, "Free: the cycle and the break after the changes");
    const picks: BreakPick[] = [];
    for (let n = 0; n < cycle; n++) picks.push(await openBreak(rig, winnerAt(n), `Free: break ${n + 1}`));
    expectFullCycle(picks, three, "Free: the first cycle");
    await flush(rig, "Free: after the first cycle");

    // Change 1: Fern's paid deal ends; the queued one takes over. A STABILITY check, not a movement: the same sponsor stays on air
    // at the same tier, so the roster before and after is identical - what moved is the deal behind it, read through its status.
    await expectArchiveRefused(api, o, fa, "Free: Fern holds a live deal");
    await endNow(api, o, faFirst, "Free: Fern's live deal ends");
    expect(await dealStatus(api, o, faFirst), "Fern's first deal is ended").toBe("ended");
    expect(await dealStatus(api, o, faNext), "the queued deal is live now").toBe("live");
    await expectRoster(() => relayPlan(rig.s), three, "Free: stability - Fern is still on the plan under its second deal, and so are the others");
    await flush(rig, "Free: after the queued deal went live");

    // Change 2: a complimentary deal ends and a hand-ticked sponsor is archived: both leave the stream. The page's carousel follows.
    await endNow(api, o, fbDeal, "Free: Fell's complimentary deal ends");
    await archive(api, o, fh, "Free: Fox archived (no deal to hold it)");
    const left = await expectRoster(() => relayPlan(rig.s), { [fa]: "partner" }, "Free: only Fern is left on the plan");
    await flush(rig, "Free: after Fell and Fox left");
    await expectCarousel(rig, left, [fa], "Free: after Fell ended and Fox was archived");

    // Change 3: Fox comes back exactly as it was and airs again; the next break is dealt over the two cards now on the plan.
    await unarchive(api, o, fh, "Free: Fox unarchived");
    const back = await expectRoster(() => relayPlan(rig.s), { [fa]: "partner", [fh]: "partner" }, "Free: Fern and Fox are on the plan");
    await flush(rig, "Free: after Fox returned");
    await expectCarousel(rig, back, [fa, fh], "Free: after Fox returned - Fox is on the carousel again");
    const afterChanges = await openBreak(rig, winnerAt(picks.length), "Free: the break after the changes");
    expectPositionsFromZero([...picks, afterChanges], "Free: the break after the changes carries the positions on");
    await flush(rig, "Free: after the break after the changes");
    await finish(rig, all, "Free");
    await endAndReadOverview(rig, all, "Free");
  });
});

// =====================================================================================================================
// J2 — Pass (a competition pass on competition A only)
// =====================================================================================================================
test("J2 Pass: a gold deal scoped to the pass competition is served as gold on it and is absent from the other competition's plan preview; deals change mid-stream and the returning sponsor airs again", async ({ browser }) => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const org = await seedOrg(browser, "ssm-pass");
  const fxA = await volleyball(org, "Pass A");
  const fxB = await volleyball(org, "Pass B");
  await downgrade(org);
  await grantCompetitionPassSql(org.orgId, fxA.competitionId, "event_pass", org.page.request);
  const api = org.page.request;
  const o = org.orgId;
  expect(await planFlagSql("sponsors.tiers", "community"), "premise: the plan itself has no sponsors.tiers").toBe(false);
  expect(await planFlagSql("sponsors.tiers", "event_pass"), "premise: a competition pass has it").toBe(true);

  // A pass lifts ITS competition only: refused anywhere else, taken on A.
  await expectTiersRefused(api, o, "gold", null, "Pass: an org-wide gold package");
  await expectTiersRefused(api, o, "gold", fxB.competitionId, "Pass: a gold package scoped to the OTHER competition");
  await expectTiersRefused(api, o, "partner", fxB.competitionId, "Pass: a partner package scoped to the OTHER competition");
  // The positive pair of those refusals: the same gold call, scoped to the pass competition, is taken.
  const goldA = await streamPackage(api, o, "gold", fxA.competitionId);
  const partnerA = await streamPackage(api, o, "partner", fxA.competitionId);
  const partnerAll = await streamPackage(api, o, "partner");

  const pg = await newSponsor(api, o, "Pike Gold Garage");
  const pp = await newSponsor(api, o, "Pine Pharmacy");
  const ph = await newSponsor(api, o, "Plover Hire");
  const pgFirst = await newDeal(api, o, pg, { package_id: goldA, competition_id: fxA.competitionId });
  await payByHand(api, o, pgFirst, "Pike's gold deal marked paid");
  const pgNext = await newDeal(api, o, pg, { package_id: partnerA, competition_id: fxA.competitionId, go_live: "immediate" });
  expect(await dealStatus(api, o, pgNext), "premise: the partner deal queues behind the gold one").toBe("scheduled");
  const ppDeal = await newDeal(api, o, pp, { package_id: partnerAll, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(api, o, ppDeal), "premise: live at once").toBe("live");
  await tick(api, o, ph, "Plover ticked by hand");
  const all = [pg, pp, ph];

  await withStream(browser, org, fxA, async (rig) => {
    const onA: Roster = { [pg]: "gold", [pp]: "partner", [ph]: "partner" };
    await expectRoster(() => relayPlan(rig.s), onA, "Pass: on the pass competition the gold deal airs as gold");
    // The other competition's plan: the gold deal is scoped to A, so it is not there; the org-wide partners are.
    const onB = () => previewPlan(api, fxB.fixtureId);
    await expectRoster(onB, { [pp]: "partner", [ph]: "partner" }, "Pass: on the OTHER competition's plan preview the gold sponsor is absent");
    const [fresh] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from sponsor_assignments where org_id = ${o}`);
    expect(fresh?.n, "guard: a fresh org has handed no break a card (the preview above wrote none)").toBe(0);
    // Before anything changes all three air on A's stream: what Pine and Plover are shown to be when they leave below.
    await expectAiredOnPage(rig, all, "Pass: before the changes");

    // One whole cycle (weights 2+1+1): as many breaks as the weights sum to, before the first change.
    const cycle = breaksInCycle(onA);
    expectBreaksAvailable(cycle, "Pass: the cycle");
    const picks: BreakPick[] = [];
    for (let n = 0; n < cycle; n++) picks.push(await openBreak(rig, winnerAt(n), `Pass: break ${n + 1}`));
    expectFullCycle(picks, onA, "Pass: the cycle");
    await flush(rig, "Pass: after the cycle");

    // Change 1: the gold deal ends; the queued partner deal takes over - the same sponsor, now a partner (a lighter weight).
    await expectArchiveRefused(api, o, pg, "Pass: Pike holds a live deal");
    await endNow(api, o, pgFirst, "Pass: Pike's gold deal ends");
    expect(await dealStatus(api, o, pgNext), "the queued deal is live").toBe("live");
    await expectRoster(() => relayPlan(rig.s), { [pg]: "partner", [pp]: "partner", [ph]: "partner" }, "Pass: Pike is now served as a partner");
    await expectRoster(onB, { [pp]: "partner", [ph]: "partner" }, "Pass: the other competition's plan did not move");
    await flush(rig, "Pass: after the gold deal ended");

    // Change 2: a complimentary deal ends, a hand-ticked sponsor is archived. Nothing but Pike airs; the other competition's preview has no plan.
    await endNow(api, o, ppDeal, "Pass: Pine's deal ends");
    await archive(api, o, ph, "Pass: Plover archived");
    const left = await expectRoster(() => relayPlan(rig.s), { [pg]: "partner" }, "Pass: only Pike is left on the pass competition");
    await expectRoster(onB, {}, "Pass: the other competition's preview has no sponsor left, so no plan");
    await flush(rig, "Pass: after Pine ended and Plover was archived");
    await expectCarousel(rig, left, [pg], "Pass: after Pine ended and Plover was archived");

    // Change 3: Plover returns and airs again.
    await unarchive(api, o, ph, "Pass: Plover unarchived");
    const back = await expectRoster(() => relayPlan(rig.s), { [pg]: "partner", [ph]: "partner" }, "Pass: Pike and Plover are on the pass competition");
    await expectRoster(onB, { [ph]: "partner" }, "Pass: Plover is on the other competition's preview too (org-wide)");
    await flush(rig, "Pass: after Plover returned");
    await expectCarousel(rig, back, [pg, ph], "Pass: after Plover returned - Plover is on the carousel again");
    await finish(rig, all, "Pass");
    await endAndReadOverview(rig, all, "Pass");
  });
});

// =====================================================================================================================
// J3 — Pro
// =====================================================================================================================
test("J3 Pro: every tier and payment type on one stream - a paid-online deal goes live mid-stream and airs, a gold deal hands over to its silver successor, an unpaid deal expires and is written off", async ({ browser }) => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const org = await seedOrg(browser, "ssm-pro");
  const fx = await volleyball(org, "Pro");
  const api = org.page.request;
  const o = org.orgId;
  expect(await planFlagSql("sponsors.tiers", "pro"), "premise: Pro has sponsors.tiers").toBe(true);

  const pkg = {
    title: await streamPackage(api, o, "title"),
    gold: await streamPackage(api, o, "gold"),
    silver: await streamPackage(api, o, "silver"),
    partner: await streamPackage(api, o, "partner"),
  };
  const t = await newSponsor(api, o, "Tarn Title Motors");
  const g = await newSponsor(api, o, "Gale Gold Estates");
  const s = await newSponsor(api, o, "Sable Silver Print");
  const q = await newSponsor(api, o, "Quarry Quick Lets");
  const tDeal = await newDeal(api, o, t, { package_id: pkg.title, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(api, o, tDeal), "premise: the title deal is live").toBe("live");
  const gGold = await newDeal(api, o, g, { package_id: pkg.gold });
  await payByHand(api, o, gGold, "Gale's gold deal marked paid");
  const gSilver = await newDeal(api, o, g, { package_id: pkg.silver, go_live: "immediate" });
  expect(await dealStatus(api, o, gSilver), "premise: the silver deal queues behind the gold one").toBe("scheduled");
  // Quarry's deal goes live at once and is never paid: the unpaid-and-expired state a write-off is for.
  const qDeal = await newDeal(api, o, q, { package_id: pkg.partner, go_live: "immediate" });
  expect(await dealStatus(api, o, qDeal), "premise: live, unpaid").toBe("live");
  // Sable's ONLINE deal, pending: SQL-seeded the way Send invoice leaves one (a CI server has no Connect to sell online through),
  // its sponsor hidden until it is paid. The payment below is the signed webhook, the route Stripe itself calls.
  const sDeal = await withDb(async (sql) => {
    const [made] = await sql<{ id: string }[]>`
      insert into sponsor_orders (org_id, package_id, sponsor_id, sponsor_name, sponsor_email, amount_cents, currency, status,
                                  deal_status, payment_method, go_live, tier, includes_on_stream, package_name, competition_id)
      values (${o}, ${pkg.silver}, ${s}, 'Sable Silver Print', 'pay@deals.e2e.test', 25000, 'gbp', 'pending',
              'awaiting_payment', 'online', 'on_payment', 'silver', true, 'silver stream board', ${null})
      returning id`;
    await sql`update sponsors set status = 'inactive' where id = ${s}`;
    return made!.id;
  });
  const all = [t, g, s, q];

  await withStream(browser, org, fx, async (rig) => {
    const start: Roster = { [t]: "title", [g]: "gold", [q]: "partner" };
    await expectRoster(() => relayPlan(rig.s), start, "Pro: every tier airs at its own tier; Sable (unpaid, online) is not on the plan yet");
    const [fresh] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from sponsor_assignments where org_id = ${o}`);
    expect(fresh?.n, "guard: a fresh org has handed no break a card, so the rotation starts clean").toBe(0);

    // Change 1: Sable's invoice is paid ONLINE while the stream is live (the signed webhook): the sponsor joins, as silver, and AIRS - in
    // the same lap that shows Quarry, which is what Quarry is shown to be when it expires below.
    const paid = await postSignedEvent(
      api,
      stripeEvent("payment_intent.succeeded", {
        id: stripeUid("pi"), object: "payment_intent", amount: 25_000, amount_received: 25_000, currency: "gbp", status: "succeeded",
        metadata: { kind: "sponsor", order_id: sDeal, org_id: o },
      }),
    );
    expect(paid.status(), "the signed event is accepted").toBe(200);
    expect(await dealStatus(api, o, sDeal), "Sable's online deal is live once paid").toBe("live");
    const joined = await expectRoster(() => relayPlan(rig.s), { ...start, [s]: "silver" }, "Pro: Sable joined the stream, as silver");
    await flush(rig, "Pro: after Sable's payment");
    await expectCarousel(rig, joined, [t, g, s, q], "Pro: after Sable joined - Sable airs, and so does every other sponsor on the roster");

    // Two breaks over the four cards on the plan (3+2+1+1, the first seven-turn cycle): a PARTIAL window, its positions read back.
    const picks: BreakPick[] = [];
    picks.push(await openBreak(rig, "home", "Pro: the first break"));
    picks.push(await openBreak(rig, "away", "Pro: the second break"));
    await flush(rig, "Pro: after the first window");

    // Change 2: Gale's gold deal ends; the queued silver deal takes over - the same sponsor, a lighter tier.
    await expectArchiveRefused(api, o, g, "Pro: Gale holds a live deal");
    await endNow(api, o, gGold, "Pro: Gale's gold deal ends");
    expect(await dealStatus(api, o, gSilver), "the queued silver deal is live").toBe("live");
    const afterGold: Roster = { [t]: "title", [g]: "silver", [s]: "silver", [q]: "partner" };
    await expectRoster(() => relayPlan(rig.s), afterGold, "Pro: Gale is served as silver now");
    await flush(rig, "Pro: after Gale's hand-over");

    // Change 3: Quarry's unpaid deal runs past its end and the sweep ends it; the club writes it off. The carousel follows.
    await withDb((sql) => sql`update sponsor_orders set ends_at = now() - interval '1 minute' where id = ${qDeal}`);
    const cronSecret = process.env.CRON_SECRET;
    expect(cronSecret, "the e2e job sets CRON_SECRET (one value for the server and this runner)").toBeTruthy();
    const sweep = await api.post("/api/cron/sponsor-deals", { headers: { "x-cron-secret": cronSecret! } });
    expect(sweep.status(), "the sweep runs").toBe(200);
    const counts = ((await sweep.json()) as { data: { checked: number; expired: number; failed: number } }).data;
    expect(counts.expired, "the sweep ended Quarry's deal (anti-vacuity)").toBeGreaterThanOrEqual(1);
    expect(counts.failed, "and failed nothing").toBe(0);
    const expired = await apiJson<{ deal_status: string; ended_reason: string | null }>(api, `/api/v1/orgs/${o}/sponsor-deals/${qDeal}`);
    expect(expired.data, "Quarry's deal ended by expiry, still unpaid").toMatchObject({ deal_status: "ended", ended_reason: "expired" });
    const writeOff = await apiJson<{ deal_status: string; ended_reason: string | null }>(api, `/api/v1/orgs/${o}/sponsor-deals/${qDeal}/write-off`, "POST");
    expect(writeOff.status, `the write-off: ${JSON.stringify(writeOff.error)}`).toBe(200);
    expect(writeOff.data, "Quarry's deal is written off").toMatchObject({ deal_status: "ended", ended_reason: "written_off" });
    const left = await expectRoster(() => relayPlan(rig.s), { [t]: "title", [g]: "silver", [s]: "silver" }, "Pro: Quarry (expired) has left the plan; Quarry does not return");
    await flush(rig, "Pro: after Quarry expired");
    await expectCarousel(rig, left, [t, g, s], "Pro: after Quarry expired - Gale (now silver) and Sable air, Quarry does not");

    // Two more breaks, dealt over the three cards now on the plan (3+1+1): the positions carry on across all three changes.
    picks.push(await openBreak(rig, "home", "Pro: the third break, after Sable joined, Gale handed over and Quarry left"));
    picks.push(await openBreak(rig, "away", "Pro: the fourth break"));
    expectPositionsFromZero(picks, "Pro: the four breaks across the changes");
    await flush(rig, "Pro: after the second window");
    await finish(rig, all, "Pro");
    await endAndReadOverview(rig, all, "Pro");
  });
});

// =====================================================================================================================
// J4 — Pro, the club's PLAN changes while the stream is live
// =====================================================================================================================
test("J4 Pro: the plan changes mid-stream - on Free every card is served as a partner and the stored tiers are untouched, back on Pro the tiers return; a hand-ticked sponsor is archived and returns", async ({ browser }) => {
  test.setTimeout(JOURNEY_TIMEOUT_MS);
  const org = await seedOrg(browser, "ssm-plan");
  const fx = await volleyball(org, "Plan");
  const api = org.page.request;
  const o = org.orgId;
  expect(await planFlagSql("sponsors.tiers", "pro"), "premise: Pro has sponsors.tiers").toBe(true);
  expect(await planFlagSql("sponsors.tiers", "community"), "premise: Free has none").toBe(false);

  // Packages and deals are made on Pro (Free refuses a title or gold placement); the plan is moved only once the stream is up.
  const titlePkg = await streamPackage(api, o, "title");
  const goldPkg = await streamPackage(api, o, "gold");
  const t = await newSponsor(api, o, "Tarn Title Motors");
  const g = await newSponsor(api, o, "Gale Gold Estates");
  const h = await newSponsor(api, o, "Heron Hand Tools");
  const tDeal = await newDeal(api, o, t, { package_id: titlePkg, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(api, o, tDeal), "premise: the title deal is live").toBe("live");
  const gDeal = await newDeal(api, o, g, { package_id: goldPkg, payment_method: "complimentary", go_live: "immediate" });
  expect(await dealStatus(api, o, gDeal), "premise: the gold deal is live").toBe("live");
  await tick(api, o, h, "Heron ticked by hand");
  const all = [t, g, h];
  // The tiers the packages bought - the test's own declaration, which the plan and the stored rows are both held to.
  const onPro: Roster = { [t]: "title", [g]: "gold", [h]: "partner" };
  const onFree: Roster = Object.fromEntries(all.map((id) => [id, "partner"]));

  await withStream(browser, org, fx, async (rig) => {
    const plan = () => relayPlan(rig.s);
    await expectRoster(plan, onPro, "Plan: on Pro every sponsor is served at its own tier");
    expect(cardTiersOf(await plan()), "premise: and every card the plan carries is at that tier").toEqual(onPro);
    expect(await tierRows(o, all), "premise: the stored rows hold the tiers the packages bought").toEqual(onPro);
    await expectAiredOnPage(rig, all, "Plan: before anything changes");

    // Change 1: the club drops to Free while the stream is live. The plan serves EVERY card as a partner; nothing is written to the rows.
    await downgrade(org);
    await expectRoster(plan, onFree, "Plan: on Free every ticked sponsor is served as a partner");
    expect(cardTiersOf(await plan()), "Plan: on Free every card the plan carries is a partner").toEqual(onFree);
    expect(await tierRows(o, all), "Plan: the downgrade wrote nothing to the rows - the tiers are flattened at the read").toEqual(onPro);
    await flush(rig, "Plan: after the downgrade");

    // Change 2: and back to Pro: the tiers return, because they never left the rows.
    await upgrade(org);
    await expectRoster(plan, onPro, "Plan: back on Pro the tiers return");
    expect(cardTiersOf(await plan()), "Plan: back on Pro every card is at its own tier again").toEqual(onPro);
    expect(await tierRows(o, all), "Plan: and the rows are as they were").toEqual(onPro);
    await flush(rig, "Plan: after the upgrade");

    // Change 3: the hand-ticked sponsor is archived and leaves the carousel (it had aired above); change 4: it returns and airs again.
    await archive(api, o, h, "Plan: Heron archived (no deal to hold it)");
    const left = await expectRoster(plan, { [t]: "title", [g]: "gold" }, "Plan: Heron has left the plan");
    await flush(rig, "Plan: after Heron left");
    await expectCarousel(rig, left, [t, g], "Plan: after Heron was archived");
    await unarchive(api, o, h, "Plan: Heron unarchived");
    const back = await expectRoster(plan, onPro, "Plan: Heron is back, as the partner it was");
    await flush(rig, "Plan: after Heron returned");
    await expectCarousel(rig, back, all, "Plan: after Heron returned - Heron is on the carousel again");
    await finish(rig, all, "Plan");
    await endAndReadOverview(rig, all, "Plan");
  });
});
