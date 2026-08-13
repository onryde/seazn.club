import "server-only";
// The web-layer AUTHORITY for D2's capacity pre-check: runs `assessCapacity`
// and is the one place that throws — a 422 CAPACITY_IMPOSSIBLE with the
// report attached, following the AI_PLAN_FAILED precedent exactly (a typed
// HttpError code, no widening of EngineErrorCode/ENGINE_HTTP: this throw
// lives in the web layer, the engine lib itself throws nothing).
//
// The DB-shape -> CapacityInput conversion itself (`capacityInputForFixtures`)
// lives in `@/lib/capacity-input`, NOT here, and is re-exported below rather
// than duplicated: that module is CLIENT-SAFE (no `server-only`, no
// `@seazn/engine/scheduling` barrel import — see its own header) because the
// setup card imports it directly for its live, no-network recompute. This
// file adds exactly one thing the client must never have: the DB-adjacent
// throw + structured log.
import { assessCapacity, type CapacityInput, type CapacityReport } from "@seazn/engine/scheduling/capacity";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { CAPACITY_REPORT_KEY } from "@/server/api-v1/schemas";

export { capacityInputForFixtures, type CapacityConfigInput, type CapacityFixtureInput } from "@/lib/capacity-input";
export { CAPACITY_REPORT_KEY } from "@/server/api-v1/schemas";

/**
 * The ONE typed code both capacity-guard call sites throw — `schedule.ts`'s
 * stage guard (via `guardCapacity` below) and `competition-schedule-ai.ts`'s
 * per-division aggregation (which cannot use `guardCapacity` directly: it
 * must assess every kept division before throwing ONE combined 422 naming
 * all of them, not refuse on the first). A literal string at each throw
 * site is exactly the two-sites-drift shape this codebase keeps naming as
 * its recurring bug — import this, never retype it.
 */
export const CAPACITY_IMPOSSIBLE_CODE = "CAPACITY_IMPOSSIBLE";

/**
 * Structured logging (design doc's "pino event capacity_assessed"): fired
 * from the server-side consumer, never inside the pure lib. Shared so the
 * stage guard and the competition per-division loop cannot describe the
 * same event with two different field sets.
 */
export function logCapacityAssessed(
  report: CapacityReport,
  context: { scope: "stage" | "competition_division"; divisionId: string; [key: string]: unknown },
): void {
  log.info(
    {
      event: "capacity_assessed",
      verdict: report.verdict,
      slotSupply: report.slotSupply,
      slotDemand: report.slotDemand,
      ratio: report.slotDemand > 0 ? report.slotSupply / report.slotDemand : null,
      ...context,
    },
    "capacity_assessed",
  );
}

/**
 * The server's authority: re-run `assessCapacity` and refuse with a typed
 * 422 when the verdict is impossible. `input === null` means the caller's
 * config had nothing to assess (see `capacityInputForFixtures`) — passed
 * straight through, nothing logged, nothing thrown.
 */
export function guardCapacity(
  input: CapacityInput | null,
  context: { scope: "stage" | "competition_division"; divisionId: string; [key: string]: unknown },
): CapacityReport | null {
  if (input === null) return null;
  const report = assessCapacity(input);
  logCapacityAssessed(report, context);
  if (report.verdict === "impossible") {
    throw new HttpError(
      422,
      "This schedule cannot fit the configured courts, dates and rest rules",
      CAPACITY_IMPOSSIBLE_CODE,
      { [CAPACITY_REPORT_KEY]: report },
    );
  }
  return report;
}
