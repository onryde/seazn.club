// Guards the SEAM, not the decoder — and does it WITHOUT a database, because
// that is exactly the gap. `platform-settings.test.ts` is `skipIf(!HAS_DB)`
// and CI's unit job has never had DATABASE_URL, so reverting
// `decodeFeePercent(row?.value)` back to `Number(row?.value)` — the original
// F5 defect — leaves the whole pipeline green. `platform-fee.test.ts` cannot
// see it either: it only exercises the pure function and never imports this
// module. So the db and cache are mocked here and the real
// `platformFeeDefault()` is driven through them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const row = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("@/lib/db", () => ({
  sql: Object.assign(
    // The tagged-template call platformFeeDefault makes: one row, or none.
    () => Promise.resolve(row.value === undefined ? [] : [{ value: row.value }]),
    { json: (v: unknown) => v, unsafe: (v: unknown) => v },
  ),
}));
// Cache-aside, forced to always miss, so every `it` reads the row it set
// rather than a previous test's memoised answer.
vi.mock("@/lib/cache", () => ({
  cacheGet: () => Promise.resolve(null),
  cacheSet: () => Promise.resolve(),
  cacheDelPattern: () => Promise.resolve(),
}));

const { platformFeeDefault, __envFallbackForTests } = await import("@/lib/platform-settings");

const ENV = process.env.PLATFORM_FEE_PERCENT;
beforeEach(() => {
  delete process.env.PLATFORM_FEE_PERCENT;
});
afterEach(() => {
  if (ENV === undefined) delete process.env.PLATFORM_FEE_PERCENT;
  else process.env.PLATFORM_FEE_PERCENT = ENV;
});

describe("platformFeeDefault — the production seam", () => {
  /**
   * The env is pinned to 11 rather than left at the default 5 so the three
   * outcomes separate: 11 is the fallback doing its job, 0 is F5, and 5 would
   * mean the fallback never ran. Asserting 5 here would pass against the
   * defect's own neighbour.
   */
  it("routes a jsonb-empty row to the fallback instead of serving 0%", async () => {
    process.env.PLATFORM_FEE_PERCENT = "11";
    for (const empty of [null, false, "", []]) {
      row.value = empty;
      expect(Number(empty), `Number(${JSON.stringify(empty)}) is the hazard`).toBe(0);
      expect(
        await platformFeeDefault(),
        `a jsonb ${JSON.stringify(empty)} row must not read as a 0% platform cut`,
      ).toBe(11);
    }
  });

  it("still honours a real number, including a deliberate zero", async () => {
    row.value = 7.5;
    expect(await platformFeeDefault()).toBe(7.5);
    // A row that genuinely SAYS zero is a valid 0% promotional cut and must
    // survive; without this, "reject every falsy value" passes the case above.
    row.value = 0;
    expect(await platformFeeDefault()).toBe(0);
  });

  it("falls back to 5 when the row is absent", async () => {
    row.value = undefined; // no row at all
    expect(await platformFeeDefault()).toBe(5);
  });
});

describe("envFallback", () => {
  /**
   * `Number("")` is a finite, in-range 0 — the same shape as F5, one layer
   * down. `?? "5"` cannot catch it, because an empty env var is SET, not
   * nullish. This branch now carries every row the jsonb decoder rejects.
   */
  it("treats a set-but-blank PLATFORM_FEE_PERCENT as unset, not as 0%", () => {
    for (const blank of ["", " ", "\t"]) {
      process.env.PLATFORM_FEE_PERCENT = blank;
      expect(Number(blank), "the hazard: a blank env coerces to a valid-looking 0").toBe(0);
      expect(__envFallbackForTests(), `PLATFORM_FEE_PERCENT=${JSON.stringify(blank)}`).toBe(5);
    }
  });

  it("honours a real value and rejects an out-of-band or junk one", () => {
    process.env.PLATFORM_FEE_PERCENT = "11";
    expect(__envFallbackForTests()).toBe(11);
    process.env.PLATFORM_FEE_PERCENT = "0";
    expect(__envFallbackForTests(), "an explicit 0% env is legitimate").toBe(0);
    process.env.PLATFORM_FEE_PERCENT = "101";
    expect(__envFallbackForTests()).toBe(5);
    process.env.PLATFORM_FEE_PERCENT = "nonsense";
    expect(__envFallbackForTests()).toBe(5);
  });
});
