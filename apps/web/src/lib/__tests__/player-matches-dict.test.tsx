// The guarantee behind `playerMatchesDict()` — `hub-dict.test.tsx`'s
// differential, for the player page's match lines island. The island is
// rendered twice per state, once with the full public dictionary and once with
// the slice, and the markup must be identical: a key the island reads that the
// slice drops shows up here as a raw key in the diff, instead of on the page.
//
// Every state that reaches different copy is rendered — empty, a live slab
// with every row result, a settled slab — because a slice proved against one
// shape of document is proved for that shape only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { playerMatchesDict } from "@/lib/player-matches-dict";
import { PlayerMatches } from "@/components/public-site/player-matches";
import type { PlayerMatchLineT, PublicPlayerMatchesT } from "@/server/public-site/player-matches-schema";

vi.mock("@/components/public-site/player-matches-data", () => ({ fetchPlayerMatches: vi.fn() }));

const full = en as Dict;
const slice = playerMatchesDict(full);

const line = (fixtureId: string, over: Partial<PlayerMatchLineT> = {}): PlayerMatchLineT => ({
  fixtureId,
  href: `/shared/riverside/autumn-cup/premier/fixtures/${fixtureId}`,
  divisionName: "Premier",
  divisionSlug: "premier",
  scheduledAt: "2026-09-05T10:00:00.000Z",
  tz: "Europe/London",
  opponentName: "Queens",
  line: "54 (40)",
  result: "won",
  ...over,
});

const STATES: Record<string, PublicPlayerMatchesT> = {
  empty: { matches: [], generatedAt: "2026-09-05T12:00:00.000Z" },
  "live slab, every row result, two divisions": {
    generatedAt: "2026-09-05T12:00:00.000Z",
    matches: [
      line("f6", { result: "live" }),
      line("f5", { result: "live", divisionSlug: "sunday", divisionName: "Sunday League" }),
      line("f4", { result: "won" }),
      line("f3", { result: "lost" }),
      line("f2", { result: "drawn", line: "—" }),
      line("f1", { result: null, scheduledAt: null }),
    ],
  },
  "settled slab": {
    generatedAt: "2026-09-05T12:00:00.000Z",
    matches: [line("f2", { result: "drawn" }), line("f1", { result: "lost" })],
  },
};

const render = (initial: PublicPlayerMatchesT, dict: Dict) =>
  renderToStaticMarkup(
    <PlayerMatches
      orgSlug="riverside"
      competitionSlug="autumn-cup"
      personId="11111111-2222-3333-4444-555555555555"
      initial={initial}
      dict={dict}
      locale="en"
    />,
  );

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:07.000Z"));
});
afterAll(() => vi.useRealTimers());

describe("playerMatchesDict — the slice renders what the full dictionary renders", () => {
  for (const [name, initial] of Object.entries(STATES)) {
    it(`identical markup: ${name}`, () => {
      expect(render(initial, slice)).toBe(render(initial, full));
    });
  }

  it("the slice is a slice — it drops what the island never reads", () => {
    expect(Object.keys(slice).length).toBeLessThan(15);
    expect(Object.hasOwn(slice, "landing.tab.overview")).toBe(false);
  });

  // The positive pair for the equality above: markup that rendered no copy at
  // all would be identical under both dictionaries too.
  it("the rendered states actually carry the copy the slice has to supply", () => {
    const live = render(STATES["live slab, every row result, two divisions"]!, slice);
    for (const k of ["player.result.live", "player.result.won", "player.result.lost", "player.result.drawn"]) {
      expect(live, k).toContain(full[k] as string);
    }
    expect(live).toContain("Updated 7s ago");
    expect(live).toContain("v Queens");
    expect(render(STATES.empty!, slice)).toContain(full["player.matches.empty"] as string);
  });
});
