// The ONE import site for Cloudflare RealtimeKit's browser SDK (Apache-2.0),
// loaded on demand so a room with camera policy `off` — and every page that
// is not a room — never downloads it.
//
// What the player's browser does with it, and nothing more (design §5): join
// the fixture's meeting with the caller's OWN participant token, audio off,
// and publish their camera.
//
// D7 (spec §5.3, review NEW-1, re-2 M1): a player never RECEIVES another
// participant's video or audio — not hidden, not received. The SDK's default
// view subscribes to the most active peers, up to the preset's
// `max_video_streams` (and cap + 4 for audio), so this module:
//   - caps the active set at 0 BEFORE join (setMaxActiveParticipantsCount —
//     a context value the SDK does not reset on a socket rejoin);
//   - on every (re)join, switches to the MANUAL view — the SDK resets the view
//     to ACTIVE_GRID on every socket (re)join, so this is re-asserted each
//     time;
//   - watches BOTH subscribed maps and unsubscribes anyone who appears in
//     either, for all four kinds (camera, screen share, microphone, screen
//     audio). The cap alone is not enough in 2.0.2: for a viewer
//     on stage the SDK's selection computes `cap - 1` and keeps one peer when
//     the server has selected two or more (the opponent and an arbiter); and
//     after a socket rejoin that selection runs before `roomJoined` fires, so
//     only a watch on the map itself is in time. Every participant starts
//     with every kind allowed (the SDK's TC default), so unsubscribing
//     "video" alone would leave the opponent subscribed for a screen share.
//     See __tests__/_fake-realtimekit.ts for the SDK lines.
//   - listens to `participantJoined` only (re-2 M2): every addition to a
//     subscribed map emits it (ClientMap.set l.14229 — selections at
//     l.18839/l.18846 and subscribe() at l.18111-18119); `participantsUpdate`
//     ends a selection whose additions have already emitted, so it can never
//     be the first or only sign of a subscription.
//   - never swallows a failure (re-2 M3): an arrival mid-run queues a re-run;
//     a call that throws is reported (once per camera) and retried at once.
//   - fails CLOSED only when there is something to refuse (re-review 3,
//     I-1, controller ruling 2026-10-12): after D7_MAX_ATTEMPTS in a row
//     with a remote peer actually in a subscribed map, it leaves the meeting
//     — before the SDK's consumer sync, so nothing is received — and tells
//     its owner (onFault): camera-session re-joins a FRESH meeting, which
//     starts capped before join, and stamps the gap on the server as OUR
//     fault. With nothing subscribed it stays in the meeting, keeps
//     publishing and retries quietly on D7_QUIET_RETRY_MS. A failure to cap
//     before the join rejects the join with D7GuardError: ours, never the
//     player's.
// The player preset's `max_video_streams` = 0 on stg and prod is the
// server-held half (owner, Cloudflare dashboard). A tampered client can still
// subscribe in a shared meeting; that is the owner's per-player-meeting
// question, not something a client can enforce.
//
// Presence (review I8): the opponent's pill is read from THIS join's own
// signalling — who is in the meeting, and whether they have a live camera
// producer — at zero network cost. Membership and producers arrive without
// any media subscription; `participant.videoEnabled` does NOT (it changes only
// through consumer events, which D7 forbids), so it is never read.
import type RealtimeKitClient from "@cloudflare/realtimekit";
import * as Sentry from "@sentry/nextjs";

/** Another participant as this client's signalling holds them. */
export type PeerView = { userId: string; videoLive: boolean };
/** What the pill reads: the other participants, and when this client last
 *  (re)joined the meeting (the pill waits for the peer list to settle). */
export type MeetingLink = { joinedAt: number; peers: PeerView[] };

export type OwnCamera = {
  /** The local camera track while publishing, else null. */
  track(): MediaStreamTrack | null;
  /** Called on every change of the published camera (enabled + track). */
  onChange(cb: (enabled: boolean, track: MediaStreamTrack | null) => void): () => void;
  /** Turn the camera back on after it was turned off or dropped. */
  enable(): Promise<void>;
  leave(): Promise<void>;
  /** The meeting as this client sees it, or null while it is not in it:
   *  before the join completes, with the socket down, after leaving. */
  link(): MeetingLink | null;
  /** Called whenever someone joins or leaves, or this client's own
   *  connection changes. Producer changes emit nothing — read on a timer. */
  onLinkChange(cb: () => void): () => void;
  /** The guard left the meeting (D7): a remote peer was subscribed and could
   *  not be refused. This camera is over — join a fresh one. Called once; at
   *  once (next microtask) for a listener added after it happened. */
  onFault(cb: () => void): () => void;
};

export type JoinOwnCamera = (authToken: string) => Promise<OwnCamera>;

/** Consecutive failed enforcement runs before the camera fails closed —
 *  retried at once, so a remote stream is never consumed meanwhile. */
export const D7_MAX_ATTEMPTS = 3;
/** With NOTHING remote subscribed, a guard that keeps failing stays in the
 *  meeting and retries after these waits (the last one repeating). */
export const D7_QUIET_RETRY_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
export type D7Event = "d7_enforce_failed" | "d7_fail_closed" | "d7_leave_failed" | "d7_prejoin_failed";
export type D7Report = (event: D7Event, err: unknown) => void;
const sentryReport: D7Report = (event, err) => {
  Sentry.captureException(err, { level: event === "d7_enforce_failed" ? "warning" : "error", tags: { area: "match-room", event } });
};
const ALL_KINDS = ["video", "screenshareVideo", "audio", "screenshareAudio"] as const;

/** The join did not hold because OUR guard could not (D7) — never the
 *  player's camera, permission or device. camera-session re-joins. */
export class D7GuardError extends Error {
  constructor(cause: unknown) {
    super("D7: remote media could not be refused; this join was left", { cause });
    this.name = "D7GuardError";
  }
}

export type D7Timing = {
  /** Test seam: how a quiet retry is scheduled. Returns a cancel. */
  later?: (fn: () => void, ms: number) => () => void;
};
const realLater = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

type Meeting = RealtimeKitClient;
type SdkModule = { default: { init(o: { authToken: string; defaults: { audio: boolean; video: boolean } }): Promise<Meeting> } };

/** Built over the SDK module so the join can be driven in node over a port
 *  of the SDK's subscription rules (camera-loader.test.ts). */
export function makeJoinOwnCamera(
  load: () => Promise<SdkModule>,
  report: D7Report = sentryReport,
  timing: D7Timing = {},
): JoinOwnCamera {
  const later = timing.later ?? realLater;
  return async (authToken) => {
    const { default: RealtimeKitClient } = await load();
    const meeting = await RealtimeKitClient.init({ authToken, defaults: { audio: false, video: true } });
    const { self, participants } = meeting;

    // ── D7 ───────────────────────────────────────────────────────────────
    const enforceOnce = async () => {
      // Only when it differs: once joined, the SDK re-runs its selection on
      // every set.
      if (participants.maxActiveParticipantsCount !== 0) participants.setMaxActiveParticipantsCount(0);
      if (participants.viewMode !== "MANUAL") await participants.setViewMode("MANUAL");
      const ids = [...new Set([...participants.videoSubscribed.keys(), ...participants.audioSubscribed.keys()])];
      if (ids.length > 0) await participants.unsubscribe(ids, [...ALL_KINDS]);
    };
    let running = false;
    let again = false;
    let failures = 0;
    let reported = false;
    let closed = false;
    let cancelQuiet: (() => void) | null = null;
    const stopQuiet = () => {
      cancelQuiet?.();
      cancelQuiet = null;
    };
    // Something to refuse: a remote peer in either subscribed map.
    const receiving = () => participants.videoSubscribed.size + participants.audioSubscribed.size > 0;
    const enforce = async (): Promise<void> => {
      if (closed) return;
      // An arrival while a run is in flight is never dropped: the run goes
      // round again once it finishes.
      if (running) {
        again = true;
        return;
      }
      running = true;
      stopQuiet();
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
              report("d7_enforce_failed", err);
            }
            if (failures < D7_MAX_ATTEMPTS) {
              again = true;
              continue;
            }
            if (receiving()) {
              await failClosed(err);
              return;
            }
            // Nothing to refuse: stay, keep publishing, try again later.
            stopQuiet();
            const wait = D7_QUIET_RETRY_MS[Math.min(failures - D7_MAX_ATTEMPTS, D7_QUIET_RETRY_MS.length - 1)]!;
            cancelQuiet = later(() => {
              cancelQuiet = null;
              void enforce();
            }, wait);
          }
        } while (again && !closed);
      } finally {
        running = false;
      }
    };
    try {
      participants.setMaxActiveParticipantsCount(0);
    } catch (err) {
      // Nothing joined yet, so nothing received; but without the cap the
      // join would subscribe by default. Ours: the owner re-joins later.
      report("d7_prejoin_failed", err);
      throw new D7GuardError(err);
    }
    const watch = () => void enforce();
    participants.videoSubscribed.on("participantJoined", watch);
    participants.audioSubscribed.on("participantJoined", watch);

    // ── presence ─────────────────────────────────────────────────────────
    let joinedAt: number | null = null;
    const linkListeners = new Set<() => void>();
    const changed = () => {
      for (const cb of [...linkListeners]) cb();
    };
    self.on("roomJoined", () => {
      if (closed) return;
      joinedAt = Date.now();
      void enforce();
      changed();
    });
    // A socket drop or failure and a media-node drop all emit roomLeft (SDK
    // l.24413, l.24419, l.24423); every rejoin ends in roomJoined.
    self.on("roomLeft", () => {
      joinedAt = null;
      changed();
    });
    participants.joined.on("participantJoined", changed);
    participants.joined.on("participantLeft", changed);

    // ── fail closed ──────────────────────────────────────────────────────
    // A FAULT for the owner to heal (a fresh join), never the camera going
    // off: "camera off" is the player's, and this is ours.
    const faultListeners = new Set<() => void>();
    let leaving: Promise<void> | null = null;
    async function failClosed(err: unknown): Promise<void> {
      closed = true;
      stopQuiet();
      report("d7_fail_closed", err);
      joinedAt = null;
      changed();
      // The owner hears it FIRST (it stamps our fault on the server before
      // the leave, so no stretch of the gap is unstamped); the leave runs on
      // the next microtask — still before the SDK's consumer sync, a
      // macrotask — and is the one leave every later caller awaits.
      leaving = Promise.resolve()
        .then(() => meeting.leave())
        .catch((leaveErr: unknown) => report("d7_leave_failed", leaveErr));
      for (const cb of [...faultListeners]) cb();
      await leaving;
    }

    await meeting.join();
    if (joinedAt === null && !closed) joinedAt = Date.now();
    await enforce();
    if (closed) {
      // Failed closed during the join itself: no camera to hand back.
      await leaving;
      throw new D7GuardError(new Error("remote media could not be refused during the join"));
    }

    const current = () => (!closed && self.videoEnabled && self.videoTrack ? self.videoTrack : null);
    return {
      track: current,
      onChange(cb) {
        const handler = (p: { videoEnabled: boolean; videoTrack: MediaStreamTrack }) => {
          if (!closed) cb(p.videoEnabled, p.videoEnabled ? p.videoTrack : null);
        };
        self.on("videoUpdate", handler);
        return () => self.removeListener("videoUpdate", handler);
      },
      async enable() {
        if (closed) throw new Error("this camera left the meeting (D7); a fresh join replaces it");
        await self.enableVideo();
      },
      async leave() {
        stopQuiet();
        // After a fail-close the meeting is already being left: the same leave.
        if (leaving !== null) return leaving;
        await meeting.leave();
        joinedAt = null;
        changed();
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
      link() {
        if (joinedAt === null) return null;
        const peers = [...participants.joined.values()].map((p) => ({
          userId: p.userId,
          videoLive: p.producers.some((x) => x.kind === "video" && !x.screenShare && !x.pause),
        }));
        return { joinedAt, peers };
      },
      onLinkChange(cb) {
        linkListeners.add(cb);
        return () => {
          linkListeners.delete(cb);
        };
      },
    };
  };
}

export const joinOwnCamera: JoinOwnCamera = makeJoinOwnCamera(() => import("@cloudflare/realtimekit") as Promise<SdkModule>);
