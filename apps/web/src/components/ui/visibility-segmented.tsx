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
  capped,
  disabled = false,
}: {
  value: VisibilityKey | string;
  onChange: (next: VisibilityKey) => void;
  /**
   * The selected visibility will be created PRIVATE because no public slot is left (Match Day PB3 m5: the form's `cap`). The line
   * under the segments then stops promising the listing / the link / search engines and says what will really happen, in the lock's
   * icon. REQUIRED so a caller cannot quietly stop passing it (a literal `false` on the form would put the promise back).
   */
  capped: boolean;
  /** Read-only (competition settings: a viewer, or a competition frozen over quota). The choice still shows; nothing picks. */
  disabled?: boolean;
}) {
  const msg = useMsg();
  const selected = VISIBILITY_OPTIONS.find((o) => o.value === value);
  const SelectedIcon = selected ? (capped ? Lock : ICON[selected.value]) : null;
  return (
    // min-w-0: a fieldset's UA default is min-inline-size:min-content, which
    // bursts out of a narrow card instead of shrinking.
    <fieldset className="min-w-0 [min-inline-size:0]">
      <legend className="label">{msg("visibility.legend")}</legend>
      {/* Below `sm` the three columns are `auto`, not equal thirds: each starts at
          its label's own width and the space left over is shared out evenly, so
          the long label takes the width the short "Privé" and "Public" do not
          need. Equal thirds left French "uniquement" (~67px at 12px) 3px of a
          70px box at 320, and CI's Linux font paints it ~1px wider than that box;
          sized to content it has ~40px. From `sm` up: equal thirds, unchanged. */}
      <div className="grid grid-cols-3 gap-0.5 rounded-xl border border-purple-200 bg-purple-50 p-[3px] max-sm:grid-cols-[auto_auto_auto]">
        {VISIBILITY_OPTIONS.map((opt) => {
          const active = opt.value === value;
          const Icon = ICON[opt.value];
          return (
            <label
              key={opt.value}
              className={`relative flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-[7px] px-1 text-xs font-medium transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-purple-600 sm:px-2 sm:text-sm ${
                active
                  ? "bg-purple-600 text-white shadow-sm"
                  : disabled
                    ? "text-slate-500"
                    : "text-slate-700 hover:bg-white hover:text-purple-700"
              } ${disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
            >
              <input
                type="radio"
                name="visibility"
                value={opt.value}
                checked={active}
                disabled={disabled}
                onChange={() => onChange(opt.value)}
                className="sr-only"
              />
              {/* Hidden below `sm`: three icons and three words do not fit a phone
                  card, and the word is the control. */}
              <Icon aria-hidden className="h-4 w-4 shrink-0 max-sm:hidden" strokeWidth={2} />
              {/* Wraps at spaces only (`break-normal`, never `break-words`: that
                  splits "uniquement" into "uniquemen / t"), and never truncates.
                  The tightest label is French "Lien uniquement", whose longest
                  word is ~72px at 13px and ~67px at 12px, hence `text-xs` below
                  `sm`, where the content-sized columns above give it its whole
                  width on one line at 320. In the lg column (26.5rem = 424px) it is
                  ~99px beside the icon, and the label sits on two lines. A word cut
                  by an ellipsis or in the middle is a control nobody can name; two
                  short lines inside the 44px target are fine. The walkthrough
                  measures every word's line count in all four languages, and the
                  room each widest word has to spare (at least 6px). */}
              <span className="min-w-0 break-normal text-center leading-tight">{msg(opt.label)}</span>
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
          <span>{msg(capped ? "visibility.capped.consequence" : selected.consequence)}</span>
        </p>
      )}
    </fieldset>
  );
}
