// W3 app-B T3 (owner Q2, 2026-11-03): the per-row facts the two standings tables mark - an entrant's pairing bye round(s)
// and the round a late entrant joined. They are read off the stage's REAL fixture rows: the bye shells (`sw-r{n}-bye`, the
// one `isSwissByeShellExtKey` predicate) and Task 8's `swissAbsentRounds` - the same absent-rounds logic the engine's
// Buchholz reads - never a second derivation.
//
// The scene is the one the DB tests build: four players start, two rounds are paired and played, a fifth joins at round 3
// (so rounds 1-2 are her absent rounds), and the odd field gives round 3's bye to Dogwood.
import { describe, expect, it } from "vitest";
import { swissAbsentRounds } from "@/server/engine-db/swiss-absent-rounds";
import { swissRowFacts, swissRowFactsFor, type RowFactsFixture } from "../swiss-row-facts";

let n = 0;
const board = (stage: string, round: number, k: number, home: string | null, away: string | null, status = "decided"): RowFactsFixture => ({
  stage_id: stage,
  round_no: round,
  ext_key: `sw-r${round}-b${k}`,
  home_entrant_id: home,
  away_entrant_id: away,
  outcome: home === null ? null : { kind: "win", winner: home, loser: away },
  status,
});
const bye = (stage: string, round: number, holder: string | null, status = "decided"): RowFactsFixture => ({
  stage_id: stage,
  round_no: round,
  ext_key: `sw-r${round}-bye`,
  home_entrant_id: holder,
  away_entrant_id: null,
  outcome: holder === null ? null : { kind: "award", winner: holder, loser: null, reason: "bye" },
  status,
});

const S = "stage-swiss";
const ENTRANTS = ["Ash", "Birch", "Cedar", "Dogwood", "Elm"];
/** Rounds 1-2 of four players; Elm joins at round 3, where Dogwood sits out. */
const scene = (): RowFactsFixture[] => [
  board(S, 1, 1, "Ash", "Birch"),
  board(S, 1, 2, "Cedar", "Dogwood"),
  board(S, 2, 1, "Ash", "Cedar"),
  board(S, 2, 2, "Birch", "Dogwood"),
  board(S, 3, 1, "Ash", "Elm"),
  board(S, 3, 2, "Birch", "Cedar"),
  bye(S, 3, "Dogwood"),
];

describe("swissRowFacts (X-SW-8 / owner Q2: the bye and the late join, from the stage's real fixtures)", () => {
  it("empty case first: no fixtures, or no entrants, is nobody marked", () => {
    expect(swissRowFacts([], ENTRANTS)).toEqual({});
    expect(swissRowFacts(scene(), [])).toEqual({});
  });

  it("a bye holder is marked with the round, a late entrant with the round she joined, and nobody else is (counted)", () => {
    const facts = swissRowFacts(scene(), ENTRANTS);
    expect(facts).toEqual({
      Dogwood: { byeRounds: [3], joinedRound: null },
      Elm: { byeRounds: [], joinedRound: 3 },
    });
    // the positive pair: the on-time, byeless entrants have no key at all (an absent key is "nothing to mark")
    for (const id of ["Ash", "Birch", "Cedar"]) expect(Object.hasOwn(facts, id), id).toBe(false);
    expect(Object.keys(facts), "entrants marked").toHaveLength(2);
  });

  it("the late join reads Task 8's absent rounds: the marked rounds ARE what swissAbsentRounds returns for her (no second derivation)", () => {
    const fixtures = scene();
    const absent = swissAbsentRounds(fixtures, ENTRANTS);
    expect(absent.get("Elm"), "premise: Task 8's producer says Elm missed rounds 1 and 2").toEqual([1, 2]);
    // joinedRound is the first round AFTER the absent prefix; derived here from the producer's own answer, not typed
    const missed = absent.get("Elm")!;
    expect(swissRowFacts(fixtures, ENTRANTS).Elm!.joinedRound).toBe(missed[missed.length - 1]! + 1);
  });

  it("an entrant who left (absent only from the rounds AFTER she played) is not a late join", () => {
    // Fern played rounds 1-2 and holds no seat in round 3: absent from round 3, which is a departure, not a late entry.
    const fixtures = [
      board(S, 1, 1, "Ash", "Fern"),
      board(S, 2, 1, "Ash", "Fern"),
      board(S, 3, 1, "Ash", "Birch"),
    ];
    const absent = swissAbsentRounds(fixtures, ["Ash", "Birch", "Fern"]);
    expect(absent.get("Fern"), "premise: Fern is absent from round 3").toEqual([3]);
    expect(swissRowFacts(fixtures, ["Ash", "Birch", "Fern"]).Fern, "no marker for a departure").toBeUndefined();
    // Birch, though, was absent from rounds 1 and 2 and joined at 3
    expect(swissRowFacts(fixtures, ["Ash", "Birch", "Fern"]).Birch).toEqual({ byeRounds: [], joinedRound: 3 });
  });

  it("a table entrant who holds NO seat on any Swiss round (only an ad-hoc or round-less row) was never in the pairing, so she did not 'join' at round N+1", () => {
    // The engine's table lists every entrant holding a seat on ANY fixture of the stage (`engine-db/competition.ts`, the entrant set
    // built from each fixture's home and away), so a Swiss table can carry an entrant that no Swiss board or bye ever seated: one
    // whose only row is an ad-hoc fixture (a legacy `addFixture` on a Swiss stage) or a round-less one. An entrant with NO seat at
    // all is not on the table, so this guard is reachable only through those rows. Every open round is such an entrant's to miss,
    // so the unbroken absent prefix runs to the end: reading it as "joined after it" would print "From R3" on an entrant who never
    // played a round. Each way of holding only a non-Swiss seat is a case.
    const cases: [string, RowFactsFixture][] = [
      ["an ad-hoc row in a round Swiss never paired", { ...board(S, 9, 2, "Gale", "Ash"), ext_key: `adhoc-${++n}` }],
      ["a round-less row", { ...board(S, 1, 2, "Gale", "Ash"), round_no: null }],
    ];
    for (const [label, seat] of cases) {
      const fixtures = [board(S, 1, 1, "Ash", "Birch"), board(S, 2, 1, "Ash", "Birch"), seat];
      const entrants = ["Ash", "Birch", "Gale"];
      expect(fixtures.some((f) => f.home_entrant_id === "Gale"), `premise (${label}): Gale holds a seat, so the engine's table lists her`).toBe(true);
      const absent = swissAbsentRounds(fixtures, entrants);
      expect(absent.get("Gale"), `premise (${label}): Task 8's producer says Gale missed both Swiss rounds`).toEqual([1, 2]);
      const facts = swissRowFacts(fixtures, entrants);
      expect(facts.Gale, `${label}: no 'From R3' for an entrant who never took a Swiss seat`).toBeUndefined();
      expect(facts, `${label}: and nobody else is marked`).toEqual({});
    }
  });

  it("an unseated bye shell, a voided bye and an ad-hoc row mark nobody", () => {
    const base = [board(S, 1, 1, "Ash", "Birch")];
    expect(swissRowFacts([...base, bye(S, 1, null)], ["Ash", "Birch"]), "a bye shell Pair has not seated").toEqual({});
    expect(swissRowFacts([...base, bye(S, 1, "Cedar", "void")], ["Ash", "Birch", "Cedar"]).Cedar?.byeRounds, "a voided bye is no bye").toBeUndefined();
    // an ad-hoc row (a legacy addFixture on a Swiss stage) is not a Swiss round: it opens nothing, so nobody is absent from it
    const adhoc: RowFactsFixture = { ...board(S, 2, 1, "Ash", "Birch"), ext_key: `adhoc-${++n}` };
    expect(swissRowFacts([...base, adhoc], ["Ash", "Birch"]), "no phantom late join from an ad-hoc round").toEqual({});
    // An ad-hoc bye-shaped key is no bye either (the key is not a Swiss shell's).
    const adhocBye: RowFactsFixture = { ...bye(S, 2, "Birch"), ext_key: `adhoc-${++n}` };
    expect(swissRowFacts([...base, adhocBye], ["Ash", "Birch"]).Birch?.byeRounds, "an ad-hoc row is no bye shell").toBeUndefined();
  });

  it("a second bye is listed in round order (an entrant can sit out twice in a long event)", () => {
    const fixtures = [board(S, 1, 1, "Ash", "Birch"), bye(S, 1, "Cedar"), board(S, 2, 1, "Ash", "Cedar"), bye(S, 2, "Birch"), board(S, 3, 1, "Ash", "Birch"), bye(S, 3, "Cedar")];
    expect(swissRowFacts(fixtures, ["Ash", "Birch", "Cedar"]).Cedar).toEqual({ byeRounds: [1, 3], joinedRound: null });
  });

  it("a late entrant who also sits out a later round carries both", () => {
    const fixtures = [board(S, 1, 1, "Ash", "Birch"), board(S, 2, 1, "Ash", "Birch"), board(S, 3, 1, "Ash", "Birch"), bye(S, 3, "Cedar"), board(S, 4, 1, "Cedar", "Ash"), bye(S, 4, "Birch")];
    expect(swissRowFacts(fixtures, ["Ash", "Birch", "Cedar"]).Cedar).toEqual({ byeRounds: [3], joinedRound: 3 });
  });
});

describe("swissRowFactsFor (the one entry the four pages call)", () => {
  const rows = ENTRANTS.map((entrantId) => ({ entrantId }));

  it("a stage that is not Swiss has no facts to mark, whatever its fixtures look like", () => {
    expect(swissRowFactsFor({ id: S, kind: "league" }, scene(), rows)).toBeUndefined();
    expect(swissRowFactsFor({ id: S, kind: "group" }, scene(), rows)).toBeUndefined();
  });

  it("a Swiss stage reads its OWN fixtures only: another stage's bye marks nobody here", () => {
    const other = [...scene(), { ...bye("stage-other", 4, "Ash") }];
    const facts = swissRowFactsFor({ id: S, kind: "swiss" }, other, rows);
    expect(facts).toEqual(swissRowFactsFor({ id: S, kind: "swiss" }, scene(), rows));
    expect(facts!.Ash, "Ash's bye is in the other stage").toBeUndefined();
    expect(Object.keys(facts!)).toHaveLength(2);
  });

  it("a Swiss stage with no fixtures yet returns an empty record, not undefined (the table is Swiss, there is just nothing to mark)", () => {
    expect(swissRowFactsFor({ id: S, kind: "swiss" }, [], rows)).toEqual({});
  });
});
