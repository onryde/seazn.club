// Online Chess credits in the division builder (spec 2026-11-23-online-chess-credits-design.md §8.1, §8.2; plan Task 11).
//
// Three things the builder owes:
//   1. The size: the strip's draft carries the "Players, up to" facts (no places held yet; the drafted Swiss rounds; the plan's cap;
//      the club's balance), and Create sends `online_size` - the size the select SHOWS, which follows the rounds until a pick is made.
//   2. No stage-less online division: the combination that would leave one is refused BEFORE the division exists - a format Online
//      Chess does not run with online play on (from either side), and more Swiss rounds than any size includes.
//   3. Review says what the choice is and what it costs ("Online Chess · up to 64 players · 8 credits, paid before round 1") and spends
//      nothing: no pay control, no request before Create.
//
// Expected values come from the spec's table (Global Constraints: 16/32/64/128/256 players include 6/7/8/9/10 rounds and cost
// 1/2/4/8/16 credits, doubled with the Fair-play camera), typed here - never read back from the price leaf or the builder.
// single-sport: Online Chess is boardgame only (online-play.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { OnlinePriceLine } from "@/components/v2/online-chess/price-line";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { ApiV1Error } from "@/lib/client-v1";
import { sportOptionsFrom } from "@/lib/sport-options";
import { formatNotSupported, roundsAboveMax, roundsNeedSize } from "@/server/usecases/online-package/format";
import { timeControlRuleValues } from "@/lib/online-time-control";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import uiEn from "@/dictionaries/en/ui.json";
import { builderStrip, byTestId, currentStep, goToStep, next, pickTemplate, pressCreate, rulesDraft, selectSport, setName, stepError, templateCards } from "./_division-builder-driver";

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

const UI = uiEn as Record<string, string>;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(v[k]));
/** Global Constraints: the smallest size whose included rounds cover r, and what each size costs (no camera / camera). */
const SIZE_FOR_ROUNDS: readonly (readonly [number, number])[] = [[2, 16], [3, 16], [6, 16], [7, 32], [8, 64], [9, 128], [10, 256]];
const PRICE = new Map([[16, 1], [32, 2], [64, 4], [128, 8], [256, 16]]);
const FACTS = { planCap: null, balance: 11, buyMoreHref: "/o/org/settings/credits?kind=stream" };

const SPORT_KEYS = ["boardgame", "badminton"] as const;
const sports: SportOption[] = sportOptionsFrom(
  SPORT_KEYS.map((key) => ({ key, name: key })),
  SPORT_KEYS.flatMap((key) =>
    Object.entries(builtinModules.find((m) => m.key === key)!.variants as Record<string, Record<string, unknown>>).map(([v, config]) => ({
      sport_key: key, key: v, name: v, is_system: true, config,
    })),
  ),
  (key) => {
    const model = effectiveEntrantModel(builtinModules.find((m) => m.key === key)!.entrantModel ?? null, null);
    return { kinds: model.kinds, defaultKind: model.defaultKind };
  },
);
const mount = (over: Partial<Parameters<typeof DivisionBuilder>[0]> = {}) => {
  const h = renderIsland(DivisionBuilder, {
    competitionId: "c1", orgSlug: "org", compSlug: "comp", sports, recentSports: ["boardgame"], constraintsAllowed: true,
    archivedSlotsExplainRefusal: false, viewerPlan: "pro", onlineChessOffered: true, onlinePackage: FACTS, ...over,
  });
  const opened = h.tree().filter((e) => e.type === "input" && propsOf(e).name === "division-sport" && propsOf(e).checked === true).map((e) => propsOf(e).value);
  if (opened.length !== 1 || opened[0] !== "boardgame") throw new Error(`the builder opened on ${opened.join(",")}, not chess`);
  return h;
};
type H = ReturnType<typeof mount>;
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const divisionPosts = () => apiV1Mock.mock.calls.filter(([url, o]) => /\/divisions$/.test(String(url)) && (o as { method?: string }).method === "POST");
const divisionBody = (): Record<string, unknown> => {
  const call = divisionPosts().at(-1);
  if (!call) throw new Error("no division POST");
  return (call[1] as { json: Record<string, unknown> }).json;
};
const roundsBox = (h: H) => {
  const label = h.tree().find((e) => e.type === "label" && walk(e).some((x) => x.type === "span" && textOf(x) === UI["wizard.rounds"]));
  return label ? walk(label).find((e) => e.type === "input") : undefined;
};
const setRounds = (h: H, n: number) => (propsOf(roundsBox(h)!).onChange as (e: { target: { value: string } }) => void)({ target: { value: String(n) } });
/** The format step on a Swiss format with `rounds` rounds (the box is the real producer of `stage.config.rounds`). */
function swiss(h: H, rounds: number) {
  setName(h, "Online");
  goToStep(h, "format");
  pickTemplate(h, "swiss");
  setRounds(h, rounds);
}
function lichessOn(h: H) {
  goToStep(h, "rules");
  rulesDraft(h).setOnlinePlay("lichess");
  rulesDraft(h).setRuleValues((v) => ({ ...v, ...timeControlRuleValues(SHIP1_TIME_CONTROLS[0]!.key)! }));
}
const toReview = (h: H) => goToStep(h, "review");
const reviewRow = (h: H, id: string) => h.tree().find((e) => e.type === "li" && propsOf(e)["data-review-row"] === id);

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation(async (url: string) => (String(url).endsWith("/divisions") ? { id: "d1", slug: "online" } : {}));
});

describe("the strip's draft carries the facts the select is drawn from", () => {
  it("no places held, the drafted Swiss rounds and stage kinds, the plan's cap and the club's balance", () => {
    const h = mount({ onlinePackage: { ...FACTS, planCap: 64 } });
    swiss(h, 7);
    lichessOn(h);
    const pkg = rulesDraft(h).onlinePackage!;
    expect(pkg, "the draft carries a package").toBeDefined();
    expect(pkg).toMatchObject({ held: 0, rounds: 7, stageKinds: ["swiss"], planCap: 64, balance: 11, cameras: false, buyMoreHref: FACTS.buyMoreHref, size: null });
  });

  it("without the page's package facts the draft carries none (no select), yet Create still sends the size that covers the rounds - never the server's 16 under 7 rounds", async () => {
    const h = mount({ onlinePackage: undefined });
    swiss(h, 7);
    lichessOn(h);
    expect(rulesDraft(h).onlinePackage).toBeUndefined();
    toReview(h);
    pressCreate(h);
    await flush();
    expect(divisionBody().online_size).toBe(32);
  });

  it("the controls read in the spec's order: Online play, Camera, Players up to, then the price line (spec 8.1)", () => {
    const h = mount();
    swiss(h, 7);
    lichessOn(h);
    const tree = builderStrip(h).tree();
    const at = (pred: (e: (typeof tree)[number]) => boolean) => tree.findIndex(pred);
    const order = {
      onlinePlay: at((e) => propsOf(e)["data-testid"] === "division-online-play"),
      camera: at((e) => propsOf(e)["data-testid"] === "division-builder-camera"),
      sizeBlock: at((e) => propsOf(e)["data-testid"] === "division-online-package"),
      priceLine: at((e) => e.type === OnlinePriceLine),
    };
    for (const [name, i] of Object.entries(order)) expect(i, `${name} is drawn`).toBeGreaterThanOrEqual(0);
    expect(order.onlinePlay, "Online play first").toBeLessThan(order.camera);
    expect(order.camera, "the Camera before the size (it changes the price)").toBeLessThan(order.sizeBlock);
    expect(order.sizeBlock, "the size select before its price line").toBeLessThan(order.priceLine);
    // the sequence: Lichess off again drops the camera and the package together
    rulesDraft(h).setOnlinePlay("off");
    const off = builderStrip(h).tree();
    expect(off.some((e) => propsOf(e)["data-testid"] === "division-builder-camera"), "no camera with online off").toBe(false);
    expect(off.some((e) => propsOf(e)["data-testid"] === "division-online-package"), "no package with online off").toBe(false);
  });

  it("the Fair-play camera follows the division's effective policy: its own pick, else the competition's", () => {
    const own = mount({ inheritedCameraPolicy: "off" });
    swiss(own, 6);
    lichessOn(own);
    expect(rulesDraft(own).onlinePackage!.cameras, "inherits off").toBe(false);
    const inherited = mount({ inheritedCameraPolicy: "optional" });
    swiss(inherited, 6);
    lichessOn(inherited);
    expect(rulesDraft(inherited).onlinePackage!.cameras, "inherits optional").toBe(true);
    // its own pick beats the competition's: "off" picked under an "optional" competition is no camera
    const picked = mount({ inheritedCameraPolicy: "optional" });
    swiss(picked, 6);
    lichessOn(picked);
    const select = builderStrip(picked).tree().find((e) => propsOf(e)["data-testid"] === "division-builder-camera")!;
    (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: "off" } });
    expect(rulesDraft(picked).onlinePackage!.cameras, "own off beats inherited optional").toBe(false);
    (propsOf(select).onChange as (e: { target: { value: string } }) => void)({ target: { value: "required" } });
    expect(rulesDraft(picked).onlinePackage!.cameras, "own required").toBe(true);
  });
});

describe("Create sends the size the select shows", () => {
  it("the default follows the Swiss rounds: every row of the table", async () => {
    let checked = 0;
    for (const [rounds, size] of SIZE_FOR_ROUNDS) {
      apiV1Mock.mockClear();
      const h = mount();
      swiss(h, rounds);
      lichessOn(h);
      toReview(h);
      expect(currentStep(h), `rounds ${rounds}: Review`).toBe("review");
      pressCreate(h);
      await flush();
      expect(divisionBody().online_size, `${rounds} rounds`).toBe(size);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(SIZE_FOR_ROUNDS.length);
  });

  it("a pick is sent; a pick the rounds then outgrow is dropped for the size that covers them (the sequence)", async () => {
    const h = mount();
    swiss(h, 6);
    lichessOn(h);
    rulesDraft(h).onlinePackage!.setSize(128);
    toReview(h);
    pressCreate(h);
    await flush();
    expect(divisionBody().online_size, "the pick stands while it fits").toBe(128);

    apiV1Mock.mockClear();
    const g = mount();
    swiss(g, 6);
    lichessOn(g);
    rulesDraft(g).onlinePackage!.setSize(16);
    goToStep(g, "format");
    setRounds(g, 8);
    toReview(g);
    pressCreate(g);
    await flush();
    expect(divisionBody().online_size, "16 includes 6 rounds; 8 need 64").toBe(64);
  });

  it("a pick does not survive a change of sport: back on chess, the size follows the rounds again", () => {
    const h = mount();
    swiss(h, 7);
    lichessOn(h);
    rulesDraft(h).onlinePackage!.setSize(128);
    expect(rulesDraft(h).onlinePackage!.size, "premise: the pick stands").toBe(128);
    selectSport(h, "badminton");
    selectSport(h, "boardgame");
    swiss(h, 7);
    lichessOn(h);
    expect(rulesDraft(h).onlinePackage!.size, "the old pick is gone").toBeNull();
  });

  it("online play off sends no size, and turning it off after a pick sends none", async () => {
    const h = mount();
    swiss(h, 7);
    lichessOn(h);
    rulesDraft(h).onlinePackage!.setSize(64);
    rulesDraft(h).setOnlinePlay("off");
    toReview(h);
    pressCreate(h);
    await flush();
    expect(Object.hasOwn(divisionBody(), "online_size")).toBe(false);
  });
});

describe("no stage-less online division: the combination is refused before the division exists", () => {
  it("online play on, then a format Online Chess does not run: the format step refuses, nothing is created", async () => {
    const h = mount();
    swiss(h, 6);
    lichessOn(h);
    goToStep(h, "format");
    pickTemplate(h, "league");
    next(h);
    expect(currentStep(h), "Next does not leave Format").toBe("format");
    expect(stepError(h)).toBe(UI["onlineChess.format.stripLine"]);
    toReview(h);
    expect(currentStep(h), "a jump to Review stops on the same step").toBe("format");
    await flush();
    expect(divisionPosts(), "no division was created").toHaveLength(0);
  });

  it("a format Online Chess does not run, then online play on: the rules step refuses the same way (both directions)", async () => {
    const h = mount();
    setName(h, "Online");
    goToStep(h, "format");
    pickTemplate(h, "league");
    lichessOn(h);
    expect(rulesDraft(h).onlinePackage!.stageKinds).toEqual(["league"]);
    next(h);
    // the first step that cannot go on is the Format step (its own check), so Next lands there, naming the refusal
    expect(currentStep(h), "Next does not reach Review").toBe("format");
    expect(stepError(h)).toBe(UI["onlineChess.format.stripLine"]);
    await flush();
    expect(divisionPosts()).toHaveLength(0);
  });

  it("the same league format with online play OFF goes through (the positive pair)", async () => {
    const h = mount();
    setName(h, "Over the board");
    goToStep(h, "format");
    pickTemplate(h, "league");
    goToStep(h, "rules");
    next(h);
    expect(currentStep(h), "Next leaves the rules step").toBe("review");
  });

  it("more Swiss rounds than any size includes stops the rules step, with the rounds sentence", async () => {
    const h = mount();
    swiss(h, 11);
    lichessOn(h);
    expect(rulesDraft(h).onlinePackage!.rounds).toBe(11);
    next(h);
    expect(currentStep(h)).toBe("rules");
    expect(stepError(h)).toBe(fill(UI["onlineChess.roundsAboveMax"]!, { max: 10 }));
    toReview(h);
    expect(currentStep(h), "a jump to Review stops on the rules step").toBe("rules");
    await flush();
    expect(divisionPosts()).toHaveLength(0);
    // 10 is the most a size includes: that one goes through
    const ok = mount();
    swiss(ok, 10);
    lichessOn(ok);
    next(ok);
    expect(currentStep(ok)).toBe("review");
  });

  it("the format cards grey the refused formats while online play is on, and not when it is off", () => {
    const off = mount();
    setName(off, "Over the board");
    goToStep(off, "format");
    const refusedOff = templateCards(off).filter((c) => propsOf(c)["data-online-refused"] !== undefined);
    expect(refusedOff, "online play off: nothing is greyed for it").toHaveLength(0);

    const on = mount();
    swiss(on, 6);
    lichessOn(on);
    goToStep(on, "format");
    const refused = templateCards(on).filter((c) => propsOf(c)["data-online-refused"] !== undefined).map((c) => propsOf(c)["data-template"]);
    expect(refused, "online play on: the league formats are greyed").toEqual(expect.arrayContaining(["league", "league_ko", "groups_ko"]));
    expect(refused, "and the Swiss and knockout ones are not").not.toContain("swiss");
    expect(refused).not.toContain("knockout");
    expect(templateCards(on).length, "anti-vacuity: the cards were drawn").toBeGreaterThan(refused.length);
  });
});

describe("Review says what the choice is and what it costs, and spends nothing", () => {
  it("\"Online Chess · up to 32 players · 2 credits, paid before round 1\" for 7 rounds; the plural for 16 players' 1 credit", () => {
    const h = mount();
    swiss(h, 7);
    lichessOn(h);
    toReview(h);
    const row = reviewRow(h, "online");
    expect(row, "the Online Chess row").toBeDefined();
    expect(textOf(row!)).toContain(UI["onlineChess.review.label"]!);
    expect(textOf(row!)).toContain(fill(UI["onlineChess.review.value.other"]!, { size: 32, count: PRICE.get(32)! }));

    const one = mount();
    swiss(one, 6);
    lichessOn(one);
    toReview(one);
    expect(textOf(reviewRow(one, "online")!)).toContain(fill(UI["onlineChess.review.value.one"]!, { size: 16, count: PRICE.get(16)! }));
  });

  it("the camera doubles the price on Review", () => {
    const h = mount({ inheritedCameraPolicy: "required" });
    swiss(h, 8);
    lichessOn(h);
    toReview(h);
    expect(textOf(reviewRow(h, "online")!)).toContain(fill(UI["onlineChess.review.value.other"]!, { size: 64, count: PRICE.get(64)! * 2 }));
  });

  it("no row when online play is off; the row says the sizes of a pick", () => {
    const off = mount();
    swiss(off, 7);
    toReview(off);
    expect(reviewRow(off, "online")).toBeUndefined();
    const picked = mount();
    swiss(picked, 7);
    lichessOn(picked);
    rulesDraft(picked).onlinePackage!.setSize(128);
    toReview(picked);
    expect(textOf(reviewRow(picked, "online")!)).toContain(fill(UI["onlineChess.review.value.other"]!, { size: 128, count: PRICE.get(128)! }));
  });

  it("nothing is spent or asked of the server before Create, and the row offers only Edit - no pay control", async () => {
    const h = mount();
    swiss(h, 7);
    lichessOn(h);
    toReview(h);
    const row = reviewRow(h, "online")!;
    const controls = walk(row).filter((e) => e.type === "button" || e.type === "a");
    expect(controls.map((e) => propsOf(e)["data-testid"]), "the row's only control is its Edit").toEqual(["division-builder-edit-online"]);
    expect(byTestId(h, "division-builder-edit-online"), "Edit is there").toBeDefined();
    expect(apiV1Mock, "no request before Create").not.toHaveBeenCalled();
    pressCreate(h);
    await flush();
    const urls = apiV1Mock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => /credits|checkout|pay|package/.test(u)), `only the create requests: ${urls.join(", ")}`).toBe(false);
  });
});

describe("the server's package refusals at Create, in the organiser's words (the stages POST after the division exists)", () => {
  const refusedStages = async (e: { status: number; code?: string; extra?: unknown }) => {
    apiV1Mock.mockReset().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/divisions")) return { id: "d1", slug: "online" };
      throw new ApiV1Error("server wording - English only", e.status, String(e.code), (e.extra ?? {}) as Record<string, unknown>);
    });
    const h = mount();
    swiss(h, 7);
    lichessOn(h);
    toReview(h);
    pressCreate(h);
    await flush();
    expect(currentStep(h), "the refusal is shown on the Format step").toBe("format");
    return stepError(h);
  };

  it("ONLINE_ROUNDS_NEED_SIZE (nextSize), ONLINE_ROUNDS_ABOVE_MAX and ONLINE_FORMAT_NOT_SUPPORTED, never the server's English", async () => {
    expect(await refusedStages(roundsNeedSize(16, 8))).toBe(fill(UI["onlineChess.roundsNeedSize"]!, { nextSize: 64 }));
    expect(await refusedStages(roundsAboveMax(11))).toBe(fill(UI["onlineChess.roundsAboveMax"]!, { max: 10 }));
    expect(await refusedStages(formatNotSupported("league"))).toBe(UI["onlineChess.format.refused"]);
  });
});
