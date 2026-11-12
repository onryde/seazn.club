// The Match Day code sheet's pure helpers (MD-1 Task 2): what the mint button sends, which venues the picker offers, and how
// a listed code names its scope. The doors themselves are proven in the routes' own suite.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import type { MatchDayCourt } from "@/lib/match-day/types";
import { codeVenues, hasQr, scopeBody, scopeWords } from "../match-day-code-sheet";

const court = (court_id: string, court_name: string, venue_id: string, venue_name: string) =>
  ({ court_id, court_name, venue_id, venue_name }) as MatchDayCourt;
const COURTS = [court("c1", "Court 1", "va", "Hall A"), court("c2", "Court 2", "va", "Hall A"), court("c3", "Court 3", "vb", "Hall B")];

describe("scopeBody", () => {
  it("names the whole competition, the picked venue, or the ticked courts", () => {
    expect(scopeBody("competition", null, new Set())).toEqual({ kind: "competition" });
    expect(scopeBody("venue", "vb", new Set())).toEqual({ kind: "venue", venue_id: "vb" });
    expect(scopeBody("courts", null, new Set(["c1", "c3"]))).toEqual({ kind: "courts", court_ids: ["c1", "c3"] });
  });

  it("is null while there is nothing to cover, so the button stays off", () => {
    expect(scopeBody("venue", null, new Set())).toBeNull();
    expect(scopeBody("courts", "va", new Set())).toBeNull();
  });
});

describe("codeVenues", () => {
  it("offers today's venues, each once", () => {
    expect(codeVenues(COURTS, ["vb"])).toEqual([{ id: "vb", name: "Hall B" }]);
  });
  it("offers every venue on the board when none has a match today", () => {
    expect(codeVenues(COURTS, [])).toEqual([
      { id: "va", name: "Hall A" },
      { id: "vb", name: "Hall B" },
    ]);
  });
});

describe("scopeWords", () => {
  it("says the competition, the venue's name, or the courts' names", () => {
    expect(scopeWords(en, { kind: "competition" }, COURTS)).toBe(en["matchDay.code.scope.competition"]);
    expect(scopeWords(en, { kind: "venue", venue_id: "vb" }, COURTS)).toBe("Hall B");
    expect(scopeWords(en, { kind: "courts", court_ids: ["c2", "c3"] }, COURTS)).toBe("Court 2, Court 3");
  });
  it("falls back to the kind's words for a venue or courts no longer on the board", () => {
    expect(scopeWords(en, { kind: "venue", venue_id: "gone" }, COURTS)).toBe(en["matchDay.code.scope.venue"]);
    expect(scopeWords(en, { kind: "courts", court_ids: ["gone"] }, COURTS)).toBe(en["matchDay.code.scope.courts"]);
  });
});

describe("hasQr (MD-1 final review I3)", () => {
  it("offers Show QR only for a code listed with its url, never for one listed with url null", () => {
    expect(hasQr({ url: "https://seazn.club/day/md_x" })).toBe(true);
    expect(hasQr({ url: null })).toBe(false);
  });
});
