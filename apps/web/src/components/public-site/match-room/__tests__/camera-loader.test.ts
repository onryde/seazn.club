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
import { D7_MAX_ATTEMPTS, D7_QUIET_RETRY_MS, D7GuardError, makeJoinOwnCamera, type D7Report, type OwnCamera } from "../camera-loader";
import { fakeRealtimeKit, MODELLED_SDK_VERSION, type FakeMeeting } from "./_fake-realtimekit";

const OPP = { peer: "opp-peer", user: "rtk-opponent" };
const ARB = { peer: "arb-peer", user: "rtk-arbiter" };

/** The macrotask on which the SDK's consumer sync runs, and the microtasks
 *  before it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
}
const camera = (m: FakeMeeting, peer: string, id = `${peer}-cam`) => m.produce(peer, { producerId: id, kind: "video", screenShare: false });
/** A microphone: an honest client cannot (audio off, no mic UI), a tampered
 *  one can — and a consumed one auto-plays. */
const mic = (m: FakeMeeting, peer: string) => m.produce(peer, { producerId: `${peer}-mic`, kind: "audio", screenShare: false });
function received(m: FakeMeeting) {
  return {
    subscribed: m.participants.videoSubscribed.size,
    consumed: m.consumedVideo.length,
    audioSubscribed: m.participants.audioSubscribed.size,
    audioConsumed: m.consumedAudio.length,
  };
}
const NOTHING = { subscribed: 0, consumed: 0, audioSubscribed: 0, audioConsumed: 0 };
/** How many times the camera told its owner the guard left the meeting. */
function faults(cam: OwnCamera) {
  const seen = { n: 0 };
  cam.onFault(() => (seen.n += 1));
  return seen;
}
/** A scheduler the test fires by hand: what the loader asked to wait, in order. */
function manualLater() {
  const queue: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    asked: () => queue.map((q) => q.ms),
    pending: () => queue.filter((q) => !q.cancelled).length,
    later: (fn: () => void, ms: number) => {
      const q = { fn, ms, cancelled: false };
      queue.push(q);
      return () => void (q.cancelled = true);
    },
    async fireNext(): Promise<boolean> {
      const q = queue.find((x) => !x.cancelled);
      if (!q) return false;
      q.cancelled = true;
      q.fn();
      await settle();
      return true;
    },
  };
}
/** A reporter that records, for the failure paths (review re-2 M3). */
function reports() {
  const seen: { event: string; message: string }[] = [];
  const report: D7Report = (event, err) => void seen.push({ event, message: err instanceof Error ? err.message : String(err) });
  return { seen, report };
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
    mic(m0, OPP.peer);
    await m0.join();
    await settle();
    expect(received(m0).consumed, "the default view subscribes and consumes the opponent's camera").toBe(1);
    expect(received(m0).audioConsumed, "…and their microphone (review re-2 M1)").toBe(1);

    const capOnly = fakeRealtimeKit();
    const m1 = await capOnly.load().then((mod: { default: { init: (o: { authToken: string }) => Promise<FakeMeeting> } }) => mod.default.init({ authToken: "t" }));
    m1.participants.setMaxActiveParticipantsCount(0);
    m1.peerJoins(OPP.peer, OPP.user);
    m1.peerJoins(ARB.peer, ARB.user);
    m1.produce(OPP.peer, { producerId: "opp-cam", kind: "video", screenShare: false });
    mic(m1, OPP.peer);
    m1.select([OPP.peer, ARB.peer]);
    await m1.join();
    await settle();
    expect(received(m1).subscribed, "selectActivePeers(0) with two selected keeps one (o = -1, slice(0, -1))").toBe(1);
    expect(received(m1).consumed).toBe(1);
    expect(received(m1).audioSubscribed, "audio selects cap + 4 - 1 = 3: both").toBe(2);
    expect(received(m1).audioConsumed).toBe(1);
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
    { label: "opponent on camera before we join", before: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer), mic(m, OPP.peer)), after: () => {} },
    {
      label: "opponent alone with a microphone, nobody selected (only the AUDIO map moves)",
      before: (m) => (m.peerJoins(OPP.peer, OPP.user), mic(m, OPP.peer)),
      after: () => {},
    },
    {
      label: "opponent AND arbiter both selected by the server (the cap-0 leak)",
      before: (m) => {
        m.peerJoins(OPP.peer, OPP.user);
        m.peerJoins(ARB.peer, ARB.user);
        camera(m, OPP.peer);
        mic(m, OPP.peer);
        m.select([OPP.peer, ARB.peer]);
      },
      after: () => {},
    },
    {
      label: "opponent joins AFTER us, then turns the camera and microphone on",
      before: () => {},
      after: (m) => {
        if (!m.roster.some((x) => x.id === OPP.peer)) m.peerJoins(OPP.peer, OPP.user);
        const opp = m.roster.find((x) => x.id === OPP.peer)!;
        if (!opp.producers.some((x) => x.kind === "video")) camera(m, OPP.peer);
        if (!opp.producers.some((x) => x.kind === "audio")) mic(m, OPP.peer);
      },
    },
    {
      label: "opponent shares a screen",
      before: (m) => m.peerJoins(OPP.peer, OPP.user),
      after: (m) => m.produce(OPP.peer, { producerId: "opp-screen", kind: "video", screenShare: true }),
    },
    {
      label: "the server re-selects mid-game",
      before: (m) => (m.peerJoins(OPP.peer, OPP.user), m.peerJoins(ARB.peer, ARB.user), camera(m, OPP.peer), mic(m, OPP.peer)),
      after: (m) => m.select([ARB.peer, OPP.peer]),
    },
    {
      label: "opponent AND arbiter selected, the opponent sharing a screen as well as the camera",
      before: (m) => {
        m.peerJoins(OPP.peer, OPP.user);
        m.peerJoins(ARB.peer, ARB.user);
        camera(m, OPP.peer);
        mic(m, OPP.peer);
        m.produce(OPP.peer, { producerId: "opp-screen", kind: "video", screenShare: true });
        m.select([OPP.peer, ARB.peer]);
      },
      after: () => {},
    },
    { label: "nobody else in the meeting", before: () => {}, after: () => {} },
  ];
  const rejoins: { label: string; run: (m: FakeMeeting) => Promise<void> }[] = [
    { label: "socket rejoin", run: (m) => m.reconnect() },
    { label: "media-node rejoin", run: (m) => m.mediaReconnect() },
    {
      // Review re-2 Q4: the opponent's media-join broadcast lands between
      // SOCKET_PEERS (view reset to ACTIVE_GRID) and our own media join.
      label: "socket rejoin with the opponent's media-join broadcast inside the window",
      run: (m) => m.reconnect({ inWindow: (x) => x.peerMediaJoined(OPP.peer) }),
    },
    { label: "second socket rejoin", run: (m) => m.reconnect() },
  ];

  it("every scenario, after join AND after each rejoin (socket, media node, socket): zero remote video subscribed, zero consumed; the view MANUAL and the cap 0 again", async () => {
    let checked = 0;
    for (const s of scenarios) {
      const rtk = fakeRealtimeKit({ setup: s.before });
      const cam = await makeJoinOwnCamera(rtk.load)("own-token");
      const m = rtk.meetings[0]!;
      s.after(m);
      await settle();
      expect(received(m), `${s.label}: after join`).toEqual(NOTHING);
      expect(m.participants.viewMode, `${s.label}: after join`).toBe("MANUAL");
      checked += 1;
      for (const r of rejoins) {
        await r.run(m);
        s.after(m);
        await settle();
        expect(received(m), `${s.label}: after ${r.label}`).toEqual(NOTHING);
        // Re-asserted on every rejoin (controller ruling) — even when nobody
        // else is there to trip the subscription watchdog.
        expect(m.participants.viewMode, `${s.label}: the view after ${r.label}`).toBe("MANUAL");
        expect(m.participants.maxActiveParticipantsCount, `${s.label}: the cap after ${r.label}`).toBe(0);
        checked += 1;
      }
      await cam.leave();
    }
    expect(checked, "anti-vacuity: scenario × (join + 4 rejoins)").toBe(scenarios.length * 5);
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
    // loader sets MANUAL again (the watchdog, then the rejoin handler).
    await m.reconnect();
    await settle();
    expect(m.participants.viewMode, "the loader put it back").toBe("MANUAL");
    expect(viewSets(), "set again on the rejoin").toBeGreaterThan(before);
    const capSets = m.calls.filter((c) => c === "setMax:0").length;
    // Anything that raises the cap (in MANUAL it selects nobody) is put back
    // at the next rejoin, before that rejoin's selection can consume anyone.
    m.participants.setMaxActiveParticipantsCount(3);
    await m.reconnect();
    await settle();
    expect(m.participants.maxActiveParticipantsCount, "put back to 0 on the rejoin").toBe(0);
    expect(m.calls.filter((c) => c === "setMax:0").length).toBeGreaterThan(capSets);
    expect(received(m)).toEqual(NOTHING);
    // Bounded: a re-assertion that re-triggers the SDK's own selection must not
    // loop (setMax re-runs the selection, which emits participantsUpdate).
    expect(m.calls.length, "no feedback loop").toBeLessThan(40);
  });
});

describe("the watchdog, one listener at a time (review re-2 M2)", () => {
  // Every addition to a subscribed map emits participantJoined (ClientMap.set,
  // l.14229): updateParticipantsMap adds with emit true (l.18846), the video
  // map's min-replacement emits for every peer not already present (l.18839),
  // and subscribe() uses the default (l.18111-18119). participantsUpdate fires
  // only at the end of a selection, whose additions already emitted — so the
  // loader listens to participantJoined only. A MANUAL subscribe() emits
  // participantJoined and NO participantsUpdate: these paths reach each map's
  // listener alone.
  for (const kind of ["video", "audio"] as const) {
    it(`a ${kind} subscription made while the view is MANUAL — no selection, no participantsUpdate — is undone before anything is consumed`, async () => {
      const rtk = fakeRealtimeKit();
      await makeJoinOwnCamera(rtk.load)("own-token");
      const m = rtk.meetings[0]!;
      m.peerJoins(OPP.peer, OPP.user);
      camera(m, OPP.peer);
      mic(m, OPP.peer);
      await settle();
      expect(m.participants.viewMode, "premise: MANUAL, so no selection runs").toBe("MANUAL");
      let updates = 0;
      const map = kind === "video" ? m.participants.videoSubscribed : m.participants.audioSubscribed;
      map.on("participantsUpdate", () => (updates += 1));
      await m.participants.subscribe([OPP.peer], kind === "video" ? ["video"] : ["audio"]);
      await settle();
      expect(updates, "premise: this path emits no participantsUpdate").toBe(0);
      expect(received(m)).toEqual(NOTHING);
    });
  }
});

describe("the watchdog when the SDK misbehaves (review re-2 M3)", () => {
  it("an arrival DURING an enforcement run is not dropped: it is handled by a re-run", async () => {
    const rtk = fakeRealtimeKit({
      setup: (m) => {
        m.peerJoins(OPP.peer, OPP.user);
        m.peerJoins(ARB.peer, ARB.user);
        camera(m, OPP.peer);
        camera(m, ARB.peer);
        m.select([OPP.peer, ARB.peer]);
      },
    });
    const cam = await makeJoinOwnCamera(rtk.load)("own-token");
    const m = rtk.meetings[0]!;
    await settle();
    // Mid-run (inside its unsubscribe), the arbiter is subscribed: the view
    // already reads MANUAL, so only the watchdog can take it out again.
    m.duringNextUnsubscribe = (x) => void x.participants.subscribe([ARB.peer], ["video"]);
    await m.participants.subscribe([OPP.peer], ["video"]);
    await settle();
    expect(m.duringNextUnsubscribe, "premise: the mid-run arrival happened").toBeNull();
    expect(received(m)).toEqual(NOTHING);
    await cam.leave();
  });

  it("a call that throws once is reported once and retried — nothing received, still in the meeting", async () => {
    const { seen, report } = reports();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer), mic(m, OPP.peer)) });
    const cam = await makeJoinOwnCamera(rtk.load, report)("own-token");
    const m = rtk.meetings[0]!;
    await settle();
    m.failNext.unsubscribe = 1;
    await m.participants.subscribe([OPP.peer], ["video", "audio"]);
    await settle();
    expect(m.failNext.unsubscribe, "premise: the failure was hit").toBe(0);
    expect(received(m)).toEqual(NOTHING);
    expect(seen).toEqual([{ event: "d7_enforce_failed", message: "injected unsubscribe failure" }]);
    expect(m.calls, "not left").not.toContain("leave");
    expect(cam.link(), "still in the meeting").not.toBeNull();
  });

  it("reports are rate-limited: a second failing episode on the same camera is not reported again", async () => {
    const { seen, report } = reports();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.failNext.setViewMode = 1) });
    await makeJoinOwnCamera(rtk.load, report)("own-token");
    const m = rtk.meetings[0]!;
    m.failNext.setViewMode = 1;
    await m.reconnect();
    await settle();
    expect(m.failNext.setViewMode, "premise: both failures were hit").toBe(0);
    expect(seen.map((x) => x.event)).toEqual(["d7_enforce_failed"]);
    expect(m.participants.viewMode).toBe("MANUAL");
  });

  it(`a remote peer subscribed and a call that keeps throwing: after ${D7_MAX_ATTEMPTS} attempts it fails CLOSED — reported, the meeting left, the OWNER told (onFault, once), nothing received`, async () => {
    const { seen, report } = reports();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer), mic(m, OPP.peer)) });
    const cam = await makeJoinOwnCamera(rtk.load, report)("own-token");
    const fault = faults(cam);
    const m = rtk.meetings[0]!;
    const leavesWhenTold: number[] = [];
    cam.onFault(() => leavesWhenTold.push(m.calls.filter((c) => c === "leave").length));
    await settle();
    expect(m.calls, "premise: in the meeting").not.toContain("leave");
    m.failNext.unsubscribe = 1_000;
    await m.participants.subscribe([OPP.peer], ["video", "audio"]);
    await settle();
    const tries = 1_000 - m.failNext.unsubscribe;
    expect(tries, "bounded: exactly the attempts allowed, never a loop").toBe(D7_MAX_ATTEMPTS);
    expect(seen.map((x) => x.event)).toEqual(["d7_enforce_failed", "d7_fail_closed"]);
    expect(m.calls.filter((c) => c === "leave")).toHaveLength(1);
    expect(fault.n, "the owner heard it once — and re-joins (camera-session)").toBe(1);
    expect(leavesWhenTold, "told BEFORE the leave: its stamp leaves no stretch of the gap unstamped").toEqual([0]);
    expect(received(m).consumed + received(m).audioConsumed, "nothing consumed").toBe(0);
    expect(cam.link(), "out of the meeting").toBeNull();
    expect(cam.track(), "this camera is gone").toBeNull();
    await expect(cam.enable(), "never back into THAT meeting — a fresh join replaces it").rejects.toThrow(/fresh join/);
    await cam.leave();
    expect(m.calls.filter((c) => c === "leave"), "the owner's leave is the same leave, not a second").toHaveLength(1);
  });

  it("fails closed DURING the join itself: the join REJECTS as our guard's (D7GuardError) — out of the meeting, nothing received", async () => {
    const { seen, report } = reports();
    const rtk = fakeRealtimeKit({
      setup: (m) => {
        m.peerJoins(OPP.peer, OPP.user);
        m.peerJoins(ARB.peer, ARB.user);
        camera(m, OPP.peer);
        mic(m, OPP.peer);
        m.select([OPP.peer, ARB.peer]);
        m.failNext.setViewMode = 1_000;
      },
    });
    const joined = makeJoinOwnCamera(rtk.load, report)("own-token");
    await expect(joined).rejects.toBeInstanceOf(D7GuardError);
    const m = rtk.meetings[0]!;
    await settle();
    expect(seen.map((x) => x.event)).toEqual(["d7_enforce_failed", "d7_fail_closed"]);
    expect(m.calls).toContain("leave");
    expect(m.socketJoined, "the join's own roomJoined does not put it back").toBe(false);
    expect(received(m).consumed + received(m).audioConsumed).toBe(0);
  });

  it("the cap cannot be set BEFORE the join: nothing is joined, and the join rejects as our guard's (D7GuardError), reported", async () => {
    const { seen, report } = reports();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer), (m.failNext.setMax = 1)) });
    await expect(makeJoinOwnCamera(rtk.load, report)("own-token")).rejects.toBeInstanceOf(D7GuardError);
    const m = rtk.meetings[0]!;
    expect(m.failNext.setMax, "premise: the cap call failed").toBe(0);
    expect(m.calls, "never joined").not.toContain("join");
    expect(seen.map((x) => x.event)).toEqual(["d7_prejoin_failed"]);
    expect(received(m)).toEqual(NOTHING);
  });

  it("fails closed during a REJOIN: that rejoin's roomJoined, landing after, does not put it back", async () => {
    const { seen, report } = reports();
    const rtk = fakeRealtimeKit({
      setup: (m) => {
        m.peerJoins(OPP.peer, OPP.user);
        camera(m, OPP.peer);
        mic(m, OPP.peer);
      },
    });
    const cam = await makeJoinOwnCamera(rtk.load, report)("own-token");
    const fault = faults(cam);
    const m = rtk.meetings[0]!;
    await settle();
    m.failNext.unsubscribe = 1_000;
    await m.reconnect({ inWindow: (x) => x.peerMediaJoined(OPP.peer) });
    await settle();
    expect(seen.map((x) => x.event)).toEqual(["d7_enforce_failed", "d7_fail_closed"]);
    expect(cam.link()).toBeNull();
    expect(fault.n).toBe(1);
    expect(received(m).consumed + received(m).audioConsumed).toBe(0);
  });

  it("isolated failures never add up: three one-off throws, each followed by a clean run, never fail closed", async () => {
    const { seen, report } = reports();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer), mic(m, OPP.peer)) });
    const cam = await makeJoinOwnCamera(rtk.load, report)("own-token");
    const m = rtk.meetings[0]!;
    await settle();
    let episodes = 0;
    for (let i = 0; i < D7_MAX_ATTEMPTS; i += 1) {
      m.failNext.unsubscribe = 1;
      await m.participants.subscribe([OPP.peer], ["video", "audio"]);
      await settle();
      expect(m.failNext.unsubscribe, `episode ${i}: the failure was hit`).toBe(0);
      expect(received(m), `episode ${i}`).toEqual(NOTHING);
      episodes += 1;
    }
    expect(episodes, "anti-vacuity: episodes").toBe(D7_MAX_ATTEMPTS);
    expect(m.calls, "never left").not.toContain("leave");
    expect(cam.link()).not.toBeNull();
    expect(seen.map((x) => x.event)).toEqual(["d7_enforce_failed"]);
  });

  it("a leave that fails while failing closed is reported, not swallowed — and the camera still reads out of the meeting", async () => {
    const { seen, report } = reports();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), camera(m, OPP.peer), mic(m, OPP.peer)) });
    const cam = await makeJoinOwnCamera(rtk.load, report)("own-token");
    const m = rtk.meetings[0]!;
    await settle();
    m.failNext.unsubscribe = 1_000;
    m.failNext.leave = 1;
    await m.participants.subscribe([OPP.peer], ["video", "audio"]);
    await settle();
    expect(m.failNext.leave, "premise: the leave failed").toBe(0);
    expect(seen).toEqual([
      { event: "d7_enforce_failed", message: "injected unsubscribe failure" },
      { event: "d7_fail_closed", message: "injected unsubscribe failure" },
      { event: "d7_leave_failed", message: "injected leave failure" },
    ]);
    expect(cam.link(), "no roomLeft arrived, and still nothing is claimed").toBeNull();
    expect(cam.track()).toBeNull();
  });

  it("the fail-close is a FAULT, never the player's camera going off: the camera listener hears nothing, the fault listener once — and one added afterwards hears it at once", async () => {
    const rtk = fakeRealtimeKit({ setup: (m) => (m.peerJoins(OPP.peer, OPP.user), mic(m, OPP.peer)) });
    const cam = await makeJoinOwnCamera(rtk.load, () => {})("own-token");
    const m = rtk.meetings[0]!;
    const heard: [boolean, MediaStreamTrack | null][] = [];
    cam.onChange((enabled, track) => heard.push([enabled, track]));
    const early = faults(cam);
    m.failNext.unsubscribe = 1_000;
    await m.participants.subscribe([OPP.peer], ["audio"]);
    await settle();
    expect(heard, "no 'camera off' — that would be the player's").toEqual([]);
    expect(early.n).toBe(1);
    const late = faults(cam);
    await settle();
    expect(late.n, "a late listener is not left waiting for a fault that already happened").toBe(1);
    expect(received(m).audioConsumed).toBe(0);
  });

  it("NOTHING remote subscribed and the guard keeps failing: it STAYS — in the meeting, publishing, reported once — and retries quietly until the SDK lets it", async () => {
    const { seen, report } = reports();
    const timer = manualLater();
    // Alone in the meeting: nobody to receive. setViewMode fails 6 times in a row.
    const rtk = fakeRealtimeKit({ setup: (m) => (m.failNext.setViewMode = 6) });
    const cam = await makeJoinOwnCamera(rtk.load, report, { later: timer.later })("own-token");
    const fault = faults(cam);
    const m = rtk.meetings[0]!;
    await settle();
    expect(m.failNext.setViewMode, "premise: the join's attempts all failed").toBe(6 - D7_MAX_ATTEMPTS);
    expect([m.calls.includes("leave"), fault.n], "not left: nothing to refuse").toEqual([false, 0]);
    expect(cam.track(), "still publishing").not.toBeNull();
    expect(cam.link(), "still in the meeting").not.toBeNull();
    let fired = 0;
    while (m.participants.viewMode !== "MANUAL" && (await timer.fireNext())) fired += 1;
    expect(fired, "the quiet retries it took: one per remaining failure, plus the one that worked").toBe(6 - D7_MAX_ATTEMPTS + 1);
    expect(m.participants.viewMode, "recovered when the SDK did").toBe("MANUAL");
    expect(timer.pending(), "nothing further scheduled once it holds").toBe(0);
    expect(seen.map((x) => x.event), "reported once, never closed").toEqual(["d7_enforce_failed"]);
    // …and the opponent arriving now is refused as ever.
    m.peerJoins(OPP.peer, OPP.user);
    camera(m, OPP.peer);
    mic(m, OPP.peer);
    await settle();
    expect(received(m)).toEqual(NOTHING);
    expect(fault.n).toBe(0);
  });

  it("a run the SDK triggers while a quiet retry waits (a socket rejoin) goes at once and cancels that wait; the owner's leave cancels it too — no retry into a left meeting", async () => {
    const timer = manualLater();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.failNext.setViewMode = D7_MAX_ATTEMPTS) });
    const cam = await makeJoinOwnCamera(rtk.load, () => {}, { later: timer.later })("own-token");
    const m = rtk.meetings[0]!;
    await settle();
    expect(timer.pending(), "premise: a quiet retry waits").toBe(1);
    await m.reconnect(); // roomJoined re-asserts — and the SDK lets it now
    await settle();
    expect(m.participants.viewMode).toBe("MANUAL");
    expect(timer.pending(), "the waiting retry was cancelled by the run").toBe(0);

    const timer2 = manualLater();
    const rtk2 = fakeRealtimeKit({ setup: (x) => (x.failNext.setViewMode = 1_000) });
    const cam2 = await makeJoinOwnCamera(rtk2.load, () => {}, { later: timer2.later })("own-token");
    await settle();
    expect(timer2.pending(), "premise: a quiet retry waits").toBe(1);
    await cam2.leave();
    expect(timer2.pending(), "left: nothing waits to call into the left meeting").toBe(0);
    await cam.leave();
  });

  it("the quiet retries wait on the declared ladder, the last wait repeating — never a hot loop", async () => {
    const timer = manualLater();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.failNext.setViewMode = 1_000) });
    await makeJoinOwnCamera(rtk.load, () => {}, { later: timer.later })("own-token");
    await settle();
    const rounds = D7_QUIET_RETRY_MS.length + 2;
    for (let i = 0; i < rounds; i += 1) expect(await timer.fireNext(), `round ${i}`).toBe(true);
    const want = [...D7_QUIET_RETRY_MS, ...Array(3).fill(D7_QUIET_RETRY_MS.at(-1))];
    expect(timer.asked(), "one wait per failed retry").toEqual(want.slice(0, rounds + 1));
    expect(Math.min(...timer.asked()), "never immediate").toBeGreaterThan(0);
    expect(rtk.meetings[0]!.calls, "still in").not.toContain("leave");
  });

  it("degraded (the view never went MANUAL) and then a peer IS subscribed: refused at once — it leaves, the owner told, nothing consumed", async () => {
    const { seen, report } = reports();
    const timer = manualLater();
    const rtk = fakeRealtimeKit({ setup: (m) => (m.failNext.setViewMode = 1_000) });
    const cam = await makeJoinOwnCamera(rtk.load, report, { later: timer.later })("own-token");
    const fault = faults(cam);
    const m = rtk.meetings[0]!;
    await settle();
    expect(m.participants.viewMode, "premise: degraded").toBe("ACTIVE_GRID");
    const before = 1_000 - m.failNext.setViewMode;
    // The opponent arrives; the SDK's own view subscribes them.
    m.peerJoins(OPP.peer, OPP.user);
    camera(m, OPP.peer);
    mic(m, OPP.peer);
    await settle();
    expect(1_000 - m.failNext.setViewMode - before, "ONE more attempt, not three: it has failed long enough").toBe(1);
    expect([m.calls.includes("leave"), fault.n]).toEqual([true, 1]);
    expect(received(m).consumed + received(m).audioConsumed, "left before the consumer sync").toBe(0);
    expect(timer.pending(), "the quiet retry is cancelled").toBe(0);
    expect(seen.map((x) => x.event)).toEqual(["d7_enforce_failed", "d7_fail_closed"]);
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
      const rejoined = m.reconnect();
      expect(cam.link(), "SOCKET_PEERS is in, the media join is not: still nothing").toBeNull();
      await rejoined;
      expect(cam.link()?.joinedAt, "a rejoin restarts the settle").toBe(9_000);
      vi.setSystemTime(12_000);
      const media = m.mediaReconnect();
      expect(cam.link(), "the media node dropped: nothing is known").toBeNull();
      await media;
      expect(cam.link()?.joinedAt, "a media-node rejoin restarts the settle too").toBe(12_000);
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
