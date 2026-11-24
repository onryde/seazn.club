// Task 14 review m2: the CS-4 division probe WRITES (a schedule_edited ledger step) wherever PLAYWRIGHT_BASE points, so its
// writing test refuses any host that is not stg or local unless REALTIME_PROBE_ALLOW_PROD=1 says so. The guard is a pure
// helper beside the probe (`e2e/probes/target-guard.ts`); vitest never collects e2e/, so it is tested here.
//
// The table is typed from the ruling (stg and local only; prod and every other host refused; the override is exactly "1"),
// never from the helper. Applies to another sport: N/A (no sport rules).
import { describe, expect, it } from "vitest";
import { probeWriteRefusal } from "../../../e2e/probes/target-guard";

describe("probeWriteRefusal: the CS-4 probe writes only to stg or a local server", () => {
  const ALLOWED = [
    "https://stg.seazn.club",
    "https://stg.seazn.club/",
    "https://seazn-club-stg.fly.dev",
    "http://localhost:3000",
    "http://127.0.0.1:3100",
    "http://[::1]:3000",
  ];
  const REFUSED = [
    "https://seazn.club",
    "https://www.seazn.club",
    "https://seazn-club.fly.dev",
    "https://example.com",
    "https://stg.seazn.club.evil.example",
    "https://evilstg.seazn.club",
    "not a url",
    "",
  ];

  it("allows every stg and local base, with or without the override", () => {
    let checked = 0;
    for (const base of ALLOWED) {
      expect(probeWriteRefusal(base, undefined), base).toBeNull();
      expect(probeWriteRefusal(base, "1"), base).toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(ALLOWED.length);
  });

  it("refuses prod, www, any other host, a look-alike and a malformed base — naming the base and the override", () => {
    let checked = 0;
    for (const base of REFUSED) {
      const refusal = probeWriteRefusal(base, undefined);
      expect(refusal, base).not.toBeNull();
      expect(refusal, base).toContain("REALTIME_PROBE_ALLOW_PROD=1");
      expect(refusal, base).toContain(JSON.stringify(base));
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(REFUSED.length);
  });

  it("the override is exactly '1': it lets a well-formed non-stg host through, and nothing else counts as set", () => {
    expect(probeWriteRefusal("https://seazn.club", "1")).toBeNull();
    expect(probeWriteRefusal("https://www.seazn.club", "1")).toBeNull();
    let checked = 0;
    for (const value of ["", "0", "true", "yes", " 1", "1 ", "TRUE"]) {
      expect(probeWriteRefusal("https://seazn.club", value), JSON.stringify(value)).not.toBeNull();
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(7);
    // A malformed base names no host to write to: the override cannot make it one.
    expect(probeWriteRefusal("not a url", "1")).not.toBeNull();
  });

  it("an unset base is Playwright's own default (playwright.config.ts: http://localhost:3000): allowed", () => {
    expect(probeWriteRefusal(undefined, undefined)).toBeNull();
  });
});
