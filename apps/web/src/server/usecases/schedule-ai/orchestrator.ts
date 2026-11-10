import "server-only";
import { AiProviderError } from "@/server/ai/provider";
import { withTenant } from "@/lib/db";
import type { PackCourtInfo } from "@/lib/court-directory";
import { log } from "@/server/logger";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { balance, spendCredit, walletIdFor } from "@/lib/credits";
import { rateLimit } from "@/lib/rate-limit";
import { captureServer, isServerFeatureEnabled } from "@/lib/posthog-server";
import { aiRunCostUsd } from "@/lib/ai-pricing";
import {
  createTokenMeter,
  meterStamp,
  minimumCredits,
  quoteRun,
  schedulingRungWeights,
  type TokenMeter,
} from "@/lib/ai-rung";
import { deferred } from "@/lib/deferred";
import { recordQuoteMismatch } from "../ai-quote-mismatch";
import { maybeAlertExpensiveRun } from "@/server/usecases/ai-runs-admin";
import { withLegacyDetail } from "@/server/api-v1/conflict-detail-legacy";
import type {
  ConflictDetail,
  SchedulingConstraints,
} from "@seazn/engine/scheduling";
import { parseInstruction } from "@/server/usecases/schedule-ai-parse";
import { consumePreview, PREVIEW_STALE, releasePreview } from "@/server/usecases/schedule-ai-preview";
import {
  assignOfficials,
  type AssignPolicy,
  type OfficialFixture,
  type OfficialSpec,
} from "@seazn/engine/officials";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AiPlanRequest, AiPlanResponse } from "@/server/api-v1/schemas";
import { withCourtNames } from "../schedule";
import { MS_PER_MIN, toMs, zonedIso } from "./helpers";
import { planIsAcceptable, planRungs, runLadder } from "./ladder";
import { schedulingAiModel } from "./model-config";
import { buildSchedulePack } from "./pack";
import { runAiPlan } from "./run";
import type { AiPlanResult, SchedulePack } from "./types";

// ===========================================================================
// Phase A endpoint orchestrator (design/v4/00 §5, 03 §2). Gates → pack → run →
// dry officials coverage → telemetry. This is the single place the schedule
// architect meets the DB, the entitlement matrix, and the kill switch.
// ===========================================================================

type OfficialsCoverage = NonNullable<AiPlanResponse["officials_coverage"]>;

/** Dry officials coverage over the proposal — the same pure engine pass the
 *  officials-auto endpoint uses, run here with `locked: []` and no LLM. Maps the
 *  proposal to engine fixtures (epoch ms via matchMinutes) and the pack's
 *  officials to specs; `role_unfilled` conflicts are the coverage gaps. */
function coveragePreview(
  pack: SchedulePack,
  proposal: AiPlanResult["proposal"],
  policy: AssignPolicy,
): OfficialsCoverage {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const durMs = pack.settings.matchMinutes * MS_PER_MIN;
  const fixtures: OfficialFixture[] = proposal.map((a) => {
    const f = fixtureById.get(a.fixture_id);
    const startAt = toMs(a.scheduled_at);
    return {
      id: a.fixture_id,
      startAt,
      endAt: startAt + durMs,
      court: a.court_label,
      divisionId: pack.division.id,
      entrants: f ? [f.home, f.away].filter((e): e is string => e !== null) : [],
    };
  });
  const officials: OfficialSpec[] = pack.officials.map((o) => ({
    id: o.id,
    roleKeys: o.role_keys,
    ...(o.max_per_day !== null ? { maxPerDay: o.max_per_day } : {}),
    ...(o.entrant_ids.length > 0 ? { entrantIds: o.entrant_ids } : {}),
    homeDivisionId: pack.division.id,
  }));
  // `pack.tz` is the ORG zone (see SchedulePack.tz) — the day bucket the
  // maxPerDay cap and per_day fairness are counted on (#448).
  const { conflicts } = assignOfficials({
    fixtures,
    officials,
    locked: [],
    policy,
    rngSeed: "coverage",
    tz: pack.tz,
  });
  const unfilled = conflicts
    .filter((c) => c.kind === "role_unfilled")
    .map((c) => ({ fixture_id: c.fixtureId ?? "", role_key: c.roleKey ?? "" }));
  const total = proposal.length * policy.roles.length;
  return { total, unfilled, fillable: total - unfilled.length };
}

/** Convert the engine constraint delta (epoch-ms startWindows) into the API
 *  shape (ISO-with-offset in the division tz) that clients + the
 *  schedule-settings PUT speak. Non-startWindow fields pass through. */
function isoConstraintSuggestions(
  s: Partial<SchedulingConstraints>,
  tz: string,
): AiPlanResponse["constraint_suggestions"] {
  return {
    ...(s.restMin !== undefined ? { restMin: s.restMin } : {}),
    ...(s.restByGroup !== undefined ? { restByGroup: s.restByGroup } : {}),
    ...(s.noBackToBack !== undefined ? { noBackToBack: s.noBackToBack } : {}),
    ...(s.startWindows !== undefined
      ? {
          startWindows: s.startWindows.map((w) => ({
            target: w.target,
            ...(w.notBefore !== undefined ? { notBefore: zonedIso(w.notBefore, tz) } : {}),
            ...(w.notAfter !== undefined ? { notAfter: zonedIso(w.notAfter, tz) } : {}),
          })),
        }
      : {}),
    ...(s.fieldFairness !== undefined ? { fieldFairness: s.fieldFairness } : {}),
    ...(s.parallelism !== undefined ? { parallelism: s.parallelism } : {}),
    ...(s.crossPersonClash !== undefined ? { crossPersonClash: s.crossPersonClash } : {}),
  };
}

/** Wire the ladder to the real architect: each rung runs on its own provider,
 *  and a degraded plan escalates via the existing quality gate. The `meter`
 *  (lib/ai-rung.ts) is the SAME instance for every rung, so the run's hard
 *  token budget spans the whole ladder rather than resetting per rung.
 *
 *  Escalation stops the moment the meter refuses a round: continuing would
 *  enter each remaining rung only to have it throw before any network call,
 *  which spends nothing but writes models into `rungs_tried` that were never
 *  actually asked. */
async function runAiPlanLadder(
  pack: SchedulePack,
  movableIds: Set<string>,
  meter: TokenMeter,
  /** P9 pass 3d — threaded straight through to every rung's `runAiPlan`
   *  call. Defaults to empty. */
  courtDirectory: Record<string, PackCourtInfo> = {},
): Promise<AiPlanResult & { served_model: string; escalated_from?: string; rungs_tried: string[] }> {
  return runLadder(
    planRungs(),
    (rung) => runAiPlan(pack, movableIds, rung.model, rung.provider, meter, courtDirectory),
    (result) => planIsAcceptable(result, movableIds.size),
    () => !meter.stoppedOnBudget,
  );
}

/**
 * POST /divisions/{id}/schedule/ai-plan orchestrator. Gate order is deliberate
 * (design/v4/00 §5, wallet per SPEC-2 §5.2): the staged-rollout kill switch
 * (fail-open) → the paid gate (`scheduling.ai`, 402) → the frozen-division
 * check → the spend limiter (5/division/hour, 429) → build the deterministic
 * pack → reserve 1 AI credit, run the architect, settle/release (402 on an
 * empty wallet, right before the LLM call) → append the schedule.ai_generated
 * audit event → optional dry officials coverage. Telemetry fires on success AND
 * on a 422 AI_PLAN_FAILED (usage rides on the error's extra) so refused spend is
 * still metered.
 *
 * @throws HttpError 403 FEATURE_DISABLED (kill switch), 402 (paid gate or an
 *   empty AI credit wallet), 409 SCHEDULE_LOCKED (frozen division — refused
 *   before the spend gates), 429 (rate limit), plus everything
 *   buildSchedulePack/runAiPlan raise (409/422/400/503).
 */
export async function aiPlanForDivision(
  auth: AuthCtx,
  divisionId: string,
  input: AiPlanRequest,
): Promise<AiPlanResponse> {
  log.info({ orgId: auth.orgId, divisionId }, "schedule-ai: aiPlanForDivision start");
  // W5 (#400) Task 2b/H3. The confirmation is claimed early — before the pack,
  // the quote and the reserve — because an atomic single-use claim is the only
  // thing that makes a double-submitted confirm buy ONE run under READ
  // COMMITTED. The claim therefore has to be given back when the run never got
  // as far as reserving a credit, or an empty wallet or an unplannable division
  // would silently cost the organiser their confirmation and a second compile.
  //
  // The test is "was anything BOUGHT", not "did the reserve succeed" — the two
  // differ on every failure of the architect itself, which `spendCredit`
  // refunds. `creditConsumed` is therefore set inside the callback and unset
  // again by `onHoldReleased`; a settle failure leaves it set, because there the
  // run happened and the credit really is gone.
  const claim: PreviewClaim = { previewId: null, creditConsumed: false };
  try {
    return await planForDivision(auth, divisionId, input, claim);
  } catch (err) {
    // Curated fields, not the raw `err` — same reasoning as
    // `placement-client.ts`'s log sites: this catches everything
    // `planForDivision` can throw (see the JSDoc above), and nothing should
    // have to reason about what an arbitrary caught object might carry.
    log.warn(
      { message: err instanceof Error ? err.message : String(err), orgId: auth.orgId, divisionId },
      "schedule-ai: aiPlanForDivision failed",
    );
    if (claim.previewId !== null && !claim.creditConsumed) {
      await releasePreviewQuietly(claim.previewId, auth.orgId);
    }
    throw err;
  }
}

/** Mutable out-parameter for the release above: what this run claimed, and
 *  whether the organiser ended up paying for it. */
export interface PreviewClaim {
  previewId: string | null;
  creditConsumed: boolean;
}

/**
 * Hand a confirmation back without ever displacing the error that caused it.
 *
 * Both wrappers call this from a `catch`, so an unhandled throw here would
 * replace the 402/422 the caller has to see with a database error about a
 * bookkeeping detail. The worst case of swallowing it is the state we already
 * had before this fix — a preview that stays claimed — which is strictly better
 * than losing the real refusal.
 */
export async function releasePreviewQuietly(previewId: string, orgId: string): Promise<void> {
  try {
    await releasePreview(previewId, orgId);
  } catch (err) {
    log.warn(
      { message: err instanceof Error ? err.message : String(err), previewId, orgId },
      "schedule-ai: could not release preview after a failed run",
    );
  }
}

async function planForDivision(
  auth: AuthCtx,
  divisionId: string,
  input: AiPlanRequest,
  claim: PreviewClaim,
): Promise<AiPlanResponse> {
  // Stable analytics id: the user, or an org: synthetic when a key drives the
  // call (auth.userId is null for API-key auth — CaptureArgs convention).
  const distinctId = auth.userId ?? `org:${auth.orgId}`;
  // Kill switch (feature-flag rollout, not billing): fail-open so an unconfigured
  // or unreachable PostHog never blocks a paying customer.
  if (
    !(await isServerFeatureEnabled("ai-scheduling", distinctId, { orgId: auth.orgId, fallback: true }))
  ) {
    throw new HttpError(403, "AI scheduling is currently turned off", "FEATURE_DISABLED");
  }
  await requireFeature(auth.orgId, "scheduling.ai");

  // The per-division run cap this used to also gate on is retired (v17 Phase
  // 2 Task 5, V322) — runs are metered by the credit wallet on every tier
  // now (SPEC-2 §5.2/Task 4). This lookup only resolves the division's
  // competition + frozen state for the checks below.
  const gate = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string; name: string; schedule_locked: boolean }[]>`
      select competition_id, name, schedule_locked from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return {
      competitionId: division.competition_id,
      // #398: the stage-1 compile is shown division names so a scoped
      // instruction ("finals in the Open on Friday") can resolve to an id.
      divisionName: division.name,
      frozen: division.schedule_locked ?? false,
    };
  });

  // A frozen division rejects every applied plan (schedule.ts applySchedule,
  // 422 "the division schedule is locked"). Running the architect anyway spends
  // a generation, a rate-limit slot and real tokens to produce a proposal the
  // organiser is then blocked from using — the failure only surfaced at Apply,
  // several minutes and one paid run later. Refuse here, ahead of the quota and
  // spend gates, so a frozen board costs nothing.
  if (gate.frozen) {
    throw new HttpError(
      409,
      "the division schedule is frozen — unfreeze it to plan with AI",
      "SCHEDULE_LOCKED",
    );
  }
  // AI runs are metered by the credit wallet on EVERY tier (SPEC-2 §5.2), not
  // by plan — resolve the wallet up front; the actual reserve/402 happens right
  // before the LLM call below, so a frozen-division or rate-limited request
  // never touches the wallet at all.
  const walletId = await walletIdFor(auth.orgId);

  // W5 (#400). A confirmed compile is the one that executes. The organiser was
  // shown what their sentence compiled into and pressed "run with these rules";
  // compiling again here would hand the architect a SECOND, independently
  // non-deterministic answer and run it under a confirmation given for the
  // first — the exact failure this wave exists to close. So a mismatch refuses
  // instead of guessing, and the claim is atomic and single-use (see
  // `consumePreview` for why each of its six refusals is the same 409).
  //
  // Claimed BEFORE the rate limit, so an unusable preview_id costs the organiser
  // neither a slot nor a token; and a valid one skips the limiter entirely,
  // because the preview already spent that slot on the LLM round the limit
  // exists to bound. Charging twice would make looking before you leap cost a
  // run.
  const confirmed =
    input.preview_id !== undefined
      ? await consumePreview(input.preview_id, {
          orgId: auth.orgId,
          scope: "division",
          scopeId: divisionId,
          // Redundant here — a division preview's scope_id IS this id — and
          // written anyway, so the predicate is one unconditional array
          // equality on both paths rather than a shape the joint path alone
          // has to remember (V346).
          divisionIds: [divisionId],
          instruction: input.instruction,
        })
      : null;
  if (input.preview_id !== undefined && confirmed === null) {
    throw new HttpError(
      409,
      "that preview no longer matches this request — check the instruction again",
      PREVIEW_STALE,
    );
  }
  // Held from here on: everything below may throw, and until a credit is
  // actually reserved this confirmation is owed back to the organiser.
  if (confirmed !== null) claim.previewId = input.preview_id!;

  if (confirmed === null) await rateLimit(`ai-plan:${divisionId}`, { max: 5, windowSeconds: 3600 });

  // The one wall-clock read on this path (#397). Everything downstream — the
  // pack builder, the clock, the window — takes the instant as a parameter, so
  // a run is reproducible from its inputs alone.
  // Stage-1 compile (#398), OUTSIDE `spendCredit` and ahead of the quote. A
  // credit buys a token BUDGET, not a number of rounds, so an extra LLM round
  // must never mint one — and the confirm step W5 (#400) adds is only genuinely
  // free to walk away from if this round is unpriced. Own meter, own ~1K
  // ceiling; the abuse bound is the rate limit above, five runs an hour.
  //
  // A failure here is NOT fatal. The run continues with no compiled rules rather
  // than presenting a rule as enforced while nothing enforces it.
  //
  // Skipped when the wallet cannot cover even the CHEAPEST this request could
  // be. "402 before any model call" is a standing invariant of this path
  // (schedule-ai-route.test.ts), and unpriced is not the same as free: an org
  // that cannot pay for the run must not spend our tokens compiling for it.
  // A lower bound, never an estimate — it can only decline to skip, never skip a
  // run that would have gone through. The 402 itself still comes from
  // `spendCredit` below, unchanged.
  //
  // The COMPILE is skipped on a confirmed preview — that round already happened
  // and was already metered on its own ledger row — but the affordability bound
  // is NOT (Task 2b/H3). The preview checked it minutes ago; a wallet emptied by
  // another run in between makes this run a 402, and finding that out at the
  // reserve costs the confirmation as well as the run. Checking it here refuses
  // before the pack is built, and the release above hands the confirmation back
  // so the retry is free.
  const canPay = (await balance(walletId)) >= minimumCredits([input.rung]);
  if (confirmed !== null && !canPay) throw new PaymentRequiredError("ai.credits");
  const parse =
    confirmed !== null
      ? { raw: confirmed.raw, failed: false, tokens: 0, servedModel: null }
      : input.instruction.trim().length > 0 && canPay
        ? await parseInstruction(input.instruction, {
            divisions: [{ id: divisionId, name: gate.divisionName }],
          })
        : { raw: null, failed: false, tokens: 0, servedModel: null };

  // OMITTED when no compile ran on THIS request — an empty instruction, a wallet
  // that could not pay for one, or a reused preview whose tokens are already
  // stamped on its own `schedule.ai_previewed` row. Without this,
  // `parse_failed: false` on the ledger doubles as "never attempted" (or, worse,
  // bills the same compile twice) and reconciliation cannot tell them apart.
  const parseStamp =
    parse.servedModel !== null || parse.failed
      ? { tokens: parse.tokens, failed: parse.failed }
      : undefined;

  const { pack, movableIds, courtDirectory } = await buildSchedulePack(auth, divisionId, {
    ...input,
    now: Date.now(),
    raw: parse.raw,
    parseFailed: parse.failed,
    // The RESOLVED parse as the organiser saw it, not a re-resolution of `raw`.
    // `resolveParsed` reads the org clock, so re-running it minutes later can
    // move a symbolic "tomorrow" onto a different date — a run under rules
    // nobody approved, arrived at without a single extra model call.
    ...(confirmed !== null ? { resolved: confirmed.resolved } : {}),
  });

  // Token-weighted credit pricing (lib/ai-rung.ts). One line — a division is
  // one unit of work — so `credits` is just its rung; #350's joint solve passes
  // one line per division to the SAME function and gets the batch discount.
  // The server always recomputes this: a client's displayed prediction, and its
  // `rung` override, are advisory. A pick below the prediction is honoured and
  // stamps `underfunded`.
  const quote = quoteRun(
    [
      {
        key: divisionId,
        input: {
          movableFixtures: movableIds.size,
          entrants: pack.entrants.length,
          courts: pack.settings.courts.length,
        },
        ...(input.rung !== undefined ? { chosen: input.rung } : {}),
      },
    ],
    schedulingRungWeights(),
  );
  // One meter for the whole run — every ladder rung and repair round charges it.
  // Sized by the movable fixtures so the per-round reserve is large enough to
  // actually emit this pack's assignment list.
  const meter = createTokenMeter(quote.budget, { units: movableIds.size });

  let result: AiPlanResult & { served_model: string; escalated_from?: string; rungs_tried: string[] };
  try {
    // Reserve `quote.credits` → run the architect → settle on success / release
    // on failure (SPEC-2 §5.2). PaymentRequiredError("ai.credits") from an empty
    // wallet falls through the catch below untouched (it matches neither
    // planErr nor providerErr) and rethrows as the 402.
    result = await spendCredit(
      walletId,
      auth.orgId,
      quote.credits,
      async () => {
        // The hold exists by the time this runs. Provisionally consumed…
        claim.creditConsumed = true;
        return {
          aiRunId: crypto.randomUUID(),
          result: await runAiPlanLadder(pack, movableIds, meter, courtDirectory),
        };
      },
      // …and un-consumed again if the ladder throws, because `spendCredit`
      // refunds the hold in that case: a timed-out or refused run costs the
      // organiser nothing, so it must not cost them their confirmation either.
      { onHoldReleased: () => (claim.creditConsumed = false) },
    );
  } catch (err) {
    // Meter a refused / un-correctable / timed-out run's token spend too —
    // usage rides on the 422 extra so a failed architect call is not invisible
    // in analytics or the run ledger. The failure row uses its own event type
    // ('schedule.ai_failed'): the quota above counts 'schedule.ai_generated'
    // only, so failures never consume a generation.
    // A provider-level failure (billing 400, auth 401, rate-limit 429,
    // overloaded 529, upstream 5xx — wrapped as AiProviderError by the
    // adapter) is NOT a planning failure — the provider is unusable right
    // now. Before 2026-07-20 it matched neither branch below: it was
    // rethrown raw from callModel, surfaced to the tenant as a 500, and left no
    // ledger row. Observed live during the effort bench, where an exhausted
    // credit balance took AI scheduling down with no diagnostic. Meter it under
    // its own outcome and translate it to a 503 — the provider's message can
    // carry our billing state and must never reach a tenant.
    const providerErr = err instanceof AiProviderError ? err : null;
    // The adapter's cause is the raw SDK error (Anthropic.APIError has
    // `status` + `name`) — read defensively since other providers' causes may
    // not carry the same shape.
    const providerCause = providerErr?.cause as { status?: number; name?: string } | undefined;
    const planErr =
      err instanceof HttpError && (err.code === "AI_PLAN_FAILED" || err.code === "AI_PLAN_TIMEOUT") ? err : null;

    if (planErr || providerErr) {
      // The ladder annotates the thrown error with the accumulated usage across
      // every rung it tried and the last rung's model, so a failed run is
      // metered against the true total spend and the true (last) model — not a
      // static default. Provider errors carry the annotation as loose fields.
      const usage = (planErr?.extra?.usage ??
        (err as { usage?: Record<string, unknown> }).usage ??
        {}) as {
        input_tokens?: number;
        output_tokens?: number;
        repair_rounds?: number;
        cost_usd?: number | null;
      };
      const model =
        (planErr?.extra?.model as string | undefined) ??
        (err as { model?: string }).model ??
        schedulingAiModel();
      const outcome = providerErr ? "provider_error" : planErr!.code === "AI_PLAN_TIMEOUT" ? "timeout" : "failed";
      const cost_usd = usage.cost_usd ?? aiRunCostUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
      await withTenant(auth.orgId, async (tx) => {
        await tx`
          insert into competition_events (competition_id, org_id, type, payload, actor_id)
          values (${gate.competitionId}, ${auth.orgId}, 'schedule.ai_failed',
                  ${tx.json({
                    division_id: divisionId,
                    phase: "schedule",
                    mode: input.mode,
                    outcome,
                    model,
                    usage: {
                      input_tokens: usage.input_tokens ?? 0,
                      output_tokens: usage.output_tokens ?? 0,
                      repair_rounds: usage.repair_rounds ?? 0,
                    },
                    cost_usd,
                    // Size measure alongside cost (v17 gap #295 — instrument
                    // now, weight later): the fixture count the pack builder
                    // already computed, the same number already reported to
                    // PostHog as `fixtures`.
                    pack_units: movableIds.size,
                    // Token-weighted credit pricing (lib/ai-rung.ts): what was
                    // charged, what it bought, what the predictor said, how much
                    // the run actually spent and whether the BUDGET cut it off
                    // — even on a failed run the credits were reserved, so the
                    // ledger stamps it here too. One helper builds this fragment
                    // for every surface so they cannot drift.
                    ...meterStamp(quote, meter, parseStamp),
                    // Provider diagnostics stay server-side (ops needs the real
                    // status; the tenant gets a bare 503).
                    ...(providerErr
                      ? { provider_status: providerCause?.status ?? null, provider_type: providerCause?.name ?? providerErr.name }
                      : {}),
                  } as never)}, ${auth.userId})`;
      });
      await captureServer({
        event: "ai_plan_run",
        distinctId,
        orgId: auth.orgId,
        properties: {
          phase: "schedule",
          mode: input.mode,
          model,
          fixtures: movableIds.size,
          repair_rounds: usage.repair_rounds ?? 0,
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cost_usd,
          blocking: 0,
          outcome,
          ...(providerErr ? { provider_status: providerCause?.status ?? null } : {}),
        },
      });
    }
    if (providerErr) {
      throw new HttpError(503, "AI scheduling is temporarily unavailable; please retry", "AI_PROVIDER_UNAVAILABLE");
    }
    throw err;
  }

  // Record this generation against the per-division cap counted above (owner
  // 2026-07-18). Append-only audit; org_id is set explicitly by the insert below.
  // Stamp the model the ladder ACTUALLY served (winning rung), not a static
  // default — so the audit and cost (result.usage sums every rung tried) reflect
  // what really ran and what it really cost.
  const model = result.served_model;
  const cost_usd = result.usage.cost_usd ?? aiRunCostUsd(model, result.usage.input_tokens, result.usage.output_tokens);
  await withTenant(auth.orgId, async (tx) => {
    await tx`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${gate.competitionId}, ${auth.orgId}, 'schedule.ai_generated',
              ${tx.json({
                division_id: divisionId,
                mode: input.mode,
                model,
                usage: result.usage,
                cost_usd,
                // Size measure alongside cost (v17 gap #295): the fixture
                // count the pack builder already computed — the smallest
                // correct instrumentation ahead of any size-weighted pricing
                // decision (deferred, SPEC-2 §5.1).
                pack_units: movableIds.size,
                // Token-weighted credit pricing (lib/ai-rung.ts): what was
                // charged, what token budget it bought, what the predictor
                // said, how much of the budget this run actually spent, whether
                // the org picked below the prediction, and whether the budget
                // cut the run short — the last is what makes a mispriced rung
                // visible instead of looking like a merely degraded plan.
                ...meterStamp(quote, meter, parseStamp),
                // Ladder telemetry: which model was tried first and rejected,
                // the full ordered chain of rungs attempted (so a 3-rung fall
                // gemini→sonnet→grok is auditable — `model` above is only the
                // winner), and the warning ratio that rejected it. The threshold
                // is uncalibrated (see escalationWarningRatio), so the ledger has
                // to carry what it would take to tune it.
                ...(result.escalated_from
                  ? {
                      escalated_from: result.escalated_from,
                      rungs_tried: result.rungs_tried,
                      warnings: result.warnings.length,
                      movable: movableIds.size,
                    }
                  : {}),
              } as never)}, ${auth.userId})`;
  });

  // Expensive-run watch (v17 gap #295): best-effort, never throws, silent
  // without a baseline or STAFF_ALERT_EMAIL — see maybeAlertExpensiveRun.
  // Deliberately AFTER the schedule.ai_generated insert above: the baseline
  // median is read from that same table, so this run counts in its own window
  // (moot at AI_RUN_MEDIAN_MIN_SAMPLE=20, but the order is pinned by test).
  // Registered as tail work: the check is a table scan plus an email send, and
  // the tenant's paid response must not wait on staff telemetry.
  // Also deliberately success-only — an expensive FAILURE (schedule.ai_failed
  // carries a real cost_usd) does not alert here; aborted/retried runs are a
  // different cost story and a different alert class, out of #295's scope.
  // mode + pack_units travel with the cost so the staff email is triageable on
  // its own — a regenerate over 400 movable fixtures at $0.90 is a different
  // story from a nudge over 6 at the same price. pack_units is the SAME number
  // stamped on the schedule.ai_generated row above (movableIds.size), so the
  // alert and the audit trail can never disagree about the run's size.
  deferred(() =>
    maybeAlertExpensiveRun({
      orgId: auth.orgId,
      competitionId: gate.competitionId,
      phase: "schedule",
      model,
      costUsd: cost_usd,
      mode: input.mode,
      packUnits: movableIds.size,
    }),
  );

  // #387: what the confirm card said, against what was actually charged.
  // AFTER the ledger row above and outside every gate — the credit is already
  // spent, so this reports and records; it never refuses.
  const quote_mismatch = await recordQuoteMismatch(
    auth,
    { competitionId: gate.competitionId, divisionIds: [divisionId] },
    input.quoted_credits,
    quote.credits,
  );

  const officials_coverage = input.officials_policy
    ? coveragePreview(pack, result.proposal, input.officials_policy)
    : null;

  // Review wave 3: the id -> venue-qualified label map this response's
  // conflicts resolve through. Built from the pack's OWN directory (already
  // in scope for `toModelPayload`), so the organiser reads the same court
  // label the model was shown.
  const packCourtNames = new Map(
    Object.entries(courtDirectory).map(([id, info]) => [id, info.label] as const),
  );
  const withPackCourtNames = <C extends { details?: ConflictDetail }>(c: C): C =>
    c.details !== undefined ? { ...c, details: withCourtNames(c.details, packCourtNames) } : c;

  await captureServer({
    event: "ai_plan_run",
    distinctId,
    orgId: auth.orgId,
    properties: {
      phase: "schedule",
      mode: input.mode,
      model,
      fixtures: movableIds.size,
      repair_rounds: result.usage.repair_rounds,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      cost_usd,
      blocking: result.blocking.length,
      outcome: "ok",
    },
  });

  return {
    proposal: result.proposal,
    unschedulable: result.unschedulable,
    // `AiPlanConflict` carries the engine `Conflict` verbatim (see its own
    // comment in schemas.ts) — `details` already rides along unchanged;
    // `withLegacyDetail` only restores the deprecated `detail` string the
    // engine stopped producing (C3, 2026-08-13 design amendment), so an
    // existing client reading `.detail` off `warnings`/`blocking` keeps
    // working.
    // Review wave 3: resolve the court NAME before the legacy prose is built.
    // `withLegacyDetail` reads `details.courtName ?? details.court`, and
    // `formatConflictDetail` on the client degrades to "Unknown court" without
    // it — so an unresolved conflict here reached the AI diff panel as
    // "Unknown court" and the deprecated sentence as a raw uuid.
    warnings: result.warnings.map((c) => withLegacyDetail(withPackCourtNames(c))),
    blocking: result.blocking.map((c) => withLegacyDetail(withPackCourtNames(c))),
    diff: result.diff,
    explanations: result.explanations,
    ...(result.constraint_suggestions !== undefined
      ? { constraint_suggestions: isoConstraintSuggestions(result.constraint_suggestions, pack.division.tz) }
      : {}),
    summary: result.summary,
    // The ARCHITECT's assumptions (stage 2). The resolver's are a different
    // array on a different response — see AiPlanResponse.assumptions.
    assumptions: result.assumptions,
    // Public shape is pinned to AiPlanResponse.usage in api-v1/schemas.ts —
    // exactly these three fields. cost_usd lives on AiPlanResult["usage"] for
    // the ledger (competition_events insert above) but must not leak into the
    // API response, so it is built explicitly here rather than by spreading
    // result.usage.
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      repair_rounds: result.usage.repair_rounds,
    },
    // W6 (#401): which engine repaired the board, and what the automatic one
    // did or gave up on. Carried whole — the fields are already the public
    // shape, and a run that fell back must be able to say so to the organiser.
    repair: result.repair,
    officials_coverage,
    // Token-weighted credit pricing (lib/ai-rung.ts) — what was charged, what
    // the predictor said, whether the confirm card's warning applies, and
    // whether the budget cut the run short, so the client can reconcile against
    // its own (advisory) prediction.
    ...meterStamp(quote, meter, parseStamp),
    // #387 — present only when the card and the charge disagreed.
    ...(quote_mismatch ? { quote_mismatch } : {}),
  };
}
