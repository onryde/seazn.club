// The quick match smoke's sweep leg calls the real expiry route, which takes no scope: it deletes every expired unsaved quick
// match on its target (quick match plan 3 Amend T7 [A9], "never prod"). The leg's guard runs only against this machine or
// staging; production, a Fly hostname and anything unreadable are refused. COUNTED: zero cases checked is a failure.
import { describe, expect, it } from "vitest";
import { sweepTargetAllowed } from "../smoke/suites/quickMatch.ts";

describe("quickMatch smoke — sweepTargetAllowed", () => {
  it("allows this machine and staging, and refuses production and everything else", () => {
    const allowed = ["http://localhost:3000", "http://localhost:3342", "http://127.0.0.1:3300", "http://[::1]:3000", "https://stg.seazn.club"];
    const refused = ["https://seazn.club", "https://www.seazn.club", "https://seazn-club.fly.dev", "https://stg.seazn.club.evil.example", "not a url", ""];
    let checked = 0;
    for (const base of allowed) {
      expect(sweepTargetAllowed(base), base).toBe(true);
      checked++;
    }
    for (const base of refused) {
      expect(sweepTargetAllowed(base), base).toBe(false);
      checked++;
    }
    expect(checked).toBe(allowed.length + refused.length);
    expect(checked).toBeGreaterThan(0);
  });
});
