// T17B fix 2, D23 (owner defect, stg v797): "the camera goes off and comes back at Check in". Check in stops the D15
// test track before the seat is asked for (D2 unchanged), so the tile went blank until the SDK's own video arrived.
// The fix is a frozen frame over the tile in between: drawn from the preview BEFORE the stop (a stopped track draws
// black), labelled, and removed when the SDK's video has painted a frame — or after HANDOVER_COVER_MS, when the
// ordinary camera_starting state is what the player is left with. The session and the capture, over fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cameraHandover, captureFrame, HANDOVER_COVER_MS, IDLE_HANDOVER, type HandoverView } from "../camera-handover";

const canvas = (tag = "frame") => ({ tag }) as unknown as HTMLCanvasElement;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function harness() {
  const views: HandoverView[] = [];
  const s = cameraHandover((v) => views.push(v));
  return { s, views };
}

describe("the hand-over cover (D23) — a session between Check in's stop and the SDK's first frame", () => {
  it("the empty case first: nothing covers anything before Check in", () => {
    const { s, views } = harness();
    expect(s.view()).toEqual(IDLE_HANDOVER);
    expect(IDLE_HANDOVER.frame).toBeNull();
    s.sdkFrame();
    vi.advanceTimersByTime(HANDOVER_COVER_MS * 2);
    expect(views, "no frame, no timer: nothing ever emitted").toEqual([]);
  });

  it("the cover is bounded at about eight seconds (the ruling's number, typed from the brief)", () => {
    expect(HANDOVER_COVER_MS).toBe(8_000);
  });

  it("no frame to keep (the preview had painted none): there is nothing to cover and no timer runs", () => {
    const { s, views } = harness();
    expect(s.begin(null)).toBe(false);
    expect(s.view().status).toBe("idle");
    vi.advanceTimersByTime(HANDOVER_COVER_MS * 2);
    expect(views).toEqual([]);
  });

  it("covers with the frame it was given, and the SDK's first frame removes it — and only once", () => {
    const { s, views } = harness();
    const frame = canvas();
    expect(s.begin(frame)).toBe(true);
    expect(s.view()).toEqual({ status: "covering", frame });
    s.sdkFrame();
    expect(s.view()).toEqual({ status: "over", frame: null, by: "sdk" });
    // The timer died with the cover: a later tick must not emit a second transition.
    vi.advanceTimersByTime(HANDOVER_COVER_MS * 2);
    s.sdkFrame();
    expect(views.map((v) => v.status)).toEqual(["covering", "over"]);
    expect(vi.getTimerCount(), "no timer left behind").toBe(0);
  });

  it("the cover ends at the bound — still there one tick before, gone at it (boundary pair)", () => {
    const { s } = harness();
    s.begin(canvas());
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 1);
    expect(s.view().status, "one millisecond early: still covering").toBe("covering");
    vi.advanceTimersByTime(1);
    expect(s.view()).toEqual({ status: "over", frame: null, by: "timeout" });
  });

  it("an SDK frame that arrives after the bound changes nothing (the fallback already stands)", () => {
    const { s, views } = harness();
    s.begin(canvas());
    vi.advanceTimersByTime(HANDOVER_COVER_MS);
    s.sdkFrame();
    expect(s.view()).toEqual({ status: "over", frame: null, by: "timeout" });
    expect(views.map((v) => v.status)).toEqual(["covering", "over"]);
  });

  it("a second hand-over (a re-test after a re-join) covers afresh and gets its own full bound", () => {
    const { s } = harness();
    s.begin(canvas("one"));
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 100);
    s.sdkFrame();
    const second = canvas("two");
    expect(s.begin(second)).toBe(true);
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 1);
    expect(s.view(), "the first cover's timer is not the second's").toEqual({ status: "covering", frame: second });
    vi.advanceTimersByTime(1);
    expect(s.view().status).toBe("over");
  });

  it("beginning again while still covering restarts the bound rather than stacking two timers", () => {
    const { s } = harness();
    s.begin(canvas("one"));
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 10);
    const second = canvas("two");
    s.begin(second);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 1);
    expect(s.view()).toEqual({ status: "covering", frame: second });
  });

  it("disposing mid-cover leaves no timer and emits nothing further (the room unmounted)", () => {
    const { s, views } = harness();
    s.begin(canvas());
    s.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HANDOVER_COVER_MS * 2);
    expect(views.map((v) => v.status)).toEqual(["covering"]);
  });
});

/** A video element with a size and a record of what was drawn from it. */
function video(w: number, h: number) {
  return { videoWidth: w, videoHeight: h } as unknown as HTMLVideoElement;
}
function fakeCanvas(opts: { ctx?: boolean; drawThrows?: boolean } = {}) {
  const draws: unknown[][] = [];
  const c = {
    width: 0,
    height: 0,
    getContext: () =>
      opts.ctx === false
        ? null
        : {
            drawImage: (...a: unknown[]) => {
              if (opts.drawThrows) throw new Error("tainted");
              draws.push(a);
            },
          },
  };
  return { c: c as unknown as HTMLCanvasElement & { width: number; height: number }, draws };
}

describe("capturing the preview's frame (D23)", () => {
  it("a preview that has painted nothing (no size) yields no frame — the guard against a blank canvas", () => {
    const fc = fakeCanvas();
    expect(captureFrame(video(0, 0), () => fc.c)).toBeNull();
    expect(captureFrame(video(640, 0), () => fc.c)).toBeNull();
    expect(fc.draws, "nothing was drawn").toEqual([]);
  });

  it("draws the video's current frame, whole, at its own size", () => {
    const fc = fakeCanvas();
    const v = video(320, 240);
    const out = captureFrame(v, (w, h) => {
      fc.c.width = w;
      fc.c.height = h;
      return fc.c;
    });
    expect(out).toBe(fc.c);
    expect(fc.draws).toEqual([[v, 0, 0, 320, 240]]);
    expect([fc.c.width, fc.c.height]).toEqual([320, 240]);
  });

  it("keeps a large frame to a bounded size, in proportion (a 1280x720 camera does not pin a 1280-wide bitmap)", () => {
    const fc = fakeCanvas();
    const out = captureFrame(video(1280, 720), (w, h) => {
      fc.c.width = w;
      fc.c.height = h;
      return fc.c;
    });
    expect(out).toBe(fc.c);
    expect([fc.c.width, fc.c.height]).toEqual([640, 360]);
    expect(fc.draws[0]!.slice(1)).toEqual([0, 0, 640, 360]);
  });

  it("no 2d context, or a draw the browser refuses, is no frame — never a throw into the Check in click", () => {
    expect(captureFrame(video(320, 240), () => fakeCanvas({ ctx: false }).c)).toBeNull();
    expect(captureFrame(video(320, 240), () => fakeCanvas({ drawThrows: true }).c)).toBeNull();
    expect(captureFrame(video(320, 240), () => null)).toBeNull();
  });
});
