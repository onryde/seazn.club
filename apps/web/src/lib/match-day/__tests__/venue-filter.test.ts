// Match Day E2 item 5 — the venue filter's pure rules (lib/match-day/view.ts).
//
// The rules, from the brief:
//  - the filter exists ONLY when the courts span more than one venue;
//  - its options are the venues (with their court counts) and "Show all venues";
//  - the default is the venues with a match today in this competition; if there are none, every venue;
//  - the state lives in the URL (`?venue=<id>,<id>`), so a reload and Back bring the same selection;
//  - exactly one venue selected drops the "(Venue)" suffix from court names;
//  - it is DISPLAY ONLY: it narrows the list, never anything a call is judged by.
// Anti-vacuity: every sweep reports what it checked, and zero checked fails.
import { describe, expect, it } from "vitest";
import type { MatchDayCourt } from "../types";
import {
  filterByVenues,
  initialVenueSelection,
  parseVenueParam,
  scopeCourtNames,
  venueOptions,
  venueParamOf,
  withVenueParam,
} from "../view";

const court = (id: string, name: string, venue: { id: string; name: string }, o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: id,
  court_name: name,
  venue_id: venue.id,
  venue_name: venue.name,
  sport_noun: "court",
  state: "free",
  current: null,
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  ...o,
});

const A = { id: "v-a", name: "Hall A" };
const B = { id: "v-b", name: "Hall B" };
const C = { id: "v-c", name: "Annex" };
/** Two venues share a court name, so the server qualified both ("Court 1 (Hall A)", "Court 1 (Hall B)"). */
const COURTS = [
  court("c-1", "Court 1 (Hall A)", A),
  court("c-2", "Court 2", A),
  court("c-3", "Court 1 (Hall B)", B),
  court("c-4", "Court 3", B),
  court("c-5", "Court 4", B, { sport_noun: "pitch" }),
];
const ids = (cs: readonly MatchDayCourt[]) => cs.map((c) => c.court_id);

describe("venueOptions — the dropdown's options, and whether there is a dropdown", () => {
  it("empty case first: no courts, no options", () => {
    expect(venueOptions([])).toEqual([]);
  });

  it("one venue: one option — the caller shows no filter for it", () => {
    const one = venueOptions([court("c-1", "Court 1", A), court("c-2", "Court 2", A)]);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ id: "v-a", name: "Hall A", courts: 2 });
  });

  it("two venues: each venue once, in the order the courts come (venue order), with its court count and the noun its courts share", () => {
    const options = venueOptions(COURTS);
    expect(options.map((o) => [o.id, o.name, o.courts])).toEqual([
      ["v-a", "Hall A", 2],
      ["v-b", "Hall B", 3],
    ]);
    expect(options[0]!.noun).toBe("court");
    // Hall B's courts do not all share a noun, so the venue says "court" (sharedNoun's rule).
    expect(options[1]!.noun).toBe("court");
    const pitches = venueOptions([court("c-1", "P1", A, { sport_noun: "pitch" }), court("c-2", "P2", A, { sport_noun: "pitch" })]);
    expect(pitches[0]!.noun).toBe("pitch");
  });
});

describe("parseVenueParam — what the URL says", () => {
  it("absent, empty and blank all read as 'no choice made'", () => {
    expect(parseVenueParam(undefined)).toBeNull();
    expect(parseVenueParam(null)).toBeNull();
    expect(parseVenueParam("")).toBeNull();
    expect(parseVenueParam(" , ")).toBeNull();
  });
  it("'all' is every venue, whatever its case", () => {
    expect(parseVenueParam("all")).toBe("all");
    expect(parseVenueParam("ALL")).toBe("all");
  });
  it("a list of ids, trimmed, empty segments dropped, repeats collapsed, in order", () => {
    expect(parseVenueParam("v-b, v-a,,v-b")).toEqual(["v-b", "v-a"]);
  });
  it("a repeated query key (an array) is read as one list", () => {
    expect(parseVenueParam(["v-a", "v-b,v-c"])).toEqual(["v-a", "v-b", "v-c"]);
  });
});

describe("initialVenueSelection — URL first, else the venues with a match today, else every venue", () => {
  const all = new Set(["v-a", "v-b"]);

  it("no URL choice and a match today at one venue: that venue", () => {
    expect(initialVenueSelection(COURTS, ["v-b"], null)).toEqual(new Set(["v-b"]));
  });
  it("no URL choice and no match today anywhere: every venue", () => {
    expect(initialVenueSelection(COURTS, [], null)).toEqual(all);
  });
  it("no URL choice and matches at every venue: every venue", () => {
    expect(initialVenueSelection(COURTS, ["v-a", "v-b"], null)).toEqual(all);
  });
  it("a venue with a match today that is not a venue on the board is ignored; when none is left, every venue", () => {
    expect(initialVenueSelection(COURTS, ["v-gone"], null)).toEqual(all);
    expect(initialVenueSelection(COURTS, ["v-gone", "v-a"], null)).toEqual(new Set(["v-a"]));
  });
  it("the URL wins over the default, in both directions", () => {
    expect(initialVenueSelection(COURTS, ["v-b"], ["v-a"])).toEqual(new Set(["v-a"]));
    expect(initialVenueSelection(COURTS, ["v-b"], "all")).toEqual(all);
    expect(initialVenueSelection(COURTS, [], ["v-a", "v-b"])).toEqual(all);
  });
  it("a URL naming only venues that do not exist falls back to the default rather than hiding every court", () => {
    expect(initialVenueSelection(COURTS, ["v-b"], ["v-nope"])).toEqual(new Set(["v-b"]));
    expect(initialVenueSelection(COURTS, [], ["v-nope"])).toEqual(all);
  });
  it("a URL naming a real and an unknown venue keeps the real one", () => {
    expect(initialVenueSelection(COURTS, [], ["v-nope", "v-b"])).toEqual(new Set(["v-b"]));
  });
  it("no courts: the empty selection (there is nothing to filter)", () => {
    expect(initialVenueSelection([], ["v-a"], null)).toEqual(new Set());
  });
});

describe("filterByVenues — display only", () => {
  it("one venue: only its courts, in order", () => {
    expect(ids(filterByVenues(COURTS, new Set(["v-a"])))).toEqual(["c-1", "c-2"]);
    expect(ids(filterByVenues(COURTS, new Set(["v-b"])))).toEqual(["c-3", "c-4", "c-5"]);
  });
  it("every venue selected is no filter at all", () => {
    expect(ids(filterByVenues(COURTS, new Set(["v-a", "v-b"])))).toEqual(ids(COURTS));
  });
  it("a selection naming nothing on the board shows every court (never an empty page from a stale id)", () => {
    expect(ids(filterByVenues(COURTS, new Set(["v-gone"])))).toEqual(ids(COURTS));
    expect(ids(filterByVenues(COURTS, new Set()))).toEqual(ids(COURTS));
  });
  it("three venues, two selected", () => {
    const three = [...COURTS, court("c-6", "Court 9", C)];
    expect(ids(filterByVenues(three, new Set(["v-a", "v-c"])))).toEqual(["c-1", "c-2", "c-6"]);
  });
  it("it returns the courts untouched (same objects): nothing about a court changes but whether it is listed", () => {
    const out = filterByVenues(COURTS, new Set(["v-a"]));
    expect(out[0]).toBe(COURTS[0]);
    expect(out[1]).toBe(COURTS[1]);
  });
  it("sweep: every non-empty subset of three venues keeps exactly the courts of its venues", () => {
    const three = [...COURTS, court("c-6", "Court 9", C)];
    const venues = ["v-a", "v-b", "v-c"];
    let checked = 0;
    for (let mask = 1; mask < 8; mask++) {
      const pick = new Set(venues.filter((_, i) => (mask & (1 << i)) !== 0));
      const expected = three.filter((c) => pick.has(c.venue_id)).map((c) => c.court_id);
      expect(ids(filterByVenues(three, pick)), [...pick].join()).toEqual(expected);
      checked++;
    }
    expect(checked).toBe(7);
  });
});

describe("scopeCourtNames — one venue selected drops the '(Venue)' suffix", () => {
  it("exactly one venue: the suffix goes from the courts that carry it, and only that venue's own", () => {
    const scoped = scopeCourtNames(filterByVenues(COURTS, new Set(["v-a"])), new Set(["v-a"]));
    expect(scoped.map((c) => c.court_name)).toEqual(["Court 1", "Court 2"]);
    const b = scopeCourtNames(filterByVenues(COURTS, new Set(["v-b"])), new Set(["v-b"]));
    expect(b.map((c) => c.court_name)).toEqual(["Court 1", "Court 3", "Court 4"]);
  });
  it("two or more venues: the names stay as the server qualified them", () => {
    const both = scopeCourtNames(COURTS, new Set(["v-a", "v-b"]));
    expect(both.map((c) => c.court_name)).toEqual(COURTS.map((c) => c.court_name));
  });
  it("a name that merely contains another venue's suffix is left alone", () => {
    const odd = court("c-9", "Court 7 (Hall B)", A); // in Hall A, named like a Hall B court: not Hall A's own suffix
    expect(scopeCourtNames([odd], new Set(["v-a"]))[0]!.court_name).toBe("Court 7 (Hall B)");
  });
  it("only the name changes", () => {
    const [first] = scopeCourtNames([COURTS[0]!], new Set(["v-a"]));
    expect({ ...first, court_name: "" }).toEqual({ ...COURTS[0], court_name: "" });
  });
});

describe("venueParamOf — the URL the selection writes", () => {
  const options = venueOptions(COURTS);
  it("every venue: 'all'", () => {
    expect(venueParamOf(new Set(["v-a", "v-b"]), options)).toBe("all");
  });
  it("some: the ids, in the venues' own order, comma-joined", () => {
    expect(venueParamOf(new Set(["v-a"]), options)).toBe("v-a");
    const three = venueOptions([...COURTS, court("c-6", "Court 9", C)]);
    expect(venueParamOf(new Set(["v-c", "v-a"]), three)).toBe("v-a,v-c");
  });
  it("round trip: what it writes, the reader reads back to the same selection (every non-empty subset of three)", () => {
    const three = [...COURTS, court("c-6", "Court 9", C)];
    const opts = venueOptions(three);
    const venues = opts.map((o) => o.id);
    let checked = 0;
    for (let mask = 1; mask < 8; mask++) {
      const pick = new Set(venues.filter((_, i) => (mask & (1 << i)) !== 0));
      const param = venueParamOf(pick, opts);
      expect(initialVenueSelection(three, [], parseVenueParam(param)), param).toEqual(pick);
      checked++;
    }
    expect(checked).toBe(7);
  });
});

describe("withVenueParam — the address the selection writes into", () => {
  const base = "https://seazn.test";
  it("adds ?venue= to a bare path", () => {
    expect(withVenueParam(`${base}/o/acme/c/open/match-day`, "v-a,v-b")).toBe("/o/acme/c/open/match-day?venue=v-a%2Cv-b");
  });
  it("replaces a previous choice and keeps every other parameter and the hash", () => {
    expect(withVenueParam(`${base}/o/acme/c/open/match-day?court=c-1&venue=all#top`, "v-a")).toBe("/o/acme/c/open/match-day?court=c-1&venue=v-a#top");
  });
  it("writes one venue key, never two", () => {
    const out = withVenueParam(`${base}/m?venue=v-a&venue=v-b`, "all");
    expect(out.match(/venue=/g)).toHaveLength(1);
    expect(out).toBe("/m?venue=all");
  });
  it("what it writes, the reader reads back", () => {
    const out = withVenueParam(`${base}/m`, "v-a,v-b");
    const raw = new URL(out, base).searchParams.get("venue");
    expect(parseVenueParam(raw)).toEqual(["v-a", "v-b"]);
  });
});
