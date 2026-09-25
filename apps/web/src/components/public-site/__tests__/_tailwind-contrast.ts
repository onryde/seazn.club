// WCAG contrast of a Tailwind palette class on a public-site ground, priced from
// the SOURCES rather than from hex values typed into a test: the swatch is read
// out of Tailwind's own `theme.css` (v4 declares every swatch in oklch, and the
// v3 hex palette disagrees with it by enough to flip an AA verdict) and the
// ground out of `globals.css`. Change the shade or the ground and every ratio
// built on this moves with it.
//
// Checked against axe on the built page: `text-emerald-600` converts to
// rgb(0,153,102) and 3.65:1 on #ffffff here, the same #009966 and 3.65 axe
// reported for the hub's live label (spectator-hub.spec.ts HB12L).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const THEME = readFileSync(fileURLToPath(import.meta.resolve("tailwindcss/theme.css")), "utf8");
const GLOBALS = readFileSync(fileURLToPath(new URL("../../../app/globals.css", import.meta.url)), "utf8");

/** A `--ps-*` colour from globals.css, as #rrggbb. */
export function psColour(name: string): string {
  const hex = new RegExp(`--ps-${name}:\\s*(#[0-9a-f]{6})\\b`, "i").exec(GLOBALS)?.[1];
  if (!hex) throw new Error(`globals.css declares no hex --ps-${name}`);
  return hex;
}

/** A Tailwind swatch (`emerald-700`) as the 8-bit sRGB a browser paints. */
export function swatchRgb(swatch: string): [number, number, number] {
  const m = new RegExp(`--color-${swatch}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(THEME);
  if (!m) throw new Error(`tailwindcss/theme.css declares no oklch --color-${swatch}`);
  // OKLCH -> OKLab -> linear sRGB (Ottosson's matrices) -> gamma, clamped to gamut.
  const [L, C, h] = [Number(m[1]) / 100, Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (x: number) => {
    const c = Math.min(1, Math.max(0, x));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  return [
    encode(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  ];
}

function luminance([r, g, b]: readonly number[]): number {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

/** WCAG 2 contrast ratio of a Tailwind swatch on a #rrggbb ground. */
export function swatchContrast(swatch: string, groundHex: string): number {
  const ground = [1, 3, 5].map((i) => parseInt(groundHex.slice(i, i + 2), 16));
  const [hi, lo] = [luminance(swatchRgb(swatch)), luminance(ground)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The `text-<hue>-<shade>` swatch among an element's classes, e.g. `emerald-700`. */
export function textSwatchOf(classes: string): string {
  const m = /(?:^|\s)text-([a-z]+-\d{2,3})(?=\s|$)/.exec(classes);
  if (!m) throw new Error(`no text-<hue>-<shade> class in "${classes}"`);
  return m[1]!;
}
