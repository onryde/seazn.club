// Design review M-7 — the player's /me page joined each of its three match lines (the next match, the upcoming list,
// the results) with a typed "vs" in every locale; every other "A vs B" the product prints is the dictionary's
// `schedule.vs`. Only fr differs ("contre"; en, es and nl all say "vs"), so French is the case that can fail, and the
// English render is its pair. The page is rendered whole, its reads mocked; the three lines are found by their names.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { msgFor } from "@/lib/messages-i18n";
import type { MyFixture, MyResult } from "@/server/usecases/me";

const locale = vi.hoisted(() => ({ current: "en" as "en" | "fr" }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/me",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: async () => ({ id: "u1", email: "player@example.com", display_name: "Pat" }),
  getActiveOrgId: async () => null,
  getUserOrgs: async () => [],
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => locale.current }));

const fixtureRow = (id: string, entrant: string, opponent: string): MyFixture =>
  ({
    id, fixture_no: 1, person_id: "p1", person_name: "Pat", org_name: "Club", org_slug: "club",
    competition_name: "Cup", competition_slug: "cup", competition_visibility: "public",
    division_name: "Open", division_slug: "open", sport_key: "football", round_no: 1,
    entrant_name: entrant, opponent_name: opponent, scheduled_at: null, venue_tz: null,
    venue_name: null, court_name: null,
  }) as unknown as MyFixture;
const resultRow: MyResult = {
  id: "r1", fixture_no: 3, competition_name: "Cup", competition_slug: "cup", competition_visibility: "public",
  division_name: "Open", division_slug: "open", org_name: "Club", org_slug: "club",
  entrant_name: "Lions", opponent_name: "Tigers", player_home: true, scheduled_at: null, summary: null, outcome: null,
  home_entrant_id: null, away_entrant_id: null, abandon_reason: null,
};

vi.mock("@/server/usecases/me", () => ({
  listMyFixtures: async () => ({
    upcoming: [fixtureRow("f1", "Falcons", "Hawks"), fixtureRow("f2", "Owls", "Ravens")],
    results: [resultRow],
    teams: [],
  }),
  getMySuspensions: async () => [],
  listMyPersons: async () => [],
  listMyPlayerStats: async () => [],
  listMyCareerStats: async () => [],
}));
vi.mock("@/server/usecases/me-officiating", () => ({
  getMyOfficiating: async () => ({ is_official: false, assignments: [], completed: [], blackouts: [] }),
  listPendingOfficiatingClaims: async () => [],
}));
vi.mock("@/server/usecases/official-marks", () => ({ myMarksAverage: async () => null }));
// page.tsx reads the Lichess card (chess T16) beside the lanes; nothing to link here, and no DB in CI's test job.
vi.mock("@/server/usecases/me-lichess", () => ({
  myLichessLink: async () => ({ show: false, linkedUsername: null, needsReconsent: false, orgSlug: null }),
}));

const { default: MePage } = await import("../page");

/** Each match line's words, found by its two names: the text between them, tags stripped. */
async function joins(at: "en" | "fr"): Promise<string[]> {
  locale.current = at;
  const html = renderToStaticMarkup((await MePage({ searchParams: Promise.resolve({}) })) as ReactElement);
  return (
    [
      ["Falcons", "Hawks"],
      ["Owls", "Ravens"],
      ["Lions", "Tigers"],
    ] as const
  ).map(([a, b]) => {
    const m = new RegExp(`${a}([\\s\\S]*?)${b}`).exec(html);
    if (!m) throw new Error(`${at}: no match line for ${a} / ${b}`);
    return m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  });
}

describe("/me — each match line joins its sides with the locale's own word for vs (review M-7)", () => {
  it("fr: the next match, the upcoming list and the results all say the French word", async () => {
    const vs = msgFor("fr", "schedule.vs");
    expect(vs, "premise: French says it differently").not.toBe("vs");
    expect(await joins("fr")).toEqual([vs, vs, vs]);
  });
  it("en: the pair — the same three lines say the English word", async () => {
    const vs = msgFor("en", "schedule.vs");
    expect(await joins("en")).toEqual([vs, vs, vs]);
  });
});
