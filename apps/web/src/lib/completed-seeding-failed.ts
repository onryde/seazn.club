// STAGE_COMPLETED_SEEDING_FAILED (completeStage, `server/usecases/stages/completion.ts`): the stage's completion COMMITTED in its own
// transaction and only the next stage's seed proposal failed afterwards. Every door that offers Complete says it the same way: amber,
// "Stage completed — but …" with the carried cause, and a refresh, because the board still shows the stage as open. One home for that
// sentence so the stage rail (`classifyActError`, stages-panel.tsx) and the open-stages warning (`open-stages-warning.tsx`, B5 n1)
// cannot drift apart. Client-safe: no server import.
import { ApiV1Error } from "@/lib/client-v1";
import type { Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { BEST_NTH_REFUSAL_CODES, CROSS_POOL_REFUSAL_CODES, seedingErrorMessage } from "@/lib/seeding-error";
import { isRoundRobinRefusalCode } from "@/lib/roundrobin-refusals";
import { undoRefusalText } from "@/lib/undo-refusals";

export const STAGE_COMPLETED_SEEDING_FAILED = "STAGE_COMPLETED_SEEDING_FAILED";

/** The "completed, but" sentence for a STAGE_COMPLETED_SEEDING_FAILED refusal, in the reader's language - or null for any other error. */
export function completedSeedingFailedText(
  err: unknown,
  msg: (key: MessageKey, vars?: Record<string, string | number>) => string,
  locale: Locale = "en",
): string | null {
  if (!(err instanceof ApiV1Error) || err.code !== STAGE_COMPLETED_SEEDING_FAILED) return null;
  // B4 fix wave (12b m1): a cut the field cannot supply rides inside the wrap by name (`cause`, completion.ts) with its numbers, so
  // the reason is the cut's own sentence in the reader's language, never the server's English.
  const cause = err.extra?.cause;
  // W5 B4 review I-1: so does every other round-robin refusal the next stage's draw can raise (completion.ts wraps them all by name) -
  // a field past the format's max entrants, a draw past the line budget - its numbers grouped the reader's way.
  const reason =
    isRoundRobinRefusalCode(cause)
      ? undoRefusalText(cause, err.extra, msg, locale)
      : // W5 app PR B T4 (K19): a best-Nth cut nobody supplies, in the seeding copy (errors.json), with its numbers.
        // W5 app PR B T5 (K22): so is a cross-pool draw that cannot separate the pools.
        typeof cause === "string" && (BEST_NTH_REFUSAL_CODES.has(cause) || CROSS_POOL_REFUSAL_CODES.has(cause))
        ? seedingErrorMessage(locale, cause, err.message, err.extra as Record<string, string | number> | undefined)
        : err.message;
  return msg("schedule.error.completedSeedingFailed", { reason });
}
