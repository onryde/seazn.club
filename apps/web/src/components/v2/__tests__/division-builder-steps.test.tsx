// Match Day C9 (owner 2026-11-02): the division builder's four steps - Who plays, Format, Division rules, Review.
//
// What is pinned here, through the builder's real handlers (the hook harness; `apiV1` and the router captured):
//   - each step's Next is refused with the reason while the step is not done, and a jump forward stops on the first
//     unfinished step; going back is free, and nothing typed is lost moving between steps (every step stays mounted);
//   - Edit from Review opens the row's step with a way straight back, and the receipt shows what was changed there;
//   - Create stays disabled (with the reason and a way to the step) while any step is blocked;
//   - a server refusal lands on the step that holds its field; a division created whose stages were refused is not
//     created twice (Create then sends the stages only);
//   - the entrant kind: nothing is sent at the sport's own default, the kind and every kind the sport allows otherwise;
//     the default is the ENGINE's per sport (volleyball teams, badminton individuals), and an untouched kind follows the sport;
//   - chess with online play: Lichess without one of its eight controls is refused on Division rules; with one, it is sent;
//   - Create lands on the new division's Fixtures tab (the stage cards);
//   - every builtin sport: its whole offer on the Format step, four suggested, its venue noun in the plan, the rules strip
//     on Division rules, the engine's entrant kinds, and a Create that sends the sport's own variant (counted).
// Expected values come from the engine (`builtinModules`, entrant models, variant presets), the dictionaries, the Lichess
// catalogue and the owner's rulings - never from the builder.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, divisionCreateConfig, eligibilityPatch, type SportOption } from "@/components/v2/division-builder";
import { templatesForSport } from "@/lib/format-templates";
import { sportOptionsFrom } from "@/lib/sport-options";
import { pickVariant } from "@/lib/preferred-variant";
import { venueNoun } from "@/lib/venue";
import { selectedTimeControlKey, timeControlRuleValues } from "@/lib/online-time-control";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import { SUGGESTED_COUNT } from "@/lib/division-builder/model";
import { ApiV1Error } from "@/lib/client-v1";
import uiEn from "@/dictionaries/en/ui.json";
import {
  byTestId,
  click,
  currentStep,
  goToStep,
  next,
  pickTemplate,
  pickedTemplate,
  pressCreate,
  rulesDraft,
  rulesStripProps,
  selectSport,
  setName,
  stepError,
  templateCards,
  templateKeys,
  visibleTemplateKeys,
  walkToReview,
} from "./_division-builder-driver";

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

/** Every builtin sport as the page hands it to the builder: the engine's variant presets and entrant model. */
const modelOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return effectiveEntrantModel(m.entrantModel ?? null, null);
};
const variantRows = builtinModules.flatMap((m) =>
  Object.entries(m.variants as Record<string, Record<string, unknown>>).map(([key, config]) => ({ sport_key: m.key, key, name: key, is_system: true, config })),
);
const ALL: SportOption[] = sportOptionsFrom(
  builtinModules.map((m) => ({ key: m.key, name: m.key })),
  variantRows,
  (key) => {
    const model = modelOf(key);
    return { kinds: model.kinds, defaultKind: model.defaultKind };
  },
);
const sportsFor = (...keys: string[]): SportOption[] => keys.map((k) => ALL.find((s) => s.key === k)!);

function mount(sports: SportOption[], over: Partial<Parameters<typeof DivisionBuilder>[0]> = {}) {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports,
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
    ...over,
  });
}
type H = ReturnType<typeof mount>;

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const posts = (path: RegExp) => apiV1Mock.mock.calls.filter(([url]) => path.test(String(url)));
const divisionBody = () => {
  const call = posts(/\/divisions$/).at(-1);
  if (!call) throw new Error("no division POST");
  return (call[1] as { json: Record<string, unknown> }).json;
};
/** The create succeeds: the division answers `{id, slug}`, everything else `{}`. */
function serverAccepts() {
  apiV1Mock.mockImplementation(async (url: string) => (String(url).endsWith("/divisions") ? { id: "d1", slug: "open" } : {}));
}
const entrantChips = (h: H) => {
  const set = byTestId(h, "division-builder-entrant-kind");
  return set === undefined ? [] : walk(set).filter((e) => e.type === "label" && typeof propsOf(e)["data-entrant-kind"] === "string");
};
const checkedKind = (h: H): string | undefined => {
  const chip = entrantChips(h).find((l) => walk(l).some((e) => e.type === "input" && propsOf(e).checked === true));
  return chip === undefined ? undefined : (propsOf(chip)["data-entrant-kind"] as string);
};
function pickKind(h: H, kind: EntrantKind) {
  const chip = entrantChips(h).find((l) => propsOf(l)["data-entrant-kind"] === kind);
  if (!chip) throw new Error(`no ${kind} chip`);
  (propsOf(walk(chip).find((e) => e.type === "input")!).onChange as () => void)();
}
const reviewRow = (h: H, id: string): string => {
  const row = h.tree().find((e) => e.type === "li" && propsOf(e)["data-review-row"] === id);
  if (!row) throw new Error(`no review row ${id}`);
  return textOf(row);
};

beforeEach(() => {
  apiV1Mock.mockReset();
  pushMock.mockReset();
  serverAccepts();
});

describe("the four steps", () => {
  it("are the owner's four, in order, each a 44px target; below md the labels fold and the step is named under them", () => {
    const h = mount(sportsFor("badminton"));
    const buttons = ["who", "format", "rules", "review"].map((s) => byTestId(h, `division-builder-step-${s}`));
    expect(buttons.map((b) => b && textOf(b).trim())).toEqual([UI["divBuilder.step.who"], UI["wizard.tab.format"], UI["rulesStrip.title"], UI["divBuilder.step.review"]]);
    for (const b of buttons) expect(String(propsOf(b!).className)).toMatch(/(^|\s)min-h-11(\s|$)/);
    // One DOM: the label is sr-only below md (the number stays), and a phone-only line names the step.
    for (const b of buttons) {
      const label = walk(b!).find((e) => e.type === "span" && /max-md:sr-only/.test(String(propsOf(e).className)));
      expect(label, "the step's name folds to sr-only below md").toBeDefined();
    }
    const line = byTestId(h, "division-builder-step-label")!;
    expect(String(propsOf(line).className)).toMatch(/(^|\s)md:hidden(\s|$)/);
    expect(textOf(line)).toContain(fill(UI["divBuilder.stepOf"]!, { n: 1, total: 4 }));
    expect(currentStep(h)).toBe("who");
  });

  it("Next is refused on an unfinished step with the reason, and goes on once it is done", () => {
    const h = mount(sportsFor("badminton"));
    next(h);
    expect(currentStep(h)).toBe("who");
    expect(stepError(h)).toBe(UI["wizard.err.name"]);
    setName(h, "Open");
    next(h);
    expect(currentStep(h)).toBe("format");
    expect(stepError(h), "the refusal goes with the step that raised it").toBeNull();
  });

  it("a jump forward stops on the FIRST unfinished step; a jump back is free", () => {
    const h = mount(sportsFor("badminton"));
    goToStep(h, "review");
    expect(currentStep(h), "no name: the jump stops on Who plays").toBe("who");
    expect(stepError(h)).toBe(UI["wizard.err.name"]);
    setName(h, "Open");
    goToStep(h, "review");
    expect(currentStep(h), "every step clear: the jump lands").toBe("review");
    goToStep(h, "who");
    expect(currentStep(h)).toBe("who");
    expect(stepError(h)).toBeNull();
  });

  it("nothing typed is lost moving between steps: name, category, age, a format and its knob survive Back and Next", () => {
    const h = mount(sportsFor("badminton"));
    setName(h, "Under 16 girls");
    const womens = h.tree().find((e) => e.type === "input" && propsOf(e).name === "division-category" && propsOf(e).value === "womens")!;
    (propsOf(womens).onChange as () => void)();
    click(h, "division-builder-eligibility-toggle");
    (propsOf(byTestId(h, "division-builder-age")!).onChange as (e: unknown) => void)({ target: { value: "16" } });
    next(h);
    pickTemplate(h, "groups_ko");
    const pools = h.tree().find((e) => propsOf(e)["data-format-bound"] === "pools")!;
    (propsOf(pools).onChange as (e: unknown) => void)({ target: { value: "4" } });
    next(h);
    expect(currentStep(h)).toBe("rules");
    click(h, "division-builder-back");
    click(h, "division-builder-back");
    expect(currentStep(h)).toBe("who");
    expect(propsOf(byTestId(h, "division-builder-name")!).value).toBe("Under 16 girls");
    expect(propsOf(h.tree().find((e) => e.type === "input" && propsOf(e).name === "division-category" && propsOf(e).checked === true)!).value).toBe("womens");
    expect(propsOf(byTestId(h, "division-builder-age")!).value).toBe("16");
    next(h);
    expect(pickedTemplate(h)).toBe("groups_ko");
    expect(Number(propsOf(h.tree().find((e) => propsOf(e)["data-format-bound"] === "pools")!).value)).toBe(4);
  });
});

describe("Review: a receipt, Edit back to each step, Create", () => {
  it("Edit on the Format row opens Format with a way straight back; the receipt shows the change", () => {
    const h = mount(sportsFor("badminton"));
    walkToReview(h);
    expect(byTestId(h, "division-builder-back-to-review"), "not offered on a normal walk").toBeUndefined();
    expect(reviewRow(h, "format")).toContain(UI["format.template.league.label"]);
    click(h, "division-builder-edit-format");
    expect(currentStep(h)).toBe("format");
    expect(byTestId(h, "division-builder-back-to-review"), "Edit offers the way back").toBeDefined();
    pickTemplate(h, "swiss");
    click(h, "division-builder-back-to-review");
    expect(currentStep(h)).toBe("review");
    expect(reviewRow(h, "format")).toContain(UI["format.template.swiss.label"]);
    expect(reviewRow(h, "format")).not.toContain(UI["format.template.league.label"]);
    // The second visit, by the step nav (not from Review): no Back to review.
    goToStep(h, "who");
    expect(byTestId(h, "division-builder-back-to-review")).toBeUndefined();
  });

  it("every row's Edit opens the step that holds it, and each row says where it can be changed later (counts)", () => {
    const h = mount(sportsFor("badminton"));
    walkToReview(h);
    const rows = h.tree().filter((e) => e.type === "li" && typeof propsOf(e)["data-review-row"] === "string");
    const want: Record<string, string> = { who: "who", format: "format", rules: "rules", points: "rules", tiebreaks: "rules", schedule: "rules" };
    expect(rows.map((r) => propsOf(r)["data-review-row"])).toEqual(Object.keys(want));
    let checked = 0;
    for (const [row, step] of Object.entries(want)) {
      goToStep(h, "review");
      click(h, `division-builder-edit-${row}`);
      expect(currentStep(h), row).toBe(step);
      checked++;
    }
    expect(checked).toBe(6);
    goToStep(h, "review");
    for (const [row, key] of [
      ["who", "divBuilder.review.later.who"],
      ["format", "divBuilder.review.later.format"],
      ["rules", "divBuilder.review.later.rules"],
      ["schedule", "divBuilder.review.later.schedule"],
    ] as const) {
      expect(reviewRow(h, row), row).toContain(UI[key]);
    }
  });

  it("a format with no table (knockout) shows no points or tie-break rows: nothing is sent for them", () => {
    const h = mount(sportsFor("badminton"));
    setName(h, "Cup");
    next(h);
    pickTemplate(h, "knockout");
    next(h);
    next(h);
    const rows = h.tree().filter((e) => e.type === "li" && typeof propsOf(e)["data-review-row"] === "string").map((r) => propsOf(r)["data-review-row"]);
    expect(rows).toEqual(["who", "format", "rules", "schedule"]);
  });

  it("Create is disabled while a step is blocked, says which and why, and offers the way there", () => {
    const h = mount(sportsFor("badminton"));
    walkToReview(h);
    expect(propsOf(byTestId(h, "division-builder-create")!).disabled).toBe(false);
    expect(byTestId(h, "division-builder-blocked")).toBeUndefined();
    setName(h, " "); // the name field stays mounted under Review; blanking it blocks Who plays
    expect(propsOf(byTestId(h, "division-builder-create")!).disabled).toBe(true);
    const notice = byTestId(h, "division-builder-blocked")!;
    expect(textOf(notice)).toContain(fill(UI["divBuilder.review.blocked"]!, { step: UI["divBuilder.step.who"]!, reason: UI["wizard.err.name"]! }));
    const go = walk(notice).find((e) => e.type === "button")!;
    (propsOf(go).onClick as () => void)();
    expect(currentStep(h)).toBe("who");
  });
});

describe("Create", () => {
  it("POSTs the division, then its stages, then the schedule seed, and lands on the new division's Fixtures tab", async () => {
    const h = mount(sportsFor("badminton"));
    walkToReview(h, "Open");
    pressCreate(h);
    await flush();
    const order = apiV1Mock.mock.calls.map(([url, opts]) => `${(opts as { method?: string }).method} ${String(url)}`);
    expect(order).toEqual(["POST /api/v1/competitions/c1/divisions", "POST /api/v1/divisions/d1/stages", "PUT /api/v1/divisions/d1/schedule-settings"]);
    // A9 (owner): land on the stage cards, where Generate names what it is waiting for.
    expect(pushMock).toHaveBeenCalledWith("/o/org/c/comp/d/open?tab=fixtures");
  });

  it("a refusal lands on the step that holds its field (counts)", async () => {
    let checked = 0;
    for (const [code, phase, step] of [
      ["CONFIG_INVALID", "division", "rules"],
      ["INVALID_TIME_CONTROL", "division", "rules"],
      ["CHESS_INDIVIDUAL_ONLY", "division", "who"],
      ["COMPETITION_ENDED", "division", "review"],
      ["STAGE_SWISS_ROUNDS_REQUIRED", "stages", "format"],
      ["VALIDATION_FAILED", "stages", "format"],
    ] as const) {
      apiV1Mock.mockReset();
      apiV1Mock.mockImplementation(async (url: string) => {
        if (String(url).endsWith(phase === "division" ? "/divisions" : "/stages")) throw new ApiV1Error("refused", 422, code, {});
        return String(url).endsWith("/divisions") ? { id: "d1", slug: "open" } : {};
      });
      const h = mount(sportsFor("badminton"));
      walkToReview(h, "Open");
      pressCreate(h);
      await flush();
      expect(currentStep(h), code).toBe(step);
      expect(stepError(h), `${code}: said on that step`).not.toBeNull();
      expect(pushMock, code).not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("COMPETITION_ENDED says the competition's own sentence, not the server's English", async () => {
    apiV1Mock.mockImplementation(async () => {
      throw new ApiV1Error("Competition has ended", 409, "COMPETITION_ENDED", {});
    });
    const h = mount(sportsFor("badminton"));
    walkToReview(h, "Open");
    pressCreate(h);
    await flush();
    expect(stepError(h)).toBe(UI["division.create.competitionEnded"]);
  });

  it("stages refused after the division was made: Create again sends the stages only, never a second division", async () => {
    let stagesRefused = 0;
    apiV1Mock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/stages") && stagesRefused === 0) {
        stagesRefused++;
        throw new ApiV1Error("rounds", 422, "STAGE_SWISS_ROUNDS_REQUIRED", {});
      }
      return String(url).endsWith("/divisions") ? { id: "d1", slug: "open" } : {};
    });
    const h = mount(sportsFor("badminton"));
    walkToReview(h, "Open");
    pressCreate(h);
    await flush();
    expect(currentStep(h)).toBe("format");
    expect(stepError(h)).toBe(UI["stage.err.swissRoundsRequired"]);
    next(h);
    next(h);
    expect(currentStep(h)).toBe("review");
    expect(textOf(byTestId(h, "division-builder-created-no-stages")!)).toContain("Open");
    expect(textOf(byTestId(h, "division-builder-create")!).trim()).toBe(UI["divBuilder.create.stages"]);
    pressCreate(h);
    await flush();
    expect(posts(/\/divisions$/).length, "the division is POSTed once").toBe(1);
    expect(posts(/\/stages$/).length, "the stages twice: refused, then sent").toBe(2);
    expect(pushMock).toHaveBeenCalledWith("/o/org/c/comp/d/open?tab=fixtures");
  });
});

describe("the entrant kind (asked at creation; the engine's model per sport)", () => {
  it("left at the sport's default, nothing is sent; another kind is sent with every kind the sport allows", async () => {
    const untouched = mount(sportsFor("badminton"));
    walkToReview(untouched, "Open");
    pressCreate(untouched);
    await flush();
    expect(Object.hasOwn(divisionBody().config as object, "entrants"), "the default kind sends nothing").toBe(false);

    apiV1Mock.mockClear();
    const pairs = mount(sportsFor("badminton"));
    pickKind(pairs, "pair");
    walkToReview(pairs, "Doubles");
    expect(reviewRow(pairs, "who")).toContain(UI["divBuilder.entrants.kind.pair"]);
    pressCreate(pairs);
    await flush();
    expect((divisionBody().config as { entrants?: unknown }).entrants).toEqual({ kinds: [...modelOf("badminton").kinds], defaultKind: "pair" });
  });

  it("opens at the engine's default per sport - teams for volleyball, individuals for badminton (class 19)", () => {
    expect(modelOf("volleyball").defaultKind, "premise").toBe("team");
    expect(modelOf("badminton").defaultKind, "premise").toBe("individual");
    expect(checkedKind(mount(sportsFor("volleyball", "badminton")))).toBe("team");
    expect(checkedKind(mount(sportsFor("badminton", "volleyball")))).toBe("individual");
  });

  it("an untouched kind follows a sport change; a chosen one stays where the new sport allows it", () => {
    const untouched = mount(sportsFor("volleyball", "badminton"));
    selectSport(untouched, "badminton");
    expect(checkedKind(untouched)).toBe("individual");
    const chosen = mount(sportsFor("badminton", "tennis", "football"));
    pickKind(chosen, "pair");
    selectSport(chosen, "tennis");
    expect(checkedKind(chosen), "tennis allows pairs").toBe("pair");
    selectSport(chosen, "football");
    expect(entrantChips(chosen), "football is teams only: no choice").toEqual([]);
    expect(textOf(byTestId(chosen, "division-builder-entrant-kind")!)).toContain(UI["divBuilder.entrants.only.team"]);
  });

  it("a sport with one kind says it in words, with no choice to make", () => {
    const h = mount(sportsFor("football"));
    expect(entrantChips(h)).toEqual([]);
    expect(textOf(byTestId(h, "division-builder-entrant-kind")!)).toContain(UI["divBuilder.entrants.only.team"]);
  });
});

describe("chess: online play first, and Lichess plays only its eight controls", () => {
  const chess = sportsFor("boardgame")[0]!;
  // A chess variant whose preset clock is NOT one of Lichess's controls (the refusal case), and the catalogue's first
  // control (the positive pair): both from the catalogue and the presets, not the builder.
  const offClock = chess.variants.find((v) => selectedTimeControlKey({}, v.config ?? {}) === "");

  it("premises: Lichess's catalogue is eight controls, and a chess preset exists whose clock is none of them", () => {
    expect(SHIP1_TIME_CONTROLS.length).toBe(8);
    expect(offClock, "a chess variant off the Lichess catalogue").toBeDefined();
  });

  it("Lichess with no control is refused on Division rules; one picked, it is sent with its clock", async () => {
    const h = mount([{ ...chess, variants: [offClock!] }], { onlineChessOffered: true });
    setName(h, "Online blitz");
    next(h);
    next(h);
    expect(currentStep(h)).toBe("rules");
    expect(rulesStripProps(h).onlineChessOffered).toBe(true);
    rulesDraft(h).setOnlinePlay("lichess");
    next(h);
    expect(currentStep(h)).toBe("rules");
    expect(stepError(h)).toBe(UI["divBuilder.err.timeControl"]);
    const control = SHIP1_TIME_CONTROLS[0]!.key;
    const values = timeControlRuleValues(control)!;
    rulesDraft(h).setRuleValues((v) => ({ ...v, ...values }));
    next(h);
    expect(currentStep(h)).toBe("review");
    expect(reviewRow(h, "rules")).toContain(control);
    pressCreate(h);
    await flush();
    const config = divisionBody().config as Record<string, unknown>;
    expect(config.onlinePlay).toBe("lichess");
    expect(selectedTimeControlKey({}, config), "the clock sent IS the control picked").toBe(control);
  });

  it("the positive pair: a club not offered online chess sends no online play, whatever the draft holds", async () => {
    const h = mount([{ ...chess, variants: [offClock!] }], { onlineChessOffered: false });
    walkToReview(h, "Over the board");
    rulesDraft(h).setOnlinePlay("lichess");
    expect(propsOf(byTestId(h, "division-builder-create")!).disabled, "not refused: online play is not offered").toBe(false);
    pressCreate(h);
    await flush();
    expect(Object.hasOwn(divisionBody().config as object, "onlinePlay")).toBe(false);
  });
});

describe("every builtin sport, walked from Who plays to Create (counts)", () => {
  it("its whole offer on Format with four suggested, its venue noun, the rules strip, its kinds, and its own variant sent", async () => {
    let sports = 0;
    let cards = 0;
    for (const m of builtinModules) {
      apiV1Mock.mockClear();
      pushMock.mockClear();
      const sport = ALL.find((s) => s.key === m.key)!;
      const h = mount([sport]);
      // Who plays: the engine's kinds, opened at its default.
      const model = modelOf(m.key);
      if (model.kinds.length > 1) {
        expect(entrantChips(h).map((c) => propsOf(c)["data-entrant-kind"]), m.key).toEqual([...model.kinds]);
        expect(checkedKind(h), m.key).toBe(model.defaultKind);
      }
      setName(h, `${m.key} open`);
      next(h);
      expect(currentStep(h), m.key).toBe("format");
      // Format: the sport's whole offer rendered, four of them suggested, the rest folded until Show all.
      const offer = templatesForSport(m.key).map((t) => t.key);
      expect([...templateKeys(h)].sort(), m.key).toEqual([...offer].sort());
      const suggested = templateCards(h).filter((c) => propsOf(c)["data-suggested"] !== undefined).map((c) => propsOf(c)["data-template"] as string);
      expect(suggested.length, m.key).toBe(Math.min(SUGGESTED_COUNT, offer.length));
      // Visible: the four, and the pick wherever it ranks.
      expect(new Set(visibleTemplateKeys(h)), m.key).toEqual(new Set([...suggested, pickedTemplate(h)!]));
      click(h, "division-builder-show-all");
      expect(visibleTemplateKeys(h).length, `${m.key}: Show all shows the whole offer`).toBe(offer.length);
      cards += offer.length;
      // The plan's venue box is named in the sport's own noun (a chess board, not a court).
      const venues = h.tree().find((e) => e.type === "label" && walk(e).some((x) => propsOf(x)["data-testid"] === "division-builder-plan-venues"))!;
      expect(textOf(venues), m.key).toContain(UI[`divBuilder.plan.venues.${venueNoun(m.key)}`]);
      next(h);
      // Division rules: the strip, on this sport.
      expect(currentStep(h), m.key).toBe("rules");
      expect(rulesStripProps(h).sportKey, m.key).toBe(m.key);
      next(h);
      expect(currentStep(h), `${m.key}: ${stepError(h) ?? ""}`).toBe("review");
      pressCreate(h);
      await flush();
      const body = divisionBody();
      expect(body.sport_key, m.key).toBe(m.key);
      expect(body.variant_key, m.key).toBe(pickVariant(m.key, sport.variants));
      expect(Object.hasOwn(body.config as object, "entrants"), `${m.key}: the default kind sends nothing`).toBe(false);
      expect(pushMock, m.key).toHaveBeenCalledWith("/o/org/c/comp/d/open?tab=fixtures");
      sports++;
    }
    expect(sports).toBe(builtinModules.length);
    expect(sports).toBeGreaterThanOrEqual(10);
    expect(cards).toBeGreaterThan(100);
  });

  it("chess's venue box says boards (the suggester's 'courts' fold-in), badminton's says courts", () => {
    const label = (key: string) => {
      const h = mount(sportsFor(key));
      return textOf(h.tree().find((e) => e.type === "label" && walk(e).some((x) => propsOf(x)["data-testid"] === "division-builder-plan-venues"))!);
    };
    expect(label("boardgame")).toContain(UI["divBuilder.plan.venues.board"]);
    expect(label("boardgame")).not.toContain(UI["divBuilder.plan.venues.court"]);
    expect(label("badminton")).toContain(UI["divBuilder.plan.venues.court"]);
  });
});

describe("what Create sends: the payload helpers", () => {
  it("eligibilityPatch: open collapses to null, U16 stores 15 with its cut-off, a blank age stores none, the note is trimmed", () => {
    expect(eligibilityPatch({ maxAge: "", cutoffMonth: "1", cutoffDay: "1", category: "open", customNote: "" })).toEqual({
      category: null,
      age_max: null,
      age_cutoff_month: null,
      age_cutoff_day: null,
      eligibility_note: null,
    });
    expect(eligibilityPatch({ maxAge: "16", cutoffMonth: "9", cutoffDay: "1", category: "womens", customNote: "  Club members only " })).toEqual({
      category: "womens",
      age_max: 15,
      age_cutoff_month: 9,
      age_cutoff_day: 1,
      eligibility_note: "Club members only",
    });
    expect(eligibilityPatch({ maxAge: "0", cutoffMonth: "9", cutoffDay: "1", category: "mixed", customNote: "" }).age_max, "0 is no age group").toBeNull();
  });

  it("divisionCreateConfig: only what was set; online play only when on; entrants only when given", () => {
    expect(divisionCreateConfig({ ruleOverrides: {}, onlinePlay: "off" })).toEqual({});
    expect(divisionCreateConfig({ ruleOverrides: { setTo: 15 }, onlinePlay: "lichess", points: { w: 3 }, entrants: { kinds: ["individual", "pair"], defaultKind: "pair" } })).toEqual({
      setTo: 15,
      onlinePlay: "lichess",
      points: { w: 3 },
      entrants: { kinds: ["individual", "pair"], defaultKind: "pair" },
    });
  });
});

describe("the plan the Format step suggests for", () => {
  it("opens at the owner's mock: 16 entrants, 2 venues, 4 hours, and the suggestion line says so", () => {
    const h = mount(sportsFor("badminton"));
    const value = (id: string) => Number(propsOf(byTestId(h, id)!).value);
    expect([value("division-builder-plan-entrants"), value("division-builder-plan-venues"), value("division-builder-plan-hours")]).toEqual([16, 2, 4]);
  });

  it("changing the plan moves the suggestion (6 entrants on 3 courts: a league fits and leads)", () => {
    const h = mount(sportsFor("badminton"));
    const before = templateCards(h).filter((c) => propsOf(c)["data-suggested"] !== undefined).map((c) => propsOf(c)["data-template"]);
    (propsOf(byTestId(h, "division-builder-plan-entrants")!).onChange as (e: unknown) => void)({ target: { value: "6" } });
    (propsOf(byTestId(h, "division-builder-plan-venues")!).onChange as (e: unknown) => void)({ target: { value: "3" } });
    const after = templateCards(h).filter((c) => propsOf(c)["data-suggested"] !== undefined).map((c) => propsOf(c)["data-template"]);
    expect(after).not.toEqual(before);
    expect(after).toContain("league");
  });
});

/** A guard against an inert seam: the helpers above are the ones the builder sends with. */
describe("the builder sends through its exported helpers", () => {
  it("the POST's eligibility fields are eligibilityPatch's, for what was typed", async () => {
    const h = mount(sportsFor("badminton"));
    setName(h, "U16");
    click(h, "division-builder-eligibility-toggle");
    (propsOf(byTestId(h, "division-builder-age")!).onChange as (e: unknown) => void)({ target: { value: "16" } });
    (propsOf(byTestId(h, "division-builder-note")!).onChange as (e: unknown) => void)({ target: { value: "School years 9-11" } });
    walkToReview(h, "U16");
    pressCreate(h);
    await flush();
    const body = divisionBody();
    expect({ age_max: body.age_max, age_cutoff_month: body.age_cutoff_month, age_cutoff_day: body.age_cutoff_day, eligibility_note: body.eligibility_note, category: body.category }).toEqual({
      age_max: 15,
      age_cutoff_month: 1,
      age_cutoff_day: 1,
      eligibility_note: "School years 9-11",
      category: null,
    });
  });
});

