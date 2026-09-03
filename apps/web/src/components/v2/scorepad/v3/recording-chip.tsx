"use client";

// The Recording chip — W1 / Task 4 (entitlements v18, owner ruling
// 2026-08-30: scoring detail is free on every plan).
//
// WHAT CHANGED, AND WHY THE WHOLE FILE TURNED OVER. Until this task a
// fidelity band was a PRICE BOUNDARY: `SportModule.fidelityTiers` named a
// feature key per band, `PadSpec.fidelityEntitlements` published it, and this
// chip's job was to word the lock ("{band} — available on {plan}") without
// ever showing a bare padlock. Tasks 1-3 deleted that model outright. What
// survives is `PadSpec.fidelity` — one band per event type — and it is a UX
// FILTER, never a gate: it answers "how much does this scorer want to record
// right now", a question only the scorer can answer.
//
// So the chip is no longer a display with an upsell behind it. It is the
// CONTROL. There is nothing here to unlock, no plan to name, no lock glyph,
// and no `featurePlan`/`planLabel` import — see the "nothing here is for
// sale" block in `__tests__/recording-chip.test.tsx`, which reds if any of
// that vocabulary comes back.
//
// THE DESIGN IS COMMITTED, NOT DERIVED HERE. Two layouts went to the owner
// (`docs/superpowers/specs/mockups/2026-09-02-entitlements-v18/`); Option B
// was chosen. A 44px pill — four-rung meter, the word "Recording", the active
// band, a chevron — raising a sheet of four full-width rows. On a phone that
// sheet is a BOTTOM sheet, thumb-reachable and edge to edge; from `sm` up it
// becomes a floating centred card with a max width and every corner rounded.
// That is two compositions, not one shrunk: "mobile is designed, not shrunk"
// is a binding rule on this programme (`1a0c948b9`).
//
// A11Y, per the mockup's own notes: `aria-haspopup="dialog"` + `aria-expanded`
// on the pill; the sheet is a `radiogroup` whose selected row carries BOTH a
// check glyph and a heavier weight; the meter's rungs read fill-vs-outline,
// never hue alone. Each row is a real `<button>` so it is tab-reachable
// without a roving-tabindex implementation this file would then have to keep
// correct.
//
// COPY. The chip says "Recording" and nothing else about which axis it is —
// deliberately. A parallel wave (R8) is adding a cricket "This innings: …"
// mode chip to the same strip and carries the differentiating wording on ITS
// side, because the axis that actually separates the two is AGENCY: ours is a
// choice the scorer can change right now, theirs is a fact locked when the
// innings began, and the value that has to explain itself is the locked one.
//
// FIDELITY BAND SCALE IS CLOSED 0-3, NEVER A TIER 4 (standing programme
// ruling; `packages/engine/src/sport/module.ts`'s `FidelityBand = 0 | 1 | 2 |
// 3` enforces it at the type level, and `BANDS` below is the runtime list).
import { useCallback, useEffect, useRef, useState } from "react";
import type { FidelityBand } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import type { MsgFn } from "./ribbon";

/** The four bands, ascending — the ONE ordered list this file iterates, so a
 *  row, a meter rung and a keyboard order can never disagree. */
export const BANDS: readonly FidelityBand[] = [0, 1, 2, 3];

export const BAND_LABEL_KEY: Record<FidelityBand, MessageKey> = {
  0: "pad.recording.band.0",
  1: "pad.recording.band.1",
  2: "pad.recording.band.2",
  3: "pad.recording.band.3",
};

/** The count-aware lookup `useMsgPlural()` hands back (dict + locale already
 *  bound). Taken as a prop for the same reason `t` is: this component is
 *  rendered inside the pad host, which resolves both once. */
export type RecordingPluralFn = (key: string, count: number, vars?: Record<string, string | number>) => string;

export interface RecordingChipProps {
  /** The band the scorer is on right now — the host's own state, not a
   *  server value and not an entitlement. */
  activeBand: FidelityBand;
  /** Report a pick. The host persists it per fixture; this component holds
   *  no band state of its own, so it can never disagree with the tile grid. */
  onBandChange: (band: FidelityBand) => void;
  /** How many tiles the pad shows AT each band — the real filtered count from
   *  the host, never an estimate. It is what makes the sheet honest: two
   *  bands a sport does not distinguish read the same number, and the scorer
   *  can see that rather than discovering it by tapping. */
  actionCounts: Readonly<Record<FidelityBand, number>>;
  /** Same MsgFn shape every other v3 control takes (useMsg()/msgFor()). */
  t: MsgFn;
  plural: RecordingPluralFn;
}

/**
 * The four-rung ladder, filled up to `upTo`.
 *
 * A PLAIN FUNCTION called directly, never `<Meter/>` — the same convention
 * `action-form.tsx`'s `renderActionRow` and `swap-sheet.tsx`'s
 * `renderCandidateRow` follow, and for the same reason: apps/web's node-only
 * `_hook-harness` expands one function component ONE level, so a nested
 * component's own output is invisible to `walk()` and the rungs could not be
 * asserted at all. `data-rung`/`data-filled` are the test contract that
 * replaces reading a class cascade there is no DOM to read.
 */
function meter(upTo: FidelityBand) {
  return (
    <span aria-hidden="true" className="flex h-3.5 shrink-0 items-end gap-px">
      {BANDS.map((band) => {
        const filled = band <= upTo;
        return (
          <i
            key={band}
            data-rung={band}
            data-filled={filled}
            style={{ height: 5 + band * 3 }}
            className={`block w-[3px] rounded-[1px] border ${
              filled ? "border-violet-600 bg-violet-600" : "border-violet-200 bg-transparent"
            }`}
          />
        );
      })}
    </span>
  );
}

/**
 * The pill, and the sheet it raises.
 *
 * Open/closed is the ONLY state this component owns. The band itself lives in
 * the host (`pad-host.tsx`), which is also what filters the tiles — one value,
 * one owner, so a picked band and a rendered grid cannot drift.
 */
export function RecordingChip({ activeBand, onBandChange, actionCounts, t, plural }: RecordingChipProps) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Focus goes back where the scorer left it, not to the top of the page.
    chipRef.current?.focus();
  }, []);

  // Escape closes, the way any dialog must. Guarded on `document` because
  // apps/web vitest runs in a node environment with no DOM at all — the
  // harness DOES run effects, so an unguarded listener would throw there.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Opening a dialog and leaving focus behind it is the classic half-built
  // sheet: a keyboard scorer would tab through the whole pad to reach it.
  useEffect(() => {
    if (open) activeRowRef.current?.focus();
  }, [open]);

  const pickLabel = t("pad.recording.pick");
  const countText = (band: FidelityBand) =>
    plural("pad.recording.actions", actionCounts[band], { count: actionCounts[band] });

  return (
    <div className="min-w-0">
      <button
        ref={chipRef}
        type="button"
        data-role="v3-recording-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ minHeight: 44 }}
        // FULL-BLEED ON A PHONE, CONTENT-WIDTH ABOVE IT. At 320 the pill is the
        // whole column and its value truncates rather than wrapping the row; at
        // 1280 a full-width pill would be ~880px of dead space with three words
        // in the corner, which is the "desktop is the mobile design stretched"
        // failure the other way round.
        className="flex w-full min-w-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 sm:gap-2.5 sm:w-auto sm:max-w-md sm:px-3.5"
      >
        {meter(activeBand)}
        <span className="shrink-0 text-[11px] text-slate-500 sm:text-xs">{t("pad.recording.lead")}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900">
          {t(BAND_LABEL_KEY[activeBand])}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <p className="mt-1.5 min-w-0 truncate pl-3 text-xs text-slate-500 sm:pl-3.5">{countText(activeBand)}</p>

      {/* Bottom sheet on a phone — thumb-reachable, edge to edge. From `sm` up
          it becomes a centred dialog, because a card pinned to the bottom edge
          of a 1280 screen is a phone pattern wearing a desktop's dimensions. */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
          {/* A real button, not a bare div: dismissing by tapping outside has
              to be reachable by something other than a mouse. It is removed
              from the tab order because the sheet's own rows are where a
              keyboard scorer should land. */}
          <button
            type="button"
            data-role="v3-recording-scrim"
            tabIndex={-1}
            aria-label={t("pad.recording.close")}
            onClick={close}
            className="absolute inset-0 bg-[#150b36]/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={pickLabel}
            className="relative w-full max-w-md rounded-t-[20px] bg-white px-3 pb-4 pt-2 shadow-[0_-8px_30px_rgba(21,11,54,0.22)] sm:rounded-[20px] sm:shadow-[0_10px_40px_rgba(21,11,54,0.28)]"
          >
            {/* NO GRAB HANDLE (W1/Task 4 review, M-3). The approved mockup drew
                one, and it was carried over as `aria-hidden` decoration — but
                this sheet does not respond to a drag at any width, so a bar
                that reads "drag me down" is a promise the sheet does not keep.
                Dismissal is the scrim, Escape, or picking a band; all three
                work. Restore the handle only alongside a real drag-to-dismiss,
                never on its own. */}
            <h2 className="mb-2 px-1 text-sm font-semibold tracking-[-0.01em] text-slate-900">
              {t("pad.recording.question")}
            </h2>
            <div role="radiogroup" aria-label={pickLabel}>
              {BANDS.map((band) => {
                const selected = band === activeBand;
                return (
                  <button
                    key={band}
                    ref={selected ? activeRowRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-band={band}
                    onClick={() => {
                      onBandChange(band);
                      close();
                    }}
                    style={{ minHeight: 60 }}
                    className={`flex w-full min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-600 ${
                      selected ? "bg-violet-50" : "hover:bg-slate-50"
                    }`}
                  >
                    {meter(band)}
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block break-words text-sm leading-tight ${
                          selected ? "font-semibold text-violet-900" : "font-medium text-slate-700"
                        }`}
                      >
                        {t(BAND_LABEL_KEY[band])}
                      </span>
                      <span className="mt-0.5 block break-words text-[11px] text-slate-500">{countText(band)}</span>
                    </span>
                    {/* Weight AND a glyph carry the selection, never colour
                        alone — the mockup's own a11y note. */}
                    <span aria-hidden="true" className="w-5 shrink-0 text-center text-sm font-bold text-violet-600">
                      {selected ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
