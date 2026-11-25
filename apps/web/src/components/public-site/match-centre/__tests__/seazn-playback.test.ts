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
//   - hls.js is used wherever `Hls.isSupported()` says so, whatever `canPlayType` says (Task 52: Chrome answers "maybe" and its native
//     player sat ~2 segments behind live); only a browser hls.js cannot run in, and that plays HLS itself, swaps through `video.src`;
//   - a fatal error, an unsupported browser, or a bundle that will not load reaches `onFatal`, once, and nothing throws.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface Rung {
  width: number;
  height: number;
  bitrate: number;
}
type XhrSetup = (xhr: { open: (method: string, url: string, async: boolean) => void }, url: string) => void;
interface FakeHlsInstance {
  config: { enableWorker?: boolean; autoStartLoad?: boolean; capLevelToPlayerSize?: boolean; startPosition: number; xhrSetup?: XhrSetup };
  startLevel: number;
  levels: Rung[];
  autoLevelCapping: number;
  calls: string[];
  loadedAt: { src: string; autoStartLoad: boolean | undefined }[];
  handlers: Map<string, (event: string, data: unknown) => void>;
  loadSource: (src: string) => void;
}
const hls = vi.hoisted(() => ({
  instances: [] as FakeHlsInstance[],
  supported: true,
  isSupportedCalls: 0,
  /** Runs inside `isSupported()`: the one point between "the bundle arrived" and "the path is set" where a test can dispose the controller. */
  duringIsSupported: null as (() => void) | null,
  /** The constructor throws (a config hls.js refuses, a browser it cannot attach to). */
  throwOnNew: false,
  /** hls.js's own cap rule (`CapLevelController.getMaxLevelByMediaSize`), the REAL library's, filled in by the mock factory. */
  capRule: null as unknown as (levels: unknown[], width: number, height: number) => number,
}));
vi.mock("hls.js", async () => {
  hls.capRule = (await vi.importActual<typeof import("hls.js")>("hls.js")).CapLevelController.getMaxLevelByMediaSize as never;
  class FakeHls implements FakeHlsInstance {
    static Events = { ERROR: "hlsError", MANIFEST_PARSED: "hlsManifestParsed" };
    static isSupported() {
      hls.isSupportedCalls++;
      hls.duringIsSupported?.();
      return hls.supported;
    }
    config: FakeHlsInstance["config"];
    calls: string[] = [];
    loadedAt: FakeHlsInstance["loadedAt"] = [];
    handlers = new Map<string, (event: string, data: unknown) => void>();
    loadedSrc: string | null = null;
    // hls.js: -1 until set (config.startLevel unset); a set is recorded in `calls` so its order against `startLoad` is visible.
    levels: Rung[] = [];
    // hls.js: -1 until its cap-level-controller computes a cap from the box.
    autoLevelCapping = -1;
    private _startLevel = -1;
    get startLevel() {
      return this._startLevel;
    }
    set startLevel(n: number) {
      this.calls.push(`startLevel:${n}`);
      this._startLevel = n;
    }
    constructor(config: { enableWorker?: boolean; autoStartLoad?: boolean; capLevelToPlayerSize?: boolean; xhrSetup?: XhrSetup }) {
      if (hls.throwOnNew) throw new Error("hls.js refused to start");
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
/** The manifest is parsed: the rungs are known (hls.js's MANIFEST_PARSED), and its cap-level-controller has computed a cap for the box. */
function parseManifest(h: FakeHlsInstance, levels: Rung[] = LEVELS, box?: { width: number; height: number; dpr: number }): void {
  h.levels = levels;
  if (box) resizeBox(h, box);
  h.handlers.get("hlsManifestParsed")!("hlsManifestParsed", { levels });
}
/** The box changes size: hls.js re-computes its cap by its own rule (the real `getMaxLevelByMediaSize`). */
function resizeBox(h: FakeHlsInstance, box: { width: number; height: number; dpr: number }): void {
  h.autoLevelCapping = hls.capRule(h.levels, box.width * box.dpr, box.height * box.dpr);
}
/** A Cloudflare live ladder, 16:9, ascending bandwidth. */
const LEVELS: Rung[] = [240, 360, 480, 720, 1080].map((height, i) => ({ height, width: Math.round((height * 16) / 9 / 2) * 2, bitrate: (i + 1) * 500_000 }));
function make(opts: { native?: boolean; hlsSupported?: boolean } = {}) {
  currentVideo = new FakeVideo();
  currentVideo.native = opts.native ?? false;
  if (opts.hlsSupported !== undefined) hls.supported = opts.hlsSupported;
  const onFatal = vi.fn();
  const onDegraded = vi.fn();
  const playback = createPlayback(currentVideo as unknown as HTMLVideoElement, { onFatal, onDegraded });
  return { video: currentVideo, onFatal, onDegraded, playback };
}

// The mock factory loads the real library for its cap rule; load it once up front so no test's `flush` waits on that first import.
beforeAll(async () => {
  await import("hls.js");
});
beforeEach(() => {
  hls.instances.length = 0;
  hls.supported = true;
  hls.isSupportedCalls = 0;
  hls.duringIsSupported = null;
  hls.throwOnNew = false;
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
    parseManifest(h);
    expect(h.calls.some((c) => c.startsWith("startLoad")), "premise: nothing fetched before play, even with the manifest parsed").toBe(false);
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

  it("a play pressed before the bundle arrived still starts the fetch, once the manifest has parsed", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    video.fire("play");
    await flush();
    const h = hls.instances[0]!;
    expect(h.calls, "built, attached and loading the manifest; no media before the rungs are known").toEqual(["attachMedia:video", `loadSource:${A}`]);
    parseManifest(h);
    expect(h.calls.filter((c) => c.startsWith("startLoad")), "the parse starts the fetch, once").toHaveLength(1);
    expect(h.config.autoStartLoad).toBe(true);
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

// Task 42: the player is told its own size. hls.js's cap-level-controller owns the rule (the first rung whose width OR height reaches
// max(box w, h) x dpr), so the fake computes its cap with the REAL library's `getMaxLevelByMediaSize` (hls.capRule) and the expectation
// is that rule's answer for the box, never this controller's own arithmetic.
describe("createPlayback: the rung the player starts on (hls.js)", () => {
  const startLevels = (h: FakeHlsInstance) => h.calls.filter((c) => c.startsWith("startLevel:"));

  it("EMPTY CASE FIRST: before play nothing is chosen, and with no cap computed yet (-1) hls.js keeps the choice", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    const h = hls.instances[0]!;
    parseManifest(h);
    expect(startLevels(h), "a parse alone chooses nothing").toEqual([]);
    expect(h.autoLevelCapping, "premise: no cap was computed").toBe(-1);
    video.fire("play");
    expect(startLevels(h), "a first play with no cap writes no start level").toEqual([]);
    expect(h.startLevel).toBe(-1);
    expect(h.calls.filter((c) => c.startsWith("startLoad")), "and the fetch still starts").toHaveLength(1);
    playback.dispose();
  });

  it("the instance is built with its rung capped to the player's box", async () => {
    const { playback } = make();
    playback.setSource(A);
    await flush();
    expect(hls.instances[0]!.config.capLevelToPlayerSize).toBe(true);
    playback.dispose();
  });

  it("the first load starts ON hls.js's cap for the box, for every box x pixel ratio, set BEFORE the fetch", async () => {
    let checked = 0;
    const seen = new Set<number>();
    for (const [w, h, dpr] of [[288, 200, 1], [288, 200, 3], [704, 396, 1], [704, 396, 2], [800, 450, 3]] as const) {
      hls.instances.length = 0;
      const { playback, video } = make();
      playback.setSource(A);
      await flush();
      const inst = hls.instances[0]!;
      parseManifest(inst, LEVELS, { width: w, height: h, dpr });
      video.fire("play");
      const expected = hls.capRule(LEVELS, w * dpr, h * dpr);
      expect(inst.startLevel, `box ${w}x${h} at dpr ${dpr}`).toBe(expected);
      expect(inst.calls.filter((c) => c.startsWith("startLevel:") || c.startsWith("startLoad:")), "the rung is chosen, then loading starts").toEqual([`startLevel:${expected}`, "startLoad:"]);
      seen.add(inst.startLevel);
      checked++;
      playback.dispose();
    }
    expect(checked).toBe(5);
    expect(seen.size, "the start rung moves with the box (a constant 0 cannot pass)").toBeGreaterThan(2);
  });

  it("the box is read at the FIRST PLAY, not at the parse: a box that grew in between starts on the new cap", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    const h = hls.instances[0]!;
    parseManifest(h, LEVELS, { width: 288, height: 200, dpr: 1 });
    const atParse = h.autoLevelCapping;
    resizeBox(h, { width: 1200, height: 675, dpr: 2 });
    expect(h.autoLevelCapping, "premise: the cap moved after the parse").toBeGreaterThan(atParse);
    video.fire("play");
    expect(h.startLevel).toBe(h.autoLevelCapping);
    expect(h.startLevel).toBeGreaterThan(atParse);
    playback.dispose();
  });

  it("the T15 seam survives a level switch: after the rung is chosen and a rendition playlist is asked for, a refresh still swaps the token of every later request, and nothing is reloaded", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    const h = hls.instances[0]!;
    parseManifest(h, LEVELS, { width: 704, height: 396, dpr: 1 });
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

describe("createPlayback: a browser that plays HLS itself AND hls.js cannot run in (Task 52: the only way onto the native path)", () => {
  it("builds no hls.js instance: the address goes to video.src, and a swap re-points it", async () => {
    const { playback, video } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    await flush();
    expect(video.src).toBe(A);
    expect(hls.instances, "hls.js was not used").toHaveLength(0);
    expect(hls.isSupportedCalls, "the path was chosen by asking hls.js, once").toBe(1);
    playback.setSource(B);
    await flush();
    expect(video.src).toBe(B);
    expect(video.canPlayType).toHaveBeenCalledWith(HLS_MIME);
    playback.dispose();
  });

  it("the same address again (the island re-rendered with an answer holding it) does not touch a PLAYING element: no write, no listener", async () => {
    const { playback, video } = make({ native: true, hlsSupported: false });
    const writes: string[] = [];
    let current = "";
    Object.defineProperty(video, "src", { get: () => current, set: (v: string) => { current = v; writes.push(v); } });
    playback.setSource(A);
    await flush();
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
    const { playback, video } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    await flush();
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
    const { playback, video } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    await flush();
    video.duration = Infinity;
    video.currentTime = 3300; // 55 minutes into the old live timeline
    video.paused = false;
    playback.setSource(B);
    video.currentTime = 0; // the element restarts at the new source
    video.fire("loadedmetadata");
    expect(video.currentTime, "no seek: the new load's own live edge").toBe(0);
    expect(video.plays, "but it keeps playing").toBe(1);
    // The positive pair: a finite recording at the same time DOES go back to it.
    const vod = make({ native: true, hlsSupported: false });
    vod.playback.setSource(A);
    await flush();
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
    const { playback, video } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    await flush();
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
    const { playback, video, onFatal } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    await flush();
    video.fire("error");
    expect(onFatal).toHaveBeenCalledTimes(1);
    playback.dispose();
    expect(video.listenerCount()).toBe(0);
  });
});

// Task 52 (owner "yes", 2026-11-25): Chrome 157 says canPlayType("application/vnd.apple.mpegurl") === "maybe", which sent it down the
// native path, where none of SEAZN_HLS_PLAYER_CONFIG applies and the picture sat ~6.5 s (about 2 segments) behind newest data. The path is
// now chosen by hls.js's own `isSupported()`, once per controller, before any `src` is written.
describe("createPlayback: the path is chosen by hls.js support, not by canPlayType (Task 52)", () => {
  it("canPlayType says maybe AND hls.js is supported -> the hls.js path: manifest loaded through hls.js, video.src never written", async () => {
    const { playback, video, onFatal } = make({ native: true, hlsSupported: true });
    expect(video.canPlayType(HLS_MIME), "PREMISE: this element says maybe to HLS, as Chrome 157 does").toBe("maybe");
    const writes: string[] = [];
    let current = "";
    Object.defineProperty(video, "src", { get: () => current, set: (v: string) => { current = v; writes.push(v); } });
    playback.setSource(A);
    await flush();
    expect(hls.instances, "one hls.js instance").toHaveLength(1);
    expect(hls.instances[0]!.calls).toEqual(["attachMedia:video", `loadSource:${A}`]);
    expect(writes, "the element's own src is never written on the hls.js path").toEqual([]);
    expect(onFatal).not.toHaveBeenCalled();
    playback.dispose();
  });

  it("canPlayType says maybe but hls.js is NOT supported -> the native path (the plan for that browser, so no degraded report)", async () => {
    const { playback, video, onFatal, onDegraded } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    await flush();
    expect(video.src).toBe(A);
    expect(hls.instances).toHaveLength(0);
    expect(onFatal).not.toHaveBeenCalled();
    expect(onDegraded).not.toHaveBeenCalled();
    playback.dispose();
  });

  it("neither plays it (no HLS of its own, hls.js unsupported) -> today's unsupported outcome: onFatal once, no instance, no src", async () => {
    const { playback, video, onFatal } = make({ native: false, hlsSupported: false });
    playback.setSource(A);
    await flush();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]![0]).toMatchObject({ reason: "unsupported" });
    expect(hls.instances).toHaveLength(0);
    expect(video.src).toBe("");
    playback.setSource(B);
    await flush();
    expect(onFatal, "decided once: a later address does not report again").toHaveBeenCalledTimes(1);
    playback.dispose();
  });

  it("hls.js is asked ONCE per controller, before any src, and the choice holds for every later address", async () => {
    const { playback, video } = make({ native: true, hlsSupported: true });
    playback.setSource(A);
    playback.setSource(B);
    await flush();
    playback.setSource(C);
    await flush();
    expect(hls.isSupportedCalls).toBe(1);
    expect(hls.instances).toHaveLength(1);
    expect(video.src).toBe("");
    playback.dispose();
  });

  it("the choice is made at the first source: a native-capable element with hls.js supported gets the play listener, not the error listener", async () => {
    const { playback, video } = make({ native: true, hlsSupported: true });
    playback.setSource(A);
    await flush();
    expect(video.listeners.get("error")?.size ?? 0, "no element-error listener on the hls.js path").toBe(0);
    expect(video.listeners.get("play")?.size, "the play listener that starts the media fetch").toBe(1);
    playback.dispose();
    expect(video.listenerCount()).toBe(0);
  });

  it("SEQUENCE: after a stop (dispose) the same element gets the same path from a new controller, one attach each, nothing doubled", async () => {
    const first = make({ native: true, hlsSupported: true });
    first.playback.setSource(A);
    await flush();
    const el = first.video;
    first.playback.dispose();
    expect(el.listenerCount(), "the stopped controller left nothing on the element").toBe(0);
    // A second play on the SAME element: a new controller (the island's effect re-ran), a fresh address.
    currentVideo = el;
    const onFatal = vi.fn();
    const second = createPlayback(el as unknown as HTMLVideoElement, { onFatal });
    second.setSource(B);
    await flush();
    expect(hls.instances, "one instance per controller, no extra").toHaveLength(2);
    expect(hls.instances.map((h) => h.calls.filter((c) => c.startsWith("attachMedia")).length), "each attached once").toEqual([1, 1]);
    expect(hls.instances[0]!.calls.filter((c) => c === "destroy")).toHaveLength(1);
    expect(hls.instances[1]!.calls).toEqual(["attachMedia:video", `loadSource:${B}`]);
    expect(el.src, "still never the element's own src").toBe("");
    expect(el.listeners.get("play")?.size, "one play listener, not two").toBe(1);
    expect(onFatal).not.toHaveBeenCalled();
    second.dispose();
    expect(el.listenerCount()).toBe(0);
  });

  it("the native path keeps its own listeners: an element error, and no play listener", async () => {
    const { playback, video } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    await flush();
    expect(video.listeners.get("error")?.size).toBe(1);
    expect(video.listeners.get("play")?.size ?? 0).toBe(0);
    playback.dispose();
    expect(video.listenerCount()).toBe(0);
  });
});

// Task 52 fix round 1: guards the first build left unwitnessed, and the failure shapes the async decision opened.
describe("createPlayback: a controller stopped mid-decision, a refused start, a tap before the source (Task 52 fix round 1)", () => {
  it("dispose BEFORE the bundle arrives, in a browser hls.js cannot run in that plays HLS itself: no listener, no src, no report (the decide guard)", async () => {
    const { playback, video, onFatal } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    playback.dispose();
    await flush();
    expect(video.listenerCount(), "nothing was put on an element this controller no longer owns").toBe(0);
    expect(video.src).toBe("");
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("dispose before the bundle arrives, in a browser that plays no HLS and hls.js cannot run in: the unsupported report is not made for a stopped controller", async () => {
    const { playback, onFatal } = make({ native: false, hlsSupported: false });
    playback.setSource(A);
    playback.dispose();
    await flush();
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("dispose BETWEEN the support answer and the first apply: no instance is built for a stopped controller (the apply guard)", async () => {
    const { playback } = make({ hlsSupported: true });
    hls.duringIsSupported = () => playback.dispose();
    playback.setSource(A);
    await flush();
    expect(hls.isSupportedCalls, "premise: the hook ran, so the dispose really came mid-decision").toBe(1);
    expect(hls.instances, "no instance for a stopped controller").toHaveLength(0);
  });

  it("the same, on the native path: nothing is written to the element of a stopped controller", async () => {
    const { playback, video } = make({ native: true, hlsSupported: false });
    hls.duringIsSupported = () => playback.dispose();
    playback.setSource(A);
    await flush();
    expect(hls.isSupportedCalls, "premise: the hook ran").toBe(1);
    expect(video.src).toBe("");
  });

  it("two addresses before the decision, on the native path: the element's src is written ONCE, with the newest (the nativeSrc dedupe)", async () => {
    const { playback, video } = make({ native: true, hlsSupported: false });
    const writes: string[] = [];
    let current = "";
    Object.defineProperty(video, "src", { get: () => current, set: (v: string) => { current = v; writes.push(v); } });
    playback.setSource(A);
    playback.setSource(B);
    await flush();
    expect(writes).toEqual([B]);
    playback.dispose();
  });

  it("two unreadable addresses before the decision: one onFatal for the newest, not one per queued apply", async () => {
    const { playback, onFatal } = make();
    playback.setSource("not an address");
    playback.setSource("still not an address");
    await flush();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]![0]).toMatchObject({ reason: "unsigned" });
    playback.dispose();
  });

  it("a start hls.js refuses (the constructor throws) reaches onFatal once, as an unsupported browser, with no instance and nothing unhandled; a later address does not retry", async () => {
    const { playback, onFatal } = make();
    hls.throwOnNew = true;
    playback.setSource(A);
    await flush();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]![0]).toMatchObject({ reason: "unsupported" });
    expect(hls.instances).toHaveLength(0);
    hls.throwOnNew = false;
    playback.setSource(B);
    await flush();
    expect(hls.instances, "a controller whose start was refused is not retried").toHaveLength(0);
    expect(onFatal).toHaveBeenCalledTimes(1);
    playback.dispose();
  });

  it("a play tapped while the bundle is still on its way is not lost on the native fallback: the source is set, then played, once", async () => {
    const { playback, video } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    video.fire("play"); // the viewer taps play on a still source-less element
    await flush();
    expect(video.src).toBe(A);
    expect(video.plays, "played once the source was there").toBe(1);
    playback.dispose();
  });

  it("and with no tap, the native fallback starts nothing", async () => {
    const { playback, video } = make({ native: true, hlsSupported: false });
    playback.setSource(A);
    await flush();
    expect(video.src).toBe(A);
    expect(video.plays).toBe(0);
    playback.setSource(B);
    expect(video.plays, "a later swap of a paused element starts nothing").toBe(0);
    playback.dispose();
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

  it("a browser that plays HLS itself falls back to its own player when the bundle will not load (no onFatal)", async () => {
    vi.resetModules();
    vi.doMock("hls.js", () => {
      throw new Error("chunk failed to load");
    });
    const { createPlayback: freshPlayback } = await import("../seazn-playback");
    const video = new FakeVideo();
    video.native = true;
    const onFatal = vi.fn();
    const playback = freshPlayback(video as unknown as HTMLVideoElement, { onFatal });
    playback.setSource(A);
    await flush();
    expect(video.src).toBe(A);
    expect(onFatal).not.toHaveBeenCalled();
    playback.dispose();
    vi.doUnmock("hls.js");
  });

  it("that fallback is REPORTED, once, as a degraded player with the bundle's code (never an address); a stopped controller reports nothing", async () => {
    vi.resetModules();
    vi.doMock("hls.js", () => {
      throw new Error("chunk failed to load");
    });
    const { createPlayback: freshPlayback } = await import("../seazn-playback");
    const failing = new FakeVideo();
    failing.native = true;
    const onFatal = vi.fn();
    const onDegraded = vi.fn();
    const playback = freshPlayback(failing as unknown as HTMLVideoElement, { onFatal, onDegraded });
    playback.setSource(A);
    await flush();
    playback.setSource(B);
    await flush();
    expect(onDegraded).toHaveBeenCalledTimes(1);
    expect(onDegraded.mock.calls[0]![0]).toEqual({ reason: "bundle", hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null });
    expect(onFatal).not.toHaveBeenCalled();
    playback.dispose();
    const stopped = new FakeVideo();
    stopped.native = true;
    const onDegraded2 = vi.fn();
    const p2 = freshPlayback(stopped as unknown as HTMLVideoElement, { onFatal, onDegraded: onDegraded2 });
    p2.setSource(A);
    p2.dispose();
    await flush();
    expect(onDegraded2, "no report for a stopped controller (the catch guard)").not.toHaveBeenCalled();
    vi.doUnmock("hls.js");
  });
});
