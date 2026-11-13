// Registration redesign B0 Task 1 — the per-stage server timer the public register route uses to measure a submit (spec
// 2026-11-13-registration-redesign-design.md §3.2). Pure: an injected clock (`now`) drives every duration, so each expected
// number below is the clock arithmetic the test performs, never a value read back from the timer under test.
import { describe, expect, it } from "vitest";
import { createStageTimer, timed } from "../timing";

/** RFC-shaped Server-Timing list as the plan pins it: `name;dur=N` entries, ", "-separated, at most one decimal. */
const SERVER_TIMING_LIST = /^[a-z_.]+;dur=\d+(\.\d)?(, [a-z_.]+;dur=\d+(\.\d)?)*$/;

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

describe("createStageTimer", () => {
  it("header() of an untouched timer is empty string, and its summary is empty", () => {
    const timer = createStageTimer(fakeClock().now);
    expect(timer.header()).toBe("");
    expect(timer.durations()).toEqual({});
  });

  it("sums repeated stages and nests names", async () => {
    let t = 0;
    const timer = createStageTimer(() => t);
    await timer.stage("pre_tx", async () => {
      await timer.stage("settings", async () => {
        t += 5;
      });
      await timer.stage("settings", async () => {
        t += 3;
      });
    });
    expect(timer.durations()).toEqual({ pre_tx: 8, "pre_tx.settings": 8 });
  });

  it("records a stage whose fn throws, then rethrows the same error", async () => {
    const clock = fakeClock();
    const timer = createStageTimer(clock.now);
    const boom = new Error("siteverify down");
    await expect(
      timer.stage("turnstile", async () => {
        clock.advance(12);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(timer.durations()).toEqual({ turnstile: 12 });
  });

  it("returns the stage fn's own value", async () => {
    const timer = createStageTimer(fakeClock().now);
    await expect(timer.stage("user", async () => ({ id: "u1" }))).resolves.toEqual({ id: "u1" });
  });

  it("header() is a valid Server-Timing list, in the order stages were entered", async () => {
    const clock = fakeClock();
    const timer = createStageTimer(clock.now);
    await timer.stage("rate_limit", async () => clock.advance(3.14));
    await timer.stage("pre_tx", async () => {
      await timer.stage("division_ctx", async () => clock.advance(20));
    });
    await timer.stage("tx", async () => clock.advance(100.06));
    const header = timer.header();
    expect(header).toMatch(SERVER_TIMING_LIST);
    expect(header).toBe("rate_limit;dur=3.1, pre_tx;dur=20, pre_tx.division_ctx;dur=20, tx;dur=100.1");
  });

  it("summary() rounds to 0.1 ms but sums the raw durations (two 0.04 stages are 0.1, not 0)", async () => {
    const clock = fakeClock();
    const timer = createStageTimer(clock.now);
    await timer.stage("settings", async () => clock.advance(0.04));
    await timer.stage("settings", async () => clock.advance(0.04));
    expect(timer.durations()).toEqual({ settings: 0.1 });
  });

  // B1 Task 4 runs the pre-transaction reads in parallel: two sibling stages in flight at once must each nest under their
  // PARENT, never under each other (a push/pop stack would name the second `pre_tx.division_ctx.settings`).
  it("concurrent sibling stages nest under their parent, not under each other", async () => {
    const clock = fakeClock();
    const timer = createStageTimer(clock.now);
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    await timer.stage("pre_tx", async () => {
      // division_ctx is entered first and is still open (parked on gateA) for the whole of settings.
      const divisionCtx = timer.stage("division_ctx", async () => {
        await gateA;
        clock.advance(4);
      });
      await timer.stage("settings", async () => clock.advance(6));
      releaseA();
      await divisionCtx;
    });
    expect(Object.keys(timer.durations()).sort()).toEqual(["pre_tx", "pre_tx.division_ctx", "pre_tx.settings"]);
    // division_ctx was open across settings' 6 ms and its own 4: overlapping stages each keep their own wall time.
    expect(timer.durations()).toEqual({ pre_tx: 10, "pre_tx.division_ctx": 10, "pre_tx.settings": 6 });
  });

  it("a stage entered after its parent has finished is top-level again", async () => {
    const clock = fakeClock();
    const timer = createStageTimer(clock.now);
    await timer.stage("pre_tx", async () => {
      await timer.stage("settings", async () => clock.advance(1));
    });
    await timer.stage("settings", async () => clock.advance(2));
    expect(timer.durations()).toEqual({ pre_tx: 1, "pre_tx.settings": 1, settings: 2 });
  });

  it("two timers never share stages, and one timer's stage does not prefix the other's", async () => {
    const clock = fakeClock();
    const outer = createStageTimer(clock.now);
    const inner = createStageTimer(clock.now);
    await outer.stage("mint", async () => {
      await inner.stage("stripe", async () => clock.advance(7));
    });
    expect(outer.durations()).toEqual({ mint: 7 });
    expect(inner.durations()).toEqual({ stripe: 7 });
  });

  it("mark(name) records the time since the timer was created, and a later mark replaces it", async () => {
    const clock = fakeClock();
    clock.advance(1000); // the clock's origin is not the timer's: only time since createStageTimer counts
    const timer = createStageTimer(clock.now);
    await timer.stage("tx", async () => clock.advance(40));
    clock.advance(2);
    timer.mark("total");
    expect(timer.durations()).toEqual({ tx: 40, total: 42 });
    clock.advance(8);
    timer.mark("total");
    expect(timer.durations()).toEqual({ tx: 40, total: 50 });
    expect(timer.header()).toMatch(SERVER_TIMING_LIST);
  });

  // A stage name becomes a Server-Timing metric name and a dotted path segment: anything outside [a-z_] would either break the
  // header's token grammar or forge a nesting level. Refused at the call, before fn runs.
  it.each(["", "Pre_tx", "pre-tx", "pre_tx.settings", "tx ", "dur=1"])("refuses the stage name %j before running fn", async (name) => {
    const timer = createStageTimer(fakeClock().now);
    let ran = false;
    await expect(
      timer.stage(name, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/stage name/);
    expect(ran).toBe(false);
    expect(() => timer.mark(name)).toThrow(/stage name/);
    expect(timer.durations()).toEqual({});
  });

  it("the default clock is real time", async () => {
    const timer = createStageTimer();
    await timer.stage("wait", () => new Promise((r) => setTimeout(r, 25)));
    expect(timer.durations().wait).toBeGreaterThanOrEqual(15);
  });
});

describe("timed", () => {
  it("with no timer, runs fn itself and returns its value", async () => {
    let calls = 0;
    await expect(
      timed(undefined, "settings", async () => {
        calls++;
        return 7;
      }),
    ).resolves.toBe(7);
    expect(calls).toBe(1);
  });

  it("with a timer, records the stage under that timer", async () => {
    const clock = fakeClock();
    const timer = createStageTimer(clock.now);
    await expect(timed(timer, "settings", async () => (clock.advance(9), "ok"))).resolves.toBe("ok");
    expect(timer.durations()).toEqual({ settings: 9 });
  });
});
