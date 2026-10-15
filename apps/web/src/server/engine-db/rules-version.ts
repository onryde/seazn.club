import "server-only";
// W2c Task 15 (X-SR-7, D14, owner P-1 "A") — the rules version an open scoring pad compares.
//
// `fixtures.rules_version` counts the corrections of a started match's format: 0 until a live correction or a staff
// re-freeze (`refreeze.ts`, the only bump). A pad loads it with the cfg it folds under and sends it with every tap; the
// append path refuses a version that is not the match's (`append-event.ts`), and the pad reloads the rules through
// `GET /api/v1/fixtures/{id}/rules` and says what they now are — this module's format line, in the reader's language.
import type { AnySportModule } from "@seazn/engine/sport";
import type { Dict } from "@/lib/i18n-constants";
import { rulesLineText } from "@/lib/rules-line";
import { describeMatchRules } from "@/server/public-site/describe-rules";

/**
 * A match's format as the public describer says it (`describeMatchRules`, the one describer every surface uses), in
 * `dict`'s language — or null when the describer has nothing honest to say of this sport or cfg. The caller then says
 * "the format changed" without naming it.
 */
export function formatLineOf(sportKey: string, module: AnySportModule, cfg: unknown, dict: Dict): string | null {
  const line = describeMatchRules(sportKey, module, cfg);
  return line === null ? null : rulesLineText(dict, line);
}
