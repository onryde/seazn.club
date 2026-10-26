// T20 — the organiser and player controls that START online chess are not rendered (never rendered-and-disabled)
// unless the club is offered online chess (the PostHog flag `online-chess`). The flag is asked on the server, by the
// page; these islands take its answer as a prop. Driven through the REAL components with the hook harness (no DOM
// in this workspace): the element tree includes what a collapsed Group holds, so a control inside one is still seen.
//
//  - division Settings: the "Online play" select and the camera Group (chess only — sport gate unchanged);
//  - the needs-a-result queue: T16 removed its "Resend link" (the server refuses an invite for every held board, 409
//    BOARD_HELD), so it takes no flag at all — every control left on it FINISHES a board;
//  - the Lichess card: its link names the club (the start route asks that club's flag).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
const net = vi.hoisted(() => ({ calls: [] as { url: string; json?: unknown }[], refuseDivisionPatch: null as Error | null }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: async (url: string, options?: { json?: unknown }) => {
      net.calls.push({ url, json: options?.json });
      if (net.refuseDivisionPatch && url === "/api/v1/divisions/d1") throw net.refuseDivisionPatch;
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
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
    // T16: the queue reads plurals and the locale through the arbiter's shared formatter.
    usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => pluralRuntime(EN_UI, key, count, "en", vars),
    useLocale: () => "en",
  };
});

import { ApiV1Error } from "@/lib/client-v1";
import { ONLINE_CHESS_DISABLED_CODE } from "@/lib/online-chess";
import { onlineChessDisabled } from "@/server/usecases/external-play/online-chess-flag";
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
    structureLocked: false,
    lockedFields: [],
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
  net.refuseDivisionPatch = null;
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

// Fix round 1, m6: a save the server refuses 403 ONLINE_CHESS_DISABLED (a save racing a flag change, a kept answer
// gone stale, PostHog down) reads in the organiser's language — the code is localised, the server's English sentence
// never shown. The sentence comes from the dictionaries; the code is the server's own constant, re-exported.
describe("division Settings: the Format summary states that the division plays online (canvas SettingsPhone)", () => {
  const formatSummary = (tree: ReactElement[]) => {
    const groups = [...new Set(tree.filter((n) => propsOf(n).title === "Format"))];
    expect(groups, "the Format group").toHaveLength(1);
    return String(propsOf(groups[0]!).summary);
  };
  // W2c: fixtures lock the structure; the variant locks once a stage that plays it has started. "Locked" is both.
  const lockedProps = (locked: boolean) => ({ structureLocked: locked, lockedFields: locked ? [{ field: "variant_key", code: "DIVISION_FORMAT_LOCKED" as const, stageId: "s1", stageName: "Round 1" }] : [] });
  it("online ⇒ '· online on Lichess', locked or not and whatever the flag (a fact, not a control); off ⇒ absent", () => {
    const ON = EN_UI["divset.onlinePlay.summaryOn"]!;
    let checked = 0;
    for (const offered of [true, false]) {
      for (const locked of [false, true]) {
        const on = renderIsland(DivisionSettings, { ...settingsProps("boardgame", { variant: "classical", onlinePlay: "lichess" }, offered), ...lockedProps(locked) }).tree();
        expect(formatSummary(on), `offered ${offered}, locked ${locked}`).toContain(` · ${ON}`);
        const off = renderIsland(DivisionSettings, { ...settingsProps("boardgame", { variant: "classical", onlinePlay: "off" }, offered), ...lockedProps(locked) }).tree();
        expect(formatSummary(off), `off: offered ${offered}, locked ${locked}`).not.toContain(ON);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });
});

describe("division Settings: a save refused because the club is not offered online chess", () => {
  const LOCALES = ["en", "es", "fr", "nl"] as const;
  const DICTS = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
  ) as Record<(typeof LOCALES)[number], Dict>;
  const KEY = "divset.err.onlineChessDisabled";
  const SERVER_SENTENCE = "Online chess is not available for this organisation";

  it("renders the localised refusal, never the server's English text", async () => {
    net.refuseDivisionPatch = new ApiV1Error(SERVER_SENTENCE, 403, ONLINE_CHESS_DISABLED_CODE);
    const island = renderIsland(
      DivisionSettings,
      settingsProps("boardgame", { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } }, true),
    );
    const save = island.tree().find((n) => n.type === "button" && textOf(n).trim() === "Save match rules");
    expect(save, "premise: the save is there").toBeDefined();
    (propsOf(save!).onClick as () => void)();
    // useMsg falls back to the English catalog outside a provider: the sentence a customer reads in English.
    const want = EN_UI[KEY] as string;
    expect(typeof want === "string" && want.length > 0, "premise: the English sentence exists").toBe(true);
    await vi.waitFor(() => expect(island.text()).toContain(want));
    expect(island.text(), "the server's sentence is never shown").not.toContain(SERVER_SENTENCE);
  });

  it("the sentence exists in all four locales, and each locale says it in its own words", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const text = DICTS[loc][KEY];
      expect(typeof text === "string" && text.trim().length > 0, `${loc} ${KEY}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    expect(new Set(LOCALES.map((l) => DICTS[l][KEY])).size).toBe(LOCALES.length);
    // The code the island matches on is the one the server's gates actually throw.
    expect(onlineChessDisabled().code).toBe(ONLINE_CHESS_DISABLED_CODE);
    expect(onlineChessDisabled().status).toBe(403);
  });
});

describe("needs-a-result queue: nothing on it starts play, so it takes no flag", () => {
  const ROW = {
    fixtureId: "f1",
    homeName: "Ann",
    awayName: "Bo",
    reason: "aborted" as const,
    whiteSide: "home" as const,
    revokedSeat: null,
    roundNo: 1,
    boardNo: 3,
    stageName: "League",
    canResync: true,
    seated: false,
    noResultOffer: { kind: "void" as const },
  };
  it("no Resend at all; the four settle buttons and Resync — the controls that FINISH a board", () => {
    const tree = renderIsland(ExternalPlayNeedsResultQueue, { held: [ROW], flagged: [], ownFlagged: 0, venueTz: "UTC" }).tree();
    expect(byTestId(tree, "external-play-resend")).toHaveLength(0);
    const resolves = new Set(tree.filter((n) => String(propsOf(n)["data-testid"] ?? "").startsWith("external-play-resolve-")));
    expect(resolves.size, "resolving finishes a board").toBe(4);
    expect(new Set(byTestId(tree, "external-play-resync")).size).toBe(1);
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
    expect(byTestId(tree, "lichess-relink"), "a grant that plays needs no re-link").toHaveLength(0);
    expect(byTestId(tree, "lichess-unlink")).toHaveLength(1);
  });

  it("from /me: the start returns to /me, not the account tab", () => {
    const tree = renderIsland(LichessLinkCard, { linkedUsername: null, configured: true, orgSlug: "riverside", next: "/me" }).tree();
    expect(propsOf(byTestId(tree, "lichess-link")[0]!).href).toBe("/api/auth/lichess?org=riverside&next=%2Fme");
  });

  it("linked with a grant that cannot play: the sentence, a re-link for the club, and unlink; no club ⇒ the sentence alone", () => {
    const withClub = renderIsland(LichessLinkCard, {
      linkedUsername: "Magnus",
      configured: true,
      orgSlug: "riverside",
      needsReconsent: true,
    }).tree();
    expect(withClub.some((n) => textOf(n).includes(String(EN_UI["settings.account.lichess.reconsentRequired"])))).toBe(true);
    const relink = byTestId(withClub, "lichess-relink");
    expect(new Set(relink).size).toBe(1);
    expect(propsOf(relink[0]!).href).toBe("/api/auth/lichess?org=riverside&next=%2Fsettings%3Ftab%3Daccount");
    expect(textOf(relink[0]!)).toBe(EN_UI["settings.account.lichess.consent.cta"]);
    expect(byTestId(withClub, "lichess-unlink").length).toBeGreaterThan(0);

    const noClub = renderIsland(LichessLinkCard, { linkedUsername: "Magnus", configured: true, orgSlug: null, needsReconsent: true }).tree();
    expect(noClub.some((n) => textOf(n).includes(String(EN_UI["settings.account.lichess.reconsentRequired"])))).toBe(true);
    expect(byTestId(noClub, "lichess-relink")).toHaveLength(0);
  });

  it("not linked and no club to link for: no link at all (the start would be refused)", () => {
    const tree = renderIsland(LichessLinkCard, { linkedUsername: null, configured: true, orgSlug: null }).tree();
    expect(byTestId(tree, "lichess-link")).toHaveLength(0);
  });
});
