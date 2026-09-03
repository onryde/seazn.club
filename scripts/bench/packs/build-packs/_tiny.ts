// build-packs/_tiny.ts — regenerates `packs/_tiny.json` from source.
//
// Modelled on `scripts/openapi-gen.ts` (route contracts -> committed spec) and
// its CI drift gate (`.github/workflows/ci.yml:94-98`): a generator, a
// committed output, and a test that fails when the two disagree
// (`build-packs/__tests__/_tiny.test.ts`). NO CI step is wired here — that is
// out of B03's charter (task brief); the determinism test is the gate.
//
//   node --experimental-strip-types scripts/bench/packs/build-packs/_tiny.ts
//
// TWO divisions. `d-tiny` (the `generic` division) is CARRIED THROUGH AS A
// LITERAL: it is hand-authored history — see its own `meta.adaptations` below
// — not something this file re-derives. `d-badminton` is the first division
// built through the REAL generator, `reconstructSetBasedStream`
// (`lib/reconstruct.ts:651`), because badminton is set-based and its rally
// order was never archived (the reconstruction "honesty clause" — see that
// file's header).
//
// Runtime constraints (bench GLOBAL.md, unchanged): no TS `enum`, no
// `namespace`, no emit-dependent syntax — this runs under
// `node --experimental-strip-types`. Every relative import carries `.ts`.
// Engine imports are SUBPATH-only; nothing here imports from `apps/web` or
// `@seazn/engine/testkit` (that barrel drags in vitest + fast-check).
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { badminton, type SetBasedCfg } from "@seazn/engine/sports/setbased";
import {
  reconstructSetBasedStream,
  type ReconstructedSet,
} from "../../lib/reconstruct.ts";
import { resolveDivisionCfg } from "../../lib/validate-pack.ts";
import {
  PackSchema,
  type PackStage,
} from "../../lib/pack-schema.ts";

/** The shape a pack AUTHOR writes — every `.default(...)` field optional, the
 *  way `_tiny.json` has always been hand-authored (no `divisions[].entry`, no
 *  `entrants[].roster[].roles`, ...). Parsing is left to the CONSUMER (the
 *  test, and eventually stage 0) — this file never calls `PackSchema.parse`
 *  itself, because a parse fills every default onto the object and printing
 *  THAT would silently change the committed file's shape out from under the
 *  hand-authored d-tiny division it is meant to carry through unchanged. */
type PackInput = z.input<typeof PackSchema>;

// ---------------------------------------------------------------------------
// d-tiny — the generic division, carried through as a literal.
//
// Every value below is copied verbatim from the `_tiny.json` this generator
// replaces (B02 task 3's hand-authored fixture). Nothing here is re-derived:
// the reconstructed stream (`rr-r2-c1`) was hand-written before task 3's
// generators existed and stays hand-written now, exactly as its own
// `meta.adaptations` entry says.
// ---------------------------------------------------------------------------

const TINY_DIVISION: PackInput["divisions"][number] = {
  ref: "d-tiny",
  name: "Tiny",
  sportKey: "generic",
  variantKey: "score",
  moduleVersion: "1.0.0",
  cfgOverrides: {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  },
  tiebreakers: ["points", "diff"],
  stages: [
    {
      ref: "s-league",
      seq: 1,
      kind: "league",
      name: "League",
      config: { legs: 3 },
      seeding: ["e-alpha", "e-bravo"],
    },
  ],
};

const TINY_PERSONS: NonNullable<PackInput["persons"]> = [
  { ref: "p-ana", fullName: "Ana Alvarez", lane: "player", shortName: "A. Alvarez" },
  { ref: "p-bo", fullName: "Bo Baptiste", lane: "player", shortName: "B. Baptiste" },
  { ref: "p-dee", fullName: "Dee Duarte", lane: "official" },
  // B03 T6: the SECOND official-lane person — Dee is the MANUAL official
  // below (a named `assignments` entry), Eli is left to `autoAssignOfficials`
  // (no `assignments` at all). One of each closes both `officials[]`
  // assignment paths pack-schema.ts:768-769 distinguishes.
  { ref: "p-eli", fullName: "Eli Ostrander", lane: "official" },
];

const TINY_ENTRANTS: PackInput["entrants"] = [
  {
    ref: "e-alpha",
    divisionRef: "d-tiny",
    kind: "individual",
    displayName: "Ana Alvarez",
    seed: 1,
    roster: [{ person: "p-ana", captain: true, squadNumber: 1 }],
  },
  {
    ref: "e-bravo",
    divisionRef: "d-tiny",
    kind: "individual",
    displayName: "Bo Baptiste",
    seed: 2,
    roster: [{ person: "p-bo", captain: true, squadNumber: 2 }],
  },
];

const TINY_STREAMS: NonNullable<PackInput["streams"]> = [
  {
    divisionRef: "d-tiny",
    fixtureExtKey: "rr-r1-c1",
    home: "e-alpha",
    away: "e-bravo",
    provenance: "real",
    events: [
      { type: "core.start" },
      { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } },
    ],
  },
  {
    divisionRef: "d-tiny",
    fixtureExtKey: "rr-r2-c1",
    home: "e-bravo",
    away: "e-alpha",
    provenance: "reconstructed",
    events: [
      { type: "core.start" },
      { type: "generic.score", payload: { by: "@e-bravo", points: 2, person: "@p-bo" } },
      { type: "generic.score", payload: { by: "@e-alpha", points: 1, person: "@p-ana" } },
      { type: "generic.score", payload: { by: "@e-alpha", points: 1, person: "@p-ana" } },
      { type: "generic.result" },
    ],
  },
  {
    divisionRef: "d-tiny",
    fixtureExtKey: "rr-r3-c1",
    home: "e-alpha",
    away: "e-bravo",
    provenance: "real",
    events: [
      { type: "core.start" },
      { type: "core.forfeit", payload: { by: "@e-bravo", reason: "retired hurt" } },
    ],
  },
];

const TINY_MATCHES: NonNullable<PackInput["expected"]["matches"]> = [
  {
    divisionRef: "d-tiny",
    fixtureExtKey: "rr-r1-c1",
    outcome: { kind: "win", winner: "e-alpha", loser: "e-bravo", method: "regulation" },
    perSide: [
      { entrant: "e-alpha", line: "3" },
      { entrant: "e-bravo", line: "1" },
    ],
  },
  {
    divisionRef: "d-tiny",
    fixtureExtKey: "rr-r2-c1",
    outcome: { kind: "draw" },
    perSide: [
      { entrant: "e-bravo", line: "2" },
      { entrant: "e-alpha", line: "2" },
    ],
  },
  {
    divisionRef: "d-tiny",
    fixtureExtKey: "rr-r3-c1",
    outcome: { kind: "award", winner: "e-alpha" },
    perSide: [
      { entrant: "e-alpha", line: "W/O" },
      { entrant: "e-bravo", line: "L" },
    ],
  },
];

const TINY_TABLES: NonNullable<PackInput["expected"]["tables"]> = [
  {
    divisionRef: "d-tiny",
    stageRef: "s-league",
    rows: [
      { entrant: "e-alpha", rank: 1, played: 3, won: 2, drawn: 1, lost: 0, points: 7 },
      { entrant: "e-bravo", rank: 2, played: 3, won: 0, drawn: 1, lost: 2, points: 1 },
    ],
  },
];

const TINY_CHAMPIONS: NonNullable<PackInput["expected"]["champions"]> = [
  { divisionRef: "d-tiny", entrant: "e-alpha" },
];

const TINY_LEADERBOARDS: NonNullable<PackInput["expected"]["leaderboards"]> = [
  {
    divisionRef: "d-tiny",
    metricKey: "scores",
    entries: [
      { person: "p-ana", name: "Ana Alvarez", count: 2 },
      { person: "p-bo", name: "Bo Baptiste", count: 1 },
    ],
  },
  {
    divisionRef: "d-tiny",
    metricKey: "points",
    entries: [
      { person: "p-ana", name: "Ana Alvarez", count: 2 },
      { person: "p-bo", name: "Bo Baptiste", count: 2 },
    ],
  },
];

const TINY_SPECIALS: NonNullable<PackInput["expected"]["specials"]> = [
  {
    kind: "retirement",
    divisionRef: "d-tiny",
    fixtureExtKey: "rr-r3-c1",
    note:
      "Bravo retires hurt; the match is awarded to Alpha. Asserted against the FOLDED outcome, " +
      "because a retirement has no event type of its own — it is the CORE type core.forfeit.",
    claims: [
      { on: "outcome", kind: "award", winner: "e-alpha" },
      { on: "state", path: "phase", equals: "done" },
      { on: "standings", entrant: "e-alpha", field: "won", equals: 1 },
      { on: "standings", entrant: "e-bravo", field: "lost", equals: 1 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Officials + claim invites (B03 T6, bench design §9 P1/P2). Both target
// d-tiny — the division `runTinySuite` already knows how to drive to real
// fixtures — never d-badminton, which keeps this addition orthogonal to T5's.
// ---------------------------------------------------------------------------

const TINY_OFFICIALS: NonNullable<PackInput["officials"]> = [
  {
    ref: "off-dee",
    person: "p-dee",
    displayName: "Dee Duarte",
    roleKeys: ["referee"],
    unavailable: [{ date: "2099-01-02", note: "family commitment" }],
    // MANUAL: a named assignment, so `seedOfficialsAndClaims` PATCHes her
    // onto rr-r1-c1 directly rather than leaving her to auto-assign
    // (pack-schema.ts:768-769's own rule).
    assignments: [{ divisionRef: "d-tiny", fixtureExtKey: "rr-r1-c1", roleKey: "referee" }],
  },
  {
    ref: "off-eli",
    person: "p-eli",
    displayName: "Eli Ostrander",
    roleKeys: ["referee"],
    // AUTO: no named assignment — left to `autoAssignOfficials`, the pack's
    // OTHER assignment path.
    unavailable: [],
    assignments: [],
  },
];

const TINY_CLAIM_INVITES: NonNullable<PackInput["claimInvites"]> = [
  // One star per division — proves the seeding layer's claim-invite mapping
  // generalises past a single division, the same reason T5 added d-badminton
  // to buildSeedPlan's own coverage.
  { person: "p-ana", email: "ana.alvarez.claim@example.com" },
  { person: "p-cho", email: "cho.minjun.claim@example.com" },
];

const TINY_ADAPTATIONS: PackInput["meta"]["adaptations"] = [
  {
    what: "The whole pack is invented. There is no historical tournament behind it, which is why meta.synthetic is true and meta.sources is empty.",
    why: "_tiny is the shared fixture the pack validator (B02 task 2) and the _tiny runner suite (B02 task 3) both prove themselves on. Binding it to a real event would make every future edit an archival research task, and a two-entrant three-game series has no real-world analogue worth citing.",
    where: "the whole file",
  },
  {
    what: "Per-stream provenance describes how each stream was AUTHORED inside this fixture, not correspondence to a real event.",
    why: "The bench's provenance doctrine ('real' vs 'reconstructed', never disguised) is a property of the stream's authoring method. In a synthetic pack 'real' means the stream IS the authored ground truth and 'reconstructed' means it was built to fold to a target score — which is exactly the distinction the validator and the report need to exercise.",
    where: "streams[1]",
  },
  {
    what: "The reconstructed d-tiny stream (rr-r2-c1) is hand-written and therefore carries no reconstruction.seed.",
    why: "Task 3 owns the deterministic generators; this file must not wait on them. A generated stream carries its seed so the same bytes come out on every machine. (B03 T5 adds the SECOND division, d-badminton, whose stream IS generated and DOES carry a seed — see streams[3].)",
    where: "streams[1].reconstruction",
  },
  {
    what: "Each stream declares its own home/away entrants rather than leaving them to be re-derived from the round-robin generator.",
    why: "foldMatch takes LineupPair as a required argument, and generic.result maps p1Score to HOME (sports/generic/generic.ts:113-114) while a multi-leg round robin mirrors home/away on even legs (scheduling/roundrobin.ts). rr-r2-c1 is leg 2, so its sides ARE swapped: without a declaration, the same payload would name a different winner depending on a generator this pack never mentions. B03 should assert the seeded fixture's sides match these.",
    where: "streams[].home / streams[].away",
  },
  {
    what: "The expected table omits per-entrant metrics (for/against/diff).",
    why: "How the competition layer AGGREGATES a StandingsDelta's metrics across fixtures is verified by the stage-0 validator (task 2), not authored blind here. Points, played, won, drawn and lost are derivable from the module's own standingsDelta and are asserted.",
    where: "expected.tables[0].rows",
  },
  {
    what: "d-badminton is a SECOND division, added by B03 T5 to exercise the two-division generalisation `buildSeedPlan` unlocked once `tinyPlan`'s divisions.length !== 1 refusal was deleted (T4).",
    why: "A synthetic fixture proves nothing about the real generalisation; a second real division in the shared pack does. badminton.rally is the only one of badminton's six declared eventSchemas that any shipped preset's padSpec actually exposes to a scorer — the other five (game.summary, timeout, sanction, sub, expedite.start) are either coarse-tier-only or unreachable, so it is the only legal choice for a reconstructed rally stream (see `assertDeclaresEventType`, lib/reconstruct.ts:172-180).",
    where: "divisions[1], streams[3], expected.matches[3], expected.tables[1]",
  },
  {
    what: "This whole file is now a GENERATED artefact — see build-packs/_tiny.ts. It is committed anyway (as openapi/v1.json is) so a pack consumer never needs to run the generator to read it, and so drift between the generator and the committed bytes is a mechanical, testable fact rather than an assertion.",
    why: "build-packs/_tiny.ts is modelled on scripts/openapi-gen.ts's generator/committed-output/drift-test pattern. B03's charter does not include a CI step for it (unlike the OpenAPI gate at .github/workflows/ci.yml:94-98); the determinism test under build-packs/__tests__ is the gate for now.",
    where: "the whole file",
  },
  {
    what: "officials[] declares TWO officials against d-tiny only: off-dee (a named assignment onto rr-r1-c1 — MANUAL) and off-eli (no assignments at all — left to autoAssignOfficials). p-eli is a NEW official-lane person added alongside the already-declared, previously-unused p-dee — B03 T6 closes that dangling ref by giving it an official row at last.",
    why: "pack-schema.ts's own comment on PackOfficial (\"an official with named assignments is manual, one without is left to autoAssignOfficials\") names both paths; one official can only ever prove one of them. d-badminton was deliberately left out — this addition is orthogonal to T5's, and mixing the two would make a failure here harder to attribute.",
    where: "officials[]",
  },
  {
    what: "claimInvites[] carries two entries, one per division's own star (p-ana from d-tiny, p-cho from d-badminton) — minted, never accepted (B03 §5: \"the accept flow is B05's, seeding only mints invites\").",
    why: "Bench design §9 P2: \"pc_ claim invites for ~3 stars/suite\". Two is enough for _tiny to prove the mapping generalises across divisions without inflating a fixture whose whole point is staying small.",
    where: "claimInvites[]",
  },
];

// ---------------------------------------------------------------------------
// d-badminton — generated through the real reconstruction path.
//
// bwf, straight games (2-0): the FIRST enumerated corner in
// `lib/__tests__/reconstruct.test.ts`'s own SCENARIOS table
// ("badminton bwf — straight games"), already proven to fold correctly
// through `foldMatchWithStoppage` there. Reused rather than invented, for the
// same reason the generic division above is carried through rather than
// rewritten: a proven target is a proven target.
// ---------------------------------------------------------------------------

const BADMINTON_DIVISION_REF = "d-badminton";
const BADMINTON_STAGE_REF = "s-badminton-league";
const BADMINTON_HOME = "e-cho";
const BADMINTON_AWAY = "e-dahl";
// `rr-r{round}-c{court}` — the product's OWN round-robin fixture-id format
// (`packages/engine/src/scheduling/roundrobin.ts:138`), sport-agnostic. Two
// entrants over one leg is one round, one court: "rr-r1-c1". Legal alongside
// d-tiny's OWN "rr-r1-c1" (streams[0]) because an ext_key is unique per
// DIVISION, never globally (pack-schema.ts's `checkStreams` comment) — and
// it has to be this, not an invented "bm-..." key, because
// `seedSuite`/`bindStreamFixtures` (lib/seed.ts) binds a stream to whatever
// ext_key the REAL `/generate` response actually returns, and that response
// never varies by sport.
const BADMINTON_FIXTURE = "rr-r1-c1";

/** A stable literal, never `Date.now()` / `Math.random()` — see
 *  lib/reconstruct.ts's own "DETERMINISM" header note. Recorded onto the
 *  emitted stream's `reconstruction.seed` so the same bytes come out on every
 *  machine that reruns this generator. */
const BADMINTON_SEED = 11;

const BADMINTON_SETS: readonly ReconstructedSet[] = [
  { home: 21, away: 15 },
  { home: 21, away: 18 },
];

const badmintonCfg = resolveDivisionCfg(badminton, { variantKey: "bwf", cfgOverrides: {} });
if (!badmintonCfg.ok) {
  throw new Error(`badminton "bwf" cfg failed to resolve: ${JSON.stringify(badmintonCfg)}`);
}

/** The STAGE OBJECT, not its ref — see `ReconstructSetBasedStreamInput.stage`'s
 *  own doc comment (lib/reconstruct.ts:596-645): passing the ref alone once
 *  let the generator and the validator apply different cfg overlays. This is
 *  the same object embedded into `BADMINTON_DIVISION.stages` below, so the
 *  two can never drift apart. */
const BADMINTON_STAGE: PackStage = {
  ref: BADMINTON_STAGE_REF,
  seq: 1,
  kind: "league",
  name: "Badminton League",
  config: { legs: 1 },
  seeding: [BADMINTON_HOME, BADMINTON_AWAY],
};

const BADMINTON_STREAM = reconstructSetBasedStream({
  module: badminton,
  cfg: badmintonCfg.cfg,
  divisionRef: BADMINTON_DIVISION_REF,
  stage: BADMINTON_STAGE,
  fixtureExtKey: BADMINTON_FIXTURE,
  home: BADMINTON_HOME,
  away: BADMINTON_AWAY,
  rallyType: "badminton.rally",
  sets: BADMINTON_SETS,
  seed: BADMINTON_SEED,
});

const BADMINTON_PERSONS: NonNullable<PackInput["persons"]> = [
  { ref: "p-cho", fullName: "Cho Min-jun", lane: "player", shortName: "C. Min-jun" },
  { ref: "p-dahl", fullName: "Dahl Erik", lane: "player", shortName: "D. Erik" },
];

const BADMINTON_ENTRANTS: PackInput["entrants"] = [
  {
    ref: BADMINTON_HOME,
    divisionRef: BADMINTON_DIVISION_REF,
    kind: "individual",
    displayName: "Cho Min-jun",
    seed: 1,
    roster: [{ person: "p-cho", captain: true, squadNumber: 1 }],
  },
  {
    ref: BADMINTON_AWAY,
    divisionRef: BADMINTON_DIVISION_REF,
    kind: "individual",
    displayName: "Dahl Erik",
    seed: 2,
    roster: [{ person: "p-dahl", captain: true, squadNumber: 1 }],
  },
];

const BADMINTON_DIVISION: PackInput["divisions"][number] = {
  ref: BADMINTON_DIVISION_REF,
  name: "Badminton",
  sportKey: badminton.key,
  variantKey: "bwf",
  moduleVersion: badminton.version,
  cfgOverrides: {},
  // The module's own official cascade (doc 05 §4), read off the module
  // rather than typed in twice — pack-schema.ts's own bidirectional
  // compile-check (`TIEBREAKER_KEYS_ARE_ENGINE_KEYS`) is what makes this
  // legal on a pack.
  tiebreakers: badminton.defaultTiebreakers,
  stages: [BADMINTON_STAGE],
};

// bestOf 3, straight games: home wins 2-0. `badminton`'s `pointsMap` default
// is `{"*": [2, 0]}` (packages/engine/src/sports/setbased/badminton.ts:23),
// so the winner's standings row is 2 points for 1 win, the loser's is 0 for a
// loss — read off the RESOLVED cfg (the same object the stream folds under,
// `badmintonCfg.cfg` above) rather than typed in blind. `SetBasedCfg` is the
// module family's own public cfg shape (`@seazn/engine/sports/setbased`).
const badmintonResolvedCfg = badmintonCfg.cfg as SetBasedCfg;
const BADMINTON_WIN_POINTS = badmintonResolvedCfg.pointsMap["*"];
if (BADMINTON_WIN_POINTS === undefined) {
  throw new Error('badminton "bwf" cfg declares no pointsMap["*"] entry');
}
const [BADMINTON_WINNER_POINTS, BADMINTON_LOSER_POINTS] = BADMINTON_WIN_POINTS;

const BADMINTON_MATCH: NonNullable<PackInput["expected"]["matches"]>[number] = {
  divisionRef: BADMINTON_DIVISION_REF,
  fixtureExtKey: BADMINTON_FIXTURE,
  outcome: { kind: "win", winner: BADMINTON_HOME, loser: BADMINTON_AWAY, method: "regulation" },
  perSide: [
    { entrant: BADMINTON_HOME, line: "2" },
    { entrant: BADMINTON_AWAY, line: "0" },
  ],
};

const BADMINTON_TABLE: NonNullable<PackInput["expected"]["tables"]>[number] = {
  divisionRef: BADMINTON_DIVISION_REF,
  stageRef: BADMINTON_STAGE_REF,
  rows: [
    {
      entrant: BADMINTON_HOME,
      rank: 1,
      played: 1,
      won: 1,
      drawn: 0,
      lost: 0,
      points: BADMINTON_WINNER_POINTS,
    },
    {
      entrant: BADMINTON_AWAY,
      rank: 2,
      played: 1,
      won: 0,
      drawn: 0,
      lost: 1,
      points: BADMINTON_LOSER_POINTS,
    },
  ],
};

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildTinyPack(): PackInput {
  return {
    schemaVersion: 1,
    suite: "_tiny",
    org: {
      name: "Bench Tiny Club",
      slug: "bench-tiny-club",
      timezone: "UTC",
    },
    competition: {
      name: "Bench Tiny Series",
      slug: "bench-tiny-series",
      startsOn: "2099-01-01",
      endsOn: "2099-01-03",
      description:
        "The bench's own proof fixture: the smallest pack that still exercises every part of PackSchema.",
    },
    divisions: [TINY_DIVISION, BADMINTON_DIVISION],
    persons: [...TINY_PERSONS, ...BADMINTON_PERSONS],
    entrants: [...TINY_ENTRANTS, ...BADMINTON_ENTRANTS],
    streams: [...TINY_STREAMS, BADMINTON_STREAM],
    officials: TINY_OFFICIALS,
    claimInvites: TINY_CLAIM_INVITES,
    expected: {
      matches: [...TINY_MATCHES, BADMINTON_MATCH],
      tables: [...TINY_TABLES, BADMINTON_TABLE],
      champions: TINY_CHAMPIONS,
      leaderboards: TINY_LEADERBOARDS,
      suspensions: [],
      specials: TINY_SPECIALS,
    },
    meta: {
      synthetic: true,
      sources: [],
      adaptations: TINY_ADAPTATIONS,
    },
  };
}

/** The exact bytes the committed `_tiny.json` must equal. `JSON.stringify`
 *  (never a hand-rolled printer) is what makes "byte-identical" a mechanical
 *  fact rather than a maintained one: key order is object-insertion order,
 *  which the literals above fix, and there is exactly one place that decides
 *  indentation. */
export function buildTinyPackJson(): string {
  return JSON.stringify(buildTinyPack(), null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// CLI entry point — only when this file is run directly, never on import.
// `build-packs/__tests__/_tiny.test.ts` imports `buildTinyPackJson` above
// with no file-write side effect; this guard is what keeps the two apart.
// ---------------------------------------------------------------------------

const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "_tiny.json");
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  writeFileSync(outPath, buildTinyPackJson());
  console.log(`wrote ${outPath}`);
}
