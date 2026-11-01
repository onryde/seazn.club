// The Legs field of a division's format: how many times each pair meets in a league or group stage. ONE control for
// both forms that set it — the division builder's Format tab and the Settings Format group — so the two cannot offer
// different values again (Match Day D1). Owner ruling 2026-10-31: 1 or 2 only, named "Once" and "Home & away".
//
// Two options read better as a pair of buttons than as a select: both choices are visible at once and each is a 44px
// target. The options are FORMAT_BOUNDS.legs, never a list typed here.
//
// A stored value the bounds no longer admit (a division saved with 3 legs before the ruling) is SHOWN, not clamped:
// neither option is selected, a note says what is saved, and the value stays as it is until the organiser picks one.
import { useMsg } from "@/components/i18n/dict-provider";
import { FORMAT_BOUNDS, withinFormatBounds } from "@/lib/format-bounds";
import type { MessageKey } from "@/lib/messages";

/** Each legs value by its owner-ruled name. */
const LEGS_LABEL: Readonly<Record<number, MessageKey>> = {
  1: "wizard.legsSingle",
  2: "wizard.legsHomeAway",
};

/** The legs values both forms offer: every whole number in FORMAT_BOUNDS.legs, each with its label. A value the bounds
 *  admit that no label names is refused here, loudly, rather than shown as a bare number. `bounds` is there for the test
 *  that reaches that refusal; the forms never pass it. */
export function legsChoices(
  bounds: Readonly<{ min: number; max: number }> = FORMAT_BOUNDS.legs,
): { value: number; labelKey: MessageKey }[] {
  const out: { value: number; labelKey: MessageKey }[] = [];
  for (let value = bounds.min; value <= bounds.max; value++) {
    const labelKey = LEGS_LABEL[value];
    if (!labelKey) throw new Error(`legs-choice: FORMAT_BOUNDS.legs admits ${value}, which has no label`);
    out.push({ value, labelKey });
  }
  return out;
}

export function LegsChoice({
  legend,
  legendClassName,
  value,
  onChange,
  disabled = false,
}: {
  legend: string;
  /** The form's own label style, so the field reads like its neighbours. */
  legendClassName: string;
  value: number;
  onChange: (legs: number) => void;
  disabled?: boolean;
}) {
  const msg = useMsg();
  return (
    <fieldset data-format-bound="legs" data-testid="legs-choice" disabled={disabled} className="min-w-0">
      <legend className={legendClassName}>{legend}</legend>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {legsChoices().map((choice) => {
          const checked = value === choice.value;
          return (
            <label
              key={choice.value}
              className={`flex min-h-11 items-center justify-center rounded-lg border px-3 py-2 text-center text-sm leading-tight transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-purple-300 ${
                checked
                  ? "border-purple-500 bg-purple-50 font-medium text-purple-800"
                  : "border-slate-200 bg-white text-slate-600"
              } ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:border-purple-200"}`}
            >
              <input
                type="radio"
                name="legs"
                value={choice.value}
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(choice.value)}
                className="sr-only"
              />
              {msg(choice.labelKey)}
            </label>
          );
        })}
      </div>
      {!withinFormatBounds("legs", value) && (
        <p className="mt-1.5 text-xs text-amber-800" data-testid="legs-choice-stored">
          {msg("format.legs.storedOutOfRange", { n: value })}
        </p>
      )}
    </fieldset>
  );
}
