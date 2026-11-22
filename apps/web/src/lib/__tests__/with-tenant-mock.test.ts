// MD-R29: the shared `withTenant` stand-in runs the privileged prelude, in the real one's order, and the callers that need it (the division
// page's `competitionFixturesToday` through `withRoundOpensToday`) get what they read. The real function's contract is lib/db.ts's; what is
// pinned here is the stand-in's: prelude first, on the SAME transaction object, awaited, then the callback; no prelude, no extra call.
import { describe, expect, it, vi } from "vitest";
import { tenantRunningPrelude } from "./_with-tenant-mock";

describe("tenantRunningPrelude - the stand-in for withTenant", () => {
  it("with no opts (the empty case first) it hands the callback the transaction and returns its result", async () => {
    const tx = { id: "tx" };
    const fn = vi.fn(() => "answer");
    await expect(tenantRunningPrelude(tx, fn)).resolves.toBe("answer");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(tx);
  });

  it("with opts that name no prelude it does the same", async () => {
    const fn = vi.fn(async () => 7);
    await expect(tenantRunningPrelude({}, fn, {})).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs the prelude FIRST, awaited, on the same transaction the callback gets", async () => {
    const tx = { id: "tx" };
    const order: string[] = [];
    let preludeDone = false;
    const prelude = vi.fn(async (t: unknown) => {
      order.push("prelude:start");
      await new Promise((r) => setTimeout(r, 5));
      preludeDone = true;
      order.push("prelude:end");
      expect(t).toBe(tx);
    });
    const fn = vi.fn((t: unknown) => {
      order.push(`fn:${preludeDone ? "after" : "BEFORE"}`);
      expect(t).toBe(tx);
      return 42;
    });
    await expect(tenantRunningPrelude(tx, fn, { privilegedPrelude: prelude })).resolves.toBe(42);
    expect(prelude).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["prelude:start", "prelude:end", "fn:after"]);
  });

  it("a prelude that rejects rejects the call and the callback never runs (the real transaction rolls back)", async () => {
    const fn = vi.fn();
    await expect(
      tenantRunningPrelude({}, fn, {
        privilegedPrelude: async () => {
          throw new Error("sealed read refused");
        },
      }),
    ).rejects.toThrow("sealed read refused");
    expect(fn).not.toHaveBeenCalled();
  });
});
