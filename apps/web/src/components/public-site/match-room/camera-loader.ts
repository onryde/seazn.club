// The ONE import site for Cloudflare RealtimeKit's browser SDK (Apache-2.0),
// loaded on demand so a room with camera policy `off` — and every page that
// is not a room — never downloads it.
//
// What the player's browser does with it, and nothing more (design §5): join
// the fixture's meeting with the caller's OWN participant token, audio off,
// and publish their camera.
//
// D7 (spec §5.3, review NEW-1): a player never RECEIVES another participant's
// video — not hidden, not received. The SDK's default view subscribes to the
// most active peers, up to the preset's `max_video_streams`, so this module:
//   - caps the active set at 0 BEFORE join (setMaxActiveParticipantsCount —
//     a context value the SDK does not reset on a socket rejoin);
//   - on every (re)join, switches to the MANUAL view — the SDK resets the view
//     to ACTIVE_GRID on every socket (re)join, so this is re-asserted each
//     time;
//   - watches the subscribed set and unsubscribes anyone who appears in it.
//     The cap alone is not enough in 2.0.2: for a viewer on stage the SDK's
//     selection computes `cap - 1` and keeps one peer when the server has
//     selected two or more (the opponent and an arbiter), see
//     __tests__/_fake-realtimekit.ts.
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
};

export type JoinOwnCamera = (authToken: string) => Promise<OwnCamera>;

type Meeting = RealtimeKitClient;
type SdkModule = { default: { init(o: { authToken: string; defaults: { audio: boolean; video: boolean } }): Promise<Meeting> } };

/** Built over the SDK module so the join can be driven in node over a port
 *  of the SDK's subscription rules (camera-loader.test.ts). */
export function makeJoinOwnCamera(load: () => Promise<SdkModule>): JoinOwnCamera {
  return async (authToken) => {
    const { default: RealtimeKitClient } = await load();
    const meeting = await RealtimeKitClient.init({ authToken, defaults: { audio: false, video: true } });
    const { self, participants, meta } = meeting;

    // ── D7 ───────────────────────────────────────────────────────────────
    let enforcing = false;
    const noRemoteVideo = async () => {
      if (enforcing) return;
      enforcing = true;
      try {
        // Only when it differs: once joined, the SDK re-runs its selection on
        // every set, which emits the update this watches.
        if (participants.maxActiveParticipantsCount !== 0) participants.setMaxActiveParticipantsCount(0);
        if (participants.viewMode !== "MANUAL") await participants.setViewMode("MANUAL");
        const subscribed = [...participants.videoSubscribed.keys()];
        if (subscribed.length > 0) await participants.unsubscribe(subscribed, ["video", "screenshareVideo"]);
      } catch {
        // The SDK refused a call it documents; the next update re-asserts.
      } finally {
        enforcing = false;
      }
    };
    participants.setMaxActiveParticipantsCount(0);
    const watch = () => void noRemoteVideo();
    participants.videoSubscribed.on("participantsUpdate", watch);
    participants.videoSubscribed.on("participantJoined", watch);

    // ── presence ─────────────────────────────────────────────────────────
    let joinedAt: number | null = null;
    const linkListeners = new Set<() => void>();
    const changed = () => {
      for (const cb of [...linkListeners]) cb();
    };
    self.on("roomJoined", () => {
      joinedAt = Date.now();
      void noRemoteVideo();
      changed();
    });
    self.on("roomLeft", () => {
      joinedAt = null;
      changed();
    });
    meta.on("socketConnectionUpdate", ({ state }) => {
      if (state === "connected") return; // roomJoined follows a rejoin
      joinedAt = null;
      changed();
    });
    participants.joined.on("participantJoined", changed);
    participants.joined.on("participantLeft", changed);

    await meeting.join();
    if (joinedAt === null) joinedAt = Date.now();
    await noRemoteVideo();

    const current = () => (self.videoEnabled && self.videoTrack ? self.videoTrack : null);
    return {
      track: current,
      onChange(cb) {
        let live = true;
        const handler = (p: { videoEnabled: boolean; videoTrack: MediaStreamTrack }) => {
          if (live) cb(p.videoEnabled, p.videoEnabled ? p.videoTrack : null);
        };
        self.on("videoUpdate", handler);
        return () => {
          live = false;
          self.removeListener("videoUpdate", handler);
        };
      },
      async enable() {
        await self.enableVideo();
      },
      async leave() {
        await meeting.leave();
        joinedAt = null;
        changed();
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
