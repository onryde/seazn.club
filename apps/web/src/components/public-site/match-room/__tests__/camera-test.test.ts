// T17B fix 2, D15 (owner, 2026-10-14; controller ruling option (c)): under camera "required" the check-in tests the
// camera ON THE PAGE first — a local getUserMedia, no meeting, no vendor call — and Check in waits for a live track
// that has PAINTED a frame. On Check in the test track is stopped BEFORE anything else runs (the SDK then takes the
// camera as it always has, so the D2 seat gate keeps its own evidence). The session, driven over fake tracks.
import { describe, expect, it, vi } from "vitest";
import { cameraTest, canCheckIn, failureOf, type CameraTestView, type GetUserMedia } from "../camera-test";

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  readonly kind = "video";
  stops = 0;
  stop() {
    // As the platform does: stop() ends the track and fires NO "ended" event.
    this.stops += 1;
    this.readyState = "ended";
  }
  /** The device went away (unplugged, taken by another app): the platform fires "ended". */
  lose() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}
class FakeStream {
  constructor(readonly track = new FakeTrack()) {}
  getTracks() {
    return [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
}
const asStream = (s: FakeStream) => s as unknown as MediaStream;
const named = (name: string) => Object.assign(new Error(name), { name });

function harness(gum: GetUserMedia | null) {
  const views: CameraTestView[] = [];
  const s = cameraTest(gum, (v) => views.push(v));
  return { s, views, last: () => views.at(-1) ?? s.view() };
}
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("the camera test (D15) — a session over the platform's getUserMedia", () => {
  it("the empty case first: before any test there is no stream and Check in waits", () => {
    const { s } = harness(vi.fn());
    expect(s.view()).toEqual({ status: "idle", stream: null, failure: null });
    expect(canCheckIn(s.view())).toBe(false);
  });

  it("asks for the camera ONLY (no microphone), shows it at once, and lets Check in through only after a painted frame", async () => {
    const stream = new FakeStream();
    const gum = vi.fn(async () => asStream(stream));
    const { s, views } = harness(gum);
    const started = s.start();
    expect(s.view().status, "asking").toBe("testing");
    expect(canCheckIn(s.view())).toBe(false);
    await started;
    expect(gum.mock.calls).toEqual([[{ video: true, audio: false }]]);
    expect(s.view(), "the preview has its stream, no frame yet").toEqual({ status: "testing", stream: asStream(stream), failure: null });
    expect(canCheckIn(s.view()), "a stream is not yet a working camera").toBe(false);
    s.frame(asStream(stream));
    expect(s.view()).toEqual({ status: "live", stream: asStream(stream), failure: null });
    expect(canCheckIn(s.view())).toBe(true);
    expect(views.map((v) => v.status)).toEqual(["testing", "testing", "live"]);
  });

  it("a frame from another stream (a superseded preview) proves nothing", async () => {
    const stream = new FakeStream();
    const { s } = harness(async () => asStream(stream));
    await s.start();
    s.frame(asStream(new FakeStream()));
    expect(s.view().status).toBe("testing");
    expect(canCheckIn(s.view())).toBe(false);
  });

  it("each refusal has its own failure, from the brief's table — and Check in waits after every one (counted)", async () => {
    const table: [unknown, string][] = [
      [named("NotAllowedError"), "denied"],
      [named("NotFoundError"), "notFound"],
      [named("NotReadableError"), "inUse"],
      [named("OverconstrainedError"), "other"],
      [named("AbortError"), "other"],
      [new TypeError("getUserMedia is not a function"), "other"],
      ["a string, not an error", "other"],
    ];
    let checked = 0;
    for (const [err, kind] of table) {
      expect(failureOf(err), String(err)).toBe(kind);
      const { s } = harness(async () => {
        throw err;
      });
      await s.start();
      expect(s.view(), String(err)).toEqual({ status: "failed", stream: null, failure: kind });
      expect(canCheckIn(s.view()), String(err)).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(table.length);
  });

  it("no mediaDevices at all (an insecure page, an old browser): a failure to show, never a throw", async () => {
    const { s } = harness(null);
    await s.start();
    expect(s.view()).toEqual({ status: "failed", stream: null, failure: "other" });
  });

  it("a test after a failure can succeed: Test again", async () => {
    const stream = new FakeStream();
    const gum = vi.fn<GetUserMedia>().mockRejectedValueOnce(named("NotReadableError")).mockResolvedValueOnce(asStream(stream));
    const { s } = harness(gum);
    await s.start();
    expect(s.view().failure).toBe("inUse");
    await s.start();
    s.frame(asStream(stream));
    expect(s.view().status).toBe("live");
    expect(canCheckIn(s.view())).toBe(true);
  });

  it("the camera stops before Check in (unplugged, taken by another app): Check in waits again, and says so", async () => {
    const stream = new FakeStream();
    const { s } = harness(async () => asStream(stream));
    await s.start();
    s.frame(asStream(stream));
    expect(canCheckIn(s.view())).toBe(true);
    stream.track.lose();
    expect(s.view()).toEqual({ status: "failed", stream: null, failure: "ended" });
    expect(canCheckIn(s.view())).toBe(false);
  });

  it("a live view whose track has ended under it is not a camera (the guard, not the event)", async () => {
    const stream = new FakeStream();
    const { s } = harness(async () => asStream(stream));
    await s.start();
    s.frame(asStream(stream));
    stream.track.readyState = "ended"; // no event delivered
    expect(canCheckIn(s.view())).toBe(false);
  });

  it("hand-over (Check in): the test track is STOPPED, synchronously, before anything else can take the camera", async () => {
    const stream = new FakeStream();
    const { s } = harness(async () => asStream(stream));
    await s.start();
    s.frame(asStream(stream));
    s.handOver();
    expect(stream.track.readyState, "stopped at once").toBe("ended");
    expect(stream.track.stops).toBe(1);
    expect(s.view()).toEqual({ status: "handed", stream: null, failure: null });
    expect(canCheckIn(s.view()), "a retried Check in needs no second test").toBe(true);
    // A stopped track's later "ended" (none is fired by stop(); a stray one) changes nothing.
    stream.track.dispatchEvent(new Event("ended"));
    expect(s.view().status).toBe("handed");
  });

  it("hand-over while the camera is still being asked for: the late stream is stopped at once and never shown", async () => {
    const stream = new FakeStream();
    const wait = deferred<MediaStream>();
    const { s, views } = harness(() => wait.promise);
    const started = s.start();
    s.handOver();
    wait.resolve(asStream(stream));
    await started;
    expect(stream.track.readyState).toBe("ended");
    expect(s.view().status).toBe("handed");
    expect(views.some((v) => v.stream !== null), "the late stream never reached the preview").toBe(false);
  });

  it("a second Test while the first is asking: the first answer is dropped and its camera released", async () => {
    const first = new FakeStream();
    const second = new FakeStream();
    const a = deferred<MediaStream>();
    const gum = vi.fn<GetUserMedia>().mockReturnValueOnce(a.promise).mockResolvedValueOnce(asStream(second));
    const { s } = harness(gum);
    const one = s.start();
    await s.start();
    a.resolve(asStream(first));
    await one;
    expect(first.track.readyState, "the dropped answer is released").toBe("ended");
    expect(s.view().stream).toBe(asStream(second));
    expect(second.track.readyState).toBe("live");
  });

  it("leaving the check-in (stop): the camera light goes off, and the session is back to the start", async () => {
    const stream = new FakeStream();
    const { s } = harness(async () => asStream(stream));
    await s.start();
    s.stop();
    expect(stream.track.readyState).toBe("ended");
    expect(s.view()).toEqual({ status: "idle", stream: null, failure: null });
    expect(canCheckIn(s.view())).toBe(false);
  });
});
