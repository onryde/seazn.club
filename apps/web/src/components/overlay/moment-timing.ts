// The slab's two numbers, in ONE place (stream overlay W2 Task 4).
//
// They live apart from the reducer and the component because the e2e derives
// its own time budget from them. A flat timeout in a spec beside a derived cost
// is a latent red — AGENTS.md class 20, paid for once already when `HOLD_MS`
// moved and a Playwright budget did not move with it.
//
// `_THEMES.md` §6: "→ 0 250 ms ease-out, hold 4000 ms, → -100% 250 ms ease-in".
// The CSS transition duration is derived from `OVERLAY_MOMENT_FOLD_MS` through
// a custom property, so the paint and the state machine cannot disagree.

/** How long a slab stays fully on screen, between its fold in and its fold out. */
export const OVERLAY_MOMENT_HOLD_MS = 4_000;

/** Each fold. Applied twice per moment — in, then out. */
export const OVERLAY_MOMENT_FOLD_MS = 250;
