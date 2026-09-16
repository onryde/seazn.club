// The public Schedule's time/status rail is a FIXED grid track, and every word
// in it is a translation (spectator N1f f1/f3, review-n1e I1 and m2).
//
// What went wrong: `/embed` mounted no display face, so the rail fell back to
// the body face and "Finalizado" (es), "Afgelopen" (nl) and "déterminer" (fr)
// painted 65-70px into a 52px column — over the start of the entrant name on
// every decided row of the embeddable schedule widget. The round view's short
// date was clipped to an ellipsis in all four locales, English included.
//
// Nothing in `apps/web` vitest can SEE that: the environment is "node", there
// is no layout and no font. What can see it is the font's own metrics, so this
// suite measures the real dictionary values in the real faces
// (`__tests__/font-advance.ts`) against the rail track read out of the
// component's own Tailwind class. The rail does not scroll: it is a fixed
// column. A word that does not fit is NOT clipped (review-n1g m4): the list's
// `overflow-hidden` cuts only at the card edge, outside the row's `px-3.5`.
// What happens instead:
// - a status word breaks MID-WORD inside the column (`break-words`): visible,
//   and broken ("détermine" / "r");
// - the live chip overflows and paints over the entrant name, silently;
// - only the court/date line truncates, by design.
// No no-scroll or scrollWidth gate sees either failure, and nothing in this
// vitest has a layout, so this suite is the only guard against them.
//
// Nothing is typed here that the source already says (N1g g4, review-n1f m3):
// - the words are the `copy.<key>` / `timeOf(` / `shortDate(` calls the rail
//   cell itself makes, parsed out of `schedule.tsx`, and valued through
//   `publicScheduleCopy`, the builder BOTH production callers use;
// - the typography — face, weight, size, tracking, case, whether the text can
//   wrap, and the fixed-width dot and gap beside a word — is read off the
//   classes around each word and priced from Tailwind's own theme;
// - the locales are the app's `LOCALES`.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDictionary } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { LOCALES, toLocale } from "@/lib/i18n-constants";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { intlLocaleFor } from "@/lib/public-date-locale";
import { shortDate, timeOf } from "../schedule";
import { openFace, minContentWidth, textWidth, type Face } from "./font-advance";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../../../..");
const SCHEDULE_SRC = readFileSync(path.join(HERE, "../schedule.tsx"), "utf8");

// The faces the rail actually paints in, filed by family and CSS weight.
// `font-display` resolves to `var(--ps-font-display, …)` (globals.css
// `@theme inline`), which both the /shared org layout and the /embed layout
// set to Barlow Condensed; the rest of the rail inherits the body sans, Geist.
// `next/font` fetches both at build time and commits nothing, so these are the
// repo's own copies of the faces the build ships (provenance and the accepted
// drift: `__tests__/font-advance.ts`). A weight is a DIFFERENT file: the live
// chip is `font-bold`, and until N1g g3 it was measured in a regular face,
// 0.9px narrower than it paints (review-n1f m2).
const FONTS = path.join(WEB, "assets/fonts");
const FACES: Record<"display" | "body", Record<number, Face>> = {
  display: {
    600: openFace(path.join(FONTS, "BarlowCondensed-SemiBold.ttf"), "Barlow Condensed SemiBold"),
    700: openFace(path.join(FONTS, "BarlowCondensed-Bold.ttf"), "Barlow Condensed Bold"),
  },
  body: {
    400: openFace(path.join(FONTS, "Geist-Regular.ttf"), "Geist Regular"),
    700: openFace(path.join(FONTS, "Geist-Bold.ttf"), "Geist Bold"),
  },
};
function faceFor(family: "display" | "body", weight: number): Face {
  const face = FACES[family][weight];
  if (!face) throw new Error(`no committed ${family} face at weight ${weight}: add the file before measuring in it`);
  return face;
}

// ---- What a class is worth: Tailwind's own theme (N1g g4) ------------------
// The installed `tailwindcss/theme.css`, then `globals.css`; a later
// declaration of the same variable wins, as it does in the cascade.
const THEME_CSS = [
  path.join(path.dirname(createRequire(import.meta.url).resolve("tailwindcss/package.json")), "theme.css"),
  path.join(WEB, "src/app/globals.css"),
].map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));

/** A theme variable priced in px (rem at 16px), em, or a bare number; undefined when no theme declares it. */
function themeVar(name: string): { value: number; unit: "px" | "em" | "" } | undefined {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`not a theme variable name: ${name}`);
  let raw: string | undefined;
  for (const css of THEME_CSS) {
    for (const m of css.matchAll(new RegExp(`(?:^|[\\s;{])--${name}:\\s*([^;}]+)`, "g"))) raw = m[1].trim();
  }
  if (raw === undefined) return undefined;
  const v = /^(-?[0-9.]+)(rem|px|em)?$/.exec(raw);
  if (!v) throw new Error(`--${name}: "${raw}" is not a length this test can price`);
  const n = Number(v[1]);
  if (v[2] === "rem") return { value: n * 16, unit: "px" };
  if (v[2] === "px") return { value: n, unit: "px" };
  return { value: n, unit: v[2] === "em" ? "em" : "" };
}
const themeNumber = (name: string): number => {
  const v = themeVar(name);
  if (!v) throw new Error(`the theme declares no --${name}`);
  return v.value;
};
const spacingPx = (steps: number) => steps * themeNumber("spacing");

/** The rail track, in px, read from the row grid the component declares. */
function railPx(): number {
  const m = /grid-cols-\[([0-9.]+)rem_minmax\(0,1fr\)_auto\]/.exec(SCHEDULE_SRC);
  if (!m) throw new Error("could not find the scorebug row's grid-cols track in schedule.tsx");
  return Number(m[1]) * 16; // Tailwind rem against the default 16px root
}

// The locales are the app's own list, never a listing of the dictionaries
// directory, where a stray folder would read as a locale (review-n1f m3).
async function railCopy(locale: string) {
  const l = toLocale(locale);
  const dict = await getDictionary(l, "public");
  return publicScheduleCopy(dict, (k) => msgFor(l, k));
}

// ---- The rail cell, read the way the browser reads it (N1g g2) -------------
// A class list is a SET: its order means nothing to the browser, so no guard
// here may care where in the list a class sits. The N1f guard matched
// `truncate` only AFTER `font-display text-sm font-semibold`, and passed
// `className="truncate w-full …"` (review-n1f m1).

/**
 * Utilities that stop a status word wrapping, or cut it off. Picked from the
 * CSS Tailwind 4.3.1 emits for each (N1h h3, review-n1g m2).
 *
 * IN:
 * - `truncate` (overflow hidden + ellipsis + nowrap), `text-ellipsis`,
 *   `text-clip`, `overflow-{hidden,clip,x-hidden,x-clip}`, `line-clamp-<n>`:
 *   they cut the text off at the box.
 * - `whitespace-nowrap`, `text-nowrap` (`text-wrap: nowrap`) and
 *   `whitespace-pre` (spaces preserved AND no wrapping): no soft wrap at all.
 *   `break-words` acts only where wrapping is allowed, so the whole run must
 *   fit.
 * - Any variant of these (`clips` strips it: `sm:`, `*:`, `[&>span]:`),
 *   because it holds in SOME state.
 *
 * OUT, because the text still wraps:
 * - `whitespace-normal`.
 * - `whitespace-pre-line`: it keeps newlines but wraps. The rail's words are
 *   dictionary strings with no newline, and a newline could only add a break.
 * - `whitespace-pre-wrap`: preserved spaces hang at a break, so a word still
 *   needs only its own width.
 * - `whitespace-break-spaces`: it wraps, but `typographyOf` refuses to price
 *   it.
 * - `text-wrap`, `text-balance`, `text-pretty`.
 * - Break utilities that only add break opportunities (`break-all`,
 *   `wrap-anywhere`, `break-words`, `wrap-break-word`), change CJK only
 *   (`break-keep`), or leave wrapping at a space intact (`break-normal`,
 *   `wrap-normal`).
 */
const CLIPPING = new Set([
  "truncate",
  "text-ellipsis",
  "text-clip",
  "whitespace-nowrap",
  "whitespace-pre",
  "text-nowrap",
  "overflow-hidden",
  "overflow-clip",
  "overflow-x-hidden",
  "overflow-x-clip",
]);
/** A class token's utility, with its variants (`max-sm:`) and `!` stripped. */
const utilityOf = (token: string) => token.slice(token.lastIndexOf(":") + 1).replace(/^!|!$/g, "");
/** Does this class token clip text? */
const clips = (token: string) => {
  const base = utilityOf(token);
  return CLIPPING.has(base) || /^line-clamp-(?!none$)/.test(base);
};

interface Span {
  /** The class tokens, or null when `className` is not a string literal. */
  classes: Set<string> | null;
  open: number;
  close: number;
  selfClosing: boolean;
}

/** Blank comments, keeping every offset, so a key or class a comment NAMES is not read as markup. */
const blankComments = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}|^[ \t]*\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, " "));

/**
 * The row grid's rail cell — its first in-flow `<span>` (an `absolute` child
 * takes no grid track) — and every `<span>` inside it, cell included, in
 * source order.
 */
function railCell(source: string): { text: string; cell: Span; spans: Span[] } {
  const text = blankComments(source);
  const grid = /grid-cols-\[[0-9.]+rem_minmax\(0,1fr\)_auto\]/.exec(text);
  if (!grid) throw new Error("no row grid (grid-cols-[<n>rem_minmax(0,1fr)_auto]) in the source");
  const tag = /<span\b([^>]*)>|<\/span>/g;
  tag.lastIndex = grid.index;
  const stack: Span[] = [];
  const spans: Span[] = [];
  let cell: Span | undefined;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    if (m[1] === undefined) {
      const done = stack.pop();
      if (!done) throw new Error(`unbalanced </span> at offset ${m.index}`);
      done.close = m.index;
      if (done === cell) return { text, cell, spans };
      continue;
    }
    const literal = /className="([^"]*)"/.exec(m[1]);
    const span: Span = {
      classes: literal ? new Set(literal[1].split(/\s+/).filter(Boolean)) : null,
      open: m.index,
      close: m.index,
      selfClosing: m[1].trimEnd().endsWith("/"),
    };
    if (!cell && stack.length === 0 && !span.classes?.has("absolute")) cell = span;
    if (cell) spans.push(span);
    if (span.selfClosing) {
      if (span === cell) return { text, cell, spans };
    } else {
      stack.push(span);
    }
  }
  throw new Error("the rail cell never closes");
}

/**
 * What the rail cell paints, each with the chain of spans around it, outermost
 * (the cell) first: its status words — each `copy.<key>` and each `timeOf(` —
 * and its short dates, each `shortDate(`. The date line is not a status word:
 * it doubles as the court-name line, which is free text and may truncate.
 */
function railWords(source: string) {
  const { text, cell, spans } = railCell(source);
  const inCell = text.slice(cell.open, cell.close);
  const found = (re: RegExp, what: (m: RegExpMatchArray) => string) =>
    [...inCell.matchAll(re)].map((m) => {
      const at = cell.open + (m.index ?? 0);
      return { what: what(m), chain: spans.filter((s) => !s.selfClosing && s.open < at && at < s.close) };
    });
  return {
    cell,
    spans,
    words: found(/\bcopy\.(\w+)|\btimeOf\(/g, (m) => (m[1] ? `copy.${m[1]}` : "timeOf()")),
    dates: found(/\bshortDate\(/g, () => "shortDate()"),
  };
}

const tokensOf = (s: Span, where: string): string[] => {
  if (!s.classes) throw new Error(`${where}: a span has a non-literal className, which this guard cannot read`);
  return [...s.classes];
};

// ---- Typography, read off the classes around a word (N1g g4) ---------------
interface Typography {
  family: "display" | "body";
  weight: number;
  sizePx: number;
  trackingEm: number;
  uppercase: boolean;
  /** `truncate` / `whitespace-nowrap`: the text cannot wrap, so its whole run must fit. */
  nowrap: boolean;
  /** Fixed-width children painted beside the text, and the gap to each, in px. */
  extraPx: number;
}

/**
 * The typography a word inherits down its chain of spans (an inner class wins).
 * What the rail's spans do not say is the page's: the body face, at the normal
 * weight, with no tracking. A typographic class behind a variant, or one this
 * test cannot price, THROWS — a silent guess would be a guard that lies.
 */
function typographyOf(chain: Span[], spans: Span[], where: string): Typography {
  let family: Typography["family"] = "body";
  let weight = themeNumber("font-weight-normal");
  let sizePx: number | undefined;
  let trackingEm = 0;
  let uppercase = false;
  let nowrap = false;
  for (const span of chain) {
    for (const token of tokensOf(span, where)) {
      const base = utilityOf(token);
      let apply: (() => void) | undefined;
      let m: RegExpExecArray | null;
      if (base === "font-display") apply = () => (family = "display");
      else if (base === "font-sans") apply = () => (family = "body");
      else if ((m = /^font-([a-z]+)$/.exec(base)) && themeVar(`font-weight-${m[1]}`)) {
        const w = themeNumber(`font-weight-${m[1]}`);
        apply = () => (weight = w);
      } else if ((m = /^text-\[([0-9.]+)px\]$/.exec(base))) {
        const px = Number(m[1]);
        apply = () => (sizePx = px);
      } else if ((m = /^text-([a-z0-9]+)$/.exec(base)) && themeVar(`text-${m[1]}`)?.unit === "px") {
        const px = themeNumber(`text-${m[1]}`);
        apply = () => (sizePx = px);
      } else if ((m = /^tracking-([a-z]+)$/.exec(base)) && themeVar(`tracking-${m[1]}`)) {
        const em = themeNumber(`tracking-${m[1]}`);
        apply = () => (trackingEm = em);
      } else if (base === "uppercase") apply = () => (uppercase = true);
      else if (base === "normal-case") apply = () => (uppercase = false);
      else if (base === "truncate" || base === "whitespace-nowrap" || base === "text-nowrap" || base === "whitespace-pre") apply = () => (nowrap = true);
      else if (/^(font-(mono|serif)$|lowercase$|capitalize$|tracking-\[|text-\[|whitespace-break-spaces$)/.test(base)) {
        throw new Error(`${where}: "${token}" is typography this test cannot price yet`);
      }
      if (!apply) continue;
      if (token !== base && token.includes(":")) {
        throw new Error(`${where}: "${token}" changes typography behind a variant; measure that state too`);
      }
      apply();
    }
  }
  if (sizePx === undefined) throw new Error(`${where}: no font size on the rail's spans`);

  // The chip's dot: a self-closing child of the word's own span, a flex item
  // with a fixed `w-<n>`, and the flex `gap-<n>` between it and the text.
  let extraPx = 0;
  for (const child of childrenBeside(chain, spans)) {
    const w = spacingOf(child, "w", where);
    if (w === undefined) throw new Error(`${where}: a child painted beside the text has no w-<n> to measure`);
    extraPx += w + gapOf(chain.at(-1)!, where);
  }
  return { family, weight, sizePx, trackingEm, uppercase, nowrap, extraPx };
}

/** The self-closing children of a word's own span: what is painted beside its text. */
function childrenBeside(chain: Span[], spans: Span[]): Span[] {
  const inner = chain.at(-1)!;
  const deepestAround = (at: number) => spans.filter((s) => !s.selfClosing && s.open < at && at < s.close).at(-1);
  return spans.filter((s) => s.selfClosing && deepestAround(s.open) === inner);
}
/** A span's `w-<n>` / `h-<n>` in px, or undefined when it declares none. */
function spacingOf(span: Span, axis: "w" | "h", where: string): number | undefined {
  const m = tokensOf(span, where).map((t) => new RegExp(`^${axis}-([0-9.]+)$`).exec(t)).find(Boolean);
  return m ? spacingPx(Number(m[1])) : undefined;
}
/** A flex row's `gap-<n>` / `gap-x-<n>` in px (0 when it declares none). */
function gapOf(span: Span, where: string): number {
  const m = tokensOf(span, where).map((t) => /^gap-(?:x-)?([0-9.]+)$/.exec(t)).find(Boolean);
  return m ? spacingPx(Number(m[1])) : 0;
}

/** The narrowest box `text` fits in when painted with `type`. */
function measureIn(type: Typography, text: string): number {
  const face = faceFor(type.family, type.weight);
  const painted = type.uppercase ? text.toUpperCase() : text;
  const run = type.nowrap ? textWidth : minContentWidth;
  return run(face, painted, type.sizePx, type.trackingEm) + type.extraPx;
}

// ---- A child beside a word keeps its box (N1h h1, review-n1g G1) -----------
// The live chip is a flex ROW: a 6px dot, a gap, then the word. The gates
// above ask whether the word CAN fit (its min-content beside the dot); they
// do not ask how the row shares the squeeze. When the word's UNWRAPPED run and
// the dot are wider than the track together (fr "EN DIRECT"), the row shrinks
// every item that may shrink, in proportion to its basis — and a dot with no
// `shrink-0` has an automatic minimum of 0 (it has no content), so it gave up
// width with the word and painted as a 4.7×6px oval in fr.

/** A child's flex-shrink factor, read off its classes. */
function shrinkOf(child: Span, where: string): number {
  let factor = 1;
  for (const token of tokensOf(child, where)) {
    const base = utilityOf(token);
    let value: number | undefined;
    let m: RegExpExecArray | null;
    if (base === "shrink" || base === "flex-shrink") value = 1;
    else if ((m = /^(?:flex-)?shrink-([0-9]+)$/.exec(base))) value = Number(m[1]);
    else if (base === "flex-none") value = 0;
    else if (/^(flex-(?:1|auto|initial|[0-9]|\[)|basis-|min-w-|grow)/.test(base)) {
      throw new Error(`${where}: "${token}" changes how a child beside the text flexes, which this test cannot price yet`);
    }
    if (value === undefined) continue;
    if (token !== base && token.includes(":")) {
      throw new Error(`${where}: "${token}" changes flex-shrink behind a variant; measure that state too`);
    }
    factor = value;
  }
  return factor;
}

/**
 * The used width of each child beside `text` once the word's flex row is laid
 * out in the track: CSS Flexbox §9.7, shrinking only (nothing here grows).
 * - The row is a column-flex item of the cell, so it is fit-content in the
 *   track: its max-content, capped at the track, never below its min-content.
 *   (A stretched row gives the same children whenever the min-content gate
 *   holds.)
 * - Items: each child (basis its `w-<n>`, automatic minimum 0, its own shrink
 *   factor), then the text (basis its unwrapped run, minimum its min-content,
 *   factor 1), with the row's gap between each.
 * - Widths come from the same font reader as every other measurement here,
 *   which over-estimates text (no kerning): a squeeze is over-reported, never
 *   missed.
 */
function rowOf(type: Typography, inner: Span, children: Span[], text: string, track: number, where: string) {
  const bare: Typography = { ...type, extraPx: 0 };
  if (!tokensOf(inner, where).some((t) => t === "flex" || t === "inline-flex")) {
    throw new Error(`${where}: children are painted beside the text outside a flex row, which this test does not model`);
  }
  const items = [
    ...children.map((c) => {
      const w = spacingOf(c, "w", where);
      if (w === undefined) throw new Error(`${where}: a child painted beside the text has no w-<n> to measure`);
      return { basis: w, min: 0, shrink: shrinkOf(c, where) };
    }),
    { basis: measureIn({ ...bare, nowrap: true }, text), min: measureIn(bare, text), shrink: 1 },
  ];
  const gaps = gapOf(inner, where) * (items.length - 1);
  const sum = (f: (i: (typeof items)[number], k: number) => number) => items.reduce((a, i, k) => a + f(i, k), 0);
  const maxContent = gaps + sum((i) => i.basis);
  const minContent = gaps + sum((i, k) => (k < children.length ? i.basis : i.min));
  const row = Math.max(minContent, Math.min(maxContent, track));
  const size = items.map((i) => i.basis);
  const frozen = items.map((i) => i.shrink === 0);
  while (maxContent > row && frozen.includes(false)) {
    const open = items.flatMap((_, k) => (frozen[k] ? [] : [k]));
    const overflow = gaps + sum((i, k) => (frozen[k] ? size[k] : i.basis)) - row;
    const scaled = open.reduce((a, k) => a + items[k].shrink * items[k].basis, 0);
    if (scaled === 0) break;
    const violators: number[] = [];
    for (const k of open) {
      const target = items[k].basis - (overflow * items[k].shrink * items[k].basis) / scaled;
      size[k] = Math.max(target, items[k].min);
      if (size[k] > target) violators.push(k);
    }
    for (const k of violators.length > 0 ? violators : open) frozen[k] = true;
  }
  return { row, text: size.at(-1)!, children: size.slice(0, children.length) };
}

/** Every clock the rail can show: each minute of a day. */
const CLOCKS = Array.from({ length: 24 * 60 }, (_, i) =>
  timeOf(new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), "UTC"),
);

/** The texts a rail word can take in `locale`. */
async function valuesOf(what: string, locale: string): Promise<string[]> {
  if (what === "timeOf()") return CLOCKS;
  const key = what.slice("copy.".length);
  const value = ((await railCopy(locale)) as unknown as Record<string, unknown>)[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${locale}: the rail renders ${what}, which publicScheduleCopy gives no text`);
  }
  return [value];
}

/**
 * The run of one lower-case letter — alone, or twice with a space between, so
 * wrapping can matter — that fits the track by `lesser` and overflows it by
 * `gate`, with the widest margin either side.
 */
function separatingRun(track: number, lesser: (t: string) => number, gate: (t: string) => number) {
  let best: { text: string; margin: number } | undefined;
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    for (let n = 1; n <= 40; n++) {
      for (const text of [letter.repeat(n), `${letter.repeat(n)} ${letter.repeat(n)}`]) {
        const [a, b] = [lesser(text), gate(text)];
        if (a > track || b <= track) continue;
        const margin = Math.min(track - a, b - track);
        if (!best || margin > best.margin) best = { text, margin };
      }
    }
  }
  return best?.text;
}

describe("public Schedule rail — every translated word fits its column (N1f f1)", () => {
  it("declares a rail track and a rail that can wrap inside it, never over the name", () => {
    expect(railPx()).toBeGreaterThan(0);
    const { cell, words } = railWords(SCHEDULE_SRC);
    // The rail cell is a grid item: without `min-w-0` its automatic minimum is
    // its min-content width, so a long word makes the CELL wider than the
    // track and paints across the gap into the name. With it, the cell is the
    // track and `break-words` is the last resort that keeps a word that is
    // somehow still too long inside the column instead of over the name.
    expect(tokensOf(cell, "rail cell")).toContain("min-w-0");
    const timeLine = words.find((w) => w.what === "timeOf()");
    expect(timeLine, "the rail cell paints no clock").toBeDefined();
    expect(tokensOf(timeLine!.chain.at(-1)!, "time/status line")).toContain("break-words");
    // Nothing in the rail may truncate a status word (the ruling): the only
    // clipping allowed there is the court-name / date line below it. Checked
    // on EVERY span between the word and the cell, the cell included.
    const report: string[] = [];
    for (const w of words) {
      const clipping = w.chain.flatMap((s) => tokensOf(s, w.what).filter(clips));
      report.push(`${w.what} in [${tokensOf(w.chain.at(-1)!, w.what).join(" ")}]`);
      expect(clipping, `${w.what} is painted inside ${clipping.join(", ")}`).toEqual([]);
    }
    console.log(`[rail classes] ${report.join("  |  ")}`);
  });

  it("finds a clipping class first, last or behind a variant: class order is not meaning (N1g g2)", () => {
    const row = (statusClasses: string) =>
      `<Link className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto]">` +
      `<span aria-hidden className="absolute inset-y-0 w-0.5" />` +
      `<span className="min-w-0 flex">{/* copy.calendar */}<span className="${statusClasses}">{copy.ended}</span></span>` +
      `<span className="truncate">{name}</span></Link>`;
    const clipped = (statusClasses: string) =>
      railWords(row(statusClasses)).words.flatMap((w) => w.chain.flatMap((s) => tokensOf(s, w.what).filter(clips)));
    // The absolute bar takes no track, the comment is not markup, the name
    // cell's own `truncate` is outside the rail: one word, in the status span.
    expect(railWords(row("font-display")).words.map((w) => w.what)).toEqual(["copy.ended"]);
    expect(clipped("truncate font-display text-sm")).toEqual(["truncate"]);
    expect(clipped("font-display text-sm truncate")).toEqual(["truncate"]);
    expect(clipped("font-display max-sm:truncate text-sm")).toEqual(["max-sm:truncate"]);
    expect(clipped("whitespace-nowrap font-display")).toEqual(["whitespace-nowrap"]);
    expect(clipped("line-clamp-none font-display break-words")).toEqual([]);
    // N1h h3 (review-n1g m2): `white-space: pre` cannot wrap at all, and
    // `overflow-wrap: break-word` acts only where wrapping is allowed, so
    // `break-words` cannot rescue it. Any variant holds in SOME state, so it
    // counts too: a width (`sm:`), a child selector (`*:`), an arbitrary one.
    expect(clipped("font-display whitespace-pre break-words")).toEqual(["whitespace-pre"]);
    expect(clipped("whitespace-pre font-display")).toEqual(["whitespace-pre"]);
    expect(clipped("font-display sm:whitespace-nowrap")).toEqual(["sm:whitespace-nowrap"]);
    expect(clipped("font-display *:truncate")).toEqual(["*:truncate"]);
    expect(clipped("font-display md:*:whitespace-nowrap")).toEqual(["md:*:whitespace-nowrap"]);
    expect(clipped("font-display [&_span]:whitespace-pre")).toEqual(["[&_span]:whitespace-pre"]);
    // A `>` inside a class list (`[&>span]:`) ends the tag for this parser, so
    // it cannot read the list and REFUSES rather than passing it.
    expect(() => clipped("font-display [&>span]:whitespace-pre")).toThrow(/non-literal className/);
    // Every other white-space / text-wrap / break utility still WRAPS, so it
    // is not a clip (`whitespace-break-spaces` wraps too, but this suite
    // cannot price it: see `typographyOf`).
    for (const wraps of [
      "whitespace-normal",
      "whitespace-pre-line",
      "whitespace-pre-wrap",
      "whitespace-break-spaces",
      "text-wrap",
      "text-balance",
      "text-pretty",
      "break-all",
      "break-keep",
      "wrap-anywhere",
      "wrap-break-word",
    ]) {
      expect({ wraps, clipped: clipped(`font-display ${wraps}`) }).toEqual({ wraps, clipped: [] });
    }
  });

  it("fits every word the rail cell renders, in every locale, in the face and box it paints in (N1f f1, N1g g4)", async () => {
    const track = railPx();
    const { words, spans } = railWords(SCHEDULE_SRC);
    expect(words.length, "the rail cell renders no status word").toBeGreaterThan(0);
    const report: string[] = [];
    for (const locale of LOCALES) {
      for (const w of words) {
        const type = typographyOf(w.chain, spans, w.what);
        let widest = { text: "", px: -1 };
        for (const text of await valuesOf(w.what, locale)) {
          const px = measureIn(type, text);
          if (px > widest.px) widest = { text: type.uppercase ? text.toUpperCase() : text, px };
        }
        report.push(`${locale} ${w.what} ${JSON.stringify(widest.text)} ${widest.px.toFixed(1)}px / ${track}px`);
        expect(
          widest.px,
          `${locale}: ${w.what} ${JSON.stringify(widest.text)} needs ${widest.px.toFixed(1)}px in a ${track}px rail`,
        ).toBeLessThanOrEqual(track);
      }
    }
    // Print what was asserted, so a green run is not a silent one.
    expect(report.length).toBe(LOCALES.length * words.length);
    console.log(`[rail top line] ${report.join("  |  ")}`);
  });

  it("measures every minute a clock can show, and the widest is the widest HH:MM the face can draw (N1h h2, review-n1g m6)", async () => {
    // The clock is the one rail word whose values are enumerated rather than
    // read from a dictionary, and every minute fits with room to spare, so the
    // fit gate above cannot tell all 1440 clocks from one typed sample. Two
    // things can, and both read the values `valuesOf` hands that gate:
    // - they are every minute of a day, 24 x 60 distinct clocks;
    // - their widest measures the same as the widest HH:MM this face can draw,
    //   built from the widest hour (00-23) and the widest minute (00-59).
    //   Advances add, so no other pair is wider.
    const { words, spans } = railWords(SCHEDULE_SRC);
    const clock = words.find((w) => w.what === "timeOf()");
    expect(clock, "the rail cell paints no clock").toBeDefined();
    const type = typographyOf(clock!.chain, spans, clock!.what);
    const widestOf = (texts: string[]) =>
      texts.reduce((best, text) => {
        const px = measureIn(type, text);
        return px > best.px ? { text, px } : best;
      }, { text: "", px: -1 });
    const pad = (n: number) => String(n).padStart(2, "0");
    const hour = widestOf(Array.from({ length: 24 }, (_, h) => pad(h)));
    const minute = widestOf(Array.from({ length: 60 }, (_, m) => pad(m)));
    const drawable = `${hour.text}:${minute.text}`;
    const seen: string[] = [];
    for (const locale of LOCALES) {
      const values = await valuesOf(clock!.what, locale);
      expect(new Set(values).size, `${locale}: distinct clocks measured`).toBe(24 * 60);
      const measured = widestOf(values);
      expect(
        measured.px,
        `${locale}: the widest clock measured is ${JSON.stringify(measured.text)}, the widest this face can draw is ${JSON.stringify(drawable)}`,
      ).toBeCloseTo(measureIn(type, drawable), 6);
      seen.push(`${locale} ${values.length} clocks, widest ${JSON.stringify(measured.text)} ${measured.px.toFixed(2)}px`);
    }
    console.log(`[rail clock] drawable ${JSON.stringify(drawable)} ${measureIn(type, drawable).toFixed(2)}px  |  ${seen.join("  |  ")}`);
  });

  it("never lets the row shrink a child painted beside a rail word: its class SET holds shrink-0 (N1h h1, review-n1g G1)", () => {
    // A bare `shrink-0` anywhere in the list. `max-sm:shrink-0` holds at some
    // widths only, so it does not count.
    const holdsShrink0 = (child: Span, where: string) => new Set(tokensOf(child, where)).has("shrink-0");
    const { words, dates, spans } = railWords(SCHEDULE_SRC);
    const seen: string[] = [];
    for (const w of [...words, ...dates]) {
      for (const child of childrenBeside(w.chain, spans)) {
        const tokens = tokensOf(child, w.what);
        seen.push(`${w.what}: [${tokens.join(" ")}]`);
        expect(holdsShrink0(child, w.what), `${w.what}: the child beside it is [${tokens.join(" ")}], which its row may shrink`).toBe(true);
      }
    }
    expect(seen.length, "no rail word has a child beside it, so this guards nothing").toBeGreaterThan(0);
    const synthetic = (dotClasses: string) => {
      const row = railWords(
        `<Link className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto]"><span className="min-w-0">` +
          `<span className="flex gap-1 text-[11px]"><span className="${dotClasses}" />{copy.live}</span></span></Link>`,
      );
      return row.words.flatMap((w) => childrenBeside(w.chain, row.spans).map((c) => holdsShrink0(c, "synthetic")));
    };
    expect(synthetic("shrink-0 h-1.5 w-1.5")).toEqual([true]);
    expect(synthetic("h-1.5 w-1.5 shrink-0")).toEqual([true]);
    expect(synthetic("h-1.5 w-1.5 max-sm:shrink-0")).toEqual([false]);
    expect(synthetic("h-1.5 w-1.5")).toEqual([false]);
    console.log(`[rail children] ${seen.join("  |  ")}`);
  });

  it("keeps the live dot round in every locale: the chip's row squeezes the word, never the dot (N1h h1, review-n1g G1)", async () => {
    const track = railPx();
    const { words, spans } = railWords(SCHEDULE_SRC);
    const report: string[] = [];
    let tightest: { line: string; need: number } | undefined;
    for (const w of words) {
      const children = childrenBeside(w.chain, spans);
      if (children.length === 0) continue;
      const type = typographyOf(w.chain, spans, w.what);
      const inner = w.chain.at(-1)!;
      const square = children.map((child) => {
        const [width, height] = [spacingOf(child, "w", w.what), spacingOf(child, "h", w.what)];
        expect(height, `${w.what}: the premise, the child beside it declares a height`).toBeDefined();
        expect(width, `${w.what}: the premise, the child beside it is as wide as it is tall`).toBe(height);
        return height!;
      });
      const check = (text: string, label: string, cs: Span[] = children) => {
        const laid = rowOf(type, inner, cs, text, track, w.what);
        const painted = JSON.stringify(type.uppercase ? text.toUpperCase() : text);
        const line = `${label} ${w.what} ${painted}: child ${laid.children.map((c, k) => `${c.toFixed(2)}x${square[k]}`).join(", ")}px, word ${laid.text.toFixed(1)}px, row ${laid.row.toFixed(1)}px / ${track}px`;
        return { laid, line };
      };
      for (const locale of LOCALES) {
        for (const text of await valuesOf(w.what, locale)) {
          const { laid, line } = check(text, locale);
          report.push(line);
          laid.children.forEach((c, k) => expect(c, `${line}: the row squeezed the child out of round`).toBeCloseTo(square[k], 6));
          const need = measureIn({ ...type, nowrap: true }, text);
          if (!tightest || need > tightest.need) tightest = { line, need };
        }
      }
      // The positive pair, on a run built from the face rather than typed: one
      // that overflows the track unwrapped but fits wrapped. With shrink-0 taken
      // off, this model MUST see the child squeezed — so a green above is the
      // class holding the dot, not a model that cannot see a squeeze.
      const run = separatingRun(track, (t) => measureIn(type, t), (t) => measureIn({ ...type, nowrap: true }, t));
      expect(run, `${w.what}: no run overflows the track unwrapped yet fits wrapped`).toBeDefined();
      const loose = children.map((c) => ({ ...c, classes: new Set([...(c.classes ?? [])].filter((t) => t !== "shrink-0")) }));
      const held = check(run!, "derived");
      const squeezed = check(run!, "derived, shrink-0 removed", loose);
      held.laid.children.forEach((c, k) => expect(c, `${held.line}: the row squeezed the child`).toBeCloseTo(square[k], 6));
      squeezed.laid.children.forEach((c, k) =>
        expect(c, `${squeezed.line}: the model cannot see a squeeze`).toBeLessThan(square[k] - 0.1),
      );
      report.push(held.line, squeezed.line);
    }
    expect(tightest, "no rail word has a child beside it, so this guards nothing").toBeDefined();
    console.log(`[rail dot] tightest: ${tightest!.line}  ||  ${report.join("  |  ")}`);
  });

  it("reads typography off a word's classes, priced from Tailwind's theme (N1g g4)", () => {
    const row = (chipClasses: string) =>
      `<Link className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto]"><span className="min-w-0 text-sm">` +
      `<span className="${chipClasses}"><span className="h-1.5 w-1.5 rounded-full" />{copy.live}</span>` +
      `<span className="font-display font-semibold">{copy.ended}</span>` +
      `<span className="truncate text-[10px]">{shortDate(x)}</span></span></Link>`;
    const typed = (chipClasses: string) => {
      const { words, dates, spans } = railWords(row(chipClasses));
      return [...words, ...dates].map((w) => typographyOf(w.chain, spans, w.what));
    };
    const [live, ended, date] = typed("flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide");
    expect(live).toEqual({
      family: "body",
      weight: themeNumber("font-weight-bold"),
      sizePx: 11,
      trackingEm: themeNumber("tracking-wide"),
      uppercase: true,
      nowrap: false,
      extraPx: spacingPx(1.5) + spacingPx(1),
    });
    // `text-sm` is inherited from the cell; nothing here says a weight for the date.
    expect(ended).toEqual({
      family: "display",
      weight: themeNumber("font-weight-semibold"),
      sizePx: themeNumber("text-sm"),
      trackingEm: 0,
      uppercase: false,
      nowrap: false,
      extraPx: 0,
    });
    expect(date).toEqual({
      family: "body",
      weight: themeNumber("font-weight-normal"),
      sizePx: 10,
      trackingEm: 0,
      uppercase: false,
      nowrap: true,
      extraPx: 0,
    });
    expect(() => typed("flex gap-1 text-[11px] max-sm:text-[13px]")).toThrow(/behind a variant/);
    expect(() => typed("flex gap-1 text-[11px] tracking-[0.2em]")).toThrow(/cannot price/);
    // N1h h3 (review-n1g m2): `whitespace-pre` cannot wrap, so the whole run
    // is measured; `whitespace-pre-line` wraps. `whitespace-break-spaces`
    // wraps too, but its spaces do not hang: a word keeps the width of the
    // space after it, which the per-word min-content measure leaves out (an
    // UNDER-estimate), so it is refused rather than guessed.
    expect(typed("flex gap-1 text-[11px] whitespace-pre")[0].nowrap).toBe(true);
    expect(typed("flex gap-1 text-[11px] whitespace-pre-line")[0].nowrap).toBe(false);
    expect(() => typed("flex gap-1 text-[11px] whitespace-break-spaces")).toThrow(/cannot price/);
  });

  it("files every face under the weight it IS, so a weight cannot be measured in another's file (N1g g3)", () => {
    for (const [family, byWeight] of Object.entries(FACES)) {
      for (const [weight, face] of Object.entries(byWeight)) {
        expect(face.weightClass, `${family} ${weight} is ${face.name}`).toBe(Number(weight));
      }
    }
  });

  it("refuses a run that fits only when measured lighter than it paints: lighter face, no dot, lower case, or wrapping (N1g g3, g4)", () => {
    // Built from the faces, not typed: for every word and date the rail paints
    // at a weight that has a lighter committed face, beside a fixed-width
    // child, in upper case, or unable to wrap, the run that fits the track
    // WITHOUT that and overflows WITH it. The gate the measurements use must
    // refuse it — so measuring the bold chip in a regular face, forgetting its
    // dot and gap, its case, or the date line's `truncate`, goes red.
    const track = railPx();
    const { words, dates, spans } = railWords(SCHEDULE_SRC);
    const seen: string[] = [];
    for (const w of [...words, ...dates]) {
      const type = typographyOf(w.chain, spans, w.what);
      const lighter: [string, Typography][] = [];
      const normal = themeNumber("font-weight-normal");
      if (type.weight !== normal && FACES[type.family][normal]) {
        lighter.push([`weight ${type.weight} measured as ${normal}`, { ...type, weight: normal }]);
      }
      if (type.extraPx > 0) lighter.push([`the ${type.extraPx}px beside it dropped`, { ...type, extraPx: 0 }]);
      if (type.uppercase) lighter.push(["its upper case dropped", { ...type, uppercase: false }]);
      if (type.nowrap) lighter.push(["allowed to wrap", { ...type, nowrap: false }]);
      for (const [what, lesser] of lighter) {
        const run = separatingRun(track, (t) => measureIn(lesser, t), (t) => measureIn(type, t));
        expect(run, `${w.what}: the gate measures it the same with ${what}`).toBeDefined();
        expect(measureIn(lesser, run!), `${w.what}: the premise, ${JSON.stringify(run)} fits with ${what}`).toBeLessThanOrEqual(
          track,
        );
        expect(measureIn(type, run!), `${w.what}: ${JSON.stringify(run)} must be refused`).toBeGreaterThan(track);
        seen.push(
          `${w.what}, ${what}: ${JSON.stringify(run)} ${measureIn(lesser, run!).toFixed(2)} -> ${measureIn(type, run!).toFixed(2)}px / ${track}px`,
        );
      }
    }
    expect(seen.length, "no rail word is bold, beside a dot, upper-cased or unwrappable, so these sentinels guard nothing").toBeGreaterThan(0);
    console.log(`[rail sentinels] ${seen.join("  |  ")}`);
  });
});

describe("public Schedule rail — the round view's short date (N1f f3)", () => {
  it("carries no weekday, in any locale", () => {
    for (const locale of LOCALES) {
      const tag = intlLocaleFor(locale);
      for (let month = 0; month < 12; month++) {
        const iso = new Date(Date.UTC(2026, month, 24, 12)).toISOString();
        const expected = new Date(`2026-${String(month + 1).padStart(2, "0")}-24T12:00`).toLocaleDateString(
          tag,
          { day: "numeric", month: "short" },
        );
        expect(shortDate(iso, "UTC", tag), `${locale} month ${month + 1}`).toBe(expected);
      }
    }
  });

  it("fits the rail track in every locale, on every month", () => {
    const track = railPx();
    const { dates, spans } = railWords(SCHEDULE_SRC);
    expect(dates.length, "the rail cell renders no short date").toBeGreaterThan(0);
    const worst: string[] = [];
    for (const d of dates) {
      const type = typographyOf(d.chain, spans, d.what);
      for (const locale of LOCALES) {
        const tag = intlLocaleFor(locale);
        let max = 0;
        let arg = "";
        for (let month = 0; month < 12; month++) {
          for (const day of [1, 20, 24, 28]) {
            const label = shortDate(new Date(Date.UTC(2026, month, day, 12)).toISOString(), "UTC", tag);
            const width = measureIn(type, label);
            if (width > max) {
              max = width;
              arg = type.uppercase ? label.toUpperCase() : label;
            }
          }
        }
        worst.push(`${locale} ${JSON.stringify(arg)} ${max.toFixed(1)}px / ${track}px`);
        expect(max, `${locale}: ${JSON.stringify(arg)} needs ${max.toFixed(1)}px in a ${track}px rail`).toBeLessThanOrEqual(
          track,
        );
      }
    }
    expect(worst.length).toBe(LOCALES.length * dates.length);
    console.log(`[rail date] ${worst.join("  |  ")}`);
  });
});
