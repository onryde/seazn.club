// RS006 chassis — shared Tailwind utility strings for the register/ tree.
// Not a new global CSS component class (globals.css's .btn/.input/.label
// are console-wide and hardcode the purple palette — this tree is the
// themeable "courtside" public surface, --ps-* driven, and must NOT pull
// those in). Plain utility strings, same convention every other
// public-site component already uses (tabs.tsx, standings-table.tsx).

/** Primary CTA — mirrors globals.css's markdown-button treatment
 *  (`bg-accent ... font-display uppercase tracking-wide text-white shadow`)
 *  so the stepper's own buttons read as the same product voice. */
export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 font-display text-sm font-semibold uppercase tracking-wide text-accent-ink shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";

/** Secondary/ghost — mirrors tabs.tsx's inactive-tab treatment. */
export const BTN_GHOST =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent-line bg-white px-4 py-2 font-display text-sm font-semibold uppercase tracking-wide text-accent-strong transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40";

/** Quiet text-only action (Remove, Add another). */
export const BTN_TEXT =
  "font-display text-xs font-semibold uppercase tracking-wide text-ink-muted transition hover:text-accent-strong disabled:cursor-not-allowed disabled:opacity-40";

export const FIELD =
  "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-muted/70 focus:border-accent focus:ring-2 focus:ring-accent-soft";

export const FIELD_LABEL =
  "mb-1.5 block font-display text-[11px] font-semibold uppercase tracking-wider text-ink-muted";
