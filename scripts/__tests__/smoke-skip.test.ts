// Gap wave G10 (player payment page ledger Q8): the smoke suite `registrationPayPage` reported its env-gated checks, skipped for
// want of DATABASE_URL / CRON_SECRET / EMAIL_OUTBOX_KEK, as `check(label, true)` - a PASS. A run without those keys then read
// "N passed, 0 failed" with the chase-mail and paid-409 checks never run. A skip now prints SKIP, is counted apart, and the run's
// summary says how many: it neither passes nor fails the run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check, counts, skip, summary } from "../smoke/harness.ts";
import { chaseMailsLinkThePage } from "../smoke/suites/registrationPayPage.ts";

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("smoke: a skip is reported as skipped, never as a pass", () => {
  it("skip prints SKIP and moves only the skipped count, once per call; check(true) still moves pass", () => {
    const a = counts();
    skip("probe skipped once");
    skip("probe skipped twice");
    const b = counts();
    expect(b).toEqual({ pass: a.pass, fail: a.fail, skipped: a.skipped + 2 });
    expect(lines).toEqual(["SKIP  probe skipped once", "SKIP  probe skipped twice"]);
    // The positive pair: a real pass is still a pass.
    check("probe passed", true);
    expect(counts()).toEqual({ pass: b.pass + 1, fail: b.fail, skipped: b.skipped });
  });

  it("the run's summary line names the skipped count beside passed and failed", () => {
    skip("probe for the summary");
    const c = counts();
    expect(c.skipped, "premise: at least one skip to report").toBeGreaterThan(0);
    expect(summary()).toBe(`${c.pass} passed, ${c.fail} failed, ${c.skipped} skipped`);
  });

  it("registrationPayPage's keyless branch skips by name and counts no pass", async () => {
    const KEYS = ["DATABASE_URL", "CRON_SECRET", "EMAIL_OUTBOX_KEK"] as const;
    for (const k of KEYS) vi.stubEnv(k, "");
    const a = counts();
    await chaseMailsLinkThePage();
    expect(counts()).toEqual({ pass: a.pass, fail: a.fail, skipped: a.skipped + 1 });
    const skips = lines.filter((l) => l.startsWith("SKIP  "));
    expect(skips).toHaveLength(1);
    for (const k of KEYS) expect(skips[0], `the skip names ${k}`).toContain(k);
    expect(lines.filter((l) => l.startsWith("PASS")), "no PASS line for a check that never ran").toHaveLength(0);
  });
});
