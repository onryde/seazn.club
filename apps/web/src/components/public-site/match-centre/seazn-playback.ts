// Seazn-hosted video (Phase 1 Task 15): how a signed HLS address reaches the match page's ONE `<video>`. A component cannot own this
// (apps/web vitest has no DOM, and an effect that re-ran on every address would rebuild the picture), so it is a controller made
// once per element: `setSource(src)` for every address the island hands over, `dispose()` when the element goes.
//
//   - A browser that plays HLS itself (`canPlayType`: Safari, iOS, and now some Chrome) is given the address through `video.src`
//     and never loads hls.js. Everything else gets hls.js, loaded on demand (the bundle is not paid by the pages that play none),
//     as a worker-less instance (`enableWorker: false`).
//   - The address carries its token in the path and the token lapses (a Cloudflare HLS is not assumed to outlive it), so the island
//     hands over a fresh address before then. On hls.js that is NOT a reload: a `loadSource` of a different address detaches and
//     re-attaches the media (hls.ts 551-560, buffer-controller.ts 604-609), which empties the buffer, resets the time and leaves the
//     element PAUSED. So one instance loads one manifest, once, and a refresh only changes the token held here: `xhrSetup` swaps the
//     token segment of every later request (playlist reloads, renditions, segments) for the newest one (seazn-signed-address.ts).
//     The picture, the buffer and the play state are untouched, and `destroy()` is only for the element going away. One controller
//     is one video: a different video (live, a part) is a different player, which the island keys, so it is a fresh element.
//   - A browser that plays HLS itself has no request hook, so there a refresh is a re-point of `video.src` that resumes where the
//     viewer was and keeps playing; a LIVE source (`duration` Infinity) resumes at its live edge, because the old time is a position
//     in a timeline the new load does not have.
//   - No MEDIA is fetched until the viewer presses play: a page that is only visited streams no video (Cloudflare bills what it
//     delivers). hls.js is built with `autoStartLoad: false` and started by the first `play`, but it DOES ask for the manifest at
//     `loadSource` (a small text file; it also lets a refused address show its note early); a native element has `preload="none"`.
//   - A failure the player cannot recover from (a fatal hls.js error, a browser hls.js cannot run in, a bundle that will not load,
//     an element error) is `onFatal`: the player says so and the island reads the route again for a fresh address. It comes with
//     WHY, as codes only (`PlaybackFailure`: hls.js's error type and details, the HTTP status it got, the element's MediaError code),
//     because the island reports it (seazn-video-report.ts). Never an address, a token, a URL or an error's text: hls.js's error data
//     carries the request's URL (the token is a path segment) and its `error.message` can quote it.
import type Hls from "hls.js";
import { parseSignedAddress, withToken, type SignedAddress } from "./seazn-signed-address";

export const HLS_MIME = "application/vnd.apple.mpegurl";

/** Why the player gave up, as codes only (see the header). */
export interface PlaybackFailure {
  /** `hls`: a fatal hls.js error; `unsupported`: a browser hls.js cannot run in; `bundle`: hls.js would not load; `element`: the
   *  element's own error (native HLS); `unsigned`: an address with no token to read (the signer changed shape). */
  reason: "hls" | "unsupported" | "bundle" | "element" | "unsigned";
  /** hls.js's error type and details (`networkError`, `manifestLoadError`), for an hls.js error; else null. */
  hlsType: string | null;
  hlsDetails: string | null;
  /** The HTTP status hls.js got (its `response.code`), when it gives one; else null. */
  httpStatus: number | null;
  /** The element's MediaError code (1-4), for an element error; else null. */
  mediaCode: number | null;
}
/** A code is a bare word (hls.js's enums are); anything else, a URL included, is dropped. */
const codeOf = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? v : null);
const statusOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null);
/** The element's MediaError code: 1-4. */
const mediaCodeOf = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 4 ? v : null);
const failure = (reason: PlaybackFailure["reason"], more: Partial<PlaybackFailure> = {}): PlaybackFailure =>
  ({ reason, hlsType: null, hlsDetails: null, httpStatus: null, mediaCode: null, ...more });
/** A fatal hls.js error's codes (its `ErrorData`: `type`, `details`, `response.code`), never its `url`, `error` or `response.text`. */
export function hlsFailureOf(data: unknown): PlaybackFailure {
  const d = (typeof data === "object" && data !== null ? data : {}) as { type?: unknown; details?: unknown; response?: { code?: unknown } | null };
  return failure("hls", { hlsType: codeOf(d.type), hlsDetails: codeOf(d.details), httpStatus: statusOf(d.response?.code) });
}

export interface Playback {
  /** The newest address the island holds. The first one is loaded; every later one is the same video under a fresh token. The same
   *  address again is a no-op. */
  setSource: (src: string) => void;
  dispose: () => void;
}

/** Where the viewer is, or null when there is no position to keep (nothing played, or a time that is not a number). */
function positionOf(video: HTMLVideoElement): number | null {
  const t = video.currentTime;
  return Number.isFinite(t) && t > 0 ? t : null;
}

export function createPlayback(video: HTMLVideoElement, { onFatal }: { onFatal: (failure: PlaybackFailure) => void }): Playback {
  const native = video.canPlayType(HLS_MIME) !== "";
  let disposed = false;
  /** The viewer has pressed play at least once: from then on a load starts by itself. */
  let started = false;
  let wanted: string | null = null;
  /** `loadSource` has been called: the one load this instance makes. */
  let loaded = false;
  /** The newest token, and the host it is for: what `xhrSetup` puts on every request. */
  let held: SignedAddress | null = null;
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
  const onError = () => onFatal(failure("element", { mediaCode: mediaCodeOf(video.error?.code) }));
  if (native) video.addEventListener("error", onError);
  else video.addEventListener("play", onPlay);

  function ensureHls(): Promise<Hls | null> {
    hlsReady ??= import("hls.js")
      .then(({ default: HlsCtor }) => {
        if (disposed) return null;
        if (!HlsCtor.isSupported()) {
          onFatal(failure("unsupported"));
          return null;
        }
        const h = new HlsCtor({
          enableWorker: false,
          autoStartLoad: started,
          // The request is opened here (hls.js skips its own `open` once the element is open), under the token held NOW.
          xhrSetup: (xhr, url) => xhr.open("GET", held === null ? url : withToken(url, held), true),
        });
        h.attachMedia(video);
        h.on(HlsCtor.Events.ERROR, (_event, data) => {
          if (data.fatal) onFatal(hlsFailureOf(data));
        });
        hls = h;
        return h;
      })
      .catch(() => {
        onFatal(failure("bundle"));
        return null;
      });
    return hlsReady;
  }

  async function loadHls(): Promise<void> {
    const h = await ensureHls();
    if (h === null || disposed) return;
    const src = wanted;
    // A newer address may have been asked for while the bundle loaded: it is the one in `wanted`, and one load serves them all. After
    // that load a newer address is only a token (`held`), never a second load.
    if (src === null || loaded) return;
    loaded = true;
    h.loadSource(src);
  }

  function loadNative(src: string): void {
    // A swap asked for twice before the first one's metadata arrived keeps the position the viewer actually had.
    // A live source has no time to go back to: the new load's timeline is its own, so it resumes at the live edge (no seek).
    const keep = resume ?? { at: video.duration === Infinity ? null : positionOf(video), playing: !video.paused && !video.ended };
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
      if (native) {
        loadNative(src);
        return;
      }
      // The token is read from the address, so an address that has none is a signer that changed shape: say so now, not at the first
      // refresh (when the old token lapses and the picture dies an hour in).
      const signed = parseSignedAddress(src);
      if (signed === null) {
        onFatal(failure("unsigned"));
        return;
      }
      held = signed;
      void loadHls();
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
