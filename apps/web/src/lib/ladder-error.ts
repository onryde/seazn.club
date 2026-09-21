// LADDER_* error-code -> organiser copy for the ladder console's challenge
// form (`components/v2/ladder-panel.tsx`).
//
// Why this file exists: the panel rendered `err.message` verbatim — the
// server's own English prose — for every refusal, so a Spanish or Dutch
// organiser got an English sentence for the four things they are most likely
// to get wrong while issuing a challenge. `LADDER_ENTRANT_WITHDRAWN` (added
// with the withdrawn-entrant guard) shipped as the fourth instance of that,
// which is what prompted wiring all four rather than one.
//
// There is no server-side i18n in this repo — nothing under `src/server`
// reads Accept-Language and the /api/v1 envelope carries no locale — so the
// server keeps emitting English for non-browser clients and the CODE is what
// the panel translates. Mirrors `seeding-error.ts` and `schedule-error.ts`
// exactly (same `errors` namespace, same bundle-all-four-locales approach,
// same "fallback verbatim, never a raw wire code" contract) rather than
// inventing a third mechanism. A file and namespace of its own on purpose:
// seeding-error.ts's scope note forbids adding codes to ITS list without a
// fresh ruling, and these are not seeding errors.
//
// Not `server-only`: this runs in the panel's catch block, on the client.
import en from "@/dictionaries/en/errors.json";
import es from "@/dictionaries/es/errors.json";
import fr from "@/dictionaries/fr/errors.json";
import nl from "@/dictionaries/nl/errors.json";
import { DEFAULT_LOCALE, type Dict, type Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

const BY_LOCALE: Record<Locale, Dict> = { en, es, fr, nl };

/** The four refusals `issueChallenge` (server/usecases/stages.ts) can put in
 *  front of an organiser using the challenge form. ALL_CAPS_SNAKE wire codes
 *  by repo convention (schemas.ts), never i18n keys themselves.
 *
 *  The fifth refusal that function can throw — "challenges only exist on
 *  ladder stages" — is deliberately absent: the panel only renders on a
 *  ladder stage, so reaching it means a caller built the request by hand, and
 *  there is no organiser to write copy for. `SCHEDULE_LOCKED` is absent for
 *  the opposite reason: it already carries its own code and copy. */
export const LADDER_ERROR_CODES = [
  "LADDER_ENTRANT_FOREIGN",
  "LADDER_ENTRANT_WITHDRAWN",
  "LADDER_CHALLENGE_NOT_UPWARD",
  "LADDER_CHALLENGE_OUT_OF_RANGE",
] as const;
export type LadderErrorCode = (typeof LADDER_ERROR_CODES)[number];

function isLadderErrorCode(code: string): code is LadderErrorCode {
  return (LADDER_ERROR_CODES as readonly string[]).includes(code);
}

/** The `extra` the range refusal rides along with. Optional and `unknown`
 *  because it arrives off the wire: a payload with no usable range must fall
 *  back to the server's English sentence rather than render "at most
 *  undefined places". */
export interface LadderErrorExtra {
  range?: unknown;
}

/**
 * `ApiV1Error` (code, extra) -> localized organiser copy, or `fallback`
 * verbatim for any code outside the four above — never a raw wire code shown
 * to an organiser, and never a guess at copy this pass did not author.
 *
 * `LADDER_CHALLENGE_OUT_OF_RANGE` is the only one that names a number, and it
 * degrades to `fallback` when the payload cannot supply it: an accurate
 * English sentence reads better than a localized one with a hole in it (the
 * rule `scheduleWindowErrorMessage` already applies to its own dates).
 */
export function ladderErrorMessage(
  locale: Locale,
  code: string,
  extra: LadderErrorExtra | undefined,
  fallback: string,
): string {
  if (!isLadderErrorCode(code)) return fallback;
  const dict = BY_LOCALE[locale] ?? BY_LOCALE[DEFAULT_LOCALE];
  if (code === "LADDER_CHALLENGE_OUT_OF_RANGE") {
    const range = extra?.range;
    if (typeof range !== "number" || !Number.isFinite(range)) return fallback;
    return t(dict, `ladder.${code}`, { range });
  }
  return t(dict, `ladder.${code}`);
}
