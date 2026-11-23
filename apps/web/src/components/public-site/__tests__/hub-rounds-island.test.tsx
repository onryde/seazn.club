// W5 follow-ups C (owner 2026-11-23, Option A "by round"): a folded round on the hub's Matches tab loads its cards when opened, from
// `[divisionSlug]/hub-rounds` (fetch stubbed with the route's own reader, `hubRoundMatches`, over the whole document), reads them AGAIN
// when the polled document changes build (`generatedAt`) so a loaded round keeps its live scores, and not when a poll changed nothing;
// a failed read says so and Try again reads again. Node env: driven through the hook harness (effects run on commit).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { hubRoundMatches, windowHubDoc } from "@/lib/hub-round-paging";
import type { HubMatchT } from "@/server/public-site/competition-hub-schema";
import { HubRounds } from "../matches-hub/hub-rounds";
import { MatchCard } from "../matches-hub/match-card";
import { hubDoc, m } from "./hub-fixtures";

const NOW = Date.parse("2026-09-05T12:00:00Z");
/** 15 rounds of 15 (225 cards, over the paging line): rounds 1-7 played, 8-15 to come. */
const full = hubDoc({
  matches: Array.from({ length: 225 }, (_, i) => {
    const round = Math.floor(i / 15) + 1;
    return m(`P${round}-${i % 15}`, round <= 7 ? "completed" : "upcoming", new Date(NOW + (round - 8) * 86_400_000).toISOString(), "premier", { roundNo: round });
  }),
});
const served = windowHubDoc(full);
const pages = served.roundPages!;
const key9 = pages.find((p) => p.roundNo === 9)!.key;

const calls: string[] = [];
function stubFetch(fail: number[] = []) {
  let n = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    n += 1;
    if (fail.includes(n)) return new Response("{}", { status: 500 });
    const key = new URL(url, "http://x").searchParams.get("key")!;
    return new Response(JSON.stringify({ ok: true, data: hubRoundMatches(full, "premier", key) }), { status: 200 });
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});
const props = (generatedAt: string) => ({
  doc: { orgSlug: full.orgSlug, competitionSlug: full.competitionSlug, generatedAt },
  divisionSlug: "premier",
  divisionName: "Premier",
  pages,
  matches: served.matches,
  bucket: "upcoming" as const,
  dict: en as Dict,
  locale: "en" as const,
  now: NOW,
  showDivision: false,
});
type Island = { tree: () => ReactElement[]; rerender: (p: never) => void };
const toggleOf = (island: Island, k: string) => {
  const round = island.tree().find((el) => propsOf(el)["data-round-key"] === k)!;
  const at = island.tree().indexOf(round);
  return island.tree().slice(at).find((el) => propsOf(el)["data-testid"] === "mh-round-toggle")!;
};
const cardsOf = (island: Island) => island.tree().filter((el) => el.type === MatchCard).map((el) => (propsOf(el).match as HubMatchT).fixtureId);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("C: a folded hub round loads when opened and keeps up with the poll", () => {
  it("premise: round 8 is served open, round 9 is folded", () => {
    expect(pages.find((p) => p.roundNo === 8)!.open).toBe(true);
    expect(pages.find((p) => p.roundNo === 9)!.open).toBe(false);
  });

  it("opening round 9 reads it once and draws exactly its 15 cards; nothing is read before the tap", async () => {
    stubFetch();
    const island = renderIsland(HubRounds, props("g1") as never) as unknown as Island;
    await settle();
    expect(calls, "no read for a shut round").toEqual([]);
    (propsOf(toggleOf(island, key9)).onClick as () => void)();
    await settle();
    expect(calls.length).toBe(1);
    // Review minor: the URL names the document build (`at`), so an edge-cached answer of an older build is never read as this one's.
    expect(calls[0]).toContain(`/live/${full.orgSlug}/${full.competitionSlug}/premier/hub-rounds?key=${encodeURIComponent(key9)}&at=g1`);
    expect(cardsOf(island).filter((id) => id.startsWith("P9-")).length).toBe(15);
  });

  it("a poll with a new build reads the open round again; a poll that changed nothing does not", async () => {
    stubFetch();
    const island = renderIsland(HubRounds, props("g1") as never) as unknown as Island;
    (propsOf(toggleOf(island, key9)).onClick as () => void)();
    await settle();
    island.rerender(props("g1") as never);
    await settle();
    expect(calls.length, "same build: no read").toBe(1);
    island.rerender(props("g2") as never);
    await settle();
    expect(calls.length, "new build: read again").toBe(2);
    expect(new URL(calls[1]!, "http://x").searchParams.get("at"), "at the new build").toBe("g2");
    expect(cardsOf(island).filter((id) => id.startsWith("P9-")).length, "the cards stay while it reads").toBe(15);
  });

  it("opening a second round while the first is still being read reads each round once", async () => {
    stubFetch();
    const island = renderIsland(HubRounds, props("g1") as never) as unknown as Island;
    const key10 = pages.find((p) => p.roundNo === 10)!.key;
    (propsOf(toggleOf(island, key9)).onClick as () => void)();
    (propsOf(toggleOf(island, key10)).onClick as () => void)();
    await settle();
    await settle();
    expect(calls.map((u) => new URL(u, "http://x").searchParams.get("key")).sort()).toEqual([key10, key9].sort());
    expect(cardsOf(island).filter((id) => id.startsWith("P10-")).length).toBe(15);
  });

  it("a round whose read failed is read again on the next build, and says it is loading meanwhile, not that it failed", async () => {
    stubFetch([1]);
    const island = renderIsland(HubRounds, props("g1") as never) as unknown as Island;
    (propsOf(toggleOf(island, key9)).onClick as () => void)();
    await settle();
    expect(island.tree().some((el) => propsOf(el).role === "alert"), "premise: the first read failed").toBe(true);
    island.rerender(props("g2") as never);
    expect(island.tree().some((el) => propsOf(el)["data-testid"] === "mh-round-loading"), "re-reading for the new build").toBe(true);
    expect(island.tree().some((el) => propsOf(el).role === "alert")).toBe(false);
    await settle();
    expect(calls.length).toBe(2);
    expect(cardsOf(island).filter((id) => id.startsWith("P9-")).length).toBe(15);
  });

  it("a failed read says so, and Try again reads the round again", async () => {
    stubFetch([1]);
    const island = renderIsland(HubRounds, props("g1") as never) as unknown as Island;
    (propsOf(toggleOf(island, key9)).onClick as () => void)();
    await settle();
    const alert = island.tree().find((el) => propsOf(el).role === "alert");
    expect(alert, "the failure line").toBeDefined();
    const retry = island.tree().find((el) => el.type === "button" && propsOf(el).children === (en as Dict)["paging.retry"])!;
    (propsOf(retry).onClick as () => void)();
    await settle();
    expect(calls.length).toBe(2);
    expect(cardsOf(island).filter((id) => id.startsWith("P9-")).length).toBe(15);
  });
});
