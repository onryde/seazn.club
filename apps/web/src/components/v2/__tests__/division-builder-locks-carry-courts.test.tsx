// Match Day C9 fix round 1 (I3, I4): the builder's plan locks and two of its seams, driven through the builder itself.
//
// I3 - a format the organisation's plan does not include (`templateLocks`, from the page's templateLocksFor) and carried
// standings without `standings.carry_over` (`carryAllowed: false`) are refused on the Format step, named, with the
// UpgradeGate beside them, and each refusal has its cleared pair.
// I4 - K5: the carry select reaches the second stage's `progression.carry` in the stages request; S4: the courts the
// picker hands back reach the schedule-settings PUT's `config.courts`.
//
// Expected values come from the dictionaries, the organiser's own picks and the fixture's court ids - never from the
// builder's helpers. One sport (badminton) on purpose: the locks and the two seams do not depend on the sport (the
// every-sport walk in division-builder-steps.test.tsx covers the per-sport offer).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { UpgradeGate } from "@/components/upgrade-gate";
import { CourtMultiPicker } from "@/components/v2/shared/court-multi-picker";
import type { Court, Venue } from "@/components/v2/venues-panel";
import { sportOptionsFrom } from "@/lib/sport-options";
import uiEn from "@/dictionaries/en/ui.json";
import { byTestId, click, currentStep, goToStep, next, pickTemplate, pressCreate, setName, stepError } from "./_division-builder-driver";

const { apiV1Mock, pushMock } = vi.hoisted(() => ({ apiV1Mock: vi.fn(), pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: pushMock, replace: vi.fn() }),
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

const UI = uiEn as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
const badminton = builtinModules.find((m) => m.key === "badminton")!;
const SPORTS: SportOption[] = sportOptionsFrom(
  [{ key: "badminton", name: "Badminton" }],
  Object.keys(badminton.variants).map((key) => ({ sport_key: "badminton", key, name: key, is_system: true, config: null })),
  () => {
    const model = effectiveEntrantModel(badminton.entrantModel ?? null, null);
    return { kinds: model.kinds, defaultKind: model.defaultKind };
  },
);

function mount(over: Partial<Parameters<typeof DivisionBuilder>[0]> = {}) {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "community",
    ...over,
  });
}
type H = ReturnType<typeof mount>;
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const gates = (h: H): string[] => h.tree().filter((e) => e.type === UpgradeGate).map((e) => String(propsOf(e).feature));
const onFormat = (h: H) => {
  setName(h, "Open");
  next(h);
  expect(currentStep(h)).toBe("format");
  click(h, "division-builder-show-all");
};
const setCarry = (h: H, value: string) =>
  (propsOf(byTestId(h, "division-builder-carry")!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const calls = (re: RegExp) => apiV1Mock.mock.calls.filter(([url]) => re.test(String(url)));

beforeEach(() => {
  apiV1Mock.mockReset();
  pushMock.mockReset();
  apiV1Mock.mockImplementation(async (url: string) => (String(url).endsWith("/divisions") ? { id: "d1", slug: "open" } : {}));
});

describe("I3: a format the plan does not include (templateLocks)", () => {
  it("empty case first: no locks - double elimination is picked and Next goes on, with no gate", () => {
    const h = mount();
    onFormat(h);
    pickTemplate(h, "double_elim");
    expect(gates(h)).toEqual([]);
    next(h);
    expect(currentStep(h)).toBe("rules");
  });

  it("locked: Next is refused naming the format, the UpgradeGate shows its feature - and picking an open format clears both", () => {
    const h = mount({ templateLocks: { double_elim: "formats.double_elim" } });
    onFormat(h);
    pickTemplate(h, "double_elim");
    expect(gates(h)).toEqual(["formats.double_elim"]);
    next(h);
    expect(currentStep(h)).toBe("format");
    expect(stepError(h)).toBe(fill(UI["divBuilder.err.formatLocked"]!, { format: UI["format.template.double_elim.label"]! }));
    // The cleared pair: an open format, and the refusal and the gate are gone.
    pickTemplate(h, "league");
    expect(stepError(h)).toBeNull();
    expect(gates(h)).toEqual([]);
    next(h);
    expect(currentStep(h)).toBe("rules");
  });
});

describe("I3: carried standings without standings.carry_over (carryAllowed: false)", () => {
  it("empty case first: carry left at none is never refused, even without the feature", () => {
    const h = mount({ carryAllowed: false });
    onFormat(h);
    pickTemplate(h, "league_ko");
    expect(propsOf(byTestId(h, "division-builder-carry")!).value).toBe("none");
    expect(gates(h)).toEqual([]);
    next(h);
    expect(currentStep(h)).toBe("rules");
  });

  it("carry chosen without the feature: Next is refused with the carry sentence and its gate; back to none clears both", () => {
    const h = mount({ carryAllowed: false });
    onFormat(h);
    pickTemplate(h, "league_ko");
    setCarry(h, "points");
    expect(gates(h)).toEqual(["standings.carry_over"]);
    next(h);
    expect(currentStep(h)).toBe("format");
    expect(stepError(h)).toBe(UI["divBuilder.err.carryLocked"]);
    setCarry(h, "none");
    expect(stepError(h)).toBeNull();
    expect(gates(h)).toEqual([]);
    next(h);
    expect(currentStep(h)).toBe("rules");
  });

  it("the positive pair: with the feature, the same carry goes on", () => {
    const h = mount({ carryAllowed: true });
    onFormat(h);
    pickTemplate(h, "league_ko");
    setCarry(h, "points");
    expect(gates(h)).toEqual([]);
    next(h);
    expect(currentStep(h)).toBe("rules");
  });
});

describe("I4 (K5): the carry select reaches the stages request", () => {
  it("each carry the select offers lands on the SECOND stage's progression.carry; none sends no carry (counts)", async () => {
    let checked = 0;
    for (const carry of ["points", "full", "none"] as const) {
      apiV1Mock.mockClear();
      const h = mount({ carryAllowed: true });
      onFormat(h);
      pickTemplate(h, "league_ko");
      setCarry(h, carry);
      goToStep(h, "review");
      pressCreate(h);
      await flush();
      const post = calls(/\/stages$/).at(-1);
      const stages = (post![1] as { json: { kind: string; progression: { carry?: string } | null }[] }).json;
      expect(stages.map((s) => s.kind), carry).toEqual(["league", "knockout"]);
      expect(stages[0]!.progression, carry).toBeNull();
      if (carry === "none") expect(stages[1]!.progression && Object.hasOwn(stages[1]!.progression, "carry"), carry).toBe(false);
      else expect(stages[1]!.progression?.carry, carry).toBe(carry);
      checked++;
    }
    expect(checked).toBe(3);
  });
});

describe("I4 (S4): the courts picked reach the schedule seed", () => {
  const court = (id: string, name: string, sort: number): Court => ({
    id, venue_id: "v-1", name, sort, tags: [], archived_at: null, created_at: "2026-01-01T00:00:00.000Z", hours: [], exceptions: [],
  });
  const VENUES: Venue[] = [
    { id: "v-1", name: "Main Hall", address: null, sort: 0, archived_at: null, created_at: "2026-01-01T00:00:00.000Z", courts: [court("c-1", "Court 1", 0), court("c-2", "Court 2", 1)] },
  ];
  const picker = (h: H): ReactElement => {
    const el = h.tree().find((e) => e.type === CourtMultiPicker);
    if (!el) throw new Error("no CourtMultiPicker");
    return el;
  };

  it("empty case first: no court picked - the PUT's config.courts is an empty list", async () => {
    const h = mount({ venues: VENUES });
    setName(h, "Open");
    goToStep(h, "review");
    pressCreate(h);
    await flush();
    const put = calls(/\/schedule-settings$/).at(-1);
    expect((put![1] as { method: string }).method).toBe("PUT");
    expect((put![1] as { json: { config: { courts: string[] } } }).json.config.courts).toEqual([]);
  });

  it("the picker's courts, as it hands them back, are the PUT's config.courts - and the picker shows them picked", async () => {
    const h = mount({ venues: VENUES });
    setName(h, "Open");
    goToStep(h, "rules");
    expect(propsOf(picker(h)).venues).toBe(VENUES);
    (propsOf(picker(h)).onChange as (ids: string[]) => void)(["c-2", "c-1"]);
    expect(propsOf(picker(h)).value).toEqual(["c-2", "c-1"]);
    goToStep(h, "review");
    pressCreate(h);
    await flush();
    const put = calls(/\/schedule-settings$/).at(-1);
    expect((put![1] as { json: { config: { courts: string[] } } }).json.config.courts).toEqual(["c-2", "c-1"]);
  });
});
