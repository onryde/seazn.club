// The settings C8 frame (owner 2026-11-11, mock set11c01 C1/C2/O1): the card the New competition form introduced, reused by
// competition settings (General, Branding) and the org's Organisation tab. Below `lg` one column in source order — the
// decisions, then the long text, then the footer; from `lg` the decisions on the left, the long text on the right (stretching
// to the left column's height), and one footer row across both. Source order is tab order and reading order.
//
// Hookless on purpose: apps/web vitest has no DOM, and a hookless frame can be called directly in a test to walk what it
// wraps. Every grid child is `min-w-0`, or a long name or a wide editor toolbar would push the page wider than the card.
import type { FormEvent, ReactNode } from "react";

/**
 * `wide`: a page of its own (competition settings) — the New competition form's exact proportions, a 26.5rem decisions
 * column. `rail`: beside the settings rail, where the card is ~250px narrower — a 20rem column, so the long text keeps
 * ~24rem at 1280 instead of ~15rem. Literal class strings, so Tailwind sees every one of them.
 */
const FRAME = {
  wide: "card p-5 max-lg:space-y-5 sm:p-6 lg:grid lg:grid-cols-[minmax(0,26.5rem)_minmax(0,1fr)] lg:gap-x-10 lg:gap-y-6 lg:p-8",
  rail: "card p-5 max-lg:space-y-5 sm:p-6 lg:grid lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-x-8 lg:gap-y-6",
} as const;

export function SettingsSplitCard({
  onSubmit,
  testId,
  size = "wide",
  left,
  right,
  notices,
  footer,
}: {
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  testId?: string;
  size?: keyof typeof FRAME;
  /** The decisions: short fields and choices. */
  left: ReactNode;
  /** The long text (an editor) or what the left column produces (a preview). */
  right: ReactNode;
  /** Errors, a paywall: across both columns, above the footer. */
  notices?: ReactNode;
  /** The save bar; absent for someone who cannot edit. */
  footer?: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit} data-testid={testId} className={FRAME[size]}>
      <div className="min-w-0 space-y-5 lg:col-start-1 lg:row-start-1" data-split="left">
        {left}
      </div>
      <div className="min-w-0 lg:col-start-2 lg:row-start-1 lg:flex lg:flex-col" data-split="right">
        {right}
      </div>
      {notices ? <div className="min-w-0 space-y-3 lg:col-span-2">{notices}</div> : null}
      {footer ? <div className="min-w-0 lg:col-span-2">{footer}</div> : null}
    </form>
  );
}

/**
 * One save for the whole card: what is unsaved on the left ("Unsaved: Name, Description", or the saved note), Discard and
 * Save on the right. Below `sm` the buttons stack full width with Save on top, the thumb's reach.
 */
export function SaveBar({
  message,
  messageId,
  canDiscard,
  busy,
  onDiscard,
  discardLabel,
  saveLabel,
  savingLabel,
}: {
  /** The unsaved list or the saved note; empty says nothing. */
  message: string;
  /** The Save button is described by this line, so "what will be saved" is read with it. */
  messageId: string;
  canDiscard: boolean;
  busy: boolean;
  onDiscard: () => void;
  discardLabel: string;
  saveLabel: string;
  savingLabel: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-purple-100 pt-5 sm:flex-row sm:items-center" data-testid="settings-save-bar">
      <p
        id={messageId}
        aria-live="polite"
        data-testid="settings-save-bar-message"
        className="min-w-0 flex-1 text-sm text-slate-600 max-sm:text-center"
      >
        {message}
      </p>
      <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
        <button type="button" onClick={onDiscard} disabled={!canDiscard || busy} className="btn btn-ghost min-h-11">
          {discardLabel}
        </button>
        <button type="submit" disabled={busy} aria-describedby={messageId} className="btn btn-primary min-h-11">
          {busy ? savingLabel : saveLabel}
        </button>
      </div>
    </div>
  );
}
