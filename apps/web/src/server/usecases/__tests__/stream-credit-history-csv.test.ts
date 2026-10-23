// The Streaming history's CSV (server/usecases/stream-credit-history-csv.ts) — pure, no DB.
//   C1 formula guard   drop the leading-apostrophe rule in csvCell   → "a name that starts like a formula is neutralised"
//   C2 number bypass   route numbers through the text guard           → "a spend's change is a number a spreadsheet can sum"
//   C3 quoting         drop the quote rule                            → "a name with a comma, a quote or a newline is quoted"
//   C4 column set      reorder or drop a column                       → "the header and every row carry the same columns, in order"
//   C5 fixture number  drop the fixture_no column's value             → "a side not yet decided is TBD … the fixture number always names the match"
//   C6 undecided       drop the TBD fallback / the both-undecided empty → same test
import { describe, expect, it } from "vitest";
import { STREAM_HISTORY_KINDS, type StreamHistoryRow } from "../stream-credit-history";
import { STREAM_HISTORY_CSV_HEADER, csvCell, streamHistoryCsv } from "../stream-credit-history-csv";

const row = (over: Partial<StreamHistoryRow> = {}): StreamHistoryRow => ({
  id: "00000000-0000-0000-0000-000000000001", dateIso: "2026-10-20T09:00:00.000Z", kind: "streamUsed", delta: -1, balanceAfter: 4,
  fixture: { homeName: "Hawks", awayName: "Owls", fixtureNo: 3, competitionName: "Autumn League", href: "/o/a/c/b/d/c/f/3" },
  ...over,
});
const parse = (csv: string) => csv.split("\r\n").map((l) => l.split(","));

describe("streamHistoryCsv", () => {
  it("the header and every row carry the same columns, in order; the activity is the stable kind key, not a label (C4)", () => {
    const rows = STREAM_HISTORY_KINDS.map((kind, i) => row({ kind, id: `00000000-0000-0000-0000-00000000000${i}`, fixture: null }));
    const lines = parse(streamHistoryCsv(rows));
    expect(lines[0]).toEqual([...STREAM_HISTORY_CSV_HEADER]);
    expect(lines).toHaveLength(rows.length + 1);
    for (const l of lines) expect(l).toHaveLength(STREAM_HISTORY_CSV_HEADER.length);
    // every kind the reader can produce is written under its own key
    expect(lines.slice(1).map((l) => l[1])).toEqual([...STREAM_HISTORY_KINDS]);
  });

  it("a row that moved for a match names it; a row that did not leaves the two columns empty", () => {
    const [, withMatch, without] = parse(streamHistoryCsv([row(), row({ kind: "packPurchase", delta: 5, balanceAfter: 5, fixture: null })]));
    expect(withMatch).toEqual(["2026-10-20T09:00:00.000Z", "streamUsed", "-1", "4", "3", "Hawks v Owls", "Autumn League"]);
    expect(without).toEqual(["2026-10-20T09:00:00.000Z", "packPurchase", "5", "5", "", "", ""]);
  });

  it("a side not yet decided is TBD, never a dangling `v`, the word undefined or null — and the fixture number always names the match (C5, C6)", () => {
    const f = (homeName: string | null, awayName: string | null) => ({ homeName, awayName, fixtureNo: 12, competitionName: "L", href: "/x" });
    const cells = (home: string | null, away: string | null) => parse(streamHistoryCsv([row({ fixture: f(home, away) })]))[1]!;
    expect(cells("Hawks", null).slice(4)).toEqual(["12", "Hawks v TBD", "L"]);
    expect(cells(null, "Owls").slice(4)).toEqual(["12", "TBD v Owls", "L"]);
    // nothing decided: no name to give, but the number still says which match
    expect(cells(null, null).slice(4)).toEqual(["12", "", "L"]);
    expect(cells("", "").slice(4), "an empty name is undecided too").toEqual(["12", "", "L"]);
    expect(cells("", "Owls").slice(4), "an empty home name is undecided, not blank").toEqual(["12", "TBD v Owls", "L"]);
    expect(cells("Hawks", "").slice(4), "an empty away name is undecided, not blank").toEqual(["12", "Hawks v TBD", "L"]);
    // positive pair: both decided
    expect(cells("Hawks", "Owls").slice(4)).toEqual(["12", "Hawks v Owls", "L"]);
    const all = streamHistoryCsv([row({ fixture: f("Hawks", null) }), row({ fixture: f(null, null) })]);
    expect(all).not.toMatch(/undefined|null| v ,|v$/m);
  });

  it("a spend's change is a number a spreadsheet can sum — a bare -1, not the text '-1 (C2)", () => {
    const [, spend] = parse(streamHistoryCsv([row({ delta: -1 })]));
    expect(spend![2]).toBe("-1");
    expect(csvCell(-12)).toBe("-12");
    expect(csvCell(7)).toBe("7");
  });

  it("a name that starts like a formula is neutralised (C1) — each of the five openers, in both name columns", () => {
    for (const opener of ["=", "+", "-", "@", "\t", "\r"]) {
      const text = `${opener}HYPERLINK("x")`;
      const cell = csvCell(text);
      expect(cell.replace(/^"/, "")[0], JSON.stringify(opener)).toBe("'");
    }
    const csv = streamHistoryCsv([row({ fixture: { homeName: "=CMD()", awayName: "@x", fixtureNo: 1, competitionName: "+SUM(A1)", href: "/x" } })]);
    expect(csv).toContain("'=CMD() v @x");
    expect(csv).toContain("'+SUM(A1)");
    // positive pair: an ordinary name is untouched
    expect(csvCell("Hawks")).toBe("Hawks");
    expect(csvCell("a-b = c")).toBe("a-b = c");
  });

  it("a name with a comma, a quote or a newline is quoted, quotes doubled (C3)", () => {
    expect(csvCell("Hawks, Owls")).toBe('"Hawks, Owls"');
    expect(csvCell('The "A" team')).toBe('"The ""A"" team"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    const csv = streamHistoryCsv([row({ fixture: { homeName: "A, B", awayName: "C", fixtureNo: 1, competitionName: "L", href: "/x" } })]);
    expect(csv).toContain('"A, B v C"');
  });

  it("an EMPTY history is the header alone — a file, not an error", () => {
    expect(streamHistoryCsv([])).toBe([...STREAM_HISTORY_CSV_HEADER].join(","));
  });
});
