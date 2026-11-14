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
// `PublicRegistrationDivision`/`PublicRegistrationInfo` (api-v1/schemas/registration.ts)
// carry no tz field, and `publicRegistrationInfo`'s own SQL query
// (usecases/registrations/) never selects `organizations.timezone` even
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { DivisionCard, windowDate } from "../division-card";
import type { DivisionLike } from "../types";

vi.mock("@/components/i18n/dict-provider", () => ({
  // Surfaces interpolation vars in the rendered text (instead of an opaque
  // key) so the wiring test below can assert on the actual date STRING
  // DivisionCard hands to the badge, matching this harness's "pin copy
  // over a lookup" convention (register-stepper-interaction.test.tsx).
  useT: () => (key: string, vars?: Record<string, string | number>) => (vars ? `${key}::${JSON.stringify(vars)}` : key),
  // B3 T12: the capacity line is a plural; the mock shows the key and the count it was asked for (the real forms are read from the
  // four dictionaries by the copy test at the end of this file).
  usePlural: () => (key: string, count: number, vars?: Record<string, string | number>) => `${key}::${JSON.stringify({ count, ...vars })}`,
}));

describe("windowDate — labels the zone it's showing instead of a bare, silently-viewer-local date", () => {
  // Same instant as the fix wave's own illustration: 2026-03-05T23:00:00Z.
  const CLOSES = "2026-03-05T23:00:00Z";

  // English is day-month (owner ruling 2026-09-16): `intlLocaleFor` writes
  // "en" as en-GB, whose short zone label for Los Angeles is the offset
  // ("GMT-8") rather than en-US's "PST". Until the ruling these read
  // "Mar 6, GMT+11" / "Mar 5, PST".
  it("Sydney and Los Angeles read DIFFERENT calendar days for the SAME instant — each one now named", () => {
    expect(windowDate(CLOSES, "en", "Australia/Sydney")).toBe("6 Mar, GMT+11");
    expect(windowDate(CLOSES, "en", "America/Los_Angeles")).toBe("5 Mar, GMT-8");
  });

  it("regression: pre-fix this returned a bare 'Mar 5' with no zone at all — UTC must show one too", () => {
    const result = windowDate(CLOSES, "en", "UTC");
    expect(result).toBe("5 Mar, UTC");
    expect(result).not.toBe("5 Mar"); // the old, ambiguous shape
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
    expect(ambient).toMatch(/^\d+ \w+, \S+/);
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
    free_agent_fee_cents: null,
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
    free_agent_fee_cents: null,
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

// FU1 (controller ruling 3): a division whose registration kind is one the division itself does not take does not open
// for sign-up. The server closes it with closed_reason "entry_kind_unavailable"; the card says so in plain words rather
// than looking like an ordinary window close (or showing nothing at all).
describe("DivisionCard — entries unavailable for a kind the division does not take (FU1)", () => {
  const DIVISION: DivisionLike = {
    division_id: "div-1",
    name: "Open Teams",
    entrant_kind: "individual",
    category: null,
    age_min: null,
    age_max: null,
    requires_dob: false,
    requires_gender: false,
    allow_free_agents: false,
    open: false,
    closed_reason: "entry_kind_unavailable",
    capacity: null,
    remaining: null,
    taken: 0,
    opens_at: null,
    closes_at: "2026-03-05T23:00:00Z",
    fee_cents: 0,
    free_agent_fee_cents: null,
    currency: "USD",
    payment_method: "offline",
    form_fields: [],
    eligibility_note: null,
  };
  const badgeTexts = (d: DivisionLike) =>
    walk(DivisionCard({ division: d, locale: "en", selfEligibility: null, imPlaying: false }))
      .filter((el) => el.type === "span")
      .map((el) => textOf(el));

  it("shows the unavailable badge, and neither the window-closed badge nor a closing date", () => {
    const texts = badgeTexts(DIVISION);
    expect(texts).toContain("register.entries.badge.kindUnavailable");
    expect(texts).not.toContain("register.entries.badge.closed");
    expect(texts.some((s) => s.startsWith("register.entries.window.closes"))).toBe(false);
  });

  it("positive pair: the same division when open (or closed for its window) carries no unavailable badge", () => {
    expect(badgeTexts({ ...DIVISION, open: true, closed_reason: null })).not.toContain("register.entries.badge.kindUnavailable");
    expect(badgeTexts({ ...DIVISION, closed_reason: "window" })).not.toContain("register.entries.badge.kindUnavailable");
    expect(badgeTexts({ ...DIVISION, closed_reason: "window" })).toContain("register.entries.badge.closed");
  });
});

// Walk-fix F5: a card division closed because card payments are not set up said only "Card payments are temporarily unavailable"
// (a badge). In a cart where offline/free divisions still register, the card now also says when it will open, in the same sentence
// the all-closed register page uses.
describe("DivisionCard — closed for card payments says it opens once payment setup is finished (walk-fix F5)", () => {
  const DIVISION: DivisionLike = {
    division_id: "div-1",
    name: "Card Singles",
    entrant_kind: "individual",
    category: null,
    age_min: null,
    age_max: null,
    requires_dob: false,
    requires_gender: false,
    allow_free_agents: false,
    open: false,
    closed_reason: "payments_unavailable",
    capacity: null,
    remaining: null,
    taken: 0,
    opens_at: null,
    closes_at: null,
    fee_cents: 1500,
    free_agent_fee_cents: null,
    currency: "GBP",
    payment_method: "stripe",
    form_fields: [],
    eligibility_note: null,
  };
  const texts = (d: DivisionLike) =>
    walk(DivisionCard({ division: d, locale: "en", selfEligibility: null, imPlaying: false })).map((el) => textOf(el));

  it("names the reason and the remedy", () => {
    expect(texts(DIVISION)).toContain("register.cardPaymentsUnavailable");
  });
  it("negative pair: the same card open, or closed for its window, does not", () => {
    let checked = 0;
    for (const d of [{ ...DIVISION, open: true, closed_reason: null }, { ...DIVISION, closed_reason: "window" }]) {
      expect(texts(d), JSON.stringify(d.closed_reason)).not.toContain("register.cardPaymentsUnavailable");
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// Registration redesign B3 T12 (spec §4.1, owner ruling 2026-11-13). The card said "3/32" for any division with a capacity and a
// "Waitlist" chip for a full one — and said nothing about the plan limit that submit enforces. It now says what a visitor can act
// on: how many places are left when the organiser set a capacity or the division is nearly full, "Full · join the waiting list"
// when it is, and nothing at all for an uncapped division (the plan's number would read "256 places left", which is noise).
describe("DivisionCard — capacity states (B3 T12)", () => {
  const BASE: DivisionLike = {
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
    capacity: 32,
    remaining: 28,
    taken: 4,
    waitlisted: 0,
    opens_at: null,
    closes_at: null,
    fee_cents: 0,
    free_agent_fee_cents: null,
    currency: "USD",
    payment_method: "offline",
    form_fields: [],
    eligibility_note: null,
  };
  const render = (d: Partial<DivisionLike>, inCart = 0, handlers: Record<string, () => void> = { onAddTeam: () => {} }) =>
    walk(DivisionCard({ division: { ...BASE, ...d }, locale: "en", selfEligibility: null, imPlaying: false, inCart, ...handlers }));
  const spans = (d: Partial<DivisionLike>, inCart = 0) => render(d, inCart).filter((el) => el.type === "span");
  /** The capacity line: the one badge that carries a `register.capacity.*` key. */
  const capacityLine = (d: Partial<DivisionLike>, inCart = 0) => spans(d, inCart).find((el) => textOf(el).startsWith("register.capacity."));
  const buttons = (d: Partial<DivisionLike>, inCart = 0, handlers?: Record<string, () => void>) =>
    render(d, inCart, handlers).filter((el) => el.type === "button").map((el) => textOf(el));
  const cls = (el: ReturnType<typeof walk>[number] | undefined) => String(propsOf(el!).className);

  it("full: 'Full · join the waiting list' with how many wait, and the CTA reads Join waiting list", () => {
    const d = { remaining: 0, closed_reason: "full", taken: 32, waitlisted: 3 };
    expect(textOf(capacityLine(d)!)).toBe(`register.capacity.fullWaitlistCount::${JSON.stringify({ count: 3 })}`);
    expect(cls(capacityLine(d))).toMatch(/amber/);
    expect(buttons(d)).toEqual(["register.capacity.joinWaitlist"]);
    expect(buttons(d), "the Add copy is gone while the division is full").not.toContain("register.entries.add.team");
  });

  it("full with nobody waiting: the count is omitted, not '(0 waiting)' — and a wire with no count reads the same", () => {
    expect(textOf(capacityLine({ remaining: 0, closed_reason: "full", waitlisted: 0 })!)).toBe("register.capacity.fullWaitlist");
    const noCount = { ...BASE, remaining: 0, closed_reason: "full" } as DivisionLike;
    delete (noCount as { waitlisted?: number }).waitlisted;
    expect(textOf(spans(noCount).find((el) => textOf(el).startsWith("register.capacity."))!)).toBe("register.capacity.fullWaitlist");
  });

  it("1 to 3 left: the count, emphasised (bold, the amber warning tone) — with or without an organiser capacity", () => {
    for (const [remaining, capacity] of [[1, 32], [2, 32], [3, 32], [3, null]] as const) {
      const line = capacityLine({ remaining, capacity });
      expect(textOf(line!), `${remaining} left, capacity ${capacity}`).toBe(`register.capacity.left::${JSON.stringify({ count: remaining })}`);
      expect(cls(line), `${remaining} left is emphasised`).toMatch(/font-bold/);
      expect(cls(line)).toMatch(/amber/);
    }
  });

  it("more than 3 left with a capacity set: the count, in the quiet neutral tone (not emphasised)", () => {
    const line = capacityLine({ remaining: 4, capacity: 8 });
    expect(textOf(line!)).toBe(`register.capacity.left::${JSON.stringify({ count: 4 })}`);
    expect(cls(line)).not.toMatch(/font-bold|amber/);
    expect(cls(line)).toMatch(/text-ink-muted/);
    expect(textOf(capacityLine({ remaining: 28, capacity: 32 })!)).toBe(`register.capacity.left::${JSON.stringify({ count: 28 })}`);
  });

  it("an uncapped division says nothing about places — however big the plan's number is (owner ruling)", () => {
    // The plan limit now rides the wire as `remaining` (T11), so an organiser who set no capacity still has a number.
    for (const [remaining, label] of [[null, "no cap at all"], [256, "Pro plan limit"], [64, "Community plan limit"], [4, "just over the few-left line"]] as const) {
      expect(capacityLine({ capacity: null, remaining }), label).toBeUndefined();
    }
    // Positive pair: the SAME remaining WITH an organiser capacity does show.
    expect(capacityLine({ capacity: 256, remaining: 256 })).toBeDefined();
  });

  it("the old 'taken/capacity' chip and the 'Waitlist' chip are gone", () => {
    for (const d of [{ capacity: 32, taken: 4 }, { remaining: 0, closed_reason: "full", taken: 32 }, { capacity: 8, remaining: 2, taken: 6 }]) {
      const all = spans(d).map((el) => textOf(el)).join("|");
      expect(all).not.toContain("register.capacity.taken");
      expect(all).not.toContain("register.entries.badge.waitlist");
      expect(all, "no bare '4/32' count").not.toMatch(/\d+\/\d+/);
    }
  });

  it("the visitor's own cart entries come off the count: 3 left with 1 in the cart reads 2", () => {
    expect(textOf(capacityLine({ remaining: 3 }, 1)!)).toBe(`register.capacity.left::${JSON.stringify({ count: 2 })}`);
    expect(textOf(capacityLine({ remaining: 5 }, 2)!), "4 -> 3 crosses into the emphasised line").toBe(`register.capacity.left::${JSON.stringify({ count: 3 })}`);
    expect(cls(capacityLine({ remaining: 5 }, 2))).toMatch(/font-bold/);
  });

  it("the cart filling the last place turns the card to the waiting list, and a removed sibling turns it back", () => {
    const d = { remaining: 1, waitlisted: 2 };
    expect(textOf(capacityLine(d, 0)!)).toBe(`register.capacity.left::${JSON.stringify({ count: 1 })}`);
    expect(buttons(d, 0)).toEqual(["register.entries.add.team"]);
    expect(textOf(capacityLine(d, 1)!)).toBe(`register.capacity.fullWaitlistCount::${JSON.stringify({ count: 2 })}`);
    expect(buttons(d, 1)).toEqual(["register.capacity.joinWaitlist"]);
    expect(textOf(capacityLine(d, 0)!), "back to one place after the entry is removed").toBe(`register.capacity.left::${JSON.stringify({ count: 1 })}`);
  });

  it("every entry kind's CTA reads Join waiting list on a full division, and still adds the entry", () => {
    const calls: string[] = [];
    const handlers = { onAddTeam: () => calls.push("team"), onAddPair: () => calls.push("pair"), onAddIndividual: () => calls.push("individual") };
    let checked = 0;
    for (const kind of ["team", "pair", "individual"] as const) {
      const tree = render({ entrant_kind: kind, remaining: 0, closed_reason: "full" }, 0, handlers);
      const cta = tree.filter((el) => el.type === "button");
      expect(cta.map((el) => textOf(el)), kind).toEqual(["register.capacity.joinWaitlist"]);
      (propsOf(cta[0]!).onClick as () => void)();
      checked += 1;
    }
    expect(calls, "each kind's own handler ran").toEqual(["team", "pair", "individual"]);
    expect(checked).toBe(3);
  });

  it("a solo sign-up button stays as it was on a full team division: solo entries are never waitlisted", () => {
    const labels = buttons({ allow_free_agents: true, remaining: 0, closed_reason: "full" }, 0, { onAddTeam: () => {}, onAddSoloSignup: () => {} });
    expect(labels).toEqual(["register.capacity.joinWaitlist", "register.entries.add.soloSignup"]);
  });

  it("a closed division has no capacity line and no CTA at all (absent, not disabled)", () => {
    // The standing contract: registration-entrant-kinds.spec.ts pins `closedCard.getByRole("button")` to 0.
    for (const d of [
      { open: false, closed_reason: "window", capacity: 32, remaining: 28 },
      { open: false, closed_reason: "window", capacity: 8, remaining: 0, waitlisted: 3 },
      { open: false, closed_reason: "entry_kind_unavailable", capacity: 8, remaining: 2 },
      { open: false, closed_reason: "payments_unavailable", capacity: null, remaining: null },
    ]) {
      expect(capacityLine(d), JSON.stringify(d)).toBeUndefined();
      expect(buttons(d), JSON.stringify(d)).toEqual([]);
    }
    // Positive pair: the same card open has both.
    expect(capacityLine({ capacity: 8, remaining: 2 })).toBeDefined();
    expect(buttons({ capacity: 8, remaining: 2 })).toEqual(["register.entries.add.team"]);
  });

  it("an open card keeps the entry kind's own Add copy", () => {
    expect(buttons({ remaining: 10, capacity: 32 })).toEqual(["register.entries.add.team"]);
    expect(buttons({ entrant_kind: "pair", remaining: 10 }, 0, { onAddPair: () => {} })).toEqual(["register.entries.add.pair"]);
    expect(buttons({ entrant_kind: "individual", capacity: null, remaining: null }, 0, { onAddIndividual: () => {} })).toEqual(["register.entries.add.individual"]);
  });
});

// The copy itself, from the four dictionaries through the real runtime (the mock above only shows keys). English is the brief's
// own wording; the other locales must carry the same placeholders, so a count never renders as a literal "{count}".
describe("capacity copy — all four locales, through the real plural and interpolation runtime (B3 T12)", () => {
  const LOCALES = ["en", "es", "fr", "nl"] as const;
  const DICTS = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
  ) as Record<(typeof LOCALES)[number], Dict>;

  it("English reads exactly as briefed", () => {
    const en = DICTS.en;
    expect(pluralRuntime(en, "register.capacity.left", 1, "en")).toBe("1 place left");
    expect(pluralRuntime(en, "register.capacity.left", 3, "en")).toBe("3 places left");
    expect(tRuntime(en, "register.capacity.fullWaitlist")).toBe("Full · join the waiting list");
    expect(tRuntime(en, "register.capacity.fullWaitlistCount", { count: 3 })).toBe("Full · join the waiting list (3 waiting)");
    expect(tRuntime(en, "register.capacity.joinWaitlist")).toBe("Join waiting list");
    expect(tRuntime(en, "register.cart.waitlistLine")).toBe("Waiting list — not charged now");
  });

  it("every locale has every key, a count where one is rendered, and no key left in place of its text", () => {
    let checked = 0;
    for (const l of LOCALES) {
      const d = DICTS[l];
      for (const n of [1, 2, 3]) {
        const text = pluralRuntime(d, "register.capacity.left", n, l);
        expect(text, `${l} left x${n}`).toContain(String(n));
        expect(text, `${l} left x${n} is real copy`).not.toMatch(/register\.|\{count\}/);
        checked += 1;
      }
      const withCount = tRuntime(d, "register.capacity.fullWaitlistCount", { count: 7 });
      expect(withCount, `${l} fullWaitlistCount`).toContain("7");
      expect(withCount).not.toMatch(/register\.|\{count\}/);
      for (const key of ["register.capacity.fullWaitlist", "register.capacity.joinWaitlist", "register.cart.waitlistLine"] as const) {
        const text = tRuntime(d, key);
        expect(text, `${l} ${key}`).not.toBe(key);
        expect(text.trim(), `${l} ${key}`).not.toBe("");
        checked += 1;
      }
      checked += 1;
    }
    expect(checked, "anti-vacuity: 4 locales x (3 plural forms + the count line + 3 plain keys)").toBe(4 * 7);
  });

  it("the old keys are gone from every locale (nothing reads them any more)", () => {
    for (const l of LOCALES) {
      for (const key of ["register.capacity.taken", "register.entries.badge.waitlist", "register.entries.cart.waitlistNote"]) {
        expect(JSON.stringify(DICTS[l]).includes(`"${key}"`), `${l} ${key}`).toBe(false);
      }
    }
  });
});
