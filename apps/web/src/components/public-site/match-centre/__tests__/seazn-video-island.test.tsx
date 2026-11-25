// Seazn-hosted video, Phase 1 Task 15 (recommendation 2026-11-21, G-B): what the match page's island SHOWS for each answer of the
// video route. `apps/web` vitest has no DOM, so this is the server markup (`renderToStaticMarkup`, `useEffect` never runs): the
// island is rendered with an `initial` answer, which goes through the SAME stage the polled answers do. The timer and the swap of a
// refreshed address are the next two files' (seazn-video-poll, seazn-playback); the one-element-across-a-refresh DOM fact is the
// e2e's (public-fixture.spec.ts).
//
//   - nothing to show (no answer yet, warming, ended with no recording signed yet): nothing at all, EXCEPT where the page says a wait
//     is on (a session warming, or just stopped with its recording not locked yet): then the player's own box holds, with one quiet
//     line, until a player arrives or the wait runs out (re-capture R2, the describes below);
//   - `live`: one player, labelled Live, and no picker, whatever recordings are listed beside it;
//   - no live and one `hls` part: one player and no picker; two or more: the picker "Part {n}" (the part's own number, which can
//     skip) in order, and still ONE player (the chosen part's);
//   - an `embed` part is the replay host's player (Task 25): an <iframe> (seazn-replay-frame.tsx), never a <video>; hls and embed parts
//     share ONE picker in partNo order and ONE player at a time, each of its own kind;
//   - PostHog must never record a signed address: `ph-no-capture` on the `<video>` AND its wrapper, and the address appears only in
//     the one attribute the player reads it from (never as `src` before hydration, never in a label or a title).
// The shape of the answer comes from the route's own schema (`PublicFixtureVideo`), never typed twice.
import { afterEach, describe, expect, it, vi } from "vitest";

// Task 25 (coordinator's addition), sent as a beacon since Task 25b: the island's failure reports go to our server's client-report route
// through `navigator.sendBeacon`, recorded here (`beaconsSent`) for the tests that mount an island.
const beacons = vi.hoisted(() => ({ sent: [] as { url: string; body: unknown }[] }));
const beaconsSent = () => {
  beacons.sent.length = 0;
  vi.stubGlobal("navigator", { sendBeacon: (url: string, body: string) => (beacons.sent.push({ url, body: JSON.parse(body) }), true) });
};
import { renderToStaticMarkup } from "react-dom/server";
import publicEn from "@/dictionaries/en/public.json";
import publicEs from "@/dictionaries/es/public.json";
import publicFr from "@/dictionaries/fr/public.json";
import publicNl from "@/dictionaries/nl/public.json";
import { PublicFixtureVideo, StreamSessionState } from "@/server/api-v1/schemas";
import { ReplayParts, SeaznVideoIsland, SeaznVideoStage, asPublicFixtureVideo, fetchSeaznVideo, nextPartIndex, playerKey, seaznVideoUrl } from "../seazn-video-island";
import { SeaznPlayer } from "../seazn-player";
import { SeaznReplayFrame } from "../seazn-replay-frame";
import { seaznVideoLabels } from "../seazn-video-labels";
import { SEAZN_VIDEO_HOLD_MS } from "../seazn-video-hold";
import { FINALISATION_GRACE_SECONDS, HOLD_SLACK_SECONDS, INGEST_TIMEOUT_SECONDS, RUNNER_STOP_GRACE_SECONDS, SEAZN_LIVE_DELAY_SECONDS, STREAM_TICK_PERIOD_SECONDS } from "@/server/relay/config";
import { SEAZN_VIDEO_POLL_CEILING_MS, SEAZN_VIDEO_POLL_FLOOR_MS } from "../seazn-video-schedule";
import { renderIsland, type walk } from "@/components/__tests__/_hook-harness";
import type { PlayerFatal } from "../seazn-video-report";
import { CLIENT_REPORTS_PATH } from "@/lib/client-reports";

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

// Owner 2026-11-23 (stg live test): a viewer at the court sees the score move before the picture does. Under the LIVE Seazn player only,
// one quiet line says by how much. It is keyed on the VIDEO being live (the answer's `live`), never on the match's status: no line for a
// replay, for the held box before the start, or after the stream ends. Words revised 2026-11-24 (T33c review m6, recommendation
// applied): "court" is wrong for a pitch or a board, so the line says "the live action", in every sport and every locale.
const OWNER_DELAY_LINE = "Video runs about 15–20 seconds behind the live action."; // the owner's words, verbatim
/** A playing-surface word in any of the four locales: the line must not name one (a pitch, a court, a board). */
const SURFACE_WORD = /\b(court|pitch|board|field|pista|cancha|campo|terrain|plateau|veld|baan|bord)\b/i;
/** The markup's text, its entities decoded (French "l'action" is serialised `l&#x27;action`). */
const unescapeHtml = (s: string): string =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The VISIBLE delay line's text, one entry per line drawn (the held row, `seazn-video-delay-reserved`, is not one). */
const delayLines = (out: string): string[] => [...out.matchAll(/<p data-testid="seazn-video-delay"[^>]*>(.*?)<\/p>/g)].map((m) => unescapeHtml(m[1]!));
const delayFor = (template: string): string =>
  template.replace("{min}", String(SEAZN_LIVE_DELAY_SECONDS.min)).replace("{max}", String(SEAZN_LIVE_DELAY_SECONDS.max));

// Task 33f (owner 'Ok', 2026-11-24): the held box's one quiet line said "The video will appear here shortly" for two different waits.
// It now says which video is coming. The owner's words, verbatim, typed here and never read back from the labels under test.
const OWNER_LIVE_LINE = "The live video will start here shortly";
const OWNER_REPLAY_LINE = "The replay will be ready here in a few minutes";
/** The held box's status line(s): one entry per `role="status"` line drawn, its text decoded. */
const statusLines = (out: string): string[] => [...out.matchAll(/<p [^>]*role="status"[^>]*>(.*?)<\/p>/g)].map((m) => unescapeHtml(m[1]!));

describe("owner 11-23: the delay line, under the LIVE player only", () => {
  it("EMPTY CASE FIRST: no answer, an empty answer, and the reserved box carry no line", () => {
    expect(html(null)).toBe("");
    expect(html(answer({}))).toBe("");
    const reserved = renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} reserve />);
    expect(reserved, "premise: the reserved box is drawn").toContain("seazn-video-reserved");
    expect(reserved).not.toContain("seazn-video-delay");
  });

  it("live: ONE line, under the player and inside the live region, in the owner's words, its numbers from the one constant", () => {
    expect(SEAZN_LIVE_DELAY_SECONDS, "the owner's numbers").toEqual({ min: 15, max: 20 });
    const out = html(answer({ live: signed("live") }));
    expect(delayLines(out)).toEqual([OWNER_DELAY_LINE]);
    const region = /<section data-testid="seazn-video"[^>]*>(.*)<\/section>/.exec(out)![1]!;
    expect(region.indexOf('data-testid="seazn-player"'), "premise: the player is in the region").toBeGreaterThanOrEqual(0);
    expect(region.indexOf('data-testid="seazn-video-delay"'), "under the player, in the same region").toBeGreaterThan(region.indexOf('data-testid="seazn-player"'));
    const line = /<p data-testid="seazn-video-delay"([^>]*)>/.exec(out)![1]!;
    expect(line, "readable: never hidden from assistive tech").not.toContain("aria-hidden");
    expect(line.split(/[\s"]/), "and never invisible").not.toContain("invisible");
    const player = /<div data-testid="seazn-player"[^>]*>(.*?)<\/div>/.exec(out);
    expect(player?.[1], "premise: the player's box, with its <video>").toMatch(/<video\b/);
    expect(player![1], "the line is not drawn over the picture").not.toContain("seazn-video-delay");
  });

  it("live with recordings listed beside it: still the live player, so still the line", () => {
    expect(delayLines(html(answer({ live: signed("live"), replay: [part(1), part(2)] })))).toEqual([OWNER_DELAY_LINE]);
  });

  it("a REPLAY never has it: one hls part, two parts, an embed part, and embed with hls", () => {
    const replays = [[part(1)], [part(1), part(2)], [part(1, "embed")], [part(1, "embed"), part(2)]];
    let checked = 0;
    for (const replay of replays) {
      const out = html(answer({ replay }));
      expect(out, `premise ${checked}: a player is drawn`).toMatch(/seazn-player|<iframe\b/);
      expect(out, `replay ${checked}`).not.toContain("seazn-video-delay");
      checked++;
    }
    expect(checked, "anti-vacuity: every replay shape").toBe(replays.length);
  });

  it("the held box (a wait: warming, or just stopped) never shows it, whatever the plan expects next", () => {
    const until = new Date(NOW + 10 * 60_000).toISOString();
    let checked = 0;
    for (const liveExpected of [false, true]) {
      const out = renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} reserve holdUntil={until} liveExpected={liveExpected} />);
      expect(out, `liveExpected ${liveExpected}: premise, the starting box`).toContain('data-testid="seazn-video-starting"');
      expect(delayLines(out), `liveExpected ${liveExpected}: no visible line`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("every locale says its own line, with the numbers filled in (never the English, never a key, never a bare {min})", () => {
    const dicts = { en: publicEn, es: publicEs, fr: publicFr, nl: publicNl } as const;
    let checked = 0;
    for (const [loc, dict] of Object.entries(dicts)) {
      const template = (dict as Record<string, string>)["seaznVideo.delay"];
      expect(template, `${loc}: premise, the key exists`).toEqual(expect.any(String));
      expect(template, `${loc}: the template keeps both numbers`).toMatch(/\{min\}[^]*\{max\}/);
      const lines = delayLines(html(answer({ live: signed("live") }), seaznVideoLabels(dict as Record<string, unknown>)));
      expect(lines, loc).toEqual([delayFor(template!)]);
      expect(lines[0], loc).not.toMatch(/\{|seaznVideo\./);
      if (loc !== "en") expect(lines[0], `${loc} is not the English`).not.toBe(OWNER_DELAY_LINE);
      expect(template, `${loc}: m6, the line names no playing surface (it reads for football, cricket and chess too)`).not.toMatch(SURFACE_WORD);
      checked++;
    }
    expect(checked, "anti-vacuity: the four locales").toBe(4);
  });
});

// The CLS half (Phase 1 D1/R1/R2: a player's arrival moves nothing; e2e/public-fixture.spec.ts "warming turns live" pins a zero shift):
// the line adds a row under the live player. So where the page expects a LIVE to come next (`liveExpected`: the fixture's Seazn session
// warming or live as the page was drawn), the box it holds keeps that row's place, invisible and silent, holding the very sentence so it
// wraps exactly as the line will at every width and in every locale. Where a RECORDING comes next (a stop) it does not, so the
// recording still lands with no shift (R1/R2 unchanged); and once a player has been on screen the box no longer holds it, so the line
// is gone the moment the stream ends.
describe("the delay line's place is held where a live comes next", () => {
  const until = new Date(NOW + 10 * 60_000).toISOString();
  const draw = (props: Record<string, unknown>) => renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} {...props} />);
  const slotOf = (out: string): { attrs: string; text: string } | null => {
    const m = /<p data-testid="seazn-video-delay-reserved"([^>]*)>(.*?)<\/p>/.exec(out);
    return m ? { attrs: m[1]!, text: m[2]! } : null;
  };
  const classesOf = (attrs: string): string[] => (/class="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/).filter(Boolean).sort();

  it("EMPTY CASE FIRST: without liveExpected neither box holds it — D1's reserved box stays wordless, R2's starting box keeps its one line (the replay's, T33f)", () => {
    const reserved = draw({ reserve: true });
    expect(reserved).toContain("seazn-video-reserved");
    expect(slotOf(reserved)).toBeNull();
    expect(reserved.replace(/<[^>]*>/g, ""), "no words").toBe("");
    const starting = draw({ reserve: true, holdUntil: until });
    expect(slotOf(starting)).toBeNull();
    expect(starting.replace(/<[^>]*>/g, "")).toBe(OWNER_REPLAY_LINE);
  });

  it("liveExpected: the reserved box and the starting box each hold the row — invisible, aria-hidden, the live line's own text and classes", () => {
    const live = html(answer({ live: signed("live") }));
    const lineAttrs = /<p data-testid="seazn-video-delay"([^>]*)>/.exec(live)![1]!;
    let checked = 0;
    for (const [name, props] of [["reserved", { reserve: true }], ["starting", { reserve: true, holdUntil: until }], ["starting, no reserve", { holdUntil: until }]] as const) {
      const out = draw({ ...props, liveExpected: true });
      const slot = slotOf(out);
      expect(slot, `${name}: the row is held`).not.toBeNull();
      expect(slot!.attrs, name).toContain('aria-hidden="true"');
      expect(slot!.text, `${name}: the very sentence, so it wraps as the line will`).toBe(OWNER_DELAY_LINE);
      expect(classesOf(slot!.attrs), `${name}: the line's classes, plus invisible`).toEqual([...classesOf(lineAttrs), "invisible"].sort());
      expect(out.indexOf("seazn-video-delay-reserved"), `${name}: under the frame`).toBeGreaterThan(out.indexOf('data-testid="seazn-video-frame"'));
      expect(delayLines(out), `${name}: and nothing visible`).toEqual([]);
      checked++;
    }
    expect(checked).toBe(3);
    expect(draw({ liveExpected: true }), "no box (no reserve, no wait): no row either").toBe("");
  });

  it("an answer in hand wins: liveExpected with a live answer draws the line (no held row); with a replay answer, neither", () => {
    const live = draw({ reserve: true, liveExpected: true, initial: answer({ live: signed("live") }) });
    expect(delayLines(live)).toEqual([OWNER_DELAY_LINE]);
    expect(live).not.toContain("seazn-video-delay-reserved");
    const replay = draw({ reserve: true, liveExpected: true, initial: answer({ replay: [part(1)] }) });
    expect(replay).not.toContain("seazn-video-delay");
  });

  it("mounted, warming → live → stop → recording: the held row becomes the line, the line is gone at the stop, and the recording lands with neither", async () => {
    const MIN = 60_000;
    const EMPTY = { live: null, replay: [] };
    const answers: object[] = [EMPTY, { live: signed("live"), replay: [] }, EMPTY, { live: null, replay: [part(1)] }];
    let i = 0;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: answers[Math.min(i++, answers.length - 1)] }), { status: 200, headers: { "content-type": "application/json" } })));
      const island = renderIsland(SeaznVideoIsland, {
        fixtureId: "f1", labels, reserve: true, liveExpected: true, holdUntil: new Date(NOW + 10 * MIN).toISOString(), activeUntil: new Date(NOW + 60 * MIN).toISOString(),
      });
      const now = () => renderToStaticMarkup(island.tree()[0]!);
      const seen: string[] = [];
      // T33f: the held box's one status line says WHICH video is coming — the live one while warming, the replay once it has stopped.
      const look = (step: string, want: { row: boolean; line: boolean; box: string; status: string | null }) => {
        const out = now();
        expect(out, `${step}: premise, ${want.box}`).toContain(`data-testid="${want.box}"`);
        expect(slotOf(out) !== null, `${step}: the held row`).toBe(want.row);
        expect(delayLines(out).length, `${step}: the visible line`).toBe(want.line ? 1 : 0);
        expect(statusLines(out), `${step}: the held box's line`).toEqual(want.status === null ? [] : [want.status]);
        seen.push(step);
      };
      look("server markup (warming)", { row: true, line: false, box: "seazn-video-starting", status: OWNER_LIVE_LINE });
      await vi.advanceTimersByTimeAsync(0);
      look("read 1: still warming", { row: true, line: false, box: "seazn-video-starting", status: OWNER_LIVE_LINE });
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      look("read 2: live", { row: false, line: true, box: "seazn-player", status: null });
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      look("read 3: stopped, the box holds", { row: false, line: false, box: "seazn-video-starting", status: OWNER_REPLAY_LINE });
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      look("read 4: the recording", { row: false, line: false, box: "seazn-player", status: null });
      expect(seen, "anti-vacuity: every step was looked at").toHaveLength(5);
      expect(i, "premise: the route was read four times").toBeGreaterThanOrEqual(4);
      island.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

// Task 33f (owner 'Ok', 2026-11-24): the held box knows which wait it is in (`liveNext`: the page's `liveExpected` at first, cleared for
// good once a player has been on screen, Task 33c). A LIVE on its way up (the session warming) or a REPLAY being prepared (the stream
// stopped, its recording not locked yet). Its one status line now says which. Every shape that draws the held box picks exactly one of
// the two lines; every other shape draws neither.
describe("Task 33f: the held box says whether the live video or the replay is coming", () => {
  const MIN = 60_000;
  const until = new Date(NOW + 10 * MIN).toISOString();
  const EMPTY = { live: null, replay: [] };
  const draw = (props: Record<string, unknown>) => renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} {...props} />);
  const statusTags = (out: string): string[] => [...out.matchAll(/<p [^>]*role="status"[^>]*>/g)].map((m) => m[0]);
  const shapes = () => {
    const out: { reserve: boolean; liveExpected: boolean; initial?: PublicFixtureVideo }[] = [];
    for (const reserve of [false, true]) for (const liveExpected of [false, true]) for (const initial of [undefined, answer({})]) out.push({ reserve, liveExpected, ...(initial ? { initial } : {}) });
    return out;
  };
  const nameOf = (s: { reserve: boolean; liveExpected: boolean; initial?: unknown }) =>
    `reserve ${s.reserve}, liveExpected ${s.liveExpected}, ${s.initial ? "after an empty answer" : "before any answer"}`;

  it("EMPTY CASE FIRST: no wait, no line — every shape of the island without one (reserved box or nothing; a live expected or not; before or after an empty answer) says neither", () => {
    let checked = 0;
    for (const s of shapes()) {
      const out = draw(s);
      expect(statusLines(out), nameOf(s)).toEqual([]);
      expect(out, nameOf(s)).not.toContain(OWNER_LIVE_LINE);
      expect(out, nameOf(s)).not.toContain(OWNER_REPLAY_LINE);
      checked++;
    }
    expect(checked, "anti-vacuity: 2 × 2 × 2 shapes").toBe(8);
  });

  it("SWEEP every shape of the held box the page can draw (a wait on): exactly ONE line — the live one where a live comes next, the replay one otherwise", () => {
    let live = 0;
    let replay = 0;
    for (const s of shapes()) {
      const out = draw({ ...s, holdUntil: until });
      expect(out, `${nameOf(s)}: premise, the held box`).toContain('data-testid="seazn-video-starting"');
      expect(statusLines(out), nameOf(s)).toEqual([s.liveExpected ? OWNER_LIVE_LINE : OWNER_REPLAY_LINE]);
      expect(out, `${nameOf(s)}: and never the other`).not.toContain(s.liveExpected ? OWNER_REPLAY_LINE : OWNER_LIVE_LINE);
      expect(out, `${nameOf(s)}: nor the retired line`).not.toContain("The video will appear here shortly");
      if (s.liveExpected) live++;
      else replay++;
    }
    expect([live, replay], "anti-vacuity: four shapes each way").toEqual([4, 4]);
  });

  it("both lines are the SAME status element, absolutely inside the player's frame, in the same box: whichever is drawn moves nothing (that each FITS the frame at 320 is the browser's, e2e/public-fixture.spec.ts)", () => {
    const liveOut = draw({ reserve: true, holdUntil: until, liveExpected: true });
    const replayOut = draw({ reserve: true, holdUntil: until });
    const [liveTag] = statusTags(liveOut);
    const [replayTag] = statusTags(replayOut);
    expect(liveTag && replayTag, "premise: both lines are drawn").toBeTruthy();
    expect(liveTag, "one element, one class set, for either line").toBe(replayTag);
    expect(/class="([^"]*)"/.exec(liveTag!)![1]!.split(/\s+/), "laid over the frame, not in the flow").toEqual(expect.arrayContaining(["absolute", "inset-0"]));
    for (const [name, out] of [["live", liveOut], ["replay", replayOut]] as const) {
      expect(out, `${name}: the line is the frame's own child`).toMatch(/<div data-testid="seazn-video-frame"[^>]*><p [^>]*role="status"/);
    }
    // Outside the line itself, the two boxes differ only by the live's invisible delay row (Task 33c), which a replay never holds.
    const strip = (out: string) => out.replace(OWNER_LIVE_LINE, "").replace(OWNER_REPLAY_LINE, "").replace(/<p data-testid="seazn-video-delay-reserved"[^>]*>.*?<\/p>/, "");
    expect(liveOut, "premise: the live box holds the delay row").toContain("seazn-video-delay-reserved");
    expect(strip(liveOut), "the same box, element for element").toBe(strip(replayOut));
  });

  /** A mounted island on fake timers whose route answers `answers` in turn. `nextRead` lets the island take its NEXT answer, whatever the
   *  schedule's delay: the k-th call waits (in 1 s steps) until the route has been asked k times, then lets the answer land. The first
   *  read is asked at mount, so the first call only lets it land. */
  async function mounted(props: Record<string, unknown>, answers: object[], body: (now: () => string, nextRead: () => Promise<void>) => Promise<void>) {
    let i = 0;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, data: answers[Math.min(i++, answers.length - 1)] }), { status: 200, headers: { "content-type": "application/json" } })));
      const island = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, ...props } as Parameters<typeof SeaznVideoIsland>[0]);
      let want = 0;
      const nextRead = async () => {
        want++;
        for (let ms = 0; i < want && ms <= 4 * SEAZN_VIDEO_POLL_CEILING_MS; ms += 1_000) await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(0);
        expect(i, "premise: the island has asked the route exactly this many times").toBe(want);
      };
      await body(() => renderToStaticMarkup(island.tree()[0]!), nextRead);
      expect(i, "premise: every answer was read").toBe(answers.length);
      island.unmount();
    } finally {
      vi.useRealTimers();
    }
  }

  it("mounted, a page drawn while the stream STOPS (a wait, no live expected) → empty reads → the recording: the replay line every time the box holds, never the live one", async () => {
    const seen: (string | null)[] = [];
    await mounted({ reserve: true, holdUntil: until, activeUntil: new Date(NOW + 60 * MIN).toISOString() }, [EMPTY, EMPTY, { live: null, replay: [part(1)] }], async (now, nextRead) => {
      const look = () => {
        const lines = statusLines(now());
        seen.push(lines[0] ?? null);
        return lines;
      };
      expect(look(), "server markup").toEqual([OWNER_REPLAY_LINE]);
      await nextRead();
      expect(look(), "read 1: still nothing to play").toEqual([OWNER_REPLAY_LINE]);
      await nextRead();
      expect(look(), "read 2: still nothing").toEqual([OWNER_REPLAY_LINE]);
      await nextRead();
      expect(look(), "read 3: the recording, the box and its line gone").toEqual([]);
      expect(now()).toContain('data-testid="seazn-player"');
    });
    expect(seen, "anti-vacuity: every step looked at").toEqual([OWNER_REPLAY_LINE, OWNER_REPLAY_LINE, OWNER_REPLAY_LINE, null]);
  });

  it("mounted the way MATCH DAY mounts it (reserve + liveExpected, no wait, the organiser's route): no line before the first answer; after the live stops, the box that holds says the REPLAY is coming, not the live it was mounted expecting", async () => {
    const steps: string[] = [];
    await mounted({ endpoint: "org", reserve: true, liveExpected: true }, [{ live: signed("live"), replay: [] }, EMPTY, { live: null, replay: [part(1)] }], async (now, nextRead) => {
      const first = now();
      expect(first, "server markup: the reserved box").toContain('data-testid="seazn-video-reserved"');
      expect(statusLines(first), "server markup: no wait, so no line").toEqual([]);
      steps.push("server");
      await nextRead();
      expect(now(), "read 1: the live player").toContain('data-testid="seazn-player"');
      expect(statusLines(now())).toEqual([]);
      steps.push("live");
      await nextRead();
      expect(now(), "read 2: the stop, the box holds").toContain('data-testid="seazn-video-starting"');
      expect(statusLines(now()), "read 2: the replay is what comes next").toEqual([OWNER_REPLAY_LINE]);
      expect(now(), "read 2: and no live row held for it").not.toContain("seazn-video-delay-reserved");
      steps.push("stopped");
      await nextRead();
      expect(statusLines(now()), "read 3: the recording").toEqual([]);
      steps.push("recording");
    });
    expect(steps, "anti-vacuity: every step looked at").toEqual(["server", "live", "stopped", "recording"]);
  });

  // Task 33g (T33f review m1): the page follows the latest session's state on every read. `session` is the route's own answer.
  const at = (state: string, wentLive: boolean) => ({ ...EMPTY, session: { state, wentLive } });
  const slotOf = (out: string): string | null => /<p data-testid="seazn-video-delay-reserved"[^>]*>(.*?)<\/p>/.exec(out)?.[1] ?? null;
  const PAGE_DRAWN_WARMING = { reserve: true, liveExpected: true, holdUntil: until, activeUntil: new Date(NOW + 60 * MIN).toISOString() };

  it("mounted, a page drawn WARMING, then the Go live is CANCELLED: the live line and its box are gone at the first read that says so (before the hold would have run out)", async () => {
    const seen: string[] = [];
    await mounted(PAGE_DRAWN_WARMING, [at("warming", false), at("warming", false), at("completed", false), at("completed", false)], async (now, nextRead) => {
      const look = (step: string, want: { box: boolean; status: string[]; row: boolean }) => {
        const out = now();
        expect(out.includes('data-testid="seazn-video-starting"'), `${step}: the held box`).toBe(want.box);
        expect(statusLines(out), `${step}: the line`).toEqual(want.status);
        expect(slotOf(out) !== null, `${step}: the held delay row`).toBe(want.row);
        seen.push(step);
      };
      look("server markup", { box: true, status: [OWNER_LIVE_LINE], row: true });
      await nextRead();
      look("read 1: warming", { box: true, status: [OWNER_LIVE_LINE], row: true });
      await nextRead();
      look("read 2: warming still", { box: true, status: [OWNER_LIVE_LINE], row: true });
      await nextRead();
      look("read 3: cancelled — it never went live, nothing is coming", { box: false, status: [], row: false });
      expect(now(), "and the island draws nothing at all").toBe("");
      await nextRead();
      look("read 4: nothing more", { box: false, status: [], row: false });
    });
    expect(seen, "anti-vacuity: every step looked at").toHaveLength(5);
  });

  it("mounted, a page drawn warming whose live was MISSED whole (the next read it sees says the session already ended, having gone live): the REPLAY line replaces the live one, then the recording", async () => {
    await mounted(PAGE_DRAWN_WARMING, [at("warming", false), at("completed", true), { live: null, replay: [part(1)], session: { state: "completed", wentLive: true } }], async (now, nextRead) => {
      expect(statusLines(now()), "server markup").toEqual([OWNER_LIVE_LINE]);
      await nextRead();
      expect(statusLines(now()), "read 1: warming").toEqual([OWNER_LIVE_LINE]);
      await nextRead();
      expect(now(), "read 2: ended — the box holds, for the recording that is coming").toContain('data-testid="seazn-video-starting"');
      expect(statusLines(now()), "read 2: the replay line, never the live one").toEqual([OWNER_REPLAY_LINE]);
      expect(slotOf(now()), "read 2: and no live row held for it").toBeNull();
      await nextRead();
      expect(now(), "read 3: the recording").toContain('data-testid="seazn-player"');
      expect(statusLines(now())).toEqual([]);
    });
  });

  it("mounted, warming → live → stop → ended (it went live): the live line, the player, then the replay line through `ending` and `completed`", async () => {
    const seen: (string | null)[] = [];
    await mounted(PAGE_DRAWN_WARMING, [at("warming", false), { live: signed("live"), replay: [], session: { state: "live", wentLive: true } }, at("ending", true), at("completed", true)], async (now, nextRead) => {
      const line = () => (seen.push(statusLines(now())[0] ?? null), statusLines(now())[0] ?? null);
      expect(line(), "server markup").toBe(OWNER_LIVE_LINE);
      await nextRead();
      expect(line(), "read 1: warming").toBe(OWNER_LIVE_LINE);
      await nextRead();
      expect(line(), "read 2: live").toBeNull();
      expect(now()).toContain('data-testid="seazn-player"');
      await nextRead();
      expect(line(), "read 3: ending").toBe(OWNER_REPLAY_LINE);
      await nextRead();
      expect(line(), "read 4: completed, a recording is coming").toBe(OWNER_REPLAY_LINE);
    });
    expect(seen, "anti-vacuity").toEqual([OWNER_LIVE_LINE, OWNER_LIVE_LINE, null, OWNER_REPLAY_LINE, OWNER_REPLAY_LINE]);
  });

  it("mounted, a Stop with a cancel in it (`ending`, never went live) and a session of ANOTHER kind (session null) each let the held box go at once", async () => {
    for (const [name, second] of [["ending, never live", at("ending", false)], ["no Seazn session", { ...EMPTY, session: null }]] as const) {
      await mounted({ reserve: true, holdUntil: until }, [at("completed", true), second], async (now, nextRead) => {
        expect(statusLines(now()), `${name}: server markup (the replay)`).toEqual([OWNER_REPLAY_LINE]);
        await nextRead();
        expect(statusLines(now()), `${name}: read 1, a recording is coming`).toEqual([OWNER_REPLAY_LINE]);
        await nextRead();
        expect(now(), `${name}: read 2, nothing is coming`).toBe("");
      });
    }
  });

  it("an answer that names no session (the route before this field) keeps the page's hint: the live line stays through empty reads, as T33f drew it", async () => {
    await mounted(PAGE_DRAWN_WARMING, [EMPTY, EMPTY], async (now, nextRead) => {
      await nextRead();
      expect(statusLines(now())).toEqual([OWNER_LIVE_LINE]);
      await nextRead();
      expect(statusLines(now())).toEqual([OWNER_LIVE_LINE]);
    });
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

});

describe("the island: the replay host's copy (Task 25)", () => {
  const iframes = (out: string) => count(out, /<iframe\b/g);
  const videos = (out: string) => count(out, /<video\b/g);

  it("one embed part: ONE <iframe> named for the replay, no <video>, no picker, and its address nowhere in the markup", () => {
    const out = html(answer({ replay: [part(1, "embed")] }));
    expect([iframes(out), videos(out)]).toEqual([1, 0]);
    expect(out).toMatch(new RegExp(`<iframe\\b[^>]*title="${labels.replay}"`));
    expect(tabs(out)).toEqual([]);
    expect(out, "the token is set after hydration, never served").not.toContain(part(1, "embed").src);
    expect(out).toContain('data-testid="seazn-video"');
  });

  it("live or an hls part renders the <video> player and no <iframe>", () => {
    for (const video of [answer({ live: signed("live") }), answer({ replay: [part(1)] }), answer({ replay: [part(1), part(2)] })]) {
      const out = html(video);
      expect([iframes(out), videos(out)]).toEqual([0, 1]);
    }
  });

  it("a live beside embed parts is the live player alone: no frame, no picker", () => {
    const out = html(answer({ live: signed("live"), replay: [part(1, "embed"), part(2, "embed")] }));
    expect([iframes(out), videos(out)]).toEqual([0, 1]);
    expect(tabs(out)).toEqual([]);
  });

  it("embed and hls parts share ONE picker in partNo order (any arrival order, gaps kept), and the picked part plays in its own kind, one at a time", () => {
    const embedFirst = html(answer({ replay: [part(3), part(2), part(1, "embed")] }));
    expect(tabs(embedFirst)).toEqual(["Part 1", "Part 2", "Part 3"]);
    expect([iframes(embedFirst), videos(embedFirst)], "Part 1 is the host's copy").toEqual([1, 0]);
    expect(embedFirst, "the other parts' addresses are not on the page").not.toContain(part(2).src);
    expect(embedFirst).toMatch(new RegExp(`<iframe\\b[^>]*title="Part 1"`));
    const hlsFirst = html(answer({ replay: [part(4, "embed"), part(2)] }));
    expect(tabs(hlsFirst)).toEqual(["Part 2", "Part 4"]);
    expect([iframes(hlsFirst), videos(hlsFirst)], "Part 2 is the interim").toEqual([0, 1]);
    expect(hlsFirst).toContain(`data-src="${part(2).src}"`);
  });

  it("SECURITY: the frame, its box and the region all carry ph-no-capture", () => {
    const out = html(answer({ replay: [part(1, "embed"), part(2, "embed")] }));
    expect(out).toMatch(/<iframe\b[^>]*class="[^"]*\bph-no-capture\b/);
    expect(out).toMatch(/data-testid="seazn-replay-frame-box"[^>]*class="[^"]*\bph-no-capture\b/);
    expect(out).toMatch(/<section\b[^>]*data-testid="seazn-video"[^>]*class="[^"]*\bph-no-capture\b/);
    expect(out).not.toContain("token=");
  });

  it("the frame's box IS the player's box (CLS): the same frame classes, so a part turning from the interim to the host's copy moves nothing", () => {
    const frameBox = /data-testid="seazn-replay-frame-box"[^>]*class="([^"]*)"/.exec(html(answer({ replay: [part(1, "embed")] })))?.[1];
    const playerBox = /data-testid="seazn-player"[^>]*class="([^"]*)"/.exec(html(answer({ replay: [part(1)] })))?.[1];
    expect(frameBox, "premise: the frame's box is found").toBeDefined();
    expect(playerBox, "premise: the player's box is found").toBeDefined();
    const tokens = (c: string) => c.split(/\s+/).filter(Boolean).sort();
    expect(tokens(frameBox!)).toEqual(tokens(playerBox!));
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
    // T33f (owner 'Ok', 2026-11-24): the held box's line is two lines, one per wait; the one line they replace is retired everywhere.
    const d = dict as Record<string, string>;
    expect(l.startingLive).toBe(d["seaznVideo.startingLive"]);
    expect(l.startingLive, "premise: the key exists in this locale (undefined === undefined would pass the line above)").toEqual(expect.any(String));
    expect(l.startingReplay).toBe(d["seaznVideo.startingReplay"]);
    expect(l.startingReplay, "premise: the key exists in this locale").toEqual(expect.any(String));
    expect(l.startingLive.length * l.startingReplay.length).toBeGreaterThan(0);
    expect(l.startingLive, "two different lines, not one twice").not.toBe(l.startingReplay);
    expect(d["seaznVideo.starting"], "the retired one-line key is gone from this locale (no orphan)").toBeUndefined();
    expect(Object.keys(l).sort(), "the labels are exactly these (no `starting` left to read)").toEqual(["delay", "live", "part", "replay", "startingLive", "startingReplay", "unavailable"]);
    expect(l.replay).toBe(dict["overlay.replay"]);
    expect(l.delay).toBe(dict["seaznVideo.delay"]);
    expect(l.delay, "premise: the key exists in this locale").toEqual(expect.any(String));
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
      for (const ok of [valid, { live: null, replay: [] }, { live: null, replay: [], session: null }, ...StreamSessionState.options.flatMap((state) => [false, true].map((wentLive) => ({ live: null, replay: [], session: { state, wentLive } })))]) {
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
      ["a session that is a string", { live: null, replay: [], session: "live" }],
      ["a session with no wentLive", { live: null, replay: [], session: { state: "live" } }],
      ["a session whose wentLive is not a boolean", { live: null, replay: [], session: { state: "live", wentLive: "yes" } }],
      ["a session whose state is not a string", { live: null, replay: [], session: { state: 1, wentLive: true } }],
    ];
    it("a session state this build does not know is still an answer (its player plays); only the shape is held", () => {
      const future = { live: null, replay: [], session: { state: "a-later-state", wentLive: true } };
      expect(PublicFixtureVideo.safeParse(future).success, "premise: the schema names the states it knows").toBe(false);
      expect(asPublicFixtureVideo(future)).toEqual(future);
    });
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
      expect(checked).toBeGreaterThanOrEqual(16);
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

// Task 25 carry 3, the seam from the frame to the loop: a frame holding a lapsed address asks for a fresh READ (`readSoon`), never a
// rebuild — the island's `epoch` (every player's key) does not move, so the waiting frame is not remounted. A player that gave up
// (`onFatal`) still rebuilds. The static markup cannot call a prop, so each link of the chain is read off the element it is handed to.
describe("Task 25: the frame's ask reaches the loop as a read, not a rebuild", () => {
  const MIN = 60_000;
  const embeds = answer({ replay: [part(1, "embed"), part(2, "embed")] });
  const route = () => vi.fn(async () => new Response(JSON.stringify({ ok: true, data: embeds }), { status: 200, headers: { "content-type": "application/json" } }));
  type StageEl = { props: { onStale: () => void; onFatal: (fatal: PlayerFatal) => void; onDegraded: (fatal: PlayerFatal) => void; epoch: number } };
  const fatalOn = (address: string): PlayerFatal => ({
    address, source: "replay", partNo: 2, player: "hls",
    failure: { reason: "hls", hlsType: "networkError", hlsDetails: "manifestLoadError", httpStatus: 403, mediaCode: null },
  });

  it("the island hands the stage an onStale that reads again (a final replay's own next read waits out the m4 bound, 5 min) and keeps the epoch; onFatal rebuilds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const fetchMock = route();
      vi.stubGlobal("fetch", fetchMock);
      const island = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, settledAt: new Date(NOW - MIN).toISOString() });
      await vi.advanceTimersByTimeAsync(4 * MIN);   // under the m4 bound (SEAZN_VIDEO_FINAL_READ_MS): no read of its own
      expect(fetchMock, "premise: a settled replay of embeds reads once before its 5 min bound").toHaveBeenCalledTimes(1);
      const stage = () => island.tree()[0] as unknown as StageEl;
      expect(stage().props.epoch).toBe(0);
      stage().props.onStale();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock, "the frame's ask: one fresh read").toHaveBeenCalledTimes(2);
      expect(stage().props.epoch, "a read, not a rebuild: the frame keeps its element").toBe(0);
      await vi.advanceTimersByTimeAsync(4 * MIN);   // under the m4 bound (SEAZN_VIDEO_FINAL_READ_MS): no read of its own
      beaconsSent();
      stage().props.onFatal(fatalOn(embeds.replay[1]!.src));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(stage().props.epoch, "the contrast: a player that gave up is rebuilt").toBe(1);
      // ...and reported, once for its address, with the island's fixture and no part of the address.
      expect(beacons.sent).toEqual([{
        url: CLIENT_REPORTS_PATH,
        body: { kind: "video", stage: "player", fixtureId: "f1", source: "replay", partNo: 2, player: "hls", reason: "hls", hlsType: "networkError", hlsDetails: "manifestLoadError", httpStatus: 403, mediaCode: null },
      }]);
      await vi.advanceTimersByTimeAsync(4 * MIN);   // under the m4 bound (SEAZN_VIDEO_FINAL_READ_MS): no read of its own
      stage().props.onFatal(fatalOn(embeds.replay[1]!.src));
      await vi.advanceTimersByTimeAsync(0);
      expect(stage().props.epoch, "rebuilt again").toBe(2);
      expect(beacons.sent, "the same address: no second report").toHaveLength(1);
      expect(JSON.stringify(beacons.sent)).not.toMatch(/tok-|fake\.invalid|manifest\/|m3u8|expires|\?/);
      island.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Task 52: the island hands the stage an onDegraded that REPORTS (once per address, with the bundle's code) and rebuilds nothing, reads nothing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const fetchMock = route();
      vi.stubGlobal("fetch", fetchMock);
      const island = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, settledAt: new Date(NOW - MIN).toISOString() });
      await vi.advanceTimersByTimeAsync(4 * MIN);
      const reads = fetchMock.mock.calls.length;
      const stage = () => island.tree()[0] as unknown as StageEl;
      beaconsSent();
      const degraded = { ...fatalOn(embeds.replay[1]!.src), failure: { reason: "bundle", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null } } as PlayerFatal;
      stage().props.onDegraded(degraded);
      stage().props.onDegraded(degraded);
      await vi.advanceTimersByTimeAsync(0);
      expect(beacons.sent).toEqual([{
        url: CLIENT_REPORTS_PATH,
        body: { kind: "video", stage: "player", fixtureId: "f1", source: "replay", partNo: 2, player: "hls", reason: "bundle", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null },
      }]);
      expect(stage().props.epoch, "a degraded player keeps playing: not rebuilt").toBe(0);
      expect(fetchMock.mock.calls.length, "and no read is asked for").toBe(reads);
      expect(JSON.stringify(beacons.sent)).not.toMatch(/tok-|fake\.invalid|manifest\/|m3u8|expires|\?/);
      island.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the stage hands onStale and onFatal on to the parts, and the parts hand them to the frame and the player", () => {
    const onStale = vi.fn();
    const onFatal = vi.fn();
    const onDegraded = vi.fn();
    const el = SeaznVideoStage({ video: embeds, epoch: 0, labels, onFatal, onDegraded, onStale, reserve: false, held: false, picker: [] }) as unknown as { type: unknown; props: { onStale: unknown; onFatal: unknown; onDegraded: unknown } };
    expect(el.type).toBe(ReplayParts);
    expect([el.props.onStale, el.props.onFatal, el.props.onDegraded]).toEqual([onStale, onFatal, onDegraded]);
    const r = renderIsland(ReplayParts, { parts: [...embeds.replay], epoch: 0, labels, onFatal, onStale });
    const frames = r.tree().filter((e) => e.type === SeaznReplayFrame);
    expect(frames, "one frame").toHaveLength(1);
    expect((frames[0]!.props as { onStale: unknown }).onStale).toBe(onStale);
  });

  it("Task 25 report: a player's give-up reaches the stage's onFatal as the island knows it — its address, live or replay, the part, hls, and the player's codes", () => {
    const failure = { reason: "element", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: 3 } as const;
    // The live: the stage's own player. renderIsland's tree is the component's own output, so the replay's player is read off
    // ReplayParts (the stage hands it onFatal unchanged, the test above).
    const liveFatal = vi.fn();
    const live = renderIsland(SeaznVideoStage, { video: answer({ live: signed("live"), replay: [part(1)] }), epoch: 0, labels, onFatal: liveFatal, onStale: () => {}, reserve: false, held: false, picker: [] });
    const replayFatal = vi.fn();
    const replay = renderIsland(ReplayParts, { parts: [...answer({ replay: [part(1, "embed"), part(4)] }).replay], epoch: 0, labels, onFatal: replayFatal, onStale: () => {} });
    // The first part is the host's frame: pick Part 4, the interim recording, so the player is the <video>.
    const tab = replay.tree().find((e) => e.type === "button" && String((e.props as { id?: string }).id).endsWith("-tab-4"));
    expect(tab, "premise: Part 4's tab").toBeDefined();
    (tab!.props as { onClick: () => void }).onClick();
    let checked = 0;
    for (const [island, onFatal, expected] of [
      [replay, replayFatal, { source: "replay", partNo: 4 }],
      [live, liveFatal, { source: "live", partNo: null }],
    ] as const) {
      const players = island.tree().filter((e) => e.type === SeaznPlayer);
      expect(players, `premise: one <video> player (${expected.source})`).toHaveLength(1);
      (players[0]!.props as { onFatal: (f: typeof failure, address: string) => void }).onFatal(failure, "the-address");
      expect(onFatal).toHaveBeenCalledWith({ address: "the-address", ...expected, player: "hls", failure });
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("Task 52: a player's degraded report (hls.js would not load, the browser's own player plays) reaches the stage's onDegraded as the island knows it, live and replay, and never onFatal", () => {
    const failure = { reason: "bundle", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null } as const;
    const liveDegraded = vi.fn();
    const liveFatal = vi.fn();
    const live = renderIsland(SeaznVideoStage, { video: answer({ live: signed("live"), replay: [part(1)] }), epoch: 0, labels, onFatal: liveFatal, onDegraded: liveDegraded, onStale: () => {}, reserve: false, held: false, picker: [] });
    const replayDegraded = vi.fn();
    const replayFatal = vi.fn();
    const replay = renderIsland(ReplayParts, { parts: [...answer({ replay: [part(1, "embed"), part(4)] }).replay], epoch: 0, labels, onFatal: replayFatal, onDegraded: replayDegraded, onStale: () => {} });
    const tab = replay.tree().find((e) => e.type === "button" && String((e.props as { id?: string }).id).endsWith("-tab-4"));
    expect(tab, "premise: Part 4's tab").toBeDefined();
    (tab!.props as { onClick: () => void }).onClick();
    let checked = 0;
    for (const [island, onDegraded, onFatal, expected] of [
      [replay, replayDegraded, replayFatal, { source: "replay", partNo: 4 }],
      [live, liveDegraded, liveFatal, { source: "live", partNo: null }],
    ] as const) {
      const players = island.tree().filter((e) => e.type === SeaznPlayer);
      expect(players, `premise: one <video> player (${expected.source})`).toHaveLength(1);
      (players[0]!.props as { onDegraded: (f: typeof failure, address: string) => void }).onDegraded(failure, "the-address");
      expect(onDegraded).toHaveBeenCalledWith({ address: "the-address", ...expected, player: "hls", failure });
      expect(onFatal, "a degraded player is not given up on: nothing is rebuilt").not.toHaveBeenCalled();
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("Task 25 report: a failed read of the route is reported once per kind, with its status, from the mounted island", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      beaconsSent();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);
      const island = renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels });
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(fetchMock.mock.calls.length, "premise: the loop retried").toBeGreaterThanOrEqual(3);
      expect(beacons.sent.map((b) => b.body), "one beacon, none for the retries").toEqual([
        { kind: "video", stage: "route", fixtureId: "f1", source: null, partNo: null, player: null, reason: "http", hlsType: null, hlsDetails: null, httpStatus: 503, mediaCode: null },
      ]);
      expect(fetchMock.mock.calls.every((c) => !String((c as unknown[])[0]).includes("client-reports")), "the report went by beacon, not by the route's fetch").toBe(true);
      expect(JSON.stringify(beacons.sent.map((b) => b.body))).not.toMatch(/\/api\/|video\?|unavailable/);
      island.unmount();
    } finally {
      vi.useRealTimers();
    }
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

// Phase 1 visual re-capture R2 (CLS 0 -> 0.0856 at 1280 on a warming session): D1 held the player's box until the first read, then an
// answer with nothing to play collapsed it, and the player that came a poll later pushed the page down again. Where the page says a wait
// is on (`holdUntil`: a Seazn session warming, or just stopped with its recording not locked yet), the same box now holds with one quiet
// line, through every empty answer, until a player arrives or the wait runs out.
describe("re-capture R2: the box holds through a wait, in the server markup", () => {
  const MIN = 60_000;
  const in10 = new Date(NOW + 10 * MIN).toISOString();
  const waiting = (props: Record<string, unknown> = {}, l = labels) =>
    renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={l} reserve holdUntil={in10} {...props} />);
  const classOf = (out: string, testId: string): string => {
    const m = new RegExp(`data-testid="${testId}"[^>]*?class="([^"]*)"`).exec(out) ?? new RegExp(`class="([^"]*)"[^>]*?data-testid="${testId}"`).exec(out);
    if (!m) throw new Error(`no ${testId} in the markup — every probe on it would pass vacuously`);
    return m[1]!;
  };
  const tokens = (c: string) => c.split(/\s+/).filter(Boolean).sort();

  it("EMPTY CASE FIRST: no wait is no line and no 'starting' frame — the reserved box stays exactly D1's empty one, and nothing at all without reserve", () => {
    const out = renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} reserve />);
    expect(out).toContain('data-testid="seazn-video-reserved"');
    expect(out).not.toContain("seazn-video-starting");
    expect(out.replace(/<[^>]*>/g, ""), "no words").toBe("");
    expect(html(null), "no reserve, no wait: nothing").toBe("");
  });

  it("a wait, no answer yet: the player's box with one status line in the page's own words, readable by assistive tech", () => {
    const out = waiting();
    expect(count(out, /data-testid="seazn-video-starting"/g), "one box").toBe(1);
    expect(out).not.toContain("seazn-video-reserved");
    expect(out.replace(/<[^>]*>/g, ""), "one short line, the localized one (no live expected: the replay's, T33f)").toBe(OWNER_REPLAY_LINE);
    expect(out).toMatch(/<p [^>]*role="status"[^>]*>/);
    expect(out, "the line is not hidden from assistive tech").not.toContain("aria-hidden");
    expect(out).not.toMatch(/<video\b|data-src=/);
  });

  it("the starting box carries the player's own region and frame class sets (16:9, 200 px floor, dark); that they place the same in a browser is the probe's (e2e/public-fixture.spec.ts)", () => {
    const box = waiting();
    const live = html(answer({ live: signed("live") }));
    expect(tokens(classOf(box, "seazn-video-starting"))).toEqual(tokens(classOf(live, "seazn-video")));
    const frame = tokens(classOf(box, "seazn-video-frame"));
    expect(frame).toEqual(tokens(classOf(live, "seazn-player")).filter((c) => c !== "ph-no-capture"));
    for (const c of ["aspect-video", "min-h-[200px]", "w-full", "bg-black"]) expect(frame, c).toContain(c);
  });

  it("a wait implies the box even without reserve (the plan says one is coming); a wait that is not a date is no wait", () => {
    expect(waiting({ reserve: false })).toContain('data-testid="seazn-video-starting"');
    for (const bad of ["not a date", "", null]) {
      const out = waiting({ reserve: false, holdUntil: bad });
      expect(out, `holdUntil ${JSON.stringify(bad)}: no box`).toBe("");
      expect(waiting({ holdUntil: bad }), `holdUntil ${JSON.stringify(bad)}, reserved: the plain empty box`).toContain("seazn-video-reserved");
    }
  });

  it("an answer in hand: a player wins over the wait; an empty answer under a wait is the starting box (nothing to play, still waiting)", () => {
    const player = waiting({ initial: answer({ live: signed("live") }) });
    expect(player).not.toContain("seazn-video-starting");
    expect(count(player, /data-testid="seazn-player"/g)).toBe(1);
    const empty = waiting({ initial: answer({}) });
    expect(empty).toContain('data-testid="seazn-video-starting"');
    const embeds = waiting({ initial: answer({ replay: [part(1, "embed")] }) });
    expect(embeds, "embeds alone draw the host's player (Task 25), so the wait does not show").not.toContain("seazn-video-starting");
    expect(count(embeds, /<iframe\b/g)).toBe(1);
  });

  it("every locale says its own line, for either wait (never the English, never a bare key)", () => {
    const dicts = { es: publicEs, fr: publicFr, nl: publicNl } as const;
    const en = publicEn as Record<string, string>;
    let checked = 0;
    for (const [loc, dict] of Object.entries(dicts)) {
      const d = dict as Record<string, string>;
      for (const [liveExpected, key] of [[true, "seaznVideo.startingLive"], [false, "seaznVideo.startingReplay"]] as const) {
        // The status line itself: a live-next box also holds the delay row's (invisible) sentence, which is not this line.
        const lines = statusLines(waiting({ liveExpected }, seaznVideoLabels(d)));
        expect(d[key], `${loc} ${key}: premise, the key exists`).toEqual(expect.any(String));
        expect(lines, `${loc} ${key}: one line`).toHaveLength(1);
        const line = lines[0]!;
        expect(line, `${loc} ${key}`).toBe(d[key]);
        expect(line, `${loc} ${key} is not the English`).not.toBe(en[key]);
        expect(line).not.toMatch(/^seaznVideo\.|\{/);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: every non-English locale, both lines").toBe(6);
  });
});

// Visual re-capture R1: a replay of two or more parts mounts its picker row (44 px + 12 px) with the first answer, and the Summary panel
// moved 56 px. The plan knows the parts' numbers, so the box holds that row too, invisible, with the picker's own geometry.
describe("re-capture R1: the picker's row is held in the box when the plan knows two or more parts", () => {
  const reserved = (replayParts: readonly number[], extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} reserve replayParts={replayParts} {...extra} />);
  const row = (out: string) => /<div [^>]*data-testid="seazn-video-picker-reserved"[^>]*>(.*?)<\/div>/.exec(out);
  const classAttr = (tag: string): string => /class="([^"]*)"/.exec(tag)?.[1] ?? "";
  const tokens = (c: string) => c.split(/\s+/).filter(Boolean).sort();

  it("EMPTY CASE FIRST: no parts, or one, holds no row (a single recording has no picker); nor does a plain box without the hint", () => {
    for (const parts of [[], [1], [3]]) expect(reserved(parts), `parts ${JSON.stringify(parts)}`).not.toContain("picker-reserved");
    expect(renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} reserve />)).not.toContain("picker-reserved");
  });

  it("two or more parts: one row above the frame, hidden from assistive tech and from sight, with a pill per part in order, labelled with the part's own number", () => {
    const out = reserved([1, 3]);
    const held = row(out);
    expect(held, "the row is in the server markup").not.toBeNull();
    expect(held![0]).toMatch(/aria-hidden="true"/);
    expect(classAttr(held![0]!)).toMatch(/\binvisible\b/);
    expect([...held![1]!.matchAll(/<span [^>]*>(.*?)<\/span>/g)].map((m) => m[1]), "a pill per part, by its number").toEqual(["Part 1", "Part 3"]);
    expect(out.indexOf("picker-reserved"), "above the frame").toBeLessThan(out.indexOf("seazn-video-frame"));
    expect(out).not.toContain('role="tab"');
    expect(count(reserved([1, 2, 3, 4]), /<span /g), "four parts, four pills").toBe(4);
  });

  it("the held row carries the picker's own class sets: its row and each pill's class equal the real tablist's (that the real one then takes its place with no shift is the browser probe's, e2e/public-fixture.spec.ts)", () => {
    const real = html(answer({ replay: [part(1), part(3)] }));
    const realRow = /<div [^>]*role="tablist"[^>]*>/.exec(real)![0];
    const heldRow = row(reserved([1, 3]))!;
    expect(tokens(classAttr(heldRow[0]!)).filter((c) => c !== "invisible")).toEqual(tokens(classAttr(realRow)));
    const realPills = [...real.matchAll(/<button [^>]*role="tab"[^>]*>/g)].map((m) => classAttr(m[0]));
    const heldPills = [...heldRow[1]!.matchAll(/<span [^>]*>/g)].map((m) => classAttr(m[0]));
    expect(realPills.length, "anti-vacuity: both pills were read").toBe(2);
    expect(heldPills, "the selected first one and the other, each with its own geometry").toEqual(realPills);
    expect(new Set(realPills).size, "the two pills differ (selected has no border): a held row that used one class for both would be wrong").toBe(2);
  });

  it("a wait holds the row too, under the line; once the answer is in hand the row is the real tablist's, not the held one", () => {
    const out = reserved([1, 3], { holdUntil: new Date(NOW + 10 * 60_000).toISOString() });
    expect(out).toContain("seazn-video-starting");
    expect(row(out)).not.toBeNull();
    const answered = reserved([1, 3], { initial: answer({ replay: [part(1), part(3)] }) });
    expect(answered).not.toContain("picker-reserved");
    expect(tabs(answered)).toEqual(["Part 1", "Part 3"]);
    const nothing = reserved([1, 3], { holdUntil: new Date(NOW + 10 * 60_000).toISOString(), initial: answer({}) });
    expect(nothing, "an answer with no parts: the hint is stale, the row is not held").not.toContain("picker-reserved");
  });

  it("no box, no row: the hint alone draws nothing", () => {
    expect(renderToStaticMarkup(<SeaznVideoIsland fixtureId="f1" labels={labels} replayParts={[1, 2]} />)).toBe("");
  });
});

// The wiring a node render cannot see: the island's own state over time, on vitest's fake clock, through the REAL loop. A box is
// "present" when the stage draws any of the box's own markers.
describe("re-capture R2: the mounted island holds its box across reads, and lets go once", () => {
  const MIN = 60_000;
  const BOX = ["seazn-video-reserved", "seazn-video-starting", "seazn-video"];
  const ids = (island: { tree: () => ReturnType<typeof walk> }) => [...renderToStaticMarkup(island.tree()[0]!).matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]!);
  const boxed = (island: { tree: () => ReturnType<typeof walk> }) => ids(island).some((id) => BOX.includes(id));
  const EMPTY = { live: null, replay: [] };
  /** The route answers `answers` in order, then the last one for ever; an `Error` entry is a failed read. */
  const route = (answers: (object | Error)[]) => {
    let i = 0;
    return vi.fn(async () => {
      const next = answers[Math.min(i++, answers.length - 1)]!;
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify({ ok: true, data: next }), { status: 200, headers: { "content-type": "application/json" } });
    });
  };
  const mount = (props: Record<string, unknown>) => renderIsland(SeaznVideoIsland, { fixtureId: "f1", labels, ...props });
  /** Advance in `step` slices up to `total`, and report, after each, whether the box was there. */
  const watch = async (island: Parameters<typeof boxed>[0], total: number, step = 1_000) => {
    const seen: boolean[] = [];
    for (let t = 0; t < total; t += step) {
      await vi.advanceTimersByTimeAsync(step);
      seen.push(boxed(island));
    }
    return seen;
  };
  const clock = async (run: () => Promise<void>) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  };
  const hot = { activeUntil: new Date(NOW + 60 * MIN).toISOString() };

  it("WARMING: empty reads while the session warms keep the box (with its line), and the live player takes the same place — the box never goes missing between", async () => {
    await clock(async () => {
      vi.stubGlobal("fetch", route([EMPTY, EMPTY, EMPTY, { live: signed("live"), replay: [] }]));
      const island = mount({ reserve: true, holdUntil: new Date(NOW + 10 * MIN).toISOString(), ...hot });
      expect(ids(island), "server markup").toContain("seazn-video-starting");
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(island), "first read: warming").toContain("seazn-video-starting");
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      expect(ids(island), "second read: still warming").toContain("seazn-video-starting");
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      expect(ids(island), "third read: still warming").toContain("seazn-video-starting");
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      const live = ids(island);
      expect(live, "fourth read: live — the player in the box").toEqual(expect.arrayContaining(["seazn-video", "seazn-player"]));
      expect(live).not.toContain("seazn-video-starting");
      island.unmount();
    });
  });

  it("STOP: the live player is gone within ONE read of the stop, the box stays with its line, and the recording takes its place when it is locked", async () => {
    await clock(async () => {
      vi.stubGlobal("fetch", route([{ live: signed("live"), replay: [] }, EMPTY, EMPTY, { live: null, replay: [{ ...part(1) }] }]));
      const island = mount({ reserve: true, ...hot });
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(island), "premise: on air").toContain("seazn-player");
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      const stopped = ids(island);
      expect(stopped, "one read after the Stop: no live player, no live region").not.toContain("seazn-player");
      expect(stopped).not.toContain("seazn-video");
      expect(stopped, "the box holds").toContain("seazn-video-starting");
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      expect(ids(island), "recording not locked yet: still the box").toContain("seazn-video-starting");
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_POLL_FLOOR_MS);
      expect(ids(island), "locked: the recording plays in the box").toEqual(expect.arrayContaining(["seazn-video", "seazn-player"]));
      island.unmount();
    });
  });

  it("TERMINAL NOTHING: with no wait, the first empty answer collapses the box once (D1's rule, unchanged)", async () => {
    await clock(async () => {
      vi.stubGlobal("fetch", route([EMPTY]));
      const island = mount({ reserve: true });
      expect(boxed(island), "before the first read").toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(boxed(island), "nothing to show: collapsed").toBe(false);
      expect(await watch(island, 5 * MIN, 10_000), "and it stays collapsed over the reads that follow").not.toContain(true);
      island.unmount();
    });
  });

  it("the plan's wait runs out: the box goes ONCE, at that instant, and stays gone through every later empty read", async () => {
    await clock(async () => {
      vi.stubGlobal("fetch", route([EMPTY]));
      const island = mount({ reserve: true, holdUntil: new Date(NOW + 5 * MIN).toISOString(), ...hot });
      await vi.advanceTimersByTimeAsync(0);
      expect(boxed(island), "read 1 is empty, the wait is on").toBe(true);
      await vi.advanceTimersByTimeAsync(5 * MIN - 1);
      expect(boxed(island), "a ms before the wait ends: held").toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(boxed(island), "at the instant it ends: collapsed").toBe(false);
      const after = await watch(island, 10 * MIN, 10_000);
      expect(after.length, "anti-vacuity: the later reads were watched").toBe(60);
      expect(after, "never back").not.toContain(true);
      island.unmount();
    });
  });

  it("AFTER A STOP the wait is the recording's lock window from the last player read: held until then, gone after, and a second Go live still reaches the open page", async () => {
    await clock(async () => {
      vi.stubGlobal("fetch", route([{ live: signed("live"), replay: [] }, EMPTY]));
      const island = mount({ reserve: true, ...hot });
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(island), "premise: on air at t0").toContain("seazn-player");
      await vi.advanceTimersByTimeAsync(SEAZN_VIDEO_HOLD_MS - 1);
      expect(boxed(island), "a ms before the lock window closes: held").toBe(true);
      expect(ids(island)).not.toContain("seazn-player");
      await vi.advanceTimersByTimeAsync(1);
      expect(boxed(island), "the window closed with no recording: the one collapse").toBe(false);
      vi.stubGlobal("fetch", route([{ live: signed("again"), replay: [] }]));
      await vi.advanceTimersByTimeAsync(2 * MIN);
      expect(ids(island), "T19: a second Go live reaches the open page, collapsed or not").toEqual(expect.arrayContaining(["seazn-video", "seazn-player"]));
      island.unmount();
    });
  });

  it("an OLD cached page (its wait ran out before it loaded): the box is not collapsed before the first answer, so a player that is live NOW lands in it with no shift", async () => {
    await clock(async () => {
      let release: (r: Response) => void = () => undefined;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
      const island = mount({ reserve: true, holdUntil: new Date(NOW - 10 * MIN).toISOString() });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ids(island), "no answer yet: the page's reserved box stands (the plan's word is old, the answer is not in) — without the line it promised").toContain("seazn-video-reserved");
      expect(ids(island)).not.toContain("seazn-video-starting");
      release(new Response(JSON.stringify({ ok: true, data: { live: signed("live"), replay: [] } }), { status: 200, headers: { "content-type": "application/json" } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(island), "live: the player, in the box").toEqual(expect.arrayContaining(["seazn-video", "seazn-player"]));
      island.unmount();
    });
    await clock(async () => {
      vi.stubGlobal("fetch", route([EMPTY]));
      const island = mount({ reserve: true, holdUntil: new Date(NOW - 10 * MIN).toISOString() });
      await vi.advanceTimersByTimeAsync(0);
      expect(boxed(island), "the answer is empty and the old wait is over: terminal nothing, collapsed once").toBe(false);
      island.unmount();
    });
  });

  it("a route that never answers: the wait still runs out — the promise of a video goes (the line), and with nothing reserved the box goes with it; a reserved box keeps D1's empty one until an answer", async () => {
    await clock(async () => {
      vi.stubGlobal("fetch", route([new Error("offline")]));
      const island = mount({ reserve: true, holdUntil: new Date(NOW + 3 * MIN).toISOString() });
      await vi.advanceTimersByTimeAsync(3 * MIN - 1);
      expect(ids(island), "still waiting: the line").toContain("seazn-video-starting");
      await vi.advanceTimersByTimeAsync(1);
      expect(ids(island), "the wait is over: no promise on screen").not.toContain("seazn-video-starting");
      expect(ids(island), "reserved, no answer yet: D1's empty box, as before this change").toContain("seazn-video-reserved");
      island.unmount();
      const bare = mount({ holdUntil: new Date(Date.now() + 3 * MIN).toISOString() });
      await vi.advanceTimersByTimeAsync(3 * MIN - 1);
      expect(boxed(bare), "not reserved: the wait alone held the box").toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(boxed(bare), "and nothing outlives it").toBe(false);
      bare.unmount();
    });
  });

  it("review m3: an OLD cached page on a route that never answers (every read fails): the line it promised goes at once, and the reserved box stays for the first answer — nothing says 'shortly' for ever", async () => {
    await clock(async () => {
      vi.stubGlobal("fetch", route([new Error("offline")]));
      const island = mount({ reserve: true, holdUntil: new Date(NOW - 10 * MIN).toISOString() });
      expect(ids(island), "server markup: the page drew the line").toContain("seazn-video-starting");
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(ids(island), "ten minutes of failed reads: no promise on screen").not.toContain("seazn-video-starting");
      expect(ids(island), "the reserved box stands, as D1 drew it").toContain("seazn-video-reserved");
      island.unmount();
    });
  });

  it("review I1: a recording locked one stream-tick LATE (stg ticks every 5 min): the box never goes missing from the Stop to the recording, and the recording plays in it", async () => {
    await clock(async () => {
      // The real path from the Stop, from the engine's own declarations (not from the hold's constants): the runner's stop grace ends the
      // session, Cloudflare finishes the recording a hold later, and the next tick firing, up to a whole period on, locks it.
      const LOCK_AFTER_STOP_MS = (RUNNER_STOP_GRACE_SECONDS + INGEST_TIMEOUT_SECONDS + HOLD_SLACK_SECONDS + STREAM_TICK_PERIOD_SECONDS) * 1000;
      expect(LOCK_AFTER_STOP_MS, "PREMISE: the lock lands after the old window (the grace plus one read) ended — the case that used to collapse the box")
        .toBeGreaterThan(FINALISATION_GRACE_SECONDS * 1000 + SEAZN_VIDEO_POLL_FLOOR_MS);
      const t0 = Date.now();
      const respond = (data: object) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
      vi.stubGlobal("fetch", vi.fn(async () => {
        const sinceStop = Date.now() - t0;
        if (sinceStop === 0) return respond({ live: signed("live"), replay: [] });   // the read the Stop follows
        return respond(sinceStop < LOCK_AFTER_STOP_MS ? EMPTY : { live: null, replay: [part(1)] });
      }));
      const island = mount({ reserve: true });   // a cold page: the reads back off to the ceiling, the slowest the lock can be noticed at
      await vi.advanceTimersByTimeAsync(0);
      expect(ids(island), "PREMISE: on air at the last read before the Stop").toContain("seazn-player");
      const seen: { box: boolean; player: boolean }[] = [];
      const slices = Math.ceil((LOCK_AFTER_STOP_MS + 3 * MIN) / 5_000);
      for (let i = 0; i < slices; i++) {
        await vi.advanceTimersByTimeAsync(5_000);
        seen.push({ box: boxed(island), player: ids(island).includes("seazn-player") });
      }
      expect(seen.length, "anti-vacuity: the whole path was watched, in 5 s slices").toBe(slices);
      expect(seen.filter((x) => !x.box), "the box never went missing (no collapse, so no re-expand)").toEqual([]);
      const stopped = seen.findIndex((x) => !x.player);
      expect(stopped, "the Stop reached the open page (the live player went) ...").toBeGreaterThanOrEqual(0);
      const firstPlayer = seen.findIndex((x, i) => i > stopped && x.player);
      expect(firstPlayer, "... and the recording then played").toBeGreaterThan(stopped);
      expect((firstPlayer + 1) * 5_000, "not before it was locked").toBeGreaterThanOrEqual(LOCK_AFTER_STOP_MS);
      expect(firstPlayer - stopped, "anti-vacuity: a long stretch of empty answers sat between them, far past the old window").toBeGreaterThan(LOCK_AFTER_STOP_MS / 5_000 - 20);
      expect(seen.slice(stopped, firstPlayer).every((x) => !x.player && x.box), "between the Stop and the recording: the box, with no player").toBe(true);
      expect(seen.slice(firstPlayer).every((x) => x.player), "and the recording stayed").toBe(true);
      island.unmount();
    });
  });

  it("the page's schedule is untouched by the hold: a warming page reads at 0 and 30 s then every 60 s unhot, every 30 s hot, and unmounting stops it", async () => {
    await clock(async () => {
      const cold = route([EMPTY]);
      vi.stubGlobal("fetch", cold);
      const a = mount({ reserve: true, holdUntil: new Date(NOW + 10 * MIN).toISOString() });
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(cold.mock.calls.length, "cold: 0 and 30 s, then every 60 s").toBe(2 + Math.floor((5 * MIN - 30_000) / 60_000));
      a.unmount();
      const warm = route([EMPTY]);
      vi.stubGlobal("fetch", warm);
      const b = mount({ reserve: true, holdUntil: new Date(NOW + 10 * MIN).toISOString(), ...hot });
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(warm.mock.calls.length, "hot: every 30 s").toBe(11);
      b.unmount();
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(warm.mock.calls.length, "no read after unmount").toBe(11);
      expect(vi.getTimerCount(), "and no timer left behind: the box's own goes with the island").toBe(0);
    });
  });
});
