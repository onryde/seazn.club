// YouTube Connect B6 batch round 2 (C4, review m5): the daily pass's port wrapper `gated`. It used to wrap a fixed list of five methods, so
// any other port method skipped the slice (and ran with the wrapper as `this`); it is now a Proxy that gates EVERY port member but `revoke`
// (the dead grants' Google revoke has its own allowance). No database: the port is a stub that records each call.
//
// Expected values are the contract's, not the code's: the member list below is typed against the PORT INTERFACE (`satisfies Record<...>`),
// so a method added to `YouTubePort` fails tsc here until someone decides whether the pass's slice gates it - the sweeps below then cover it.
import { describe, expect, it } from "vitest";
import { gated } from "../daily";
import { BudgetSpent } from "../end-step";
import type { YouTubePort } from "../port";

/** Every callable member of the port. */
const METHODS = {
  authorizeUrl: 1, exchangeCode: 1, accessToken: 1, listMyChannels: 1, liveEnabled: 1, insertStream: 1, deleteStream: 1,
  insertBroadcast: 1, bind: 1, broadcastLife: 1, complete: 1, deleteBroadcast: 1, existingVideos: 1, revoke: 1,
} satisfies Record<Exclude<keyof YouTubePort, "mode">, 1>;
const NAMES = Object.keys(METHODS);
const UNGATED = ["revoke"];

interface Call { method: string; self: unknown; args: unknown[] }
/** A port whose every method records its call (with the `this` it ran under) and answers `<method>-result`. */
function stubPort(extra: string[] = []) {
  const calls: Call[] = [];
  const stub: Record<string, unknown> = { mode: "fake" };
  for (const m of [...NAMES, ...extra]) {
    stub[m] = function (this: unknown, ...args: unknown[]) {
      calls.push({ method: m, self: this, args });
      return `${m}-result`;
    };
  }
  return { stub, port: stub as unknown as YouTubePort, calls };
}
const asRecord = (p: YouTubePort) => p as unknown as Record<string, (...a: unknown[]) => unknown>;
/** What a caller sees from `await port.m(...)`: the value, or the error it threw (synchronously or as a rejection). */
async function attempt(run: () => unknown): Promise<unknown> {
  try {
    return await run();
  } catch (err) {
    return err;
  }
}

describe("the daily pass's gated port (B6 round 2 C4)", () => {
  it("anti-vacuity: the sweeps below judge every port method (14 of them), one of them ungated", () => {
    expect(NAMES.length).toBe(14);
    expect(NAMES.filter((m) => !UNGATED.includes(m)).length).toBe(13);
  });

  it("a slice with NO room refuses every port method but revoke, calling none of them - listed in the wrapper or not", async () => {
    const { port, calls } = stubPort();
    const g = asRecord(gated(port, () => false));
    let refused = 0;
    for (const m of NAMES.filter((n) => !UNGATED.includes(n))) {
      const out = await attempt(() => g[m]!("arg"));
      expect(out, `${m} refused with BudgetSpent`).toBeInstanceOf(BudgetSpent);
      refused++;
    }
    expect(refused, "anti-vacuity: every gated method was tried").toBe(NAMES.length - UNGATED.length);
    expect(calls, "and not one reached the port").toEqual([]);
  });

  it("a method the wrapper has never heard of is gated too: a member added to the port tomorrow cannot skip the slice", async () => {
    const { port, calls } = stubPort(["someMethodAddedTomorrow"]);
    const spent = asRecord(gated(port, () => false));
    expect(await attempt(() => spent.someMethodAddedTomorrow!())).toBeInstanceOf(BudgetSpent);
    expect(calls).toEqual([]);
    const roomy = asRecord(gated(port, () => true));
    expect(await attempt(() => roomy.someMethodAddedTomorrow!("x"))).toBe("someMethodAddedTomorrow-result");
    expect(calls.map((c) => c.method), "with room it is called").toEqual(["someMethodAddedTomorrow"]);
  });

  it("with room every method reaches the ORIGINAL port, under it as `this`, with its arguments, and returns its answer", async () => {
    const { stub, port, calls } = stubPort();
    const g = asRecord(gated(port, () => true));
    for (const m of NAMES) expect(await attempt(() => g[m]!(`${m}-a`, 2)), m).toBe(`${m}-result`);
    expect(calls.map((c) => c.method), "every method was called, once, in order").toEqual(NAMES);
    expect(calls.every((c) => c.self === stub), "each ran with the original port as `this`, never the wrapper").toBe(true);
    expect(calls.map((c) => c.args)).toEqual(NAMES.map((m) => [`${m}-a`, 2]));
  });

  it("revoke is NOT gated: with no room at all it is still called, once, on the original port (its own allowance bounds it, in daily.ts)", async () => {
    const { stub, port, calls } = stubPort();
    const g = asRecord(gated(port, () => false));
    expect(await attempt(() => g.revoke!("token"))).toBe("revoke-result");
    expect(calls).toEqual([{ method: "revoke", self: stub, args: ["token"] }]);
  });

  it("the room is asked at EVERY call, not once when the wrapper is made: a slice that runs out between two calls refuses the second", async () => {
    const { port, calls } = stubPort();
    let room = true;
    const g = asRecord(gated(port, () => room));
    expect(await attempt(() => g.accessToken!("t"))).toBe("accessToken-result");
    room = false;
    expect(await attempt(() => g.accessToken!("t"))).toBeInstanceOf(BudgetSpent);
    room = true;
    expect(await attempt(() => g.accessToken!("t")), "and with time again, it is called again").toBe("accessToken-result");
    expect(calls.length).toBe(2);
  });

  it("a member that is not a method passes through (the port's `mode`)", () => {
    const { port } = stubPort();
    expect(gated(port, () => false).mode).toBe("fake");
  });
});
