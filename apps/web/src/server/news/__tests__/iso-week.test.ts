import { describe, expect, it } from "vitest";
import { isoWeekKeyUtc } from "../enrichment";

const k = (iso: string) => isoWeekKeyUtc(Date.parse(iso));

describe("isoWeekKeyUtc", () => {
  it.each([
    ["2026-09-28T00:00:00Z", "2026-W40"], // Monday
    ["2026-10-04T23:59:59Z", "2026-W40"], // Sunday, same week
    ["2026-10-05T00:00:00Z", "2026-W41"], // next Monday
    ["2026-01-01T12:00:00Z", "2026-W01"], // Thursday, so week 1
    ["2027-01-01T12:00:00Z", "2026-W53"], // 2026 has 53 ISO weeks
    ["2024-12-30T12:00:00Z", "2025-W01"], // Monday belonging to the next ISO year
    ["2021-01-03T12:00:00Z", "2020-W53"], // Sunday belonging to the previous ISO year
  ])("%s → %s", (iso, key) => {
    expect(k(iso)).toBe(key);
  });
});
