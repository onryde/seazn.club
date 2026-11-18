// C38 review I1: the one reading of a `group_too_few_entrants` refusal (STAGE_NOT_READY, api-v1/http.ts forwards
// groups / entrants / required) shared by every screen that generates a group stage - the stages panel's Generate and
// the board's Start / Publish all - so none paints the server's English sentence. Client-safe: type import only.
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function tooFewGroupEntrantsText(extra: Record<string, unknown>, msg: Msg): string {
  const groups = Number(extra.groups ?? 1);
  if (groups <= 1) return msg("schedule.error.tooFewEntrants");
  const vars = { required: Number(extra.required ?? groups * 2), have: Number(extra.entrants ?? 0), groups };
  // W5 T12 (X-BD-1, PO-1): the refusal names the group count that works (`suggested`, the one rule the builder's Next also reads), or
  // says to add entrants when none does. A refusal without the key (an older server) keeps the unnamed sentence.
  if (typeof extra.suggested === "number") return msg("schedule.error.tooFewGroupEntrantsSuggest", { ...vars, suggested: extra.suggested });
  if (extra.suggested === null) return msg("schedule.error.tooFewGroupEntrantsAdd", vars);
  return msg("schedule.error.tooFewGroupEntrants", vars);
}
