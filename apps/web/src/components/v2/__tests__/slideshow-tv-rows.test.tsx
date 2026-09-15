// K-2 (visual gate, 2026-09-15) — on a TV the kiosk's "Coming up" rows cut
// entrant names while the same row had empty space beside them.
//
// What went wrong. Each row centred on a fixed "vs" axis: the two name columns
// were `minmax(0,1fr)`, equal halves whatever the names were. "North Harbour
// Rovers" was cut in its half while "West", in the other half, left most of
// its own empty. And at 1920 the slide was capped at `max-w-6xl` (1152px), so
// the final ("Winner of Semi-finals, match 1" vs "... match 2") was cut with
// 768px of the TV unused beside the slide.
//
// What this suite measures. `apps/web` vitest has no layout, so it prices the
// row the way a browser would, from the board's OWN rendered classes (tracks,
// padding, gaps, text sizes, the slide cap and its breakpoint), Tailwind's own
// theme, and the committed display face (`public-site/__tests__/font-advance.ts`),
// then applies CSS grid's track sizing for the two track kinds the row can
// hold. Nothing about the row is typed in here except the names, which are the
// capture harness's seed, one realistic 43-character name, and the dictionary's
// own feeder label.
//
// What it cannot see, and the capture harness (kiosk-shots.cjs) and the kiosk
// e2e exist for: a real browser's layout, kerning (unkerned widths are an
// over-estimate, the safe direction for "fits"), team badges (these rows have
// none; a badge adds its 40px and a 12px gap to that side's content), and how
// the stretched free space LOOKS. With content-sized name tracks the "vs" is no
// longer on one shared axis down the list: it sits between its own two names.
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { Slideshow } from "@/components/v2/slideshow";
import type { FixtureSlideItem, Slide } from "@/server/slideshow-data";
import { slideshowLabels } from "@/server/slideshow-labels";
import { getDictionary } from "@/lib/i18n";
import { t } from "@/lib/i18n-runtime";
import { openFace, textWidth, type Face } from "@/components/public-site/__tests__/font-advance";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../../../..");
const FONTS = path.join(WEB, "assets/fonts");
// `font-display` on the kiosk is Barlow Condensed (both kiosk layouts mount it
// as `--ps-font-display`); a weight is a different file.
const DISPLAY: Record<number, Face> = {
  600: openFace(path.join(FONTS, "BarlowCondensed-SemiBold.ttf"), "Barlow Condensed SemiBold"),
  700: openFace(path.join(FONTS, "BarlowCondensed-Bold.ttf"), "Barlow Condensed Bold"),
};

// ---- Tailwind's theme, as the rail test reads it -----------------------------
const THEME_CSS = [
  path.join(path.dirname(createRequire(import.meta.url).resolve("tailwindcss/package.json")), "theme.css"),
  path.join(WEB, "src/app/globals.css"),
].map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));

/** A theme length in px (rem at 16px). A later declaration wins, as in the cascade. */
function themePx(name: string): number {
  let raw: string | undefined;
  for (const css of THEME_CSS) {
    for (const m of css.matchAll(new RegExp(`(?:^|[\\s;{])--${name}:\\s*([^;}]+)`, "g"))) raw = m[1]!.trim();
  }
  if (raw === undefined) throw new Error(`the theme declares no --${name}`);
  return lengthPx(raw);
}
function lengthPx(raw: string): number {
  const v = /^([0-9.]+)(rem|px)$/.exec(raw);
  if (!v) throw new Error(`"${raw}" is not a length this test can price`);
  return v[2] === "rem" ? Number(v[1]) * 16 : Number(v[1]);
}
const spacingPx = (steps: string) => Number(steps) * themePx("spacing");

// ---- The board's rendered classes -------------------------------------------
const board = (slide: Slide) =>
  renderToStaticMarkup(createElement(Slideshow, { title: "Cup", slides: [slide], backHref: "/", labels: slideshowLabels("en") }));

/** Class tokens of the first element whose class list satisfies `pick`. */
function classesWhere(html: string, pick: (tokens: string[]) => boolean, what: string): string[] {
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    const tokens = m[1]!.split(/\s+/).filter(Boolean);
    if (pick(tokens)) return tokens;
  }
  throw new Error(`no ${what} in the rendered board`);
}
/** Class tokens of the element wrapping exactly `text`. */
function classesAround(html: string, text: string): string[] {
  const m = new RegExp(`class="([^"]*)">${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</`).exec(html);
  if (!m) throw new Error(`no element wrapping "${text}"`);
  return m[1]!.split(/\s+/).filter(Boolean);
}
const one = (tokens: string[], re: RegExp, what: string): RegExpExecArray => {
  const hits = tokens.map((tk) => re.exec(tk)).filter((m): m is RegExpExecArray => m !== null);
  if (hits.length !== 1) throw new Error(`expected one ${what} class, saw ${hits.length} in "${tokens.join(" ")}"`);
  return hits[0]!;
};

type Track = { kind: "fixed"; px: number } | { kind: "need" } | { kind: "fr" } | { kind: "content" } | { kind: "auto" };

/** `grid-cols-[...]` as tracks. `repeat(n,x)` is expanded. Anything else refuses. */
function tracksOf(tokens: string[]): Track[] {
  const template = one(tokens, /^grid-cols-\[(.+)\]$/, "grid-cols-[…]")[1]!;
  return template.split("_").flatMap((raw): Track[] => {
    const rep = /^repeat\((\d+),(.+)\)$/.exec(raw);
    if (rep) return Array.from({ length: Number(rep[1]) }, () => trackOf(rep[2]!));
    return [trackOf(raw)];
  });
}
function trackOf(raw: string): Track {
  if (/^[0-9.]+(rem|px)$/.test(raw)) return { kind: "fixed", px: lengthPx(raw) };
  if (raw === "minmax(0,auto)") return { kind: "need" };
  if (raw === "minmax(0,1fr)") return { kind: "fr" };
  if (raw === "max-content") return { kind: "content" };
  if (raw === "auto") return { kind: "auto" };
  throw new Error(`track "${raw}" is not one this model prices: re-derive it`);
}
/** Under `justify-content: normal`, an `auto`-max track and an `fr` track both take free space. */
const grows = (tr: Track) => tr.kind === "need" || tr.kind === "fr" || tr.kind === "auto";

/** The slide's width at a viewport: the main's padding, then the slide cap in force at that width. */
function slideWidth(html: string, vw: number): number {
  const main = classesWhere(html, (tk) => tk.includes("flex-1") && tk.some((c) => /^px-\d+$/.test(c)), "board <main>");
  const pad = spacingPx(one(main, /^px-(\d+)$/, "main px")[1]!);
  const wrapper = classesWhere(html, (tk) => tk.includes("animate-slide-in"), "slide wrapper");
  let cap = Infinity;
  let capFrom = -1;
  for (const token of wrapper) {
    const m = /^(?:([a-z0-9]+):)?max-w-(?:\[([^\]]+)\]|([a-z0-9]+))$/.exec(token);
    if (!m) continue;
    const from = m[1] ? themePx(`breakpoint-${m[1]}`) : 0;
    if (vw < from || from < capFrom) continue;
    cap = m[2] ? lengthPx(m[2]) : themePx(`container-${m[3]}`);
    capFrom = from;
  }
  return Math.min(vw - 2 * pad, cap);
}

interface RowFit {
  homeCut: boolean;
  awayCut: boolean;
  /** Space inside the name tracks that neither name uses. */
  unused: number;
}

/** One fixtures row at a viewport, priced from the rendered row. */
function fitRow(html: string, vw: number, home: string, away: string, tracksOverride?: Track[]): RowFit {
  const li = classesWhere(html, (tk) => tk.includes("grid") && tk.some((c) => c.startsWith("grid-cols-[")), "row grid");
  const tracks = tracksOverride ?? tracksOf(li);
  if (tracks.length !== 5) throw new Error(`the row grid has ${tracks.length} tracks, not round|home|vs|away|status: re-derive this model`);
  const rowPad = spacingPx(one(li, /^px-(\d+(?:\.\d+)?)$/, "row px")[1]!);
  const gap = spacingPx(one(li, /^gap-x-(\d+)$/, "row gap-x")[1]!);

  const labels = slideshowLabels("en");
  const vsCell = classesAround(html, labels.vs);
  const vsPx =
    textWidth(DISPLAY[weightOf(vsCell)]!, labels.vs, themePx(`text-${one(vsCell, /^text-(\d?xl|lg|base|sm)$/, "vs size")[1]}`)) +
    2 * spacingPx(one(vsCell, /^px-(\d+)$/, "vs px")[1]!);
  const cell = nameCellOf(html, home);
  if (!cell) throw new Error(`no name cell wrapping "${home}"`);
  const namePx = themePx(`text-${one(cell, /^text-(\d?xl|lg|base|sm)$/, "name size")[1]}`);
  const face = DISPLAY[weightOf(cell)]!;
  const hw = textWidth(face, home, namePx);
  const aw = textWidth(face, away, namePx);

  const fixed = [tracks[0]!, tracks[4]!].reduce((a, tr) => {
    if (tr.kind !== "fixed") throw new Error("the round and status columns are no longer fixed: re-derive this model");
    return a + tr.px;
  }, 0);
  const avail = slideWidth(html, vw) - 2 * rowPad - fixed - vsPx - 4 * gap;
  const [h, a] = [tracks[1]!, tracks[3]!];
  let ht: number;
  let at: number;
  if (h.kind === "fr" && a.kind === "fr") {
    ht = at = avail / 2;
  } else if (h.kind === "need" && a.kind === "need") {
    // Base 0, growth limit max-content: free space is shared equally until a
    // track reaches its content, and the rest goes to the other.
    const half = avail / 2;
    if (hw + aw <= avail) [ht, at] = [hw, aw];
    else if (hw <= half) [ht, at] = [hw, avail - hw];
    else if (aw <= half) [ht, at] = [avail - aw, aw];
    else [ht, at] = [half, half];
  } else {
    throw new Error(`name tracks ${h.kind}/${a.kind}: this model prices fr/fr and minmax(0,auto) pairs only`);
  }
  const homeCut = hw > ht + 0.5;
  const awayCut = aw > at + 0.5;
  return { homeCut, awayCut, unused: Math.max(0, ht - Math.min(hw, ht)) + Math.max(0, at - Math.min(aw, at)) };
}
/** The name cell: the flex span that wraps the truncating name span. */
function nameCellOf(html: string, name: string): string[] | null {
  const m = new RegExp(`<span class="([^"]*)"><span class="[^"]*\\btruncate\\b[^"]*">${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`).exec(html);
  return m ? m[1]!.split(/\s+/).filter(Boolean) : null;
}
function weightOf(tokens: string[]): number {
  if (tokens.includes("font-bold")) return 700;
  if (tokens.includes("font-semibold")) return 600;
  throw new Error(`no priced weight in "${tokens.join(" ")}"`);
}

// ---- The rows ----------------------------------------------------------------
const item = (home: string, away: string, roundName?: string): FixtureSlideItem => ({
  home,
  away,
  homeLogo: null,
  awayLogo: null,
  line: null,
  status: "scheduled",
  round: 1,
  ...(roundName === undefined ? {} : { roundName }),
});
const fixtures = (home: string, away: string, named: boolean): Slide => ({
  kind: "fixtures",
  division: "Cup",
  title: "Coming up",
  items: [item(home, away, named ? "Semi-finals" : undefined)],
});

/** A realistic long entrant name (AGENTS.md: the one that found the phone overflow). */
const LONG43 = "Northern Harbour Rovers Football Club U18 A";

async function pairs(): Promise<[string, string][]> {
  const [ui, pub] = await Promise.all([getDictionary("en", "ui"), getDictionary("en", "public")]);
  const round = t(ui, "bracket.round.semi");
  const feeder = (seq: number) => t(pub, "knockout.feederWinner", { round, seq });
  expect(feeder(1).startsWith("knockout."), "the feeder key resolves").toBe(false);
  return [
    ["North Harbour Rovers", "West"], // kiosk-shots.cjs seed
    [feeder(1), feeder(2)], // the final between two unplayed semi-finals
    [LONG43, "West"],
    [LONG43, LONG43],
  ];
}

const VARIANTS = [
  { name: "public kiosk row (round name)", named: true },
  { name: "organiser board row (round code)", named: false },
] as const;

const tvWidths = () => [themePx("breakpoint-lg"), 1280, themePx("breakpoint-2xl"), 1920, 2560];

describe("K-2: the kiosk's Coming up row gives its free space to the names", () => {
  it.each(VARIANTS)("$name: the two name tracks grow to their content, and nothing else in the row grows", ({ named }) => {
    const html = board(fixtures("North Harbour Rovers", "West", named));
    const li = classesWhere(html, (tk) => tk.includes("grid") && tk.some((c) => c.startsWith("grid-cols-[")), "row grid");
    const tracks = tracksOf(li);
    expect(tracks.map((tr) => tr.kind)).toHaveLength(5);
    expect([tracks[1]!.kind, tracks[3]!.kind], "home and away are content-sized, not equal fr halves").toEqual(["need", "need"]);
    expect(
      tracks.flatMap((tr, i) => (grows(tr) ? [i] : [])),
      "only the name tracks take free space (a growing vs or fixed column takes it from the names)",
    ).toEqual([1, 3]);
  });

  it.each(VARIANTS)("$name: at every TV width, a cut name never sits beside unused space in its row", async ({ named }) => {
    const found: string[] = [];
    for (const [home, away] of await pairs()) {
      const html = board(fixtures(home, away, named));
      for (const vw of tvWidths()) {
        const fit = fitRow(html, vw, home, away);
        if ((fit.homeCut || fit.awayCut) && fit.unused > 1) found.push(`${vw}: "${home}" | "${away}" cut with ${fit.unused.toFixed(0)}px unused`);
      }
    }
    expect(found, `cut beside unused space:\n${found.join("\n")}`).toEqual([]);
  });

  it("the probe can see K-2: the same public row with equal fr halves cuts North Harbour Rovers beside unused space at lg", () => {
    const html = board(fixtures("North Harbour Rovers", "West", true));
    const halves: Track[] = tracksOf(
      classesWhere(html, (tk) => tk.includes("grid") && tk.some((c) => c.startsWith("grid-cols-[")), "row grid"),
    ).map((tr, i) => (i === 1 || i === 3 ? { kind: "fr" } : tr));
    const fit = fitRow(html, themePx("breakpoint-lg"), "North Harbour Rovers", "West", halves);
    expect(fit.homeCut).toBe(true);
    expect(fit.unused).toBeGreaterThan(100);
  });

  it("from 2xl the slide widens, so the final between two unplayed semi-finals, and two 43-character names, fit at 1920 and 2560", async () => {
    const [, feeders, , longs] = await pairs();
    for (const [home, away] of [feeders!, longs!]) {
      const html = board(fixtures(home, away, true));
      for (const vw of [1920, 2560]) {
        const fit = fitRow(html, vw, home, away);
        expect({ vw, home, homeCut: fit.homeCut, awayCut: fit.awayCut }).toEqual({ vw, home, homeCut: false, awayCut: false });
      }
    }
  });

  it("below 2xl the slide keeps its old cap, so lg and 1280 are sized as before", () => {
    const html = board(fixtures("North Harbour Rovers", "West", true));
    const pad = 2 * spacingPx("12");
    for (const vw of [themePx("breakpoint-lg"), 1280, themePx("breakpoint-2xl") - 1]) {
      expect(slideWidth(html, vw), `slide width at ${vw}`).toBe(Math.min(vw - pad, themePx("container-6xl")));
    }
  });
});

describe("K-2: the standings slide already gives its free space to the team name", () => {
  const standings: Slide = {
    kind: "standings",
    division: "Cup",
    caption: "Table",
    rows: [
      { rank: 1, name: "North Harbour Rovers", played: 3, won: 3, drawn: 0, lost: 0, points: 9 },
      { rank: 2, name: "West", played: 3, won: 1, drawn: 0, lost: 2, points: 3 },
    ],
  };

  it("the header and every row share one template whose only growing track is the team name", () => {
    const html = board(standings);
    const grids = [...html.matchAll(/class="([^"]*\bgrid-cols-\[[^"]*)"/g)].map((m) => m[1]!.split(/\s+/).filter(Boolean));
    expect(grids.length, "a header and at least one row").toBeGreaterThanOrEqual(2);
    const templates = new Set(grids.map((tk) => one(tk, /^grid-cols-\[(.+)\]$/, "grid-cols")[1]));
    expect([...templates]).toHaveLength(1);
    expect(tracksOf(grids[0]!).flatMap((tr, i) => (grows(tr) ? [i] : []))).toEqual([1]);
  });
});
