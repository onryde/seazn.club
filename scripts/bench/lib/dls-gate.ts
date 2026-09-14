// B03 T7, re-pointed by B05 — the scoring-door probe.
//
// Originally chartered to prove the `cricket.dls` PAYWALL both existed and
// could be cleared. The product removed that paywall on purpose, so this
// file now proves the opposite promise, plus a paywall assertion pointed at
// a key that is still gated.
//
// ---------------------------------------------------------------------------
// OWNER RULING (relayed 2026-09-08): scoring is free
// ---------------------------------------------------------------------------
// "yes, we made all scoring is free." Scoring is not a paid differentiator.
// The migrations say it twice:
//
//   * `V390__scoring_free.sql` (owner ruling 2026-08-30, entitlements v18 W1)
//     deletes the three fidelity keys from `plan_entitlements` AND their
//     overrides; their server gate (`requiredFeatureForEvent`) went with them.
//   * `V393__entitlements_v18.sql:63-70` sets `bool_value = true` on
//     `community` — the plan a subscription-less org coalesces to
//     (`apps/web/src/lib/entitlements.ts:70`) — for the correctness keys,
//     `cricket.dls` among them: "charge for leverage, never correctness".
//
// `apps/web/src/lib/feature-copy.ts:105-109` lists those keys as deliberately
// "unreachable from a plan — all `true` on community".
//
// So NO plan choice can produce an org unentitled to `cricket.dls` any more,
// and the 402 this file used to assert is a refusal no customer can hit. A
// live run reported the old cell as:
//
//   FAIL entitlement-gate: revise_no_target_unentitled — expected a 402
//   PAYMENT_REQUIRED refusal naming feature_key "cricket.dls"; got status
//   422, code "INVALID_EVENT"
//
// That 422 was the product being RIGHT. Do not restore the paywall here, and
// do NOT manufacture one with an explicit `org_entitlement_overrides` deny:
// such a row does still produce a 402 (`lib/entitlements.ts` :399-418, "a
// live override wins"), but it would assert a refusal no customer can ever
// hit — exercising the override MECHANISM while pretending to test a
// paywall, and quietly re-enshrining "DLS is paid" in a bench whose job is
// to describe the product as it is. Built, then rejected, 2026-09-08.
//
// ---------------------------------------------------------------------------
// What this file asserts NOW — four things, none of them a DLS paywall
// ---------------------------------------------------------------------------
// 1. THE PROMISE, POSITIVELY, OVER HTTP. `revise_no_target_community` sends
//    `cricket.revise` with an EMPTY payload from a community-plan org and
//    requires exactly 422 / `INVALID_EVENT` — the ENGINE's own shape refusal
//    (`CricketRevise` needs `oversPerSide` and/or `target`;
//    packages/engine/src/sports/cricket/cricket.ts:259-266), mapped to 422 by
//    `api-v1/http.ts:23`. That is a positive freedom proof rather than a
//    weaker "was not a 402", and the reason is an ORDERING fact:
//    `assertEntitledToScore` runs BEFORE `appendEvent` touches the engine
//    (`usecases/scoring.ts` :96 vs :101), so an engine-shaped code can only
//    be reached by a call the entitlement door already let through. Re-gate
//    scoring in a later migration and this cell reds.
//
//    Its CEILING is honest and deliberate: a genuine 201 for a cricket event
//    needs a real match state — a toss, an open innings, `cfg.inningsPerSide
//    === 1` (cricket.ts:965-968) — which needs lineups and a ball-by-ball
//    walk this file does not build. That is `docs/superpowers/specs/
//    bench-product-value/bench-prompts/B08-pack-cricket.md`'s job. 422
//    INVALID_EVENT is the strongest statement reachable from here, and it is
//    already enough to witness a re-gating.
//
// 2. THE PROMISE AT THE MATRIX. `dlsFreeOnCommunityPlan` reads
//    `plan_entitlements` at call time (never a constant — see plan.ts's
//    "derive, never hardcode" header) and reports whether `community` still
//    carries an explicit `bool_value = true` row for `cricket.dls`. The HTTP
//    cell above proves the door is open for THIS org; this proves the door is
//    open for every org that never paid.
//
// 3. THE PAYWALL ASSERTION, RE-POINTED RATHER THAN DELETED. "A refusal names
//    its feature_key" is a real regression-catcher for every key that IS
//    still plan-gated — checking all three of status, code and `feature_key`
//    is what stops it passing on a gate refusing for the WRONG feature
//    (AGENTS.md recurring-failure class 19, applied to a refusal instead of a
//    value). It is now pointed at whichever key in
//    `PROVOCABLE_GATED_FEATURES` the LIVE matrix still gates for a
//    community-plan org — derived from the same `entitlementRows` reads the
//    plan choice already makes, never typed in. If a later migration frees
//    every one of them, the cell is not emitted at all and
//    `gatedFeatureProbed` is null: a REPORTED retirement, never a silently
//    weakened assertion and never an invented gate.
//
// 4. THE DEVICE LINK, REFUSED THEN BOUGHT (B07a T11). `scoring.device_links`
//    is sold (V117__device_links.sql:55-56: community false, pro true), and a
//    tap suite cannot hand a scorer a phone without it
//    (`usecases/device-links.ts:128`). `proveDeviceLinkGate` mints on the
//    probe's own fixture while the org is still on the free plan (a 402
//    naming the key), provisions, then mints again (201 with a secret). Two
//    cells, separate from point 3's on purpose: that cell names the FIRST
//    provocable key (`officials.auto` while it is sold), and pointing it here
//    instead would lose that coverage. Both retire, reported, when the live
//    catalog stops paywalling the key; the second FAILS — never passes on a
//    mint that was not sent — when the plan this run can buy does not grant it.
//
// ---------------------------------------------------------------------------
// Why the three "not refused for payment" cells still prove the DOOR
// ---------------------------------------------------------------------------
// `requiresDlsEntitlement` (usecases/scoring.ts:300-308) is a THREE-conjunct
// predicate keyed on the event's own type, the DIVISION's `config.dls
// .enabled`, and the payload's `target` — config-sensitive, which is what
// makes a real 2x2 possible at all. It is unchanged and still returns `true`
// for the empty-payload cell; what changed underneath it is that
// `requireFeature` (lib/entitlements.ts:673-674) no longer throws, because
// `hasFeature` is now true for everyone. The other three cells are a
// different claim — "the entitlement gate did not block this" — and this
// probe asserts exactly that (`status !== 402`), never that the underlying
// cricket fold ACCEPTED the event businesswise.
//
// ---------------------------------------------------------------------------
// One fixture per cell, never a shared one
// ---------------------------------------------------------------------------
// Nothing here can predict whether a given cell APPENDS (see the ceiling
// above), so every cell gets its own fixture and `expected_seq: 0`; sharing
// one would make a later cell's `expected_seq` a coin flip on whether an
// earlier cell happened to persist. The one deliberate exception is the
// after-plan replay, which reuses the empty-payload cell's fixture: a 422
// shape refusal is raised by the engine BEFORE anything is appended, so that
// fixture's `expected_seq` is still 0. The device-link cells (point 4) reuse
// that fixture too, for the same reason read the other way: `createDeviceLink`
// 422s a finalized or cancelled fixture, and one that has only ever drawn
// shape refusals is still the `scheduled` row `/generate` inserted
// (`usecases/stages.ts:1351`). A mint appends no event, so the replay's
// `expected_seq: 0` survives it.
//
// ---------------------------------------------------------------------------
// DI, same shape as `lib/seed.ts`
// ---------------------------------------------------------------------------
// `ProbeTransport` extends `SeedTransport` (signIn + request) with `raw` —
// the ONE extra primitive this file needs that `seedSuite` never did: a
// probe cell has to read back the actual HTTP status and the v1 error
// envelope's `feature_key`, which `request()` deliberately discards (it
// throws on any unexpected 4xx/5xx and returns only `data` on success —
// exactly right for a driver that expects one shape, wrong for a probe that
// expects several). `lib/http.ts#raw()` already exists for this; nothing new
// is added there. `PlanSql` (lib/plan.ts) is a SEPARATE required parameter,
// not bundled into the transport — this file also owns the bench-only
// `setDivisionActive` shortcut (see plan.ts's own doc comment on why) and
// the plan-entitlement reads that drive the after-plan cell, the re-pointed
// paywall cell, and the `officials.auto` derivation `lib/suites/tiny.ts`
// consumes.
import { newSession, raw, type RawResult, type Session } from "./http.ts";
import { defaultTransport, type SeedTransport } from "./seed.ts";
import {
  FREE_PLAN_KEY,
  chooseGrantingPlanForCapabilities,
  paywalledOnFreePlan,
  planGrants,
  provisionPlan,
  type PlanEntitlementRow,
  type PlanSql,
} from "./plan.ts";

export interface ProbeTransport extends SeedTransport {
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

/** `signIn`/`request` from `seed.ts`'s own `defaultTransport`, plus
 *  `lib/http.ts`'s `raw` directly — the real thing, exactly as every other
 *  `*Transport` default in this directory composes. */
export const defaultProbeTransport: ProbeTransport = { ...defaultTransport, raw };

// ---------------------------------------------------------------------------
// The pure interpretation — one cell in, one verdict out
// ---------------------------------------------------------------------------

export type DlsGateCellName =
  /** `cricket.revise` with an EMPTY payload, community plan. The engine's own
   *  shape refusal (422 INVALID_EVENT) is the positive proof that the
   *  entitlement door let a free-scoring call through — see this file's
   *  header, "What this file asserts NOW", point 1. */
  | "revise_no_target_community"
  | "revise_with_target_community"
  | "revise_dls_off_community"
  | "other_event_community"
  /** The empty-payload call REPLAYED after a paid plan is provisioned. Must
   *  answer identically: scoring is free at BOTH ends, so a plan flip must
   *  not change this verdict in either direction. */
  | "revise_no_target_after_plan"
  /** The re-pointed paywall assertion (header point 3). Emitted only when the
   *  live matrix still gates one of `PROVOCABLE_GATED_FEATURES`. */
  | "gated_feature_refusal_names_its_key"
  /** B07a T11 — `POST /fixtures/{id}/device-links` on the free plan, BEFORE
   *  the plan flip: a 402 naming `scoring.device_links`. Emitted only while
   *  the live catalog still paywalls the key (`provocableFeatureKeys`). */
  | "device_link_refused_before_plan"
  /** The same POST AFTER the flip: a 201 carrying the one-time secret.
   *  Emitted with its refusal and never without it; when the provisioned plan
   *  does not grant the key it is emitted FAILED, with nothing sent. */
  | "device_link_minted_after_plan";

/**
 * What a cell requires of its response. Three kinds, because "not a 402" is
 * too weak for the freedom cells and 402 is now wrong for all but one cell.
 */
export type DlsGateExpectation =
  /** Exactly a paywall refusal, naming this key — all THREE of status, code
   *  and `feature_key`. A cell that checked only the 402 would pass on a gate
   *  refusing for the wrong feature. */
  | { readonly kind: "payment_refusal"; readonly featureKey: string }
  /** Exactly this engine-raised status + code. Reachable ONLY past the
   *  entitlement door (`assertEntitledToScore` precedes the engine fold), so
   *  it asserts the door is OPEN — a strictly stronger claim than
   *  `not_payment_refused`. */
  | { readonly kind: "engine_rejection"; readonly status: number; readonly code: string }
  /** The entitlement gate specifically did not block this call. Weaker than
   *  `engine_rejection` on purpose: these cells cannot predict which
   *  business-level status the fold returns. */
  | { readonly kind: "not_payment_refused" }
  /** A mint went through: 201, and the envelope's `data.secret` is a
   *  non-empty string (`createDeviceLink` returns it exactly once). The secret
   *  itself is never copied into the verdict — it is a live scoring credential
   *  for that fixture until local midnight, and the verdict lands in a report. */
  | { readonly kind: "minted_with_secret" };

export interface DlsGateCellOutcome {
  readonly cell: DlsGateCellName;
  /** The HTTP status the cell's request drew, or `null` when the request was
   *  deliberately NOT sent (`device_link_minted_after_plan` on a plan that does
   *  not grant the key). A `null` cell is never ok. */
  readonly status: number | null;
  readonly featureKey?: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** The v1 error envelope's shape (api-v1/http.ts's `errorResponse`):
 *  `{ ok: false, error: { code, message, ...extra }, requestId }` — `error`
 *  is an OBJECT here, unlike `lib/http.ts`'s own loosely-typed `RawJson`
 *  (`error?: string`, written for the admin-route envelope, which IS a
 *  string — `apps/web/src/lib/http.ts#handlerInner`'s catch branches). Two
 *  different envelopes in this codebase share the field name; this local
 *  type describes the ONE this file actually reads. */
interface V1ErrorEnvelope {
  readonly ok: false;
  readonly error?: { readonly code?: string; readonly feature_key?: string; readonly message?: string };
}

/**
 * Statuses raised by guards that run BEFORE the entitlement check —
 * `requireFixtureActor -> requireScorable` (scoring.ts's own comment:
 * "coverage was proven at the door"). A cell that saw one of these never
 * reached the gate at all, so it proves nothing about it in EITHER
 * direction. Waving them through would let a broken probe SETUP — wrong
 * actor, fixture that does not exist — report green cells having tested
 * nothing, which is precisely the vacuous green this probe exists to
 * prevent, so it must not be vacuous itself.
 */
const NEVER_REACHED_THE_GATE = [401, 403, 404];

/**
 * Pure: no I/O, so every branch below is unit-testable directly against a
 * crafted `RawResult`, independent of the HTTP orchestration below it.
 */
export function classifyDlsGateCell(
  cell: DlsGateCellName,
  expectation: DlsGateExpectation,
  result: RawResult,
): DlsGateCellOutcome {
  const body = result.json as unknown as V1ErrorEnvelope;
  const featureKey = body?.ok === false ? body.error?.feature_key : undefined;
  const code = body?.ok === false ? body.error?.code : undefined;
  const seen =
    `status ${result.status}` + (code ? `, code "${code}"` : "") + (featureKey ? `, feature_key "${featureKey}"` : "");
  const withKey = featureKey === undefined ? {} : { featureKey };

  if (expectation.kind === "payment_refusal") {
    const ok = result.status === 402 && code === "PAYMENT_REQUIRED" && featureKey === expectation.featureKey;
    return {
      cell,
      status: result.status,
      ...withKey,
      ok,
      detail: ok
        ? `refused as expected: 402 PAYMENT_REQUIRED, feature_key "${expectation.featureKey}"`
        : `expected a 402 PAYMENT_REQUIRED refusal naming feature_key "${expectation.featureKey}"; got ${seen}`,
    };
  }

  if (expectation.kind === "minted_with_secret") {
    const data = result.json?.ok === true ? (result.json.data as { readonly secret?: unknown } | undefined) : undefined;
    const secret = data?.secret;
    const ok = result.status === 201 && typeof secret === "string" && secret.length > 0;
    return {
      cell,
      status: result.status,
      ...withKey,
      ok,
      detail: ok
        ? "minted: 201 with a one-time device-link secret (deliberately not copied here) — provisioning cleared the refusal"
        : result.status === 402
          ? `still refused for payment after provisioning (${seen}) — the plan flip did not clear this gate`
          : result.status === 201
            ? "got a 201 with no device-link secret in it — a mint that hands the scorer nothing to use is not a mint"
            : `expected a 201 carrying a one-time device-link secret; got ${seen}`,
    };
  }

  if (expectation.kind === "engine_rejection") {
    const ok = result.status === expectation.status && code === expectation.code;
    return {
      cell,
      status: result.status,
      ...withKey,
      ok,
      detail: ok
        ? `reached the ENGINE and was refused on shape: ${expectation.status} ${expectation.code} — the ` +
          `entitlement door let this call through, which is what "scoring is free" means over HTTP`
        : result.status === 402
          ? `refused for PAYMENT (${seen}) — but scoring is FREE (owner ruling; V390__scoring_free.sql, ` +
            `V393__entitlements_v18.sql:63-70 puts cricket.dls on community). A paywall has come back at ` +
            `the scoring door; fix the product, never this expectation`
          : NEVER_REACHED_THE_GATE.includes(result.status)
            ? `${seen} comes from a guard that runs BEFORE the entitlement check ` +
              `(requireFixtureActor/requireScorable), so this cell never reached the gate and proves ` +
              `nothing about it — fix the probe's setup rather than reading this as a pass`
            : `expected the engine's own ${expectation.status} ${expectation.code} shape refusal; got ${seen}`,
    };
  }

  // "Accepted" here means the ENTITLEMENT gate specifically did not block
  // the call — see this file's header comment. A 402 naming ANY feature_key
  // (not just the one under test) still fails this cell: an org gated on some
  // OTHER feature for an unrelated reason would be a real bug this probe
  // should catch, not wave through because the feature_key didn't match.
  const ok = result.status !== 402 && !NEVER_REACHED_THE_GATE.includes(result.status);
  return {
    cell,
    status: result.status,
    ...withKey,
    ok,
    detail: ok
      ? `not refused for payment (status ${result.status}) — the entitlement gate cleared it`
      : NEVER_REACHED_THE_GATE.includes(result.status)
        ? `${seen} comes from a guard that runs BEFORE the entitlement check ` +
          `(requireFixtureActor/requireScorable), so this cell never reached the gate and proves ` +
          `nothing about it — fix the probe's setup rather than reading this as a pass`
        : `refused with 402 PAYMENT_REQUIRED (feature_key "${featureKey}") — the gate should NOT have blocked this cell`,
  };
}

// ---------------------------------------------------------------------------
// The HTTP orchestration
// ---------------------------------------------------------------------------

interface IdOut {
  id: string;
}
interface GenerateOut {
  fixtures: { id: string }[];
}

const CRICKET_VARIANT = "t20"; // single-innings (cfg.inningsPerSide defaults to 1 — cricket.ts:3032-3040), quota != null

/** One cricket division + 2 entrants + one league stage + `/generate` —
 *  everything a probe cell needs to name a real `fixtures` row, minimal
 *  otherwise (no venues, no roster, no scheduling — see this file's header
 *  comment on why "accepted" never claims a full cricket-valid 201). `legs`
 *  controls how many fixtures come out of a 2-entrant round robin — this
 *  file's caller sizes it to exactly the number of cells that division's
 *  fixtures serve, per this file's "one fixture per cell" rule. */
async function createCricketDivision(
  base: string,
  s: Session,
  t: ProbeTransport,
  competitionId: string,
  label: string,
  dls: { enabled: boolean; edition: "standard" },
  legs: number,
): Promise<{ divisionId: string; fixtureIds: readonly string[] }> {
  const division = await t.request<IdOut>(base, s, `/api/v1/competitions/${competitionId}/divisions`, {
    method: "POST",
    body: { name: `Cricket ${label}`, sport_key: "cricket", variant_key: CRICKET_VARIANT, config: { dls } },
  });
  const entrants = await t.request<IdOut[]>(base, s, `/api/v1/divisions/${division.id}/entrants`, {
    method: "POST",
    body: [
      { kind: "team", display_name: `${label} Alpha` },
      { kind: "team", display_name: `${label} Bravo` },
    ],
  });
  if (entrants.length !== 2) {
    throw new Error(`createCricketDivision("${label}"): expected 2 entrants, POST .../entrants returned ${entrants.length}`);
  }
  const stages = await t.request<IdOut[]>(base, s, `/api/v1/divisions/${division.id}/stages`, {
    method: "POST",
    body: [{ seq: 1, kind: "league", name: `${label} League`, config: { legs } }],
  });
  const stage = stages[0];
  if (stage === undefined) {
    throw new Error(`createCricketDivision("${label}"): POST .../stages returned no rows`);
  }
  const generated = await t.request<GenerateOut>(base, s, `/api/v1/stages/${stage.id}/generate`, { method: "POST" });
  return { divisionId: division.id, fixtureIds: generated.fixtures.map((f) => f.id) };
}

export interface DlsGateProbeInput {
  readonly base: string;
  /** The identity this probe signs in with — its OWN competition/divisions
   *  live under whatever org that identity's FIRST sign-in provisioned (same
   *  auto-provisioning `seed.ts`'s own header comment describes). Passing
   *  the SAME email a `seedSuite` run used for its own suite lands this
   *  probe's cricket divisions in that SAME org, so the plan flip below
   *  (and the `officials.auto` derivation) applies to the run's real org —
   *  but this file never depends on anything `seedSuite` created. */
  readonly email: string;
  /** Uniqueness for this probe's OWN throwaway competition slug — reuse the
   *  caller's own run tag, never mint a second one. */
  readonly runTag: string;
  readonly sql: PlanSql;
  readonly transport?: ProbeTransport;
}

/**
 * A feature key this probe knows HOW to provoke a refusal for, over a route
 * the bench ALREADY drives.
 *
 * The key -> route mapping is declared here because nothing can derive it: no
 * query says "this gate is reachable by POSTing that path". What is NOT
 * declared here is which of these keys is still gated — that is read off
 * `plan_entitlements` at call time (`paywalledOnFreePlan`), so a key the
 * product later frees drops out of the probe by itself instead of reddening
 * a cell for describing the product correctly. That is exactly the failure
 * this whole file was re-pointed to repair: a bench asserting yesterday's
 * price list.
 *
 * Adding an entry means finding a gate whose `requireFeature` runs BEFORE any
 * state the probe would have to build. Do NOT add one that needs a schedule,
 * a roster or a payment to reach — an unreachable entry silently never fires.
 */
interface ProvocableGatedFeature {
  readonly featureKey: string;
  /** Every id a route here might need. The probe owns both, and neither is
   *  `_tiny`'s: its own dls-on division, and that division's empty-payload
   *  fixture (see `runDlsGateProbe` on why that one). */
  readonly path: (ids: { readonly divisionId: string; readonly fixtureId: string }) => string;
  /** Must be schema-valid: the v1 route parses the body BEFORE the usecase
   *  runs, so a body that fails zod 400s ahead of the gate and the cell would
   *  report a paywall miss that never happened. */
  readonly body: unknown;
}

/** The key `createDeviceLink` gates on (`usecases/device-links.ts:128`).
 *  Named, like every capability the plan choice asks for, because a request
 *  has to say what it wants; whether the key is still SOLD is never named
 *  anywhere — `provocableFeatureKeys` reads that. */
const DEVICE_LINKS_FEATURE_KEY = "scoring.device_links";

const PROVOCABLE_GATED_FEATURES: readonly ProvocableGatedFeature[] = [
  {
    featureKey: "officials.auto",
    // `autoAssignOfficials` (usecases/officials.ts:491-496) opens with
    // `requireFeature(auth.orgId, "officials.auto", ...)` as its FIRST
    // statement — before `withTenant`, before any division-state read — so a
    // division that merely EXISTS provokes it: no courts, no schedule, no
    // officials pool. `V393__entitlements_v18.sql:84` grants it to `pro` and
    // :108-109 to both pass rungs; `community` gets no row, which is what
    // `paywalledOnFreePlan` checks at call time rather than trusting this
    // comment. `lib/suites/tiny.ts` already drives this exact route
    // post-scheduling, so it is a route the bench owns, not one invented for
    // a test.
    path: ({ divisionId }) => `/api/v1/divisions/${divisionId}/officials/auto`,
    // `AssignPolicy.roles` is `z.array(z.string()).min(1)`; every other field
    // defaults (packages/engine/src/officials/types.ts:41-50), as does
    // `AutoAssignInput.rng_seed`.
    body: { policy: { roles: ["umpire"] } },
  },
  {
    featureKey: DEVICE_LINKS_FEATURE_KEY,
    // B07a T11 — `createDeviceLink` (usecases/device-links.ts:121-132) runs
    // `requireSessionEditor`, then `requireFeature(orgId,
    // "scoring.device_links", competitionForFixture(id))`, BEFORE its
    // transaction reads the fixture. The ROUTE runs three guards first
    // (api/v1/fixtures/[id]/device-links/route.ts): a per-IP rate limit of 10
    // mints a minute, `parseBody`, and `requireResourceAuth(fixture, write)` —
    // which 404s a fixture that does not exist, so this entry needs a REAL
    // fixture id and never reaches the gate without one. V117__device_links
    // .sql:55-56 put the key on `pro` and not `community`; `paywalledOnFreePlan`
    // checks that at call time rather than trusting this comment.
    path: ({ fixtureId }) => `/api/v1/fixtures/${fixtureId}/device-links`,
    // `CreateDeviceLink` is `{ label?: string | null }` — every field optional.
    body: {},
  },
];

/**
 * The keys in `PROVOCABLE_GATED_FEATURES` the LIVE catalog still puts behind a
 * paywall for a free-plan org — `paywalledOnFreePlan` over each entry's own
 * `entitlementRows`, in declaration order. Read, never typed: a key the
 * product frees, or stops selling to anyone, drops out by itself, and every
 * cell that hangs off it retires rather than reddening for describing the
 * product correctly.
 *
 * Takes only the one read it needs, so `runDlsGateProbe` can hand it rows it
 * already fetched for the plan choice instead of reading them twice.
 */
export async function provocableFeatureKeys(sql: Pick<PlanSql, "entitlementRows">): Promise<readonly string[]> {
  const keys: string[] = [];
  for (const feature of PROVOCABLE_GATED_FEATURES) {
    if (paywalledOnFreePlan(await sql.entitlementRows(feature.featureKey))) {
      keys.push(feature.featureKey);
    }
  }
  return keys;
}

export interface DeviceLinkGateInput {
  readonly base: string;
  /** The org owner's session: `createDeviceLink` refuses anything but a
   *  session editor (403) before it ever reaches the gate. */
  readonly session: Session;
  readonly transport: Pick<ProbeTransport, "raw">;
  /** A REAL fixture the org owns, neither finalized nor cancelled. */
  readonly ids: { readonly divisionId: string; readonly fixtureId: string };
  /** Whether `provocableFeatureKeys` still lists `scoring.device_links`. False
   *  retires BOTH cells: with no refusal to witness, a mint after the flip
   *  says nothing about the flip. */
  readonly paywalledOnFreePlan: boolean;
  /** The plan flip. Runs exactly once, between the two POSTs, whether or not
   *  the cells run. Resolves to the plan it provisioned and whether that plan
   *  grants `scoring.device_links` — derived from the plan choice's
   *  `unsatisfied`, never assumed from "some plan got provisioned". */
  readonly provision: () => Promise<{ readonly plan: string; readonly grantsDeviceLinks: boolean }>;
}

export interface DeviceLinkGateProof {
  /** The status the mint drew BEFORE the flip; `null` when it was not sent. */
  readonly refusedStatus: number | null;
  /** True only when a mint was actually SENT after the flip and came back
   *  201 with a secret. */
  readonly mintedAfterProvision: boolean;
  /** `device_link_refused_before_plan` then `device_link_minted_after_plan`,
   *  or neither. */
  readonly cells: readonly DlsGateCellOutcome[];
}

/**
 * B07a T11 — the device-link entitlement, proved in the only order that proves
 * anything: mint while the org is still on the free plan (a 402 naming the
 * key), provision, mint again (a 201 with a secret). `runDlsGateProbe` drives
 * its plan flip THROUGH this function, so the order lives in one place and the
 * unit tests exercise the same code a live run does.
 *
 * When the provisioned plan does not grant the key, the second mint is not
 * sent and its cell FAILS, naming the plan. A refusal after the flip would
 * only restate the catalog, and a cell that passed on a mint nobody sent would
 * be the vacuous green this probe exists to prevent.
 */
export async function proveDeviceLinkGate(input: DeviceLinkGateInput): Promise<DeviceLinkGateProof> {
  const { base, session, transport, ids } = input;
  const feature = PROVOCABLE_GATED_FEATURES.find((f) => f.featureKey === DEVICE_LINKS_FEATURE_KEY);
  if (feature === undefined) {
    throw new Error(`proveDeviceLinkGate: PROVOCABLE_GATED_FEATURES has no "${DEVICE_LINKS_FEATURE_KEY}" entry`);
  }
  if (!input.paywalledOnFreePlan) {
    await input.provision();
    return { refusedStatus: null, mintedAfterProvision: false, cells: [] };
  }
  const mint = () => transport.raw(base, session, feature.path(ids), "POST", feature.body);

  const before = await mint();
  const refused = classifyDlsGateCell(
    "device_link_refused_before_plan",
    { kind: "payment_refusal", featureKey: feature.featureKey },
    before,
  );

  const { plan, grantsDeviceLinks } = await input.provision();

  const minted: DlsGateCellOutcome = grantsDeviceLinks
    ? classifyDlsGateCell("device_link_minted_after_plan", { kind: "minted_with_secret" }, await mint())
    : {
        cell: "device_link_minted_after_plan",
        status: null,
        ok: false,
        detail:
          `not sent: plan "${plan}" — the best single plan for every capability this run wants — does not grant ` +
          `${feature.featureKey}, so provisioning cannot have cleared the refusal and no scorer on this org can be ` +
          "handed a device link",
      };

  return { refusedStatus: before.status, mintedAfterProvision: minted.ok, cells: [refused, minted] };
}

export interface DlsGateProbeResult {
  readonly orgId: string;
  /** The plan_key `chooseGrantingPlanForCapabilities` picked and
   *  `provisionPlan` flipped the org onto — derived at call time, never a
   *  constant (see plan.ts's header comment on why a hardcoded key goes
   *  stale), and chosen to grant EVERY capability this probe asked for
   *  (`cricket.dls`, required; `officials.auto`, `stats.player`, `news.auto`
   *  and `scoring.device_links`, desired),
   *  not `cricket.dls` alone (B03 review F1(a): picking a plan for one
   *  feature and then hoping it happens to grant another is exactly the bug
   *  this fixes). */
  readonly provisionedPlan: string;
  /** Whether `provisionedPlan` grants `officials.auto` — derived from
   *  `unsatisfiedCapabilities` below, never assumed from "some plan got
   *  provisioned, so surely auto-assign works now" (the T7 brief's own
   *  language: "derived, not assumed"). `lib/suites/tiny.ts` threads this
   *  straight into the post-scheduling auto-assign call. */
  readonly officialsAutoGranted: boolean;
  /** Capabilities this probe wanted, beyond the required `cricket.dls`, that
   *  `provisionedPlan` does NOT grant — empty when one plan grants
   *  everything asked for. Non-empty is a legitimate, REPORTED outcome (see
   *  `plan.ts#chooseGrantingPlanForCapabilities`'s own doc comment) — never
   *  silently downgraded to "granted". */
  readonly unsatisfiedCapabilities: readonly string[];
  /** Whether the chosen plan grants `stats.player`, from the SAME selection as
   *  `officialsAutoGranted` — not a second read tested against the winner. */
  readonly statsPlayerGranted: boolean;
  /** Whether the chosen plan grants `news.auto`, from the same selection.
   *  Without it `PATCH /divisions/{id}` refuses `auto_posts: true`
   *  (`usecases/divisions.ts:652-654`), nothing drafts, and — because
   *  drafting is a side effect of FOLDING — there is no later point at which
   *  the run could recover. A run that finds this false must report the news
   *  step as having no subject rather than as passing on zero posts. */
  readonly newsAutoGranted: boolean;
  /** B07a T11 — whether the chosen plan grants `scoring.device_links`, from
   *  the same selection as `officialsAutoGranted` (derived from
   *  `unsatisfiedCapabilities` below, never assumed). Minting a device link
   *  refuses 402 without it (`usecases/device-links.ts:128`), so a run that
   *  finds this false cannot hand any scorer a device, and must report its tap
   *  steps as having no subject rather than as passing on zero taps. */
  readonly deviceLinksGranted: boolean;
  /** Whether the two device-link cells ran. False when the live catalog no
   *  longer paywalls `scoring.device_links` for a free-plan org — the same
   *  retirement rule as `gatedFeatureProbed`, and like it a REPORTED
   *  retirement, never a pass. */
  readonly deviceLinkGateProbed: boolean;
  /**
   * THE PROMISE, at the matrix (this file's header, point 2): whether
   * `plan_entitlements` still carries an explicit `bool_value = true` row for
   * `cricket.dls` on `FREE_PLAN_KEY` — the plan an org that never paid
   * resolves to.
   *
   * False means scoring has been re-gated for customers who never paid, which
   * contradicts the owner ruling this file's header records. It is reported
   * rather than thrown so the run still produces its other verdicts; the
   * caller decides how loudly to fail.
   */
  readonly dlsFreeOnCommunityPlan: boolean;
  /**
   * The feature key `gated_feature_refusal_names_its_key` was pointed at, or
   * `null` when NO key in `PROVOCABLE_GATED_FEATURES` is still gated for a
   * free-plan org.
   *
   * `null` retires that one cell — it does not weaken it. A run reporting
   * null is saying "this bench can no longer provoke a paywall on any route
   * it drives", which is a finding to act on (point one of these gates at a
   * key that IS still sold), never a pass.
   */
  readonly gatedFeatureProbed: string | null;
  readonly cells: readonly DlsGateCellOutcome[];
}

/**
 * Drives the cells described in this file's header over the real HTTP API
 * (+ the injected SQL seam for the bench-only division-activation shortcut
 * and the plan read/write). Order, and every step's reason:
 *
 *   1. sign in (idempotent — lands in the run's real org, which has no
 *      subscription and therefore resolves to `FREE_PLAN_KEY`)
 *   2. one throwaway competition, two cricket divisions (dls on / dls off),
 *      each force-activated via SQL (see `PlanSql.setDivisionActive`)
 *   3. the four free-scoring cells, against the org while it is still on the
 *      free plan — the state every claim about "scoring is free" is about
 *   4. read `plan_entitlements` for `cricket.dls` (required), `officials
 *      .auto`, `stats.player`, `news.auto` and `scoring.device_links`
 *      (desired). This is where BOTH derivations come from: the plan choice,
 *      and which keys are still paywalled (`provocableFeatureKeys`).
 *   5. the re-pointed paywall cell — STILL on the free plan, because that is
 *      the only state in which a paywall can refuse anything
 *   6. choose the plan that grants the most of what was asked (pure: every
 *      row it needs is already read)
 *   7. `proveDeviceLinkGate`: mint a device link (refused — still the free
 *      plan), provision the chosen plan, mint again (201)
 *   8. replay the empty-payload cell: a paid plan must not change a free
 *      answer
 */
export async function runDlsGateProbe(input: DlsGateProbeInput): Promise<DlsGateProbeResult> {
  const { base, email, runTag, sql } = input;
  const t = input.transport ?? defaultProbeTransport;
  const s: Session = newSession();
  const { org_id: orgId } = await t.signIn(base, s, email);

  const competition = await t.request<IdOut>(base, s, "/api/v1/competitions", {
    method: "POST",
    body: {
      name: `Bench DLS Gate Probe ${runTag}`,
      slug: `bench-dls-probe-${runTag}`,
      ends_on: "2099-01-03",
    },
  });

  // dls-on division serves 3 cells (revise/no-target, revise/with-target,
  // some-other-event) — 3 legs over 2 entrants mints 3 fixtures, one each.
  const dlsOn = await createCricketDivision(
    base, s, t, competition.id, "DLS on", { enabled: true, edition: "standard" }, 3,
  );
  // dls-off division serves exactly 1 cell.
  const dlsOff = await createCricketDivision(
    base, s, t, competition.id, "DLS off", { enabled: false, edition: "standard" }, 1,
  );

  await sql.setDivisionActive(dlsOn.divisionId);
  await sql.setDivisionActive(dlsOff.divisionId);

  const [fixtureShapeRefusal, fixtureManualTarget, fixtureOtherEvent] = dlsOn.fixtureIds;
  const [fixtureDlsOff] = dlsOff.fixtureIds;
  if (fixtureShapeRefusal === undefined || fixtureManualTarget === undefined || fixtureOtherEvent === undefined) {
    throw new Error(
      `runDlsGateProbe: expected 3 fixtures on the dls-on division (2 entrants, 3 legs), got ${dlsOn.fixtureIds.length}`,
    );
  }
  if (fixtureDlsOff === undefined) {
    throw new Error(
      `runDlsGateProbe: expected 1 fixture on the dls-off division (2 entrants, 1 leg), got ${dlsOff.fixtureIds.length}`,
    );
  }

  const send = (fixtureId: string, type: string, payload: unknown) =>
    t.raw(base, s, `/api/v1/fixtures/${fixtureId}/events`, "POST", { expected_seq: 0, type, payload });

  /** The engine's own refusal for a `cricket.revise` carrying neither
   *  `oversPerSide` nor `target` (`CricketRevise`'s `.refine`,
   *  packages/engine/src/sports/cricket/cricket.ts:259-266), mapped to 422 by
   *  `apps/web/src/server/api-v1/http.ts:23`. Reaching it AT ALL is the proof
   *  that scoring is free — see this file's header, point 1. */
  const ENGINE_SHAPE_REFUSAL = { kind: "engine_rejection", status: 422, code: "INVALID_EVENT" } as const;

  const cells: DlsGateCellOutcome[] = [];
  cells.push(
    classifyDlsGateCell("revise_no_target_community", ENGINE_SHAPE_REFUSAL, await send(fixtureShapeRefusal, "cricket.revise", {})),
  );
  cells.push(
    classifyDlsGateCell(
      "revise_with_target_community",
      { kind: "not_payment_refused" },
      await send(fixtureManualTarget, "cricket.revise", { target: 150 }),
    ),
  );
  cells.push(
    classifyDlsGateCell("revise_dls_off_community", { kind: "not_payment_refused" }, await send(fixtureDlsOff, "cricket.revise", {})),
  );
  cells.push(
    classifyDlsGateCell("other_event_community", { kind: "not_payment_refused" }, await send(fixtureOtherEvent, "cricket.ball", {})),
  );

  // ---- the plan-entitlement reads ----
  // Both derivations below hang off these, and all of them happen BEFORE any
  // choice: B03 review F1(a)'s bug was choosing a plan for `cricket.dls`
  // alone and only THEN asking whether it happened to also grant
  // `officials.auto` — a plan that satisfies one feature and hopes.
  const dlsRows = await sql.entitlementRows("cricket.dls");
  const autoRows = await sql.entitlementRows("officials.auto");
  // `stats.player` belongs in the SELECTION, not in a check afterwards. It was
  // originally read separately in `suites/tiny.ts` and tested against whatever
  // plan this function had already chosen — which is F1(a)'s exact shape ("pick
  // for some features, hope on another"), reintroduced one capability over from
  // the fix.
  const statsRows = await sql.entitlementRows("stats.player");
  // B06a T7 — `news.auto` joins the SELECTION for the same reason
  // `stats.player` did, and it matters more here than for any of the three
  // above: `PATCH /divisions/{id}` REFUSES to set `auto_posts: true` without
  // it (`usecases/divisions.ts:652-654`), so a run that provisioned a plan
  // lacking it cannot even turn drafting on — and drafting is a side effect
  // of folding, so there is no later moment to notice. Read from the LIVE
  // catalog, never from the migrations: V295 seeded it, V393 flipped
  // `community` on, and V396 flipped `community` back off, so the deltas alone
  // are three answers to one question.
  const newsRows = await sql.entitlementRows("news.auto");
  // B07a T11 — `scoring.device_links` joins the SELECTION for the reason
  // `news.auto` did: a tap suite cannot hand a scorer a device without it
  // (`createDeviceLink`'s gate, usecases/device-links.ts:128), and a plan
  // picked for the other four and hoped to include it is F1(a) again. One
  // read, shared by the plan choice and the device-link paywall derivation.
  const deviceLinkRows = await sql.entitlementRows(DEVICE_LINKS_FEATURE_KEY);

  // THE PROMISE, at the matrix — read, never assumed, and never a constant.
  const dlsFreeOnCommunityPlan = planGrants(dlsRows, FREE_PLAN_KEY);

  // ---- the re-pointed paywall cell ----
  // Runs while the org is STILL on the free plan: provisioning first would
  // clear the very gate this cell exists to witness. Which key it points at
  // is derived from the rows just read, so a key the product frees drops out
  // instead of reddening.
  const rowsByFeature = new Map<string, readonly PlanEntitlementRow[]>([
    ["cricket.dls", dlsRows],
    ["officials.auto", autoRows],
    ["stats.player", statsRows],
    ["news.auto", newsRows],
    [DEVICE_LINKS_FEATURE_KEY, deviceLinkRows],
  ]);
  // Reuse a read this function already made; only pay for a fresh one if a
  // future entry names a key the plan choice does not care about.
  const provocable = await provocableFeatureKeys({
    entitlementRows: async (featureKey) => rowsByFeature.get(featureKey) ?? (await sql.entitlementRows(featureKey)),
  });
  // The FIRST provocable key in declaration order, so `officials.auto` stays
  // the key this cell names while it is sold; the device-link cells below are
  // separate rather than a replacement.
  const gatedFeature = PROVOCABLE_GATED_FEATURES.find((candidate) => provocable.includes(candidate.featureKey));
  if (gatedFeature !== undefined) {
    cells.push(
      classifyDlsGateCell(
        "gated_feature_refusal_names_its_key",
        { kind: "payment_refusal", featureKey: gatedFeature.featureKey },
        await t.raw(
          base,
          s,
          gatedFeature.path({ divisionId: dlsOn.divisionId, fixtureId: fixtureShapeRefusal }),
          "POST",
          gatedFeature.body,
        ),
      ),
    );
  }

  // ---- the plan choice ----
  // Pure over reads already made, so choosing here — before the device-link
  // refusal below — changes nothing that refusal sees.
  const candidatePlanKeys = [
    ...new Set([...dlsRows, ...autoRows, ...statsRows, ...newsRows, ...deviceLinkRows].map((r) => r.plan_key)),
  ];
  const candidates = await sql.planCandidateInfo(candidatePlanKeys);
  const { plan: provisionedPlan, unsatisfied: unsatisfiedCapabilities } = chooseGrantingPlanForCapabilities(
    [
      { featureKey: "cricket.dls", rows: dlsRows },
      { featureKey: "officials.auto", rows: autoRows },
      { featureKey: "stats.player", rows: statsRows },
      { featureKey: "news.auto", rows: newsRows },
      { featureKey: DEVICE_LINKS_FEATURE_KEY, rows: deviceLinkRows },
    ],
    candidates,
  );
  const officialsAutoGranted = !unsatisfiedCapabilities.includes("officials.auto");
  const statsPlayerGranted = !unsatisfiedCapabilities.includes("stats.player");
  const newsAutoGranted = !unsatisfiedCapabilities.includes("news.auto");
  const deviceLinksGranted = !unsatisfiedCapabilities.includes(DEVICE_LINKS_FEATURE_KEY);

  // ---- the device-link refusal, the plan flip, the mint ----
  // `proveDeviceLinkGate` owns the order (refuse, flip, mint) and runs the
  // flip exactly once even when its cells retire. Both mints go to the
  // empty-payload cell's fixture — see this file's header, "One fixture per
  // cell", on why that fixture is still mintable.
  const deviceLinkGate = await proveDeviceLinkGate({
    base,
    session: s,
    transport: t,
    ids: { divisionId: dlsOn.divisionId, fixtureId: fixtureShapeRefusal },
    paywalledOnFreePlan: provocable.includes(DEVICE_LINKS_FEATURE_KEY),
    provision: async () => {
      await provisionPlan({ base, orgId, plan: provisionedPlan, ownerSession: s, sql, transport: t });
      return { plan: provisionedPlan, grantsDeviceLinks: deviceLinksGranted };
    },
  });
  cells.push(...deviceLinkGate.cells);

  // Same fixture, same body, as `revise_no_target_community` above — a 422
  // shape refusal is raised before anything is appended, so `expected_seq: 0`
  // is still correct. And it must answer IDENTICALLY: buying a plan changes
  // nothing about a free feature, in either direction.
  cells.push(
    classifyDlsGateCell("revise_no_target_after_plan", ENGINE_SHAPE_REFUSAL, await send(fixtureShapeRefusal, "cricket.revise", {})),
  );

  return {
    orgId,
    provisionedPlan,
    officialsAutoGranted,
    statsPlayerGranted,
    newsAutoGranted,
    deviceLinksGranted,
    unsatisfiedCapabilities,
    dlsFreeOnCommunityPlan,
    gatedFeatureProbed: gatedFeature?.featureKey ?? null,
    deviceLinkGateProbed: deviceLinkGate.cells.length > 0,
    cells,
  };
}
