// WCAG contrast of a Tailwind palette class against white, from Tailwind's OWN palette entry (`tailwindcss/colors`), so an
// expected ratio is the standard's number and the colour is whatever the class really compiles to — never a hex typed into a
// test. Shared by the registration hub suites (moved out of registration-hub-registrant-filter-sheet.test.tsx in B7 T24).
import tailwindColors from "tailwindcss/colors";

/** WCAG relative-luminance contrast of a Tailwind palette entry (`oklch(L C h)` or a hex) against white. */
export function contrastOnWhite(color: string): number {
  const lin = (c: number) => Math.min(1, Math.max(0, c));
  let r: number, g: number, b: number;
  const ok = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)/.exec(color);
  if (ok) {
    const L = Number(ok[1]) / 100;
    const C = Number(ok[2]);
    const h = (Number(ok[3]) * Math.PI) / 180;
    const a = C * Math.cos(h);
    const bb = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
    const sv = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
    r = lin(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sv);
    g = lin(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sv);
    b = lin(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sv);
  } else {
    const hex = color.replace("#", "");
    const ch = (i: number) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    [r, g, b] = [ch(0), ch(2), ch(4)];
  }
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return 1.05 / (Y + 0.05);
}

/** The palette entry a `<prefix>-<family>-<shade>` class (`text-slate-500`, `bg-purple-600`) compiles to; throws on anything
 *  that is not one, so a caller can never measure a colour it failed to find. */
export function paletteColor(cls: string, prefix: "text" | "bg"): string {
  const m = new RegExp(`^${prefix}-([a-z]+)-(\\d{2,3})$`).exec(cls);
  if (!m) throw new Error(`paletteColor: ${cls} is not a ${prefix}-<family>-<shade> class`);
  const palette = (tailwindColors as unknown as Record<string, Record<string, string> | undefined>)[m[1]!];
  const color = palette?.[m[2]!];
  if (!color) throw new Error(`paletteColor: Tailwind has no ${m[1]}-${m[2]}`);
  return color;
}
