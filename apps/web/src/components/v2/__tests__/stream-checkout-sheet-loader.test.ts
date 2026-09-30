// The checkout sheet's loader (Streaming R1 lane D, Task 14 fix round 5, R5a).
//
// `loadCheckoutSheet` is `makeSheetLoader` over the sheet's own `import()` (the panel test pins that line). What is
// proven here is the cache around ANY importer: a load that succeeded is never fetched again, and a load that FAILED is
// forgotten — so "Try again" after a failed chunk really calls `import()` again instead of replaying the rejection.
// A fake importer stands in for `import()`; importing this module itself calls nothing (no Stripe, no sheet).
import { describe, expect, it, vi } from "vitest";
import { makeSheetLoader } from "@/components/v2/stream-checkout-sheet-loader";

const SHEET = { default: () => null };

describe("makeSheetLoader", () => {
  it("a load that SUCCEEDS is fetched once — concurrent and later calls share it", async () => {
    const importer = vi.fn(async () => SHEET);
    const load = makeSheetLoader(importer);
    expect(importer, "building the loader fetches nothing").not.toHaveBeenCalled();
    const [a, b] = await Promise.all([load(), load()]);
    const c = await load();
    expect([a, b, c]).toEqual([SHEET, SHEET, SHEET]);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("a load that FAILS is forgotten: the next call imports AGAIN, and once that succeeds it sticks", async () => {
    const importer = vi.fn<() => Promise<typeof SHEET>>();
    importer.mockRejectedValueOnce(new Error("Failed to load chunk static/chunks/sheet.js")).mockResolvedValue(SHEET);
    const load = makeSheetLoader(importer);
    await expect(load()).rejects.toThrow(/Failed to load chunk/);
    expect(importer).toHaveBeenCalledTimes(1);
    await expect(load(), "the retry replayed the cached rejection").resolves.toBe(SHEET);
    expect(importer, "the retry never called import() again").toHaveBeenCalledTimes(2);
    await load();
    expect(importer, "a success is not re-fetched").toHaveBeenCalledTimes(2);
  });

  it("callers that joined a FAILING load all see it fail — and the next call after it still retries", async () => {
    let fail: (e: Error) => void = () => {};
    const importer = vi.fn<() => Promise<typeof SHEET>>();
    importer.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue(SHEET);
    const load = makeSheetLoader(importer);
    const first = load();
    const second = load();
    expect(importer, "two callers, one import").toHaveBeenCalledTimes(1);
    fail(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    await expect(second).rejects.toThrow("offline");
    await expect(load()).resolves.toBe(SHEET);
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
