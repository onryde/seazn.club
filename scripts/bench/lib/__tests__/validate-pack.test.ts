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
import { boardgame } from "@seazn/engine/sports/boardgame";
import { PackSchema, fixtureKey } from "../pack-schema.ts";
import {
  OFFLINE_RECORDED_AT,
  PACK_FOLD_OPTIONS,
  packEnvelopes,
  packLineupPair,
  resolveStatePath,
  sigil,
  stageScopedFoldCfg,
  validatePack,
  type PackFinding,
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
    stages: { ref: string; seq: number; kind: string; name: string; config: Record<string, unknown> }[];
  }[];
  persons: { ref: string; fullName: string; lane: string }[];
  entrants: { ref: string }[];
  streams: TinyStream[];
  expected: {
    matches: {
      divisionRef: string;
      fixtureExtKey: string;
      outcome: Record<string, unknown>;
      perSide?: { entrant: string; line: string }[];
    }[];
    tables: { divisionRef: string; stageRef: string; poolKey?: string; rows: TinyTableRow[] }[];
    specials: {
      kind: string;
      divisionRef: string;
      fixtureExtKey: string;
      claims: Record<string, unknown>[];
    }[];
  };
  meta: { synthetic: boolean; sources: unknown[] };
}

const errors = (findings: readonly PackFinding[]): readonly PackFinding[] =>
  findings.filter((f) => f.severity === "error");
const warnings = (findings: readonly PackFinding[]): readonly PackFinding[] =>
  findings.filter((f) => f.severity === "warning");

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
      { ref: "e1", divisionRef: "d1", kind: "individual", displayName: "One", roster: [{ person: "p1" }] },
      { ref: "e2", divisionRef: "d1", kind: "individual", displayName: "Two", roster: [{ person: "p2" }] },
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
function boardgamePack(pairing: Record<string, unknown>): Record<string, unknown> {
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
        { divisionRef: "d1", fixtureExtKey: "f1", outcome: { kind: "win", winner: "e1", loser: "e2" } },
      ],
    },
    meta: { synthetic: true, sources: [] },
  };
}

// ===========================================================================
// The shared fixture
// ===========================================================================

describe("validatePack — _tiny.json, the shared fixture", () => {
  it("validates green end to end, with no findings of any severity", () => {
    const result = validatePack(tiny(), { expectedSuite: "_tiny" });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pack?.suite).toBe("_tiny");
  });

  it("reports the provenance split per division and overall", () => {
    const result = validatePack(tiny());
    // Two `real` streams and one `reconstructed`, per the committed file.
    expect(result.provenance.overall).toEqual({
      real: 2,
      reconstructed: 1,
      synthetic: 0,
      total: 3,
    });
    expect(result.provenance.byDivision).toEqual({
      "d-tiny": { real: 2, reconstructed: 1, synthetic: 0, total: 3 },
    });
  });

  it("gives every declared division a split, including one with no streams", () => {
    const pack = tiny();
    pack.streams = [];
    pack.expected.matches = [];
    pack.expected.tables = [];
    pack.expected.specials = [];
    const result = validatePack(pack);
    // An absent key and a zero count are different facts: a report that cannot
    // tell them apart hides a division nothing replayed.
    expect(result.provenance.byDivision).toEqual({
      "d-tiny": { real: 0, reconstructed: 0, synthetic: 0, total: 0 },
    });
  });
});

// ===========================================================================
// Regression — deliberately corrupted streams
// ===========================================================================

describe("validatePack — corrupted streams die naming the stream and the divergence", () => {
  it("a WRONG SCORER (the entrant credited with the points) reds the fold", () => {
    const pack = tiny();
    // rr-r2-c1 is the drawn fixture: 2 to bravo, 1+1 to alpha. Credit bravo's
    // two points to alpha instead and the draw becomes an alpha win.
    const stream = pack.streams[1] as TinyStream;
    expect(stream.fixtureExtKey).toBe("rr-r2-c1");
    (stream.events[1] as { payload: Record<string, unknown> }).payload["by"] = "@e-alpha";

    const finding = onlyError(validatePack(pack).findings);
    expect(finding.code).toBe("match.outcome_kind");
    expect(finding.where).toBe("streams[1] (d-tiny/rr-r2-c1)");
    expect(finding.message).toBe('outcome kind: pack expects "draw", the fold produced "win"');
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

    const finding = onlyError(validatePack(pack).findings);
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
    (stream.events[1] as { payload: Record<string, unknown> }).payload["p1Score"] = 4;

    const result = validatePack(pack);
    const finding = onlyError(result.findings);
    expect(finding.code).toBe("match.side_line");
    expect(finding.where).toBe("streams[0] (d-tiny/rr-r1-c1)");
    expect(finding.message).toBe(
      'score line for "e-alpha": pack expects "3", the fold produced "4"',
    );
    // And the table is not silently skipped: the skip says why, so a reader
    // cannot mistake "not checked" for "checked and fine".
    expect(warnings(result.findings).map((f) => f.code)).toEqual(["standings.upstream_fold_failed"]);
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

    const finding = onlyError(validatePack(pack).findings);
    expect(finding.code).toBe("standings.order");
    expect(finding.where).toBe("expected.tables[0] (d-tiny/s-league)");
    expect(finding.message).toBe('rank 1: pack expects "e-bravo", the fold ranked "@e-alpha" there');
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
    match.outcome = { kind: "win", winner: "e-bravo", loser: "e-alpha", method: "regulation" };
    match.perSide = [
      { entrant: "e-bravo", line: "3" },
      { entrant: "e-alpha", line: "1" },
    ];

    const result = validatePack(pack);
    // The fixture itself is now self-consistent: stage 2 has nothing to say.
    expect(errors(result.findings).filter((f) => f.code.startsWith("match."))).toEqual([]);
    // The cumulative table is where the reversal shows up: alpha and bravo end
    // level on 4 points each, and the cascade puts bravo first.
    const finding = onlyError(result.findings);
    expect(finding.code).toBe("standings.order");
    expect(finding.where).toBe("expected.tables[0] (d-tiny/s-league)");
    expect(finding.message).toBe('rank 1: pack expects "e-alpha", the fold ranked "@e-bravo" there');
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
    ["the wrong type", (s) => void ((s as unknown as { provenance: number }).provenance = 42)],
    ["null", (s) => void ((s as unknown as { provenance: null }).provenance = null)],
  ];
  it.each(badProvenance)("refuses a stream whose provenance is %s", (_label, mutate) => {
    const pack = tiny();
    mutate(pack.streams[0] as TinyStream);

    const result = validatePack(pack);
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
  });

  it("accepts all THREE declared provenances, not just real/reconstructed", () => {
    const pack = tiny();
    // `synthetic` was added in Task 1's fix round; GLOBAL.md still names two
    // values. A validator that hardcoded the old pair would red here.
    (pack.streams[1] as TinyStream).provenance = "synthetic";
    const result = validatePack(pack);
    expect(result.findings).toEqual([]);
    expect(result.provenance.overall).toEqual({
      real: 2,
      reconstructed: 0,
      synthetic: 1,
      total: 3,
    });
  });

});

// ===========================================================================
// Parity with the product's batch import
// ===========================================================================

describe("validatePack — parity P1: envelope synthesis", () => {
  it("mints id = String(i) and seq = i + 1, 1-based and gapless", () => {
    const pack = PackSchema.parse(tiny());
    const stream = pack.streams[1]!;
    const envelopes = packEnvelopes(stream);

    expect(envelopes).toHaveLength(stream.events.length);
    expect(envelopes.map((e) => e.id)).toEqual(stream.events.map((_, i) => String(i)));
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
    expect(envelopes.map((e) => e.type)).toEqual(stream.events.map((e) => e.type));
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
    const strictRefused = validatePack(boardgamePack({ white: "@e1" }));
    const finding = onlyError(strictRefused.findings);
    expect(finding.code).toBe("fold.rejected");
    expect(finding.where).toBe("streams[0] (d1/f1)");
    expect(finding.message).toContain("this division plays without colours");

    // Control 1: the same stream with a pairing card that carries no colour
    // folds green, so the refusal above is the colours rule and not a broken
    // fixture.
    expect(validatePack(boardgamePack({ board: 1 })).findings).toEqual([]);

    // Control 2: the SAME events fold cleanly with the tolerant (replay)
    // reading. Without this the test could pass against a validator that
    // never passed any options at all.
    const pack = PackSchema.parse(boardgamePack({ white: "@e1" }));
    const stream = pack.streams[0]!;
    const cfg = boardgame.configSchema.parse({ ...boardgame.variants["classical"], colors: false });
    const args = [boardgame, cfg, packLineupPair(stream), packEnvelopes(stream)] as const;
    expect(() => foldMatchWithStoppage(...args)).not.toThrow();
    expect(() => foldMatchWithStoppage(...args, PACK_FOLD_OPTIONS)).toThrow();
  });
});

describe("validatePack — parity P2: the not-decided rejection", () => {
  it("reds a stream that folds legally but reaches no outcome", () => {
    const result = validatePack(genericPack({ events: [{ type: "core.start" }] }));
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
    (pack.expected.matches[1] as { outcome: Record<string, unknown> }).outcome = { kind: "tie" };

    const codes = errors(validatePack(pack).findings).map((f) => `${f.code} @ ${f.where}`);
    expect(codes).toEqual([
      "fold.rejected @ streams[0] (d-tiny/rr-r1-c1)",
      "match.outcome_kind @ streams[1] (d-tiny/rr-r2-c1)",
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
    pack.expected.specials[0]!.claims = [{ on: "state", path: "mtbTo", equals: true }];

    const finding = onlyError(validatePack(pack).findings);
    expect(finding.code).toBe("special.state");
    expect(finding.where).toBe("expected.specials[0] (retirement d-tiny/rr-r3-c1) claims[0]");
    expect(finding.message).toContain('state path "mtbTo" does not exist');
  });

  it("reds a state path that resolves to the wrong value, naming both", () => {
    const pack = tiny();
    pack.expected.specials[0]!.claims = [{ on: "state", path: "phase", equals: "live" }];
    const finding = onlyError(validatePack(pack).findings);
    expect(finding.code).toBe("special.state");
    expect(finding.message).toBe('state "phase": claim expects "live", the fold produced "done"');
  });

  it("reds an outcome claim whose method the fold did not produce", () => {
    const pack = tiny();
    pack.expected.specials[0]!.claims = [
      { on: "outcome", kind: "award", winner: "e-alpha", method: "shootout" },
    ];
    const finding = onlyError(validatePack(pack).findings);
    expect(finding.code).toBe("special.outcome");
    expect(finding.message).toContain('claim expects "shootout"');
  });

  it("reds a standings claim against THIS fixture's own delta", () => {
    const pack = tiny();
    // The real value is 1 (alpha won the awarded fixture). `2` would be its
    // value in the cumulative table, which is the assertion this branch must
    // NOT be making.
    pack.expected.specials[0]!.claims = [
      { on: "standings", entrant: "e-alpha", field: "won", equals: 2 },
    ];
    const finding = onlyError(validatePack(pack).findings);
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
    const finding = onlyError(validatePack(pack).findings);
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
            claims: [{ on: "squads", entrant: "e1", field: "subsUsed", equals }],
          },
        ],
      });

    expect(validatePack(withSub(1)).findings).toEqual([]);
    const finding = onlyError(validatePack(withSub(0)).findings);
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
        { on: "squads", entrant: "e-alpha", field: "exemptUsed", exemption: "concussion", equals },
      ],
    });
    const green = tiny();
    green.expected.specials = [claim(0) as TinyShape["expected"]["specials"][number]];
    expect(validatePack(green).findings).toEqual([]);

    const red = tiny();
    red.expected.specials = [claim(1) as TinyShape["expected"]["specials"][number]];
    expect(onlyError(validatePack(red).findings).message).toBe(
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
    expect(validatePack(withCharlie("e-alpha")).findings).toEqual([]);

    const finding = onlyError(validatePack(withCharlie("e-charlie")).findings);
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
    (stream.events[2] as { payload: Record<string, unknown> }).payload["person"] = "@p-bo";
    expect(validatePack(pack).findings).toEqual([]);
  });

  it("cannot bind streams to a stage in a MULTI-STAGE division, and says so", () => {
    const pack = tiny();
    pack.divisions[0]!.stages.push({
      ref: "s-ko",
      seq: 2,
      kind: "knockout",
      name: "Knockout",
      config: {},
    });
    const result = validatePack(pack);
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
    const result = validatePack(pack);
    expect(errors(result.findings)).toEqual([]);
    expect(warnings(result.findings).map((f) => f.code)).toEqual(["standings.pool_unbindable"]);
  });
});

// ===========================================================================
// Stage-3 plumbing that mirrors the product
// ===========================================================================

describe("validatePack — the standings derivation mirrors the product's own", () => {
  it("reds a table declared against a stage that produces a bracket, not a table", () => {
    const pack = tiny();
    pack.divisions[0]!.stages[0]!.kind = "knockout";
    const finding = onlyError(validatePack(pack).findings);
    expect(finding.code).toBe("standings.not_a_table_stage");
    expect(finding.message).toContain('kind "knockout"');
  });

  it("applies the stage's carry-over openings (stage.config.carry_deltas)", () => {
    const pack = tiny();
    pack.divisions[0]!.stages[0]!.config["carry_deltas"] = [
      { entrantId: "@e-alpha", played: 0, won: 0, drawn: 0, lost: 0, points: 5, metrics: {} },
    ];
    // The pack now expects 7 + 5. Green ONLY if the opening delta is applied;
    // ignoring `carry_deltas` gives 7 and reds.
    pack.expected.tables[0]!.rows[0]!.points = 12;
    expect(validatePack(pack).findings).toEqual([]);
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
    expect(validatePack(pack).findings).toEqual([]);
  });

  it("reds when the fold produces a different number of rows", () => {
    const pack = tiny();
    pack.expected.tables[0]!.rows = [pack.expected.tables[0]!.rows[0]!];
    const finding = onlyError(validatePack(pack).findings);
    expect(finding.code).toBe("standings.row_count");
    expect(finding.message).toBe("the fold produced 2 row(s), the pack declares 1");
  });

  it("compares declared metrics, and asserts none when the pack declares none", () => {
    const green = tiny();
    expect(validatePack(green).findings).toEqual([]); // `_tiny` declares no metrics

    const red = tiny();
    red.expected.tables[0]!.rows[0]!.metrics = { nonsense: 1 };
    const finding = onlyError(validatePack(red).findings);
    expect(finding.code).toBe("standings.metrics");
    expect(finding.message).toContain('rank 1 "e-alpha" metrics');
  });
});

describe("stageScopedFoldCfg — the product's two-key stage overlay", () => {
  it("overlays ONLY shootout and extraTime", () => {
    const base = { setTo: 21, shootout: false };
    expect(
      stageScopedFoldCfg(base, { legs: 3, shootout: true, extraTime: { halves: 2 } }),
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
    const result = validatePack(pack);
    expect(result.ok).toBe(false);
    // The rule and its reason live in PackSchema's `checkStreams`, not here —
    // one implementation, reached through the pipeline.
    const dup = result.findings.find((f) => f.message.includes("unique per DIVISION"));
    expect(dup?.where).toBe("streams.1.fixtureExtKey");
    expect(dup?.code).toBe("schema.custom");
  });

  it("stops after stage 1 and returns no pack when the shape is wrong", () => {
    const result = validatePack({ schemaVersion: 2 });
    expect(result.pack).toBe(null);
    expect(result.ok).toBe(false);
    expect(result.provenance.overall.total).toBe(0);
    expect(result.findings.every((f) => f.code.startsWith("schema."))).toBe(true);
  });

  it("checks the pack's own suite key against the caller's expectation", () => {
    const finding = onlyError(validatePack(tiny(), { expectedSuite: "worldcup-2019" }).findings);
    expect(finding.code).toBe("pack.suite_mismatch");
    expect(finding.message).toContain('pack declares suite "_tiny"');
    // Omitting the option must not silently red — the runner may not pass one.
    expect(validatePack(tiny()).findings).toEqual([]);
  });

  it("warns when a REAL suite key waives the cite-a-source rule", () => {
    const pack = tiny();
    pack.suite = "worldcup-2019";
    const result = validatePack(pack, { expectedSuite: "worldcup-2019" });
    expect(errors(result.findings)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(warnings(result.findings).map((f) => f.code)).toEqual(["pack.synthetic_suite"]);
  });
});

// ===========================================================================
// Helpers with their own contracts
// ===========================================================================

describe("resolveStatePath", () => {
  it("separates 'absent' from 'present but undefined'", () => {
    expect(resolveStatePath({ a: undefined }, "a")).toEqual({ found: true, value: undefined });
    expect(resolveStatePath({ a: 1 }, "b")).toEqual({ found: false, value: undefined });
  });

  it("indexes into arrays and refuses an out-of-range index", () => {
    const state = { sets: [{ mtb: false }, { mtb: true }] };
    expect(resolveStatePath(state, "sets.1.mtb")).toEqual({ found: true, value: true });
    expect(resolveStatePath(state, "sets.2.mtb").found).toBe(false);
  });

  it("refuses to walk through a non-object", () => {
    expect(resolveStatePath({ a: 5 }, "a.b").found).toBe(false);
    expect(resolveStatePath({ a: null }, "a.b").found).toBe(false);
  });
});

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
          away: [{ person: "p2", slot: "starting", orderNo: 4, positionKey: "gk" }],
        },
      }),
    );
    const pair = packLineupPair(pack.streams[0]!);
    expect(pair.home.slots).toEqual([
      { personId: sigil("p1"), slot: "starting", orderNo: 1, roles: ["captain"] },
      { personId: sigil("p2"), slot: "bench", orderNo: 2, squadNumber: 7, role: "coach" },
    ]);
    expect(pair.away.slots).toEqual([
      { personId: sigil("p2"), slot: "starting", orderNo: 4, positionKey: "gk" },
    ]);
  });
});
