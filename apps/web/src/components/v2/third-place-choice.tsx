"use client";
// W4 app B, Task 10 (X-TP-2 UI half, X-TP-1; owner pick 1A): "Third place: Shared | Play-off match", ONE two-segment control for
// the division builder, the Format dialog and the stage settings. House look (the Legs choice's segments: purple edge on the
// picked one), phone-first: two equal 44px segments side by side down to 320, the one-line reason under them.
//
// Below four entrants the Play-off segment is DISABLED, never hidden (pick 1A, superseding the plan's "hidden"): the organiser sees
// that the option exists and what unlocks it. A stored Play-off the field can no longer play reads as Shared (the server refuses the
// other). `readOnly` is the stage settings once the stage started: both segments are inert and the lock's own sentence says why.
import { useId } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { ThirdPlaceMode } from "@/lib/third-place";

export function ThirdPlaceChoice({
  value,
  onChange,
  offer,
  readOnlyReason,
  busy = false,
  testId = "third-place-choice",
  storedView = false,
}: {
  value: ThirdPlaceMode;
  onChange: (mode: ThirdPlaceMode) => void;
  /** X-TP-1: whether the Play-off is on offer for the field (`thirdPlaceOffer`). */
  offer: { offered: boolean; entrants: number | null };
  /** Set once the stage has started (X-TP-6): the control is read-only and this sentence says why. */
  readOnlyReason?: string | null;
  busy?: boolean;
  testId?: string;
  /** B4 I-2: the stage settings show what is STORED. A stored Play-off the field can no longer play stays picked (disabled), says
   *  the count, and offers "Use Shared" (pick 7A); the builder keeps reading it as Shared, since it SENDS Shared there. */
  storedView?: boolean;
}) {
  const msg = useMsg();
  const name = useId();
  const readOnly = readOnlyReason != null;
  const stuckPlayoff = storedView && !offer.offered && value === "playoff";
  const shown: ThirdPlaceMode = !offer.offered && value === "playoff" && !storedView ? "shared" : value;
  const modes: { mode: ThirdPlaceMode; label: string; off: boolean }[] = [
    { mode: "shared", label: msg("thirdPlace.shared"), off: false },
    { mode: "playoff", label: msg("thirdPlace.playoff"), off: !offer.offered },
  ];
  const reasonId = `${name}-reason`;
  return (
    <fieldset data-testid={testId} data-third-place={shown} data-read-only={readOnly ? "" : undefined} disabled={readOnly || busy} className="min-w-0" aria-describedby={reasonId}>
      <legend className="label">{msg("thirdPlace.label")}</legend>
      <div className="mt-1 grid grid-cols-2 gap-2">
        {modes.map(({ mode, label, off }) => {
          const checked = shown === mode;
          const inert = off || readOnly;
          return (
            <label
              key={mode}
              data-third-place-option={mode}
              aria-disabled={inert ? "true" : undefined}
              className={`flex min-h-11 min-w-0 items-center justify-center rounded-lg border px-3 py-2 text-center text-sm leading-tight transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-purple-300 ${
                checked
                  ? "border-purple-500 bg-purple-50 font-medium text-purple-800"
                  : off
                    ? "border-dashed border-slate-300 bg-slate-50 text-slate-500"
                    : "border-slate-200 bg-white text-slate-600"
              } ${inert ? "cursor-not-allowed" : "cursor-pointer hover:border-purple-200"} ${readOnly && !checked ? "opacity-60" : ""}`}
            >
              <input
                type="radio"
                name={name}
                value={mode}
                checked={checked}
                disabled={inert || busy}
                onChange={() => onChange(mode)}
                className="sr-only"
              />
              {label}
            </label>
          );
        })}
      </div>
      <p id={reasonId} data-testid={`${testId}-note`} className={`mt-1.5 text-xs ${!offer.offered || readOnly ? "text-amber-800" : "text-slate-500"}`}>
        {readOnly
          ? readOnlyReason
          : stuckPlayoff && offer.entrants !== null
            ? msg("thirdPlace.tooFewCount", { count: offer.entrants })
            : !offer.offered
              ? msg("thirdPlace.hiddenBelow4")
              : msg(shown === "playoff" ? "thirdPlace.playoffHint" : "thirdPlace.sharedHint")}
      </p>
      {stuckPlayoff && !readOnly && (
        <button type="button" data-testid={`${testId}-use-shared`} disabled={busy} onClick={() => onChange("shared")} className="btn btn-ghost mt-2 min-h-11 px-3 py-1.5 text-sm">
          {msg("thirdPlace.useShared")}
        </button>
      )}
    </fieldset>
  );
}
