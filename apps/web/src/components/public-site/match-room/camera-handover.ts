// T17B fix 2, D23 (owner defect, stg v797: "the camera goes off and comes back at Check in").
//
// D15's Check in STOPS the test track before the seat is asked for (so the SDK takes a free device, and the D2 gate
// keeps the SDK's own evidence). Between that stop and the SDK's first video frame the tile has nothing to show. This
// is the cover for that gap: the last frame of the preview, drawn to a canvas BEFORE the stop (a stopped track draws
// black), laid over the tile with "Connecting your camera…", and taken away when the SDK's own video has painted a
// frame. A stale picture never poses as a live camera for longer than a join takes: after HANDOVER_COVER_MS the
// PICTURE goes (D23-fix m1) and the words stay over the silhouette — "connecting" — until the SDK's frame, or an end
// the room reports (the camera failed or gave up, the screen left, the seat's poll budget spent), or — a guard, not an
// expectation — HANDOVER_CEILING_MS, so a frame proof that never fires cannot pin a false "Connecting…" for ever.
// The end is reported once (`onEnd`: how it ended, the milliseconds from the click) — the stg measurement of whether
// eight seconds is the right number.
//
// Nothing here touches the stop, the seat claim or the SDK: it only remembers a picture and a clock.

/** How long the frozen PICTURE may stand in for the camera ("about 8 s", D23). */
export const HANDOVER_COVER_MS = 8_000;
/** D23-fix: the hard stop for the words. The room's own poll budget on `camera_starting` is about 20 s; a minute is far
 *  past anything the room itself will wait, so reaching this is a defect in the frame proof, and says so (`ceiling`). */
export const HANDOVER_CEILING_MS = 60_000;
/** The longest edge of the kept frame: the tile is at most 288 px wide, so a 1280x720 camera need not pin a full bitmap. */
const MAX_EDGE = 640;

/** How a hand-over ended: the SDK's own video painted (`sdk`), the camera failed or gave up (`failed`), the room moved
 *  to a screen with no tile to cover (`left`), the seat's `camera_starting` poll budget ran out (`budget`), or the
 *  guard's ceiling (`ceiling`). */
export type HandoverEnd = "sdk" | "failed" | "left" | "budget" | "ceiling";
/** What the end reports: how, the milliseconds from the Check in click, and whether the picture had already gone (the
 *  SDK took longer than HANDOVER_COVER_MS). */
export type HandoverEndEvent = { by: HandoverEnd; ms: number; pictureExpired: boolean };

export type HandoverView =
  | { status: "idle"; frame: null }
  /** Between Check in's stop and the SDK's first frame: show `frame` over the tile, with the words. */
  | { status: "covering"; frame: HTMLCanvasElement }
  /** The picture's bound passed: the words stay over the silhouette until the SDK's frame or an end. */
  | { status: "connecting"; frame: null }
  /** The cover is gone, and `by` says how. */
  | { status: "over"; frame: null; by: HandoverEnd };

export const IDLE_HANDOVER: HandoverView = { status: "idle", frame: null };

/** The cover is on show (picture and words, or the words alone). */
export const isHandoverActive = (v: HandoverView): v is Extract<HandoverView, { status: "covering" | "connecting" }> =>
  v.status === "covering" || v.status === "connecting";

/** The end as a Sentry breadcrumb (the hook adds it): a fixed message and the three enumerated facts — nothing of the
 *  player, the fixture or the camera. */
export function handoverBreadcrumb(e: HandoverEndEvent) {
  return {
    category: "chess.camera.handover",
    level: "info" as const,
    message: "camera handover ended",
    data: { by: e.by, ms: Math.round(e.ms), pictureExpired: e.pictureExpired },
  };
}

function newCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * The preview's CURRENT frame as a canvas, or null when there is none to keep: a preview that has painted nothing
 * (no size yet) would give a blank canvas, which is worse than no cover. Never throws — it runs inside the Check in
 * click, which must go on to stop the track and ask for the seat whatever happens here. `make` is the canvas factory
 * (a test seam; the browser's own by default).
 */
export function captureFrame(
  video: HTMLVideoElement,
  make: (w: number, h: number) => HTMLCanvasElement | null = newCanvas,
): HTMLCanvasElement | null {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (!(vw > 0) || !(vh > 0)) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  try {
    const canvas = make(w, h);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return canvas;
  } catch {
    return null;
  }
}

/** The cover as a session (like camera-test.ts): `begin` at Check in, `sdkFrame` when the SDK's video has painted, `end`
 *  when the room knows there is nothing left to wait for. */
export function cameraHandover(onView: (v: HandoverView) => void, opts: { onEnd?: (e: HandoverEndEvent) => void } = {}) {
  let view: HandoverView = IDLE_HANDOVER;
  let coverTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  const set = (v: HandoverView) => {
    view = v;
    onView(v);
  };
  const clear = () => {
    if (coverTimer !== null) clearTimeout(coverTimer);
    if (ceilingTimer !== null) clearTimeout(ceilingTimer);
    coverTimer = null;
    ceilingTimer = null;
  };
  /** The one way a cover ends: stop the clocks, say how, report it once. */
  const finish = (by: HandoverEnd) => {
    if (!isHandoverActive(view)) return;
    const pictureExpired = view.status === "connecting";
    clear();
    set({ status: "over", frame: null, by });
    opts.onEnd?.({ by, ms: Date.now() - startedAt, pictureExpired });
  };
  return {
    view: () => view,
    /** Check in pressed with a frame in hand: cover the tile — the picture for at most HANDOVER_COVER_MS, the words
     *  until the SDK's frame or an end. No frame, no cover. */
    begin(frame: HTMLCanvasElement | null): boolean {
      clear();
      if (frame === null) return false;
      startedAt = Date.now();
      set({ status: "covering", frame });
      coverTimer = setTimeout(() => {
        coverTimer = null;
        if (view.status === "covering") set({ status: "connecting", frame: null });
      }, HANDOVER_COVER_MS);
      ceilingTimer = setTimeout(() => {
        ceilingTimer = null;
        finish("ceiling");
      }, HANDOVER_CEILING_MS);
      return true;
    },
    /** The SDK's own video painted a frame in the tile: the camera is back, the cover goes. Late or stray calls are no-ops. */
    sdkFrame(): void {
      finish("sdk");
    },
    /** The room reports there is nothing left to wait for (the camera failed, the screen left, the budget spent). */
    end(by: Exclude<HandoverEnd, "sdk" | "ceiling">): void {
      finish(by);
    },
    /** The room is going away: stop the clocks, say nothing more. */
    dispose(): void {
      clear();
    },
  };
}

export type CameraHandoverSession = ReturnType<typeof cameraHandover>;
