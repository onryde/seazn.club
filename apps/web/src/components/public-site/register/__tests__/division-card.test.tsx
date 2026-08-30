// RS006 fix wave finding #2 (MEDIUM) — `windowDate` formatted opens_at/
// closes_at with `Intl.DateTimeFormat` in the VIEWER's browser timezone
// with no indication that's what it was doing, while the server decides
// the same window server-side. Two viewers in different zones read
// DIFFERENT, un-labeled calendar dates for the SAME instant
// (closes_at=2026-03-05T23:00:00Z: Sydney "Closes 6 Mar", LA "Closes
// 5 Mar") with nothing on the badge to say why they disagree.
//
// Investigated per the dispatch before changing anything: the ORGANISER's
// timezone is not plumbed to this client at ALL today —
// `PublicRegistrationDivision`/`PublicRegistrationInfo` (schemas.ts:2312,
// :2346) carry no tz field, and `publicRegistrationInfo`'s own SQL query
// (registrations.ts:~1382) never selects `organizations.timezone` even
// though that column exists and already governs scheduling elsewhere
// (`settings.orgTz`, #397/#448). Inventing that plumbing is out of scope
// for a "smaller" fix (a server-schema change touching files this task
// does not own) — see `windowDate`'s own doc comment in division-card.tsx
// for exactly what full plumbing would need. This fix instead makes the
// viewer-local date UNAMBIGUOUS: `timeZoneName: "short"` names the zone
// being shown, so the two viewers above now read "6 Mar, GMT+11" and
// "5 Mar, PST" — still different, but each one honestly labeled instead of
// silently disagreeing.
//
// `windowDate` grew an optional third `timeZone` param SPECIFICALLY so
// this suite can pin deterministic zones — this workspace's
// `process.env.TZ` does NOT move `Date`/`Intl` inside a vitest worker
// thread (`zoned-datetime.test.ts`'s own header comment), so a date test
// here has no other way to avoid silently asserting whatever zone the
// CI box happens to be in. Every PRODUCTION call site still omits the
// third arg, so this changes nothing about what a real browser shows.
import { describe, expect, it, vi } from "vitest";
import { textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionCard, windowDate } from "../division-card";
import type { DivisionLike } from "../types";

vi.mock("@/components/i18n/dict-provider", () => ({
  // Surfaces interpolation vars in the rendered text (instead of an opaque
  // key) so the wiring test below can assert on the actual date STRING
  // DivisionCard hands to the badge, matching this harness's "pin copy
  // over a lookup" convention (register-stepper-interaction.test.tsx).
  useT: () => (key: string, vars?: Record<string, string | number>) => (vars ? `${key}::${JSON.stringify(vars)}` : key),
}));

describe("windowDate — labels the zone it's showing instead of a bare, silently-viewer-local date", () => {
  // Same instant as the fix wave's own illustration: 2026-03-05T23:00:00Z.
  const CLOSES = "2026-03-05T23:00:00Z";

  it("Sydney and Los Angeles read DIFFERENT calendar days for the SAME instant — each one now named", () => {
    expect(windowDate(CLOSES, "en", "Australia/Sydney")).toBe("Mar 6, GMT+11");
    expect(windowDate(CLOSES, "en", "America/Los_Angeles")).toBe("Mar 5, PST");
  });

  it("regression: pre-fix this returned a bare 'Mar 5' with no zone at all — UTC must show one too", () => {
    const result = windowDate(CLOSES, "en", "UTC");
    expect(result).toBe("Mar 5, UTC");
    expect(result).not.toBe("Mar 5"); // the old, ambiguous shape
  });

  it("localizes the zone label itself, not just the date, across all 4 app locales", () => {
    expect(windowDate(CLOSES, "es", "Australia/Sydney")).toBe("6 mar, GMT+11");
    expect(windowDate(CLOSES, "fr", "Australia/Sydney")).toBe("6 mars, UTC+11");
    expect(windowDate(CLOSES, "nl", "Australia/Sydney")).toBe("6 mrt, GMT+11");
  });

  it("omitting timeZone (every production call site) still resolves ambiently — unchanged call shape", () => {
    // Not asserting WHICH zone (that's whatever this process runs in —
    // pinning it is exactly what the note above says a vitest worker
    // cannot do) — only that the 2-arg production call shape still works
    // and still names SOME zone rather than throwing or going bare.
    const ambient = windowDate(CLOSES, "en");
    expect(ambient).toMatch(/^\w+ \d+, \S+/);
  });
});

describe("DivisionCard's window badges — wired through the (now zone-labeled) windowDate, not a fork of it", () => {
  const DIVISION: DivisionLike = {
    division_id: "div-1",
    name: "Open Teams",
    entrant_kind: "team",
    category: null,
    age_min: null,
    age_max: null,
    requires_dob: false,
    requires_gender: false,
    allow_free_agents: false,
    open: true,
    closed_reason: null,
    capacity: null,
    remaining: null,
    taken: 0,
    opens_at: null,
    closes_at: "2026-03-05T23:00:00Z",
    fee_cents: 0,
    currency: "USD",
    payment_method: "offline",
    form_fields: [],
    eligibility_note: null,
  };

  it("the Closes badge's date is exactly what windowDate(closes_at, locale) produces — same instant, no forked formatting", () => {
    const tree = walk(DivisionCard({ division: DIVISION, locale: "en", selfEligibility: null, imPlaying: false }));
    const closesBadge = tree.find((el) => el.type === "span" && textOf(el).includes("register.entries.window.closes"));
    expect(closesBadge, "Closes badge not found").toBeTruthy();
    const expected = `register.entries.window.closes::${JSON.stringify({ date: windowDate(DIVISION.closes_at!, "en") })}`;
    expect(textOf(closesBadge!)).toBe(expected);
  });
});

// RS007/V380 defect #3: the wizard's custom rule was written and shown
// NOWHERE — the validator handled only 'age'/'gender', so an organiser's
// "School-registered students only" landed in a void. eligibility_note is
// now a first-class column; this proves DivisionCard actually renders it.
describe("DivisionCard — the organiser's eligibility_note (RS007/V380 defect #3)", () => {
  const DIVISION: DivisionLike = {
    division_id: "div-1",
    name: "Open Teams",
    entrant_kind: "team",
    category: null,
    age_min: null,
    age_max: null,
    requires_dob: false,
    requires_gender: false,
    allow_free_agents: false,
    open: true,
    closed_reason: null,
    capacity: null,
    remaining: null,
    taken: 0,
    opens_at: null,
    closes_at: null,
    fee_cents: 0,
    currency: "USD",
    payment_method: "offline",
    form_fields: [],
    eligibility_note: "School-registered students only",
  };

  it("renders the note, interpolated into the organiser-speaking template", () => {
    const tree = walk(DivisionCard({ division: DIVISION, locale: "en", selfEligibility: null, imPlaying: false }));
    const note = tree.find((el) => el.type === "p" && textOf(el).includes("register.organiserNote"));
    expect(note, "organiser note not found").toBeTruthy();
    expect(textOf(note!)).toBe(
      `register.organiserNote::${JSON.stringify({ note: "School-registered students only" })}`,
    );
  });

  it("renders nothing when the division has no note set", () => {
    const tree = walk(
      DivisionCard({
        division: { ...DIVISION, eligibility_note: null },
        locale: "en",
        selfEligibility: null,
        imPlaying: false,
      }),
    );
    expect(tree.some((el) => el.type === "p" && textOf(el).includes("register.organiserNote"))).toBe(false);
  });

  it("renders regardless of imPlaying (general info, not a per-viewer verdict)", () => {
    const tree = walk(
      DivisionCard({
        division: DIVISION,
        locale: "en",
        selfEligibility: { eligible: true, issues: [] },
        imPlaying: true,
      }),
    );
    expect(tree.some((el) => el.type === "p" && textOf(el).includes("register.organiserNote"))).toBe(true);
  });
});
