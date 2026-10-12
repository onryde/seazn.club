// T14 — the player's own camera, every transition (rule 1): a second start,
// a join that fails, a camera that drops and comes back, a stop before the
// join lands. The RealtimeKit join is the injected seam; the real one is the
// e2e's (with camera policy off the room never loads it — asserted there).
import { describe, expect, it } from "vitest";
import { cameraSession, RECOVER_BACKOFF_MS, type CameraView } from "../camera-session";
import { D7GuardError, makeJoinOwnCamera, type MeetingLink, type OwnCamera } from "../camera-loader";
import { fakeRealtimeKit, type FakeMeeting } from "./_fake-realtimekit";
import { matchCameraOff } from "@/server/external-play/video/match-camera-off";
import { videoOffCoverage } from "@/server/external-play/video/realtimekit";

const TRACK = { id: "local-video" } as unknown as MediaStreamTrack;

function fakeCamera(initial: MediaStreamTrack | null) {
  let listener: ((enabled: boolean, track: MediaStreamTrack | null) => void) | null = null;
  let faultListener: (() => void) | null = null;
  const calls = { leave: 0, enable: 0, unsubscribed: 0, linkUnsubscribed: 0, faultUnsubscribed: 0 };
  let current: MeetingLink | null = { joinedAt: 1, peers: [] };
  const linkListeners = new Set<() => void>();
  const cam: OwnCamera = {
    link: () => current,
    onLinkChange(cb) {
      linkListeners.add(cb);
      return () => {
        calls.linkUnsubscribed += 1;
        linkListeners.delete(cb);
      };
    },
    track: () => initial,
    onChange(cb) {
      listener = cb;
      return () => {
        calls.unsubscribed += 1;
        listener = null;
      };
    },
    async enable() {
      calls.enable += 1;
      listener?.(true, TRACK);
    },
    async leave() {
      calls.leave += 1;
    },
    onFault(cb) {
      faultListener = cb;
      return () => {
        calls.faultUnsubscribed += 1;
        faultListener = null;
      };
    },
  };
  return {
    cam,
    calls,
    fire: (enabled: boolean, track: MediaStreamTrack | null) => listener?.(enabled, track),
    /** The guard left the meeting (camera-loader's fail-close). */
    fault: () => faultListener?.(),
    setLink: (l: MeetingLink | null) => {
      current = l;
      for (const cb of [...linkListeners]) cb();
    },
  };
}

function record() {
  const views: CameraView[] = [];
  return { views, emit: (v: CameraView) => views.push(v), statuses: () => views.map((v) => v.status) };
}

describe("cameraSession", () => {
  it("the empty case: never started ⇒ nothing emitted, nothing joined", async () => {
    let joins = 0;
    const r = record();
    const s = cameraSession(async () => {
      joins += 1;
      return fakeCamera(TRACK).cam;
    }, r.emit);
    await s.enable(); // nothing to enable yet
    await s.stop();
    expect([joins, r.views.length]).toEqual([0, 0]);
  });

  it("idle → joining → live, with the caller's own token and the local track", async () => {
    const tokens: string[] = [];
    const r = record();
    const f = fakeCamera(TRACK);
    const s = cameraSession(async (t) => {
      tokens.push(t);
      return f.cam;
    }, r.emit);
    await s.start("own-token");
    expect(tokens).toEqual(["own-token"]);
    expect(r.views).toEqual([
      { status: "joining", track: null },
      { status: "live", track: TRACK },
    ]);
  });

  it("a second start — while joining, or once joined — never joins twice", async () => {
    let joins = 0;
    let release: (c: OwnCamera) => void = () => {};
    const r = record();
    const s = cameraSession(
      () =>
        new Promise<OwnCamera>((res) => {
          joins += 1;
          release = res;
        }),
      r.emit,
    );
    const first = s.start("t");
    await s.start("t"); // while joining
    release(fakeCamera(TRACK).cam);
    await first;
    await s.start("t"); // once joined
    expect(joins).toBe(1);
  });

  it("a join that throws (permission denied, no device) is failed", async () => {
    const r = record();
    const s = cameraSession(async () => {
      throw new Error("NotAllowedError");
    }, r.emit);
    await s.start("t");
    expect(r.statuses()).toEqual(["joining", "failed"]);
  });

  it("joined with no camera track (published nothing) reads as off, not live", async () => {
    const r = record();
    const s = cameraSession(async () => fakeCamera(null).cam, r.emit);
    await s.start("t");
    expect(r.views.at(-1)).toEqual({ status: "off", track: null });
  });

  it("the camera drops ⇒ off; Turn camera on ⇒ live again", async () => {
    const r = record();
    const f = fakeCamera(TRACK);
    const s = cameraSession(async () => f.cam, r.emit);
    await s.start("t");
    f.fire(false, TRACK);
    expect(r.views.at(-1)).toEqual({ status: "off", track: null });
    await s.enable();
    expect([f.calls.enable, r.views.at(-1)]).toEqual([1, { status: "live", track: TRACK }]);
  });

  it("stop leaves the meeting and unsubscribes; changes after stop emit nothing; a second stop is a no-op", async () => {
    const r = record();
    const f = fakeCamera(TRACK);
    const s = cameraSession(async () => f.cam, r.emit);
    await s.start("t");
    const before = r.views.length;
    await s.stop();
    f.fire(false, null);
    await s.stop();
    expect([f.calls.leave, f.calls.unsubscribed, r.views.length]).toEqual([1, 1, before]);
    await s.start("t");
    expect(r.views.length, "nothing starts after stop").toBe(before);
  });

  it("a join that lands AFTER stop is left at once and never reported live", async () => {
    let release: (c: OwnCamera) => void = () => {};
    const r = record();
    const f = fakeCamera(TRACK);
    const s = cameraSession(() => new Promise<OwnCamera>((res) => (release = res)), r.emit);
    const pending = s.start("t");
    await s.stop();
    release(f.cam);
    await pending;
    expect(f.calls.leave).toBe(1);
    expect(r.statuses()).toEqual(["joining"]);
  });

  it("the meeting link (review I8): null before the join, the camera's own after it, relayed to a listener added BEFORE the join, and null again after stop — with the camera's listener released", async () => {
    const { cam, calls, setLink } = fakeCamera(TRACK);
    let release!: (c: OwnCamera) => void;
    const s = cameraSession(() => new Promise<OwnCamera>((r) => (release = r)), () => {});
    let heard = 0;
    const off = s.onLinkChange(() => (heard += 1));
    expect(s.link(), "the empty case: no camera, no link").toBeNull();
    const started = s.start("tok");
    release(cam);
    await started;
    expect(heard, "the join itself is a change").toBeGreaterThan(0);
    expect(s.link()).toEqual({ joinedAt: 1, peers: [] });
    const h0 = heard;
    setLink({ joinedAt: 2, peers: [{ userId: "rtk-opp", videoLive: true }] });
    expect(heard).toBe(h0 + 1);
    expect(s.link()?.peers).toEqual([{ userId: "rtk-opp", videoLive: true }]);
    await s.stop();
    expect(s.link(), "stopped: nothing is known").toBeNull();
    expect(calls.linkUnsubscribed, "the camera's link listener is released").toBe(1);
    const h1 = heard;
    setLink({ joinedAt: 3, peers: [] });
    expect(heard, "nothing relayed after stop").toBe(h1);
    off();
  });

  it("a join that lands after stop relays nothing and leaves no listener behind", async () => {
    const { cam, calls } = fakeCamera(TRACK);
    let release!: (c: OwnCamera) => void;
    const s = cameraSession(() => new Promise<OwnCamera>((r) => (release = r)), () => {});
    let heard = 0;
    s.onLinkChange(() => (heard += 1));
    const started = s.start("tok");
    await s.stop();
    release(cam);
    await started;
    expect(s.link()).toBeNull();
    expect(heard).toBe(0);
    expect(calls.leave).toBe(1);
  });
});

// T14 re-review 3, I-1 (controller ruling 2026-10-12): when the guard has to
// leave the meeting, that is OUR fault — the camera re-joins a fresh meeting
// with back-off, the gap is stamped on the server (start, then end), and the
// player is never shown "camera off" for it.
describe("cameraSession — our guard's fault: re-join, never blame (I-1)", () => {
  /** Joins that hand out the given cameras in order; a thrown value is a
   *  failed attempt. */
  function joins(...outcomes: (OwnCamera | Error)[]) {
    const tokens: string[] = [];
    const join = async (t: string) => {
      tokens.push(t);
      const next = outcomes.shift();
      if (next === undefined) throw new Error("no more joins scripted");
      if (next instanceof Error) throw next;
      return next;
    };
    return { join, tokens };
  }
  function stamps() {
    const seen: ("start" | "end")[] = [];
    return { seen, stamp: async (state: "start" | "end") => void seen.push(state) };
  }
  const instant = { sleep: async () => {} };

  it("a fault ⇒ recovering (never off/failed) ⇒ a fresh join ⇒ live; the old camera left, its listeners released; stamped start then end", async () => {
    const r = record();
    const first = fakeCamera(TRACK);
    const second = fakeCamera(TRACK);
    const j = joins(first.cam, second.cam);
    const st = stamps();
    const s = cameraSession(j.join, r.emit, { stamp: st.stamp, ...instant });
    await s.start("own-token");
    first.fault();
    expect(r.views.at(-1), "at once: ours, reconnecting").toEqual({ status: "recovering", track: null });
    expect(st.seen, "stamped before anything else happens").toEqual(["start"]);
    await new Promise((res) => setTimeout(res, 0));
    expect(j.tokens, "re-joined with the seat's own token").toEqual(["own-token", "own-token"]);
    expect(r.statuses()).toEqual(["joining", "live", "recovering", "live"]);
    expect(st.seen).toEqual(["start", "end"]);
    expect([first.calls.leave, first.calls.unsubscribed, first.calls.linkUnsubscribed, first.calls.faultUnsubscribed]).toEqual([1, 1, 1, 1]);
    // The new camera is the session's now: its changes are relayed.
    second.fire(false, TRACK);
    expect(r.views.at(-1)).toEqual({ status: "off", track: null });
    first.fire(true, TRACK);
    expect(r.views.at(-1), "the old camera is heard no more").toEqual({ status: "off", track: null });
  });

  it("re-join attempts that fail back off on the declared ladder, the last wait repeating, status recovering throughout", async () => {
    const r = record();
    const first = fakeCamera(TRACK);
    const fails = Array.from({ length: RECOVER_BACKOFF_MS.length + 1 }, () => new D7GuardError(new Error("cap")));
    const j = joins(first.cam, ...fails, fakeCamera(TRACK).cam);
    const waits: number[] = [];
    const st = stamps();
    const s = cameraSession(j.join, r.emit, { stamp: st.stamp, sleep: async (ms) => void waits.push(ms) });
    await s.start("t");
    first.fault();
    for (let i = 0; i < 20 && r.views.at(-1)?.status !== "live"; i += 1) await new Promise((res) => setTimeout(res, 0));
    expect(waits).toEqual([...RECOVER_BACKOFF_MS, RECOVER_BACKOFF_MS.at(-1), RECOVER_BACKOFF_MS.at(-1)]);
    expect(r.statuses()).toEqual(["joining", "live", "recovering", "live"]);
    expect(st.seen, "one interval, however many attempts").toEqual(["start", "end"]);
  });

  it("the default ladder starts its first FOUR attempts inside 7 s — under the 15 s (3 × 5 s cadence, spec §5.2) that would make the gap a loss even unstamped", () => {
    const startsAt = RECOVER_BACKOFF_MS.slice(0, 4).reduce<number[]>((acc, w) => [...acc, (acc.at(-1) ?? 0) + w], []);
    expect(startsAt.at(-1)).toBeLessThanOrEqual(7_000);
    expect(startsAt.at(-1)).toBeLessThan(3 * 5_000);
    expect(RECOVER_BACKOFF_MS[0], "the first re-join is at once").toBe(0);
  });

  it("a first join that our guard could not hold (D7GuardError) is recovered the same way — never 'failed'; any OTHER join error still is", async () => {
    const r = record();
    const st = stamps();
    const later = fakeCamera(TRACK);
    const s = cameraSession(joins(new D7GuardError(new Error("cap")), later.cam).join, r.emit, { stamp: st.stamp, ...instant });
    await s.start("t");
    await new Promise((res) => setTimeout(res, 0));
    expect(r.statuses()).toEqual(["joining", "recovering", "live"]);
    expect(st.seen).toEqual(["start", "end"]);

    const r2 = record();
    const st2 = stamps();
    const s2 = cameraSession(joins(new Error("NotAllowedError")).join, r2.emit, { stamp: st2.stamp, ...instant });
    await s2.start("t");
    expect(r2.statuses(), "the player's own device or permission").toEqual(["joining", "failed"]);
    expect(st2.seen, "nothing of ours to stamp").toEqual([]);
  });

  it("stop while recovering: nothing re-joins, the stamp is closed; a join landing after is left at once", async () => {
    const r = record();
    const first = fakeCamera(TRACK);
    const late = fakeCamera(TRACK);
    let release!: (c: OwnCamera) => void;
    let n = 0;
    const join = (): Promise<OwnCamera> => (n++ === 0 ? Promise.resolve(first.cam) : new Promise((res) => (release = res)));
    const st = stamps();
    const s = cameraSession(join, r.emit, { stamp: st.stamp, ...instant });
    await s.start("t");
    first.fault();
    await new Promise((res) => setTimeout(res, 0));
    expect(n, "premise: the re-join is in flight").toBe(2);
    await s.stop();
    expect(st.seen, "the page is gone: our interval ends with it").toEqual(["start", "end"]);
    release(late.cam);
    await new Promise((res) => setTimeout(res, 0));
    expect(late.calls.leave).toBe(1);
    expect(r.statuses()).toEqual(["joining", "live", "recovering"]);
  });

  it("a second fault after recovering is a second interval; a fault from a camera already replaced is ignored", async () => {
    const r = record();
    const a = fakeCamera(TRACK);
    const b = fakeCamera(TRACK);
    const c = fakeCamera(TRACK);
    const st = stamps();
    const s = cameraSession(joins(a.cam, b.cam, c.cam).join, r.emit, { stamp: st.stamp, ...instant });
    await s.start("t");
    a.fault();
    await new Promise((res) => setTimeout(res, 0));
    b.fault();
    await new Promise((res) => setTimeout(res, 0));
    expect(st.seen).toEqual(["start", "end", "start", "end"]);
    a.fault(); // its listener was released; nothing may happen
    await new Promise((res) => setTimeout(res, 0));
    expect(st.seen).toEqual(["start", "end", "start", "end"]);
    expect(r.statuses()).toEqual(["joining", "live", "recovering", "live", "recovering", "live"]);
  });

  it("while recovering, Turn camera on does nothing and a new start only updates the token the re-join uses", async () => {
    const r = record();
    const first = fakeCamera(TRACK);
    const second = fakeCamera(TRACK);
    let gate!: () => void;
    const j = joins(first.cam, second.cam);
    const s = cameraSession(j.join, r.emit, { sleep: () => new Promise<void>((res) => (gate = res)) });
    await s.start("seat-1");
    first.fault();
    await s.enable();
    expect(first.calls.enable, "not into the left meeting").toBe(0);
    await s.start("seat-2"); // a later seat answer
    gate();
    await new Promise((res) => setTimeout(res, 0));
    expect(j.tokens).toEqual(["seat-1", "seat-2"]);
    expect(r.statuses()).toEqual(["joining", "live", "recovering", "live"]);
  });
});

// The ruling's own scenario, through camera-session over the REAL loader and
// the port of the SDK: leave → re-join → still nothing received → the
// player's camera publishing again.
describe("cameraSession over the real loader: the heal (I-1, rulings 2 and 5)", () => {
  const OPP = { peer: "opp-peer", user: "rtk-opponent" };
  const ARB = { peer: "arb-peer", user: "rtk-arbiter" };
  const tick = () => new Promise((res) => setTimeout(res, 0));
  async function until(cond: () => boolean, what: string) {
    for (let i = 0; i < 200 && !cond(); i += 1) await tick();
    expect(cond(), what).toBe(true);
  }
  /** Every remote consumer this client ever created, plus — while it is in
   *  the meeting — anyone still subscribed. A meeting it LEFT receives
   *  nothing more, whatever its stale maps still hold. */
  const received = (m: FakeMeeting) =>
    m.consumedVideo.length +
    m.consumedAudio.length +
    (m.socketJoined ? m.participants.videoSubscribed.size + m.participants.audioSubscribed.size : 0);

  /** One player's browser: the opponent and an arbiter in the room, both
   *  selected (so the cap of 0 alone would leak one — the guard's work), and
   *  an event log on a shared sequence. */
  function player(name: string, burst: { on: boolean }, log: [string, string][]) {
    const rtk = fakeRealtimeKit({
      setup: (m) => {
        m.peerJoins(OPP.peer, OPP.user);
        m.peerJoins(ARB.peer, ARB.user);
        m.produce(OPP.peer, { producerId: "opp-cam", kind: "video", screenShare: false });
        m.produce(OPP.peer, { producerId: "opp-mic", kind: "audio", screenShare: false });
        m.select([OPP.peer, ARB.peer]);
        m.failWhile = () => burst.on;
        const join = m.join.bind(m);
        m.join = async () => {
          await join();
          log.push([name, "joined"]);
        };
        const leave = m.leave.bind(m);
        m.leave = async () => {
          log.push([name, "left"]);
          await leave();
        };
      },
    });
    const views: CameraView[] = [];
    const waits: number[] = [];
    const session = cameraSession(makeJoinOwnCamera(rtk.load, () => {}), (v) => views.push(v), {
      stamp: async (state) => void log.push([name, `stamp:${state}`]),
      sleep: async (ms) => {
        waits.push(ms);
        // The fault clears while the third re-join waits.
        if (waits.length === 3) burst.on = false;
        await tick();
      },
    });
    return { rtk, views, waits, session };
  }

  it("ruling 2: the guard leaves, camera-session re-joins a FRESH meeting, still nothing received, the camera publishing again", async () => {
    const burst = { on: false };
    const log: [string, string][] = [];
    const p = player("p", burst, log);
    await p.session.start("own-token");
    const m1 = p.rtk.meetings[0]!;
    await tick();
    expect(p.views.at(-1)?.status, "premise: live").toBe("live");
    // unsubscribe fails for good on THIS meeting while a socket rejoin
    // re-selects the opponent (their media join lands in the rejoin's
    // window, in the SDK's reset view): the guard must leave.
    m1.failNext.unsubscribe = 1_000;
    await m1.reconnect({ inWindow: (x) => x.peerMediaJoined(OPP.peer) });
    await until(() => p.views.at(-1)?.status === "live" && p.rtk.meetings.length === 2, "re-joined and live");
    const m2 = p.rtk.meetings[1]!;
    expect(m1.socketJoined, "the old meeting was left").toBe(false);
    expect(received(m1), "nothing received in the old one").toBe(0);
    expect(received(m2), "nothing received in the new one").toBe(0);
    expect(m2.participants.viewMode).toBe("MANUAL");
    expect(m2.calls.indexOf("setMax:0"), "capped before the join").toBeLessThan(m2.calls.indexOf("join"));
    expect(p.views.at(-1)?.track, "the player's own camera, publishing").not.toBeNull();
    expect(p.views.map((v) => v.status)).toEqual(["joining", "live", "recovering", "live"]);
    expect(log.map(([, e]) => e)).toEqual(["joined", "stamp:start", "left", "joined", "stamp:end"]);
    await p.session.stop();
  });

  it("ruling 5: all THREE guard calls throw at once for EVERY player — each leaves, re-joins when the fault clears, nothing received, never shown off or failed, and the stamps cover every gap", async () => {
    const burst = { on: false };
    const log: [string, string][] = [];
    const players = [player("home", burst, log), player("away", burst, log)];
    for (const p of players) await p.session.start("own-token");
    await tick();
    expect(players.map((p) => p.views.at(-1)?.status), "premise: both live").toEqual(["live", "live"]);
    burst.on = true;
    // A socket rejoin for each (the SDK resets the view; its selection
    // subscribes the leak) while every guard call throws.
    await Promise.all(players.map((p) => p.rtk.meetings[0]!.reconnect()));
    await until(() => players.every((p) => p.views.at(-1)?.status === "live" && p.rtk.meetings.length >= 2), "every camera back");
    let checked = 0;
    for (const p of players) {
      const statuses = p.views.map((v) => v.status);
      expect(statuses.filter((x) => x === "off" || x === "failed"), "never the player's states").toEqual([]);
      expect(statuses.at(-1)).toBe("live");
      // meetings[0] is the one left; the last is the one that held; every
      // one between is a re-join the fault refused before it joined.
      expect(p.rtk.meetings.length - 2, "re-joins refused while the fault lasted").toBeGreaterThanOrEqual(1);
      for (const m of p.rtk.meetings.slice(1, -1)) expect(m.calls, "refused before joining").not.toContain("join");
      for (const m of p.rtk.meetings) expect(received(m), "nothing received, in any meeting").toBe(0);
      const last = p.rtk.meetings.at(-1)!;
      expect(last.socketJoined && last.participants.viewMode === "MANUAL", "the fresh meeting holds").toBe(true);
      checked += 1;
    }
    expect(checked, "anti-vacuity: players").toBe(2);

    // No blame: each player's stamped interval covers their whole gap —
    // opened before the leave, closed after the re-join. Laid on a timeline
    // (one event = 20 s, so the gap is far past the 15 s threshold) and fed
    // to T13's own judge, the positive pair: unstamped it IS a loss.
    const SEC = 20;
    for (const name of ["home", "away"]) {
      const at = (e: string) => log.findIndex(([n, x]) => n === name && x === e);
      const lastAt = (e: string) => log.length - 1 - [...log].reverse().findIndex(([n, x]) => n === name && x === e);
      const [start, left, rejoined, end] = [at("stamp:start"), at("left"), lastAt("joined"), at("stamp:end")];
      expect(start, `${name}: stamped before leaving`).toBeLessThan(left);
      expect(rejoined, `${name}: back before the stamp closed`).toBeLessThan(end);
      const iso = (i: number) => new Date(Date.UTC(2026, 9, 12, 10) + i * SEC * 1000).toISOString();
      const conn = (from: number, to: number) => {
        const samples: number[] = [];
        for (let t = from * SEC; t <= to * SEC; t += 5) samples.push(t);
        const c = videoOffCoverage({
          participant: {
            joined_at: iso(from), left_at: iso(to), duration: ((to - from) * SEC) / 60,
            peer_report: { metadata: { events: [] }, quality: { video_producer: samples.map((t) => ({ timestamp: iso(t / SEC), frames_encoded: 140 })) } },
          },
        });
        if (c.incomplete) throw new Error("premise: final");
        return c;
      };
      const window = { from: new Date(iso(0)), to: new Date(iso(log.length + 1)) };
      const reports = [conn(0, left), conn(rejoined, log.length + 1)];
      const stamped = [{ from: new Date(iso(start)), to: new Date(iso(end)) }];
      expect(matchCameraOff(window, reports).offIntervals.length, `${name}: unstamped, the gap would be flagged`).toBe(1);
      expect(matchCameraOff(window, reports, stamped).offIntervals, `${name}: stamped, nothing is the player's`).toEqual([]);
    }
    for (const p of players) await p.session.stop();
  });
});
