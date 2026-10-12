// T14 — the player's own camera, every transition (rule 1): a second start,
// a join that fails, a camera that drops and comes back, a stop before the
// join lands. The RealtimeKit join is the injected seam; the real one is the
// e2e's (with camera policy off the room never loads it — asserted there).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { cameraSession, RECOVER_BACKOFF_MS, RECOVER_MAX_ATTEMPTS, STAMP_RETRY_MS, type CameraView } from "../camera-session";
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
  // Each back-off wait is a real macrotask (of zero length), so a re-join
  // loop that never ends can never starve the test's own timers: a defect
  // here FAILS, it does not hang.
  const instant = { sleep: () => new Promise<void>((res) => setTimeout(res, 0)) };
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((res) => setTimeout(res, 0));
  };

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
    await flush();
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
    const s = cameraSession(j.join, r.emit, {
      stamp: st.stamp,
      sleep: async (ms) => {
        waits.push(ms);
        await new Promise((res) => setTimeout(res, 0));
      },
    });
    await s.start("t");
    first.fault();
    for (let i = 0; i < 20 && r.views.at(-1)?.status !== "live"; i += 1) await flush();
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
    await flush();
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
    await flush();
    expect(n, "premise: the re-join is in flight").toBe(2);
    await s.stop();
    expect(st.seen, "the page is gone: our interval ends with it").toEqual(["start", "end"]);
    release(late.cam);
    await flush();
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
    await flush();
    b.fault();
    await flush();
    expect(st.seen).toEqual(["start", "end", "start", "end"]);
    a.fault(); // its listener was released; nothing may happen
    await flush();
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
    await flush();
    expect(j.tokens).toEqual(["seat-1", "seat-2"]);
    expect(r.statuses()).toEqual(["joining", "live", "recovering", "live"]);
  });
});

// T14 fix round 5, ruling 2: a re-join that keeps failing — for ANY reason,
// not only our guard's — stops after RECOVER_MAX_ATTEMPTS and says so, never
// "reconnecting" for ever. The open stamp closes with the give-up, so the gap
// still counts toward ruling 1's neutral flag. The way back is a reload.
describe("cameraSession — giving up: fail → retry × N → give-up → reload → recover (fix round 5)", () => {
  function joins(...outcomes: (OwnCamera | Error)[]) {
    let n = 0;
    const join = async () => {
      n += 1;
      const next = outcomes.shift();
      if (next === undefined) throw new Error("no more joins scripted");
      if (next instanceof Error) throw next;
      return next;
    };
    return { join, count: () => n };
  }
  function stamps() {
    const seen: ("start" | "end")[] = [];
    return { seen, stamp: async (state: "start" | "end") => void seen.push(state) };
  }
  const flush = async (n = 5) => {
    for (let i = 0; i < n; i += 1) await new Promise((res) => setTimeout(res, 0));
  };
  /** The wait before re-join attempt i, on the declared ladder. */
  const waitBefore = (i: number) => RECOVER_BACKOFF_MS[Math.min(i, RECOVER_BACKOFF_MS.length - 1)]!;
  const failure = (i: number) => (i % 2 === 0 ? new Error("network: join timed out") : new D7GuardError(new Error("cap")));

  it("the give-up comes after roughly 60–90 s of back-off — the ruled band, from the declared ladder and attempt count", () => {
    const total = Array.from({ length: RECOVER_MAX_ATTEMPTS }, (_, i): number => waitBefore(i)).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(60_000);
    expect(total).toBeLessThanOrEqual(90_000);
  });

  it("N attempts that all fail (network AND our guard's): recovering throughout, then gave_up — never off or failed; ONE interval, left OPEN by the give-up (fix round 6, I-2); nothing more by itself", async () => {
    const r = record();
    const first = fakeCamera(TRACK);
    const j = joins(first.cam, ...Array.from({ length: RECOVER_MAX_ATTEMPTS + 3 }, (_, i) => failure(i)));
    const waits: number[] = [];
    const st = stamps();
    const s = cameraSession(j.join, r.emit, {
      stamp: st.stamp,
      sleep: async (ms) => {
        waits.push(ms);
        await new Promise((res) => setTimeout(res, 0));
      },
    });
    await s.start("t");
    first.fault();
    for (let i = 0; i < 4 * RECOVER_MAX_ATTEMPTS && r.views.at(-1)?.status === "recovering"; i += 1) await flush(1);
    expect(r.statuses()).toEqual(["joining", "live", "recovering", "gave_up"]);
    expect(r.views.at(-1)).toEqual({ status: "gave_up", track: null });
    expect(j.count(), "the first join, then exactly N re-joins").toBe(1 + RECOVER_MAX_ATTEMPTS);
    expect(waits).toEqual(Array.from({ length: RECOVER_MAX_ATTEMPTS }, (_, i) => waitBefore(i)));
    // I-2: the reload the player is told to make is OUR gap too — the
    // window stays open, and the reload's re-seat closes it on the server.
    expect(st.seen, "the give-up leaves our window open").toEqual(["start"]);
    await flush(20);
    expect(j.count(), "given up: no join by itself").toBe(1 + RECOVER_MAX_ATTEMPTS);
    await s.enable();
    await s.stop();
    expect(st.seen, "a stop after the give-up leaves it open too: the re-seat is the closer").toEqual(["start"]);
    expect(r.statuses().at(-1)).toBe("gave_up");
  });

  it("after the give-up, a NEW start (the next seat's token) joins a fresh camera — live, and the open window closes", async () => {
    const r = record();
    const first = fakeCamera(TRACK);
    const second = fakeCamera(TRACK);
    const j = joins(first.cam, ...Array.from({ length: RECOVER_MAX_ATTEMPTS }, (_, i) => failure(i)), second.cam);
    const st = stamps();
    const s = cameraSession(j.join, r.emit, { stamp: st.stamp, sleep: () => new Promise<void>((res) => setTimeout(res, 0)) });
    await s.start("t");
    first.fault();
    for (let i = 0; i < 4 * RECOVER_MAX_ATTEMPTS && r.views.at(-1)?.status === "recovering"; i += 1) await flush(1);
    expect(r.statuses().at(-1), "premise: given up").toBe("gave_up");
    expect(st.seen, "premise: open").toEqual(["start"]);
    await s.start("t2");
    expect(r.statuses().slice(-2)).toEqual(["joining", "live"]);
    expect(j.count()).toBe(1 + RECOVER_MAX_ATTEMPTS + 1);
    expect(st.seen, "back: closed").toEqual(["start", "end"]);
    // Back from the give-up, a stop closes as any stop does: a fresh fault,
    // then the page goes while recovering ⇒ that second window is closed.
    second.fault();
    await flush(1); // the queue: the new start is sent once the end has landed (M-3)
    expect(st.seen, "premise: a second window").toEqual(["start", "end", "start"]);
    await s.stop();
    expect(st.seen, "no longer given up: the stop closes it").toEqual(["start", "end", "start", "end"]);
  });

  it("…then the reload: a fresh page's session joins and is live, nothing of ours left open", async () => {
    const r = record();
    const st = stamps();
    const reloaded = cameraSession(joins(fakeCamera(TRACK).cam).join, r.emit, { stamp: st.stamp });
    await reloaded.start("t");
    expect(r.statuses()).toEqual(["joining", "live"]);
    expect(st.seen).toEqual([]);
  });

  it("property: any run of failures then (maybe) a success — live at the first success inside N, else gave_up after exactly N; one interval either way; never off or failed", async () => {
    const seen = { recovered: 0, gaveUp: 0, lastChance: 0, firstMiss: 0 };
    await fc.assert(
      fc.asyncProperty(
        // Where the first good join lands (≥ N ⇒ never inside the budget),
        // weighted onto the two edges, and each failure's kind.
        fc.oneof(fc.constantFrom(RECOVER_MAX_ATTEMPTS - 1, RECOVER_MAX_ATTEMPTS), fc.integer({ min: 0, max: RECOVER_MAX_ATTEMPTS + 2 })),
        fc.array(fc.boolean(), { minLength: RECOVER_MAX_ATTEMPTS + 3, maxLength: RECOVER_MAX_ATTEMPTS + 3 }),
        async (okAt, d7) => {
          const r = record();
          const st = stamps();
          const first = fakeCamera(TRACK);
          const outcomes: (OwnCamera | Error)[] = Array.from({ length: RECOVER_MAX_ATTEMPTS + 3 }, (_, i) =>
            i === okAt ? fakeCamera(TRACK).cam : d7[i] ? new D7GuardError(new Error("cap")) : new Error("network"),
          );
          const j = joins(first.cam, ...outcomes);
          const s = cameraSession(j.join, r.emit, { stamp: st.stamp, sleep: () => new Promise<void>((res) => setTimeout(res, 0)) });
          await s.start("t");
          first.fault();
          for (let i = 0; i < 4 * RECOVER_MAX_ATTEMPTS && r.views.at(-1)?.status === "recovering"; i += 1) await flush(1);
          const statuses = r.statuses();
          expect(statuses.filter((x) => x === "off" || x === "failed"), "never the player's").toEqual([]);
          if (okAt < RECOVER_MAX_ATTEMPTS) {
            expect(st.seen, "one interval, closed by the return").toEqual(["start", "end"]);
            expect(statuses).toEqual(["joining", "live", "recovering", "live"]);
            expect(j.count()).toBe(1 + okAt + 1);
            seen.recovered += 1;
            if (okAt === RECOVER_MAX_ATTEMPTS - 1) seen.lastChance += 1;
          } else {
            expect(statuses).toEqual(["joining", "live", "recovering", "gave_up"]);
            expect(j.count()).toBe(1 + RECOVER_MAX_ATTEMPTS);
            expect(st.seen, "one interval, left open for the re-seat (I-2)").toEqual(["start"]);
            seen.gaveUp += 1;
            if (okAt === RECOVER_MAX_ATTEMPTS) seen.firstMiss += 1;
          }
          await s.stop();
        },
      ),
      { numRuns: 60 },
    );
    // Anti-vacuity: both outcomes, and both edges of the budget, were reached.
    expect(seen.recovered + seen.gaveUp).toBe(60);
    expect(seen.recovered).toBeGreaterThan(0);
    expect(seen.gaveUp).toBeGreaterThan(0);
    expect(seen.lastChance, "a success on the LAST attempt is live").toBeGreaterThan(0);
    expect(seen.firstMiss, "a success one attempt too late is a give-up").toBeGreaterThan(0);
  });
});

// T14 fix round 6, M-3: a stamp request that fails (the session's stamp
// rejects — the shell maps a network error or a 5xx to a rejection) is sent
// again on STAMP_RETRY_MS, bounded, through ONE serial queue: a start's retry
// never lands after its end. A resolve (a 2xx, or a final 4xx) is delivered.
describe("cameraSession — stamp delivery: retried on the declared ladder, serial (M-3)", () => {
  const record = () => {
    const views: CameraView[] = [];
    return { views, emit: (v: CameraView) => void views.push(v), statuses: () => views.map((v) => v.status) };
  };
  const flush = async (n = 5) => {
    for (let i = 0; i < n; i += 1) await new Promise((res) => setTimeout(res, 0));
  };
  /** A stamp that fails `fail[state]` times, then lands; every call recorded. */
  function flakyStamp(fail: { start: number; end: number }) {
    const calls: ("start" | "end")[] = [];
    const left = { ...fail };
    return {
      calls,
      stamp: async (state: "start" | "end") => {
        calls.push(state);
        if (left[state] > 0) {
          left[state] -= 1;
          throw new Error("network");
        }
      },
    };
  }
  /** A camera that faults, then a re-join that holds at once. */
  async function faultAndRecover(stamp: (s: "start" | "end") => Promise<void>, sleep: (ms: number) => Promise<void>) {
    const r = record();
    const first = fakeCamera(TRACK);
    let n = 0;
    const join = async () => (n++ === 0 ? first.cam : fakeCamera(TRACK).cam);
    const s = cameraSession(join, r.emit, { stamp, sleep });
    await s.start("t");
    first.fault();
    return { r, s };
  }
  const stampWaits = (waits: number[]) => waits.filter((ms) => ms !== RECOVER_BACKOFF_MS[0]);

  it("premise: the ladder is bounded, every wait is real, and none collides with the re-join's first (at once) wait", () => {
    expect(STAMP_RETRY_MS.length).toBeGreaterThan(0);
    for (const ms of STAMP_RETRY_MS) expect(ms).toBeGreaterThan(0);
    expect(STAMP_RETRY_MS).not.toContain(RECOVER_BACKOFF_MS[0]);
  });

  it("rejects twice, then lands ⇒ three calls, the first two waits of the ladder; the end follows, once", async () => {
    const st = flakyStamp({ start: 2, end: 0 });
    const waits: number[] = [];
    const { r, s } = await faultAndRecover(st.stamp, async (ms) => {
      waits.push(ms);
      await new Promise((res) => setTimeout(res, 0));
    });
    await flush(20);
    expect(r.statuses().at(-1), "premise: back").toBe("live");
    expect(st.calls).toEqual(["start", "start", "start", "end"]);
    expect(stampWaits(waits)).toEqual([STAMP_RETRY_MS[0], STAMP_RETRY_MS[1]]);
    await s.stop();
  });

  it("always failing ⇒ BOUNDED: 1 + the ladder's length attempts, the whole ladder once, then dropped; the end has its own budget; nothing more after", async () => {
    const st = flakyStamp({ start: Infinity, end: Infinity });
    const waits: number[] = [];
    const { s } = await faultAndRecover(st.stamp, async (ms) => {
      waits.push(ms);
      await new Promise((res) => setTimeout(res, 0));
    });
    await flush(40);
    const each = 1 + STAMP_RETRY_MS.length;
    expect(st.calls).toEqual([...Array<"start">(each).fill("start"), ...Array<"end">(each).fill("end")]);
    expect(stampWaits(waits)).toEqual([...STAMP_RETRY_MS, ...STAMP_RETRY_MS]);
    await flush(40);
    expect(st.calls, "dropped: no more").toHaveLength(2 * each);
    await s.stop();
  });

  it("SERIAL: the end waits behind the start's pending retry — start before end, even when the camera is back first", async () => {
    const st = flakyStamp({ start: 1, end: 0 });
    const held: { ms: number; go: () => void }[] = [];
    const { r, s } = await faultAndRecover(st.stamp, (ms) => new Promise<void>((go) => held.push({ ms, go })));
    await flush(5);
    const rejoinWait = held.find((h) => h.ms === RECOVER_BACKOFF_MS[0]);
    const retryWait = held.find((h) => h.ms === STAMP_RETRY_MS[0]);
    expect(rejoinWait && retryWait, "premise: both waits pending").toBeTruthy();
    rejoinWait!.go();
    await flush(5);
    expect(r.statuses().at(-1), "premise: the camera is back").toBe("live");
    expect(st.calls, "the end is queued behind the start's retry").toEqual(["start"]);
    retryWait!.go();
    await flush(5);
    expect(st.calls).toEqual(["start", "start", "end"]);
    await s.stop();
  });

  it("property: any failures on the start and the end — each sent min(k+1, 1+ladder) times, every start before every end, the waits the ladder's prefix", async () => {
    const L = STAMP_RETRY_MS.length;
    const seen = { startRetried: 0, startDropped: 0, lastChance: 0, firstDrop: 0, endRetried: 0, clean: 0 };
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constantFrom(L, L + 1), fc.integer({ min: 0, max: L + 2 })),
        fc.oneof(fc.constantFrom(0, L), fc.integer({ min: 0, max: L + 2 })),
        async (k1, k2) => {
          const st = flakyStamp({ start: k1, end: k2 });
          const waits: number[] = [];
          const { s } = await faultAndRecover(st.stamp, async (ms) => {
            waits.push(ms);
            await new Promise((res) => setTimeout(res, 0));
          });
          const n1 = Math.min(k1 + 1, 1 + L);
          const n2 = Math.min(k2 + 1, 1 + L);
          for (let i = 0; i < 200 && st.calls.length < n1 + n2; i += 1) await flush(1);
          await flush(10);
          expect(st.calls).toEqual([...Array<"start">(n1).fill("start"), ...Array<"end">(n2).fill("end")]);
          expect(stampWaits(waits)).toEqual([...STAMP_RETRY_MS.slice(0, n1 - 1), ...STAMP_RETRY_MS.slice(0, n2 - 1)]);
          if (k1 === 0 && k2 === 0) seen.clean += 1;
          if (k1 > 0 && k1 <= L) seen.startRetried += 1;
          if (k1 > L) seen.startDropped += 1;
          if (k1 === L) seen.lastChance += 1;
          if (k1 === L + 1) seen.firstDrop += 1;
          if (k2 > 0) seen.endRetried += 1;
          await s.stop();
        },
      ),
      { numRuns: 60 },
    );
    expect(seen.startRetried, "a start delivered after retries").toBeGreaterThan(0);
    expect(seen.startDropped, "a start dropped past the ladder").toBeGreaterThan(0);
    expect(seen.lastChance, "delivered on the LAST retry").toBeGreaterThan(0);
    expect(seen.firstDrop, "one failure too many: dropped").toBeGreaterThan(0);
    expect(seen.endRetried, "an end retried").toBeGreaterThan(0);
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
