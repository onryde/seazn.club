// Match Day C9 fix round 1 (m2): the Format step's estimates assume a match length, and the plan note names it.
//
// The length is set on Division rules (step 3), after Format. The note on Format says which length its estimates use,
// and after the organiser types a new one and goes Back, the picked card's estimate and Review's total read the same
// time. Expected values come from the match-length box the organiser sees and from the dictionaries' own templates -
// never from the builder's estimate helpers. One sport (badminton): the note and the shared length do not depend on
// the sport (the every-sport walk in division-builder-steps.test.tsx covers the per-sport offer).
//
// m15 rides here because it is Review's time total: the receipt reads its OWN places keys (divBuilder.places.*), not the
// Match Day header's. The two read alike in every locale today, so the text cannot tell them apart - the test records
// the keys the builder asks the dictionary for instead.
import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { sportOptionsFrom } from "@/lib/sport-options";
import uiEn from "@/dictionaries/en/ui.json";
import { back, byTestId, currentStep, goToStep, next, pickedTemplate, setName } from "./_division-builder-driver";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
const { keysRead } = vi.hoisted(() => ({ keysRead: [] as string[] }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...real,
    useLocale: () => "en" as const,
    // The real lookups, recording each key asked for.
    useMsg: () => {
      const msg = real.useMsg();
      return (key: Parameters<typeof msg>[0], vars?: Record<string, string | number>) => (keysRead.push(key), msg(key, vars));
    },
    useMsgPlural: () => {
      const plural = real.useMsgPlural();
      return (key: string, count: number, vars?: Record<string, string | number>) => (keysRead.push(key), plural(key, count, vars));
    },
  };
});

const UI = uiEn as Record<string, string>;
const badminton = builtinModules.find((m) => m.key === "badminton")!;
const SPORTS: SportOption[] = sportOptionsFrom(
  [{ key: "badminton", name: "Badminton" }],
  Object.keys(badminton.variants).map((key) => ({ sport_key: "badminton", key, name: key, is_system: true, config: null })),
  () => {
    const model = effectiveEntrantModel(badminton.entrantModel ?? null, null);
    return { kinds: model.kinds, defaultKind: model.defaultKind };
  },
);
const mount = () =>
  renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "community",
  });
type H = ReturnType<typeof mount>;

/** A dictionary template turned into a matcher: each {placeholder} captures, the rest is literal. */
function templateMatcher(key: string): RegExp {
  const template = UI[key];
  if (!template) throw new Error(`no ${key} in en/ui.json`);
  const source = template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\w+)\}/g, (_m, name: string) => `(?<${name}>.+?)`);
  return new RegExp(`^${source}$`);
}
function read(key: string, text: string): Record<string, string> {
  const m = templateMatcher(key).exec(text);
  if (!m?.groups) throw new Error(`"${text}" does not read as ${key} ("${UI[key]}")`);
  return m.groups;
}
const noteMinutes = (h: H) => Number(read("divBuilder.plan.note", textOf(byTestId(h, "division-builder-plan-note")!)).minutes);
const boxMinutes = (h: H) => Number(propsOf(byTestId(h, "division-builder-match-minutes")!).value);
/** The picked card's "N matches · about T": T, read through divBuilder.card.about. */
function cardTime(h: H): string {
  const key = pickedTemplate(h)!;
  const parts = textOf(byTestId(h, `division-builder-estimate-${key}`)!).split(" · ");
  return read("divBuilder.card.about", parts.at(-1)!).time!;
}
/** Review's time total, read through divBuilder.review.time. */
function reviewTotal(h: H): { time: string; minutes: number } {
  const cell = h.tree().find((e) => propsOf(e)["data-total"] === "time");
  const groups = read("divBuilder.review.time", textOf(cell!));
  return { time: groups.time!, minutes: Number(groups.minutes) };
}
const setLength = (h: H, value: string) =>
  (propsOf(byTestId(h, "division-builder-match-minutes")!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });

describe("m2: the plan note names the match length the Format estimates assume", () => {
  it("opens naming the length in the match-length box (the empty case: nothing typed yet)", () => {
    const h = mount();
    setName(h, "Open");
    next(h);
    expect(currentStep(h)).toBe("format");
    expect(boxMinutes(h)).toBeGreaterThan(0);
    expect(noteMinutes(h)).toBe(boxMinutes(h));
  });

  it("25 typed on Division rules, then Back: the note says 25, and the picked card's estimate equals Review's", () => {
    const h = mount();
    setName(h, "Open");
    next(h);
    const opening = boxMinutes(h);
    const cardBefore = cardTime(h);
    // A case where the right answer differs from the wrong one: 25 is not the opening length.
    expect(opening).not.toBe(25);
    next(h);
    expect(currentStep(h)).toBe("rules");
    setLength(h, "25");
    back(h);
    expect(currentStep(h)).toBe("format");
    expect(noteMinutes(h)).toBe(25);
    const cardAfter = cardTime(h);
    expect(cardAfter, "the typed length moved the card's estimate").not.toBe(cardBefore);
    goToStep(h, "review");
    const total = reviewTotal(h);
    expect(total.minutes).toBe(25);
    expect(cardAfter).toBe(total.time);
  });
});

describe("m15: Review names its places with its own keys", () => {
  it("the time total's places read divBuilder.places.<venue>, and the builder asks for no matchDay.* key at all", () => {
    keysRead.length = 0;
    const h = mount();
    setName(h, "Open");
    goToStep(h, "review");
    const cell = h.tree().find((e) => propsOf(e)["data-total"] === "time");
    const places = read("divBuilder.review.time", textOf(cell!)).places!;
    // Badminton plays on courts; the plan opens at 2 of them (the Venues box).
    expect(places).toBe(UI["divBuilder.places.court.other"]!.replace("{count}", "2"));
    expect(keysRead).toContain("divBuilder.places.court");
    const borrowed = keysRead.filter((k) => k.startsWith("matchDay."));
    expect(borrowed).toEqual([]);
    expect(keysRead.length, "the recorder saw the builder's lookups").toBeGreaterThan(0);
  });
});

