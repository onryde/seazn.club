// Seazn-hosted video, Phase 1 Task 15: the player's playback controller (`createPlayback`), the part of `<SeaznPlayer>` that decides
// HOW a signed HLS address reaches the one `<video>`. `apps/web` vitest has no DOM, so the element is a scripted stand-in and
// hls.js is a recording fake (`vi.mock("hls.js")`, reached through the controller's own dynamic import, so the real wiring runs);
// the DOM facts (one element across a refresh, a real swap in a real browser) are the e2e's (public-fixture.spec.ts).
//
// What must hold (the plan's Interfaces, and the lifecycle the owner set 2026-11-21: a token lapses, so the source is swapped):
//   - one Hls instance and one `attachMedia` per element, ever: a new address is `loadSource(B)` on the SAME instance, never a
//     `destroy()` (that would tear the picture down on every token refresh), and it resumes at the current time;
//   - hls.js is a worker-less instance (`enableWorker: false`) that fetches no media until the viewer presses play;
//   - a browser that plays HLS itself (`canPlayType`) never loads hls.js at all and swaps through `video.src`;
//   - a fatal error, an unsupported browser, or a bundle that will not load reaches `onFatal`, once, and nothing throws.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeHlsInstance {
  config: { enableWorker?: boolean; autoStartLoad?: boolean; startPosition: number };
  calls: string[];
  loadedAt: { src: string; startPosition: number; autoStartLoad: boolean | undefined }[];
  handlers: Map<string, (event: string, data: unknown) => void>;
}
const hls = vi.hoisted(() => ({ instances: [] as FakeHlsInstance[], supported: true, isSupportedCalls: 0 }));
vi.mock("hls.js", () => {
  class FakeHls implements FakeHlsInstance {
    static Events = { ERROR: "hlsError" };
    static isSupported() {
      hls.isSupportedCalls++;
      return hls.supported;
    }
    config: FakeHlsInstance["config"];
    calls: string[] = [];
    loadedAt: FakeHlsInstance["loadedAt"] = [];
    handlers = new Map<string, (event: string, data: unknown) => void>();
    constructor(config: { enableWorker?: boolean; autoStartLoad?: boolean }) {
      this.config = { startPosition: -1, ...config };
      hls.instances.push(this);
    }
    attachMedia(el: unknown) {
      this.calls.push(`attachMedia:${el === currentVideo ? "video" : "other"}`);
    }
    loadSource(src: string) {
      this.calls.push(`loadSource:${src}`);
      this.loadedAt.push({ src, startPosition: this.config.startPosition, autoStartLoad: this.config.autoStartLoad });
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

/** The element, as far as the controller touches it. */
class FakeVideo {
  native = false;
  currentTime = 0;
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
afterEach(() => vi.restoreAllMocks());

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

  it("a refreshed address is loadSource(B) on the SAME instance: one attach, no destroy, and it resumes at the current time", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    video.currentTime = 42.5;
    playback.setSource(B);
    await flush();
    expect(hls.instances, "still one instance").toHaveLength(1);
    const h = hls.instances[0]!;
    expect(h.calls.filter((c) => c === "destroy"), "never destroyed by a swap").toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("attachMedia")), "attached once").toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith("loadSource"))).toEqual([`loadSource:${A}`, `loadSource:${B}`]);
    // The position is set BEFORE the load, because the load starts from it.
    expect(h.loadedAt[1]).toMatchObject({ src: B, startPosition: 42.5 });
    playback.dispose();
  });

  it("a swap before anything has played does not pin a start position (a live source starts at the live edge)", async () => {
    const { playback, video } = make();
    playback.setSource(A);
    await flush();
    video.currentTime = 0;
    playback.setSource(B);
    await flush();
    expect(hls.instances[0]!.loadedAt[1]).toMatchObject({ src: B, startPosition: -1 });
    video.currentTime = Number.NaN;
    playback.setSource(A);
    await flush();
    expect(hls.instances[0]!.loadedAt[2], "a time that is not a number is no position").toMatchObject({ src: A, startPosition: -1 });
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

  it("two addresses before the bundle has loaded: only the newest is loaded", async () => {
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
    video.currentTime = 12;
    playback.setSource(B);
    await flush();
    expect(h.loadedAt[1], "a swap after play loads on its own, from where the viewer is").toMatchObject({ src: B, startPosition: 12, autoStartLoad: true });
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
    expect(() => playback.dispose()).not.toThrow();
    vi.doUnmock("hls.js");
  });
});
