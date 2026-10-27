// OG card models (v3/10 #1): youth divisions never print player names
// (v3/11 gap 8) and a failing org accent falls back to platform violet
// (gap 7) — the two rules that MUST hold on platform-cached share images.
import { describe, expect, it } from "vitest";
import { fixtureCardModel, ogTheme, standingsCardModel } from "@/server/og/model";
import { msgFor } from "@/lib/messages-i18n";
import { chessRoundRobin, levelLeague, type StoredTable } from "@/server/engine-db/__tests__/helpers/stored-table-rows";

const brandingOf = (hex: string) => ({ colors: { primary: hex } });

describe("ogTheme contrast guard", () => {
  it("uses a passing brand color", () => {
    const t = ogTheme(brandingOf("#0f766e"));
    expect(t.accent).toBe("#0f766e");
  });

  it("falls back to violet for a low-contrast accent (near-white)", () => {
    const t = ogTheme(brandingOf("#f3f0ff"));
    expect(t.accent).toBe("#7c3aed");
  });

  it("competition branding wins over org branding; empty blobs skip", () => {
    const t = ogTheme(brandingOf("#0f766e"), brandingOf("#1d4ed8"));
    expect(t.accent).toBe("#0f766e");
    const t2 = ogTheme({}, brandingOf("#1d4ed8"));
    expect(t2.accent).toBe("#1d4ed8");
  });
});

const baseStandings = {
  orgName: "Riverside",
  competitionName: "Summer",
  divisionName: "U14 Singles",
  logo: null,
  branding: [],
  rows: [
    { rank: 1, entrantId: "e1", played: 3, points: 9 },
    { rank: 2, entrantId: "e2", played: 3, points: 6 },
  ],
  names: { e1: "Maya Kapoor", e2: "Leo Ng" },
  rules: null,
};

describe("standingsCardModel youth rule", () => {
  it("youth + individuals → no names at all, just the fallback line", () => {
    const m = standingsCardModel({ ...baseStandings, youth: true, entrantKind: "individual" });
    expect(m.rows).toHaveLength(0);
    expect(m.fallbackKey).toBe("og.standings.youth");
    expect(JSON.stringify(m)).not.toContain("Maya");
    expect(JSON.stringify(m)).not.toContain("Leo");
  });

  it("youth + teams → team names are fine", () => {
    const m = standingsCardModel({
      ...baseStandings,
      names: { e1: "Rockets", e2: "Comets" },
      youth: true,
      entrantKind: "team",
    });
    expect(m.rows.map((r) => r.name)).toEqual(["Rockets", "Comets"]);
  });

  it("adult division → names render, top 6, rank order", () => {
    const m = standingsCardModel({ ...baseStandings, youth: false, entrantKind: "individual" });
    expect(m.rows[0]).toMatchObject({ rank: "1", name: "Maya Kapoor", points: "9", leader: true });
    expect(m.fallbackKey).toBeNull();
  });

  it("no standings yet → the empty line's key, not the youth one", () => {
    const m = standingsCardModel({ ...baseStandings, rows: [], youth: false, entrantKind: "individual" });
    expect(m.rows).toHaveLength(0);
    expect(m.fallbackKey).toBe("og.standings.empty");
  });
});

// W2d T17 fix 1 (I3): the share card prints a stored table through the public table's own helpers — the stage's unit
// (chess's half-points, RB2B-17), the level test and the rank text (X-TB-6, anti-goal 3: a level table has no leader).
// The rows are the engine's own, ranked by `completeTableStage` under the sport's rule; the expected values are the
// rulebook's (FIDE 1 / ½ / 0), never the helpers' output.
describe("standingsCardModel — W2d T17 fix 1: the public table's points and places", () => {
  const NAMES = { e1: "Anand", e2: "Bela", e3: "Clara", e4: "Dmitri" };
  const inputOf = (t: StoredTable, rules: StoredTable["doc"] | null) => ({
    ...baseStandings,
    youth: false,
    entrantKind: "individual",
    names: NAMES,
    rules,
    rows: t.rows.map((r) => ({ rank: r.rank ?? null, entrantId: r.entrantId, played: r.played, points: r.points, ...(r.level === true ? { level: true } : {}) })),
  });

  it("a chess table prints 1½ / 1 / ½ / 0 under its stage's half-point unit; without the stage's rules, the stored number", () => {
    // Anand beat Bela, drew Clara, lost to Dmitri: 1 + ½ + 0 = 1½; Dmitri 1; Clara ½; Bela 0.
    const chess = chessRoundRobin(["e1", "e2", "e3", "e4"]);
    const m = standingsCardModel(inputOf(chess, chess.doc));
    expect(m.rows.map((r) => [r.rank, r.name, r.points, r.leader])).toEqual([
      ["1", "Anand", "1½", true],
      ["2", "Dmitri", "1", false],
      ["3", "Clara", "½", false],
      ["4", "Bela", "0", false],
    ]);
    expect(standingsCardModel(inputOf(chess, null)).rows.map((r) => r.points), "no rules: the stored half-points").toEqual(["3", "2", "1", "0"]);
  });

  it("a level table (started, nothing counted) prints no places and draws no leader; it is still a table, not the empty line", () => {
    const level = levelLeague(["e1", "e2", "e3"]);
    expect(level.rows.every((r) => r.level === true), "premise: the engine marks every row level").toBe(true);
    const m = standingsCardModel(inputOf(level, level.doc));
    expect(m.rows.map((r) => [r.rank, r.leader])).toEqual([["–", false], ["–", false], ["–", false]]);
    expect(m.fallbackKey).toBeNull();
  });

  it("a row the ranking pass left without a place keeps the card's '–' while its neighbours keep theirs", () => {
    const m = standingsCardModel({ ...baseStandings, youth: false, entrantKind: "individual", rows: [{ rank: 1, entrantId: "e1", played: 3, points: 9 }, { rank: null, entrantId: "e2", played: 3, points: 6 }] });
    expect(m.rows.map((r) => r.rank)).toEqual(["1", "–"]);
  });
});

describe("fixtureCardModel youth rule", () => {
  const base = {
    orgName: "Riverside",
    competitionName: "Summer",
    divisionName: "U14 Singles",
    logo: null,
    branding: [],
    homeName: "Maya Kapoor",
    awayName: "Leo Ng",
    headline: "21 – 18",
    fixtureStatus: "decided",
  };

  it("youth individuals: matchup collapses to the division, headline dropped", () => {
    const m = fixtureCardModel({ ...base, youth: true, entrantKind: "individual" });
    expect(JSON.stringify(m)).not.toContain("Maya");
    expect(m.home).toBe("U14 Singles");
    expect(m.headline).toBeNull();
  });

  it("adult: names + headline + result status", () => {
    const m = fixtureCardModel({ ...base, youth: false, entrantKind: "individual" });
    expect(m.home).toBe("Maya Kapoor");
    expect(m.headline).toBe("21 – 18");
    expect(m.status).toBe("result");
  });

  it("in_play maps to live", () => {
    const m = fixtureCardModel({
      ...base, youth: false, entrantKind: "team", fixtureStatus: "in_play",
    });
    expect(m.status).toBe("live");
  });

  // P6 fix round 1, finding #2 (CRITICAL): when neither an entrant NOR a
  // slot label was known (homeName/awayName both null — e.g. the caller
  // could not resolve the fixture at all), the model's own internal
  // fallback must go through the CALLER's locale, not always English. The
  // caller (fixtures/[fixtureId]/opengraph-image.tsx) already resolves
  // homeName/awayName itself for the common case; `lookup` only matters for
  // this residual null/null edge.
  it("optional `lookup` drives the null/null fallback text; omitting it keeps the old English default (back-compat)", () => {
    const nullNames = { ...base, homeName: null, awayName: null, youth: false, entrantKind: "individual" as const };
    const esLookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor("es", k, v);
    const es = fixtureCardModel({ ...nullNames, lookup: esLookup });
    expect(es.home).toBe("Por confirmar"); // es schedule.tbd
    expect(es.away).toBe("Por confirmar");

    const defaulted = fixtureCardModel(nullNames); // no `lookup` passed at all
    expect(defaulted.home).toBe("TBD"); // en schedule.tbd — unchanged behaviour
    expect(defaulted.away).toBe("TBD");
  });

  // N1c c4 — a youth card's hidden away side printed a hardcoded English
  // "Match centre" whatever the org's language. It comes from the dictionary
  // through the caller's `lookup`, like the TBD fallback above.
  it("youth individuals: the hidden away side reads og.matchCentre in the caller's locale (es), not English", () => {
    const esLookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) => msgFor("es", k, v);
    const m = fixtureCardModel({ ...base, youth: true, entrantKind: "individual", lookup: esLookup });
    expect(msgFor("es", "og.matchCentre"), "the premise: es differs from en").not.toBe(msgFor("en", "og.matchCentre"));
    expect(m.away).toBe(msgFor("es", "og.matchCentre"));

    const defaulted = fixtureCardModel({ ...base, youth: true, entrantKind: "individual" });
    expect(defaulted.away).toBe(msgFor("en", "og.matchCentre"));
  });
});
