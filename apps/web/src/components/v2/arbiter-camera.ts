// T15 — the arbiter's browser in a board's video meeting (design §5.3): it
// joins receive-only with its OWN token (preset `arbiter`: produces nothing,
// at most two video streams) and RECEIVES exactly two things — the two
// players' cameras. Never a microphone (chess needs no audio; controller
// addendum 2026-10-12: "the arbiter receives NO audio"), never a screen
// share, never another participant.
//
// The player's D7 guard (match-room/camera-loader.ts) is a different rule —
// receive NOTHING — and is not reused or touched: an arbiter loader that went
// through it would see no one, and loosening it for the arbiter would loosen
// it for a child. What the two share is the SDK's subscription mechanics,
// ported in match-room/__tests__/_fake-realtimekit.ts:
//   - the SDK resets the view to ACTIVE_GRID on every socket rejoin and
//     selects there before `roomJoined` fires, so MANUAL is re-asserted on
//     every arrival in either subscribed map, not only on `roomJoined`;
//   - in ACTIVE_GRID the AUDIO map selects cap + 4 peers, so the cap alone
//     never keeps audio out; the audio map is watched and emptied;
//   - every participant starts with every kind allowed (TC), so a MANUAL
//     subscribe of "video" is preceded by an unsubscribe of the other three
//     kinds for that peer — its screen share and audio stay refused.
// A guard that cannot empty the audio map (or a stranger's video) after
// ARBITER_MAX_ATTEMPTS tries in a row leaves the meeting before the SDK's
// consumer sync — nothing heard — and tells the panel, which offers a rejoin.
import type RealtimeKitClient from "@cloudflare/realtimekit";
import * as Sentry from "@sentry/nextjs";
import { loadRealtimeKitSdk, type RealtimeKitSdk } from "@/components/public-site/match-room/camera-loader";

export type ArbiterSeat = "white" | "black";

/** One player's camera as the arbiter's client holds it. */
export type ArbiterTileView = {
  /** A peer of this player's participant is in the meeting. */
  present: boolean;
  /** Their camera is being received and is on. */
  live: boolean;
  track: MediaStreamTrack | null;
};

export type ArbiterCameras = {
  tile(seat: ArbiterSeat): ArbiterTileView;
  /** Called on every change a tile could show. */
  onChange(cb: () => void): () => void;
  /** The guard left the meeting: remote audio (or a stranger's video) could
   *  not be refused. Called once; at once for a listener added after. */
  onFault(cb: () => void): () => void;
  leave(): Promise<void>;
};

export type JoinArbiter = (a: { authToken: string; white: readonly string[]; black: readonly string[] }) => Promise<ArbiterCameras>;

export const ARBITER_MAX_ATTEMPTS = 3;
/** With nothing harmful subscribed, a failing guard retries after these. */
export const ARBITER_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export type ArbiterEvent = "arbiter_enforce_failed" | "arbiter_fail_closed" | "arbiter_leave_failed" | "arbiter_prejoin_failed";
export type ArbiterReport = (event: ArbiterEvent, err: unknown) => void;
const sentryReport: ArbiterReport = (event, err) => {
  Sentry.captureException(err, { level: event === "arbiter_enforce_failed" ? "warning" : "error", tags: { area: "arbiter", event } });
};

export class ArbiterGuardError extends Error {
  constructor(cause: unknown) {
    super("arbiter: remote audio could not be refused; this join was left", { cause });
    this.name = "ArbiterGuardError";
  }
}

const ALL_KINDS = ["video", "screenshareVideo", "audio", "screenshareAudio"] as const;
const NOT_CAMERA = ["screenshareVideo", "audio", "screenshareAudio"] as const;

type Peer = { id: string; userId: string; videoEnabled: boolean; videoTrack?: MediaStreamTrack | undefined } & {
  on(event: "videoUpdate", cb: () => void): unknown;
};
type Meeting = RealtimeKitClient;

export function makeJoinArbiter(
  load: () => Promise<RealtimeKitSdk> = loadRealtimeKitSdk,
  report: ArbiterReport = sentryReport,
  later: (fn: () => void, ms: number) => () => void = (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
): JoinArbiter {
  return async ({ authToken, white, black }) => {
    const seatOf = (userId: string): ArbiterSeat | null =>
      white.includes(userId) ? "white" : black.includes(userId) ? "black" : null;
    const { default: RealtimeKitClient } = await load();
    const meeting: Meeting = await RealtimeKitClient.init({ authToken, defaults: { audio: false, video: false } });
    const { participants } = meeting;
    const joinedPeers = () => [...participants.joined.values()] as unknown as Peer[];

    const listeners = new Set<() => void>();
    const changed = () => {
      for (const cb of [...listeners]) cb();
    };
    // A peer's own videoUpdate (the SDK's setVideoEnabled) is what a tile
    // shows; each peer is watched once, however often it re-appears.
    const watched = new WeakSet<object>();
    const watchPeers = () => {
      for (const p of joinedPeers()) {
        if (watched.has(p)) continue;
        watched.add(p);
        p.on("videoUpdate", changed);
      }
    };

    const enforceOnce = async () => {
      if (participants.maxActiveParticipantsCount !== 0) participants.setMaxActiveParticipantsCount(0);
      if (participants.viewMode !== "MANUAL") await participants.setViewMode("MANUAL");
      const heard = [...participants.audioSubscribed.keys()];
      if (heard.length > 0) await participants.unsubscribe(heard, ["audio", "screenshareAudio"]);
      const strangers = ([...participants.videoSubscribed.values()] as unknown as Peer[])
        .filter((p) => seatOf(p.userId) === null)
        .map((p) => p.id);
      if (strangers.length > 0) await participants.unsubscribe(strangers, [...ALL_KINDS]);
      const missing = joinedPeers()
        .filter((p) => seatOf(p.userId) !== null && !participants.videoSubscribed.has(p.id))
        .map((p) => p.id);
      if (missing.length > 0) {
        // Every kind but the camera refused FIRST (TC allows all four).
        await participants.unsubscribe(missing, [...NOT_CAMERA]);
        await participants.subscribe(missing, ["video"]);
      }
    };

    let running = false;
    let again = false;
    let failures = 0;
    let reported = false;
    let closed = false;
    let cancelRetry: (() => void) | null = null;
    const harmful = () =>
      participants.audioSubscribed.size > 0 ||
      ([...participants.videoSubscribed.values()] as unknown as Peer[]).some((p) => seatOf(p.userId) === null);
    const enforce = async (): Promise<void> => {
      if (closed) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      cancelRetry?.();
      cancelRetry = null;
      try {
        do {
          again = false;
          try {
            await enforceOnce();
            failures = 0;
          } catch (err) {
            failures += 1;
            if (!reported) {
              reported = true;
              report("arbiter_enforce_failed", err);
            }
            if (failures < ARBITER_MAX_ATTEMPTS) {
              again = true;
              continue;
            }
            if (harmful()) {
              await failClosed(err);
              return;
            }
            const wait = ARBITER_RETRY_MS[Math.min(failures - ARBITER_MAX_ATTEMPTS, ARBITER_RETRY_MS.length - 1)]!;
            cancelRetry = later(() => {
              cancelRetry = null;
              void enforce();
            }, wait);
          }
        } while (again && !closed);
      } finally {
        running = false;
      }
      watchPeers();
      changed();
    };

    const faultListeners = new Set<() => void>();
    let leaving: Promise<void> | null = null;
    async function failClosed(err: unknown): Promise<void> {
      closed = true;
      report("arbiter_fail_closed", err);
      leaving = Promise.resolve()
        .then(() => meeting.leave())
        .catch((leaveErr: unknown) => report("arbiter_leave_failed", leaveErr));
      for (const cb of [...faultListeners]) cb();
      changed();
      await leaving;
    }

    try {
      participants.setMaxActiveParticipantsCount(0);
    } catch (err) {
      report("arbiter_prejoin_failed", err);
      throw new ArbiterGuardError(err);
    }
    const watch = () => void enforce();
    participants.audioSubscribed.on("participantJoined", watch);
    participants.videoSubscribed.on("participantJoined", watch);
    // A player arriving is someone to subscribe; one leaving changes a tile.
    participants.joined.on("participantJoined", watch);
    participants.joined.on("participantLeft", changed);
    meeting.self.on("roomJoined", watch);
    meeting.self.on("roomLeft", changed);

    await meeting.join();
    await enforce();
    if (closed) {
      await leaving;
      throw new ArbiterGuardError(new Error("remote audio could not be refused during the join"));
    }

    return {
      tile(seat) {
        if (closed) return { present: false, live: false, track: null };
        const mine = joinedPeers().filter((p) => seatOf(p.userId) === seat);
        const on = mine.find((p) => p.videoEnabled && p.videoTrack !== undefined && participants.videoSubscribed.has(p.id));
        return { present: mine.length > 0, live: on !== undefined, track: on?.videoTrack ?? null };
      },
      onChange(cb) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      onFault(cb) {
        let live = true;
        const relay = () => {
          if (live) cb();
        };
        if (closed) queueMicrotask(relay);
        else faultListeners.add(relay);
        return () => {
          live = false;
          faultListeners.delete(relay);
        };
      },
      async leave() {
        cancelRetry?.();
        cancelRetry = null;
        if (leaving !== null) return leaving;
        closed = true;
        await meeting.leave();
        changed();
      },
    };
  };
}

export const joinArbiter: JoinArbiter = makeJoinArbiter();
