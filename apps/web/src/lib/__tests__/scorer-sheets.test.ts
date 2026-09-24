// Scorer sheets §4.4 — which fixtures print on a day, in what order, on which
// page. Pure: the loader (server/usecases/scorer-sheets.ts) hands these rows in
// with names, match refs and the venue zone already resolved, and its own DB
// suite proves that half.
import { describe, expect, it } from "vitest";
import {
  PRINTABLE_STATUSES,
  ROWS_PER_PAGE,
  defaultSheetDay,
  localDateOf,
  paginateSheet,
  selectSheetFixtures,
  sheetDays,
  type SheetCandidate,
} from "../scorer-sheets";

const side = (name: string) => ({
  name,
  kind: "individual" as const,
  members: [] as { person_id: string; full_name: string }[],
});
let n = 0;
function c(over: Partial<SheetCandidate> = {}): SheetCandidate {
  n += 1;
  return {
    id: `f${String(n).padStart(3, "0")}`,
    status: "scheduled",
    scheduled_at: "2026-09-23T09:00:00Z",
    tz: "UTC",
    division_name: "Open",
    round_no: 1,
    seq_in_round: n,
    match_ref: `R1·${n}`,
    venue_name: "Hall",
    venue_sort: 0,
    court_name: "Court 1",
    court_sort: 0,
    home: side("A"),
    away: side("B"),
    home_tbd: "TBD",
    away_tbd: "TBD",
    home_slot_label: null,
    away_slot_label: null,
    ...over,
  };
}
const ids = (rows: readonly SheetCandidate[]) => rows.map((r) => r.id);
const DAY = "2026-09-23";

describe("selectSheetFixtures (scorer sheets §4.4)", () => {
  it("empty case first: no candidates → no rows, whatever the day", () => {
    expect(selectSheetFixtures([], DAY)).toEqual([]);
    expect(selectSheetFixtures([], "1999-01-01")).toEqual([]);
  });

  it("keeps scheduled and in-play; drops decided/finalized/forfeited/abandoned/cancelled", () => {
    // Every status the V214 check constraint allows — the allow-list is exact.
    const rows = ["scheduled", "in_play", "decided", "finalized", "forfeited", "abandoned", "cancelled"].map((status) =>
      c({ status }),
    );
    expect(selectSheetFixtures(rows, DAY).map((r) => r.status)).toEqual(["scheduled", "in_play"]);
    expect([...PRINTABLE_STATUSES].sort()).toEqual(["in_play", "scheduled"]);
  });

  it("drops unscheduled fixtures", () => {
    expect(selectSheetFixtures([c({ scheduled_at: null })], DAY)).toEqual([]);
  });

  it("keeps a TBD-side fixture (knockout later rounds print, D2) but drops a bye on EITHER side", () => {
    const tbd = c({ away: null, away_slot_label: { key: "slot.winner_match", params: { round: 1, seq: 1 } } });
    const awayBye = c({ away: null, away_slot_label: { key: "bracket.slot.bye", params: {} } });
    const homeBye = c({ home: null, home_slot_label: { key: "bracket.slot.bye", params: {} } });
    expect(ids(selectSheetFixtures([tbd, awayBye, homeBye], DAY))).toEqual([tbd.id]);
  });

  it("the day is the fixture's LOCAL day in its own tz — Auckland vs UTC (Review Focus 3)", () => {
    const late = c({ scheduled_at: "2026-09-23T11:30:00Z", tz: "Pacific/Auckland" }); // 23:30 NZST, 23 Sep
    const early = c({ scheduled_at: "2026-09-22T12:30:00Z", tz: "Pacific/Auckland" }); // 00:30 NZST, 23 Sep
    expect(ids(selectSheetFixtures([late, early], DAY)).sort()).toEqual([early.id, late.id].sort());
    expect(selectSheetFixtures([early], "2026-09-22")).toEqual([]); // the UTC day would say yes
  });

  it("orders by court, then time; courtless rows last", () => {
    const rows = [
      c({ id: "none", court_name: null, court_sort: null, venue_name: null, venue_sort: null }),
      // A court_label-only row: no venue and no court entity, but a court NAME.
      // Only the courtless-last term puts it ahead of "none" (pre-flight T7e).
      c({ id: "label", court_name: "Court A", court_sort: null, venue_name: null, venue_sort: null }),
      c({ id: "c2-late", court_name: "Court 2", court_sort: 1, scheduled_at: "2026-09-23T11:00:00Z" }),
      c({ id: "c1-late", court_name: "Court 1", court_sort: 0, scheduled_at: "2026-09-23T11:00:00Z" }),
      c({ id: "c1-early", court_name: "Court 1", court_sort: 0, scheduled_at: "2026-09-23T09:00:00Z" }),
      c({ id: "c2-early", court_name: "Court 2", court_sort: 1, scheduled_at: "2026-09-23T09:00:00Z" }),
    ];
    expect(ids(selectSheetFixtures(rows, DAY))).toEqual(["c1-early", "c1-late", "c2-early", "c2-late", "label", "none"]);
  });

  it("court SORT beats court NAME — the ordering differential", () => {
    const rows = [c({ id: "B", court_name: "A court", court_sort: 9 }), c({ id: "A", court_name: "Z court", court_sort: 8 })];
    expect(ids(selectSheetFixtures(rows, DAY))).toEqual(["A", "B"]);
  });

  it("the VENUE comes before the court: venue sort, then venue name, then the court's own sort", () => {
    const rows = [
      // Court sort 0 in the second venue: a court-first order would put it first.
      c({ id: "v2-c0", venue_name: "Annex", venue_sort: 1, court_name: "Court 1", court_sort: 0 }),
      c({ id: "v1-c5", venue_name: "Zeta hall", venue_sort: 0, court_name: "Court 9", court_sort: 5 }),
      // Same venue sort: the NAME decides ("Beta" before "Gamma"), whatever the courts say.
      c({ id: "gamma", venue_name: "Gamma", venue_sort: 2, court_name: "Court 1", court_sort: 0 }),
      c({ id: "beta", venue_name: "Beta", venue_sort: 2, court_name: "Court 9", court_sort: 9 }),
    ];
    expect(ids(selectSheetFixtures(rows, DAY))).toEqual(["v1-c5", "v2-c0", "beta", "gamma"]);
  });

  it("court names without a sort compare numerically — Court 2 before Court 10", () => {
    const rows = [
      c({ id: "ten", court_name: "Court 10", court_sort: null, venue_name: null, venue_sort: null }),
      c({ id: "two", court_name: "Court 2", court_sort: null, venue_name: null, venue_sort: null }),
    ];
    expect(ids(selectSheetFixtures(rows, DAY))).toEqual(["two", "ten"]);
  });

  it("same court and time: the match ref order — round, then seq", () => {
    // Ids sort AGAINST the expected order, so the id tiebreak cannot stand in
    // for a dropped round or seq term.
    const rows = [
      c({ id: "mm-r2s1", round_no: 2, seq_in_round: 1 }),
      c({ id: "aa-r1s2", round_no: 1, seq_in_round: 2 }),
      c({ id: "zz-r1s1", round_no: 1, seq_in_round: 1 }),
    ];
    expect(ids(selectSheetFixtures(rows, DAY))).toEqual(["zz-r1s1", "aa-r1s2", "mm-r2s1"]);
  });

  it("a full tie across divisions is settled by division name, then id — a reprint prints the same order", () => {
    const tie = { court_name: null, court_sort: null, venue_name: null, venue_sort: null, round_no: 1, seq_in_round: 1 };
    const rows = [
      c({ ...tie, id: "x-open", division_name: "Open" }),
      c({ ...tie, id: "y-masters", division_name: "Masters" }),
      c({ ...tie, id: "b-open", division_name: "Open" }),
    ];
    expect(ids(selectSheetFixtures(rows, DAY))).toEqual(["y-masters", "b-open", "x-open"]);
    expect(ids(selectSheetFixtures([...rows].reverse(), DAY))).toEqual(["y-masters", "b-open", "x-open"]);
  });
});

describe("sheetDays / defaultSheetDay", () => {
  it("empty: no days, no default", () => {
    expect(sheetDays([])).toEqual([]);
    expect(defaultSheetDay([], DAY)).toBeNull();
  });

  it("distinct local days of printable fixtures only, sorted", () => {
    const rows = [
      c({ scheduled_at: "2026-09-24T09:00:00Z" }),
      c({ scheduled_at: "2026-09-23T09:00:00Z" }),
      c({ scheduled_at: "2026-09-23T10:00:00Z" }),
      c({ scheduled_at: "2026-09-25T09:00:00Z", status: "decided" }),
      c({ scheduled_at: "2026-09-26T09:00:00Z", away: null, away_slot_label: { key: "bracket.slot.bye", params: {} } }),
      c({ scheduled_at: null }),
    ];
    expect(sheetDays(rows)).toEqual(["2026-09-23", "2026-09-24"]);
  });

  it("a day is the fixture's LOCAL day, not its UTC one", () => {
    // 22 Sep 12:30Z is 23 Sep 00:30 in Auckland.
    expect(sheetDays([c({ scheduled_at: "2026-09-22T12:30:00Z", tz: "Pacific/Auckland" })])).toEqual(["2026-09-23"]);
  });

  it("default: today if it has fixtures, else the next day that does, else the last", () => {
    const days = ["2026-09-20", "2026-09-23", "2026-09-26"];
    expect(defaultSheetDay(days, "2026-09-23")).toBe("2026-09-23");
    expect(defaultSheetDay(days, "2026-09-24")).toBe("2026-09-26");
    expect(defaultSheetDay(days, "2026-09-30")).toBe("2026-09-26");
    expect(defaultSheetDay(days, "2026-09-01")).toBe("2026-09-20");
  });
});

describe("localDateOf", () => {
  it("is tz-aware", () => {
    expect(localDateOf("2026-09-23T11:30:00Z", "Pacific/Auckland")).toBe("2026-09-23");
    expect(localDateOf("2026-09-23T03:30:00Z", "America/Los_Angeles")).toBe("2026-09-22");
    expect(localDateOf("2026-09-23T03:30:00Z", "UTC")).toBe("2026-09-23");
  });
});

describe("paginateSheet", () => {
  it("empty: no pages", () => {
    expect(paginateSheet([], "No court")).toEqual([]);
  });

  it(`${ROWS_PER_PAGE} rows per page; each court starts a page; numbering is PER COURT (owner ruling Q7)`, () => {
    const c1 = Array.from({ length: ROWS_PER_PAGE + 1 }, () => c({ court_name: "Court 1" }));
    const c2 = [c({ court_name: "Court 2", court_sort: 1 })];
    expect(
      paginateSheet([...c1, ...c2], "No court").map((p) => [p.courtHeading, p.continued, p.rows.length, p.pageInCourt, p.pagesInCourt]),
    ).toEqual([
      ["Court 1", false, ROWS_PER_PAGE, 1, 2],
      ["Court 1", true, 1, 2, 2],
      ["Court 2", false, 1, 1, 1], // a global counter would say 3 of 3
    ]);
  });

  it(`exactly ${ROWS_PER_PAGE} rows fill ONE page — no empty continuation`, () => {
    const rows = Array.from({ length: ROWS_PER_PAGE }, () => c({ court_name: "Court 1" }));
    expect(paginateSheet(rows, "No court").map((p) => [p.rows.length, p.pageInCourt, p.pagesInCourt])).toEqual([
      [ROWS_PER_PAGE, 1, 1],
    ]);
  });

  it("rows stay in the order given — the page is a slice of the selection", () => {
    const rows = Array.from({ length: ROWS_PER_PAGE + 2 }, () => c({ court_name: "Court 1" }));
    expect(paginateSheet(rows, "No court").flatMap((p) => ids(p.rows))).toEqual(ids(rows));
  });

  it("courtless fixtures print under the no-court heading", () => {
    const pages = paginateSheet([c({ court_name: "Court 1" }), c({ court_name: null })], "No court");
    expect(pages.map((p) => [p.courtHeading, p.continued, p.pageInCourt, p.pagesInCourt])).toEqual([
      ["Court 1", false, 1, 1],
      ["No court", false, 1, 1],
    ]);
  });
});
