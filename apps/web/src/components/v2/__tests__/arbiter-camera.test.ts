// T15 — the arbiter's receive side (design §5.3; D16 §5.6.4: a meeting per
// PLAYER, the arbiter in one at a time; "Chess needs no audio"; controller
// addendum 2026-10-12: "the arbiter receives NO audio. Assert it.").
//
// Driven through the REAL loader (`makeJoinArbiter`) over the same port of the
// SDK's subscription rules the player's D7 guard is proven on
// (match-room/__tests__/_fake-realtimekit.ts, line references inside). The
// expected values are the scenario's own producers, never the loader's
// output: the arbiter consumes exactly the CAMERA of the player whose meeting
// it joined, and nothing else - no microphone, no screen share, no other
// participant (the OPPONENT included, who is never in this meeting but would be
// refused if they were) - however the server selects and however often the
// socket rejoins.
//
// Both sides (controller ruling): the player's guard (`makeJoinOwnCamera`) is
// untouched by any of this and still receives NOTHING in the very meeting the
// arbiter watches - the last describe drives both loaders over one roster.
import { describe, expect, it } from "vitest";
import { makeJoinOwnCamera } from "@/components/public-site/match-room/camera-loader";
import { fakeRealtimeKit, type FakeMeeting } from "@/components/public-site/match-room/__tests__/_fake-realtimekit";
import { ARBITER_MAX_ATTEMPTS, ArbiterGuardError, makeJoinArbiter, type ArbiterCameras, type ArbiterReport } from "../arbiter-camera";

const W = { peer: "w-peer", user: "rtk-white" };
const B = { peer: "b-peer", user: "rtk-black" };
const OTHER = { peer: "x-peer", user: "rtk-someone-else" };
/** The meeting the arbiter joined: one player's, W by default. B is then a stranger to it - the OTHER player, who has a
 *  meeting of their own and must never be received here. */
const PLAYERS = { players: [W.user] };

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
}
const cam = (m: FakeMeeting, peer: string) => m.produce(peer, { producerId: `${peer}-cam`, kind: "video", screenShare: false });
const mic = (m: FakeMeeting, peer: string) => m.produce(peer, { producerId: `${peer}-mic`, kind: "audio", screenShare: false });
const share = (m: FakeMeeting, peer: string) => m.produce(peer, { producerId: `${peer}-share`, kind: "video", screenShare: true });
const shareAudio = (m: FakeMeeting, peer: string) =>
  m.produce(peer, { producerId: `${peer}-share-audio`, kind: "audio", screenShare: true });

/** Everyone on, everything a tampered client could publish: camera, mic, a
 *  screen share and its audio — the two players and a third participant. */
function fullRoom(m: FakeMeeting): void {
  for (const p of [W, B, OTHER]) {
    m.peerJoins(p.peer, p.user);
    cam(m, p.peer);
    mic(m, p.peer);
    share(m, p.peer);
    shareAudio(m, p.peer);
  }
  m.select([W.peer, B.peer, OTHER.peer]);
}

const consumedVideo = (m: FakeMeeting) => m.consumedVideo.map((c) => c.producerId).sort();
const consumedAudio = (m: FakeMeeting) => m.consumedAudio.map((c) => c.producerId).sort();
const W_CAMERA = [`${W.peer}-cam`];

function reports() {
  const seen: string[] = [];
  const report: ArbiterReport = (event) => void seen.push(event);
  return { seen, report };
}

async function arbiterIn(setup: (m: FakeMeeting) => void, presetMax = 2, players: readonly string[] = PLAYERS.players) {
  const rtk = fakeRealtimeKit({ presetMaxVideoStreams: presetMax, selfUserId: "rtk-arbiter", setup });
  const r = reports();
  const cams = await makeJoinArbiter(rtk.load, r.report)({ authToken: "arb-token", players });
  await settle();
  return { m: rtk.meetings[0]!, cams, seen: r.seen };
}

describe("the arbiter receives the meeting's one player's camera, and nothing else", () => {
  it("controls: the SDK's own default would hand an arbiter every microphone and screen share in this room", async () => {
    // Positive control — without it the assertions below could pass on a
    // fake that never subscribes anyone.
    const raw = fakeRealtimeKit({ presetMaxVideoStreams: 2, setup: fullRoom });
    const m = await raw.load().then((mod: { default: { init: (o: { authToken: string }) => Promise<FakeMeeting> } }) =>
      mod.default.init({ authToken: "t" }),
    );
    await m.join();
    await settle();
    expect(consumedAudio(m).length, "the default view consumes microphones").toBeGreaterThan(0);
    expect(consumedVideo(m).length, "…and video").toBeGreaterThan(0);
  });

  it("joins with its own token, audio and video OFF, and the cap at 0 before join", async () => {
    const { m } = await arbiterIn(fullRoom);
    expect(m.authToken).toBe("arb-token");
    expect(m.initDefaults, "never its own microphone or camera").toEqual({ audio: false, video: false });
    expect(m.calls.indexOf("setMax:0")).toBeGreaterThanOrEqual(0);
    expect(m.calls.indexOf("setMax:0")).toBeLessThan(m.calls.indexOf("join"));
    expect(m.participants.viewMode).toBe("MANUAL");
  });

  it("a full room, for each player's meeting in turn: exactly THAT player's camera is consumed; no audio at all; no screen share; not the opponent; not the third participant", async () => {
    let checked = 0;
    for (const [mine, theirs] of [[W, B], [B, W]] as const) {
      const { m, cams } = await arbiterIn(fullRoom, 2, [mine.user]);
      expect(consumedVideo(m), `${mine.user}: only the camera of the player whose meeting this is`).toEqual([`${mine.peer}-cam`]);
      expect(consumedAudio(m), "the arbiter receives NO audio").toEqual([]);
      expect(m.participants.audioSubscribed.size).toBe(0);
      expect([...m.participants.videoSubscribed.keys()], `${mine.user}: not ${theirs.user}`).toEqual([mine.peer]);
      expect(cams.tile()).toMatchObject({ present: true, live: true });
      expect((cams.tile().track as unknown as { id: string }).id).toBe(`remote-${mine.peer}-cam`);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both players' meetings").toBe(2);
  });

  it("the sequence: players arrive AFTER the arbiter, then publish; a reconnect selects in ACTIVE_GRID in its window — still only the two cameras, never audio", async () => {
    const { m, cams } = await arbiterIn(() => {});
    expect(cams.tile()).toMatchObject({ present: false, live: false, track: null });
    m.peerJoins(W.peer, W.user);
    m.peerJoins(OTHER.peer, OTHER.user);
    await settle();
    expect(cams.tile()).toMatchObject({ present: true, live: false });
    cam(m, W.peer);
    mic(m, W.peer);
    cam(m, OTHER.peer);
    mic(m, OTHER.peer);
    await settle();
    expect(consumedVideo(m)).toEqual(W_CAMERA);
    // The OPPONENT arrives in this meeting (it should never happen: they have their own) and is a stranger like any other.
    m.peerJoins(B.peer, B.user);
    cam(m, B.peer);
    mic(m, B.peer);
    await settle();
    expect(consumedVideo(m), "the opponent's camera is never received here").toEqual(W_CAMERA);
    // A socket rejoin: SOCKET_PEERS resets to ACTIVE_GRID, and a peer's
    // media-join broadcast selects in that mode before our own rejoin.
    m.select([W.peer, B.peer, OTHER.peer]);
    await m.reconnect({ inWindow: (mm) => mm.peerMediaJoined(OTHER.peer) });
    await settle();
    expect(m.participants.viewMode, "MANUAL re-asserted after the rejoin").toBe("MANUAL");
    expect(consumedAudio(m), "never any audio, across the rejoin").toEqual([]);
    expect(consumedVideo(m).filter((p) => p.startsWith(OTHER.peer)), "never the third participant's camera").toEqual([]);
    expect(cams.tile().live, "the tile is back after the rejoin").toBe(true);
    let checks = 0;
    for (let i = 0; i < 3; i++) {
      await m.reconnect();
      await settle();
      expect(consumedAudio(m)).toEqual([]);
      expect([...m.participants.videoSubscribed.keys()].sort()).toEqual([W.peer]);
      checks++;
    }
    expect(checks).toBe(3);
  });

  // MANUAL refused for a whole rejoin's guard run (ARBITER_MAX_ATTEMPTS in a
  // row, nothing yet selected so nothing to leave over): the SDK stays in
  // ACTIVE_GRID and selects at the media join — audio for everyone, and (the
  // cap-0 leak) a stranger's video. The next guard run, on that arrival,
  // must empty both before the consumer sync.
  async function rejoinWithManualRefused(
    select: string[],
    room: (m: FakeMeeting) => void,
    o: { refusals?: number; inWindow?: (m: FakeMeeting) => void; before?: (m: FakeMeeting) => void } = {},
  ) {
    const rtk = fakeRealtimeKit({ presetMaxVideoStreams: 2, selfUserId: "rtk-arbiter", setup: room });
    const held: (() => void)[] = [];
    const cams = await makeJoinArbiter(rtk.load, reports().report, (fn) => (held.push(fn), () => undefined))({
      authToken: "t",
      ...PLAYERS,
    });
    await settle();
    const m = rtk.meetings[0]!;
    o.before?.(m);
    await settle();
    m.select(select);
    m.failNext.setViewMode = o.refusals ?? ARBITER_MAX_ATTEMPTS;
    // What the SDK selected during the rejoin — the precondition each test
    // states, so a fake that never selects cannot pass them.
    const selected = { audio: new Set<string>(), video: new Set<string>() };
    m.participants.audioSubscribed.on("participantJoined", (p: unknown) => selected.audio.add((p as { id: string }).id));
    m.participants.videoSubscribed.on("participantJoined", (p: unknown) => selected.video.add((p as { id: string }).id));
    await m.reconnect(o.inWindow ? { inWindow: o.inWindow } : {});
    await settle();
    return { m, cams, held, selected };
  }

  it("a rejoin whose MANUAL is refused until the media join: the audio and the stranger's video it selected are dropped before the sync", async () => {
    const { m, cams, selected } = await rejoinWithManualRefused([OTHER.peer, W.peer, B.peer], fullRoom);
    expect(selected.audio.size, "precondition: the SDK selected microphones").toBeGreaterThan(0);
    expect(selected.video.has(OTHER.peer), "precondition: …and the stranger's video (the cap-0 leak)").toBe(true);
    expect(consumedAudio(m), "nothing heard").toEqual([]);
    expect(consumedVideo(m).filter((p) => p.startsWith(OTHER.peer)), "never the stranger's camera").toEqual([]);
    expect(m.calls).not.toContain("leave");
    expect(cams.tile().live).toBe(true);
  });

  it("MANUAL refused ONCE on a rejoin while a peer's media join selects in that window: the guard's retry empties the audio and the stranger before the sync", async () => {
    const { m, cams, selected } = await rejoinWithManualRefused([OTHER.peer, W.peer, B.peer], fullRoom, {
      refusals: 1,
      inWindow: (mm) => mm.peerMediaJoined(OTHER.peer),
    });
    expect(selected.audio.size, "precondition: microphones selected in the window").toBe(3);
    expect(selected.video.has(OTHER.peer), "precondition: the stranger's video selected (cap-0 leak)").toBe(true);
    expect(consumedAudio(m), "nothing heard").toEqual([]);
    expect(consumedVideo(m), "only the one player's camera - not the stranger's, not the opponent's").toEqual(W_CAMERA);
    expect(m.calls).not.toContain("leave");
    expect(cams.tile().live).toBe(true);
  });

  it("a player RELOADS during that rejoin window (a new peer the guard never refused, selected for video AND audio): its microphone is still dropped", async () => {
    const { m, cams, selected } = await rejoinWithManualRefused([OTHER.peer, W.peer, B.peer], fullRoom, {
      refusals: 1,
      inWindow: (mm) => {
        mm.peerJoins("w2-peer", W.user);
        mm.produce("w2-peer", { producerId: "w2-cam", kind: "video", screenShare: false });
        mm.produce("w2-peer", { producerId: "w2-mic", kind: "audio", screenShare: false });
        mm.select(["w2-peer", B.peer, OTHER.peer]);
      },
      before: (mm) => mm.peerLeaves(W.peer),
    });
    expect(selected.audio.has("w2-peer") && selected.video.has("w2-peer"), "precondition: the new peer selected for both").toBe(true);
    expect(consumedAudio(m), "nothing heard").toEqual([]);
    expect(cams.tile()).toMatchObject({ present: true, live: true });
    expect((cams.tile().track as unknown as { id: string }).id).toBe("remote-w2-cam");
  });

  it("…and when only the AUDIO map moves (one microphone, no video selected), that arrival alone is enough", async () => {
    const { m, selected } = await rejoinWithManualRefused([OTHER.peer], (mm) => {
      mm.peerJoins(OTHER.peer, OTHER.user);
      mic(mm, OTHER.peer);
    });
    expect([...selected.audio], "precondition: the microphone was selected").toEqual([OTHER.peer]);
    expect(selected.video.size, "precondition: no video map arrival to ride on").toBe(0);
    expect(consumedAudio(m)).toEqual([]);
  });

  it("a media-node reconnect (no SOCKET_PEERS): still nothing heard", async () => {
    const { m } = await arbiterIn(fullRoom);
    await m.mediaReconnect();
    await settle();
    expect(consumedAudio(m)).toEqual([]);
    expect(consumedVideo(m)).toEqual(W_CAMERA);
  });
});

describe("the tile follows the player's camera", () => {
  it("a camera paused is off, resumed is live — and each change is told", async () => {
    const { m, cams } = await arbiterIn(fullRoom);
    let told = 0;
    const off = cams.onChange(() => (told += 1));
    m.toggle(W.peer, `${W.peer}-cam`, true);
    expect(cams.tile()).toMatchObject({ present: true, live: false });
    expect(told).toBeGreaterThan(0);
    const before = told;
    m.toggle(W.peer, `${W.peer}-cam`, false);
    await settle();
    expect(cams.tile()).toMatchObject({ live: true });
    expect(told).toBeGreaterThan(before);
    off();
    const afterOff = told;
    m.toggle(W.peer, `${W.peer}-cam`, true);
    await settle();
    expect(told, "an unsubscribed listener hears nothing").toBe(afterOff);
  });

  it("the player leaves (absent), then comes back on a NEW peer (a reload): present and live again - for the black player's meeting too", async () => {
    const { m, cams } = await arbiterIn(fullRoom, 2, [B.user]);
    m.peerLeaves(B.peer);
    await settle();
    expect(cams.tile()).toMatchObject({ present: false, live: false, track: null });
    m.peerJoins("b-peer-2", B.user);
    m.produce("b-peer-2", { producerId: "b2-cam", kind: "video", screenShare: false });
    await settle();
    expect(cams.tile()).toMatchObject({ present: true, live: true });
    expect((cams.tile().track as unknown as { id: string }).id).toBe("remote-b2-cam");
  });

  it("a meeting whose player is not in it (only the opponent and a stranger are) shows nobody, never someone else's tile", async () => {
    const rtk = fakeRealtimeKit({ presetMaxVideoStreams: 2, setup: fullRoom });
    const cams = await makeJoinArbiter(rtk.load, reports().report)({ authToken: "t", players: ["rtk-nobody-here"] });
    await settle();
    expect(cams.tile()).toMatchObject({ present: false, live: false, track: null });
    expect(consumedVideo(rtk.meetings[0]!), "and nothing is received at all").toEqual([]);
  });
});

describe("failure is reported, and audio that cannot be refused is never kept", () => {
  // MANUAL cannot be set (a future SDK refusing it): the SDK stays in
  // ACTIVE_GRID, selects every peer's audio at the media join, and every
  // unsubscribe throws ("MANUAL subscription mode was not activated").
  it("MANUAL refused, audio in the map: the arbiter leaves before the consumer sync — nothing heard; the join answers the fault", async () => {
    const rtk = fakeRealtimeKit({
      presetMaxVideoStreams: 2,
      setup: (m) => {
        fullRoom(m);
        m.failNext.setViewMode = 50;
      },
    });
    const r = reports();
    const cams = await makeJoinArbiter(rtk.load, r.report)({ authToken: "t", ...PLAYERS }).catch((e: unknown) => e);
    await settle();
    const m = rtk.meetings[0]!;
    expect(m.participants.viewMode, "the precondition: the SDK stayed in ACTIVE_GRID").toBe("ACTIVE_GRID");
    expect(consumedAudio(m), "nothing heard").toEqual([]);
    expect(consumedVideo(m), "nothing seen either").toEqual([]);
    expect(m.calls.filter((c) => c === "leave")).toHaveLength(1);
    expect(r.seen.filter((e) => e === "arbiter_fail_closed")).toHaveLength(1);
    expect(r.seen[0], "the first failure is reported once, before the leave").toBe("arbiter_enforce_failed");
    expect(cams, "the join itself answers the fault").toBeInstanceOf(ArbiterGuardError);
  });

  it("a fault AFTER the join (a rejoin in which MANUAL is refused) is told to the panel once; the tiles go dark; nothing heard", async () => {
    const { m, cams } = await arbiterIn(fullRoom);
    expect(cams.tile().live, "precondition: watching").toBe(true);
    let faults = 0;
    cams.onFault(() => (faults += 1));
    m.failNext.setViewMode = 50;
    await m.reconnect();
    await settle();
    expect(consumedAudio(m)).toEqual([]);
    expect(faults).toBe(1);
    expect(m.calls.filter((c) => c === "leave")).toHaveLength(1);
    expect(cams.tile()).toMatchObject({ present: false, live: false, track: null });
    let late = 0;
    cams.onFault(() => (late += 1));
    await settle();
    expect(late, "a listener added after the fault hears it at once").toBe(1);
  });

  it("failures with NOTHING harmful subscribed do not leave: the guard retries on the scheduler and recovers", async () => {
    const asked: number[] = [];
    const pending: (() => void)[] = [];
    const later = (fn: () => void, ms: number) => {
      asked.push(ms);
      pending.push(fn);
      return () => undefined;
    };
    const rtk = fakeRealtimeKit({
      presetMaxVideoStreams: 2,
      setup: (m) => {
        fullRoom(m);
        // Only the subscribe path's unsubscribe fails; MANUAL holds, so the
        // SDK selects nobody and nothing harmful is ever in a map.
        m.failNext.unsubscribe = ARBITER_MAX_ATTEMPTS;
      },
    });
    const r = reports();
    const cams = await makeJoinArbiter(rtk.load, r.report, later)({ authToken: "t", ...PLAYERS });
    await settle();
    const m = rtk.meetings[0]!;
    expect(m.calls).not.toContain("leave");
    expect(r.seen).toEqual(["arbiter_enforce_failed"]);
    // Whatever the retry was asked to wait, firing it subscribes both cameras.
    expect(asked.length).toBeGreaterThan(0);
    pending.shift()!();
    await settle();
    expect(consumedVideo(m)).toEqual(W_CAMERA);
    expect(consumedAudio(m)).toEqual([]);
    expect(cams.tile().live).toBe(true);
  });
});

describe("both sides, one meeting: the arbiter sees the players; a player still sees nobody", () => {
  it("the player's own D7 guard receives NOTHING in the meeting the arbiter watches", async () => {
    // The player's view of the same room: the opponent publishing camera and
    // mic, and an arbiter peer present (an arbiter publishes nothing).
    const player = fakeRealtimeKit({
      presetMaxVideoStreams: 0,
      selfUserId: W.user,
      setup: (m) => {
        m.peerJoins(B.peer, B.user);
        cam(m, B.peer);
        mic(m, B.peer);
        m.peerJoins("arb-peer", "rtk-arbiter");
        m.select([B.peer, "arb-peer"]);
      },
    });
    await makeJoinOwnCamera(player.load)("player-token");
    await settle();
    const pm = player.meetings[0]!;
    expect([pm.consumedVideo.length, pm.consumedAudio.length, pm.participants.videoSubscribed.size]).toEqual([0, 0, 0]);

    const { m } = await arbiterIn(fullRoom);
    expect(consumedVideo(m)).toEqual(W_CAMERA);
  });
});

// Keep the type import honest.
export type _Cams = ArbiterCameras;
