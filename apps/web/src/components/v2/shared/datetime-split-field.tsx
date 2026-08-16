"use client";

/**
 * `kind="datetime-local"`, split in two: a native date input beside a native
 * `<select>` of times, joined back into the "YYYY-MM-DDTHH:MM" string every
 * caller already passes/receives. See
 * docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md
 * ("Half-filled state") for why this needs state at all.
 *
 * THE ONLY STATEFUL PIECE of the date/time UX. `DateTimeField` stays
 * hookless on purpose (see its own file); this component is what it renders
 * into for `kind="datetime-local"`, and it is the one place a real React
 * mount is required — its own test uses `renderToStaticMarkup`, not a direct
 * function call, because a `useState` component cannot be invoked as a plain
 * function outside React (see `_hook-harness.tsx`).
 *
 * WHY LOCAL STATE, NOT A DERIVED SPLIT OF `value` ON EVERY RENDER: `joinValue`
 * emits `""` for a half-filled pair (design: `splitValue`/`joinValue`'s own
 * doc), because `new Date("2026-10-12T")` is an Invalid Date that throws at
 * `.toISOString()` downstream. So the instant a user picks a date and leaves
 * the time blank, the value this component receives back as its OWN `value`
 * prop is `""` — and deriving `{date, time}` straight from that on every
 * render would erase the date half the user just picked, one keystroke after
 * they picked it. The pair therefore lives in `useState`, seeded once from
 * the incoming `value` and updated only by this component's own two
 * `onChange` handlers — never re-derived from props after mount. The accepted
 * consequence (also in the design doc): a `value` changed from OUTSIDE this
 * component after mount (a parent resetting the whole form to a different
 * record, for instance) will not be reflected here without remounting it —
 * the same "controlled component with an escape hatch" trade every half-typed
 * form field like this one makes.
 */
import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { DateTimeField, type DateTimeFieldProps } from "./datetime-field";
import { joinValue, splitValue } from "./time-options";

export interface DateTimeSplitFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** A `datetime-local` (or bare date) lower bound. Filtering only applies to
   *  the time half on the day it names — see `filterByMin` in time-options.ts;
   *  a different day keeps the full option list. */
  min?: string;
  /** An upper bound for the DATE half only — the time `<select>` is never
   *  constrained by it (time-options.ts has no `maxTime` filter, and the rule
   *  this exists for — a division inside its competition's window — compares
   *  whole days). A bare "YYYY-MM-DD" splits to `{date, time: ""}` just as
   *  `min` does. */
  max?: string;
  disabled?: boolean;
  required?: boolean;
  labelHidden?: boolean;
  step?: number;
  options?: string[];
  extraOptions?: string[];
}

export function DateTimeSplitField({
  value,
  onChange,
  label,
  min,
  max,
  disabled,
  required,
  labelHidden,
  step,
  options,
  extraOptions,
}: DateTimeSplitFieldProps) {
  // Seeded ONCE from the incoming value — see the file doc for why this is
  // never re-derived from `value` on a later render.
  const [halves, setHalves] = useState(() => splitValue(value));
  const msg = useMsg();

  const minHalves = min !== undefined && min !== "" ? splitValue(min) : null;
  // A bare "YYYY-MM-DD" `min` (no "T") splits to `{ date: min, time: "" }`
  // already, so this covers both a full datetime-local bound and a plain
  // date one with the same expression.
  const dateMin = minHalves !== null && minHalves.date !== "" ? minHalves.date : undefined;
  // Same-day floor only: a `min` naming a different day must not filter the
  // time list at all (the whole day is already excluded by `dateMin` on the
  // date half instead) — see time-options.ts `filterByMin`.
  const timeMin =
    minHalves !== null && minHalves.date !== "" && minHalves.date === halves.date && minHalves.time !== ""
      ? minHalves.time
      : undefined;

  function setDate(date: string): void {
    const next = { date, time: halves.time };
    setHalves(next);
    onChange(joinValue(next.date, next.time));
  }

  function setTime(time: string): void {
    const next = { date: halves.date, time };
    setHalves(next);
    onChange(joinValue(next.date, next.time));
  }

  // Same split as `dateMin`, and deliberately no `timeMax` twin — see the
  // `max` prop's own doc above.
  const maxHalves = max !== undefined && max !== "" ? splitValue(max) : null;
  const dateMax = maxHalves !== null && maxHalves.date !== "" ? maxHalves.date : undefined;

  const dateProps: DateTimeFieldProps = {
    kind: "date",
    value: halves.date,
    onChange: setDate,
    label,
    min: dateMin,
    max: dateMax,
    disabled,
    required,
    labelHidden,
  };

  const timeProps: DateTimeFieldProps = {
    kind: "time",
    value: halves.time,
    onChange: setTime,
    // The date half above already carries the composite field's real,
    // visible label — reusing it here (hidden) would give the select the
    // SAME accessible name as the date input right beside it. `selectAriaLabel`
    // overrides that with a distinct one ("Time", all 4 locales).
    label,
    labelHidden: true,
    selectAriaLabel: msg("datetime.timeLabel"),
    min: timeMin,
    disabled,
    required,
    step,
    options,
    extraOptions,
  };

  return (
    // A CONTAINER QUERY, deliberately not a viewport one. What decides whether
    // a date input and a time select fit on one row is how wide THIS FIELD is,
    // and that is not what the window is doing: the registrations sidebar is
    // pinned to 340px at `lg`, so a viewport rule reading "1280px, plenty of
    // room" put the pair side by side inside ~300px and clipped both halves to
    // `dd/r` and a bare chevron. Measured at 82px and 55px before this.
    //
    // Below 18rem of OWN width they stack; at or above it they sit side by
    // side. That covers 320px phones (the low end of the mobile.spec.ts
    // matrix) and every narrow column, present and future, without the call
    // site having to know it is narrow.
    <div className="@container">
      <div className="flex flex-col gap-2 @[18rem]:flex-row @[18rem]:items-end">
        <div className="min-w-0 flex-[3]">
          <DateTimeField {...dateProps} />
        </div>
        <div className="min-w-0 flex-[2]">
          <DateTimeField {...timeProps} />
        </div>
      </div>
    </div>
  );
}
