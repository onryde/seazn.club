// F5 test debt, Task 5b: division-settings.tsx's shared run() helper (the
// single error path for every action here — saveName, uploadLogo,
// removeLogo, applyStructure/buildTemplateStages, applyFormat, …) had no
// ApiV1Error/PAYMENT_REQUIRED branch, so a paid action that came back
// PAYMENT_REQUIRED rendered as the SAME plain red error banner as any other
// failure, instead of the paywall card `news.auto` already shows statically
// at :919. Fixed ONCE, at run() itself (:320) — this test drives it through
// saveName (the "General" Group, defaultOpen, so its Save button is present
// in DivisionSettings' own returned element tree without needing to open any
// OTHER accordion), per the brief's "any run()-wrapped action, since the fix
// is at run() level".
//
// Same harness as division-settings-entrants.test.tsx (router + confirm
// mocked) but the INTERACTIVE hook harness, not renderToStaticMarkup — a
// click has to actually re-run the component's state, which a static render
// can't do.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const net = vi.hoisted(() => ({
  impl: (() => Promise.resolve({})) as (
    url: string,
    options?: { method?: string; json?: unknown },
  ) => Promise<unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => net.impl(url, options),
  };
});

import { DivisionSettings } from "@/components/v2/division-settings";
import { UpgradeGate } from "@/components/upgrade-gate";
import { ApiV1Error } from "@/lib/client-v1";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

const ENTRANT_MODEL: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

const baseProps = {
  division: {
    id: "d1",
    name: "Open",
    sport_key: "football",
    variant_key: "standard",
    config: {},
    logo_url: null,
    logo_storage_path: null,
  },
  orgId: "org1",
  variants: [{ key: "standard", name: "Standard" }],
  locked: false,
  stages: [],
  canEdit: true,
  divisionPathPrefix: "/o/org/c/comp/d/",
  fixturesHref: "/o/org/c/comp/d/div/fixtures",
  embed: null,
  danger: null,
  entrantModel: ENTRANT_MODEL,
  entrantModelSource: "sport",
  autoPosts: false,
  // true — canAutoPost:false renders a SECOND, static <UpgradeGate
  // feature="news.auto"/> (:919) unconditionally, unrelated to run()'s
  // PAYMENT_REQUIRED branch this test targets. Keeping it entitled here
  // means the only UpgradeGate this test can find is the dynamic one.
  canAutoPost: true,
} as unknown as Parameters<typeof DivisionSettings>[0];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Same idiom as stages-panel-auto-schedule-seq.test.tsx's fireAutoSchedule:
 *  invoke the handler the harness found rather than simulate a DOM click —
 *  there is no DOM here (`environment: "node"`). */
function clickButton(tree: ReactElement[], text: string): void {
  const btn = tree.find((n) => n.type === "button" && textOf(n).trim() === text);
  if (!btn) {
    throw new Error(`no <button> with text "${text}" — rendered: ${tree.map((n) => textOf(n)).join(" | ")}`);
  }
  (propsOf(btn).onClick as () => void)();
}

function paywallCard(tree: ReactElement[]): ReactElement | undefined {
  return tree.find((n) => n.type === UpgradeGate);
}

function errorBanner(tree: ReactElement[]): ReactElement | undefined {
  return tree.find((n) => {
    if (n.type !== "p") return false;
    const cls = propsOf(n).className;
    return typeof cls === "string" && cls.includes("bg-red-50");
  });
}

beforeEach(() => {
  net.impl = () => Promise.resolve({});
});

describe("DivisionSettings — run()'s PAYMENT_REQUIRED branch (F5 task 5b)", () => {
  it("renders the UpgradeGate paywall card, not the plain red banner, when a run()-wrapped action 402s PAYMENT_REQUIRED", async () => {
    net.impl = () =>
      Promise.reject(
        new ApiV1Error("upgrade required", 402, "PAYMENT_REQUIRED", { feature_key: "divisions.rename" }),
      );
    const island = renderIsland(DivisionSettings, baseProps);

    clickButton(island.tree(), "Save name");
    await flush();

    const gate = paywallCard(island.tree());
    expect(gate).toBeDefined();
    expect(propsOf(gate!).feature).toBe("divisions.rename");
    expect(errorBanner(island.tree())).toBeUndefined();
  });

  it("regression: a non-PAYMENT_REQUIRED failure still renders the plain red banner, not the paywall card", async () => {
    net.impl = () => Promise.reject(new Error("network down"));
    const island = renderIsland(DivisionSettings, baseProps);

    clickButton(island.tree(), "Save name");
    await flush();

    expect(paywallCard(island.tree())).toBeUndefined();
    const err = errorBanner(island.tree());
    expect(err).toBeDefined();
    expect(propsOf(err!).children).toBe("network down");
  });
});
