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
const loadDivisionWatch = vi.fn();
vi.mock("@/server/usecases/external-play-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/external-play-read")>()),
  loadDivisionWatch: (...a: unknown[]) => loadDivisionWatch(...a),
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
  loadDivisionWatch.mockReset();
  loadDivisionWatch.mockResolvedValue({ links: { f1: { kind: "live" } }, roundOpenedAt: { f1: "2026-10-16T13:05:00.000Z" } });
});

describe("public division page — the watch links (I4)", () => {
  it("an online chess division: one read for THIS division, its links and the org locale's words reach the list", async () => {
    const props = await scheduleProps("boardgame", { variant: "classical", onlinePlay: "lichess" });
    expect(loadDivisionWatch.mock.calls).toEqual([["d1"]]);
    // V4 (T17 fix round 4): the same read carries each open board's round-open moment, for the rail.
    expect(props.watch).toEqual({
      links: { f1: { kind: "live" } },
      roundOpenedAt: { f1: "2026-10-16T13:05:00.000Z" },
      copy: {
        live: msgFor("fr", "externalPlay.watch.list.live"),
        final: msgFor("fr", "externalPlay.watch.list.final"),
        notOpened: msgFor("fr", "externalPlay.watch.list.notOpened"),
        starting: msgFor("fr", "externalPlay.watch.list.starting"),
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
    expect(loadDivisionWatch, "no read for any of them").not.toHaveBeenCalled();
    expect(checked, "anti-vacuity: sports swept").toBeGreaterThan(3);
  });
});

// T17 round B, C: the division's format badge over an online division is its time control's speed (variant-label.ts),
// the same word the fixture page's header prints — a "Classical" division played at 10+5 is Rapid.
describe("public division page — the format badge of an online chess division", () => {
  const badgeTexts = async (config: unknown) => {
    getPublicDivision.mockResolvedValue(divisionData("boardgame", config));
    const root = await DivisionHomePage({ params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "cup", divisionSlug: "open" }) });
    return elements(root)
      .filter((el) => typeof (el.props as { className?: unknown }).className === "string" && (el.props as { className: string }).className.includes("bg-accent-soft"))
      .map((el) => (el.props as { children?: unknown }).children);
  };
  it("online at 10+5 reads the speed; over the board the declared family stands", async () => {
    const rapid = msgFor("fr", "variant.boardgame.rapid");
    const classical = msgFor("fr", "variant.boardgame.classical");
    expect(rapid, "premise: two different words").not.toBe(classical);
    expect(await badgeTexts({ variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } })).toEqual([rapid]);
    expect(await badgeTexts({ variant: "classical", onlinePlay: "off", clock: { base: 600, increment: 5 } })).toEqual([classical]);
  });
});
