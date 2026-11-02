"use client";

// Visibility as a segmented 3-way control (Match Day C8, the New competition
// form): Private | Link only | Public, with the selected option's consequence
// printed directly underneath. The labels and the consequences are the SAME
// keys the settings radio cards read (`VISIBILITY_OPTIONS`), so the wording has
// one home.
//
// Each segment WRAPS its radio (visually hidden, still focusable), so a click on
// the label picks it, arrow keys walk the group natively, and the radio's
// accessible name is the label alone.
//
// The group is a <fieldset> with a <legend> over three native radios of one
// name: that IS a radio group to assistive tech (the browser exposes it as
// `radiogroup`-equivalent with the legend as its name), so it carries no ARIA
// role of its own. A `role="radiogroup"` + `role="radio"` rebuild would only add
// what the platform already gives, and lose the native arrow-key walk.
import { Globe, Link2, Lock, type LucideIcon } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { VISIBILITY_OPTIONS, type VisibilityKey } from "@/components/ui/visibility-picker";

const ICON: Record<VisibilityKey, LucideIcon> = {
  private: Lock,
  unlisted: Link2,
  public: Globe,
};

export function VisibilitySegmented({
  value,
  onChange,
}: {
  value: VisibilityKey | string;
  onChange: (next: VisibilityKey) => void;
}) {
  const msg = useMsg();
  const selected = VISIBILITY_OPTIONS.find((o) => o.value === value);
  const SelectedIcon = selected ? ICON[selected.value] : null;
  return (
    // min-w-0: a fieldset's UA default is min-inline-size:min-content, which
    // bursts out of a narrow card instead of shrinking.
    <fieldset className="min-w-0 [min-inline-size:0]">
      <legend className="label">{msg("visibility.legend")}</legend>
      <div className="grid grid-cols-3 gap-0.5 rounded-xl border border-purple-200 bg-purple-50 p-[3px]">
        {VISIBILITY_OPTIONS.map((opt) => {
          const active = opt.value === value;
          const Icon = ICON[opt.value];
          return (
            <label
              key={opt.value}
              className={`relative flex min-h-11 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[7px] px-1 text-[13px] font-medium transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 sm:px-2 sm:text-sm ${
                active
                  ? "bg-purple-600 text-white shadow-sm"
                  : "text-slate-700 hover:bg-white hover:text-purple-700"
              }`}
            >
              <input
                type="radio"
                name="visibility"
                value={opt.value}
                checked={active}
                onChange={() => onChange(opt.value)}
                className="sr-only"
              />
              {/* Hidden at the tightest widths: three words and three icons do
                  not fit a 320px card, and the word is the control. */}
              <Icon aria-hidden className="h-4 w-4 shrink-0 max-[359px]:hidden" strokeWidth={2} />
              {/* Wraps rather than truncating: "Lien uniquement" needs 104-126px and
                  the segment's text box is ~99px beside the icon in the lg column
                  (and ~78px at 320). A word cut by an ellipsis is a control nobody
                  can name; two short lines inside the 44px target are fine. */}
              <span className="min-w-0 break-words text-center leading-tight">{msg(opt.label)}</span>
            </label>
          );
        })}
      </div>
      {selected && SelectedIcon && (
        <p
          data-testid="visibility-consequence"
          aria-live="polite"
          className="mt-2.5 flex min-h-5 items-start gap-2 text-sm leading-snug text-slate-600"
        >
          <SelectedIcon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-purple-700" strokeWidth={2} />
          <span>{msg(selected.consequence)}</span>
        </p>
      )}
    </fieldset>
  );
}
