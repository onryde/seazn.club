// T14 — the player's own camera, every transition (rule 1): a second start,
// a join that fails, a camera that drops and comes back, a stop before the
// join lands. The RealtimeKit join is the injected seam; the real one is the
// e2e's (with camera policy off the room never loads it — asserted there).
import { describe, expect, it } from "vitest";
import { cameraSession, type CameraView } from "../camera-session";
import type { MeetingLink, OwnCamera } from "../camera-loader";

const TRACK = { id: "local-video" } as unknown as MediaStreamTrack;

function fakeCamera(initial: MediaStreamTrack | null) {
  let listener: ((enabled: boolean, track: MediaStreamTrack | null) => void) | null = null;
  const calls = { leave: 0, enable: 0, unsubscribed: 0, linkUnsubscribed: 0 };
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
  };
  return {
    cam,
    calls,
    fire: (enabled: boolean, track: MediaStreamTrack | null) => listener?.(enabled, track),
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
