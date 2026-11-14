// The /start wizard's state and its POST body (start-wizard redesign, plan 2026-11-13 Task 4): the pure half of the stepped
// night wizard (B1 Sport → B2 Size and format → B3 Date → B4 Email → Sent), so every step rule and the body it posts are
// witnessed without a DOM (apps/web vitest is `environment: "node"`).
//
// Expected values never come from the model: the bounds are the start route's own schema (lib/funnel.ts, server-only, so
// the wizard restates them and this file pins the restatement), the format cards and Best fit are T1's reviewed layer
// (rankFormats / bestFitSlug over the sport's own match length), the sports and their catalogue names are FUNNEL_SPORTS
// (pinned to the catalogue writer by T1), the calendar rows are typed off a calendar, the format and sport words are the
// dictionaries on disk, and the email rule is zod's, which the start route runs.
//
// Sequence (TEST-STRATEGY §1, §10): a second send after "Change it", an empty input (a cleared size box, a blank name, no
// date, nothing fits), and every funnel sport. No withdrawal or void exists before the event is built: not applicable.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { funnelPayloadSchema } from "@/lib/funnel";
import { FUNNEL_SPORTS, funnelSportMatchMinutes, type FunnelSport } from "@/lib/funnel-sports";
import { FUNNEL_FORMATS, FUNNEL_MORE_FORMATS, funnelFormatMin, funnelFormatStages, type FunnelFormat } from "@/lib/funnel-formats";
import { bestFitSlug, rankFormats } from "@/lib/format-recommend";
import { detectTemplate } from "@/lib/format-templates";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { parseStartPrefill } from "@/app/[lang]/(marketing)/start/prefill";
import {
  FORMAT_NAME_KEY,
  FORMAT_TAGLINE_KEY,
  WIZARD_BOUNDS,
  WIZARD_DEFAULTS,
  WIZARD_STEPS,
  buildFunnelBody,
  canAdvance,
  heldStart,
  sendBody,
  initialWizardState,
  nextEventDays,
  parseCount,
  plausibleEmail,
  sportLabelKey,
  wizardCards,
  wizardField,
  wizardReducer,
  wizardQuery,
  wizardToday,
  type WizardAction,
  type WizardContext,
  type WizardState,
} from "../start-wizard-model";

const ALL_FORMATS: readonly FunnelFormat[] = [...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS];
const TODAY = "2026-11-12";
const CTX: WizardContext = { maxEntrants: null, today: TODAY };
const CAPPED: WizardContext = { maxEntrants: 64, today: TODAY };
const NO_PREFILL = parseStartPrefill({}, TODAY);

/** The start route's body, as `app/api/funnel/start/route.ts` declares it: its own email and locale over the payload. */
const ROUTE_BODY = z
  .object({ email: z.string().email().max(120), locale: z.enum(LOCALES).optional().catch(undefined) })
  .extend(funnelPayloadSchema.shape)
  .strict();
const ALLOWED_KEYS = new Set(["email", "locale", "name", "sport", "entrants", "start_date", "format", "courts", "hours"]);

const sportOf = (key: string): FunnelSport => {
  const s = FUNNEL_SPORTS.find((x) => x.key === key);
  if (!s) throw new Error(`premise: ${key} is a funnel sport`);
  return s;
};
/** T1's cards for these inputs, at the sport's own match length: the authority the wizard shows. */
const t1Cards = (sportKey: string, entrants: number, courts: number, hours: number) =>
  rankFormats({ entrants, courts, hours, matchMinutes: funnelSportMatchMinutes(sportOf(sportKey)) });

const run = (s: WizardState, actions: readonly WizardAction[], ctx: WizardContext = CTX): WizardState =>
  actions.reduce((acc, a) => wizardReducer(acc, a, ctx), s);

const dict = (locale: Locale, file: "ui" | "marketing"): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../dictionaries", locale, `${file}.json`), "utf8")) as Record<string, unknown>;

describe("the wizard's bounds are the start route's own", () => {
  // lib/funnel.ts is server-only: the island cannot import the schema, so it restates the bounds. Each restated bound is
  // parsed AT the bound (accepted) and one past it (refused) through the route's schema, so a narrower or wider wizard reds.
  it("entrants, courts and hours: each bound is accepted and one past it is refused", () => {
    let checked = 0;
    for (const field of ["entrants", "courts", "hours"] as const) {
      const { min, max } = WIZARD_BOUNDS[field];
      const shape = funnelPayloadSchema.shape[field];
      for (const v of [min, max]) {
        const s = run(initialWizardState(NO_PREFILL, CTX), [{ type: "planning" }, { type: field, value: v }]);
        expect(s[field], `${field} ${v} is reachable`).toBe(v);
        const body = buildFunnelBody({ ...s, email: "sam@harbourvale.org" }, "en", "Badminton tournament");
        expect(ROUTE_BODY.safeParse(body).success, `${field} = ${v} is a body the route takes`).toBe(true);
        checked++;
      }
      expect(shape.safeParse(min - 1).success, `${field} ${min - 1} is refused by the route`).toBe(false);
      expect(shape.safeParse(max + 1).success, `${field} ${max + 1} is refused by the route`).toBe(false);
      checked += 2;
    }
    expect(checked).toBe(12);
  });

  it("a value past a bound, a fraction or a cleared box never leaves the wizard's range (the cards are never empty)", () => {
    let checked = 0;
    for (const field of ["entrants", "courts", "hours"] as const) {
      const { min, max } = WIZARD_BOUNDS[field];
      for (const raw of [min - 1, max + 1, 0, -5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
        const s = run(initialWizardState(NO_PREFILL, CTX), [{ type: "planning" }, { type: field, value: raw }]);
        expect(Number.isInteger(s[field]), `${field} ${raw} stays whole`).toBe(true);
        expect(s[field]).toBeGreaterThanOrEqual(min);
        expect(s[field]).toBeLessThanOrEqual(max);
        expect(wizardCards(s, CTX).length, `${field} ${raw}: cards still drawn`).toBe(ALL_FORMATS.length);
        checked++;
      }
    }
    expect(checked).toBe(24);
  });

  it("a count box while typing: plain digits in range count, above the top reads as the top, anything else is no count yet", () => {
    const b = WIZARD_BOUNDS.entrants;
    const rows: [string, number | null][] = [
      ["12", 12], [" 24 ", 24], [String(b.min), b.min], [String(b.max), b.max], ["300", b.max], ["99999999999999999999", b.max],
      ["1", null], ["0", null], ["", null], ["  ", null], ["-5", null], ["+5", null], ["2.5", null], ["1e2", null], ["0x10", null], ["12abc", null],
    ];
    for (const [raw, want] of rows) expect(parseCount(raw, b), JSON.stringify(raw)).toBe(want);
    expect(parseCount("1", WIZARD_BOUNDS.courts), "one court is a count").toBe(1);
  });

  it("a name longer than the route takes is cut at its limit", () => {
    const s = run(initialWizardState(NO_PREFILL, CTX), [{ type: "name", value: "x".repeat(250) }, { type: "email", value: "sam@harbourvale.org" }]);
    expect(s.name.length).toBe(funnelPayloadSchema.shape.name.maxLength);
    expect(ROUTE_BODY.safeParse(buildFunnelBody(s, "en", "x")).success).toBe(true);
  });

  it("the defaults lie inside the bounds and are the mock's (Badminton, 16, 2 courts, 4 hours)", () => {
    expect(WIZARD_DEFAULTS).toEqual({ sportKey: "badminton", entrants: 16, courts: 2, hours: 4 });
    for (const field of ["entrants", "courts", "hours"] as const) {
      expect(WIZARD_DEFAULTS[field]).toBeGreaterThanOrEqual(WIZARD_BOUNDS[field].min);
      expect(WIZARD_DEFAULTS[field]).toBeLessThanOrEqual(WIZARD_BOUNDS[field].max);
    }
  });
});

describe("the body is POST-compatible", () => {
  it("every funnel sport: its catalogue name, only the allowed keys, and no courts or hours while Planning was never opened", () => {
    let checked = 0;
    for (const sport of FUNNEL_SPORTS) {
      const s = run(initialWizardState(NO_PREFILL, CTX), [{ type: "sport", key: sport.key }, { type: "email", value: "sam@harbourvale.org" }]);
      const body = buildFunnelBody(s, "es", "Torneo");
      expect(Object.keys(body).every((k) => ALLOWED_KEYS.has(k)), `${sport.key}: keys ${Object.keys(body)}`).toBe(true);
      expect(body.sport, `${sport.key} posts the catalogue name`).toBe(sport.name);
      expect(body).not.toHaveProperty("courts");
      expect(body).not.toHaveProperty("hours");
      expect(body).not.toHaveProperty("start_date");
      expect(body.locale).toBe("es");
      expect(body.entrants).toBe(WIZARD_DEFAULTS.entrants);
      expect(ROUTE_BODY.safeParse(body).success, `${sport.key}: the route takes it`).toBe(true);
      checked++;
    }
    expect(checked).toBe(FUNNEL_SPORTS.length);
  });

  it("Planning opened: courts and hours ride along; a date rides as start_date; a blank name takes the default, a typed one is trimmed", () => {
    const opened = run(initialWizardState(NO_PREFILL, CTX), [
      { type: "planning" },
      { type: "courts", value: 3 },
      { type: "hours", value: 5 },
      { type: "date", value: "2026-11-21" },
      { type: "email", value: "  sam@harbourvale.org " },
    ]);
    const body = buildFunnelBody(opened, "en", "Badminton tournament");
    expect(body).toMatchObject({ courts: 3, hours: 5, start_date: "2026-11-21", name: "Badminton tournament", email: "sam@harbourvale.org" });
    expect(ROUTE_BODY.safeParse(body).success).toBe(true);

    const named = buildFunnelBody(run(opened, [{ type: "name", value: "  Harbour Vale Winter League  " }]), "en", "x");
    expect(named.name).toBe("Harbour Vale Winter League");
    const blank = buildFunnelBody(run(opened, [{ type: "name", value: "   " }]), "en", "Badminton tournament");
    expect(blank.name, "a blank name is not posted as blank").toBe("Badminton tournament");
  });

  it("Planning opened once stays opened: its courts are what the organiser saw, even left at the defaults", () => {
    const s = run(initialWizardState(NO_PREFILL, CTX), [{ type: "planning" }, { type: "email", value: "sam@harbourvale.org" }]);
    expect(buildFunnelBody(s, "en", "x")).toMatchObject({ courts: WIZARD_DEFAULTS.courts, hours: WIZARD_DEFAULTS.hours });
    expect(run(s, [{ type: "planning" }]).planningOpen, "a second open is still open").toBe(true);
  });

  it("the format is posted only while the field meets its minimum (a crafted state never posts a format the claim refuses)", () => {
    const s = run(initialWizardState(NO_PREFILL, CTX), [{ type: "entrants", value: 12 }, { type: "format", slug: "groups-knockout" }]);
    expect(buildFunnelBody(s, "en", "x").format).toBe("groups-knockout");
    const below = { ...s, entrants: funnelFormatMin("groups-knockout") - 1 };
    expect(buildFunnelBody(below, "en", "x")).not.toHaveProperty("format");
    expect(buildFunnelBody({ ...s, format: null }, "en", "x")).not.toHaveProperty("format");
  });
});

describe("preselection is honest", () => {
  it("nothing fits (40 players, 2 courts, 4 hours): no format chosen, and Next stays shut until a card is picked", () => {
    const s = initialWizardState(parseStartPrefill({ entrants: "40" }, TODAY), CTX);
    expect(bestFitSlug(t1Cards("badminton", 40, 2, 4)), "premise: T1 says nothing fits").toBeNull();
    expect(s.format).toBeNull();
    const atSize = run(s, [{ type: "next" }]);
    expect(atSize.step).toBe("size");
    expect(canAdvance(atSize, CTX)).toBe(false);
    const picked = run(atSize, [{ type: "format", slug: "league" }]);
    expect(picked.format).toBe("league");
    expect(canAdvance(picked, CTX), "League is always offered and buildable").toBe(true);
  });

  it("12 players, 4 courts, 6 hours: Swiss, the mock A2 pick, follows the organiser's inputs while nothing is picked", () => {
    const s = run(initialWizardState(parseStartPrefill({ entrants: "12" }, TODAY), CTX), [
      { type: "planning" },
      { type: "courts", value: 4 },
      { type: "hours", value: 6 },
    ]);
    expect(s.format).toBe("swiss");
    expect(s.formatPicked).toBe(false);
  });

  it("a format from the link wins when it can be built, and is dropped when the field is below its minimum", () => {
    const fromDraw = initialWizardState(parseStartPrefill({ sport: "Football", entrants: "16", format: "groups-knockout" }, TODAY), CTX);
    expect(fromDraw).toMatchObject({ sportKey: "football", entrants: 16, format: "groups-knockout", formatPicked: true });

    const tooSmall = initialWizardState(parseStartPrefill({ entrants: "3", format: "groups-knockout" }, TODAY), CTX);
    expect(funnelFormatMin("groups-knockout"), "premise: 3 is below Groups + knockout's minimum").toBeGreaterThan(3);
    expect(tooSmall.formatPicked).toBe(false);
    expect(tooSmall.format).toBe(bestFitSlug(t1Cards("badminton", 3, 2, 4)));
    expect(tooSmall.format).not.toBe("groups-knockout");
  });

  it("the badge is never on a card that runs over: the unpicked selection is T1's Best fit at every size, sport and plan", () => {
    let checked = 0;
    for (const sport of FUNNEL_SPORTS) {
      for (const entrants of [2, 3, 4, 7, 12, 16, 33, 64, 65, 200, 256]) {
        for (const ctx of [CTX, CAPPED]) {
          const s = run(initialWizardState(NO_PREFILL, ctx), [{ type: "sport", key: sport.key }, { type: "entrants", value: entrants }], ctx);
          const field = ctx.maxEntrants !== null && entrants > ctx.maxEntrants ? ctx.maxEntrants : entrants;
          expect(s.format, `${sport.key} ${entrants} cap ${ctx.maxEntrants}`).toBe(bestFitSlug(t1Cards(sport.key, field, 2, 4)));
          checked++;
        }
      }
    }
    expect(checked).toBe(FUNNEL_SPORTS.length * 11 * 2);
  });
});

describe("a pick sticks; an unpicked selection follows", () => {
  it("picking League holds through a new size, new courts and a new sport (sequence: B2 → B1 → B2)", () => {
    const s = run(initialWizardState(NO_PREFILL, CTX), [
      { type: "next" },
      { type: "format", slug: "league" },
      { type: "entrants", value: 8 },
      { type: "planning" },
      { type: "courts", value: 6 },
      { type: "back" },
      { type: "sport", key: "football" },
      { type: "next" },
    ]);
    expect(s).toMatchObject({ step: "size", sportKey: "football", entrants: 8, courts: 6, format: "league", formatPicked: true });
  });

  it("a card that cannot be built is not picked, and a pick the field then outgrows blocks Next until the field returns", () => {
    const small = run(initialWizardState(NO_PREFILL, CTX), [{ type: "next" }, { type: "entrants", value: 3 }]);
    const refused = run(small, [{ type: "format", slug: "groups-knockout" }]);
    expect(refused.format, "a disabled card is not picked").toBe(small.format);
    expect(refused.formatPicked).toBe(false);

    const picked = run(initialWizardState(NO_PREFILL, CTX), [{ type: "next" }, { type: "format", slug: "groups-knockout" }]);
    expect(canAdvance(picked, CTX)).toBe(true);
    const shrunk = run(picked, [{ type: "entrants", value: 3 }]);
    expect(shrunk.format, "the pick is kept, not silently swapped").toBe("groups-knockout");
    expect(canAdvance(shrunk, CTX), "but it cannot be built at 3").toBe(false);
    expect(run(shrunk, [{ type: "next" }]).step, "Next is refused").toBe("size");
    expect(canAdvance(run(shrunk, [{ type: "entrants", value: 4 }]), CTX)).toBe(true);
  });

  it("canAdvance at size: false with no format, true with League at the smallest field", () => {
    const none = { ...run(initialWizardState(NO_PREFILL, CTX), [{ type: "next" }]), format: null, formatPicked: false };
    expect(canAdvance(none, CTX)).toBe(false);
    const two = run(initialWizardState(NO_PREFILL, CTX), [{ type: "next" }, { type: "entrants", value: 2 }, { type: "format", slug: "league" }]);
    expect(two.entrants).toBe(WIZARD_BOUNDS.entrants.min);
    expect(canAdvance(two, CTX)).toBe(true);
  });
});

describe("above the plan's cap the cards count the field the claim will build", () => {
  it("the field is the cap when the size is above it, the size otherwise; a cap that holds no draw is not one", () => {
    expect(wizardField(100, 64)).toBe(64);
    expect(wizardField(64, 64)).toBe(64);
    expect(wizardField(10, 64)).toBe(10);
    expect(wizardField(100, null), "unlimited").toBe(100);
    // "Cannot happen" (the catalogue holds no plan under 2), held as a guard: a cap under a draw's minimum is ignored.
    expect(wizardField(100, 1)).toBe(100);
    expect(wizardField(100, 0)).toBe(100);
  });

  it("100 asked on a 64 cap: the cards are T1's at 64, the body still asks for 100 (the claim clamps to the org's own cap)", () => {
    const s = run(initialWizardState(NO_PREFILL, CAPPED), [{ type: "entrants", value: 100 }, { type: "email", value: "sam@harbourvale.org" }], CAPPED);
    expect(wizardCards(s, CAPPED)).toEqual(t1Cards("badminton", 64, 2, 4));
    expect(wizardCards(s, CAPPED)).not.toEqual(t1Cards("badminton", 100, 2, 4));
    expect(buildFunnelBody(s, "en", "x").entrants).toBe(100);
  });
});

describe("steps", () => {
  it("four steps then Sent: forward only when the step can advance, back one at a time, and Sent only from Email", () => {
    expect(WIZARD_STEPS).toEqual(["sport", "size", "date", "email"]);
    let s = initialWizardState(NO_PREFILL, CTX);
    expect(s.step).toBe("sport");
    expect(run(s, [{ type: "back" }]).step, "nothing before Sport").toBe("sport");
    expect(run(s, [{ type: "sent" }]).step, "Sent only from Email").toBe("sport");
    s = run(s, [{ type: "next" }, { type: "next" }, { type: "next" }]);
    expect(s.step).toBe("email");
    expect(canAdvance(s, CTX), "no address yet").toBe(false);
    expect(run(s, [{ type: "next" }]).step, "Next at Email does not send").toBe("email");
    s = run(s, [{ type: "email", value: "sam@harbourvale.org" }]);
    expect(canAdvance(s, CTX)).toBe(true);
    const sent = run(s, [{ type: "sent" }]);
    expect(sent.step).toBe("sent");
    expect(canAdvance(sent, CTX)).toBe(false);
    expect(run(sent, [{ type: "back" }]).step, "Back does not leave Sent").toBe("sent");
    expect(run(s, [{ type: "back" }, { type: "back" }, { type: "back" }, { type: "back" }]).step).toBe("sport");
  });

  it("'Wrong address? Change it' returns to Email with every answer kept, and a second send is a second Sent", () => {
    const answered = run(initialWizardState(NO_PREFILL, CTX), [
      { type: "sport", key: "tabletennis" },
      { type: "name", value: "Harbour Vale" },
      { type: "next" },
      { type: "entrants", value: 12 },
      { type: "format", slug: "knockout" },
      { type: "next" },
      { type: "date", value: "2026-11-21" },
      { type: "next" },
      { type: "email", value: "sam@harbourvale.org" },
      { type: "sent" },
    ]);
    const back = run(answered, [{ type: "changeEmail" }]);
    expect(back).toEqual({ ...answered, step: "email" });
    const resent = run(back, [{ type: "email", value: "sam@harbourvale.com" }, { type: "sent" }]);
    expect(resent).toEqual({ ...answered, email: "sam@harbourvale.com", step: "sent" });
    expect(run(initialWizardState(NO_PREFILL, CTX), [{ type: "changeEmail" }]).step, "Change it only from Sent").toBe("sport");
  });

  it("a date before today, or not a calendar day, is refused; Not sure yet clears it", () => {
    const s = initialWizardState(NO_PREFILL, CTX);
    expect(run(s, [{ type: "date", value: "2026-11-11" }]).date, "yesterday").toBeNull();
    expect(run(s, [{ type: "date", value: "2026-02-30" }]).date).toBeNull();
    expect(run(s, [{ type: "date", value: "21/11/2026" }]).date).toBeNull();
    expect(run(s, [{ type: "date", value: TODAY }]).date, "today is a day still to come").toBe(TODAY);
    expect(run(s, [{ type: "date", value: "2026-11-21" }, { type: "date", value: null }]).date).toBeNull();
  });

  it("an unknown sport key is refused, never stored", () => {
    const s = initialWizardState(NO_PREFILL, CTX);
    for (const key of ["", "quidditch", "Badminton", "generic", "<script>"]) {
      expect(run(s, [{ type: "sport", key }]).sportKey, key).toBe("badminton");
    }
  });

  it("the link's sport opens B1 on it; no sport opens Badminton", () => {
    expect(initialWizardState(parseStartPrefill({ sport: "tabletennis" }, TODAY), CTX).sportKey).toBe("tabletennis");
    expect(initialWizardState(parseStartPrefill({ sport: "Ice Hockey" }, TODAY), CTX).sportKey).toBe("icehockey");
    expect(initialWizardState(NO_PREFILL, CTX).sportKey).toBe("badminton");
    expect(initialWizardState(parseStartPrefill({ date: "2026-11-21" }, TODAY), CTX).date).toBe("2026-11-21");
  });
});

describe("the date chips (mock B3): next Saturday and Sunday strictly after today, then the Saturday after", () => {
  it("calendar rows", () => {
    // Typed off a calendar: 2026-11-13 is a Friday.
    const rows: [string, string[]][] = [
      ["2026-11-13", ["2026-11-14", "2026-11-15", "2026-11-21"]], // Friday
      ["2026-11-14", ["2026-11-21", "2026-11-22", "2026-11-28"]], // Saturday
      ["2026-11-15", ["2026-11-21", "2026-11-22", "2026-11-28"]], // Sunday
      ["2026-12-30", ["2027-01-02", "2027-01-03", "2027-01-09"]], // Wednesday, year end
      ["2028-02-25", ["2028-02-26", "2028-02-27", "2028-03-04"]], // Friday before a leap day
    ];
    for (const [today, want] of rows) expect(nextEventDays(today), today).toEqual(want);
  });

  it("every day of two years: Saturday, the Sunday after it, the next Saturday; the first within a week, after today", () => {
    let checked = 0;
    for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2027, 11, 31); t += 86_400_000) {
      const today = new Date(t).toISOString().slice(0, 10);
      const [sat, sun, sat2] = nextEventDays(today).map((d) => Date.parse(`${d}T00:00:00Z`));
      expect([new Date(sat!).getUTCDay(), new Date(sun!).getUTCDay(), new Date(sat2!).getUTCDay()]).toEqual([6, 0, 6]);
      expect(sat! > t && sat! - t <= 7 * 86_400_000, today).toBe(true);
      expect(sun! - sat!).toBe(86_400_000);
      expect(sat2! - sat!).toBe(7 * 86_400_000);
      checked++;
    }
    expect(checked).toBe(730);
  });

  it("refuses a today that is not a calendar day", () => {
    expect(() => nextEventDays("2026-02-30")).toThrow(/today/);
  });
});

describe("the page's today: the server's UTC day less one", () => {
  // A same-day `date=` from a visitor west of UTC must not be dropped (review-t3 m3), so the earliest day is yesterday in UTC.
  it("rows", () => {
    expect(wizardToday(new Date("2026-11-13T00:30:00Z"))).toBe("2026-11-12");
    expect(wizardToday(new Date("2026-11-13T23:59:59Z"))).toBe("2026-11-12");
    expect(wizardToday(new Date("2027-01-01T05:00:00Z"))).toBe("2026-12-31");
    expect(wizardToday(new Date("2028-03-01T12:00:00Z"))).toBe("2028-02-29");
  });
});

describe("the email check says what is wrong before anything is sent (mock A3)", () => {
  it("rows", () => {
    expect(plausibleEmail("sam@harbourvale")).toBe("missingTld");
    expect(plausibleEmail("x")).toBe("invalid");
    expect(plausibleEmail("")).toBe("invalid");
    expect(plausibleEmail("sam@harbourvale.org")).toBe("ok");
    expect(plausibleEmail("  sam@harbourvale.org  "), "padding is not the address").toBe("ok");
    expect(plausibleEmail("sam@@harbourvale.org")).toBe("invalid");
  });

  it("'ok' is exactly what the start route takes (zod's email, 120 at most): no send can be refused for its address", () => {
    const route = ROUTE_BODY.shape.email;
    const corpus = [
      "sam@harbourvale.org", "a@b.co", "a@b.c", "first.last+tag@sub.club.org", "sam@harbourvale", "sam@", "@harbourvale.org",
      "sam harbour@vale.org", "sam@harbour vale.org", ".sam@vale.org", "sam..x@vale.org", "sam@vale..org", "sam@-vale.org",
      "sam@vale.org.", "sam@vale.o", "sam@vale.123", "émile@vale.org", "sam@välé.org", `${"a".repeat(110)}@vale.org`,
      `${"a".repeat(111)}@vale.org`, "SAM@VALE.ORG", "sam@localhost", "sam.vale.org", "x", "", " ", "sam@vale.org\n",
    ];
    let checked = 0;
    for (const raw of corpus) {
      expect(plausibleEmail(raw) === "ok", JSON.stringify(raw)).toBe(route.safeParse(raw.trim()).success);
      checked++;
    }
    expect(checked).toBe(corpus.length);
    expect(corpus.filter((c) => plausibleEmail(c) === "ok").length, "anti-vacuity: some pass").toBeGreaterThan(2);
    expect(corpus.filter((c) => plausibleEmail(c) === "missingTld").length, "anti-vacuity: some miss an ending").toBeGreaterThan(1);
  });
});

describe("the words come from the dictionaries", () => {
  it("each card's name is the template the claim builds, worded in every locale; its line is the format's own tagline", () => {
    let checked = 0;
    for (const f of ALL_FORMATS) {
      const template = detectTemplate(funnelFormatStages(f, 12));
      expect(FORMAT_NAME_KEY[f], f).toBe(`format.template.${template}.label`);
      expect(FORMAT_TAGLINE_KEY[f]).toBe(`format.${f}.tagline`);
      for (const locale of LOCALES) {
        const ui = dict(locale, "ui");
        expect(typeof ui[FORMAT_NAME_KEY[f]], `${locale} ${FORMAT_NAME_KEY[f]}`).toBe("string");
        expect(typeof ui[FORMAT_TAGLINE_KEY[f]], `${locale} ${FORMAT_TAGLINE_KEY[f]}`).toBe("string");
        checked++;
      }
    }
    expect(checked).toBe(ALL_FORMATS.length * LOCALES.length);
  });

  it("each sport chip is worded in every locale: the sport's own name, or Other's", () => {
    let checked = 0;
    for (const sport of FUNNEL_SPORTS) {
      const key = sportLabelKey(sport.key);
      expect(key, sport.key).toBe(sport.module === "generic" ? "start.wizard.sportOther" : `sport.${sport.key}`);
      for (const locale of LOCALES) {
        const words = { ...dict(locale, "marketing"), ...dict(locale, "ui") };
        expect(typeof words[key], `${locale} ${key}`).toBe("string");
        checked++;
      }
    }
    expect(checked).toBe(FUNNEL_SPORTS.length * LOCALES.length);
  });
});

describe("model-based sequences (TEST-STRATEGY §10): every step keeps the wizard's rules", () => {
  const sportKeys = [...FUNNEL_SPORTS.map((s) => s.key), "quidditch", ""];
  const num = fc.oneof(fc.integer({ min: -5, max: 300 }), fc.constantFrom(Number.NaN, 2.5, Number.POSITIVE_INFINITY));
  const action: fc.Arbitrary<WizardAction> = fc.oneof(
    fc.constantFrom(...sportKeys).map((key): WizardAction => ({ type: "sport", key })),
    fc.string({ maxLength: 12 }).map((value): WizardAction => ({ type: "name", value })),
    num.map((value): WizardAction => ({ type: "entrants", value })),
    num.map((value): WizardAction => ({ type: "courts", value })),
    num.map((value): WizardAction => ({ type: "hours", value })),
    fc.constant<WizardAction>({ type: "planning" }),
    fc.constantFrom(...ALL_FORMATS).map((slug): WizardAction => ({ type: "format", slug })),
    fc.constantFrom(null, "2026-11-10", TODAY, "2026-11-21", "2026-02-30").map((value): WizardAction => ({ type: "date", value })),
    fc.constantFrom("", "sam@harbourvale", "sam@harbourvale.org").map((value): WizardAction => ({ type: "email", value })),
    fc.constantFrom<WizardAction>({ type: "next" }, { type: "back" }, { type: "sent" }, { type: "changeEmail" }),
  );

  it("bounds, the honest selection, the step gate and a route-shaped body hold after every action", () => {
    let steps = 0;
    fc.assert(
      fc.property(fc.constantFrom(CTX, CAPPED), fc.array(action, { maxLength: 30 }), (ctx, actions) => {
        let s = initialWizardState(NO_PREFILL, ctx);
        for (const a of actions) {
          const before = s;
          s = wizardReducer(s, a, ctx);
          steps++;
          for (const field of ["entrants", "courts", "hours"] as const) {
            expect(Number.isInteger(s[field]) && s[field] >= WIZARD_BOUNDS[field].min && s[field] <= WIZARD_BOUNDS[field].max).toBe(true);
          }
          expect(FUNNEL_SPORTS.some((x) => x.key === s.sportKey)).toBe(true);
          const cards = wizardCards(s, ctx);
          expect(cards.map((c) => c.slug)).toEqual(ALL_FORMATS);
          if (!s.formatPicked) expect(s.format).toBe(bestFitSlug(cards));
          expect(s.date === null || s.date >= TODAY).toBe(true);
          if (a.type === "next" && s.step !== before.step) expect(canAdvance(before, ctx)).toBe(true);
          if (s.step === "sent") expect(before.step === "email" || before.step === "sent").toBe(true);
          if (plausibleEmail(s.email) === "ok") {
            expect(ROUTE_BODY.safeParse(buildFunnelBody(s, "nl", "Toernooi")).success).toBe(true);
          }
        }
      }),
      { numRuns: 150, seed: 20261113 },
    );
    expect(steps, "anti-vacuity: actions applied").toBeGreaterThan(500);
  });
});

// The wizard's own URL (review-t4 (a)): what a refresh, a shared link or Back to /start restores. Sport, size, format,
// first day, Courts and time and the step ride the query; the organiser's name and address NEVER do (PostHog and Sentry
// record page URLs). The step is restored by replaying Next through the reducer, so canAdvance decides how far it goes.
describe("the wizard's URL: what rides it, and what a reload restores", () => {
  const reload = (s: WizardState, ctx: WizardContext) =>
    initialWizardState(parseStartPrefill(Object.fromEntries(new URLSearchParams(wizardQuery(s))), ctx.today), ctx);
  const restored = (s: WizardState) => ({
    sportKey: s.sportKey,
    entrants: s.entrants,
    format: s.format,
    formatPicked: s.formatPicked,
    date: s.date,
    planningOpen: s.planningOpen,
    courts: s.courts,
    hours: s.hours,
    step: s.step === "sent" ? "email" : s.step,
  });

  it("a walk's query names exactly its answers, never the name or the address", () => {
    let s = initialWizardState(NO_PREFILL, CAPPED);
    for (const a of [
      { type: "sport", key: "tabletennis" },
      { type: "name", value: "Harbour Vale Open" },
      { type: "next" },
      { type: "entrants", value: 24 },
      { type: "planning" },
      { type: "courts", value: 3 },
      { type: "hours", value: 6 },
      { type: "format", slug: "knockout" },
      { type: "next" },
      { type: "date", value: "2026-11-21" },
      { type: "next" },
      { type: "email", value: "sam@harbourvale.org" },
    ] as WizardAction[]) {
      s = wizardReducer(s, a, CAPPED);
    }
    expect(s.step, "premise: the walk reached B4").toBe("email");
    const q = new URLSearchParams(wizardQuery(s));
    expect(Object.fromEntries(q)).toEqual({
      sport: "tabletennis",
      entrants: "24",
      format: "knockout",
      date: "2026-11-21",
      courts: "3",
      hours: "6",
      step: "email",
    });
    expect(wizardQuery(s)).not.toMatch(/harbour|sam|name|email=/i);
    // Sent keeps the email step's query: Sent itself is never restored (there is no address to have sent to).
    expect(wizardQuery(wizardReducer(s, { type: "sent" }, CAPPED))).toBe(wizardQuery(s));
  });

  it("the empty case: the opening state's query is the sport and the size alone (Planning shut, nothing picked, no date)", () => {
    const s = initialWizardState(NO_PREFILL, CTX);
    expect(Object.fromEntries(new URLSearchParams(wizardQuery(s)))).toEqual({ sport: WIZARD_DEFAULTS.sportKey, entrants: String(WIZARD_DEFAULTS.entrants) });
    expect(reload(s, CTX)).toEqual(s);
  });

  /** The step each answer's control is on (Next, Back, Sent and Change it are on every step that shows them). */
  const ON_STEP: Partial<Record<WizardAction["type"], WizardState["step"]>> = {
    sport: "sport",
    name: "sport",
    entrants: "size",
    courts: "size",
    hours: "size",
    planning: "size",
    format: "size",
    date: "date",
    email: "email",
  };

  it("round trip: every state a random walk reaches reloads to the same answers and step (property)", () => {
    const action = fc.oneof(
      fc.constantFrom(...FUNNEL_SPORTS.map((x) => x.key)).map((key): WizardAction => ({ type: "sport", key })),
      fc.integer({ min: 2, max: 256 }).map((value): WizardAction => ({ type: "entrants", value })),
      fc.integer({ min: 1, max: 32 }).map((value): WizardAction => ({ type: "courts", value })),
      fc.integer({ min: 1, max: 72 }).map((value): WizardAction => ({ type: "hours", value })),
      fc.constant<WizardAction>({ type: "planning" }),
      fc.constantFrom(...ALL_FORMATS).map((slug): WizardAction => ({ type: "format", slug })),
      fc.constantFrom(null, ...nextEventDays(TODAY), "2026-12-24").map((value): WizardAction => ({ type: "date", value })),
      fc.string({ maxLength: 12 }).map((value): WizardAction => ({ type: "name", value })),
      fc.constantFrom("sam@harbourvale.org", "x").map((value): WizardAction => ({ type: "email", value })),
      // Weighted: an organiser mostly goes forward, and the email step must be reached to be checked.
      { arbitrary: fc.constant<WizardAction>({ type: "next" }), weight: 12 },
      fc.constant<WizardAction>({ type: "back" }),
      fc.constant<WizardAction>({ type: "sent" }),
    );
    let states = 0;
    const steps = new Set<string>();
    fc.assert(
      fc.property(fc.constantFrom(CTX, CAPPED), fc.array(action, { maxLength: 40 }), (ctx, actions) => {
        let s = initialWizardState(NO_PREFILL, ctx);
        for (const a of actions) {
          // As the island: each control lives on its own step (the size box on Size, the chips on Date), and the courts
          // and hours steppers inside the fold that opening dispatches Planning.
          const home = ON_STEP[a.type];
          if (home !== undefined && home !== s.step) continue;
          if (a.type === "courts" || a.type === "hours") s = wizardReducer(s, { type: "planning" }, ctx);
          s = wizardReducer(s, a, ctx);
          const back = reload(s, ctx);
          expect(restored(back)).toEqual(restored(s));
          expect(back.name, "the name never rides the URL").toBe("");
          expect(back.email, "the address never rides the URL").toBe("");
          steps.add(s.step);
          states++;
        }
      }),
      { numRuns: 250, seed: 20261113 },
    );
    expect(states, "anti-vacuity: states checked").toBeGreaterThan(800);
    expect([...steps].sort(), "every step was reached and reloaded (Sent as its email step)").toEqual(["date", "email", "sent", "size", "sport"]);
  });

  it("a step the answers cannot leave is where the replay stops: nothing fits at 40, so ?step=email opens on Size", () => {
    expect(bestFitSlug(rankFormats({ entrants: 40, courts: 2, hours: 4, matchMinutes: funnelSportMatchMinutes(FUNNEL_SPORTS.find((x) => x.key === "badminton")!) })), "premise").toBeNull();
    const rows: [string, Record<string, string>, string][] = [
      ["nothing chosen at 40", { entrants: "40", step: "email" }, "size"],
      ["League at 40 can leave Size", { entrants: "40", format: "league", step: "email" }, "email"],
      ["date only", { step: "date" }, "date"],
      ["size only", { step: "size" }, "size"],
      ["no step", {}, "sport"],
    ];
    for (const [label, sp, want] of rows) {
      expect(initialWizardState(parseStartPrefill(sp, TODAY), CTX).step, label).toBe(want);
    }
    expect(rows.length).toBe(5);
  });

  it("courts or hours in the link open Planning (so they are posted); neither leaves it shut", () => {
    const rows: [Record<string, string>, boolean, number, number][] = [
      [{ courts: "5" }, true, 5, WIZARD_DEFAULTS.hours],
      [{ hours: "8" }, true, WIZARD_DEFAULTS.courts, 8],
      [{ courts: "5", hours: "8" }, true, 5, 8],
      [{ courts: "99" }, false, WIZARD_DEFAULTS.courts, WIZARD_DEFAULTS.hours],
      [{}, false, WIZARD_DEFAULTS.courts, WIZARD_DEFAULTS.hours],
    ];
    for (const [sp, open, courts, hours] of rows) {
      const s = initialWizardState(parseStartPrefill(sp, TODAY), CTX);
      expect({ open: s.planningOpen, courts: s.courts, hours: s.hours }, JSON.stringify(sp)).toEqual({ open, courts, hours });
      expect("courts" in buildFunnelBody(s, "en", "x"), JSON.stringify(sp)).toBe(open);
    }
    expect(rows.length).toBe(5);
  });
});

// Two guards the reducer and the parser cover for each other (review-t4 m2), each reached here alone by a hand-built input.
describe("guards behind guards, reached alone", () => {
  it("canAdvance at Date refuses a date before today or not a day, though the reducer never lets one in", () => {
    const at = { ...initialWizardState(NO_PREFILL, CTX), step: "date" } as WizardState;
    const rows: [string | null, boolean][] = [
      [null, true],
      [TODAY, true],
      ["2026-11-11", false],
      ["2026-02-30", false],
      ["soon", false],
    ];
    for (const [date, want] of rows) expect(canAdvance({ ...at, date }, CTX), String(date)).toBe(want);
    expect(rows.length).toBe(5);
  });

  it("initialWizardState drops a prefill date before today, though the parser never hands one", () => {
    const rows: [string, string | null][] = [
      ["2026-11-11", null],
      ["2026-02-30", null],
      [TODAY, TODAY],
    ];
    for (const [date, want] of rows) expect(initialWizardState({ ...NO_PREFILL, date }, CTX).date, date).toBe(want);
    expect(rows.length).toBe(3);
  });
});

// The Change-email flow (/start "Sent stepper", owner 2026-11-14): the start route answers a `reference` and a `replaceKey`;
// every resend carries both back, so the draft the first send wrote is replaced although the address changed. The route's own
// rule for the pair (app/api/funnel/start/route.ts): `previousReference` the SZ- shape, `replaceKey` 32 to 100 characters, both
// or neither. The DB half (the pair through the real route) is wizard-body-claim.test.ts.
describe("the replace pair a resend carries", () => {
  const ROUTE_PAIR = z
    .object({ previousReference: z.string().regex(/^SZ-[2-9A-HJ-NP-Z]{6}$/).optional(), replaceKey: z.string().min(32).max(100).optional() })
    .refine((b) => (b.previousReference === undefined) === (b.replaceKey === undefined));
  const KEY = "k".repeat(43);

  it("is held only when the answer carries both halves", () => {
    const rows: [unknown, ReturnType<typeof heldStart>][] = [
      [{ message: "x", reference: "SZ-4K7Q2M", replaceKey: KEY }, { reference: "SZ-4K7Q2M", replaceKey: KEY }],
      [{ message: "x", reference: "SZ-4K7Q2M" }, null],
      [{ message: "x", replaceKey: KEY }, null],
      [{ message: "x" }, null],
      [{ reference: 7, replaceKey: KEY }, null],
      [undefined, null],
      [null, null],
      ["SZ-4K7Q2M", null],
    ];
    for (const [answer, want] of rows) expect(heldStart(answer), JSON.stringify(answer)).toEqual(want);
    expect(rows.length).toBe(8);
  });

  it("the first send carries no pair; a resend carries both, beside an unchanged body; the route's rule takes either", () => {
    const s = run(initialWizardState(NO_PREFILL, CTX), [{ type: "email", value: "sam@harbourvale.org" }]);
    const body = buildFunnelBody(s, "en", "Badminton tournament");
    const first = sendBody(body, null);
    expect(first, "the first send is the wizard's body as it was").toEqual(body);
    expect(first).not.toHaveProperty("previousReference");
    expect(first).not.toHaveProperty("replaceKey");
    const resend = sendBody({ ...body, email: "sam@harbourvale.com" }, { reference: "SZ-4K7Q2M", replaceKey: KEY });
    expect(resend).toEqual({ ...body, email: "sam@harbourvale.com", previousReference: "SZ-4K7Q2M", replaceKey: KEY });
    for (const sent of [first, resend]) {
      const { previousReference, replaceKey, ...rest } = sent as Record<string, unknown>;
      expect(ROUTE_PAIR.safeParse({ previousReference, replaceKey }).success, JSON.stringify(sent)).toBe(true);
      expect(ROUTE_BODY.safeParse(rest).success, "the rest is the route's body").toBe(true);
    }
  });
});
