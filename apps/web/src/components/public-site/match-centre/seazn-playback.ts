// Seazn-hosted video (Phase 1 Task 15): how a signed HLS address reaches the match page's ONE `<video>`. A component cannot own this
// (apps/web vitest has no DOM, and an effect that re-ran on every address would rebuild the picture), so it is a controller made
// once per element: `setSource(src)` for every address the island hands over, `dispose()` when the element goes.
//
//   - Which path a controller takes is decided ONCE, at its first address, by asking hls.js (`Hls.isSupported()`: MSE, or iOS 17.1+'s
//     ManagedMediaSource), and never by `canPlayType`: Chrome answers "maybe" to HLS and its native player sat ~2 segments (about 6.5 s,
//     stg 2026-11-25) behind the newest data, with none of SEAZN_HLS_PLAYER_CONFIG applying. So hls.js is used wherever it runs, loaded on
//     demand (the bundle is not paid by the pages that play none), as a worker-less instance (`enableWorker: false`), and the browser's
//     own player is only for a browser hls.js cannot run in that plays HLS itself (or whose hls.js bundle will not load). The decision is
//     made before any `src` is written, so one element never has both an MSE source and an address of its own.
//   - The address carries its token in the path and the token lapses (a Cloudflare HLS is not assumed to outlive it), so the island
//     hands over a fresh address before then. On hls.js that is NOT a reload: a `loadSource` of a different address detaches and
//     re-attaches the media (hls.ts 551-560, buffer-controller.ts 604-609), which empties the buffer, resets the time and leaves the
//     element PAUSED. So one instance loads one manifest, once, and a refresh only changes the token held here: `xhrSetup` swaps the
//     token segment of every later request (playlist reloads, renditions, segments) for the newest one (seazn-signed-address.ts).
//     The picture, the buffer and the play state are untouched, and `destroy()` is only for the element going away. One controller
//     is one video: a different video (live, a part) is a different player, which the island keys, so it is a fresh element.
//   - On the native path there is no request hook, so a refresh is a re-point of `video.src` that resumes where the
//     viewer was and keeps playing; a LIVE source (`duration` Infinity) resumes at its live edge, because the old time is a position
//     in a timeline the new load does not have.
//   - No MEDIA is fetched until the viewer presses play: a page that is only visited streams no video (Cloudflare bills what it
//     delivers). hls.js is built with `autoStartLoad: false` and started by the first `play`, but it DOES ask for the manifest at
//     `loadSource` (a small text file; it also lets a refused address show its note early); a native element has `preload="none"`.
//   - The player is told its own size (seazn-player-config.ts): the rung is capped to the box by hls.js, and the first load starts ON the
//     cap (the rung hls.js itself would allow for the box the viewer has at the first play), not on the lowest rung.
//   - A failure the player cannot recover from (a fatal hls.js error, a browser hls.js cannot run in, a bundle that will not load,
//     an element error) is `onFatal`: the player says so and the island reads the route again for a fresh address. It comes with
//     WHY, as codes only (`PlaybackFailure`: hls.js's error type and details, the HTTP status it got, the element's MediaError code),
//     because the island reports it (seazn-video-report.ts). Never an address, a token, a URL or an error's text: hls.js's error data
//     carries the request's URL (the token is a path segment) and its `error.message` can quote it.
import type Hls from "hls.js";
import { isClientReportCode } from "@/lib/client-reports";
import type { PlayerFailureReason } from "@/lib/seazn-video-report-codes";
import { SEAZN_HLS_PLAYER_CONFIG, startLevelFromCap } from "./seazn-player-config";
import { parseSignedAddress, withToken, type SignedAddress } from "./seazn-signed-address";

export const HLS_MIME = "application/vnd.apple.mpegurl";

/** Why the player gave up, as codes only (see the header). */
export interface PlaybackFailure {
  /** `hls`: a fatal hls.js error; `unsupported`: a browser hls.js cannot run in; `bundle`: hls.js would not load; `element`: the
   *  element's own error (native HLS); `unsigned`: an address with no token to read (the signer changed shape). */
  reason: PlayerFailureReason;
  /** hls.js's error type and details (`networkError`, `manifestLoadError`), for an hls.js error; else null. */
  hlsType: string | null;
  hlsDetails: string | null;
  /** The HTTP status hls.js got (its `response.code`), when it gives one; else null. */
  httpStatus: number | null;
  /** The element's MediaError code (1-4), for an element error; else null. */
  mediaCode: number | null;
}
/** A code is a bare word (hls.js's enums are) that names no credential (lib/client-reports.ts, the beacon route's own rule); anything
 *  else, a URL included, is dropped, so a report never carries a code the route would refuse. */
const codeOf = (v: unknown): string | null => (isClientReportCode(v) ? v : null);
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

/** How the controller reaches the element: decided once, from hls.js's own answer (see the header). `none`: neither player can run. */
type Path = "hls" | "native" | "none";

export function createPlayback(video: HTMLVideoElement, { onFatal }: { onFatal: (failure: PlaybackFailure) => void }): Playback {
  let disposed = false;
  /** The viewer has pressed play at least once: from then on a load starts by itself. */
  let started = false;
  let wanted: string | null = null;
  /** `loadSource` has been called: the one load this instance makes. */
  let loaded = false;
  /** The newest token, and the host it is for: what `xhrSetup` puts on every request. */
  let held: SignedAddress | null = null;
  let HlsCtor: typeof Hls | null = null;
  let hls: Hls | null = null;
  let deciding: Promise<void> | null = null;
  let path: Path | null = null;
  let resume: { at: number | null; playing: boolean; listener: () => void } | null = null;
  /** The newest address written to `video.src` (native path). */
  let nativeSrc: string | null = null;

  /** The manifest has been parsed: the rungs are known, so a load can begin. */
  let parsed = false;
  /** `startLoad` has been called: media is being fetched. */
  let loadBegun = false;

  /** The first media fetch: the viewer has pressed play AND the rungs are known. It starts on the cap hls.js holds NOW (the box as it is
   *  at the first play, not as it was at parse), then fetches; from here a later load starts by itself. */
  function beginLoad(h: Hls): void {
    if (loadBegun) return;
    loadBegun = true;
    const rung = startLevelFromCap(h.autoLevelCapping, h.levels.length);
    if (rung >= 0) h.startLevel = rung;
    h.config.autoStartLoad = true;
    h.startLoad();
  }

  const onPlay = () => {
    if (started) return;
    started = true;
    if (hls && parsed) beginLoad(hls);
  };
  const onError = () => onFatal(failure("element", { mediaCode: mediaCodeOf(video.error?.code) }));
  // Listening from the start: a play pressed while the bundle is still arriving must still start the fetch once the manifest has parsed.
  // A controller that ends on the native path drops it (decide), as it never had one.
  video.addEventListener("play", onPlay);

  /** The one decision (see the header). The bundle is asked for once; its answer, or its absence, picks the path. */
  function decide(): Promise<void> {
    deciding ??= import("hls.js")
      .then(({ default: Ctor }) => {
        if (disposed) return;
        if (Ctor.isSupported()) {
          HlsCtor = Ctor;
          path = "hls";
          return;
        }
        settleWithoutHls("unsupported");
      })
      .catch(() => {
        if (!disposed) settleWithoutHls("bundle");
      });
    return deciding;
  }

  /** hls.js will not run (or did not load): the browser's own player if it plays HLS, else the failure, said once. */
  function settleWithoutHls(why: "unsupported" | "bundle"): void {
    if (video.canPlayType(HLS_MIME) !== "") {
      path = "native";
      video.removeEventListener("play", onPlay);
      video.addEventListener("error", onError);
      return;
    }
    path = "none";
    onFatal(failure(why));
  }

  function buildHls(Ctor: typeof Hls): Hls {
    const h = new Ctor({
      enableWorker: false,
      // The rung is capped to the box, and the picture sits about one segment behind live (seazn-player-config.ts).
      ...SEAZN_HLS_PLAYER_CONFIG,
      // Never self-starting: the first fetch is `beginLoad`'s, once the viewer has pressed play and the rungs are known.
      autoStartLoad: false,
      // The request is opened here (hls.js skips its own `open` once the element is open), under the token held NOW.
      xhrSetup: (xhr, url) => xhr.open("GET", held === null ? url : withToken(url, held), true),
    });
    h.attachMedia(video);
    h.on(Ctor.Events.MANIFEST_PARSED, () => {
      parsed = true;
      if (started) beginLoad(h);
    });
    h.on(Ctor.Events.ERROR, (_event, data) => {
      if (data.fatal) onFatal(hlsFailureOf(data));
    });
    return h;
  }

  function applyHls(src: string): void {
    // The token is read from the address, so an address that has none is a signer that changed shape: say so now, not at the first
    // refresh (when the old token lapses and the picture dies an hour in).
    const signed = parseSignedAddress(src);
    if (signed === null) {
      onFatal(failure("unsigned"));
      return;
    }
    held = signed;
    // One load serves every address asked for before it ran; after it a newer address is only a token (`held`), never a second load.
    if (loaded || HlsCtor === null) return;
    hls ??= buildHls(HlsCtor);
    loaded = true;
    hls.loadSource(src);
  }

  function loadNative(src: string): void {
    if (src === nativeSrc) return;
    nativeSrc = src;
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

  /** Hands the newest address to whichever path was chosen. */
  function apply(): void {
    if (disposed || wanted === null) return;
    if (path === "native") loadNative(wanted);
    else if (path === "hls") applyHls(wanted);
  }

  return {
    setSource(src) {
      if (disposed || src === wanted) return;
      wanted = src;
      // Once the path is chosen a refresh is handled in the same tick (the token swap and the re-point are not to wait on a promise).
      if (path !== null) apply();
      else void decide().then(apply);
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
