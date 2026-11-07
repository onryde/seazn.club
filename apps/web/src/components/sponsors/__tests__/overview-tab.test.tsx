// R4 sponsors on stream, S13 - the Sponsors hub's Overview tab (components/sponsors/overview-tab.tsx), driven the way a person
// drives it. vitest is `environment: "node"` (no DOM), so the island runs under components/__tests__/_hook-harness.tsx: React's
// own hook dispatcher, the element tree back, an event is the element's own handler prop called. What this cannot see (CSS, the
// widths, a real tap) is CI's e2e (`e2e/sponsors-hub.spec.ts`, default viewport) and mobile.spec.ts's hub sweep.
//
// Expected strings come from the dictionary (`t(en, key)`) and the formatters' own Intl output, never a literal typed per
// locale; expected numbers are the props handed in.
//
// The transitions and where each is pinned:
//   a period is picked ............................... "the picker"
//   numbers; Coming soon for null viewers ............. "a row reads its own numbers", "viewers with no number"
//   a deleted sponsor .................................. "a deleted sponsor"
//   empty org (editor / viewer) ........................ "empty"
//   viewer (R19 read-only) ............................. "R19"
//   Share report opened, switched, closed .............. "Share report"
//   props refreshed while a panel is open .............. "Share report"
//
// Killers (one at a time, restore from a cp backup):
//   U1  dash for null    `value === null ? DASH :` -> `String(value ?? 0)`    -> "a row reads its own numbers"
//   U2  share editor-only  drop `canEdit &&` on the share cell                -> "R19: a viewer"
//   U3  deleted no link  drop `row.sponsorId !== null &&` on the button       -> "a deleted sponsor"
//   U4  picker value     `onChange` pushes overviewHref(orgSlug, THIS_YEAR)   -> "the picker"
//   U5  competition note  drop `period.kind === "competition" &&`              -> "the competition-click footnote..." (fix round 1, m4)
//   U6  legend dropped    null viewers draw nothing instead of the legend      -> "viewers with no number", "a row reads its own numbers"
//   U7  legend unwrapped  the Coming soon dd keeps `shrink-0`                  -> "the phone line" (nl, fix round 1 I-new)
//   U8  legend floorless  the Coming soon dd takes `min-w-0`                   -> "the phone line" (es, ci-fix review I1)
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

import { OverviewTab, type OverviewTabProps } from "../overview-tab";
import { ShareReport } from "../share-report";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { fmtIsoDay, fmtOnScreen, overviewHref, type SponsorOverviewRow, type SponsorPeriod } from "@/lib/sponsor-report";
import { sponsorsHref } from "@/lib/sponsors-hub";
import { t } from "@/lib/i18n-runtime";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { minContentWidth, openFace, textWidth } from "@/components/public-site/__tests__/font-advance";
import uiEn from "@/dictionaries/en/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

const en = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) => t(en, key, vars);
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const DASH = "—";

/** Review Focus 5: a realistic 43-character name. */
const LONG_NAME = "Harbourside Building Supplies and Timber Co";
const COMPETITIONS = [{ id: "11111111-1111-4111-8111-111111111111", name: "Spring Cup" }, { id: "22222222-2222-4222-8222-222222222222", name: "Autumn Cup" }];
const row = (over: Partial<SponsorOverviewRow> & { sponsorId: string | null; name: string }): SponsorOverviewRow => ({
  timesShown: 0, onScreenMs: 0, viewerImpressions: null, peakViewers: null, linkClicks: 0, ...over,
});
const ROWS: SponsorOverviewRow[] = [
  row({ sponsorId: "s1", name: LONG_NAME, timesShown: 12, onScreenMs: 252_000, linkClicks: 7 }),
  row({ sponsorId: "s2", name: "Ridge Cycles", timesShown: 3, onScreenMs: 45_000, linkClicks: 0, viewerImpressions: 1840, peakViewers: 212 }),
  row({ sponsorId: null, name: "Gone Bakery", timesShown: 2, onScreenMs: 18_000, linkClicks: null }),
];
const NOW = "2026-06-15T12:00:00.000Z";

const base = (over: Partial<OverviewTabProps> = {}): OverviewTabProps => ({
  orgId: "org-1",
  orgSlug: "riverside",
  period: { kind: "this_year" },
  nowIso: NOW,
  competitions: COMPETITIONS,
  rows: ROWS,
  canEdit: true,
  links: [],
  shareDefaults: { from: "2026-01-01", to: "2026-12-31", competitionId: null },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

function mount(over: Partial<OverviewTabProps> = {}) {
  const island = renderIsland(OverviewTab, base(over));
  const all = (pred: (e: ReactElement) => boolean) => island.tree().filter(pred);
  const byTestId = (id: string) => all((e) => propsOf(e)["data-testid"] === id);
  const find = (id: string): ReactElement => {
    const [el] = byTestId(id);
    if (!el) throw new Error(`no element with data-testid="${id}"`);
    return el;
  };
  const has = (id: string) => byTestId(id).length > 0;
  const text = (id: string) => flat(textOf(find(id)));
  const shares = () => all((e) => e.type === ShareReport);
  return { island, find, has, text, byTestId, shares };
}
/** The rows' keys, the way the list renders them: a live sponsor by id, a deleted one by its name. */
const rowKey = (r: SponsorOverviewRow) => (r.sponsorId !== null ? r.sponsorId : `gone-${r.name}`);

describe("the picker - the period on screen, and a pick navigates to it", () => {
  it("opens AT the period on screen for each kind (counted), and offers the org's competitions", () => {
    const cases: [SponsorPeriod, string][] = [
      [{ kind: "this_year" }, "this_year"],
      [{ kind: "last_30_days" }, "last_30_days"],
      [{ kind: "competition", competitionId: COMPETITIONS[1]!.id }, COMPETITIONS[1]!.id],
    ];
    let checked = 0;
    for (const [period, value] of cases) {
      expect(propsOf(mount({ period }).find("sponsor-overview-period")).value, period.kind).toBe(value);
      checked++;
    }
    expect(checked).toBe(3);
    const m = mount();
    const options = m.island.tree().filter((e) => e.type === "option").map((e) => [propsOf(e).value, flat(textOf(e))]);
    expect(options).toEqual([
      ["this_year", msg("sponsors.overview.period.this_year")],
      ["last_30_days", msg("sponsors.overview.period.last_30_days")],
      ...COMPETITIONS.map((c) => [c.id, c.name]),
    ]);
    // No competitions: no group, only the two time periods.
    expect(mount({ competitions: [] }).island.tree().filter((e) => e.type === "optgroup")).toHaveLength(0);
  });

  it("a pick pushes that period's own URL - every option, counted", () => {
    const m = mount();
    const onChange = propsOf(m.find("sponsor-overview-period")).onChange as (e: { target: { value: string } }) => void;
    const picks: [string, SponsorPeriod][] = [
      ["last_30_days", { kind: "last_30_days" }],
      [COMPETITIONS[0]!.id, { kind: "competition", competitionId: COMPETITIONS[0]!.id }],
      ["this_year", { kind: "this_year" }],
    ];
    for (const [value] of picks) onChange({ target: { value } });
    expect(nav.push.mock.calls.map((c) => c[0])).toEqual(picks.map(([, p]) => overviewHref("riverside", p)));
    expect(nav.push).toHaveBeenCalledTimes(picks.length);
  });

  it("the caption names the window's own dates (UTC) for a time period, and 'every match' for a competition", () => {
    expect(mount({ period: { kind: "last_30_days" } }).text("sponsor-overview-window"))
      .toBe(flat(msg("sponsors.overview.window", { from: fmtIsoDay("en", "2026-05-17"), to: fmtIsoDay("en", "2026-06-15") })));
    expect(mount().text("sponsor-overview-window"))
      .toBe(flat(msg("sponsors.overview.window", { from: fmtIsoDay("en", "2026-01-01"), to: fmtIsoDay("en", "2026-12-31") })));
    expect(mount({ period: { kind: "competition", competitionId: COMPETITIONS[0]!.id } }).text("sponsor-overview-window"))
      .toBe(msg("sponsors.overview.windowCompetition"));
  });
});

describe("the rows", () => {
  it("a row reads its own numbers: times shown, on screen to the second, link clicks, and Coming soon for viewers it does not have (never 0, never a dash)", () => {
    const m = mount();
    let checked = 0;
    for (const r of ROWS) {
      const k = rowKey(r);
      const cell = (field: string) => flat(textOf(m.byTestId(`sponsor-overview-${field}`).find((e) => (propsOf(e)["data-row"] as string) === k)!));
      expect(cell("times"), r.name).toBe(String(r.timesShown));
      expect(cell("onscreen"), r.name).toBe(fmtOnScreen("en", r.onScreenMs));
      // A deleted sponsor's clicks (they went with it) are the dash on screen plus words for a screen reader (fix round 1, m7);
      // viewers with no number are the "Coming soon" legend (owner ruling 2026-11-01, PR B deferred).
      expect(cell("clicks"), r.name).toBe(r.linkClicks === null ? `${DASH} ${msg("sponsors.overview.notAvailable")}` : String(r.linkClicks));
      if (r.viewerImpressions === null) expect(cell("viewers"), r.name).toBe(msg("sponsors.viewers.comingSoon"));
      else expect(cell("viewers"), r.name).toBe(flat(`${r.viewerImpressions.toLocaleString("en")} ${msg("sponsors.overview.peak", { count: r.peakViewers!.toLocaleString("en") })}`));
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    // Zero is a number, not a dash: Ridge's 0 clicks read 0.
    expect(m.island.text()).toContain(fmtOnScreen("en", 252_000));
  });

  it("every dash is hidden from screen readers and spoken as words instead (counted) - viewers are never a dash", () => {
    const m = mount();
    const dashes = m.island.tree().filter((e) => e.type === "span" && textOf(e) === DASH);
    expect(dashes.length, "Gone's clicks only").toBe(1);
    for (const d of dashes) expect(propsOf(d)["aria-hidden"]).toBe("true");
    const spoken = m.island.tree().filter((e) => e.type === "span" && String(propsOf(e).className) === "sr-only").map((e) => textOf(e)).sort();
    expect(spoken).toEqual([msg("sponsors.overview.notAvailable")]);
  });

  // Owner ruling 2026-11-01: PR B (viewer counts) is deferred, so a row with no viewer number says "Coming soon".
  it("viewers with no number is the Coming soon legend: one per such row, real text, never aria-hidden; a row with a number has none (counted)", () => {
    expect(msg("sponsors.viewers.comingSoon"), "premise: the dictionary has the legend").not.toBe("sponsors.viewers.comingSoon");
    const m = mount();
    const legends = m.byTestId("viewers-coming-soon");
    const without = ROWS.filter((r) => r.viewerImpressions === null);
    expect(without.length, "anti-vacuity: rows with no viewer number").toBe(2);
    expect(legends).toHaveLength(without.length);
    let checked = 0;
    for (const r of ROWS) {
      const k = rowKey(r);
      const cell = m.byTestId("sponsor-overview-viewers").find((e) => (propsOf(e)["data-row"] as string) === k);
      expect(cell, `${r.name}: the viewers cell is drawn`).toBeDefined();
      const inCell = walk(cell);
      const legend = inCell.filter((e) => propsOf(e)["data-testid"] === "viewers-coming-soon");
      expect(legend, r.name).toHaveLength(r.viewerImpressions === null ? 1 : 0);
      for (const e of inCell) expect(propsOf(e)["aria-hidden"], `${r.name}: nothing in the viewers cell is hidden from a screen reader`).toBeUndefined();
      if (legend[0]) expect(flat(textOf(legend[0])), r.name).toBe(msg("sponsors.viewers.comingSoon"));
      checked++;
    }
    expect(checked).toBe(ROWS.length);
    // The notes explain the legend instead of a dash.
    expect(m.text("sponsor-overview-notes")).toContain(msg("sponsors.overview.viewersFootnote"));
  });

  // Only NULL is "not measured": a measured 0 (viewer counts shipped, nobody watching) is a number, so a null check
  // loosened to a falsy one (`!r.viewerImpressions`) would print the legend over a real 0 (coming-soon review M3).
  it("a row with 0 viewers reads 0 with its peak, never the Coming soon legend", () => {
    const zero = row({ sponsorId: "s0", name: "Zero Viewers Ltd", timesShown: 4, onScreenMs: 32_000, viewerImpressions: 0, peakViewers: 0 });
    const m = mount({ rows: [zero] });
    const cell = m.byTestId("sponsor-overview-viewers").find((e) => (propsOf(e)["data-row"] as string) === rowKey(zero));
    expect(cell, "the viewers cell is drawn").toBeDefined();
    expect(flat(textOf(cell!))).toBe(flat(`${(0).toLocaleString("en")} ${msg("sponsors.overview.peak", { count: (0).toLocaleString("en") })}`));
    expect(m.byTestId("viewers-coming-soon"), "no legend over a measured 0").toHaveLength(0);
  });

  it("every stat carries its label in the row (the phone card's line, the desktop's screen-reader name), in order", () => {
    const m = mount();
    const items = m.byTestId(`sponsor-overview-row-s1`);
    expect(items).toHaveLength(1);
    const dts = m.island.tree().filter((e) => e.type === "dt" && (propsOf(e)["data-row"] as string) === "s1").map((e) => flat(textOf(e)));
    expect(dts).toEqual([
      msg("sponsors.overview.col.timesShown"),
      msg("sponsors.overview.col.onScreen"),
      msg("sponsors.overview.col.viewerImpressions"),
      msg("sponsors.overview.col.linkClicks"),
    ]);
  });

  it("the long name is truncated with min-w-0 on its chain and keeps its full text in a title", () => {
    const m = mount();
    const name = m.byTestId("sponsor-overview-name").find((e) => flat(textOf(e)) === LONG_NAME)!;
    expect(name).toBeDefined();
    expect(String(propsOf(name).className)).toMatch(/(^|\s)truncate(\s|$)/);
    expect(String(propsOf(name).className)).toMatch(/(^|\s)min-w-0(\s|$)/);
    expect(propsOf(name).title).toBe(LONG_NAME);
    expect(String(propsOf(m.find("sponsor-overview-row-s1")).className)).toMatch(/(^|\s)min-w-0(\s|$)/);
  });

  it("a deleted sponsor: its row reads under its name with a Deleted chip, its clicks a dash, NO Share report, and the notes say why", () => {
    const m = mount();
    expect(m.has("sponsor-overview-row-gone-Gone Bakery")).toBe(true);
    expect(m.text("sponsor-overview-row-gone-Gone Bakery")).toContain(msg("sponsors.overview.deleted"));
    const shareButtons = m.byTestId("sponsor-overview-share").map((e) => propsOf(e)["data-row"]);
    expect(shareButtons).toEqual(["s1", "s2"]);
    expect(m.text("sponsor-overview-notes")).toContain(msg("sponsors.overview.deletedFootnote"));
    // With no deleted row, that note is not shown.
    expect(mount({ rows: ROWS.slice(0, 2) }).text("sponsor-overview-notes")).not.toContain(msg("sponsors.overview.deletedFootnote"));
  });

  it("the competition-click footnote shows for a competition period only, naming the two time periods by their own labels (counted)", () => {
    const want = msg("sponsors.overview.competitionClicksFootnote", {
      thisYear: msg("sponsors.overview.period.this_year"),
      last30: msg("sponsors.overview.period.last_30_days"),
    });
    const cases: [SponsorPeriod, boolean][] = [
      [{ kind: "this_year" }, false],
      [{ kind: "last_30_days" }, false],
      [{ kind: "competition", competitionId: COMPETITIONS[0]!.id }, true],
    ];
    let checked = 0;
    for (const [period, shown] of cases) {
      const m = mount({ period });
      expect(m.has("sponsor-overview-competition-clicks-note"), period.kind).toBe(shown);
      if (shown) expect(m.text("sponsor-overview-competition-clicks-note")).toBe(flat(want));
      checked++;
    }
    expect(checked).toBe(3);
    expect(want).toContain(msg("sponsors.overview.period.this_year"));
  });

  it("the notes carry the link-click footnote exactly, and never call clicks visitors or people", () => {
    const notes = mount().text("sponsor-overview-notes");
    expect(notes).toContain(msg("sponsors.overview.clicksFootnote"));
    expect(msg("sponsors.overview.clicksFootnote")).toBe("Automated previews and repeat taps within 30 s are excluded.");
    expect(notes).not.toMatch(/visitor|people|unique/i);
  });
});

describe("empty", () => {
  it("no sponsor: the empty state, no list and no notes - with the way to add one for an editor, without it for a viewer", () => {
    const editor = mount({ rows: [] });
    expect(editor.has("sponsor-overview-empty")).toBe(true);
    expect(editor.has("sponsor-overview-list")).toBe(false);
    expect(editor.has("sponsor-overview-notes")).toBe(false);
    expect(editor.text("sponsor-overview-empty")).toContain(msg("sponsors.overview.empty"));
    expect(propsOf(editor.find("sponsor-overview-empty-link")).href).toBe(sponsorsHref("riverside", "sponsors"));
    const viewer = mount({ rows: [], canEdit: false, links: [], shareDefaults: null });
    expect(viewer.has("sponsor-overview-empty")).toBe(true);
    expect(viewer.has("sponsor-overview-empty-link")).toBe(false);
  });

  it("sponsors with nothing aired read zeros and Coming soon for viewers, not the empty state", () => {
    const m = mount({ rows: [row({ sponsorId: "s9", name: "Quiet Ltd" })] });
    expect(m.has("sponsor-overview-empty")).toBe(false);
    expect(m.text("sponsor-overview-row-s9")).toContain(fmtOnScreen("en", 0));
    expect(m.byTestId("viewers-coming-soon"), "the one row's viewers").toHaveLength(1);
  });
});

describe("R19: a viewer reads the Overview, read-only", () => {
  it("a viewer sees every row and number, and no Share report anywhere", () => {
    const m = mount({ canEdit: false, links: [], shareDefaults: null });
    expect(ROWS.every((r) => m.has(`sponsor-overview-row-${rowKey(r)}`))).toBe(true);
    expect(m.has("sponsor-overview-share")).toBe(false);
    expect(m.shares()).toHaveLength(0);
    // The positive pair: an editor has one per live sponsor.
    expect(mount().byTestId("sponsor-overview-share")).toHaveLength(2);
  });
});

describe("Share report", () => {
  it("opens under its own sponsor with that sponsor's links and the period's defaults; a second sponsor's button moves it; Close closes it", () => {
    const links = [
      { id: "l1", sponsorId: "s1", competitionId: null, competitionName: null, from: "2026-01-01", to: "2026-12-31", createdAt: "2026-06-01T10:00:00.000Z" },
      { id: "l2", sponsorId: "s2", competitionId: null, competitionName: null, from: "2026-01-01", to: "2026-03-31", createdAt: "2026-06-02T10:00:00.000Z" },
    ];
    const m = mount({ links });
    expect(m.shares(), "closed at first").toHaveLength(0);
    const button = (rowId: string) => m.byTestId("sponsor-overview-share").find((e) => propsOf(e)["data-row"] === rowId)!;
    expect(propsOf(button("s1"))["aria-expanded"]).toBe(false);

    (propsOf(button("s1")).onClick as () => void)();
    let [panel] = m.shares();
    expect(m.shares()).toHaveLength(1);
    expect(propsOf(panel!)).toMatchObject({
      orgId: "org-1", sponsor: { id: "s1", name: LONG_NAME }, defaults: base().shareDefaults, links: [links[0]], competitionName: null,
    });
    expect(propsOf(button("s1"))["aria-expanded"]).toBe(true);
    expect(propsOf(button("s1"))["aria-controls"]).toBe(propsOf(panel!).id);

    (propsOf(button("s2")).onClick as () => void)();
    [panel] = m.shares();
    expect(m.shares()).toHaveLength(1);
    expect(propsOf(panel!)).toMatchObject({ sponsor: { id: "s2", name: "Ridge Cycles" }, links: [links[1]] });
    expect(propsOf(button("s1"))["aria-expanded"]).toBe(false);

    (propsOf(panel!).onClose as () => void)();
    expect(m.shares()).toHaveLength(0);
    // The button toggles it too.
    (propsOf(button("s2")).onClick as () => void)();
    (propsOf(button("s2")).onClick as () => void)();
    expect(m.shares()).toHaveLength(0);
  });

  it("a competition period hands the panel that competition's name; the panel stays open over a props refresh", () => {
    const period: SponsorPeriod = { kind: "competition", competitionId: COMPETITIONS[1]!.id };
    const defaults = { from: "2026-03-01", to: "2026-06-15", competitionId: COMPETITIONS[1]!.id };
    const m = mount({ period, shareDefaults: defaults });
    (propsOf(m.byTestId("sponsor-overview-share")[0]!).onClick as () => void)();
    expect(propsOf(m.shares()[0]!)).toMatchObject({ defaults, competitionName: "Autumn Cup" });
    m.island.rerender(base({ period, shareDefaults: defaults, links: [{ id: "l9", sponsorId: "s1", competitionId: defaults.competitionId, competitionName: "Autumn Cup", from: defaults.from, to: defaults.to, createdAt: NOW }] }));
    expect(m.shares()).toHaveLength(1);
    expect((propsOf(m.shares()[0]!).links as { id: string }[]).map((l) => l.id)).toEqual(["l9"]);
  });
});

// Fix round 1, I-new: on a phone each stat is one flex line, label (`dt`) and value (`dd`). A value never shrinks (`shrink-0`),
// but the Coming soon legend is a caption, so it may wrap - nl's "Binnenkort beschikbaar" did not fit beside its label at 320
// and crossed the row card's border. vitest has no layout, so the line is priced with the shipped faces (font-advance.ts, an
// over-estimate: no kerning) against the width a 320 px screen leaves the line, from the classes the island renders.
describe("the phone line - the viewers label and its Coming soon legend fit a 320 px card in every locale", () => {
  const FONTS = join(dirname(fileURLToPath(import.meta.url)), "../../../../assets/fonts");
  const regular = openFace(join(FONTS, "Geist-Regular.ttf"), "Geist Regular");
  // The legend is `font-medium` (500). No 500 instance is committed, and 700 is wider: an upper bound, the safe direction.
  const bold = openFace(join(FONTS, "Geist-Bold.ttf"), "Geist Bold");
  const DICTS: Record<Locale, Dict> = { en, fr: uiFr as unknown as Dict, es: uiEs as unknown as Dict, nl: uiNl as unknown as Dict };
  // 320 - main `px-4` (16 x 2), the hub card's `p-4` and border (17 x 2), this row's `p-3` and border (13 x 2) = 228.
  const LINE_PX = 320 - 2 * 16 - 2 * (16 + 1) - 2 * (12 + 1);
  const GAP_PX = 12; // `gap-3`
  const LABEL_PX = 14; // the `dl`'s `text-sm`
  const LEGEND_PX = 12; // `text-xs`

  it("prices the line from what renders: the row's padding, a number's dd that never shrinks, and a legend's dd that may wrap", () => {
    const m = mount();
    const cls = (e: ReactElement) => String(propsOf(e).className ?? "").split(/\s+/);
    const li = m.find("sponsor-overview-row-s1");
    expect(cls(li), "the row card's padding and border the 228 px budget assumes").toEqual(expect.arrayContaining(["p-3", "border"]));
    const dd = (row: string) => {
      const [el] = m.byTestId("sponsor-overview-viewers").filter((e) => propsOf(e)["data-row"] === row);
      if (!el) throw new Error(`no viewers cell on row ${row}`);
      return cls(el);
    };
    expect(dd("s2"), "a number never shrinks off its line").toContain("shrink-0");
    // s1's viewers are null: the legend. With `shrink-0` it is one unbreakable line; without it, only its longest word is.
    const legendWraps = !dd("s1").includes("shrink-0");
    // The floors this model prices: a flex item with no `min-w-0` cannot shrink below its longest word. With `min-w-0` the
    // legend's floor is 0, flex shrinks it in proportion to its width, and es "Próximamente" lands narrower than itself and
    // crosses the border (ci-fix review I1) - the sum below would no longer bound the line.
    expect(dd("s1"), "the legend keeps its longest word as its floor").not.toContain("min-w-0");
    const labels = m.island.tree().filter((e) => e.type === "dt" && propsOf(e)["data-row"] === "s1");
    expect(labels.length, "the row's four labels").toBe(4);
    for (const dt of labels) expect(cls(dt), "a label keeps its longest word as its floor").not.toContain("min-w-0");
    let checked = 0;
    const over: string[] = [];
    for (const locale of LOCALES) {
      const label = t(DICTS[locale], "sponsors.overview.col.viewerImpressions");
      const legend = t(DICTS[locale], "sponsors.viewers.comingSoon");
      // The dt has no `min-w-0`, so it cannot shrink below its longest word.
      const need =
        minContentWidth(regular, label, LABEL_PX) + GAP_PX + (legendWraps ? minContentWidth(bold, legend, LEGEND_PX) : textWidth(bold, legend, LEGEND_PX));
      if (need > LINE_PX) over.push(`${locale}: "${label}" + "${legend}" needs ${need.toFixed(1)} px of ${LINE_PX}`);
      checked++;
    }
    expect(over.join("; "), "a locale whose label and legend overrun the line").toBe("");
    expect(checked, "every locale priced").toBe(LOCALES.length);
    expect(checked).toBeGreaterThan(0);
  });
});
