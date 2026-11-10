import "server-only";
// ===========================================================================
// #350 Phase C — the ORCHESTRATOR. Gates, pricing, the credit spend, the two
// competition-level ledger events. This is the money path: everything that can
// refuse must refuse BEFORE `spendCredit`, and the gate ORDER below is the
// acceptance criterion, not an implementation detail.
// ===========================================================================

const SINGLE_DIVISION = "AI_PLAN_SINGLE_DIVISION";

/** Fewer than two divisions to solve. This is not merely a UX nicety: pricing
 *  gives a joint run `max(1, Σ rungs − 1)`, so a lone rung-2 division routed
 *  through this endpoint would cost 1 credit instead of the 2 the division
 *  endpoint charges. The rule closes that arbitrage, which is why it also fires
 *  when the zero-movable drop below leaves only one division standing. */
const singleDivision = (): HttpError =>
  new HttpError(400, "use the division schedule page to plan a single division", SINGLE_DIVISION);

/** A division whose own data cannot be planned (spec §11). Refused before any
 *  credit is reserved and NAMES the division — "something is wrong somewhere in
 *  your competition" is not an actionable error for a 12-division board. */
const UNPLANNABLE = "AI_PLAN_DIVISION_UNPLANNABLE";
import { withTenant } from "@/lib/db";
import { HttpError, PaymentRequiredError } from "@/lib/errors";
import { resolveVenueTz } from "@/lib/tz";
import type { AuthCtx } from "@/server/api-v1/auth";
import { assessCapacity, type CapacityReport } from "@seazn/engine/scheduling/capacity";
import { movableFixtureSql, toSlotConfig } from "../schedule";
import {
  CAPACITY_IMPOSSIBLE_CODE,
  capacityInputForFixtures,
  logCapacityAssessed,
} from "../capacity-guard";
import { ScheduleConfig } from "@/server/api-v1/schemas";
import {
  schedulingAiModel,
  toRuleFixture,
  releasePreviewQuietly,
  type PreviewClaim,
} from "../schedule-ai";
import { parseInstruction } from "../schedule-ai-parse";
import { consumePreview, PREVIEW_STALE } from "../schedule-ai-preview";
import { withLegacyDetail } from "@/server/api-v1/conflict-detail-legacy";
import { AiProviderError } from "@/server/ai/provider";
import { aiRunCostUsd } from "@/lib/ai-pricing";
import {
  createTokenMeter,
  meterStamp,
  minimumCredits,
  quoteRun,
  schedulingRungWeights,
} from "@/lib/ai-rung";
import { balance, spendCredit, walletIdFor } from "@/lib/credits";
import { deferred } from "@/lib/deferred";
import { recordQuoteMismatch } from "../ai-quote-mismatch";
import { requireFeature } from "@/lib/entitlements";
import { captureServer, isServerFeatureEnabled } from "@/lib/posthog-server";
import { rateLimit } from "@/lib/rate-limit";
import { assertCompetitionNotFrozen } from "../entitlement-freeze";
import { maybeAlertExpensiveRun } from "../ai-runs-admin";
import { cmp } from "./helpers";
import { runCompetitionAiPlanLadder } from "./joint-run";
import { JOINT_RUN_EVENT } from "./last-apply";
import { buildCompetitionPack } from "./pack";
import type {
  AiCompetitionPlanRequest,
  AiCompetitionPlanResponse,
  CompetitionPlanResult,
} from "./types";

/**
 * POST /competitions/{id}/schedule/ai-plan orchestrator — the joint twin of
 * `aiPlanForDivision` (schedule-ai/orchestrator.ts).
 *
 * GATE ORDER, and why each step sits where it does:
 *
 *   1. kill switch `ai-scheduling` (fail-open) — a rollout switch, never a
 *      billing gate, so an unreachable PostHog must not block a paying org.
 *   2. `scheduling.ai` (402).
 *   3. `scheduling.multi_division` (402). This is the FIRST server-side
 *      enforcement of that key anywhere: until now it only hid a page
 *      (`c/[compSlug]/schedule/page.tsx:36`), so an API caller could reach
 *      multi-division behaviour without the plan.
 *   4. `>= 2` divisions (400) — the discount-arbitrage rule above.
 *   5. competition + divisions in ONE query: unknown competition 404, a
 *      requested id not in this competition 404 naming it, a frozen division
 *      409 naming it.
 *   6. a division that cannot be planned at all (no courts / unparseable
 *      settings) 422 naming it.
 *   6b. divisions with nothing movable are DROPPED (ruling R6), not refused —
 *      a joint action over five divisions must not fail because one of them is
 *      already fully scheduled, and must never charge for a division it did not
 *      solve. Fewer than two left falls back to step 4's 400.
 *   7. wallet resolve, 8. rate limit (its OWN key namespace — a joint run must
 *      not consume the per-division 5/hr buckets), 9. pack build (the summed
 *      500 cap fires here), 10. quote, 11. `spendCredit`.
 *
 * Everything through step 10 happens before a single credit is reserved.
 *
 * @throws HttpError 403 FEATURE_DISABLED, 402 (either paid gate, or an empty
 *   credit wallet), 400 AI_PLAN_SINGLE_DIVISION, 404, 409 SCHEDULE_LOCKED,
 *   409 AI_PLAN_TOO_LARGE, 422 AI_PLAN_DIVISION_UNPLANNABLE, 429, plus
 *   everything the runner raises (422 AI_PLAN_FAILED/AI_PLAN_TIMEOUT, 503).
 */
export async function aiPlanForCompetition(
  auth: AuthCtx,
  competitionId: string,
  input: AiCompetitionPlanRequest,
): Promise<AiCompetitionPlanResponse> {
  // W5 (#400) Task 2b/H3, the joint twin of `aiPlanForDivision`'s wrapper: the
  // confirmation is claimed early so a double-submitted confirm buys ONE run,
  // and is handed back when the run never reached a reserved credit. A joint
  // run is the most expensive one this product has, so paying twice for the
  // same compile after a 402 is the most expensive version of that bug too.
  const claim: PreviewClaim = { previewId: null, creditConsumed: false };
  try {
    return await planForCompetition(auth, competitionId, input, claim);
  } catch (err) {
    if (claim.previewId !== null && !claim.creditConsumed) {
      await releasePreviewQuietly(claim.previewId, auth.orgId);
    }
    throw err;
  }
}

async function planForCompetition(
  auth: AuthCtx,
  competitionId: string,
  input: AiCompetitionPlanRequest,
  claim: PreviewClaim,
): Promise<AiCompetitionPlanResponse> {
  // Stable analytics id: the user, or an org: synthetic when an API key drives
  // the call (auth.userId is null for key auth).
  const distinctId = auth.userId ?? `org:${auth.orgId}`;
  if (
    !(await isServerFeatureEnabled("ai-scheduling", distinctId, { orgId: auth.orgId, fallback: true }))
  ) {
    throw new HttpError(403, "AI scheduling is currently turned off", "FEATURE_DISABLED");
  }
  await requireFeature(auth.orgId, "scheduling.ai");
  // Competition-scoped since V353 (#382): an Event Pass now lifts
  // `scheduling.multi_division`, and a pass covers ONE competition — the
  // competition being planned is the only honest scope to ask about.
  await requireFeature(auth.orgId, "scheduling.multi_division", competitionId);

  const requested = [...new Set(input.division_ids)];
  if (requested.length < 2) throw singleDivision();

  // A competition frozen by competitions.max_active (a downgrade left more
  // active competitions than the plan allows) is read-only: applySchedule
  // refuses with a 402 (schedule/). Exactly the argument the
  // schedule_locked 409 below makes — planning one spends credits and tokens
  // on a proposal the organiser is then blocked from applying — except a
  // joint run's charge is N times larger, so it is checked here rather than
  // inherited from the single-division path, which does not check it.
  //
  // OUTSIDE the transaction: the freeze lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. An unknown competition is never a
  // member of the frozen set, so the entity's own 404 still fires first.
  await assertCompetitionNotFrozen(auth.orgId, competitionId);

  const rows = await withTenant(auth.orgId, async (tx) => {
    const [comp] = await tx<{ id: string }[]>`
      select id from competitions where id = ${competitionId}`;
    if (!comp) throw new HttpError(404, "competition not found");
    // One query for every per-division gate below — locked state, slot config
    // and the movable count that decides the R6 drop. The count is un-scoped
    // `movableFixtureSql` (scheduled, holding no result: `isMovable`, which is
    // what the joint builder plans, and it never passes a repair `scope`), so
    // it cannot disagree with the pack.
    return tx<
      {
        id: string;
        name: string;
        slug: string;
        schedule_locked: boolean | null;
        config: unknown | null;
        movable: number;
      }[]
    >`
      select d.id, d.name, d.slug, d.schedule_locked, ss.config,
             (select count(*)::int from fixtures f
               where f.division_id = d.id and ${movableFixtureSql(tx)}) as movable
        from divisions d
        left join schedule_settings ss on ss.division_id = d.id
       where d.competition_id = ${competitionId} and d.id in ${tx(requested)}`;
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Checks run in REQUEST order so the error a caller gets back is a function
  // of the request alone, never of row order out of Postgres.
  for (const id of requested) {
    if (!byId.has(id)) throw new HttpError(404, `division not in competition: ${id}`);
  }
  for (const id of requested) {
    const row = byId.get(id)!;
    // A frozen division rejects every applied plan, so planning one spends
    // credits and tokens on a proposal the organiser is then blocked from
    // using — the failure would surface minutes later at Apply. Refuse here.
    if (row.schedule_locked === true) {
      throw new HttpError(
        409,
        `the schedule for division "${row.name}" is frozen — unfreeze it to plan with AI`,
        "SCHEDULE_LOCKED",
      );
    }
  }
  for (const id of requested) {
    const row = byId.get(id)!;
    // `courts` is min(1) in ScheduleConfig, so an empty list can only reach the
    // row from outside the API — and it would otherwise surface as a 500 from
    // the parse inside buildSchedulePack. Both branches are live: the first is
    // the specific, actionable message, the second catches every other way a
    // hand-edited config fails to parse.
    const raw = (row.config ?? {}) as { courts?: unknown };
    if (Array.isArray(raw.courts) && raw.courts.length === 0) {
      throw new HttpError(
        422,
        `division "${row.name}" has no courts configured — set them on its schedule settings`,
        UNPLANNABLE,
      );
    }
    if (!ScheduleConfig.safeParse(row.config ?? {}).success) {
      throw new HttpError(
        422,
        `division "${row.name}" has invalid schedule settings and cannot be planned`,
        UNPLANNABLE,
      );
    }
  }

  // Ruling R6. Dropped BEFORE the quote, so a division with nothing to solve is
  // never a priced line — and, in `repair` mode, so the per-division builder's
  // 422 AI_PLAN_EMPTY_SCOPE can never escape from a joint call.
  const kept = requested.filter((id) => byId.get(id)!.movable > 0);
  const skipped_divisions = requested
    .filter((id) => byId.get(id)!.movable === 0)
    .map((id) => ({
      id,
      name: byId.get(id)!.name,
      reason: "no_movable_fixtures" as const,
    }))
    // Same (name, slug) domain order the pack sorts divisions by — never the id.
    .sort(
      (a, b) =>
        cmp(a.name, b.name) || cmp(byId.get(a.id)!.slug, byId.get(b.id)!.slug),
    );
  if (kept.length < 2) throw singleDivision();

  // D2 capacity pre-check (owner ruling, guard `aiPlanForCompetition`):
  // assess each kept division's arithmetic feasibility BEFORE the wallet is
  // touched, same reasoning as the courts/config checks just above — an AI
  // run that cannot possibly fit its courts and dates must not spend a
  // credit finding that out. Scope is deliberately narrower than the stage
  // guard: whole-day aggregate caps and court/rest arithmetic only, no
  // per-entrant rest bound here (that runs per-division at solve time via
  // the SAME `autoSchedule` path when an organiser later runs Auto-schedule
  // on one of these divisions) — this is a coarse, cheap pre-flight, not a
  // second copy of the full check.
  const capacityImpossible: { id: string; name: string; report: CapacityReport }[] = [];
  await withTenant(auth.orgId, async (tx) => {
    const [org] = await tx<{ timezone: string | null }[]>`select timezone from organizations where id = ${auth.orgId}`;
    const orgTz = resolveVenueTz(null, org?.timezone ?? null);
    // id/ext_key/winner_to_fixture (same three columns rowToRuleFixture
    // renames, schedule/) are what let this guard's forcedDemand floor
    // (fixture_on_date/fixture_on_weekday) resolve at all — without them
    // capacityInputForFixtures still runs, just with no fixture identity to
    // resolve a selector against (see CapacityFixtureInput's own comment).
    const fixtureRows = await tx<
      {
        id: string;
        division_id: string;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        pool_id: string | null;
        ext_key: string | null;
        winner_to_fixture: string | null;
      }[]
    >`
      select f.id, f.division_id, f.home_entrant_id, f.away_entrant_id, f.pool_id, f.ext_key, f.winner_to_fixture
      from fixtures f
      where f.division_id in ${tx(kept)} and ${movableFixtureSql(tx)}`;
    for (const id of kept) {
      const row = byId.get(id)!;
      const parsed = ScheduleConfig.safeParse(row.config ?? {});
      if (!parsed.success) continue; // already refused by the loop above
      // `toSlotConfig` ALONE never sets `.tz` — `toVerifyConfig` is the
      // builder that adds it (`tz: settings.orgTz`), and `capacityInputFor
      // Fixtures` skips (returns null, "nothing to assess") whenever `tz`
      // is undefined. Calling `toSlotConfig` directly here — caught only by
      // the new competition-guard tests this review round added — made
      // this guard a permanent no-op: every division always resolved to a
      // skipped assessment, regardless of how oversubscribed it was.
      const slotConfig = { ...toSlotConfig({ division_id: id, config: parsed.data, displayTz: orgTz, orgTz, updated_at: "" }, Date.now()), tz: orgTz };
      // The identity half comes from the ONE shared builder, not a second
      // literal. `capacityInputForFixtures` needs exactly the facts a
      // `RuleFixture` already carries — id, extKey, poolId, winnerTo — so
      // writing them out here would be a fourth producer of `winnerTo`, and
      // #443 was precisely two copies of that drifting onto a shared wrong
      // assumption. `competition-schedule-ai-repair.test.ts` counts the
      // producers per file and requires zero in this one; it caught this
      // exact regression, which is why the delegation is not optional.
      // Column names differ on this row shape, hence the adapter — the same
      // move the two other call sites in this file already make.
      const fixtures = fixtureRows
        .filter((f) => f.division_id === id)
        .map((f) => ({
          home: f.home_entrant_id ?? undefined,
          away: f.away_entrant_id ?? undefined,
          ...toRuleFixture(
            { id: f.id, ext_key: f.ext_key, pool: f.pool_id, feeds: { winner_to: f.winner_to_fixture } },
            id,
          ),
        }));
      const input = capacityInputForFixtures(fixtures, slotConfig, id);
      if (input === null) continue; // no bounded window to assess — skip, not impossible
      const report = assessCapacity(input);
      logCapacityAssessed(report, { scope: "competition_division", divisionId: id, competitionId });
      if (report.verdict === "impossible") capacityImpossible.push({ id, name: row.name, report });
    }
  });
  if (capacityImpossible.length > 0) {
    throw new HttpError(
      422,
      `these divisions cannot fit their configured courts, dates and rest rules: ${capacityImpossible.map((d) => d.name).join(", ")}`,
      CAPACITY_IMPOSSIBLE_CODE,
      { divisions: capacityImpossible },
    );
  }

  // AI runs are wallet-metered on every tier (v17 SPEC-2 §5.2). Resolved here;
  // the reserve itself happens below, right around the model call, so a
  // rate-limited or too-large request never touches the wallet.
  const walletId = await walletIdFor(auth.orgId);

  // W5 (#400), the joint twin of the single-division gate: a confirmed compile
  // is the one that executes, and a `preview_id` that no longer matches this
  // request refuses rather than silently recompiling behind a confirmation the
  // organiser already gave. Scoped to the COMPETITION, so a preview taken
  // against one division — whose window resolved from that division's fixture
  // count alone — cannot authorise a joint run. Claimed before the limiter for
  // the reasons stated on `aiPlanForDivision`.
  const confirmed =
    input.preview_id !== undefined
      ? await consumePreview(input.preview_id, {
          orgId: auth.orgId,
          scope: "competition",
          scopeId: competitionId,
          // H1 (V346). `scope_id` is the COMPETITION and says nothing about
          // which divisions were selected — yet the stored window was resolved
          // from their SUMMED movable-fixture count and the compiler was shown
          // them by name. `kept`, not `requested`: R6 drops a division with
          // nothing movable before the price, and the preview drops it too, so
          // adding an already-scheduled division must not invalidate a
          // confirmation the run would not charge for either.
          divisionIds: kept,
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
  // Held from here on; see the wrapper above.
  if (confirmed !== null) claim.previewId = input.preview_id!;

  // Its OWN key namespace. Sharing `ai-plan:{divisionId}` would let one joint
  // run burn a slot in every selected division's per-division bucket. Skipped on
  // a confirmed preview: that request already spent this bucket's token on the
  // LLM round the limit exists to bound.
  if (confirmed === null) {
    await rateLimit(`ai-plan-competition:${competitionId}`, { max: 3, windowSeconds: 3600 });
  }

  // Stage-1 compile (#398), OUTSIDE `spendCredit` and ahead of the quote — the
  // joint twin of the single-division pre-flight. A credit buys a token BUDGET,
  // not a number of rounds. The model is shown every kept division's id and
  // name, so "finals in the Open on Friday" can compile to a scoped rule; a
  // failure is not fatal and simply leaves the run with no compiled rules.
  // Skipped when the wallet cannot cover the cheapest this request could be, for
  // the reason the single-division path states: unpriced is not free, and "the
  // refusal happened before any model call" is an invariant of this path too
  // (smoke.ts, #350 joint/credits). With per-division overrides supplied the
  // bound is the exact price; without them each line floors at rung 1. The 402
  // still comes from `spendCredit`.
  //
  // The COMPILE is skipped on a confirmed preview — already run, already metered
  // on its own ledger row — but the affordability bound is NOT (Task 2b/H3). The
  // preview checked it minutes ago; a wallet emptied by another run in between
  // makes this a 402, and discovering that at the reserve costs the confirmation
  // as well as the run. Refuse here, before the pack is built, and the wrapper
  // above gives the confirmation back so the retry is free.
  const canPay =
    (await balance(walletId)) >= minimumCredits(kept.map((id) => input.rung_overrides?.[id]));
  if (confirmed !== null && !canPay) throw new PaymentRequiredError("ai.credits");
  const parse =
    confirmed !== null
      ? { raw: confirmed.raw, failed: false, tokens: 0, servedModel: null }
      : input.instruction.trim().length > 0 && canPay
        ? await parseInstruction(input.instruction, {
            divisions: kept.map((id) => ({ id, name: byId.get(id)!.name })),
          })
        : { raw: null, failed: false, tokens: 0, servedModel: null };

  // OMITTED when no compile ran on THIS request — an empty instruction, a wallet
  // that could not pay for one, or a reused preview whose tokens are already
  // stamped on its own `schedule.ai_previewed` row. Without this,
  // `parse_failed: false` on the ledger doubles as "never attempted" (or bills
  // one compile twice) and reconciliation cannot tell them apart.
  const parseStamp =
    parse.servedModel !== null || parse.failed
      ? { tokens: parse.tokens, failed: parse.failed }
      : undefined;

  // The summed 500-fixture cap lives in here — still before any reserve.
  const { pack, movableIds, courtDirectory } = await buildCompetitionPack(auth, competitionId, kept, {
    mode: input.mode,
    instruction: input.instruction,
    raw: parse.raw,
    parseFailed: parse.failed,
    // The resolution the organiser actually saw, not a re-resolution against a
    // clock that has moved since. See BuildPackOptions.resolved.
    ...(confirmed !== null ? { resolved: confirmed.resolved } : {}),
    // The one wall-clock read on this path (#397). Everything downstream takes
    // the instant as a parameter, so a run is reproducible from its inputs.
    now: Date.now(),
    ...(input.prior !== undefined ? { prior: input.prior } : {}),
  });

  // Token-weighted pricing (lib/ai-rung.ts): one line per SOLVED division, so
  // `credits` is max(1, Σ rungs − 1) and `budget` is sized from the
  // UNDISCOUNTED Σ — the batch discount is a margin gift, not a capability cut.
  const quote = quoteRun(
    pack.divisions.map((d) => ({
      key: d.id,
      input: {
        movableFixtures: d.movableIds.length,
        entrants: pack.entrants.filter((e) => e.division_id === d.id).length,
        courts: d.settings.courts.length,
      },
      ...(input.rung_overrides?.[d.id] !== undefined
        ? { chosen: input.rung_overrides[d.id]! }
        : {}),
    })),
    schedulingRungWeights(),
  );
  // One meter for the whole run — every ladder rung and repair round charges it.
  const meter = createTokenMeter(quote.budget, { units: movableIds.size });
  const pricedByDivision = new Map(quote.lines.map((l) => [l.key, l]));

  // R7: only `.size` and membership of `movableIds` are stable, so nothing here
  // serialises the set. Division ids are a sorted array off the pack instead.
  const division_ids = pack.divisions.map((d) => d.id).sort(cmp);
  const skipped_division_ids = skipped_divisions.map((s) => s.id).sort(cmp);

  let result: CompetitionPlanResult & {
    served_model: string;
    escalated_from?: string;
    rungs_tried: string[];
  };
  try {
    // Reserve → run → settle on success, release on throw. A
    // PaymentRequiredError("ai.credits") from an empty wallet is raised by the
    // reserve itself, before the model is ever called, and falls through the
    // catch below untouched.
    result = await spendCredit(
      walletId,
      auth.orgId,
      quote.credits,
      async () => {
        // The hold exists by the time this runs. Provisionally consumed…
        claim.creditConsumed = true;
        return {
          aiRunId: crypto.randomUUID(),
          // The LADDER, not the single-model runner: production wants the
          // fallback chain, and the two names differ by one word.
          result: await runCompetitionAiPlanLadder(pack, movableIds, meter, courtDirectory),
        };
      },
      // …and un-consumed again if the ladder throws — the joint run is the most
      // expensive failure this product has, so paying twice for the same compile
      // after one is the most expensive version of that bug.
      { onHoldReleased: () => (claim.creditConsumed = false) },
    );
  } catch (err) {
    // Spec §11: a run that produced nothing usable is not charged (spendCredit
    // released the hold on the throw) but IS recorded — an un-metered failure
    // is invisible in both analytics and the run ledger, and a failed joint run
    // is the most expensive failure this product has.
    const providerErr = err instanceof AiProviderError ? err : null;
    const providerCause = providerErr?.cause as { status?: number; name?: string } | undefined;
    const planErr =
      err instanceof HttpError && (err.code === "AI_PLAN_FAILED" || err.code === "AI_PLAN_TIMEOUT")
        ? err
        : null;
    if (planErr || providerErr) {
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
      const outcome = providerErr
        ? "provider_error"
        : planErr!.code === "AI_PLAN_TIMEOUT"
          ? "timeout"
          : "failed";
      const cost_usd =
        usage.cost_usd ?? aiRunCostUsd(model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
      await withTenant(auth.orgId, async (tx) => {
        await tx`
          insert into competition_events (competition_id, org_id, type, payload, actor_id)
          values (${competitionId}, ${auth.orgId}, 'schedule.ai_failed_multi',
                  ${tx.json({
                    division_ids,
                    skipped_division_ids,
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
                    pack_units: movableIds.size,
                    // What was reserved, what it bought, and the per-division
                    // breakdown behind the discount — stamped on the failure row
                    // too, so a run that cost real tokens for nothing is priced
                    // in the ledger exactly like one that worked.
                    ...meterStamp(quote, meter, parseStamp),
                    ...(providerErr
                      ? {
                          provider_status: providerCause?.status ?? null,
                          provider_type: providerCause?.name ?? providerErr.name,
                        }
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
          divisions: pack.divisions.length,
          credits: quote.credits,
          ...(providerErr ? { provider_status: providerCause?.status ?? null } : {}),
        },
      });
    }
    if (providerErr) {
      // The provider's message can carry OUR billing state — never let it reach
      // a tenant.
      throw new HttpError(
        503,
        "AI scheduling is temporarily unavailable; please retry",
        "AI_PROVIDER_UNAVAILABLE",
      );
    }
    throw err;
  }

  const model = result.served_model;
  const cost_usd =
    result.usage.cost_usd ??
    aiRunCostUsd(model, result.usage.input_tokens, result.usage.output_tokens);
  await withTenant(auth.orgId, async (tx) => {
    await tx`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${competitionId}, ${auth.orgId}, ${JOINT_RUN_EVENT},
              ${tx.json({
                division_ids,
                // R6: what the organiser asked for but the run did not solve —
                // without it the ledger cannot explain why a 5-division request
                // was priced as 4.
                skipped_division_ids,
                // LOAD-BEARING, not decoration. Both /admin readers classify a
                // run by `type` first and fall back to `payload->>'phase'`,
                // whose default arm is 'officials' (ai-runs-admin.ts:115,472) —
                // so an unstamped joint run is filed under the wrong phase and
                // skews both phases' $/unit. The failure row below stamps it
                // too; the two must not drift.
                phase: "schedule",
                mode: input.mode,
                model,
                usage: result.usage,
                cost_usd,
                pack_units: movableIds.size,
                // credits, discount, budget, spent_tokens, stopped_on_budget,
                // underfunded and the per-division breakdown — one builder, so
                // the event and the API response cannot drift.
                ...meterStamp(quote, meter, parseStamp),
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

  // Expensive-run watch (v17 gap #295) — deliberately AFTER the insert above,
  // whose table is the baseline's own source, and deferred so the tenant's paid
  // response does not wait on a table scan plus an email send. A joint run is
  // the class this alert exists for: it is compared against the SINGLE-division
  // 30-day median (medianRunCostUsd is scoped to schedule.ai_generated), so an
  // N-division run that costs several times one division's run will trip it —
  // which is the intended signal while joint pricing is uncalibrated, not noise.
  deferred(() =>
    maybeAlertExpensiveRun({
      orgId: auth.orgId,
      competitionId,
      phase: "schedule",
      model,
      costUsd: cost_usd,
      mode: input.mode,
      packUnits: movableIds.size,
    }),
  );

  // #387: the card's quote against the charge. The joint path is where a
  // divergence is most likely — the batch discount is arithmetic the client
  // reimplements nowhere but still has to arrive at — and the event names every
  // division in the run.
  const quote_mismatch = await recordQuoteMismatch(
    auth,
    { competitionId, divisionIds: pack.divisions.map((d) => d.id) },
    input.quoted_credits,
    quote.credits,
  );

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
      // The one property the single-division event cannot carry: what makes
      // this run a joint one, and what it was priced on.
      divisions: pack.divisions.length,
      credits: quote.credits,
    },
  });

  return {
    proposal: result.proposal,
    unschedulable: result.unschedulable,
    // W6 (#401): ONE report for the whole competition — the joint solve runs
    // once over the whole board, never once per division.
    repair: result.repair,
    // R13: warnings are carried IN FULL. `isBlocking` covers only `court` and
    // direct `order`, so blackout, session-window, rest and person-overlap
    // violations neither block nor trigger a repair round — the organiser
    // reviewing this response is the last automated-gate-free line of defence,
    // and the board cannot render what is not returned here.
    // `AiPlanConflict` carries the engine `Conflict` verbatim (see its own
    // comment in api-v1/schemas/) — `details` already rides along unchanged;
    // `withLegacyDetail` only restores the deprecated `detail` string the
    // engine stopped producing (C3, 2026-08-13 design amendment).
    warnings: result.warnings.map(withLegacyDetail),
    blocking: result.blocking.map(withLegacyDetail),
    diff: result.diff,
    explanations: result.explanations,
    // constraint_suggestions is dropped on purpose — see the response type.
    summary: result.summary,
    // The ARCHITECT's assumptions (stage 2). The resolver's are a different
    // array on a different response — see AiCompetitionPlanResponse.assumptions.
    assumptions: result.assumptions,
    divergent_courts: pack.divergentCourts,
    skipped_divisions,
    usage: {
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      repair_rounds: result.usage.repair_rounds,
    },
    ...meterStamp(quote, meter, parseStamp),
    // #387 — present only when the card and the charge disagreed.
    ...(quote_mismatch ? { quote_mismatch } : {}),
    // AFTER the stamp, deliberately: the stamp carries its own narrow
    // `divisions` breakdown and this merged one replaces it (see the field's
    // doc comment). Every solved division has a quote line — they are built
    // from the same `pack.divisions` — so the lookup cannot miss.
    divisions: pack.divisions.map((d) => {
      const line = pricedByDivision.get(d.id)!;
      return {
        id: d.id,
        name: d.name,
        movable: d.movableIds.length,
        rung: line.rung,
        predicted_rung: line.predictedRung,
        underfunded: line.underfunded,
      };
    }),
  };
}
