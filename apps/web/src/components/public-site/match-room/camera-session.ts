// The player's own camera as a small state machine, free of React so its
// transitions are testable in node (camera-session.test.ts). `use-own-camera`
// is the hook over it; `camera-loader` is the real RealtimeKit join, injected.
//
//   idle → joining → live ⇄ off      (the camera dropped or was turned off)
//            ├──→ failed             (no permission, no device, no meeting)
//            └──→ recovering → live  (OUR guard left the meeting: re-join)
//                       └──→ gave_up (RECOVER_MAX_ATTEMPTS failed: reload)
// A second start while joining or joined is a no-op; nothing starts after
// stop, and a join that lands after stop is left at once.
//
// Moving meetings (final re-review 3, R3-1): a start may name the PARTICIPANT
// its token is for. A re-pair's retire ends the meeting the camera joined and
// deletes its participants, and the room's quiet re-claim answers with
// another participant, in the new meeting: the session leaves the old join and
// joins with the new token. The same participant's refreshed token (every
// seat answer refreshes it) moves nothing, and a start that names no
// participant behaves as before. The move is not our guard's fault: nothing
// is stamped. A start while a join is in flight only records the latest; the
// join that lands then moves if it is not the latest seat's.
//
// Recovering (T14 re-review 3, I-1, controller ruling 2026-10-12): when the
// D7 guard cannot refuse a remote stream it leaves the meeting (onFault), or
// a join rejects as the guard's (D7GuardError). That is Seazn's fault, never
// the player's camera: the session stamps it on the server (`stamp("start")`,
// before the old meeting is even left), re-joins a FRESH meeting on
// RECOVER_BACKOFF_MS with the seat's latest token, and stamps the end once
// it is back. The player sees "reconnecting", never "camera off".
//
// Giving up (T14 fix round 5, ruling 2): after RECOVER_MAX_ATTEMPTS failed
// re-joins — for any reason — the session stops trying and reads `gave_up`:
// the player is told to reload, never left on "reconnecting" for ever. The
// stamp stays OPEN (fix round 6, I-2): the reload is our gap too, and the
// reload's re-seat (claimRoomSeat) closes it on the server — the closer that
// lands nearest the camera's return. A stop after the give-up leaves it open
// for the same reason: an unload's POST may never arrive, and an end sent at
// the unload would leave the page load and the join uncovered. Every other
// stop closes it. The open time still counts toward job 5's neutral flag.
//
// Delivering a stamp (fix round 6, M-3): a stamp request that REJECTS (the
// shell maps a network error or a 5xx to a rejection; a final 4xx resolves)
// is sent again after each wait of STAMP_RETRY_MS, then dropped. Every stamp
// goes through ONE serial queue, so a start's retry never lands after its end.
//
// Reporting the camera (D16, §5.6.3): each player is in a meeting of their own, so the opponent's browser cannot see this
// camera - the OPPONENT's pill is this session's own word, relayed by the server. The session reports its camera's current
// state on every change, and again every CAMERA_REPORT_HEARTBEAT_MS in BOTH states (a camera that stays off stays fresh
// exactly as one that stays live does). `live` is live; `off`, `failed` and `gave_up` are off; `joining`, `recovering` and
// `idle` send nothing - they are transitions, and `recovering` is OUR guard's re-join, never the player's "off". One serial
// queue, one request at a time, of the stamp queue's shape. A report is a CHANGE until the server has acknowledged that
// state and a heartbeat after, judged when it is SENT: a change the server did not take is sent again as a change after a wait
// and then dropped (the next beat is still a change, since nothing was acknowledged); a lost heartbeat is simply dropped. A
// queued report whose state has moved on by the time its turn comes is not sent: what it said is no longer true.
import { D7GuardError, type JoinOwnCamera, type OwnCamera } from "./camera-loader";
import { CAMERA_REPORT_HEARTBEAT_MS } from "./room-snapshot";

export type CameraStatus = "idle" | "joining" | "live" | "off" | "failed" | "recovering" | "gave_up";
export type CameraView = { status: CameraStatus; track: MediaStreamTrack | null };

/** Waits before each re-join attempt; the last one repeats. The first is at
 *  once: a gap shorter than 15 s is never a camera loss even unstamped. */
export const RECOVER_BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;

/** Re-join attempts before giving up: on RECOVER_BACKOFF_MS their waits come
 *  to 71 s, inside the ruled 60–90 s (fix round 5). */
export const RECOVER_MAX_ATTEMPTS = 12;

/** Waits before each re-send of a stamp request that failed (M-3): bounded,
 *  1 + its length attempts in all, about 7.5 s of waiting. */
export const STAMP_RETRY_MS = [500, 1_000, 2_000, 4_000] as const;

/** Waits before the re-send of a CHANGE the server did not take (D16): once, then dropped. A heartbeat is never re-sent. */
export const CAMERA_REPORT_RETRY_MS = [2_000] as const;

/** A report's wire state: the camera is on, or it is not. */
export type CameraReportState = "live" | "off";

/** What each CameraStatus tells the opponent's pill (D16, §5.6.3); `null` sends nothing. */
export function cameraReportOf(status: CameraStatus): CameraReportState | null {
  switch (status) {
    case "live":
      return "live";
    case "off":
    case "failed":
    case "gave_up":
      return "off";
    case "joining":
    case "recovering":
    case "idle":
      return null;
  }
}

export type CameraSessionOptions = {
  /** Tells the server our guard's gap started / ended (room camera-fault).
   *  A rejection (or a throw) is a request to re-send; a resolve is final. */
  stamp?: (state: "start" | "end") => Promise<unknown> | void;
  /** Tells the server this camera's current state for the opponent's pill (room camera-report). `heartbeat` is a repeat of a
   *  state the server already acknowledged. A rejection (or a throw) means the server may not have taken it; a resolve is final. */
  report?: (state: CameraReportState, heartbeat: boolean) => Promise<unknown> | void;
  /** Test seam: the back-off's wait — the re-join's, the stamp's and the report's. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: the heartbeat's timer. Returns what stops it. */
  heartbeatEvery?: (cb: () => void, ms: number) => () => void;
};

const realSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const realEvery = (cb: () => void, ms: number) => {
  const id = setInterval(cb, ms);
  return () => clearInterval(id);
};

export function cameraSession(join: JoinOwnCamera, emitView: (v: CameraView) => void, opts: CameraSessionOptions = {}) {
  const sleep = opts.sleep ?? realSleep;
  let cam: OwnCamera | null = null;
  let release: (() => void) | null = null;
  // The camera report (D16): see the header. `current` is the state a heartbeat repeats (null between states), `acked` the
  // last state the server took.
  let current: CameraReportState | null = null;
  let acked: CameraReportState | null = null;
  let stopBeat: (() => void) | null = null;
  let reportQueue: Promise<void> = Promise.resolve();
  let reportsQueued = 0;
  const deliverReport = async (state: CameraReportState) => {
    for (let attempt = 0; ; attempt += 1) {
      // What this report said may no longer be true by its turn (a newer one is behind it, or the camera is between states).
      if (stopped || current !== state) return;
      const heartbeat = acked === state;
      try {
        await opts.report?.(state, heartbeat);
        acked = state;
        return;
      } catch {
        if (heartbeat || attempt >= CAMERA_REPORT_RETRY_MS.length) return;
        await sleep(CAMERA_REPORT_RETRY_MS[attempt]!);
      }
    }
  };
  const enqueueReport = (state: CameraReportState) => {
    if (opts.report === undefined || stopped) return;
    const send = () => deliverReport(state).finally(() => void (reportsQueued -= 1));
    reportsQueued += 1;
    reportQueue = reportsQueued === 1 ? send() : reportQueue.then(send);
  };
  /** Every status the session emits passes here: it moves `current` and reports a change. */
  const emit = (v: CameraView) => {
    emitView(v);
    const state = cameraReportOf(v.status);
    current = state;
    if (state === null) return;
    if (opts.report !== undefined && stopBeat === null && !stopped) {
      stopBeat = (opts.heartbeatEvery ?? realEvery)(() => {
        if (current !== null) enqueueReport(current);
      }, CAMERA_REPORT_HEARTBEAT_MS);
    }
    enqueueReport(state);
  };

  let token: string | null = null;
  /** The participant the latest seat's token is for (R3-1), and the one the attached camera joined with. */
  let key: string | null = null;
  let joinedKey: string | null = null;
  let busy = false;
  let stopped = false;
  let faultOpen = false;
  let gaveUp = false;

  // One queue for every stamp request: a start's retries all run before its
  // end is sent. Idle, a request is sent AT ONCE — the start goes out before
  // the old meeting is left. A stamp is evidence for the organiser; it never
  // stops the camera, so nothing here rejects.
  let stampQueue: Promise<void> = Promise.resolve();
  let queued = 0;
  const deliver = async (state: "start" | "end") => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await opts.stamp?.(state);
        return;
      } catch {
        if (attempt >= STAMP_RETRY_MS.length) return;
        await sleep(STAMP_RETRY_MS[attempt]!);
      }
    }
  };
  const stamp = (state: "start" | "end") => {
    if ((state === "start") === faultOpen) return;
    faultOpen = state === "start";
    const send = () => deliver(state).finally(() => void (queued -= 1));
    queued += 1;
    stampQueue = queued === 1 ? send() : stampQueue.then(send);
  };

  const attach = (joined: OwnCamera, joinedFor: string | null) => {
    cam = joined;
    joinedKey = joinedFor;
    const unchange = joined.onChange((enabled, track) => {
      if (!stopped) emit({ status: enabled && track ? "live" : "off", track: enabled ? track : null });
    });
    const unfault = joined.onFault(() => void recover(joined));
    release = () => {
      unchange();
      unfault();
    };
    gaveUp = false;
    stamp("end");
    const track = joined.track();
    emit({ status: track ? "live" : "off", track });
  };

  const detach = (): OwnCamera | null => {
    release?.();
    release = null;
    const c = cam;
    cam = null;
    return c;
  };

  /** Our guard's fault: from a live camera (onFault — released with the
   *  camera, so a replaced one is never heard), or a join it could not hold
   *  (`from` null). Re-joins until it holds, until stop, or until
   *  RECOVER_MAX_ATTEMPTS have failed. */
  async function recover(from: OwnCamera | null): Promise<void> {
    if (stopped) return;
    detach();
    busy = true;
    stamp("start");
    emit({ status: "recovering", track: null });
    await from?.leave().catch(() => undefined);
    for (let attempt = 0; attempt < RECOVER_MAX_ATTEMPTS; attempt += 1) {
      await sleep(RECOVER_BACKOFF_MS[Math.min(attempt, RECOVER_BACKOFF_MS.length - 1)]!);
      if (stopped) break;
      let joined: OwnCamera;
      const joiningFor = key;
      try {
        joined = await join(token!);
      } catch {
        continue;
      }
      if (stopped) {
        await joined.leave().catch(() => undefined);
        break;
      }
      busy = false;
      attach(joined, joiningFor);
      if (key !== joiningFor) void start(token!, key);
      return;
    }
    busy = false;
    if (stopped) return;
    // Out of attempts: the player is told to reload, the page's own way back.
    // OUR window stays open until the reload's re-seat closes it (I-2).
    gaveUp = true;
    emit({ status: "gave_up", track: null });
  }

  async function start(authToken: string, participantKey: string | null = null): Promise<void> {
    if (stopped) return;
    // The latest seat's token is the one any re-join uses.
    token = authToken;
    key = participantKey;
    if (busy) return;
    // Joined, and still the latest seat's participant: nothing to do. Another participant is another meeting (R3-1).
    if (cam !== null && joinedKey === key) return;
    busy = true;
    const left = detach();
    if (left !== null) await left.leave().catch(() => undefined);
    if (stopped) {
      busy = false;
      return;
    }
    emit({ status: "joining", track: null });
    const joiningFor = key;
    let joined: OwnCamera;
    try {
      joined = await join(token);
    } catch (err) {
      busy = false;
      if (stopped) return;
      if (err instanceof D7GuardError) void recover(null);
      else emit({ status: "failed", track: null });
      return;
    }
    busy = false;
    if (stopped) {
      await joined.leave().catch(() => undefined);
      return;
    }
    attach(joined, joiningFor);
    // A newer seat for another participant arrived while this join was in flight: move on to it.
    if (key !== joiningFor) void start(token, key);
  }

  return {
    start,
    /** "Turn camera on" (card 9). The change arrives through onChange. */
    async enable(): Promise<void> {
      if (stopped || cam === null) return;
      try {
        await cam.enable();
      } catch {
        if (!stopped) emit({ status: "failed", track: null });
      }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      stopBeat?.();
      stopBeat = null;
      const c = detach();
      // The page is gone: our interval, if one is open, ends with it — unless
      // we gave up, when the re-seat after the reload is its closer (I-2).
      if (!gaveUp) stamp("end");
      await c?.leave().catch(() => undefined);
    },
  };
}
