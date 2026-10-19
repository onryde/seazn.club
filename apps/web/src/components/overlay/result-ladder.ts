// The Result card's headline ladder — owner ruling (1), 2026-10-19, relayed by the coordinator (PR #982 review
// round 1, item 2's residual).
//
// "Full result → shortResult → shortResult at a smaller headline size → the highlights give way. Each rung is taken
// only when the one before doesn't fit on one line." The bar's card region holds ONE headline line beside cricket's
// highlights (1728 × 636, card max-width 1100), and a 43-character winner runs the full sentence to three.
//
// MEASURED, NOT COUNTED — the name ladder's reason (`name-ladder.ts`): the display face is condensed, and a
// character rule would be wrong one way or the other. Each rung is rendered once as a hidden, unwrapped probe; its
// natural width against the card's content width says whether it fits on one line. The probes' widths do not depend
// on which rung is on air and neither does the card's width, so the choice cannot oscillate.
//
// SPLIT ON PURPOSE, as `name-ladder.ts` is: `pickResultRung` and `resultLadderTexts` are arithmetic and unit-tested;
// the two functions that read boxes run only in a browser, and gallery check 4c covers them in every locale.

/** The rungs, in order. `yield` keeps the compact short sentence (wrapping) and drops the highlights. */
export const RESULT_RUNG_NAMES = ["full", "short", "compact", "yield"] as const;
export type ResultRung = 0 | 1 | 2 | 3;

/** The three headline texts, one per measured rung: the full sentence, then the short one twice — the compact rung
 *  is a SIZE step of the same words. No short form (a void with no verdict, the "ended" fallback): the full text on
 *  every rung, so the ladder still steps down in size. */
export function resultLadderTexts(full: string, short: string | undefined): [string, string, string] {
  const s = short ?? full;
  return [full, s, s];
}

/**
 * The first rung whose ONE line fits `available`, else `3` — the highlights give way.
 *
 * @param widths  each measured rung's natural (unwrapped) width: [full, short, compact], in layout px
 * @param available  the headline's one-line room: the card's content width, capped by the headline's max-width
 */
export function pickResultRung(widths: readonly [number, number, number], available: number): ResultRung {
  // Guards, not comments: an unmeasured box reads 0 (or NaN), and "nothing fits" would then hide the highlights on a
  // card that has not been laid out. The caller measures only a laid-out card; these refuse anything else by name.
  if (!(available > 0) || !Number.isFinite(available)) {
    throw new RangeError(`pickResultRung: available must be a positive width, got ${available}`);
  }
  for (const w of widths) {
    if (!Number.isFinite(w) || w < 0) throw new RangeError(`pickResultRung: a probe width must be finite, got ${w}`);
  }
  if (widths[0] <= available) return 0;
  if (widths[1] <= available) return 1;
  if (widths[2] <= available) return 2;
  return 3;
}

/** The headline's one-line room, in layout px: the card's content box (its padding off), capped by the headline's own
 *  `max-width`. Layout px (`clientWidth`), never `getBoundingClientRect` — the gallery's previews are scaled. Returns 0
 *  for a card that is not laid out. Browser only. */
export function availableHeadlineWidth(card: HTMLElement): number {
  if (card.clientWidth === 0) return 0;
  const cs = getComputedStyle(card);
  const content = card.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const headline = card.querySelector<HTMLElement>('[data-testid="ovl-slate-headline"]');
  const max = headline === null ? Number.NaN : parseFloat(getComputedStyle(headline).maxWidth);
  return Number.isFinite(max) ? Math.min(content, max) : content;
}

/** A probe's natural width in the card's layout px: its painted width divided by the scale the card is painted at (a
 *  preview's transform scales both alike). Browser only. */
export function probeLayoutWidth(probe: HTMLElement, card: HTMLElement): number {
  const scale = card.getBoundingClientRect().width / card.offsetWidth;
  return probe.getBoundingClientRect().width / scale;
}
