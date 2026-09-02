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
  foldAgreementIssue,
  reconstructSetBasedStream,
  reconstructSetRallies,
  setBankedIssue,
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

// ---------------------------------------------------------------------------
// The generator's own two INTERNAL refusals.
//
// Both survived the sweep in situ with ZERO red, because each is covered by the
// other plus the external oracle — "two guards covering for each other", one
// level up from the lesson the suite already records. They are pure functions
// now, so each is killable alone. That matters because they are not decoration:
// B03's pack builder will rely on this generator THROWING rather than handing
// back a wrong stream.
// ---------------------------------------------------------------------------
describe("setBankedIssue — did the module bank the set that was asked for", () => {
  const target: ReconstructedSet = { home: 21, away: 15 };

  it("is null when the ledger entry matches on all three facts", () => {
    expect(setBankedIssue({ home: 21, away: 15, closed: true }, target, 0)).toBeNull();
  });

  it("names both scores when the set closed on the WRONG one", () => {
    const issue = setBankedIssue({ home: 21, away: 14, closed: true }, target, 2);
    // The set index a reader will look for, and BOTH values — never "a
    // mismatch occurred".
    expect(issue).toContain("set 3:");
    expect(issue).toContain("asked for 21–15");
    expect(issue).toContain("the fold banked 21–14");
  });

  it("says STILL OPEN when the score is right but the set never closed", () => {
    // A distinct defect from a wrong score, and the message has to tell them
    // apart: this is what a target that is no finished set at all produces if
    // it ever reaches the walk.
    const issue = setBankedIssue({ home: 21, away: 15, closed: false }, target, 0);
    expect(issue).toContain("(still open)");
  });
});

describe("foldAgreementIssue — does the REAL fold path agree with the plan", () => {
  it("is null when the two score strings are equal", () => {
    expect(foldAgreementIssue("21–15, 19–21", "21–15, 19–21")).toBeNull();
  });

  it("names both sides when they diverge", () => {
    const issue = foldAgreementIssue("21–15, 19–21*", "21–15, 19–21");
    expect(issue).toContain("asked for [21–15, 19–21]");
    expect(issue).toContain("the real fold path produced [21–15, 19–21*]");
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

  it("refuses a score that is no finished set AT ALL, before it walks anywhere", () => {
    // 19–15 is a live badminton game, not a result. This is a DIFFERENT
    // authoring error from 22–19 (which is over earlier) and it is caught by a
    // DIFFERENT half of the plan: the lattice endpoint has to be a CLOSED set,
    // not merely a reachable one.
    //
    // Found by the mutation sweep. Dropping that half survived the whole suite,
    // because the engine-checked postcondition after the walk caught it instead
    // and every existing test was satisfied by either message — two guards
    // covering for each other, and so neither one tested. The assertion below
    // pins the PLANNING refusal specifically: the postcondition's wording
    // ("asked for …, the fold banked … (still open)") does not match it.
    expect(() =>
      call([
        { home: 19, away: 15 },
        { home: 21, away: 10 },
      ]),
    ).toThrow(/no legal rally order reaches set 1's declared 19–15/);
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

  it("carries per-fixture LINEUPS through, and folds under the ones it generated under", () => {
    // `packLineupPair` reads `stream.lineups`, so the pair the generator folds
    // under is built from the draft — a caller attaching sheets to the RESULT
    // would generate under empty ones and validate under real ones. Before the
    // field existed the two agreed only because the field did not exist.
    const lineups = {
      home: [{ person: "p-ana", slot: "starting" as const, roles: [], pairOrder: 1 }],
      away: [{ person: "p-bo", slot: "starting" as const, roles: [], pairOrder: 1 }],
    };
    const stream = reconstructSetBasedStream({
      module: badminton,
      cfg: cfgFor(badminton, "bwf"),
      divisionRef: "d",
      fixtureExtKey: "fx",
      home: HOME,
      away: AWAY,
      rallyType: "badminton.rally",
      sets: SETS,
      seed: 5,
      lineups,
    });
    expect(stream.lineups).toEqual(lineups);
    // And the whole thing still folds green through the real validator, with
    // the two people the sheets name declared on the pack.
    const pack = badmintonPack(stream) as { persons: unknown[] };
    pack.persons = [
      { ref: "p-ana", fullName: "Ana Alvarez", lane: "player" },
      { ref: "p-bo", fullName: "Bo Baptiste", lane: "player" },
    ];
    const result = validatePack(pack, { expectedSuite: "_unit" });
    expect(errorsOf(result.findings)).toEqual([]);
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
    // declares, in the order the engine accepts them, ending at "FT". The WHOLE
    // sequence is pinned, not just the labels — WHICH PERIOD a goal was scored
    // in is the fact a period filler exists to preserve, and a filler that
    // dropped the inter-segment whistle would put every goal in Q1 while still
    // emitting these four labels at the end.
    expect(show(events)).toEqual([
      "core.start:{}",
      'hockey.goal:{"by":"@e-alpha","kind":"fg"}',
      'hockey.period.advance:{"to":"Q2"}',
      'hockey.period.advance:{"to":"Q3"}',
      'hockey.period.advance:{"to":"Q4"}',
      'hockey.goal:{"by":"@e-alpha","kind":"fg"}',
      'hockey.period.advance:{"to":"FT"}',
    ]);
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

  // ---------------------------------------------------------------------
  // The filler's ARBITRATION policy, which no shipped module can reach.
  //
  // Every module that ships accepts exactly one marker from any given phase
  // (football's `applyPeriod` and the period kernel's `applyAdvance` both
  // refuse every other), so three of the filler's refusals are unreachable
  // through a real sport — and an untested defensive branch is how a policy
  // quietly becomes "pick the first one". The minimal modules below implement
  // the same `SportModule` surface the filler consumes, so they exercise the
  // policy rather than a mirror of it. Found as survivors by the mutation
  // sweep.
  // ---------------------------------------------------------------------
  interface FakeOptions {
    readonly values?: readonly string[];
    readonly padSpec?: boolean;
    readonly decides?: boolean;
  }
  const fakeModule = (options: FakeOptions = {}): AnySportModule => {
    const values = options.values ?? ["a"];
    const base = {
      key: "fake",
      version: "1.0.0",
      init: () => ({ n: 0 }),
      apply: (state: { n: number }) => ({ n: state.n + 1 }),
      outcome: (state: { n: number }) =>
        options.decides === true && state.n > 2 ? { kind: "draw" } : null,
      summary: () => ({ headline: "", perSide: [] }),
    };
    if (options.padSpec === false) return base as unknown as AnySportModule;
    return {
      ...base,
      padSpec: () => ({
        panels: [
          {
            labelKey: { key: "p", label: "P" },
            phase: "live",
            layout: "grid",
            actions: [
              {
                type: "fake.marker",
                labelKey: { key: "a", label: "A" },
                fields: [{ kind: "enum", path: "to", values }],
                attribution: [],
              },
            ],
          },
        ],
        fidelity: {},
        fidelityEntitlements: {},
      }),
    } as unknown as AnySportModule;
  };

  it("REFUSES to pick when a module accepts more than one marker", () => {
    expect(() =>
      fillPeriodMarkers({
        module: fakeModule({ values: ["a", "b"] }),
        cfg: {},
        lineups: lineups(),
        markerType: "fake.marker",
        segments: [[], []],
      }),
    ).toThrow(/accepted 2 markers here/);
  });

  it("REFUSES an action declaring two top-level enums rather than guessing a cross product", () => {
    // The candidate builder names a marker by ONE enum. With two it would emit
    // payloads that each set only one of them — a partial payload the engine
    // refuses, degrading to a confusing "accepted none of". Which combination
    // is legal is a question no authored source answers, so it refuses.
    const twoEnums = {
      ...(fakeModule() as unknown as { padSpec: unknown }),
      padSpec: () => ({
        panels: [
          {
            labelKey: { key: "p", label: "P" },
            phase: "live",
            layout: "grid",
            actions: [
              {
                type: "fake.marker",
                labelKey: { key: "a", label: "A" },
                fields: [
                  { kind: "enum", path: "to", values: ["a"] },
                  { kind: "enum", path: "half", values: ["1"] },
                ],
                attribution: [],
              },
            ],
          },
        ],
        fidelity: {},
        fidelityEntitlements: {},
      }),
    } as unknown as AnySportModule;
    expect(() =>
      fillPeriodMarkers({
        module: twoEnums,
        cfg: {},
        lineups: lineups(),
        markerType: "fake.marker",
        segments: [[], []],
      }),
    ).toThrow(/declares 2 top-level enum fields \(\[to, half\]\)/);
  });

  it("refuses a module that declares no padSpec at all", () => {
    expect(() =>
      fillPeriodMarkers({
        module: fakeModule({ padSpec: false }),
        cfg: {},
        lineups: lineups(),
        markerType: "fake.marker",
        segments: [[], []],
      }),
    ).toThrow(/declares no padSpec/);
  });

  it("stops rather than filling for ever when markers never decide the match", () => {
    expect(() =>
      fillPeriodMarkers({
        module: fakeModule(),
        cfg: {},
        lineups: lineups(),
        markerType: "fake.marker",
        segments: [[]],
        maxTrailingMarkers: 3,
      }),
    ).toThrow(/still undecided after 3 trailing marker\(s\)/);
  });

  it("stops as soon as the module says the match is decided", () => {
    const events = fillPeriodMarkers({
      module: fakeModule({ decides: true }),
      cfg: {},
      lineups: lineups(),
      markerType: "fake.marker",
      segments: [[]],
      maxTrailingMarkers: 8,
    });
    // Three markers: the fake decides once its counter passes two, and the
    // loop asks the MODULE rather than counting periods itself.
    expect(events).toHaveLength(3);
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
