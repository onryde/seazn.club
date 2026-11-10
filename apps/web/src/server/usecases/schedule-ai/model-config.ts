import "server-only";
import type { AiReasoning } from "@/server/ai/provider";

// 300s: live runs with adaptive thinking + effort:high regularly exceed 120s
// per round even at ~17 movable fixtures (measured 2026-07-19: opus round 1
// >120s, sonnet ~4 rounds ≈ 480s). The abort must outlast a real round or
// every sizable live run dies as AI_PLAN_TIMEOUT.
// 600s. Measured 2026-07-20 on a 30-fixture pack with dense constraints
// (round-robin + 60m rest + no-back-to-back + a court blackout): effort:high
// needed 1095s and never returned inside the old 300s, so the run 422'd having
// spent a full generation it could neither bill nor show; effort:medium took
// 213s and 194s across two runs — under 300s, but with <30% headroom against
// observed ~2x run-to-run variance in adaptive thinking, so a slow sample of a
// passing config would still 422.
//
// Raising this does NOT make the model generate more: the abort is client-side
// and only decides whether we receive the round. It does make repair rounds 2-3
// reachable, and each round re-sends the prior round's output as input — so the
// worst case gets more expensive even though the per-round cost is unchanged.
// ROUND_TIMEOUT_MS / MAX_REPAIR_ROUNDS / MAX_TOKENS below are exported for the
// #350 joint runner (competition-schedule-ai/), which drives the same round
// loop over a multi-division pack and must not fork these numbers. Export only —
// no caller behaviour changes.
export const ROUND_TIMEOUT_MS = Number(process.env.SCHEDULING_AI_ROUND_TIMEOUT_MS) || 600_000;
export const MAX_REPAIR_ROUNDS = 2;

/** Output token ceiling per round. Configurable per environment (same
 *  philosophy as AI_PROVIDER) so a candidate that spends its whole budget on
 *  reasoning can be given more room without a code change. Default of
 *  32_000 is unchanged from the hardcoded value, so the shipped Anthropic
 *  path behaves identically unless this is explicitly overridden. */
export const MAX_TOKENS = Number(process.env.SCHEDULING_AI_MAX_TOKENS) || 32_000;

/** The model every architect run uses (both phases import this — single
 *  source). Default measured live 2026-07-19 (17-fixture pack, adaptive
 *  thinking, effort:high): opus-4-8 could not finish round 1 inside 300s;
 *  sonnet-5 returned an engine-verified CLEAN plan in one 249s round at
 *  $0.42. The deterministic referee checks every proposal regardless of
 *  model, so the faster model is the safe default; SCHEDULING_AI_MODEL
 *  still overrides. */
export function schedulingAiModel(): string {
  return process.env.SCHEDULING_AI_MODEL ?? "claude-sonnet-5";
}

/** Effort hint for the architect call.
 *
 *  Stays "high". A live A/B (2026-07-20, sonnet-5, two packs, n=3 per cell)
 *  was run specifically to justify lowering it, and concluded against:
 *
 *    pack             effort   secs mean            out mean   warnings
 *    teams-15 (30)    high     276.8 [268.5-282.9]   29,858       0
 *    teams-15 (30)    medium   616.1 [291.4-808.3]   20,411       0
 *    individuals-50   high      97.6 [ 73.4-142.7]   11,510       0
 *    individuals-50   medium    80.0 [ 55.8- 98.0]    9,460       0
 *
 *  Quality is identical — all 12 runs returned an engine-verified plan with
 *  zero blocking, zero warnings, zero repair rounds. So the only live axes are
 *  latency and money, and on the dense pack medium is 2.2x SLOWER to save
 *  $0.135. Against a lifetime quota of 20-50 runs per division that is a few
 *  dollars, traded for ~5.6 extra minutes of an organiser watching a spinner.
 *
 *  An n=1 pass had briefly suggested the opposite (medium "5.1x faster") — that
 *  was a 1095s outlier on the high side; with n=3 high never exceeded 283s on
 *  that pack. Recorded here because the wrong conclusion shipped for a day.
 *
 *  Effort escalation is NOT viable for the same reason: medium never produced a
 *  degraded plan, so the referee has nothing to escalate on. Cheap-MODEL
 *  escalation is a different matter — see runLadder / runAiPlanLadder.
 *
 *  Phase B (officials-ai.ts) is deliberately still "high": it was not measured.
 *  Full write-up: design/v4/04-architect-benchmarks.md. */
export function schedulingAiEffort(): AiEffort {
  return parseAiEffort(process.env.SCHEDULING_AI_EFFORT, "high");
}

export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

const AI_EFFORTS: readonly AiEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Shared by both architect phases, which carry DIFFERENT defaults on purpose:
 *  Phase A is benched, Phase B is not. An unset or unrecognised value falls back
 *  rather than throwing — a typo'd env var must not take AI scheduling down. */
export function parseAiEffort(raw: string | undefined, fallback: AiEffort): AiEffort {
  return (AI_EFFORTS as readonly string[]).includes(raw ?? "") ? (raw as AiEffort) : fallback;
}

/** Thinking mode for the architect call.
 *
 *  Measured 2026-07-20: the structured plan is only ~2,588 tokens of a 27,349
 *  token response — 90.5% of what a run costs is thinking, not output. So this
 *  is the largest single cost lever available, an order of magnitude bigger
 *  than any schema change (short ids save 2.1%, diff-from-draft 7.5%).
 *
 *  Default stays "adaptive". Turning it off is only defensible because the
 *  deterministic referee verifies every proposal and the repair loop re-prompts
 *  on blocking conflicts — a thin plan gets caught, never shipped. Whether that
 *  actually wins is an open question: fewer thinking tokens per round, but
 *  possibly more rounds, and each round re-sends the prior output as input.
 *  SCHEDULING_AI_THINKING=disabled exists so the bench can settle it. */
export type AiThinking = "adaptive" | "disabled";

export function schedulingAiThinking(): AiThinking {
  return process.env.SCHEDULING_AI_THINKING === "disabled" ? "disabled" : "adaptive";
}

/** Models that predate adaptive thinking and the effort parameter. Verified
 *  live against the API on 2026-07-20 — claude-haiku-4-5 rejects BOTH:
 *    thinking:{type:"adaptive"}  → 400 "adaptive thinking is not supported on this model"
 *    output_config.effort        → 400 "This model does not support the effort parameter."
 *  It does accept legacy `thinking:{type:"enabled",budget_tokens}` and returns
 *  structured output through zodOutputFormat exactly like the newer models, so
 *  it is usable here — just not with the request shape the newer models want. */
const LEGACY_REASONING_MODELS = new Set(["claude-haiku-4-5", "claude-sonnet-4-5"]);

/** Thinking budget for legacy-reasoning models. Must stay below max_tokens.
 *  Unlike effort's five positions this is a token-precise ceiling, which is the
 *  shape this workload wants: the 2026-07-20 repeats showed effort:medium's
 *  problem was spread (1.63x), not its average. */
export function schedulingAiThinkingBudget(): number {
  const n = Number(process.env.SCHEDULING_AI_THINKING_BUDGET);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 0;
}

/** The reasoning half of the request, shaped for what `model` actually accepts.
 *  Anthropic-shaped: schedule-ai-run.test.ts asserts these fields directly.
 *
 *  Derived from `aiReasoning` below (the provider-neutral function `callModel`
 *  actually uses) rather than duplicating the per-model branching, so there is
 *  one source of truth for reasoning policy — a bug in `aiReasoning` fails
 *  this function's tests too instead of shipping silently. */
export function aiReasoningParams(model: string): {
  thinking?: { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budget_tokens: number };
  effort?: AiEffort;
} {
  const r = aiReasoning(model);
  if (r.kind === "none") return {};
  if (r.kind === "budget") return { thinking: { type: "enabled", budget_tokens: r.tokens } };
  return { thinking: { type: r.thinking }, effort: r.effort };
}

/** Provider-neutral reasoning request, shaped for what `model` actually
 *  accepts. Same legacy-model list and budget as `aiReasoningParams` — this is
 *  what `callModel` sends through the provider seam.
 *
 *  `effort` rides along even when thinking is disabled — the code this
 *  replaces (the old inline callModel) sent it unconditionally. Mapping
 *  "disabled" thinking to `kind: "none"` would silently drop
 *  SCHEDULING_AI_EFFORT on that path. */
export function aiReasoning(model: string): AiReasoning {
  if (LEGACY_REASONING_MODELS.has(model)) {
    const budget = schedulingAiThinkingBudget();
    return budget > 0 ? { kind: "budget", tokens: budget } : { kind: "none" };
  }
  return {
    kind: "effort",
    effort: schedulingAiEffort(),
    thinking: schedulingAiThinking() === "disabled" ? "disabled" : "adaptive",
  };
}
