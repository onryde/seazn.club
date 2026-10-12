// T14 — the player's own camera, every transition (rule 1): a second start,
// a join that fails, a camera that drops and comes back, a stop before the
// join lands. The RealtimeKit join is the injected seam; the real one is the
// e2e's (with camera policy off the room never loads it — asserted there).
import { describe, expect, it } from "vitest";
import { cameraSession, type CameraView } from "../camera-session";
import type { OwnCamera } from "../camera-loader";

const TRACK = { id: "local-video" } as unknown as MediaStreamTrack;

function fakeCamera(initial: MediaStreamTrack | null) {
  let listener: ((enabled: boolean, track: MediaStreamTrack | null) => void) | null = null;
  const calls = { leave: 0, enable: 0, unsubscribed: 0 };
  const cam: OwnCamera = {
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
  return { cam, calls, fire: (enabled: boolean, track: MediaStreamTrack | null) => listener?.(enabled, track) };
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
});
