// Match Day C9 fix round 1 (m7): Review's Points and Tie-breaks rows say WHAT the division will play, as the approved
// receipt (mock A7) does - "Win 2 · Loss 0 (sport's)", "Sport's order: wins, head-to-head…" - not only whose it is.
//
// Expected values are the engine's own declarations (the sport's points rule and default order) put through the
// dictionaries' words, never the builder's helpers. Two sports on purpose: badminton pays a uniform set table (said once,
// "Win 2 · Loss 0", without the public dictionary) and has no division points boxes; football pays win/draw/loss (the public
// points sentence) and has boxes the organiser can change - the "yours" case needs them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type TiebreakerKey } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { sportOptionsFrom } from "@/lib/sport-options";
import { pointsLineDict } from "@/lib/rules-line";
import { unitLabelKey } from "@/lib/stage-card/summaries";
import uiEn from "@/dictionaries/en/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import { goToStep, pickTemplate, rulesDraft, setName } from "./_division-builder-driver";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

const UI = uiEn as Record<string, string>;
const PUB = publicEn as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
const moduleOf = (key: string) => builtinModules.find((m) => m.key === key)!;
const sportsFor = (key: string): SportOption[] =>
  sportOptionsFrom(
    [{ key, name: key }],
    Object.entries(moduleOf(key).variants as Record<string, Record<string, unknown>>).map(([v, config]) => ({ sport_key: key, key: v, name: v, is_system: true, config })),
    () => {
      const model = effectiveEntrantModel(moduleOf(key).entrantModel ?? null, null);
      return { kinds: model.kinds, defaultKind: model.defaultKind };
    },
  );
const POINTS_DICT = pointsLineDict(publicEn);
const mount = (key: string) =>
  renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: sportsFor(key),
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
    pointsDict: POINTS_DICT,
  });
type H = ReturnType<typeof mount>;

/** A Review row's value line (its second paragraph: label, value, "change it later"). */
function rowValue(h: H, id: string): string | undefined {
  const row = h.tree().find((e) => e.type === "li" && propsOf(e)["data-review-row"] === id);
  if (!row) return undefined;
  return textOf(walk(row).filter((e) => e.type === "p")[1]!);
}
/** A league, so the one table kind is "league". */
function toReview(h: H) {
  setName(h, "Open");
  goToStep(h, "format");
  pickTemplate(h, "league");
  goToStep(h, "review");
}
/** The sport's order as the C1 summary says it: the two-way head-to-head rung is a sentence of its own, not a step;
 *  the first three steps, in the sport's unit, then "…". */
function orderWords(sportKey: string, keys: readonly string[]): string {
  const steps = keys.filter((k) => k !== "h2h_two");
  return steps.slice(0, 3).map((k) => UI[unitLabelKey(k, sportKey)]!).join(", ") + (steps.length > 3 ? ", …" : "");
}
/** The engine's default order for a league, under the variant preset the builder opened on (generic, for one, has no
 *  config without a preset). */
const engineOrder = (h: H, key: string): TiebreakerKey[] => {
  const m = moduleOf(key);
  const preset = (m.variants as Record<string, Record<string, unknown>>)[rulesDraft(h).variantKey] ?? {};
  return m.defaultTiebreakers("league", m.configSchema.parse(preset)) as TiebreakerKey[];
};

beforeEach(() => vi.clearAllMocks());

describe("m7: Review's Points row says what the division pays", () => {
  it("badminton: the sport's uniform set table, said once - 'Win 2 · Loss 0 (sport's)'", () => {
    const m = moduleOf("badminton");
    const pair = m.tablePointsRule(m.configSchema.parse({}), "league").bySetScore!["*"]!;
    const h = mount("badminton");
    toReview(h);
    const pays = fill(UI["stageCard.points.uniform"]!, { w: pair[0], l: pair[1] });
    expect(rowValue(h, "points")).toBe(fill(UI["divBuilder.review.points.sports"]!, { points: pays }));
  });

  it("football: the sport's win/draw/loss sentence, then the organiser's own once a box changes (sequence)", () => {
    const declared = moduleOf("football").configSchema.parse({}).points as { win: number; draw: number; loss: number };
    const sentence = (p: { win: number; draw: number; loss: number }) => {
      const s = fill(PUB["format.points.base"]!, p);
      return s.charAt(0).toUpperCase() + s.slice(1);
    };
    const h = mount("football");
    toReview(h);
    expect(rowValue(h, "points")).toBe(fill(UI["divBuilder.review.points.sports"]!, { points: sentence(declared) }));
    // A case where the right answer differs from the sport's: one point less for a win.
    const mine = { ...declared, win: declared.win - 1 };
    rulesDraft(h).setPointsValues({ win: String(mine.win), draw: String(mine.draw), loss: String(mine.loss) });
    expect(rowValue(h, "points")).toBe(fill(UI["divBuilder.review.points.own"]!, { points: sentence(mine) }));
    // Back to the sport's numbers: the sport's again.
    rulesDraft(h).setPointsValues({ win: String(declared.win), draw: String(declared.draw), loss: String(declared.loss) });
    expect(rowValue(h, "points")).toBe(fill(UI["divBuilder.review.points.sports"]!, { points: sentence(declared) }));
  });

  it("the empty case: a format with no table (knockout) has no Points or Tie-breaks row", () => {
    const h = mount("badminton");
    setName(h, "Open");
    goToStep(h, "format");
    pickTemplate(h, "knockout");
    goToStep(h, "review");
    expect(rowValue(h, "points")).toBeUndefined();
    expect(rowValue(h, "tiebreaks")).toBeUndefined();
  });
});

describe("m7: Review's Tie-breaks row names the order", () => {
  it("every sport: the sport's own order, in the sport's unit (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const h = mount(m.key);
      toReview(h);
      const order = engineOrder(h, m.key);
      expect(order.length, m.key).toBeGreaterThan(0);
      expect(rowValue(h, "tiebreaks"), m.key).toBe(fill(UI["divBuilder.review.order.sports"]!, { order: orderWords(m.key, order) }));
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("badminton: the organiser's own order once they reorder it", () => {
    const h = mount("badminton");
    toReview(h);
    const mine = [...engineOrder(h, "badminton")].reverse();
    rulesDraft(h).setOrder(mine);
    expect(rowValue(h, "tiebreaks")).toBe(fill(UI["divBuilder.review.order.own"]!, { order: orderWords("badminton", mine) }));
  });
});
