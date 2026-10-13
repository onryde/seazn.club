// T16 fix round 1, I4 — the public division page hands its Fixtures list the online watch links for an online
// chess division, and makes NO read for any other division. The page is an async server component: called with its
// data doors mocked, its returned tree walked (node vitest has no DOM).
//
// Single-sport by construction: online play is boardgame only (supportsOnlinePlay); the negative pair is every
// OTHER registered sport plus an online-capable division with online play off.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement } from "react";

const getPublicDivision = vi.fn();
vi.mock("@/server/public-site/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/public-site/data")>()),
  getPublicDivision: (...a: unknown[]) => getPublicDivision(...a),
}));
vi.mock("@/server/usecases/discipline", () => ({ publicSuspensions: async () => [] }));
const loadDivisionWatchLinks = vi.fn();
vi.mock("@/server/usecases/external-play-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/external-play-read")>()),
  loadDivisionWatchLinks: (...a: unknown[]) => loadDivisionWatchLinks(...a),
}));

import { msgFor } from "@/lib/messages-i18n";
import { builtinModules } from "@seazn/engine/sports";
import { resolveLatestModule } from "@/server/engine-db";
import { Schedule } from "@/components/public-site/schedule";
import DivisionHomePage from "../page";

const divisionData = (sportKey: string, config: unknown) => {
  const mod = resolveLatestModule(sportKey);
  return {
    org: { id: "o1", slug: "test-org", name: "Test Org", default_locale: "fr" },
    competition: {
      id: "c1", org_id: "o1", name: "Cup", slug: "cup", description: null, starts_on: null, ends_on: null,
      branding: {}, status: "active", visibility: "public",
    },
    division: {
      id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: sportKey,
      variant_key: Object.keys(mod.variants)[0] ?? "default", status: "active", module_version: mod.version,
      tiebreakers: null, sport_name: null, entrant_count: 0, config,
    },
    stages: [], pools: [], fixtures: [], standings: [], entrants: [], tz: "UTC",
  };
};
function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const child of node) elements(child, out);
  else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values((node.props ?? {}) as Record<string, unknown>)) elements(value, out);
  }
  return out;
}
async function scheduleProps(sportKey: string, config: unknown) {
  getPublicDivision.mockResolvedValue(divisionData(sportKey, config));
  const root = await DivisionHomePage({ params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "cup", divisionSlug: "open" }) });
  const s = elements(root).filter((el) => el.type === Schedule);
  expect(s, "anti-vacuity: the Fixtures list is on the page").toHaveLength(1);
  return s[0]!.props as Parameters<typeof Schedule>[0];
}

beforeEach(() => {
  loadDivisionWatchLinks.mockReset();
  loadDivisionWatchLinks.mockResolvedValue({ f1: { kind: "live" } });
});

describe("public division page — the watch links (I4)", () => {
  it("an online chess division: one read for THIS division, its links and the org locale's words reach the list", async () => {
    const props = await scheduleProps("boardgame", { variant: "classical", onlinePlay: "lichess" });
    expect(loadDivisionWatchLinks.mock.calls).toEqual([["d1"]]);
    expect(props.watch).toEqual({
      links: { f1: { kind: "live" } },
      copy: {
        live: msgFor("fr", "externalPlay.watch.list.live"),
        final: msgFor("fr", "externalPlay.watch.list.final"),
        notOpened: msgFor("fr", "externalPlay.watch.list.notOpened"),
      },
    });
  });

  it("every other division makes no read and passes no links — online play off, and every other sport", async () => {
    let checked = 0;
    const off = await scheduleProps("boardgame", { variant: "classical", onlinePlay: "off" });
    expect(off.watch, "boardgame, online play off").toBeUndefined();
    checked += 1;
    for (const key of [...new Set(builtinModules.map((m) => m.key))].filter((k) => k !== "boardgame")) {
      const props = await scheduleProps(key, { onlinePlay: "lichess" });
      expect(props.watch, key).toBeUndefined();
      checked += 1;
    }
    expect(loadDivisionWatchLinks, "no read for any of them").not.toHaveBeenCalled();
    expect(checked, "anti-vacuity: sports swept").toBeGreaterThan(3);
  });
});
