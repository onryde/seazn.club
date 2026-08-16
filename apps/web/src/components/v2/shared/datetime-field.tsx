"use client";

import { timeOptions } from "./time-options";
import { DateTimeSplitField } from "./datetime-split-field";

/**
 * The one native date/time control. Six call sites hand-rolled
 * `<label className="block"><span className="label">…</span><input type="date" …
 * className="input w-full" /></label>`; Prompts 02-04 convert them onto this.
 *
 * `kind="date"` is still a native `<input type="date">` — Chrome's calendar
 * popup is already correct and a custom one buys nothing here (design
 * decision 1, see the quarter-hour-time-select design doc). `kind="time"` and
 * `kind="datetime-local"` are NOT native clock inputs any more: Chrome's
 * picker *popup* ignores `step` even though its validity engine honours it
 * (measured, Chrome 151), so quarter-hour granularity existed for the
 * keyboard and not the mouse. Owning the option list is the only way to bound
 * what can be picked — `kind="time"` renders a `<select>` built from
 * `timeOptions()` (time-options.ts, every rule lives there), and
 * `kind="datetime-local"` delegates to `DateTimeSplitField`, which pairs a
 * native date input with that same select.
 *
 * `label` is a rendered string, not a message key — every caller passes
 * `msg("…")`, which keeps the copy in the four dictionaries where it already
 * lives and keeps this component free of a `DictProvider` dependency.
 *
 * Deliberately hookless: apps/web has no jsdom, so a component with no hooks
 * can be called directly in a test and its element tree walked (see the
 * sibling test). Adding a hook here — `useId` was the near miss — costs that.
 * Association is implicit instead, via the wrapping `<label>`, which is also
 * exactly what the division wizard does today. `DateTimeSplitField` is the
 * one place a hook lives now (it owns the half-filled pair's state); this
 * component only ever returns an element for it, never calls it, so nothing
 * here invokes a hook itself.
 */
export interface DateTimeFieldProps {
  kind: "date" | "time" | "datetime-local";
  value: string;
  onChange: (value: string) => void;
  label: string;
  min?: string;
  /**
   * Upper bound, `kind="date"` and the date half of `kind="datetime-local"`
   * only — never the time `<select>` (see `DateTimeSplitField`). The bound the
   * competition window needs: a division's schedule may not run past the
   * competition's last day, which the server already rejects with a 422, and
   * the picker should say so before the save rather than after it.
   */
  max?: string;
  disabled?: boolean;
  /**
   * Announce the field as compulsory to assistive tech. This does NOT set the
   * native `required` attribute, and the component owns that policy so no call
   * site has to rediscover it — see the render below.
   */
  required?: boolean;
  /**
   * Hide the label VISUALLY only, for a field that already sits under a
   * `<legend>` or heading saying the same thing — a second visible line there
   * is duplication, and the extra `.label` row (16px + 4px margin) is what
   * knocks a `sm:grid-cols-2` row's inputs off a shared baseline with the
   * plain field beside them.
   *
   * The label element is ALWAYS rendered and only ever hidden, never dropped:
   * it is this control's entire accessible name, since the component takes no
   * `id` and relies on implicit association through the wrapping `<label>`.
   * Dropping it would leave the input unnamed.
   *
   * This is strictly better than the bare `aria-label` such call sites carried
   * before converting — a real wrapping `<label>` is what makes implicit
   * association hold and Playwright's `getByLabel` resolve; `aria-label` on a
   * naked input gives neither.
   */
  labelHidden?: boolean;
  /**
   * Granularity of the generated option list, in SECONDS. Defaults to
   * {@link TIME_STEP_SECONDS} so `kind="time"` offers 9:00 / 9:15 / 9:30 …
   *
   *  - **Never applied for `kind="date"`.** Dates are not stepped — the
   *    native calendar's own one-day granularity is correct and stays.
   *  - **No longer a DOM attribute.** It used to be `step={900}` on the
   *    native clock input, which Chrome's picker *popup* ignored (the popup
   *    is browser UI, not DOM). It now drives `timeOptions()` — the list the
   *    `<select>` actually offers — so what the keyboard could already do is
   *    now also what the mouse can do.
   *
   * `step` constrains the OFFERED list, not this component's state: a value
   * already stored off the grid still renders (`timeOptions` always injects
   * the current value, sorted into place) and still round-trips.
   */
  step?: number;
  /**
   * Explicit option list for `kind="time"`, overriding the generated stepped
   * list — the board-slot call sites (a division's fixtures do not sit on a
   * quarter-hour grid once `matchMinutes` isn't a multiple of 15).
   */
  options?: string[];
  /**
   * Appended to the option list verbatim, deduped — the registration
   * deadlines pass `["23:59"]`, since a cutoff is not a slot and the
   * quarter-hour grid tops out at `23:45`.
   */
  extraOptions?: string[];
  /**
   * `aria-label` for the `<select>`, INTERNAL to this module: only
   * `DateTimeSplitField` passes it, for the time half of a datetime-local
   * pair. That half's wrapping `<label>` still carries the composite field's
   * own label text (hidden), which is what names the DATE half; without a
   * distinct name here the time `<select>` would read as the identical
   * "Start date & time" a screen reader already heard on the date input right
   * before it. Not part of the public 14-call-site contract — a bare
   * `kind="time"` field already gets a real, distinct label via `label`.
   */
  selectAriaLabel?: string;
}

/**
 * Quarter-hour granularity, in seconds. Exported so the few native time
 * inputs that cannot use this component yet — `ai-wish-chips`, `move-panel`,
 * `stages-panel`, `registration-settings`, `ai-officials-review` — step by
 * the same number instead of each re-typing 900. Re-exported from
 * `time-options.ts`, the single source of truth for this value, rather than
 * hand-typed again here.
 */
export { TIME_STEP_SECONDS } from "./time-options";

export function DateTimeField({
  kind,
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
  selectAriaLabel,
}: DateTimeFieldProps) {
  if (kind === "datetime-local") {
    return (
      <DateTimeSplitField
        value={value}
        onChange={onChange}
        label={label}
        min={min}
        max={max}
        disabled={disabled}
        required={required}
        labelHidden={labelHidden}
        step={step}
        options={options}
        extraOptions={extraOptions}
      />
    );
  }

  if (kind === "time") {
    const opts = timeOptions({
      value,
      options,
      stepSeconds: step,
      extraOptions,
      minTime: min ?? null,
    });
    return (
      <label className="block">
        {/* `sr-only` is a visual utility, never a removal — see `labelHidden`. */}
        <span className={labelHidden ? "label sr-only" : "label"}>{label}</span>
        <select
          className="input w-full text-base"
          value={value}
          disabled={disabled}
          aria-required={required ? "true" : undefined}
          aria-label={selectAriaLabel}
          onChange={(e) => onChange(e.target.value)}
        >
          {/* "No time" — how the datetime-local pair clears one half. Never
              disabled: it has to stay pickable to clear a value back out. */}
          <option value="">{"--:--"}</option>
          {opts.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="block">
      {/* `sr-only` is a visual utility, never a removal — see `labelHidden`. */}
      <span className={labelHidden ? "label sr-only" : "label"}>{label}</span>
      <input
        type={kind}
        // `text-base` only. The plan asked for `text-base sm:text-sm` as an iOS
        // zoom-on-focus block, but globals.css Pattern 5 already forces 16px on
        // every form control under 40rem — measured identical at 375px with and
        // without it. All `sm:text-sm` did was shrink this to 14px/38px on
        // desktop beside `.input` siblings at 16px/42px, breaking the "styled
        // identically to the division wizard" criterion this component exists
        // to satisfy. Dropped; `text-base` matches `.input` and is a no-op.
        className="input w-full text-base"
        value={value}
        min={min}
        // `kind` is always "date" here, so this is a day bound — never a
        // time-of-day one. The `kind="time"` branch above takes no `max` at
        // all: `timeOptions()` has a `minTime` filter and no `maxTime`, and a
        // ceiling on the last day's clock is a different rule from the
        // whole-day one the server enforces.
        max={max}
        // `kind` here is always "date" (the other two branches return above),
        // and a date input measures `step` in DAYS — so it is never set. The
        // (now removed) `step={900}` regression is pinned in the sibling test.
        disabled={disabled}
        // ARIA only, deliberately never the native `required` attribute (#376):
        // the native one fires the browser's OWN English validation tooltip,
        // which preempts the localized message the form shows instead. So a
        // required date/time field gets the screen-reader signal without the
        // tooltip, by construction rather than by every caller remembering.
        aria-required={required ? "true" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
