// Spectator surface W1 — the Timeline's dictionary-key table, split out of
// `server/public-site/timeline.ts` so a CLIENT component can import it.
//
// WHY THIS FILE EXISTS AT ALL. `timeline.ts` imports pino (the repo scopes
// `no-console: error` to `src/server/**` and names `server/logger.ts` as the
// logger), and in this app a client component importing anything under
// `@/server/**` is a BUILD FAILURE, not a warning. The key table is exactly the
// part a renderer needs — to recognise a derived line, to assert on a key, to
// map one to an icon — so it lives here, with no server import of any kind, and
// `timeline.ts` re-exports it for its own callers.
//
// Import from `@/lib/timeline-keys` in a component. Import from
// `server/public-site/timeline` only on the server.
//
// Two things about the table itself, both load-bearing:
//
// 1. IT IS KEYED BY THE RECORDED EVENT TYPE STRING, never by a module's
//    declared `eventSchemas` — only five of the eleven modules declare that
//    record at all, so a table derived from the declarations would silently
//    cover half the catalogue. The coverage gate in
//    `server/public-site/__tests__/timeline.test.ts` sweeps the engine's own
//    golden corpora UNION the kernel's `CORE_EVENT_SCHEMAS` /
//    `LINEUP_EVENT_SCHEMAS`, so a new type cannot ship unlocalised.
//
// 2. SEVERAL TYPES SHARE ONE KEY. A template is a SENTENCE: field hockey and
//    ice hockey are one kernel with one vocabulary, the three set-based sports
//    differ only in the set/game noun, and the five `core.lineup.*` siblings
//    all say "this side changed its line-up".

/** The line a recorded type with no template of its own renders. Never nothing. */
export const TIMELINE_NEUTRAL_KEY = "timeline.generic.event";
/** Derived, not recorded: emitted when `summary.detail.sets[i].closed` flips. */
export const TIMELINE_SET_WON_KEY = "timeline.set.won";
/** Derived, not recorded: emitted when `summary.detail.periods` grows. */
export const TIMELINE_PERIOD_END_KEY = "timeline.period.end";

const FOOTBALL = "timeline.football.";
const TENNIS = "timeline.tennis.";
const SETBASED = "timeline.setbased.";
/** Field hockey and ice hockey ride the period kernel and one vocabulary. */
const PERIODSPORT = "timeline.periodsport.";

/**
 * Keys a per-payload override can emit INSTEAD of the type's table entry.
 *
 * `boardgame.result` is the only one today: with a winner it is a decisive
 * result, without one it is a draw, and the two are different sentences. These
 * are unioned into the dictionary coverage gates exactly like `TIMELINE_KEY_FOR`
 * — a key reachable at runtime that no locale carries is the same defect
 * whether it comes from the table or from an override.
 */
export const TIMELINE_OVERRIDE_KEYS: readonly string[] = ["timeline.boardgame.draw"];

/** The template table: recorded event type -> dictionary key. */
export const TIMELINE_KEY_FOR: Readonly<Record<string, string>> = {
  "core.start": "timeline.core.start",
  "core.forfeit": "timeline.core.forfeit",
  "core.abandon": "timeline.core.abandon",
  // The rest of the KERNEL's own vocabulary. The golden corpora record only
  // start / forfeit / abandon, so a table built from the corpora alone would
  // have left the other nine to the neutral line — and one of them,
  // `core.note`, is an OFFICIAL'S OWN ANNOTATION: rendering that as "Match
  // event" throws away the only free text in the ledger.
  "core.note": "timeline.core.note",
  "core.finalize": "timeline.core.finalize",
  "core.award": "timeline.core.award",
  "core.suspend": "timeline.core.suspend",
  "core.resume": "timeline.core.resume",
  "core.lineup.substitution": "timeline.core.lineup",
  "core.lineup.replacement": "timeline.core.lineup",
  "core.lineup.position": "timeline.core.lineup",
  "core.lineup.retirement": "timeline.core.lineup",
  "core.lineup.entry": "timeline.core.lineup",
  // `core.void` is deliberately ABSENT: `resolveVoids` removes it and its
  // target before pass 1, so it can never reach a line. The neutral key covers
  // it if that ever changes.

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

  "carrom.toss": "timeline.carrom.toss",
  "carrom.board.summary": "timeline.carrom.board.summary",
  "carrom.game.adjust": "timeline.carrom.game.adjust",

  "boardgame.pairing": "timeline.boardgame.pairing",
  "boardgame.result": "timeline.boardgame.result",

  "generic.score": "timeline.generic.score",
  "generic.result": "timeline.generic.result",
};
