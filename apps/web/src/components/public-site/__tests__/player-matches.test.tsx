// Spectator surface W2, Task 14 — the player page's match lines update IN PLACE
// while the page is open (R10), through ONE poll.
//
// Driven through the shared `_hook-harness` (`renderIsland`) with fake timers,
// the way `use-live-competition.test.tsx` drives the hub: the island itself is
// mounted, so what is asserted is the TEXT a spectator reads after a tick, not
// a hook's return value that the markup might ignore. `fetchPlayerMatches` is
// mocked here; its URL and `no-store` contract are pinned on the real `api()`
// in `player-matches-data.test.ts`, because an assertion on fetch's call shape
// made against this mock would pass with the URL spelled any way at all.
//
// Cadence is witnessed by COUNTING FETCHES across time, not by spying on
// `setInterval`: the island also runs a clock for its "Updated Ns ago" line,
// and a spy that reads interval lengths cannot tell that clock from the poll.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { intlLocaleFor } from "@/lib/public-date-locale";
import type { PlayerMatchLineT, PublicPlayerMatchesT } from "@/server/public-site/player-matches-schema";

vi.mock("../player-matches-data", () => ({ fetchPlayerMatches: vi.fn() }));

import { fetchPlayerMatches } from "../player-matches-data";
import { PlayerMatches, type PlayerMatchesProps } from "../player-matches";
import { HUB_IDLE_POLL_MS, HUB_POLL_MS } from "../use-live-competition";

const PERSON = "11111111-2222-3333-4444-555555555555";
const HELD_AT = "2026-09-05T12:00:00.000Z";

const line = (fixtureId: string, figures: string, over: Partial<PlayerMatchLineT> = {}): PlayerMatchLineT => ({
  fixtureId,
  href: `/shared/riverside/autumn-cup/premier/fixtures/${fixtureId}`,
  divisionName: "Premier",
  divisionSlug: "premier",
  scheduledAt: "2026-09-05T10:00:00.000Z",
  tz: "Europe/London",
  opponentName: "Queens",
  line: figures,
  result: "won",
  ...over,
});

const doc = (matches: PlayerMatchLineT[], generatedAt = HELD_AT): PublicPlayerMatchesT => ({ matches, generatedAt });

const LIVE = () => doc([line("f2", "54 (40)", { result: "live" }), line("f1", "12 (9)", { result: "lost" })]);
const IDLE = () => doc([line("f2", "54 (40)", { result: "won" }), line("f1", "12 (9)", { result: "lost" })]);

function mount(initial: PublicPlayerMatchesT) {
  const props: PlayerMatchesProps = {
    orgSlug: "riverside",
    competitionSlug: "autumn-cup",
    personId: PERSON,
    initial,
    dict: en as Dict,
    locale: "en",
  };
  return renderIsland(PlayerMatches, props);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:05.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("PlayerMatches — live means live", () => {
  it("a poll that returns a changed line re-renders that figure in place, with no reload", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(
      doc([line("f2", "61 (44)", { result: "live" }), line("f1", "12 (9)", { result: "lost" })], "2026-09-05T12:00:15.000Z"),
    );
    const island = mount(LIVE());
    expect(island.text()).toContain("54 (40)");
    expect(island.text()).not.toContain("61 (44)");

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);

    expect(fetchPlayerMatches).toHaveBeenCalledWith("riverside", "autumn-cup", PERSON);
    expect(island.text()).toContain("61 (44)");
    expect(island.text()).not.toContain("54 (40)");
    // The untouched line is still there: a whole-document replace, not a wipe.
    expect(island.text()).toContain("12 (9)");
  });

  it("a match that finishes between ticks loses its live pill on the next poll", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(
      doc([line("f2", "54 (40)", { result: "won" }), line("f1", "12 (9)", { result: "lost" })], "2026-09-05T12:00:15.000Z"),
    );
    const island = mount(LIVE());
    expect(island.text()).toContain(en["player.result.live"]);

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);

    expect(island.text()).not.toContain(en["player.result.live"]);
    expect(island.text()).toContain(en["player.result.won"]);
  });

  it("a failed poll keeps the lines the page already shows", async () => {
    vi.mocked(fetchPlayerMatches).mockRejectedValue(new Error("offline"));
    const island = mount(LIVE());
    await expect(vi.advanceTimersByTimeAsync(HUB_POLL_MS)).resolves.not.toThrow();
    expect(island.text()).toContain("54 (40)");
  });

  it("a response built BEFORE the document held is not applied (R10 C1)", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(
      doc([line("f2", "10 (8)", { result: "live" })], "2026-09-05T11:59:00.000Z"),
    );
    const island = mount(LIVE());
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    expect(island.text()).toContain("54 (40)");
    expect(island.text()).not.toContain("10 (8)");
  });
});

/** The fixture ids of the slab and of the rows, read from the rendered
 *  match links: the slab is the one carrying `data-slab`. */
function layout(island: ReturnType<typeof mount>) {
  const links = island
    .tree()
    .map(propsOf)
    .filter((p) => typeof p["data-testid"] === "string" && (p["data-testid"] as string).startsWith("mh-player-match-"));
  const id = (p: Record<string, unknown>) => (p["data-testid"] as string).slice("mh-player-match-".length);
  return {
    slab: links.filter((p) => p["data-slab"] === "true").map(id),
    rows: links.filter((p) => p["data-slab"] === undefined).map(id),
  };
}

describe("PlayerMatches — the slab follows the live match", () => {
  it("a poll where a DIFFERENT fixture goes live moves the slab to it, and the old slab fixture becomes a row", async () => {
    const before = doc([
      line("f3", "8 (11)", { result: "won" }),
      line("f2", "", { result: null }),
      line("f1", "12 (9)", { result: "lost" }),
    ]);
    vi.mocked(fetchPlayerMatches).mockResolvedValue(
      doc(
        [line("f3", "8 (11)", { result: "won" }), line("f2", "17 (12)", { result: "live" }), line("f1", "12 (9)", { result: "lost" })],
        "2026-09-05T12:01:00.000Z",
      ),
    );
    const island = mount(before);
    expect(layout(island)).toEqual({ slab: ["f3"], rows: ["f2", "f1"] });
    expect(island.text()).not.toContain(en["player.result.live"]);

    // Nothing live yet, so the next fetch is the idle one.
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS);

    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    expect(layout(island)).toEqual({ slab: ["f2"], rows: ["f3", "f1"] });
    const slabPill = island.tree().map(propsOf).find((p) => p["data-testid"] === "mh-player-slab-live");
    expect(slabPill, "the moved slab carries the live pill").toBeDefined();
    expect(island.text()).toContain("17 (12)");
  });
});

describe("PlayerMatches — the older-response guard compares SERVER clocks (F9)", () => {
  // The seed's `generatedAt` is the server's cached-read instant and every
  // poll document's is the server's build instant. The viewer's clock is in
  // neither: here it runs five minutes FAST, so a guard that measured a
  // document against `Date.now()` would refuse every fresh one.
  it("a Redis document built BEFORE the seed is dropped; one built AFTER it is kept, whatever the viewer's clock says", async () => {
    vi.setSystemTime(new Date("2026-09-05T12:05:00.000Z"));
    vi.mocked(fetchPlayerMatches)
      .mockResolvedValueOnce(doc([line("f2", "40 (30)", { result: "live" })], "2026-09-05T11:59:50.000Z"))
      .mockResolvedValueOnce(doc([line("f2", "61 (44)", { result: "live" })], "2026-09-05T12:00:10.000Z"));
    const island = mount(LIVE());

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    expect(island.text(), "built 10 s before the seed").not.toContain("40 (30)");
    expect(island.text()).toContain("54 (40)");

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(2);
    expect(island.text(), "built 10 s after the seed").toContain("61 (44)");
    expect(island.text()).not.toContain("54 (40)");
  });
});

describe("PlayerMatches — one poll, at the hub's cadence", () => {
  it("with a live line it polls every HUB_POLL_MS", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(LIVE());
    mount(LIVE());
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(2);
  });

  it("with nothing live it does NOT poll at the live cadence — only every HUB_IDLE_POLL_MS", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(IDLE());
    mount(IDLE());
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS - HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
  });

  // One instance driven across the boundary. Two separately mounted hooks
  // only witness the cadence each was BORN with — the hub's own suite records
  // a dropped `hasLive` dependency surviving exactly that.
  it("re-arms the cadence when the last live line finishes", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(doc(IDLE().matches, "2026-09-05T12:00:15.000Z"));
    mount(LIVE());
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    // Now idle: another live-cadence tick must NOT fetch.
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS - HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(2);
  });

  it("unmount stops polling", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(LIVE());
    const island = mount(LIVE());
    island.unmount();
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS * 2);
    expect(fetchPlayerMatches).not.toHaveBeenCalled();
  });
});

describe("PlayerMatches — the freshness line counts from the DOCUMENT's clock", () => {
  it("while live it reads the seconds since `generatedAt`, and it advances", async () => {
    const island = mount(LIVE());
    // System time is HELD_AT + 5 s.
    expect(island.text()).toContain("Updated 5s ago");
    vi.mocked(fetchPlayerMatches).mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(island.text()).toContain("Updated 8s ago");
  });

  it("with nothing live there is no freshness line (positive pair above)", () => {
    const island = mount(IDLE());
    expect(island.text()).not.toContain("Updated");
  });
});

// The owner's day-month ruling (2026-09-16, `lib/public-date-locale.ts`): an
// English org's dates read "5 Sept", never the US "Sep 5" that bare "en" gives
// `Intl`. Every other locale keeps its own format. The slab is where the ORDER
// shows — a row puts day and month in separate elements — so the order is
// asserted there and the month word on a row.
//
// Expected strings are derived from `Intl` through `intlLocaleFor`, with the
// venue zone pinned in the options (the worker's TZ is not something a test can
// move), plus ONE literal so the day-month order itself is witnessed. Markup is
// read through `renderToStaticMarkup` and anchored on `>…<`, so a string that
// merely contains the expected one cannot pass.
describe("PlayerMatches — dates in the org's locale, day-month for English", () => {
  const TZ = "Europe/London";
  const AT = "2026-09-05T10:00:00.000Z";
  const SLAB: Intl.DateTimeFormatOptions = { timeZone: TZ, weekday: "short", day: "numeric", month: "short" };
  const MONTH: Intl.DateTimeFormatOptions = { timeZone: TZ, month: "short" };
  const fmt = (tag: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, opts).format(Date.parse(AT));

  const markup = (locale: Locale, dict: Dict) =>
    renderToStaticMarkup(
      <PlayerMatches
        orgSlug="riverside"
        competitionSlug="autumn-cup"
        personId={PERSON}
        initial={doc([
          line("f2", "54 (40)", { scheduledAt: AT, tz: TZ }),
          line("f1", "12 (9)", { scheduledAt: AT, tz: TZ, result: "lost" }),
        ])}
        dict={dict}
        locale={locale}
      />,
    );

  it("premise: bare en and intlLocaleFor(en) really differ, in the slab and in the month word", () => {
    expect(intlLocaleFor("en")).not.toBe("en");
    expect(fmt(intlLocaleFor("en"), SLAB)).not.toBe(fmt("en", SLAB));
    expect(fmt(intlLocaleFor("en"), MONTH)).not.toBe(fmt("en", MONTH));
  });

  it("en: the slab reads day-month — 'Sat 5 Sept', not the US 'Sat, Sep 5'", () => {
    const html = markup("en", en as Dict);
    expect(html).toContain(">Sat 5 Sept<");
    expect(html).toContain(`>${fmt(intlLocaleFor("en"), SLAB)}<`);
    expect(html).not.toContain(`>${fmt("en", SLAB)}<`);
  });

  it("en: a row's month word is the day-month locale's ('Sept'), not bare en's ('Sep')", () => {
    const html = markup("en", en as Dict);
    expect(html).toContain(`>${fmt(intlLocaleFor("en"), MONTH)}<`);
    expect(html).not.toContain(`>${fmt("en", MONTH)}<`);
  });

  it("es: keeps its own format, in the slab and on a row (positive pair: not the English one)", () => {
    expect(intlLocaleFor("es")).toBe("es");
    const html = markup("es", es as Dict);
    expect(html).toContain(`>${fmt("es", SLAB)}<`);
    expect(html).toContain(`>${fmt("es", MONTH)}<`);
    expect(fmt("es", SLAB)).not.toBe(fmt(intlLocaleFor("en"), SLAB));
    expect(html).not.toContain(`>${fmt(intlLocaleFor("en"), SLAB)}<`);
  });
});
