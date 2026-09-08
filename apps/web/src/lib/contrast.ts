// WCAG 2.x contrast, one implementation for the overlay's contrast gate.
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
//
// Lifted from components/v2/scorepad/v3/__tests__/contrast.test.ts (R1 Task 5),
// where it was written from the spec formula and pinned by the #767676-on-white
// gamma-differential case that this module's own test keeps.
//
// WHY THIS IS A MODULE AND NOT A TEST HELPER. The overlay's colour gate
// (components/overlay/__tests__/contrast.test.ts) sweeps every painted pair
// across eleven sports and derives the moments slab's ink from the ratio
// itself (_THEMES.md §5) — a derivation, not just an assertion, so the formula
// is production code the sweep and the tokens module both read. Two copies of
// a luminance curve is exactly how a gate and the thing it gates drift apart.

/** Normalise `#abc` / `#AABBCC` / `aabbcc` to six lower-case hex digits. */
function expandHex(hex: string): string {
  const n = hex.trim().replace(/^#/, "").toLowerCase();
  // Validate the CHARACTER SET on both branches. A 3-digit value that is not
  // hex would otherwise expand happily and parseInt its way to NaN, and a NaN
  // channel scores every pair it touches as 1:1 — a sweep that reports nothing
  // as red, which is the one failure mode a contrast gate must not have.
  if (/[^0-9a-f]/.test(n) || (n.length !== 3 && n.length !== 6)) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  return n.length === 3
    ? n
        .split("")
        .map((c) => c + c)
        .join("")
    : n;
}

function channels(hex: string): [number, number, number] {
  const n = expandHex(hex);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function srgbChannelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance: 0 for black, 1 for white. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** (L1 + 0.05) / (L2 + 0.05), L1 the lighter. 1 ≤ ratio ≤ 21. */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** The colour a viewer SEES for `fg` painted at `alpha` over an opaque `bg` —
 *  simple source-over per channel, rounded. Ink at 70 % on the board is a
 *  different pair from ink on the board, and only the composite can be
 *  measured against a floor. */
export function blendOver(fgHex: string, bgHex: string, alpha: number): string {
  if (!(alpha >= 0 && alpha <= 1)) throw new Error(`alpha out of range: ${alpha}`);
  const f = channels(fgHex);
  const b = channels(bgHex);
  const out = f.map((fc, i) => Math.round(fc * alpha + b[i]! * (1 - alpha)));
  return `#${out.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
