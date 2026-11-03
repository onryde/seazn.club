// Match Day C9 fix round 1, owner ruling 2026-11-03 (Q5, "apply rec"): the builder OPENS on the top suggestion - the
// first format the suggester ranks for the sport at the opening plan - not on League.
//
// The expected pick is the SUGGESTER's own ranking (`rankTemplates`, whose first four are `suggestTemplates`), asked with
// the plan the Format step opens at, read off its own boxes (entrants, venues, hours, and the match-length box), and the
// opening knobs the ranking declares. Every sport, counted; League (the old default) is never the top suggestion at the
// opening plan, so every row is a case where the old answer and the right one differ.
//
// One guard on top of the ruling (reported to the owner): at the opening plan the suggester's first is Americano for
// every sport but chess, and Americano rotates INDIVIDUAL players into PAIR entrants (the engine's americanoGen). A
// division whose kinds lack either - the team sports, volleyball, or a division narrowed to teams on Who plays (Q3) -
// opens on the first ranked format it can play instead.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { sportOptionsFrom } from "@/lib/sport-options";
import { templatesForSport } from "@/lib/format-templates";
import { rankTemplates } from "@/lib/division-builder/model";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { swissRoundsDefault } from "@/lib/swiss-rounds";
import { byTestId, goToStep, next, pickTemplate, pickedTemplate, pressCreate, selectSport, setName } from "./_division-builder-driver";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));
vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

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
const sportsFor = (...keys: string[]) => keys.map((k) => ALL.find((s) => s.key === k)!);
const mount = (sports: SportOption[]) =>
  renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
  });
type H = ReturnType<typeof mount>;
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const boxNumber = (h: H, id: string) => Number(propsOf(byTestId(h, id)!).value);

/** The rulebook fact the guard rests on: Americano/Mexicano (stage kind "americano") pairs individual players into pair
 *  entrants, so the division must take both. */
const playableBy = (kinds: readonly string[]) => (key: string) =>
  !STAGE_TEMPLATES.find((t) => t.key === key)!
    .build({ qualified: 4, swissRounds: 4, poolCount: 2, legs: 1 })
    .some((s) => s.kind === "americano" && !(kinds.includes("individual") && kinds.includes("pair")));
const sportKinds = (key: string) => effectiveEntrantModel(builtinModules.find((m) => m.key === key)!.entrantModel ?? null, null).kinds;

/** The suggester's ranking for the sport on screen, at the plan the Format step's boxes open at. */
function suggestersRanking(h: H, sportKey: string): string[] {
  const plan = {
    entrants: boxNumber(h, "division-builder-plan-entrants"),
    venues: boxNumber(h, "division-builder-plan-venues"),
    hours: boxNumber(h, "division-builder-plan-hours"),
    matchMinutes: boxNumber(h, "division-builder-match-minutes"),
  };
  const offered = templatesForSport(sportKey).map((t) => t.key);
  return rankTemplates(offered, plan, { qualified: 4, swissRounds: swissRoundsDefault(plan.entrants), poolCount: 2, legs: 1 }).map((r) => r.key);
}
/** The suggester's first that a division taking these kinds can play. */
const suggestersPick = (h: H, sportKey: string, kinds: readonly string[] = sportKinds(sportKey)): string =>
  suggestersRanking(h, sportKey).find(playableBy(kinds))!;

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation(async (url: string) => (String(url).endsWith("/divisions") ? { id: "d1", slug: "open" } : {}));
});

describe("Q5: the builder opens on the top suggestion", () => {
  it("every sport: the picked card on Format is the suggester's first it can play, and never League (counts)", () => {
    let checked = 0;
    let differsFromLeague = 0;
    let topIsTheSuggestersFirst = 0;
    let guardSkippedTheFirst = 0;
    for (const m of builtinModules) {
      const h = mount(sportsFor(m.key));
      setName(h, "Open");
      next(h);
      const want = suggestersPick(h, m.key);
      expect(pickedTemplate(h), m.key).toBe(want);
      if (want !== "league") differsFromLeague++;
      if (want === suggestersRanking(h, m.key)[0]) topIsTheSuggestersFirst++;
      else guardSkippedTheFirst++;
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
    expect(differsFromLeague, "League, the old default, is not the top suggestion").toBe(checked);
    // Both branches reached: sports that open on the suggester's very first, and sports the guard moved on from it.
    expect(topIsTheSuggestersFirst, "sports opening on the suggester's first").toBeGreaterThan(0);
    expect(guardSkippedTheFirst, "sports whose kinds cannot play the suggester's first").toBeGreaterThan(0);
  });

  it("Q3 with Q5: a generic division narrowed to Teams on Who plays opens on a format teams can play", () => {
    const h = mount(sportsFor("generic"));
    setName(h, "Open");
    next(h);
    const opensOn = pickedTemplate(h);
    expect(opensOn).toBe(suggestersPick(h, "generic"));
    goToStep(h, "who");
    const teams = h.tree().find((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).value === "team");
    (propsOf(teams!).onChange as () => void)();
    goToStep(h, "format");
    const want = suggestersPick(h, "generic", ["team"]);
    expect(want, "premise: the narrowed division opens elsewhere").not.toBe(opensOn);
    expect(pickedTemplate(h)).toBe(want);
  });

  it("an untouched builder creates the top suggestion's stages", async () => {
    const h = mount(sportsFor("badminton"));
    setName(h, "Open");
    next(h);
    const want = suggestersPick(h, "badminton");
    goToStep(h, "review");
    pressCreate(h);
    await flush();
    const stagesCall = apiV1Mock.mock.calls.filter(([url]) => /\/stages$/.test(String(url))).at(-1);
    const sent = (stagesCall![1] as { json: { kind: string }[] }).json.map((s) => s.kind);
    const kinds = templatesForSport("badminton").find((t) => t.key === want)!.build({ qualified: 4, swissRounds: 4, poolCount: 2, legs: 1 }).map((s) => s.kind);
    expect(sent).toEqual(kinds);
  });

  it("untouched, it follows the sport; a card the organiser picked stays picked through a sport change (sequence)", () => {
    const h = mount(sportsFor("badminton", "football"));
    selectSport(h, "football");
    setName(h, "Open");
    next(h);
    expect(pickedTemplate(h)).toBe(suggestersPick(h, "football"));
    // Typing a plan reshuffles the suggestions but never moves the pick: it is the opening plan's.
    const opening = pickedTemplate(h);
    (propsOf(byTestId(h, "division-builder-plan-entrants")!).onChange as (e: { target: { value: string } }) => void)({ target: { value: "6" } });
    expect(pickedTemplate(h)).toBe(opening);
    pickTemplate(h, "knockout");
    goToStep(h, "who");
    selectSport(h, "badminton");
    goToStep(h, "format");
    expect(pickedTemplate(h), "a picked card is kept").toBe("knockout");
  });
});
