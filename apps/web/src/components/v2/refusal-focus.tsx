// A YouTube refusal REPLACES Go live (YouTube Connect T12). The organiser's focus was on Go live (they just pressed it), so when the
// refusal block takes its place the focused element is removed and focus falls back to the page: a keyboard or screen-reader user is
// dropped at the top of the document. The block takes focus itself when it appears.
//
// The BLOCK, not one of its buttons (T12 fix round 2): the refusal commits while the start is still in flight (`onGoLive` records the
// refusal, then awaits the session read, and only then ends `busy`), so Try again is still disabled at the moment the block attaches and
// a "first enabled action" lands on Use another destination instead. The block is `tabIndex={-1}` and carries role=alert, so focusing it
// is deterministic whichever action is enabled, announces the refusal, and one Tab then reaches the first ENABLED action in DOM order.
//
// A callback ref, not an effect: it runs once when the block attaches, and the callback is module-level so its identity never changes —
// a re-render of the panel (every poll) does not re-run it and steal focus back, and a panel that mounts with no refusal focuses nothing.
// The panel keys the block by its code, so a second refusal (a different code, or the same one after Try again unmounted the block)
// attaches a new element and focuses again.

/** Focus the refusal block as it attaches (a callback ref: `null` is the detach and does nothing). */
export function focusRefusalBlock(block: HTMLElement | null): void {
  block?.focus();
}

/** The house keyboard ring (globals.css's `:where(a, button, …):focus-visible` is 2px, offset 2px, `--ps-accent`), for a box that is not a
 *  link or a button: shown to a keyboard user, not painted for a pointer user whose press the focus follows. The colour is the repo's
 *  `accent` token (`@theme inline` in globals.css: `--color-accent: var(--ps-accent)`), NOT a Tailwind palette violet: violet-600 is
 *  rgb(127 34 254) in Tailwind 4, a different colour from `--ps-accent` (#7c3aed), so the ring on this box and the one on every link would
 *  not match (B4 fix round 2, F3). The accent clears 3:1 against white; the lighter violet-400 was ~2.7:1. */
export const REFUSAL_FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
