import { afterEach, describe, expect, it, vi } from "vitest";

// `after` is wrapped (not replaced) so the two request-scope-less tests below
// keep exercising the REAL next/server after() throwing outside a request
// scope (the actual behavior this helper's fallback branch depends on) — only
// the regression test overrides it, per-call, via mockImplementationOnce.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn(actual.after) };
});

import { after } from "next/server";
import { deferred, flushDeferred } from "@/lib/deferred";
import { log } from "@/server/logger";

describe("deferred", () => {
  it("runs the callback inline when outside a Next request scope", async () => {
    const fn = vi.fn(async () => {});
    deferred(fn);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  });

  // `log` is a module singleton: a spy left in place leaks into later tests.
  let warn: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    warn?.mockRestore();
    warn = undefined;
  });

  it("swallows callback rejections — and logs them through the repo logger", async () => {
    warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(() => deferred(fn)).not.toThrow();
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith({ err: "boom" }, "deferred: a tail task failed"));
  });

  // Task 6 review finding 1 (CRITICAL) / finding 4: `run` used to be
  // non-async and returned undefined, so after(run) hands Next's after()
  // nothing to wait on — the after-window can close (Redis invalidation +
  // revalidateTag racing the response) even though `run` is still mid-flight.
  // Simulates being inside a request scope (after() registers instead of
  // throwing) and proves the registered callback's OWN returned promise
  // tracks fn's completion, not just fn's synchronous kickoff.
  it("hands after() a callback whose promise stays pending until fn settles", async () => {
    let captured: (() => unknown) | undefined;
    vi.mocked(after).mockImplementationOnce((task) => {
      captured = task as () => unknown;
    });

    let flag = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deferred(async () => {
      await gate;
      flag = true;
    });

    expect(captured).toBeTypeOf("function");

    let settled = false;
    const returned = Promise.resolve(captured!()).then(() => {
      settled = true;
    });

    // Drain microtasks AND a macrotask tick without releasing the gate — a
    // non-async `run` (the bug) resolves `captured()` immediately regardless,
    // so this is where the unfixed helper fails.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(flag).toBe(false);

    release();
    await returned;

    expect(settled).toBe(true);
    expect(flag).toBe(true);
  });
});

// Registration redesign B1 T5: the register route queues the cart mail through `deferred`, so it lands AFTER the response. A test that
// reads the outbox right after the route returns must first wait for that tail, and for any tail the tail itself starts (the mail's
// own first attempt is a nested `deferred`). `flushDeferred` is that wait, for tests only.
describe("flushDeferred (tests only)", () => {
  let warn: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    warn?.mockRestore();
    warn = undefined;
  });

  it("the empty case: nothing pending settles nothing, and answers 0", async () => {
    await flushDeferred();
    expect(await flushDeferred()).toBe(0);
  });

  it("waits for a tail AND the tail it starts, then answers how many settled; a second flush finds none", async () => {
    await flushDeferred();
    const done: string[] = [];
    deferred(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      done.push("outer");
      deferred(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        done.push("inner");
      });
    });
    expect(done, "premise: nothing has finished when the flush starts").toEqual([]);
    expect(await flushDeferred()).toBe(2);
    expect(done).toEqual(["outer", "inner"]);
    expect(await flushDeferred(), "the sequence: a second flush has nothing left").toBe(0);
  });

  it("a tail that fails still settles (deferred swallows it), and is counted", async () => {
    await flushDeferred();
    warn = vi.spyOn(log, "warn").mockImplementation(() => undefined as never);
    deferred(async () => {
      throw new Error("tail boom");
    });
    expect(await flushDeferred()).toBe(1);
    expect(warn).toHaveBeenCalledWith({ err: "tail boom" }, "deferred: a tail task failed");
  });

  it("a tail handed to a request scope's after() is not tracked: the request owns it", async () => {
    await flushDeferred();
    let captured: (() => unknown) | undefined;
    vi.mocked(after).mockImplementationOnce((task) => {
      captured = task as () => unknown;
    });
    deferred(async () => {});
    expect(captured, "premise: after() took the task").toBeTypeOf("function");
    expect(await flushDeferred()).toBe(0);
  });

  it("refuses outside vitest, by name", async () => {
    vi.stubEnv("VITEST", "");
    try {
      await expect(flushDeferred()).rejects.toThrow(/flushDeferred is for tests only/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
