// RS004 W3 — the Settings tab row's status pill. Pure derivation from
// `enabled` + the opens_at/closes_at window + "now", so every boundary is
// testable without a clock mock or a DB row: open|scheduled|closed.
import { describe, expect, it } from "vitest";
import { deriveRegistrationStatus } from "@/components/registration-hub-status";

const NOW = new Date("2026-06-15T12:00:00Z");
const PAST = new Date("2026-06-01T00:00:00Z");
const FUTURE = new Date("2026-07-01T00:00:00Z");

describe("deriveRegistrationStatus", () => {
  it("is scheduled when the window has not opened yet", () => {
    expect(
      deriveRegistrationStatus({ enabled: true, opens_at: FUTURE, closes_at: null }, NOW),
    ).toBe("scheduled");
  });

  it("is open when now falls inside the window", () => {
    expect(
      deriveRegistrationStatus({ enabled: true, opens_at: PAST, closes_at: FUTURE }, NOW),
    ).toBe("open");
  });

  it("is closed once the window has passed", () => {
    expect(
      deriveRegistrationStatus(
        { enabled: true, opens_at: PAST, closes_at: new Date("2026-06-10T00:00:00Z") },
        NOW,
      ),
    ).toBe("closed");
  });

  it("is open when enabled with no window set at all", () => {
    expect(
      deriveRegistrationStatus({ enabled: true, opens_at: null, closes_at: null }, NOW),
    ).toBe("open");
  });

  it("is closed when disabled, even with a future window — enabled overrides window state", () => {
    expect(
      deriveRegistrationStatus({ enabled: false, opens_at: FUTURE, closes_at: null }, NOW),
    ).toBe("closed");
  });

  it("accepts string timestamps (raw DB rows), not only Date objects", () => {
    expect(
      deriveRegistrationStatus(
        { enabled: true, opens_at: PAST.toISOString(), closes_at: FUTURE.toISOString() },
        NOW,
      ),
    ).toBe("open");
  });
});
