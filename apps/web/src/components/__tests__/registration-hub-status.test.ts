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

// RS004 W3b review finding 2 — the implementation's boundary handling was
// undocumented and untested: both `opens_at` and `closes_at` are INCLUSIVE
// of "open" (exactly at either instant reads open), and an inverted window
// (`closes_at` before `opens_at`) makes "open" unreachable entirely. Both
// are defensible, intentional behaviours already shipped in
// deriveRegistrationStatus — this is CHARACTERISATION: it pins what the
// function already does (see its docstring), not a behaviour change.
describe("deriveRegistrationStatus — boundary instants (characterisation)", () => {
  const OPENS = new Date("2026-06-10T00:00:00.000Z");
  const CLOSES = new Date("2026-06-20T00:00:00.000Z");
  const oneMsBefore = (d: Date) => new Date(d.getTime() - 1);
  const oneMsAfter = (d: Date) => new Date(d.getTime() + 1);

  it("is open exactly AT opens_at — the open instant is inclusive", () => {
    expect(
      deriveRegistrationStatus({ enabled: true, opens_at: OPENS, closes_at: CLOSES }, OPENS),
    ).toBe("open");
  });

  it("is scheduled one millisecond BEFORE opens_at", () => {
    expect(
      deriveRegistrationStatus(
        { enabled: true, opens_at: OPENS, closes_at: CLOSES },
        oneMsBefore(OPENS),
      ),
    ).toBe("scheduled");
  });

  it("is open one millisecond AFTER opens_at", () => {
    expect(
      deriveRegistrationStatus(
        { enabled: true, opens_at: OPENS, closes_at: CLOSES },
        oneMsAfter(OPENS),
      ),
    ).toBe("open");
  });

  it("is open exactly AT closes_at — the close instant is still inclusive of open", () => {
    expect(
      deriveRegistrationStatus({ enabled: true, opens_at: OPENS, closes_at: CLOSES }, CLOSES),
    ).toBe("open");
  });

  it("is open one millisecond BEFORE closes_at", () => {
    expect(
      deriveRegistrationStatus(
        { enabled: true, opens_at: OPENS, closes_at: CLOSES },
        oneMsBefore(CLOSES),
      ),
    ).toBe("open");
  });

  it("is closed one millisecond AFTER closes_at", () => {
    expect(
      deriveRegistrationStatus(
        { enabled: true, opens_at: OPENS, closes_at: CLOSES },
        oneMsAfter(CLOSES),
      ),
    ).toBe("closed");
  });
});

describe("deriveRegistrationStatus — inverted window, closes_at before opens_at (characterisation)", () => {
  // closes_at sits BEFORE opens_at — a malformed-looking but currently
  // unvalidated combination. "open" must never occur: the status jumps
  // directly from scheduled to closed the instant `now` reaches opens_at.
  const OPENS = new Date("2026-06-20T00:00:00.000Z");
  const CLOSES = new Date("2026-06-10T00:00:00.000Z"); // before OPENS

  it("is scheduled before opens_at, even though that instant is already past closes_at", () => {
    expect(
      deriveRegistrationStatus(
        { enabled: true, opens_at: OPENS, closes_at: CLOSES },
        new Date(OPENS.getTime() - 1),
      ),
    ).toBe("scheduled");
  });

  it("is scheduled exactly AT closes_at (still well before opens_at)", () => {
    expect(
      deriveRegistrationStatus({ enabled: true, opens_at: OPENS, closes_at: CLOSES }, CLOSES),
    ).toBe("scheduled");
  });

  it("is closed exactly AT opens_at — the transition point, with no open state ever visited", () => {
    expect(
      deriveRegistrationStatus({ enabled: true, opens_at: OPENS, closes_at: CLOSES }, OPENS),
    ).toBe("closed");
  });

  it("is closed after opens_at", () => {
    expect(
      deriveRegistrationStatus(
        { enabled: true, opens_at: OPENS, closes_at: CLOSES },
        new Date(OPENS.getTime() + 1),
      ),
    ).toBe("closed");
  });
});
