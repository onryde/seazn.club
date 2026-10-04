// B05 T4 — unit coverage for lib/oracle.ts, the comparators the whole
// simulation wave exists for.
//
// Every fetch wrapper is exercised through an injected `OracleTransport`
// fake (`{ raw }`, the same narrow-DI shape `advance.ts`/`simulate.ts` use)
// — nothing here touches `global.fetch` or a real server. Every comparator
// is pure and unit-tested directly, with NO transport at all.
//
// What this file pins, and why:
//  * D6 — the runtime oracle is provably distinct from stage 0's own OFFLINE
//    self-consistency check: mutating an event AFTER stage 0 passes does not
//    make stage 0 fail (it never reads events for this), but DOES red the
//    runtime comparator once fed the value that mutation would actually
//    produce.
//  * The two-crossing rank comparison is fed two INDEPENDENTLY CONSTRUCTED
//    arrays (never the same object read twice) so a disagreement test can
//    actually disagree.
//  * A leaderboard entry whose NAME matches and whose COUNT does not must
//    red on the count specifically — asserting a count alone would pass for
//    the wrong player, asserting a name alone would pass for the wrong
//    tally (design §8).
//  * The tie-order cascade comparator is fed an ORDERING-DIFFERENTIAL
//    fixture — two rows tied on points, where cascade order A picks one
//    winner and cascade order B picks the other — so the test can actually
//    tell which cascade ran, not merely that the two rows are present.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { newSession, type RawResult, type Session } from "../http.ts";
import { loadPackValue } from "../pack-io.ts";
import { TINY_PACK_PATH } from "../suites/tiny.ts";
import {
  compareCareerStats,
  compareChampion,
  compareLeaderboard,
  comparePersonDivisionStat,
  compareRankCrossings,
  compareStandings,
  compareTieOrderCascade,
  fetchDivisionPlayerStats,
  fetchPersonCareerStats,
  fetchPersonStats,
  fetchStandings,
  renderChampionMismatch,
  renderLeaderboardMismatch,
  renderRankCrossingMismatch,
  renderSideBySide,
  renderStandingsMismatch,
  renderUndeclaredMetrics,
  resolveTieWinner,
  standingsRankOrder,
  type DivisionPlayerStatsWire,
  type ExpectedCareerStat,
  type ExpectedSuspension,
  type SuspensionFixtureSheet,
  type SuspensionWire,
  compareSuspensions,
  suspensionMismatchReasons,
  type ExpectedLeaderboardEntry,
  type ExpectedStandingsRow,
  type OracleTransport,
  type PersonCareerStatsWire,
  type PersonStatsWire,
  type StandingsRowWire,
  type StandingsWire,
} from "../oracle.ts";

const BASE = "http://bench.example";

function session(): Session {
  return newSession();
}

function fakeRaw(handler: (path: string, method: string, body: unknown) => RawResult): OracleTransport {
  return {
    async raw(_base, _s, path, method = "GET", body): Promise<RawResult> {
      return handler(path, method, body);
    },
  };
}

// ---------------------------------------------------------------------------
// Fetch wrappers
// ---------------------------------------------------------------------------

describe("fetchStandings", () => {
  const okBody: StandingsWire = {
    stage_id: "stage-1",
    pool_id: null,
    rows: [{ entrantId: "e1", played: 1, won: 1, drawn: 0, lost: 0, points: 3 }],
    computed_through_seq: 5,
    updated_at: "2026-09-07T00:00:00.000Z",
  };

  it("returns the standings data on 200", async () => {
    const t = fakeRaw((path) => {
      expect(path).toBe("/api/v1/stages/stage-1/standings");
      return { status: 200, json: { ok: true, data: okBody } };
    });
    const out = await fetchStandings(BASE, session(), "stage-1", undefined, t);
    expect(out).toEqual(okBody);
  });

  it("appends pool_id when given", async () => {
    const t = fakeRaw((path) => {
      expect(path).toBe("/api/v1/stages/stage-1/standings?pool_id=A");
      return { status: 200, json: { ok: true, data: okBody } };
    });
    await fetchStandings(BASE, session(), "stage-1", "A", t);
  });

  it("throws with the refusal's code and message on a non-200", async () => {
    const t = fakeRaw(() => ({
      status: 404,
      json: { ok: false, error: { code: "NOT_FOUND", message: "stage not found" } },
    }));
    await expect(fetchStandings(BASE, session(), "stage-x", undefined, t)).rejects.toThrow(/NOT_FOUND/);
  });

  // Minors row 7 (task-1-review.md M4 / re-review §4): `dataOf`'s "carried
  // no data" throw is now a shared factory (`makeDataOf`, bound to "oracle"
  // here) rather than a hand copy also living in `advance.ts` — this pins
  // that the shared prefix/label/path are still all present after the fold.
  it("throws when a 200 carries no data instead of reporting an empty standings table", async () => {
    const t = fakeRaw(() => ({ status: 200, json: { ok: true } }));
    await expect(fetchStandings(BASE, session(), "stage-1", undefined, t)).rejects.toThrow(
      /oracle: standings response for \/api\/v1\/stages\/stage-1\/standings carried no data/,
    );
  });
});

describe("fetchDivisionPlayerStats", () => {
  it("returns the leaderboard data on 200", async () => {
    const body: DivisionPlayerStatsWire = {
      metrics: [{ key: "points", label: "Points" }],
      rows: [{ person_id: "p1", full_name: "Ana", stats: { points: 2 } }],
      requires_detailed_scoring: false,
    };
    const t = fakeRaw((path) => {
      expect(path).toBe("/api/v1/divisions/div-1/stats/players");
      return { status: 200, json: { ok: true, data: body } };
    });
    const out = await fetchDivisionPlayerStats(BASE, session(), "div-1", t);
    expect(out).toEqual(body);
  });

  it("throws on refusal", async () => {
    const t = fakeRaw(() => ({ status: 402, json: { ok: false, error: { code: "PAYMENT_REQUIRED" } } }));
    await expect(fetchDivisionPlayerStats(BASE, session(), "div-1", t)).rejects.toThrow(/PAYMENT_REQUIRED/);
  });
});

describe("fetchPersonStats / fetchPersonCareerStats", () => {
  it("fetchPersonStats hits the plain route", async () => {
    const body: PersonStatsWire = { divisions: [{ division_id: "d1", division_name: "D", stats: { points: 2 } }] };
    const t = fakeRaw((path) => {
      expect(path).toBe("/api/v1/persons/p1/stats");
      return { status: 200, json: { ok: true, data: body } };
    });
    const out = await fetchPersonStats(BASE, session(), "p1", undefined, t);
    expect(out).toEqual(body);
  });

  it("fetchPersonStats appends division_id", async () => {
    const t = fakeRaw((path) => {
      expect(path).toBe("/api/v1/persons/p1/stats?division_id=d1");
      return { status: 200, json: { ok: true, data: { divisions: [] } } };
    });
    await fetchPersonStats(BASE, session(), "p1", "d1", t);
  });

  it("fetchPersonCareerStats hits ?group=sport", async () => {
    const body: PersonCareerStatsWire = {
      sports: [{ sport_key: "football", sport_label: "Football", metrics: [], divisions: 1, variants: 1, matches: 3 }],
    };
    const t = fakeRaw((path) => {
      expect(path).toBe("/api/v1/persons/p1/stats?group=sport");
      return { status: 200, json: { ok: true, data: body } };
    });
    const out = await fetchPersonCareerStats(BASE, session(), "p1", t);
    expect(out).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// renderSideBySide
// ---------------------------------------------------------------------------

describe("renderSideBySide", () => {
  it("renders nothing readable as '(no mismatches)'", () => {
    expect(renderSideBySide([])).toBe("(no mismatches)");
  });

  it("renders BOTH the expected and actual value for a mismatch, legibly", () => {
    const out = renderSideBySide([{ label: "rank 1", expected: "e-alpha Pts7", actual: "e-alpha Pts1" }]);
    expect(out).toContain("rank 1");
    expect(out).toContain("expected:");
    expect(out).toContain("e-alpha Pts7");
    expect(out).toContain("actual:");
    expect(out).toContain("e-alpha Pts1");
  });
});

// ---------------------------------------------------------------------------
// compareStandings
// ---------------------------------------------------------------------------

const expectedTable: ExpectedStandingsRow[] = [
  { entrantId: "e-alpha", played: 3, won: 2, drawn: 1, lost: 0, points: 7 },
  { entrantId: "e-bravo", played: 3, won: 0, drawn: 1, lost: 2, points: 1 },
];

describe("compareStandings", () => {
  it("matches an identical, same-order actual", () => {
    const actual: StandingsRowWire[] = expectedTable.map((r) => ({ ...r }));
    const cmp = compareStandings(expectedTable, actual);
    expect(cmp.matched).toBe(true);
    expect(cmp.rows.every((r) => r.matched)).toBe(true);
  });

  it("reds when a field disagrees (points), and the mismatch renders BOTH sides", () => {
    const actual: StandingsRowWire[] = [
      { ...expectedTable[0]!, points: 1 }, // wrong — the actual product bug class this guards
      { ...expectedTable[1]! },
    ];
    const cmp = compareStandings(expectedTable, actual);
    expect(cmp.matched).toBe(false);
    expect(cmp.rows[0]!.mismatchFields).toContain("points");
    const rendered = renderStandingsMismatch(cmp);
    // LABELLED association, not just "both values appear somewhere" — a
    // mutant that swapped which side is rendered as "expected" vs "actual"
    // must be caught, not just one that dropped a value entirely.
    expect(rendered).toMatch(/expected:\s*e-alpha[^\n]*Pts7/);
    expect(rendered).toMatch(/actual:\s*e-alpha[^\n]*Pts1/);
  });

  it("is LENGTH-sensitive the OTHER way too: an actual LONGER than expected is not silently ignored", () => {
    const extra: StandingsRowWire[] = [...expectedTable.map((r) => ({ ...r })), { entrantId: "e-charlie", played: 3, won: 1, drawn: 1, lost: 1, points: 4 }];
    const cmp = compareStandings(expectedTable, extra);
    expect(cmp.matched).toBe(false);
  });

  it("is ORDER-sensitive: a same-length, reordered actual does not match", () => {
    const reordered: StandingsRowWire[] = [{ ...expectedTable[1]! }, { ...expectedTable[0]! }];
    const cmp = compareStandings(expectedTable, reordered);
    expect(cmp.matched).toBe(false);
  });

  it("catches an entrantId SWAP even when every scalar field is otherwise identical", () => {
    const evenlyMatched: ExpectedStandingsRow[] = [
      { entrantId: "e1", played: 2, won: 1, drawn: 0, lost: 1, points: 3 },
      { entrantId: "e2", played: 2, won: 1, drawn: 0, lost: 1, points: 3 },
    ];
    // Same stats on both sides, but e1/e2's IDENTITIES are swapped —
    // no scalar field differs, so only the entrantId check itself can see
    // this.
    const swapped: StandingsRowWire[] = [
      { entrantId: "e2", played: 2, won: 1, drawn: 0, lost: 1, points: 3 },
      { entrantId: "e1", played: 2, won: 1, drawn: 0, lost: 1, points: 3 },
    ];
    const cmp = compareStandings(evenlyMatched, swapped);
    expect(cmp.matched).toBe(false);
    expect(cmp.rows[0]!.mismatchFields).toContain("entrantId");
  });

  it("the EMPTY set is checked explicitly: empty expected + empty actual matches", () => {
    const cmp = compareStandings([], []);
    expect(cmp.matched).toBe(true);
    expect(cmp.rows).toHaveLength(0);
  });

  it("the EMPTY set is checked explicitly: empty actual against a non-empty expected reds, never vacuously", () => {
    const cmp = compareStandings(expectedTable, []);
    expect(cmp.matched).toBe(false);
    expect(cmp.rows.every((r) => !r.matched)).toBe(true);
  });

  it("compares metrics by value, not by reference/key-order", () => {
    const withMetrics: ExpectedStandingsRow[] = [{ ...expectedTable[0]!, metrics: { diff: 4, buchholz: 2 } }];
    const same: StandingsRowWire[] = [{ ...withMetrics[0]!, metrics: { buchholz: 2, diff: 4 } }];
    expect(compareStandings(withMetrics, same).matched).toBe(true);
    const different: StandingsRowWire[] = [{ ...withMetrics[0]!, metrics: { buchholz: 2, diff: 5 } }];
    expect(compareStandings(withMetrics, different).matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B05 T6 fix 1 — a metric the pack does NOT declare is not a failure
//
// The first LIVE run reds two of three standings tables on nothing but this
// (`bench-report/4b739e59.../report.md:34-39`): every field `_tiny.json`'s
// `expected.tables` DECLARES for `d-tiny/s-league` — played, won, drawn,
// lost, points and the entrant identity — matched exactly, and the row still
// failed because the LIVE row carries a football `for/diff/against` map the
// pack never mentions. `d-badminton` fails identically on
// `sets_won/sets_lost/points_won/points_lost`; `d-tiebreak` passes ONLY
// because T5a's tie work happened to declare those three keys.
//
// The rule these tests pin, in BOTH directions: a metric the pack DECLARES
// must match (a live value that differs, or is absent, still reds); a metric
// it does not declare is carried as `undeclaredMetrics` — visible, never a
// failure, and never silently discarded (discarding is how a genuinely wrong
// metric would hide).
//
// Every expected value below is read out of the committed pack, never typed
// here; the only literals are the LIVE metric maps, which are transcribed
// from that live run's own report and are the `actual` side by definition.
// ---------------------------------------------------------------------------

/** The live `GET /stages/{id}/standings` metrics for `_tiny.json`'s two
 *  metric-less tables, verbatim from the first live run's report.md — the
 *  shape the product actually answers with, which no fixture in this repo
 *  had ever carried. */
const LIVE_UNDECLARED_METRICS: Readonly<Record<string, readonly Record<string, number>[]>> = {
  "s-league": [
    { for: 5, diff: 2, against: 3 },
    { for: 3, diff: -2, against: 5 },
  ],
  "s-badminton-league": [
    { sets_won: 2, sets_lost: 0, points_won: 42, points_lost: 33 },
    { sets_won: 0, sets_lost: 2, points_won: 33, points_lost: 42 },
  ],
};

async function packTable(stageRef: string): Promise<ExpectedStandingsRow[]> {
  const loaded = loadPackValue(JSON.parse(await readFile(TINY_PACK_PATH, "utf8")), TINY_PACK_PATH);
  if (!loaded.ok) throw new Error(`_tiny.json did not load: ${JSON.stringify(loaded.errors)}`);
  const table = loaded.pack.expected.tables.find((t) => t.stageRef === stageRef);
  if (table === undefined) throw new Error(`_tiny.json declares no expected.tables row for "${stageRef}"`);
  // `entrant` is a pack REF, not a resolved id — the comparator only ever
  // compares it as an opaque string, so the ref IS a usable identity here
  // (and keeps this test derived from the pack rather than from a seed run).
  return table.rows.map((r) => ({
    entrantId: r.entrant,
    played: r.played,
    won: r.won,
    drawn: r.drawn,
    lost: r.lost,
    points: r.points,
    ...(r.metrics === undefined ? {} : { metrics: r.metrics }),
  }));
}

describe("B05 T6 — compareStandings and metrics the pack never declared", () => {
  for (const stageRef of ["s-league", "s-badminton-league"] as const) {
    it(`"${stageRef}": an expected row with NO metrics map matches a live row that HAS one`, async () => {
      const expectedRows = await packTable(stageRef);
      // The premise this whole test rests on, asserted rather than assumed:
      // this pack table declares no metrics at all.
      expect(expectedRows.every((r) => r.metrics === undefined)).toBe(true);
      const liveMetrics = LIVE_UNDECLARED_METRICS[stageRef]!;
      expect(liveMetrics).toHaveLength(expectedRows.length);
      const live: StandingsRowWire[] = expectedRows.map((r, i) => ({ ...r, metrics: { ...liveMetrics[i]! } }));

      const cmp = compareStandings(expectedRows, live);
      expect(cmp.matched).toBe(true);
      expect(cmp.rows.every((r) => r.mismatchFields.length === 0)).toBe(true);
      // Carried, not discarded — every live key, with its live value.
      expect(cmp.rows.map((r) => r.undeclaredMetrics)).toEqual(liveMetrics.map((m) => ({ ...m })));
      const note = renderUndeclaredMetrics(cmp);
      for (const [i, m] of liveMetrics.entries()) {
        expect(note).toContain(expectedRows[i]!.entrantId);
        for (const [k, v] of Object.entries(m)) expect(note).toContain(`"${k}":${v}`);
      }
    });
  }

  it("renders nothing when every live metric was declared — the informational channel stays silent on a clean row", async () => {
    const expectedRows = await packTable("s-tiebreak-league");
    expect(expectedRows.every((r) => r.metrics !== undefined)).toBe(true);
    const live: StandingsRowWire[] = expectedRows.map((r) => ({ ...r, metrics: { ...r.metrics! } }));
    const cmp = compareStandings(expectedRows, live);
    expect(cmp.matched).toBe(true);
    expect(cmp.rows.every((r) => Object.keys(r.undeclaredMetrics).length === 0)).toBe(true);
    expect(renderUndeclaredMetrics(cmp)).toBe("");
  });

  it("a DECLARED metric whose live value differs still FAILS — the other direction", async () => {
    const expectedRows = await packTable("s-tiebreak-league");
    const declared = expectedRows[0]!.metrics!;
    const [key, value] = Object.entries(declared)[0]!;
    // Derived from the pack's own declared value, never a typed constant —
    // if the pack's `diff` moves, so does this.
    const live: StandingsRowWire[] = expectedRows.map((r, i) =>
      i === 0 ? { ...r, metrics: { ...declared, [key]: value + 1 } } : { ...r, metrics: { ...r.metrics! } },
    );
    const cmp = compareStandings(expectedRows, live);
    expect(cmp.matched).toBe(false);
    expect(cmp.rows[0]!.mismatchFields).toContain("metrics");
    // …and it is the DECLARED key that is named, not a blanket "metrics differ".
    expect(cmp.rows[0]!.mismatchedMetrics).toEqual([key]);
    expect(cmp.rows[0]!.undeclaredMetrics).toEqual({});
  });

  it("a DECLARED metric the live row does not carry AT ALL still FAILS — absence is not agreement", async () => {
    const expectedRows = await packTable("s-tiebreak-league");
    const live: StandingsRowWire[] = expectedRows.map(({ metrics: _drop, ...rest }) => ({ ...rest }));
    const cmp = compareStandings(expectedRows, live);
    expect(cmp.matched).toBe(false);
    expect(cmp.rows[0]!.mismatchFields).toContain("metrics");
    expect(cmp.rows[0]!.mismatchedMetrics).toEqual(Object.keys(expectedRows[0]!.metrics!));
  });

  it("a live row carrying BOTH a wrong declared metric and an undeclared one fails on the declared one only", async () => {
    const expectedRows = await packTable("s-tiebreak-league");
    const declared = expectedRows[0]!.metrics!;
    const [key, value] = Object.entries(declared)[0]!;
    const live: StandingsRowWire[] = expectedRows.map((r, i) =>
      i === 0
        ? { ...r, metrics: { ...declared, [key]: value + 1, sets_won: 9 } }
        : { ...r, metrics: { ...r.metrics! } },
    );
    const cmp = compareStandings(expectedRows, live);
    expect(cmp.matched).toBe(false);
    expect(cmp.rows[0]!.mismatchedMetrics).toEqual([key]);
    expect(cmp.rows[0]!.undeclaredMetrics).toEqual({ sets_won: 9 });
  });
});

// ---------------------------------------------------------------------------
// resolveTieWinner / compareTieOrderCascade — the ORDERING-DIFFERENTIAL case
// ---------------------------------------------------------------------------

describe("resolveTieWinner / compareTieOrderCascade", () => {
  // Tied on points; diff favours A, buchholz favours B — a genuine
  // ordering-differential fixture, not a membership one.
  const a: StandingsRowWire = { entrantId: "a", played: 3, won: 1, drawn: 1, lost: 1, points: 4, metrics: { diff: 5, buchholz: 2 } };
  const b: StandingsRowWire = { entrantId: "b", played: 3, won: 1, drawn: 1, lost: 1, points: 4, metrics: { diff: 3, buchholz: 6 } };

  it("cascade [points, diff] picks A", () => {
    expect(resolveTieWinner(["points", "diff"], a, b)).toBe("a");
  });

  it("the SAME two rows, cascade [points, buchholz] picks B — same data, different cascade, different result", () => {
    expect(resolveTieWinner(["points", "buchholz"], a, b)).toBe("b");
  });

  it("is 'unresolvable' when a decisive key has no readable value on either row (an h2h_* key)", () => {
    expect(resolveTieWinner(["points", "h2h_diff"], a, b)).toBe("unresolvable");
  });

  it("is 'tie' when every cascade key agrees", () => {
    expect(resolveTieWinner(["points"], a, { ...b, metrics: { diff: 5, buchholz: 2 } })).toBe("tie");
  });

  it("compareTieOrderCascade matches when the live order agrees with the cascade [points, diff] (A ranked ahead)", () => {
    const cmp = compareTieOrderCascade(["points", "diff"], [a, b]);
    expect(cmp.matched).toBe(true);
    expect(cmp.checkedPairs).toBe(1);
    expect(cmp.skippedPairs).toBe(0);
  });

  it("compareTieOrderCascade reds when the SAME data is ranked against the SAME cascade in the WRONG order", () => {
    // b ranked ahead of a, but cascade [points, diff] says a should be first.
    const cmp = compareTieOrderCascade(["points", "diff"], [b, a]);
    expect(cmp.matched).toBe(false);
    expect(cmp.issues).toHaveLength(1);
  });

  it("a non-tie (different points) needs no tiebreak and is reported as such — not a false pass on a check never run", () => {
    const notTied: StandingsRowWire[] = [
      { entrantId: "x", played: 1, won: 1, drawn: 0, lost: 0, points: 3 },
      { entrantId: "y", played: 1, won: 0, drawn: 0, lost: 1, points: 0 },
    ];
    const cmp = compareTieOrderCascade(["points", "diff"], notTied);
    expect(cmp.matched).toBe(true);
    expect(cmp.checkedPairs).toBe(0);
  });

  it("the empty set (no rows, or one row) is checked explicitly and needs no tiebreak", () => {
    expect(compareTieOrderCascade(["points"], [])).toMatchObject({ matched: true, checkedPairs: 0, skippedPairs: 0 });
    expect(compareTieOrderCascade(["points"], [a])).toMatchObject({ matched: true, checkedPairs: 0, skippedPairs: 0 });
  });

  it("an unresolvable pair is SKIPPED, not silently passed as matched-with-no-issue miscounted as checked", () => {
    const cmp = compareTieOrderCascade(["h2h_diff"], [a, b]);
    expect(cmp.matched).toBe(true); // no issues raised
    expect(cmp.checkedPairs).toBe(0); // but nothing was actually checked
    expect(cmp.skippedPairs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// standingsRankOrder / compareRankCrossings — the two-crossing check
// ---------------------------------------------------------------------------

describe("standingsRankOrder", () => {
  it("sorts by rank ascending", () => {
    const rows: StandingsRowWire[] = [
      { entrantId: "b", played: 0, won: 0, drawn: 0, lost: 0, points: 0, rank: 2 },
      { entrantId: "a", played: 0, won: 0, drawn: 0, lost: 0, points: 0, rank: 1 },
    ];
    expect(standingsRankOrder(rows)).toEqual(["a", "b"]);
  });

  it("sorts undefined ranks last, stably", () => {
    const rows: StandingsRowWire[] = [
      { entrantId: "no-rank-1", played: 0, won: 0, drawn: 0, lost: 0, points: 0 },
      { entrantId: "ranked", played: 0, won: 0, drawn: 0, lost: 0, points: 0, rank: 1 },
      { entrantId: "no-rank-2", played: 0, won: 0, drawn: 0, lost: 0, points: 0 },
    ];
    expect(standingsRankOrder(rows)).toEqual(["ranked", "no-rank-1", "no-rank-2"]);
  });
});

describe("compareRankCrossings", () => {
  // Two GENUINELY SEPARATE arrays each time — never the same object read
  // twice, per the coordinator's own clarification: otherwise the
  // "disagreement is a finding" test is decoration.
  it("matches when the two INDEPENDENTLY SOURCED crossings agree", () => {
    const captured = ["e-alpha", "e-bravo"];
    const standings = ["e-alpha", "e-bravo"];
    expect(captured).not.toBe(standings); // genuinely separate arrays
    const cmp = compareRankCrossings(captured, standings);
    expect(cmp.matched).toBe(true);
  });

  it("REDS when the captured response and the re-read standings DISAGREE", () => {
    const captured = ["e-alpha", "e-bravo"]; // the engine's own captured intent
    const standings = ["e-bravo", "e-alpha"]; // what a customer would see, independently re-read
    const cmp = compareRankCrossings(captured, standings);
    expect(cmp.matched).toBe(false);
    const rendered = renderRankCrossingMismatch(cmp);
    expect(rendered).toMatch(/expected:[^\n]*e-alpha, e-bravo/);
    expect(rendered).toMatch(/actual:[^\n]*e-bravo, e-alpha/);
  });

  it("an absent capture never counts as agreement", () => {
    const cmp = compareRankCrossings(undefined, ["e-alpha", "e-bravo"]);
    expect(cmp.matched).toBe(false);
  });

  // Review MAJOR: `[].every(...)` is vacuously true and 0===0, so the naive
  // length+every check reported `matched: true` for two GENUINELY EMPTY
  // arrays — there is nothing to agree ON, so this must never read as a pass.
  it("the EMPTY set: empty captured against empty standings is NOT a vacuous match — nothing to agree on", () => {
    const cmp = compareRankCrossings([], []);
    expect(cmp.matched).toBe(false);
    expect(cmp.reason).toBeDefined();
  });

  it("an empty captured against a NON-empty standings is also false-by-emptiness, not a length mismatch alone", () => {
    const cmp = compareRankCrossings([], ["e-alpha"]);
    expect(cmp.matched).toBe(false);
    expect(cmp.reason).toBeDefined();
  });

  it("its positive pair: a REAL non-empty agreement still matches, and carries no 'nothing to agree on' reason", () => {
    const captured = ["e-alpha", "e-bravo"];
    const standings = ["e-alpha", "e-bravo"];
    expect(captured).not.toBe(standings); // genuinely separate arrays, same discipline as the block's other tests
    const cmp = compareRankCrossings(captured, standings);
    expect(cmp.matched).toBe(true);
    expect(cmp.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// compareChampion
// ---------------------------------------------------------------------------

describe("compareChampion", () => {
  it("matches when standings, captured and expected all agree", () => {
    const cmp = compareChampion("e-alpha", ["e-alpha", "e-bravo"], ["e-alpha", "e-bravo"]);
    expect(cmp.matched).toBe(true);
    expect(cmp.crossingsAgree).toBe(true);
  });

  it("reds when standings' rank-1 disagrees with expected, even with no capture to contradict it", () => {
    const cmp = compareChampion("e-alpha", ["e-bravo", "e-alpha"], undefined);
    expect(cmp.matched).toBe(false);
    expect(cmp.crossingsAgree).toBe(true); // nothing to disagree with
  });

  it("reds when the two crossings disagree with EACH OTHER, even though standings alone matches expected", () => {
    const cmp = compareChampion("e-alpha", ["e-alpha", "e-bravo"], ["e-bravo", "e-alpha"]);
    expect(cmp.crossingsAgree).toBe(false);
    expect(cmp.matched).toBe(false);
    const rendered = renderChampionMismatch(cmp);
    expect(rendered).toMatch(/expected:\s*e-alpha/);
    expect(rendered).toMatch(/actual:[^\n]*standings: e-alpha[^\n]*captured: e-bravo/);
  });
});

// ---------------------------------------------------------------------------
// compareLeaderboard — name AND count
// ---------------------------------------------------------------------------

describe("compareLeaderboard", () => {
  const expected: ExpectedLeaderboardEntry[] = [
    { personId: "p-ana", name: "Ana Alvarez", count: 2 },
    { personId: "p-bo", name: "Bo Baptiste", count: 1 },
  ];

  it("matches when every entry's name AND count agree", () => {
    const actual: DivisionPlayerStatsWire = {
      metrics: [{ key: "scores", label: "Scores" }],
      rows: [
        { person_id: "p-ana", full_name: "Ana Alvarez", stats: { scores: 2 } },
        { person_id: "p-bo", full_name: "Bo Baptiste", stats: { scores: 1 } },
      ],
      requires_detailed_scoring: false,
    };
    const cmp = compareLeaderboard("scores", expected, actual);
    expect(cmp.matched).toBe(true);
  });

  it("REDS when the name matches but the COUNT does not — the exact vacuity trap design §8 names", () => {
    const actual: DivisionPlayerStatsWire = {
      metrics: [{ key: "scores", label: "Scores" }],
      rows: [
        { person_id: "p-ana", full_name: "Ana Alvarez", stats: { scores: 99 } }, // right person, WRONG count
        { person_id: "p-bo", full_name: "Bo Baptiste", stats: { scores: 1 } },
      ],
      requires_detailed_scoring: false,
    };
    const cmp = compareLeaderboard("scores", expected, actual);
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.nameMatched).toBe(true);
    expect(cmp.entries[0]!.countMatched).toBe(false);
    const rendered = renderLeaderboardMismatch(cmp);
    expect(rendered).toMatch(/expected:\s*Ana Alvarez = 2\b/);
    expect(rendered).toMatch(/actual:\s*Ana Alvarez = 99/);
  });

  it("reds when the count matches but the NAME does not (the wrong-player trap, its positive-pair complement)", () => {
    const actual: DivisionPlayerStatsWire = {
      metrics: [{ key: "scores", label: "Scores" }],
      rows: [
        { person_id: "p-ana", full_name: "Someone Else", stats: { scores: 2 } },
        { person_id: "p-bo", full_name: "Bo Baptiste", stats: { scores: 1 } },
      ],
      requires_detailed_scoring: false,
    };
    const cmp = compareLeaderboard("scores", expected, actual);
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.nameMatched).toBe(false);
    expect(cmp.entries[0]!.countMatched).toBe(true);
  });

  it("the EMPTY set: an empty actual leaderboard against non-empty expected reds every entry, never vacuously", () => {
    const actual: DivisionPlayerStatsWire = { metrics: [], rows: [], requires_detailed_scoring: true };
    const cmp = compareLeaderboard("scores", expected, actual);
    expect(cmp.matched).toBe(false);
    expect(cmp.entries.every((e) => !e.matched)).toBe(true);
  });

  it("empty expected against empty actual matches (nothing to check, honestly)", () => {
    const actual: DivisionPlayerStatsWire = { metrics: [], rows: [], requires_detailed_scoring: false };
    expect(compareLeaderboard("scores", [], actual).matched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compareCareerStats / comparePersonDivisionStat
// ---------------------------------------------------------------------------

describe("compareCareerStats", () => {
  const expected: ExpectedCareerStat[] = [{ personId: "p-ana", name: "Ana Alvarez", metricKey: "goals", count: 5 }];

  it("matches when the metric is found in exactly one sport with the right value", () => {
    const actual: PersonCareerStatsWire = {
      sports: [{ sport_key: "football", sport_label: "Football", metrics: [{ key: "goals", label: "Goals", value: 5 }], divisions: 1, variants: 1, matches: 3 }],
    };
    expect(compareCareerStats(expected, actual).matched).toBe(true);
  });

  it("reds when the value disagrees", () => {
    const actual: PersonCareerStatsWire = {
      sports: [{ sport_key: "football", sport_label: "Football", metrics: [{ key: "goals", label: "Goals", value: 1 }], divisions: 1, variants: 1, matches: 3 }],
    };
    expect(compareCareerStats(expected, actual).matched).toBe(false);
  });

  it("reds on an AMBIGUOUS metric key (found under two sports) rather than silently picking one", () => {
    const actual: PersonCareerStatsWire = {
      sports: [
        { sport_key: "football", sport_label: "Football", metrics: [{ key: "goals", label: "Goals", value: 5 }], divisions: 1, variants: 1, matches: 3 },
        { sport_key: "hockey", sport_label: "Hockey", metrics: [{ key: "goals", label: "Goals", value: 5 }], divisions: 1, variants: 1, matches: 2 },
      ],
    };
    const cmp = compareCareerStats(expected, actual);
    expect(cmp.entries[0]!.foundInSports).toBe(2);
    expect(cmp.matched).toBe(false);
  });

  it("the empty set: no expected careers is vacuously matched, and callers must check length before trusting it", () => {
    const cmp = compareCareerStats([], { sports: [] });
    expect(cmp.matched).toBe(true);
    expect(cmp.entries).toHaveLength(0);
  });
});

describe("comparePersonDivisionStat", () => {
  it("matches when the person's own division card agrees with the leaderboard's authored count", () => {
    const actual: PersonStatsWire = { divisions: [{ division_id: "div-1", division_name: "D", stats: { scores: 2 } }] };
    expect(comparePersonDivisionStat("scores", 2, "div-1", actual).matched).toBe(true);
  });

  it("reds when the person's own card disagrees with the same historical count the leaderboard already pins", () => {
    const actual: PersonStatsWire = { divisions: [{ division_id: "div-1", division_name: "D", stats: { scores: 99 } }] };
    expect(comparePersonDivisionStat("scores", 2, "div-1", actual).matched).toBe(false);
  });

  it("reds when the division is absent from the person's card entirely", () => {
    const actual: PersonStatsWire = { divisions: [] };
    const cmp = comparePersonDivisionStat("scores", 2, "div-1", actual);
    expect(cmp.matched).toBe(false);
    expect(cmp.actualCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D6 — the runtime oracle is provably distinct from stage 0
// ---------------------------------------------------------------------------
//
// Re-pinned against the real `validate-pack.ts`, not assumed: stage 0
// actually FOLDS `pack.streams.events` through the real engine module for
// two subjects — `match.*` (a fixture's own outcome/score line) and
// `standings.*` (a stage's aggregate table) — and reds a mutation to either.
// A flipped scoreline is therefore the WRONG mutation to prove D6 with: it
// would be caught at stage 0 too, which is not the point being proven.
//
// `validate-pack.ts`'s own header comment ("LIMITS — what stage 0 is KNOWN
// not to catch") names the RIGHT one verbatim: "A MIS-TRANSCRIBED SCORER.
// `generic.score.person` ... feeds `expected.leaderboards`, which stage 0
// does NOT derive ... Owed to B05's live run." — this is that regression.
describe("D6 — a mis-transcribed scorer stays invisible to stage 0, but reds the RUNTIME leaderboard oracle", () => {
  it("stage 0 stays green on a re-attributed generic.score event; compareLeaderboard reds against what the live product would derive", async () => {
    const raw = JSON.parse(await readFile(TINY_PACK_PATH, "utf8")) as Record<string, unknown>;

    const before = loadPackValue(structuredClone(raw), TINY_PACK_PATH);
    expect(before.ok).toBe(true);

    // d-tiny's "rr-r2-c1" stream carries three `generic.score` events: two
    // credited to @p-ana (1 point each) and one to @p-bo (2 points) — the
    // real source of `expected.leaderboards`' "scores"/"points" metrics for
    // this pack. Re-attribute p-bo's OWN scoring event to p-ana. The event's
    // `by` (the SIDE/entrant, e-bravo) is left untouched, so this changes
    // nothing about who won the fixture or the stage's aggregate table —
    // only which PERSON gets credit, which is exactly what stage 0 admits it
    // cannot see.
    const mutated = structuredClone(raw) as {
      streams: { fixtureExtKey: string; events: { type: string; payload?: Record<string, string | number> }[] }[];
    };
    const stream = mutated.streams.find((s) => s.fixtureExtKey === "rr-r2-c1");
    if (stream === undefined) throw new Error("test fixture assumption broken: rr-r2-c1 stream not found");
    const scoreEvents = stream.events.filter((e) => e.type === "generic.score");
    expect(scoreEvents).toHaveLength(3);
    const boEvent = scoreEvents.find((e) => e.payload?.person === "@p-bo");
    if (boEvent?.payload === undefined) throw new Error("test fixture assumption broken: no @p-bo scoring event");
    expect(boEvent.payload).toEqual({ by: "@e-bravo", points: 2, person: "@p-bo" });
    boEvent.payload.person = "@p-ana"; // the mis-transcription

    // Stage 0 does NOT derive `expected.leaderboards` from events at all
    // (`validate-pack.ts`'s own header comment) — the mutated pack still
    // validates clean, and says so explicitly via its own warning channel.
    const after = loadPackValue(mutated, TINY_PACK_PATH);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("unreachable — checked above");
    expect(after.warnings.some((w) => w.code === "leaderboards.not_derived")).toBe(true);

    // The pack's OWN `expected.leaderboards` is UNCHANGED by the mutation —
    // p-ana:2, p-bo:1 "scores", the real historical fact.
    const board = after.pack.expected.leaderboards.find((l) => l.divisionRef === "d-tiny" && l.metricKey === "scores");
    if (board === undefined) throw new Error("test fixture assumption broken: no d-tiny/scores leaderboard");
    const expectedEntries: ExpectedLeaderboardEntry[] = board.entries.map((e) => ({
      personId: e.person,
      name: e.name,
      count: e.count,
    }));
    expect(expectedEntries).toEqual([
      { personId: "p-ana", name: "Ana Alvarez", count: 2 },
      { personId: "p-bo", name: "Bo Baptiste", count: 1 },
    ]);

    // What the LIVE product would actually derive from the MUTATED stream —
    // p-ana now credited with THREE scoring events, p-bo with zero. This
    // stands in for a real fetch against `divisionPlayerStats`; it is
    // constructed independently of `pack.expected`, never re-read from it a
    // second time, which is the whole point of D6.
    const liveDerivedActual: DivisionPlayerStatsWire = {
      metrics: [{ key: "scores", label: "Scores" }],
      rows: [
        { person_id: "p-ana", full_name: "Ana Alvarez", stats: { scores: 3 } },
        { person_id: "p-bo", full_name: "Bo Baptiste", stats: { scores: 0 } },
      ],
      requires_detailed_scoring: false,
    };

    const runtimeCheck = compareLeaderboard("scores", expectedEntries, liveDerivedActual);
    // The RUNTIME oracle reds — even though stage 0 (an OFFLINE fold of
    // `pack.expected` that explicitly does not touch leaderboards) passed on
    // the very same mutated pack, and said so via its own warning.
    expect(runtimeCheck.matched).toBe(false);
    expect(runtimeCheck.entries.find((e) => e.personId === "p-bo")?.countMatched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B05 T5b-3 — compareSuspensions (discipline carry)
// ---------------------------------------------------------------------------
// Read `compareSuspensions`'s own header in oracle.ts first: it records WHY
// this comparator does not assert a 422 on the lineup route. It cannot —
// `putLineup` never reads the `suspensions` table, so a suspended player is
// accepted onto a team sheet by this product. What is asserted instead is the
// pair the product CAN answer, in both directions.

const SUS_DIVISION = "div-tiebreak";
const SUS_ENTRANT = "ent-foxtrot";
const BANNED = "person-hotel";
const CONTROL = "person-foxtrot";

function sheet(
  fixtureExtKey: string,
  missed: boolean,
  personIds: readonly string[],
): SuspensionFixtureSheet {
  return {
    fixtureExtKey,
    fixtureId: `fx-${fixtureExtKey}`,
    missed,
    lineup: {
      fixture_id: `fx-${fixtureExtKey}`,
      entrant_id: SUS_ENTRANT,
      slots: personIds.map((id) => ({ person_id: id, full_name: `name-${id}` })),
    },
  };
}

function activeBan(over: Partial<SuspensionWire> = {}): SuspensionWire {
  return {
    id: "sus-1",
    divisionId: SUS_DIVISION,
    personId: BANNED,
    personName: "Hana Okonkwo",
    entrantId: SUS_ENTRANT,
    status: "active",
    source: "manual",
    reason: "Dissent toward the match official",
    matchesTotal: 1,
    matchesServed: 0,
    ...over,
  };
}

const SUS_EXPECTED: ExpectedSuspension[] = [
  {
    personId: BANNED,
    personName: "Hana Okonkwo",
    divisionId: SUS_DIVISION,
    entrantId: SUS_ENTRANT,
    matchesTotal: 1,
    controlPersonId: CONTROL,
    controlPersonName: "Farid Haddad",
  },
];

/** The shape a correct run produces: the banned player off the MISSED sheet,
 *  on the PLAYED one; the control on both. */
function goodSheets(): SuspensionFixtureSheet[] {
  return [
    sheet("rr-r1-c1", false, [CONTROL, BANNED]),
    sheet("rr-r3-c1", true, [CONTROL]),
  ];
}

describe("compareSuspensions — the discipline carry", () => {
  it("matches when the ban is active, correctly sized, and lands on exactly the named fixture", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan()],
      sheets: goodSheets(),
    });
    expect(cmp.matched).toBe(true);
    const e = cmp.entries[0]!;
    expect(e.banFound).toBe(true);
    expect(e.playedFixturesChecked).toBe(1);
    expect(e.missedFixturesChecked).toBe(1);
    expect(suspensionMismatchReasons(e)).toEqual([]);
  });

  it("reds when the banned player is still named on the MISSED fixture's team sheet", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan()],
      sheets: [sheet("rr-r1-c1", false, [CONTROL, BANNED]), sheet("rr-r3-c1", true, [CONTROL, BANNED])],
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.presentOnMissed).toEqual(["rr-r3-c1"]);
    expect(suspensionMismatchReasons(cmp.entries[0]!)).toEqual([
      "still named on the team sheet of rr-r3-c1",
    ]);
  });

  // THE fixture-identity assertion. A ban that reaches every fixture is
  // absent from the named one too, so an oracle that only asked "was she
  // absent from rr-r3-c1?" would pass on it.
  it("reds a ban that reached a fixture the pack does NOT name — over-reach, not carry", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan()],
      sheets: [sheet("rr-r1-c1", false, [CONTROL]), sheet("rr-r3-c1", true, [CONTROL])],
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.absentOnPlayed).toEqual(["rr-r1-c1"]);
    expect(cmp.entries[0]!.presentOnMissed).toEqual([]);
    expect(suspensionMismatchReasons(cmp.entries[0]!)).toEqual([
      "missing from rr-r1-c1, which the pack does NOT name",
    ]);
  });

  // The POSITIVE half, and the reason it is mandatory: this `active` list
  // bans everybody, and every negative assertion above still holds on it.
  it("reds a product that refuses EVERYBODY — the eligible team-mate is banned too", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan(), activeBan({ id: "sus-2", personId: CONTROL, personName: "Farid Haddad" })],
      sheets: goodSheets(),
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.controlBanned).toBe(true);
    // Every NEGATIVE check still passes on this input — which is exactly why
    // the one-sided version of this oracle would have shipped green.
    expect(cmp.entries[0]!.presentOnMissed).toEqual([]);
    expect(cmp.entries[0]!.absentOnPlayed).toEqual([]);
    expect(cmp.entries[0]!.banFound).toBe(true);
  });

  it("reds a product that seats NOBODY — the eligible team-mate is off the sheets too", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan()],
      sheets: [sheet("rr-r1-c1", false, []), sheet("rr-r3-c1", true, [])],
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.controlMissingFrom).toEqual(["rr-r1-c1", "rr-r3-c1"]);
  });

  // The case above cannot KILL the control-presence clause on its own: an
  // empty sheet also removes the BANNED player from the played fixture, so
  // `absentOnPlayed` reds it first and the two guards cover for each other
  // (AGENTS.md failure class 3). This one moves only the control: the banned
  // player is off the missed sheet and on the played one, exactly as she
  // should be, and ONLY the team-mate's own presence can witness the fault.
  it("reds when ONLY the eligible team-mate is off the missed fixture — the banned player is placed correctly", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan()],
      sheets: [sheet("rr-r1-c1", false, [CONTROL, BANNED]), sheet("rr-r3-c1", true, [])],
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.presentOnMissed).toEqual([]);
    expect(cmp.entries[0]!.absentOnPlayed).toEqual([]);
    expect(cmp.entries[0]!.controlBanned).toBe(false);
    expect(cmp.entries[0]!.controlMissingFrom).toEqual(["rr-r3-c1"]);
    expect(suspensionMismatchReasons(cmp.entries[0]!)).toEqual([
      "the ELIGIBLE team-mate is off the team sheet of rr-r3-c1",
    ]);
  });

  it("reds a ban still PENDING — a row nobody confirmed is not a ban", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      // `listSuspensions(?status=active)` would not return this row at all;
      // the guard is here because a caller that forgot the filter would
      // otherwise match a pending row and call the carry proven.
      active: [activeBan({ status: "pending", entrantId: null })],
      sheets: goodSheets(),
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.banFound).toBe(false);
    expect(suspensionMismatchReasons(cmp.entries[0]!)).toEqual([
      `no ACTIVE suspension for "Hana Okonkwo" in this division`,
    ]);
  });

  // The mirror of the banned player's own PENDING case: a row nobody
  // confirmed is not a ban in EITHER direction. Without this, the status
  // filter on the control lookup has no killer of its own — every row a
  // `?status=active` read returns is active already, so only a fake that
  // hands back a pending one can witness the guard.
  it("does NOT count a PENDING row against the eligible team-mate", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [
        activeBan(),
        activeBan({ id: "sus-2", personId: CONTROL, personName: "Farid Haddad", status: "pending" }),
      ],
      sheets: goodSheets(),
    });
    expect(cmp.entries[0]!.controlBanned).toBe(false);
    expect(cmp.matched).toBe(true);
  });

  it("reds a ban length that disagrees with the number of fixtures the pack names", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan({ matchesTotal: 3 })],
      sheets: goodSheets(),
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.matchesTotalMatched).toBe(false);
    expect(cmp.entries[0]!.actualMatchesTotal).toBe(3);
  });

  it("reds a confirmed ban stamped against the wrong entrant", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan({ entrantId: "ent-echo" })],
      sheets: goodSheets(),
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.entrantMatched).toBe(false);
  });

  it("reds a ban recorded in a DIFFERENT division", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan({ divisionId: "div-tiny" })],
      sheets: goodSheets(),
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.banFound).toBe(false);
  });

  // The vacuity guards. An EMPTY `active` list must not read as "nothing to
  // disagree with"; an entrant with no PLAYED fixture must not read as a pass
  // just because the negative half happens to hold.
  it("an EMPTY live suspension list is a failure, never a vacuous pass", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, { active: [], sheets: goodSheets() });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.banFound).toBe(false);
  });

  it("reds a subject with NO played fixture — the identity discriminator is missing", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan()],
      sheets: [sheet("rr-r3-c1", true, [CONTROL])],
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.playedFixturesChecked).toBe(0);
    expect(suspensionMismatchReasons(cmp.entries[0]!)).toEqual([
      "no PLAYED fixture sheet was read — a ban from this fixture cannot be told apart " +
        "from a ban from every fixture",
    ]);
  });

  it("reds a subject with NO missed fixture — the ban itself was never witnessed", () => {
    const cmp = compareSuspensions(SUS_EXPECTED, {
      active: [activeBan()],
      sheets: [sheet("rr-r1-c1", false, [CONTROL, BANNED])],
    });
    expect(cmp.matched).toBe(false);
    expect(cmp.entries[0]!.missedFixturesChecked).toBe(0);
    expect(suspensionMismatchReasons(cmp.entries[0]!)).toEqual([
      "no MISSED fixture sheet was read — the ban itself was never witnessed",
    ]);
  });

  // `every()` over an empty list is a silent yes — same trap `compareCareerStats`
  // documents. The caller checks `expected.length`; this pins the shape it
  // must not trust.
  it("an EMPTY expected set is vacuously matched — which is why the caller checks the length", () => {
    const cmp = compareSuspensions([], { active: [], sheets: [] });
    expect(cmp.matched).toBe(true);
    expect(cmp.entries).toEqual([]);
  });
});
