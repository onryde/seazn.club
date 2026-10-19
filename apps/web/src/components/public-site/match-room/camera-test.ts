// T17B fix 2, D15 (owner, 2026-10-14; controller ruling option (c)): under camera "required" the check-in tests the
// camera on the page BEFORE Check in can be pressed — a plain getUserMedia, local only: no meeting, no vendor call, no
// SDK. Check in waits for a track that is live AND has painted a frame in the preview (`frame`, from own-tile.tsx).
//
// On Check in the test track is STOPPED (`handOver`), synchronously, before the seat is asked for: the meeting's SDK
// then takes the camera exactly as it always has (camera-loader.ts), so the D2 seat gate keeps the SDK's own evidence
// (its `media_permission` report) and a single-camera phone never sees two grabs at once. The browser's granted
// permission is what spares the player a second prompt. The server's D2 gate stays the backstop: nothing here is
// trusted by the server.

export type CameraTestFailure = "denied" | "notFound" | "inUse" | "other" | "ended";

export type CameraTestView =
  | { status: "idle"; stream: null; failure: null }
  /** Asking for the camera (stream null), or showing it and waiting for its first painted frame. */
  | { status: "testing"; stream: MediaStream | null; failure: null }
  | { status: "live"; stream: MediaStream; failure: null }
  | { status: "failed"; stream: null; failure: CameraTestFailure }
  /** Check in was pressed: the test camera is released, the SDK's join takes over. */
  | { status: "handed"; stream: null; failure: null };

export type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export const IDLE: CameraTestView = { status: "idle", stream: null, failure: null };
export const HANDED: CameraTestView = { status: "handed", stream: null, failure: null };

/** The brief's table: the three refusals a player can act on, each its own words; everything else is "other". */
export function failureOf(err: unknown): Exclude<CameraTestFailure, "ended"> {
  const name = err instanceof Error || (typeof err === "object" && err !== null) ? (err as { name?: unknown }).name : null;
  if (name === "NotAllowedError") return "denied";
  if (name === "NotFoundError") return "notFound";
  if (name === "NotReadableError") return "inUse";
  return "other";
}

const liveTrack = (s: MediaStream) => s.getVideoTracks().find((t) => t.readyState === "live") ?? null;

/** Check in may be pressed: a tested camera that is still live, or one already handed to the join (a retried Check in
 *  needs no second test). */
export function canCheckIn(v: CameraTestView): boolean {
  if (v.status === "handed") return true;
  return v.status === "live" && liveTrack(v.stream) !== null;
}

export function cameraTest(getUserMedia: GetUserMedia | null, onView: (v: CameraTestView) => void) {
  let view: CameraTestView = IDLE;
  let stream: MediaStream | null = null;
  // Each start() and every stop/hand-over bumps it: an answer for an older ask is released, never shown.
  let generation = 0;
  const set = (v: CameraTestView) => {
    view = v;
    onView(v);
  };
  const onEnded = () => {
    if (stream === null) return;
    release();
    set({ status: "failed", stream: null, failure: "ended" });
  };
  function release() {
    const s = stream;
    stream = null;
    if (s === null) return;
    for (const t of s.getTracks()) {
      t.removeEventListener("ended", onEnded);
      t.stop();
    }
  }
  const drop = (s: MediaStream) => {
    for (const t of s.getTracks()) t.stop();
  };

  return {
    view: () => view,
    async start(): Promise<void> {
      const mine = ++generation;
      release();
      set({ status: "testing", stream: null, failure: null });
      if (getUserMedia === null) {
        set({ status: "failed", stream: null, failure: "other" });
        return;
      }
      let s: MediaStream;
      try {
        s = await getUserMedia({ video: true, audio: false });
      } catch (err) {
        if (mine === generation) set({ status: "failed", stream: null, failure: failureOf(err) });
        return;
      }
      if (mine !== generation) {
        drop(s);
        return;
      }
      const track = liveTrack(s);
      if (track === null) {
        drop(s);
        set({ status: "failed", stream: null, failure: "other" });
        return;
      }
      stream = s;
      track.addEventListener("ended", onEnded);
      set({ status: "testing", stream: s, failure: null });
    },
    /** The preview painted a frame of `of`. Only the stream on show, still live, proves the camera. */
    frame(of: MediaStream): void {
      if (view.status !== "testing" || stream === null || of !== stream || liveTrack(stream) === null) return;
      set({ status: "live", stream, failure: null });
    },
    /** Check in: release the camera NOW, before the seat is asked for and the SDK takes the device. */
    handOver(): void {
      generation += 1;
      release();
      set(HANDED);
    },
    /** Leaving the check-in: the camera light goes off; a later check-in starts afresh. */
    stop(): void {
      generation += 1;
      release();
      set(IDLE);
    },
  };
}

export type CameraTestSession = ReturnType<typeof cameraTest>;
