import "server-only";
import { resolveProvider, selectProvider, type ProviderName } from "@/server/ai/select-provider";
import {
  AiProviderError,
  type AiChatResponse,
  type AiProvider,
  type AiTurn,
} from "@/server/ai/provider";
import type { PackCourtInfo } from "@/lib/court-directory";
import { HttpError } from "@/lib/errors";
import { aiRunCostUsd } from "@/lib/ai-pricing";
import { unmeteredTokenMeter, type TokenMeter } from "@/lib/ai-rung";
import { legacyVerifierConflict } from "@/server/api-v1/conflict-detail-legacy";
import { validateAssignments, type Conflict } from "@seazn/engine/scheduling";
import {
  applySolverMoves,
  solveBoard,
  solverBudgetMs,
  SOLVER_MIN_BUDGET_MS,
  type RepairEngine,
  type SolverTelemetry,
} from "@/server/usecases/schedule-ai-solver";
import { AiSchedulePlan, SINGLE_SYSTEM_PROMPT } from "../schedule-ai-prompt";
import { zonedIso } from "./helpers";
import {
  aiReasoning,
  MAX_REPAIR_ROUNDS,
  MAX_TOKENS,
  ROUND_TIMEOUT_MS,
  schedulingAiModel,
} from "./model-config";
import { toModelPayload } from "./model-payload";
import type { AiPlanResult, SchedulePack } from "./types";
import {
  computeDiff,
  isBlocking,
  packFeedDependencies,
  structuralCheck,
  toEngineAssignments,
  toObstacleAssignments,
  toSchedulableFixtures,
  unschedulableRule,
  verifyConfig,
  windowBounds,
} from "./verify";

// ===========================================================================
// Phase A runner — the Anthropic structured-output call + engine verify/repair
// loop (design/v4/00 §3-4, 01 §1,§5). Pure over the pack: no DB, no wall clock.
// ===========================================================================

/** Ask `provider` for one round. Thin wrapper: the provider seam owns the
 *  wire format, the reasoning shape, structured-output parsing, and echoing
 *  the assistant turn back unchanged on repair (01 §5) — callers just replay
 *  `response.assistantTurn`. */
async function callModel(
  provider: AiProvider,
  model: string,
  messages: AiTurn[],
  maxTokens: number = MAX_TOKENS,
): Promise<AiChatResponse<AiSchedulePlan> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
  try {
    return await provider.chat({
      model,
      system: SINGLE_SYSTEM_PROMPT,
      messages,
      maxTokens,
      reasoning: aiReasoning(model),
      schema: { name: "schedule_plan", zod: AiSchedulePlan },
      signal: controller.signal,
      // The explicit timeout is load-bearing: without it the Anthropic SDK
      // refuses non-streaming requests whose max_tokens implies >10 min and
      // throws synchronously ("Streaming is required…"), which the
      // corrective path would mask as AI_PLAN_FAILED. The AbortController
      // above remains the real per-round deadline.
      timeoutMs: 600_000,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpError(422, "AI scheduling timed out; please retry", "AI_PLAN_TIMEOUT");
    }
    // Genuine transport/API failures propagate (→ 5xx). The adapter, however,
    // returns null on schema-invalid structured output instead of throwing —
    // fold that into the null-parsed path so the corrective retry (01 §1)
    // runs rather than surfacing a raw 500.
    if (err instanceof HttpError || err instanceof AiProviderError) {
      throw err;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** P9 pass 3d: the model speaks the court LABELS `toModelPayload` showed it
 *  (`settings.courts`/`courtDetails`) — every id-based check from here on
 *  (`structuralCheck`, `toEngineAssignments`, the diff, the stored proposal)
 *  expects the same ids `pack` itself carries throughout. Resolve once,
 *  right after the model answers, so nothing downstream needs to know the
 *  model ever saw a name rather than an id.
 *
 *  An unrecognised label passes through UNRESOLVED, on purpose:
 *  `structuralCheck`'s existing "not in settings.courts" check still catches
 *  it — and now names the label the model actually used instead of an id
 *  nobody could read. `labelToId.size === 0` (no directory supplied) is a
 *  fast path that returns `plan` untouched, matching this function's
 *  behaviour before this pass exactly for any caller with no directory to
 *  offer.
 *
 *  Exported: `runCompetitionAiPlan` (competition-schedule-ai.ts) needs the
 *  identical step for the joint plan — `AiSchedulePlan.assignments` is the
 *  same shape either way, only the pack around it differs. */
export function resolveModelCourtLabels(
  plan: AiSchedulePlan,
  labelToId: ReadonlyMap<string, string>,
): AiSchedulePlan {
  if (labelToId.size === 0) return plan;
  return {
    ...plan,
    assignments: plan.assignments.map((a) => ({
      ...a,
      court_label: labelToId.get(a.court_label) ?? a.court_label,
    })),
  };
}

/**
 * Run the schedule architect over a pre-built pack: call the model, verify the
 * proposal with the engine, and repair blocking conflicts up to twice before
 * returning best-so-far. Takes the pack + movable id set as data — never touches
 * the DB.
 *
 * @throws HttpError 503 (the resolved AI provider is not configured — no
 *   ANTHROPIC_API_KEY for an Anthropic rung, no OPENROUTER_API_KEY for an
 *   OpenRouter rung), 422 AI_PLAN_FAILED (model refusal, or an un-correctable
 *   structural violation), 422 AI_PLAN_TIMEOUT.
 */
export async function runAiPlan(
  pack: SchedulePack,
  movableIds: Set<string>,
  modelOverride?: string,
  providerName?: ProviderName,
  /** The run's cumulative token meter (lib/ai-rung.ts). ONE instance is shared
   *  by every ladder rung, so the hard budget spans the whole run instead of
   *  resetting per rung. Defaults to an unmetered one — behaviour is unchanged
   *  for callers that do not price a run. */
  meter: TokenMeter = unmeteredTokenMeter(),
  /** P9 pass 3d, appended rather than inserted so no positional caller shifts.
   *  Same directory `buildSchedulePack` returned alongside `pack` — see
   *  `toModelPayload` and `resolveModelCourtLabels`. Defaults to empty. */
  courtDirectory: Record<string, PackCourtInfo> = {},
): Promise<AiPlanResult> {
  // One provider per run: reasoning blocks are provider-specific and replayed
  // verbatim on repair, so a run that resolved a provider per round could send
  // one service's reasoning to another. 503 before any network if unconfigured.
  // A ladder rung pins its provider explicitly (never via AI_PROVIDER — that is
  // process-global and unsafe under concurrency); an unset name falls back to
  // the env-selected provider, exactly as before this parameter existed.
  const provider = providerName ? resolveProvider(providerName) : selectProvider();
  if (!provider.isConfigured()) {
    throw new HttpError(503, "AI scheduling is not configured on this server", "AI_PROVIDER_NOT_CONFIGURED");
  }
  const model = modelOverride ?? schedulingAiModel();

  const conversation: AiTurn[] = [
    { role: "user", content: JSON.stringify(toModelPayload(pack, courtDirectory)) },
  ];
  const config = verifyConfig(pack);
  const obstacles = toObstacleAssignments(pack);
  const dependencies = packFeedDependencies(pack);
  // P9 pass 3d: the reverse of `courtDirectory` — label -> id — for
  // resolving the model's own `court_label` back the moment each round
  // answers (see `resolveModelCourtLabels`). Built once: the directory is
  // stable for the whole run.
  const labelToId = new Map(Object.entries(courtDirectory).map(([id, c]) => [c.label, id] as const));

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  let repairRounds = 0;
  let correctiveUsed = false; // one non-repair retry for a malformed plan (01 §1)

  // Best-so-far across repair rounds: repair round 2 can leave MORE blocking
  // conflicts than round 1, so we keep the plan with the fewest blocking (ties
  // resolve to the later round) and return that — never blindly the last round.
  // `engine` rides along per candidate rather than being tracked for the run:
  // the winning board can be an earlier round's, and "which engine repaired
  // this" is a fact about the board returned, not about the run.
  let best: { plan: AiSchedulePlan; blocking: Conflict[]; warnings: Conflict[]; engine: RepairEngine } | null = null;

  // #401 solver state. The budget is per RUN, not per round: the solver is
  // tried before every repair round, and a run that met its budget three times
  // over would add three times the latency it was sized for.
  const pinnedIds = new Set(pack.fixtures.movable.filter((f) => f.pinned).map((f) => f.id));
  let solverBudgetLeft = solverBudgetMs();
  let solverAttempts = 0;
  let repairTelemetry: SolverTelemetry = { solver_ran: false };

  // Accumulated usage rides along on a 422 too, so callers can meter a refused
  // or un-correctable run rather than losing the tokens already spent.
  const usageNow = () => ({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    repair_rounds: repairRounds,
    cost_usd: costUsd,
  });

  const finalizeFrom = (chosen: NonNullable<typeof best>): AiPlanResult => ({
    proposal: chosen.plan.assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_label: a.court_label,
      ...(a.schedule_locked !== undefined ? { schedule_locked: a.schedule_locked } : {}),
    })),
    // #399: every unplaced fixture carries a code — the rule the model cited,
    // or CAP when it named none (the capacity case).
    unschedulable: chosen.plan.unschedulable.map((u) => ({
      ...u,
      rule: unschedulableRule(u.reason),
    })),
    warnings: chosen.warnings,
    blocking: chosen.blocking,
    diff: computeDiff(chosen.plan, pack),
    explanations: chosen.plan.explanations,
    ...(chosen.plan.constraint_suggestions !== undefined
      ? { constraint_suggestions: chosen.plan.constraint_suggestions }
      : {}),
    summary: chosen.plan.summary,
    // `.max(10).optional()` on the prompt schema — the model omits it routinely,
    // and the review panel maps over the array.
    assumptions: chosen.plan.assumptions ?? [],
    usage: usageNow(),
    repair: { engine: chosen.engine, ...repairTelemetry },
  });

  for (;;) {
    // Hard token budget (design §5). The meter already holds every prior
    // round's AND every prior ladder rung's output tokens, so there is nothing
    // to add here. Below the reserve, stop asking for another round — ship the
    // best plan already produced, or (nothing produced yet) fail in a way
    // runLadder can recover from.
    if (!meter.canStartRound()) {
      if (best !== null) return finalizeFrom(best);
      throw new HttpError(
        422,
        "AI scheduling stopped: token budget exhausted before a usable plan was produced",
        "AI_PLAN_FAILED",
        { usage: usageNow() },
      );
    }
    const roundMaxTokens = meter.clampRound(MAX_TOKENS);

    let response: Awaited<ReturnType<typeof callModel>>;
    try {
      response = await callModel(provider, model, conversation, roundMaxTokens);
    } catch (err) {
      // A timed-out round still spent the earlier rounds' tokens — ride the
      // accumulated usage on the 422 so callers can meter it (same contract
      // as AI_PLAN_FAILED).
      if (err instanceof HttpError && err.code === "AI_PLAN_TIMEOUT") {
        throw new HttpError(422, err.message, "AI_PLAN_TIMEOUT", { usage: usageNow() });
      }
      throw err;
    }
    const roundInput = response?.usage?.inputTokens ?? 0;
    const roundOutput = response?.usage?.outputTokens ?? 0;
    inputTokens += roundInput;
    outputTokens += roundOutput;
    // Charge the run's meter the moment usage is known — BEFORE any of the
    // throw paths below. A round that spent tokens and then refused/failed to
    // parse must still count against the budget, or a run could loop past its
    // cap on failures alone.
    meter.add(roundOutput);
    // Prefer the cost the provider reports; fall back to a derived estimate
    // only when the round produced no reported cost. Never a guess.
    const roundCost =
      response?.usage?.costUsd ??
      (response ? aiRunCostUsd(response.servedModel, roundInput, roundOutput) : 0);
    costUsd = costUsd === null || roundCost === null ? null : costUsd + roundCost;

    // Refusal: bail before reading content (01 §1). `stop_reason` is not part
    // of the provider-neutral response — `refused` is the seam's equivalent,
    // and MUST stay distinct from a null parse: a refusal spends no
    // corrective retry.
    if (response?.refused) {
      throw new HttpError(
        422,
        "AI scheduling could not produce a usable plan; please retry",
        "AI_PLAN_FAILED",
        { usage: usageNow() },
      );
    }

    // P9 pass 3d: resolve the model's court_label (a label) back to the real
    // id BEFORE anything below reads it — structuralCheck, toEngineAssignments
    // and the diff all compare against `pack`'s own id-based fields.
    const plan = response?.parsed ? resolveModelCourtLabels(response.parsed, labelToId) : null;
    const structuralError =
      plan === null ? "the model returned no parseable plan" : structuralCheck(plan, movableIds, pack);
    if (structuralError !== null) {
      if (correctiveUsed) {
        throw new HttpError(
          422,
          "AI scheduling could not produce a usable plan; please retry",
          "AI_PLAN_FAILED",
          { usage: usageNow() },
        );
      }
      correctiveUsed = true;
      conversation.push(response?.assistantTurn ?? { role: "assistant", content: [] });
      conversation.push({
        role: "user",
        content: JSON.stringify({
          structural_error: structuralError,
          note: "Your previous output was rejected before verification. Resend the full plan: every movable fixture exactly once (in assignments or unschedulable), only movable ids, court_label drawn from settings.courts (or the fixture's own narrower courts list, when it carries one), and never move a pinned fixture.",
        }),
      });
      continue;
    }

    // Verify against the engine (obstacles are fixed occupancy).
    let chosen: AiSchedulePlan = plan!;
    let conflicts = validateAssignments(toEngineAssignments(chosen, pack), config, obstacles, dependencies);
    let blocking = conflicts.filter(isBlocking);
    // A board straight from the model carries no repair of ours; a board a
    // repair round produced carries the LLM's.
    let boardEngine: RepairEngine = repairRounds === 0 ? "none" : "llm";
    /** Fixtures the solver could not resolve — handed to the LLM round below so
     *  it is pointed at the residue rather than left to re-derive it. */
    let unresolved: readonly string[] = [];

    // ---- #401: solve before asking the model again -------------------------
    // The solver costs no tokens, no credits and no SDK call, so the only thing
    // a failed attempt spends is its own bounded wall clock. Every failure —
    // switched off, queued, out of budget, infeasible, thrown — falls through to
    // the LLM repair path exactly as this loop behaved before the wave, and says
    // so in `repair`.
    //
    // The MIN guard applies from the second attempt on: the first attempt runs
    // whatever budget it was given, so an operator who sets the budget very low
    // still gets the attempt (and the telemetry) they configured.
    if (blocking.length > 0 && (solverAttempts === 0 || solverBudgetLeft >= SOLVER_MIN_BUDGET_MS)) {
      solverAttempts++;
      const board = toEngineAssignments(chosen, pack);
      // "Pin what stands, re-solve the violators" (z3 retirement design,
      // stage B, C5). The violators are every fixture THIS round's own
      // verifier named in a blocking conflict — both ends of a pairwise one
      // (a court/person clash names its counterparty in
      // `details.otherFixtureId`), never `warnings`: non-blocking residue is
      // a quality note this round is not spending budget to chase (same
      // hand-off policy the LLM round below already uses). Everything else
      // this pack may move — union this pack's own pins — is FROZEN at its
      // current slot: `buildSchedule` has no "fewest fixtures moved" term of
      // its own the way z3's old ascending-k repair search did, so freezing
      // every non-violator is what keeps this round from reshuffling a board
      // the LLM conversation, and the organiser, have already seen (the same
      // ruling C4 applied to REFLOW — see `reflowExisting`'s own doc
      // comment, `schedule.ts`).
      const violatorIds = new Set<string>();
      for (const c of blocking) {
        violatorIds.add(c.fixtureId);
        if (c.details?.otherFixtureId !== undefined) violatorIds.add(c.details.otherFixtureId);
      }
      const frozen = new Set(
        pack.fixtures.movable
          .filter((f) => pinnedIds.has(f.id) || !violatorIds.has(f.id))
          .map((f) => f.id),
      );
      const attempt = await solveBoard({
        // The FULL movable set, violators included — `solveBoard`'s own
        // defensive narrowing plus `buildSchedule`'s pin-promotion are what
        // keep `frozen` ids from moving, not a pre-filter here (the same
        // lesson C4 already learned for `reflowExisting`: do not pre-filter
        // `fixtures` yourself).
        fixtures: toSchedulableFixtures(pack),
        board,
        frozen,
        existing: obstacles,
        dependencies,
        config: {
          ...config,
          courts: pack.settings.courts,
          matchMinutes: pack.settings.matchMinutes,
          startAt: windowBounds(pack.window).from,
        },
        budgetMs: Math.max(solverBudgetLeft, 1),
      });
      solverBudgetLeft -= attempt.telemetry.ms ?? 0;
      // A later attempt that never reached the solver must not erase an earlier
      // one that did.
      if (attempt.telemetry.solver_ran || !repairTelemetry.solver_ran) {
        repairTelemetry = attempt.telemetry;
      }
      unresolved = attempt.unresolvedFixtureIds;

      if (attempt.assignments !== null && attempt.movedFixtureIds.length > 0) {
        const patched = applySolverMoves(
          chosen,
          attempt.assignments,
          attempt.movedFixtureIds,
          (instantMs) => zonedIso(instantMs, pack.tz),
        );
        const after = validateAssignments(toEngineAssignments(patched, pack), config, obstacles, dependencies);
        const afterBlocking = after.filter(isBlocking);
        // ADOPTION GATE: strictly fewer BLOCKING conflicts, judged by this
        // runner's own verifier rather than by the solver's internal one. A
        // solver answer that trades a blocking conflict for warnings is still a
        // good trade — a warning is a quality note, a blocking conflict is an
        // impossible board — so warnings are recorded, never a veto.
        if (afterBlocking.length < blocking.length) {
          chosen = patched;
          conflicts = after;
          blocking = afterBlocking;
          boardEngine = "optimized";
        } else {
          repairTelemetry = { ...repairTelemetry, fallback: "not_adopted" };
        }
      }
    }

    const warnings = conflicts.filter((c) => !isBlocking(c));

    // Keep the fewest-blocking plan; `<=` lets a later round win an exact tie.
    if (best === null || blocking.length <= best.blocking.length) {
      best = { plan: chosen, blocking, warnings, engine: boardEngine };
    }

    if (blocking.length === 0 || repairRounds >= MAX_REPAIR_ROUNDS) {
      return finalizeFrom(best!);
    }

    // Blocking conflicts remain and rounds are left — send the report back and
    // ask for minimal fixes (01 §5).
    //
    // HAND-OFF POLICY (#401), stated once because it is a choice and not a
    // consequence: BLOCKING residue is mandatory work and always triggers this
    // round. Non-blocking residue left behind by a solver that RELAXED a family
    // does not trigger a round of its own — the board is legal, and spending a
    // paid round on a quality note the organiser can see would be the wrong
    // trade. It stays visible in two places: `warnings` (which the review panel
    // renders and `planIsAcceptable` already counts toward ladder escalation)
    // and `repair.relaxed` / `repair.residual`.
    repairRounds++;
    conversation.push(response?.assistantTurn ?? { role: "assistant", content: [] });
    conversation.push({
      role: "user",
      content: JSON.stringify({
        // Byte-identical to pre-C3 (C3 2026-08-13 design doc ruling: "the
        // prose reaches the model, not just the screen") — `detail`, derived,
        // never the structured `details` the engine now emits. Nothing in
        // this task measures repair quality, and the AI-credit meter already
        // charged this run against the pre-C3 token weight.
        verifier_conflicts: conflicts.map(legacyVerifierConflict),
        // When the solver moved fixtures, the model's own last turn is no longer
        // the board these conflicts were measured on. Send the board, or it
        // repairs a plan nobody holds and silently discards the solver's work.
        ...(boardEngine === "optimized" ? { repaired_assignments: chosen.assignments } : {}),
        ...(unresolved.length > 0 ? { focus_fixture_ids: [...unresolved] } : {}),
        note:
          boardEngine === "optimized"
            ? "An automatic solver has already moved some fixtures to clear other conflicts. `repaired_assignments` is the board these conflicts were measured on and it REPLACES your previous output — start from it. Fix only these conflicts, concentrating on focus_fixture_ids. Move as few fixtures as possible. Do not reintroduce earlier conflicts."
            : "Fix only these conflicts. Move as few fixtures as possible. Do not reintroduce earlier conflicts.",
      }),
    });
  }
}
