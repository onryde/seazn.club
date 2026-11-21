// Seazn-hosted video (Phase 1 Task 15): how a signed HLS address reaches the match page's ONE `<video>`. A component cannot own this
// (apps/web vitest has no DOM, and an effect that re-ran on every address would rebuild the picture), so it is a controller made
// once per element: `setSource(src)` for every address the island hands over, `dispose()` when the element goes.
//
//   - A browser that plays HLS itself (`canPlayType`: Safari, iOS, and now some Chrome) is given the address through `video.src`
//     and never loads hls.js. Everything else gets hls.js, loaded on demand (the bundle is not paid by the pages that play none),
//     as a worker-less instance (`enableWorker: false`).
//   - The address carries its token in the path and the token lapses (a Cloudflare HLS is not assumed to outlive it), so the island
//     hands over a fresh address before then. That is `loadSource(B)` on the same instance and the same element, resuming at the
//     current time: a refreshed token must not restart the picture, and `destroy()` is only for the element going away.
//   - Nothing is fetched until the viewer presses play: a page that is only visited streams no video (Cloudflare bills what it
//     delivers). hls.js is built with `autoStartLoad: false` and started by the first `play`; a native element has `preload="none"`.
//   - A failure the player cannot recover from (a fatal hls.js error, a browser hls.js cannot run in, a bundle that will not load,
//     an element error) is `onFatal`: the player says so and the island reads the route again for a fresh address.
import type Hls from "hls.js";

export const HLS_MIME = "application/vnd.apple.mpegurl";

export interface Playback {
  /** The newest address the island holds. The same address again is a no-op. */
  setSource: (src: string) => void;
  dispose: () => void;
}

/** Where the viewer is, or null when there is no position to keep (nothing played, or a time that is not a number). */
function positionOf(video: HTMLVideoElement): number | null {
  const t = video.currentTime;
  return Number.isFinite(t) && t > 0 ? t : null;
}

export function createPlayback(video: HTMLVideoElement, { onFatal }: { onFatal: () => void }): Playback {
  const native = video.canPlayType(HLS_MIME) !== "";
  let disposed = false;
  /** The viewer has pressed play at least once: from then on a load starts by itself. */
  let started = false;
  let wanted: string | null = null;
  let loaded: string | null = null;
  let hls: Hls | null = null;
  let hlsReady: Promise<Hls | null> | null = null;
  let resume: { at: number | null; playing: boolean; listener: () => void } | null = null;

  const onPlay = () => {
    if (started) return;
    started = true;
    if (hls) {
      hls.config.autoStartLoad = true;
      hls.startLoad();
    }
  };
  const onError = () => onFatal();
  if (native) video.addEventListener("error", onError);
  else video.addEventListener("play", onPlay);

  function ensureHls(): Promise<Hls | null> {
    hlsReady ??= import("hls.js")
      .then(({ default: HlsCtor }) => {
        if (disposed) return null;
        if (!HlsCtor.isSupported()) {
          onFatal();
          return null;
        }
        const h = new HlsCtor({ enableWorker: false, autoStartLoad: started });
        h.attachMedia(video);
        h.on(HlsCtor.Events.ERROR, (_event, data) => {
          if (data.fatal) onFatal();
        });
        hls = h;
        return h;
      })
      .catch(() => {
        onFatal();
        return null;
      });
    return hlsReady;
  }

  async function loadHls(): Promise<void> {
    const h = await ensureHls();
    if (h === null || disposed) return;
    const src = wanted;
    // A newer address may have been asked for while the bundle loaded: it is the one in `wanted`, and one load serves them all.
    if (src === null || src === loaded) return;
    // The position is set BEFORE the load, because the load starts from it; -1 is hls.js's own "no position" (the live edge).
    h.config.startPosition = positionOf(video) ?? -1;
    loaded = src;
    h.loadSource(src);
  }

  function loadNative(src: string): void {
    // A swap asked for twice before the first one's metadata arrived keeps the position the viewer actually had.
    const keep = resume ?? { at: positionOf(video), playing: !video.paused && !video.ended };
    if (resume) video.removeEventListener("loadedmetadata", resume.listener);
    const pending = {
      ...keep,
      listener: () => {
        video.removeEventListener("loadedmetadata", pending.listener);
        resume = null;
        if (pending.at !== null) video.currentTime = pending.at;
        if (pending.playing) void video.play().catch(() => {});
      },
    };
    loaded = src;
    video.src = src;
    if (pending.at !== null || pending.playing) {
      resume = pending;
      video.addEventListener("loadedmetadata", pending.listener);
    } else {
      resume = null;
    }
  }

  return {
    setSource(src) {
      if (disposed || src === wanted) return;
      wanted = src;
      if (native) loadNative(src);
      else void loadHls();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      video.removeEventListener("error", onError);
      video.removeEventListener("play", onPlay);
      if (resume) video.removeEventListener("loadedmetadata", resume.listener);
      resume = null;
      hls?.destroy();
      hls = null;
    },
  };
}
