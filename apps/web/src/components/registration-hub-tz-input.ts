// Registration hub config panel — org-timezone datetime-local conversion
// (RS004 W3c, owner decision 1: registration windows are edited and
// displayed in the ORG timezone, with the zone labelled — never
// browser-local, never resolveVenueTz's venue lane).
//
// A `<input type="datetime-local">` always reads/writes a bare
// "YYYY-MM-DDTHH:MM" wall-clock string with no zone of its own. Left alone,
// the browser treats that string as the VISITOR's local time when it renders
// or parses it — wrong here, since the organiser is setting a window for the
// competition in the org's chosen zone, which is very often not the zone the
// organiser happens to be sitting in.
//
// Same fixpoint-over-Intl technique as @seazn/engine/scheduling/tz's
// zonedTimeToUtc (that module's own comment records it verified against all
// 418 IANA zones over 400 consecutive days) — reimplemented locally rather
// than imported: this file is apps/web UI code and this task does not own
// packages/engine, so it does not reach across that boundary for ten lines
// of pure Intl arithmetic.
//
// RS005 R4 task 2 — the half-filled clock bug. This panel's clock fields
// don't actually render a native `<input type="datetime-local">` (that
// would make `input.validity.badInput` the natural detector, per the R4
// dispatch's own framing) — DateTimeField/DateTimeSplitField
// (v2/shared/datetime-field.tsx) already split every `kind="datetime-local"`
// into a separate native date input and a time `<select>`, and THEIR OWN
// `joinValue` (v2/shared/time-options.ts) deliberately collapses a
// half-filled pair to `""` before this module ever sees it — the exact same
// `""` a fully-cleared pair also produces, and once collapsed the two are
// indistinguishable. `orgTzInputValueToInstant("")` returning null is
// therefore correct for THAT string; the bug is that "date typed, time
// blank" and "both blank" reach it as the identical string.
//
// So the fix lives one layer up, where the two halves are still separately
// known: `editOrgTzDateTimeHalf` below tracks {date, time} directly (reusing
// DateTimeSplitField's own splitValue/joinValue, not reimplementing them)
// and reports `incomplete: true` — never a silently-nulled instant — the
// moment exactly one half is filled. The config panel (registration-hub-
// config-panel.tsx) owns the {date, time} draft as lifted state and renders
// the two native halves itself via `OrgTzDateTimePair`, rather than going
// through DateTimeSplitField, specifically so this incompleteness is
// visible to it at all.
import {
  joinValue,
  splitValue,
  type DateTimeHalves,
} from "@/components/v2/shared/time-options";

export type { DateTimeHalves } from "@/components/v2/shared/time-options";

/** An ISO instant (or Date) -> the wall-clock value a `datetime-local` input
 *  should show, as seen in `tz`. Empty string for null/unparseable input —
 *  never "Invalid Date" leaking into the DOM. */
export function instantToOrgTzInputValue(instant: string | Date | null, tz: string): string {
  if (instant == null) return "";
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (Number.isNaN(ms)) return "";
  return `${dayKeyInTz(ms, tz)}T${hhmmInTz(ms, tz)}`;
}

/** The reverse: a `datetime-local` input's wall-clock value, interpreted in
 *  `tz` -> a UTC ISO instant. Empty string -> null (the field was cleared). */
export function orgTzInputValueToInstant(value: string, tz: string): string | null {
  if (!value) return null;
  const [ymd, hhmm] = value.split("T");
  if (!ymd || !hhmm) return null;
  const ms = zonedTimeToUtcMs(ymd, hhmm.slice(0, 5), tz);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** The calendar day an instant falls on, in `tz`. `en-CA` formats YYYY-MM-DD. */
function dayKeyInTz(instantMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/** The wall-clock time of an instant, in `tz`, zero-padded 24h. The `^24`
 *  guard mirrors the engine module's: `hour12: false` can render midnight as
 *  "24:00" on some ICU builds, which would sort after every other time. */
function hhmmInTz(instantMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(instantMs))
    .replace(/^24/, "00");
}

/** Wall clock `(ymd, hh:mm)` in `tz` -> UTC epoch ms. Two correction passes:
 *  the first lands within the offset error, the second fixes the case where
 *  that correction itself crossed a DST boundary. */
function zonedTimeToUtcMs(ymd: string, hhmm: string, tz: string): number {
  const target = Date.parse(`${ymd}T${hhmm}:00Z`);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const wall = Date.parse(`${dayKeyInTz(guess, tz)}T${hhmmInTz(guess, tz)}:00Z`);
    if (wall === target) break;
    guess += target - wall;
  }
  return guess;
}

// ---------------------------------------------------------------------------
// Half-filled detection (RS004 R4 task 2)
// ---------------------------------------------------------------------------

/** An instant (or null) -> the two-part wall-clock value the config panel's
 *  own date/time pair should show, in `tz`. Empty halves for null/unparseable
 *  input, same as `instantToOrgTzInputValue` — never "Invalid Date" leaking
 *  into either half. */
export function orgTzDateTimeHalves(instant: string | Date | null, tz: string): DateTimeHalves {
  return splitValue(instantToOrgTzInputValue(instant, tz));
}

/** True when EXACTLY ONE half is filled — the state a native `datetime-local`
 *  input can never produce (it is a single control) and this split pair
 *  can: a date picked with the time left at "--:--", or vice versa. Both
 *  halves empty is a deliberate, complete clear, not this. */
export function isDateTimeHalvesIncomplete(halves: DateTimeHalves): boolean {
  return (halves.date === "") !== (halves.time === "");
}

/** Result of typing into one half of the pair. `instant` is only meaningful
 *  when `incomplete` is false — the caller (registration-hub-config-panel.tsx)
 *  must not write it into RegistrationConfigState while incomplete is true,
 *  which is the entire fix: the state a save reads from never silently
 *  becomes "unset" just because the other half hasn't been typed yet. */
export interface DateTimeHalfEditResult {
  halves: DateTimeHalves;
  incomplete: boolean;
  instant: string | null;
}

/** Apply one half's new value (from the date input or the time select) to
 *  the pair's current halves, and resolve what that means for the instant:
 *  both filled -> a real instant (via `orgTzInputValueToInstant`, unchanged
 *  semantics); both empty -> null (an explicit, complete clear); exactly one
 *  filled -> `incomplete: true`, `instant` unusable. */
export function editOrgTzDateTimeHalf(
  current: DateTimeHalves,
  half: "date" | "time",
  value: string,
  tz: string,
): DateTimeHalfEditResult {
  const halves = half === "date" ? { date: value, time: current.time } : { date: current.date, time: value };
  const incomplete = isDateTimeHalvesIncomplete(halves);
  const instant = incomplete ? null : orgTzInputValueToInstant(joinValue(halves.date, halves.time), tz);
  return { halves, incomplete, instant };
}
