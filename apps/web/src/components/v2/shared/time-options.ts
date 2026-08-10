/**
 * The list of times a clock control offers, and the rules that build it.
 *
 * WHY THIS EXISTS. `<input type="time" step="900">` does not produce a
 * quarter-hour picker. Measured in Chrome 151 on a real page: the browser
 * honours `step` in its validity engine (`stepUp()` 09:00 → 09:15, and 09:34
 * reports `validity.stepMismatch`) while its picker popup renders a full 0-59
 * minute column regardless. The popup is browser UI, not DOM, so no attribute
 * we can write reaches it — the granularity existed for the keyboard and not
 * for the mouse, and a mouse-picked `:34` saved as an invalid value nothing
 * checked. Owning the option list is the only way to bound what can be picked.
 *
 * Pure and React-free on purpose. `apps/web` is vitest `environment: "node"`
 * with no jsdom, so anything living inside a component can only be tested
 * through rendered markup; every rule with a decision in it lives here instead
 * and is tested directly.
 *
 * ALL TIMES HERE ARE WALL CLOCK ("HH:MM", 24-hour) — the same lane
 * `<input type="time">` values live in. The one instant this module reads
 * (`startAt`) is converted at the boundary by the caller, through
 * `zoned-datetime` on the ORG zone (#448). Nothing here parses a date, so
 * nothing here can silently re-zone one.
 */

/** Minutes in a day. A time is a minute offset into this, everywhere below. */
const MINUTES_PER_DAY = 24 * 60;

/** Quarter-hour granularity in seconds — what `DateTimeField.step` defaults to,
 *  kept in the units the (now removed) DOM attribute used so call sites that
 *  already pass `TIME_STEP_SECONDS` read unchanged. */
export const TIME_STEP_SECONDS = 900;

/**
 * The cap on a generated list. `matchMinutes: 1` with no play hours would
 * otherwise be a 1,440-entry dropdown — technically correct and unusable. The
 * cap truncates rather than falling back, so a long day still offers its
 * earliest slots rather than silently reverting to quarter hours that do not
 * exist on that board.
 */
export const MAX_OPTIONS = 200;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" → minutes into the day, or null when it is not a time. */
export function minutesOfDay(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes into the day → "HH:MM". Days do not wrap: a caller that walks past
 *  midnight has left the day it was enumerating and must stop, not roll over
 *  onto times that belong to tomorrow. */
export function hhmmOfMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

/**
 * Every time on a fixed step through the day, from midnight.
 *
 * The default list, and the fallback for everything else. `stepSeconds` is the
 * component's `step` prop so the two stay in one unit; a step that is not a
 * whole number of minutes, or does not divide the day, still produces a usable
 * list — it just does not land on the hour.
 */
export function steppedTimes(stepSeconds: number = TIME_STEP_SECONDS): string[] {
  const stepMinutes = Math.max(1, Math.round(stepSeconds / 60));
  const out: string[] = [];
  for (let m = 0; m < MINUTES_PER_DAY && out.length < MAX_OPTIONS; m += stepMinutes) {
    out.push(hhmmOfMinutes(m));
  }
  return out;
}

/** The 96 quarter hours, `00:00` … `23:45`. */
export const quarterHours = (): string[] => steppedTimes(TIME_STEP_SECONDS);

/**
 * What a division's board actually offers, as wall-clock times.
 *
 * A board is laid out from `startAt` in steps of `matchMinutes + gapMinutes`,
 * so on a 40/0 division the slots are 09:00, 09:40, 10:20 — and a quarter-hour
 * list cannot express any of them past the first. Offering quarter hours on
 * such a board is not a smaller bug than offering every minute: nudging a
 * fixture would move it onto :45, off the grid every other match sits on.
 *
 * NOT THE PLACER'S TRUTH, deliberately. `slotFixtures` (engine
 * `scheduling/calendar.ts`) places greedily and can legitimately start a match
 * at the trailing edge of a blackout or a neighbouring booking, which is not on
 * this grid at all. This is the canonical grid an organiser reasons in; the
 * server still accepts any instant on the fixture PATCH, and the verifier
 * remains the authority on whether a placement is legal. Treating this list as
 * a constraint rather than an affordance would be the placer/verifier fork this
 * repo keeps re-deriving.
 */
export interface BoardSlotConfig {
  /** `startAt` as the org zone's wall clock ("HH:MM") — converted by the caller
   *  through `zoned-datetime`, never here. */
  anchor: string;
  matchMinutes: number;
  gapMinutes: number;
  /** Play hours, when the division bounds them. `to` is the last instant a
   *  match may still be RUNNING, so a slot needs `start + matchMinutes <= to`. */
  playFrom?: string;
  playTo?: string;
}

export function boardSlotTimes(config: BoardSlotConfig): string[] {
  const { matchMinutes, gapMinutes } = config;
  const stride = Math.round(matchMinutes + gapMinutes);
  if (!Number.isFinite(stride) || stride <= 0 || !Number.isFinite(matchMinutes) || matchMinutes <= 0) {
    return [];
  }
  const anchor = minutesOfDay(config.anchor);
  const from = config.playFrom !== undefined ? minutesOfDay(config.playFrom) : null;
  const to = config.playTo !== undefined ? minutesOfDay(config.playTo) : null;
  // Play hours win over the anchor when both exist: the anchor is where the
  // board happens to have started, the window is where play is ALLOWED. An
  // anchor before the window would otherwise offer slots nobody may use.
  const start = from ?? anchor ?? 0;
  const end = to ?? MINUTES_PER_DAY;
  const out: string[] = [];
  for (let m = start; m + matchMinutes <= end && out.length < MAX_OPTIONS; m += stride) {
    out.push(hhmmOfMinutes(m));
  }
  return out;
}

/**
 * Same-day options at or after `min`.
 *
 * `min` is a whole `datetime-local`/`date` bound, so the filter only applies on
 * the day it names: a later day keeps the full list. Two live callers — the End
 * date bounded by the start, and a blackout's `to` bounded by its `from`. The
 * server guard (`ScheduleConfig`, `19fdac2d`) stays the backstop; this only
 * stops us offering what it will reject.
 */
export function filterByMin(times: readonly string[], minTime: string | null): string[] {
  if (minTime === null) return [...times];
  const floor = minutesOfDay(minTime);
  if (floor === null) return [...times];
  return times.filter((t) => {
    const m = minutesOfDay(t);
    return m === null || m >= floor;
  });
}

export interface TimeOptionsInput {
  /** The control's current value ("HH:MM"), or "" when unset. */
  value: string;
  /** Explicit list, overriding generation — the board-slot call sites. */
  options?: readonly string[];
  /** Step for the generated list, in seconds. */
  stepSeconds?: number;
  /** Appended verbatim: the registration deadlines pass `["23:59"]`, since a
   *  cutoff is not a slot and `23:45` silently refuses a quarter hour of
   *  entries. */
  extraOptions?: readonly string[];
  /** Same-day lower bound ("HH:MM"), already resolved by the caller — null when
   *  `min` names a different day, so no filtering applies. */
  minTime?: string | null;
}

/**
 * The final option list, in order.
 *
 * Rules, in order: explicit `options` (or a generated stepped list) → `min`
 * filter → `extraOptions` → dedupe → sort.
 *
 * THE CURRENT VALUE OUTRANKS ALL OF THEM. A `<select>` whose `value` matches no
 * `<option>` renders BLANK, so an off-grid time would look like the time had
 * vanished from the field and saving would then write empty — silent data loss,
 * and it fires without any stored history: place fixtures at 09:40 on a 40/0
 * board, change match length to 30, reopen the fixture. So the value is always
 * injected, sorted into place.
 *
 * The `min` filter deliberately runs BEFORE injection: a value below `min` is a
 * state the organiser can already be in (a stored blackout whose `from` was
 * later moved past its `to`), and blanking their own field is worse than
 * showing the illegal value the server will refuse to store.
 */
export function timeOptions(input: TimeOptionsInput): string[] {
  const base = input.options !== undefined ? [...input.options] : steppedTimes(input.stepSeconds);
  const bounded = filterByMin(base, input.minTime ?? null);
  const withExtras = [...bounded, ...(input.extraOptions ?? [])];
  if (input.value !== "" && minutesOfDay(input.value) !== null) withExtras.push(input.value);
  const seen = new Set<string>();
  const unique = withExtras.filter((t) => {
    if (minutesOfDay(t) === null || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  return unique.sort((a, b) => (minutesOfDay(a) ?? 0) - (minutesOfDay(b) ?? 0));
}

// ---------------------------------------------------------------------------
// The datetime-local pair
// ---------------------------------------------------------------------------

/** A `datetime-local` value split into the two controls that now render it.
 *  Either half may be "" — that state is unreachable through a native input and
 *  is exactly what the split creates. */
export interface DateTimeHalves {
  date: string;
  time: string;
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Split a `datetime-local` value. Anything unparseable splits to two blanks
 *  rather than throwing: these values come out of stored config the panels
 *  never re-validate, and a field the organiser cannot clear is worse than an
 *  empty one. */
export function splitValue(value: string): DateTimeHalves {
  const parts = DATE_TIME.exec(value);
  if (parts !== null) return { date: parts[1]!, time: parts[2]! };
  return YMD.test(value) ? { date: value, time: "" } : { date: "", time: "" };
}

/**
 * Join the halves back into what every caller already expects.
 *
 * A half-filled pair emits "" — NOT a partial string. Callers hand this value
 * to `new Date(...)` and to API payloads; "2026-10-12T" would parse as an
 * Invalid Date and throw at `.toISOString()`, turning a half-typed field into a
 * white screen. Blank is the state they all already handle.
 */
export function joinValue(date: string, time: string): string {
  if (!YMD.test(date) || minutesOfDay(time) === null) return "";
  return `${date}T${time}`;
}
