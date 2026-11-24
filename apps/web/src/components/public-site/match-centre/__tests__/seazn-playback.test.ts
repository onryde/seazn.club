// Seazn-hosted video, Phase 1 Task 15: the player's playback controller (`createPlayback`), the part of `<SeaznPlayer>` that decides
// HOW a signed HLS address reaches the one `<video>`. `apps/web` vitest has no DOM, so the element is a scripted stand-in and
// hls.js is a recording fake (`vi.mock("hls.js")`, reached through the controller's own dynamic import, so the real wiring runs);
// the DOM facts (one element across a refresh, a real swap in a real browser) are the e2e's (public-fixture.spec.ts).
//
// What must hold (the plan's Interfaces, and the lifecycle the owner set 2026-11-21: a token lapses, so the source is swapped):
//   - one Hls instance, one `attachMedia` and ONE `loadSource` per element, ever: a refreshed address is only a new token, swapped
//     into every later request by `xhrSetup`. The real library's `loadSource` of a different address detaches the media and leaves
//     the element paused (hls.ts 551-560, buffer-controller.ts 604-609), and the fake below does the same, so a controller that
//     reloaded on a refresh stops the picture here as it would in a browser;
//   - hls.js is a worker-less instance (`enableWorker: false`) that fetches no media until the viewer presses play;
//   - a browser that plays HLS itself (`canPlayType`) never loads hls.js at all and swaps through `video.src`;
//   - a fatal error, an unsupported browser, or a bundle that will not load reaches `onFatal`, once, and nothing throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type XhrSetup = (xhr: { open: (method: string, url: string, async: boolean) => void }, url: string) => void;
interface FakeHlsInstance {
  config: { enableWorker?: boolean; autoStartLoad?: boolean; capLevelToPlayerSize?: boolean; startPosition: number; xhrSetup?: XhrSetup };
  startLevel: number;
  calls: string[];
  loadedAt: { src: string; autoStartLoad: boolean | undefined }[];
  handlers: Map<string, (event: string, data: unknown) => void>;
  loadSource: (src: string) => void;
}
const hls = vi.hoisted(() => ({ instances: [] as FakeHlsInstance[], supported: true, isSupportedCalls: 0 }));
vi.mock("hls.js", () => {
  class FakeHls implements FakeHlsInstance {
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    static isSupported() {
      hls.isSupportedCalls++;
      return hls.supported;
    }
    config: FakeHlsInstance["config"];
    calls: string[] = [];
    loadedAt: FakeHlsInstance["loadedAt"] = [];
    handlers = new Map<string, (event: string, data: unknown) => void>();
    loadedSrc: string | null = null;
    // hls.js: -1 until set (config.startLevel unset); a set is recorded in `calls` so its order against `startLoad` is visible.
    private _startLevel = -1;
    get startLevel() {
      return this._startLevel;
    }
    set startLevel(n: number) {
      this.calls.push(`startLevel:${n}`);
      this._startLevel = n;
    }
    constructor(config: { enableWorker?: boolean; autoStartLoad?: boolean; capLevelToPlayerSize?: boolean; xhrSetup?: XhrSetup }) {
      this.config = { startPosition: -1, ...config };
      hls.instances.push(this);
    }
    attachMedia(el: unknown) {
      this.calls.push(`attachMedia:${el === currentVideo ? "video" : "other"}`);
    }
    loadSource(src: string) {
      this.calls.push(`loadSource:${src}`);
      this.loadedAt.push({ src, autoStartLoad: this.config.autoStartLoad });
      // hls.ts 551-560: a DIFFERENT address detaches and re-attaches the media; buffer-controller.ts 604-609 removes the element's src
      // and calls load(), which by the HTML load algorithm resets the time and pauses the element. Nothing plays it again.
      if (this.loadedSrc !== null && this.loadedSrc !== src) {
        currentVideo.paused = true;
        currentVideo.currentTime = 0;
      }
      this.loadedSrc = src;
    }
    startLoad(position?: number) {
      this.calls.push(`startLoad:${position ?? ""}`);
    }
    destroy() {
      this.calls.push("destroy");
    }
    on(event: string, handler: (event: string, data: unknown) => void) {
      this.handlers.set(event, handler);
    }
  }
  return { default: FakeHls };
});

import { createPlayback } from "../seazn-playback";

const HLS_MIME = "application/vnd.apple.mpegurl";
const A = "https://playback.fake.invalid/tokenA/manifest/video.m3u8";
const B = "https://playback.fake.invalid/tokenB/manifest/video.m3u8";
const C = "https://playback.fake.invalid/tokenC/manifest/video.m3u8";
/** What hls.js asks for under the loaded manifest's token: a rendition's playlist and a segment (resolved against the manifest). */
const underToken = (token: string, path: string) => `https://playback.fake.invalid/${token}/${path}`;
/** The element hls.js opens a request on, as far as the hook touches it. */
const xhr = () => {
  const opened: [string, string, boolean][] = [];
  return { opened, open: (method: string, url: string, async: boolean) => void opened.push([method, url, async]) };
};

/** The element, as far as the controller touches it. */
class FakeVideo {
  native = false;
  currentTime = 0;
  duration = Number.NaN;
  /** The element's rendered height in CSS px (0 = not laid out). */
  clientHeight = 0;
  paused = true;
  ended = false;
  src = "";
  plays = 0;
  listeners = new Map<string, Set<() => void>>();
  canPlayType = vi.fn((mime: string) => (this.native && mime === HLS_MIME ? "maybe" : ""));
  addEventListener = vi.fn((type: string, fn: () => void) => {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  });
  removeEventListener = vi.fn((type: string, fn: () => void) => this.listeners.get(type)?.delete(fn));
  play = vi.fn(async () => {
    this.plays++;
  });
  fire(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}
let currentVideo: FakeVideo;
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};
function make(opts: { native?: boolean } = {}) {
  currentVideo = new FakeVideo();
  currentVideo.native = opts.native ?? false;
  const onFatal = vi.fn();
  const playback = createPlayback(currentVideo as unknown as HTMLVideoElement, { onFatal });
  return { video: currentVideo, onFatal, playback };
}

beforeEach(() => {
  hls.instances.length = 0;
  hls.supported = true;
  hls.isSupportedCalls = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createPlayback: hls.js (a browser that does not play HLS itself)", () => {
  it("EMPTY CASE FIRST: with no source nothing is built, and disposing is safe", async () => {
    const { playback } = make();
    await flush();
    expect(hls.instances, "no source, no hls.js instance").toHaveLength(0);
    expect(() => playback.dispose()).not.toThrow();
  });

  it("the first source builds ONE worker-less instance, attaches the element and loads the manifest, fetching no media yet", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    expect(hls.instances).toHaveLength(1);
    const [h] = hls.instances;
    expect(h!.config.enableWorker, "no web worker").toBe(false);
    expect(h!.config.autoStartLoad, "no media is fetched before the viewer presses play").toBe(false);
    expect(h!.calls).toEqual(["attachMedia:video", `loadSource:${A}`]);
    expect(video.src, "hls.js owns the element's own src (a MediaSource); the controller never writes it").toBe("");
    playback.dispose();
  });

  it("PREMISE: the fake is as strict as the library: loading a DIFFERENT address pauses and rewinds the element, the same one does not", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    const h = hls.instances[0]!;
    video.paused = false;
    video.currentTime = 42.5;
    h.loadSource(A);
    expect(video.paused, "the same address leaves the element alone").toBe(false);
    h.loadSource(B);
    expect(video.paused, "a different address pauses it").toBe(true);
    expect(video.currentTime, "and rewinds it").toBe(0);
    playback.dispose();
  });

  it("a refreshed address is NOT a load: one instance, one attach, ONE loadSource, no destroy, and a playing element keeps playing where it was", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    video.fire("play");
    video.paused = false;
    video.currentTime = 42.5;
    playback.setSource(B);
    await flush();
    expect(hls.instances, "still one instance").toHaveLength(1);
    const h = hls.instances[0]!;
    expect(h.calls.filter((c) => c === "destroy"), "never destroyed by a refresh").toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("attachMedia")), "attached once").toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith("loadSource")), "the manifest is loaded once, under the first token").toEqual([`loadSource:${A}`]);
    expect(video.paused, "still playing").toBe(false);
    expect(video.currentTime, "at the same place").toBe(42.5);
    playback.dispose();
  });

  it("every request after a refresh goes out under the NEWEST token: manifest, rendition playlist and segment shapes, and each refresh replaces the last", async () => {
    const { playback } = make();
    playback.setSource(A);
    await flush();
    const setup = hls.instances[0]!.config.xhrSetup;
    expect(setup, "premise: the instance is given a request hook").toBeTypeOf("function");
    const shapes = ["manifest/video.m3u8", "manifest/stream_1/video.m3u8?_HLS_msn=12", "video/stream_1/seg_12.ts", "audio/init.mp4#t=0"];
    const open = (token: string, path: string) => {
      const x = xhr();
      setup!(x, underToken(token, path));
      expect(x.opened, `${path}: opened once`).toHaveLength(1);
      return x.opened[0]!;
    };
    let checked = 0;
    for (const path of shapes) {
      // Before any refresh the first token is the token: nothing is rewritten.
      expect(open("tokenA", path), path).toEqual(["GET", underToken("tokenA", path), true]);
      checked++;
    }
    playback.setSource(B);
    for (const path of shapes) {
      expect(open("tokenA", path), `${path} after the first refresh`).toEqual(["GET", underToken("tokenB", path), true]);
      checked++;
    }
    playback.setSource(C);
    for (const path of shapes) {
      // A URL still built from the FIRST token and one built from the second both go out under the third.
      expect(open("tokenA", path), `${path} (first-token URL)`).toEqual(["GET", underToken("tokenC", path), true]);
      expect(open("tokenB", path), `${path} (second-token URL)`).toEqual(["GET", underToken("tokenC", path), true]);
      checked += 2;
    }
    expect(checked, "anti-vacuity: every shape checked at every stage").toBe(shapes.length * 4);
    expect(hls.instances[0]!.calls.filter((c) => c.startsWith("loadSource"))).toEqual([`loadSource:${A}`]);
    playback.dispose();
  });

  it("a request to any other host is passed through untouched, whatever token is held", async () => {
    const { playback } = make();
    playback.setSource(A);
    await flush();
    playback.setSource(B);
    const x = xhr();
    hls.instances[0]!.config.xhrSetup!(x, "https://elsewhere.example/tokenA/manifest/video.m3u8");
    expect(x.opened).toEqual([["GET", "https://elsewhere.example/tokenA/manifest/video.m3u8", true]]);
    playback.dispose();
  });

  it("a refresh before the bundle arrives: one load, of the newest address, and its requests go out under it", async () => {
    const { playback } = make();
    playback.setSource(A);
    playback.setSource(B);
    await flush();
    const h = hls.instances[0]!;
    expect(h.calls.filter((c) => c.startsWith("loadSource"))).toEqual([`loadSource:${B}`]);
    const x = xhr();
    h.config.xhrSetup!(x, underToken("tokenA", "video/seg_1.ts"));
    expect(x.opened[0]![1]).toBe(underToken("tokenB", "video/seg_1.ts"));
    playback.dispose();
  });

  it("an address with no token to read (the signer changed shape) is onFatal at once, with no instance and no load", async () => {
    const { playback, onFatal } = make();
    playback.setSource("https://playback.fake.invalid");
    await flush();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(hls.instances, "nothing built for an address that cannot be refreshed").toHaveLength(0);
    playback.dispose();
  });

  it("a refresh to an address with no token to read is onFatal too, and the one load stays the one load", async () => {
    const { playback, onFatal } = make();
    playback.setSource(A);
    await flush();
    expect(onFatal).not.toHaveBeenCalled();
    playback.setSource("not an address");
    await flush();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(hls.instances[0]!.calls.filter((c) => c.startsWith("loadSource"))).toEqual([`loadSource:${A}`]);
    playback.dispose();
  });

  it("the same address again (a re-render) loads nothing", async () => {
    const { playback } = make();
    playback.setSource(A);
    await flush();
    playback.setSource(A);
    await flush();
    expect(hls.instances[0]!.calls.filter((c) => c.startsWith("loadSource"))).toEqual([`loadSource:${A}`]);
    playback.dispose();
  });

  it("two addresses before the bundle has loaded: only the newest is loaded, on one instance", async () => {
    const { playback } = make();
    playback.setSource(A);
    playback.setSource(B);
    await flush();
    expect(hls.instances).toHaveLength(1);
    expect(hls.instances[0]!.calls.filter((c) => c.startsWith("loadSource"))).toEqual([`loadSource:${B}`]);
    playback.dispose();
  });

  it("media is fetched from the first play on: startLoad once, and every later load starts by itself", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    const h = hls.instances[0]!;
    expect(h.calls.some((c) => c.startsWith("startLoad")), "premise: nothing fetched before play").toBe(false);
    video.fire("play");
    expect(h.calls.filter((c) => c.startsWith("startLoad")), "the first play starts the fetch").toHaveLength(1);
    expect(h.config.autoStartLoad).toBe(true);
    video.fire("play");
    expect(h.calls.filter((c) => c.startsWith("startLoad")), "a second play (resume after a pause) is not a second start").toHaveLength(1);
    playback.setSource(B);
    await flush();
    expect(h.calls.filter((c) => c.startsWith("startLoad")), "a refresh after play starts nothing either").toHaveLength(1);
    expect(h.loadedAt, "and loads nothing: the one load was the first").toHaveLength(1);
    playback.dispose();
  });

  it("a play pressed before the bundle arrived still starts the fetch once it has", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    video.fire("play");
    await flush();
    const h = hls.instances[0]!;
    expect(h.config.autoStartLoad, "built already started").toBe(true);
    expect(h.calls).toEqual(["attachMedia:video", `loadSource:${A}`]);
    playback.dispose();
  });

  it("a FATAL hls.js error reaches onFatal; a non-fatal one does not", async () => {
    const { playback, onFatal } = make();
    playback.setSource(A);
    await flush();
    const raise = hls.instances[0]!.handlers.get("hlsError");
    expect(raise, "premise: the controller listens for hls.js errors").toBeTypeOf("function");
    raise!("hlsError", { fatal: false });
    expect(onFatal).not.toHaveBeenCalled();
    raise!("hlsError", { fatal: true });
    expect(onFatal).toHaveBeenCalledTimes(1);
    playback.dispose();
  });

  it("a browser hls.js cannot run in: onFatal, and no instance", async () => {
    hls.supported = false;
    const { playback, onFatal } = make();
    playback.setSource(A);
    await flush();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(hls.instances).toHaveLength(0);
    playback.dispose();
  });

  it("dispose destroys the instance once and removes every listener; a later source does nothing", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    expect(video.listenerCount(), "premise: the controller listens on the element").toBeGreaterThan(0);
    playback.dispose();
    expect(hls.instances[0]!.calls.filter((c) => c === "destroy")).toHaveLength(1);
    expect(video.listenerCount(), "no listener left on the element").toBe(0);
    playback.setSource(B);
    await flush();
    expect(hls.instances[0]!.calls.filter((c) => c.startsWith("loadSource"))).toEqual([`loadSource:${A}`]);
    playback.dispose();
    expect(hls.instances[0]!.calls.filter((c) => c === "destroy"), "disposing twice destroys once").toHaveLength(1);
  });

  it("dispose before the bundle arrived builds nothing", async () => {
    const { playback } = make();
    playback.setSource(A);
    playback.dispose();
    await flush();
    expect(hls.instances).toHaveLength(0);
  });
});

// Task 42: the player is told its own size. The rung table, the box and the pixel ratio below are the test's own; the expected rung is
// read off the table (the tallest rung that fits the box in device pixels), never off the helper (seazn-player-config.test.ts sweeps it).
describe("createPlayback: the rung the player starts on (hls.js)", () => {
  const LEVELS = [240, 360, 480, 720, 1080].map((height, i) => ({ height, bitrate: (i + 1) * 500_000 }));
  const parsed = (h: FakeHlsInstance, levels = LEVELS) => h.handlers.get("hlsManifestParsed")!("hlsManifestParsed", { levels });
  const fit = (deviceHeight: number) => LEVELS.map((l, i) => ({ l, i })).filter(({ l }) => l.height <= deviceHeight).at(-1)?.i ?? -1;

  it("EMPTY CASE FIRST: a manifest with no rungs leaves hls.js to choose (nothing is written to startLevel)", async () => {
    const { playback, video } = make();
    video.clientHeight = 360;
    playback.setSource(A);
    await flush();
    parsed(hls.instances[0]!, []);
    expect(hls.instances[0]!.calls.filter((c) => c.startsWith("startLevel:"))).toEqual([]);
    expect(hls.instances[0]!.startLevel, "still hls.js's own -1").toBe(-1);
    playback.dispose();
  });

  it("the instance is built with its rung capped to the player's box", async () => {
    const { playback } = make();
    playback.setSource(A);
    await flush();
    expect(hls.instances[0]!.config.capLevelToPlayerSize).toBe(true);
    playback.dispose();
  });

  it("the start rung follows the box x pixel ratio, and is set BEFORE the first play starts loading", async () => {
    let checked = 0;
    const seen = new Set<number>();
    for (const [height, dpr] of [[200, 1], [200, 3], [394, 1], [394, 2], [450, 3]] as const) {
      hls.instances.length = 0;
      vi.stubGlobal("devicePixelRatio", dpr);
      const { playback, video } = make();
      video.clientHeight = height;
      playback.setSource(A);
      await flush();
      const h = hls.instances[0]!;
      parsed(h);
      video.fire("play");
      expect(h.startLevel, `box ${height}px at dpr ${dpr}`).toBe(Math.max(0, fit(height * dpr)));
      const order = h.calls.filter((c) => c.startsWith("startLevel:") || c.startsWith("startLoad:"));
      expect(order, "the rung is chosen, then loading starts").toEqual([`startLevel:${h.startLevel}`, "startLoad:"]);
      seen.add(h.startLevel);
      checked++;
      playback.dispose();
    }
    expect(checked).toBe(5);
    expect(seen.size, "the start rung moves with the box (a constant 0 cannot pass)").toBeGreaterThan(2);
  });

  it("a box that is not laid out yet (height 0) does not pin a rung", async () => {
    const { playback, video } = make();
    video.clientHeight = 0;
    playback.setSource(A);
    await flush();
    parsed(hls.instances[0]!);
    expect(hls.instances[0]!.calls.some((c) => c.startsWith("startLevel:"))).toBe(false);
    playback.dispose();
  });

  it("the T15 seam survives a level switch: after the rung is chosen and a rendition playlist is asked for, a refresh still swaps the token of every later request, and nothing is reloaded", async () => {
    const { playback, video } = make();
    video.clientHeight = 394;
    playback.setSource(A);
    await flush();
    const h = hls.instances[0]!;
    parsed(h);
    video.fire("play");
    const setup = h.config.xhrSetup!;
    const open = (token: string, path: string) => {
      const x = xhr();
      setup(x, underToken(token, path));
      return x.opened[0]![1];
    };
    // A rendition on the start rung, then the ABR's switch to another: both before and after a refresh, under the newest token.
    expect(open("tokenA", "manifest/stream_4/video.m3u8")).toBe(underToken("tokenA", "manifest/stream_4/video.m3u8"));
    playback.setSource(B);
    let checked = 0;
    for (const path of ["manifest/stream_4/video.m3u8", "manifest/stream_5/video.m3u8", "video/stream_5/seg_1.ts"]) {
      expect(open("tokenA", path), path).toBe(underToken("tokenB", path));
      checked++;
    }
    expect(checked).toBe(3);
    expect(h.calls.filter((c) => c.startsWith("loadSource:")), "the one load").toEqual([`loadSource:${A}`]);
    expect(hls.instances, "one instance").toHaveLength(1);
    playback.dispose();
  });
});

describe("createPlayback: a browser that plays HLS itself", () => {
  it("never loads hls.js: the address goes to video.src, and a swap re-points it", async () => {
    const { playback, video } = make({ native: true });
    playback.setSource(A);
    await flush();
    expect(video.src).toBe(A);
    expect(hls.instances, "hls.js was not used").toHaveLength(0);
    expect(hls.isSupportedCalls).toBe(0);
    playback.setSource(B);
    await flush();
    expect(video.src).toBe(B);
    expect(video.canPlayType).toHaveBeenCalledWith(HLS_MIME);
    playback.dispose();
  });

  it("the same address again (the island re-rendered with an answer holding it) does not touch a PLAYING element: no write, no listener", async () => {
    const { playback, video } = make({ native: true });
    const writes: string[] = [];
    let current = "";
    Object.defineProperty(video, "src", { get: () => current, set: (v: string) => { current = v; writes.push(v); } });
    playback.setSource(A);
    video.currentTime = 30;
    video.paused = false;
    const listenersBefore = video.listenerCount();
    playback.setSource(A);
    playback.setSource(A);
    expect(writes, "one write: re-pointing a playing element at its own address restarts it").toEqual([A]);
    expect(video.listenerCount(), "and no resume listener is left behind").toBe(listenersBefore);
    expect(video.currentTime).toBe(30);
    playback.dispose();
  });

  it("a swap while playing resumes at the current time and keeps playing", async () => {
    const { playback, video } = make({ native: true });
    playback.setSource(A);
    video.currentTime = 30;
    video.paused = false;
    playback.setSource(B);
    expect(video.listeners.get("loadedmetadata")?.size, "waits for the new manifest before seeking").toBe(1);
    video.currentTime = 0; // the element restarts at the new source
    video.fire("loadedmetadata");
    expect(video.currentTime).toBe(30);
    expect(video.plays).toBe(1);
    expect(video.listeners.get("loadedmetadata")?.size, "the resume listener is one-shot").toBe(0);
    playback.dispose();
  });

  it("a swap of a LIVE source (duration Infinity) keeps playing at the live edge: the old time is not a place in the new load, so nothing seeks", async () => {
    const { playback, video } = make({ native: true });
    playback.setSource(A);
    video.duration = Infinity;
    video.currentTime = 3300; // 55 minutes into the old live timeline
    video.paused = false;
    playback.setSource(B);
    video.currentTime = 0; // the element restarts at the new source
    video.fire("loadedmetadata");
    expect(video.currentTime, "no seek: the new load's own live edge").toBe(0);
    expect(video.plays, "but it keeps playing").toBe(1);
    // The positive pair: a finite recording at the same time DOES go back to it.
    const vod = make({ native: true });
    vod.playback.setSource(A);
    vod.video.duration = 5400;
    vod.video.currentTime = 3300;
    vod.video.paused = false;
    vod.playback.setSource(B);
    vod.video.currentTime = 0;
    vod.video.fire("loadedmetadata");
    expect(vod.video.currentTime, "a recording resumes at the viewer's place").toBe(3300);
    playback.dispose();
    vod.playback.dispose();
  });

  it("a swap while paused (or before anything played) resumes nowhere and starts nothing", async () => {
    const { playback, video } = make({ native: true });
    playback.setSource(A);
    video.currentTime = 0;
    video.paused = true;
    playback.setSource(B);
    video.fire("loadedmetadata");
    expect(video.currentTime).toBe(0);
    expect(video.plays).toBe(0);
    video.currentTime = 20;
    playback.setSource(A);
    video.currentTime = 0;
    video.fire("loadedmetadata");
    expect(video.currentTime, "paused at 20 s: back to 20 s").toBe(20);
    expect(video.plays, "but not started").toBe(0);
    playback.dispose();
  });

  it("an element error reaches onFatal; dispose removes the listeners", async () => {
    const { playback, video, onFatal } = make({ native: true });
    playback.setSource(A);
    video.fire("error");
    expect(onFatal).toHaveBeenCalledTimes(1);
    playback.dispose();
    expect(video.listenerCount()).toBe(0);
  });
});

describe("createPlayback: the hls.js bundle will not load", () => {
  it("onFatal once, nothing throws, and a later source does not retry a bundle that failed", async () => {
    vi.resetModules();
    vi.doMock("hls.js", () => {
      throw new Error("chunk failed to load");
    });
    const { createPlayback: freshPlayback } = await import("../seazn-playback");
    const video = new FakeVideo();
    const onFatal = vi.fn();
    const playback = freshPlayback(video as unknown as HTMLVideoElement, { onFatal });
    playback.setSource(A);
    await flush();
    expect(onFatal).toHaveBeenCalledTimes(1);
    playback.setSource(B);
    await flush();
    expect(onFatal, "the failed bundle is not retried by a later address: no second report").toHaveBeenCalledTimes(1);
    expect(() => playback.dispose()).not.toThrow();
    vi.doUnmock("hls.js");
  });
});
