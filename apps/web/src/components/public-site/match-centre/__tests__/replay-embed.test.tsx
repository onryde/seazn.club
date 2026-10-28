// YouTube Connect T16 (owner rulings O1, O4, O5): the replay player inside the match card - a click-to-play facade, part tabs for
// two or more parts, an "Open on YouTube" link, and a fallback to that link when the video cannot play here.
//
// `apps/web` vitest is `environment: "node"` (no DOM), so this file tests what a node test can see and says so:
//   - the PURE parts exhaustively: the state machine (every transition, the sequences, the stray message), the player-message
//     verdict (swept over every error code 0-200), the sizing rule;
//   - the MARKUP of every state, by rendering the real component bare (a facade, a player, a fallback, one part, two parts, three
//     locales), including the negatives that the owner's rulings are about - no iframe before a tap, no part label for one part,
//     no YouTube logo on the facade - each with its positive pair so the probe is known to be able to see the thing;
//   - the WIRING (taps, arrow keys, the live postMessage) is what a node test cannot see; youtube-parts.shots.spec.ts drives the
//     real browser (tap -> iframe, tab -> new facade, a player error -> the fallback), and its footing is stated there.
//
// Expected values are typed from the rulings and YouTube's documented error list (100 not found or private, 101 and 150 embedding
// disallowed, 153 missing embedder identity), never read back from the component.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { YoutubeIcon } from "@/components/v2/youtube-icon";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { ReplayPart } from "@/lib/youtube";
import {
  ReplayEmbed, ReplayStage, REPLAY_UNPLAYABLE_CODES, initialReplayState, playerReportsUnplayable, replayReducer,
  type ReplayMode, type ReplayState,
} from "../replay-embed";

const ID1 = "dQw4w9WgXcQ";
const ID2 = "a-B_c1D2e3F";
const ID3 = "x9Y8z7W6v5U";
const P1: ReplayPart = { partNo: 1, url: `https://www.youtube.com/watch?v=${ID1}` };
const P2: ReplayPart = { partNo: 2, url: `https://www.youtube.com/watch?v=${ID2}` };
const P3: ReplayPart = { partNo: 3, url: `https://www.youtube.com/watch?v=${ID3}` };
const CHANNEL_ONLY: ReplayPart = { partNo: 1, url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv" };   // YouTube, but no video id

const UI: Record<string, Dict> = { en: uiEn as Dict, es: uiEs as Dict, fr: uiFr as Dict, nl: uiNl as Dict };
const render = (node: React.ReactNode, locale = "en") =>
  renderToStaticMarkup(<DictProvider dict={UI[locale]!} locale={locale as "en"}>{node}</DictProvider>);
const embed = (parts: ReplayPart[], locale = "en") => render(<ReplayEmbed parts={parts} />, locale);
// React escapes an apostrophe in text (can't -> can&#x27;t); a markup assertion compares what the browser would be sent.
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
const copy = (locale: string, key: string, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), (UI[locale] as Record<string, string>)[key]!);

// ─── the state machine ────────────────────────────────────────────────────────────────────────────────────────────────────
describe("replayReducer: the player's states", () => {
  const two = (): ReplayState => initialReplayState([P1, P2]);

  it("EMPTY CASE FIRST: nothing to play is an empty state that every action leaves alone", () => {
    const empty = initialReplayState([]);
    expect(empty).toEqual({ active: 0, modes: [] });
    for (const action of [{ type: "play" }, { type: "unavailable" }, { type: "select", index: 0 }, { type: "select", index: 3 }] as const) {
      expect(replayReducer(empty, action), JSON.stringify(action)).toEqual(empty);
    }
  });

  it("starts on Part 1 as a facade: nothing plays until a tap; a part with no provable video id starts as the link fallback", () => {
    expect(two()).toEqual({ active: 0, modes: ["facade", "facade"] });
    expect(initialReplayState([P1, CHANNEL_ONLY, P3])).toEqual({ active: 0, modes: ["facade", "unavailable", "facade"] });
    expect(initialReplayState([CHANNEL_ONLY]).modes).toEqual(["unavailable"]);
  });

  it("a tap plays the active part, and only the active part; a second tap changes nothing", () => {
    const played = replayReducer(two(), { type: "play" });
    expect(played).toEqual({ active: 0, modes: ["playing", "facade"] });
    expect(replayReducer(played, { type: "play" })).toEqual(played);
  });

  it("choosing the other part stops what played and shows THAT part's facade - still click-to-play, never autoplay", () => {
    const played = replayReducer(two(), { type: "play" });
    const switched = replayReducer(played, { type: "select", index: 1 });
    expect(switched).toEqual({ active: 1, modes: ["facade", "facade"] });
    expect(switched.modes.includes("playing"), "nothing is playing after a switch").toBe(false);
    // And back: Part 1 is a facade again (the video was stopped, not paused behind the scenes).
    expect(replayReducer(switched, { type: "select", index: 0 })).toEqual({ active: 0, modes: ["facade", "facade"] });
  });

  it("choosing the part already showing does not stop it (re-tapping the selected tab is not a stop button)", () => {
    const played = replayReducer(two(), { type: "play" });
    expect(replayReducer(played, { type: "select", index: 0 })).toEqual(played);
  });

  it("a player error while PLAYING makes that part the link fallback; the other part is untouched", () => {
    const failed = replayReducer(replayReducer(two(), { type: "play" }), { type: "unavailable" });
    expect(failed).toEqual({ active: 0, modes: ["unavailable", "facade"] });
    // Part 2 still plays: one video's embedding ban says nothing about the next.
    expect(replayReducer(replayReducer(failed, { type: "select", index: 1 }), { type: "play" }).modes).toEqual(["unavailable", "playing"]);
  });

  it("the fallback is remembered: leaving the part and coming back does not offer a player that cannot play", () => {
    const failed = replayReducer(replayReducer(two(), { type: "play" }), { type: "unavailable" });
    const away = replayReducer(failed, { type: "select", index: 1 });
    expect(replayReducer(away, { type: "select", index: 0 }).modes[0]).toBe("unavailable");
    expect(replayReducer(failed, { type: "play" }).modes[0], "a tap cannot revive it").toBe("unavailable");
  });

  it("a stray error when nothing is playing changes nothing (a message from a closed player must not blank a facade)", () => {
    expect(replayReducer(two(), { type: "unavailable" })).toEqual(two());
  });

  it("choosing a part that does not exist changes nothing (a stale tab index cannot point past the list)", () => {
    const s = two();
    for (const index of [-1, 2, 99, 1.5, Number.NaN]) expect(replayReducer(s, { type: "select", index }), String(index)).toEqual(s);
  });
});

// ─── the player's message ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("playerReportsUnplayable: when the embedded player says it cannot play this video here", () => {
  const FROM = "https://www.youtube-nocookie.com";
  const err = (info: unknown) => JSON.stringify({ event: "onError", info, id: 1, channel: "widget" });

  it("is true for exactly the documented 'cannot play here' codes, swept over every code 0-200", () => {
    let checked = 0;
    const flagged: number[] = [];
    for (let code = 0; code <= 200; code++) {
      if (playerReportsUnplayable(FROM, true, err(code))) flagged.push(code);
      checked++;
    }
    expect(checked, "anti-vacuity: every code was asked").toBe(201);
    expect(flagged).toEqual([100, 101, 150, 153]);
    expect([...REPLAY_UNPLAYABLE_CODES]).toEqual([100, 101, 150, 153]);
  });

  it("accepts the message as the string YouTube posts and as an already-parsed object", () => {
    expect(playerReportsUnplayable(FROM, true, err(150))).toBe(true);
    expect(playerReportsUnplayable(FROM, true, { event: "onError", info: 101 })).toBe(true);
  });

  it("is false for the transient errors, other events, and anything that is not a well-formed error", () => {
    for (const data of [
      err(2), err(5),                                                          // invalid parameter / HTML5 player error: not "embedding disabled"
      JSON.stringify({ event: "onReady" }),
      JSON.stringify({ event: "infoDelivery", info: { currentTime: 3 } }),
      JSON.stringify({ event: "onError" }),                                    // no info
      JSON.stringify({ event: "onError", info: "150" }),                       // the code is a number
      JSON.stringify({ event: "onError", info: null }),
      "not json", "", "{", "null", "150", JSON.stringify([150]), null, undefined, 150, true,
    ]) {
      expect(playerReportsUnplayable(FROM, true, data), JSON.stringify(data)).toBe(false);
    }
  });

  it("is false unless the message comes from the player we mounted: wrong origin, another window", () => {
    const good = err(150);
    expect(playerReportsUnplayable(FROM, true, good), "positive pair").toBe(true);
    for (const origin of ["https://www.youtube.com", "https://youtube-nocookie.com", "https://evil.example", "https://www.youtube-nocookie.com.evil.example", "http://www.youtube-nocookie.com", "", "null"]) {
      expect(playerReportsUnplayable(origin, true, good), origin).toBe(false);
    }
    expect(playerReportsUnplayable(FROM, false, good), "right origin, but not our iframe's window").toBe(false);
  });
});

// ─── the markup, one state at a time ──────────────────────────────────────────────────────────────────────────────────────
describe("ReplayEmbed: one part is the player alone", () => {
  const html = embed([P1]);

  it("renders the facade: a play button with the neutral glyph and 'Play on YouTube', the video's own thumbnail, and NO iframe before a tap", () => {
    expect(html).toContain('data-testid="replay-embed"');
    expect(html).toContain('data-testid="replay-facade"');
    expect(html).toContain(copy("en", "streaming.youtube.replay.play"));
    expect(html).toContain(`src="https://i.ytimg.com/vi/${ID1}/hqdefault.jpg"`);
    expect(html, "click-to-play: nothing from YouTube's player loads until a tap").not.toContain("<iframe");
    expect(html).not.toContain("youtube-nocookie.com");
    expect(html).not.toContain("autoplay");
  });

  it("shows no part label anywhere and no tablist: one part is the player alone", () => {
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('role="tabpanel"');
    expect(html).not.toMatch(/\bPart\b/);
    expect(html).not.toContain(copy("en", "streaming.youtube.part", { n: 1 }));
  });

  it("links 'Open on YouTube' to the part's own address, in a new tab with noopener, with a 44px hit area", () => {
    const link = /<a [^>]*data-testid="replay-open"[^>]*>/.exec(html)?.[0] ?? "";
    expect(link, "the link exists").not.toBe("");
    expect(link).toContain(`href="${P1.url}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/);
    expect(link).toMatch(/\bmin-h-11\b/);
    expect(html).toContain(`>${copy("en", "streaming.youtube.replay.open")}</a>`);
  });

  it("the box is 16:9 and never under 200px tall (YouTube's minimum embedded-player size), and the play button fills it", () => {
    const box = /<div [^>]*data-testid="replay-box"[^>]*>/.exec(html)?.[0] ?? "";
    expect(box).toMatch(/\baspect-video\b/);
    expect(box).toMatch(/\bmin-h-\[200px\]/);
    expect(box).toMatch(/\bw-full\b/);
    const button = /<button [^>]*data-testid="replay-facade"[^>]*>/.exec(html)?.[0] ?? "";
    expect(button).toMatch(/\babsolute\b/);
    expect(button).toMatch(/\binset-0\b/);
  });

  it("carries no YouTube logo on the facade (the logo only ever sits inside a link to YouTube content); the probe can see a logo when there is one", () => {
    expect(html).not.toContain("data-youtube-icon");
    expect(html).not.toContain("#FF0000");
    expect(html).not.toContain("M27.9727");
    // Positive pair: the same probes DO fire on the real icon, so their silence above is a fact about the facade.
    const logo = renderToStaticMarkup(<YoutubeIcon size="sm" />);
    expect(logo).toContain("data-youtube-icon");
    expect(logo).toContain("#FF0000");
    expect(logo).toContain("M27.9727");
  });

  it("the region is named and the thumbnail is decorative, the play button is named by its visible words", () => {
    expect(html).toMatch(/<section [^>]*aria-label="Match replay"/);
    expect(/<img [^>]*>/.exec(html)?.[0]).toContain('alt=""');
  });
});

describe("ReplayEmbed: two or more parts are tabs, in order", () => {
  const html = embed([P1, P2]);

  it("renders Part 1 then Part 2 as a tablist of 44px tabs, Part 1 selected", () => {
    expect(html).toMatch(/role="tablist"/);
    const tabs = [...html.matchAll(/<button [^>]*role="tab"[^>]*>(.*?)<\/button>/g)];
    expect(tabs.map((m) => m[1]!.replace(/<[^>]+>/g, ""))).toEqual([copy("en", "streaming.youtube.part", { n: 1 }), copy("en", "streaming.youtube.part", { n: 2 })]);
    expect(tabs[0]![0]).toContain('aria-selected="true"');
    expect(tabs[1]![0]).toContain('aria-selected="false"');
    for (const t of tabs) expect(t[0], "44px target").toMatch(/\bmin-h-11\b/);
    // Roving tabindex: exactly one tab stop on the rail, the selected tab.
    expect(tabs[0]![0]).toContain('tabindex="0"');
    expect(tabs[1]![0]).toContain('tabindex="-1"');
  });

  it("the facade, thumbnail and 'Open on YouTube' belong to the SELECTED part (Part 1), and Part 2's video appears nowhere yet", () => {
    expect(html).toContain(`src="https://i.ytimg.com/vi/${ID1}/hqdefault.jpg"`);
    expect(/<a [^>]*data-testid="replay-open"[^>]*>/.exec(html)![0]).toContain(`href="${P1.url}"`);
    expect(html).not.toContain(ID2);
    expect(html, "still click-to-play").not.toContain("<iframe");
  });

  it("the active tab controls the panel and the panel is labelled by that tab", () => {
    const tab = /<button [^>]*role="tab"[^>]*aria-selected="true"[^>]*>/.exec(html)?.[0] ?? /<button [^>]*aria-selected="true"[^>]*role="tab"[^>]*>/.exec(html)?.[0] ?? "";
    const controls = /aria-controls="([^"]+)"/.exec(tab)?.[1];
    const tabId = /\bid="([^"]+)"/.exec(tab)?.[1];
    expect(controls, "the active tab names its panel").toBeTruthy();
    expect(tabId).toBeTruthy();
    const panel = new RegExp(`<div [^>]*id="${controls!.replace(/[:]/g, "\\:")}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(panel).toContain('role="tabpanel"');
    expect(panel).toContain(`aria-labelledby="${tabId}"`);
  });

  it("three parts give three tabs in the order given", () => {
    const three = embed([P1, P2, P3]);
    expect([...three.matchAll(/role="tab"/g)]).toHaveLength(3);
    expect([three.indexOf("Part 1"), three.indexOf("Part 2"), three.indexOf("Part 3")]).toEqual([...[three.indexOf("Part 1"), three.indexOf("Part 2"), three.indexOf("Part 3")]].sort((a, b) => a - b));
    expect(three.indexOf("Part 3")).toBeGreaterThan(0);
  });

  it("the tab carries the PART's own number, not its position (a gap in the numbering is not renumbered)", () => {
    const gap = embed([P1, P3]);
    expect(gap).toContain(copy("en", "streaming.youtube.part", { n: 3 }));
    expect(gap).not.toContain(copy("en", "streaming.youtube.part", { n: 2 }));
  });
});

describe("ReplayEmbed: nothing to play, and the link fallback", () => {
  it("no parts renders nothing at all (an empty list is not an empty player)", () => {
    expect(embed([])).toBe("");
    // Positive pair: one part renders.
    expect(embed([P1])).not.toBe("");
  });

  it("a part with no provable video id is the link, never an iframe: the fallback note and the link, no facade, no thumbnail", () => {
    const html = embed([CHANNEL_ONLY]);
    expect(html).toContain('data-testid="replay-unavailable"');
    expect(html).toContain(esc(copy("en", "streaming.youtube.replay.unavailable")));
    expect(html).not.toContain('data-testid="replay-facade"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
    expect(/<a [^>]*data-testid="replay-open"[^>]*>/.exec(html)![0]).toContain(`href="${CHANNEL_ONLY.url}"`);
  });

  it("a part that is not a YouTube address at all is neither embedded nor linked as 'Open on YouTube'", () => {
    for (const url of ["https://example.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "http://www.youtube.com/watch?v=dQw4w9WgXcQ"]) {
      const html = embed([{ partNo: 1, url }]);
      expect(html, url).not.toContain("<iframe");
      expect(html, url).not.toContain(`href="${url}"`);
    }
  });
});

describe("ReplayStage: each state of the player box", () => {
  const stage = (mode: ReplayMode, over: Partial<React.ComponentProps<typeof ReplayStage>> = {}) =>
    render(
      <ReplayStage
        part={P1} mode={mode} multi={false} pageOrigin="https://seazn.club"
        onPlay={() => {}} iframeRef={{ current: null }} onFrameLoad={() => {}}
        {...over}
      />,
    );

  it("facade: the button, the thumbnail and the words; no iframe", () => {
    const html = stage("facade");
    expect(html).toContain('data-testid="replay-facade"');
    expect(html).not.toContain("<iframe");
  });

  it("playing: the privacy-enhanced iframe at the part's video, titled, allowed to autoplay and go fullscreen - and no facade over it", () => {
    const html = stage("playing");
    const iframe = /<iframe [^>]*>/.exec(html)?.[0] ?? "";
    expect(iframe, "the player mounts").not.toBe("");
    const src = new URL(/src="([^"]+)"/.exec(iframe)![1]!.replaceAll("&amp;", "&"));
    expect(src.origin).toBe("https://www.youtube-nocookie.com");
    expect(src.pathname).toBe(`/embed/${ID1}`);
    expect(src.searchParams.get("autoplay"), "autoplay only because the person just tapped").toBe("1");
    expect(src.searchParams.get("origin")).toBe("https://seazn.club");
    expect(iframe).toContain(`title="${copy("en", "streaming.youtube.replay.playerTitle")}"`);
    expect(iframe).toMatch(/allow="[^"]*\bautoplay\b[^"]*"/);
    expect(iframe).toMatch(/\ballowfullscreen\b/i);
    expect(html, "nothing overlays the player or its controls").not.toContain('data-testid="replay-facade"');
    expect(html).not.toContain("replay-scrim");
    expect(html).not.toContain("<img");
  });

  it("playing a part of several is titled with its number; a single part's title has none", () => {
    const multi = stage("playing", { part: P2, multi: true });
    expect(multi).toContain(`title="${copy("en", "streaming.youtube.replay.playerTitlePart", { n: 2 })}"`);
    expect(multi).toContain(`/embed/${ID2}`);
    expect(stage("playing")).not.toContain("title=\"Match replay, part");
  });

  it("unavailable: the note and the link in place of the player - no iframe, no facade", () => {
    const html = stage("unavailable");
    expect(html).toContain(esc(copy("en", "streaming.youtube.replay.unavailable")));
    expect(html).toContain('data-testid="replay-open"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain('data-testid="replay-facade"');
  });

  it("refuses to mount a player for a part with no provable video id even when told it is playing", () => {
    const html = stage("playing", { part: CHANNEL_ONLY });
    expect(html).not.toContain("<iframe");
    expect(html).toContain('data-testid="replay-unavailable"');
  });
});

describe("the words come from the dictionary of the page's own language", () => {
  for (const locale of ["es", "fr", "nl"] as const) {
    it(`${locale}: facade, link, tabs and region are that locale's words, not English`, () => {
      const html = embed([P1, P2], locale);
      for (const key of ["streaming.youtube.replay.play", "streaming.youtube.replay.open", "streaming.youtube.replay.tabs", "streaming.youtube.replay.region"]) {
        expect(copy(locale, key), `premise: ${key} differs from English in ${locale}`).not.toBe(copy("en", key));
        expect(html, key).toContain(copy(locale, key));
        expect(html, `${key} in English`).not.toContain(copy("en", key));
      }
      expect(html).toContain(copy(locale, "streaming.youtube.part", { n: 1 }));
      expect(html).toContain(copy(locale, "streaming.youtube.part", { n: 2 }));
    });
  }
});
