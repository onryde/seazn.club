"use client";
// Registration redesign B2 T8 (spec §7.2) — the register form's action bar, drawn. ONE DOM: Back, the running total and the one forward
// button, plus the live region that says the submit phase aloud, never a phone twin. What the bar SAYS is computed by
// action-bar-labels.ts from the stepper's own state and handed in as `labels`; the stepper owns what the buttons DO (`onBack`,
// `onNext`, `onSubmit`) and whether a submit is in flight. This module owns how it looks and how it stacks.
//
// Below `md` it is a bar pinned to the bottom of the register column (`sticky bottom-0`, full-bleed over the page's 16px gutter,
// padded for the home-indicator inset); from `md` it is the plain row it always was. Back is ABSENT on step 1, not disabled.
import type { Ref } from "react";
import { useT } from "@/components/i18n/dict-provider";
import type { ActionBarLabels } from "./action-bar-labels";
import { BTN_FORWARD, BTN_GHOST, LABEL_SIZER, LABEL_SIZER_TEXT } from "./styles";
import type { StepId } from "./types";

export function ActionBar({
  step,
  hasBack,
  submitting,
  labels,
  sentTo,
  blocked = null,
  blockedRef,
  onBack,
  onNext,
  onSubmit,
}: {
  step: StepId;
  /** False on the first step: Back is then absent, not disabled. */
  hasBack: boolean;
  /** A submit is in flight (saving or opening payment). Back and the submit button are disabled, and the live region speaks. */
  submitting: boolean;
  labels: ActionBarLabels;
  /** The address the confirmation goes to (Review's md+ note). "" shows no note. Trimmed by the caller, as submit.ts trims it. */
  sentTo: string;
  /** Walk-fix F6: why the forward button cannot move on, when the reason is not a field the registrant can see beside it (a mixed-method
   *  cart). Drawn IN the bar, directly above the button, so it is on screen wherever the button is (on a phone the bar is pinned and
   *  a notice under the cart sat below the fold, under the bar); the button is then `aria-disabled` and described by it. What a tap
   *  does then is the stepper's (`onNext`): it reveals and focuses this notice through `blockedRef`. Null = nothing blocks. */
  blocked?: string | null;
  /** The notice's element, for the stepper's reveal (a ref of its own prop: react-hooks/refs reads a ref inside an object as a read). */
  blockedRef?: Ref<HTMLParagraphElement>;
  onBack: () => void;
  onNext: () => void;
  /** Passed straight to the button's onClick, so what it returns (the stepper's submit is async) is what a caller of the handler awaits. */
  onSubmit: () => void | Promise<void>;
}) {
  const t = useT();
  return (
    <>
      {/* Tokens: surface + zinc-200 hairline + `shadow-sm`, all three the step cards' own (`bg-surface`, `border-zinc-200`, `shadow-sm`).
          No upward shadow token exists in the tree, so the hairline carries the bar's top edge.
          Stacking, against the fixed z-40 cookie banner (cookie-consent.tsx; dialogs are z-50 above both): from `md` the row is z-50,
          the fix-wave finding #6 escape hatch — the banner must never swallow a click on Back/Next, and the in-flow row is not pinned,
          so the banner can only brush it. Below `md` the bar is pinned to the very edge the banner also sits on, so z-50 there buried
          the banner under the bar (measured in a browser: its Accept/Reject hidden for as long as the bar is pinned, i.e. unanswerable).
          z-30 puts the banner above the bar instead: a first visit answers the banner, then has the whole bar.
          `gap-x-3` (B1 fix round 1, D2): at 320 a long translated label wraps and the forward button fills the row, which left it
          flush against Back; the gap keeps the two targets apart at any label length. The summary is its own full-width line above the
          buttons (three items do not fit one 320px row beside "Continue to Entries"), so the bar wraps. `max-md:mb-0`: the root's
          `space-y-4` would otherwise leave a 16px margin under a sticky bar that should sit on the viewport's edge. */}
      <div
        data-testid="reg-bar"
        className="relative flex flex-wrap items-center gap-x-3 gap-y-2 max-md:sticky max-md:bottom-0 max-md:z-30 md:z-50 max-md:-mx-4 max-md:mb-0 max-md:border-t max-md:border-zinc-200 max-md:bg-surface max-md:px-4 max-md:pt-3 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:shadow-sm"
      >
        {/* Shown whenever the stepper passes a refusal; WHICH steps can have one is the stepper's rule (ENTRIES only, walk-fix B
            review m3), so the bar does not restate it. */}
        {blocked !== null ? (
          // `role="alert"`: said when the cart becomes mixed, as the cart's own notice used to be. `tabIndex={-1}`: focusable by the
          // stepper's reveal, never a tab stop. `w-full`: its own line above the summary and the buttons, at every width.
          <p
            id="reg-bar-blocked"
            ref={blockedRef}
            role="alert"
            tabIndex={-1}
            data-testid="reg-bar-blocked"
            className="w-full min-w-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
          >
            {blocked}
          </p>
        ) : null}
        {labels.total ? (
          <p data-testid="reg-bar-summary" className="w-full text-sm font-semibold tabular-nums text-ink md:hidden">
            {labels.total}
          </p>
        ) : null}
        {hasBack ? (
          <button
            type="button"
            data-testid="reg-back"
            onClick={onBack}
            // In flight (B2 T8): the cart is on its way to the server; a Back now would show an earlier step over a submit that is
            // still running. Re-enabled by the stepper's catch branch, with the button itself.
            disabled={submitting}
            className={`${BTN_GHOST} max-md:min-h-11`}
          >
            {t("register.nav.back")}
          </button>
        ) : null}
        {step === "review" ? (
          <>
            {/* From `md` the bar is a plain row, with room for where the confirmation goes (spec 7.3). Phones have the address in the
                You section, and no spare width: hidden there, not a second tree. `md:ml-auto` pushes it, and the button after it (whose
                own `ml-auto` is cancelled at md), to the row's end; without an address (cannot happen past Contact) there is no note.
                `min-w-0 break-words` (B2 review m6): an address has no break points and may be 200 characters, so the note must be
                allowed to shrink and to wrap it, or it pushes the row past the page at 768. */}
            {sentTo !== "" && (
              <p data-testid="reg-bar-sent-to" className="max-md:hidden md:ml-auto min-w-0 break-words text-sm text-ink-muted">
                {t("register.review.sentTo", { email: sentTo })}
              </p>
            )}
            <button
              type="button"
              data-testid="reg-submit"
              onClick={onSubmit}
              disabled={submitting}
              // Busy, not unavailable (B1 fix round 1, D1): BTN_PRIMARY keeps a disabled+busy button at full strength, so the phase
              // label is read as "working", and assistive tech is told the same thing.
              aria-busy={submitting}
              className={sentTo !== "" ? `${BTN_FORWARD} md:ml-0` : BTN_FORWARD}
            >
              {/* The label sits in a sizer (styles.ts LABEL_SIZER) that is as wide as the longest label the button will show, so the
                  click that changes the words does not change the button's width. */}
              <span data-widest={labels.widestSubmitLabel} className={LABEL_SIZER}>
                <span className={LABEL_SIZER_TEXT}>{labels.submitLabel}</span>
              </span>
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="reg-next"
            onClick={onNext}
            // Not `disabled`: a disabled button takes no tap and no focus, so the reveal could never run. `aria-disabled` says it to
            // assistive tech, the notice says why, and the styles dim it the way `disabled` would.
            aria-disabled={blocked !== null ? true : undefined}
            aria-describedby={blocked !== null ? "reg-bar-blocked" : undefined}
            className={`${BTN_FORWARD} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
          >
            {labels.continueLabel}
          </button>
        )}
      </div>
      {/* The submit phase, said aloud (B1 fix round 1, D3): Chrome drops focus from the button the moment it is disabled, so its own
          label change is not read out. Mounted on every step and empty until a submit starts (a live region injected already
          filled is not reliably announced, own-tile.tsx), cleared when the phase returns to idle: an error has its own alert. */}
      <p role="status" aria-live="polite" data-testid="reg-submit-status" className="sr-only">
        {submitting ? labels.submitLabel : ""}
      </p>
    </>
  );
}
