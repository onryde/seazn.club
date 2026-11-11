// C38 review I1: the one reading of a `group_too_few_entrants` refusal (STAGE_NOT_READY, api-v1/http.ts forwards
// groups / entrants / required) shared by every screen that generates a group stage - the stages panel's Generate and
// the board's Start / Publish all - so none paints the server's English sentence. Client-safe: type import only.
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function tooFewGroupEntrantsText(extra: Record<string, unknown>, msg: Msg): string {
  const groups = Number(extra.groups ?? 1);
  return groups > 1
    ? msg("schedule.error.tooFewGroupEntrants", {
        required: Number(extra.required ?? groups * 2),
        have: Number(extra.entrants ?? 0),
        groups,
      })
    : msg("schedule.error.tooFewEntrants");
}
