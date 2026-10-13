// The fakes' copy of the product's W2a fixture-status rule (spec §5.4.2, D3), so a fake serves the status the
// product would. It mirrors apps/web/src/server/engine-db/append-event.ts `fixtureStatusFromFold` (loop F, Task 7)
// rather than importing it: the harness may not import from apps/web (ruling 17), and a fake that read the rule from
// the code under test would prove nothing. The expected statuses are the rule rows' (X-BR-1, X-BR-2, X-ST-1), and
// w2a-fakes.test.ts holds this function to them.
import { forbidsLevelResult, isLevelOutcome } from "@seazn/engine/core";

/** W2b D7 (the plan's status table, amending W2a's D3), in the product's order, over the ACTIVE (void-resolved)
 *  events: 1 an active settle decides, even an abandoned match; 2 an active abandon leaves it abandoned when it left
 *  no outcome, or a level one in a bracket kind (stuck and visible) — an abandon whose sport's rule gives it a result
 *  falls through (X-AB-2); 3 a level outcome in a bracket kind is HELD as needs_decision; 4 an active core.forfeit, or a
 *  double walkover, is forfeited; 5 any other outcome is decided; and no outcome is in_play once started, scheduled
 *  before. */
export function fixtureStatusFromFold(outcome: unknown, active: readonly { readonly type: string }[], stageKind: string | null): string {
  const has = (type: string) => active.some((e) => e.type === type);
  const heldLevel = outcome !== null && forbidsLevelResult(stageKind) && isLevelOutcome(outcome as never);
  if (has("core.settle")) return "decided";
  if (has("core.abandon") && (outcome === null || heldLevel)) return "abandoned";
  if (heldLevel) return "needs_decision";
  if (outcome !== null && (has("core.forfeit") || (outcome as { kind?: unknown }).kind === "double_walkover")) return "forfeited";
  if (outcome !== null) return "decided";
  return has("core.start") ? "in_play" : "scheduled";
}
