// Spectator surface W1 — the Timeline and the Sets / Periods table for every
// sport that is NOT cricket (cricket gets a Scorecard and a Commentary tab from
// its own fold instead). Design:
// `docs/superpowers/specs/2026-09-04-spectator-surface-design.md` §W1,
// "Every other sport in W1".
//
// A pure builder over an event ledger and a `ScoreSummary` — no I/O, no DB.
// It reaches for `@/lib/public-site`'s `setBreakdown` / `periodBreakdown`
// rather than re-reading `summary.detail` for itself: those two are the repo's
// existing readers of that shape and `live-score.tsx` already renders from them.
//
// It is nonetheless a SERVER module, and the one thing that makes it one is the
// logger. `eslint.config.mjs` scopes `no-console: error` to `src/server/**`
// with the reason spelled out — "pino (server/logger.ts) is the logger, not
// console" — so the degrade below reports through pino, and this file inherits
// pino's server-only-ness. An earlier draft claimed client-safety here so a
// later wave could re-run the builder from a pushed payload; that was an
// aspiration nothing consumed, and carving a lint exemption to protect it
// would have been the wrong trade.
//
// ---------------------------------------------------------------------------
// Four things about this file that are NOT derivable from reading it
// ---------------------------------------------------------------------------
//
// 1. TEMPLATES ARE KEYED BY THE RECORDED EVENT TYPE STRING, not by a module's
//    declared `eventSchemas`. Only five of the eleven modules declare that
//    record at all (football, cricket, boardgame, carrom, generic); tennis,
//    hockey, icehockey, badminton, tabletennis and volleyball declare none, so
//    a table derived from the declarations would silently cover half the
//    catalogue. The coverage test in `__tests__/timeline.test.ts` therefore
//    derives its type set from the ENGINE'S OWN GOLDEN CORPORA
//    (`packages/engine/src/sports/**\/<key>.golden.json`) — a new recorded type
//    cannot ship unlocalised.
//
// 2. SEVERAL SPORTS SHARE ONE TEMPLATE. `TIMELINE_KEY_FOR` maps type -> key and
//    nothing says the map is injective: a template is a SENTENCE, and field
//    hockey and ice hockey (one kernel, one vocabulary) say the same sentence,
//    as do the three set-based sports for everything but the set/game noun.
//    Sharing keeps the four dictionaries at 41 keys instead of 73.
//
// 3. EVERY `{param}` A TEMPLATE NAMES IS ALWAYS SUPPLIED, because `interpolate`
//    leaves an unmatched `{person}` in the rendered string for a spectator to
//    read. Optional detail is composed into ONE trailing `detail` param that is
//    the empty string when nothing is known, and every template places it LAST,
//    so the empty case is a clean trailing space the renderer trims rather than
//    a hole in the middle of a sentence.
//
// 4. ENGINE ENUM TOKENS RIDE IN PARAMS VERBATIM, AND THAT IS DELIBERATE.
//    `{colour}` is "yellow", `{kind}` is "double_fault", and so on for
//    `{outcome}`, `{level}`, `{class}` and `{method}` — the templates are one
//    per event TYPE (the football test pins that), so they cannot branch per
//    enum member. Left alone a Dutch reader would get "yellow kaart"; the fix
//    is in the RENDERER, where a dictionary is in hand: `localiseParams` in
//    `components/public-site/match-centre/timeline-tab.tsx` swaps any param
//    value with a `term.<token>` key for that key's text and passes everything
//    else through. Do not "fix" it here — this builder has no dictionary, and
//    a term table it could not consume would be an inert seam.
import {
  REPLAY_LINEUP_POLICY,
  initSquads,
  isLineupEventType,
  kernelOwnsEvent,
  reduceLineupEvent,
  resolveVoids,
  type EventEnvelope,
  type LineupPair,
  type ScoreSummary,
  type SquadState,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { matchPhase, periodBreakdown, servingSide, setBreakdown, type PeriodScoreRow, type SetScore } from "@/lib/public-site";
import { log } from "@/server/logger";
import {
  TIMELINE_GAME_BROKEN_KEY,
  TIMELINE_GAME_HELD_KEY,
  TIMELINE_KEY_FOR,
  TIMELINE_NEUTRAL_KEY,
  TIMELINE_PERIOD_END_KEY,
  TIMELINE_SET_WON_KEY,
} from "@/lib/timeline-keys";
import type { MsgT, PersonT, SetsViewT, SideT, TimelineLineT } from "./match-centre-schema";

export interface TimelineArgs {
  sportKey: string;
  events: readonly EventEnvelope[];
  module: AnySportModule;
  /** The fixture's resolved config, passed through exactly as `fold.ts` passes
   *  it to `foldMatch` — never re-parsed here, or the timeline would replay
   *  under a config the fixture was not scored under. */
  cfg: unknown;
  lineups: LineupPair;
  sides: [SideT, SideT];
  /** Consent-resolved by the caller (`public-lineups.ts`); never resolved here. */
  personOf: (personId: string) => PersonT;
}

export interface SetsArgs {
  sportKey: string;
  summary: ScoreSummary;
  sides: [SideT, SideT];
}

// THE KEY TABLE LIVES IN `@/lib/timeline-keys`, NOT HERE, and is re-exported
// for this module's own callers. The reason is mechanical: this file imports
// pino (see the header), and in this app a client component importing anything
// under `@/server/**` is a BUILD FAILURE — so a renderer that needs to
// recognise a derived line has to be able to reach the keys without reaching
// this module. A component imports `@/lib/timeline-keys`; the server imports
// either.
export {
  TIMELINE_GAME_BROKEN_KEY,
  TIMELINE_GAME_HELD_KEY,
  TIMELINE_KEY_FOR,
  TIMELINE_NEUTRAL_KEY,
  TIMELINE_OVERRIDE_KEYS,
  TIMELINE_PERIOD_END_KEY,
  TIMELINE_SET_WON_KEY,
} from "@/lib/timeline-keys";

// --------------------------------------------------------------- primitives

type Payload = Record<string, unknown>;
type Params = Record<string, string | number>;

const asPayload = (value: unknown): Payload =>
  typeof value === "object" && value !== null ? (value as Payload) : {};

/** A template's param, never `undefined` — see note 3 in the header. */
const S = (value: unknown): string => (typeof value === "string" ? value : "");
const N = (value: unknown): string | number =>
  typeof value === "number" && Number.isFinite(value) ? value : "";

/** The entrant fields a payload can carry a side in, in precedence order. */
// `side` is the kernel lineup family's spelling; the rest are the sports'.
const SIDE_FIELDS = ["by", "side", "wonBy", "winner", "winnerId", "entrantId", "firstBreak", "white"];

function sideIndexOf(payload: Payload, sides: readonly [SideT, SideT]): 0 | 1 | null {
  for (const field of SIDE_FIELDS) {
    const value = payload[field];
    if (typeof value !== "string" || value === "") continue;
    if (value === sides[0].entrantId) return 0;
    if (value === sides[1].entrantId) return 1;
  }
  return null;
}

/** Sport notation, never prose: "23'" from a deprecated `minute`, else the
 *  `GameTime` stamp as "H1 4:00".
 *
 *  NOT the phase a `football.period` / `*.period.advance` event names, though
 *  it used to be: those two put the phase in their SENTENCE, so a marker would
 *  print "HT" twice on one line — once as the marker and once inside "Period
 *  marker — HT". The marker column is for WHEN a line happened, and a phase
 *  boundary's answer to that is the phase itself, which the sentence already
 *  gives. */
function markerOf(payload: Payload): string | null {
  const minute = payload.minute;
  if (typeof minute === "number" && Number.isFinite(minute)) return `${minute}'`;

  const at = asPayload(payload.at);
  const period = at.period;
  const elapsed = at.elapsed;
  if (typeof period === "string" && period !== "" && typeof elapsed === "number") {
    const mins = Math.floor(elapsed / 60);
    const secs = Math.floor(elapsed % 60);
    return `${period} ${mins}:${String(secs).padStart(2, "0")}`;
  }

  return null;
}

const SCORE_EMPHASIS = new Set([
  "football.goal",
  "football.shootout.kick",
  "tennis.point",
  "tennis.set_summary",
  "volleyball.rally",
  "volleyball.set.summary",
  "badminton.rally",
  "badminton.game.summary",
  "tabletennis.rally",
  "tabletennis.game.summary",
  "hockey.goal",
  "hockey.shootout.attempt",
  "icehockey.goal",
  "icehockey.shootout.attempt",
  "carrom.board.summary",
  "generic.score",
]);

const STRONG_EMPHASIS = new Set([
  "core.start",
  "core.forfeit",
  "core.abandon",
  "core.settle",
  "football.card",
  "football.period",
  "tennis.game.award",
  "tennis.sanction",
  "volleyball.sanction",
  "badminton.sanction",
  "tabletennis.sanction",
  "hockey.period.advance",
  "hockey.suspension.start",
  "icehockey.period.advance",
  "icehockey.suspension.start",
  "boardgame.result",
  "generic.result",
]);

function emphasisOf(type: string): TimelineLineT["emphasis"] {
  if (SCORE_EMPHASIS.has(type)) return "score";
  if (STRONG_EMPHASIS.has(type)) return "strong";
  return "normal";
}

// ----------------------------------------------------------- param mapping

interface ParamCtx {
  payload: Payload;
  sides: readonly [SideT, SideT];
  sideIndex: 0 | 1 | null;
  personOf: (personId: string) => PersonT;
}

const nameOf = (ctx: ParamCtx, field: string): string => {
  const id = ctx.payload[field];
  return typeof id === "string" && id !== "" ? ctx.personOf(id).name : "";
};

/** Compose the optional trailing `detail` — see note 3 in the header. */
const detailOf = (...parts: string[]): string =>
  parts.filter((part) => part !== "").join(" ");

const sideNameOf = (ctx: ParamCtx): string =>
  ctx.sideIndex === null ? "" : ctx.sides[ctx.sideIndex].name;

/** Language-neutral glyphs for the booleans a sentence cannot carry. */
const scoredGlyph = (value: unknown): string => (value === true ? "✓" : "✗");

function personListOf(ctx: ParamCtx, field: string): string {
  const raw = ctx.payload[field];
  if (!Array.isArray(raw)) return "";
  const names = raw
    .filter((id): id is string => typeof id === "string" && id !== "")
    .map((id) => ctx.personOf(id).name);
  return names.length === 0 ? "" : `(${names.join(", ")})`;
}

const lineupParams = (c: ParamCtx): Params => {
  const params: Params = {};
  if (c.sideIndex !== null) params.side = sideNameOf(c);
  return params;
};

/** Per-type params. Keyed by RECORDED TYPE (not by dictionary key) so two
 *  sports sharing one template can still read their own payload field names. */
const PARAMS_FOR: Record<string, (ctx: ParamCtx) => Params> = {
  "core.start": () => ({}),
  "core.forfeit": (c) => ({ side: sideNameOf(c) }),
  "core.abandon": () => ({}),
  // `CoreNote` is `{ text }` — free text an official typed, so it passes
  // through verbatim; there is nothing to localise about it.
  "core.note": (c) => ({ text: S(c.payload.text) }),
  "core.finalize": () => ({}),
  // `CoreAward` is `{ person, key }` — a PERSON and an award key, with no
  // entrant on it at all (`core/events.ts`). The review brief said `{side}`;
  // the schema says otherwise, so the line names the person.
  "core.award": (c) => ({ person: nameOf(c, "person"), key: S(c.payload.key) }),
  "core.suspend": () => ({}),
  "core.resume": () => ({}),
  // W2a (X-ST-1): `CoreSettle` is `{ winner, method, note? }`; the winner is an
  // entrant (SIDE_FIELDS reads `winner`), so the line names the side that advances.
  "core.settle": (c) => ({ side: sideNameOf(c) }),

  // A penalty or an own goal is named by its SENTENCE (KEY_OVERRIDE below),
  // not by an English "(pen)" / "(og)" on `detail`: this builder has no
  // dictionary, and a flag glued into free text is past any renderer's reach.
  "football.goal": (c) => {
    const assist = nameOf(c, "assist");
    return {
      side: sideNameOf(c),
      detail: detailOf(nameOf(c, "scorer"), assist === "" ? "" : `(${assist})`),
    };
  },
  "football.card": (c) => ({
    side: sideNameOf(c),
    colour: S(c.payload.color),
    detail: nameOf(c, "person"),
  }),
  "football.sub": (c) => ({
    side: sideNameOf(c),
    on: nameOf(c, "on"),
    off: nameOf(c, "off"),
  }),
  "football.period": (c) => ({ phase: S(c.payload.phase) }),
  "football.shootout.kick": (c) => ({
    side: sideNameOf(c),
    result: scoredGlyph(c.payload.scored),
    detail: nameOf(c, "person"),
  }),
  "football.penalty": (c) => ({
    side: sideNameOf(c),
    outcome: S(c.payload.outcome),
    detail: nameOf(c, "taker"),
  }),
  "football.sinbin.start": (c) => ({ side: sideNameOf(c), detail: nameOf(c, "person") }),
  "football.sinbin.end": (c) => ({ side: sideNameOf(c), detail: nameOf(c, "person") }),
  "football.shot": (c) => ({
    side: sideNameOf(c),
    outcome: S(c.payload.outcome),
    detail: nameOf(c, "taker"),
  }),

  "tennis.point": (c) => {
    const kind = S(asPayload(c.payload.meta).kind);
    return {
      side: sideNameOf(c),
      detail: detailOf(nameOf(c, "scorer"), kind === "" ? "" : `(${kind})`),
    };
  },
  "tennis.game.award": (c) => ({ side: sideNameOf(c), detail: S(c.payload.reason) }),
  "tennis.set_summary": (c) => ({ home: N(c.payload.home), away: N(c.payload.away) }),
  "tennis.sanction": (c) => ({
    side: sideNameOf(c),
    level: S(c.payload.level),
    detail: nameOf(c, "person"),
  }),
  "tennis.interruption": (c) => ({
    side: sideNameOf(c),
    kind: S(c.payload.kind),
    detail: nameOf(c, "person"),
  }),

  "carrom.toss": (c) => ({ side: sideNameOf(c) }),
  "carrom.board.summary": (c) => ({
    side: sideNameOf(c),
    coins: N(c.payload.opponentCoinsLeft),
  }),
  "carrom.game.adjust": (c) => ({ side: sideNameOf(c), delta: N(c.payload.delta) }),

  "boardgame.pairing": (c) => ({ side: sideNameOf(c), board: N(c.payload.board) }),
  // A DRAW carries no winner, and the `timeline.boardgame.draw` template
  // KEY_OVERRIDE swaps in names no `{side}` — so `side` is omitted rather than
  // supplied empty. An unused empty param is harmless today and is exactly the
  // kind of thing a later template change turns into a dangling dash.
  "boardgame.result": (c) => {
    // ONE object shape, not a ternary over two: a union of
    // `{ method } | { side; method }` is not assignable to `Params`, and the
    // conditional spread says the same thing in a shape TS can widen.
    const params: Params = { method: S(c.payload.method) };
    if (c.sideIndex !== null) params.side = sideNameOf(c);
    return params;
  },
  // `side` only when it RESOLVED. An unrecognised entrant id would otherwise
  // supply the empty string and render "Line-up change — " with a dangling
  // dash; omitted, the renderer at least shows the unfilled placeholder, which
  // is a visible defect rather than a plausible-looking wrong line.
  "core.lineup.substitution": lineupParams,
  "core.lineup.replacement": lineupParams,
  "core.lineup.position": lineupParams,
  "core.lineup.retirement": lineupParams,
  "core.lineup.entry": lineupParams,

  "generic.score": (c) => ({
    side: sideNameOf(c),
    points: N(c.payload.points),
    detail: nameOf(c, "person"),
  }),
  "generic.result": (c) => ({ side: sideNameOf(c) }),
};

// The three set-based sports and the two period-kernel sports share their
// templates, so they share their param mappers too — registered by loop rather
// than by five copies each.
const rally = (c: ParamCtx): Params => ({ side: sideNameOf(c) });
const setSummary = (c: ParamCtx): Params => ({ home: N(c.payload.home), away: N(c.payload.away) });
const sanction = (c: ParamCtx): Params => ({
  side: sideNameOf(c),
  level: S(c.payload.level),
  detail: nameOf(c, "person"),
});
const sub = (c: ParamCtx): Params => ({
  side: sideNameOf(c),
  on: nameOf(c, "on"),
  off: nameOf(c, "off"),
});
const timeout = (c: ParamCtx): Params => ({ side: sideNameOf(c) });
const expedite = (): Params => ({});

for (const [sport, summaryType] of [
  ["volleyball", "volleyball.set.summary"],
  ["badminton", "badminton.game.summary"],
  ["tabletennis", "tabletennis.game.summary"],
] as const) {
  PARAMS_FOR[`${sport}.rally`] = rally;
  PARAMS_FOR[summaryType] = setSummary;
  PARAMS_FOR[`${sport}.sanction`] = sanction;
  PARAMS_FOR[`${sport}.sub`] = sub;
  PARAMS_FOR[`${sport}.timeout`] = timeout;
  PARAMS_FOR[`${sport}.expedite.start`] = expedite;
}
for (const sport of ["hockey", "icehockey"] as const) {
  PARAMS_FOR[`${sport}.goal`] = (c) => ({
    side: sideNameOf(c),
    detail: detailOf(nameOf(c, "person"), personListOf(c, "assists")),
  });
  PARAMS_FOR[`${sport}.period.advance`] = (c) => ({ phase: S(c.payload.to) });
  PARAMS_FOR[`${sport}.set_piece`] = (c) => ({
    side: sideNameOf(c),
    kind: S(c.payload.kind),
    detail: nameOf(c, "person"),
  });
  PARAMS_FOR[`${sport}.shootout.attempt`] = (c) => ({
    side: sideNameOf(c),
    result: scoredGlyph(c.payload.scored),
    detail: nameOf(c, "person"),
  });
  PARAMS_FOR[`${sport}.shot`] = (c) => ({
    side: sideNameOf(c),
    outcome: S(c.payload.outcome),
    detail: nameOf(c, "person"),
  });
  PARAMS_FOR[`${sport}.suspension.start`] = (c) => ({
    side: sideNameOf(c),
    class: S(c.payload.class),
    detail: nameOf(c, "person"),
  });
  PARAMS_FOR[`${sport}.suspension.end`] = (c) => ({
    side: sideNameOf(c),
    class: S(c.payload.class),
    detail: nameOf(c, "person"),
  });
}

// -------------------------------------------------------------- the builder

/**
 * The few types whose SENTENCE depends on the payload, not only on the type.
 *
 * `TIMELINE_KEY_FOR` stays the coverage table — every recorded type maps to a
 * key there, and that is what the dictionary gate reads. This is the narrow
 * escape hatch beside it, for a case where one type genuinely says two things:
 * `boardgame.result` with no winner is a DRAW, and rendering it through the
 * decisive template printed "Result (agreement) — " with an empty side, which
 * is worse than saying nothing.
 */
const lineupOverride = (_payload: Payload, sideIndex: 0 | 1 | null): string | null =>
  sideIndex === null ? "timeline.core.lineup.unknownSide" : null;

const KEY_OVERRIDE: Readonly<
  Record<string, (payload: Payload, sideIndex: 0 | 1 | null) => string | null>
> = {
  // Keyed on the RESOLVED side, not on `payload.winner` being a non-empty
  // string. A winner id that matches NEITHER entrant — a stale fixture, an
  // entrant deleted after scoring — resolved to `sideIndex: null` and then took
  // the decisive template anyway, printing "Result (resign) — " with nothing
  // where the winner should be. Reading the resolved index means "we could not
  // name a winner" and "there is no winner" take the same, safe branch.
  "boardgame.result": (_payload, sideIndex) =>
    sideIndex === null ? "timeline.boardgame.draw" : null,
  // Task 16: the goal's own flags choose its sentence. An own goal wins over a
  // penalty if a ledger ever carries both — the scorer did not score for his
  // side, whatever the kick was.
  "football.goal": (payload) =>
    payload.ownGoal === true
      ? "timeline.football.ownGoal"
      : payload.penalty === true
        ? "timeline.football.penaltyGoal"
        : null,
  // Same shape for the lineup family: with no side to name, the template that
  // names one would render "Line-up change — " with a dangling dash. Five
  // types, one override, because they share one sentence.
  "core.lineup.substitution": lineupOverride,
  "core.lineup.replacement": lineupOverride,
  "core.lineup.position": lineupOverride,
  "core.lineup.retirement": lineupOverride,
  "core.lineup.entry": lineupOverride,
  // W2a (X-ST-1): the settle method is part of the sentence. An unknown method
  // keeps the table's method-free line rather than inventing how.
  "core.settle": (payload) =>
    payload.method === "lot" || payload.method === "higher_seed" || payload.method === "organiser"
      ? `timeline.core.settle.${payload.method}`
      : null,
};

/** Internal only: the ledger order a line was produced in. Two lines can share
 *  a `seq` (a derived line carries the seq of the event that caused it), so the
 *  sort tie-break has to be something monotone that `seq` is not. */
interface Ordered {
  line: TimelineLineT;
  ordinal: number;
}

function recordedLine(
  event: EventEnvelope,
  sides: readonly [SideT, SideT],
  personOf: (personId: string) => PersonT,
): TimelineLineT {
  const payload = asPayload(event.payload);
  const sideIndex = sideIndexOf(payload, sides);
  const key =
    KEY_OVERRIDE[event.type]?.(payload, sideIndex) ??
    TIMELINE_KEY_FOR[event.type] ??
    TIMELINE_NEUTRAL_KEY;
  const build = PARAMS_FOR[event.type];
  const params = build ? build({ payload, sides, sideIndex, personOf }) : {};
  const text: MsgT = Object.keys(params).length === 0 ? { key } : { key, params };
  return {
    seq: event.seq,
    at: event.recordedAt,
    marker: markerOf(payload),
    sideIndex,
    text,
    emphasis: emphasisOf(event.type),
  };
}

const setsOf = (summary: ScoreSummary, sportKey: string): SetScore[] =>
  setBreakdown(summary, sportKey)?.sets ?? [];
const periodsOf = (summary: ScoreSummary): PeriodScoreRow[] => periodBreakdown(summary) ?? [];

/** Derived lines for one fold step: a set that has just closed, and a period
 *  that has just been left behind. Both read the module's OWN summary — the
 *  timeline never re-derives a score for itself. */
/** `summary.detail.games` — games in the set IN PROGRESS. Tennis only; every
 *  other set-based sport scores points straight into the set and has no such
 *  level. `null` when the shape is absent, which is how a non-tennis summary
 *  and a tennis summary before the first point both answer. */
function gamesOf(summary: ScoreSummary): { home: number; away: number } | null {
  const detail: unknown = (summary as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const games: unknown = (detail as { games?: unknown }).games;
  if (typeof games !== "object" || games === null) return null;
  const home: unknown = (games as { home?: unknown }).home;
  const away: unknown = (games as { away?: unknown }).away;
  if (typeof home !== "number" || typeof away !== "number") return null;
  return { home, away };
}

/**
 * The GAME rung — tennis only, and the reason is that tennis is the only rally
 * sport with a level between the point and the set.
 *
 * Emitted when the games score GROWS without a set closing. A set closing also
 * moves `games` (back to 0–0), and that moment already has its own, better line
 * — `Set 2 to Marchetti — 6–3` — so a game rung there would say the same thing
 * twice and in less detail.
 *
 * HELD OR BROKEN IS READ FROM `before`, not `after`: by the time the summary is
 * taken after the deciding point, `serving` has already flipped to whoever
 * serves the NEXT game, so asking `after` who was serving names the wrong
 * player every single time.
 */
function gameLine(
  before: ScoreSummary,
  after: ScoreSummary,
  event: EventEnvelope,
  sportKey: string,
  sides: readonly [SideT, SideT],
  setIndex: number,
): TimelineLineT | null {
  if (sportKey !== "tennis") return null;

  const gamesBefore = gamesOf(before);
  const gamesAfter = gamesOf(after);
  if (gamesBefore === null || gamesAfter === null) return null;

  const homeWon = gamesAfter.home === gamesBefore.home + 1 && gamesAfter.away === gamesBefore.away;
  const awayWon = gamesAfter.away === gamesBefore.away + 1 && gamesAfter.home === gamesBefore.home;
  if (!homeWon && !awayWon) return null;

  const winner: 0 | 1 = homeWon ? 0 : 1;
  const server = servingSide(before);
  // No server on the record is not a hold — an unknown server cannot be said to
  // have held, and calling it a break would be a guess in the other direction.
  // The neutral of the two is "held", so this stays silent instead and the
  // point/score lines still carry the game.
  if (server === null) return null;
  const held = (server === "home" ? 0 : 1) === winner;

  return {
    seq: event.seq,
    at: event.recordedAt,
    // Raw notation, like `markerOf`'s "67'" — the set this game belongs to.
    marker: `S${setIndex + 1}`,
    sideIndex: winner,
    text: {
      key: held ? TIMELINE_GAME_HELD_KEY : TIMELINE_GAME_BROKEN_KEY,
      params: { side: sides[winner].name, home: gamesAfter.home, away: gamesAfter.away },
    },
    emphasis: "normal",
  };
}

function derivedLines(
  before: ScoreSummary | null,
  after: ScoreSummary,
  event: EventEnvelope,
  sportKey: string,
  sides: readonly [SideT, SideT],
): TimelineLineT[] {
  const out: TimelineLineT[] = [];

  const setsBefore = before === null ? [] : setsOf(before, sportKey);
  const setsAfter = setsOf(after, sportKey);

  const closedNow = setsAfter.some((set, i) => set.closed && setsBefore[i]?.closed !== true);
  if (before !== null && !closedNow) {
    // The set in progress is the last one the engine has opened.
    const line = gameLine(before, after, event, sportKey, sides, Math.max(setsAfter.length - 1, 0));
    if (line !== null) out.push(line);
  }
  for (let i = 0; i < setsAfter.length; i++) {
    const set = setsAfter[i]!;
    if (!set.closed || setsBefore[i]?.closed === true) continue;
    const winner: 0 | 1 = set.home >= set.away ? 0 : 1;
    out.push({
      seq: event.seq,
      at: event.recordedAt,
      marker: null,
      sideIndex: winner,
      text: {
        key: TIMELINE_SET_WON_KEY,
        params: { set: i + 1, home: set.home, away: set.away, winner: sides[winner].name },
      },
      emphasis: "strong",
    });
  }

  // A period is CLOSED by the arrival of the next one: the period kernel and
  // football both push `{ phase, home: 0, away: 0 }` when a phase opens and
  // update only the last entry while it runs, so growth means the previous
  // entry is now final. (Its scores are read from AFTER, which is where they
  // were last written.)
  const periodsBefore = before === null ? [] : periodsOf(before);
  const periodsAfter = periodsOf(after);
  if (periodsBefore.length > 0 && periodsAfter.length > periodsBefore.length) {
    const closed = periodsAfter[periodsBefore.length - 1];
    if (closed) {
      out.push({
        seq: event.seq,
        at: event.recordedAt,
        // No marker: the sentence already names the phase — see `markerOf`.
        marker: null,
        sideIndex: null,
        text: {
          key: TIMELINE_PERIOD_END_KEY,
          params: { phase: closed.phase, home: closed.home, away: closed.away },
        },
        emphasis: "strong",
      });
    }
  }

  return out;
}

/**
 * The fixture's ledger as localised lines, NEWEST FIRST.
 *
 * Two passes, deliberately separated:
 *
 *  - the RECORDED pass turns each surviving envelope into exactly one line and
 *    cannot throw — it never touches the module;
 *  - the DERIVED pass replays `init` / `apply` the way `foldMatch` does and
 *    diffs `module.summary(state)` for closed sets and periods. A ledger the
 *    module refuses part-way (a stale config, an event beyond a decided match)
 *    stops the derivation THERE and keeps whatever it had — a spectator page
 *    must not 500 because the eleventh event of a hundred is unfoldable, and
 *    the recorded lines are all still rendered.
 *
 * `derivedComplete` is how the caller finds out that happened. The degrade used
 * to be an empty `catch {}`, which is the shape a whole class of defect hides
 * in: a fixture whose fold breaks on event two loses EVERY set-won and
 * period-end line, and the page renders a plausible timeline with nothing
 * obviously missing. It is reported rather than swallowed — logged here, and
 * returned so the document can carry it.
 */
export interface TimelineResult {
  lines: TimelineLineT[];
  /** False when the replay stopped early: derived lines beyond that point are
   *  ABSENT, not proven not to exist. */
  derivedComplete: boolean;
}

export function buildTimeline(args: TimelineArgs): TimelineResult {
  const { events, module, cfg, lineups, sides, personOf, sportKey } = args;
  const active = resolveVoids(events);
  if (active.length === 0) return { lines: [], derivedComplete: true };

  // Pass 1 — recorded.
  //
  // `null` rather than a shorter array: the derived pass below indexes its
  // output by POSITION IN `active`, so dropping entries here would slide every
  // derived line onto the wrong event. The nulls are skipped at assembly.
  //
  // A tennis POINT is not rendered. It is the only recorded type suppressed
  // anywhere, and it earns it: 132 point rows and 6.5 phone screens on a short
  // seeded match, each row reading "Point — <name>", with the game and set
  // structure a spectator actually navigates by nowhere on the page. The game
  // rungs `gameLine` derives carry the same ledger at the level the design
  // board draws, and the set lines were already there.
  //
  // NOT EXTENDED TO THE OTHER RALLY SPORTS, deliberately. Badminton, table
  // tennis and volleyball score rallies straight into the set with no level in
  // between, so suppressing their rallies would leave the tab with set lines
  // and nothing else. They have the same volume problem and no natural rung to
  // aggregate to — a design question, recorded rather than guessed at.
  const recorded = active.map((event) =>
    sportKey === "tennis" && event.type === "tennis.point"
      ? null
      : recordedLine(event, sides, personOf),
  );
  const derivedAfter = new Map<number, TimelineLineT[]>();

  // Pass 2 — derived.
  let derivedComplete = true;
  let failedAt: number | null = null;
  try {
    let state = module.init(cfg, lineups);
    let squads: SquadState = initSquads(lineups);
    if (module.onLineup !== undefined) state = module.onLineup(state, squads);
    let previous: ScoreSummary | null = module.summary(state);
    let settled = false;

    for (let i = 0; i < active.length; i++) {
      const event = active[i]!;
      failedAt = event.seq;
      // Everything the kernel folds itself and never hands to a module — the
      // engine's own predicate (W2a I-1), never a list restated here: suspend,
      // resume, settle, the lineup family, and a settled fixture's finalize.
      // Of those only a lineup change moves anything this pass reads.
      if (kernelOwnsEvent(module, event, { state, settled })) {
        if (event.type === "core.settle") settled = true;
        if (isLineupEventType(event.type)) {
          const reduced = reduceLineupEvent(squads, event, REPLAY_LINEUP_POLICY);
          if (reduced.ok) {
            squads = reduced.squads;
            if (module.onLineup !== undefined) state = module.onLineup(state, squads);
          }
        }
        continue;
      }
      state = module.apply(state, event, { strict: false, squads });
      const summary = module.summary(state);
      const extra = derivedLines(previous, summary, event, sportKey, sides);
      if (extra.length > 0) derivedAfter.set(i, extra);
      previous = summary;
    }
    failedAt = null;
  } catch (err) {
    // Degrade to the recorded lines, and SAY SO — both here and in the return
    // value. An empty `catch` made a fixture that loses every derived line
    // indistinguishable from one that had none to lose.
    derivedComplete = false;
    log.warn(
      {
        sportKey,
        seq: failedAt,
        err: err instanceof Error ? err.message : String(err),
      },
      "match-centre timeline replay stopped; derived set/period lines beyond this seq are absent",
    );
  }

  // Assemble in LEDGER order, stamping the ordinal as we go — a derived line
  // therefore sits immediately after the event that caused it and, once the
  // descending sort runs, immediately ABOVE it. The ordinal cannot be stamped
  // during pass 1: the derived lines are not known yet, and numbering them
  // afterwards floated every derived line to the top of the whole timeline.
  const lines: Ordered[] = [];
  for (let i = 0; i < recorded.length; i++) {
    const line = recorded[i];
    if (line != null) lines.push({ line, ordinal: lines.length });
    for (const extra of derivedAfter.get(i) ?? []) {
      lines.push({ line: extra, ordinal: lines.length });
    }
  }

  lines.sort((a, b) => b.ordinal - a.ordinal);
  return { lines: lines.map((entry) => entry.line), derivedComplete };
}

/**
 * The Sets / Periods tab: per-set points (racket and set-based sports) or
 * goals by period (football, field hockey, ice hockey). `null` for a sport
 * whose summary carries neither shape — cricket (its own Scorecard tab),
 * generic, carrom and board games — so the tab is not rendered at all (R4).
 */
export function buildSets(args: SetsArgs): SetsViewT | null {
  const { summary, sportKey } = args;

  const breakdown = setBreakdown(summary, sportKey);
  const sets = breakdown?.sets ?? [];
  if (sets.length > 0) {
    return {
      kind: "sets",
      // `setBreakdown` already owns the badminton/table-tennis "Game" vs
      // "Set" split (`GAME_UNIT_SPORTS` in `lib/public-site.ts`); lower-casing
      // its answer reuses that list instead of forking a second copy that can
      // disagree with the one `live-score.tsx` renders from.
      unit: breakdown?.unit.toLowerCase() === "game" ? "game" : "set",
      columns: sets.map((_, i) => String(i + 1)),
      rows: [sets.map((s) => String(s.home)), sets.map((s) => String(s.away))],
      // The engine's own flag — never inferred from position.
      closedMask: sets.map((s) => s.closed),
    };
  }

  const periods = periodsOf(summary);
  if (periods.length > 0) {
    const phase = matchPhase(summary);
    return {
      kind: "periods",
      unit: "period",
      // Ordinals for the fallback label ("Period 3"), and the ENGINE'S OWN
      // phase token beside each one so the renderer can say "ET 2nd half"
      // instead. Product ruling, and it is the right one: "Period 4" is not
      // what extra time is called, and the distinction between regulation,
      // extra time and overtime is exactly what a spectator opening this tab
      // is looking for. Set-based sports leave `columnLabels` undefined —
      // a set has no name beyond its number.
      columns: periods.map((_, i) => String(i + 1)),
      columnLabels: periods.map((p) => p.phase),
      rows: [periods.map((p) => String(p.home)), periods.map((p) => String(p.away))],
      // `detail.periods` carries no `closed` flag: a period is closed once a
      // later one exists, and the last one is closed too when the kernel says
      // play has moved on to a phase that is not it (a shoot-out, or done).
      closedMask: periods.map(
        (p, i) => i < periods.length - 1 || (phase !== null && phase !== p.phase),
      ),
    };
  }

  return null;
}
