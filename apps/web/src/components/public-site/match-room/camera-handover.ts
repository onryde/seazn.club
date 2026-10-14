// T17B fix 2, D23 (owner defect, stg v797: "the camera goes off and comes back at Check in").
//
// D15's Check in STOPS the test track before the seat is asked for (so the SDK takes a free device, and the D2 gate
// keeps the SDK's own evidence). Between that stop and the SDK's first video frame the tile has nothing to show. This
// is the cover for that gap: the last frame of the preview, drawn to a canvas BEFORE the stop (a stopped track draws
// black), laid over the tile with "Connecting your camera…", and taken away when the SDK's own video has painted a
// frame — or, if it never does, after HANDOVER_COVER_MS, so a stale picture never poses as a live camera for longer
// than a join takes (what is left is the ordinary camera_starting state: the Check in button's own words).
//
// Nothing here touches the stop, the seat claim or the SDK: it only remembers a picture and a clock.

/** How long the frozen frame may stand in for the camera ("about 8 s", D23). */
export const HANDOVER_COVER_MS = 8_000;
/** The longest edge of the kept frame: the tile is at most 288 px wide, so a 1280x720 camera need not pin a full bitmap. */
const MAX_EDGE = 640;

export type HandoverView =
  | { status: "idle"; frame: null }
  /** Between Check in's stop and the SDK's first frame: show `frame` over the tile. */
  | { status: "covering"; frame: HTMLCanvasElement }
  /** The cover is gone: the SDK's video painted (`sdk`), or the bound ran out (`timeout`). */
  | { status: "over"; frame: null; by: "sdk" | "timeout" };

export const IDLE_HANDOVER: HandoverView = { status: "idle", frame: null };

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

/** The cover as a session (like camera-test.ts): `begin` at Check in, `sdkFrame` when the SDK's video has painted. */
export function cameraHandover(onView: (v: HandoverView) => void) {
  let view: HandoverView = IDLE_HANDOVER;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const set = (v: HandoverView) => {
    view = v;
    onView(v);
  };
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    view: () => view,
    /** Check in pressed with a frame in hand: cover the tile, for at most HANDOVER_COVER_MS. No frame, no cover. */
    begin(frame: HTMLCanvasElement | null): boolean {
      clear();
      if (frame === null) return false;
      set({ status: "covering", frame });
      timer = setTimeout(() => {
        timer = null;
        if (view.status === "covering") set({ status: "over", frame: null, by: "timeout" });
      }, HANDOVER_COVER_MS);
      return true;
    },
    /** The SDK's own video painted a frame in the tile: the camera is back, the cover goes. Late or stray calls are no-ops. */
    sdkFrame(): void {
      if (view.status !== "covering") return;
      clear();
      set({ status: "over", frame: null, by: "sdk" });
    },
    /** The room is going away: stop the clock, say nothing more. */
    dispose(): void {
      clear();
    },
  };
}

export type CameraHandoverSession = ReturnType<typeof cameraHandover>;
