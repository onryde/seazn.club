// Seazn-hosted video, Phase 1 Task 15 (recommendation 2026-11-21, G-B): what the match page's island SHOWS for each answer of the
// video route. `apps/web` vitest has no DOM, so this is the server markup (`renderToStaticMarkup`, `useEffect` never runs): the
// island is rendered with an `initial` answer, which goes through the SAME stage the polled answers do. The timer and the swap of a
// refreshed address are the next two files' (seazn-video-poll, seazn-playback); the one-element-across-a-refresh DOM fact is the
// e2e's (public-fixture.spec.ts).
//
//   - nothing to show (no answer yet, warming, ended with no recording signed yet): nothing at all;
//   - `live`: one player, labelled Live, and no picker, whatever recordings are listed beside it;
//   - no live and one `hls` part: one player and no picker; two or more: the picker "Part {n}" (the part's own number, which can
//     skip) in order, and still ONE player (the chosen part's);
//   - an `embed` part is the replay host's player (Task 25): this task renders no player for one;
//   - PostHog must never record a signed address: `ph-no-capture` on the `<video>` AND its wrapper, and the address appears only in
//     the one attribute the player reads it from (never as `src` before hydration, never in a label or a title).
// The shape of the answer comes from the route's own schema (`PublicFixtureVideo`), never typed twice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import publicEn from "@/dictionaries/en/public.json";
import publicEs from "@/dictionaries/es/public.json";
import publicFr from "@/dictionaries/fr/public.json";
import publicNl from "@/dictionaries/nl/public.json";
import { PublicFixtureVideo } from "@/server/api-v1/schemas";
import { SeaznVideoIsland, asPublicFixtureVideo, fetchSeaznVideo, nextPartIndex, playerKey, seaznVideoUrl } from "../seazn-video-island";
import { seaznVideoLabels } from "../seazn-video-labels";
import { renderIsland, type walk } from "@/components/__tests__/_hook-harness";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const labels = seaznVideoLabels(publicEn);
const signed = (name: string): { src: string; expiresAt: string } => ({
  src: `https://playback.fake.invalid/tok-${name}/manifest/video.m3u8`,
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
});
const part = (partNo: number, player: "hls" | "embed" = "hls") => ({ partNo, player, ...signed(`p${partNo}`) });
const answer = (v: { live?: ReturnType<typeof signed> | null; replay?: ReturnType<typeof part>[] }): PublicFixtureVideo =>
  PublicFixtureVideo.parse({ live: v.live ?? null, replay: v.replay ?? [] });
const html = (video: PublicFixtureVideo | null, l = labels): string =>
  renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={l} {...(video === null ? {} : { initial: video })} />);
const count = (s: string, re: RegExp): number => [...s.matchAll(re)].length;
const tabs = (s: string): string[] => [...s.matchAll(/<button [^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!);

afterEach(() => vi.unstubAllGlobals());

describe("the island: nothing to show", () => {
  it("EMPTY CASE FIRST: no answer yet, warming, and ended with no recording each render nothing at all", () => {
    expect(html(null)).toBe("");
    expect(html(answer({}))).toBe("");
  });

  it("a replay made only of the replay host's embeds renders nothing until Task 25 gives it a player", () => {
    expect(html(answer({ replay: [part(1, "embed"), part(2, "embed")] }))).toBe("");
  });
});

// Phase 1 visual pass D1 (CLS up to 0.094): the island used to draw nothing until its first read answered, then pushed the page down by
// the player's height. Where a player is expected (`reserve`: the fixture has a Seazn session, or Match Day's court is on air to Seazn),
// the server render now holds the player's own box: the same region, the same 16:9 frame with its 200 px floor, dark and empty, no
// spinner and no words. An answer with nothing to show collapses it (the island's design for "nothing": no box at all).
describe("review D1: the player's box is reserved from the server render", () => {
  const reserved = (extra: { initial?: PublicFixtureVideo } = {}) =>
    renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} reserve {...extra} />);
  const classOf = (out: string, testId: string): string => {
    const m = new RegExp(`data-testid="${testId}"[^>]*?class="([^"]*)"`).exec(out) ?? new RegExp(`class="([^"]*)"[^>]*?data-testid="${testId}"`).exec(out);
    if (!m) throw new Error(`no ${testId} in the markup — every probe on it would pass vacuously`);
    return m[1]!;
  };
  const tokens = (c: string) => c.split(/\s+/).filter(Boolean).sort();

  it("EMPTY CASE FIRST: not reserved, no answer yet renders nothing (the pre-kick-off page keeps no box)", () => {
    expect(html(null)).toBe("");
  });

  it("reserved, no answer yet: one empty dark box at the player's 16:9 with its 200 px floor, hidden from assistive tech, with no text", () => {
    const out = reserved();
    expect(count(out, /data-testid="seazn-video-reserved"/g), "one reserved box").toBe(1);
    const frame = tokens(classOf(out, "seazn-video-frame"));
    for (const c of ["aspect-video", "min-h-[200px]", "w-full", "bg-black"]) expect(frame, c).toContain(c);
    expect(out).toMatch(/data-testid="seazn-video-reserved"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-testid="seazn-video-reserved"/);
    expect(out.replace(/<[^>]*>/g, ""), "no spinner text, no words").toBe("");
    expect(out).not.toMatch(/<video\b|data-src=/);
  });

  it("the reserved box IS the player's box: the region and the frame carry exactly the classes the live player's do, so the swap moves nothing", () => {
    const box = reserved();
    const live = html(answer({ live: signed("live") }));
    expect(tokens(classOf(box, "seazn-video-reserved"))).toEqual(tokens(classOf(live, "seazn-video")));
    // The player's frame also carries `ph-no-capture` (the address is a credential); the reserved frame has no address to hide.
    expect(tokens(classOf(box, "seazn-video-frame"))).toEqual(tokens(classOf(live, "seazn-player")).filter((c) => c !== "ph-no-capture"));
  });

  it("an answer already in hand draws the player, never the reserved box", () => {
    const out = reserved({ initial: answer({ live: signed("live") }) });
    expect(out).not.toContain('data-testid="seazn-video-reserved"');
    expect(count(out, /data-testid="seazn-player"/g)).toBe(1);
  });

  it("mounted: the reserved box stands until the first read answers; an empty answer collapses it, a live one replaces it with the player", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const routeOf = (data: unknown) => vi.fn(async () => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } }));
    // The island's output is its stage ELEMENT; its server markup is what the box looks like at that moment.
    const ids = (island: { tree: () => ReturnType<typeof walk> }) =>
      [...renderToStaticMarkup(island.tree()[0]!).matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
    try {
      vi.stubGlobal("fetch", routeOf({ live: null, replay: [] }));
      const empty = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, reserve: true });
      expect(ids(empty), "before the first answer").toContain("seazn-video-reserved");
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(empty), "nothing to show: collapsed").toEqual([]);
      empty.unmount();
      vi.stubGlobal("fetch", routeOf({ live: signed("live"), replay: [] }));
      const live = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, reserve: true });
      expect(ids(live)).toContain("seazn-video-reserved");
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(live), "the player in the same place").toEqual(expect.arrayContaining(["seazn-video", "seazn-player"]));
      expect(ids(live)).not.toContain("seazn-video-reserved");
      live.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the island: live", () => {
  it("one player, labelled Live, carrying the live address, and no picker", () => {
    const live = signed("live");
    const out = html(answer({ live }));
    expect(count(out, /data-testid="seazn-video"/g), "one region").toBe(1);
    expect(count(out, /data-testid="seazn-player"/g), "one player").toBe(1);
    expect(count(out, /<video\b/g), "one <video>").toBe(1);
    expect(out).toContain(`data-src="${live.src}"`);
    expect(out).toContain(`>${labels.live}<`);
    expect(out).not.toContain('role="tab"');
    expect(out).not.toContain('role="tablist"');
  });

  it("recordings listed beside a live source are not played: the live player alone, no picker", () => {
    const live = signed("live");
    const out = html(answer({ live, replay: [part(1), part(2)] }));
    expect(count(out, /<video\b/g)).toBe(1);
    expect(out).toContain(`data-src="${live.src}"`);
    expect(out).not.toContain(part(1).src);
    expect(out).not.toContain('role="tab"');
  });
});

describe("the island: replay parts (the interim Cloudflare recording)", () => {
  it("one hls part: one player, the part's address, no picker and no 'Part 1' anywhere", () => {
    const out = html(answer({ replay: [part(1)] }));
    expect(count(out, /<video\b/g)).toBe(1);
    expect(out).toContain(`data-src="${part(1).src}"`);
    expect(out).not.toContain('role="tab"');
    expect(out).not.toMatch(/Part \d/);
    expect(out, "a replay is not labelled Live").not.toContain(`>${labels.live}<`);
  });

  it("two hls parts: the picker Part 1, Part 2 and ONE player, on Part 1", () => {
    const out = html(answer({ replay: [part(1), part(2)] }));
    expect(tabs(out)).toEqual(["Part 1", "Part 2"]);
    expect(count(out, /<video\b/g), "one player at a time").toBe(1);
    expect(out).toContain(`data-src="${part(1).src}"`);
    expect(out, "the other part's address is not on the page").not.toContain(part(2).src);
    expect(out).toMatch(/<button [^>]*role="tab"[^>]*aria-selected="true"[^>]*>Part 1<\/button>/);
    expect(out).toMatch(/<button [^>]*role="tab"[^>]*aria-selected="false"[^>]*>Part 2<\/button>/);
  });

  it("parts arrive in any order and with gaps in their numbers: the picker follows partNo and names the part's own number", () => {
    const out = html(answer({ replay: [part(4), part(1), part(3)] }));
    expect(tabs(out), "ordered by partNo, labelled by it (a gap is a part that aged out)").toEqual(["Part 1", "Part 3", "Part 4"]);
    expect(out).toContain(`data-src="${part(1).src}"`);
  });

  it("a part whose number is not 1 plays alone without a picker (the first part aged out)", () => {
    const out = html(answer({ replay: [part(3)] }));
    expect(tabs(out)).toEqual([]);
    expect(out).toContain(`data-src="${part(3).src}"`);
  });

  it("an embed part beside hls parts is not a player and not a tab", () => {
    const out = html(answer({ replay: [part(1, "embed"), part(2), part(3)] }));
    expect(tabs(out)).toEqual(["Part 2", "Part 3"]);
    expect(count(out, /<video\b/g)).toBe(1);
    expect(out).not.toContain(part(1).src);
    expect(html(answer({ replay: [part(1, "embed"), part(2)] })), "one hls part left: no picker").not.toContain('role="tab"');
  });
});

describe("the island: a signed address never reaches a recording", () => {
  const cases: [string, PublicFixtureVideo][] = [
    ["live", answer({ live: signed("live") })],
    ["one part", answer({ replay: [part(1)] })],
    ["two parts", answer({ replay: [part(1), part(2)] })],
  ];
  it.each(cases)("%s: ph-no-capture on the <video>, its wrapper and the region, and the address only in data-src", (_name, video) => {
    const out = html(video);
    const videoTag = /<video\b[^>]*>/.exec(out)?.[0] ?? "";
    const wrapper = /<div\b[^>]*data-testid="seazn-player"[^>]*>/.exec(out)?.[0] ?? "";
    expect(videoTag, "premise: the <video> is found").not.toBe("");
    expect(wrapper, "premise: the wrapper is found").not.toBe("");
    const region = /<section\b[^>]*data-testid="seazn-video"[^>]*>/.exec(out)?.[0] ?? "";
    expect(region, "premise: the region is found").not.toBe("");
    expect(videoTag).toMatch(/class="[^"]*\bph-no-capture\b/);
    expect(wrapper).toMatch(/class="[^"]*\bph-no-capture\b/);
    expect(region, "the whole region too (a picker's labels and the chip sit in it)").toMatch(/class="[^"]*\bph-no-capture\b/);
    expect(videoTag, "no src before hydration: the controller sets it").not.toMatch(/\ssrc=/);
    const shown = (video.live ?? video.replay[0]!).src;
    const token = /tok-[a-z0-9]+/.exec(shown)![0];
    expect(count(out, new RegExp(token, "g")), "the token appears once: in data-src").toBe(1);
    expect(out).toContain(`data-src="${shown}"`);
  });

  it("the player is a native control surface a phone can use: controls, inline playback, no media fetched until play", () => {
    const videoTag = /<video\b[^>]*>/.exec(html(answer({ live: signed("live") })))![0];
    expect(videoTag).toContain("controls");
    expect(videoTag).toMatch(/playsinline/i);
    expect(videoTag).toContain('preload="none"');
    expect(videoTag, "an accessible name").toContain(`aria-label="${labels.live}"`);
  });
});

describe("seaznVideoLabels: the page's own strings, in every locale", () => {
  const dicts = { en: publicEn, es: publicEs, fr: publicFr, nl: publicNl } as const;
  it.each(Object.entries(dicts))("%s: each label is that locale's own string and no raw key", (_loc, dict) => {
    const l = seaznVideoLabels(dict as Record<string, unknown>);
    expect(l.live).toBe(dict["seaznVideo.live"]);
    expect(l.unavailable).toBe(dict["seaznVideo.unavailable"]);
    expect(l.part).toBe(dict["seaznVideo.part"]);
    expect(l.replay).toBe(dict["overlay.replay"]);
    for (const v of Object.values(l)) expect(v, "never a bare dictionary key").not.toMatch(/^seaznVideo\.|^overlay\./);
    expect(l.part, "the part template keeps its {n}").toContain("{n}");
  });

  it("the picker renders the part template of the locale it is given", () => {
    const out = html(answer({ replay: [part(1), part(2)] }), seaznVideoLabels(publicNl));
    expect(tabs(out)).toEqual(["Deel 1", "Deel 2"]);
  });
});

describe("the route: URL, the read, and a guard on what comes back", () => {
  it("reads the public route by default and the organiser's with endpoint=org, the id encoded", () => {
    expect(seaznVideoUrl("abc", "public")).toBe("/api/v1/public/fixtures/abc/video");
    expect(seaznVideoUrl("abc", "org")).toBe("/api/v1/fixtures/abc/video");
    expect(seaznVideoUrl("a/b c", "public")).toBe("/api/v1/public/fixtures/a%2Fb%20c/video");
  });

  it("fetchSeaznVideo reads the envelope's data, never from the browser's cache, and aborts with the loop's signal", async () => {
    const body = answer({ live: signed("live"), replay: [part(1)] });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: body }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const ctl = new AbortController();
    const got = await fetchSeaznVideo("f1", "public", ctl.signal);
    expect(got).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/public/fixtures/f1/video");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBe(ctl.signal);
  });

  it("a refused read rejects (the loop keeps the last answer and tries again)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "slow down" }), { status: 429 })));
    await expect(fetchSeaznVideo("f1", "public", new AbortController().signal)).rejects.toThrow();
  });

  it("an answer that is not the route's shape rejects instead of reaching the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { live: "yes" } }), { status: 200 })));
    await expect(fetchSeaznVideo("f1", "public", new AbortController().signal)).rejects.toThrow(/video/);
  });

  describe("asPublicFixtureVideo", () => {
    const valid = answer({ live: signed("live"), replay: [part(2), part(5, "embed")] });
    it("accepts the answers the route's schema accepts (a live with parts, and the empty answer) and hands them back as they came", () => {
      for (const ok of [valid, { live: null, replay: [] }]) {
        expect(PublicFixtureVideo.safeParse(ok).success, "premise: the route's schema accepts it").toBe(true);
        expect(asPublicFixtureVideo(ok)).toEqual(ok);
      }
    });

    const bad: [string, unknown][] = [
      ["null", null],
      ["a string", "x"],
      ["no replay", { live: null }],
      ["no live", { replay: [] }],
      ["replay not an array", { live: null, replay: {} }],
      ["live without a src", { live: { expiresAt: "2026-11-21T13:00:00.000Z" }, replay: [] }],
      ["live src not a string", { live: { src: 1, expiresAt: "2026-11-21T13:00:00.000Z" }, replay: [] }],
      ["live without an expiry", { live: { src: "https://h.invalid/t/m.m3u8" }, replay: [] }],
      ["a part with an unknown player", { live: null, replay: [{ ...part(1), player: "flash" }] }],
      ["a part number 0", { live: null, replay: [{ ...part(1), partNo: 0 }] }],
      ["a part number 1.5", { live: null, replay: [{ ...part(1), partNo: 1.5 }] }],
      ["a part with no src", { live: null, replay: [{ partNo: 1, player: "hls", expiresAt: "2026-11-21T13:00:00.000Z" }] }],
    ];
    it.each(bad)("rejects %s", (_name, value) => {
      expect(() => asPublicFixtureVideo(value)).toThrow(/video/);
    });
    it("the guard and the route's own schema agree on every case above (anti-vacuity: all checked)", () => {
      let checked = 0;
      for (const [, value] of bad) {
        expect(PublicFixtureVideo.safeParse(value).success, "the schema refuses it too").toBe(false);
        checked++;
      }
      expect(checked).toBe(bad.length);
      expect(checked).toBeGreaterThanOrEqual(12);
    });
  });
});

describe("nextPartIndex: the picker's arrow keys (a tablist)", () => {
  it.each([
    ["ArrowRight", 0, 3, 1],
    ["ArrowRight", 2, 3, 0],
    ["ArrowLeft", 1, 3, 0],
    ["ArrowLeft", 0, 3, 2],
    ["Home", 2, 3, 0],
    ["End", 0, 3, 2],
  ] as const)("%s from %i of %i parts goes to %i", (key, from, n, to) => {
    expect(nextPartIndex(key, from, n)).toBe(to);
  });
  it("any other key moves nothing", () => {
    expect(nextPartIndex("Enter", 1, 3)).toBeNull();
    expect(nextPartIndex("a", 0, 3)).toBeNull();
  });
});

// A player is identified by its part and its epoch (how many times a player that gave up has been rebuilt). The wiring that bumps the
// epoch on the poll's `rebuild` answer is the e2e's (a node render cannot run an effect); what is pinned here is the identity itself:
// a token refresh (same part, same epoch) MUST be the same key (React keeps the element, so the picture runs on), and anything that is
// to give the viewer a fresh player MUST be a different one.
describe("playerKey: what keeps a player across a token refresh and rebuilds it otherwise", () => {
  it("is the same for the same part and epoch, so a refreshed address keeps its element", () => {
    expect(playerKey("live", 0)).toBe(playerKey("live", 0));
    expect(playerKey(2, 3)).toBe(playerKey(2, 3));
  });
  it("differs by epoch (a rebuild), by part (a different recording) and between the live and any part", () => {
    const keys = [playerKey("live", 0), playerKey("live", 1), playerKey(1, 0), playerKey(1, 1), playerKey(2, 0), playerKey(12, 0), playerKey(1, 20), playerKey(120, 0)];
    expect(new Set(keys).size, "every identity is its own key (no part/epoch pair can collide)").toBe(keys.length);
    expect(keys.length, "anti-vacuity").toBeGreaterThanOrEqual(8);
  });
});

// Phase 1 review I2, at the island itself: the page's `settledAt` and the document's visibility reach the loop. `renderIsland` (the
// workspace's hook harness) runs the island's mount effect, so its REAL `startVideoPoll` reads the (stubbed) route on vitest's fake
// clock. The loop's own rules are seazn-video-poll.test.ts's; this pins only the wiring the static markup above cannot see.
describe("review I2: the mounted island's loop", () => {
  const MIN = 60_000;
  const emptyRoute = () => vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { live: null, replay: [] } }), { status: 200, headers: { "content-type": "application/json" } }));
  const mount = (settledAt?: string | null) => renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, ...(settledAt === undefined ? {} : { settledAt }) });

  it("EMPTY CASE FIRST: no settledAt — empty answers keep being read (backing off); a settledAt already past stops the island after the one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const open = emptyRoute();
      vi.stubGlobal("fetch", open);
      const a = mount();
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(open.mock.calls.length, "not settled: read on, backing off (at 0 and 30 s, then every 60 s)").toBe(2 + Math.floor((30 * MIN - 30_000) / 60_000));
      a.unmount();
      const settled = emptyRoute();
      vi.stubGlobal("fetch", settled);
      const b = mount(new Date(NOW - MIN).toISOString());
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(settled.mock.calls, "settled: the one read, then nothing").toHaveLength(1);
      b.unmount();
      const notYet = emptyRoute();
      vi.stubGlobal("fetch", notYet);
      const c = mount(new Date(Date.now() + 10 * MIN).toISOString());
      await vi.advanceTimersByTimeAsync(30 * MIN);
      // 0, 30, 90, 150, ... 570 s before the settle instant (10 min on): 11 reads; the read at 630 s is past it and stops the loop.
      expect(notYet.mock.calls, "settles 10 min on: reads until then, and the first empty answer past it is the last").toHaveLength(12);
      c.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("review N1: the page's kick-off and active hints reach the loop — kick-off in 10 min, or active for an hour, holds the 30 s floor; neither backs off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const readsOver5Min = async (hints: Record<string, string | null>) => {
        const route = emptyRoute();
        vi.stubGlobal("fetch", route);
        const island = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, ...hints });
        await vi.advanceTimersByTimeAsync(5 * MIN);
        island.unmount();
        return route.mock.calls.length;
      };
      expect(await readsOver5Min({}), "EMPTY CASE FIRST: no hints — at 0 and 30 s, then every 60 s").toBe(2 + Math.floor((5 * MIN - 30_000) / 60_000));
      expect(await readsOver5Min({ kickoffAt: new Date(NOW + 10 * MIN).toISOString() }), "kick-off in 10 min: every 30 s").toBe(11);
      expect(await readsOver5Min({ activeUntil: new Date(NOW + 60 * MIN).toISOString() }), "active for an hour: every 30 s").toBe(11);
      expect(await readsOver5Min({ kickoffAt: "not a date", activeUntil: null }), "a kick-off that is not a date is cold").toBe(2 + Math.floor((5 * MIN - 30_000) / 60_000));
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hidden document: the mounted island reads nothing until the page is shown, and unmounting lets go of the document", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const doc = Object.assign(new EventTarget(), { hidden: true });
      const removed = vi.spyOn(doc, "removeEventListener");
      vi.stubGlobal("document", doc);
      const route = emptyRoute();
      vi.stubGlobal("fetch", route);
      const island = mount();
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(route.mock.calls, "hidden: nothing read").toHaveLength(0);
      doc.hidden = false;
      doc.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(route.mock.calls, "shown: read at once").toHaveLength(1);
      island.unmount();
      expect(removed.mock.calls.map(([type]) => type), "the listener goes with the island").toEqual(["visibilitychange"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
