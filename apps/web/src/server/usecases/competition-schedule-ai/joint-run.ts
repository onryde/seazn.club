import "server-only";
import { HttpError } from "@/lib/errors";
import {
  MAX_REPAIR_ROUNDS,
  MAX_TOKENS,
  ROUND_TIMEOUT_MS,
  aiReasoning,
  planIsAcceptable,
  planRungs,
  resolveModelCourtLabels,
  runLadder,
  schedulingAiModel,
  unschedulableRule,
  windowBounds,
  zonedIso,
  type PackCourtInfo,
} from "../schedule-ai";
import {
  applySolverMoves,
  solveBoard,
  solverBudgetMs,
  SOLVER_MIN_BUDGET_MS,
  type RepairEngine,
  type SolverTelemetry,
} from "../schedule-ai-solver";
import {
  AiSchedulePlan,
  INSTRUCTION_RULES,
  JOINT_RULES,
  SYSTEM_PROMPT,
} from "../schedule-ai-prompt";
import { legacyVerifierConflict } from "@/server/api-v1/conflict-detail-legacy";
import { resolveProvider, selectProvider, type ProviderName } from "@/server/ai/select-provider";
import {
  AiProviderError,
  type AiChatResponse,
  type AiProvider,
  type AiTurn,
} from "@/server/ai/provider";
import { aiRunCostUsd } from "@/lib/ai-pricing";
import { unmeteredTokenMeter, type TokenMeter } from "@/lib/ai-rung";
import type { Conflict } from "@seazn/engine/scheduling";
import { ms } from "./helpers";
import {
  JOINT_ASSIGNMENT_UNKNOWN,
  jointFeedDependencies,
  toJointEngineAssignments,
  toJointObstacleAssignments,
  toJointSchedulableFixtures,
} from "./joint-assignments";
import {
  jointSolverConfig,
  jointStructuralCheck,
  partitionConflicts,
  verifyJoint,
} from "./joint-verify";
import { toJointModelPayload } from "./model-payload";
import type { CompetitionPack, CompetitionPlanResult } from "./types";

/** The joint system prompt. SYSTEM_PROMPT is golden-snapshotted and must never
 *  be edited; JOINT_RULES is a separate constant appended to it here — this is
 *  its ONLY consumer, so this concatenation is what puts Task 2's rules on the
 *  wire. */
export const JOINT_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n\n${INSTRUCTION_RULES}\n\n${JOINT_RULES}`;

/** proposal vs each movable fixture's current slot, over the union — the joint
 *  mirror of `computeDiff` (schedule-ai/verify.ts). */
function computeJointDiff(plan: AiSchedulePlan, pack: CompetitionPack): CompetitionPlanResult["diff"] {
  const proposalById = new Map(plan.assignments.map((a) => [a.fixture_id, a]));
  const unsched = new Set(plan.unschedulable.map((u) => u.fixture_id));
  const diff: CompetitionPlanResult["diff"] = { moved: [], placed: [], unscheduled: [], unchanged: [] };
  for (const f of pack.fixtures.movable) {
    const a = proposalById.get(f.id);
    if (a) {
      const hadSlot = f.current.at !== null && f.current.court !== null;
      if (!hadSlot) diff.placed.push(f.id);
      else if (ms(f.current.at!) === ms(a.scheduled_at) && f.current.court === a.court_label) {
        diff.unchanged.push(f.id);
      } else diff.moved.push(f.id);
    } else if (unsched.has(f.id)) {
      diff.unscheduled.push(f.id);
    }
  }
  return diff;
}

/** One round, joint system prompt. A near-copy of `callModel`
 *  (schedule-ai/run.ts) rather than a parameterisation of it: that function's
 *  `system: SYSTEM_PROMPT` is asserted by the single-division tests, and adding
 *  a prompt parameter to the shipped per-division path to serve a new one is a
 *  behaviour change on a live endpoint for no gain. Everything else — the
 *  AbortController deadline, the explicit SDK timeout, the null-on-unparseable
 *  contract — is identical and must stay so. */
async function callJointModel(
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
      system: JOINT_SYSTEM_PROMPT,
      messages,
      maxTokens,
      reasoning: aiReasoning(model),
      schema: { name: "schedule_plan", zod: AiSchedulePlan },
      signal: controller.signal,
      timeoutMs: 600_000,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpError(422, "AI scheduling timed out; please retry", "AI_PLAN_TIMEOUT");
    }
    if (err instanceof HttpError || err instanceof AiProviderError) throw err;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the schedule architect over a pre-built JOINT pack. Mirrors `runAiPlan`
 * (schedule-ai/run.ts) round for round — same meter placement (the round's
 * output is charged the moment usage is known, BEFORE the refusal and
 * parse-failure throws), same single corrective retry for a malformed plan, same
 * MAX_REPAIR_ROUNDS, same fewest-blocking best-so-far selection, same
 * usage-rides-on-the-422 contract. Takes the pack as data; never touches the DB.
 *
 * PREFER {@link runCompetitionAiPlanLadder}. This function runs ONE model with
 * no fallback; the ladder is what production wants and what the orchestrator
 * must call. It is exported only because the ladder needs an attempt function
 * and because the bench pins a single model. (The single-division twin avoids
 * this ambiguity by keeping `runAiPlanLadder` module-private — it cannot here,
 * since the orchestrator lives in a different module.)
 *
 * What differs: the system prompt is SYSTEM_PROMPT + JOINT_RULES, and the two
 * checks are the joint ones.
 *
 * @throws HttpError 503 AI_PROVIDER_NOT_CONFIGURED, 422 AI_PLAN_FAILED (refusal,
 *   un-correctable structural violation, or budget exhausted before a usable
 *   plan), 422 AI_PLAN_TIMEOUT.
 */
export async function runCompetitionAiPlan(
  pack: CompetitionPack,
  movableIds: Set<string>,
  modelOverride?: string,
  providerName?: ProviderName,
  meter: TokenMeter = unmeteredTokenMeter(),
  /** P9 pass 3d, appended rather than inserted so no positional caller
   *  shifts. Same directory `buildCompetitionPack` returned alongside
   *  `pack` — see `toJointModelPayload` and `resolveModelCourtLabels`
   *  (schedule-ai/run.ts). Defaults to empty. */
  courtDirectory: Record<string, PackCourtInfo> = {},
): Promise<CompetitionPlanResult> {
  const provider = providerName ? resolveProvider(providerName) : selectProvider();
  if (!provider.isConfigured()) {
    throw new HttpError(503, "AI scheduling is not configured on this server", "AI_PROVIDER_NOT_CONFIGURED");
  }
  const model = modelOverride ?? schedulingAiModel();

  // `toJointModelPayload(pack, courtDirectory)`, never `pack`: `participants`
  // and `assumptions` are server-side enforcement inputs and would blow the
  // token budget.
  const conversation: AiTurn[] = [
    { role: "user", content: JSON.stringify(toJointModelPayload(pack, courtDirectory)) },
  ];
  // P9 pass 3d: label -> id, for resolving the model's own court_label back
  // the moment each round answers — see the `plan` derivation below.
  const labelToId = new Map(Object.entries(courtDirectory).map(([id, c]) => [c.label, id] as const));
  const divisionByFixture = new Map(pack.fixtures.movable.map((f) => [f.id, f.division_id]));
  /** Same invariant as toJointEngineAssignments, and for the same reason: a
   *  proposal entry with an empty division_id is a valid-looking lie that the
   *  route would serialise straight to the client. `jointStructuralCheck` has
   *  already rejected foreign ids by the time this runs. */
  const divisionOf = (fixtureId: string): string => {
    const d = divisionByFixture.get(fixtureId);
    if (d === undefined) {
      throw new HttpError(
        500,
        `assignment names a fixture outside the pack: ${fixtureId}`,
        JOINT_ASSIGNMENT_UNKNOWN,
      );
    }
    return d;
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  let repairRounds = 0;
  let correctiveUsed = false;

  let best:
    | { plan: AiSchedulePlan; blocking: Conflict[]; warnings: Conflict[]; engine: RepairEngine }
    | null = null;

  // #401 solver state, mirroring the single-division runner: ONE budget for the
  // run, tried before every repair round, and a `repair` report either way.
  const pinnedIds = new Set(pack.fixtures.movable.filter((f) => f.pinned).map((f) => f.id));
  const solverConfig = jointSolverConfig(pack);
  const jointObstacles = toJointObstacleAssignments(pack);
  const jointDeps = jointFeedDependencies(pack);
  let solverBudgetLeft = solverBudgetMs();
  let solverAttempts = 0;
  let repairTelemetry: SolverTelemetry = { solver_ran: false };

  const usageNow = () => ({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    repair_rounds: repairRounds,
    cost_usd: costUsd,
  });

  const finalizeFrom = (chosen: NonNullable<typeof best>): CompetitionPlanResult => ({
    proposal: chosen.plan.assignments.map((a) => ({
      fixture_id: a.fixture_id,
      scheduled_at: a.scheduled_at,
      court_label: a.court_label,
      // Resolved server-side from the pack. JOINT_RULES tells the model NOT to
      // emit a division field, so this is never an echo of model output.
      division_id: divisionOf(a.fixture_id),
      ...(a.schedule_locked !== undefined ? { schedule_locked: a.schedule_locked } : {}),
    })),
    // #399: same codes as the single-division runner — the rule the model
    // cited, or CAP for the capacity case.
    unschedulable: chosen.plan.unschedulable.map((u) => ({
      ...u,
      rule: unschedulableRule(u.reason),
    })),
    warnings: chosen.warnings,
    blocking: chosen.blocking,
    diff: computeJointDiff(chosen.plan, pack),
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

    let response: Awaited<ReturnType<typeof callJointModel>>;
    try {
      response = await callJointModel(provider, model, conversation, roundMaxTokens);
    } catch (err) {
      if (err instanceof HttpError && err.code === "AI_PLAN_TIMEOUT") {
        throw new HttpError(422, err.message, "AI_PLAN_TIMEOUT", { usage: usageNow() });
      }
      throw err;
    }
    const roundInput = response?.usage?.inputTokens ?? 0;
    const roundOutput = response?.usage?.outputTokens ?? 0;
    inputTokens += roundInput;
    outputTokens += roundOutput;
    meter.add(roundOutput);
    const roundCost =
      response?.usage?.costUsd ??
      (response ? aiRunCostUsd(response.servedModel, roundInput, roundOutput) : 0);
    costUsd = costUsd === null || roundCost === null ? null : costUsd + roundCost;

    if (response?.refused) {
      throw new HttpError(
        422,
        "AI scheduling could not produce a usable plan; please retry",
        "AI_PLAN_FAILED",
        { usage: usageNow() },
      );
    }

    // P9 pass 3d: resolve the model's court_label (a label) back to the real
    // id BEFORE anything below reads it — jointStructuralCheck,
    // toJointEngineAssignments and the diff all compare against `pack`'s own
    // id-based fields.
    const plan = response?.parsed ? resolveModelCourtLabels(response.parsed, labelToId) : null;
    const structuralError =
      plan === null ? "the model returned no parseable plan" : jointStructuralCheck(plan, movableIds, pack);
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
          note: "Your previous output was rejected before verification. Resend the full plan: every movable fixture of every division exactly once (in assignments or unschedulable), only movable ids, court_label drawn from that fixture's OWN division's settings.courts, and never move a pinned fixture.",
        }),
      });
      continue;
    }

    let chosen: AiSchedulePlan = plan!;
    let conflicts = verifyJoint(chosen, pack);
    let blocking = partitionConflicts(conflicts).blocking;
    let boardEngine: RepairEngine = repairRounds === 0 ? "none" : "llm";
    let unresolved: readonly string[] = [];

    // ---- #401: solve the WHOLE board before asking the model again ---------
    // One solve, never one per division: the clash this pipeline exists to catch
    // lives BETWEEN divisions, and each division's own board is clean when it
    // does. `jointSolverConfig` is what makes one config safe for many
    // divisions.
    if (blocking.length > 0 && (solverAttempts === 0 || solverBudgetLeft >= SOLVER_MIN_BUDGET_MS)) {
      solverAttempts++;
      if (solverConfig.courts.length === 0) {
        // No court is legal for every division in the run, so the solver has
        // nowhere to put anything. Say so rather than attempting it: a solve
        // with an empty court list is a guaranteed-infeasible use of the budget.
        repairTelemetry = { solver_ran: false, fallback: "court_split" };
      } else {
        const board = toJointEngineAssignments(chosen, pack);
        // "Pin what stands, re-solve the violators" (z3 retirement design,
        // stage B, C5) — the joint mirror of `schedule-ai/` folder's identical
        // ruling. The violators are every fixture THIS round's own JOINT
        // verifier named in a blocking conflict; everything else this run
        // may move — union every pinned fixture across every division — is
        // FROZEN at its current slot, so a solve spanning several divisions
        // cannot reshuffle a division the LLM conversation never flagged.
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
          // defensive narrowing plus `buildSchedule`'s pin-promotion keep
          // `frozen` ids from moving, not a pre-filter here (the same lesson
          // C4 already learned for `reflowExisting`).
          fixtures: toJointSchedulableFixtures(pack),
          board,
          frozen,
          existing: jointObstacles,
          dependencies: jointDeps,
          config: {
            ...solverConfig,
            // `jointSolverConfig` always sets `matchMinutes` (the conservative
            // MAX across every division, the same lever its own
            // `perEntrantMinRest` already uses) — re-asserted as required
            // here only because `VerifyConfig` types the field `Partial`.
            matchMinutes: solverConfig.matchMinutes!,
            startAt: windowBounds(pack.window).from,
          },
          budgetMs: Math.max(solverBudgetLeft, 1),
        });
        solverBudgetLeft -= attempt.telemetry.ms ?? 0;
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
          const after = verifyJoint(patched, pack);
          const afterBlocking = partitionConflicts(after).blocking;
          // ADOPTION GATE. Strictly fewer blocking conflicts under the JOINT
          // verifier — the authority on a board the solver graded through one
          // merged config — and every moved fixture still on a court its own
          // division owns, which no verifier pass checks.
          if (afterBlocking.length < blocking.length && courtsAreOwned(patched, pack)) {
            chosen = patched;
            conflicts = after;
            blocking = afterBlocking;
            boardEngine = "optimized";
          } else {
            repairTelemetry = { ...repairTelemetry, fallback: "not_adopted" };
          }
        }
      }
    }

    const warnings = partitionConflicts(conflicts).warnings;

    if (best === null || blocking.length <= best.blocking.length) {
      best = { plan: chosen, blocking, warnings, engine: boardEngine };
    }

    if (blocking.length === 0 || repairRounds >= MAX_REPAIR_ROUNDS) {
      return finalizeFrom(best!);
    }

    // Hand-off policy is the single-division runner's, unchanged: blocking
    // residue is mandatory work and triggers this round; non-blocking residue a
    // relaxed solve left behind does not, and stays visible in `warnings` and in
    // `repair.relaxed` / `repair.residual`.
    repairRounds++;
    conversation.push(response?.assistantTurn ?? { role: "assistant", content: [] });
    conversation.push({
      role: "user",
      content: JSON.stringify({
        // Byte-identical to pre-C3 (C3 2026-08-13 design doc ruling: "the
        // prose reaches the model, not just the screen") — see the identical
        // comment at schedule-ai/ folder's own `verifier_conflicts`.
        verifier_conflicts: conflicts.map(legacyVerifierConflict),
        ...(boardEngine === "optimized" ? { repaired_assignments: chosen.assignments } : {}),
        ...(unresolved.length > 0 ? { focus_fixture_ids: [...unresolved] } : {}),
        note:
          boardEngine === "optimized"
            ? "An automatic solver has already moved some fixtures to clear other conflicts. `repaired_assignments` is the board these conflicts were measured on and it REPLACES your previous output — start from it. Fix only these conflicts, concentrating on focus_fixture_ids. Move as few fixtures as possible. Do not reintroduce earlier conflicts. A court conflict between two divisions may be reported on both fixtures; where it is, moving either one resolves it."
            : "Fix only these conflicts. Move as few fixtures as possible. Do not reintroduce earlier conflicts. A court conflict between two divisions may be reported on both fixtures; where it is, moving either one resolves it.",
      }),
    });
  }
}

/** Every assignment sits on a court its OWN division owns.
 *
 *  The structural rule `jointStructuralCheck` enforces on model output, applied
 *  to solver output for the same reason: no `validateAssignments` pass rejects a
 *  fixture on another division's court, so without this a solver handed too many
 *  courts produces a board that grades perfectly clean and is not schedulable.
 *  Belt to `jointSolverConfig`'s braces — that function only offers courts every
 *  division shares, and this proves it. */
function courtsAreOwned(plan: AiSchedulePlan, pack: CompetitionPack): boolean {
  const divisionByFixture = new Map(pack.fixtures.movable.map((f) => [f.id, f.division_id]));
  const courtsByDivision = new Map(pack.divisions.map((d) => [d.id, new Set(d.settings.courts)]));
  return plan.assignments.every((a) => {
    const division = divisionByFixture.get(a.fixture_id);
    if (division === undefined) return false;
    return courtsByDivision.get(division)?.has(a.court_label) === true;
  });
}

/** Wire the joint runner to the shared model ladder — the joint mirror of
 *  `runAiPlanLadder` (schedule-ai/orchestrator.ts). The SAME meter instance is handed to
 *  every rung, so the run's hard token budget spans the whole ladder rather than
 *  resetting per rung, and escalation stops the moment the meter refuses a round
 *  (entering a further rung would spend nothing but would write a model into
 *  `rungs_tried` that was never actually asked). */
export async function runCompetitionAiPlanLadder(
  pack: CompetitionPack,
  movableIds: Set<string>,
  meter: TokenMeter,
  /** P9 pass 3d — threaded straight through to every rung's
   *  `runCompetitionAiPlan` call. Defaults to empty. */
  courtDirectory: Record<string, PackCourtInfo> = {},
): Promise<CompetitionPlanResult & { served_model: string; escalated_from?: string; rungs_tried: string[] }> {
  return runLadder(
    planRungs(),
    (rung) => runCompetitionAiPlan(pack, movableIds, rung.model, rung.provider, meter, courtDirectory),
    (result) => planIsAcceptable(result, movableIds.size),
    () => !meter.stoppedOnBudget,
  );
}
