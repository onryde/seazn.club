// RS006 chassis — shared Tailwind utility strings for the register/ tree.
// Not a new global CSS component class (globals.css's .btn/.input/.label
// are console-wide and hardcode the purple palette — this tree is the
// themeable "courtside" public surface, --ps-* driven, and must NOT pull
// those in). Plain utility strings, same convention every other
// public-site component already uses (tabs.tsx, standings-table.tsx).

/** Primary CTA — mirrors globals.css's markdown-button treatment
 *  (`bg-accent ... font-display uppercase tracking-wide text-white shadow`)
 *  so the stepper's own buttons read as the same product voice.
 *
 *  Busy (registration redesign B1 fix round 1, D1): a disabled button that
 *  also says `aria-busy="true"` is WORKING, not unavailable, and its label is
 *  the status the person reads while they wait ("Saving your place…"). It
 *  keeps full strength and shows a progress cursor instead of the 40% dim.
 *  Keyed on the ARIA attribute itself, so what is drawn and what a screen
 *  reader is told cannot disagree; stacked on `disabled:` so it outranks
 *  `disabled:opacity-40` by specificity whatever order the CSS is emitted in. */
export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 font-display text-sm font-semibold uppercase tracking-wide text-accent-ink shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:aria-busy:cursor-progress disabled:aria-busy:opacity-100";

/** The action bar's forward button (B2 T8): the primary treatment, pushed to the row's end (`ml-auto`: Back is absent on the first step, so
 *  `justify-between` would leave a lone button on the left) and, below `md`, filling whatever Back leaves of the row so it is the big
 *  thumb target and its width does not depend on its label. `text-center` for a label that wraps at 320; `max-md:min-h-11` is the 44px
 *  phone tap target (BTN_PRIMARY's own height is ~36px). */
export const BTN_FORWARD = `${BTN_PRIMARY} ml-auto text-center max-md:min-h-11 max-md:flex-1`;

/** A label that changes length while the button around it does not (B2 T8: "Pay £25.00 and enter" -> "Saving your place…" -> "Opening
 *  secure payment…"). The outer span's `data-widest` carries the longest of the labels it will ever show; its `::after` draws that
 *  text invisibly in the SAME grid cell as the visible label (LABEL_SIZER_TEXT), so the cell, and the button around it, is always as
 *  wide AND as tall as the longest label — a click that changes the words moves nothing, including at 320 where the long ones wrap.
 *  The ghost is `after:invisible` (visibility: hidden), so it is out of the accessibility tree and the button's accessible name; being
 *  generated content would not by itself keep it out of either. */
export const LABEL_SIZER = "grid after:invisible after:col-start-1 after:row-start-1 after:content-[attr(data-widest)]";
/** The visible label, in the ghost's cell and centred against it (the cell may be taller than a short label). */
export const LABEL_SIZER_TEXT = "col-start-1 row-start-1 self-center";

/** Secondary/ghost — mirrors tabs.tsx's inactive-tab treatment. */
export const BTN_GHOST =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent-line bg-white px-4 py-2 font-display text-sm font-semibold uppercase tracking-wide text-accent-strong transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40";

/** Quiet text-only action (Remove, Add another). */
export const BTN_TEXT =
  "font-display text-xs font-semibold uppercase tracking-wide text-ink-muted transition hover:text-accent-strong disabled:cursor-not-allowed disabled:opacity-40";

/** The form control. `aria-invalid` is the single hook for the danger state (B2 T9): every field in this tree that sets the attribute gets
 *  the red border and a red focus ring from here, so what is drawn and what a screen reader is told cannot disagree. The compound
 *  `aria-invalid:focus:` forms keep the red on focus, where the plain `focus:border-accent` would otherwise win. */
export const FIELD =
  "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-muted/70 focus:border-accent focus:ring-2 focus:ring-accent-soft aria-invalid:border-red-600 aria-invalid:focus:border-red-600 aria-invalid:focus:ring-red-100";

/** Added to FIELD on an `<input readOnly>` (B2 T9: the contact's own row on Details): the canvas fill and a plain cursor say "not for
 *  typing" while the field keeps its box, its focus ring and its text colour. Spelled with `read-only:` on purpose and NOT folded into
 *  FIELD: `:read-only` matches every `<select>` too, which would grey all of them. */
export const FIELD_READONLY = "read-only:cursor-default read-only:bg-canvas";

/** A small neutral tag beside a label ("Optional"). Sentence case and untracked, so it reads the same inside FIELD_LABEL's uppercase
 *  tracking; the canvas fill and zinc-200 hairline are the roster row's own (roster-table.tsx). */
export const TAG_NEUTRAL =
  "inline-flex items-center rounded-full border border-zinc-200 bg-canvas px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal text-ink-muted";

export const FIELD_LABEL =
  "mb-1.5 block font-display text-[11px] font-semibold uppercase tracking-wider text-ink-muted";
