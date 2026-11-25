// The package's analytics events (spec 2026-11-23-online-chess-credits-design.md §14; plan Task 13 step 6): one PostHog event per
// package action - `online_chess_package_bought` (a first payment), `_resized` (a later payment: a bigger size, cameras added, a
// move down) and `_refunded` (the full refund the delete doors and the switch-off write) - carrying exactly eight facts:
// size, cameras, credits, monthly, pack, forfeited, plan, at_round_one. This file is the PROPS: what each kind sends, the builders
// that turn the doors' own results into them, and the rule that analytics never throws into the money path. Where the events are
// SENT from (after the commit, never on a no-op) is the DB-backed `events-doors.test.ts`.
//
// Expected values are the spec's: the price table (`GC_PRICE`, the Global Constraints: 16→1/2, 32→2/4, 64→4/8, 128→8/16, 256→16/32
// credits without / with cameras) and the ledger's sign convention (a debit is positive, a return negative), never read back from
// the code under test.
//
// single-sport: Online Chess is boardgame only (online-play.ts `supportsOnlinePlay`).
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ calls: [] as { event: string; distinctId: string; orgId?: string; properties?: Record<string, unknown> }[] }));
const failures = vi.hoisted(() => ({ capture: false, hang: false, plan: false, failFirst: false, attempts: 0, logged: [] as unknown[][] }));

vi.mock("@/lib/posthog-server", () => ({
  captureServer: vi.fn(async (a: { event: string; distinctId: string; orgId?: string; properties?: Record<string, unknown> }) => {
    if (failures.capture) throw new Error("posthog is down");
    if (failures.failFirst && failures.attempts++ === 0) throw new Error("posthog is down for the first send only");
    if (failures.hang) return new Promise<void>(() => undefined); // a flush that never comes back
    sent.calls.push(a);
  }),
}));
vi.mock("@/lib/entitlements", () => ({
  orgPlanKey: vi.fn(async () => {
    if (failures.plan) throw new Error("plan lookup failed");
    return "pro";
  }),
}));
vi.mock("@/server/logger", () => ({ log: { error: (...a: unknown[]) => failures.logged.push(a), warn: (...a: unknown[]) => failures.logged.push(a) } }));

import { EVENTS } from "@/lib/analytics-events";
import { captureServer } from "@/lib/posthog-server";
import { orgPlanKey } from "@/lib/entitlements";
import { ONLINE_SIZES, type OnlineSize } from "@/lib/online-chess-package";
import type { PayResult } from "../pay";
import type { PackageQuote } from "../quote";
import type { PackageRow } from "../types";
import { CAPTURE_TIMEOUT_MS, capturePackageEvent, captureRefundEvents, PACKAGE_EVENT_NAMES, payEvent, refundEvents, type PackageEventFact } from "../events";

const GC_PRICE: Record<OnlineSize, readonly [number, number]> = { 16: [1, 2], 32: [2, 4], 64: [4, 8], 128: [8, 16], 256: [16, 32] };
const price = (size: OnlineSize, cameras: boolean): number => GC_PRICE[size][cameras ? 1 : 0];

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const FACT: PackageEventFact = { orgId: ORG, actorId: USER, size: 64, cameras: true, credits: 8, monthly: 3, pack: 5, forfeited: 0, atRoundOne: false };

/** The eight facts, in the spec's words. */
const PROP_KEYS = ["at_round_one", "cameras", "credits", "forfeited", "monthly", "pack", "plan", "size"];

beforeEach(() => {
  sent.calls.length = 0;
  failures.capture = false;
  failures.hang = false;
  failures.plan = false;
  failures.failFirst = false;
  failures.attempts = 0;
  failures.logged.length = 0;
  vi.mocked(orgPlanKey).mockClear();
  vi.mocked(captureServer).mockClear();
});

/** A package row as the pay door leaves it: only what the builders read. */
const row = (size: OnlineSize, cameras: boolean): PackageRow => ({
  id: "pkg", orgId: ORG, divisionId: "div", divisionName: "Open", size, camerasPaid: cameras, creditsPaid: price(size, cameras),
  creditsRefunded: 0, creditsForfeited: 0, paidAt: new Date(), paidBy: USER, frozenAt: null, refundedAt: null, createdAt: new Date(),
});

/** A pay door's answer for a payment of `owed` credits, the quote the door acted on. */
function paid(a: {
  size: OnlineSize; cameras: boolean; owed: number; take?: { monthly: number; pack: number } | null;
  back?: { pack: number; monthly: number; forfeited: number } | null; applied?: boolean;
}): PayResult {
  const quote = { size: a.size, cameras: a.cameras, owed: a.owed, take: a.take ?? null, back: a.back ?? null, refusal: null } as unknown as PackageQuote;
  return { applied: a.applied ?? true, quote, package: row(a.size, a.cameras), capacityLoweredTo: null };
}
const CTX = { orgId: ORG, actorId: USER, paidBefore: false, atRoundOne: false };

describe("the three events: name and the eight facts", () => {
  it("the names are the spec's, one per kind, each a registered analytics event", () => {
    expect(PACKAGE_EVENT_NAMES).toEqual({
      bought: "online_chess_package_bought",
      resized: "online_chess_package_resized",
      refunded: "online_chess_package_refunded",
    });
    for (const name of Object.values(PACKAGE_EVENT_NAMES)) expect(Object.values(EVENTS), name).toContain(name);
  });

  it("each kind sends its own event with EXACTLY the eight facts, for the actor and the org's group, and nothing else", async () => {
    let checked = 0;
    for (const kind of ["bought", "resized", "refunded"] as const) {
      sent.calls.length = 0;
      await capturePackageEvent(kind, FACT);
      expect(sent.calls, kind).toHaveLength(1);
      const call = sent.calls[0]!;
      expect(call.event, kind).toBe(`online_chess_package_${kind}`);
      expect(call.distinctId, kind).toBe(USER);
      expect(call.orgId, kind).toBe(ORG);
      expect(Object.keys(call.properties!).sort(), `${kind}: the eight facts and no id, name or address`).toEqual(PROP_KEYS);
      expect(call.properties, kind).toEqual({ size: 64, cameras: true, credits: 8, monthly: 3, pack: 5, forfeited: 0, plan: "pro", at_round_one: false });
      checked += 1;
    }
    expect(checked, "anti-vacuity: three kinds").toBe(3);
  });

  it("at_round_one is carried as given, both ways (a mutant that pins it to false is caught)", async () => {
    for (const atRoundOne of [true, false]) {
      sent.calls.length = 0;
      await capturePackageEvent("bought", { ...FACT, atRoundOne });
      expect(sent.calls[0]!.properties!.at_round_one, String(atRoundOne)).toBe(atRoundOne);
    }
  });
});

describe("analytics never throws into the money path", () => {
  it("PostHog failing: the capture swallows it, logs it, and the caller carries on", async () => {
    failures.capture = true;
    await expect(capturePackageEvent("bought", FACT)).resolves.toBeUndefined();
    expect(failures.logged.length, "logged, not silent").toBeGreaterThan(0);
  });

  it("the plan lookup failing: the event is still sent, with the plan unknown, and the failure is logged", async () => {
    failures.plan = true;
    await expect(capturePackageEvent("resized", FACT)).resolves.toBeUndefined();
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0]!.properties!.plan).toBe("unknown");
    expect(failures.logged.length).toBeGreaterThan(0);
  });

  it("a flush that never comes back cannot hold the request: the capture gives up after CAPTURE_TIMEOUT_MS, logs it, and returns", async () => {
    vi.useFakeTimers();
    try {
      failures.hang = true;
      let settled = false;
      const done = capturePackageEvent("bought", FACT).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1);
      expect(settled, "still inside the window: waiting for the flush").toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await done;
      expect(settled, "past the window: the request is let go").toBe(true);
      expect(sent.calls, "nothing was sent, and nothing threw").toHaveLength(0);
      expect(failures.logged.some((l) => /did not come back in time/.test(String(l[1]))), "the give-up is logged").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the refund doors' capture is bounded the same way (a hung flush on a door's first package does not hold the response)", async () => {
    vi.useFakeTimers();
    try {
      failures.hang = true;
      let settled = false;
      const done = captureRefundEvents(
        [{ size: 16, cameras: false, back: { pack: 1, monthly: 0, forfeited: 0 } }],
        { orgId: ORG, actorId: USER },
      ).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS + 1);
      await done;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("captureRefundEvents: one plan lookup per door, one event per package, never a throw", () => {
  const THREE = [
    { size: 16, cameras: false, back: { pack: 1, monthly: 0, forfeited: 0 } },
    { size: 64, cameras: true, back: { pack: 4, monthly: 4, forfeited: 0 } },
    { size: 32, cameras: false, back: { pack: 0, monthly: 2, forfeited: 0 } },
  ] as const;

  it("a hung flush holds a door with k packages for ONE bound, not k: all k sends start together and the door is let go after CAPTURE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      failures.hang = true;
      let settled = false;
      const done = captureRefundEvents(THREE, { orgId: ORG, actorId: USER }).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1);
      expect(vi.mocked(captureServer), "every package's send has started (a sequential door would have started one)").toHaveBeenCalledTimes(THREE.length);
      expect(settled, "inside the bound: still waiting").toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await done;
      expect(settled, "ONE bound later the door is free (sequential: it would wait k x the bound)").toBe(true);
      expect(failures.logged.filter((l) => /did not come back in time/.test(String(l[1]))), "each give-up is logged").toHaveLength(THREE.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one send failing does not stop the others: the other packages' events still go out and the door resolves", async () => {
    failures.failFirst = true;
    await expect(captureRefundEvents(THREE, { orgId: ORG, actorId: USER })).resolves.toBeUndefined();
    expect(vi.mocked(captureServer)).toHaveBeenCalledTimes(THREE.length);
    expect(sent.calls, "the first failed, the other two were sent").toHaveLength(THREE.length - 1);
    expect(failures.logged.some((l) => /the refund stands/.test(String(l[1]))), "the failure is logged").toBe(true);
  });

  it("three refunded packages are three events and ONE plan lookup (not one per package)", async () => {
    await captureRefundEvents(THREE, { orgId: ORG, actorId: USER });
    expect(sent.calls.map((c) => c.event)).toEqual(Array(3).fill("online_chess_package_refunded"));
    expect(sent.calls.map((c) => c.properties!.size), "in the order the door refunded them").toEqual([16, 64, 32]);
    expect(sent.calls.every((c) => c.properties!.plan === "pro")).toBe(true);
    expect(vi.mocked(orgPlanKey), "one lookup for the door").toHaveBeenCalledTimes(1);
  });

  it("a malformed refund entry (the collector is typed, so this is a guard): the door resolves and logs, never throws into the delete", async () => {
    await expect(captureRefundEvents([{ size: 16, cameras: false, back: undefined } as never], { orgId: ORG, actorId: USER })).resolves.toBeUndefined();
    expect(failures.logged.length, "logged").toBe(1);
    expect(sent.calls).toHaveLength(0);
  });

  it("nothing refunded: no event and no plan lookup at all (the empty case)", async () => {
    await captureRefundEvents([], { orgId: ORG, actorId: USER });
    expect(sent.calls).toHaveLength(0);
    expect(vi.mocked(orgPlanKey)).not.toHaveBeenCalled();
  });

  it("PostHog failing on every package: the door resolves, every failure is logged, none is thrown", async () => {
    failures.capture = true;
    await expect(captureRefundEvents(THREE, { orgId: ORG, actorId: USER })).resolves.toBeUndefined();
    expect(failures.logged.length, "one logged failure per package").toBe(3);
  });

  it("the plan lookup failing: all three still go, plan unknown, the lookup tried once", async () => {
    failures.plan = true;
    await captureRefundEvents(THREE, { orgId: ORG, actorId: USER });
    expect(sent.calls).toHaveLength(3);
    expect(sent.calls.every((c) => c.properties!.plan === "unknown")).toBe(true);
    expect(vi.mocked(orgPlanKey)).toHaveBeenCalledTimes(1);
  });
});

describe("payEvent: the pay door's own result, as an event", () => {
  it("a first payment is `bought`: the size, the price, and the split the debit took", () => {
    // 64 without cameras costs 4: drawn 1 from the month's included credits and 3 from the bought pack.
    const e = payEvent(paid({ size: 64, cameras: false, owed: price(64, false), take: { monthly: 1, pack: 3 } }), CTX)!;
    expect(e.kind).toBe("bought");
    expect(e.fact).toEqual({ orgId: ORG, actorId: USER, size: 64, cameras: false, credits: 4, monthly: 1, pack: 3, forfeited: 0, atRoundOne: false });
  });

  it("a payment on an already paid package is `resized`: a bigger size is a positive total, the difference only", () => {
    // 32 → 128 without cameras: 8 - 2 = 6 credits.
    const e = payEvent(paid({ size: 128, cameras: false, owed: price(128, false) - price(32, false), take: { monthly: 0, pack: 6 } }), { ...CTX, paidBefore: true })!;
    expect(e.kind).toBe("resized");
    expect(e.fact).toMatchObject({ size: 128, cameras: false, credits: 6, monthly: 0, pack: 6, forfeited: 0 });
  });

  it("cameras added at the same size is `resized`, and cameras read true", () => {
    const owed = price(64, true) - price(64, false); // 8 - 4
    const e = payEvent(paid({ size: 64, cameras: true, owed, take: { monthly: 0, pack: 4 } }), { ...CTX, paidBefore: true })!;
    expect(e.kind).toBe("resized");
    expect(e.fact).toMatchObject({ size: 64, cameras: true, credits: 4, pack: 4 });
  });

  it("a move down is `resized` with a NEGATIVE total: what came back by bucket, what was given up on top", () => {
    // 128 → 32 without cameras: 6 credits owed back; one of them was an included credit of an earlier month, forfeited.
    const owed = price(32, false) - price(128, false); // -6
    const e = payEvent(paid({ size: 32, cameras: false, owed, back: { pack: 3, monthly: 2, forfeited: 1 } }), { ...CTX, paidBefore: true })!;
    expect(e.kind).toBe("resized");
    expect(e.fact).toMatchObject({ size: 32, credits: -5, pack: 3, monthly: 2, forfeited: 1 });
  });

  it("a size change that costs nothing (owed 0: a smaller size with cameras for what a larger one cost without) moves no credits", () => {
    const e = payEvent(paid({ size: 32, cameras: true, owed: 0 }), { ...CTX, paidBefore: true })!;
    expect(e.kind).toBe("resized");
    expect(e.fact).toMatchObject({ size: 32, cameras: true, credits: 0, monthly: 0, pack: 0, forfeited: 0 });
  });

  it("the open's own payment says so: at_round_one true; the pay door's says false", () => {
    const r = paid({ size: 16, cameras: false, owed: price(16, false), take: { monthly: 1, pack: 0 } });
    expect(payEvent(r, { ...CTX, atRoundOne: true })!.fact.atRoundOne).toBe(true);
    expect(payEvent(r, { ...CTX, atRoundOne: false })!.fact.atRoundOne).toBe(false);
  });

  it("a payment that moved nothing (the second tab, a frozen row) is NO event", () => {
    expect(payEvent(paid({ size: 64, cameras: false, owed: 4, take: { monthly: 0, pack: 4 }, applied: false }), CTX)).toBeNull();
    expect(payEvent(paid({ size: 64, cameras: false, owed: 4, take: { monthly: 0, pack: 4 }, applied: false }), { ...CTX, paidBefore: true })).toBeNull();
  });

  it("every size of the ladder, with and without cameras: the first payment's credits are the price table's cell (anti-vacuity: 10 cells)", () => {
    let cells = 0;
    for (const size of ONLINE_SIZES) {
      for (const cameras of [false, true]) {
        const owed = price(size, cameras);
        const e = payEvent(paid({ size, cameras, owed, take: { monthly: 0, pack: owed } }), CTX)!;
        expect(e.fact.credits, `${size} ${cameras ? "with" : "without"} cameras`).toBe(GC_PRICE[size][cameras ? 1 : 0]);
        expect(e.fact.size).toBe(size);
        expect(e.fact.cameras).toBe(cameras);
        cells += 1;
      }
    }
    expect(cells).toBe(10);
  });

  it("a charge the door did not split cannot be made into an event: it is LOGGED and skipped (null), never a throw and never a silent zero", () => {
    // The pay door calls payEvent after its money moved, and the open's gate calls it inside the open's own transaction: a throw
    // here would be a 500 after a payment, or a rolled-back "Pay and open". The door's own debit would have refused first, so this
    // is a guard, reached only by a result that is not what the door writes.
    expect(payEvent(paid({ size: 64, cameras: false, owed: 4, take: null }), CTX)).toBeNull();
    expect(failures.logged, "logged, naming the split").toHaveLength(1);
    expect((failures.logged[0]![0] as { err: Error }).err.message).toMatch(/split/i);

    failures.logged.length = 0;
    // The same for a return with no split of what came back.
    expect(payEvent(paid({ size: 32, cameras: false, owed: -2, back: null }), { ...CTX, paidBefore: true })).toBeNull();
    expect(failures.logged, "a missing return split is logged too").toHaveLength(1);
  });

  it("a malformed result of any shape never throws out of payEvent (no package, no quote)", () => {
    let guarded = 0;
    for (const bad of [{ applied: true }, { applied: true, quote: null }, { applied: true, quote: { owed: 3 }, package: undefined }]) {
      expect(() => payEvent(bad as unknown as PayResult, CTX), JSON.stringify(bad)).not.toThrow();
      expect(payEvent(bad as unknown as PayResult, CTX)).toBeNull();
      guarded += 1;
    }
    expect(guarded, "anti-vacuity: three malformed shapes").toBe(3);
  });
});

describe("refundEvents: one event per package a door refunded", () => {
  it("each refunded package is one `refunded` event: its size, its cameras, what came back (negative), what was forfeited", () => {
    const list = refundEvents(
      [
        { size: 64, cameras: false, back: { pack: 4, monthly: 0, forfeited: 0 } },
        { size: 128, cameras: true, back: { pack: 6, monthly: 4, forfeited: 6 } },
      ],
      { orgId: ORG, actorId: USER },
    );
    expect(list).toEqual([
      { orgId: ORG, actorId: USER, size: 64, cameras: false, credits: -4, monthly: 0, pack: 4, forfeited: 0, atRoundOne: false },
      { orgId: ORG, actorId: USER, size: 128, cameras: true, credits: -10, monthly: 4, pack: 6, forfeited: 6, atRoundOne: false },
    ]);
  });

  it("a refund that gave nothing back (every included credit forfeited) reads 0, never -0", () => {
    const [e] = refundEvents([{ size: 16, cameras: false, back: { pack: 0, monthly: 0, forfeited: 1 } }], { orgId: ORG, actorId: USER });
    expect(Object.is(e!.credits, 0), "credits is +0").toBe(true);
    expect(e!.forfeited).toBe(1);
    // The same on a move down that returned nothing but forfeited what it gave up.
    const down = payEvent(paid({ size: 16, cameras: false, owed: -1, back: { pack: 0, monthly: 0, forfeited: 1 } }), { ...CTX, paidBefore: true })!;
    expect(Object.is(down.fact.credits, 0), "a move down that returned nothing reads +0").toBe(true);
  });

  it("a door reached with no user (an API key's delete) sends the event for the org's own synthetic id", async () => {
    const [e] = refundEvents([{ size: 16, cameras: false, back: { pack: 1, monthly: 0, forfeited: 0 } }], { orgId: ORG, actorId: null });
    expect(e!.actorId).toBeNull();
    await capturePackageEvent("refunded", e!);
    expect(sent.calls[0]!.distinctId).toBe(`org:${ORG}`);
  });

  it("no refunded package, no event (the empty case: a delete that refunded nothing)", () => {
    expect(refundEvents([], { orgId: ORG, actorId: USER })).toEqual([]);
  });
});
