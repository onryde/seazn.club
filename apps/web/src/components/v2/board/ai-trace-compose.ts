// #364 — the schedule referee trace, composed. Lifted out of ai-console.tsx so
// the marketing demo can narrate a canned plan through the SAME code the product
// console runs; a second copy would let the shipped surface and the surface that
// sells it drift apart.
//
// Pure: no JSX, no hooks, no dict. Every import here is type-only and erases at
// build, so the module is safe to pull into a client island. Localization enters
// as `msg` — the caller's `useMsg()` in the console, whatever the demo island
// hands it elsewhere.
//
// Out of scope: `ai-officials-review.tsx` keeps its own mirrored
// `buildOfficialsTrace`. It narrates a different spine over a different response
// shape; unifying the two is not this change.
import type { MessageKey } from "@/lib/messages";
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { TraceEvent } from "./ai-trace";

/** `useMsg()`'s signature, named so a caller outside a DictProvider can supply
 *  its own translator without the module depending on React. */
export type TraceMsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The slice of a plan response the composer reads — nothing else is touched,
 *  so a caller need not manufacture a whole run to narrate one. */
export type TraceSource = Pick<AiPlanResponse, "proposal" | "blocking" | "warnings" | "usage">;

/**
 * Compose the referee trace from the verified plan (design §0). There is no
 * server trace field, so the console narrates what the engine did from the
 * result: a draft/plan/verify spine, then — when a repair ran or conflicts
 * surfaced — flag lines (the caught conflicts, pulsed on the grid) and a repair
 * round, and finally either the mandated CLEAN line + Ready, or, when blocking
 * conflicts remain, a red "unresolved" tail (no clean, spine stays flagged).
 */
export function buildScheduleTrace(
  plan: TraceSource,
  courts: number,
  msg: TraceMsgFn,
): { events: TraceEvent[]; flaggedIds: string[] } {
  const events: TraceEvent[] = [];
  const node = (k: MessageKey) => events.push({ t: "step", text: msg(k) });
  const log = (text: string) => events.push({ t: "log", text });

  node("board.ai.trace.node.draft");
  log(msg("board.ai.trace.line.draft", { fixtures: plan.proposal.length, courts }));
  node("board.ai.trace.node.plan");
  log(msg("board.ai.trace.line.plan", { count: plan.proposal.length }));
  node("board.ai.trace.node.referee");
  log(msg("board.ai.trace.line.verify"));

  const conflicts = [...plan.blocking, ...plan.warnings];
  const flaggedIds = Array.from(new Set(conflicts.map((c) => c.fixtureId)));
  const repaired = plan.usage.repair_rounds > 0;

  if (repaired || conflicts.length > 0) {
    const shown = conflicts.slice(0, 3);
    if (shown.length > 0) {
      for (const c of shown) {
        events.push({ t: "flag", text: msg("board.ai.trace.line.flag", { what: c.detail || c.reason }) });
      }
    } else {
      events.push({ t: "flag", text: msg("board.ai.trace.line.flagGeneric") });
    }
    if (repaired) {
      node("board.ai.trace.node.repair");
      log(msg("board.ai.trace.line.repair", { rounds: plan.usage.repair_rounds }));
    }
  }

  if (plan.blocking.length > 0) {
    // Not clean — the engine could not fully verify; spine ends flagged.
    events.push({ t: "flag", text: msg("board.ai.trace.line.blockingRemain", { count: plan.blocking.length }) });
  } else {
    events.push({ t: "clean", text: msg("board.ai.trace.line.clean") });
    node("board.ai.trace.node.ready");
  }

  return { events, flaggedIds };
}
