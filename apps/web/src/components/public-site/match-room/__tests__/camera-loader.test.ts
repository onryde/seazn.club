// T14 re-review NEW-1 (D7, spec §5.3): a player's browser must never RECEIVE
// the opponent's video — not hidden, not received. And review I8: the
// opponent's presence comes from this client's own signalling, read from the
// SAME meeting join, never from a server call.
//
// Driven through the REAL loader (`makeJoinOwnCamera`) over a port of the SDK's
// subscription rules (_fake-realtimekit.ts, with its line references). The
// expected values come from the rule, never from the loader: zero remote video
// subscribed or consumed, whatever the server selects and however often the
// socket rejoins.
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeJoinOwnCamera } from "../camera-loader";
import { fakeRealtimeKit, MODELLED_SDK_VERSION, type FakeMeeting } from "./_fake-realtimekit";

const OPP = { peer: "opp-peer", user: "rtk-opponent" };
const ARB = { peer: "arb-peer", user: "rtk-arbiter" };

/** The macrotask on which the SDK's consumer sync runs, and the microtasks
 *  before it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
}
const camera = (m: FakeMeeting, peer: string, id = `${peer}-cam`) => m.produce(peer, { producerId: id, kind: "video", screenShare: false });
function received(m: FakeMeeting) {
  return { subscribed: m.participants.videoSubscribed.size, consumed: m.consumedVideo.length };
}

describe("D7: no remote video is ever received (review NEW-1)", () => {
  it("the SDK pin: the port this suite trusts is of the version the app installs", () => {
    const pkg = JSON.parse(readFileSync(pathJoin(__dirname, "../../../../../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@cloudflare/realtimekit"]).toBe(MODELLED_SDK_VERSION);
  });

  it("controls: with no loader the SDK's default DOES receive the opponent, and a cap of 0 alone still leaks one peer when two are selected", async () => {
    // Positive controls — without them the sweep below could pass on a fake
    // that never subscribes anyone.
    const raw = fakeRealtimeKit();
    const m0 = await raw.load().then((mod: { default: { init: (o: { authToken: string }) => Promise<FakeMeeting> } }) => mod.default.init({ authToken: "t" }));
    m0.peerJoins(OPP.peer, OPP.user);
    m0.produce(OPP.peer, { producerId: "opp-cam", kind: "video", screenShare: false });
    await m0.join();
    await settle();
    expect(received(m0).consumed, "the default view subscribes and consumes the opponent's camera").toBe(1);

    const capOnly = fakeRealtimeKit();
    const m1 = await capOnly.load().then((mod: { default: { init: (o: { authToken: string }) => Promise<FakeMeeting> } }) => mod.default.init({ authToken: "t" }));
    m1.participants.setMaxActiveParticipantsCount(0);
    m1.peerJoins(OPP.peer, OPP.user);
    m1.peerJoins(ARB.peer, ARB.user);
    m1.produce(OPP.peer, { producerId: "opp-cam", kind: "video", screenShare: false });
    m1.select([OPP.peer, ARB.peer]);
    await m1.join();
    await settle();
    expect(received(m1).subscribed, "selectActivePeers(0) with two selected keeps one (o = -1, slice(0, -1))").toBe(1);
    expect(received(m1).consumed).toBe(1);
  });

  it("the stream cap is set to 0 BEFORE join", async () => {
    const rtk = fakeRealtimeKit();
    await makeJoinOwnCamera(rtk.load)("own-token");
    const calls = rtk.meetings[0]!.calls;
    expect(calls.indexOf("setMax:0"), "capped").toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("setMax:0")).toBeLessThan(calls.indexOf("join"));
    expect(rtk.meetings[0]!.authToken, "joined with the caller's OWN token").toBe("own-token");
  });

  type Scenario = { label: string; before: (m: FakeMeeting) => void; after: (m: FakeMeeting) => void };
  const scenarios: Scenario[] = [
    { label: "opponent on camera before we join", before: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer)), after: () => {} },
    {
      label: "opponent AND arbiter both selected by the server (the cap-0 leak)",
      before: (m) => {
        m.peerJoins(OPP.peer, OPP.user);
        m.peerJoins(ARB.peer, ARB.user);
        camera(m, OPP.peer);
        m.select([OPP.peer, ARB.peer]);
      },
      after: () => {},
    },
    { label: "opponent joins AFTER us, then turns the camera on", before: () => {}, after: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer)) },
    {
      label: "opponent shares a screen",
      before: (m) => m.peerJoins(OPP.peer, OPP.user),
      after: (m) => m.produce(OPP.peer, { producerId: "opp-screen", kind: "video", screenShare: true }),
    },
    {
      label: "the server re-selects mid-game",
      before: (m) => (m.peerJoins(OPP.peer, OPP.user), m.peerJoins(ARB.peer, ARB.user), camera(m, OPP.peer)),
      after: (m) => m.select([ARB.peer, OPP.peer]),
    },
  ];

  it("every scenario, after join AND after each of two reconnects: zero remote video subscribed, zero consumed", async () => {
    let checked = 0;
    for (const s of scenarios) {
      const rtk = fakeRealtimeKit({ setup: s.before });
      const cam = await makeJoinOwnCamera(rtk.load)("own-token");
      const m = rtk.meetings[0]!;
      s.after(m);
      await settle();
      expect(received(m), `${s.label}: after join`).toEqual({ subscribed: 0, consumed: 0 });
      checked += 1;
      for (const n of [1, 2]) {
        m.reconnect();
        s.after(m);
        await settle();
        expect(received(m), `${s.label}: after reconnect ${n}`).toEqual({ subscribed: 0, consumed: 0 });
        expect(m.participants.maxActiveParticipantsCount, `${s.label}: the cap holds after reconnect ${n}`).toBe(0);
        checked += 1;
      }
      await cam.leave();
    }
    expect(checked, "anti-vacuity: scenario × (join + 2 reconnects)").toBe(scenarios.length * 3);
  });

  it("re-asserted on every rejoin: the cap and the MANUAL view are set again each time the socket rejoins, with no feedback loop", async () => {
    const rtk = fakeRealtimeKit();
    await makeJoinOwnCamera(rtk.load)("own-token");
    const m = rtk.meetings[0]!;
    m.peerJoins(OPP.peer, OPP.user);
    camera(m, OPP.peer);
    await settle();
    const viewSets = () => m.calls.filter((c) => c === "setViewMode:MANUAL").length;
    const before = viewSets();
    expect(m.participants.viewMode).toBe("MANUAL");
    // SOCKET_PEERS resets the view to ACTIVE_GRID inside reconnect(); the
    // loader's rejoin handler sets MANUAL again in the same turn.
    m.reconnect();
    await settle();
    expect(m.participants.viewMode, "the loader put it back").toBe("MANUAL");
    expect(viewSets(), "set again on the rejoin").toBeGreaterThan(before);
    const capSets = m.calls.filter((c) => c === "setMax:0").length;
    // Anything that raises the cap (in MANUAL it selects nobody) is put back
    // at the next rejoin, before that rejoin's selection can consume anyone.
    m.participants.setMaxActiveParticipantsCount(3);
    m.reconnect();
    await settle();
    expect(m.participants.maxActiveParticipantsCount, "put back to 0 on the rejoin").toBe(0);
    expect(m.calls.filter((c) => c === "setMax:0").length).toBeGreaterThan(capSets);
    expect(received(m)).toEqual({ subscribed: 0, consumed: 0 });
    // Bounded: a re-assertion that re-triggers the SDK's own selection must not
    // loop (setMax re-runs the selection, which emits participantsUpdate).
    expect(m.calls.length, "no feedback loop").toBeLessThan(40);
  });
});

describe("the meeting link the presence pill reads (review I8: zero network)", () => {
  it("null until joined; the opponent's camera from producers (video, not a screen share, not paused); null with the socket down; a NEW join instant after a reconnect; null after leaving", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000);
      const rtk = fakeRealtimeKit();
      const cam = await makeJoinOwnCamera(rtk.load)("own-token");
      const m = rtk.meetings[0]!;
      const live = () => cam.link()?.peers.find((p) => p.userId === OPP.user)?.videoLive ?? null;
      expect(cam.link()?.joinedAt).toBe(1_000);
      expect(cam.link()?.peers).toEqual([]);

      let notified = 0;
      const off = cam.onLinkChange(() => (notified += 1));
      m.peerJoins(OPP.peer, OPP.user);
      expect(notified, "a peer joining notifies").toBeGreaterThan(0);
      expect(live(), "in the meeting, no producer").toBe(false);
      camera(m, OPP.peer);
      expect(live(), "a camera producer").toBe(true);
      m.toggle(OPP.peer, `${OPP.peer}-cam`, true);
      expect(live(), "paused").toBe(false);
      m.toggle(OPP.peer, `${OPP.peer}-cam`, false);
      expect(live()).toBe(true);
      m.closeProducer(OPP.peer, `${OPP.peer}-cam`);
      m.produce(OPP.peer, { producerId: "opp-screen", kind: "video", screenShare: true });
      expect(live(), "a screen share is not the camera").toBe(false);
      m.produce(OPP.peer, { producerId: "opp-mic", kind: "audio", screenShare: false });
      expect(live(), "nor is a microphone").toBe(false);

      vi.setSystemTime(5_000);
      const n0 = notified;
      m.dropSocket();
      expect(cam.link(), "socket down: nothing is known").toBeNull();
      expect(notified).toBeGreaterThan(n0);
      vi.setSystemTime(9_000);
      m.reconnect();
      expect(cam.link()?.joinedAt, "a rejoin restarts the settle").toBe(9_000);
      m.peerLeaves(OPP.peer);
      expect(cam.link()?.peers.some((p) => p.userId === OPP.user), "left").toBe(false);
      off();
      const n1 = notified;
      m.peerJoins(ARB.peer, ARB.user);
      expect(notified, "unsubscribed listeners hear nothing").toBe(n1);
      await cam.leave();
      expect(cam.link(), "left the meeting").toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the player's own camera (unchanged behaviour, now under test)", () => {
  let rtk: ReturnType<typeof fakeRealtimeKit>;
  beforeEach(() => {
    rtk = fakeRealtimeKit();
  });
  afterEach(() => vi.restoreAllMocks());

  it("track() is the local camera while enabled; onChange relays the SDK's videoUpdate until unsubscribed; enable() turns it back on", async () => {
    const cam = await makeJoinOwnCamera(rtk.load)("own-token");
    const m = rtk.meetings[0]!;
    expect(cam.track()).toBe(m.self.videoTrack);
    const seen: boolean[] = [];
    const off = cam.onChange((enabled) => seen.push(enabled));
    m.self.videoEnabled = false;
    m.self.emit("videoUpdate", { videoEnabled: false, videoTrack: m.self.videoTrack });
    expect(cam.track()).toBeNull();
    await cam.enable();
    expect(seen).toEqual([false, true]);
    off();
    m.self.emit("videoUpdate", { videoEnabled: false, videoTrack: m.self.videoTrack });
    expect(seen).toEqual([false, true]);
  });
});
