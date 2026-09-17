// Spectator W2, Task 15 — the org home's chip island (R10: live means live,
// never reload). ONE island per page renders the whole competitions list and
// polls `GET /api/v1/public/orgs/{orgSlug}/live`; each chip is derived from
// the competition's status AND its in-play count, so a match starting flips
// "Upcoming" to "On now" in place, and one ending flips it back.
//
// Driven through the shared `_hook-harness` (`renderIsland`) with fake timers
// and the fetch module mocked, the way `use-live-competition.test.tsx` drives
// the hub's transport. `fetchOrgLive`'s own URL/unwrap contract is pinned in
// `org-live-data.test.ts`.
//
// What this cannot see (node vitest, no DOM): whether the browser actually
// runs the interval, the card's real tap area, and whether a class is in
// effect. The chip VALUE after a poll is what it pins.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { orgLiveDict } from "@/lib/hub-dict";
import type { PublicOrgLiveT } from "@/server/api-v1/schemas";

vi.mock("../org-live-data", () => ({ fetchOrgLive: vi.fn() }));

import { fetchOrgLive } from "../org-live-data";
import { HUB_IDLE_POLL_MS, HUB_POLL_MS } from "../use-live-competition";
import { OrgLiveChips, type OrgLiveChipsProps, type OrgLiveCompetition } from "../org-live-chips";

const DICT = en as Dict;

function comp(id: string, status: string, inPlay: number, over: Partial<OrgLiveCompetition> = {}): OrgLiveCompetition {
  return {
    id,
    slug: `${id}-cup`,
    name: `${id.toUpperCase()} Cup`,
    status,
    in_play: inPlay,
    dateLine: "1 Sept 2026 – 13 Sept 2026",
    ...over,
  };
}

function props(competitions: OrgLiveCompetition[], dict: Dict = DICT, locale: Locale = "en"): OrgLiveChipsProps {
  return { orgSlug: "riverside", competitions, dict, locale };
}

/** A dictionary's count sentence for `count` competitions' fixtures in play,
 *  read from the dictionary VALUE (never through the island's helper). */
const liveNow = (dict: Dict, form: "one" | "other", count: number) =>
  (dict[`org.live.${form}`] as string).replace("{count}", String(count));

type LivePoll = PublicOrgLiveT["competitions"][number];
const poll = (...competitions: LivePoll[]): PublicOrgLiveT => ({ competitions });
const row = (id: string, status: LivePoll["status"], in_play: number): LivePoll => ({ id, status, in_play });

/** Every chip the island currently draws, as `{id: chip}` — read from the
 *  element carrying the testid, so a chip that moved elsewhere cannot pass. */
function chips(tree: ReactElement[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of tree) {
    const p = propsOf(el);
    const testid = p["data-testid"];
    if (typeof testid === "string" && testid.startsWith("mh-org-chip-")) {
      out[testid.slice("mh-org-chip-".length)] = String(p["data-chip"]);
    }
  }
  return out;
}

/** The label a spectator reads on one competition's chip. */
function chipText(tree: ReactElement[], id: string): string {
  const el = tree.find((e) => propsOf(e)["data-testid"] === `mh-org-chip-${id}`);
  return el ? textOf(el).trim() : "(no chip)";
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("OrgLiveChips — first paint", () => {
  it("EMPTY first: no competitions renders nothing, fetches nothing and arms no poll (the page keeps its own empty sentence)", async () => {
    const spy = vi.spyOn(global, "setInterval");
    expect(renderToStaticMarkup(<OrgLiveChips {...props([])} />)).toBe("");
    const island = renderIsland(OrgLiveChips, props([]));
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS);
    expect(island.tree()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(fetchOrgLive).not.toHaveBeenCalled();
  });

  it("one chip per competition, each derived from status AND in-play — a published competition with a match in play is ON NOW", () => {
    const html = renderToStaticMarkup(
      <OrgLiveChips
        {...props([comp("a", "published", 2), comp("b", "published", 0), comp("c", "completed", 0)])}
      />,
    );
    expect(html.match(/data-testid="mh-org-chip-/g)).toHaveLength(3);
    expect(html).toMatch(/data-testid="mh-org-chip-a" data-chip="on-now"/);
    // Positive pair: the same status with nothing in play is still upcoming.
    expect(html).toMatch(/data-testid="mh-org-chip-b" data-chip="upcoming"/);
    expect(html).toMatch(/data-testid="mh-org-chip-c" data-chip="finished"/);
  });

  it("the chip's label is the dictionary's sentence for that chip, in the dictionary it was handed", () => {
    const island = renderIsland(
      OrgLiveChips,
      props([comp("a", "draft", 1), comp("b", "draft", 0), comp("c", "live", 0)], es as Dict, "es"),
    );
    expect(chipText(island.tree(), "a")).toBe(liveNow(es as Dict, "one", 1));
    expect(chipText(island.tree(), "b")).toBe(t(es as Dict, "chip.upcoming"));
    expect(chipText(island.tree(), "c")).toBe(t(es as Dict, "chip.onNow"));
    expect(liveNow(es as Dict, "one", 1), "premise: es is really translated").not.toBe(liveNow(DICT, "one", 1));
    expect(t(es as Dict, "chip.onNow"), "premise: es is really translated").not.toBe(t(DICT, "chip.onNow"));
  });

  it("each card links to its competition and carries the date line it was handed", () => {
    const html = renderToStaticMarkup(<OrgLiveChips {...props([comp("a", "published", 0, { dateLine: "1 sept 2026" })])} />);
    expect(html).toMatch(/href="\/shared\/riverside\/a-cup"/);
    expect(html).toContain(">1 sept 2026<");
    expect(html).toContain(">A Cup<");
  });

  it("a competition with no dates draws no empty date element", () => {
    const html = renderToStaticMarkup(<OrgLiveChips {...props([comp("a", "published", 0, { dateLine: "" })])} />);
    // The chip is the row's only child.
    expect(html).toMatch(/data-chip="upcoming"[^>]*>[^<]*<\/span><\/div>/);
  });

  it("hands only the chip slice of the dictionary across the boundary without changing a byte of markup", () => {
    const list = [comp("a", "published", 1), comp("b", "draft", 0), comp("c", "archived", 0), comp("d", "live", 0)];
    const full = renderToStaticMarkup(<OrgLiveChips {...props(list, DICT)} />);
    const slice = renderToStaticMarkup(<OrgLiveChips {...props(list, orgLiveDict(DICT))} />);
    expect(slice).toBe(full);
    // Not vacuous: every label the island can draw is in the markup, and the slice is small.
    for (const key of ["chip.onNow", "chip.upcoming", "chip.finished"] as const) expect(full).toContain(t(DICT, key));
    expect(full).toContain(liveNow(DICT, "one", 1));
    expect(Object.keys(orgLiveDict(DICT)).sort()).toEqual([
      "chip.finished",
      "chip.onNow",
      "chip.upcoming",
      "empty",
      "org.live.one",
      "org.live.other",
    ]);
  });
});

describe("OrgLiveChips — an in-play competition COUNTS its live matches (owner ruling 2026-09-16)", () => {
  // Every shipped dictionary writes `org.live.one` and `org.live.other` the
  // same way, so no real dictionary can tell the two plural forms apart. This
  // one can: only the form is different, never the key or the count.
  const FORMS = { ...orgLiveDict(DICT), "org.live.one": "{count} match live", "org.live.other": "{count} matches live" };

  it("premise: the shipped en forms are identical, so the form check needs its own dictionary", () => {
    expect(DICT["org.live.one"]).toBe(DICT["org.live.other"]);
  });

  it("1 in play → the ONE form, 3 in play → the OTHER form, 0 in play → the status label, unchanged", () => {
    const island = renderIsland(
      OrgLiveChips,
      props([comp("a", "published", 1), comp("b", "draft", 3), comp("c", "live", 0), comp("d", "published", 0)], FORMS),
    );
    expect(chipText(island.tree(), "a")).toBe("1 match live");
    expect(chipText(island.tree(), "b")).toBe("3 matches live");
    expect(chipText(island.tree(), "c")).toBe(t(DICT, "chip.onNow"));
    expect(chipText(island.tree(), "d")).toBe(t(DICT, "chip.upcoming"));
    // The count changes the words only: every in-play chip is still the on-now pill.
    expect(chips(island.tree())).toEqual({ a: "on-now", b: "on-now", c: "on-now", d: "upcoming" });
  });

  it("es: the count sentence is the es dictionary's value for that count", () => {
    const ES = orgLiveDict(es as Dict);
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 1), comp("b", "published", 3)], ES, "es"));
    expect(chipText(island.tree(), "a")).toBe(liveNow(es as Dict, "one", 1));
    expect(chipText(island.tree(), "b")).toBe(liveNow(es as Dict, "other", 3));
    expect(chipText(island.tree(), "b")).not.toBe(liveNow(DICT, "other", 3));
  });

  it("a poll that moves the count 1 → 2 re-renders the sentence in place", async () => {
    vi.mocked(fetchOrgLive).mockResolvedValue(poll(row("a", "published", 2)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 1)], FORMS));
    expect(chipText(island.tree(), "a")).toBe("1 match live");

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);

    expect(chipText(island.tree(), "a")).toBe("2 matches live");
    expect(chips(island.tree())).toEqual({ a: "on-now" });
  });
});

describe("OrgLiveChips — the poll (R10)", () => {
  it("fetches once ON MOUNT, before any interval tick — the first paint is not left a whole poll stale", async () => {
    const spy = vi.spyOn(global, "setInterval");
    vi.mocked(fetchOrgLive).mockResolvedValue(poll(row("a", "published", 1)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 0)]));
    // The server's first paint, before anything lands.
    expect(chips(island.tree())).toEqual({ a: "upcoming" });

    await vi.advanceTimersByTimeAsync(0);

    expect(fetchOrgLive).toHaveBeenCalledTimes(1);
    expect(fetchOrgLive).toHaveBeenCalledWith("riverside");
    expect(chips(island.tree())).toEqual({ a: "on-now" });
    // …and the interval is still armed, now at the in-play cadence.
    expect(spy.mock.calls.at(-1)?.[1]).toBe(HUB_POLL_MS);
  });

  it("an island unmounted before its mount fetch goes out never sends it", async () => {
    vi.mocked(fetchOrgLive).mockResolvedValue(poll(row("a", "published", 1)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 0)]));
    island.unmount();
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS);
    expect(fetchOrgLive).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("nothing in play: the interval is HUB_IDLE_POLL_MS; something in play: HUB_POLL_MS (positive pair)", () => {
    const spy = vi.spyOn(global, "setInterval");
    renderIsland(OrgLiveChips, props([comp("a", "published", 0), comp("b", "completed", 0)]));
    expect(spy.mock.calls.map(([, ms]) => ms)).toEqual([HUB_IDLE_POLL_MS]);

    spy.mockClear();
    renderIsland(OrgLiveChips, props([comp("a", "published", 0), comp("b", "published", 1)]));
    expect(spy.mock.calls.map(([, ms]) => ms)).toEqual([HUB_POLL_MS]);
    expect(HUB_POLL_MS, "premise: the two cadences differ").not.toBe(HUB_IDLE_POLL_MS);
  });

  it("a poll that flips in_play 0 → 1 re-renders the chip to ON NOW in place, and speeds the poll up", async () => {
    const spy = vi.spyOn(global, "setInterval");
    vi.mocked(fetchOrgLive).mockResolvedValue(poll(row("a", "published", 1), row("b", "published", 0)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 0), comp("b", "published", 0)]));
    expect(chips(island.tree())).toEqual({ a: "upcoming", b: "upcoming" });

    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS);

    expect(fetchOrgLive).toHaveBeenCalledWith("riverside");
    expect(chips(island.tree())).toEqual({ a: "on-now", b: "upcoming" });
    expect(chipText(island.tree(), "a")).toBe(liveNow(DICT, "one", 1));
    expect(spy.mock.calls.at(-1)?.[1]).toBe(HUB_POLL_MS);
  });

  it("…and the other direction: the match ends, in_play 1 → 0, the chip goes back and the poll slows down", async () => {
    const spy = vi.spyOn(global, "setInterval");
    vi.mocked(fetchOrgLive).mockResolvedValue(poll(row("a", "published", 0)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 1)]));
    expect(chips(island.tree())).toEqual({ a: "on-now" });

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);

    expect(chips(island.tree())).toEqual({ a: "upcoming" });
    expect(spy.mock.calls.at(-1)?.[1]).toBe(HUB_IDLE_POLL_MS);
  });

  it("the poll's STATUS moves the chip too (an organiser completes the competition)", async () => {
    vi.mocked(fetchOrgLive).mockResolvedValue(poll(row("a", "completed", 0)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 0)]));
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS);
    expect(chips(island.tree())).toEqual({ a: "finished" });
  });

  it("a competition the poll no longer returns is DROPPED (made private: its card stops pulsing); the ones it returns move", async () => {
    vi.mocked(fetchOrgLive).mockResolvedValue(poll(row("b", "published", 1)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 1), comp("b", "published", 0)]));
    expect(chips(island.tree())).toEqual({ a: "on-now", b: "upcoming" });
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(chips(island.tree())).toEqual({ b: "on-now" });
    // The whole card goes, not just its chip.
    const hrefs = island.tree().map((e) => propsOf(e).href).filter(Boolean);
    expect(hrefs).toEqual(["/shared/riverside/b-cup"]);
  });

  // Owner ruling 2026-09-17: the org home lists its competitions in three tiers
  // read off each card's chip — a match in play ("2 live now"), then "On now"
  // with nothing in play, then the rest — keeping the incoming order within a
  // tier. The island sorts with the same function the server does
  // (`sortOrgHomeCompetitions`), after every poll, so a competition that goes
  // live moves up on the same poll that lights its chip, whatever order the
  // poll's rows arrive in.
  it("the cards are drawn in three tiers after every poll — in play, then 'On now', then the rest — even when the poll lists them by date", async () => {
    const hrefs = (tree: ReactElement[]) =>
      tree.map((e) => propsOf(e).href).filter((h): h is string => typeof h === "string");
    vi.mocked(fetchOrgLive)
      // Date order, NOT tiered: c went live, b was marked live with nothing in play.
      .mockResolvedValueOnce(poll(row("a", "published", 0), row("b", "live", 0), row("c", "published", 1)))
      .mockResolvedValue(poll(row("a", "published", 0), row("b", "published", 0), row("c", "published", 0)));
    // First paint: the server's order (a newest; nothing live).
    const island = renderIsland(
      OrgLiveChips,
      props([comp("a", "published", 0), comp("b", "published", 0), comp("c", "published", 0)]),
    );
    expect(hrefs(island.tree())).toEqual(["/shared/riverside/a-cup", "/shared/riverside/b-cup", "/shared/riverside/c-cup"]);

    await vi.advanceTimersByTimeAsync(0);

    // c (in play, oldest) above b ("On now") above a (newest, idle) — the whole
    // card moves, its chip with it.
    expect(hrefs(island.tree())).toEqual(["/shared/riverside/c-cup", "/shared/riverside/b-cup", "/shared/riverside/a-cup"]);
    expect(chipText(island.tree(), "c")).toBe(liveNow(DICT, "one", 1));
    expect(chipText(island.tree(), "b")).toBe(t(DICT, "chip.onNow"));
    expect(Object.keys(chips(island.tree())), "the chips moved with their cards").toEqual(["c", "b", "a"]);

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);

    // Nothing live any more: one tier, the incoming (date) order.
    expect(hrefs(island.tree())).toEqual(["/shared/riverside/a-cup", "/shared/riverside/b-cup", "/shared/riverside/c-cup"]);
    expect(chips(island.tree())).toEqual({ a: "upcoming", b: "upcoming", c: "upcoming" });
  });

  it("the FIRST paint is drawn in three tiers too, before any poll lands", () => {
    vi.mocked(fetchOrgLive).mockReturnValue(new Promise(() => {}));
    const island = renderIsland(
      OrgLiveChips,
      props([comp("a", "published", 0), comp("b", "live", 0), comp("c", "draft", 2)]),
    );
    expect(Object.keys(chips(island.tree()))).toEqual(["c", "b", "a"]);
  });

  it("a poll naming a competition the page never rendered skips it (no name to draw) and keeps the poll's order for the rest", async () => {
    vi.mocked(fetchOrgLive).mockResolvedValue(
      poll(row("c", "published", 2), row("new", "published", 1), row("a", "published", 0)),
    );
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 0), comp("c", "published", 0)]));
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.keys(chips(island.tree()))).toEqual(["c", "a"]);
  });

  it("a poll that returns NOTHING keeps polling, so a competition made public again comes back", async () => {
    vi.mocked(fetchOrgLive)
      .mockResolvedValueOnce(poll())
      .mockResolvedValue(poll(row("a", "published", 0)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 0)]));
    await vi.advanceTimersByTimeAsync(0);
    expect(chips(island.tree())).toEqual({});

    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS);

    expect(fetchOrgLive).toHaveBeenCalledTimes(2);
    expect(chips(island.tree())).toEqual({ a: "upcoming" });
  });

  it.each([
    ["en", en],
    ["es", es],
  ] as const)(
    "%s: a poll that drops EVERY competition says the page's empty sentence — never a heading over nothing",
    async (locale, source) => {
      const dict = source as Dict;
      vi.mocked(fetchOrgLive).mockResolvedValue(poll());
      const island = renderIsland(
        OrgLiveChips,
        props([comp("a", "published", 1), comp("b", "completed", 0)], orgLiveDict(dict), locale),
      );
      // First paint: the server's cards, and no empty sentence.
      expect(textOf(island.tree()[0]!)).not.toContain(dict["empty"] as string);

      await vi.advanceTimersByTimeAsync(0);

      const tree = island.tree();
      expect(tree.filter((e) => e.type === "ul" || e.type === "li")).toHaveLength(0);
      expect(chips(tree)).toEqual({});
      const sentence = tree.filter((e) => e.type === "p");
      expect(sentence).toHaveLength(1);
      // The dictionary's own VALUE, read without the island's lookup.
      expect(textOf(sentence[0]!)).toBe(dict["empty"] as string);
      if (locale === "es") expect(dict["empty"], "premise: es is really translated").not.toBe(en["empty"]);
    },
  );

  it("a failed poll keeps the last chips (never throws to the UI)", async () => {
    vi.mocked(fetchOrgLive).mockRejectedValue(new Error("offline"));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 1)]));
    await expect(vi.advanceTimersByTimeAsync(HUB_POLL_MS)).resolves.not.toThrow();
    expect(fetchOrgLive).toHaveBeenCalledTimes(2);
    expect(chips(island.tree())).toEqual({ a: "on-now" });
  });

  it("unmount stops the poll: no fetch after the island is gone", async () => {
    vi.mocked(fetchOrgLive).mockResolvedValue(poll(row("a", "published", 1)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 1)]));
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    // One on mount, one on the tick.
    expect(fetchOrgLive).toHaveBeenCalledTimes(2);

    island.unmount();
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS * 3);
    expect(fetchOrgLive).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a poll that lands AFTER unmount changes nothing (no state set on a gone island)", async () => {
    let resolve!: (v: PublicOrgLiveT) => void;
    vi.mocked(fetchOrgLive).mockImplementation(() => new Promise((r) => (resolve = r)));
    const island = renderIsland(OrgLiveChips, props([comp("a", "published", 1)]));
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    island.unmount();
    resolve(poll(row("a", "completed", 0)));
    await vi.advanceTimersByTimeAsync(0);
    expect(chips(island.tree())).toEqual({ a: "on-now" });
  });
});
