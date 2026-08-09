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
}

export function DateTimeField({ kind, value, onChange, label, min, disabled }: DateTimeFieldProps) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        type={kind}
        // `text-base` under `sm` is the iOS zoom-on-focus block. globals.css
        // Pattern 5 already forces 16px on every form control at that width;
        // this states it locally so the rule survives a caller that overrides.
        className="input w-full text-base sm:text-sm"
        value={value}
        min={min}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
