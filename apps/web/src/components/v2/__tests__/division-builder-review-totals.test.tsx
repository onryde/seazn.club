// Match Day C9 round 4 (owner 2026-11-03, on Review's "What this makes": "make it center and clean display"): each of
// the four totals is a centred stat - the number large, its unit a smaller muted line under it - and the time's number
// is "about 15 hr" with the places and the match length as its line. Two tiles to a row below md, four from md, all one
// height with their content centred.
//
// Expected values are read off what the organiser sees elsewhere on the same screen and from the dictionaries' own
// templates, never from the builder's estimate helpers: the stage count is the rendered stage list's length, the
// places and the match length are the Format step's own boxes, and each unit is the dictionary's plural for the
// number shown. Every registry sport, counted; the no-draw case (a ladder) first.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { sportOptionsFrom } from "@/lib/sport-options";
import { venueNoun } from "@/lib/venue";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import uiEn from "@/dictionaries/en/ui.json";
import { byTestId, goToStep, next, pickTemplate, setName, templateKeys } from "./_division-builder-driver";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

const UI = uiEn as Record<string, string>;
const PLURAL = new Intl.PluralRules("en");
const unitFor = (key: string, n: number) => UI[`${key}.${PLURAL.select(n)}`]!;
const ALL: SportOption[] = sportOptionsFrom(
  builtinModules.map((m) => ({ key: m.key, name: m.key })),
  builtinModules.flatMap((m) =>
    Object.entries(m.variants as Record<string, Record<string, unknown>>).map(([key, config]) => ({ sport_key: m.key, key, name: key, is_system: true, config })),
  ),
  (key) => {
    const model = effectiveEntrantModel(builtinModules.find((m) => m.key === key)!.entrantModel ?? null, null);
    return { kinds: model.kinds, defaultKind: model.defaultKind };
  },
);
const mount = (sportKey: string) =>
  renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: [ALL.find((s) => s.key === sportKey)!],
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
  });
type H = ReturnType<typeof mount>;

/** A dictionary template turned into a matcher: each {placeholder} captures, the rest is literal. */
function read(key: string, text: string): Record<string, string> {
  const template = UI[key];
  if (!template) throw new Error(`no ${key} in en/ui.json`);
  const source = template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_m, name: string) => `(?<${name}>.+?)`);
  const m = new RegExp(`^${source}$`).exec(text);
  if (!m?.groups) throw new Error(`"${text}" does not read as ${key} ("${template}")`);
  return m.groups;
}
const classes = (e: ReactElement) => String(propsOf(e).className).split(/\s+/);
type Tile = { id: string; el: ReactElement; value: string; unit: string; valueEl: ReactElement; unitEl: ReactElement };
function tiles(h: H): Tile[] {
  const dl = byTestId(h, "division-builder-totals");
  if (!dl) throw new Error("no totals");
  return walk(dl)
    .filter((e) => typeof propsOf(e)["data-total"] === "string")
    .map((el) => {
      const valueEls = walk(el).filter((e) => propsOf(e)["data-total-value"] !== undefined);
      const unitEls = walk(el).filter((e) => propsOf(e)["data-total-unit"] !== undefined);
      expect([valueEls.length, unitEls.length], String(propsOf(el)["data-total"])).toEqual([1, 1]);
      return { id: String(propsOf(el)["data-total"]), el, value: textOf(valueEls[0]!).trim(), unit: textOf(unitEls[0]!).trim(), valueEl: valueEls[0]!, unitEl: unitEls[0]! };
    });
}
const box = (h: H, id: string) => Number(propsOf(byTestId(h, id)!).value);

/** The four tiles against the screen and the dictionaries; returns how many it read. */
function expectTotals(h: H, sportKey: string): number {
  const dl = byTestId(h, "division-builder-totals")!;
  // Two to a row below md, four from md, every row one height.
  expect(classes(dl), sportKey).toEqual(expect.arrayContaining(["grid", "grid-cols-2", "md:grid-cols-4", "auto-rows-fr"]));
  const ts = tiles(h);
  expect(ts.map((t) => t.id), sportKey).toEqual(["stages", "matches", "rounds", "time"]);
  for (const t of ts) {
    // A centred stat: a column, centred both ways; the number large, the unit small and muted.
    expect(classes(t.el), `${sportKey} ${t.id}`).toEqual(expect.arrayContaining(["flex", "flex-col", "justify-center", "text-center"]));
    expect(classes(t.valueEl), `${sportKey} ${t.id}`).toEqual(expect.arrayContaining(["text-xl", "sm:text-2xl", "font-semibold"]));
    expect(classes(t.unitEl), `${sportKey} ${t.id}`).toEqual(expect.arrayContaining(["text-xs", "text-slate-500"]));
    expect(t.value.length * t.unit.length, `${sportKey} ${t.id}: a number and a unit`).toBeGreaterThan(0);
  }
  const [stages, matches, rounds, time] = ts as [Tile, Tile, Tile, Tile];
  // Stages: the number is the stage list's length below the tiles.
  const listed = walk(byTestId(h, "division-builder-stages")!).filter((e) => e.type === "li").length;
  expect([stages.value, stages.unit], sportKey).toEqual([String(listed), unitFor("divBuilder.review.unit.stages", listed)]);
  // Matches and rounds: a number with its plural, or a dash where the format has no fixed draw.
  if (matches.value === "—") expect(matches.unit, sportKey).toBe(UI["divBuilder.card.noDraw"]);
  else expect(matches.unit, sportKey).toBe(unitFor("divBuilder.review.unit.matches", Number(matches.value)));
  if (rounds.value !== "—") expect(rounds.unit, sportKey).toBe(unitFor("divBuilder.review.unit.rounds", Number(rounds.value)));
  // Time: "about T" as the number, the places and the match length - the Format step's own boxes - as its line.
  if (time.value !== "—") expect(read("divBuilder.card.about", time.value).time, sportKey).toMatch(/\d/);
  const line = read("divBuilder.review.timeUnit", time.unit);
  const venues = box(h, "division-builder-plan-venues");
  expect(line.places, sportKey).toBe(unitFor(`divBuilder.places.${venueNoun(sportKey)}`, venues).replace("{count}", String(venues)));
  expect(Number(line.minutes), sportKey).toBe(box(h, "division-builder-match-minutes"));
  // The time line breaks only at its dot: each of the template's " · " phrases is one inline box (the browser once split
  // "30- / minute matches" after the hyphen at 320; the walkthrough measures the real line).
  const phrases = walk(time.unitEl).filter((e) => propsOf(e)["data-unit-phrase"] !== undefined);
  expect(phrases.length, sportKey).toBe(UI["divBuilder.review.timeUnit"]!.split(" · ").length);
  for (const p of phrases) expect(classes(p), sportKey).toEqual(expect.arrayContaining(["inline-block", "max-w-full"]));
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  expect(squash(phrases.map((p) => textOf(p)).join(" ")), sportKey).toBe(squash(time.unit));
  return ts.length;
}

describe("Review's totals: four centred stats, a number over its unit (round 4)", () => {
  it("empty case first: a format with no fixed draw (ladder) shows dashes over its units, and the time line still names the plan", () => {
    const h = mount("badminton");
    setName(h, "Open");
    next(h);
    expect(templateKeys(h), "premise: badminton is offered the ladder").toContain("ladder");
    pickTemplate(h, "ladder");
    goToStep(h, "review");
    const ts = tiles(h);
    const ladderStages = STAGE_TEMPLATES.find((t) => t.key === "ladder")!.build({ qualified: 4, swissRounds: 4, poolCount: 2, legs: 1 }).length;
    expect(ts.map((t) => [t.id, t.value])).toEqual([
      ["stages", String(ladderStages)],
      ["matches", "—"],
      ["rounds", "—"],
      ["time", "—"],
    ]);
    expect(ts[1]!.unit).toBe(UI["divBuilder.card.noDraw"]);
    expect(expectTotals(h, "badminton")).toBe(4);
  });

  it("every sport's opening format: each tile reads as the screen and the dictionaries say (counts)", () => {
    let sports = 0;
    let read4 = 0;
    let drawn = 0;
    for (const m of builtinModules) {
      const h = mount(m.key);
      setName(h, "Open");
      goToStep(h, "review");
      read4 += expectTotals(h, m.key);
      if (tiles(h)[3]!.value !== "—") drawn++;
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
    expect(read4).toBe(4 * builtinModules.length);
    // The witness that the time number is exercised, not only its dash.
    expect(drawn, "sports whose opening format has a fixed draw").toBeGreaterThan(0);
  });
});
