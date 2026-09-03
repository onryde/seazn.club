// B03 T7 — the entitlement-gate PROBE. Proves the one surviving scoring-door
// gate (`requiresDlsEntitlement`, apps/web/src/server/usecases/scoring.ts:
// 298-307, gated at :269-271 with `requireFeature(orgId, "cricket.dls")`)
// both EXISTS and can be CLEARED, over the real HTTP API.
//
// ---------------------------------------------------------------------------
// Two premises the T7 brief corrected up front
// ---------------------------------------------------------------------------
// The refusal is a 402 PAYMENT_REQUIRED (`errorResponse(requestId, 402,
// "PAYMENT_REQUIRED", …)`, api-v1/http.ts:214-226) carrying `feature_key`,
// never the "typed 422" an earlier draft of this task expected. And the gate
// itself is NOT the old fidelity-band gate (deleted, entitlements v18 W1) —
// it is `requiresDlsEntitlement`, a THREE-conjunct predicate keyed on the
// event's own type, the DIVISION's `config.dls.enabled`, and the payload's
// `target` — config-sensitive, unlike the uniform gate it replaced, which is
// what makes a real 2x2 possible at all.
//
// ---------------------------------------------------------------------------
// Why this proves the DOOR, not the cricket FOLD
// ---------------------------------------------------------------------------
// `requiresDlsEntitlement` fires inside `assertEntitledToScore`, which runs
// BEFORE `appendEvent` touches the engine (scoring.ts:94). So the REFUSED
// cell is airtight: a 402 here can only come from the entitlement door,
// nothing else runs first. The three cells that must NOT be refused are a
// different claim — "the entitlement gate did not block this" — and this
// probe asserts exactly that (`status !== 402`), never that the underlying
// cricket engine fold ACCEPTED the event businesswise. Driving `cricket.
// revise` (or any cricket event) to a genuine 201 needs a real match state —
// a toss, an open innings, `cfg.inningsPerSide === 1` (cricket.ts:965-968) —
// which needs lineups and a full ball-by-ball walk this task does not build.
// That is `docs/superpowers/specs/bench-product-value/bench-prompts/
// B08-pack-cricket.md`'s job ("org plan must clear it, probe per B03" — this
// file is the "per B03" it depends on). A non-402 status here, even a 4xx
// the engine raises for an unrelated business reason, still proves the gate
// cleared the call — which is the one thing this probe is chartered to
// prove. Recorded as a finding in the task report, not worked around.
//
// ---------------------------------------------------------------------------
// One fixture per cell, never a shared one
// ---------------------------------------------------------------------------
// A 402 refusal fires before `appendEvent`, so nothing is ever appended —
// the fixture's `expected_seq` stays 0 after a refused call, and the SAME
// fixture can be replayed later (see the "cleared direction" cell below,
// which reuses cell 1's fixture rather than minting a fifth one). But an
// ACCEPTED cell might genuinely append (or might not — see above), and this
// file cannot predict which without the full cricket state it deliberately
// does not build. So every "must not be refused" cell gets its OWN fixture:
// sharing one would make a later cell's `expected_seq: 0` a coin flip on
// whether an earlier cell's call happened to persist.
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
// expects FOUR). `lib/http.ts#raw()` already exists for this; nothing new is
// added there. `PlanSql` (lib/plan.ts) is a SEPARATE required parameter, not
// bundled into the transport — this file also owns the bench-only
// `setDivisionActive` shortcut (see plan.ts's own doc comment on why) and
// the plan-entitlement reads that drive the "cleared" cell and the
// `officials.auto` derivation `lib/suites/tiny.ts` consumes.
import { newSession, raw, type RawResult, type Session } from "./http.ts";
import { defaultTransport, type SeedTransport } from "./seed.ts";
import { chooseGrantingPlanForCapabilities, provisionPlan, type PlanSql } from "./plan.ts";

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
  | "revise_no_target_unentitled"
  | "revise_with_target_unentitled"
  | "revise_dls_off_unentitled"
  | "other_event_unentitled"
  | "revise_no_target_entitled";

export interface DlsGateCellOutcome {
  readonly cell: DlsGateCellName;
  readonly status: number;
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
 * Pure: no I/O, so every branch below is unit-testable directly against a
 * crafted `RawResult`, independent of the HTTP orchestration below it.
 *
 * `expectRefusal` is true for exactly ONE of the five cells this file
 * drives (`revise_no_target_unentitled`) — the only combination
 * `requiresDlsEntitlement` returns `true` for. Getting that branch's THREE
 * conditions right (status, code, feature_key) rather than just `status ===
 * 402` is what stops this probe from passing on a gate that refuses for the
 * WRONG feature — AGENTS.md recurring-failure class 19's "pin what a
 * control opens at, not just that it is there", applied to a refusal
 * instead of a value.
 */
export function classifyDlsGateCell(
  cell: DlsGateCellName,
  expectRefusal: boolean,
  result: RawResult,
): DlsGateCellOutcome {
  const body = result.json as unknown as V1ErrorEnvelope;
  const featureKey = body?.ok === false ? body.error?.feature_key : undefined;
  const code = body?.ok === false ? body.error?.code : undefined;

  if (expectRefusal) {
    const ok = result.status === 402 && code === "PAYMENT_REQUIRED" && featureKey === "cricket.dls";
    return {
      cell,
      status: result.status,
      ...(featureKey === undefined ? {} : { featureKey }),
      ok,
      detail: ok
        ? `refused as expected: 402 PAYMENT_REQUIRED, feature_key "cricket.dls"`
        : `expected a 402 PAYMENT_REQUIRED refusal naming feature_key "cricket.dls"; got status ${result.status}` +
          (code ? `, code "${code}"` : "") +
          (featureKey ? `, feature_key "${featureKey}"` : ""),
    };
  }

  // "Accepted" here means the ENTITLEMENT gate specifically did not block
  // the call — see this file's header comment. A 402 naming ANY feature_key
  // (not just "cricket.dls") still fails this cell: an org gated on some
  // OTHER feature for an unrelated reason would be a real bug this probe
  // should catch, not wave through because the feature_key didn't match.
  //
  // But "not 402" alone is not enough, and the reason is an ordering fact.
  // `scoreEvent` runs `assertEntitledToScore` BEFORE the engine fold, so an
  // engine-level 400/422 legitimately proves the entitlement door was passed
  // — that is what lets these cells assert something weaker than 201, and it
  // is sound. What is NOT sound is treating a status from a guard that runs
  // BEFORE the gate as evidence the gate was cleared: `requireFixtureActor ->
  // requireScorable` precede it (scoring.ts's own comment: "coverage was
  // proven at the door"), so a 401/403/404 means this probe never reached the
  // entitlement check at all. Waving those through would let a broken probe
  // SETUP — wrong actor, fixture that does not exist — report three green
  // "accepted" cells having tested nothing. That is precisely the vacuous
  // green this probe exists to prevent, so it must not be vacuous itself.
  const NEVER_REACHED_THE_GATE = [401, 403, 404];
  const ok = result.status !== 402 && !NEVER_REACHED_THE_GATE.includes(result.status);
  return {
    cell,
    status: result.status,
    ...(featureKey === undefined ? {} : { featureKey }),
    ok,
    detail: ok
      ? `not refused for payment (status ${result.status}) — the entitlement gate cleared it`
      : NEVER_REACHED_THE_GATE.includes(result.status)
        ? `status ${result.status} comes from a guard that runs BEFORE the entitlement check ` +
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

export interface DlsGateProbeResult {
  readonly orgId: string;
  /** The plan_key `chooseGrantingPlanForCapabilities` picked and
   *  `provisionPlan` flipped the org onto — derived at call time, never a
   *  constant (see plan.ts's header comment on why a hardcoded key goes
   *  stale), and chosen to grant EVERY capability this probe asked for
   *  (`cricket.dls`, required; `officials.auto`, desired), not `cricket.dls`
   *  alone (B03 review F1(a): picking a plan for one feature and then hoping
   *  it happens to grant another is exactly the bug this fixes — the old
   *  single-feature choice landed on "pro", which does not grant
   *  `officials.auto` on the live catalog; only "pro_plus" grants both). */
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
  readonly cells: readonly DlsGateCellOutcome[];
}

/**
 * Drives the full 2x2-plus-clear proof described in this file's header
 * comment, over the real HTTP API (+ the injected SQL seam for the
 * bench-only division-activation shortcut and the plan read/write). Order:
 *
 *   1. sign in (idempotent — lands in the run's real org)
 *   2. one throwaway competition, two cricket divisions (dls on / dls off),
 *      each force-activated via SQL (see `PlanSql.setDivisionActive`)
 *   3. four cells against the UNENTITLED (fresh/community) org
 *   4. read `plan_entitlements` for BOTH `cricket.dls` (required) and
 *      `officials.auto` (desired) and derive + provision the plan that
 *      grants both when one exists (B03 review F1(a) —
 *      `chooseGrantingPlanForCapabilities`, never `cricket.dls` alone)
 *   5. replay cell 1's exact call (its fixture's `expected_seq` is still 0 —
 *      nothing was ever appended by a 402) — now expected to clear
 *   6. report whether the CHOSEN plan grants `officials.auto`, and name it
 *      when it does not (`unsatisfiedCapabilities`)
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

  const [fixtureRefuse, fixtureManualTarget, fixtureOtherEvent] = dlsOn.fixtureIds;
  const [fixtureDlsOff] = dlsOff.fixtureIds;
  if (fixtureRefuse === undefined || fixtureManualTarget === undefined || fixtureOtherEvent === undefined) {
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

  const cells: DlsGateCellOutcome[] = [];
  cells.push(classifyDlsGateCell("revise_no_target_unentitled", true, await send(fixtureRefuse, "cricket.revise", {})));
  cells.push(
    classifyDlsGateCell(
      "revise_with_target_unentitled",
      false,
      await send(fixtureManualTarget, "cricket.revise", { target: 150 }),
    ),
  );
  cells.push(classifyDlsGateCell("revise_dls_off_unentitled", false, await send(fixtureDlsOff, "cricket.revise", {})));
  cells.push(classifyDlsGateCell("other_event_unentitled", false, await send(fixtureOtherEvent, "cricket.ball", {})));

  // ---- the cleared direction ----
  // Both reads happen BEFORE the choice, not after: B03 review F1(a)'s bug
  // was choosing a plan for `cricket.dls` alone and only THEN asking whether
  // it happened to also grant `officials.auto` — a plan that satisfies one
  // feature and hopes. `chooseGrantingPlanForCapabilities` needs both rows
  // up front to pick a plan that grants everything this run asked for.
  const dlsRows = await sql.entitlementRows("cricket.dls");
  const autoRows = await sql.entitlementRows("officials.auto");
  // `stats.player` belongs in the SELECTION, not in a check afterwards. It was
  // originally read separately in `suites/tiny.ts` and tested against whatever
  // plan this function had already chosen — which is F1(a)'s exact shape ("pick
  // for some features, hope on another"), reintroduced one capability over from
  // the fix. It was dormant rather than wrong (both `pro` and `pro_plus` grant
  // it today, so the plan chosen for the other two happened to cover it), and
  // dormant-by-luck is not a property to rely on: a catalog where the best plan
  // for {cricket.dls, officials.auto} does not grant `stats.player` would have
  // dropped the whole stats baseline with no warning, because only
  // `officials.auto` had reporting.
  const statsRows = await sql.entitlementRows("stats.player");
  const { plan: provisionedPlan, unsatisfied: unsatisfiedCapabilities } = chooseGrantingPlanForCapabilities([
    { featureKey: "cricket.dls", rows: dlsRows },
    { featureKey: "officials.auto", rows: autoRows },
    { featureKey: "stats.player", rows: statsRows },
  ]);
  await provisionPlan({ base, orgId, plan: provisionedPlan, ownerSession: s, sql, transport: t });

  // Same fixture, same body, as `revise_no_target_unentitled` above — its
  // refusal never appended anything, so `expected_seq: 0` is still correct.
  cells.push(
    classifyDlsGateCell("revise_no_target_entitled", false, await send(fixtureRefuse, "cricket.revise", {})),
  );

  const officialsAutoGranted = !unsatisfiedCapabilities.includes("officials.auto");
  const statsPlayerGranted = !unsatisfiedCapabilities.includes("stats.player");

  return {
    orgId,
    provisionedPlan,
    officialsAutoGranted,
    statsPlayerGranted,
    unsatisfiedCapabilities,
    cells,
  };
}
