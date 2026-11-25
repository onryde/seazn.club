// W3 batch-4 review I1: what the Swiss admin doors' refusals say — "Add a round" and "Finish the Swiss now", from the
// stage rail (stages-panel.tsx, `swissStageRefusal`) and from the Entrants tab's late-add recovery (entrants-panel.tsx,
// `fail`). ONE mapping for both panels, so the same write never reads two ways: a Swiss refusal by its code
// (`swissRefusalText`), a frozen timetable (SCHEDULE_LOCKED — the freeze sits outside the Swiss predicates, checked first,
// T12 ruling m2) as the Schedule page names it, and a rule lock (FIXTURE_HAS_OWN_FORMAT: a removed shell carrying its own
// format) by `ruleRefusalText`. Null for any other code: the caller keeps its own copy for those.
//
// Client-safe: both callers are client components.
import type { MessageKey } from "./messages";
import { onlinePackageRefusalText } from "./online-package-refusal";
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
  // Online Chess credits (spec 2026-11-23 §7.6, §8.1): a rounds edit or an added round that the division's size does not include
  // (ONLINE_ROUNDS_NEED_SIZE, with the size to move to) or that no size includes (ONLINE_ROUNDS_ABOVE_MAX) - said in the reader's
  // language, never the server's English.
  const online = onlinePackageRefusalText({ code, extra }, (key, vars) => msg(key as MessageKey, vars));
  if (online !== null) return online;
  return ruleRefusalText(code, extra, msg);
}
