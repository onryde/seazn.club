// /start's one prefill parser (start-wizard redesign, plan 2026-11-13 Task 3): every link into /start, from each of its
// producers, and the garbage a hand-edited or crafted link carries. Expected values come from each producer's own
// declaration and from the authorities the parser answers to, never from the parser:
//   - sport keys: the quick-match offer /play and the home hero both read (lib/quick-match-offer.generated.json) and the
//     wizard's own list (lib/funnel-sports.ts FUNNEL_SPORTS);
//   - formats: The Draw's (lib/marketing/formats.ts MARKETING_FORMATS) and the funnel's (lib/funnel-formats.ts);
//   - the field size: the start route's own schema (lib/funnel.ts funnelPayloadSchema.entrants), so a size the POST
//     would refuse is never prefilled.
// Every sweep counts what it checked and fails on zero.
import { describe, expect, it } from "vitest";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { funnelPayloadSchema } from "@/lib/funnel";
import { FUNNEL_FORMATS, FUNNEL_MORE_FORMATS } from "@/lib/funnel-formats";
import { FUNNEL_SPORTS } from "@/lib/funnel-sports";
import { MARKETING_FORMATS } from "@/lib/marketing/formats";
import { DRAW_ENTRANTS } from "@/components/marketing/the-draw";
import { parseStartPrefill, type StartPrefill } from "../prefill";

type SearchParams = Record<string, string | string[] | undefined>;

const TODAY = "2026-11-13";

/** `day` moved `k` whole days, in UTC: the test's own calendar, so no row's date is the parser's arithmetic. */
function addDays(day: string, k: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}

/** A link's query string as Next hands a page its `searchParams` (node_modules/next/dist/docs, page.md: `/shop?a=1&a=2`
 *  → `{ a: ['1', '2'] }`): one value is a string, a repeated key an array in link order. */
function searchParamsOf(qs: string): SearchParams {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(qs)) {
    const had = out[k];
    out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
  }
  return out;
}

const NONE: StartPrefill = { sportKey: null, entrants: null, date: null, format: null };

/** The bounds the start route's schema puts on the field size (the POST's authority). */
const ENTRANTS = funnelPayloadSchema.shape.entrants;
const MIN = ENTRANTS.minValue as number;
const MAX = ENTRANTS.maxValue as number;

/** Every sport key the quick-match offer lists: the keys /play's "Or register to start a season" link and the hero's
 *  Sport select can put in `?sport=`. */
const OFFERED_KEYS = [...new Set(offerJson.offered.map((o) => o.sport_key))];

/** Every size The Draw's stepper can reach, so every `entrants` its "Make it real" link can send. */
const DRAW_SIZES = Array.from({ length: DRAW_ENTRANTS.max - DRAW_ENTRANTS.min + 1 }, (_, i) => DRAW_ENTRANTS.min + i);

describe("parseStartPrefill", () => {
  it("the bounds it holds the size to are the start route's own", () => {
    // Premise: the schema declares both bounds, so the boundary rows below test something.
    expect(Number.isInteger(MIN)).toBe(true);
    expect(Number.isInteger(MAX)).toBe(true);
    expect(MIN).toBeLessThan(MAX);
    const rows: [string, number | null][] = [
      [String(MIN - 1), null],
      [String(MIN), MIN],
      [String(MAX), MAX],
      [String(MAX + 1), null],
    ];
    for (const [raw, want] of rows) {
      expect(parseStartPrefill({ entrants: raw }, TODAY).entrants, raw).toBe(want);
      // What the parser keeps, the POST takes: never a size the route would refuse.
      if (want !== null) expect(ENTRANTS.safeParse(want).success, raw).toBe(true);
      else expect(ENTRANTS.safeParse(Number(raw)).success, raw).toBe(false);
    }
    expect(rows.length).toBe(4);
  });

  it("the empty case: no query, a blank query and the utm-only links prefill nothing", () => {
    const rows: [string, SearchParams][] = [
      ["no query", {}],
      ["blank params", searchParamsOf("sport=&entrants=&date=&format=")],
      ["whitespace params", { sport: "  ", entrants: " ", date: "\t", format: " " }],
      // discover/page.tsx and run-your-own-cta.tsx link to /start with only campaign tags.
      ["discover", searchParamsOf("utm_source=discover&utm_medium=directory&utm_campaign=plg")],
      ["run-your-own", searchParamsOf("utm_source=me&utm_medium=player&utm_campaign=plg")],
      // Param names are exact: a capitalised name is some other param.
      ["capitalised names", searchParamsOf(`Sport=tennis&Entrants=12&Date=${addDays(TODAY, 3)}&Format=league`)],
    ];
    for (const [name, sp] of rows) expect(parseStartPrefill(sp, TODAY), name).toEqual(NONE);
    expect(rows.length).toBe(6);
  });

  it("every producer's link prefills", () => {
    const rows: { name: string; qs: string; want: StartPrefill }[] = [];
    // /play's season link and the home hero: `?sport=<offer key>` (the plan names tabletennis and icehockey).
    expect(OFFERED_KEYS).toContain("tabletennis");
    expect(OFFERED_KEYS).toContain("icehockey");
    for (const key of OFFERED_KEYS) {
      rows.push({ name: `/play ${key}`, qs: `sport=${key}`, want: { ...NONE, sportKey: key } });
    }
    // The Draw's "Make it real": `?sport=Football&entrants=<n>&format=<slug>` (the-draw.tsx), every format × size.
    for (const format of MARKETING_FORMATS) {
      for (const n of DRAW_SIZES) {
        rows.push({
          name: `the draw ${format} ${n}`,
          qs: `sport=Football&entrants=${n}&format=${format}`,
          want: { sportKey: "football", entrants: n, date: null, format },
        });
      }
    }
    // The legacy name link: `?sport=<Name>&entrants=<n>&date=<day>`.
    const d3 = addDays(TODAY, 3);
    rows.push({
      name: "legacy",
      qs: `sport=Badminton&entrants=8&date=${d3}`,
      want: { sportKey: "badminton", entrants: 8, date: d3, format: null },
    });
    // The wizard's own sports, by key or by name, in any case (Other included: it is a funnel sport).
    for (const s of FUNNEL_SPORTS) {
      for (const raw of [s.key, s.name, s.name.toLowerCase(), s.key.toUpperCase()]) {
        rows.push({ name: `funnel ${raw}`, qs: `sport=${encodeURIComponent(raw)}`, want: { ...NONE, sportKey: s.key } });
      }
    }

    let checked = 0;
    for (const r of rows) {
      expect(parseStartPrefill(searchParamsOf(r.qs), TODAY), r.name).toEqual(r.want);
      checked++;
    }
    expect(OFFERED_KEYS.length).toBeGreaterThan(0);
    expect(MARKETING_FORMATS.length).toBeGreaterThan(0);
    expect(FUNNEL_SPORTS.length).toBeGreaterThan(1);
    expect(checked).toBe(OFFERED_KEYS.length + MARKETING_FORMATS.length * DRAW_SIZES.length + 1 + FUNNEL_SPORTS.length * 4);
  });

  it("every funnel format prefills itself, in any case and padding", () => {
    const all = [...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS];
    let checked = 0;
    for (const f of all) {
      for (const raw of [f, f.toUpperCase(), `  ${f} `]) {
        expect(parseStartPrefill({ format: raw }, TODAY).format, raw).toBe(f);
        checked++;
      }
    }
    expect(all.length).toBeGreaterThan(0);
    expect(checked).toBe(all.length * 3);
  });

  // One valid link, then one field at a time made hostile: that field alone is dropped, the other three still prefill
  // (an over-refusing parser that drops the whole link on one bad field is caught here, not just a lax one).
  const BASE = { sport: "tennis", entrants: "12", date: addDays(TODAY, 3), format: "league" } as const;
  const BASE_WANT: StartPrefill = { sportKey: "tennis", entrants: 12, date: addDays(TODAY, 3), format: "league" };
  const GARBAGE: Record<keyof typeof BASE, string[]> = {
    sport: [
      "quidditch",
      "<script>alert(1)</script>",
      // The engine's generic module is the funnel's "Other": `generic` is no funnel key or name.
      "generic",
      "tennis!",
      "ten nis",
      "table-tennis",
      "x".repeat(5000),
    ],
    entrants: [
      "0",
      "-3",
      "12abc",
      "1e1",
      "0x10",
      "12.0",
      "12.5",
      "+12",
      "012",
      "abc",
      "Infinity",
      "NaN",
      "9".repeat(400),
    ],
    date: [
      // The plan's row: no such day (and past).
      "2026-02-30",
      addDays(TODAY, -1),
      "2025-11-20",
      // No such day, still to come: only the calendar refuses these.
      "2027-02-29",
      "2026-11-31",
      "2026-13-01",
      "2026-12-00",
      `${addDays(TODAY, 3)}T10:00`,
      addDays(TODAY, 3).replaceAll("-", "/"),
      addDays(TODAY, 3).replaceAll("-", ""),
      "2026-1-20",
      "tomorrow",
      `${addDays(TODAY, 3)}${"0".repeat(5000)}`,
    ],
    format: [
      // A Pro-only kind the funnel does not offer (plan N3).
      "ladder",
      "round_robin_xl",
      // The template key, not the format: the claim maps the slug itself.
      "groups_ko",
      "groups knockout",
      "league;drop",
      "league".repeat(1000),
    ],
  };

  it("garbage in one field drops that field alone", () => {
    expect(parseStartPrefill({ ...BASE }, TODAY)).toEqual(BASE_WANT);
    let checked = 0;
    for (const field of Object.keys(GARBAGE) as (keyof typeof BASE)[]) {
      for (const bad of GARBAGE[field]) {
        const want = { ...BASE_WANT, [field === "sport" ? "sportKey" : field]: null };
        expect(parseStartPrefill({ ...BASE, [field]: bad }, TODAY), `${field}=${bad.slice(0, 40)}`).toEqual(want);
        checked++;
      }
    }
    expect(checked).toBe(Object.values(GARBAGE).reduce((a, xs) => a + xs.length, 0));
    expect(checked).toBeGreaterThan(0);
  });

  it("padding and case are not garbage", () => {
    const rows: [string, SearchParams, StartPrefill][] = [
      [
        "padded",
        { sport: " tennis ", entrants: " 12 ", date: ` ${addDays(TODAY, 3)} `, format: " league " },
        BASE_WANT,
      ],
      ["cased", { ...BASE, sport: "TeNNiS", format: "LEAGUE" }, BASE_WANT],
      // A `+` in a query string is a space, so `?entrants=+12` arrives as " 12".
      ["plus-as-space", searchParamsOf(`sport=tennis&entrants=+12&date=${addDays(TODAY, 3)}&format=league`), BASE_WANT],
    ];
    for (const [name, sp, want] of rows) expect(parseStartPrefill(sp, TODAY), name).toEqual(want);
    expect(rows.length).toBe(3);
  });

  it("a date is a real calendar day from today on", () => {
    const rows: [today: string, date: string, want: string | null][] = [
      [TODAY, TODAY, TODAY],
      [TODAY, addDays(TODAY, 1), addDays(TODAY, 1)],
      [TODAY, addDays(TODAY, -1), null],
      // The year turns.
      ["2026-12-31", "2027-01-01", "2027-01-01"],
      ["2027-01-01", "2026-12-31", null],
      // A leap day is a day; the same date a year on is not.
      [TODAY, "2028-02-29", "2028-02-29"],
      [TODAY, "2027-02-29", null],
      // The month turns: the last real day and the one after it.
      [TODAY, "2026-11-30", "2026-11-30"],
      [TODAY, "2026-11-31", null],
    ];
    for (const [today, date, want] of rows) {
      expect(parseStartPrefill({ date }, today).date, `${date} on ${today}`).toBe(want);
    }
    expect(rows.length).toBe(9);
  });

  it("a repeated param reads its first, never a later one", () => {
    const d3 = addDays(TODAY, 3);
    const rows: [string, SearchParams, StartPrefill][] = [
      ["sport twice", searchParamsOf("sport=tennis&sport=football"), { ...NONE, sportKey: "tennis" }],
      ["bad sport first", searchParamsOf("sport=quidditch&sport=tennis"), NONE],
      ["entrants twice", searchParamsOf("entrants=12&entrants=16"), { ...NONE, entrants: 12 }],
      ["bad entrants first", searchParamsOf("entrants=1&entrants=12"), NONE],
      ["date twice", searchParamsOf(`date=${d3}&date=${addDays(TODAY, 5)}`), { ...NONE, date: d3 }],
      ["past date first", searchParamsOf(`date=${addDays(TODAY, -1)}&date=${d3}`), NONE],
      ["format twice", searchParamsOf("format=swiss&format=league"), { ...NONE, format: "swiss" }],
      ["bad format first", searchParamsOf("format=ladder&format=league"), NONE],
      ["empty arrays", { sport: [], entrants: [], date: [], format: [] }, NONE],
      ["blank first", { sport: ["", "tennis"], entrants: ["", "12"], date: ["", d3], format: ["", "league"] }, NONE],
    ];
    for (const [name, sp, want] of rows) expect(parseStartPrefill(sp, TODAY), name).toEqual(want);
    // Premise: the helper really hands the parser arrays for a repeated key.
    expect(Array.isArray(searchParamsOf("sport=a&sport=b").sport)).toBe(true);
    expect(rows.length).toBe(10);
  });

  it("a value that is not a string prefills nothing", () => {
    // Next only ever hands strings; a caller that does not is refused field by field, never coerced ("42" would pass).
    const rows: [string, unknown][] = [
      ["number", 42],
      ["number in an array", [42]],
      ["object", { toString: () => "12" }],
      ["null", null],
    ];
    for (const [name, v] of rows) {
      const sp = { sport: v, entrants: v, date: v, format: v } as unknown as SearchParams;
      expect(parseStartPrefill(sp, TODAY), name).toEqual(NONE);
    }
    expect(rows.length).toBe(4);
  });

  it("refuses a today that is not a day, by name", () => {
    const bad = ["2026-02-30", "", "13/11/2026", `${TODAY}T00:00`, "today"];
    for (const today of bad) {
      const call = () => parseStartPrefill({ date: addDays(TODAY, 3) }, today);
      expect(call, JSON.stringify(today)).toThrow(RangeError);
      // Named: the parser, the rule, and the value it was handed.
      expect(call, JSON.stringify(today)).toThrow(
        `parseStartPrefill: today must be a YYYY-MM-DD calendar day, got ${JSON.stringify(today)}`,
      );
    }
    expect(bad.length).toBe(5);
  });
});
