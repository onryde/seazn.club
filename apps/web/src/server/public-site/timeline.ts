// Spectator surface W1 — the Timeline and the Sets / Periods table for every
// sport that is NOT cricket (cricket gets a Scorecard and a Commentary tab from
// its own fold instead). Design:
// `docs/superpowers/specs/2026-09-04-spectator-surface-design.md` §W1,
// "Every other sport in W1".
//
// NO `server-only` here on purpose: this file is a pure builder over an event
// ledger and a `ScoreSummary`, so the live block can re-run it client-side from
// a pushed payload if a later wave wants to (R10, "every tab re-renders in
// place"). It reaches for `@/lib/public-site`'s `setBreakdown` / `periodBreakdown`
// rather than re-reading `summary.detail` for itself: those two are the repo's
// existing readers of that shape and `live-score.tsx` already renders from them.
//
// ---------------------------------------------------------------------------
// Three things about this file that are NOT derivable from reading it
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
// KNOWN GAP, recorded rather than half-fixed: a few templates interpolate an
// engine enum token verbatim — `{colour}` (yellow/red/second_yellow),
// `{outcome}`, `{level}`, `{class}`, `{kind}`, `{method}`. Those tokens are not
// translated, so a Dutch reader sees "yellow kaart". Closing it needs a term
// table the RENDERER resolves (`ui.json` already has `cardColor.second_yellow`
// for the console), which is Task 8's surface, not this builder's — adding one
// here that nothing consumes would be an inert seam. The brief names these
// fields as params (`football.card -> { side, person, colour, minute }`), so
// this file supplies them and the gap is reported.
import {
  REPLAY_LINEUP_POLICY,
  initSquads,
  isLineupEventType,
  reduceLineupEvent,
  resolveVoids,
  type EventEnvelope,
  type LineupPair,
  type ScoreSummary,
  type SquadState,
} from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { periodBreakdown, setBreakdown, type PeriodScoreRow, type SetScore } from "@/lib/public-site";
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

/** The line a recorded type with no template of its own renders. Never nothing. */
export const TIMELINE_NEUTRAL_KEY = "public.timeline.generic.event";
/** Derived, not recorded: emitted when `summary.detail.sets[i].closed` flips. */
export const TIMELINE_SET_WON_KEY = "public.timeline.set.won";
/** Derived, not recorded: emitted when `summary.detail.periods` grows. */
export const TIMELINE_PERIOD_END_KEY = "public.timeline.period.end";

const FOOTBALL = "public.timeline.football.";
const TENNIS = "public.timeline.tennis.";
const SETBASED = "public.timeline.setbased.";
/** Field hockey and ice hockey ride the period kernel and one vocabulary. */
const PERIODSPORT = "public.timeline.periodsport.";

/** The template table: recorded event type -> dictionary key. */
export const TIMELINE_KEY_FOR: Readonly<Record<string, string>> = {
  "core.start": "public.timeline.core.start",
  "core.forfeit": "public.timeline.core.forfeit",
  "core.abandon": "public.timeline.core.abandon",

  "football.goal": `${FOOTBALL}goal`,
  "football.card": `${FOOTBALL}card`,
  "football.sub": `${FOOTBALL}sub`,
  "football.period": `${FOOTBALL}period`,
  "football.shootout.kick": `${FOOTBALL}shootout.kick`,
  "football.penalty": `${FOOTBALL}penalty`,
  "football.sinbin.start": `${FOOTBALL}sinbin.start`,
  "football.sinbin.end": `${FOOTBALL}sinbin.end`,
  "football.shot": `${FOOTBALL}shot`,

  "tennis.point": `${TENNIS}point`,
  "tennis.game.award": `${TENNIS}game.award`,
  "tennis.set_summary": `${TENNIS}set_summary`,
  "tennis.sanction": `${TENNIS}sanction`,
  "tennis.interruption": `${TENNIS}interruption`,

  "volleyball.rally": `${SETBASED}rally`,
  "volleyball.set.summary": `${SETBASED}set.summary`,
  "volleyball.sanction": `${SETBASED}sanction`,
  "volleyball.sub": `${SETBASED}sub`,
  "volleyball.timeout": `${SETBASED}timeout`,
  "volleyball.expedite.start": `${SETBASED}expedite`,
  "badminton.rally": `${SETBASED}rally`,
  "badminton.game.summary": `${SETBASED}game.summary`,
  "badminton.sanction": `${SETBASED}sanction`,
  "badminton.sub": `${SETBASED}sub`,
  "badminton.timeout": `${SETBASED}timeout`,
  "badminton.expedite.start": `${SETBASED}expedite`,
  "tabletennis.rally": `${SETBASED}rally`,
  "tabletennis.game.summary": `${SETBASED}game.summary`,
  "tabletennis.sanction": `${SETBASED}sanction`,
  "tabletennis.sub": `${SETBASED}sub`,
  "tabletennis.timeout": `${SETBASED}timeout`,
  "tabletennis.expedite.start": `${SETBASED}expedite`,

  "hockey.goal": `${PERIODSPORT}goal`,
  "hockey.period.advance": `${PERIODSPORT}advance`,
  "hockey.set_piece": `${PERIODSPORT}setPiece`,
  "hockey.shootout.attempt": `${PERIODSPORT}shootout.attempt`,
  "hockey.shot": `${PERIODSPORT}shot`,
  "hockey.suspension.start": `${PERIODSPORT}suspension.start`,
  "hockey.suspension.end": `${PERIODSPORT}suspension.end`,
  "icehockey.goal": `${PERIODSPORT}goal`,
  "icehockey.period.advance": `${PERIODSPORT}advance`,
  "icehockey.set_piece": `${PERIODSPORT}setPiece`,
  "icehockey.shootout.attempt": `${PERIODSPORT}shootout.attempt`,
  "icehockey.shot": `${PERIODSPORT}shot`,
  "icehockey.suspension.start": `${PERIODSPORT}suspension.start`,
  "icehockey.suspension.end": `${PERIODSPORT}suspension.end`,

  "carrom.toss": "public.timeline.carrom.toss",
  "carrom.board.summary": "public.timeline.carrom.board.summary",
  "carrom.game.adjust": "public.timeline.carrom.game.adjust",

  "boardgame.pairing": "public.timeline.boardgame.pairing",
  "boardgame.result": "public.timeline.boardgame.result",

  "generic.score": "public.timeline.generic.score",
  "generic.result": "public.timeline.generic.result",
};

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
const SIDE_FIELDS = ["by", "wonBy", "winner", "winnerId", "entrantId", "firstBreak", "white"];

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
 *  `GameTime` stamp as "H1 4:00", else the phase label the event names. */
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

  const phase = payload.phase ?? payload.to;
  return typeof phase === "string" && phase !== "" ? phase : null;
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

/** Per-type params. Keyed by RECORDED TYPE (not by dictionary key) so two
 *  sports sharing one template can still read their own payload field names. */
const PARAMS_FOR: Record<string, (ctx: ParamCtx) => Params> = {
  "core.start": () => ({}),
  "core.forfeit": (c) => ({ side: sideNameOf(c) }),
  "core.abandon": () => ({}),

  "football.goal": (c) => {
    const assist = nameOf(c, "assist");
    const flags = [
      c.payload.ownGoal === true ? "(og)" : "",
      c.payload.penalty === true ? "(pen)" : "",
    ];
    return {
      side: sideNameOf(c),
      detail: detailOf(nameOf(c, "scorer"), assist === "" ? "" : `(${assist})`, ...flags),
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
  "boardgame.result": (c) => ({ side: sideNameOf(c), method: S(c.payload.method) }),

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
  const key = TIMELINE_KEY_FOR[event.type] ?? TIMELINE_NEUTRAL_KEY;
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
        marker: closed.phase,
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
 */
export function buildTimeline(args: TimelineArgs): TimelineLineT[] {
  const { events, module, cfg, lineups, sides, personOf, sportKey } = args;
  const active = resolveVoids(events);
  if (active.length === 0) return [];

  // Pass 1 — recorded.
  const recorded = active.map((event) => recordedLine(event, sides, personOf));
  const derivedAfter = new Map<number, TimelineLineT[]>();

  // Pass 2 — derived.
  try {
    let state = module.init(cfg, lineups);
    let squads: SquadState = initSquads(lineups);
    if (module.onLineup !== undefined) state = module.onLineup(state, squads);
    let previous: ScoreSummary | null = module.summary(state);

    for (let i = 0; i < active.length; i++) {
      const event = active[i]!;
      // The three event families `foldMatch` never hands to a module.
      if (event.type === "core.suspend" || event.type === "core.resume") continue;
      if (isLineupEventType(event.type)) {
        const reduced = reduceLineupEvent(squads, event, REPLAY_LINEUP_POLICY);
        if (reduced.ok) {
          squads = reduced.squads;
          if (module.onLineup !== undefined) state = module.onLineup(state, squads);
        }
        continue;
      }
      state = module.apply(state, event, { strict: false, squads });
      const summary = module.summary(state);
      const extra = derivedLines(previous, summary, event, sportKey, sides);
      if (extra.length > 0) derivedAfter.set(i, extra);
      previous = summary;
    }
  } catch {
    // Degrade to the recorded lines derived so far. See the doc comment.
  }

  // Assemble in LEDGER order, stamping the ordinal as we go — a derived line
  // therefore sits immediately after the event that caused it and, once the
  // descending sort runs, immediately ABOVE it. The ordinal cannot be stamped
  // during pass 1: the derived lines are not known yet, and numbering them
  // afterwards floated every derived line to the top of the whole timeline.
  const lines: Ordered[] = [];
  for (let i = 0; i < recorded.length; i++) {
    lines.push({ line: recorded[i]!, ordinal: lines.length });
    for (const extra of derivedAfter.get(i) ?? []) {
      lines.push({ line: extra, ordinal: lines.length });
    }
  }

  lines.sort((a, b) => b.ordinal - a.ordinal);
  return lines.map((entry) => entry.line);
}

/** The phase the period kernel says is in play, when its summary carries one.
 *  Football's summary does not (its `detail` is `{ periods, shootout? }`), so
 *  for football the last recorded period always reads as the open one. */
function currentPhaseOf(summary: ScoreSummary): string | null {
  const detail = summary.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const phase = (detail as { phase?: unknown }).phase;
  return typeof phase === "string" && phase !== "" ? phase : null;
}

/**
 * The Sets / Periods tab: per-set points (racket and set-based sports) or
 * goals by period (football, field hockey, ice hockey). `null` for a sport
 * whose summary carries neither shape — cricket (its own Scorecard tab),
 * generic, carrom and board games — so the tab is not rendered at all (R4).
 */
export function buildSets(args: SetsArgs): SetsViewT | null {
  const { summary, sportKey } = args;

  const sets = setsOf(summary, sportKey);
  if (sets.length > 0) {
    return {
      kind: "sets",
      columns: sets.map((_, i) => String(i + 1)),
      rows: [sets.map((s) => String(s.home)), sets.map((s) => String(s.away))],
      // The engine's own flag — never inferred from position.
      closedMask: sets.map((s) => s.closed),
    };
  }

  const periods = periodsOf(summary);
  if (periods.length > 0) {
    const phase = currentPhaseOf(summary);
    return {
      kind: "periods",
      columns: periods.map((p) => p.phase),
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
