// SCHEDULE_OUTSIDE_COMPETITION -> localized organiser copy.
//
// The containment guard in `server/usecases/schedule.ts` refuses a division
// whose schedule range falls outside its competition's own dates. Its 422
// message is composed English prose, and the board rendered it verbatim
// (`schedule-board.tsx`: `err instanceof Error ? err.message : …`), so an
// organiser reading the console in Spanish got an English sentence for the one
// refusal they are most likely to hit while setting a division up.
//
// There is no server-side i18n in this repo — nothing under `src/server` reads
// Accept-Language, and the /api/v1 envelope has no locale — so the server keeps
// emitting English for non-browser clients and the CODE is what the panel
// translates. This mirrors `seeding-error.ts` exactly (same `errors` namespace,
// same bundle-all-four-locales approach, same "fallback verbatim, never a raw
// wire code" contract) rather than inventing a second mechanism. It is a
// separate file and a separate namespace on purpose: that module's scope note
// forbids adding codes to ITS list without a fresh ruling.
//
// THREE keys, not one with an optional clause. Which bound was crossed changes
// the sentence's structure in every locale (French moves the date, Dutch moves
// the verb), so a single template with two optional halves would be
// untranslatable. The server says which bounds were crossed in `extra`; this
// picks the matching key.
import en from "@/dictionaries/en/errors.json";
import es from "@/dictionaries/es/errors.json";
import fr from "@/dictionaries/fr/errors.json";
import nl from "@/dictionaries/nl/errors.json";
import { DEFAULT_LOCALE, type Dict, type Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { ApiV1Error } from "@/lib/client-v1";

const BY_LOCALE: Record<Locale, Dict> = { en, es, fr, nl };

/** The wire code thrown by the containment guard. ALL_CAPS_SNAKE by repo
 *  convention (schemas.ts) — a wire code, never an i18n key itself. */
export const SCHEDULE_OUTSIDE_COMPETITION = "SCHEDULE_OUTSIDE_COMPETITION";

/** The `extra` the guard rides along with. Every field optional at this
 *  boundary because it arrives off the wire: a payload missing a bound, or
 *  carrying a null date, must degrade to the fallback rather than render
 *  "opens on undefined". */
export interface ScheduleWindowExtra {
  startsBefore?: unknown;
  endsAfter?: unknown;
  competitionStartsOn?: unknown;
  competitionEndsOn?: unknown;
}

function day(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * `ApiV1Error` (code, extra) -> localized copy, or `fallback` verbatim.
 *
 * `fallback` is returned — never a key, never a wire code — for any other
 * code, and also when the payload cannot fill the sentence it selected: a
 * "starts before" refusal with no competition start date has nothing to name,
 * and the server's own English message is strictly better than a sentence with
 * a hole in it.
 */
export function scheduleWindowErrorMessage(
  locale: Locale,
  code: string,
  extra: ScheduleWindowExtra | undefined,
  fallback: string,
): string {
  if (code !== SCHEDULE_OUTSIDE_COMPETITION) return fallback;
  const startsBefore = extra?.startsBefore === true;
  const endsAfter = extra?.endsAfter === true;
  const startsOn = day(extra?.competitionStartsOn);
  const endsOn = day(extra?.competitionEndsOn);

  // Which variant the payload can actually SUPPORT, not which one it claims:
  // a bound with no date to name is dropped here, so "both" degrades to the
  // half that has a date rather than to a sentence with `{endsOn}` in it.
  const before = startsBefore && startsOn !== null;
  const after = endsAfter && endsOn !== null;
  const variant = before && after ? "both" : before ? "before" : after ? "after" : null;
  if (variant === null) return fallback;

  const dict = BY_LOCALE[locale] ?? BY_LOCALE[DEFAULT_LOCALE];
  return t(dict, `schedule.${SCHEDULE_OUTSIDE_COMPETITION}.${variant}`, {
    startsOn: startsOn ?? "",
    endsOn: endsOn ?? "",
  });
}

/** The wire code thrown by `putScheduleSettings`'s court-removal guard
 *  (`server/usecases/schedule.ts`) when a dropped court still holds a fixture
 *  the schedule cannot relocate. Deliberately NOT `venues.ts`'s
 *  `COURT_IN_USE` — same shape of problem, different guard, different
 *  remedy set (that one blocks archiving; this one blocks removing a court
 *  from `config.courts`). */
export const SCHEDULE_COURT_STILL_IN_USE = "SCHEDULE_COURT_STILL_IN_USE";

/** The `extra` the court-removal guard rides along with. Same "arrives off
 *  the wire, every field optional" discipline as `ScheduleWindowExtra`: a
 *  payload missing both booleans, or carrying a non-string `courtsDetail`,
 *  must degrade to the fallback rather than render a sentence with nothing
 *  to name. */
export interface ScheduleCourtInUseExtra {
  anyPinned?: unknown;
  anyInPlay?: unknown;
  anyFixed?: unknown;
  courtsDetail?: unknown;
}

/**
 * `ApiV1Error` (code, extra) -> localized copy for the court-removal guard,
 * or `fallback` verbatim.
 *
 * FOUR variants, picked by three independent booleans rather than one
 * template with optional clauses — same reasoning as
 * `scheduleWindowErrorMessage` above. `anyFixed` here means "genuinely
 * archivable" (completed/decided/finalized/forfeited) — `anyInPlay` is
 * deliberately its own boolean, not folded into `anyFixed`: archiving a
 * court blocks on the exact same still-unplayed statuses `venues.ts`'s
 * `archiveCourt` guards on, which INCLUDES `in_play`. Telling an organiser
 * to "archive it instead" for a live match would send them straight into a
 * second 409 with no remedy at all — the bug this split closes. Two or more
 * booleans true falls through to `mixed`, which names every reason without
 * promising a specific single-step remedy (a per-court breakdown, not a
 * per-reason one, is what `courtsDetail` already carries).
 */
export function courtStillInUseErrorMessage(
  locale: Locale,
  code: string,
  extra: ScheduleCourtInUseExtra | undefined,
  fallback: string,
): string {
  if (code !== SCHEDULE_COURT_STILL_IN_USE) return fallback;
  const anyPinned = extra?.anyPinned === true;
  const anyInPlay = extra?.anyInPlay === true;
  const anyFixed = extra?.anyFixed === true;
  const courtsDetail =
    typeof extra?.courtsDetail === "string" && extra.courtsDetail !== "" ? extra.courtsDetail : null;

  // Which variant the payload can actually SUPPORT: no usable `courtsDetail`
  // means every variant is a sentence with a hole in it, and no boolean true
  // means there is no remedy to name at all.
  if (courtsDetail === null) return fallback;
  const reasonCount = [anyPinned, anyInPlay, anyFixed].filter(Boolean).length;
  const variant =
    reasonCount > 1 ? "mixed" : anyPinned ? "pinned" : anyInPlay ? "inPlay" : anyFixed ? "fixed" : null;
  if (variant === null) return fallback;

  const dict = BY_LOCALE[locale] ?? BY_LOCALE[DEFAULT_LOCALE];
  return t(dict, `schedule.${SCHEDULE_COURT_STILL_IN_USE}.${variant}`, { courtsDetail });
}

/**
 * A failed schedule-settings save, as the organiser should read it.
 *
 * Both surfaces that save these settings — the board's inline settings card
 * and the division's settings TAB — used to render `err.message`, the server's
 * own English prose, for every failure. That is how a Spanish organiser got an
 * English sentence for the containment refusal, the refusal they are most
 * likely to meet while setting a division up.
 *
 * Lives here rather than beside either caller because both call it: putting it
 * in `schedule-board.tsx` and importing it from `board/settings-panel.tsx`
 * would close an import cycle (the board renders the panel).
 *
 * Two codes have authored copy — `SCHEDULE_OUTSIDE_COMPETITION` and
 * `SCHEDULE_COURT_STILL_IN_USE`. Everything else still shows the server's own
 * message: a localized guess at copy that does not exist would read worse
 * than an accurate English sentence, and `generic` is reserved for a throw
 * that is not an `Error` at all.
 */
export function settingsErrorText(err: unknown, locale: Locale, generic: string): string {
  if (err instanceof ApiV1Error) {
    if (err.code === SCHEDULE_COURT_STILL_IN_USE) {
      return courtStillInUseErrorMessage(locale, err.code, err.extra, err.message);
    }
    return scheduleWindowErrorMessage(locale, err.code, err.extra, err.message);
  }
  return err instanceof Error ? err.message : generic;
}
