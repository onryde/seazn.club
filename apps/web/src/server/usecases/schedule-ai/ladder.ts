import "server-only";
import type { ProviderName } from "@/server/ai/select-provider";
import { AiProviderError } from "@/server/ai/provider";
import { HttpError } from "@/lib/errors";
import { schedulingAiModel } from "./model-config";
import type { AiPlanResult } from "./types";

/** Opt-in cheaper first-attempt model. Unset (the default) means no escalation
 *  and behaviour is exactly as before. */
export function schedulingAiCheapModel(): string | null {
  return process.env.SCHEDULING_AI_CHEAP_MODEL || null;
}

/** Warnings-per-movable-fixture above which a cheap plan is rejected and the
 *  primary model re-runs.
 *
 *  UNCALIBRATED. Measured 2026-07-20 (n=3 per cell): sonnet-5 scored 0 warnings
 *  on both benched packs; haiku-4-5 scored 0 on the sparse pack and 20/43/100
 *  on the dense one — 0.67, 1.43 and 3.33 per fixture. The default of 1.0 sits
 *  inside that observed range rather than at a boundary derived from real
 *  divisions, so it will need tuning against production data before this is
 *  trusted. That is exactly why escalation is opt-in. */
function escalationWarningRatio(): number {
  const n = Number(process.env.SCHEDULING_AI_ESCALATE_WARN_RATIO);
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

/** Is a plan good enough to ship without re-running on the primary model?
 *  Blocking conflicts are never acceptable — the engine says the schedule is
 *  physically impossible. Warnings are soft (rest, blackout, session window,
 *  cross-person), so they are judged against pack size rather than absolutely.
 *
 *  Exported for the #350 joint ladder, and its parameter widened from
 *  AiPlanResult to the two fields it actually reads so a joint result (which
 *  carries division-tagged proposals) satisfies it without a cast. No caller
 *  behaviour changes — every existing AiPlanResult still matches. */
export function planIsAcceptable(
  result: Pick<AiPlanResult, "blocking" | "warnings">,
  movableCount: number,
): boolean {
  if (result.blocking.length > 0) return false;
  if (movableCount === 0) return true;
  return result.warnings.length / movableCount <= escalationWarningRatio();
}

/** One candidate in the fallback ladder: a model and the provider that serves
 *  it. Provider is pinned per rung so a cross-provider ladder (OpenRouter
 *  gemini → Anthropic sonnet → OpenRouter grok) never mutates AI_PROVIDER. */
export type LadderRung = { provider: ProviderName; model: string };

/** Parse SCHEDULING_AI_LADDER into ordered rungs, or null when unset/empty (the
 *  caller then uses the legacy cheap→primary path). Comma-separated model ids;
 *  the provider is inferred from the id — an OpenRouter id carries a vendor
 *  prefix ("google/…", "x-ai/…"), an Anthropic id does not ("claude-sonnet-5").
 *  Example (the recommended production ladder):
 *    SCHEDULING_AI_LADDER="google/gemini-3.6-flash,claude-sonnet-5,x-ai/grok-4.5"
 */
/** Parse a comma-separated ladder spec into rungs, or null when empty/unset.
 *  Shared by the schedule and officials ladders (each reads its own env var).
 *  Provider is inferred from the id — a "/" means an OpenRouter vendor prefix,
 *  else Anthropic direct. */
export function parseLadderSpec(raw: string | null | undefined): LadderRung[] | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const rungs = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((model): LadderRung => ({ provider: model.includes("/") ? "openrouter" : "anthropic", model }));
  return rungs.length > 0 ? rungs : null;
}

export function schedulingAiLadder(): LadderRung[] | null {
  return parseLadderSpec(process.env.SCHEDULING_AI_LADDER);
}

/** The shipped default fallback ladder: cheap/fast primary → proven backstop →
 *  last-ditch. Rungs whose provider has no API key are SKIPPED at run time (see
 *  isConfigured / isRecoverable), so a deployment with only ANTHROPIC_API_KEY
 *  transparently resolves to sonnet-direct; the gemini/grok rungs activate only
 *  once OPENROUTER_API_KEY is present. That key is the deliberate production
 *  flip — no separate SCHEDULING_AI_LADDER needed. */
export const DEFAULT_LADDER: readonly LadderRung[] = [
  { provider: "openrouter", model: "google/gemini-3.6-flash" },
  { provider: "anthropic", model: "claude-sonnet-5" },
  { provider: "openrouter", model: "x-ai/grok-4.5" },
];

/** The ordered candidate list for one architect run. Precedence:
 *    1. SCHEDULING_AI_LADDER       — explicit ladder, used verbatim.
 *    2. SCHEDULING_AI_MODEL         — explicit single-model pin (no fallback),
 *       on the AI_PROVIDER transport; the "force exactly this model" escape
 *       hatch (also what the bench pins, though the bench calls runAiPlan
 *       directly and never reaches here).
 *    3. SCHEDULING_AI_CHEAP_MODEL   — legacy cheap→primary escalation.
 *    4. DEFAULT_LADDER              — the shipped default (gemini→sonnet→grok).
 *  Because unconfigured rungs are skipped, (4) resolves to sonnet-direct until
 *  OPENROUTER_API_KEY is set, so nothing about a no-OpenRouter deployment
 *  changes. */
export function planRungs(): LadderRung[] {
  const ladder = schedulingAiLadder();
  if (ladder) return ladder;
  const provider: ProviderName = process.env.AI_PROVIDER === "openrouter" ? "openrouter" : "anthropic";
  if (process.env.SCHEDULING_AI_MODEL) return [{ provider, model: process.env.SCHEDULING_AI_MODEL }];
  const cheap = schedulingAiCheapModel();
  if (cheap && cheap !== schedulingAiModel()) {
    return [{ provider, model: cheap }, { provider, model: schedulingAiModel() }];
  }
  return [...DEFAULT_LADDER];
}

type Usage = AiPlanResult["usage"];

/** Sum a run's usage into the accumulator. `cost_usd` is null-preserving: a real
 *  `null` (cost unknown — the model has no PRICING entry) must NOT collapse to 0
 *  (which asserts "free" and undercounts the total); only a genuinely-absent
 *  `undefined` defaults to 0. */
function addUsage(acc: Usage, next: Partial<Usage>): Usage {
  const nextCost = next.cost_usd === undefined ? 0 : next.cost_usd;
  return {
    input_tokens: acc.input_tokens + (next.input_tokens ?? 0),
    output_tokens: acc.output_tokens + (next.output_tokens ?? 0),
    repair_rounds: acc.repair_rounds + (next.repair_rounds ?? 0),
    cost_usd: acc.cost_usd === null || nextCost === null ? null : acc.cost_usd + nextCost,
  };
}

/** Does this error justify trying the next rung? A plan the model could not
 *  produce (AI_PLAN_FAILED / AI_PLAN_TIMEOUT), a transport/API failure
 *  (AiProviderError — unparsable body, 5xx, refusal), or a rung whose provider
 *  simply has no API key here (AI_PROVIDER_NOT_CONFIGURED — skip it) is
 *  recoverable by a different model/provider. A deterministic user error (empty
 *  scope, too large, 400/404) is NOT — it would fail identically on every rung.
 *
 *  Skipping unconfigured rungs is what lets DEFAULT_LADDER ship safely: a
 *  deployment with only ANTHROPIC_API_KEY skips the gemini/grok rungs and lands
 *  on sonnet-direct; if EVERY rung is unconfigured, the last one's 503
 *  propagates unchanged. */
function isRecoverable(err: unknown): boolean {
  if (err instanceof AiProviderError) return true;
  return (
    err instanceof HttpError &&
    (err.code === "AI_PLAN_FAILED" ||
      err.code === "AI_PLAN_TIMEOUT" ||
      err.code === "AI_PROVIDER_NOT_CONFIGURED")
  );
}

/**
 * Run an ordered ladder of model candidates, returning the first acceptable
 * plan and falling back on evidence (a thrown recoverable failure, or a
 * usable-but-degraded plan that fails `acceptable`). Deterministic user errors
 * stop the ladder immediately — retrying them only burns money.
 *
 * ESCALATE on evidence, don't PREDICT from the pack: choosing a model up front
 * needs a "density" metric the bench could not supply, and the referee already
 * measures the thing that matters — plan quality — so let it decide. Failure
 * mode is bounded: a wasted earlier rung is at most the cost of that rung, and
 * the ladder can never ship a worse plan than a later rung would have.
 *
 * COST TRUTH (aligns spend with what actually ran): usage from EVERY attempted
 * rung is summed (null-preserving), and the winning rung's model is returned as
 * `served_model` so the ledger/analytics record the model that produced the
 * plan — not a static default. When all rungs fail, the thrown error carries the
 * accumulated usage and the last rung's model so a failed run is still metered
 * against the truth.
 *
 * Pure over `attempt`/`acceptable` so it is unit-tested without a network.
 * Generic over the result so both phases reuse it — schedule (AiPlanResult) and
 * officials (OfficialsPlanResult) both carry a `usage` with the same shape.
 *
 * The hard token budget (lib/ai-rung.ts) needs NOTHING from this function: the
 * caller closes over one `TokenMeter` and hands the same instance to every
 * rung's runner, which charges it per round. Cross-rung accounting therefore
 * cannot drift from the ladder's own `acc`, and a rung that throws without
 * riding its usage on the error still has its tokens counted.
 */
export async function runLadder<T extends { usage: Usage }>(
  rungs: LadderRung[],
  attempt: (rung: LadderRung) => Promise<T>,
  acceptable: (result: T) => boolean,
  /** Asked BEFORE each rung after the first. Returning false stops escalation
   *  without recording the rung — a budget-exhausted run must not list models
   *  it never actually asked in `rungs_tried`. */
  canEscalate?: () => boolean,
): Promise<T & { served_model: string; escalated_from?: string; rungs_tried: string[] }> {
  let acc: Usage = { input_tokens: 0, output_tokens: 0, repair_rounds: 0, cost_usd: 0 };
  const tried: string[] = [];
  // Best-so-far USABLE plan (a rung returned it, but it failed `acceptable`).
  // A degraded-but-real plan beats any failure, so if every later rung throws or
  // is skipped (unconfigured), this is returned rather than surfacing an error —
  // exactly what the old single-rung path did when sonnet was the terminal rung.
  let bestEffort: { result: T; model: string } | null = null;
  // Most recent MEANINGFUL failure (anything but a skipped-because-unconfigured
  // rung) + the model that raised it. Thrown on exhaustion ONLY when no usable
  // plan exists, in preference to a trailing "not configured" skip — so a real
  // outage / AI_PLAN_FAILED on a configured rung surfaces with its true code, not
  // a spurious 503-not-configured.
  let meaningful: { err: unknown; model: string } | null = null;
  const finalize = (result: T, model: string) => ({
    ...result,
    usage: acc,
    served_model: model,
    rungs_tried: tried,
    ...(tried.length > 1 ? { escalated_from: tried[0] } : {}),
  });
  // Exhausted (the ladder ran out of rungs, or escalation was stopped early).
  // A usable (if degraded) plan beats any failure — ship it. Otherwise throw the
  // last MEANINGFUL failure over a trailing unconfigured skip, carrying the
  // accumulated spend + the model that raised it. HttpError.extra is read-only
  // → rebuild it; provider errors take loose fields.
  const exhaust = (err: unknown, model: string): never => {
    const chosen = meaningful ?? { err, model };
    if (chosen.err instanceof HttpError) {
      throw new HttpError(chosen.err.status, chosen.err.message, chosen.err.code, {
        ...(chosen.err.extra ?? {}),
        usage: acc,
        model: chosen.model,
      });
    }
    (chosen.err as { usage?: Usage; model?: string }).usage = acc;
    (chosen.err as { model?: string }).model = chosen.model;
    throw chosen.err;
  };
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i]!;
    const last = i === rungs.length - 1;
    if (i > 0 && canEscalate && !canEscalate()) {
      if (bestEffort) return finalize(bestEffort.result, bestEffort.model);
      exhaust(
        meaningful?.err ?? new HttpError(422, "AI planning stopped before a usable plan", "AI_PLAN_FAILED"),
        tried[tried.length - 1] ?? rung.model,
      );
    }
    tried.push(rung.model);
    try {
      const result = await attempt(rung);
      acc = addUsage(acc, result.usage);
      if (acceptable(result)) return finalize(result, rung.model); // clean win — stop
      bestEffort = { result, model: rung.model }; // usable but degraded — remember
      if (last) return finalize(result, rung.model); // nothing better left to try
    } catch (err) {
      if (!isRecoverable(err)) throw err;
      acc = addUsage(acc, (err as { extra?: { usage?: Partial<Usage> } }).extra?.usage ?? {});
      const unconfigured = err instanceof HttpError && err.code === "AI_PROVIDER_NOT_CONFIGURED";
      if (!unconfigured) meaningful = { err, model: rung.model };
      if (last) {
        if (bestEffort) return finalize(bestEffort.result, bestEffort.model);
        exhaust(err, rung.model);
      }
    }
  }
  // Unreachable: a non-empty ladder's final rung always returns or throws.
  throw new HttpError(500, "model ladder exhausted without a result", "AI_PLAN_FAILED");
}
