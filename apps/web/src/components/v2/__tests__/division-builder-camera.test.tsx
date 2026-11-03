// Match Day C9 fix round 1 (m6, controller ruling): "Camera during online play" sits next to online play on Division
// rules, as the approved mock (A5) draws it, and Create sends it.
//
// Class 19 - what the control OPENS AT: the server's own default. CreateDivision's camera_policy is "absent or null ⇒
// inherit the competition's" (schemas.ts), so the select opens on "Competition setting" and an untouched builder sends
// no camera_policy at all - the division stores NULL, exactly as one created before the control existed. Expected values
// come from that declaration, the camera vocabulary (lib/camera-policy.ts) and the dictionaries, never the builder.
//
// Chess only on purpose: camera policy is an online-chess setting and the server refuses any other sport a camera
// (CAMERA_POLICY_SPORT); one non-chess sport is the "never shown" pair.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel } from "@seazn/engine/sport";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { CAMERA_POLICIES } from "@/lib/camera-policy";
import { sportOptionsFrom } from "@/lib/sport-options";
import { timeControlRuleValues } from "@/lib/online-time-control";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import uiEn from "@/dictionaries/en/ui.json";
import { builderStrip, goToStep, next, pressCreate, rulesDraft, selectSport, setName } from "./_division-builder-driver";

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
const sportsFor = (...keys: string[]): SportOption[] =>
  sportOptionsFrom(
    keys.map((key) => ({ key, name: key })),
    keys.flatMap((key) =>
      Object.entries(builtinModules.find((m) => m.key === key)!.variants as Record<string, Record<string, unknown>>).map(([v, config]) => ({
        sport_key: key,
        key: v,
        name: v,
        is_system: true,
        config,
      })),
    ),
    (key) => {
      const model = effectiveEntrantModel(builtinModules.find((m) => m.key === key)!.entrantModel ?? null, null);
      return { kinds: model.kinds, defaultKind: model.defaultKind };
    },
  );
/** The builder on chess: it opens on the first tile shown (C9 round 3), so the organisation's history names chess - the
 *  real path to a chess opening - and the mount checks it landed there, so no test runs on badminton unawares. */
const mount = (over: Partial<Parameters<typeof DivisionBuilder>[0]> = {}) => {
  const h = renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: sportsFor("boardgame", "badminton"),
    recentSports: ["boardgame"],
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
    onlineChessOffered: true,
    ...over,
  });
  const opened = h.tree().filter((e) => e.type === "input" && propsOf(e).name === "division-sport" && propsOf(e).checked === true).map((e) => propsOf(e).value);
  if (opened.length !== 1 || opened[0] !== "boardgame") throw new Error(`the builder opened on ${opened.join(",")}, not chess`);
  return h;
};
type H = ReturnType<typeof mount>;
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const divisionBody = (): Record<string, unknown> => {
  const call = apiV1Mock.mock.calls.filter(([url]) => /\/divisions$/.test(String(url))).at(-1);
  if (!call) throw new Error("no division POST");
  return (call[1] as { json: Record<string, unknown> }).json;
};

/** The strip as the builder hands it over, rendered: the camera select is found where the organiser sees it. */
const stripTree = (h: H): ReactElement[] => builderStrip(h).tree();
const cameraSelect = (h: H): ReactElement | undefined => stripTree(h).find((e) => propsOf(e)["data-testid"] === "division-builder-camera");
const pickCamera = (h: H, value: string) => (propsOf(cameraSelect(h)!).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
function onlineChess(h: H) {
  setName(h, "Online");
  goToStep(h, "rules");
  rulesDraft(h).setOnlinePlay("lichess");
  rulesDraft(h).setRuleValues((v) => ({ ...v, ...timeControlRuleValues(SHIP1_TIME_CONTROLS[0]!.key)! }));
}

beforeEach(() => {
  apiV1Mock.mockReset();
  apiV1Mock.mockImplementation(async (url: string) => (String(url).endsWith("/divisions") ? { id: "d1", slug: "online" } : {}));
});

describe("m6: Camera during online play, next to online play", () => {
  it("the empty case: online play off - no camera control, and Create sends no camera_policy", async () => {
    const h = mount();
    setName(h, "Over the board");
    goToStep(h, "rules");
    expect(cameraSelect(h)).toBeUndefined();
    goToStep(h, "review");
    pressCreate(h);
    await flush();
    expect(Object.hasOwn(divisionBody(), "camera_policy")).toBe(false);
  });

  it("opens at the server's default (inherit the competition's), names the competition's value, and sends nothing untouched", async () => {
    const h = mount({ inheritedCameraPolicy: "optional" });
    onlineChess(h);
    const select = cameraSelect(h)!;
    expect(select, "the camera select is drawn once online play is Lichess").toBeDefined();
    // Next to online play: the select that follows the online-play select in the strip is the camera's.
    const selects = stripTree(h).filter((e) => e.type === "select").map((e) => propsOf(e)["data-testid"]);
    expect(selects.indexOf("division-builder-camera")).toBe(selects.indexOf("division-online-play") + 1);
    expect(propsOf(select).value).toBe("inherit");
    // Every declared policy is offered, after the competition setting (lib/camera-policy.ts is the vocabulary).
    const options = walk(propsOf(select).children as ReactNode).filter((e) => e.type === "option").map((e) => propsOf(e).value);
    expect(options).toEqual(["inherit", ...CAMERA_POLICIES]);
    expect(textOf(stripTree(h).find((e) => propsOf(e)["data-testid"] === "division-builder-camera-inherited")!)).toBe(
      fill(UI["divBuilder.camera.inherited"]!, { policy: UI["divset.camera.optional"]! }),
    );
    goToStep(h, "review");
    pressCreate(h);
    await flush();
    expect(Object.hasOwn(divisionBody(), "camera_policy"), "untouched: the server's default (NULL, inherit) stands").toBe(false);
  });

  it("a picked policy is sent and named on Review; online play off again sends none (sequence)", async () => {
    const h = mount();
    onlineChess(h);
    pickCamera(h, "required");
    expect(propsOf(cameraSelect(h)!).value).toBe("required");
    expect(stripTree(h).find((e) => propsOf(e)["data-testid"] === "division-builder-camera-inherited")).toBeUndefined();
    next(h);
    const rulesRow = h.tree().find((e) => e.type === "li" && propsOf(e)["data-review-row"] === "rules")!;
    expect(textOf(rulesRow)).toContain(fill(UI["divBuilder.review.camera"]!, { policy: UI["divset.camera.required"]! }));
    pressCreate(h);
    await flush();
    expect(divisionBody().camera_policy).toBe("required");

    // Online play off: the camera no longer applies and is not sent, whatever was picked.
    apiV1Mock.mockClear();
    const off = mount();
    onlineChess(off);
    pickCamera(off, "required");
    rulesDraft(off).setOnlinePlay("off");
    expect(cameraSelect(off)).toBeUndefined();
    goToStep(off, "review");
    pressCreate(off);
    await flush();
    expect(Object.hasOwn(divisionBody(), "camera_policy")).toBe(false);
  });

  it("a sport change resets it: back on chess, the camera opens at the competition setting again", () => {
    const h = mount();
    onlineChess(h);
    pickCamera(h, "required");
    goToStep(h, "who");
    selectSport(h, "badminton");
    goToStep(h, "rules");
    expect(cameraSelect(h), "badminton plays no online chess").toBeUndefined();
    goToStep(h, "who");
    selectSport(h, "boardgame");
    onlineChess(h);
    expect(propsOf(cameraSelect(h)!).value).toBe("inherit");
  });
});
