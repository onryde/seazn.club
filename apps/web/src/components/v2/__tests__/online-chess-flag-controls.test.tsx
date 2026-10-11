// T20 — the organiser and player controls that START online chess are not rendered (never rendered-and-disabled)
// unless the club is offered online chess (the PostHog flag `online-chess`). The flag is asked on the server, by the
// page; these islands take its answer as a prop. Driven through the REAL components with the hook harness (no DOM
// in this workspace): the element tree includes what a collapsed Group holds, so a control inside one is still seen.
//
//  - division Settings: the "Online play" select and the camera Group (chess only — sport gate unchanged);
//  - the needs-a-result queue: "Resend link" (an invite is a start), while the resolve buttons — which FINISH a board —
//    stay whatever the flag says;
//  - the Lichess card: its link names the club (the start route asks that club's flag).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
const net = vi.hoisted(() => ({ calls: [] as { url: string; json?: unknown }[] }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: async (url: string, options?: { json?: unknown }) => {
      net.calls.push({ url, json: options?.json });
      return {};
    },
  };
});
// The card reads its copy through useT, which needs a provider; the REAL English translator, as the stepper's
// interaction test does. useMsg (division settings, queue) falls back to the English catalog by itself.
const EN_UI: Dict = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8"),
) as Dict;
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars) };
});

import { DivisionSettings } from "@/components/v2/division-settings";
import { ExternalPlayNeedsResultQueue } from "@/components/v2/external-play-needs-result-queue";
import { LichessLinkCard } from "@/components/lichess-link-card";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

type SettingsProps = Parameters<typeof DivisionSettings>[0];
function settingsProps(sportKey: string, config: Record<string, unknown>, onlineChessOffered: boolean): SettingsProps {
  return {
    division: {
      id: "d1",
      name: "Open",
      sport_key: sportKey,
      variant_key: sportKey === "boardgame" ? "classical" : "standard",
      config,
      logo_url: null,
      logo_storage_path: null,
      camera_policy: null,
      inherited_camera_policy: "off",
    },
    orgId: "org1",
    variants: [{ key: sportKey === "boardgame" ? "classical" : "standard", name: "Standard" }],
    locked: false,
    stages: [],
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: null,
    danger: null,
    entrantModel: INDIVIDUAL_ONLY,
    entrantModelSource: "sport",
    autoPosts: false,
    canAutoPost: true,
    showSeeds: true,
    viewerPlan: "community",
    onlineChessOffered,
  } as SettingsProps;
}
const byTestId = (tree: ReactElement[], id: string) => tree.filter((n) => propsOf(n)["data-testid"] === id);

beforeEach(() => {
  net.calls.length = 0;
});

describe("division Settings: the online-play controls follow the club's flag", () => {
  it("chess, flag ON: the Online play select and the camera control render; flag OFF: neither does", () => {
    let checked = 0;
    for (const offered of [true, false]) {
      const tree = renderIsland(DivisionSettings, settingsProps("boardgame", { variant: "classical" }, offered)).tree();
      // Anti-vacuity: the Format group's other controls are in the same tree, so an absence is the gate's doing.
      expect(tree.some((n) => n.type === "button" && textOf(n).trim() === "Save match rules"), `offered ${offered}`).toBe(true);
      const want = offered ? 1 : 0;
      expect(byTestId(tree, "division-online-play"), `offered ${offered}: online play select`).toHaveLength(want);
      expect(byTestId(tree, "division-camera-policy"), `offered ${offered}: camera select`).toHaveLength(want);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("another sport never shows them, whatever the flag (the sport gate is unchanged)", () => {
    const tree = renderIsland(DivisionSettings, settingsProps("football", {}, true)).tree();
    expect(tree.some((n) => n.type === "button" && textOf(n).trim() === "Save match rules")).toBe(true);
    expect(byTestId(tree, "division-online-play")).toHaveLength(0);
    expect(byTestId(tree, "division-camera-policy")).toHaveLength(0);
  });

  it("flag OFF on a division already online: saving the match rules keeps it online — the hidden control drops nothing", async () => {
    const island = renderIsland(
      DivisionSettings,
      settingsProps("boardgame", { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } }, false),
    );
    expect(byTestId(island.tree(), "division-online-play"), "premise: hidden").toHaveLength(0);
    const save = island.tree().find((n) => n.type === "button" && textOf(n).trim() === "Save match rules");
    // Mount-time reads (tag suggestions) go through the same client; only the division PATCH is the save.
    const saves = () => net.calls.filter((c) => c.url === "/api/v1/divisions/d1");
    expect(saves(), "premise: nothing saved yet").toHaveLength(0);
    (propsOf(save!).onClick as () => void)();
    await vi.waitFor(() => expect(saves()).toHaveLength(1));
    expect((saves()[0]!.json as { config: Record<string, unknown> }).config.onlinePlay).toBe("lichess");
  });
});

describe("needs-a-result queue: Resend is a start, resolving is not", () => {
  const ROW = {
    fixtureId: "f1",
    fixtureNo: 3,
    homeName: "Ann",
    awayName: "Bo",
    scheduledAt: null,
    lastError: "no_show_grace_elapsed",
    href: "/o/org/c/comp/d/div/fixtures/3",
  };
  it("flag ON shows Resend; flag OFF renders no Resend — and the four resolve buttons either way", () => {
    let checked = 0;
    for (const resendOffered of [true, false]) {
      const tree = renderIsland(ExternalPlayNeedsResultQueue, { rows: [ROW], resendOffered }).tree();
      expect(byTestId(tree, "external-play-resend"), `offered ${resendOffered}`).toHaveLength(resendOffered ? 1 : 0);
      const resolves = tree.filter((n) => String(propsOf(n)["data-testid"] ?? "").startsWith("external-play-resolve-"));
      expect(resolves, `offered ${resendOffered}: resolving finishes a board`).toHaveLength(4);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

describe("the Lichess card: its link names the club", () => {
  it("not linked: one link, to the start route for THIS club, returning to the account tab", () => {
    const tree = renderIsland(LichessLinkCard, { linkedUsername: null, configured: true, orgSlug: "riverside" }).tree();
    const links = byTestId(tree, "lichess-link");
    expect(links).toHaveLength(1);
    // Typed from the route's contract, not built with the helper: org first, then the same-origin next.
    expect(propsOf(links[0]!).href).toBe("/api/auth/lichess?org=riverside&next=%2Fsettings%3Ftab%3Daccount");
  });

  it("linked: no link at all, the unlink control instead", () => {
    const tree = renderIsland(LichessLinkCard, { linkedUsername: "Magnus", configured: true, orgSlug: "riverside" }).tree();
    expect(byTestId(tree, "lichess-link")).toHaveLength(0);
    expect(byTestId(tree, "lichess-unlink")).toHaveLength(1);
  });
});
