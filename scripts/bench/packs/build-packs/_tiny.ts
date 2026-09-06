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
// THREE divisions. `d-tiny` (the `generic` division) is CARRIED THROUGH AS A
// LITERAL: it is hand-authored history — see its own `meta.adaptations` below
// — not something this file re-derives. `d-badminton` is the first division
// built through the REAL generator, `reconstructSetBasedStream`
// (`lib/reconstruct.ts:651`), because badminton is set-based and its rally
// order was never archived (the reconstruction "honesty clause" — see that
// file's header). `d-registration` (B03r tasks 9+10) is the registration-ui
// smoke floor design §9 asks for — see its own block below for why it needs
// a stage AND two "shadow" entrants it never actually seeds.
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
  type PackRegistrationBlock,
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
// B04 T6 — venues, and the per-division scheduleConfig (design §7)
//
// `_tiny` declared NO venues at all until now: `suites/tiny.ts` created one
// venue and ONE court over HTTP itself, so nothing in the pack could name a
// court and design §3.3's court-double-booking rule had nowhere to fire. The
// pack is the one source from here on (`seedSuite` already seeds `pack.venues`,
// seed.ts:332-378) and the ad-hoc creation is deleted.
//
// TWO courts, not one, and that is the whole point of the number: a single
// court makes "two placed fixtures overlap on one courtId" unfalsifiable in
// one direction (every fixture is on the same court) and unreachable in the
// other, so the rule would report clean forever. Design §7 names the two.
// ---------------------------------------------------------------------------

const TINY_VENUE_REF = "v-tiny";
const TINY_COURT_REFS = ["c-tiny-1", "c-tiny-2"] as const;

/** B04 T7a: the competition's own three days, Thursday through Saturday
 *  (`2099-01-01`..`2099-01-03` is pinned as weekday 4/5/6 — see the task
 *  report). The court-hours rule keys on WEEKDAY, so a window authored for
 *  the wrong day would be exactly as vacuous as declaring none.
 *
 *  08:00-19:00, comfortably containing whatever a real run schedules onto
 *  these courts (it never runs past noon) — and DELIBERATELY narrower than
 *  `TINY_SCHEDULE_CONFIG.sessionWindows`' own 08:00-20:00 close, one hour
 *  short of it. That asymmetry (mirrored from `_board-fixtures.ts`'s own
 *  clean board) is what lets `checker.test.ts` move a fixture to 19:15 and
 *  breach ONLY court hours — inside the session window, outside its own
 *  court's calendar — rather than a same-bound pair that always breach
 *  together and can never isolate which rule actually caught it. */
const TINY_COURT_OPEN_MIN = 8 * 60;
const TINY_COURT_CLOSE_MIN = 19 * 60;
const TINY_COURT_WEEKDAYS = [4, 5, 6] as const;
const TINY_COURT_HOURS: NonNullable<PackInput["venues"]>[number]["courts"][number]["hours"] =
  TINY_COURT_WEEKDAYS.map((weekday) => ({
    weekday,
    openMin: TINY_COURT_OPEN_MIN,
    closeMin: TINY_COURT_CLOSE_MIN,
  }));

const TINY_VENUES: NonNullable<PackInput["venues"]> = [
  {
    ref: TINY_VENUE_REF,
    name: "Bench Tiny Venue",
    courts: [
      // B04 T7a: BOTH courts declare the SAME weekly hours (design §7's own
      // "the config is SHARED between the two divisions" reasoning, one
      // level down) — the checker's court-hours rule (2c) was vacuous
      // because no pack court had ever declared an `hours` row at all
      // (`PackCourt.hours` only became authorable in f71d7d5f0). Declaring it
      // on both, identically, is what makes "the schedule stays inside
      // hours" true by construction rather than by one court's window
      // agreeing with the other's by luck.
      { ref: TINY_COURT_REFS[0], name: "Court 1", sort: 1, hours: TINY_COURT_HOURS },
      { ref: TINY_COURT_REFS[1], name: "Court 2", sort: 2, hours: TINY_COURT_HOURS },
    ],
  },
];

/** The instant both scheduled divisions start at.
 *
 *  INSIDE the competition's own window (`2099-01-01`..`2099-01-03`):
 *  `usecases/schedule.ts` refuses a division whose schedule starts before its
 *  competition opens (`SCHEDULE_OUTSIDE_COMPETITION`), and the first live
 *  `_tiny` run ever made 422'd on exactly that with a wall-clock `Date.now() +
 *  24h`. Written as a literal here rather than derived from
 *  `competition.startsOn` because this file emits a COMMITTED artefact — a
 *  derived value would still be a literal in `_tiny.json`, and one that no
 *  longer says where it came from.
 *
 *  The trailing `Z` is load-bearing: `encodeConstraints` THROWS on an
 *  offsetless ISO date-time, because reading one against the host timezone
 *  would make the checker's oracle answer differently on a BST dev box and a
 *  UTC CI runner. */
const TINY_SCHEDULE_START_AT = "2099-01-01T09:00:00.000Z";

/** The `ScheduleConfig` both scheduled divisions get.
 *
 *  Shared rather than written twice: the two divisions have no reason to
 *  differ, and two copies is how the badminton half quietly stops being
 *  scheduled against the same courts the generic half is.
 *
 *  `courts` names the venue's courts by `@`-sigil — the pack cannot know the
 *  real UUIDs, which only exist once `seedSuite` has run. `pack-schema.ts`'s
 *  `checkReservations` resolves these against the DECLARED venues/courts at
 *  stage 0; `board.ts`'s `encodeConstraints` resolves them against the SEEDED
 *  ids at run time, and `schedule.ts` builds the config it PUTs from that one
 *  resolution rather than resolving a second time.
 *
 *  `gapMinutes: 0` is declared deliberately, not omitted: it lands in
 *  `EncodedConstraints.unmodelled` (a declared knob with no rule behind it —
 *  court occupancy is judged on `matchMinutes` alone, ruling R12), and that
 *  entry is what makes `_tiny`'s report exercise the "unchecked rendered
 *  BESIDE the verdict" requirement on a green run instead of only on a
 *  hypothetical one.
 *
 *  B04 T7a: `perEntrantMinRest`, `blackouts`, `sessionWindows` and
 *  `constraints.hard` were ALL declared vacuous values (`0`, `[]`, `[]`,
 *  absent) until this task — satisfied by construction on every board, never
 *  by the rule actually comparing anything. `_tiny` is the only pack this
 *  bench runs, so checker.ts's rules 2a/2b/2c/3/4 had never fired on a real
 *  input. The values below are chosen to clear the bar the task report names:
 *  satisfied by the schedule this pack actually produces AND violable by a
 *  wrong one (proved against a hand-built board in `checker.test.ts`, not
 *  merely reachable).
 *
 *   - `perEntrantMinRest: 15` — both `d-tiny` entrants play all three
 *     fixtures, so 15 minutes of turnaround between consecutive ones is a
 *     real, checkable floor rather than the `0` that made rule 3 vacuous.
 *     This fake's own scheduler bakes it into its slot spacing
 *     (`_schedule-routes.ts`).
 *   - `constraints.hard` — ONE `max_fixtures_per_day` rule, scoped
 *     `every_entrant` at `count: 2`. Fix round 1: `count: 3` (T7a's first
 *     cut) was satisfied by the schedule but pinned at the cap BY THE
 *     FIXTURE COUNT ITSELF — `d-tiny` has exactly 3 fixtures and both
 *     entrants play all of them, so no product defect could ever raise the
 *     figure to 4, and the only violating board `checker.test.ts` could
 *     build was a hand-added FOURTH fixture `_tiny` cannot produce. `count:
 *     2` forces the THIRD fixture onto a second calendar day on every real
 *     run, so `checker.test.ts` can now also red rule 4 using `_tiny`'s
 *     OWN three real fixtures placed on one day — the shape an actual
 *     defect would produce. The old fake could not honour this (it had no
 *     notion of "day" at all); `_schedule-routes.ts` was taught one, the
 *     same way it was taught the rest-aware pitch.
 *   - `sessionWindows` — TWO windows, day 1 and day 2 (both 08:00-20:00,
 *     wide enough to hold the whole working day rather than a box
 *     hand-fitted to wherever a fixture happened to land), because
 *     `count: 2` forces a fixture onto day 2 and the pack has to admit that
 *     day or it is infeasible rather than merely constrained. Day 3
 *     (`2099-01-03`) is deliberately left OFF this list — it is the region
 *     that still violates rule 2a. Both windows are WIDER than the courts'
 *     own 08:00-19:00 hours (see `TINY_COURT_CLOSE_MIN`'s comment) — the
 *     asymmetry is what lets a test isolate "outside court hours" from
 *     "outside the session window".
 *   - `blackouts` — one court-scoped window on day 1, `c-tiny-1`
 *     09:30-12:00. Fix round 1: the first cut (12:00-12:30) sat ninety
 *     minutes after this pack's own schedule ever runs, so nothing could
 *     land in it either way — "a blackout the solver would never have hit
 *     anyway proves nothing" is the task's own bar, and that draft failed
 *     it. `09:30`, not `09:00`: `d-tiny`'s FIRST fixture is unconditionally
 *     PINNED to `startAt` on this division's first declared court before
 *     `auto` ever runs (ruling R22, `resolveScheduleLocks` in
 *     `suites/tiny.ts`) — i.e. `c-tiny-1` at exactly `09:00`-`09:30` on
 *     every run, pin or no pin. A blackout starting at `09:00` would make
 *     the PINNED fixture itself the violation on every green run; `09:30`
 *     abuts it instead (half-open, same convention as
 *     `_board-fixtures.ts`'s own clean board), so the pin is UNTOUCHED and
 *     the window still sits inside the hours a real fixture can occupy.
 *
 *  THE EXACT SCHEDULE THAT SATISFIES ALL FIVE CONSTRAINTS AT ONCE — checked
 *  by hand against every one of them, and reproduced by this fake's own
 *  scheduler (`_schedule-routes.ts`) on a default run:
 *
 *    d-tiny   rr-r1-c1  2099-01-01 (Thu)  09:00  c-tiny-1   [pinned, R22]
 *    d-tiny   rr-r2-c1  2099-01-01 (Thu)  09:45  c-tiny-2
 *    d-tiny   rr-r3-c1  2099-01-02 (Fri)  09:00  c-tiny-1
 *    d-badminton rr-r1-c1 2099-01-01 (Thu) 11:15  c-tiny-2
 *
 *  Session windows: every start above falls inside its day's 08:00-20:00
 *  window. Court hours: every start (09:00/09:45/11:15 Thu, 09:00 Fri) falls
 *  inside 08:00-19:00 on a declared weekday. Blackout: `rr-r1-c1` on
 *  `c-tiny-1` occupies [09:00,09:30) and the blackout is [09:30,12:00) —
 *  abutting, not overlapping; `rr-r3-c1` is on `c-tiny-1` but day 2, outside
 *  the blackout's single dated instant range; neither of the other two ever
 *  touches `c-tiny-1`. Rest: `d-tiny`'s series is 09:00-09:30, 09:45-10:15,
 *  next-day 09:00 — gaps of exactly 15 minutes then a full day, both ≥15.
 *  Day cap (`every_entrant`, count 2): day 1 carries 2 `d-tiny` fixtures per
 *  entrant (at the cap, not over it) and 1 `d-badminton` fixture for its own
 *  two entrants; day 2 carries 1 `d-tiny` fixture. Nothing exceeds 2.
 *
 *  Rule 5 (`not_before`/`not_after`) stays DELIBERATELY unexercised — no
 *  `constraints.hard` entry of either type is declared here. `_tiny` is the
 *  only pack this bench runs, so if all eight rules went live, the checker's
 *  own "this rule had nothing to check" report section (`unchecked[]`) would
 *  have an empty list on every real run — a branch no live run could ever
 *  witness, which is the same vacuous-report trap one level up from the rules
 *  themselves. This mirrors `gapMinutes: 0` above: declared not to fire, on
 *  purpose, so the report's UNCHECKED section is exercised on a GREEN run
 *  rather than a hypothetical one. Do not "fix" this by adding a wall-clock
 *  bound — that would leave rule 5 the one uncovered by the same argument
 *  this comment makes for keeping it uncovered. */
const TINY_SCHEDULE_CONFIG: NonNullable<PackInput["divisions"][number]["scheduleConfig"]> = {
  startAt: TINY_SCHEDULE_START_AT,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: TINY_COURT_REFS.map((ref) => `@${ref}`),
  perEntrantMinRest: 15,
  blackouts: [
    { court: `@${TINY_COURT_REFS[0]}`, from: "2099-01-01T09:30:00.000Z", to: "2099-01-01T12:00:00.000Z" },
  ],
  sessionWindows: [
    { from: "2099-01-01T08:00:00.000Z", to: "2099-01-01T20:00:00.000Z" },
    { from: "2099-01-02T08:00:00.000Z", to: "2099-01-02T20:00:00.000Z" },
  ],
  constraints: {
    hard: [{ type: "max_fixtures_per_day", count: 2, scope: { kind: "every_entrant" } }],
  },
};

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
  // B04 T6 (design §7): BOTH scheduled divisions get one, and both are
  // scheduled. `_INDEX.md` recorded that `runTinySuite` drove
  // `divisions[0]`/`stages[0]` only and that B04 owned closing it; this
  // declaration plus `suites/tiny.ts`'s per-division loop is where it closes.
  scheduleConfig: TINY_SCHEDULE_CONFIG,
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
    what: "venues[] declares ONE venue with TWO courts, and BOTH scheduled divisions (d-tiny, d-badminton) carry the SAME scheduleConfig naming those courts by @-sigil. suites/tiny.ts's own ad-hoc one-venue/one-court HTTP creation is deleted; the pack is the one source.",
    why: "B04 design \u00a77. One court makes design \u00a73.3's court-double-booking rule unfalsifiable \u2014 every fixture sits on the same court, so the rule reports clean forever \u2014 which is exactly the vacuous-guard class this bench exists to catch. Two courts give it somewhere to happen. The config is SHARED between the two divisions rather than copied, so \"both divisions are scheduled onto the same courts\" is true by construction; gapMinutes: 0 is declared on purpose so the report carries a real EncodedConstraints.unmodelled entry and the \"unchecked beside the verdict\" rendering is exercised on a green run.",
    where: "venues[], divisions[0].scheduleConfig, divisions[1].scheduleConfig",
  },
  {
    what:
      "B04 T7a (fix round 1): both courts declare weekly `hours` (Thu/Fri/Sat 08:00-19:00), and the " +
      "shared scheduleConfig declares a real perEntrantMinRest (15), one blackout (c-tiny-1, day 1, " +
      "09:30-12:00), two session windows (day 1 and day 2, day 3 deliberately absent) and one " +
      "max_fixtures_per_day hard rule (count 2, scoped every_entrant) — every one of them previously a " +
      "vacuous sentinel (0 / [] / [] / no constraints.hard at all).",
    why:
      "checker.ts's rules 2a/2b/2c/3/4 could not fire on ANY input while _tiny, the only pack this " +
      "bench runs, declared sentinel values for all five — a green live run reported CLEAN having " +
      "measured half of what it claims. T7a's first cut used count: 3, pinned at the cap BY THE " +
      "FIXTURE COUNT ITSELF (both d-tiny entrants play exactly 3 fixtures) — no real defect could ever " +
      "exceed it, only a hand-added fourth fixture _tiny cannot produce. count: 2 forces the third " +
      "fixture onto a second day on every real run, so the cap is both satisfied by the live schedule " +
      "AND violable from _tiny's own three real fixtures (checker.test.ts proves both) — see " +
      "TINY_SCHEDULE_CONFIG's own comment for the full reasoning and the exact satisfying schedule. " +
      "Rule 5 stays deliberately vacuous: making all eight live would leave the report's own \"nothing " +
      "to check\" section empty on every real run — the same vacuous-report trap one level up.",
    where:
      "venues[0].courts[0].hours, venues[0].courts[1].hours, divisions[0].scheduleConfig, " +
      "divisions[1].scheduleConfig",
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
  // The SAME object d-tiny carries — see `TINY_SCHEDULE_CONFIG`. Sharing it
  // is what makes "both divisions are scheduled onto the same two courts"
  // true by construction rather than by two literals agreeing.
  scheduleConfig: TINY_SCHEDULE_CONFIG,
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
// d-registration — the registration-ui smoke floor (B03r tasks 9+10, design
// §9: "browser drivers have no meaningful unit test ... this is their
// floor").
//
// One FREE, `entry: "registration-ui"` division: 2 entries, `approval:
// "manual"`, 1 approve, no Stripe (task brief verbatim). `category: "open"`
// and `entrantKind: "individual"` are the simplest legal shapes that still
// exercise the funnel end to end without dragging in Stripe/category/roster
// machinery this floor was never asked to prove — that is B16's suite-13 job
// (design §5).
//
// TWO REAL constraints from files this task does NOT own collide here, and
// both are worth recording rather than rediscovering:
//
//   1. `checkEntrantDivisions` (pack-schema.ts) requires EVERY division —
//      registration-only or not — to declare at least two `entrants[]` rows.
//      There is no carve-out for `entry !== "admin"`. So this division
//      declares two ordinary-looking "shadow" entrants (`e-reg-*`) purely to
//      satisfy that minimum; `suites/tiny.ts` NEVER hands them to `seedSuite`
//      — the division's REAL entrants come from the registration funnel
//      (`register.ts`'s `runRegistrationDivision`), driven separately. A live
//      run therefore creates the division and its TWO registration entries,
//      but never POSTs these two shadow rows to `/entrants` at all.
//   2. `usecases/stages.ts:1141` refuses to `/generate` a stage with fewer
//      than two entrants — and this division's REAL entrant count is only
//      known once the funnel completes, long after `seedSuite`'s
//      create-then-generate walk would have already tried and failed. So
//      `suites/tiny.ts` excludes this division from the `SeedPlan` it hands
//      to `seedSuite` entirely (no `/divisions` POST, no `/stages` POST, no
//      `/generate` there) and creates + configures it itself, directly, via
//      `register.ts`'s own driver flow. `stages: PackDivision.stages.min(1)`
//      still requires ONE declared stage, kept here purely to satisfy that
//      shape rule — `s-registration`'s `kind: "knockout"` is deliberate:
//      `buildSeedPlan`'s `expectedFixtureCounts` only derives a count for a
//      `"league"` stage (`s.kind !== "league" => continue`,
//      `seed-plan.ts:476`), so a non-league kind here means this division
//      contributes NOTHING to that machinery — no fixture count to satisfy,
//      no round-robin arithmetic to keep honest, nothing for
//      `build-packs/__tests__/_tiny.test.ts`'s existing
//      `plan.expectedFixtureCounts` assertion to gain a third entry for. The
//      stage is NEVER created over HTTP in this session; nothing here claims
//      otherwise.
const REGISTRATION_DIVISION_REF = "d-registration";
const REGISTRATION_STAGE_REF = "s-registration";
const REGISTRATION_ENTRY_1 = "reg-cap1";
const REGISTRATION_ENTRY_2 = "reg-cap2";

const REGISTRATION_PERSONS: NonNullable<PackInput["persons"]> = [
  // Adult `dob` on BOTH: `checkRegistrationRequiresDobGender`
  // (validate-pack.ts) requires a dob for the captain of any
  // `entry:"registration-*"` INDIVIDUAL-kind entry (self-registers,
  // independent of any age band) — `register.ts`'s `buildRegistrationEntry`
  // sets `registeringSelf: true` unconditionally for that kind, and the
  // real API 400s any self-registering entry lacking `contact.dob`.
  { ref: "p-reg-priya", fullName: "Priya Kapoor", lane: "player", dob: "1990-03-14" },
  { ref: "p-reg-sami", fullName: "Sami Okafor", lane: "player", dob: "1988-11-02" },
];

/** The two "shadow" entrants — see this block's header comment, constraint
 *  1. Never sent to `POST /divisions/{id}/entrants` by a live run;
 *  `suites/tiny.ts` filters `divisionRef === REGISTRATION_DIVISION_REF`
 *  entrants out of the `SeedPlan` it hands to `seedSuite`. Exist only so
 *  `PackSchema`'s own `checkEntrantDivisions` (>=2 entrants per division,
 *  no exception for a registration division) accepts the pack. */
const REGISTRATION_SHADOW_ENTRANTS: PackInput["entrants"] = [
  {
    ref: "e-reg-priya",
    divisionRef: REGISTRATION_DIVISION_REF,
    kind: "individual",
    displayName: "Priya Kapoor",
    roster: [{ person: "p-reg-priya", captain: true }],
  },
  {
    ref: "e-reg-sami",
    divisionRef: REGISTRATION_DIVISION_REF,
    kind: "individual",
    displayName: "Sami Okafor",
    roster: [{ person: "p-reg-sami", captain: true }],
  },
];

const REGISTRATION_DIVISION: PackInput["divisions"][number] = {
  ref: REGISTRATION_DIVISION_REF,
  name: "Registration UI Proof",
  // Never folded (this division declares no streams) — `generic`/`score`
  // mirrors d-tiny's own choice rather than inventing a third pairing that
  // would mean nothing either way.
  sportKey: "generic",
  variantKey: "score",
  moduleVersion: "1.0.0",
  cfgOverrides: {},
  stages: [
    {
      ref: REGISTRATION_STAGE_REF,
      seq: 1,
      kind: "knockout",
      name: "Registration proof (never created over HTTP this session)",
      config: {},
    },
  ],
  entry: "registration-ui",
};

/** Design §4 / `PackRegistrationBlock`. Free (`feeCents: 0`, so `org.currency`
 *  stays unset — `checkCurrencyRequiredForFee` only fires for a priced
 *  division), `approval: "manual"`, 2 entries, exactly ONE `approve`
 *  organiser action (task brief verbatim: "2 entries ... 1 approve"). The
 *  entry NOT approved simply stays at its post-submit "pending" status,
 *  which `register.ts`'s `classifyFunnelOutcome` counts as `"entrant"`
 *  exactly like an approved one (`"pending" | "paid" | "confirmed"` all map
 *  to `"entrant"` — manual approval only ever produces a DIFFERENT
 *  classification via an explicit "reject") — so both entries declare
 *  `expect: "entrant"`, and the single `approve` action's job is to prove
 *  the organiser-action leg of the browser (or http) driver actually runs,
 *  not to change either entry's funnel bucket.
 */
const REGISTRATION_BLOCK: PackRegistrationBlock = {
  category: "open",
  entrantKind: "individual",
  feeCents: 0,
  // Free division, so nothing is collected either way — but the field is
  // required rather than defaulted here so the pack states its own answer.
  paymentMethod: "offline",
  approval: "manual",
  entries: [
    { extKey: REGISTRATION_ENTRY_1, captain: "p-reg-priya", roster: [], pay: false, expect: "entrant" },
    { extKey: REGISTRATION_ENTRY_2, captain: "p-reg-sami", roster: [], pay: false, expect: "entrant" },
  ],
  joins: [],
  organiser: [{ action: "approve", target: REGISTRATION_ENTRY_1 }],
  expect: { entrants: 2, waitlisted: 0, rejected: 0, paidCents: 0 },
};

const REGISTRATION_ADAPTATIONS: NonNullable<PackInput["meta"]["adaptations"]> = [
  {
    what:
      "d-registration declares two ordinary-shaped entrants[] rows (e-reg-priya, e-reg-sami) that a live run " +
      "NEVER creates over HTTP — they exist only to satisfy PackSchema's checkEntrantDivisions minimum (every " +
      "division needs >=2 declared entrants, with no carve-out for a registration-only division).",
    why:
      "This division's REAL entrants only exist once the registration funnel completes (register.ts), which " +
      "runs long after PackSchema parses. There is no PackSchema field meaning \"this division's entrant " +
      "minimum is satisfied by its registration block instead\", and adding one is a schema change outside " +
      "this task's file set (pack-schema.ts is frozen pre-B06 and owned by a completed task). suites/tiny.ts " +
      "filters divisionRef === \"d-registration\" out of the SeedPlan it hands to seedSuite, so these two rows " +
      "never reach /entrants.",
    where: "entrants[] (e-reg-priya, e-reg-sami), divisions[2]",
  },
  {
    what: "d-registration's one stage (s-registration) is never created over HTTP this session.",
    why:
      "usecases/stages.ts:1141 refuses to /generate a stage with fewer than two entrants, and this division's " +
      "real entrant count is only known after the registration funnel runs — after seedSuite's create-then-" +
      "generate walk would already have tried and failed. suites/tiny.ts excludes this division from " +
      "seedSuite's plan entirely and creates + configures it directly via register.ts's own driver flow " +
      "instead. The stage exists only because PackDivision.stages requires at least one; kind:\"knockout\" " +
      "keeps it out of buildSeedPlan's expectedFixtureCounts (league-only), so it changes nothing about the " +
      "existing fixture-count arithmetic the other two divisions already prove.",
    where: "divisions[2].stages[0]",
  },
  {
    what: "registration.byDivision[\"d-registration\"] declares exactly one organiser action (approve) though both entries expect:\"entrant\".",
    why:
      "The task brief's own acceptance line is \"2 entries, approval: manual, 1 approve\" — the unapproved " +
      "entry stays \"pending\", which register.ts's classifyFunnelOutcome counts as an entrant exactly like " +
      "an approved one (manual approval only produces a different classification via an explicit reject). The " +
      "single approve action proves the organiser-action leg of the driver runs; it is not needed to make the " +
      "funnel oracle's arithmetic balance.",
    where: "registration.byDivision[\"d-registration\"].organiser",
  },
];

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
    divisions: [TINY_DIVISION, BADMINTON_DIVISION, REGISTRATION_DIVISION],
    persons: [...TINY_PERSONS, ...BADMINTON_PERSONS, ...REGISTRATION_PERSONS],
    entrants: [...TINY_ENTRANTS, ...BADMINTON_ENTRANTS, ...REGISTRATION_SHADOW_ENTRANTS],
    streams: [...TINY_STREAMS, BADMINTON_STREAM],
    venues: TINY_VENUES,
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
    registration: { byDivision: { [REGISTRATION_DIVISION_REF]: REGISTRATION_BLOCK } },
    meta: {
      synthetic: true,
      sources: [],
      adaptations: [...(TINY_ADAPTATIONS ?? []), ...REGISTRATION_ADAPTATIONS],
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
