// A stand-in for @cloudflare/realtimekit's browser client — ONLY the parts the
// room's camera loader touches, PORTED from the installed 2.0.2 build
// (node_modules/@cloudflare/realtimekit/dist/index.es.js; line numbers below
// are that file's). The real SDK cannot run headless: its own ClientMock does
// not drive 2.0.2 through a join (measured 2026-10-12: undefined socket
// payloads, a protobuf decode crash), so the end-to-end proof — two real
// participants, `videoSubscribed.size === 0` on each side after join and after
// a forced reconnect — is owed on staging or T17's RealtimeKit fixture.
//
// What is ported, because D7 (players never RECEIVE each other's video) rests
// on it:
//   - setMaxActiveParticipantsCount: 0..24, else throws; once joined it re-runs
//     the active selection (l.18002).
//   - SOCKET_PEERS on every socket (re)join: clears the joined and subscribed
//     maps and resets viewMode to ACTIVE_GRID, then re-adds the peers
//     (l.18385) — a MANUAL view does not survive a reconnect. Re-adding a peer
//     selects nobody (onParticipantSocketJoined, l.18990: `joined.add` only).
//   - The selection runs when the media join completes (selfJoinComplete,
//     l.18405-18418): one UPDATE_ACTIVE per peer (onParticipantMediaJoined,
//     l.~18960), then UPDATE_ACTIVE{createAllConsumers} (l.18963), which
//     clears BOTH subscribed maps and re-selects in the CURRENT mode before
//     scheduling the sync — so it empties them only if the view is MANUAL by
//     then. The server's selected-peer broadcast alone updates no map
//     (computeActivateParticipants → updateActiveParticipantsWithPriorities
//     with emit false). A peer's media-join broadcast (l.18396) is gated on
//     OUR media being joined, which a socket-only drop leaves up: it can land
//     between SOCKET_PEERS and our own selfJoinComplete and select in
//     ACTIVE_GRID (`reconnect({ inWindow })`, review re-2 Q4).
//   - Audio (review re-2 M1): in ACTIVE_GRID `audioSubscribed` =
//     selectActivePeers(cap + 4) (l.18627-18632) — with cap 0, up to three
//     peers, the opponent first. syncConsumers' audio half (l.18696-18702)
//     consumes every audio producer of a subscribed peer, paused or not, and
//     the SDK auto-plays it.
//   - `roomJoined` comes LATER than SOCKET_PEERS: only after the media join's
//     network awaits (joinMediaRoom, l.24515-24535; on a socket rejoin via
//     SOCKET_SERVICE_RECONNECTED → resetSelf → joinRoom, l.24416). Anything
//     the ACTIVE_GRID selection subscribes in between is consumed by the
//     scheduled sync before `roomJoined` fires — so a guard on `roomJoined`
//     alone is too late; the map watchdog is what closes that window.
//   - A media-node reconnect is a separate path: roomLeft then
//     roomJoined({reconnected: true}) with NO SOCKET_PEERS (l.24411-24413).
//     A socket drop also emits roomLeft (SOCKET_SERVICE_DISCONNECTED,
//     l.24419).
//   - Every participant starts with manualProducerConfig = TC, all four kinds
//     TRUE (l.4954, l.17469): unsubscribing "video" alone leaves the peer in
//     videoSubscribed for its screen share (l.18137), which is then consumed.
//   - ACTIVE_GRID selection, `selectActivePeers` (l.18580), verbatim —
//     INCLUDING its arithmetic for a viewer on stage: with a cap of 0 it
//     computes `o = -1` and `slice(0, -1)`, so when the server has selected two
//     or more peers (the opponent and an arbiter), ONE stays subscribed. A cap
//     of 0 alone does not close D7.
//   - syncConsumers (l.18680): video is consumed only for peers in
//     `videoSubscribed`, per producer, honouring `manualProducerConfig`, and
//     runs on a timer after each selection (scheduleSyncConsumers, l.18640).
//   - subscribe/unsubscribe refuse outside MANUAL (l.18105, l.18128).
//   - NEW_PRODUCER / PRODUCER_TOGGLE / PRODUCER_CLOSED mutate
//     `participant.producers` and emit no participant event (l.18445-18500).
//
// MODELLED_SDK_VERSION is pinned against package.json by camera-loader.test,
// so an SDK upgrade fails until this port is re-read against the new build.
export const MODELLED_SDK_VERSION = "2.0.2";

type Listener = (...args: never[]) => void;

class Emitter {
  #ls = new Map<string, Set<Listener>>();
  on(event: string, cb: Listener): this {
    if (!this.#ls.has(event)) this.#ls.set(event, new Set());
    this.#ls.get(event)!.add(cb);
    return this;
  }
  removeListener(event: string, cb: Listener): this {
    this.#ls.get(event)?.delete(cb);
    return this;
  }
  off(event: string, cb: Listener): this {
    return this.removeListener(event, cb);
  }
  emit(event: string, ...args: unknown[]): boolean {
    for (const cb of [...(this.#ls.get(event) ?? [])]) (cb as (...a: unknown[]) => void)(...args);
    return true;
  }
  listeners(event: string): number {
    return this.#ls.get(event)?.size ?? 0;
  }
}

export type FakeProducer = { producerId: string; kind: "audio" | "video"; pause: boolean; screenShare: boolean };

export class FakePeer extends Emitter {
  stageStatus = "ON_STAGE";
  producers: FakeProducer[] = [];
  // TC (l.4954): every kind allowed until a MANUAL unsubscribe says otherwise.
  manualProducerConfig: { video?: boolean; screenshareVideo?: boolean; audio?: boolean; screenshareAudio?: boolean } = {
    audio: true,
    video: true,
    screenshareAudio: true,
    screenshareVideo: true,
  };
  constructor(
    public id: string,
    public userId: string,
  ) {
    super();
  }
}

/** ClientMap: a Map that emits on add/delete (l.17740). */
class PeerMap extends Map<string, FakePeer> {
  #em = new Emitter();
  on(event: string, cb: Listener): this {
    this.#em.on(event, cb);
    return this;
  }
  removeListener(event: string, cb: Listener): this {
    this.#em.removeListener(event, cb);
    return this;
  }
  off(event: string, cb: Listener): this {
    return this.removeListener(event, cb);
  }
  emit(event: string, ...args: unknown[]): boolean {
    return this.#em.emit(event, ...args);
  }
  add(p: FakePeer, emit = true): this {
    this.set(p.id, p);
    if (emit) this.emit("participantJoined", p);
    return this;
  }
  override delete(id: string, emit = true): boolean {
    const p = this.get(id);
    const had = super.delete(id);
    if (had && emit && p) this.emit("participantLeft", p);
    return had;
  }
  override clear(emit = true): void {
    super.clear();
    if (emit) this.emit("participantsCleared");
  }
}

type ViewMode = "ACTIVE_GRID" | "PAGINATED" | "MANUAL";
type Kind = "audio" | "video" | "screenshareAudio" | "screenshareVideo";
const ALL_KINDS: Kind[] = ["audio", "video", "screenshareAudio", "screenshareVideo"];

class FakeParticipants extends Emitter {
  joined = new PeerMap();
  videoSubscribed = new PeerMap();
  audioSubscribed = new PeerMap();
  pinned = new PeerMap();
  viewMode: ViewMode = "ACTIVE_GRID";
  #max: number;
  constructor(
    private m: FakeMeeting,
    presetMax: number,
  ) {
    super();
    this.#max = presetMax; // setupControllers: the preset's max_video_streams (l.26749)
  }
  get maxActiveParticipantsCount(): number {
    return this.#max;
  }
  setMaxActiveParticipantsCount(limit: number): void {
    this.m.calls.push(`setMax:${limit}`);
    if (limit < 0 || limit > 24) throw new Error("0 <= Max active participants count limit <= 24");
    this.#max = limit;
    if (this.m.socketJoined) this.m.updateActive();
  }
  async setViewMode(mode: ViewMode): Promise<void> {
    this.m.calls.push(`setViewMode:${mode}`);
    this.m.injectedFailure("setViewMode");
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    if (mode !== "MANUAL") this.m.updateActive();
    this.emit("viewModeChanged", { viewMode: mode });
  }
  async subscribe(ids: string[], kinds: Kind[] = ALL_KINDS): Promise<void> {
    if (this.viewMode !== "MANUAL") throw new Error("MANUAL subscription mode was not activated.");
    for (const id of ids) {
      const n = this.joined.get(id);
      if (!n) continue;
      if (kinds.includes("audio")) {
        n.manualProducerConfig = { ...n.manualProducerConfig, audio: true };
        if (!this.audioSubscribed.has(n.id)) this.audioSubscribed.add(n);
      }
      if (kinds.includes("video")) {
        n.manualProducerConfig = { ...n.manualProducerConfig, video: true };
        if (!this.videoSubscribed.has(n.id)) this.videoSubscribed.add(n);
      }
      if (kinds.includes("screenshareAudio")) {
        n.manualProducerConfig = { ...n.manualProducerConfig, screenshareAudio: true };
        if (!this.audioSubscribed.has(n.id)) this.audioSubscribed.add(n);
      }
      if (kinds.includes("screenshareVideo")) {
        n.manualProducerConfig = { ...n.manualProducerConfig, screenshareVideo: true };
        if (!this.videoSubscribed.has(n.id)) this.videoSubscribed.add(n);
      }
    }
    this.m.updateActive();
  }
  async unsubscribe(ids: string[], kinds: Kind[] = ALL_KINDS): Promise<void> {
    this.m.calls.push(`unsubscribe:${ids.join(",")}:${kinds.join("+")}`);
    if (this.viewMode !== "MANUAL") throw new Error("MANUAL subscription mode was not activated.");
    this.m.injectedFailure("unsubscribe");
    const hook = this.m.duringNextUnsubscribe;
    this.m.duringNextUnsubscribe = null;
    hook?.(this.m);
    for (const id of ids) {
      const n = this.joined.get(id);
      if (!n) continue;
      if (kinds.includes("audio")) {
        n.manualProducerConfig = { ...n.manualProducerConfig, audio: false };
        if (!n.manualProducerConfig.screenshareAudio) this.audioSubscribed.delete(n.id);
      }
      if (kinds.includes("screenshareAudio")) {
        n.manualProducerConfig = { ...n.manualProducerConfig, screenshareAudio: false };
        if (!n.manualProducerConfig.audio) this.audioSubscribed.delete(n.id);
      }
      if (kinds.includes("video")) {
        n.manualProducerConfig = { ...n.manualProducerConfig, video: false };
        if (!n.manualProducerConfig.screenshareVideo) this.videoSubscribed.delete(n.id);
      }
      if (kinds.includes("screenshareVideo")) {
        n.manualProducerConfig = { ...n.manualProducerConfig, screenshareVideo: false };
        if (!n.manualProducerConfig.video) this.videoSubscribed.delete(n.id);
      }
    }
    this.m.updateActive();
  }
}

class FakeSelf extends Emitter {
  id = "self-peer";
  stageStatus = "ON_STAGE";
  videoEnabled = true;
  videoTrack = { id: "own-camera" } as unknown as MediaStreamTrack;
  constructor(public userId: string) {
    super();
  }
  async enableVideo(): Promise<void> {
    this.videoEnabled = true;
    this.emit("videoUpdate", { videoEnabled: true, videoTrack: this.videoTrack });
  }
}

export class FakeMeeting {
  calls: string[] = [];
  self: FakeSelf;
  participants: FakeParticipants;
  meta = new Emitter();
  /** The server's selected peers: compulsory + active speakers (l.17850). */
  selectedPeers: string[] = [];
  /** Who the server holds in the room, joined or not yet seen by us. */
  roster: FakePeer[] = [];
  socketJoined = false;
  /** Every remote VIDEO consumer this client ever created — D7's evidence. */
  consumedVideo: { peerId: string; producerId: string }[] = [];
  /** Every remote AUDIO consumer — the SDK auto-plays these. */
  consumedAudio: { peerId: string; producerId: string }[] = [];
  // ── test seams (not SDK behaviour) ────────────────────────────────────
  /** Make the next N calls of a method throw, as a future SDK might. */
  failNext: { setViewMode: number; unsubscribe: number; leave: number } = { setViewMode: 0, unsubscribe: 0, leave: 0 };
  /** Runs once inside the next unsubscribe — an arrival mid-enforcement. */
  duringNextUnsubscribe: ((m: FakeMeeting) => void) | null = null;
  injectedFailure(method: "setViewMode" | "unsubscribe" | "leave"): void {
    if (this.failNext[method] > 0) {
      this.failNext[method] -= 1;
      throw new Error(`injected ${method} failure`);
    }
  }
  constructor(
    public authToken: string,
    selfUserId: string,
    presetMax: number,
  ) {
    this.self = new FakeSelf(selfUserId);
    this.participants = new FakeParticipants(this, presetMax);
  }

  async join(): Promise<void> {
    this.calls.push("join");
    this.socketPeers();
    await mediaJoinGap();
    this.selfJoinComplete();
    await mediaJoinGap(); // shareMediaTracks (l.24535)
    this.self.emit("roomJoined", { reconnected: false });
  }
  async leave(): Promise<void> {
    this.calls.push("leave");
    this.injectedFailure("leave");
    this.socketJoined = false;
    this.self.emit("roomLeft", { state: "left" });
  }

  /** SOCKET_PEERS (l.18385). The room-joined notice is NOT here: it follows
   *  the media join's network awaits (see the callers). */
  private socketPeers(): void {
    const p = this.participants;
    p.videoSubscribed.clear();
    p.audioSubscribed.clear();
    p.pinned.clear();
    p.joined.clear();
    p.viewMode = "ACTIVE_GRID";
    this.socketJoined = true;
    for (const peer of this.roster) p.joined.add(peer);
  }

  /** selfJoinComplete (l.18405-18418): each peer's media join, then the
   *  createAllConsumers update. */
  private selfJoinComplete(): void {
    for (const peer of this.roster) if (this.participants.joined.has(peer.id)) this.updateActive();
    this.updateActive({ createAllConsumers: true });
  }

  /** UPDATE_ACTIVE → updateMediaSubscribedMaps (l.18601), then a consumer
   *  sync on a timer (scheduleSyncConsumers, l.18640). */
  updateActive(opts: { createAllConsumers?: boolean } = {}): void {
    const p = this.participants;
    if (opts.createAllConsumers) {
      p.videoSubscribed.clear();
      p.audioSubscribed.clear();
    }
    if (p.viewMode === "ACTIVE_GRID") {
      updateMap(p.videoSubscribed, this.selectActivePeers(p.maxActiveParticipantsCount), p.joined);
      updateMap(p.audioSubscribed, this.selectActivePeers(p.maxActiveParticipantsCount + 4), p.joined);
    }
    setTimeout(() => this.syncConsumers(), 0);
  }

  /** selectActivePeers (l.18580), verbatim. */
  selectActivePeers(s: number): string[] {
    const p = this.participants;
    const onStage = new Set<string>();
    const e = [...p.joined.values()].filter((h) => h.stageStatus === "ON_STAGE").map((h) => (onStage.add(h.id), h.id));
    const r = this.selectedPeers;
    const i = [...p.pinned.values()].filter((g) => g.stageStatus === "ON_STAGE").map((g) => g.id);
    const n = this.self.stageStatus === "ON_STAGE" ? 1 : 0;
    const o = s - n;
    const c = new Set(r.concat(i).filter((h) => h !== this.self.id && onStage.has(h)));
    let d = Array.from(c);
    const l = o - c.size;
    if (l >= 0) {
      const h = e.filter((g) => !c.has(g) && g !== this.self.id).slice(0, l);
      d = Array.from(c).concat(h);
    } else d = d.slice(0, o);
    return d;
  }

  /** syncConsumers (l.18680): the video half, then the audio half. */
  private syncConsumers(): void {
    const p = this.participants;
    if (!this.socketJoined) return;
    for (const sub of p.videoSubscribed.values()) {
      const j = p.joined.get(sub.id);
      if (!j) continue;
      for (const x of sub.producers.filter((k) => k.kind === "video")) {
        const cam = (j.manualProducerConfig.video ?? true) && !x.screenShare;
        const share = (j.manualProducerConfig.screenshareVideo ?? true) && x.screenShare;
        if ((cam || share) && !x.pause && !this.consumedVideo.some((c) => c.producerId === x.producerId)) {
          this.consumedVideo.push({ peerId: sub.id, producerId: x.producerId });
        }
      }
    }
    for (const sub of p.audioSubscribed.values()) {
      const j = p.joined.get(sub.id);
      if (!j) continue;
      for (const x of sub.producers.filter((k) => k.kind === "audio")) {
        const mic = (j.manualProducerConfig.audio ?? true) && !x.screenShare;
        const share = (j.manualProducerConfig.screenshareAudio ?? true) && x.screenShare;
        // No pause check for audio (l.18701).
        if ((mic || share) && !this.consumedAudio.some((c) => c.producerId === x.producerId)) {
          this.consumedAudio.push({ peerId: sub.id, producerId: x.producerId });
        }
      }
    }
  }

  // ── the server's side, driven by tests ────────────────────────────────
  peerJoins(peerId: string, userId: string): FakePeer {
    const peer = new FakePeer(peerId, userId);
    this.roster.push(peer);
    if (this.socketJoined) {
      this.participants.joined.add(peer);
      this.updateActive();
    }
    return peer;
  }
  peerLeaves(peerId: string): void {
    this.roster = this.roster.filter((x) => x.id !== peerId);
    if (!this.socketJoined) return;
    this.participants.joined.delete(peerId);
    this.participants.pinned.delete(peerId);
    this.updateActive();
    this.participants.videoSubscribed.delete(peerId);
    this.participants.audioSubscribed.delete(peerId);
  }
  /** NEW_PRODUCER (l.18445): the producer list only; a consumer sync only
   *  if the peer is subscribed for that kind, or it is a screen share. */
  produce(peerId: string, producer: Omit<FakeProducer, "pause"> & { pause?: boolean }): void {
    const peer = this.roster.find((x) => x.id === peerId);
    if (!peer) throw new Error(`no peer ${peerId}`);
    peer.producers.push({ pause: false, ...producer });
    const subscribed = producer.kind === "audio" ? this.participants.audioSubscribed : this.participants.videoSubscribed;
    if (subscribed.has(peerId) || producer.screenShare) setTimeout(() => this.syncConsumers(), 0);
  }
  /** PRODUCER_TOGGLE (l.18489): flips `pause`, nothing else. */
  toggle(peerId: string, producerId: string, pause: boolean): void {
    const x = this.roster.find((r) => r.id === peerId)?.producers.find((q) => q.producerId === producerId);
    if (x) x.pause = pause;
  }
  /** PRODUCER_CLOSED: drops it from the list. */
  closeProducer(peerId: string, producerId: string): void {
    const peer = this.roster.find((r) => r.id === peerId);
    if (peer) peer.producers = peer.producers.filter((q) => q.producerId !== producerId);
  }
  /** The server changes its selected peers (SELECTED_PEERS_DIFF). */
  select(peerIds: string[]): void {
    this.selectedPeers = peerIds;
    if (this.socketJoined) this.updateActive();
  }
  dropSocket(): void {
    this.socketJoined = false;
    this.meta.emit("socketConnectionUpdate", { state: "disconnected", reconnected: false, reconnectionAttempt: 0 });
    this.self.emit("roomLeft", { state: "disconnected" });
  }
  /** The socket drops and comes back (l.14463, l.24416): connected, then
   *  SOCKET_PEERS, then — after the media join's awaits — selfJoinComplete
   *  and roomJoined. `inWindow` runs between SOCKET_PEERS and the media join
   *  (e.g. a peer's media-join broadcast). */
  async reconnect(opts: { inWindow?: (m: FakeMeeting) => void } = {}): Promise<void> {
    this.dropSocket();
    this.meta.emit("socketConnectionUpdate", { state: "connected", reconnected: true, reconnectionAttempt: undefined });
    this.socketPeers();
    opts.inWindow?.(this);
    await mediaJoinGap();
    this.selfJoinComplete();
    await mediaJoinGap();
    this.self.emit("roomJoined", { reconnected: true });
  }
  /** A peer's media-join broadcast (l.18396 → onParticipantMediaJoined):
   *  UPDATE_ACTIVE in the CURRENT view mode. */
  peerMediaJoined(peerId: string): void {
    if (this.participants.joined.has(peerId)) this.updateActive();
  }
  /** The media node drops and comes back; the socket and its peers stay
   *  (ROOM_NODE_DISCONNECTED / ROOM_NODE_RECONNECTED, l.24411-24413). */
  async mediaReconnect(): Promise<void> {
    this.self.emit("roomLeft", { state: "disconnected" });
    await mediaJoinGap();
    // "Transport reconnected" (l.22656): UPDATE_ACTIVE{createAllConsumers}.
    this.updateActive({ createAllConsumers: true });
    this.self.emit("roomJoined", { reconnected: true });
  }
}

/** The media join's network round trips: at least one macrotask, so a
 *  consumer sync scheduled by SOCKET_PEERS runs first. */
function mediaJoinGap(): Promise<void> {
  return new Promise((r) => setTimeout(r, 1));
}

function updateMap(map: PeerMap, ids: string[], joined: PeerMap): void {
  for (const id of [...map.keys()]) if (!ids.includes(id)) map.delete(id);
  for (const id of ids) if (!map.has(id) && joined.get(id)) map.add(joined.get(id)!);
  map.emit("participantsUpdate");
}

/** A fake `@cloudflare/realtimekit` module for camera-loader's injected
 *  loader. `presetMaxVideoStreams` stands for the player preset's
 *  `max_video_streams` (6 is the SDK's own default preset, l.5887). */
export function fakeRealtimeKit(
  opts: { presetMaxVideoStreams?: number; selfUserId?: string; setup?: (m: FakeMeeting) => void } = {},
) {
  const meetings: FakeMeeting[] = [];
  const mod = {
    default: {
      init: async (o: { authToken: string }) => {
        const m = new FakeMeeting(o.authToken, opts.selfUserId ?? "self-user", opts.presetMaxVideoStreams ?? 6);
        // The room as the server holds it when this client arrives.
        opts.setup?.(m);
        meetings.push(m);
        return m;
      },
    },
  };
  return { load: async () => mod as never, meetings };
}
