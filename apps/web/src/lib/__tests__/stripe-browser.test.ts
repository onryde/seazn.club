// Parked (d), Task 14 re-review 3: lib/stripe-browser.ts held `loadStripe()` in a module constant. @stripe/stripe-js
// resets its OWN cache when the script fails to load, but the app's constant kept the rejected promise — so after one
// js.stripe.com failure, every embedded checkout in the app (plans, passes, AI packs, match credits, billing manage)
// failed until a full reload. The export now drops a rejected load, so the next checkout loads afresh; a load that
// SUCCEEDED is still loaded once for the whole app, and it still starts at import (the preload is unchanged).
import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeJs = vi.hoisted(() => ({ loadStripe: vi.fn() }));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: stripeJs.loadStripe }));

/** A fresh copy of the module, so each case starts from its own import-time load. Boxed: an async function that
 *  RETURNS a thenable adopts it, which would read the export once more before the case gets to. */
async function fresh() {
  vi.resetModules();
  const { stripePromise } = await import("../stripe-browser");
  return { stripePromise };
}

beforeEach(() => {
  stripeJs.loadStripe.mockReset();
});

describe("stripePromise", () => {
  it("a FAILED load is dropped: the checkout that met the outage fails, the NEXT one loads Stripe.js again and gets it — no reload needed", async () => {
    const stripe = { id: "stripe-instance" };
    let fail: (e: Error) => void = () => {};
    stripeJs.loadStripe.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; })).mockResolvedValue(stripe);
    const { stripePromise } = await fresh();
    expect(stripeJs.loadStripe, "the preload still starts at import").toHaveBeenCalledTimes(1);
    const meetsOutage = Promise.resolve(stripePromise); // a checkout opened while js.stripe.com is failing
    fail(new Error("Failed to load Stripe.js"));
    await expect(meetsOutage, "the checkout that met the outage").rejects.toThrow(/Failed to load/);
    await expect(Promise.resolve(stripePromise), "the next checkout retries instead of replaying the failure").resolves.toBe(stripe);
    expect(stripeJs.loadStripe).toHaveBeenCalledTimes(2);
  });

  it("a PRELOAD that failed before anyone asked is not replayed to the first checkout — it loads afresh", async () => {
    const stripe = { id: "stripe-instance" };
    stripeJs.loadStripe.mockReturnValueOnce(Promise.reject(new Error("Failed to load Stripe.js"))).mockResolvedValue(stripe);
    const { stripePromise } = await fresh();
    await new Promise((r) => setTimeout(r, 0)); // the preload's failure lands with nobody reading
    await expect(Promise.resolve(stripePromise)).resolves.toBe(stripe);
    expect(stripeJs.loadStripe).toHaveBeenCalledTimes(2);
  });

  it("a SUCCESSFUL load is loaded once for the whole app — every later read, and reads racing a pending load, share it", async () => {
    const stripe = { id: "stripe-instance" };
    let release: (s: unknown) => void = () => {};
    stripeJs.loadStripe.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const { stripePromise } = await fresh();
    const racing = [Promise.resolve(stripePromise), Promise.resolve(stripePromise)];
    release(stripe);
    let checked = 0;
    for (const r of racing) {
      await expect(r).resolves.toBe(stripe);
      checked++;
    }
    for (let i = 0; i < 3; i++) {
      await expect(Promise.resolve(stripePromise)).resolves.toBe(stripe);
      checked++;
    }
    expect(checked).toBe(5);
    expect(stripeJs.loadStripe, "one load, however many readers").toHaveBeenCalledTimes(1);
  });

  it("the key is the public NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, on every load, retries included", async () => {
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_test_unit");
    try {
      stripeJs.loadStripe.mockReturnValueOnce(Promise.reject(new Error("x"))).mockResolvedValue({});
      const { stripePromise } = await fresh();
      await Promise.resolve(stripePromise).catch(() => {});
      await Promise.resolve(stripePromise);
      expect(stripeJs.loadStripe.mock.calls).toEqual([["pk_test_unit"], ["pk_test_unit"]]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
