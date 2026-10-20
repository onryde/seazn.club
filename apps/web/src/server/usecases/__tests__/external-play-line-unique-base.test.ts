// Every scene of the check-in line's tests gets a bucket - and so a LINE - of its own by handing the adapter a base URL that nobody
// else holds (`uniqueBase`, _external-play-line.ts). The bucket's key IS that base (budget.ts `budgetKey`), so two scenes on one
// base share a line and each reads the other's stays. That is what failed in CI (external-play-line-consumers.test.ts, test 15(d)):
//   inLine 9 (the optional yield ...) for a served stay: expected 'true' to be 'false'
// - the "served" scene asked whether the line was active and the "live" scene before it, on the SAME key, answered yes. It was not a
// slow test (5.7 s, against a timeout the test pins at 600 s); it was a repeat in a base drawn at random out of 40 000 ports, which a
// test that builds 36 scenes meets in ~3% of runs.
//
// Pure: no database. The two sweeps below are anti-vacuity counted - a sweep that drew nothing would find no repeat.
import { describe, expect, it, vi } from "vitest";
import { uniqueBase } from "./_external-play-line";

/** Calls per sweep. The old draw (one of 40 000 ports) repeats about 5 000 times in this many, so a draw that is not unique fails
 *  this sweep at once - it does not wait for a lucky seed. */
const DRAWS = 20_000;

describe("uniqueBase: a base is a bucket of its own (the key of the line a scene reads)", () => {
  it("no base repeats within one test file's run (the 36 scenes of one test are far fewer than this)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < DRAWS; i += 1) seen.add(uniqueBase());
    expect(seen.size, "distinct bases drawn").toBe(DRAWS);
  });

  it("no base is shared between two test files (each file gets its own copy of the module, as `isolate: true` gives it)", async () => {
    // Two files run at the same time against the one database; each has its own module state, so a counter inside the module
    // could not tell them apart. Two fresh copies of the module stand for two files.
    const drawFromFreshCopy = async (): Promise<string[]> => {
      vi.resetModules();
      const copy = (await import("./_external-play-line")) as { uniqueBase: () => string };
      return Array.from({ length: DRAWS }, () => copy.uniqueBase());
    };
    const a = await drawFromFreshCopy();
    const b = await drawFromFreshCopy();
    expect(a.length + b.length, "bases drawn across the two copies").toBe(2 * DRAWS);
    const first = new Set(a);
    const shared = b.filter((base) => first.has(base));
    expect(shared, "bases both files drew").toEqual([]);
  });

  it("every base keeps the shape the fake vendor reads: a URL whose path is /client/v4, never the platform's own base", () => {
    let checked = 0;
    for (let i = 0; i < 200; i += 1) {
      const base = uniqueBase();
      const url = new URL(base);
      expect(url.pathname, base).toBe("/client/v4");
      expect(url.search + url.hash, base).toBe("");
      expect(url.host, base).not.toBe("api.cloudflare.com");
      checked += 1;
    }
    expect(checked, "bases checked").toBe(200);
  });
});
