// build-packs/suite11.ts — regenerates `packs/suite11.json` from the two
// committed research datasets under `data/`.
//
//   node --experimental-strip-types scripts/bench/packs/build-packs/suite11.ts
//
// Suite 11 — "PDC Worlds". Two `generic` divisions from primary-source darts
// results: the 2025 PDC World Championship encoded at SET granularity, and PDC
// Women's Series 2024 Event 1 at LEG granularity. Same module, a real
// granularity contrast (B06 design D1).
//
// Three things here are load-bearing and easy to get wrong. Each is pinned by
// a test in `__tests__/suite11.test.ts`.
//
// 1. THE ENGINE DERIVES THE SCORE, NOT THE PACK. A stream is `core.start`, one
//    `generic.score` per set (or leg) won, then an EMPTY `generic.result`.
//    `applyResult` (generic.ts:110-114) settles from the running tally when the
//    card carries no scores. Putting p1Score/p2Score on that card would hand
//    the engine the answer and make `expected.matches` compare the pack
//    against itself — the exact tautology `_RULES.md` §3 forbids.
//
// 2. FIXTURE EXT KEYS BELONG TO THE PRODUCT. A knockout stage generates
//    `se-r{round}-i{index}` (bracket.ts:170, :197). The pack cannot mint its
//    own, so the bracket is reconstructed here by descending from the final
//    and the generated key is computed from each match's slot span.
//
// 3. `slotOrder` IS A LIST OF SEED NUMBERS, NOT ENTRANT IDS (bracket.ts:135-152).
//    It resolves through `seedOrder` (roundrobin.ts:62), which falls back to
//    INPUT ORDER for unseeded entrants — something a pack cannot control. So
//    every entrant here carries a distinct seed, which makes the draw a pure
//    function of this file. The real PDC seeds keep 1..32; the rest are
//    authoring artifacts, declared in `meta.adaptations`.
//
// Runtime constraints (bench GLOBAL.md): no TS `enum`, no `namespace`, no
// emit-dependent syntax; every relative import carries `.ts`; engine imports
// are SUBPATH-only; nothing here imports from `apps/web`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PackSchema } from "../../lib/pack-schema.ts";

/** The shape a pack AUTHOR writes — every `.default(...)` field optional.
 *  Parsing is left to the CONSUMER (the test, and stage 0): a parse fills
 *  every default onto the object, and printing THAT would change the
 *  committed file's shape. Same reasoning as `_tiny.ts`. */
type PackInput = z.input<typeof PackSchema>;
type StageInput = NonNullable<PackInput["divisions"]>[number]["stages"][number];
type StreamInput = NonNullable<PackInput["streams"]>[number];
type EventInput = StreamInput["events"][number];
type ExpectedMatchInput = NonNullable<PackInput["expected"]["matches"]>[number];
type HistoricalInput = NonNullable<PackInput["historicalAssignment"]>[number];
type CourtHoursInput = NonNullable<NonNullable<PackInput["venues"]>[number]["courts"][number]["hours"]>[number];

// ---------------------------------------------------------------------------
// The datasets
// ---------------------------------------------------------------------------

interface WorldsMatch {
  round: string;
  matchNo: number;
  date: string;
  session: string | null;
  p1: string;
  p2: string;
  setsP1: number | null;
  setsP2: number | null;
  setScores: string[] | null;
  walkover: boolean;
  notes: string | null;
  winner?: string;
}

interface WomensMatch {
  round: string;
  matchNo: number;
  p1: string;
  p2: string | null;
  legsP1: number | null;
  legsP2: number | null;
  walkover: boolean;
  board?: number;
  startTime?: string;
  endTime?: string;
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./data/${file}`, import.meta.url)), "utf8")) as T;
}

const WORLDS = load<{
  meta: { sources: string[]; fetchedOn: string };
  roundFormat: { round: string; label: string; bestOfSets: number }[];
  seeds: { seed: number; name: string }[];
  field: { name: string }[];
  matches: WorldsMatch[];
  sessions: { date: string; session: string | null; matches?: number[]; noPlay?: boolean }[];
}>("suite11-pdc-worlds-2025.json");

const WOMENS = load<{
  meta: { eventChosen: string; eventDate: string; venue: string; sources: string[]; fetchedOn: string };
  roundFormat: { round: string; label: string; bestOfLegs: number }[];
  field: { name: string }[];
  matches: WomensMatch[];
}>("suite11-pdc-womens-series-2024.json");

const WORLDS_ROUNDS = ["R1", "R2", "R3", "R4", "QF", "SF", "F"];
const WOMENS_ROUNDS = ["R1", "R2", "R3", "R4", "QF", "SF", "F"];

const DIV_A = "d-worlds";
const DIV_B = "d-womens";
const STAGE_A = "s-worlds-main";
const STAGE_B = "s-womens-main";

// ---------------------------------------------------------------------------
// Refs — ONE authority, so a name in both divisions maps to ONE person
// ---------------------------------------------------------------------------

/** Diacritic-stripping slug. Deterministic and stable: refs are the join key
 *  between persons, entrants, streams and every expected block, so a change
 *  here rewrites the whole pack. */
function slug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function personRef(name: string): string {
  return `p-${slug(name)}`;
}

/** Entrant refs are division-scoped BECAUSE two entrants can share a person:
 *  Fallon Sherrock and Noa-Lynn van Leuven each play both divisions, and that
 *  is precisely what gives the careers oracle a cross-division subject. */
export function entrantRef(division: "a" | "b", name: string): string {
  return `e-${division}-${slug(name)}`;
}

// ---------------------------------------------------------------------------
// The bracket — reconstructed by descending from the final
// ---------------------------------------------------------------------------

export interface BracketShape {
  /** 128 entries in bracket order; `null` is a bye slot. */
  readonly slots: (string | null)[];
  /** Match identity (`round:matchNo`) -> the product's generated ext key. */
  readonly extKeyByMatch: Map<string, string>;
}

const matchId = (m: { round: string; matchNo: number }): string => `${m.round}:${m.matchNo}`;

/**
 * Rebuild the real bracket TOPOLOGY from the results, then read the product's
 * fixture keys off it.
 *
 * Why this is legitimate rather than a reconstruction: who played whom, and
 * who therefore met whom in the next round, is published. Only the draw
 * sheet's absolute top-to-bottom ORIENTATION is a convention, and nothing in
 * the bench depends on it. A `byeEntrants` list would instead let the PRODUCT
 * choose the pairings (bracket.ts:120-122 reorders and falls back to
 * `seedPositions`), which would pair players who never met while the pack
 * still asserted the real results — ninety-five wrong answers from one
 * config choice.
 *
 * The descent also yields the ext keys, because a match's key is fixed by its
 * slot span: round `r`'s fixture `i` owns slots `[i·2^(r+1), (i+1)·2^(r+1))`.
 */
export function reconstructBracket<M extends { round: string; matchNo: number; p1: string; p2: string | null }>(
  matches: readonly M[],
  rounds: readonly string[],
  winnerOf: (m: M) => string,
  size: number,
): BracketShape {
  const finalRound = rounds[rounds.length - 1];
  const finals = matches.filter((m) => m.round === finalRound);
  if (finals.length !== 1) throw new Error(`expected exactly one ${finalRound}, got ${finals.length}`);

  /** Per round: winner name -> the match they won. A bye row (p2 null) is
   *  included deliberately — expanding it yields `[p1, null]`, which is the
   *  same pair the bye slot needs, so byes need no special case. */
  const winnerToMatch: Map<string, M>[] = rounds.map((r) => {
    const map = new Map<string, M>();
    for (const m of matches.filter((x) => x.round === r)) {
      const w = winnerOf(m);
      if (map.has(w)) throw new Error(`${w} wins two matches in ${r}`);
      map.set(w, m);
    }
    return map;
  });

  const extKeyByMatch = new Map<string, string>();

  function expand(m: M, roundIdx: number, slotStart: number): (string | null)[] {
    const width = 2 ** (roundIdx + 1);
    if (slotStart % width !== 0) throw new Error(`slot ${slotStart} is not aligned to width ${width}`);
    extKeyByMatch.set(matchId(m), `se-r${roundIdx}-i${slotStart / width}`);
    if (roundIdx === 0) return [m.p1, m.p2];
    const half = width / 2;
    const out: (string | null)[] = [];
    let offset = 0;
    for (const side of [m.p1, m.p2]) {
      if (side === null) throw new Error(`${matchId(m)} has a null side above round 0`);
      const feeder = winnerToMatch[roundIdx - 1].get(side);
      if (feeder !== undefined) {
        out.push(...expand(feeder, roundIdx - 1, slotStart + offset));
      } else {
        // The side enters the draw here rather than winning its way in — a
        // bye. Legal only at the declared entry round; anywhere else it means
        // the bracket does not reconcile and the pack must not be built.
        if (roundIdx !== 1) {
          throw new Error(`${side} enters at ${rounds[roundIdx]}, which is not the entry round`);
        }
        out.push(side, null);
      }
      offset += half;
    }
    return out;
  }

  const slots = expand(finals[0], rounds.length - 1, 0);
  if (slots.length !== size) throw new Error(`bracket expanded to ${slots.length} slots, expected ${size}`);
  for (let i = 0; i < slots.length; i += 2) {
    if (slots[i] === null && slots[i + 1] === null) throw new Error(`round-0 pair ${i / 2} is two byes`);
  }
  return { slots, extKeyByMatch };
}

const worldsWinner = (m: WorldsMatch): string =>
  m.winner ?? ((m.setsP1 ?? 0) > (m.setsP2 ?? 0) ? m.p1 : m.p2);

const womensWinner = (m: WomensMatch): string =>
  m.p2 === null ? m.p1 : (m.legsP1 ?? 0) > (m.legsP2 ?? 0) ? m.p1 : m.p2;

const BRACKET_SIZE = 128;

const WORLDS_BRACKET = reconstructBracket(WORLDS.matches, WORLDS_ROUNDS, worldsWinner, BRACKET_SIZE);
const WOMENS_BRACKET = reconstructBracket(WOMENS.matches, WOMENS_ROUNDS, womensWinner, BRACKET_SIZE);

// ---------------------------------------------------------------------------
// Seed numbers — what `slotOrder` actually indexes
// ---------------------------------------------------------------------------

/**
 * Assign every entrant a distinct seed, so `seedOrder` is a pure function of
 * the pack rather than of whatever order the product returns entrants in.
 *
 * `real` keeps the published seeds (Div A's 32); everyone else is numbered in
 * bracket-slot order, which makes `slotOrder` readable top-to-bottom and is
 * declared as an authoring artifact in `meta.adaptations`.
 */
function assignSeeds(slots: readonly (string | null)[], real: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>(real);
  let next = real.size + 1;
  for (const name of slots) {
    if (name === null || out.has(name)) continue;
    out.set(name, next);
    next++;
  }
  return out;
}

const WORLDS_REAL_SEEDS = new Map(WORLDS.seeds.map((s) => [s.name, s.seed] as const));
const WORLDS_SEEDS = assignSeeds(WORLDS_BRACKET.slots, WORLDS_REAL_SEEDS);
const WOMENS_SEEDS = assignSeeds(WOMENS_BRACKET.slots, new Map());

function slotOrderOf(slots: readonly (string | null)[], seeds: ReadonlyMap<string, number>): (number | null)[] {
  return slots.map((name) => {
    if (name === null) return null;
    const seed = seeds.get(name);
    if (seed === undefined) throw new Error(`no seed assigned for ${name}`);
    return seed;
  });
}

// ---------------------------------------------------------------------------
// Persons and entrants
// ---------------------------------------------------------------------------

function buildPersons(): NonNullable<PackInput["persons"]> {
  const names = new Set<string>([...WORLDS.field.map((p) => p.name), ...WOMENS.field.map((p) => p.name)]);
  return [...names]
    .sort((a, b) => (personRef(a) < personRef(b) ? -1 : 1))
    .map((name) => ({
      ref: personRef(name),
      fullName: name,
      lane: "player" as const,
      // `countryCode` is deliberately OMITTED. PackPerson wants a 3-char code;
      // the datasets carry country NAMES, and DartConnect records six Div B
      // players as "United Kingdom" and one as "World" — no home nation at
      // all. Guessing one would invent an attributed fact. Declared in
      // meta.adaptations.
    }));
}

function buildEntrants(): PackInput["entrants"] {
  const out: PackInput["entrants"] = [];
  for (const [division, field, seeds, divisionRef] of [
    ["a", WORLDS.field, WORLDS_SEEDS, DIV_A],
    ["b", WOMENS.field, WOMENS_SEEDS, DIV_B],
  ] as const) {
    const rows = field
      .map((p) => p.name)
      .sort((a, b) => (seeds.get(a) as number) - (seeds.get(b) as number))
      .map((name) => ({
        ref: entrantRef(division, name),
        divisionRef,
        kind: "individual" as const,
        displayName: name,
        seed: seeds.get(name) as number,
        // The roster is what binds an entrant to a PERSON, and it is what the
        // leaderboard and career oracles read through. An individual entrant
        // with an empty roster scores for nobody.
        roster: [{ person: personRef(name) }],
      }));
    out.push(...rows);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

const GENERIC_CFG = {
  resultMode: "score",
  // Darts cannot draw. `allowDraws: false` makes `applyResult` REFUSE a tally
  // that came out level (generic.ts:122-124), so a mis-encoded stream reds
  // instead of folding to a draw nobody noticed.
  allowDraws: false,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;

/** A PAYLOAD ref is SIGILLED; a structural ref is not.
 *
 *  `pack-schema.ts` header note 6: the seeding layer rewrites every
 *  `@`-prefixed string in a payload to its real UUID, and OFFLINE the
 *  sigilled string is used AS the id, so the same bytes fold in both places.
 *  `home`/`away` and every `expected.*` ref are structural and stay bare.
 *
 *  Note what could NOT catch a missing sigil: `PackSchema` validates
 *  `@`-strings but a BARE string in a payload is a literal by design, so an
 *  unsigilled ref parses cleanly and then folds against an entrant the engine
 *  has never heard of. Stage 0 is the only gate that sees it — which it did,
 *  offline, on all 205 streams at once. */
const sigil = (ref: string): string => `@${ref}`;

/** One `generic.score` per unit won, in the order the units were actually
 *  won, then an empty settling card. See header note 1. */
function scoreEvents(
  units: readonly { winner: string }[],
  division: "a" | "b",
): EventInput[] {
  return units.map((u) => ({
    type: "generic.score",
    payload: { by: sigil(entrantRef(division, u.winner)), points: 1, person: sigil(personRef(u.winner)) },
  }));
}

function worldsUnits(m: WorldsMatch): { winner: string }[] {
  if (m.setScores === null) {
    // The walkover. No darts were thrown, and the generic module in score
    // mode REFUSES a result card with no scores and no tally
    // (generic.ts:119-120) — while the product has no route to forfeit an
    // existing fixture at all (only the bracket generator stamps
    // `forfeited`, on byes it created itself: stages.ts:1351). So the
    // advance is encoded as a single administrative unit. Declared in
    // meta.adaptations; recorded as a product finding in the PR.
    return [{ winner: worldsWinner(m) }];
  }
  // `setScores` is in PLAY order, so the tally moves the way the match moved
  // rather than as a block of wins followed by a block of losses. A pack that
  // collapsed the order would still fold to the right total, which is exactly
  // why nothing downstream would catch it.
  return m.setScores.map((set) => {
    const [x, y] = set.split("-").map(Number);
    return { winner: x > y ? m.p1 : m.p2 };
  });
}

function womensUnits(m: WomensMatch): { winner: string }[] {
  // Div B publishes leg TOTALS only, never the sequence. The winner's legs
  // are emitted first, then the loser's: the final tally is order-independent,
  // and the flattening is declared in meta.adaptations so nobody later reads
  // a Div B stream as a real sequence.
  const winner = womensWinner(m);
  const loser = m.p1 === winner ? (m.p2 as string) : m.p1;
  const winnerLegs = m.p1 === winner ? (m.legsP1 as number) : (m.legsP2 as number);
  const loserLegs = m.p1 === winner ? (m.legsP2 as number) : (m.legsP1 as number);
  return [
    ...Array.from({ length: winnerLegs }, () => ({ winner })),
    ...Array.from({ length: loserLegs }, () => ({ winner: loser })),
  ];
}

function extKey(bracket: BracketShape, m: { round: string; matchNo: number }): string {
  const key = bracket.extKeyByMatch.get(matchId(m));
  if (key === undefined) throw new Error(`no generated ext key for ${matchId(m)} — the bracket did not reach it`);
  return key;
}

function buildStreams(): NonNullable<PackInput["streams"]> {
  const out: StreamInput[] = [];
  for (const m of WORLDS.matches) {
    out.push({
      divisionRef: DIV_A,
      fixtureExtKey: extKey(WORLDS_BRACKET, m),
      stageRef: STAGE_A,
      home: entrantRef("a", m.p1),
      away: entrantRef("a", m.p2),
      provenance: "real",
      events: [{ type: "core.start" }, ...scoreEvents(worldsUnits(m), "a"), { type: "generic.result", payload: {} }],
    });
  }
  for (const m of WOMENS.matches) {
    // A bye carries NO stream: the product creates it as a round-0 fixture
    // with an award and auto-decides it (bracket.ts:184-186, which omits the
    // away side entirely rather than nulling it). There is no event to fold.
    if (m.p2 === null) continue;
    out.push({
      divisionRef: DIV_B,
      fixtureExtKey: extKey(WOMENS_BRACKET, m),
      stageRef: STAGE_B,
      home: entrantRef("b", m.p1),
      away: entrantRef("b", m.p2),
      provenance: "real",
      events: [{ type: "core.start" }, ...scoreEvents(womensUnits(m), "b"), { type: "generic.result", payload: {} }],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Divisions and stages
// ---------------------------------------------------------------------------

function buildStage(ref: string, name: string, slots: readonly (string | null)[], seeds: ReadonlyMap<string, number>): StageInput {
  return {
    ref,
    seq: 1,
    kind: "knockout",
    name,
    config: {
      // The real draw, pinned. `slotOrder` and `byes` cannot be combined
      // (bracket.ts:130), and a misspelled key here now 400s rather than being
      // dropped in silence (StageConfig is a strictObject since #765).
      slotOrder: slotOrderOf(slots, seeds),
    },
  };
}

function buildDivisions(): PackInput["divisions"] {
  return [
    {
      ref: DIV_A,
      name: "PDC World Championship 2025",
      sportKey: "generic",
      variantKey: "score",
      moduleVersion: "1.0.0",
      cfgOverrides: { ...GENERIC_CFG },
      stages: [buildStage(STAGE_A, "Main draw", WORLDS_BRACKET.slots, WORLDS_SEEDS)],
      scheduleConfig: worldsScheduleConfig(),
    },
    {
      ref: DIV_B,
      name: `PDC Women's Series 2024 — ${WOMENS.meta.eventChosen}`,
      sportKey: "generic",
      variantKey: "score",
      moduleVersion: "1.0.0",
      cfgOverrides: { ...GENERIC_CFG },
      stages: [buildStage(STAGE_B, "Knockout", WOMENS_BRACKET.slots, WOMENS_SEEDS)],
      scheduleConfig: womensScheduleConfig(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Venues, the historical timetable, and the constraint scenario
// ---------------------------------------------------------------------------

const ALLY_PALLY = "v-ally-pally";
const ALLY_PALLY_STAGE = "c-ally-pally-stage";
const ROBIN_PARK = "v-robin-park";
const boardRef = (n: number): string => `c-robin-park-board-${n}`;

/** Div A's published session clock, in minutes from midnight (GMT). */
const AFTERNOON_OPEN = 12 * 60 + 30;
const AFTERNOON_CLOSE = 18 * 60;
const EVENING_OPEN = 19 * 60;
const EVENING_CLOSE = 23 * 60 + 20;
/** The final alone starts at 19:30 rather than 19:00 — published. */
const FINAL_OPEN = 19 * 60 + 30;

const isoAt = (date: string, minutes: number): string => {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${date}T${hh}:${mm}:00.000Z`;
};

function worldsCourtHours(): CourtHoursInput[] {
  // Two ranges per weekday on the ONE court — afternoon and evening. NOT
  // `sessionWindows`: that field is venue-wide with no court key
  // (api-v1/schemas.ts:1633-1636), so it cannot express "this court, twice a
  // day". The product allows multiple ranges per weekday and 422s only on
  // overlap (usecases/venues.ts:191-200), and 1080 < 1140 so these two do not.
  const hours: CourtHoursInput[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    hours.push({ weekday, openMin: AFTERNOON_OPEN, closeMin: AFTERNOON_CLOSE });
    hours.push({ weekday, openMin: EVENING_OPEN, closeMin: EVENING_CLOSE });
  }
  return hours;
}

function worldsClosedDates(): string[] {
  return WORLDS.sessions.filter((s) => s.noPlay === true).map((s) => s.date).sort();
}

/**
 * Div A's per-match start times.
 *
 * The published timetable is SESSION-level: the day, the session and the order
 * of matches within it are real; the clock time of each match inside a session
 * is not published, because matches run consecutively. `startsAt` is required
 * by `PackHistoricalAssignment`, and two fixtures sharing a start on one court
 * would make the certificate report the REAL timetable as infeasible — a false
 * red that reads exactly like a product bug.
 *
 * So each match is allotted a slot inside its own session, derived from that
 * session's span and match count rather than from a fixed length: a two-match
 * session and a four-match session differ, and the derivation moves if the
 * data does. Declared in meta.adaptations.
 */
function worldsHistorical(): HistoricalInput[] {
  const rows: HistoricalInput[] = [];
  const byNo = new Map(WORLDS.matches.map((m) => [m.matchNo, m] as const));
  for (const session of WORLDS.sessions) {
    const nos = session.matches ?? [];
    if (session.noPlay === true || nos.length === 0) continue;
    const isFinal = nos.some((n) => byNo.get(n)?.round === "F");
    // 2 January publishes no session caption (both semi-finals). PDC semi-final
    // night is the evening session; treated as such, and declared.
    const evening = isFinal || session.session === null || session.session === "evening";
    const open = isFinal ? FINAL_OPEN : evening ? EVENING_OPEN : AFTERNOON_OPEN;
    const close = evening ? EVENING_CLOSE : AFTERNOON_CLOSE;
    const slot = Math.floor((close - open) / nos.length);
    nos.forEach((no, i) => {
      const m = byNo.get(no);
      if (m === undefined) throw new Error(`session ${session.date} names unknown match ${no}`);
      rows.push({
        divisionRef: DIV_A,
        fixtureExtKey: extKey(WORLDS_BRACKET, m),
        venue: "Alexandra Palace",
        court: "Ally Pally Stage",
        startsAt: isoAt(session.date, open + i * slot),
      });
    });
  }
  return rows;
}

/** Div B's timetable is entirely real — DartConnect publishes a start AND an
 *  end per match on a named board. The one same-board overlap it contains
 *  (board 2, R3-2 against R4-2) is left VERBATIM: three feeds agree, and a
 *  certificate that reports this history as clean is broken. */
function womensHistorical(): HistoricalInput[] {
  return WOMENS.matches
    .filter((m) => m.p2 !== null && m.startTime !== undefined)
    .map((m) => ({
      divisionRef: DIV_B,
      fixtureExtKey: extKey(WOMENS_BRACKET, m),
      venue: WOMENS.meta.venue,
      court: `Board ${m.board as number}`,
      startsAt: m.startTime as string,
      ...(m.endTime === undefined ? {} : { endsAt: m.endTime }),
    }));
}

function buildVenues(): PackInput["venues"] {
  const boards = [...new Set(WOMENS.matches.filter((m) => m.board !== undefined).map((m) => m.board as number))].sort(
    (a, b) => a - b,
  );
  const eventDate = WOMENS.meta.eventDate;
  const weekday = new Date(`${eventDate}T00:00:00.000Z`).getUTCDay();
  return [
    {
      ref: ALLY_PALLY,
      name: "Alexandra Palace",
      courts: [
        {
          ref: ALLY_PALLY_STAGE,
          name: "Ally Pally Stage",
          sort: 1,
          hours: worldsCourtHours(),
          // The Christmas break and New Year's Eve — closed DATES, not absent
          // hours, because the weekday pattern still holds either side of them.
          exceptions: worldsClosedDates().map((date) => ({ date, closed: true })),
        },
      ],
    },
    {
      ref: ROBIN_PARK,
      name: WOMENS.meta.venue,
      courts: boards.map((n) => ({
        ref: boardRef(n),
        name: `Board ${n}`,
        sort: n,
        // One playing day, so one weekday. Derived from the event date rather
        // than typed, so a different event moves it.
        hours: [{ weekday, openMin: 10 * 60, closeMin: 15 * 60 }],
      })),
    },
  ];
}

/** The most matches any ONE entrant played in a single day, read out of the
 *  history. Not typed in: the 2025 draw really does put a player through two
 *  matches in an evening (Thibault Tricole, opening night), so a hand-typed
 *  `1` would refuse the real timetable. */
function worldsMaxMatchesPerEntrantPerDay(): number {
  const perDay = new Map<string, number>();
  for (const m of WORLDS.matches) {
    for (const name of [m.p1, m.p2]) {
      const key = `${m.date}/${name}`;
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
  }
  return Math.max(...perDay.values());
}

function worldsScheduleConfig(): Record<string, unknown> {
  const firstDay = WORLDS.sessions.filter((s) => s.noPlay !== true)[0];
  return {
    startAt: isoAt(firstDay.date, AFTERNOON_OPEN),
    // A best-of-7-sets darts match runs a little over an hour; the packing
    // pressure comes from the court hours, not from this number.
    matchMinutes: 75,
    gapMinutes: 0,
    courts: [`@${ALLY_PALLY_STAGE}`],
    constraints: {
      hard: [
        {
          type: "max_fixtures_per_day",
          count: worldsMaxMatchesPerEntrantPerDay(),
          scope: { kind: "every_entrant" },
        },
      ],
    },
  };
}

function womensScheduleConfig(): Record<string, unknown> {
  const boards = [...new Set(WOMENS.matches.filter((m) => m.board !== undefined).map((m) => m.board as number))].sort(
    (a, b) => a - b,
  );
  return {
    startAt: isoAt(WOMENS.meta.eventDate, 10 * 60),
    matchMinutes: 20,
    gapMinutes: 0,
    courts: boards.map((n) => `@${boardRef(n)}`),
  };
}

// ---------------------------------------------------------------------------
// Expected
// ---------------------------------------------------------------------------

function expectedMatches(): ExpectedMatchInput[] {
  const rows: ExpectedMatchInput[] = [];
  for (const m of WORLDS.matches) {
    const winner = worldsWinner(m);
    const loser = winner === m.p1 ? m.p2 : m.p1;
    const units = worldsUnits(m);
    const won = units.filter((u) => u.winner === m.p1).length;
    const lost = units.length - won;
    rows.push({
      divisionRef: DIV_A,
      fixtureExtKey: extKey(WORLDS_BRACKET, m),
      outcome: {
        kind: "win",
        winner: entrantRef("a", winner),
        loser: entrantRef("a", loser),
        // "regulation" even for the walkover, and that is the FINDING rather
        // than a concession. Stage 0 refused `method: "walkover"` here —
        // `method: pack expects "walkover", the fold produced "regulation"` —
        // because a walkover encoded as an administrative 1-0 is, to the
        // engine, an ordinary win. So a walkover is not merely awkward to
        // record (there is no route to forfeit an existing fixture at all):
        // once recorded the only way it can be, it is INDISTINGUISHABLE from
        // a played 1-0. Asserting "walkover" would assert something the
        // product cannot express.
        method: "regulation",
      },
      // `sideLine` renders `String(state.score[side])` once decided
      // (generic.ts:196-197), and the score here is the TALLY the engine built
      // from the score events — which is the whole point of the encoding.
      perSide: [
        { entrant: entrantRef("a", m.p1), line: String(won) },
        { entrant: entrantRef("a", m.p2), line: String(lost) },
      ],
    });
  }
  for (const m of WOMENS.matches) {
    if (m.p2 === null) continue;
    const winner = womensWinner(m);
    const loser = winner === m.p1 ? m.p2 : m.p1;
    rows.push({
      divisionRef: DIV_B,
      fixtureExtKey: extKey(WOMENS_BRACKET, m),
      outcome: { kind: "win", winner: entrantRef("b", winner), loser: entrantRef("b", loser), method: "regulation" },
      perSide: [
        { entrant: entrantRef("b", m.p1), line: String(m.legsP1) },
        { entrant: entrantRef("b", m.p2), line: String(m.legsP2) },
      ],
    });
  }
  return rows;
}

/** Units won per PERSON, derived from the streams this file just built rather
 *  than from a table typed here — so a change to the data moves the expected
 *  leaderboard with it instead of leaving it asserting yesterday's numbers. */
function unitsWonByPerson(divisionRef: string, streams: readonly StreamInput[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const s of streams) {
    if (s.divisionRef !== divisionRef) continue;
    for (const e of s.events) {
      if (e.type !== "generic.score") continue;
      const person = (e.payload as { person?: string }).person;
      if (person === undefined) continue;
      // Strip the payload sigil: `expected.leaderboards[].person` and
      // `expected.careers[].person` are STRUCTURAL refs and carry none.
      const ref = person.startsWith("@") ? person.slice(1) : person;
      tally.set(ref, (tally.get(ref) ?? 0) + 1);
    }
  }
  return tally;
}

const LEADERBOARD_DEPTH = 10;

function expectedLeaderboards(streams: readonly StreamInput[]): NonNullable<PackInput["expected"]["leaderboards"]> {
  const nameOf = new Map(buildPersons().map((p) => [p.ref, p.fullName] as const));
  return [DIV_A, DIV_B].map((divisionRef) => {
    const tally = [...unitsWonByPerson(divisionRef, streams)]
      // Count descending, then ref ascending so ties are deterministic.
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, LEADERBOARD_DEPTH);
    return {
      divisionRef,
      metricKey: "scores",
      entries: tally.map(([person, count]) => ({ person, name: nameOf.get(person) as string, count })),
    };
  });
}

/** The cross-division careers: one person, both divisions. `PackExpectedCareer`
 *  carries no `divisionRef` because a career rollup is cross-division by
 *  design, so the count is sets won at the Worlds PLUS legs won in the
 *  Women's Series. */
function expectedCareers(streams: readonly StreamInput[]): NonNullable<PackInput["expected"]["careers"]> {
  const inWorlds = new Set(WORLDS.field.map((p) => p.name));
  const both = WOMENS.field
    .map((p) => p.name)
    .filter((name) => inWorlds.has(name))
    .sort();
  const a = unitsWonByPerson(DIV_A, streams);
  const b = unitsWonByPerson(DIV_B, streams);
  return both.map((name) => {
    const ref = personRef(name);
    return {
      person: ref,
      name,
      metricKey: "scores",
      count: (a.get(ref) ?? 0) + (b.get(ref) ?? 0),
    };
  });
}

function expectedChampions(): NonNullable<PackInput["expected"]["champions"]> {
  const worldsFinal = WORLDS.matches.find((m) => m.round === "F") as WorldsMatch;
  const womensFinal = WOMENS.matches.find((m) => m.round === "F") as WomensMatch;
  return [
    { divisionRef: DIV_A, stageRef: STAGE_A, entrant: entrantRef("a", worldsWinner(worldsFinal)) },
    { divisionRef: DIV_B, stageRef: STAGE_B, entrant: entrantRef("b", womensWinner(womensFinal)) },
  ];
}

/**
 * Final ranks, cut where the real tournament stops ordering.
 *
 * A knockout ranks its champion and its runner-up and nothing below: both
 * losing semi-finalists are equal third, and the pack must not invent an
 * ordering between them. `PackExpectedFinalRanks.order` needs at least two
 * refs, which is exactly what a knockout can honestly supply. The cut is
 * declared in meta.adaptations.
 */
function expectedFinalRanks(): NonNullable<PackInput["expected"]["finalRanks"]> {
  const rows: NonNullable<PackInput["expected"]["finalRanks"]> = [];
  for (const [division, matches, winnerOf, divisionRef, stageRef] of [
    ["a", WORLDS.matches, worldsWinner as (m: never) => string, DIV_A, STAGE_A],
    ["b", WOMENS.matches, womensWinner as (m: never) => string, DIV_B, STAGE_B],
  ] as const) {
    const final = matches.find((m) => m.round === "F") as never;
    const champion = winnerOf(final);
    const f = final as { p1: string; p2: string | null };
    const runnerUp = champion === f.p1 ? (f.p2 as string) : f.p1;
    rows.push({
      divisionRef,
      stageRef,
      order: [entrantRef(division, champion), entrantRef(division, runnerUp)],
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Claim invites — the three stars who accept through the real invitee flow
// ---------------------------------------------------------------------------

const CLAIM_STARS = ["Luke Littler", "Michael van Gerwen", "Fallon Sherrock"];

function buildClaimInvites(): PackInput["claimInvites"] {
  return CLAIM_STARS.map((name) => ({
    person: personRef(name),
    // `.invalid` is reserved by RFC 2606 and can never route anywhere, which
    // is the point: the bench signs in as these addresses locally and nothing
    // it sends can reach a real inbox.
    email: `${slug(name)}@bench.invalid`,
  }));
}

// ---------------------------------------------------------------------------
// Meta — sources, and every adaptation
// ---------------------------------------------------------------------------

function httpSources(): NonNullable<PackInput["meta"]>["sources"] {
  const rows: { url: string; label: string; retrievedOn: string }[] = [];
  const add = (raw: string, label: string, retrievedOn: string): void => {
    // The datasets record some entries as "<url> (fetched; SPA shell)" — a
    // note, not a URL. PackSource.url is z.url() and would refuse them.
    const url = raw.split(" ")[0];
    if (!url.startsWith("http")) return;
    if (rows.some((r) => r.url === url)) return;
    rows.push({ url, label, retrievedOn });
  };
  for (const s of WORLDS.meta.sources) add(s, "2025 PDC World Darts Championship", WORLDS.meta.fetchedOn);
  for (const s of WOMENS.meta.sources) add(s, `PDC Women's Series 2024 ${WOMENS.meta.eventChosen}`, WOMENS.meta.fetchedOn);
  return rows;
}

function adaptations(): NonNullable<PackInput["meta"]>["adaptations"] {
  return [
    {
      what: "Every entrant carries a distinct seed: 1..96 in Div A and 1..111 in Div B. Only Div A's 1..32 are the real PDC seedings.",
      why: "`slotOrder` indexes SEED NUMBERS, resolved through `seedOrder` (roundrobin.ts:62), which falls back to the product's INPUT ORDER for unseeded entrants — an order no pack can control. Numbering the whole field makes the draw a pure function of the pack. The Women's Series publishes no seedings at all, so all 111 of Div B's are authoring artifacts.",
      where: "divisions[].stages[].config.slotOrder, entrants[].seed",
    },
    {
      what: "The draw is reconstructed from the results by descending from the final, not taken from a published draw sheet.",
      why: "Who played whom, and therefore who met whom next, is published; only the sheet's absolute top-to-bottom orientation is a convention and nothing depends on it. The alternative — declaring byes by name — hands the pairings to the product, which would pair players who never met while the pack asserted the real results.",
      where: "divisions[].stages[].config.slotOrder",
    },
    {
      what: "Div A match 35, Ian White w/o Sandro Eric Sosing, is encoded as a single 1-0 administrative set and its expected outcome method is \"regulation\", not \"walkover\". No darts were thrown.",
      why: "Two product facts, not one. There is no route to forfeit an existing fixture — `forfeited` is a fixture status but its only writer is the bracket generator, stamping byes it created itself (stages.ts:1351) — and the generic module in score mode refuses a result card with no scores and no tally (generic.ts:119-120), so a stream cannot express it either. Encoded the only way available, the walkover then becomes INDISTINGUISHABLE from a played 1-0: stage 0 refused `method: \"walkover\"` against a fold that produced `\"regulation\"`. The 1-0 is an encoding of record, not a score that happened. Both halves recorded as a product finding.",
      where: "streams[] and expected.matches[] for se-r0-i19 of Div A",
    },
    {
      what: "Div B leg order within a match is flattened: the winner's legs are emitted first, then the loser's.",
      why: "The sources publish leg TOTALS only, never the sequence. The final tally is order-independent, so the fold is correct — but the ORDER is not real and nobody should later read a Div B stream as a rally sequence. Div A needs no such adaptation: its per-set scores are in play order.",
      where: "streams[] of Div B",
    },
    {
      what: "Div B's 17 first-round byes are derived, not published.",
      why: "DartConnect records no bye rows. They are the Last-64 entrants who were not Last-128 winners, verified exactly: 47 contested R1 matches yield 47 winners, all 47 appear in the Last 64, no R1 loser reappears, and 47 + 17 = 64 slots.",
      where: "divisions[].stages[].config.slotOrder of Div B",
    },
    {
      what: "Div A per-match start times are allotted within their published session; only the day, the session and the order within it are real.",
      why: "The PDC publishes a session-level timetable (afternoon 12:30, evening 19:00, final 19:30) because matches run consecutively. `PackHistoricalAssignment.startsAt` is required, and two fixtures sharing a start on one court would make the certificate report the REAL timetable as infeasible. Each slot is derived from its session's own span and match count rather than a fixed length.",
      where: "historicalAssignment[] of Div A",
    },
    {
      what: "2 January is treated as an evening session.",
      why: "It is the only playing day the source publishes with no session caption, and it holds both semi-finals, which the PDC stages in the evening. Recorded rather than silently defaulted.",
      where: "historicalAssignment[] of Div A",
    },
    {
      what: "Div B's historical timetable contains one same-board overlap — board 2, R3 match 2 against R4 match 2 — and is carried verbatim.",
      why: "Three independent DartConnect feeds agree on both boards, so it is a fact about the event rather than a transcription error. Shifting either match to satisfy the feasibility certificate would invent an attributed fact; a certificate that reports this history as clean is broken.",
      where: "historicalAssignment[] of Div B",
    },
    {
      what: "No `countryCode` on any person.",
      why: "PackPerson wants a 3-character code and the datasets carry country NAMES. DartConnect records six Div B players as 'United Kingdom' with no home nation and one as 'World'. Guessing a nation would invent an attributed fact.",
      where: "persons[]",
    },
    {
      what: "No leaderboards for three-dart average, 180s or high checkouts.",
      why: "None is representable by the generic module at any fidelity tier — it declares exactly two event types, `generic.result` and `generic.score` (generic.ts:242-245). Dropped under the §7A protocol rather than faked.",
      where: "expected.leaderboards",
    },
    {
      what: "`expected.finalRanks` is cut after the runner-up in both divisions.",
      why: "A knockout honestly ranks only its champion and runner-up: both losing semi-finalists are equal third and the real tournament orders them no further. Inventing an order between them would be a fabricated fact asserted as an oracle.",
      where: "expected.finalRanks",
    },
    {
      what: "No officials, and therefore no officials oracle subject.",
      why: "Neither source publishes the callers or referees for this event, and the suite sheet only asked for them 'where published'. The people layer's officials steps will report NO SUBJECT, which is the honest outcome — an invented referee roster would satisfy the acceptance item while proving nothing.",
      where: "officials[]",
    },
    {
      what: "No suspensions and no specials.",
      why: "Darts has neither disciplinary suspensions nor a tie-break special of the kind bench design §8 enumerates, and §8 assigns darts none. Both oracles report NO SUBJECT deliberately; the pilot stays mechanically plain on purpose so the PIPELINE is what gets proven.",
      where: "expected.suspensions, expected.specials",
    },
  ];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildSuite11(): PackInput {
  const streams = buildStreams();
  return {
    schemaVersion: 1,
    suite: "suite11",
    org: { name: "PDC Worlds", slug: "pdc-worlds", timezone: "Europe/London", currency: "gbp" },
    competition: {
      name: "PDC 2024/25",
      slug: "pdc-2024-25",
      startsOn: WOMENS.meta.eventDate,
      endsOn: "2025-01-03",
      description:
        "Two real PDC knockouts: the 2025 World Championship at set granularity and a 2024 Women's Series event at leg granularity.",
    },
    divisions: buildDivisions(),
    persons: buildPersons(),
    entrants: buildEntrants(),
    streams,
    historicalAssignment: [...worldsHistorical(), ...womensHistorical()],
    venues: buildVenues(),
    claimInvites: buildClaimInvites(),
    expected: {
      matches: expectedMatches(),
      tables: [],
      champions: expectedChampions(),
      finalRanks: expectedFinalRanks(),
      leaderboards: expectedLeaderboards(streams),
      careers: expectedCareers(streams),
      suspensions: [],
      specials: [],
    },
    meta: { synthetic: false, sources: httpSources(), adaptations: adaptations() },
  };
}

function main(): void {
  const out = fileURLToPath(new URL("../suite11.json", import.meta.url));
  writeFileSync(out, `${JSON.stringify(buildSuite11(), null, 2)}\n`);
  const pack = buildSuite11();
  const divisions = pack.divisions as { ref: string }[];
  process.stdout.write(
    `wrote ${out}\n  divisions ${divisions.length}` +
      `  persons ${(pack.persons ?? []).length}` +
      `  entrants ${pack.entrants.length}` +
      `  streams ${(pack.streams ?? []).length}` +
      `  events ${(pack.streams ?? []).reduce((a, s) => a + s.events.length, 0)}` +
      `  historical ${(pack.historicalAssignment ?? []).length}` +
      `  adaptations ${(pack.meta.adaptations ?? []).length}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
