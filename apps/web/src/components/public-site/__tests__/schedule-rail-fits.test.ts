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
// component's own Tailwind class. Expected values are derived end to end:
// the strings come from `publicScheduleCopy`, the builder BOTH production
// callers use, and the date from the component's own exported formatter.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getDictionary } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { toLocale } from "@/lib/i18n-constants";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { dateTagFor, shortDate } from "../schedule";
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
const GEIST_400 = openFace(path.join(FONTS, "Geist-Regular.ttf"), "Geist Regular");
const GEIST_700 = openFace(path.join(FONTS, "Geist-Bold.ttf"), "Geist Bold");
const FACES: Record<"display" | "body", Record<number, Face>> = {
  display: { 600: openFace(path.join(FONTS, "BarlowCondensed-SemiBold.ttf"), "Barlow Condensed SemiBold") },
  body: { 400: GEIST_400, 700: GEIST_700 },
};
function faceFor(family: "display" | "body", weight: number): Face {
  const face = FACES[family][weight];
  if (!face) throw new Error(`no committed ${family} face at weight ${weight}: add the file before measuring in it`);
  return face;
}

// The live chip: `text-[11px] font-bold uppercase tracking-wide` on the body
// face, after its `h-1.5 w-1.5` dot and `gap-1` (6px + 4px).
const LIVE_DOT_AND_GAP = 10;
const chipWidthIn = (face: Face, text: string) => minContentWidth(face, text, 11, 0.025) + LIVE_DOT_AND_GAP;
const liveChipWidth = (text: string) => chipWidthIn(faceFor("body", 700), text);

/** The rail track, in px, read from the row grid the component declares. */
function railPx(): number {
  const m = /grid-cols-\[([0-9.]+)rem_minmax\(0,1fr\)_auto\]/.exec(SCHEDULE_SRC);
  if (!m) throw new Error("could not find the scorebug row's grid-cols track in schedule.tsx");
  return Number(m[1]) * 16; // Tailwind rem against the default 16px root
}

const LOCALES = ["en", "es", "fr", "nl"] as const;

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
/** Does this class token clip text? Variants (`max-sm:`) and `!` are stripped first. */
const clips = (token: string) => {
  const base = token.slice(token.lastIndexOf(":") + 1).replace(/^!|!$/g, "");
  return CLIPPING.has(base) || /^line-clamp-(?!none$)/.test(base);
};

interface Span {
  /** The class tokens, or null when `className` is not a string literal. */
  classes: Set<string> | null;
  open: number;
  close: number;
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
    };
    if (!cell && stack.length === 0 && !span.classes?.has("absolute")) cell = span;
    if (cell) spans.push(span);
    if (m[1].trimEnd().endsWith("/")) {
      if (span === cell) return { text, cell, spans };
    } else {
      stack.push(span);
    }
  }
  throw new Error("the rail cell never closes");
}

/**
 * Every place the rail cell paints a status word — each `copy.<key>` and each
 * `timeOf(` inside it — with the chain of spans around it, outermost (the
 * cell) first. The court/date line's `shortDate(` is not a status word.
 */
function railWords(source: string) {
  const { text, cell, spans } = railCell(source);
  const inCell = text.slice(cell.open, cell.close);
  const words = [...inCell.matchAll(/\bcopy\.(\w+)|\btimeOf\(/g)].map((m) => {
    const at = cell.open + (m.index ?? 0);
    return {
      what: m[1] ? `copy.${m[1]}` : "timeOf()",
      chain: spans.filter((s) => s.open < at && at < s.close),
    };
  });
  return { cell, words };
}

const tokensOf = (s: Span, where: string): string[] => {
  if (!s.classes) throw new Error(`${where}: a span has a non-literal className, which this guard cannot read`);
  return [...s.classes];
};

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

  it("fits every locale's Live / Ended / TBD and a clock inside the rail track", async () => {
    const track = railPx();
    const report: string[] = [];
    for (const locale of LOCALES) {
      const copy = await railCopy(locale);
      // The status/time line is `font-display text-sm font-semibold` -> the
      // display face at 14px, weight 600. The live chip: `liveChipWidth`.
      const display = faceFor("display", 600);
      const cases: [string, number][] = [
        [copy.ended, minContentWidth(display, copy.ended, 14)],
        [copy.tbd, minContentWidth(display, copy.tbd, 14)],
        ["14:30", textWidth(display, "14:30", 14)],
        [copy.live.toUpperCase(), liveChipWidth(copy.live.toUpperCase())],
      ];
      for (const [word, width] of cases) {
        report.push(`${locale} ${JSON.stringify(word)} ${width.toFixed(1)}px / ${track}px`);
        expect(
          width,
          `${locale}: ${JSON.stringify(word)} needs ${width.toFixed(1)}px in a ${track}px rail`,
        ).toBeLessThanOrEqual(track);
      }
    }
    // Print what was asserted, so a green run is not a silent one.
    expect(report.length).toBe(LOCALES.length * 4);
    console.log(`[rail top line] ${report.join("  |  ")}`);
  });

  it("files every face under the weight it IS, so a weight cannot be measured in another's file (N1g g3)", () => {
    for (const [family, byWeight] of Object.entries(FACES)) {
      for (const [weight, face] of Object.entries(byWeight)) {
        expect(face.weightClass, `${family} ${weight} is ${face.name}`).toBe(Number(weight));
      }
    }
  });

  it("measures the live chip in the BOLD body face: a word that fits in Geist 400 but not 700 is refused (N1g g3)", () => {
    const track = railPx();
    // Built from the faces, not typed: the one-letter run, at the chip's own
    // typography, that fits the track in the regular file and overflows it in
    // the bold one — the widest margin on both sides of the track wins.
    let sentinel: { text: string; margin: number } | undefined;
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      for (let n = 1; n <= 24; n++) {
        const text = letter.repeat(n);
        const regular = chipWidthIn(GEIST_400, text);
        const bold = chipWidthIn(GEIST_700, text);
        if (regular > track || bold <= track) continue;
        const margin = Math.min(track - regular, bold - track);
        if (!sentinel || margin > sentinel.margin) sentinel = { text, margin };
      }
    }
    expect(sentinel, `no one-letter run separates Geist 400 from 700 at ${track}px`).toBeDefined();
    const { text } = sentinel!;
    const regular = chipWidthIn(GEIST_400, text);
    // The premise: in a regular face this word would pass the gate…
    expect(regular).toBeLessThanOrEqual(track);
    // …and the gate the locale loop uses refuses it.
    expect(liveChipWidth(text), `${JSON.stringify(text)}: ${regular.toFixed(2)}px regular`).toBeGreaterThan(track);
    console.log(
      `[rail chip face] ${JSON.stringify(text)} regular ${regular.toFixed(2)}px, chip gate ${liveChipWidth(text).toFixed(2)}px / ${track}px`,
    );
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
    const worst: string[] = [];
    for (const locale of LOCALES) {
      const tag = dateTagFor(locale);
      let max = 0;
      let arg = "";
      for (let month = 0; month < 12; month++) {
        for (const day of [1, 20, 24, 28]) {
          const iso = new Date(Date.UTC(2026, month, day, 12)).toISOString();
          // `text-[10px] uppercase tracking-wide` on the body face.
          const label = shortDate(iso, "UTC", tag).toUpperCase();
          const width = textWidth(faceFor("body", 400), label, 10, 0.025);
          if (width > max) {
            max = width;
            arg = label;
          }
        }
      }
      worst.push(`${locale} ${JSON.stringify(arg)} ${max.toFixed(1)}px / ${track}px`);
      expect(max, `${locale}: ${JSON.stringify(arg)} needs ${max.toFixed(1)}px in a ${track}px rail`).toBeLessThanOrEqual(
        track,
      );
    }
    expect(worst.length).toBe(LOCALES.length);
    console.log(`[rail date] ${worst.join("  |  ")}`);
  });
});
