// T17B fix 2, D23 (owner defect, stg v797): "the camera goes off and comes back at Check in". Check in stops the D15
// test track before the seat is asked for (D2 unchanged), so the tile went blank until the SDK's own video arrived.
// The fix is a frozen frame over the tile in between: drawn from the preview BEFORE the stop (a stopped track draws
// black), labelled, and removed when the SDK's video has painted a frame. D23-fix: the PICTURE goes after
// HANDOVER_COVER_MS, but the words ("Connecting your camera…") stay over the silhouette until the SDK's frame or an
// end the room reports (camera failed, the screen left, the poll budget spent), under a hard ceiling; the end is
// emitted once, with `by` and the milliseconds from the click, for the stg measurement. The session and the capture,
// over fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cameraHandover,
  captureFrame,
  handoverBreadcrumb,
  HANDOVER_CEILING_MS,
  HANDOVER_COVER_MS,
  IDLE_HANDOVER,
  isHandoverActive,
  type HandoverEndEvent,
  type HandoverView,
} from "../camera-handover";

const canvas = (tag = "frame") => ({ tag }) as unknown as HTMLCanvasElement;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function harness() {
  const views: HandoverView[] = [];
  const ends: HandoverEndEvent[] = [];
  const s = cameraHandover((v) => views.push(v), { onEnd: (e) => ends.push(e) });
  return { s, views, ends };
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

  it("the PICTURE ends at the bound — still there one tick before, gone at it (boundary pair) — and the words stay (D23-fix m1)", () => {
    const { s, ends } = harness();
    s.begin(canvas());
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 1);
    expect(s.view().status, "one millisecond early: still covering").toBe("covering");
    vi.advanceTimersByTime(1);
    expect(s.view(), "no picture, but not over: the chip stays over the silhouette").toEqual({ status: "connecting", frame: null });
    expect(isHandoverActive(s.view())).toBe(true);
    expect(ends, "nothing has ended").toEqual([]);
  });

  it("an SDK frame that arrives AFTER the picture's bound still ends it — by the SDK, flagged as late (the stg measurement)", () => {
    const { s, views, ends } = harness();
    s.begin(canvas());
    vi.advanceTimersByTime(HANDOVER_COVER_MS + 2_500);
    s.sdkFrame();
    expect(s.view()).toEqual({ status: "over", frame: null, by: "sdk" });
    expect(views.map((v) => v.status)).toEqual(["covering", "connecting", "over"]);
    expect(ends).toEqual([{ by: "sdk", ms: HANDOVER_COVER_MS + 2_500, pictureExpired: true }]);
    expect(vi.getTimerCount(), "no timer left behind").toBe(0);
  });

  it("the end is emitted ONCE, with the milliseconds from the click: an SDK frame inside the bound is not late", () => {
    const { s, ends } = harness();
    s.begin(canvas());
    vi.advanceTimersByTime(1_234);
    s.sdkFrame();
    s.sdkFrame();
    s.end("failed");
    expect(ends).toEqual([{ by: "sdk", ms: 1_234, pictureExpired: false }]);
  });

  it("the room's own ends (failed, left, budget, idle) stop it from either state, each saying why — and from idle or over they are no-ops (counted)", () => {
    let checked = 0;
    for (const by of ["failed", "left", "budget", "idle"] as const) {
      for (const phase of ["covering", "connecting"] as const) {
        const { s, views, ends } = harness();
        s.end(by); // idle: nothing
        expect([s.view().status, ends.length], `${by} while idle`).toEqual(["idle", 0]);
        s.begin(canvas());
        vi.advanceTimersByTime(phase === "covering" ? 1_000 : HANDOVER_COVER_MS + 1_000);
        s.end(by);
        expect(s.view(), `${by} while ${phase}`).toEqual({ status: "over", frame: null, by });
        expect(ends, `${by} while ${phase}`).toEqual([
          { by, ms: phase === "covering" ? 1_000 : HANDOVER_COVER_MS + 1_000, pictureExpired: phase === "connecting" },
        ]);
        s.end(by);
        s.sdkFrame();
        expect(views.map((v) => v.status), `${by} while ${phase}: a second end changes nothing`).toEqual(
          phase === "covering" ? ["covering", "over"] : ["covering", "connecting", "over"],
        );
        expect(vi.getTimerCount(), "no timer left behind").toBe(0);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 ends x 2 phases").toBe(8);
  });

  it("the words have a hard ceiling too (a frame proof that never fires cannot pin a false 'Connecting…'): one tick before still there, at it over by 'ceiling'", () => {
    expect(HANDOVER_CEILING_MS, "longer than the room's own poll budget (about 20 s)").toBeGreaterThan(20_000);
    expect(HANDOVER_CEILING_MS).toBe(60_000);
    const { s, ends } = harness();
    s.begin(canvas());
    vi.advanceTimersByTime(HANDOVER_CEILING_MS - 1);
    expect(s.view()).toEqual({ status: "connecting", frame: null });
    vi.advanceTimersByTime(1);
    expect(s.view()).toEqual({ status: "over", frame: null, by: "ceiling" });
    expect(ends).toEqual([{ by: "ceiling", ms: HANDOVER_CEILING_MS, pictureExpired: true }]);
    expect(vi.getTimerCount()).toBe(0);
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
    expect(s.view().status, "its own bound: the picture goes, the words stay").toBe("connecting");
  });

  it("beginning again while still covering restarts the bound rather than stacking two timers", () => {
    const { s } = harness();
    s.begin(canvas("one"));
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 10);
    const second = canvas("two");
    s.begin(second);
    expect(vi.getTimerCount(), "the picture's bound and the ceiling: two, never four").toBe(2);
    vi.advanceTimersByTime(HANDOVER_COVER_MS - 1);
    expect(s.view()).toEqual({ status: "covering", frame: second });
  });

  it("disposing mid-cover — or mid-connecting — leaves no timer and emits nothing further, no end event (the room unmounted)", () => {
    for (const waited of [0, HANDOVER_COVER_MS + 1]) {
      const { s, views, ends } = harness();
      s.begin(canvas());
      vi.advanceTimersByTime(waited);
      s.dispose();
      expect(vi.getTimerCount(), `after ${waited} ms`).toBe(0);
      vi.advanceTimersByTime(HANDOVER_CEILING_MS * 2);
      expect(views.map((v) => v.status)).toEqual(waited === 0 ? ["covering"] : ["covering", "connecting"]);
      expect(ends).toEqual([]);
    }
  });
});

describe("the end's breadcrumb (D23-fix m4) — the stg measurement of whether eight seconds is right", () => {
  it("is named, carries only the enumerated way it ended, the milliseconds and whether the picture had already gone — no identifying data", () => {
    const e: HandoverEndEvent = { by: "sdk", ms: 9_321.7, pictureExpired: true };
    const b = handoverBreadcrumb(e);
    expect(b.category).toBe("chess.camera.handover");
    expect(b.data, "exactly these keys: nothing of the player, the fixture or the camera").toEqual({ by: "sdk", ms: 9_322, pictureExpired: true });
    expect(Object.keys(b).sort(), "no free text beyond a fixed message").toEqual(["category", "data", "level", "message"]);
    expect(b.message).toBe("camera handover ended");
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
