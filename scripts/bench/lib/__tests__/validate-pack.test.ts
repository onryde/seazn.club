// Unit coverage for the stage-0 pack validator (lib/validate-pack.ts).
// Pure: no DB, no HTTP, no env. The only I/O is reading the committed
// packs/_tiny.json off disk, which the TEST does — the validator itself is
// handed an already-parsed value. Runs in CI's DB-free job.
//
// The corrupted-stream regressions all start from the REAL `_tiny.json` and
// break exactly one thing, because a corruption is only evidence if the
// uncorrupted original is green through the same code path.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage } from "@seazn/engine/core";
import { builtinModules } from "@seazn/engine/sports";
import { boardgame } from "@seazn/engine/sports/boardgame";
import { PackSchema, fixtureKey } from "../pack-schema.ts";
import { fillPeriodMarkers, reconstructSetRallies } from "../reconstruct.ts";
import {
  OFFLINE_RECORDED_AT,
  PACK_FOLD_OPTIONS,
  packEnvelope,
  packEnvelopes,
  packLineupPair,
  resolveDivisionCfg,
  resolveStatePath,
  sigil,
  stageScopedFoldCfg,
  validatePack,
  type PackFinding,
  type PackValidation,
} from "../validate-pack.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TINY_PACK_PATH = path.join(REPO_ROOT, "scripts/bench/packs/_tiny.json");

const TINY_TEXT = readFileSync(TINY_PACK_PATH, "utf8");

/** A fresh deep copy of the committed micro-pack for every test. */
function tiny(): TinyShape {
  return JSON.parse(TINY_TEXT) as TinyShape;
}

// A structural view of `_tiny.json` — enough to reach into for a corruption,
// deliberately loose rather than importing `Pack` (these fixtures are the
// PRE-parse JSON, so a defaults-applied type would lie about them).
interface TinyStream {
  divisionRef: string;
  fixtureExtKey: string;
  home: string;
  away: string;
  provenance: string;
  events: { type: string; payload?: Record<string, unknown> }[];
}
interface TinyTableRow {
  entrant: string;
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  metrics?: Record<string, number>;
}
interface TinyShape {
  suite: string;
  divisions: {
    ref: string;
    stages: {
      ref: string;
      seq: number;
      kind: string;
      name: string;
      config: Record<string, unknown>;
    }[];
  }[];
  persons: { ref: string; fullName: string; lane: string }[];
  entrants: { ref: string }[];
  streams: TinyStream[];
  // B03 T6 — loose, like every other field here: an official's `assignments`
  // name a (divisionRef, fixtureExtKey) that must resolve against `streams`,
  // so a test that empties `streams` has to empty this too or the pack
  // fails to validate for a reason unrelated to what that test is proving.
  officials?: {
    ref: string;
    assignments?: { divisionRef: string; fixtureExtKey: string }[];
  }[];
  expected: {
    matches: {
      divisionRef: string;
      fixtureExtKey: string;
      outcome: Record<string, unknown>;
      perSide?: { entrant: string; line: string }[];
    }[];
    tables: {
      divisionRef: string;
      stageRef: string;
      poolKey?: string;
      rows: TinyTableRow[];
    }[];
    specials: {
      kind: string;
      divisionRef: string;
      fixtureExtKey: string;
      claims: Record<string, unknown>[];
    }[];
  };
  meta: { synthetic: boolean; sources: unknown[] };
}

/** `expectedSuite` is REQUIRED, so every call site names the pack it drives —
 *  which is the point: a runner that forgets it no longer compiles. */
const TINY = { expectedSuite: "_tiny" } as const;
const UNIT = { expectedSuite: "_unit" } as const;

/**
 * `_tiny` declares two leaderboards, a champion, and (B05 T3 — d-tiny's
 * second stage, s-playoff) a finalRanks order, and stage 0 derives NONE of
 * them — so every green `_tiny` run carries exactly these three warnings.
 * Spelled out rather than filtered away, because the whole point of the
 * not-derived warnings is that a reader sees them.
 */
const TINY_NOT_DERIVED = [
  "leaderboards.not_derived",
  "champions.not_derived",
  "finalRanks.not_derived",
  // B05 T5b — `_tiny.json` now declares expected.careers (Ana Alvarez's
  // cross-division rollup), so stage 0's FOURTH permanent notice is part of
  // this pack's clean baseline. Order matches validate-pack.ts's own
  // emission order (:1839-1870), which this list is compared against exactly.
  "careers.not_derived",
];

/** `genericPack` declares a league stage and no `expected.tables`, so stage 0
 *  says the stage's points and tie order are asserted by nothing. */
const UNIT_NO_TABLE = ["standings.no_expected_table"];

const errors = (findings: readonly PackFinding[]): readonly PackFinding[] =>
  findings.filter((f) => f.severity === "error");
const warnings = (findings: readonly PackFinding[]): readonly PackFinding[] =>
  findings.filter((f) => f.severity === "warning");

/**
 * No errors, and EXACTLY these warnings — never "no findings", which stopped
 * being expressible the moment stage 0 started SAYING what it does not derive.
 * Spelling the warnings out per call is deliberate: a helper that filtered
 * them away would hide the one thing they exist to make visible.
 */
function expectClean(
  result: PackValidation,
  expectedWarnings: readonly string[],
): void {
  expect(errors(result.findings)).toEqual([]);
  expect(warnings(result.findings).map((f) => f.code)).toEqual([
    ...expectedWarnings,
  ]);
  expect(result.ok).toBe(true);
}

/** The single error a corruption is expected to produce. Fails loudly on 0 or
 *  2+, so a test can never assert against "the first of several". */
function onlyError(findings: readonly PackFinding[]): PackFinding {
  const list = errors(findings);
  expect(list.map((f) => `${f.code} @ ${f.where}`)).toHaveLength(1);
  return list[0] as PackFinding;
}

// ---------------------------------------------------------------------------
// A minimal generic pack, for the cases `_tiny` cannot express
// ---------------------------------------------------------------------------

interface BuildOpts {
  readonly events?: { type: string; payload?: Record<string, unknown> }[];
  readonly lineups?: Record<string, unknown>;
  readonly outcome?: Record<string, unknown>;
  readonly specials?: Record<string, unknown>[];
  readonly persons?: { ref: string; fullName: string; lane: string }[];
}

function genericPack(opts: BuildOpts = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    suite: "_unit",
    org: { name: "Unit Org", slug: "unit-org", timezone: "UTC" },
    competition: { name: "Unit Cup", slug: "unit-cup", endsOn: "2099-01-02" },
    divisions: [
      {
        ref: "d1",
        name: "D1",
        sportKey: "generic",
        variantKey: "score",
        moduleVersion: "1.0.0",
        cfgOverrides: {
          resultMode: "score",
          allowDraws: true,
          points: { w: 3, d: 1, l: 0 },
          progressScore: false,
        },
        stages: [{ ref: "s1", seq: 1, kind: "league", name: "League" }],
      },
    ],
    persons: opts.persons ?? [
      { ref: "p1", fullName: "Person One", lane: "player" },
      { ref: "p2", fullName: "Person Two", lane: "player" },
    ],
    entrants: [
      {
        ref: "e1",
        divisionRef: "d1",
        kind: "individual",
        displayName: "One",
        roster: [{ person: "p1" }],
      },
      {
        ref: "e2",
        divisionRef: "d1",
        kind: "individual",
        displayName: "Two",
        roster: [{ person: "p2" }],
      },
    ],
    streams: [
      {
        divisionRef: "d1",
        fixtureExtKey: "f1",
        home: "e1",
        away: "e2",
        provenance: "real",
        ...(opts.lineups === undefined ? {} : { lineups: opts.lineups }),
        events: opts.events ?? [
          { type: "core.start" },
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
        ],
      },
    ],
    expected: {
      matches: [
        {
          divisionRef: "d1",
          fixtureExtKey: "f1",
          outcome: opts.outcome ?? { kind: "win", winner: "e1", loser: "e2" },
        },
      ],
      ...(opts.specials === undefined ? {} : { specials: opts.specials }),
    },
    meta: { synthetic: true, sources: [] },
  };
}

/** A boardgame pack whose division plays WITHOUT colours — the one cheap place
 *  in the engine where a strict fold and a tolerant fold disagree
 *  (`applyPairing`, sports/boardgame/boardgame.ts:297: "STRICT ONLY (§3.3
 *  seam)"). Used to prove the validator really folds strictly. */
function boardgamePack(
  pairing: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    suite: "_unit",
    org: { name: "Unit Org", slug: "unit-org", timezone: "UTC" },
    competition: { name: "Unit Cup", slug: "unit-cup", endsOn: "2099-01-02" },
    divisions: [
      {
        ref: "d1",
        name: "D1",
        sportKey: "boardgame",
        variantKey: "classical",
        moduleVersion: "1.0.0",
        cfgOverrides: { colors: false },
        stages: [{ ref: "s1", seq: 1, kind: "league", name: "League" }],
      },
    ],
    persons: [{ ref: "p1", fullName: "Person One", lane: "player" }],
    entrants: [
      { ref: "e1", divisionRef: "d1", kind: "individual", displayName: "One" },
      { ref: "e2", divisionRef: "d1", kind: "individual", displayName: "Two" },
    ],
    streams: [
      {
        divisionRef: "d1",
        fixtureExtKey: "f1",
        home: "e1",
        away: "e2",
        provenance: "real",
        events: [
          { type: "core.start" },
          { type: "boardgame.pairing", payload: pairing },
          { type: "boardgame.result", payload: { winner: "@e1" } },
        ],
      },
    ],
    expected: {
      matches: [
        {
          divisionRef: "d1",
          fixtureExtKey: "f1",
          outcome: { kind: "win", winner: "e1", loser: "e2" },
        },
      ],
    },
    meta: { synthetic: true, sources: [] },
  };
}

// ===========================================================================
// The shared fixture
// ===========================================================================

describe("validatePack — _tiny.json, the shared fixture", () => {
  it("validates green end to end — no errors, and only the not-derived notices", () => {
    const result = validatePack(tiny(), TINY);
    expectClean(result, TINY_NOT_DERIVED);
    expect(result.pack?.suite).toBe("_tiny");
    // The notices are not decoration: each names what it did not check.
    expect(warnings(result.findings).map((f) => f.message)).toEqual([
      // B05 T5b — FOUR now: d-tiny's own two (scores, points) plus
      // d-tiebreak's own two, the second division contributing to Ana
      // Alvarez's career rollup.
      expect.stringContaining(
        "4 declared expected.leaderboards entries are NOT checked offline",
      ),
      expect.stringContaining(
        "1 declared expected.champions entry is NOT checked offline",
      ),
      // B05 T3 — d-tiny's second stage, s-playoff.
      expect.stringContaining(
        "1 declared expected.finalRanks entry is NOT checked offline",
      ),
      // B05 T5b — the cross-division career rollup, both metric rows.
      expect.stringContaining(
        "2 declared expected.careers entries are NOT checked offline",
      ),
    ]);
  });

  it("reports the provenance split per division and overall", () => {
    const result = validatePack(tiny(), TINY);
    // d-tiny: THREE `real` streams (B05 T3 added the playoff final,
    // provenance "real") and one `reconstructed`. d-badminton (B03 T5): one
    // `reconstructed` stream (`reconstructSetBasedStream`, folded through the
    // real generator). d-tiebreak (B05 T5a): three `real` streams (the
    // tie-order-cascade subject, plain generic.result events). Overall sums
    // all three streamed divisions.
    expect(result.provenance.overall).toEqual({
      real: 6,
      reconstructed: 2,
      synthetic: 0,
      total: 8,
    });
    expect(result.provenance.byDivision).toEqual({
      "d-tiny": { real: 3, reconstructed: 1, synthetic: 0, total: 4 },
      "d-badminton": { real: 0, reconstructed: 1, synthetic: 0, total: 1 },
      // d-registration (B03r tasks 9+10) declares no streams at all — its
      // split is present and zeroed, same as "gives every declared division
      // a split" below proves for d-tiny/d-badminton with streams emptied.
      "d-registration": { real: 0, reconstructed: 0, synthetic: 0, total: 0 },
      "d-tiebreak": { real: 3, reconstructed: 0, synthetic: 0, total: 3 },
    });
  });

  it("gives every declared division a split, including one with no streams", () => {
    const pack = tiny();
    pack.streams = [];
    pack.expected.matches = [];
    pack.expected.tables = [];
    pack.expected.specials = [];
    // officials[].assignments name a (divisionRef, fixtureExtKey) that must
    // resolve against `streams` — emptied above, so this has to empty too,
    // or `checkReservations` reds the pack for a reason this test is not
    // about (an unrelated "no stream declares fixture ..." error).
    pack.officials = [];
    const result = validatePack(pack, TINY);
    // An absent key and a zero count are different facts: a report that cannot
    // tell them apart hides a division nothing replayed. Every declared
    // division appears, each zeroed.
    expect(result.provenance.byDivision).toEqual({
      "d-tiny": { real: 0, reconstructed: 0, synthetic: 0, total: 0 },
      "d-badminton": { real: 0, reconstructed: 0, synthetic: 0, total: 0 },
      "d-registration": { real: 0, reconstructed: 0, synthetic: 0, total: 0 },
      "d-tiebreak": { real: 0, reconstructed: 0, synthetic: 0, total: 0 },
    });
  });
});

// ===========================================================================
// Regression — deliberately corrupted streams
// ===========================================================================

describe("validatePack — a league stage NOTHING binds to (B03 T8)", () => {
  /** `_tiny` with every badminton stream removed, and the `expected` rows that
   *  depended on them. What is left is a declared league stage with entrants,
   *  legs, and no stream bound to it at all. */
  function tinyWithBadmintonUnbound(): unknown {
    const raw = structuredClone(tiny()) as {
      streams: { divisionRef: string }[];
      expected: {
        matches: { divisionRef: string }[];
        tables?: { divisionRef: string }[];
      };
    };
    raw.streams = raw.streams.filter((x) => x.divisionRef !== "d-badminton");
    raw.expected.matches = raw.expected.matches.filter(
      (m) => m.divisionRef !== "d-badminton",
    );
    raw.expected.tables = (raw.expected.tables ?? []).filter(
      (t) => t.divisionRef !== "d-badminton",
    );
    return raw;
  }

  it("warns naming the stage, the implied count and its arithmetic", () => {
    const result = validatePack(tinyWithBadmintonUnbound(), TINY);
    const none = warnings(result.findings).filter(
      (f) => f.code === "streams.none_bound",
    );
    expect(none).toHaveLength(1);
    // The count is DERIVED (2 entrants over 1 leg), so an edit to the pack
    // moves this with it rather than leaving a stale literal behind.
    expect(none[0]?.message).toContain("implies 1 fixture(s)");
    expect(none[0]?.message).toContain("2 entrants");
    expect(none[0]?.where).toContain("s-badminton-league");
  });

  it("WARNS rather than refusing — a partial pack must stay authorable", () => {
    // A pack covering part of a real tournament may legitimately declare a
    // stage it carries no streams for. Refusing would make that unauthorable.
    const result = validatePack(tinyWithBadmintonUnbound(), TINY);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("this state was previously SILENT, which is why the warning exists", () => {
    // The skip it replaces read "an unplayed or unbindable stage is already
    // reported elsewhere". "Elsewhere" was `standings.row_count`, which only
    // fires when the pack declares a standings table for that stage — so the
    // claim held exactly when the mismatch was smallest, and failed when it was
    // total. This pins the distinction: with the expected.tables entry KEPT,
    // the other check does fire; with it removed, nothing but this one does.
    const withTable = structuredClone(tiny()) as {
      streams: { divisionRef: string }[];
      expected: { matches: { divisionRef: string }[] };
    };
    withTable.streams = withTable.streams.filter(
      (x) => x.divisionRef !== "d-badminton",
    );
    withTable.expected.matches = withTable.expected.matches.filter(
      (m) => m.divisionRef !== "d-badminton",
    );
    const stillCaught = validatePack(withTable, TINY);
    expect(
      stillCaught.findings.some((f) => f.code === "standings.row_count"),
    ).toBe(true);

    const codes = validatePack(tinyWithBadmintonUnbound(), TINY).findings.map(
      (f) => f.code,
    );
    expect(codes).not.toContain("standings.row_count");
    expect(codes).toContain("streams.none_bound");
  });
});

describe("validatePack — corrupted streams die naming the stream and the divergence", () => {
  it("a WRONG SCORER (the entrant credited with the points) reds the fold", () => {
    const pack = tiny();
    // rr-r2-c1 is the drawn fixture: 2 to bravo, 1+1 to alpha. Credit bravo's
    // two points to alpha instead and the draw becomes an alpha win.
    const stream = pack.streams[1] as TinyStream;
    expect(stream.fixtureExtKey).toBe("rr-r2-c1");
    (stream.events[1] as { payload: Record<string, unknown> }).payload["by"] =
      "@e-alpha";

    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("match.outcome_kind");
    expect(finding.where).toBe("streams[1] (d-tiny/rr-r2-c1)");
    expect(finding.message).toBe(
      'outcome kind: pack expects "draw", the fold produced "win"',
    );
  });

  it("an EXTRA SCORING EVENT reds the fold", () => {
    const pack = tiny();
    const stream = pack.streams[1] as TinyStream;
    // One more point to alpha, inserted before the terminal result — the
    // generic sport's equivalent of an extra ball in the over.
    stream.events.splice(4, 0, {
      type: "generic.score",
      payload: { by: "@e-alpha", points: 1, person: "@p-ana" },
    });

    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("match.outcome_kind");
    expect(finding.where).toBe("streams[1] (d-tiny/rr-r2-c1)");
    expect(finding.message).toContain('pack expects "draw"');
  });

  it("a MIS-TRANSCRIBED SCORE LINE that leaves the winner intact still reds", () => {
    const pack = tiny();
    const stream = pack.streams[0] as TinyStream;
    expect(stream.fixtureExtKey).toBe("rr-r1-c1");
    // 3–1 becomes 4–1: same winner, same points, different score line. Only
    // the perSide comparison can see it.
    (stream.events[1] as { payload: Record<string, unknown> }).payload[
      "p1Score"
    ] = 4;

    const result = validatePack(pack, TINY);
    const finding = onlyError(result.findings);
    expect(finding.code).toBe("match.side_line");
    expect(finding.where).toBe("streams[0] (d-tiny/rr-r1-c1)");
    expect(finding.message).toBe(
      'score line for "e-alpha": pack expects "3", the fold produced "4"',
    );
    // And the table is not silently skipped: the skip says why, so a reader
    // cannot mistake "not checked" for "checked and fine".
    expect(warnings(result.findings).map((f) => f.code)).toEqual([
      "standings.upstream_fold_failed",
      ...TINY_NOT_DERIVED,
    ]);
  });

  it("a SWAPPED WINNER reds the fold even though the outcome kind is right", () => {
    const pack = tiny();
    const match = pack.expected.matches[0]!;
    match.outcome = {
      kind: "win",
      winner: "e-bravo",
      loser: "e-alpha",
      method: "regulation",
    };
    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("match.outcome_winner");
    expect(finding.message).toBe(
      'winner: pack expects "e-bravo", the fold produced "@e-alpha"',
    );
  });

  it("a SWAPPED LOSER reds the fold", () => {
    const pack = tiny();
    // A three-entrant division makes the mistake realistic: the loser named is
    // a real entrant of the division who did not play this fixture.
    pack.entrants.push({
      ref: "e-charlie",
      divisionRef: "d-tiny",
      kind: "individual",
      displayName: "Charlie",
    } as TinyShape["entrants"][number]);
    const match = pack.expected.matches[0]!;
    match.outcome = {
      kind: "win",
      winner: "e-alpha",
      loser: "e-charlie",
      method: "regulation",
    };
    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("match.outcome_loser");
    expect(finding.message).toBe(
      'loser: pack expects "e-charlie", the fold produced "@e-bravo"',
    );
  });

  it("a WRONG METHOD reds the fold, and an unstated method asserts nothing", () => {
    const pack = tiny();
    (pack.expected.matches[0]!.outcome as Record<string, unknown>)["method"] =
      "extra_time";
    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("match.outcome_method");
    expect(finding.message).toBe(
      'method: pack expects "extra_time", the fold produced "regulation"',
    );

    // A pack that does not care which method decided a fixture must not be
    // forced to guess one.
    const silent = tiny();
    delete (silent.expected.matches[0]!.outcome as Record<string, unknown>)[
      "method"
    ];
    expectClean(validatePack(silent, TINY), TINY_NOT_DERIVED);
  });

  it("a SWAPPED TIE ORDER in the expected table reds the standings", () => {
    const pack = tiny();
    const table = pack.expected.tables[0]!;
    const [first, second] = [table.rows[0]!, table.rows[1]!];
    // Each entrant keeps its own numbers; only their ORDER changes. `rank`
    // moves with the position because PackSchema forces rank === index + 1,
    // so the corruption stays parseable and the fold is what must catch it.
    table.rows = [
      { ...second, rank: 1 },
      { ...first, rank: 2 },
    ];

    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("standings.order");
    expect(finding.where).toBe("expected.tables[0] (d-tiny/s-league)");
    expect(finding.message).toBe(
      'rank 1: pack expects "e-bravo", the fold ranked "@e-alpha" there',
    );
  });

  it("an END-TO-END REVERSED stream folds green and is caught by the TABLE", () => {
    const pack = tiny();
    const stream = pack.streams[0] as TinyStream;
    // Reverse the fixture in BOTH places the schema cross-checks — the sides
    // and its own expected match. PackSchema pins perSide to [home, away], so
    // a reversal in one place alone is a parse error; a reversal in both
    // parses clean and is exactly the hole the fold gate exists to close.
    [stream.home, stream.away] = [stream.away, stream.home];
    const match = pack.expected.matches[0]!;
    match.outcome = {
      kind: "win",
      winner: "e-bravo",
      loser: "e-alpha",
      method: "regulation",
    };
    match.perSide = [
      { entrant: "e-bravo", line: "3" },
      { entrant: "e-alpha", line: "1" },
    ];

    const result = validatePack(pack, TINY);
    // The fixture itself is now self-consistent: stage 2 has nothing to say.
    expect(
      errors(result.findings).filter((f) => f.code.startsWith("match.")),
    ).toEqual([]);
    // The cumulative table is where the reversal shows up: alpha and bravo end
    // level on 4 points each, and the cascade puts bravo first.
    const finding = onlyError(result.findings);
    expect(finding.code).toBe("standings.order");
    expect(finding.where).toBe("expected.tables[0] (d-tiny/s-league)");
    expect(finding.message).toBe(
      'rank 1: pack expects "e-alpha", the fold ranked "@e-bravo" there',
    );
  });
});

// ===========================================================================
// Provenance
// ===========================================================================

describe("validatePack — provenance", () => {
  // A stream with NO provenance is the one provenance check code can make
  // (a reconstructed stream dishonestly flagged `"real"` is undetectable —
  // see the file header). It is refused, and the whole pipeline stops.
  //
  // MEASURED, not assumed: zod 4.4.3 reports an ABSENT enum field and an
  // INVALID one with the same `code`, the same `message` and the same `path`
  // — `invalid_value`, "Invalid option: expected one of …". So no assertion on
  // the issue can tell the two apart, and a test claiming to pin "missing"
  // specifically would be claiming a precision that does not exist. All four
  // shapes are driven here, and the assertion is what is really true of them.
  const badProvenance: [string, (s: TinyStream) => void][] = [
    ["absent", (s) => delete (s as Partial<TinyStream>).provenance],
    ["not one of the three", (s) => void (s.provenance = "estimated")],
    [
      "the wrong type",
      (s) => void ((s as unknown as { provenance: number }).provenance = 42),
    ],
    [
      "null",
      (s) => void ((s as unknown as { provenance: null }).provenance = null),
    ],
  ];
  it.each(badProvenance)(
    "refuses a stream whose provenance is %s",
    (_label, mutate) => {
      const pack = tiny();
      mutate(pack.streams[0] as TinyStream);

      const result = validatePack(pack, TINY);
      expect(result.ok).toBe(false);
      expect(result.pack).toBe(null);
      const finding = onlyError(result.findings);
      expect(finding.code).toBe("schema.invalid_value");
      expect(finding.where).toBe("streams.0.provenance");
      // The message carries the vocabulary, so widening the enum moves the test
      // rather than leaving it asserting yesterday's list.
      for (const value of ["real", "reconstructed", "synthetic"]) {
        expect(finding.message).toContain(value);
      }
    },
  );

  it("accepts all THREE declared provenances, not just real/reconstructed", () => {
    const pack = tiny();
    // `synthetic` was added in Task 1's fix round; GLOBAL.md still names two
    // values. A validator that hardcoded the old pair would red here.
    (pack.streams[1] as TinyStream).provenance = "synthetic";
    const result = validatePack(pack, TINY);
    expectClean(result, TINY_NOT_DERIVED);
    // d-tiny's THREE `real` streams (B05 T3 added the playoff final), the
    // mutated `synthetic` one, d-badminton's own `reconstructed` stream
    // (B03 T5), and d-tiebreak's own THREE `real` streams (B05 T5a) — all
    // untouched by this mutation, since it targets `pack.streams[1]`,
    // d-tiny's own.
    expect(result.provenance.overall).toEqual({
      real: 6,
      reconstructed: 1,
      synthetic: 1,
      total: 8,
    });
  });
});

// ===========================================================================
// Parity with the product's batch import
// ===========================================================================

describe("validatePack — resolving the module and its cfg", () => {
  const withDivision = (
    patch: Record<string, unknown>,
  ): Record<string, unknown> => {
    const pack = genericPack() as unknown as {
      divisions: Record<string, unknown>[];
    };
    Object.assign(pack.divisions[0]!, patch);
    return pack as unknown as Record<string, unknown>;
  };

  it("reds a division pinned to a module version the registry does not hold", () => {
    const finding = onlyError(
      validatePack(withDivision({ moduleVersion: "9.9.9" }), UNIT).findings,
    );
    expect(finding.code).toBe("fold.module_not_found");
    expect(finding.where).toBe("streams[0] (d1/f1)");
    expect(finding.message).toContain('no engine module "generic@9.9.9"');
    expect(finding.message).toContain("MODULE_NOT_FOUND");
  });

  it("reds an unknown variant key, and names the ones the module declares", () => {
    // `variantKey` is a named cfg PRESET, not a module selector — the product
    // 422s on exactly this (`usecases/divisions.ts:242`), reading the preset
    // from the `sport_variants` rows `scripts/sync-sports.ts` generates from
    // `module.variants`. Offline that map IS the source.
    const finding = onlyError(
      validatePack(withDivision({ variantKey: "banana" }), UNIT).findings,
    );
    expect(finding.code).toBe("fold.unknown_variant");
    expect(finding.message).toContain(
      'unknown variant "banana" for sport "generic"',
    );
    // Derived from the module, so a new variant moves the message with it.
    for (const key of Object.keys(
      builtinModules.find((m) => m.key === "generic")!.variants,
    )) {
      expect(finding.message).toContain(key);
    }
  });

  it("reds a cfg the module's own configSchema refuses", () => {
    const finding = onlyError(
      validatePack(
        withDivision({ cfgOverrides: { resultMode: "banana" } }),
        UNIT,
      ).findings,
    );
    expect(finding.code).toBe("fold.cfg_invalid");
    expect(finding.message).toContain("configSchema");
    expect(finding.message).toContain("resultMode");
  });
});

describe("validatePack — parity P1: envelope synthesis", () => {
  it("mints id = String(i) and seq = i + 1, 1-based and gapless", () => {
    const pack = PackSchema.parse(tiny());
    const stream = pack.streams[1]!;
    const envelopes = packEnvelopes(stream);

    expect(envelopes).toHaveLength(stream.events.length);
    expect(envelopes.map((e) => e.id)).toEqual(
      stream.events.map((_, i) => String(i)),
    );
    // 1..n, gapless — event-import.ts:289 (`seq: i + 1`), whose own comment
    // at :282 reads "seq 1..n, gapless". The stale doc comment on
    // EventImportRequest claiming "0..n" is NOT what the code does.
    expect(envelopes.map((e) => e.seq)).toEqual(
      stream.events.map((_, i) => i + 1),
    );
    expect(envelopes[0]?.seq).toBe(1);
    // One fixture-key format, shared with the schema and the seeding layer.
    expect(new Set(envelopes.map((e) => e.fixtureId))).toEqual(
      new Set([fixtureKey(stream.divisionRef, stream.fixtureExtKey)]),
    );
    expect(envelopes.map((e) => e.type)).toEqual(
      stream.events.map((e) => e.type),
    );
    expect(envelopes.every((e) => e.recordedBy === null)).toBe(true);
  });

  it("uses the event's own `at` when it has one, and a FIXED sentinel otherwise", () => {
    const pack = PackSchema.parse(
      genericPack({
        events: [
          { type: "core.start" },
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
        ],
      }),
    );
    const stream = { ...pack.streams[0]! };
    stream.events = [
      { ...stream.events[0]!, at: "2020-05-05T10:00:00.000Z" },
      stream.events[1]!,
    ];
    const envelopes = packEnvelopes(stream);
    expect(envelopes[0]?.recordedAt).toBe("2020-05-05T10:00:00.000Z");
    // Deterministic, unlike the product's `new Date()` fallback — no fold
    // reads `recordedAt`, and an offline gate must be reproducible.
    expect(envelopes[1]?.recordedAt).toBe(OFFLINE_RECORDED_AT);
  });

  it("folds STRICTLY (strictFromSeq: 1) — proven by an event only strict mode refuses", () => {
    // A boardgame division with `colors: false` and a pairing card that names
    // a white player. `applyPairing` refuses that ONLY when strict
    // (boardgame.ts:297), so the two modes genuinely disagree here.
    const strictRefused = validatePack(boardgamePack({ white: "@e1" }), UNIT);
    const finding = onlyError(strictRefused.findings);
    expect(finding.code).toBe("fold.rejected");
    expect(finding.where).toBe("streams[0] (d1/f1)");
    expect(finding.message).toContain("this division plays without colours");

    // Control 1: the same stream with a pairing card that carries no colour
    // folds green, so the refusal above is the colours rule and not a broken
    // fixture.
    expectClean(validatePack(boardgamePack({ board: 1 }), UNIT), UNIT_NO_TABLE);

    // Control 2: the SAME events fold cleanly with the tolerant (replay)
    // reading. Without this the test could pass against a validator that
    // never passed any options at all.
    const pack = PackSchema.parse(boardgamePack({ white: "@e1" }));
    const stream = pack.streams[0]!;
    const cfg = boardgame.configSchema.parse({
      ...boardgame.variants["classical"],
      colors: false,
    });
    const args = [
      boardgame,
      cfg,
      packLineupPair(stream),
      packEnvelopes(stream),
    ] as const;
    expect(() => foldMatchWithStoppage(...args)).not.toThrow();
    expect(() => foldMatchWithStoppage(...args, PACK_FOLD_OPTIONS)).toThrow();
  });
});

describe("validatePack — parity P2: the not-decided rejection", () => {
  it("reds a stream that folds legally but reaches no outcome", () => {
    const result = validatePack(
      genericPack({ events: [{ type: "core.start" }] }),
      UNIT,
    );
    const finding = onlyError(result.findings);
    expect(finding.code).toBe("fold.not_decided");
    expect(finding.where).toBe("streams[0] (d1/f1)");
    // The parity claim itself: this is the product's own refusal, and the
    // message names it so a pack author can find the code that will reject
    // their pack on seeding.
    expect(finding.message).toContain("import.not_decided");
    expect(finding.message).toContain("event-import.ts:323");
  });
});

// ===========================================================================
// EngineError containment
// ===========================================================================

describe("validatePack — an EngineError is a finding, never a crash", () => {
  it("names the offending event index and type for a KERNEL refusal", () => {
    const result = validatePack(
      genericPack({
        events: [
          { type: "core.start" },
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
          // The match is already decided; the kernel refuses anything further.
          { type: "generic.score", payload: { by: "@e1", points: 1 } },
        ],
      }),
      UNIT,
    );
    const finding = onlyError(result.findings);
    expect(finding.code).toBe("fold.rejected");
    // `data.eventId` IS the array index, because P1's synthesis makes it so —
    // the same property the product relies on to report `eventIndex`.
    expect(finding.message).toContain('event #2 ("generic.score")');
    expect(finding.message).toContain("ALREADY_DECIDED");
  });

  it("says so when the engine did NOT name the event — a MODULE-level refusal", () => {
    // MEASURED. The brief said `data.eventId` maps a fold rejection back to an
    // array index; that is true only of the kernel's own refusals. A throw
    // from inside `module.apply` is not wrapped (core/events.ts:681), so no
    // `eventId` is attached and the PRODUCT omits its `eventIndex` for this
    // whole class too. The message must not imply an index it does not have.
    const result = validatePack(
      genericPack({
        events: [
          { type: "core.start" },
          { type: "core.start" }, // generic's own wrongPhase("already started")
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
        ],
      }),
      UNIT,
    );
    const finding = onlyError(result.findings);
    expect(finding.code).toBe("fold.rejected");
    expect(finding.message).toContain("did not name");
    expect(finding.message).toContain("WRONG_PHASE");
    expect(finding.message).not.toContain("event #");
  });

  it("keeps validating the remaining streams after one throws", () => {
    const pack = tiny();
    // Break the FIRST stream outright, and the second one's oracle too. A
    // validator that let the throw escape would report only the crash.
    (pack.streams[0] as TinyStream).events.splice(1, 0, { type: "core.start" });
    (pack.expected.matches[1] as { outcome: Record<string, unknown> }).outcome =
      { kind: "tie" };

    const result = validatePack(pack, TINY);
    const codes = errors(result.findings).map((f) => `${f.code} @ ${f.where}`);
    expect(codes).toEqual([
      "fold.rejected @ streams[0] (d-tiny/rr-r1-c1)",
      "match.outcome_kind @ streams[1] (d-tiny/rr-r2-c1)",
    ]);
    expect(warnings(result.findings).map((f) => f.code)).toEqual([
      "standings.upstream_fold_failed",
      ...TINY_NOT_DERIVED,
    ]);
  });

  it("a fold failure suppresses its table as a WARNING, not a second error", () => {
    // The suppression has TWO sites — a stream that never folded, and a stream
    // that folded to the wrong answer — and two guards covering for each other
    // are each untested. This pack's ONLY failure is the fold, so nothing else
    // can populate the suppression set: without it the table derivation runs
    // on an incomplete division and reports `standings.underivable`, a SECOND
    // error that buries the first.
    const pack = tiny();
    (pack.streams[0] as TinyStream).events.splice(1, 0, { type: "core.start" });

    const result = validatePack(pack, TINY);
    expect(onlyError(result.findings).code).toBe("fold.rejected");
    expect(warnings(result.findings).map((f) => f.code)).toEqual([
      "standings.upstream_fold_failed",
      ...TINY_NOT_DERIVED,
    ]);
  });
});

// ===========================================================================
// Specials
// ===========================================================================

describe("validatePack — specials", () => {
  it("reds a state path the module's folded state does not expose", () => {
    const pack = tiny();
    // The exact class the specials design was corrected for: `mtbTo` is a
    // field on a DERIVED per-set struct built inside `rulesFor()`, not on any
    // state, so a claim written from that line number parses cleanly and can
    // never resolve. `ClosedSet.mtb` is the reachable representation.
    pack.expected.specials[0]!.claims = [
      { on: "state", path: "mtbTo", equals: true },
    ];

    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("special.state");
    expect(finding.where).toBe(
      "expected.specials[0] (retirement d-tiny/rr-r3-c1) claims[0]",
    );
    expect(finding.message).toContain('state path "mtbTo" does not exist');
  });

  it("reds a state path that resolves to the wrong value, naming both", () => {
    const pack = tiny();
    pack.expected.specials[0]!.claims = [
      { on: "state", path: "phase", equals: "live" },
    ];
    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("special.state");
    expect(finding.message).toBe(
      'state "phase": claim expects "live", the fold produced "done"',
    );
  });

  /**
   * Every claim below is posed against a fixture whose fold COULD satisfy it,
   * with a green control alongside. That distinction is not cosmetic: a claim
   * naming `loser` or `method` on an AWARD outcome can never hold — the
   * engine's award variant has neither field — so a "reds" assertion there
   * proves nothing about the comparison. (PackSchema now refuses `method` on
   * an award for the same reason; `PackClaim` is a flat union and still
   * permits the shape, which is why the absence case below is kept and
   * labelled rather than deleted.)
   *
   * `_tiny`'s rr-r1-c1 folds to `{win, winner: e-alpha, loser: e-bravo,
   * method: "regulation"}`, which carries all four fields.
   */
  const onWin = (claim: Record<string, unknown>): TinyShape => {
    const pack = tiny();
    pack.expected.specials[0]!.fixtureExtKey = "rr-r1-c1";
    pack.expected.specials[0]!.claims = [claim];
    return pack;
  };
  const winClaims: [string, Record<string, unknown>, string][] = [
    [
      "kind",
      { on: "outcome", kind: "draw" },
      'outcome kind: claim expects "draw", the fold produced "win"',
    ],
    [
      "winner",
      { on: "outcome", winner: "e-bravo" },
      'outcome winner: claim expects "e-bravo", the fold produced "@e-alpha"',
    ],
    [
      "loser",
      { on: "outcome", loser: "e-alpha" },
      'outcome loser: claim expects "e-alpha", the fold produced "@e-bravo"',
    ],
    [
      "method",
      { on: "outcome", method: "shootout" },
      'outcome method: claim expects "shootout", the fold produced "regulation"',
    ],
  ];
  it.each(winClaims)(
    "reds an outcome claim on %s, against a fold that carries it",
    (_f, claim, message) => {
      expect(onlyError(validatePack(onWin(claim), TINY).findings).message).toBe(
        message,
      );
    },
  );

  it("holds when every field of the same outcome claim is right", () => {
    // The control the four cases above need: without it each of them could be
    // passing because the claim shape is unsatisfiable rather than wrong.
    expectClean(
      validatePack(
        onWin({
          on: "outcome",
          kind: "win",
          winner: "e-alpha",
          loser: "e-bravo",
          method: "regulation",
        }),
        TINY,
      ),
      TINY_NOT_DERIVED,
    );
  });

  it("reds a claim on a field the folded outcome does not carry at all", () => {
    // An `award` has no `loser`. The claim must red on the ABSENCE rather than
    // quietly pass because there is nothing to compare — the direction that
    // `"loser" in outcome &&` guarding would have got wrong.
    const pack = tiny();
    pack.expected.specials[0]!.claims = [{ on: "outcome", loser: "e-bravo" }];
    expect(onlyError(validatePack(pack, TINY).findings).message).toBe(
      'outcome loser: claim expects "e-bravo", the fold produced undefined',
    );
  });

  it("reds a standings claim against THIS fixture's own delta", () => {
    const pack = tiny();
    // The real value is 1 (alpha won the awarded fixture). `2` would be its
    // value in the cumulative table, which is the assertion this branch must
    // NOT be making.
    pack.expected.specials[0]!.claims = [
      { on: "standings", entrant: "e-alpha", field: "won", equals: 2 },
    ];
    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("special.standings");
    expect(finding.message).toBe(
      'standings won for "e-alpha": claim expects 2, this fixture\'s delta gives 1',
    );
  });

  it("reports only the FIRST divergent claim of a special", () => {
    const pack = tiny();
    pack.expected.specials[0]!.claims = [
      { on: "state", path: "phase", equals: "live" },
      { on: "standings", entrant: "e-alpha", field: "won", equals: 9 },
    ];
    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.where).toContain("claims[0]");
  });

  it("reaches the kernel's squad bookkeeping, which no state path can", () => {
    // `subsUsed` moves only because a real `core.lineup.substitution` was
    // folded — 0 vs 0 would prove nothing, so the pack does one.
    const withSub = (equals: number): Record<string, unknown> =>
      genericPack({
        persons: [
          { ref: "p1", fullName: "Person One", lane: "player" },
          { ref: "p2", fullName: "Person Two", lane: "player" },
          { ref: "p3", fullName: "Person Three", lane: "player" },
        ],
        lineups: {
          home: [
            { person: "p1", slot: "starting" },
            { person: "p3", slot: "bench" },
          ],
          away: [{ person: "p2", slot: "starting" }],
        },
        events: [
          { type: "core.start" },
          {
            type: "core.lineup.substitution",
            payload: {
              side: "@e1",
              off: "@p1",
              on: { personId: "@p3", slot: "starting", orderNo: 1 },
            },
          },
          { type: "generic.result", payload: { p1Score: 2, p2Score: 1 } },
        ],
        specials: [
          {
            kind: "concussion_sub",
            divisionRef: "d1",
            fixtureExtKey: "f1",
            claims: [
              { on: "squads", entrant: "e1", field: "subsUsed", equals },
            ],
          },
        ],
      });

    expectClean(validatePack(withSub(1), UNIT), UNIT_NO_TABLE);
    const finding = onlyError(validatePack(withSub(0), UNIT).findings);
    expect(finding.code).toBe("special.squads");
    expect(finding.message).toBe(
      'squads subsUsed for "e1": claim expects 0, the fold produced 1',
    );
  });

  it("reads an exemption never charged as 0, so `equals: 0` is assertable", () => {
    const claim = (equals: number): Record<string, unknown> => ({
      kind: "concussion_sub",
      divisionRef: "d-tiny",
      fixtureExtKey: "rr-r3-c1",
      claims: [
        {
          on: "squads",
          entrant: "e-alpha",
          field: "exemptUsed",
          exemption: "concussion",
          equals,
        },
      ],
    });
    const green = tiny();
    green.expected.specials = [
      claim(0) as TinyShape["expected"]["specials"][number],
    ];
    expectClean(validatePack(green, TINY), TINY_NOT_DERIVED);

    const red = tiny();
    red.expected.specials = [
      claim(1) as TinyShape["expected"]["specials"][number],
    ];
    expect(onlyError(validatePack(red, TINY).findings).message).toBe(
      'squads exemptUsed["concussion"] for "e-alpha": claim expects 1, the fold produced 0',
    );
  });

  it("reds a squads claim naming an entrant that is neither side", () => {
    // A third entrant of the SAME division, which the schema's ref check
    // therefore accepts — the realistic mistake is a copy-paste from the
    // neighbouring fixture, not an invented ref.
    const withCharlie = (entrant: string): TinyShape => {
      const pack = tiny();
      pack.entrants.push({
        ref: "e-charlie",
        divisionRef: "d-tiny",
        kind: "individual",
        displayName: "Charlie",
      } as TinyShape["entrants"][number]);
      pack.expected.specials[0]!.claims = [
        { on: "squads", entrant, field: "subsUsed", equals: 0 },
      ];
      return pack;
    };
    // Control: alpha DID play rr-r3-c1, so the same claim shape is green.
    //
    // The third entrant makes this pack's league stage imply nine fixtures
    // (3 entrants over 3 legs) against the three streams `_tiny` carries, so
    // stage 0 warns — correctly, and by construction of the fixture rather
    // than by defect. Spelled out rather than filtered away: `expectClean`
    // asserts the EXACT warning list on purpose.
    expectClean(validatePack(withCharlie("e-alpha"), TINY), [
      "streams.count_mismatch",
      ...TINY_NOT_DERIVED,
    ]);

    const finding = onlyError(
      validatePack(withCharlie("e-charlie"), TINY).findings,
    );
    expect(finding.code).toBe("special.squads");
    expect(finding.message).toContain("is neither side of this fixture");
  });
});

// ===========================================================================
// The documented limits — pinned so they cannot quietly become false
// ===========================================================================

describe("validatePack — the limits stage 0 declares", () => {
  it("does NOT catch a mis-transcribed SCORER (that is B05's leaderboard check)", () => {
    const pack = tiny();
    // Credit Ana's point to Bo. The entrant score is untouched, so every
    // fold-derived answer is identical and only `expected.leaderboards` — which
    // stage 0 deliberately does not derive — changes.
    const stream = pack.streams[1] as TinyStream;
    (stream.events[2] as { payload: Record<string, unknown> }).payload[
      "person"
    ] = "@p-bo";
    expectClean(validatePack(pack, TINY), TINY_NOT_DERIVED);
  });

  it("cannot bind streams to a stage in a MULTI-STAGE division, and says so", () => {
    const pack = tiny();
    // B05 T3 gave d-tiny a real second stage (s-playoff, seq 2) whose own
    // streams declare an explicit `stageRef` — so a THIRD stage alone no
    // longer reproduces "cannot bind": every d-tiny stream now resolves
    // fine on its own declared ref. `seq: 3` avoids colliding with
    // s-playoff's seq 2 (PackSchema refuses a duplicate stage seq outright,
    // a schema-level error this test is not about), and clearing every
    // league stream's OWN `stageRef` recreates the ambiguity this test
    // exists to prove: a stream naming no stage cannot be resolved once its
    // division has more than one.
    pack.divisions[0]!.stages.push({
      ref: "s-ko",
      seq: 3,
      kind: "knockout",
      name: "Knockout",
      config: {},
    });
    for (const stream of pack.streams) {
      if (stream.divisionRef === "d-tiny") delete (stream as { stageRef?: string }).stageRef;
    }
    const result = validatePack(pack, TINY);
    expect(errors(result.findings)).toEqual([]);
    expect(result.ok).toBe(true);
    const warning = warnings(result.findings)[0];
    expect(warning?.code).toBe("standings.stage_unbindable");
    expect(warning?.where).toBe("expected.tables[0] (d-tiny/s-league)");
    expect(warning?.message).toContain("streams[].stageRef");
  });

  it("cannot bind streams to a POOL, and says so", () => {
    const pack = tiny();
    pack.expected.tables[0]!.poolKey = "A";
    const result = validatePack(pack, TINY);
    expect(errors(result.findings)).toEqual([]);
    expect(warnings(result.findings).map((f) => f.code)).toEqual([
      "standings.pool_unbindable",
      ...TINY_NOT_DERIVED,
    ]);
  });
});

// ===========================================================================
// Stage-3 plumbing that mirrors the product
// ===========================================================================

describe("validatePack — the standings derivation mirrors the product's own", () => {
  it("reds a table declared against a stage that produces a bracket, not a table", () => {
    const pack = tiny();
    pack.divisions[0]!.stages[0]!.kind = "knockout";
    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("standings.not_a_table_stage");
    expect(finding.message).toContain('kind "knockout"');
  });

  it("applies the stage's carry-over openings (stage.config.carry_deltas)", () => {
    const pack = tiny();
    pack.divisions[0]!.stages[0]!.config["carry_deltas"] = [
      {
        entrantId: "@e-alpha",
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        points: 5,
        metrics: {},
      },
    ];
    // The pack now expects 7 + 5. Green ONLY if the opening delta is applied;
    // ignoring `carry_deltas` gives 7 and reds.
    pack.expected.tables[0]!.rows[0]!.points = 12;
    expectClean(validatePack(pack, TINY), TINY_NOT_DERIVED);
  });

  it("applies the stage's manual rank locks (stage.config.rank_overrides)", () => {
    const pack = tiny();
    pack.divisions[0]!.stages[0]!.config["rank_overrides"] = [
      { entrant_id: "@e-bravo", rank: 1 },
    ];
    const table = pack.expected.tables[0]!;
    const [alpha, bravo] = [table.rows[0]!, table.rows[1]!];
    // Bravo is pinned to rank 1 with its own (losing) numbers intact.
    table.rows = [
      { ...bravo, rank: 1 },
      { ...alpha, rank: 2 },
    ];
    expectClean(validatePack(pack, TINY), TINY_NOT_DERIVED);
  });

  it("carries the entrants' declared seeds into the ranking", () => {
    // Two entrants level on every cascade criterion. The engine's last resort
    // is `bySeedThenId` (competition/tiebreakers.ts:608), so the DECLARED
    // seeds — and only they — decide the order; without them the fallback is
    // entrant id, which would put "@e1" first.
    const pack = genericPack({
      events: [
        { type: "core.start" },
        { type: "generic.result", payload: { p1Score: 1, p2Score: 1 } },
      ],
      outcome: { kind: "draw" },
    }) as unknown as {
      divisions: { tiebreakers?: string[] }[];
      entrants: { ref: string; seed?: number }[];
      expected: { tables?: unknown[] };
    };
    // A cascade WITHOUT `lots`: generic's own default ends with it, and a
    // cascade that lists `lots` breaks the tie by drawing lots instead of
    // falling through to seed→id.
    pack.divisions[0]!.tiebreakers = ["points", "diff"];
    pack.entrants[0]!.seed = 2; // e1
    pack.entrants[1]!.seed = 1; // e2
    pack.expected.tables = [
      {
        divisionRef: "d1",
        stageRef: "s1",
        rows: [
          {
            entrant: "e2",
            rank: 1,
            played: 1,
            won: 0,
            drawn: 1,
            lost: 0,
            points: 1,
          },
          {
            entrant: "e1",
            rank: 2,
            played: 1,
            won: 0,
            drawn: 1,
            lost: 0,
            points: 1,
          },
        ],
      },
    ];
    expectClean(
      validatePack(pack as unknown as Record<string, unknown>, UNIT),
      [],
    );
  });

  // Every scalar, one at a time. One sample is not a parity sweep: with only
  // the order and one value asserted, dropping a field from the comparison
  // list survives (it did — `points` was uncovered on the first sweep).
  const scalars = ["played", "won", "drawn", "lost", "points"] as const;
  it.each(scalars)(
    "reds when the fold and the pack disagree on %s alone",
    (field) => {
      const pack = tiny();
      const row = pack.expected.tables[0]!.rows[0]!;
      const before = row[field];
      row[field] = before + 1;
      const finding = onlyError(validatePack(pack, TINY).findings);
      expect(finding.code).toBe("standings.value");
      expect(finding.message).toBe(
        `rank 1 "e-alpha" ${field}: pack expects ${before + 1}, the fold produced ${before}`,
      );
    },
  );

  it("falls back to the SPORT's own cascade when the division declares none", () => {
    // Two entrants, one win each, level on points — separated only by `diff`,
    // which is the second key of generic's own `defaultTiebreakers`. With no
    // cascade at all the engine falls through to seed-then-id and puts e1
    // first, so this order is evidence that the module's default was used.
    const stream = (
      key: string,
      home: string,
      away: string,
      p1: number,
      p2: number,
    ) => ({
      divisionRef: "d1",
      fixtureExtKey: key,
      home,
      away,
      provenance: "real",
      events: [
        { type: "core.start" },
        { type: "generic.result", payload: { p1Score: p1, p2Score: p2 } },
      ],
    });
    const pack = genericPack() as unknown as {
      divisions: Record<string, unknown>[];
      streams: unknown[];
      expected: Record<string, unknown>;
    };
    expect(pack.divisions[0]!["tiebreakers"]).toBeUndefined();
    // Two entrants meeting twice IS a two-leg league, and the stage now says
    // so. Added when stage 0 learned to compare a league stage's declared
    // streams against the count its entrants and legs imply
    // (`streams.count_mismatch`): this fixture was internally inconsistent —
    // a single-leg stage carrying two meetings — and the new warning was
    // right to say so. `legs` feeds nothing else on the fold path.
    (pack.divisions[0]!["stages"] as Record<string, unknown>[])[0]!["config"] =
      { legs: 2 };
    pack.streams = [
      stream("f1", "e1", "e2", 1, 0),
      stream("f2", "e2", "e1", 5, 0),
    ];
    pack.expected["matches"] = [
      {
        divisionRef: "d1",
        fixtureExtKey: "f1",
        outcome: { kind: "win", winner: "e1", loser: "e2" },
      },
      {
        divisionRef: "d1",
        fixtureExtKey: "f2",
        outcome: { kind: "win", winner: "e2", loser: "e1" },
      },
    ];
    pack.expected["tables"] = [
      {
        divisionRef: "d1",
        stageRef: "s1",
        rows: [
          {
            entrant: "e2",
            rank: 1,
            played: 2,
            won: 1,
            drawn: 0,
            lost: 1,
            points: 3,
          },
          {
            entrant: "e1",
            rank: 2,
            played: 2,
            won: 1,
            drawn: 0,
            lost: 1,
            points: 3,
          },
        ],
      },
    ];
    expectClean(
      validatePack(pack as unknown as Record<string, unknown>, UNIT),
      [],
    );
  });

  it("reds when the fold produces a different number of rows", () => {
    const pack = tiny();
    pack.expected.tables[0]!.rows = [pack.expected.tables[0]!.rows[0]!];
    const finding = onlyError(validatePack(pack, TINY).findings);
    expect(finding.code).toBe("standings.row_count");
    expect(finding.message).toBe(
      "the fold produced 2 row(s), the pack declares 1",
    );
  });

  it("compares declared metrics, and asserts none when the pack declares none", () => {
    const green = tiny();
    expectClean(validatePack(green, TINY), TINY_NOT_DERIVED); // `_tiny` declares no metrics

    const exact = tiny();
    // The real derived ledger for alpha, so the comparison has a green case
    // and is not merely "any metrics block reds".
    exact.expected.tables[0]!.rows[0]!.metrics = {
      for: 5,
      against: 3,
      diff: 2,
    };
    expectClean(validatePack(exact, TINY), TINY_NOT_DERIVED);

    const red = tiny();
    red.expected.tables[0]!.rows[0]!.metrics = { nonsense: 1 };
    const finding = onlyError(validatePack(red, TINY).findings);
    expect(finding.code).toBe("standings.metrics");
    expect(finding.message).toContain('rank 1 "e-alpha" metrics');
  });

  // A metrics block that is a strict SUBSET of the derived ledger, and one
  // that is a strict SUPERSET. They fail through different halves of the
  // comparison — the subset trips the per-key walk, the superset only the key
  // COUNT — so a single case leaves one half of the check untested.
  const metricsCases: [string, Record<string, number>][] = [
    ["a SUBSET of", { for: 5 }],
    ["a SUPERSET of", { for: 5, against: 3, diff: 2, invented: 0 }],
  ];
  it.each(metricsCases)(
    "reds a metrics block that is %s the derived ledger",
    (_l, metrics) => {
      const pack = tiny();
      pack.expected.tables[0]!.rows[0]!.metrics = metrics;
      const finding = onlyError(validatePack(pack, TINY).findings);
      expect(finding.code).toBe("standings.metrics");
      expect(finding.message).toContain(
        'the fold produced {"for":5,"against":3,"diff":2}',
      );
    },
  );
});

// ===========================================================================
// Stage 3's `toTableStage` mirror — the region the first sweep never reached
//
// Nine mirrored lines exist so the offline table cannot differ from the seeded
// one, and not one of them was driven: no test declared a stage `points` rule,
// an americano or swiss stage, `rngSeed`, `rounds` or `h2h_scope`. Every case
// below is built so that DROPPING its mirror line changes the derived table.
// ===========================================================================

interface LeagueSpec {
  readonly entrants: readonly string[];
  /** `[extKey, home, away, homeScore, awayScore]` */
  readonly fixtures: readonly [string, string, string, number, number][];
  readonly stage?: Record<string, unknown>;
  readonly stageKind?: string;
  readonly tiebreakers?: readonly string[];
  readonly seeds?: Readonly<Record<string, number>>;
  readonly rows?: readonly Record<string, unknown>[];
}

/** A multi-fixture generic league, for the stage-3 cases `_tiny` cannot pose. */
function leaguePack(spec: LeagueSpec): Record<string, unknown> {
  const outcomeOf = (
    home: string,
    away: string,
    hs: number,
    as_: number,
  ): Record<string, unknown> =>
    hs === as_
      ? { kind: "draw" }
      : {
          kind: "win",
          winner: hs > as_ ? home : away,
          loser: hs > as_ ? away : home,
        };
  return {
    schemaVersion: 1,
    suite: "_unit",
    org: { name: "Unit Org", slug: "unit-org", timezone: "UTC" },
    competition: { name: "Unit Cup", slug: "unit-cup", endsOn: "2099-01-02" },
    divisions: [
      {
        ref: "d1",
        name: "D1",
        sportKey: "generic",
        variantKey: "score",
        moduleVersion: "1.0.0",
        cfgOverrides: {
          resultMode: "score",
          allowDraws: true,
          points: { w: 3, d: 1, l: 0 },
          progressScore: false,
        },
        ...(spec.tiebreakers === undefined
          ? {}
          : { tiebreakers: [...spec.tiebreakers] }),
        stages: [
          {
            ref: "s1",
            seq: 1,
            kind: spec.stageKind ?? "league",
            name: "Stage",
            config: spec.stage ?? {},
          },
        ],
      },
    ],
    persons: [],
    entrants: spec.entrants.map((ref) => ({
      ref,
      divisionRef: "d1",
      kind: "individual",
      displayName: ref.toUpperCase(),
      ...(spec.seeds?.[ref] === undefined ? {} : { seed: spec.seeds[ref] }),
    })),
    streams: spec.fixtures.map(([key, home, away, hs, as_]) => ({
      divisionRef: "d1",
      fixtureExtKey: key,
      home,
      away,
      provenance: "real",
      events: [
        { type: "core.start" },
        { type: "generic.result", payload: { p1Score: hs, p2Score: as_ } },
      ],
    })),
    expected: {
      matches: spec.fixtures.map(([key, home, away, hs, as_]) => ({
        divisionRef: "d1",
        fixtureExtKey: key,
        outcome: outcomeOf(home, away, hs, as_),
      })),
      ...(spec.rows === undefined
        ? {}
        : {
            tables: [
              {
                divisionRef: "d1",
                stageRef: "s1",
                rows: spec.rows.map((r) => ({ ...r })),
              },
            ],
          }),
    },
    meta: { synthetic: true, sources: [] },
  };
}

const row = (
  entrant: string,
  rank: number,
  played: number,
  won: number,
  drawn: number,
  lost: number,
  points: number,
): Record<string, unknown> => ({
  entrant,
  rank,
  played,
  won,
  drawn,
  lost,
  points,
});

describe("validatePack — the stage-config mirror is DRIVEN, key by key", () => {
  it("applies the stage's own points rule, which the division cfg cannot express", () => {
    // The competition layer's `applyPointsRule` path, not the module's
    // `standingsDelta` path — a real group stage sets 3/1/0 at the STAGE. The
    // division cfg awards 3/1/0; the stage rule awards 10/4/1, so the table is
    // green ONLY if the rule ran.
    const pack = leaguePack({
      entrants: ["e1", "e2"],
      fixtures: [["f1", "e1", "e2", 3, 1]],
      stage: { points: { base: { win: 10, draw: 4, loss: 1 } } },
      rows: [row("e1", 1, 1, 1, 0, 0, 10), row("e2", 2, 1, 0, 0, 1, 1)],
    });
    expectClean(validatePack(pack, UNIT), []);

    // The control: the SAME fixtures with no stage rule fall back to the
    // module's own 3/0, so the two paths are visibly different numbers.
    const bare = leaguePack({
      entrants: ["e1", "e2"],
      fixtures: [["f1", "e1", "e2", 3, 1]],
      rows: [row("e1", 1, 1, 1, 0, 0, 3), row("e2", 2, 1, 0, 0, 1, 0)],
    });
    expectClean(validatePack(bare, UNIT), []);
  });

  it("reds a stage points rule the engine's own schema refuses", () => {
    // `stages[].config` is an opaque JSON record in the pack, so a malformed
    // rule parses at stage 1 and is only caught here. Ignoring it silently
    // would derive the table under the MODULE's points instead — a wrong
    // table reported as a right one.
    const pack = leaguePack({
      entrants: ["e1", "e2"],
      fixtures: [["f1", "e1", "e2", 3, 1]],
      stage: { points: { base: { win: "three", draw: 1, loss: 0 } } },
      rows: [row("e1", 1, 1, 1, 0, 0, 3), row("e2", 2, 1, 0, 0, 1, 0)],
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("standings.underivable");
    expect(finding.message).toContain("points rule the engine refuses");
  });

  it("assembles the Swiss ledger for a swiss stage, so buchholz can separate", () => {
    // e2 and e3 are level on points; buchholz splits them (e3's opponents
    // scored 9 half-points, e2's 3). Without the assembled ledger the
    // comparator returns 0 for every pair and the tie falls through to
    // entrant id — which would put e2 first.
    const pack = leaguePack({
      stageKind: "swiss",
      stage: { rounds: 2 },
      tiebreakers: ["points", "buchholz"],
      entrants: ["e1", "e2", "e3", "e4"],
      fixtures: [
        ["f1", "e1", "e3", 2, 0],
        ["f2", "e2", "e4", 2, 0],
        ["f3", "e3", "e2", 2, 0],
        ["f4", "e1", "e4", 2, 0],
      ],
      rows: [
        row("e1", 1, 2, 2, 0, 0, 6),
        row("e3", 2, 2, 1, 0, 1, 3),
        row("e2", 3, 2, 1, 0, 1, 3),
        row("e4", 4, 2, 0, 0, 2, 0),
      ],
    });
    expectClean(validatePack(pack, UNIT), []);
  });

  it("carries the stage's rngSeed into a drawing of lots", () => {
    // Two entrants level after a draw, cascade ending in `lots`. Seed 4 draws
    // them [e2, e1]; with no seed the engine uses 0 and draws [e1, e2]. The
    // draw is reproducible by design (spec 05 §4.4), which is the only reason
    // a pack can assert its result at all.
    const drawn = (
      stage: Record<string, unknown>,
      rows: readonly Record<string, unknown>[],
    ) =>
      leaguePack({
        entrants: ["e1", "e2"],
        fixtures: [["f1", "e1", "e2", 1, 1]],
        tiebreakers: ["points", "lots"],
        stage,
        rows,
      });
    expectClean(
      validatePack(
        drawn({ rngSeed: 4 }, [
          row("e2", 1, 1, 0, 1, 0, 1),
          row("e1", 2, 1, 0, 1, 0, 1),
        ]),
        UNIT,
      ),
      [],
    );
    expectClean(
      validatePack(
        drawn({}, [row("e1", 1, 1, 0, 1, 0, 1), row("e2", 2, 1, 0, 1, 0, 1)]),
        UNIT,
      ),
      [],
    );

    // And a NON-numeric seed is forwarded, not dropped. `stages[].config` is
    // an opaque JSON record, so `"4"` is expressible; the product's
    // `toTableStage` tests `!= null` and passes it through, and the engine
    // coerces it — so `"4"` draws the same order as `4`. A `typeof === "number"`
    // sniff here would drop it, fold green offline, and rank differently on
    // seeding: the exact divergence "mirrored in full" exists to prevent.
    expectClean(
      validatePack(
        drawn({ rngSeed: "4" }, [
          row("e2", 1, 1, 0, 1, 0, 1),
          row("e1", 2, 1, 0, 1, 0, 1),
        ]),
        UNIT,
      ),
      [],
    );
  });

  it("carries h2h_scope: overall, which skips the mini-table for a 3-way tie", () => {
    // e1/e2/e3 are circular on points. Their head-to-head mini-table orders
    // them e3 > e2 > e1; overall goal difference orders them the OTHER way,
    // because of how heavily each beat e4. `h2h_scope: "overall"` is the
    // organiser's choice between those two answers.
    const fixtures: [string, string, string, number, number][] = [
      ["f1", "e1", "e2", 2, 1],
      ["f2", "e2", "e3", 2, 1],
      ["f3", "e3", "e1", 4, 1],
      ["f4", "e1", "e4", 10, 0],
      ["f5", "e2", "e4", 5, 0],
      ["f6", "e3", "e4", 1, 0],
    ];
    const base = {
      entrants: ["e1", "e2", "e3", "e4"],
      fixtures,
      tiebreakers: ["points", "h2h_diff", "diff"],
    } as const;
    const table = (order: readonly string[]): Record<string, unknown>[] =>
      order.map((ref, i) =>
        ref === "e4"
          ? row(ref, i + 1, 3, 0, 0, 3, 0)
          : row(ref, i + 1, 3, 2, 0, 1, 6),
      );

    expectClean(
      validatePack(
        leaguePack({
          ...base,
          stage: { h2h_scope: "overall" },
          rows: table(["e1", "e2", "e3", "e4"]),
        }),
        UNIT,
      ),
      [],
    );
    // The default (mini-table) gives the opposite order for the tied three,
    // so the two modes are genuinely distinguishable by this fixture.
    expectClean(
      validatePack(
        leaguePack({ ...base, rows: table(["e3", "e2", "e1", "e4"]) }),
        UNIT,
      ),
      [],
    );
  });

  it("derives an AMERICANO stage's table, which rides the league fold", () => {
    const pack = leaguePack({
      stageKind: "americano",
      entrants: ["e1", "e2"],
      fixtures: [["f1", "e1", "e2", 3, 1]],
      rows: [row("e1", 1, 1, 1, 0, 0, 3), row("e2", 2, 1, 0, 0, 1, 0)],
    });
    expectClean(validatePack(pack, UNIT), []);
  });

  it("warns when a table-kind stage folds streams and the pack asserts no table", () => {
    // Stage 3 is the ONLY stage that catches an end-to-end reversed stream,
    // and PackSchema's anti-vacuity rule stops at streams — so a stage with no
    // declared table is the gate's own blind spot.
    const noTable = leaguePack({
      entrants: ["e1", "e2"],
      fixtures: [["f1", "e1", "e2", 3, 1]],
    });
    const result = validatePack(noTable, UNIT);
    expect(errors(result.findings)).toEqual([]);
    const warning = warnings(result.findings)[0];
    expect(warning?.code).toBe("standings.no_expected_table");
    expect(warning?.where).toBe("divisions[ref=d1].stages[ref=s1]");
    expect(warning?.message).toContain('1 stream(s) fold into stage "s1"');

    // And it goes quiet the moment the table is declared — otherwise it would
    // fire on every pack and mean nothing.
    const withTable = leaguePack({
      entrants: ["e1", "e2"],
      fixtures: [["f1", "e1", "e2", 3, 1]],
      rows: [row("e1", 1, 1, 1, 0, 0, 3), row("e2", 2, 1, 0, 0, 1, 0)],
    });
    expectClean(validatePack(withTable, UNIT), []);
  });

  it("does NOT warn about a BRACKET stage with no table — it has none to declare", () => {
    const ko = leaguePack({
      stageKind: "knockout",
      entrants: ["e1", "e2"],
      fixtures: [["f1", "e1", "e2", 3, 1]],
    });
    expectClean(validatePack(ko, UNIT), []);
  });
});

// ===========================================================================
// streams[].stageRef — bound, not merely accepted
// ===========================================================================

describe("validatePack — a stream's declared stageRef binds it to a stage", () => {
  /** A two-stage football division: a league group, then a knockout that turns
   *  `shootout` on. A goalless fixture is a decided DRAW under the division
   *  cfg and an UNDECIDED shootout under the knockout stage's overlay, so
   *  which stage a stream binds to is directly observable in the outcome. */
  const twoStage = (stageRef: string | undefined): Record<string, unknown> => ({
    schemaVersion: 1,
    suite: "_unit",
    org: { name: "Unit Org", slug: "unit-org", timezone: "UTC" },
    competition: { name: "Unit Cup", slug: "unit-cup", endsOn: "2099-01-02" },
    divisions: [
      {
        ref: "d1",
        name: "D1",
        sportKey: "football",
        variantKey: "11-a-side",
        moduleVersion: "1.0.0",
        cfgOverrides: { shootout: false },
        stages: [
          { ref: "s-group", seq: 1, kind: "group", name: "Group", config: {} },
          {
            ref: "s-ko",
            seq: 2,
            kind: "knockout",
            name: "KO",
            config: { shootout: true },
          },
        ],
      },
    ],
    persons: [],
    entrants: [
      { ref: "e1", divisionRef: "d1", kind: "team", displayName: "One" },
      { ref: "e2", divisionRef: "d1", kind: "team", displayName: "Two" },
    ],
    streams: [
      {
        divisionRef: "d1",
        fixtureExtKey: "f1",
        ...(stageRef === undefined ? {} : { stageRef }),
        home: "e1",
        away: "e2",
        provenance: "real",
        events: [
          { type: "core.start" },
          { type: "football.period", payload: { phase: "HT" } },
          { type: "football.period", payload: { phase: "FT" } },
        ],
      },
    ],
    expected: {
      matches: [
        { divisionRef: "d1", fixtureExtKey: "f1", outcome: { kind: "draw" } },
      ],
    },
    meta: { synthetic: true, sources: [] },
  });

  it("folds under the NAMED stage's decider overlay", () => {
    // Bound to the knockout: `shootout` overlays, the goalless match enters the
    // shootout phase and never decides. This is the assertion that proves the
    // field is CONSULTED — a schema that merely accepts it leaves this green.
    const finding = onlyError(validatePack(twoStage("s-ko"), UNIT).findings);
    expect(finding.code).toBe("fold.not_decided");
    expect(finding.where).toBe("streams[0] (d1/f1)");
  });

  it("folds under the group stage's when that is the one named", () => {
    // Same events, same division, different stageRef — a decided draw, and NO
    // unbindable warning, because nothing is unbound any more.
    const result = validatePack(twoStage("s-group"), UNIT);
    expectClean(result, ["standings.no_expected_table"]);
  });

  it("without a stageRef, a multi-stage division binds nothing and says so", () => {
    const result = validatePack(twoStage(undefined), UNIT);
    expect(errors(result.findings)).toEqual([]);
    expect(warnings(result.findings).map((f) => f.code)).toEqual([
      "fold.stage_overlay_unbindable",
    ]);
    expect(warnings(result.findings)[0]?.message).toContain("[shootout]");
    expect(warnings(result.findings)[0]?.message).toContain(
      "1 of its stream(s) name no stage",
    );
  });

  it("checks a MULTI-STAGE division's per-stage table once every stream is bound", () => {
    // The payoff: with streams bound, `expected.tables` for one stage is
    // derived from THAT stage's streams only. Two stages, one fixture each,
    // and each table must see just its own.
    const pack = {
      schemaVersion: 1,
      suite: "_unit",
      org: { name: "Unit Org", slug: "unit-org", timezone: "UTC" },
      competition: { name: "Unit Cup", slug: "unit-cup", endsOn: "2099-01-02" },
      divisions: [
        {
          ref: "d1",
          name: "D1",
          sportKey: "generic",
          variantKey: "score",
          moduleVersion: "1.0.0",
          cfgOverrides: {
            resultMode: "score",
            allowDraws: true,
            points: { w: 3, d: 1, l: 0 },
            progressScore: false,
          },
          stages: [
            { ref: "sA", seq: 1, kind: "league", name: "A", config: {} },
            { ref: "sB", seq: 2, kind: "league", name: "B", config: {} },
          ],
        },
      ],
      persons: [],
      entrants: [
        {
          ref: "e1",
          divisionRef: "d1",
          kind: "individual",
          displayName: "One",
        },
        {
          ref: "e2",
          divisionRef: "d1",
          kind: "individual",
          displayName: "Two",
        },
      ],
      streams: [
        {
          divisionRef: "d1",
          stageRef: "sA",
          fixtureExtKey: "a1",
          home: "e1",
          away: "e2",
          provenance: "real",
          events: [
            { type: "core.start" },
            { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } },
          ],
        },
        {
          divisionRef: "d1",
          stageRef: "sB",
          fixtureExtKey: "b1",
          home: "e2",
          away: "e1",
          provenance: "real",
          events: [
            { type: "core.start" },
            { type: "generic.result", payload: { p1Score: 2, p2Score: 0 } },
          ],
        },
      ],
      expected: {
        matches: [
          {
            divisionRef: "d1",
            fixtureExtKey: "a1",
            outcome: { kind: "win", winner: "e1", loser: "e2" },
          },
          {
            divisionRef: "d1",
            fixtureExtKey: "b1",
            outcome: { kind: "win", winner: "e2", loser: "e1" },
          },
        ],
        tables: [
          // Each stage's table counts ONE fixture. A derivation that pooled
          // both would give `played: 2` on every row.
          {
            divisionRef: "d1",
            stageRef: "sA",
            rows: [row("e1", 1, 1, 1, 0, 0, 3), row("e2", 2, 1, 0, 0, 1, 0)],
          },
          {
            divisionRef: "d1",
            stageRef: "sB",
            rows: [row("e2", 1, 1, 1, 0, 0, 3), row("e1", 2, 1, 0, 0, 1, 0)],
          },
        ],
      },
      meta: { synthetic: true, sources: [] },
    };
    expectClean(validatePack(pack, UNIT), []);
  });
});

// ===========================================================================
// The warning channel's own coverage
// ===========================================================================

describe("validatePack — the oracles it does NOT derive say so", () => {
  it("names a fabricated leaderboard as unchecked rather than reporting nothing", () => {
    // `_tiny`'s declared leaderboard is factually wrong once the scorer is
    // flipped, and stage 0 still cannot see it — but the report no longer
    // reads "ok, no findings".
    const pack = tiny();
    const stream = pack.streams[1] as TinyStream;
    (stream.events[2] as { payload: Record<string, unknown> }).payload[
      "person"
    ] = "@p-bo";
    const result = validatePack(pack, TINY);
    expectClean(result, TINY_NOT_DERIVED);
    expect(warnings(result.findings)[0]?.message).toContain("B05");
  });

  it("stays silent about an EMPTY block — a warning that always fires means nothing", () => {
    const pack = tiny();
    pack.expected.leaderboards = [];
    pack.expected.champions = [];
    // B05 T3 — `_tiny.json` now declares its own expected.finalRanks
    // (d-tiny/s-playoff); cleared here too so this test still proves silence
    // on an EMPTY block rather than silently stopping being about finalRanks.
    (pack.expected as Record<string, unknown>)["finalRanks"] = [];
    // B05 T5b — same again for expected.careers, which `_tiny.json` now
    // declares: without this the test asserts silence on a block that is no
    // longer empty, which is the opposite of what it is named for.
    (pack.expected as Record<string, unknown>)["careers"] = [];
    expectClean(validatePack(pack, TINY), []);
  });

  it("warns for suspensions too, and counts them", () => {
    const pack = tiny();
    pack.expected.suspensions = [
      {
        divisionRef: "d-tiny",
        person: "p-bo",
        missesFixtureExtKeys: ["rr-r3-c1"],
      },
    ] as TinyShape["expected"]["suspensions"];
    const result = validatePack(pack, TINY);
    expectClean(result, [...TINY_NOT_DERIVED, "suspensions.not_derived"]);
    const suspension = warnings(result.findings).find(
      (f) => f.code === "suspensions.not_derived",
    );
    expect(suspension?.message).toContain(
      "1 declared expected.suspensions entry is NOT checked",
    );
  });

  it("warns for finalRanks — a bracket's placement order is the product's answer, not the fold's", () => {
    const pack = tiny();
    // B05 T3 — `_tiny.json` now declares its OWN finalRanks entry
    // (d-tiny/s-playoff, already covered by TINY_NOT_DERIVED below); this
    // REPLACES it with a different one (same count, 1, so the warning's own
    // count assertion below is unaffected) to keep proving the block is
    // reachable independent of which stage it names.
    (pack.expected as Record<string, unknown>)["finalRanks"] = [
      {
        divisionRef: "d-tiny",
        stageRef: "s-league",
        order: ["e-alpha", "e-bravo"],
      },
    ];
    const result = validatePack(pack, TINY);
    // The block is REACHABLE and the warning names its count and its owner —
    // a shape the schema accepts and stage 0 never mentions is the inert seam
    // this warning channel exists to prevent.
    expectClean(result, TINY_NOT_DERIVED);
    const found = warnings(result.findings).find(
      (f) => f.code === "finalRanks.not_derived",
    );
    expect(found?.message).toContain(
      "1 declared expected.finalRanks entry is NOT checked",
    );
    expect(found?.message).toContain("B05");
    // …and it says what IS checked offline, so a reader does not conclude the
    // block is unchecked in every respect.
    expect(found?.message).toContain("checked at parse");
  });

  it("warns for careers, and counts them", () => {
    const pack = tiny();
    (pack.expected as Record<string, unknown>)["careers"] = [
      { person: "p-ana", name: "Ana Alvarez", metricKey: "scores", count: 2 },
      { person: "p-bo", name: "Bo Baptiste", metricKey: "scores", count: 1 },
    ];
    const result = validatePack(pack, TINY);
    // B05 T5b — `careers.not_derived` is already part of TINY_NOT_DERIVED
    // now that the committed pack declares its own careers block; this test
    // REPLACES that block with two rows of its own to pin the COUNT in the
    // message below, so the warning list is unchanged, not one longer.
    expectClean(result, TINY_NOT_DERIVED);
    const found = warnings(result.findings).find(
      (f) => f.code === "careers.not_derived",
    );
    expect(found?.message).toContain(
      "2 declared expected.careers entries are NOT checked",
    );
    // The REASON matters: summing the per-division leaderboards here would
    // compute one expected value out of others, which is the oracle direction
    // inverted.
    expect(found?.message).toContain("expected value out of others");
  });

  it("stays silent about both new blocks when they are empty", () => {
    const pack = tiny();
    pack.expected.leaderboards = [];
    pack.expected.champions = [];
    (pack.expected as Record<string, unknown>)["finalRanks"] = [];
    (pack.expected as Record<string, unknown>)["careers"] = [];
    expectClean(validatePack(pack, TINY), []);
  });

  it("warns when a SPECIAL's own stream did not fold", () => {
    // The only unpinned warning site on the first sweep: `_tiny`'s special is
    // on rr-r3-c1 while every other corruption breaks rr-r1-c1 or rr-r2-c1, so
    // the special always folded and the skip was never exercised.
    const pack = tiny();
    const stream = pack.streams[2] as TinyStream;
    expect(stream.fixtureExtKey).toBe("rr-r3-c1");
    stream.events.splice(1, 0, { type: "core.start" });

    const result = validatePack(pack, TINY);
    expect(onlyError(result.findings).code).toBe("fold.rejected");
    const skipped = warnings(result.findings).find(
      (f) => f.code === "special.upstream_fold_failed",
    );
    // The MESSAGE, not just the code: a skip that says "not checked" without
    // naming WHICH fixture is the decoration this warning exists to replace.
    expect(skipped?.where).toBe(
      "expected.specials[0] (retirement d-tiny/rr-r3-c1)",
    );
    expect(skipped?.message).toBe(
      'not checked: fixture "rr-r3-c1" did not fold to a verified outcome',
    );
    // And no special ERROR: an unfolded stream must not also be reported as a
    // failed claim, which would bury the fold failure under a derived one.
    expect(
      errors(result.findings).filter((f) => f.code.startsWith("special.")),
    ).toEqual([]);
  });
});

// ===========================================================================
// The mirrored product constant, checked against the product itself
// ===========================================================================

describe("STAGE_DECIDER_KEYS — the mirror is diffed against apps/web, not itself", () => {
  it("equals the product's own constant, read as TEXT", () => {
    // GLOBAL.md forbids IMPORTING from apps/web (the `@/` aliases do not
    // resolve here and most of that tree is `server-only`). Reading the file
    // as text is not importing it, and it is the only thing that can catch the
    // failure the mirror actually has: the PRODUCT adding a third key. A test
    // asserting the mirror against a copy of itself cannot.
    const source = readFileSync(
      path.join(REPO_ROOT, "apps/web/src/server/engine-db/stage-cfg.ts"),
      "utf8",
    );
    const literal = /const STAGE_DECIDER_KEYS = \[([^\]]*)\] as const;/.exec(
      source,
    );
    // Red on ABSENCE rather than skipping: a bench that cannot see the product
    // it mirrors must say so, not quietly pass.
    expect(
      literal,
      "STAGE_DECIDER_KEYS not found in engine-db/stage-cfg.ts",
    ).not.toBeNull();
    const productKeys = [...(literal?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(productKeys.length).toBeGreaterThan(0);

    // Driven through the mirror rather than read off a copied array: the
    // overlay must carry every key the product carries, and nothing else.
    const stageCfg = Object.fromEntries(productKeys.map((k) => [k, `v-${k}`]));
    stageCfg["legs"] = 3;
    expect(stageScopedFoldCfg({ base: 1 }, stageCfg)).toEqual({
      base: 1,
      ...Object.fromEntries(productKeys.map((k) => [k, `v-${k}`])),
    });
  });
});

describe("stageScopedFoldCfg — the product's two-key stage overlay", () => {
  // A goalless football match, ended by its two period markers. With
  // `shootout` off it is a decided draw; with `shootout` on the same events
  // leave the match in its SHOOTOUT phase, undecided. The division declares
  // it OFF and the STAGE turns it on — so this is green only if the overlay
  // actually reaches the fold, not merely if the overlay function is correct.
  const goalless = (
    stageConfig: Record<string, unknown>,
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    suite: "_unit",
    org: { name: "Unit Org", slug: "unit-org", timezone: "UTC" },
    competition: { name: "Unit Cup", slug: "unit-cup", endsOn: "2099-01-02" },
    divisions: [
      {
        ref: "d1",
        name: "D1",
        sportKey: "football",
        variantKey: "11-a-side",
        moduleVersion: "1.0.0",
        cfgOverrides: { shootout: false },
        stages: [
          {
            ref: "s1",
            seq: 1,
            kind: "knockout",
            name: "KO",
            config: stageConfig,
          },
        ],
      },
    ],
    persons: [],
    entrants: [
      { ref: "e1", divisionRef: "d1", kind: "team", displayName: "One" },
      { ref: "e2", divisionRef: "d1", kind: "team", displayName: "Two" },
    ],
    streams: [
      {
        divisionRef: "d1",
        fixtureExtKey: "f1",
        home: "e1",
        away: "e2",
        provenance: "real",
        events: [
          { type: "core.start" },
          { type: "football.period", payload: { phase: "HT" } },
          { type: "football.period", payload: { phase: "FT" } },
        ],
      },
    ],
    expected: {
      matches: [
        { divisionRef: "d1", fixtureExtKey: "f1", outcome: { kind: "draw" } },
      ],
    },
    meta: { synthetic: true, sources: [] },
  });

  it("is APPLIED at the fold, not merely correct in isolation", () => {
    expectClean(validatePack(goalless({}), UNIT), []);

    const applied = validatePack(goalless({ shootout: true }), UNIT);
    expect(onlyError(applied.findings).code).toBe("fold.not_decided");
    // And NO warning: a single-stage division binds its overlay, so there is
    // nothing unbindable to report. Without this the unbindable warning could
    // fire on every pack that declares a decider key at all.
    expect(warnings(applied.findings)).toEqual([]);
  });

  it("is NOT applied in a multi-stage division, and the risk is named", () => {
    // The division cannot bind a stream to a stage, so no overlay is applied
    // — even though a stage declares one. The fold therefore runs on the
    // division's own cfg (shootout OFF) and the match is a decided draw.
    const pack = goalless({ shootout: true }) as unknown as {
      divisions: { stages: Record<string, unknown>[] }[];
    };
    pack.divisions[0]!.stages.push({
      ref: "s2",
      seq: 2,
      kind: "knockout",
      name: "KO2",
      config: {},
    });

    const result = validatePack(
      pack as unknown as Record<string, unknown>,
      UNIT,
    );
    expect(errors(result.findings)).toEqual([]);
    const warning = warnings(result.findings)[0];
    expect(warning?.code).toBe("fold.stage_overlay_unbindable");
    expect(warning?.where).toBe("divisions[ref=d1]");
    expect(warning?.message).toContain("[shootout]");

    // And a multi-stage division that declares NO decider key says nothing —
    // the warning must not fire on every multi-stage pack.
    const quiet = goalless({}) as unknown as {
      divisions: { stages: Record<string, unknown>[] }[];
    };
    quiet.divisions[0]!.stages.push({
      ref: "s2",
      seq: 2,
      kind: "knockout",
      name: "KO2",
      config: {},
    });
    expectClean(
      validatePack(quiet as unknown as Record<string, unknown>, UNIT),
      [],
    );
  });

  // The same football fold is the only place in this suite whose state carries
  // a nested ARRAY, so it is where a state claim's deep equality is really
  // exercised — a claim's `equals` is any JSON value, and `periods` is the
  // realistic shape a pack would assert against.
  const withClaim = (
    equals: unknown,
    path: string,
  ): Record<string, unknown> => {
    const pack = goalless({}) as unknown as {
      expected: Record<string, unknown>;
    };
    pack.expected["specials"] = [
      {
        kind: "ot_gws",
        divisionRef: "d1",
        fixtureExtKey: "f1",
        claims: [{ on: "state", path, equals }],
      },
    ];
    return pack as unknown as Record<string, unknown>;
  };
  const periods = [
    { phase: "H1", home: 0, away: 0 },
    { phase: "H2", home: 0, away: 0 },
  ];

  it("holds when a state claim deep-equals the folded value", () => {
    expectClean(validatePack(withClaim(periods, "periods"), UNIT), []);
    expectClean(
      validatePack(withClaim({ home: 0, away: 0 }, "goals"), UNIT),
      [],
    );
  });

  // Each of these is caught by a DIFFERENT line of the comparison, and each
  // one is the case its line exists for. Picked by driving the mutants: an
  // array claim that is SHORT reds through the element walk and leaves the
  // length check untested, and an object claim with FEWER keys reds through
  // the key count and leaves the array-vs-object check untested. Only the
  // long array and the fully-indexed object separate them.
  const claimShapes: [string, unknown][] = [
    ["an array one element SHORT", [periods[0]]],
    ["an array one element LONG", [...periods, periods[0]]],
    [
      "an object standing in for the array, same keys",
      { 0: periods[0], 1: periods[1] },
    ],
    [
      "an element whose value differs",
      [periods[0], { phase: "H2", home: 1, away: 0 }],
    ],
  ];
  it.each(claimShapes)("reds a state claim that is %s", (_label, equals) => {
    expect(
      onlyError(validatePack(withClaim(equals, "periods"), UNIT).findings).code,
    ).toBe("special.state");
  });

  it("overlays ONLY shootout and extraTime", () => {
    const base = { setTo: 21, shootout: false };
    expect(
      stageScopedFoldCfg(base, {
        legs: 3,
        shootout: true,
        extraTime: { halves: 2 },
      }),
    ).toEqual({ setTo: 21, shootout: true, extraTime: { halves: 2 } });
  });

  it("is the identity when the stage sets neither key", () => {
    const base = { setTo: 21 };
    expect(stageScopedFoldCfg(base, { legs: 3 })).toBe(base);
    expect(stageScopedFoldCfg(base, undefined)).toBe(base);
  });
});

// ===========================================================================
// Pipeline-level checks
// ===========================================================================

describe("validatePack — stage 1 is the pipeline's shape gate", () => {
  it("refuses a duplicate ext_key within one division", () => {
    const pack = tiny();
    (pack.streams[1] as TinyStream).fixtureExtKey = "rr-r1-c1";
    const result = validatePack(pack, TINY);
    expect(result.ok).toBe(false);
    // The rule and its reason live in PackSchema's `checkStreams`, not here —
    // one implementation, reached through the pipeline.
    const dup = result.findings.find((f) =>
      f.message.includes("unique per DIVISION"),
    );
    expect(dup?.where).toBe("streams.1.fixtureExtKey");
    expect(dup?.code).toBe("schema.custom");
  });

  it("stops after stage 1 and returns no pack when the shape is wrong", () => {
    const result = validatePack({ schemaVersion: 2 }, UNIT);
    expect(result.pack).toBe(null);
    expect(result.ok).toBe(false);
    expect(result.provenance.overall.total).toBe(0);
    expect(result.findings.every((f) => f.code.startsWith("schema."))).toBe(
      true,
    );
  });

  it("checks the pack's own suite key against the caller's expectation", () => {
    const finding = onlyError(
      validatePack(tiny(), { expectedSuite: "worldcup-2019" }).findings,
    );
    expect(finding.code).toBe("pack.suite_mismatch");
    expect(finding.message).toContain('pack declares suite "_tiny"');
    expectClean(validatePack(tiny(), TINY), TINY_NOT_DERIVED);
    // `expectedSuite` is REQUIRED, so the previous version of this test — "an
    // omitted option must not red" — is no longer expressible: omitting it is
    // a tsc error, which is the point. `tsconfig.scripts.json` covers every
    // non-test file under `scripts/bench/**`, so Task 3's runner cannot forget
    // it. Pinned by mutant M69b (make it optional again → tsc still passes,
    // which is exactly why the REQUIRED form is the guard and a comment was
    // not).
  });

  it("warns when a REAL suite key waives the cite-a-source rule", () => {
    const pack = tiny();
    pack.suite = "worldcup-2019";
    const result = validatePack(pack, { expectedSuite: "worldcup-2019" });
    expect(errors(result.findings)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(warnings(result.findings).map((f) => f.code)).toEqual([
      "pack.synthetic_suite",
      ...TINY_NOT_DERIVED,
    ]);
  });
});

// ===========================================================================
// Helpers with their own contracts
// ===========================================================================

describe("resolveStatePath", () => {
  it("separates 'absent' from 'present but undefined'", () => {
    expect(resolveStatePath({ a: undefined }, "a")).toEqual({
      found: true,
      value: undefined,
    });
    expect(resolveStatePath({ a: 1 }, "b")).toEqual({
      found: false,
      value: undefined,
    });
  });

  it("indexes into arrays and refuses an out-of-range or non-numeric index", () => {
    const state = { sets: [{ mtb: false }, { mtb: true }] };
    expect(resolveStatePath(state, "sets.1.mtb")).toEqual({
      found: true,
      value: true,
    });
    expect(resolveStatePath(state, "sets.2.mtb").found).toBe(false);
    // The index must be checked where the path ENDS on it, not only where a
    // later segment happens to fall off a non-object: walking past the end of
    // an array otherwise reports `found: true, value: undefined`, and a claim
    // of `equals: undefined` would silently hold.
    expect(resolveStatePath(state, "sets.5").found).toBe(false);
    expect(resolveStatePath(state, "sets.length").found).toBe(false);
  });

  it("refuses to walk through a non-object", () => {
    expect(resolveStatePath({ a: 5 }, "a.b").found).toBe(false);
    expect(resolveStatePath({ a: null }, "a.b").found).toBe(false);
  });
});

describe("engine facts that make two of this file's mirrors unfalsifiable today", () => {
  it("no shipped module's standingsDelta reads its StageCtx", () => {
    // Stage 3 passes the stage's OWN kind as `ctxBase`, mirroring
    // `competition.ts:236`. Today that mirror cannot be witnessed: all eight
    // `standingsDelta` implementations in the engine name the argument `_ctx`
    // and never read it, so passing the wrong kind changes nothing (recorded
    // as an equivalent mutant in the task report).
    //
    // Driven rather than grepped, on the module this suite actually folds. If
    // a module starts varying its delta by stage kind — knockout football
    // forbidding draws is the obvious one — this reds and the mirror becomes
    // load-bearing.
    const lineups = {
      home: {
        entrantId: "HOME",
        slots: [{ personId: "ph", slot: "starting" as const, orderNo: 1 }],
      },
      away: {
        entrantId: "AWAY",
        slots: [{ personId: "pa", slot: "starting" as const, orderNo: 1 }],
      },
    };
    // EVERY shipped module, not just the one this file happens to fold — the
    // mirror is generic and so is the claim about it.
    let compared = 0;
    for (const sportModule of builtinModules) {
      const raws = [{}, ...Object.values(sportModule.variants)];
      const raw = raws.find(
        (candidate) => sportModule.configSchema.safeParse(candidate).success,
      );
      if (raw === undefined) continue;
      const cfg = sportModule.configSchema.parse(raw);
      const state = sportModule.init(cfg, lineups);
      const outcome = { kind: "win" as const, winner: "HOME", loser: "AWAY" };
      const league = sportModule.standingsDelta(
        outcome,
        cfg,
        { kind: "league" },
        state,
      );
      const knockout = sportModule.standingsDelta(
        outcome,
        cfg,
        { kind: "knockout" },
        state,
      );
      expect(league, sportModule.key).toEqual(knockout);
      compared += 1;
    }
    // Non-vacuity: a loop that compared nothing would pass silently.
    expect(compared).toBe(builtinModules.length);
  });

  it("every shipped module renders perSide as [home, away] AT INIT", () => {
    // TITLE NARROWED (whole-branch review N2). This loop measures `init` and
    // nothing else, where every score is zero and a module that ordered
    // `perSide` BY SCORE is indistinguishable from one that never reorders.
    // "Every shipped module" was true of the SWEEP and false of the CLAIM, and
    // conflating the two is how one sample gets read as a parity sweep. The
    // decided-fold sweep below is where the claim has teeth.
    //
    // stage 2 matches a pack's score lines to the module's summary BY ENTRANT,
    // never by index, because `ScoreSummary.perSide`'s order is not
    // contractual. Measured here: all eleven shipped modules order it
    // [home, away] at init, and PackSchema already forces the pack's own
    // `perSide` to [home, away] — so for every pack that can be built today,
    // by-entrant and by-index give the same answer, and no test can tell them
    // apart (recorded as an equivalent mutant in the task report).
    //
    // The day a module reorders, this test reds FIRST and tells the next
    // session that the by-entrant rule has become load-bearing — which is the
    // whole point of pinning the fact rather than assuming it.
    const lineups = {
      home: {
        entrantId: "HOME",
        slots: [{ personId: "ph", slot: "starting" as const, orderNo: 1 }],
      },
      away: {
        entrantId: "AWAY",
        slots: [{ personId: "pa", slot: "starting" as const, orderNo: 1 }],
      },
    };
    expect(builtinModules.length).toBeGreaterThan(0);
    for (const sportModule of builtinModules) {
      const raws = [{}, ...Object.values(sportModule.variants)];
      const raw = raws.find(
        (candidate) => sportModule.configSchema.safeParse(candidate).success,
      );
      expect(raw, `${sportModule.key} has no parseable config`).toBeDefined();
      const cfg = sportModule.configSchema.parse(raw);
      const summary = sportModule.summary(sportModule.init(cfg, lineups));
      expect(
        summary.perSide.map((s) => s.entrantId),
        sportModule.key,
      ).toEqual(["HOME", "AWAY"]);
    }
  });

  it("still renders perSide as [home, away] after a DECIDED fold, on SEVEN modules", () => {
    // The `init` loop above cannot see a score-ordering module. These can: each
    // stream below is decided with an UNEVEN score, built by this branch's own
    // generators through the real fold path, so a module that reordered by
    // score would put the winner first and red here.
    //
    // Seven of eleven. The four not covered — cricket, boardgame, carrom,
    // tennis — need a bespoke decided stream each and no generator in this
    // branch produces one; they stay `init`-only, and saying which four is the
    // point of narrowing the title above.
    const pair = packLineupPair({
      divisionRef: "d",
      fixtureExtKey: "fx",
      home: "e-home",
      away: "e-away",
      provenance: "reconstructed",
      events: [],
    } as never);
    const cfgOf = (
      m: (typeof builtinModules)[number],
      variantKey: string,
    ): unknown => {
      const resolved = resolveDivisionCfg(m, { variantKey, cfgOverrides: {} });
      if (!resolved.ok)
        throw new Error(`${m.key}/${variantKey}: ${JSON.stringify(resolved)}`);
      return resolved.cfg;
    };
    const byKey = (key: string): (typeof builtinModules)[number] => {
      const found = builtinModules.find((m) => m.key === key);
      if (found === undefined) throw new Error(`no module "${key}"`);
      return found;
    };

    // Each sport's OWN set target — a score is only a finished set under the
    // module's own predicate, and the generator refuses one that is not.
    const setBased: [
      string,
      string,
      string,
      { home: number; away: number }[],
    ][] = [
      [
        "badminton",
        "bwf",
        "badminton.rally",
        [
          { home: 21, away: 15 },
          { home: 21, away: 9 },
        ],
      ],
      [
        "volleyball",
        "indoor",
        "volleyball.rally",
        [
          { home: 25, away: 20 },
          { home: 25, away: 12 },
          { home: 25, away: 23 },
        ],
      ],
      [
        "tabletennis",
        "bo5",
        "tabletennis.rally",
        [
          { home: 11, away: 4 },
          { home: 11, away: 9 },
          { home: 11, away: 7 },
        ],
      ],
    ];
    for (const [key, variantKey, rallyType, sets] of setBased) {
      const sportModule = byKey(key);
      const cfg = cfgOf(sportModule, variantKey);
      const events = reconstructSetRallies({
        stage: undefined,
        module: sportModule,
        cfg,
        lineups: pair,
        rallyType,
        // The HOME side wins every set, and by different margins, so neither a
        // score order nor a winner-first order can pass by luck.
        sets,
        seed: 1,
      });
      const { state } = foldMatchWithStoppage(
        sportModule,
        cfg,
        pair,
        events.map((ev, i) => packEnvelope("fx", ev, i)),
        PACK_FOLD_OPTIONS,
      );
      expect(sportModule.outcome(state), key).not.toBeNull();
      expect(
        sportModule.summary(state).perSide.map((x) => x.entrantId),
        key,
      ).toEqual(["@e-home", "@e-away"]);
    }

    const period: [string, string, string][] = [
      ["football", "11-a-side", "football.period"],
      ["hockey", "fih-outdoor", "hockey.period.advance"],
      ["icehockey", "iihf", "icehockey.period.advance"],
    ];
    for (const [key, variantKey, markerType] of period) {
      const sportModule = byKey(key);
      const cfg = cfgOf(sportModule, variantKey);
      const goal = { type: `${key}.goal`, payload: { by: "@e-home" } };
      const events = fillPeriodMarkers({
        stage: undefined,
        module: sportModule,
        cfg,
        lineups: pair,
        markerType,
        segments: [[{ type: "core.start", payload: {} }, goal, goal]],
      });
      const { state } = foldMatchWithStoppage(
        sportModule,
        cfg,
        pair,
        events.map((ev, i) => packEnvelope("fx", ev, i)),
        PACK_FOLD_OPTIONS,
      );
      expect(sportModule.outcome(state), key).not.toBeNull();
      expect(
        sportModule.summary(state).perSide.map((x) => x.entrantId),
        key,
      ).toEqual(["@e-home", "@e-away"]);
    }
  });

  it("still renders perSide as [home, away] after a DECIDED generic fold", () => {
    // `init` alone is too weak a pin for the claim it carries: a module that
    // ordered `perSide` BY SCORE would be [home, away] at kick-off, when both
    // are zero, and reversed the moment anyone scores. `_tiny`'s rr-r1-c1 is a
    // 3-1 home win, so a score-ordering module would fail here and not above.
    const summary = foldTinyFirstFixtureSummary();
    expect(summary.map((s) => s.entrantId)).toEqual(["@e-alpha", "@e-bravo"]);
    // And the losing side really is second — otherwise the assertion above
    // could hold for a module that simply never reorders anything.
    expect(summary.map((s) => s.line)).toEqual(["3", "1"]);
  });
});

/** rr-r1-c1's folded `ScoreSummary.perSide` — a DECIDED 3-1 home win, driven
 *  through the same envelopes and lineups the validator builds. */
function foldTinyFirstFixtureSummary(): readonly {
  entrantId: string;
  line: string;
}[] {
  const pack = PackSchema.parse(tiny());
  const division = pack.divisions[0]!;
  const sportModule = builtinModules.find((m) => m.key === division.sportKey)!;
  const cfg = sportModule.configSchema.parse({
    ...(sportModule.variants[division.variantKey] as object),
    ...division.cfgOverrides,
  });
  const stream = pack.streams[0]!;
  const { state } = foldMatchWithStoppage(
    sportModule,
    cfg,
    packLineupPair(stream),
    packEnvelopes(stream),
    PACK_FOLD_OPTIONS,
  );
  return sportModule.summary(state).perSide;
}

describe("packLineupPair", () => {
  it("gives an entrant with no team sheet an EMPTY slot list, as the product does", () => {
    const pack = PackSchema.parse(tiny());
    const pair = packLineupPair(pack.streams[0]!);
    expect(pair).toEqual({
      home: { entrantId: "@e-alpha", slots: [] },
      away: { entrantId: "@e-bravo", slots: [] },
    });
  });

  it("mirrors buildLineup: orderNo falls back to append order, role 'player' is never spread", () => {
    const pack = PackSchema.parse(
      genericPack({
        lineups: {
          home: [
            { person: "p1", slot: "starting", roles: ["captain"] },
            { person: "p2", slot: "bench", role: "coach", squadNumber: 7 },
          ],
          away: [
            { person: "p2", slot: "starting", orderNo: 4, positionKey: "gk" },
          ],
        },
      }),
    );
    const pair = packLineupPair(pack.streams[0]!);
    expect(pair.home.slots).toEqual([
      {
        personId: sigil("p1"),
        slot: "starting",
        orderNo: 1,
        roles: ["captain"],
      },
      {
        personId: sigil("p2"),
        slot: "bench",
        orderNo: 2,
        squadNumber: 7,
        role: "coach",
      },
    ]);
    expect(pair.away.slots).toEqual([
      {
        personId: sigil("p2"),
        slot: "starting",
        orderNo: 4,
        positionKey: "gk",
      },
    ]);
  });
});

// ===========================================================================
// Registration funnel — stage-0 offline checks (B03r, design §4)
// ===========================================================================
//
// These checks read `pack.persons` / `pack.divisions` / `pack.registration`
// only — never streams — so a minimal `genericPack()` (one division, two
// entrants, one stream, all otherwise irrelevant here) is layered with a
// registration block on top. `competition.startsOn` is set explicitly:
// `seasonStartYearFrom` (mirrored from
// `apps/web/src/lib/registration-rules.ts:351-355`) falls back to THIS YEAR
// when it is absent, which would make an age-band assertion wall-clock
// dependent — every fixture below pins it instead.

interface RegPerson {
  readonly ref: string;
  readonly fullName: string;
  readonly lane: string;
  readonly dob?: string;
  readonly gender?: "m" | "f" | "x";
}

function registrationPack(opts: {
  readonly division?: Record<string, unknown>;
  readonly persons?: readonly RegPerson[];
  readonly org?: Record<string, unknown>;
  readonly block: Record<string, unknown>;
}): Record<string, unknown> {
  const base = genericPack() as Record<string, unknown>;
  const divisions = base.divisions as Record<string, unknown>[];
  return {
    ...base,
    org: opts.org ?? base.org,
    competition: {
      ...(base.competition as Record<string, unknown>),
      startsOn: "2024-01-01",
    },
    divisions: [{ ...divisions[0], entry: "admin", ...(opts.division ?? {}) }],
    persons: [...(base.persons as unknown[]), ...(opts.persons ?? [])],
    registration: { byDivision: { d1: opts.block } },
  };
}

/** A registration BLOCK fragment (`category`/`ageMin`/`ageMax` are
 *  `PackRegistrationBlock` fields, not `PackDivision` ones — spread into a
 *  test's `block:`, never into `registrationPack`'s `division:`) with no
 *  restriction at all — an entry tagged `rejected_eligibility` must never
 *  appear against it (nothing can violate an unrestricted division), so
 *  rules other than #1, which are not testing eligibility, use this. */
const OPEN_RESTRICTION = { category: "open" } as const;

function baseExpect(
  overrides: Partial<
    Record<"entrants" | "waitlisted" | "rejected" | "paidCents", number>
  > = {},
) {
  return {
    entrants: 0,
    waitlisted: 0,
    rejected: 0,
    paidCents: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule 1 — a `rejected_eligibility` entry must ACTUALLY violate (design §4
// check 1: "else the pack lies").
//
// One division (`category:"womens"`, `ageMax:18`) drives all three cases so
// a mutant that drops either half of the check (category or age band) is
// witnessed by the OTHER case, not just by its own: a captain who violates
// only on gender (age legal) and one who violates only on age (gender
// legal) are both declared `rejected_eligibility` and must NOT red; a third,
// who violates NEITHER, must.
// ---------------------------------------------------------------------------

describe("registration funnel — rule 1: rejected_eligibility must actually violate", () => {
  // The restriction lives on the BLOCK (`category`/`ageMax` are
  // PackRegistrationBlock fields, not PackDivision ones) — each test below
  // sets it inline. `LEGAL_DOB`/`ILLEGAL_DOB` are ages relative to the
  // 2024-01-01 cutoff (`competition.startsOn`, `registrationPack` above).
  const LEGAL_DOB = "2010-06-15"; // age 13 at 2024-01-01 cutoff — within ageMax 18
  const ILLEGAL_DOB = "2000-06-15"; // age 23 at 2024-01-01 cutoff — over ageMax 18

  it("an offender that violates on GENDER only (age legal) does not red", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-gender-only",
          fullName: "Gender Only",
          lane: "player",
          dob: LEGAL_DOB,
          gender: "m",
        },
      ],
      block: {
        category: "womens",
        ageMax: 18,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-gender",
            captain: "p-gender-only",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        expect: baseExpect({ rejected: 1 }),
      },
    });
    const result = validatePack(pack, UNIT);
    expect(
      errors(result.findings).filter(
        (f) => f.code === "registration.rejected_not_violating",
      ),
    ).toEqual([]);
  });

  it("an offender that violates on AGE only (gender legal) does not red", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-age-only",
          fullName: "Age Only",
          lane: "player",
          dob: ILLEGAL_DOB,
          gender: "f",
        },
      ],
      block: {
        category: "womens",
        ageMax: 18,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-age",
            captain: "p-age-only",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        expect: baseExpect({ rejected: 1 }),
      },
    });
    const result = validatePack(pack, UNIT);
    expect(
      errors(result.findings).filter(
        (f) => f.code === "registration.rejected_not_violating",
      ),
    ).toEqual([]);
  });

  it("THE PACK LIES: an offender who violates NEITHER reds, naming the entry's extKey", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-eligible",
          fullName: "Actually Eligible",
          lane: "player",
          dob: LEGAL_DOB,
          gender: "f",
        },
      ],
      block: {
        category: "womens",
        ageMax: 18,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-lies",
            captain: "p-eligible",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        expect: baseExpect({ rejected: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.rejected_not_violating");
    expect(finding.message).toContain("e-lies");
  });
});

// ---------------------------------------------------------------------------
// Gap 1 (B03r-repins-2026-09-03.md, owner ruling 2026-09-04): a
// non-1-January eligibility cutoff. Same person, same ageMax:17 band, both
// blocks declare the SAME entry `rejected_eligibility` — only the cutoff
// differs. Person born 2006-08-01 is age 17 at a 1 January 2024 cutoff
// (not yet had their 2024 birthday relative to Jan 1) and age 18 at a
// 1 September 2024 cutoff (birthday already passed) — so the same person
// is ELIGIBLE under the default cutoff and INELIGIBLE under an explicit
// September one.
// ---------------------------------------------------------------------------

describe("registration funnel — rule 1 + Gap 1: a non-1-January cutoff changes the verdict", () => {
  const CUTOFF_DOB = "2006-08-01"; // age 17 @ 1 Jan 2024, age 18 @ 1 Sep 2024

  it("under the DEFAULT (absent) cutoff the person is eligible — declaring them rejected is the pack lying", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-cutoff",
          fullName: "Cutoff Case",
          lane: "player",
          dob: CUTOFF_DOB,
          gender: "f",
        },
      ],
      block: {
        category: "open",
        ageMax: 17,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-default-cutoff",
            captain: "p-cutoff",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        expect: baseExpect({ rejected: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.rejected_not_violating");
    expect(finding.message).toContain("e-default-cutoff");
  });

  it("under an EXPLICIT 1 September cutoff the SAME person is ineligible — the same rejection is now honest", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-cutoff",
          fullName: "Cutoff Case",
          lane: "player",
          dob: CUTOFF_DOB,
          gender: "f",
        },
      ],
      block: {
        category: "open",
        ageMax: 17,
        ageCutoffMonth: 9,
        ageCutoffDay: 1,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-sept-cutoff",
            captain: "p-cutoff",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        expect: baseExpect({ rejected: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("cutoff defaulting: an absent cutoff produces the IDENTICAL verdict as an explicit 1 January cutoff", () => {
    const buildPack = (block: Record<string, unknown>) =>
      registrationPack({
        persons: [
          {
            ref: "p-cutoff",
            fullName: "Cutoff Case",
            lane: "player",
            dob: CUTOFF_DOB,
            gender: "f",
          },
        ],
        block: {
          category: "open",
          ageMax: 17,
          entrantKind: "individual",
          feeCents: 0,
          approval: "auto",
          entries: [
            {
              extKey: "e-jan-default",
              captain: "p-cutoff",
              roster: [],
              pay: false,
              expect: "rejected_eligibility",
            },
          ],
          expect: baseExpect({ rejected: 1 }),
          ...block,
        },
      });
    const withDefault = errors(validatePack(buildPack({}), UNIT).findings).map(
      (f) => f.code,
    );
    const withExplicitJan1 = errors(
      validatePack(buildPack({ ageCutoffMonth: 1, ageCutoffDay: 1 }), UNIT)
        .findings,
    ).map((f) => f.code);
    expect(withDefault).toEqual(["registration.rejected_not_violating"]);
    expect(withDefault).toEqual(withExplicitJan1);
  });

  // The schema only range-checks 1-12/1-31 (matching the DB CHECK
  // constraint's own laxness — pack-schema.ts's doc comment on
  // `ageCutoffMonth`), so `(2, 30)` — Feb 30 does not exist — parses. The
  // product's `ageBandEligibilityIssues` treats an impossible legacy
  // combination as "no age rule to evaluate" rather than rolling into the
  // next month (registration-rules.ts's own comment, "never throw ...
  // strictly safer than either alternative") — this proves the mirror does
  // the same, not a silent rollover. dob 2005-01-01 is chosen so the two
  // interpretations disagree: skipped entirely, nothing ever violates
  // (rule 1 must red the "rejected" declaration); rolled into March, the
  // person is 19 and DOES violate ageMax:17 (rule 1 must NOT red).
  it("an impossible cutoff (Feb 30) is never enforced — not silently rolled into March", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-badcutoff",
          fullName: "Bad Cutoff",
          lane: "player",
          dob: "2005-01-01",
          gender: "f",
        },
      ],
      block: {
        category: "open",
        ageMax: 17,
        ageCutoffMonth: 2,
        ageCutoffDay: 30,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-bad-cutoff",
            captain: "p-badcutoff",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        expect: baseExpect({ rejected: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.rejected_not_violating");
    expect(finding.message).toContain("e-bad-cutoff");
  });
});

// ---------------------------------------------------------------------------
// Gap 2 (B03r-repins-2026-09-03.md, owner ruling 2026-09-04): gender "x".
// The product's `categoryEligibilityIssues` never blocks a person whose
// gender is "x" against a mens/womens gate (owner ruling, RS002) — a MISSING
// gender still blocks. The differential between "x" (never violates) and
// missing (always violates) is the pair that witnesses a mutant collapsing
// the two back together.
// ---------------------------------------------------------------------------

describe("registration funnel — rule 1 + Gap 2: gender 'x' never violates a category gate", () => {
  it("an 'x' person declared rejected_eligibility against a womens division is a pack lie", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-x",
          fullName: "Nonbinary Person",
          lane: "player",
          gender: "x",
        },
      ],
      block: {
        category: "womens",
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-x-lies",
            captain: "p-x",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        expect: baseExpect({ rejected: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.rejected_not_violating");
    expect(finding.message).toContain("e-x-lies");
  });

  it("the SAME division with a person who has NO gender at all correctly reds as a genuine violation", () => {
    const pack = registrationPack({
      persons: [
        { ref: "p-none", fullName: "No Gender Recorded", lane: "player" },
      ],
      block: {
        category: "womens",
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-missing-ok",
            captain: "p-none",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        expect: baseExpect({ rejected: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

describe("registration funnel — rule 5 + Gap 2: an entering person with gender 'x' satisfies the presence check", () => {
  it("entry:registration-api, category:mixed, gender:'x' does not red missing_gender", () => {
    const pack = registrationPack({
      division: { entry: "registration-api" },
      persons: [
        {
          ref: "p-x-entrant",
          fullName: "X Entrant",
          lane: "player",
          gender: "x",
        },
      ],
      block: {
        category: "mixed",
        entrantKind: "team",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-x-entrant",
            captain: "p-x-entrant",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — `expect.entrants == entries − rejected − waitlisted`, counted
// from the entries' own `expect` tags (design §4 check 2).
// ---------------------------------------------------------------------------

describe("registration funnel — rule 2: expect arithmetic", () => {
  it("entries(4) − rejected(1) − waitlisted(1) = 2, and a wrong declared entrants reds naming the tally", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        // capacity:2 makes the (2 entrant + 1 waitlisted) admitted set
        // consistent with rule 3 too, so this test stays isolated to rule 2.
        capacity: 2,
        entries: [
          {
            extKey: "e-1",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-2",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-3",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "rejected_manual",
          },
          {
            extKey: "e-4",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "waitlisted",
          },
        ],
        // Wrong on purpose: should be 4 − 1 − 1 = 2.
        expect: baseExpect({ entrants: 3, waitlisted: 1, rejected: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.expect_arithmetic");
    expect(finding.message).toContain("e-3"); // the rejected offender
    expect(finding.message).toContain("e-4"); // the waitlisted offender
  });

  it("the correct tally does not red", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        capacity: 2,
        entries: [
          {
            extKey: "e-1",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-2",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-3",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "rejected_manual",
          },
          {
            extKey: "e-4",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "waitlisted",
          },
        ],
        expect: baseExpect({ entrants: 2, waitlisted: 1, rejected: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — capacity vs admitted (`entrant` + `waitlisted` tagged) entries
// produces EXACTLY the declared `expect.waitlisted` (design §4 check 3).
// ---------------------------------------------------------------------------

describe("registration funnel — rule 3: capacity vs waitlist", () => {
  it("capacity(2) against 3 admitted entries wants waitlisted:1 — a wrong 0 reds", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        capacity: 2,
        entries: [
          {
            extKey: "e-1",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-2",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-3",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        // Wrong on purpose: 3 admitted against capacity 2 wants waitlisted:1.
        expect: baseExpect({ entrants: 3, waitlisted: 0 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.waitlist_mismatch");
  });

  it("an UNSET capacity wants waitlisted:0 — a declared 1 reds", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-1",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-2",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "waitlisted",
          },
        ],
        // Wrong on purpose: no capacity means nothing forces a waitlist.
        expect: baseExpect({ entrants: 1, waitlisted: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.waitlist_mismatch");
  });

  it("an UNSET capacity with 2 admitted entries correctly declaring waitlisted:0 does not red", () => {
    // Distinguishes "capacity unset ⇒ 0" from a mutant that instead falls
    // back to `admitted.length` for an unset capacity: that mutant produces
    // the SAME red as the test above (2 admitted vs declared 1 still
    // mismatches), but only THIS case — a correct waitlisted:0 against 2
    // admitted — tells the two formulas apart.
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-1",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-2",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 2, waitlisted: 0 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("capacity(2) against 3 admitted (2 entrant + 1 waitlisted) matches — does not red", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        capacity: 2,
        entries: [
          {
            extKey: "e-1",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-2",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "entrant",
          },
          {
            extKey: "e-3",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "waitlisted",
          },
        ],
        expect: baseExpect({ entrants: 2, waitlisted: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — `pay: true` requires the division's `feeCents > 0` (design §4
// check 4).
// ---------------------------------------------------------------------------

describe("registration funnel — rule 4: pay requires a fee", () => {
  it("pay:true against feeCents:0 reds, naming the entry's extKey", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        // A `pay: true` entry needs a division Stripe can actually charge for
        // (stage-0 rule 7): "offline" makes hosted Checkout unmintable.
        paymentMethod: "stripe" as const,
        entries: [
          {
            extKey: "e-free-pay",
            captain: "p1",
            roster: [],
            pay: true,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.pay_requires_fee");
    expect(finding.message).toContain("e-free-pay");
  });

  it("pay:true against feeCents:1000 does not red", () => {
    const pack = registrationPack({
      org: {
        name: "Unit Org",
        slug: "unit-org",
        timezone: "UTC",
        currency: "usd",
      },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 1000,
        approval: "auto",
        // A `pay: true` entry needs a division Stripe can actually charge for
        // (stage-0 rule 7): "offline" makes hosted Checkout unmintable.
        paymentMethod: "stripe" as const,
        entries: [
          {
            extKey: "e-paid",
            captain: "p1",
            roster: [],
            pay: true,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1, paidCents: 1000 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it('RULE 7: pay:true against an "offline" division reds, naming the entry and the reason', () => {
    // The configuration the bench could ONLY express before this rule
    // existed: a real fee, a real payer, and a division whose
    // payment_method the product defaults to "offline" — which
    // `resumeRegistrationCheckout` refuses to mint a session for.
    const pack = registrationPack({
      org: {
        name: "Unit Org",
        slug: "unit-org",
        timezone: "UTC",
        currency: "usd",
      },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 1000,
        paymentMethod: "offline" as const,
        approval: "auto",
        entries: [
          {
            extKey: "e-offline-payer",
            captain: "p1",
            roster: [],
            pay: true,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1, paidCents: 1000 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.pay_requires_stripe");
    expect(finding.message).toContain("e-offline-payer");
    // The message has to say WHICH method it saw, or a reader cannot tell
    // this rule from rule 4's "nothing to pay".
    expect(finding.message).toContain('paymentMethod:"offline"');
  });

  it('RULE 7: pay:false against an "offline" division does NOT red — the rule tracks the payer, not the method', () => {
    // The positive pair. An offline division is a real, shipped product
    // configuration (`payment_instructions` exists for it); without this
    // case, a rule that simply refused every "offline" division with a fee
    // would satisfy the assertion above while banning a legitimate pack.
    const pack = registrationPack({
      org: {
        name: "Unit Org",
        slug: "unit-org",
        timezone: "UTC",
        currency: "usd",
      },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 1000,
        paymentMethod: "offline" as const,
        approval: "auto",
        entries: [
          {
            extKey: "e-offline-nonpayer",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it('RULE 7 vs RULE 4: a free division with pay:true and paymentMethod "stripe" reds on the FEE, not the method', () => {
    // The two rules are adjacent and must not cover for each other — mutate
    // one and exactly one test moves. A zero fee is rule 4's business even
    // when the method is perfectly chargeable.
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        paymentMethod: "stripe" as const,
        approval: "auto",
        entries: [
          {
            extKey: "e-free-stripe",
            captain: "p1",
            roster: [],
            pay: true,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.pay_requires_fee");
  });

  it("RULE 8: a stripe division's entrant-expecting entry with pay:false reds — the product charges it anyway", () => {
    // Found live: a stripe division collects at SUBMIT, so `pay: false` does
    // not stop the charge. The first paid run declared it and reported
    // paidCents 200 against a declared 100.
    const pack = registrationPack({
      org: {
        name: "Unit Org",
        slug: "unit-org",
        timezone: "UTC",
        currency: "usd",
      },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 1000,
        paymentMethod: "stripe" as const,
        approval: "auto",
        entries: [
          {
            extKey: "e-freeloader",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.stripe_entrant_must_pay");
    expect(finding.message).toContain("e-freeloader");
  });

  it("RULE 8: a WAITLISTED entry on a stripe division may declare pay:false — it never clears capacity to be charged", () => {
    // The positive pair, and the reason the rule is scoped to `expect:
    // "entrant"` rather than applied to every entry. A blanket rule would ban
    // a legitimate waitlist pack outright.
    const pack = registrationPack({
      org: {
        name: "Unit Org",
        slug: "unit-org",
        timezone: "UTC",
        currency: "usd",
      },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 1000,
        paymentMethod: "stripe" as const,
        approval: "auto",
        capacity: 1,
        entries: [
          {
            extKey: "e-in",
            captain: "p1",
            roster: [],
            pay: true,
            expect: "entrant",
          },
          {
            extKey: "e-waits",
            captain: "p2",
            roster: [],
            pay: false,
            expect: "waitlisted",
          },
        ],
        expect: baseExpect({ entrants: 1, waitlisted: 1, paidCents: 1000 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("RULE 8 does not fire on an OFFLINE division — an offline entrant pays the organiser directly", () => {
    // The other half of the scoping. Offline is a real shipped configuration
    // and its entrants genuinely do not pay through the product.
    const pack = registrationPack({
      org: {
        name: "Unit Org",
        slug: "unit-org",
        timezone: "UTC",
        currency: "usd",
      },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 1000,
        paymentMethod: "offline" as const,
        approval: "auto",
        entries: [
          {
            extKey: "e-offline",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("pay:false against feeCents:0 does not red — a free entry never has to pay", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-free",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — `divisions[].entry: "registration-api"|"registration-ui"` with an
// age band OR a non-`open` category requires `dob`/`gender` on EVERY
// entering person (design §4 check 5). `p1`/`p2` (`genericPack`'s base
// persons) carry neither field, which is exactly what these tests need for
// the RED cases — no extra fixture person required.
// ---------------------------------------------------------------------------

describe("registration funnel — rule 5: registration-api/ui needs dob/gender", () => {
  it("an age band with entry:registration-api and a captain with no dob reds", () => {
    const pack = registrationPack({
      division: { entry: "registration-api" },
      block: {
        category: "open",
        ageMax: 18,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-nodob",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.missing_dob");
    expect(finding.message).toContain("e-nodob");
  });

  it("a non-open category with entry:registration-api and a captain with no gender reds", () => {
    const pack = registrationPack({
      division: { entry: "registration-api" },
      // Rule 5's WIDENED half (self-registration alone requires dob, tested
      // separately below) also fires for an individual entry with no dob —
      // this captain carries a dob specifically so the ONLY thing red here
      // is the gender rule this test exists to prove.
      persons: [
        {
          ref: "p-nogender",
          fullName: "No Gender",
          lane: "player",
          dob: "2000-01-01",
        },
      ],
      block: {
        category: "womens",
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-nogender",
            captain: "p-nogender",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.missing_gender");
    expect(finding.message).toContain("e-nogender");
  });

  it("a ROSTER member with no gender reds too — not just the captain", () => {
    const pack = registrationPack({
      division: { entry: "registration-api" },
      persons: [
        {
          ref: "p-captain-ok",
          fullName: "Captain OK",
          lane: "player",
          gender: "m",
        },
      ],
      block: {
        category: "mixed",
        entrantKind: "team",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-roster-gap",
            captain: "p-captain-ok",
            roster: ["p1"],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.missing_gender");
    expect(finding.message).toContain("e-roster-gap");
  });

  it("the SAME restriction with entry:admin (the default) does not red", () => {
    const pack = registrationPack({
      block: {
        category: "womens",
        ageMax: 18,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-admin-seeded",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("entry:registration-ui with dob/gender present on every entering person does not red", () => {
    const pack = registrationPack({
      division: { entry: "registration-ui" },
      persons: [
        {
          ref: "p-complete",
          fullName: "Complete Person",
          lane: "player",
          dob: "2010-06-15",
          gender: "f",
        },
      ],
      block: {
        category: "womens",
        ageMax: 18,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-complete",
            captain: "p-complete",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 5, widened — the B03r live-crash fix
// (B03r-repins-2026-09-03.md dispatch, "fix a live-only crash in the
// registration runner"). `register.ts`'s `buildRegistrationEntry` sets
// `registeringSelf: true` UNCONDITIONALLY for every entry of an
// "individual" division (the captain IS the entrant) — and
// `PublicRegisterGroupRequest`'s superRefine (apps/web/src/server/api-v1/
// schemas.ts) 400s ANY self-registering entry lacking `contact.dob`,
// independent of whether the division declares an age band. Before this
// fix, an `open`, no-age-band, individual-kind division was a LEGAL pack
// that crashed live — the original rule 5 only fired for an age band or a
// non-open category, neither of which "open + individual" ever declares.
// ---------------------------------------------------------------------------

describe("registration funnel — rule 5 widened: self-registration alone requires dob", () => {
  it("an OPEN, no-age-band, INDIVIDUAL division with entry:registration-api and a captain with no dob reds — self-registration alone requires dob", () => {
    const pack = registrationPack({
      division: { entry: "registration-api" },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-selfreg-nodob",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.missing_dob");
    expect(finding.message).toContain("e-selfreg-nodob");
  });

  it("the SAME open/no-age-band/individual/registration-api pack does not red once the captain has a dob", () => {
    const pack = registrationPack({
      division: { entry: "registration-api" },
      persons: [
        {
          ref: "p-hasdob",
          fullName: "Has Dob",
          lane: "player",
          dob: "2000-01-01",
        },
      ],
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-selfreg-dob",
            captain: "p-hasdob",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("a TEAM (not individual) division under the same open/no-age-band/registration-api conditions does NOT red — only an individual entry self-registers (register.ts never sets registeringSelf for team/pair)", () => {
    const pack = registrationPack({
      division: { entry: "registration-api" },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "team",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-team-nodob",
            captain: "p1",
            roster: ["p2"],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("a PAIR division under the same conditions does NOT red either", () => {
    const pack = registrationPack({
      division: { entry: "registration-api" },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "pair",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-pair-nodob",
            captain: "p1",
            roster: ["p2"],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("entry:admin (the default) still never requires dob, even for an individual division — admin-seeded, nothing collects it through a public form", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-admin-nodob",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Job 1's currency move (pack-schema.ts) owes this stage-0 consequence:
// `org.currency` is required wherever a division prices a fee — the B03r
// dispatch's own Job 1 text, "required whenever any division declares
// feeCents > 0, which is a stage-0 rule (Job 2), not a shape rule."
// ---------------------------------------------------------------------------

describe("registration funnel — org.currency required when a division prices a fee", () => {
  it("feeCents:1000 with no org.currency reds", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 1000,
        approval: "auto",
        // A `pay: true` entry needs a division Stripe can actually charge for
        // (stage-0 rule 7): "offline" makes hosted Checkout unmintable.
        paymentMethod: "stripe" as const,
        entries: [
          {
            extKey: "e-paid",
            captain: "p1",
            roster: [],
            pay: true,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1, paidCents: 1000 }),
      },
    });
    expect(
      (pack as { org: Record<string, unknown> }).org.currency,
    ).toBeUndefined();
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.currency_required");
  });

  it("feeCents:1000 WITH org.currency does not red", () => {
    const pack = registrationPack({
      org: {
        name: "Unit Org",
        slug: "unit-org",
        timezone: "UTC",
        currency: "usd",
      },
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 1000,
        approval: "auto",
        // A `pay: true` entry needs a division Stripe can actually charge for
        // (stage-0 rule 7): "offline" makes hosted Checkout unmintable.
        paymentMethod: "stripe" as const,
        entries: [
          {
            extKey: "e-paid",
            captain: "p1",
            roster: [],
            pay: true,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1, paidCents: 1000 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("feeCents:0 with no org.currency does not red — nothing is priced", () => {
    const pack = registrationPack({
      block: {
        ...OPEN_RESTRICTION,
        entrantKind: "individual",
        feeCents: 0,
        approval: "auto",
        entries: [
          {
            extKey: "e-free",
            captain: "p1",
            roster: [],
            pay: false,
            expect: "entrant",
          },
        ],
        expect: baseExpect({ entrants: 1 }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The GREEN fixture — all five design §4 rules, plus the currency
// consequence, satisfied AT ONCE by one division. Mirrors the shape of
// design §5's own table rows (a paid entrant, a capacity waitlist, and an
// eligibility offender coexisting in one division).
// ---------------------------------------------------------------------------

describe("registration funnel — the green fixture: all five rules satisfied at once", () => {
  it("passes clean end to end", () => {
    const LEGAL_DOB = "2010-06-15"; // age 13 at the 2024-01-01 cutoff — within ageMax 18
    const pack = registrationPack({
      division: { entry: "registration-api" },
      org: {
        name: "Unit Org",
        slug: "unit-org",
        timezone: "UTC",
        currency: "usd",
      },
      persons: [
        {
          ref: "p-paid",
          fullName: "Paid Entrant",
          lane: "player",
          dob: LEGAL_DOB,
          gender: "f",
        },
        {
          ref: "p-waits",
          fullName: "Waitlisted Entrant",
          lane: "player",
          dob: LEGAL_DOB,
          gender: "f",
        },
        // Violates on GENDER (age is legal) — rule 1's offender.
        {
          ref: "p-rejected",
          fullName: "Rejected Offender",
          lane: "player",
          dob: LEGAL_DOB,
          gender: "m",
        },
      ],
      block: {
        category: "womens",
        ageMax: 18,
        entrantKind: "individual",
        feeCents: 1500,
        approval: "manual",
        // A `pay: true` entry needs a division Stripe can actually charge for
        // (stage-0 rule 7): "offline" makes hosted Checkout unmintable.
        paymentMethod: "stripe" as const,
        capacity: 1, // 2 admitted (paid + waitlisted) against capacity 1 -> 1 waitlisted
        entries: [
          {
            extKey: "e-paid",
            captain: "p-paid",
            roster: [],
            pay: true,
            expect: "entrant",
          },
          {
            extKey: "e-waits",
            captain: "p-waits",
            roster: [],
            pay: false,
            expect: "waitlisted",
          },
          {
            extKey: "e-rejected",
            captain: "p-rejected",
            roster: [],
            pay: false,
            expect: "rejected_eligibility",
          },
        ],
        // entries(3) − rejected(1) − waitlisted(1) = 1 entrant (rule 2).
        expect: baseExpect({
          entrants: 1,
          waitlisted: 1,
          rejected: 1,
          paidCents: 1500,
        }),
      },
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — `joins[].consent` must agree with whether the joining PERSON is
// actually a minor, in BOTH directions (found by opening `StepConsent`'s
// `showGuardian` condition rather than trusting the `reg-consent-grant`
// testid it is attached to — B03r-repins-2026-09-03.md "A sixth stage-0
// rule").
//
// Derived from `isMinor`/`ageAt` (apps/web/src/lib/registration-rules.ts:
// 56-68), NOT from `guardianRequired` (components/public-site/register/
// validation.ts) directly: that function takes a `CartState`/`ContactState`
// pair a pack join has neither shape of, but it is a thin wrapper —
// `guardianRequired` -> `effectiveSelfDob` -> `isMinor(dob, now)` — so
// mirroring `isMinor` itself reaches the exact verdict a pack CAN supply the
// inputs for.
//
// Uses WALL-CLOCK "now" (computed once per `validatePack` call), NOT the
// `seasonStartYear`/2024-01-01 cutoff rule 1/5's age-band checks use above —
// a deliberately DIFFERENT date basis, because the product's own
// `showGuardian = guardianRequired(cart, contact, new Date())`
// (step-consent.tsx:54) evaluates minority at the moment someone actually
// registers, not against a season-start cutoff. So every dob below is
// computed RELATIVE TO TODAY (`isoDateYearsAgo`), never a fixed literal —
// a fixed "over 18" dob would silently go stale and eventually assert the
// wrong thing as wall-clock time passes.
// ---------------------------------------------------------------------------

/** Today minus `years` years, plus `dayOffset` days — e.g. `isoDateYearsAgo(18, -1)`
 *  is a birthday that fell YESTERDAY (18 today, adult); `isoDateYearsAgo(18, 1)`
 *  is a birthday that falls TOMORROW (still 17, minor). Relative to the real
 *  clock on purpose (see block comment above). */
function isoDateYearsAgo(years: number, dayOffset = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

const ADULT_DOB = isoDateYearsAgo(30);
const MINOR_DOB = isoDateYearsAgo(10);
// Boundary pair: a right-answer-differs-from-the-wrong-answer's-constant
// case (AGENTS.md #19) — a flipped `<`/`<=` or a dropped `beforeBirthday`
// adjustment swaps these two relative to each other, where two ordinary
// "clearly adult"/"clearly minor" dobs would not catch it.
const JUST_TURNED_18_DOB = isoDateYearsAgo(18, -1); // birthday was yesterday -> 18, adult
const TURNS_18_TOMORROW_DOB = isoDateYearsAgo(18, 1); // birthday is tomorrow -> still 17, minor

function joinBlock(overrides: {
  readonly consent: "granted" | "guardian";
  readonly personRef: string;
}): Record<string, unknown> {
  return {
    ...OPEN_RESTRICTION,
    entrantKind: "team",
    feeCents: 0,
    approval: "auto",
    entries: [
      {
        extKey: "e-team",
        captain: "p1",
        roster: [],
        pay: false,
        expect: "entrant",
      },
    ],
    joins: [
      {
        entry: "e-team",
        person: overrides.personRef,
        consent: overrides.consent,
      },
    ],
    expect: baseExpect({ entrants: 1 }),
  };
}

describe("registration funnel — rule 6: join consent must match minority", () => {
  it('consent:"guardian" declared for an ADULT reds, naming the person and the entry', () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-adult",
          fullName: "Adult Joiner",
          lane: "player",
          dob: ADULT_DOB,
        },
      ],
      block: joinBlock({ consent: "guardian", personRef: "p-adult" }),
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.join_consent_mismatch");
    expect(finding.message).toContain("p-adult");
    expect(finding.message).toContain("e-team");
  });

  it('consent:"guardian" declared for a MINOR does not red', () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-minor",
          fullName: "Minor Joiner",
          lane: "player",
          dob: MINOR_DOB,
        },
      ],
      block: joinBlock({ consent: "guardian", personRef: "p-minor" }),
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it('CONVERSE: consent:"granted" declared for a MINOR reds — the server unconditionally requires a guardian', () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-minor2",
          fullName: "Minor Joiner 2",
          lane: "player",
          dob: MINOR_DOB,
        },
      ],
      block: joinBlock({ consent: "granted", personRef: "p-minor2" }),
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.join_consent_mismatch");
    expect(finding.message).toContain("p-minor2");
    expect(finding.message).toContain("e-team");
  });

  it('consent:"granted" declared for an ADULT does not red', () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-adult2",
          fullName: "Adult Joiner 2",
          lane: "player",
          dob: ADULT_DOB,
        },
      ],
      block: joinBlock({ consent: "granted", personRef: "p-adult2" }),
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("BOUNDARY: a birthday yesterday (18, adult) declaring guardian reds", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-just18",
          fullName: "Just Turned 18",
          lane: "player",
          dob: JUST_TURNED_18_DOB,
        },
      ],
      block: joinBlock({ consent: "guardian", personRef: "p-just18" }),
    });
    const finding = onlyError(validatePack(pack, UNIT).findings);
    expect(finding.code).toBe("registration.join_consent_mismatch");
  });

  it("BOUNDARY: a birthday tomorrow (still 17, minor) declaring guardian does not red", () => {
    const pack = registrationPack({
      persons: [
        {
          ref: "p-almost18",
          fullName: "Turns 18 Tomorrow",
          lane: "player",
          dob: TURNS_18_TOMORROW_DOB,
        },
      ],
      block: joinBlock({ consent: "guardian", personRef: "p-almost18" }),
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });

  it("a join for a person with NO dob on record is treated as adult (mirrors the server's !!dob short-circuit)", () => {
    const pack = registrationPack({
      persons: [{ ref: "p-nodob", fullName: "No Dob", lane: "player" }],
      block: joinBlock({ consent: "granted", personRef: "p-nodob" }),
    });
    expect(errors(validatePack(pack, UNIT).findings)).toEqual([]);
  });
});

// ===========================================================================
// Stage 1.6 — a scheduled division must pin its own zone (finding R06)
// ===========================================================================
//
// EVERY case below constructs the pack shape it needs and asserts that shape
// before asserting the rule's answer. That is not ceremony: the first version
// of this block leaned on what the committed `_tiny.json` happened to contain
// ("it declares no venues at all"), and `_tiny` is owned by another task,
// which gave it `v-tiny` and two courts the same week. A test whose premise
// lives in someone else's file breaks on their schedule rather than its own —
// and, worse, can go quietly VACUOUS instead of red when their change happens
// to satisfy it by accident.
//
// So the division REFS are derived from the pack rather than typed in, and
// every premise a case depends on is an assertion in that case.

/** Refs of the divisions the scheduling layer will schedule — every division
 *  that is not a registration-funnel one, in pack order.
 *
 *  Derived so a change to `_tiny`'s division list moves these cases with it
 *  instead of leaving them asserting yesterday's refs. This is FIXTURE
 *  SELECTION, never the assertion: no case below concludes "the rule was
 *  right" from this function — each states independently which refs it
 *  expects to be refused and which it expects to be spared. */
function scheduledRefs(pack: Record<string, unknown>): string[] {
  const registration = pack.registration as
    | { byDivision?: Record<string, unknown> }
    | undefined;
  const funnel = registration?.byDivision ?? {};
  return (pack.divisions as Record<string, unknown>[])
    .map((d) => d.ref as string)
    .filter((ref) => funnel[ref] === undefined);
}

/** Refs of the registration-funnel divisions, in pack order. */
function funnelRefs(pack: Record<string, unknown>): string[] {
  const registration = pack.registration as
    | { byDivision?: Record<string, unknown> }
    | undefined;
  const funnel = registration?.byDivision ?? {};
  return (pack.divisions as Record<string, unknown>[])
    .map((d) => d.ref as string)
    .filter((ref) => funnel[ref] !== undefined);
}

/** Every division that would offend the rule as the pack currently stands: a
 *  scheduled division carrying no `scheduleConfig`. Used by the cases that
 *  need to prove a pack IS one the rule would refuse but for the gate under
 *  test — without which those cases pass for the wrong reason. */
function offendingRefs(pack: Record<string, unknown>): string[] {
  const divisions = pack.divisions as Record<string, unknown>[];
  return scheduledRefs(pack).filter(
    (ref) =>
      divisions.find((d) => d.ref === ref)?.scheduleConfig === undefined,
  );
}

/** A pack the rule must ACCEPT: one venue with two courts, and a
 *  `scheduleConfig` on every scheduled division. Its own venue rather than
 *  whatever `_tiny` ships, so the courts this pack declares are the courts
 *  its configs reference and neither can drift under the other.
 *
 *  Every case below perturbs exactly one thing about this. */
function scheduledPack(): Record<string, unknown> {
  const pack = tiny() as unknown as Record<string, unknown>;
  pack.venues = [
    {
      ref: "v-test",
      name: "Test Hall",
      courts: [
        { ref: "c-test-1", name: "Court 1" },
        { ref: "c-test-2", name: "Court 2" },
      ],
    },
  ];
  const config = {
    courts: ["@c-test-1", "@c-test-2"],
    matchMinutes: 30,
    gapMinutes: 0,
  };
  const scheduled = new Set(scheduledRefs(pack));
  for (const d of pack.divisions as Record<string, unknown>[]) {
    // A registration-funnel division is seeded through the funnel rather than
    // the schedule path and gets NONE — exactly as the real pack leaves it.
    if (scheduled.has(d.ref as string)) d.scheduleConfig = { ...config };
    else delete d.scheduleConfig;
  }
  return pack;
}

const schedulingErrors = (result: PackValidation): readonly PackFinding[] =>
  errors(result.findings).filter(
    (f) => f.code === "pack.division_missing_schedule_config",
  );

describe("validatePack — stage 1.6, a scheduled division must declare a scheduleConfig", () => {
  // The premises the whole block rests on, asserted ONCE and loudly. If
  // `_tiny` ever stops providing two scheduled divisions and one funnel
  // division, several cases below would still pass while proving nothing —
  // "refuses EVERY offending division" cannot tell "every" from "the first"
  // with only one to refuse, and the exemption case has nothing to exempt.
  it("rests on a fixture with at least two scheduled divisions and one funnel division", () => {
    const pack = scheduledPack();
    expect(scheduledRefs(pack).length).toBeGreaterThanOrEqual(2);
    expect(funnelRefs(pack).length).toBeGreaterThanOrEqual(1);
    // …and the two sets are disjoint and cover every division, so no case
    // below is reasoning about a division that is in neither.
    expect([...scheduledRefs(pack), ...funnelRefs(pack)].sort()).toEqual(
      (pack.divisions as Record<string, unknown>[])
        .map((d) => d.ref as string)
        .sort(),
    );
  });

  // The positive pair, FIRST. Without it every case below is satisfied by a
  // rule that refuses everything, and the whole block would prove nothing.
  it("accepts a pack whose every scheduled division declares one", () => {
    const pack = scheduledPack();
    // The premise: this pack really does declare courts, so the rule is armed
    // and its silence below is a decision rather than the gate being shut.
    expect((pack.venues as { courts: unknown[] }[])[0].courts.length).toBeGreaterThan(0);
    expect(offendingRefs(pack)).toEqual([]);
    expectClean(validatePack(pack, TINY), TINY_NOT_DERIVED);
  });

  it("REFUSES a scheduled division that declares none, naming the division ref", () => {
    const pack = scheduledPack();
    // ONE perturbation: the LAST scheduled division loses the config its
    // sibling keeps, so the finding cannot be satisfied by a rule that fires
    // per-pack rather than per-division.
    const refs = scheduledRefs(pack);
    const offender = refs[refs.length - 1];
    const keeper = refs[0];
    // The negative assertion below is only sound while the two refs cannot
    // match each other as substrings.
    expect(offender).not.toBe(keeper);
    const divisions = pack.divisions as Record<string, unknown>[];
    delete divisions.find((d) => d.ref === offender)?.scheduleConfig;

    const result = validatePack(pack, TINY);
    const finding = onlyError(result.findings);
    expect(finding.code).toBe("pack.division_missing_schedule_config");
    // Names WHICH division, so a pack author is not left diffing three of
    // them — the whole ask of the finding. Anchored on the quoted ref and on
    // `ref=`, so a message that merely mentioned the pack cannot satisfy it.
    expect(finding.where).toContain(`ref=${offender}`);
    expect(finding.message).toContain(`"${offender}"`);
    expect(finding.message).not.toContain(`"${keeper}"`);
    // …and says WHY, in terms of the thing that actually breaks: the zone is
    // never pinned because no PUT happens, so wall-clock rules judge it in a
    // zone nobody verified.
    expect(finding.message).toMatch(/tz|timezone/i);
    expect(finding.message).toMatch(/PUT|schedule-settings/i);
    // An `error`, not a warning: `ok` false is what stops the run before
    // anything is seeded, which is the entire point of catching it at stage 0.
    expect(result.ok).toBe(false);
  });

  it("refuses EVERY offending division, not merely the first", () => {
    // A rule that `return`ed on the first miss would report one and let the
    // second through, and the author would fix one and re-run into the other.
    const pack = scheduledPack();
    for (const d of pack.divisions as Record<string, unknown>[]) {
      delete d.scheduleConfig;
    }
    const expectedRefs = scheduledRefs(pack);
    // Two or more, or this case cannot tell "every" from "the first" at all.
    expect(expectedRefs.length).toBeGreaterThanOrEqual(2);
    expect(schedulingErrors(validatePack(pack, TINY)).map((f) => f.where)).toEqual(
      expectedRefs.map((ref) => `divisions[ref=${ref}]`),
    );
  });

  it("does NOT refuse a REGISTRATION-funnel division that declares none", () => {
    // A funnel division is seeded through registration rather than the
    // schedule path and carries no config in the real pack either. Its own
    // case, so this exemption can be killed on its own — an over-broad rule
    // that refused it would red the committed pack, which is a FALSE red on a
    // correct pack and the one outcome stage 0 must not have.
    const pack = scheduledPack();
    const funnel = funnelRefs(pack);
    expect(funnel.length).toBeGreaterThanOrEqual(1);
    const divisions = pack.divisions as Record<string, unknown>[];
    // The premise: these divisions really do lack a config, so the exemption
    // is what spares them rather than a config they happen to carry.
    for (const ref of funnel) {
      expect(divisions.find((d) => d.ref === ref)?.scheduleConfig).toBeUndefined();
    }
    expect(schedulingErrors(validatePack(pack, TINY))).toEqual([]);
  });

  it("does not fire at all for a pack that declares no courts", () => {
    // `scheduleConfig.courts` is an array of @-sigil refs resolved against the
    // pack's OWN venues, so a pack declaring no court cannot express a
    // meaningful config and has nowhere to place a fixture — the scheduling
    // layer does not run for it. That is what keeps the rule off packs from
    // the layers before this one.
    //
    // The court-less pack is CONSTRUCTED here rather than taken from the
    // committed `_tiny`. This case previously asserted `_tiny` declared no
    // venues, which was true when it was written and false a commit later.
    const pack = tiny() as unknown as Record<string, unknown>;
    delete pack.venues;
    // The configs go too, and not as tidying. With them left in place the rule
    // would stay silent because every scheduled division HAS one, and this
    // case would pass without ever exercising the courts gate — vacuous in
    // exactly the way the header warns about. Stripping them is what makes
    // this a pack the rule WOULD refuse but for the gate under test. (It is
    // also required for the pack to parse at all: a config's `@`-court refs
    // resolve against the venues just deleted.)
    for (const d of pack.divisions as Record<string, unknown>[]) {
      delete d.scheduleConfig;
    }

    // Both premises, asserted rather than inherited.
    expect(pack.venues ?? []).toEqual([]);
    expect(offendingRefs(pack).length).toBeGreaterThan(0);

    expect(schedulingErrors(validatePack(pack, TINY))).toEqual([]);
  });
});
