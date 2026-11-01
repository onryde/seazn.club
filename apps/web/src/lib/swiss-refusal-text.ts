// W3 Task 11 (X-SW-16): a Swiss refusal (`lib/swiss-refusals.ts`) said in the reader's language, with what to do next.
// Apart from `lib/swiss-rounds.ts` on purpose: that module is pure arithmetic with no import, because a smoke suite loads
// it under bare `node --experimental-strip-types` (scripts/smoke/suites/swissKnockout.ts) and the scripts typecheck
// cannot follow the dictionary types this file needs. Client-safe: stages-panel.tsx and launch-actions.tsx call it.
import type { MessageKey } from "./messages";
import { swissRefusalKey, type SwissRefusalCode } from "./swiss-refusals";
import { swissRoundsGuidanceLine, type SwissRoundsPlural } from "./swiss-rounds";

/** `useMsg()` satisfies it. */
export type SwissRefusalMsg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * A Swiss refusal (`lib/swiss-refusals.ts`) in the reader's language, off its CODE — never the server's English. For
 * `SWISS_ROUNDS_ABOVE_MAX` whose details name the field (`{ rounds, field, hardMax, canFinish }`), a second sentence
 * says what to do: as sent (Generate, Start) the field's guidance, so the organiser reads the number to set; after the
 * field shrank under a running Swiss (`canFinish`), what the field still pairs and that the Swiss can be finished — the
 * count is fixed once a match has started (T12), so "recommended" would mislead there.
 */
export function swissRefusalText(
  code: SwissRefusalCode,
  details: Record<string, unknown> | undefined,
  msg: SwissRefusalMsg,
  plural: SwissRoundsPlural,
): string {
  const sentence = msg(swissRefusalKey(code));
  if (code !== "SWISS_ROUNDS_ABOVE_MAX") return sentence;
  const field = details?.field;
  const hardMax = details?.hardMax;
  if (details?.canFinish === true && typeof field === "number" && typeof hardMax === "number") {
    return `${sentence} ${plural("swiss.rounds.shrunk", hardMax, { field })}`;
  }
  const line = typeof field === "number" ? swissRoundsGuidanceLine(field, plural) : null;
  return line === null ? sentence : `${sentence} ${line}`;
}
