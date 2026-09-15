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
// column inside an `overflow-hidden` list, so a word that does not fit is
// clipped SILENTLY, and this suite is the only guard against it.
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
import { dateTagFor, shortDate, timeOf } from "../schedule";
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

/** Utilities that make a status word disappear instead of wrapping. */
const CLIPPING = new Set([
  "truncate",
  "text-ellipsis",
  "text-clip",
  "whitespace-nowrap",
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
      else if (base === "truncate" || base === "whitespace-nowrap" || base === "text-nowrap") apply = () => (nowrap = true);
      else if (/^(font-(mono|serif)$|lowercase$|capitalize$|tracking-\[|text-\[)/.test(base)) {
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
  const inner = chain.at(-1)!;
  const deepestAround = (at: number) => spans.filter((s) => !s.selfClosing && s.open < at && at < s.close).at(-1);
  let extraPx = 0;
  for (const child of spans.filter((s) => s.selfClosing && deepestAround(s.open) === inner)) {
    const w = tokensOf(child, where).map((t) => /^w-([0-9.]+)$/.exec(t)).find(Boolean);
    if (!w) throw new Error(`${where}: a child painted beside the text has no w-<n> to measure`);
    const gap = tokensOf(inner, where).map((t) => /^gap-(?:x-)?([0-9.]+)$/.exec(t)).find(Boolean);
    extraPx += spacingPx(Number(w[1])) + (gap ? spacingPx(Number(gap[1])) : 0);
  }
  return { family, weight, sizePx, trackingEm, uppercase, nowrap, extraPx };
}

/** The narrowest box `text` fits in when painted with `type`. */
function measureIn(type: Typography, text: string): number {
  const face = faceFor(type.family, type.weight);
  const painted = type.uppercase ? text.toUpperCase() : text;
  const run = type.nowrap ? textWidth : minContentWidth;
  return run(face, painted, type.sizePx, type.trackingEm) + type.extraPx;
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
      const tag = dateTagFor(locale);
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
        const tag = dateTagFor(locale);
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
