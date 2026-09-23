import { describe, expect, it } from "vitest";
import { liveCopy } from "../device-link-copy";

const fmt = (iso: string) => `AT(${iso})`;

describe("device-link panel copy (scorer sheets §4.2)", () => {
  it("a sealed link (null expiry) says 'until the match is over' — never an epoch date", () => {
    expect(liveCopy(null, fmt)).toEqual({ key: "dlink.liveUntilOver" });
  });
  it("a dated row keeps the existing dated line (the key that already exists — no new legacy copy, ruling Q3)", () => {
    expect(liveCopy("2026-09-23T23:59:59Z", fmt)).toEqual({ key: "dlink.live", vars: { date: "AT(2026-09-23T23:59:59Z)" } });
  });
});
