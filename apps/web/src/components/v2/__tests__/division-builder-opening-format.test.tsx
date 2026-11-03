// Match Day C9 fix round 1, owner ruling 2026-11-03 (Q5, "apply rec"): the builder OPENS on the top suggestion - the
// first format the suggester ranks for the sport at the opening plan - not on League. Round 4 (I1, owner "A"): the top
// suggestion as SHOWN - the first card of the grid, where Americano and Mexicano sit after every other (R2).
//
// The expected pick is the SUGGESTER's own ranking (`rankTemplates`, whose first five are `suggestTemplates`), asked with
// the plan the Format step opens at, read off its own boxes (entrants, venues, hours, and the match-length box), and the
// opening knobs the ranking declares. Every sport, counted; League (the old default) is never the top suggestion at the
// opening plan, so every row is a case where the old answer and the right one differ.
//
// One guard on top of the ruling (accepted by the owner 2026-11-03): Americano rotates INDIVIDUAL players into pairs (the
// server's americanoGen), so a division that takes no individual players opens on the first ranked format it can play
// instead. Since review I5 the SPORT's offer already leaves Americano out where the sport's engine model cannot play it
// (the team sports, volleyball, chess), and since review 2 (N1) the Format offer is the DIVISION's - a division narrowed
// to Pairs or Teams on Who plays is not offered it at all - so every division opens on the first of its own offer. The
// suggester's ranking below is of the SPORT's offer, read with the division's kinds (the one kind shown, n3).
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
import { byTestId, currentStep, goToStep, next, pickTemplate, pickedTemplate, pressCreate, selectSport, setName, stepError, templateKeys, visibleTemplateKeys } from "./_division-builder-driver";

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
/** The builder, opening on `sports[0]` unless a test hands its own history: it opens on the first tile shown (C9 round
 *  3), so the organisation's history names `sports[0]` - the real path to that opening - and the mount checks it. */
const mount = (sports: SportOption[], over: Partial<Parameters<typeof DivisionBuilder>[0]> = {}) => {
  const h = renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports,
    recentSports: sports[0] ? [sports[0].key] : [],
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
    ...over,
  });
  if (over.recentSports === undefined && sports[0]) {
    const opened = h.tree().filter((e) => e.type === "input" && propsOf(e).name === "division-sport" && propsOf(e).checked === true).map((e) => propsOf(e).value);
    if (opened.length !== 1 || opened[0] !== sports[0].key) throw new Error(`the builder opened on ${opened.join(",")}, not ${sports[0].key}`);
  }
  return h;
};
type H = ReturnType<typeof mount>;
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const boxNumber = (h: H, id: string) => Number(propsOf(byTestId(h, id)!).value);

/** The rulebook fact the guard rests on: Americano/Mexicano (stage kind "americano") pairs up individual players (the
 *  server mints the pairs), so the DIVISION must take individual players (C9 review 2, N1). */
const playableBy = (kinds: readonly string[]) => (key: string) =>
  !STAGE_TEMPLATES.find((t) => t.key === key)!
    .build({ qualified: 4, swissRounds: 4, poolCount: 2, legs: 1 })
    .some((s) => s.kind === "americano" && !kinds.includes("individual"));
/** A partner-rotation format (Americano, Mexicano): its stages include the stage kind that pairs up individuals. */
const isRotation = (key: string) =>
  STAGE_TEMPLATES.find((t) => t.key === key)!
    .build({ qualified: 4, swissRounds: 4, poolCount: 2, legs: 1 })
    .some((s) => s.kind === "americano");
const modelOfSport = (key: string) => effectiveEntrantModel(builtinModules.find((m) => m.key === key)!.entrantModel ?? null, null);
const sportKinds = (key: string) => modelOfSport(key).kinds;
/** The kinds an untouched division of this sport takes (n3: its default kind, alone). */
const untouchedKinds = (key: string) => [modelOfSport(key).defaultKind];

/** The suggester's ranking for the sport on screen, at the plan the Format step's boxes open at. */
function suggestersRanking(h: H, sportKey: string): string[] {
  const plan = {
    entrants: boxNumber(h, "division-builder-plan-entrants"),
    venues: boxNumber(h, "division-builder-plan-venues"),
    hours: boxNumber(h, "division-builder-plan-hours"),
    matchMinutes: boxNumber(h, "division-builder-match-minutes"),
  };
  // The offer as the page asks for it: the sport's ENGINE entrant kinds (review I5).
  const offered = templatesForSport(sportKey, sportKinds(sportKey)).map((t) => t.key);
  return rankTemplates(offered, plan, { qualified: 4, swissRounds: swissRoundsDefault(plan.entrants), poolCount: 2, legs: 1 }).map((r) => r.key);
}
/** The suggester's first that a division taking these kinds can play (untouched: the sport's default kind, n3) and that
 *  is not a partner-rotation format while another is (I1: the grid shows those last, and the builder opens on the first
 *  card shown). */
const suggestersPick = (h: H, sportKey: string, kinds: readonly string[] = untouchedKinds(sportKey)): string => {
  const playable = suggestersRanking(h, sportKey).filter(playableBy(kinds));
  return (playable.find((k) => !isRotation(k)) ?? playable[0])!;
};

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation(async (url: string) => (String(url).endsWith("/divisions") ? { id: "d1", slug: "open" } : {}));
});

describe("Q5: the builder opens on the top suggestion", () => {
  it("every sport: the picked card on Format is the suggester's first other than Americano/Mexicano, and never League (counts)", () => {
    let checked = 0;
    let differsFromLeague = 0;
    let movedPastRotation = 0;
    let offerLacksAmericano = 0;
    for (const m of builtinModules) {
      const h = mount(sportsFor(m.key));
      setName(h, "Open");
      next(h);
      const want = suggestersPick(h, m.key);
      expect(pickedTemplate(h), m.key).toBe(want);
      expect(pickedTemplate(h), `${m.key}: the first card shown`).toBe(visibleTemplateKeys(h)[0]);
      if (want !== "league") differsFromLeague++;
      if (isRotation(suggestersRanking(h, m.key)[0]!)) movedPastRotation++;
      if (!suggestersRanking(h, m.key).includes("americano")) offerLacksAmericano++;
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
    expect(differsFromLeague, "League, the old default, is not the top suggestion").toBe(checked);
    // I1: the sports whose ranking puts Americano first open past it (the five individual-default racket/table sports and
    // generic); the sports whose offer lost Americano (I5) open on the ranking's very first.
    expect(movedPastRotation, "sports whose ranking's first is Americano/Mexicano").toBeGreaterThan(0);
    expect(offerLacksAmericano, "sports whose engine model cannot play Americano (I5)").toBeGreaterThan(0);
  });

  it("Q3 with Q5: a generic division narrowed to Teams on Who plays opens on a format teams can play", () => {
    const h = mount(sportsFor("generic"));
    setName(h, "Open");
    next(h);
    const opensOn = pickedTemplate(h);
    expect(opensOn).toBe(suggestersPick(h, "generic"));
    expect(opensOn, "premise: generic opens on the first card shown").toBe(visibleTemplateKeys(h)[0]);
    goToStep(h, "who");
    const teams = h.tree().find((e) => e.type === "input" && propsOf(e).type === "radio" && propsOf(e).value === "team");
    (propsOf(teams!).onChange as () => void)();
    goToStep(h, "format");
    // Since I1 the untouched division never opened on Americano either, so the narrowed one may open on the same card; what
    // narrowing changes is the OFFER - teams are offered no partner-rotation format - and the opening is still its first.
    expect(templateKeys(h).some(isRotation), "the Teams division is offered no Americano/Mexicano").toBe(false);
    expect(pickedTemplate(h)).toBe(suggestersPick(h, "generic", ["team"]));
    expect(pickedTemplate(h)).toBe(visibleTemplateKeys(h)[0]);
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
    const kinds = STAGE_TEMPLATES.find((t) => t.key === want)!.build({ qualified: 4, swissRounds: 4, poolCount: 2, legs: 1 }).map((s) => s.kind);
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

// C9 round 4, owner ruling I1 ("A", 2026-11-03): Format opens on the FIRST CARD SHOWN - the same rule as Sport (round 3).
// The picker puts Americano and Mexicano after every other card (R2), so a sport whose suggester ranks one of them first
// (badminton, tennis, table tennis, carrom, generic: their Individuals offer) used to open on a card pinned into the last
// collapsed slot. The expected card is read off the grid the organiser sees (the first card not folded away), never off
// the builder's own helpers; the kinds swept are each sport's engine entrant model.
describe("I1: the builder opens Format on the first card shown", () => {
  /** Who plays, narrowed to `kind` as a tap on its radio does (no tap when it is the sport's own default; a one-kind
   *  sport shows no kind radios at all). */
  const pickKind = (h: H, sportKey: string, kind: string) => {
    const radio = h.tree().find((e) => e.type === "input" && propsOf(e).name === "division-entrant-kind" && propsOf(e).value === kind);
    if (!radio && sportKinds(sportKey).length === 1) return;
    if (!radio) throw new Error(`no ${kind} radio`);
    if (propsOf(radio).checked !== true) (propsOf(radio).onChange as () => void)();
  };

  it("empty case first: a sport whose offer holds no partner-rotation format opens on its first card too", () => {
    const h = mount(sportsFor("football"));
    setName(h, "Open");
    next(h);
    expect(templateKeys(h).some((k) => isRotation(k)), "premise: football is offered no Americano").toBe(false);
    expect(pickedTemplate(h)).toBe(visibleTemplateKeys(h)[0]);
  });

  it("every sport x every kind its engine model takes: the opening pick is the first visible card (counts)", () => {
    let checked = 0;
    let rankedRotationFirst = 0;
    for (const m of builtinModules) {
      for (const kind of sportKinds(m.key)) {
        const h = mount(sportsFor(m.key));
        setName(h, "Open");
        pickKind(h, m.key, kind);
        next(h);
        expect(currentStep(h), `${m.key}/${kind}`).toBe("format");
        const shown = visibleTemplateKeys(h);
        expect(shown.length, `${m.key}/${kind}: some card is shown`).toBeGreaterThan(0);
        expect(pickedTemplate(h), `${m.key}/${kind}: shown ${shown.join(",")}`).toBe(shown[0]);
        expect(isRotation(shown[0]!), `${m.key}/${kind}: a partner-rotation format is never the first card`).toBe(false);
        // The witness: the suggester's own first for this division is a partner-rotation format - the I1 case, where the
        // old opening (the ranking's first) and the right one differ.
        if (isRotation(suggestersRanking(h, m.key).find(playableBy([kind]))!)) rankedRotationFirst++;
        checked++;
      }
    }
    const expected = builtinModules.reduce((n, m) => n + sportKinds(m.key).length, 0);
    console.info(`[I1 sweep] ${checked} sport x kind cells, ${rankedRotationFirst} where the ranking's first is Americano/Mexicano`);
    expect(checked).toBe(expected);
    expect(checked).toBeGreaterThan(builtinModules.length);
    expect(rankedRotationFirst, "cells the old opening got wrong").toBeGreaterThan(0);
  });
});

// Found in fix round 1 (a scout audit of every e2e that walks the builder): a Community organisation's plan locks
// Americano (formats.advanced), so opening on it put a locked card under the organiser and Next refused it until they
// picked another - division-delete.spec, pricing-v3.spec's Free cap and event-pass's Free rig would all have stopped on
// Format. The builder opens on the suggester's first that the division can play AND the plan includes. The lock map is
// the Community one as doc 10 §1 states it (formats.advanced: the americano and ladder kinds; formats.double_elim:
// double_elim and page_playoff) over the templates carrying those kinds, typed as format-gates.test.ts types it - never
// read off templateLocksFor.
describe("Q5 on a plan that locks the top suggestion (Community)", () => {
  const COMMUNITY_LOCKS: Readonly<Record<string, string>> = {
    americano: "formats.advanced",
    mexicano: "formats.advanced",
    ladder: "formats.advanced",
    group_playoffs: "formats.double_elim",
    swiss_playoff: "formats.double_elim",
    double_elim: "formats.double_elim",
  };
  const notLocked = (key: string) => COMMUNITY_LOCKS[key] === undefined;

  it("empty case first: a plan that locks nothing opens where Pro does", () => {
    const h = mount(sportsFor("badminton"), { templateLocks: {} });
    setName(h, "Open");
    next(h);
    expect(pickedTemplate(h)).toBe(suggestersPick(h, "badminton"));
  });

  it("every sport opens on the first card shown that it can play and the plan includes, and Next leaves Format (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const h = mount(sportsFor(m.key), { templateLocks: COMMUNITY_LOCKS, viewerPlan: "community" });
      setName(h, "Open");
      next(h);
      // The grid's order (every card, folded or not), the first the plan includes.
      const want = templateKeys(h).find(notLocked);
      expect(want, `${m.key}: something is open to a Community plan`).toBeDefined();
      expect(pickedTemplate(h), m.key).toBe(want);
      // The step the organiser opens on is never refused: Next leaves Format.
      next(h);
      expect(stepError(h), m.key).toBeNull();
      expect(currentStep(h), m.key).toBe("rules");
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    // Since I1 no Community lock reaches the first card shown (the lock's old case, Americano first, opens past it now),
    // so this sweep alone no longer moves an opening: the next test locks the first card itself.
  });

  it("a plan that locks the first card shown opens on the next card shown, every sport (counts)", () => {
    let checked = 0;
    for (const m of builtinModules) {
      const open = mount(sportsFor(m.key));
      setName(open, "Open");
      next(open);
      const first = visibleTemplateKeys(open)[0]!;
      expect(pickedTemplate(open), `${m.key}: unlocked, the first card`).toBe(first);
      const h = mount(sportsFor(m.key), { templateLocks: { [first]: "formats.advanced" }, viewerPlan: "community" });
      setName(h, "Open");
      next(h);
      const want = templateKeys(h).find((k) => k !== first);
      expect(want, `${m.key}: a second card`).toBeDefined();
      expect(pickedTemplate(h), `${m.key}: the lock on ${first} moves the opening`).toBe(want);
      next(h);
      expect(currentStep(h), m.key).toBe("rules");
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
  });

  it("a locked card the organiser picks is still refused by name (the lock is not lifted, only not opened on)", () => {
    const h = mount(sportsFor("badminton"), { templateLocks: COMMUNITY_LOCKS, viewerPlan: "community" });
    setName(h, "Open");
    next(h);
    pickTemplate(h, "americano");
    next(h);
    expect(currentStep(h)).toBe("format");
    expect(stepError(h)).not.toBeNull();
  });
});
