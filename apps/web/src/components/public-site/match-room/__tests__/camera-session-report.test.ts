// D16 (§5.6.3) - the camera's report to the server, for the OPPONENT's pill. Each player is in a meeting of their own, so
// the opponent's browser cannot see this camera; it hears about it from here, through ONE serial queue of the stamp
// queue's shape (camera-session.ts, "Delivering a stamp"): a change on every transition, a heartbeat every
// CAMERA_REPORT_HEARTBEAT_MS in BOTH states, a lost change resent as a change after a wait and then dropped.
import { describe, expect, it } from "vitest";
import { cameraSession, CAMERA_REPORT_RETRY_MS, RECOVER_MAX_ATTEMPTS, type CameraStatus, type CameraView } from "../camera-session";
import { CAMERA_REPORT_HEARTBEAT_MS } from "../room-snapshot";
import { D7GuardError, type OwnCamera } from "../camera-loader";

const TRACK = { id: "local-video" } as unknown as MediaStreamTrack;

type Report = { state: "live" | "off"; heartbeat: boolean };

function fakeCamera() {
  let onChange: ((enabled: boolean, track: MediaStreamTrack | null) => void) | null = null;
  let onFault: (() => void) | null = null;
  const cam: OwnCamera = {
    link: () => null,
    onLinkChange: () => () => {},
    track: () => TRACK,
    onChange(cb) {
      onChange = cb;
      return () => void (onChange = null);
    },
    async enable() {},
    async leave() {},
    onFault(cb) {
      onFault = cb;
      return () => void (onFault = null);
    },
  };
  return { cam, set: (enabled: boolean) => onChange?.(enabled, enabled ? TRACK : null), fault: () => onFault?.() };
}

/** A manual heartbeat clock: `tick()` fires every registered interval once; `live()` is how many are still registered. */
function fakeTicker() {
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let next = 1;
  return {
    every: (cb: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { cb, ms });
      return () => void timers.delete(id);
    },
    tick: () => {
      for (const t of [...timers.values()]) t.cb();
    },
    live: () => timers.size,
    periods: () => [...timers.values()].map((t) => t.ms),
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function rig(opts: { report?: (r: Report) => Promise<unknown> | void; sleeps?: number[]; rejoin?: "hangs" } = {}) {
  const sent: Report[] = [];
  const views: CameraView[] = [];
  const ticker = fakeTicker();
  const cam = fakeCamera();
  const sleeps = opts.sleeps ?? [];
  let joins = 0;
  // `rejoin: "hangs"` - the first join lands, any later one (our guard's re-join) never does, so `recovering` can be held.
  const join = async () => {
    joins += 1;
    if (opts.rejoin === "hangs" && joins > 1) return new Promise<OwnCamera>(() => {});
    return cam.cam;
  };
  const s = cameraSession(join, (v) => views.push(v), {
    report: (state, heartbeat) => {
      const r = { state, heartbeat };
      sent.push(r);
      return opts.report?.(r);
    },
    heartbeatEvery: ticker.every,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { s, sent, views, ticker, cam, sleeps };
}

describe("the camera report: what each CameraStatus sends", () => {
  // The spec's own map (§5.6.3). `null` is "sends nothing": a transition, and `recovering` is OUR guard's re-join, which is
  // never the player's "off".
  const MAP = {
    live: "live",
    off: "off",
    failed: "off",
    gave_up: "off",
    joining: null,
    recovering: null,
    idle: null,
  } as const satisfies Record<CameraStatus, "live" | "off" | null>;

  /** Drives a session to `status` and returns what it sent on arriving there (nothing sent before it counts). */
  async function arriveAt(status: CameraStatus): Promise<Report[]> {
    const r = rig();
    switch (status) {
      case "idle":
        break; // never started
      case "joining": {
        const stuck = cameraSession(() => new Promise<OwnCamera>(() => {}), () => {}, {
          report: (state, heartbeat) => void r.sent.push({ state, heartbeat }),
          heartbeatEvery: r.ticker.every,
        });
        void stuck.start("t");
        await flush();
        break;
      }
      case "live":
        await r.s.start("t");
        break;
      case "off":
        await r.s.start("t");
        r.sent.length = 0;
        r.cam.set(false);
        break;
      case "failed": {
        const failing = cameraSession(async () => Promise.reject(new Error("denied")), () => {}, {
          report: (state, heartbeat) => void r.sent.push({ state, heartbeat }),
          heartbeatEvery: r.ticker.every,
        });
        await failing.start("t");
        break;
      }
      case "recovering": {
        const held = rig({ rejoin: "hangs" });
        await held.s.start("t");
        await flush();
        held.sent.length = 0;
        held.cam.fault();
        await flush();
        expect(held.views.at(-1)?.status, "premise: held in recovering").toBe("recovering");
        return held.sent;
      }
      case "gave_up": {
        const guard = cameraSession(async () => Promise.reject(new D7GuardError("cannot refuse")), () => {}, {
          report: (state, heartbeat) => void r.sent.push({ state, heartbeat }),
          heartbeatEvery: r.ticker.every,
          sleep: async () => {},
        });
        await guard.start("t");
        for (let i = 0; i < RECOVER_MAX_ATTEMPTS + 2; i += 1) await flush();
        break;
      }
    }
    await flush();
    return r.sent;
  }

  it("sends live for live, off for off, failed and gave_up, and NOTHING for joining, recovering and idle - all seven, counted", async () => {
    let checked = 0;
    const sentOff: string[] = [];
    for (const status of Object.keys(MAP) as CameraStatus[]) {
      const got = await arriveAt(status);
      const want = MAP[status];
      if (want === null) expect(got, `${status} sends nothing`).toEqual([]);
      else {
        expect(got.at(-1), `${status} sends ${want}`).toEqual({ state: want, heartbeat: false });
        if (want === "off") sentOff.push(status);
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: every CameraStatus value").toBe(7);
    expect(sentOff.sort(), "the three off-like statuses all reported off").toEqual(["failed", "gave_up", "off"]);
  });
});

describe("the camera report: change, then heartbeat", () => {
  it("a state is sent as a CHANGE until the server acknowledges it, and as a HEARTBEAT after - in both states", async () => {
    const r = rig();
    await r.s.start("t");
    await flush();
    expect(r.sent, "live joined: a change").toEqual([{ state: "live", heartbeat: false }]);
    r.ticker.tick();
    await flush();
    expect(r.sent.at(-1), "acknowledged, so the next beat is a heartbeat").toEqual({ state: "live", heartbeat: true });
    r.cam.set(false);
    await flush();
    expect(r.sent.at(-1), "the camera went off: a change").toEqual({ state: "off", heartbeat: false });
    r.ticker.tick();
    await flush();
    expect(r.sent.at(-1), "off, acknowledged, stays fresh by heartbeat too").toEqual({ state: "off", heartbeat: true });
    r.cam.set(true);
    await flush();
    expect(r.sent.at(-1), "back on: a change again").toEqual({ state: "live", heartbeat: false });
    expect(r.sent.length).toBe(5);
  });

  it("the heartbeat runs at CAMERA_REPORT_HEARTBEAT_MS, starts with the first state, and stops with the session", async () => {
    const r = rig();
    expect(r.ticker.live(), "nothing to repeat before there is a state").toBe(0);
    await r.s.start("t");
    expect(r.ticker.periods()).toEqual([CAMERA_REPORT_HEARTBEAT_MS]);
    await r.s.stop();
    expect(r.ticker.live(), "stopped: no timer left running").toBe(0);
    const before = r.sent.length;
    r.ticker.tick();
    await flush();
    expect(r.sent.length, "and a tick after stop sends nothing").toBe(before);
  });

  it("a tick while the camera is between states (joining, recovering) sends nothing", async () => {
    const r = rig({ rejoin: "hangs" });
    await r.s.start("t");
    await flush();
    r.cam.fault(); // recovering, and held there
    await flush();
    const before = r.sent.length;
    r.ticker.tick();
    await flush();
    expect(r.views.at(-1)?.status, "premise: recovering").toBe("recovering");
    expect(r.sent.length).toBe(before);
  });
});

describe("the camera report: delivery", () => {
  it("a change the server did not take is sent AGAIN as a change after the wait, then dropped; the next beat is still a change", async () => {
    const r = rig({ report: () => Promise.reject(new Error("503")) });
    await r.s.start("t");
    await flush();
    expect(r.sent.length, "1 + one resend per wait").toBe(1 + CAMERA_REPORT_RETRY_MS.length);
    expect(r.sent.every((x) => x.heartbeat === false && x.state === "live"), "every attempt is a change").toBe(true);
    expect(r.sleeps, "waited between attempts").toEqual([...CAMERA_REPORT_RETRY_MS]);
    r.ticker.tick();
    await flush();
    expect(r.sent.at(-1), "never acknowledged, so the tick is still a change - not a heartbeat that would be ignored").toEqual({ state: "live", heartbeat: false });
  });

  it("a lost HEARTBEAT is dropped, not retried: the next one is 30 s away", async () => {
    let fail = false;
    const r = rig({ report: () => (fail ? Promise.reject(new Error("429")) : undefined) });
    await r.s.start("t");
    await flush();
    fail = true;
    r.ticker.tick();
    await flush();
    expect(r.sent.at(-1)).toEqual({ state: "live", heartbeat: true });
    expect(r.sent.length, "one attempt, no resend").toBe(2);
    expect(r.sleeps, "and no wait").toEqual([]);
    fail = false;
    r.ticker.tick();
    await flush();
    expect(r.sent.at(-1), "acknowledged earlier, still a heartbeat").toEqual({ state: "live", heartbeat: true });
  });

  it("is one request at a time: a second report waits for the first to settle, and order is kept", async () => {
    const gates: (() => void)[] = [];
    const r = rig({ report: () => new Promise<void>((done) => gates.push(done)) });
    await r.s.start("t");
    await flush();
    expect(r.sent.map((x) => x.state), "the first is out").toEqual(["live"]);
    r.cam.set(false);
    await flush();
    expect(r.sent.length, "the change to off is queued behind it, not sent alongside").toBe(1);
    gates[0]!();
    await flush();
    expect(r.sent.map((x) => x.state)).toEqual(["live", "off"]);
    gates[1]!();
    await flush();
  });

  it("a heartbeat queued behind a change is not sent with the state it was made for once that state is gone", async () => {
    const gates: (() => void)[] = [];
    const r = rig({ report: () => new Promise<void>((done) => gates.push(done)) });
    await r.s.start("t");
    await flush();
    gates[0]!(); // live acknowledged
    await flush();
    r.ticker.tick(); // heartbeat(live) goes out and hangs
    await flush();
    r.ticker.tick(); // a second heartbeat(live) queues behind it
    r.cam.set(false); // ... and the camera goes off before it is sent
    await flush();
    gates[1]!();
    await flush();
    const sentAfter = r.sent.slice(1);
    expect(sentAfter.map((x) => `${x.state}:${x.heartbeat}`), "the queued live heartbeat was dropped; the off change follows the first").toEqual([
      "live:true",
      "off:false",
    ]);
    gates.slice(2).forEach((g) => g());
    await flush();
  });
});
