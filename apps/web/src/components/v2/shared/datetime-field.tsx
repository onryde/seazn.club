"use client";

/**
 * The one native date/time control. Six call sites hand-rolled
 * `<label className="block"><span className="label">…</span><input type="date" …
 * className="input w-full" /></label>`; Prompts 02-04 convert them onto this.
 *
 * Native inputs on purpose (design decision 1): `<input type="time">` cannot
 * shade a blacked-out range inline no matter how it is wrapped, so a custom
 * picker buys nothing that is in scope.
 *
 * `label` is a rendered string, not a message key — every caller passes
 * `msg("…")`, which keeps the copy in the four dictionaries where it already
 * lives and keeps this component free of a `DictProvider` dependency.
 *
 * Deliberately hookless: apps/web has no jsdom, so a component with no hooks
 * can be called directly in a test and its element tree walked (see the
 * sibling test). Adding a hook here — `useId` was the near miss — costs that.
 * Association is implicit instead, via the wrapping `<label>`, which is also
 * exactly what the division wizard does today.
 */
export interface DateTimeFieldProps {
  kind: "date" | "time" | "datetime-local";
  value: string;
  onChange: (value: string) => void;
  label: string;
  min?: string;
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
   * Granularity of the native picker and spinner, in SECONDS. Defaults to
   * {@link TIME_STEP_SECONDS} so every control offers 9:00 / 9:15 / 9:30 …
   *
   * Two spec details this default hides from the call sites:
   *
   *  - **Never defaulted for `kind="date"`.** On a date input `step` counts
   *    DAYS, so the same 900 would mean "one selectable date every 900 days"
   *    and reject every value the organiser can reach. `undefined` there
   *    leaves the native one-day default.
   *  - The step BASE is `min` when `min` is set, else midnight (`time`) or
   *    1970-01-01T00:00 (`datetime-local`). With no `min` that lands the
   *    offered values on :00/:15/:30/:45; with one it makes them relative to
   *    `min`, which is what the blackout `to` field wants — 15-minute steps
   *    measured from `from`.
   *
   * `step` constrains the picker, not this component's state: a value already
   * stored off the quarter-hour still renders and still round-trips.
   */
  step?: number;
}

/**
 * Quarter-hour granularity, in seconds. Exported so the few native time
 * inputs that cannot use this component — `ai-wish-chips`, `move-panel`,
 * `stages-panel`, `registration-settings`, `ai-officials-review` — step by
 * the same number instead of each re-typing 900.
 */
export const TIME_STEP_SECONDS = 900;

export function DateTimeField({
  kind,
  value,
  onChange,
  label,
  min,
  disabled,
  required,
  labelHidden,
  step,
}: DateTimeFieldProps) {
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
        // See the `step` prop. `kind === "date"` is the load-bearing half of
        // this expression: a date input measures `step` in days.
        step={step ?? (kind === "date" ? undefined : TIME_STEP_SECONDS)}
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
