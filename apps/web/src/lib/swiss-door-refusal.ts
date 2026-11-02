// W3 batch-4 review I1: what the Swiss admin doors' refusals say — "Add a round" and "Finish the Swiss now", from the
// stage rail (stages-panel.tsx, `swissStageRefusal`) and from the Entrants tab's late-add recovery (entrants-panel.tsx,
// `fail`). ONE mapping for both panels, so the same write never reads two ways: a Swiss refusal by its code
// (`swissRefusalText`), a frozen timetable (SCHEDULE_LOCKED — the freeze sits outside the Swiss predicates, checked first,
// T12 ruling m2) as the Schedule page names it, and a rule lock (FIXTURE_HAS_OWN_FORMAT: a removed shell carrying its own
// format) by `ruleRefusalText`. Null for any other code: the caller keeps its own copy for those.
//
// Client-safe: both callers are client components.
import { ruleRefusalText } from "./rule-errors";
import { SCHEDULE_LOCKED_CODE } from "./schedule-lock";
import { swissRefusalText, type SwissRefusalMsg } from "./swiss-refusal-text";
import { isSwissRefusalCode } from "./swiss-refusals";
import type { SwissRoundsPlural } from "./swiss-rounds";

export function swissDoorRefusalText(
  code: string | undefined,
  extra: Record<string, unknown> | undefined,
  msg: SwissRefusalMsg,
  plural: SwissRoundsPlural,
): string | null {
  if (isSwissRefusalCode(code)) return swissRefusalText(code, extra, msg, plural);
  if (code === SCHEDULE_LOCKED_CODE) return msg("stage.error.scheduleFrozen");
  return ruleRefusalText(code, extra, msg);
}
