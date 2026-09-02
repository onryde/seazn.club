// Unit coverage for the reconstruction generators (lib/reconstruct.ts).
//
// Pure: no DB, no HTTP, no env, no disk. Runs in CI's DB-free job.
//
// THE ORACLE DIRECTION. Every exactness assertion below reads the set ledger
// the ENGINE folded, off `foldMatch` — the real fold path — and compares it
// against the TARGET the generator was asked to hit. Never against the
// generator's own idea of what it produced, and never through `buildWalk`
// (which is `module.apply`, one layer below the fold; testkit/helpers.ts:86-96
// says so itself).
//
// The set targets are ENUMERATED, not sampled once: a deuce/cap/decider bug
// hides behind a single lucky score.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, type LineupPair } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { badminton, tabletennis, volleyball } from "@seazn/engine/sports/setbased";
import { football } from "@seazn/engine/sports/football";
import { generic } from "@seazn/engine/sports/generic";
import { hockey } from "@seazn/engine/sports/hockey";
import type { PackEvent, PackStream } from "../pack-schema.ts";
import {
  PACK_FOLD_OPTIONS,
  packEnvelopes,
  packLineupPair,
  resolveDivisionCfg,
  sigil,
  validatePack,
  type PackFinding,
} from "../validate-pack.ts";
import {
  fillPeriodMarkers,
  reconstructSetBasedStream,
  reconstructSetRallies,
  type ReconstructedSet,
} from "../reconstruct.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME = "e-alpha";
const AWAY = "e-bravo";

const streamOf = (events: readonly PackEvent[], provenance = "reconstructed"): PackStream =>
  ({
    divisionRef: "d",
    fixtureExtKey: "fx",
    home: HOME,
    away: AWAY,
    provenance,
    events,
  }) as unknown as PackStream;

/** The two sides as the OFFLINE fold sees them — sigilled pack refs, built by
 *  the SAME function stage 0 builds its `LineupPair` with. */
const lineups = (): LineupPair => packLineupPair(streamOf([]));

/** The cfg through the ONE shared resolution the validator also uses. A test
 *  that resolved its own would prove the generator agrees with the test rather
 *  than with the validator. */
function cfgFor(sportModule: AnySportModule, variantKey: string, cfgOverrides = {}): unknown {
  const resolved = resolveDivisionCfg(sportModule, { variantKey, cfgOverrides });
  if (!resolved.ok) throw new Error(`test fixture cfg is invalid: ${JSON.stringify(resolved)}`);
  return resolved.cfg;
}

/** The set ledger the ENGINE folded through `foldMatch`, read off the module's
 *  own public summary. Never recomputed here. */
function foldedSets(
  sportModule: AnySportModule,
  cfg: unknown,
  events: readonly PackEvent[],
): { home: number; away: number; closed: boolean }[] {
  const { state } = foldMatchWithStoppage(
    sportModule,
    cfg,
    lineups(),
    packEnvelopes(streamOf(events)),
    PACK_FOLD_OPTIONS,
  );
  const detail = sportModule.summary(state).detail as {
    sets: { home: number; away: number; closed: boolean }[];
  };
  return detail.sets.map((s) => ({ home: s.home, away: s.away, closed: s.closed }));
}

const errorsOf = (findings: readonly PackFinding[]): readonly PackFinding[] =>
  findings.filter((f) => f.severity === "error");
const codesOf = (findings: readonly PackFinding[]): string[] => findings.map((f) => f.code);

interface UnitPackInput {
  readonly sportKey: string;
  readonly variantKey: string;
  readonly moduleVersion: string;
  readonly streams: readonly PackStream[];
  readonly expected: Record<string, unknown>;
  readonly stages?: readonly Record<string, unknown>[];
}

/** A whole pack around a generated stream, so the generator's output is driven
 *  through its REAL consumer (`validatePack`) instead of through a fixture that
 *  agrees with it by construction. The `expected` block is the caller's claim
 *  about the real world; the generator never touches it. */
function unitPack(input: UnitPackInput): unknown {
  return {
    schemaVersion: 1,
    suite: "_unit",
    org: { name: "Unit", slug: "unit", timezone: "UTC" },
    competition: { name: "Unit", endsOn: "2099-01-01" },
    divisions: [
      {
        ref: "d",
        name: "D",
        sportKey: input.sportKey,
        variantKey: input.variantKey,
        moduleVersion: input.moduleVersion,
        stages: input.stages ?? [{ ref: "s", seq: 1, kind: "league", name: "League" }],
      },
    ],
    persons: [],
    entrants: [
      { ref: HOME, divisionRef: "d", kind: "individual", displayName: "Alpha", seed: 1 },
      { ref: AWAY, divisionRef: "d", kind: "individual", displayName: "Bravo", seed: 2 },
    ],
    streams: input.streams,
    expected: input.expected,
    meta: { synthetic: true, sources: [] },
  };
}

// ---------------------------------------------------------------------------
// The enumerated target table.
//
// Every real corner of each sport's own set predicate, NOT one lucky score:
// a straight target win, a deuce, badminton's hard cap (the 30–29 golden
// point), volleyball's UNCAPPED win-by-two endgame, a deciding set played to a
// DIFFERENT target, a whitewash with zero points, and matches that run the full
// distance in three, five and seven-game formats.
// ---------------------------------------------------------------------------

interface Scenario {
  readonly name: string;
  readonly module: AnySportModule;
  readonly variantKey: string;
  readonly rallyType: string;
  readonly sets: readonly ReconstructedSet[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "badminton bwf — straight games",
    module: badminton,
    variantKey: "bwf",
    rallyType: "badminton.rally",
    sets: [
      { home: 21, away: 15 },
      { home: 21, away: 18 },
    ],
  },
  {
    name: "badminton bwf — three games, one deuce, one lost",
    module: badminton,
    variantKey: "bwf",
    rallyType: "badminton.rally",
    sets: [
      { home: 24, away: 22 },
      { home: 19, away: 21 },
      { home: 21, away: 19 },
    ],
  },
  {
    name: "badminton bwf — the 30-29 golden point at the hard cap, and a 21-0",
    module: badminton,
    variantKey: "bwf",
    rallyType: "badminton.rally",
    sets: [
      { home: 30, away: 29 },
      { home: 21, away: 0 },
    ],
  },
  {
    name: "badminton short — the junior 11-point variant and its 15 cap",
    module: badminton,
    variantKey: "short",
    rallyType: "badminton.rally",
    sets: [
      { home: 11, away: 9 },
      { home: 8, away: 11 },
      { home: 15, away: 14 },
    ],
  },
  {
    name: "table tennis bo5 — five games including a deuce",
    module: tabletennis,
    variantKey: "bo5",
    rallyType: "tabletennis.rally",
    sets: [
      { home: 11, away: 8 },
      { home: 9, away: 11 },
      { home: 15, away: 13 },
      { home: 5, away: 11 },
      { home: 11, away: 9 },
    ],
  },
  {
    name: "table tennis bo7 — the longer distance to FOUR games, an 11-0 and a lost deuce",
    module: tabletennis,
    variantKey: "bo7",
    rallyType: "tabletennis.rally",
    sets: [
      { home: 11, away: 0 },
      { home: 11, away: 6 },
      { home: 10, away: 12 },
      { home: 11, away: 9 },
      { home: 9, away: 11 },
      { home: 11, away: 7 },
    ],
  },
  {
    name: "table tennis hardbat-21 — the legacy 21-point game, five of them",
    module: tabletennis,
    variantKey: "hardbat-21",
    rallyType: "tabletennis.rally",
    sets: [
      { home: 21, away: 19 },
      { home: 23, away: 25 },
      { home: 21, away: 12 },
      { home: 19, away: 21 },
      { home: 21, away: 17 },
    ],
  },
  {
    name: "volleyball indoor — five sets, the decider played to a DIFFERENT target",
    module: volleyball,
    variantKey: "indoor",
    rallyType: "volleyball.rally",
    sets: [
      { home: 25, away: 20 },
      { home: 23, away: 25 },
      { home: 25, away: 27 },
      { home: 25, away: 18 },
      { home: 15, away: 12 },
    ],
  },
  {
    name: "volleyball indoor — the uncapped 32-30 endgame",
    module: volleyball,
    variantKey: "indoor",
    rallyType: "volleyball.rally",
    sets: [
      { home: 32, away: 30 },
      { home: 25, away: 23 },
      { home: 25, away: 22 },
    ],
  },
  {
    name: "volleyball beach — the 21/15 preset, decider to 15",
    module: volleyball,
    variantKey: "beach",
    rallyType: "volleyball.rally",
    sets: [
      { home: 21, away: 18 },
      { home: 19, away: 21 },
      { home: 15, away: 13 },
    ],
  },
];

const SEEDS = [0, 1, 7, 4242, 987_654_321] as const;

// ---------------------------------------------------------------------------

describe("reconstructSetRallies — exactness, enumerated", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: folds to the exact declared score, every seed`, () => {
      const cfg = cfgFor(scenario.module, scenario.variantKey);
      const want = scenario.sets.map((s) => ({ home: s.home, away: s.away, closed: true }));
      for (const seed of SEEDS) {
        const events = reconstructSetRallies({
          module: scenario.module,
          cfg,
          lineups: lineups(),
          rallyType: scenario.rallyType,
          sets: scenario.sets,
          seed,
        });
        expect(foldedSets(scenario.module, cfg, events), `${scenario.name} @ seed ${seed}`).toEqual(
          want,
        );
      }
    });
  }

  it("emits core.start first, then exactly one rally per declared point", () => {
    const scenario = SCENARIOS[1] as Scenario;
    const events = reconstructSetRallies({
      module: scenario.module,
      cfg: cfgFor(scenario.module, scenario.variantKey),
      lineups: lineups(),
      rallyType: scenario.rallyType,
      sets: scenario.sets,
      seed: 3,
    });
    expect(events[0]).toEqual({ type: "core.start", payload: {} });
    expect([...new Set(events.slice(1).map((e) => e.type))]).toEqual([scenario.rallyType]);
    const points = scenario.sets.reduce((n, s) => n + s.home + s.away, 0);
    expect(events.length).toBe(points + 1);
  });

  it("attributes rallies to SIDES and never to a person — the honesty clause", () => {
    const scenario = SCENARIOS[4] as Scenario;
    const events = reconstructSetRallies({
      module: scenario.module,
      cfg: cfgFor(scenario.module, scenario.variantKey),
      lineups: lineups(),
      rallyType: scenario.rallyType,
      sets: scenario.sets,
      seed: 11,
    });
    // The rally payload also accepts `scorer` and `server` (PersonId) and
    // `serving` (the serving side). All three are facts the archive does not
    // give, and a reconstruction that filled one would be inventing.
    for (const event of events.slice(1)) {
      expect(Object.keys(event.payload)).toEqual(["wonBy"]);
      expect([sigil(HOME), sigil(AWAY)]).toContain(event.payload["wonBy"]);
    }
  });
});

describe("reconstructSetRallies — determinism", () => {
  it("the same seed gives BYTE-identical output, for every scenario", () => {
    for (const scenario of SCENARIOS) {
      const cfg = cfgFor(scenario.module, scenario.variantKey);
      const call = (): string =>
        JSON.stringify(
          reconstructSetRallies({
            module: scenario.module,
            cfg,
            lineups: lineups(),
            rallyType: scenario.rallyType,
            sets: scenario.sets,
            seed: 20_260_812,
          }),
        );
      // Serialized BYTES, never a structural deep-equal: a pack is a JSON file,
      // and what a second machine has to reproduce is its bytes.
      expect(call(), scenario.name).toBe(call());
    }
  });

  it("different seeds give DIFFERENT sequences that fold to the SAME target", () => {
    // A target with very many legal orderings, on purpose: 21–0 has exactly
    // one, so a generator that ignored its seed entirely would pass there.
    const sets: ReconstructedSet[] = [
      { home: 25, away: 23 },
      { home: 26, away: 24 },
      { home: 25, away: 22 },
    ];
    const cfg = cfgFor(volleyball, "indoor");
    const want = sets.map((s) => ({ home: s.home, away: s.away, closed: true }));
    const serialized = new Set<string>();
    for (let seed = 0; seed < 12; seed++) {
      const events = reconstructSetRallies({
        module: volleyball,
        cfg,
        lineups: lineups(),
        rallyType: "volleyball.rally",
        sets,
        seed,
      });
      serialized.add(JSON.stringify(events));
      expect(foldedSets(volleyball, cfg, events), `seed ${seed}`).toEqual(want);
    }
    expect(serialized.size).toBeGreaterThan(1);
  });
});

describe("reconstructSetRallies — refusals", () => {
  const call = (sets: readonly ReconstructedSet[]): PackEvent[] =>
    reconstructSetRallies({
      module: badminton,
      cfg: cfgFor(badminton, "bwf"),
      lineups: lineups(),
      rallyType: "badminton.rally",
      sets,
      seed: 1,
    });

  it("refuses a set score the sport's own predicate can never reach, and says where it closed", () => {
    // 22–19 is already over at 21–19, so no rally order reaches it.
    expect(() =>
      call([
        { home: 22, away: 19 },
        { home: 21, away: 10 },
      ]),
    ).toThrow(/no legal rally order reaches set 1's declared 22–19.*already over at 21–19/s);
  });

  it("refuses a drawn set — a set-based set has no draw", () => {
    expect(() => call([{ home: 21, away: 21 }])).toThrow(/set 1 declares 21–21/);
  });

  it("refuses a set list that decides the match before its last set", () => {
    expect(() =>
      call([
        { home: 21, away: 10 },
        { home: 21, away: 11 },
        { home: 21, away: 12 },
      ]),
    ).toThrow(/already decided at set 2/);
  });

  it("refuses a set list that never decides the match", () => {
    expect(() => call([{ home: 21, away: 10 }])).toThrow(/reaches no decided outcome/);
  });

  it("refuses an empty set list", () => {
    expect(() => call([])).toThrow(/at least one set score/);
  });

  it("refuses an event type the module does not declare", () => {
    expect(() =>
      reconstructSetRallies({
        module: badminton,
        cfg: cfgFor(badminton, "bwf"),
        lineups: lineups(),
        rallyType: "badminton.raly",
        sets: [
          { home: 21, away: 10 },
          { home: 21, away: 11 },
        ],
        seed: 1,
      }),
    ).toThrow(/declares no event type "badminton\.raly"/);
  });

  it("refuses a module whose summary exposes no set ledger", () => {
    // `generic` has no `detail` at all, so it is not a set-based module and its
    // rally order is not this generator's to reconstruct.
    expect(() =>
      reconstructSetRallies({
        module: generic,
        cfg: cfgFor(generic, "score"),
        lineups: lineups(),
        rallyType: "generic.score",
        sets: [{ home: 2, away: 1 }],
        seed: 1,
      }),
    ).toThrow(/exposes no set ledger/);
  });
});

describe("reconstructSetBasedStream — the stream a pack carries", () => {
  const SETS: readonly ReconstructedSet[] = [
    { home: 21, away: 15 },
    { home: 19, away: 21 },
    { home: 24, away: 22 },
  ];
  const build = (seed: number, stageRef?: string): PackStream =>
    reconstructSetBasedStream({
      module: badminton,
      cfg: cfgFor(badminton, "bwf"),
      divisionRef: "d",
      ...(stageRef === undefined ? {} : { stageRef }),
      fixtureExtKey: "fx",
      home: HOME,
      away: AWAY,
      rallyType: "badminton.rally",
      sets: SETS,
      seed,
    });

  /** The pack a reconstructed badminton stream sits in. Two games to one, so
   *  home wins 2–1; badminton's own `pointsMap` is `{"*": [2, 0]}`. */
  const badmintonPack = (stream: PackStream, stages?: readonly Record<string, unknown>[]): unknown =>
    unitPack({
      sportKey: "badminton",
      variantKey: "bwf",
      moduleVersion: badminton.version,
      streams: [stream],
      ...(stages === undefined ? {} : { stages }),
      expected: {
        matches: [
          {
            divisionRef: "d",
            fixtureExtKey: "fx",
            outcome: { kind: "win", winner: HOME, loser: AWAY, method: "regulation" },
            perSide: [
              { entrant: HOME, line: "2" },
              { entrant: AWAY, line: "1" },
            ],
          },
        ],
        tables: [
          {
            divisionRef: "d",
            stageRef: "s",
            rows: [
              { entrant: HOME, rank: 1, played: 1, won: 1, drawn: 0, lost: 0, points: 2 },
              { entrant: AWAY, rank: 2, played: 1, won: 0, drawn: 0, lost: 1, points: 0 },
            ],
          },
        ],
      },
    });

  it("flags itself reconstructed and RECORDS the seed that reproduces its bytes", () => {
    const stream = build(99);
    expect(stream.provenance).toBe("reconstructed");
    // Not merely "a seed is present": the seed that actually produced THESE
    // bytes, replayed through the generator to prove it.
    expect(stream.reconstruction?.seed).toBe(99);
    const replayed = reconstructSetRallies({
      module: badminton,
      cfg: cfgFor(badminton, "bwf"),
      lineups: lineups(),
      rallyType: "badminton.rally",
      sets: SETS,
      seed: stream.reconstruction?.seed ?? -1,
    });
    expect(JSON.stringify(stream.events)).toBe(JSON.stringify(replayed));
  });

  it("its note names the scores it was asked to hit", () => {
    expect(build(1).reconstruction?.note).toBe("reconstructed to fold to 21–15, 19–21, 24–22");
  });

  it("binds stageRef when given one, and omits it when not", () => {
    expect(build(1, "s").stageRef).toBe("s");
    expect(build(1).stageRef).toBeUndefined();
  });

  it("validates GREEN through the real stage-0 validator", () => {
    const result = validatePack(badmintonPack(build(5)), { expectedSuite: "_unit" });
    expect(errorsOf(result.findings)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.provenance.overall.reconstructed).toBe(1);
  });

  it("in a MULTI-stage division the stageRef is what binds the table; without it stage 0 refuses to check", () => {
    const stages = [
      { ref: "s", seq: 1, kind: "league", name: "Group" },
      { ref: "s2", seq: 2, kind: "league", name: "Final round" },
    ];
    const bound = validatePack(badmintonPack(build(5, "s"), stages), { expectedSuite: "_unit" });
    expect(errorsOf(bound.findings)).toEqual([]);
    expect(codesOf(bound.findings)).not.toContain("standings.stage_unbindable");

    const unbound = validatePack(badmintonPack(build(5), stages), { expectedSuite: "_unit" });
    expect(errorsOf(unbound.findings)).toEqual([]);
    expect(codesOf(unbound.findings)).toContain("standings.stage_unbindable");
  });
});

describe("fillPeriodMarkers — the whistles a match sheet does not record", () => {
  const start: PackEvent = { type: "core.start", payload: {} };
  const goal = (by: string): PackEvent => ({ type: "football.goal", payload: { by: sigil(by) } });
  const puck = (by: string): PackEvent => ({
    type: "hockey.goal",
    payload: { by: sigil(by), kind: "fg" },
  });
  const show = (events: readonly PackEvent[]): string[] =>
    events.map((e) => `${e.type}:${JSON.stringify(e.payload)}`);

  it("supplies HT and FT for a two-half football sheet, and nothing else", () => {
    const events = fillPeriodMarkers({
      module: football,
      cfg: cfgFor(football, "11-a-side"),
      lineups: lineups(),
      markerType: "football.period",
      segments: [
        [start, goal(HOME)],
        [goal(AWAY), goal(HOME)],
      ],
    });
    expect(show(events)).toEqual([
      "core.start:{}",
      'football.goal:{"by":"@e-alpha"}',
      'football.period:{"phase":"HT"}',
      'football.goal:{"by":"@e-bravo"}',
      'football.goal:{"by":"@e-alpha"}',
      'football.period:{"phase":"FT"}',
    ]);
  });

  it("follows the cfg's own period SHAPE — mini-soccer's four quarters, not two halves", () => {
    // The value is derived from padSpec, so the quarters vocabulary
    // (QT / HT / 3QT / FT) arrives without this file naming any of it. A filler
    // holding a typed-in ["HT","FT"] would emit two markers here and leave the
    // match undecided.
    const events = fillPeriodMarkers({
      module: football,
      cfg: cfgFor(football, "mini-soccer"),
      lineups: lineups(),
      markerType: "football.period",
      segments: [[start, goal(HOME)], [], [], []],
    });
    expect(events.filter((e) => e.type === "football.period").map((e) => e.payload["phase"])).toEqual(
      ["QT", "HT", "3QT", "FT"],
    );
  });

  it("supplies the period kernel's OWN advance vocabulary, which is a different one", () => {
    const cfg = cfgFor(hockey, "fih-outdoor");
    const events = fillPeriodMarkers({
      module: hockey,
      cfg,
      lineups: lineups(),
      markerType: "hockey.period.advance",
      segments: [[start, puck(HOME)], [], [], [puck(HOME)]],
    });
    // Derived from the engine, never typed in: whatever labels this cfg
    // declares, in the order the engine accepts them, ending at "FT".
    expect(
      events.filter((e) => e.type === "hockey.period.advance").map((e) => e.payload["to"]),
    ).toEqual(["Q2", "Q3", "Q4", "FT"]);
    const { state } = foldMatchWithStoppage(
      hockey,
      cfg,
      lineups(),
      packEnvelopes(streamOf(events, "real")),
      PACK_FOLD_OPTIONS,
    );
    expect(hockey.outcome(state)).not.toBeNull();
  });

  it("refuses to fill an ATTRIBUTED action — the honesty clause, mechanically", () => {
    expect(() =>
      fillPeriodMarkers({
        module: football,
        cfg: cfgFor(football, "11-a-side"),
        lineups: lineups(),
        markerType: "football.goal",
        segments: [[start], []],
      }),
    ).toThrow(/collects attribution/);
  });

  it("refuses when the module declares no pad action for the named type", () => {
    expect(() =>
      fillPeriodMarkers({
        module: football,
        cfg: cfgFor(football, "11-a-side"),
        lineups: lineups(),
        markerType: "football.periods",
        segments: [[start], []],
      }),
    ).toThrow(/declares no pad action for "football\.periods"/);
  });

  it("refuses a sheet the markers alone cannot decide", () => {
    // Level after both halves with `shootout` on: the engine takes the fixture
    // to a shoot-out, and a shoot-out kick is an ATTRIBUTED fact.
    expect(() =>
      fillPeriodMarkers({
        module: football,
        cfg: cfgFor(football, "11-a-side", { shootout: true }),
        lineups: lineups(),
        markerType: "football.period",
        segments: [[start], []],
      }),
    ).toThrow(/accepted none of/);
  });

  it("folds green through the real validator as a REAL-provenance football stream", () => {
    const events = fillPeriodMarkers({
      module: football,
      cfg: cfgFor(football, "11-a-side"),
      lineups: lineups(),
      markerType: "football.period",
      segments: [
        [start, goal(HOME)],
        [goal(HOME), goal(AWAY)],
      ],
    });
    const pack = unitPack({
      sportKey: "football",
      variantKey: "11-a-side",
      moduleVersion: football.version,
      streams: [streamOf(events, "real")],
      expected: {
        matches: [
          {
            divisionRef: "d",
            fixtureExtKey: "fx",
            outcome: { kind: "win", winner: HOME, loser: AWAY, method: "regulation" },
          },
        ],
      },
    });
    const result = validatePack(pack, { expectedSuite: "_unit" });
    expect(errorsOf(result.findings)).toEqual([]);
    expect(result.provenance.overall.real).toBe(1);
  });
});
