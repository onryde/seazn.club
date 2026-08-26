// Locale-aware display labels for scoring domain vocab whose STORED form stays
// English (DB sport_key, event-ledger payload kinds, palette hex→name). Every
// vocab here is a closed enum, so each helper indexes a typed
// Record<Enum, MessageKey> map: the Record forces every member to be mapped, and
// the MessageKey value forces every key to exist in ui.json — both nets hold at
// compile time, and there are no dynamic key strings. Unknown runtime values
// (payloads are `string`) fall back to a humanized token, never throw.
//
// #427 adds three more layers on top of the closed enums below: `EVENT_KEY`
// (every event type the shipped sport modules declare), `ENUM_VOCAB` (every
// enum member those modules' payload schemas can carry, keyed by the FIELD the
// enum sits on — payloads carry no type discriminator, so the field name is the
// only stable handle) and `ENGINE_ERROR_KEY`. Those three sets are open-ended —
// they grow whenever the engine grows — so the compiler cannot force them.
// `__tests__/scoring-vocab.test.ts` does instead, by DERIVING the expected sets
// from the engine's own declarations at test time.
//
// #S13 — `SportKey` just below gets the same runtime discipline for a
// different reason. It IS closed (like `WicketKind`/`ExtraKind`), so its
// `SPORT_KEY` Record already forces every member to carry a label at compile
// time; what the compiler cannot force is that the union's MEMBERSHIP stays
// equal to the engine's own `builtinModules` keys. That equality can't be
// pushed to the type level either — `SportModule.key` is declared plain
// `string` (`packages/engine/src/sport/module.ts`), so every shipped module
// widens back to `string` the moment it's typed against that interface, and
// `(typeof builtinModules)[number]["key"]` buys nothing (proved by probe, not
// assumed — see the S13 task notes). So `SportKey` stays hand-written and is
// pinned instead: `__tests__/scoring-vocab.test.ts` derives the real key set
// from `builtinModules` and reds if `SPORT_KEY` ever carries more, fewer, or
// different keys than the engine ships.
import type { MessageKey } from "@/lib/messages";
import type { EngineErrorCode, SquadProvenance, SquadRole } from "@seazn/engine/core";
import { swatchName } from "@/lib/brand-palette";

export type WicketKind =
  | "bowled" | "caught" | "lbw" | "runout" | "stumped"
  | "hitwicket" | "retired" | "obstructed" | "timedout" | "hitballtwice";
export type ExtraKind = "wide" | "noball" | "bye" | "legbye" | "penalty";
/**
 * Every sport key the engine ships — see the #S13 note above for why this is
 * hand-written rather than derived, and pinned rather than left to drift.
 */
export type SportKey =
  | "badminton" | "boardgame" | "carrom" | "cricket" | "football" | "generic"
  | "hockey" | "icehockey" | "tabletennis" | "tennis" | "volleyball";

const WICKET_KEY: Record<WicketKind, MessageKey> = {
  bowled: "wicket.bowled", caught: "wicket.caught", lbw: "wicket.lbw",
  runout: "wicket.runout", stumped: "wicket.stumped", hitwicket: "wicket.hitwicket",
  retired: "wicket.retired", obstructed: "wicket.obstructed", timedout: "wicket.timedout",
  // Reuses ENUM_VOCAB's existing "kind.hitballtwice" key rather than minting a
  // duplicate — wicketLabel() previously checked ONLY this map, never falling
  // through to KIND_KEY the way enumLabel("kind", …) does, so the picker
  // rendered "Hitballtwice" (naive capitalize) though the correct translated
  // string already existed and was reachable from every OTHER kind lookup.
  hitballtwice: "kind.hitballtwice",
};
const EXTRA_KEY: Record<ExtraKind, MessageKey> = {
  wide: "extra.wide", noball: "extra.noball", bye: "extra.bye",
  legbye: "extra.legbye", penalty: "extra.penalty",
};
/** Exported so `__tests__/scoring-vocab.test.ts` can pin its keys to the
 *  engine's `builtinModules` at test time — see the #S13 note above. */
export const SPORT_KEY: Record<SportKey, MessageKey> = {
  badminton: "sport.badminton", boardgame: "sport.boardgame", carrom: "sport.carrom",
  cricket: "sport.cricket", football: "sport.football", generic: "sport.generic",
  hockey: "sport.hockey", icehockey: "sport.icehockey", tabletennis: "sport.tabletennis",
  tennis: "sport.tennis", volleyball: "sport.volleyball",
};
const SWATCH_KEY: Record<string, MessageKey> = {
  Teal: "swatch.Teal", Ocean: "swatch.Ocean", Cobalt: "swatch.Cobalt",
  Midnight: "swatch.Midnight", Forest: "swatch.Forest", Ember: "swatch.Ember",
  Bronze: "swatch.Bronze", Crimson: "swatch.Crimson", Magenta: "swatch.Magenta",
  Graphite: "swatch.Graphite",
};

/** Every event type the shipped sport modules declare, plus the core ledger. */
export const EVENT_KEY: Record<string, MessageKey> = {
  "core.start": "event.core.start", "core.void": "event.core.void",
  "core.forfeit": "event.core.forfeit", "core.abandon": "event.core.abandon",
  "core.finalize": "event.core.finalize", "core.note": "event.core.note",
  "core.award": "event.core.award", "core.suspend": "event.core.suspend",
  "core.resume": "event.core.resume",
  // S3/W4b (#426) — the lineup family. `replacement` is the exemptible one
  // (concussion / injury / COVID), which is why fr distinguishes it from a
  // plain `substitution`: both are "remplacement" in football French and a
  // reader cannot tell an exempt change from a counted one otherwise.
  "core.lineup.substitution": "event.core.lineup.substitution",
  "core.lineup.replacement": "event.core.lineup.replacement",
  "core.lineup.position": "event.core.lineup.position",
  "core.lineup.retirement": "event.core.lineup.retirement",
  "core.lineup.entry": "event.core.lineup.entry",

  "badminton.game.summary": "event.badminton.game.summary",
  "badminton.rally": "event.badminton.rally",
  "badminton.sanction": "event.badminton.sanction",

  "boardgame.pairing": "event.boardgame.pairing",
  "boardgame.result": "event.boardgame.result",

  "carrom.board.summary": "event.carrom.board.summary",
  "carrom.game.adjust": "event.carrom.game.adjust",
  "carrom.toss": "event.carrom.toss",

  "cricket.ball": "event.cricket.ball",
  "cricket.followon": "event.cricket.followon",
  "cricket.innings.close": "event.cricket.innings.close",
  "cricket.innings.declare": "event.cricket.innings.declare",
  "cricket.innings.summary": "event.cricket.innings.summary",
  "cricket.interruption": "event.cricket.interruption",
  "cricket.match.close": "event.cricket.match.close",
  "cricket.newball": "event.cricket.newball",
  "cricket.player.line": "event.cricket.player.line",
  "cricket.powerplay": "event.cricket.powerplay",
  "cricket.retire": "event.cricket.retire",
  "cricket.review": "event.cricket.review",
  "cricket.revise": "event.cricket.revise",
  "cricket.superover.ball": "event.cricket.superover.ball",
  "cricket.toss": "event.cricket.toss",

  "football.card": "event.football.card",
  "football.goal": "event.football.goal",
  "football.penalty": "event.football.penalty",
  "football.period": "event.football.period",
  "football.shootout.kick": "event.football.shootout.kick",
  "football.shot": "event.football.shot",
  "football.sinbin.start": "event.football.sinbin.start",
  "football.sinbin.end": "event.football.sinbin.end",
  "football.sub": "event.football.sub",

  "generic.result": "event.generic.result",
  "generic.score": "event.generic.score",

  "hockey.goal": "event.hockey.goal",
  "hockey.period.advance": "event.hockey.period.advance",
  "hockey.set_piece": "event.hockey.set_piece",
  "hockey.shootout.attempt": "event.hockey.shootout.attempt",
  "hockey.shot": "event.hockey.shot",
  "hockey.suspension.start": "event.hockey.suspension.start",
  "hockey.suspension.end": "event.hockey.suspension.end",

  "icehockey.goal": "event.icehockey.goal",
  "icehockey.period.advance": "event.icehockey.period.advance",
  "icehockey.set_piece": "event.icehockey.set_piece",
  "icehockey.shootout.attempt": "event.icehockey.shootout.attempt",
  "icehockey.shot": "event.icehockey.shot",
  "icehockey.suspension.start": "event.icehockey.suspension.start",
  "icehockey.suspension.end": "event.icehockey.suspension.end",

  "tabletennis.expedite.start": "event.tabletennis.expedite.start",
  "tabletennis.game.summary": "event.tabletennis.game.summary",
  "tabletennis.rally": "event.tabletennis.rally",
  "tabletennis.sanction": "event.tabletennis.sanction",
  "tabletennis.timeout": "event.tabletennis.timeout",

  "tennis.game.award": "event.tennis.game.award",
  "tennis.interruption": "event.tennis.interruption",
  "tennis.point": "event.tennis.point",
  "tennis.sanction": "event.tennis.sanction",
  "tennis.set_summary": "event.tennis.set_summary",

  "volleyball.rally": "event.volleyball.rally",
  "volleyball.sanction": "event.volleyball.sanction",
  "volleyball.set.summary": "event.volleyball.set.summary",
  "volleyball.sub": "event.volleyball.sub",
  "volleyball.timeout": "event.volleyball.timeout",
};

/**
 * The cross-sport match-position axis (W4a, `@seazn/engine/core` position.ts):
 * one `key` per ordered segment — "Set 2 · 30–15", "Innings 1 · Over 12.3",
 * "P2 · 12:41" — that a single renderer draws for all eleven sports.
 *
 * The engine emits `key` as the stable token and writes no locale copy; its
 * optional `label` is an English fallback, present only where a value needs a
 * noun to read. The three label-less keys (`period`, `clock`, `points`) are
 * mapped anyway: a value that names itself inline still needs a noun the
 * moment a surface heads a column with it or an assistive reader announces it,
 * and a gap there is a hardcoded English string waiting to happen.
 *
 * Derived, never hand-listed — `__tests__/scoring-vocab.test.ts` folds real
 * streams for the nine projecting sports and reds on any key missing here.
 */
export const POSITION_KEY: Record<string, MessageKey> = {
  set: "scoring.position.set",
  game: "scoring.position.game",
  innings: "scoring.position.innings",
  over: "scoring.position.over",
  board: "scoring.position.board",
  points: "scoring.position.points",
  period: "scoring.position.period",
  clock: "scoring.position.clock",
};

/**
 * Match awards, shared by two surfaces that used to name them independently:
 * the player-stat rows below (`*_awards`) and the fixture console's `core.award`
 * line. One key per award, so "Man of the Match" is translated once.
 */
const AWARD_KEY: Record<string, MessageKey> = {
  motm: "award.motm", mvp: "award.mvp", potm: "award.potm",
};

/**
 * Player-stat row labels, keyed `<sportKey>.<rowKey>` — the row key is the one
 * a snapshot carries, so awards appear here with their `_awards` suffix.
 *
 * PER-SPORT BY NECESSITY, not by taste. Five metric keys are declared by more
 * than one sport with DIFFERENT English: `sanctions` is "Sanctions" in
 * volleyball and "Cards" in badminton and table tennis; `points` is "Points won"
 * in tennis; `so_attempts` / `so_goals` / `so_saves` are the IIHF's "GWS *" on
 * ice and the FIH's "SO *" on grass. A flat `stat.sanctions` would force one
 * sport's wording onto another in four languages, and nothing on screen would
 * show it — the engine's English `label` always renders something plausible.
 * `__tests__/player-stat-vocab.test.ts` derives that collision set from the
 * engine and reds if any locale collapses two of them into one word.
 *
 * The three award rows point at `AWARD_KEY` rather than minting `stat.*` copy,
 * because the console names the same awards.
 */
export const PLAYER_STAT_KEY: Record<string, MessageKey> = {
  "football.goals": "stat.football.goals",
  "football.assists": "stat.football.assists",
  "football.yellow_cards": "stat.football.yellow_cards",
  "football.red_cards": "stat.football.red_cards",
  "football.penalty_goals": "stat.football.penalty_goals",
  "football.penalties_missed": "stat.football.penalties_missed",
  "football.own_goals": "stat.football.own_goals",
  "football.sin_bins": "stat.football.sin_bins",
  "football.points": "stat.football.points",
  "football.motm_awards": AWARD_KEY.motm,
  // S8/#417 W6 — the goalkeeper metrics (`playerStats.folded`, football.ts)
  // plus the shooter's own `shots`/`shots_on_target` (plain metrics, same
  // wave). Identical English across football/hockey/icehockey below — one
  // shared goalkeeping/shooting vocabulary, not three names for one concept.
  "football.goals_conceded": "stat.football.goals_conceded",
  "football.clean_sheets": "stat.football.clean_sheets",
  "football.saves": "stat.football.saves",
  "football.shots_faced": "stat.football.shots_faced",
  "football.save_percentage": "stat.football.save_percentage",
  "football.shots": "stat.football.shots",
  "football.shots_on_target": "stat.football.shots_on_target",

  "cricket.runs": "stat.cricket.runs",
  "cricket.balls_faced": "stat.cricket.balls_faced",
  "cricket.balls_bowled": "stat.cricket.balls_bowled",
  "cricket.runs_conceded": "stat.cricket.runs_conceded",
  "cricket.wickets": "stat.cricket.wickets",
  "cricket.catches": "stat.cricket.catches",
  "cricket.stumpings": "stat.cricket.stumpings",
  "cricket.run_outs": "stat.cricket.run_outs",
  "cricket.fours": "stat.cricket.fours",
  "cricket.sixes": "stat.cricket.sixes",
  // S8/#417 — the batter's dismissal splits. One row per `CricketWicket.kind`
  // member, so this list is only complete while the enum is unchanged; the
  // engine derives the metrics from `CricketWicket.shape.kind.options` and the
  // vocab gate reds here the moment a new Law adds a mode.
  "cricket.dismissals": "stat.cricket.dismissals",
  "cricket.dismissals_bowled": "stat.cricket.dismissals_bowled",
  "cricket.dismissals_caught": "stat.cricket.dismissals_caught",
  "cricket.dismissals_lbw": "stat.cricket.dismissals_lbw",
  "cricket.dismissals_runout": "stat.cricket.dismissals_runout",
  "cricket.dismissals_stumped": "stat.cricket.dismissals_stumped",
  "cricket.dismissals_hitwicket": "stat.cricket.dismissals_hitwicket",
  "cricket.dismissals_retired": "stat.cricket.dismissals_retired",
  "cricket.dismissals_obstructed": "stat.cricket.dismissals_obstructed",
  "cricket.dismissals_timedout": "stat.cricket.dismissals_timedout",
  "cricket.dismissals_hitballtwice": "stat.cricket.dismissals_hitballtwice",

  "boardgame.games": "stat.boardgame.games",
  "boardgame.wins": "stat.boardgame.wins",
  // S8/#417 W6 — `playerStats.folded` (boardgame.ts): draws/losses cannot be
  // a plain metric+field walk (no single entrant field names a draw, and a
  // decisive result's LOSER has none of its own), white/black are the
  // pairing card's colour split.
  "boardgame.draws": "stat.boardgame.draws",
  "boardgame.losses": "stat.boardgame.losses",
  "boardgame.white": "stat.boardgame.white",
  "boardgame.black": "stat.boardgame.black",

  "carrom.breaks": "stat.carrom.breaks",
  "carrom.queens": "stat.carrom.queens",
  "carrom.penalties": "stat.carrom.penalties",
  "carrom.boards_won": "stat.carrom.boards_won",
  // S8/#417 W6 — `playerStats.folded` (carrom.ts): the match-level outcome a
  // metric+field walk cannot express (no payload ever names "who won the
  // match", only who won each board).
  "carrom.matches": "stat.carrom.matches",
  "carrom.wins": "stat.carrom.wins",

  "generic.points": "stat.generic.points",
  "generic.scores": "stat.generic.scores",
  // S8/#417 W6 — `playerStats.folded` (generic.ts): the terminal result is
  // entrant-only by design, so win/draw/loss/points-for reach a person only
  // through the caller-supplied roster.
  "generic.wins": "stat.generic.wins",
  "generic.draws": "stat.generic.draws",
  "generic.losses": "stat.generic.losses",
  "generic.points_for": "stat.generic.points_for",

  "volleyball.points": "stat.volleyball.points",
  "volleyball.serves": "stat.volleyball.serves",
  "volleyball.sanctions": "stat.volleyball.sanctions",
  // S8/#417 — `points_won` comes from the set-based/nested KERNEL default, so
  // all four sports declare it with the same English. Keyed per sport anyway:
  // the scheme's rule is one key per (sport, row), and a shared key here would
  // have to be un-shared the first time one sport's word diverges.
  "volleyball.points_won": "stat.volleyball.points_won",
  // S8/#417 W6 — the setbased-kernel default `playerStats.folded`: match/set
  // OUTCOMES a metric+field walk over individual rallies cannot express.
  // `sets_won`/`sets_lost` keep volleyball's own "Sets" wording (its
  // `unitLabel`, setbased/kernel.ts) — matches this sport's OWN standings
  // column for the same fact, one word choice, not two.
  "volleyball.matches": "stat.volleyball.matches",
  "volleyball.sets_won": "stat.volleyball.sets_won",
  "volleyball.sets_lost": "stat.volleyball.sets_lost",

  "badminton.points": "stat.badminton.points",
  "badminton.serves": "stat.badminton.serves",
  "badminton.sanctions": "stat.badminton.sanctions",
  "badminton.points_won": "stat.badminton.points_won",
  // S8/#417 W6 — same kernel default as volleyball's above, but badminton's
  // OWN `unitLabel` calls this unit a "Game" everywhere else in its product
  // surface (its own standings column, `setbased/badminton.ts`), so this
  // reads "Games won"/"Games lost" here — deliberately DIFFERENT English
  // from volleyball's "Sets won"/"Sets lost" for the identical row key,
  // which is exactly the collision `collidingMetricKeys()` (player-stat-
  // vocab.test.ts) exists to force apart.
  "badminton.matches": "stat.badminton.matches",
  "badminton.sets_won": "stat.badminton.sets_won",
  "badminton.sets_lost": "stat.badminton.sets_lost",

  "tabletennis.points": "stat.tabletennis.points",
  "tabletennis.serves": "stat.tabletennis.serves",
  "tabletennis.sanctions": "stat.tabletennis.sanctions",
  "tabletennis.points_won": "stat.tabletennis.points_won",
  // S8/#417 W6 — table tennis also calls its unit a "Game" (its own
  // `unitLabel`), same reasoning as badminton immediately above.
  "tabletennis.matches": "stat.tabletennis.matches",
  "tabletennis.sets_won": "stat.tabletennis.sets_won",
  "tabletennis.sets_lost": "stat.tabletennis.sets_lost",

  "tennis.points": "stat.tennis.points",
  "tennis.service_points": "stat.tennis.service_points",
  "tennis.aces": "stat.tennis.aces",
  "tennis.double_faults": "stat.tennis.double_faults",
  "tennis.violations": "stat.tennis.violations",
  "tennis.medical_timeouts": "stat.tennis.medical_timeouts",
  "tennis.points_won": "stat.tennis.points_won",
  // S8/#417 W6 — the nested-kernel twin of the setbased rows above.
  // `sets_won`/`sets_lost` read "Sets won"/"Sets lost" (tennis genuinely
  // plays in sets, matching volleyball's wording); `games_won` is the
  // kernel-specific addition — tennis alone has a game layer between points
  // and sets.
  "tennis.matches": "stat.tennis.matches",
  "tennis.sets_won": "stat.tennis.sets_won",
  "tennis.sets_lost": "stat.tennis.sets_lost",
  "tennis.games_won": "stat.tennis.games_won",

  "icehockey.goals": "stat.icehockey.goals",
  "icehockey.assists": "stat.icehockey.assists",
  "icehockey.pen_minor": "stat.icehockey.pen_minor",
  "icehockey.pen_double": "stat.icehockey.pen_double",
  "icehockey.pen_major": "stat.icehockey.pen_major",
  "icehockey.pen_misc": "stat.icehockey.pen_misc",
  "icehockey.pen_gm": "stat.icehockey.pen_gm",
  "icehockey.pen_match": "stat.icehockey.pen_match",
  "icehockey.goals_pp": "stat.icehockey.goals_pp",
  "icehockey.goals_sh": "stat.icehockey.goals_sh",
  "icehockey.goals_ps": "stat.icehockey.goals_ps",
  "icehockey.goals_en": "stat.icehockey.goals_en",
  "icehockey.ps_taken": "stat.icehockey.ps_taken",
  "icehockey.so_attempts": "stat.icehockey.so_attempts",
  "icehockey.so_goals": "stat.icehockey.so_goals",
  "icehockey.so_saves": "stat.icehockey.so_saves",
  "icehockey.pen_served": "stat.icehockey.pen_served",
  "icehockey.points": "stat.icehockey.points",
  "icehockey.pim": "stat.icehockey.pim",
  "icehockey.mvp_awards": AWARD_KEY.mvp,
  // S8/#417 W6 — `playerStats.folded` (`periodKeeperStatsFold`, shared with
  // hockey below) plus the shooter's own `shots`/`shots_on_target`. Same
  // English as football's/hockey's own block — see football's comment above.
  "icehockey.goals_conceded": "stat.icehockey.goals_conceded",
  "icehockey.clean_sheets": "stat.icehockey.clean_sheets",
  "icehockey.saves": "stat.icehockey.saves",
  "icehockey.shots_faced": "stat.icehockey.shots_faced",
  "icehockey.save_percentage": "stat.icehockey.save_percentage",
  "icehockey.shots": "stat.icehockey.shots",
  "icehockey.shots_on_target": "stat.icehockey.shots_on_target",

  "hockey.goals": "stat.hockey.goals",
  "hockey.green_cards": "stat.hockey.green_cards",
  "hockey.yellow_cards": "stat.hockey.yellow_cards",
  "hockey.red_cards": "stat.hockey.red_cards",
  "hockey.goals_pc": "stat.hockey.goals_pc",
  "hockey.goals_stroke": "stat.hockey.goals_stroke",
  "hockey.goals_en": "stat.hockey.goals_en",
  "hockey.strokes_taken": "stat.hockey.strokes_taken",
  "hockey.pc_taken": "stat.hockey.pc_taken",
  "hockey.so_attempts": "stat.hockey.so_attempts",
  "hockey.so_goals": "stat.hockey.so_goals",
  "hockey.so_saves": "stat.hockey.so_saves",
  "hockey.cards_served": "stat.hockey.cards_served",
  "hockey.potm_awards": AWARD_KEY.potm,
  // S8/#417 W6 — `playerStats.folded` (`periodKeeperStatsFold`, shared with
  // icehockey above) plus the shooter's own `shots`/`shots_on_target`.
  "hockey.goals_conceded": "stat.hockey.goals_conceded",
  "hockey.clean_sheets": "stat.hockey.clean_sheets",
  "hockey.saves": "stat.hockey.saves",
  "hockey.shots_faced": "stat.hockey.shots_faced",
  "hockey.save_percentage": "stat.hockey.save_percentage",
  "hockey.shots": "stat.hockey.shots",
  "hockey.shots_on_target": "stat.hockey.shots_on_target",
};

const CARD_COLOR_KEY: Record<string, MessageKey> = {
  yellow: "cardColor.yellow", red: "cardColor.red",
  second_yellow: "cardColor.second_yellow",
};
// Football's 13 CardReason members, cricket's innings-close / retire reasons,
// plus S4 (#428)'s hockey/icehockey PeriodSuspensionReason members (23 total,
// 2 of which — dissent, other — already had a key from football/cricket).
const REASON_KEY: Record<string, MessageKey> = {
  delaying_restart: "reason.delaying_restart",
  denying_goal_by_handball: "reason.denying_goal_by_handball",
  denying_obvious_goalscoring_opportunity: "reason.denying_obvious_goalscoring_opportunity",
  dissent: "reason.dissent",
  entering_or_leaving_without_permission: "reason.entering_or_leaving_without_permission",
  failure_to_respect_distance: "reason.failure_to_respect_distance",
  offensive_language: "reason.offensive_language",
  persistent_offences: "reason.persistent_offences",
  second_caution: "reason.second_caution",
  serious_foul_play: "reason.serious_foul_play",
  spitting: "reason.spitting",
  unsporting_behaviour: "reason.unsporting_behaviour",
  violent_conduct: "reason.violent_conduct",
  all_out: "reason.all_out", overs_complete: "reason.overs_complete",
  target_reached: "reason.target_reached", forfeited: "reason.forfeited",
  hurt: "reason.hurt", out: "reason.out", time: "reason.time",
  weather: "reason.weather", other: "reason.other",
  // S4 (#428) — PeriodSuspensionReason (period/kernel.ts), shared by hockey
  // (FIH) and icehockey (IIHF); see HOCKEY_SUSPENSION_REASONS /
  // ICEHOCKEY_SUSPENSION_REASONS for which federation offers which member.
  tripping: "reason.tripping",
  hooking: "reason.hooking",
  holding: "reason.holding",
  holding_the_stick: "reason.holding_the_stick",
  slashing: "reason.slashing",
  high_sticking: "reason.high_sticking",
  cross_checking: "reason.cross_checking",
  roughing: "reason.roughing",
  elbowing: "reason.elbowing",
  charging: "reason.charging",
  boarding: "reason.boarding",
  checking_from_behind: "reason.checking_from_behind",
  interference: "reason.interference",
  delay_of_game: "reason.delay_of_game",
  too_many_men: "reason.too_many_men",
  unsportsmanlike_conduct: "reason.unsportsmanlike_conduct",
  fighting: "reason.fighting",
  illegal_equipment: "reason.illegal_equipment",
  obstruction: "reason.obstruction",
  dangerous_play: "reason.dangerous_play",
  time_wasting: "reason.time_wasting",
};
// S4 (#428) — FootballPenalty.offence: the closed IFAB Law 12 direct-free-
// kick/penalty offence that CONCEDED the kick. A different field, a different
// question, from `reason` (the card the referee separately showed, if any) —
// see PenaltyOffence's own doc comment in football.ts.
const OFFENCE_KEY: Record<string, MessageKey> = {
  kicking: "offence.kicking",
  tripping: "offence.tripping",
  jumping_at: "offence.jumping_at",
  charging: "offence.charging",
  pushing: "offence.pushing",
  striking: "offence.striking",
  tackling: "offence.tackling",
  handball: "offence.handball",
};
// ET_H1/ET_H2 arrive from `football.period` payloads. They were absent here
// until #427's second pass, because `event-copy.ts` carried its own PERIOD_LABEL
// table and nothing forced the two to agree — the exact drift a single
// vocabulary exists to prevent.
// S5/#431 — QT/3QT are football's two new quarters-mode markers (mini-soccer,
// `Cfg.halves === 4`): quarter-time (Q1 -> Q2) and three-quarter-time
// (Q3 -> Q4). The other two quarter boundaries reuse HT/FT verbatim, so they
// need no new key here.
const PHASE_KEY: Record<string, MessageKey> = {
  start: "matchPhase.start", end: "matchPhase.end",
  HT: "matchPhase.HT", FT: "matchPhase.FT",
  ET_H1: "matchPhase.ET_H1", ET_HT: "matchPhase.ET_HT",
  ET_H2: "matchPhase.ET_H2", ET_FT: "matchPhase.ET_FT",
  QT: "matchPhase.QT", "3QT": "matchPhase.3QT",
};
// Penalty / shoot-out outcomes and cricket's review outcomes share the field.
// S8/#417 W6 — `blocked` is `ShotOutcome`'s (football.ts / period/kernel.ts)
// one genuinely new member: `scored`/`saved`/`missed` already had copy via
// the pre-existing penalty/shoot-out vocabulary below, reused rather than
// re-keyed for this new field's own values.
const OUTCOME_KEY: Record<string, MessageKey> = {
  scored: "outcome.scored", missed: "outcome.missed", saved: "outcome.saved",
  post: "outcome.post", upheld: "outcome.upheld",
  struck_down: "outcome.struck_down", umpires_call: "outcome.umpires_call",
  blocked: "outcome.blocked",
};
// `kind` beyond the dismissal and extra vocabularies already mapped above:
// tennis point kinds and interruption kinds, cricket breaks and powerplays.
const KIND_KEY: Record<string, MessageKey> = {
  ace: "kind.ace", double_fault: "kind.double_fault", winner: "kind.winner",
  ue: "kind.ue", medical: "kind.medical", toilet: "kind.toilet",
  heat: "kind.heat", other: "kind.other", rain: "kind.rain",
  light: "kind.light", player: "kind.player", umpire: "kind.umpire",
  batting: "kind.batting", bowling: "kind.bowling", mandatory: "kind.mandatory",
  hitballtwice: "kind.hitballtwice",
};
const TOSS_KEY: Record<string, MessageKey> = {
  bat: "toss.bat", bowl: "toss.bowl",
};
const METHOD_KEY: Record<string, MessageKey> = {
  checkmate: "method.checkmate", resign: "method.resign", time: "method.time",
  stalemate: "method.stalemate", agreement: "method.agreement",
  insufficient: "method.insufficient", adjudication: "method.adjudication",
  forfeit: "method.forfeit", double_forfeit: "method.double_forfeit",
  repetition: "method.repetition", fifty_move: "method.fifty_move",
  dead_position: "method.dead_position", illegal_move: "method.illegal_move",
};
const SANCTION_KEY: Record<string, MessageKey> = {
  warning: "sanction.warning", penalty: "sanction.penalty",
  point_penalty: "sanction.point_penalty", game_penalty: "sanction.game_penalty",
  default: "sanction.default", expulsion: "sanction.expulsion",
  disqualification: "sanction.disqualification",
};
const COURT_KEY: Record<string, MessageKey> = {
  deuce: "court.deuce", ad: "court.ad",
};

/**
 * Enum field name → the vocabularies that can label its members. A field maps
 * to SEVERAL maps where an existing closed enum already covers part of it:
 * cricket's `kind` spans dismissals (WICKET_KEY), extras (EXTRA_KEY) and the
 * break/powerplay vocabulary (KIND_KEY), and re-keying those would duplicate
 * copy that already ships in four locales.
 */
export const ENUM_VOCAB: Record<string, readonly Record<string, MessageKey>[]> = {
  color: [CARD_COLOR_KEY],
  reason: [REASON_KEY],
  phase: [PHASE_KEY],
  outcome: [OUTCOME_KEY],
  kind: [WICKET_KEY, EXTRA_KEY, KIND_KEY],
  elected: [TOSS_KEY],
  method: [METHOD_KEY],
  level: [SANCTION_KEY],
  receiverSide: [COURT_KEY],
  offence: [OFFENCE_KEY], // S4 (#428) — FootballPenalty.offence
};

/**
 * Engine refusal copy. `EngineError.message` is serialised into the /api/v1
 * error envelope and the scoring surfaces render it verbatim
 * (`device-score-pad.tsx`, `fixture-console.tsx` both do
 * `setError(err.message)`), so without this map an engine string reaches the
 * scorer in English on every locale. Typed by `EngineErrorCode`, so adding a
 * code to the engine fails this file's typecheck until copy exists.
 */
export const ENGINE_ERROR_KEY: Record<EngineErrorCode, MessageKey> = {
  INVALID_EVENT: "engineError.INVALID_EVENT",
  WRONG_PHASE: "engineError.WRONG_PHASE",
  ALREADY_DECIDED: "engineError.ALREADY_DECIDED",
  LINEUP_INVALID: "engineError.LINEUP_INVALID",
  CONFIG_INVALID: "engineError.CONFIG_INVALID",
  SEQ_CONFLICT: "engineError.SEQ_CONFLICT",
  STAGE_NOT_READY: "engineError.STAGE_NOT_READY",
  SCHEDULE_CONFLICT: "engineError.SCHEDULE_CONFLICT",
  DRAW_NOT_ALLOWED: "engineError.DRAW_NOT_ALLOWED",
  QUALIFICATION_INVALID: "engineError.QUALIFICATION_INVALID",
  ELIGIBILITY: "engineError.ELIGIBILITY",
  MODULE_NOT_FOUND: "engineError.MODULE_NOT_FOUND",
  MODULE_DUPLICATE: "engineError.MODULE_DUPLICATE",
  NON_MONOTONIC_TIME: "engineError.NON_MONOTONIC_TIME",
  UNKNOWN_PHASE: "engineError.UNKNOWN_PHASE",
  EXPEDITE_WRONG_WINNER: "engineError.EXPEDITE_WRONG_WINNER",
  SUB_WINDOW_EXCEEDED: "engineError.SUB_WINDOW_EXCEEDED",
  GAME_AWARD_DURING_TIEBREAK: "engineError.GAME_AWARD_DURING_TIEBREAK",
  // F2 (unified progression field) — placeDescriptors/
  // validateProgressionAgainstShapes moved into the engine with these four
  // codes (packages/engine/src/core/errors.ts); lib/seeding-error.ts already
  // wired organiser copy for the wire-visible HttpError path (its
  // SEEDING_ERROR_CODES allowlist has all four), but that is a SEPARATE
  // resolver keyed off the raw HTTP error code, not this EngineErrorCode map.
  SEEDING_RULES_MISSING: "engineError.SEEDING_RULES_MISSING",
  SEEDING_MAP_SLOT_INVALID: "engineError.SEEDING_MAP_SLOT_INVALID",
  SEEDING_MAP_SOURCE_INVALID: "engineError.SEEDING_MAP_SOURCE_INVALID",
  SEEDING_BESTNTH_UNEQUAL_POOLS: "engineError.SEEDING_BESTNTH_UNEQUAL_POOLS",
  // F3 Task 3 (P6) — placeDescriptors' new ambiguous-seeded_map refusal
  // (progression.ts). Same "this file's typecheck fails until copy exists"
  // forcing function as the four F2 codes above; unlike lib/seeding-error.ts's
  // closed 13-code allowlist, THIS map has no such ruling — every
  // EngineErrorCode needs an entry here regardless.
  SEEDING_MAP_SOURCE_AMBIGUOUS: "engineError.SEEDING_MAP_SOURCE_AMBIGUOUS",
};

/**
 * S3/W4b (#426)'s two lineup enums, neither of which had display copy anywhere
 * — a squad list could show a coach and a mid-match call-up and had no word for
 * either. Both are TRUE closed TS unions (`core/lineup.ts`), so unlike
 * `EVENT_KEY`/`ENUM_VOCAB`/`PAD_LABEL_KEYS` below these get the full
 * `Record<Enum, MessageKey>` treatment: the Record forces every member to be
 * mapped and the MessageKey forces the copy to exist, both at compile time.
 * Add a member to `SquadRole` in the engine and this file stops typechecking.
 */
const SQUAD_ROLE_KEY: Record<SquadRole, MessageKey> = {
  player: "squadRole.player",
  coach: "squadRole.coach",
  staff: "squadRole.staff",
};
const SQUAD_PROVENANCE_KEY: Record<SquadProvenance, MessageKey> = {
  named: "squadProvenance.named",
  added: "squadProvenance.added",
};

/**
 * Sport CONFIG knobs a scoring surface names, as distinct from the match
 * vocabulary above. One entry today, and the entry is the point: #431 item 8
 * flagged that `generic.score.points` (the per-person running tally, labelled
 * `stat.generic.points` → "Points") and `GenericCfg.points` (the win/draw/loss
 * points table) "are different things" sharing one word.
 *
 * `points` therefore points at the EXISTING `divset.standingsPoints`
 * ("Standings points"), which `division-settings.tsx` already draws over that
 * exact cfg object — the same reuse `PLAYER_STAT_KEY`'s award rows make of
 * `AWARD_KEY`, and for the same reason: minting a second string for one
 * concept is how two labels for one knob drift apart in four locales.
 *
 * NOT here: cricket's `Cfg.reviews.perInnings`. S7 checked and it has no
 * renderer anywhere in `apps/web` (`git grep perInnings` hits only
 * `packages/engine`), so a label would be copy with nothing to attach it to —
 * deferred alongside PadSpec's own renderer (S10), not forgotten.
 */
const CONFIG_KEY: Record<string, MessageKey> = {
  points: "divset.standingsPoints",
};

/**
 * S6's `PadSpec` label keys — every `PadLabel.key` the eleven sport modules'
 * `padSpec(cfg)` can emit for a panel, an action, or (S7) a field or
 * attribution item, across each module's whole cfg space.
 *
 * OPEN-ENDED, like `EVENT_KEY`: `PadLabel.key` is a plain `string` on a
 * cfg-driven function's return value, not a closed TS union, so no
 * exhaustiveness check the compiler can perform exists here. The typed
 * `MessageKey` element still forces every key LISTED to exist in `en/ui.json`
 * at compile time; COMPLETENESS is enforced at test time instead, by
 * `__tests__/scoring-vocab.test.ts` enumerating `padSpec(cfg)` over every
 * module × (default + named variants + single-cfg-leaf overrides) and reding
 * on any key absent here or from any of the four dictionaries.
 *
 * Note the prefix collision with the v1 pad's own `pad.<abbrev>.*` namespace
 * (`pad.ck.ballByBall`, `pad.fb.*`, `pad.tn.*`): different vocabulary, and
 * they cannot collide because these always carry a FULL sport key plus
 * `.action.`/`.panel.`.
 */
export const PAD_LABEL_KEYS: readonly MessageKey[] = [
  "pad.badminton.action.expediteStart",
  "pad.badminton.action.rally",
  "pad.badminton.action.rallyAttributed",
  "pad.badminton.action.rallyAttributed.field.scorer",
  "pad.badminton.action.rallyAttributed.field.server",
  "pad.badminton.action.rallyExpedite",
  "pad.badminton.action.sanction",
  "pad.badminton.action.setScore",
  "pad.badminton.action.sub",
  "pad.badminton.action.timeout",
  "pad.badminton.panel.expedite",
  "pad.badminton.panel.expediteRally",
  "pad.badminton.panel.rally",
  "pad.badminton.panel.sanctions",
  "pad.badminton.panel.setScore",
  "pad.badminton.panel.subs",
  "pad.badminton.panel.timeouts",

  "pad.boardgame.action.draw",
  "pad.boardgame.action.pairing",
  "pad.boardgame.action.result",
  "pad.boardgame.panel.draw",
  "pad.boardgame.panel.pre",
  "pad.boardgame.panel.result",

  "pad.carrom.action.adjustCredit",
  "pad.carrom.action.adjustDeduct",
  "pad.carrom.action.board",
  "pad.carrom.action.board.field.breaker",
  "pad.carrom.action.boardQueen",
  "pad.carrom.action.boardQueen.field.breaker",
  "pad.carrom.action.boardQueen.field.queenBy",
  "pad.carrom.action.toss",
  "pad.carrom.panel.adjust",
  "pad.carrom.panel.board",
  "pad.carrom.panel.pre",

  "pad.cricket.action.ball",
  "pad.cricket.action.declare",
  "pad.cricket.action.extra",
  "pad.cricket.action.followOn",
  "pad.cricket.action.inningsClose",
  "pad.cricket.action.inningsSummary",
  "pad.cricket.action.interruption",
  "pad.cricket.action.matchClose",
  "pad.cricket.action.newBall",
  "pad.cricket.action.playerLine",
  "pad.cricket.action.powerplay",
  "pad.cricket.action.retire",
  "pad.cricket.action.review",
  "pad.cricket.action.revise",
  "pad.cricket.action.superOverBall",
  "pad.cricket.action.toss",
  "pad.cricket.action.wicket",
  "pad.cricket.action.wicket.field.fielderAssist",
  "pad.cricket.action.wicket.field.incoming",
  "pad.cricket.panel.dls",
  "pad.cricket.panel.extras",
  "pad.cricket.panel.innings",
  "pad.cricket.panel.over",
  "pad.cricket.panel.post",
  "pad.cricket.panel.pre",
  "pad.cricket.panel.reviews",
  "pad.cricket.panel.superOver",
  "pad.cricket.panel.wicket",
  // R2/task C (v3 ribbon — brief item 10): registered here, not only in the
  // dictionaries. ribbon.ts's buildRibbon() gates its per-sport lookup on
  // PAD_LABEL_KEYS membership BEFORE calling padLabel() — dictionary copy
  // with no entry here silently stays on the generic `pad.ribbon.fallback`
  // forever, with nothing failing (R1's own owed item, restated in the R2
  // plan so this session doesn't repeat it). One key per event type this
  // skin's tiles/sheets dispatch directly — the remaining 8 cricket.* types
  // (reachable only via the "More" sheet) stay on the fallback, same
  // graceful-degradation posture ribbon.ts's header already documents.
  "pad.cricket.ribbon.ball",
  "pad.cricket.ribbon.innings.close",
  "pad.cricket.ribbon.innings.declare",
  // R2b: `cricket.innings.summary` is the over-by-over event this wave gives
  // a dedicated tile — without this entry the ribbon silently stays on the
  // generic "{event} recorded" fallback (ribbon.ts's own header comment).
  "pad.cricket.ribbon.innings.summary",
  "pad.cricket.ribbon.retire",
  "pad.cricket.ribbon.review",
  "pad.cricket.ribbon.superover.ball",
  "pad.cricket.ribbon.toss",

  "pad.football.action.card",
  "pad.football.action.goal",
  "pad.football.action.penalty",
  "pad.football.action.period",
  "pad.football.action.shootoutKick",
  "pad.football.action.shot",
  "pad.football.action.sinbinEnd",
  "pad.football.action.sinbinStart",
  "pad.football.action.sub",
  "pad.football.panel.cards",
  "pad.football.panel.goals",
  "pad.football.panel.penalties",
  "pad.football.panel.period",
  "pad.football.panel.shootout",
  "pad.football.panel.shots",
  "pad.football.panel.sinbin",
  "pad.football.panel.subs",
  // R3/task C (v3 ribbon). Football is the first sport whose ribbon coverage
  // is COMPLETE: these nine are every `football.*` type the engine's fidelity
  // tiers declare, so no football event falls to the generic
  // `pad.ribbon.fallback` ("{event} recorded"). Registered HERE, not only in
  // the dictionaries — buildRibbon (v3/ribbon.ts) gates its per-sport lookup
  // on PAD_LABEL_KEYS membership, so dictionary copy with no entry here stays
  // on the fallback forever with nothing failing. Suffixes are
  // `ribbonKeyFor`'s split-on-FIRST-dot output, hence the two-segment
  // `sinbin.*`/`shootout.*` tails.
  "pad.football.ribbon.card",
  "pad.football.ribbon.goal",
  "pad.football.ribbon.penalty",
  "pad.football.ribbon.period",
  "pad.football.ribbon.shootout.kick",
  "pad.football.ribbon.shot",
  "pad.football.ribbon.sinbin.end",
  "pad.football.ribbon.sinbin.start",
  "pad.football.ribbon.sub",

  "pad.generic.action.addPoints",
  "pad.generic.action.correctPoints",
  "pad.generic.action.decisive",
  "pad.generic.action.draw",
  "pad.generic.action.scoreEntry",
  "pad.generic.action.settleFromTally",
  "pad.generic.panel.draw",
  "pad.generic.panel.result",
  "pad.generic.panel.score",
  "pad.generic.panel.settle",
  "pad.generic.panel.tally",

  "pad.hockey.action.advance",
  "pad.hockey.action.goal",
  "pad.hockey.action.goal.field.emptyNet",
  "pad.hockey.action.setPiece",
  "pad.hockey.action.shootoutAttempt",
  "pad.hockey.action.shootoutAttempt.field.goalkeeper",
  "pad.hockey.action.shot",
  "pad.hockey.action.shot.field.goalkeeper",
  "pad.hockey.action.suspensionEnd",
  "pad.hockey.action.suspensionStart",
  "pad.hockey.action.suspensionStart.field.minutes",
  "pad.hockey.action.suspensionStart.field.servedBy",
  "pad.hockey.panel.discipline",
  "pad.hockey.panel.goal",
  "pad.hockey.panel.period",
  "pad.hockey.panel.setPiece",
  "pad.hockey.panel.shootout",
  "pad.hockey.panel.shot",

  "pad.icehockey.action.advance",
  "pad.icehockey.action.goal",
  "pad.icehockey.action.goal.field.emptyNet",
  "pad.icehockey.action.setPiece",
  "pad.icehockey.action.shootoutAttempt",
  "pad.icehockey.action.shootoutAttempt.field.goalkeeper",
  "pad.icehockey.action.shot",
  "pad.icehockey.action.shot.field.goalkeeper",
  "pad.icehockey.action.suspensionEnd",
  "pad.icehockey.action.suspensionStart",
  "pad.icehockey.action.suspensionStart.field.minutes",
  "pad.icehockey.action.suspensionStart.field.servedBy",
  "pad.icehockey.panel.discipline",
  "pad.icehockey.panel.goal",
  "pad.icehockey.panel.period",
  "pad.icehockey.panel.setPiece",
  "pad.icehockey.panel.shootout",
  "pad.icehockey.panel.shot",

  "pad.tabletennis.action.expediteStart",
  "pad.tabletennis.action.rally",
  "pad.tabletennis.action.rallyAttributed",
  "pad.tabletennis.action.rallyAttributed.field.scorer",
  "pad.tabletennis.action.rallyAttributed.field.server",
  "pad.tabletennis.action.rallyExpedite",
  "pad.tabletennis.action.sanction",
  "pad.tabletennis.action.setScore",
  "pad.tabletennis.action.sub",
  "pad.tabletennis.action.timeout",
  "pad.tabletennis.panel.expedite",
  "pad.tabletennis.panel.expediteRally",
  "pad.tabletennis.panel.rally",
  "pad.tabletennis.panel.sanctions",
  "pad.tabletennis.panel.setScore",
  "pad.tabletennis.panel.subs",
  "pad.tabletennis.panel.timeouts",

  "pad.tennis.action.gameAward",
  "pad.tennis.action.interruption",
  "pad.tennis.action.point",
  "pad.tennis.action.pointAttributed",
  "pad.tennis.action.sanction",
  "pad.tennis.action.setScore",
  "pad.tennis.action.setScoreTiebreak",
  "pad.tennis.panel.gameAward",
  "pad.tennis.panel.interruptions",
  "pad.tennis.panel.points",
  "pad.tennis.panel.sanctions",
  "pad.tennis.panel.setScore",
  // R4/tennis (v3 ribbon). Five keys for the FIVE `tennis.*` types the engine
  // declares (`kernel.ts:1766-1772`) — the brief said four; §9.1's own
  // false-premises note corrects it, and this skin's ribbon coverage is
  // complete, same as football's own note states for its nine. Registered
  // HERE, not only in the dictionaries — `ribbon.ts`'s `buildRibbon` gates its
  // per-sport lookup on membership in this array, so dictionary copy with no
  // entry here stays on the generic fallback forever with nothing failing.
  "pad.tennis.ribbon.point",
  "pad.tennis.ribbon.set_summary",
  "pad.tennis.ribbon.sanction",
  "pad.tennis.ribbon.interruption",
  "pad.tennis.ribbon.game.award",
  // R4/tennis — tap model S's own hint. `ScorebugHalf.hintKey` resolves
  // through this SAME `padLabel()` gate (scorebug.tsx), so an unregistered
  // key would print its own raw dotted name as the visible hint text.
  "pad.tennis.scorebug.point.hint",

  "pad.volleyball.action.expediteStart",
  "pad.volleyball.action.rally",
  "pad.volleyball.action.rallyAttributed",
  "pad.volleyball.action.rallyAttributed.field.scorer",
  "pad.volleyball.action.rallyAttributed.field.server",
  "pad.volleyball.action.rallyExpedite",
  "pad.volleyball.action.sanction",
  "pad.volleyball.action.setScore",
  "pad.volleyball.action.sub",
  "pad.volleyball.action.timeout",
  "pad.volleyball.panel.expedite",
  "pad.volleyball.panel.expediteRally",
  "pad.volleyball.panel.rally",
  "pad.volleyball.panel.sanctions",
  "pad.volleyball.panel.setScore",
  "pad.volleyball.panel.subs",
  "pad.volleyball.panel.timeouts",
];

const PAD_LABEL_SET: ReadonlySet<string> = new Set<string>(PAD_LABEL_KEYS);

/**
 * Bound translator: client `useMsg()` or server `(k)=>msgFor(locale,k)`.
 *
 * `vars` is OPTIONAL and additive (Task 11, R1 chassis Ruling G): every
 * existing call site here calls `m(key)` with one argument and stays
 * valid unchanged. Widened to match `useMsg()`'s real signature
 * (dict-provider.tsx:78) and v3/ribbon.ts's own local `MsgFn`, so a
 * per-sport interpolating sentence ("FOUR · Kannan · through covers",
 * design spec §2.2) can flow through `padLabel` — R1 ships the plumbing
 * only; no per-sport vocab yet computes a real `vars` object to pass
 * (that lands with each conversion wave, alongside its own dictionary
 * copy — see v3/ribbon.ts's header comment).
 */
export type MsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "second_yellow" → "Second yellow" */
const humanize = (s: string) => title(s.replace(/_/g, " "));
/** "volleyball.set.summary" → "Set summary" */
const prettify = (type: string) =>
  humanize(type.split(".").slice(1).join(" ").trim() || type);

export const wicketLabel = (k: string, m: MsgFn): string =>
  k in WICKET_KEY ? m(WICKET_KEY[k as WicketKind]) : title(k);
export const extraLabel = (k: string, m: MsgFn): string =>
  k in EXTRA_KEY ? m(EXTRA_KEY[k as ExtraKind]) : title(k);
export const sportLabel = (k: string, m: MsgFn): string =>
  k in SPORT_KEY ? m(SPORT_KEY[k as SportKey]) : title(k);

/** Localized palette-swatch name for a stored hex; null when hex isn't a swatch. */
export function swatchLabel(hex: string | null | undefined, m: MsgFn): string | null {
  const name = swatchName(hex);
  if (!name) return null;
  return name in SWATCH_KEY ? m(SWATCH_KEY[name]) : name;
}

/** Localized name for a ledger event type, e.g. "tabletennis.expedite.start". */
export const eventLabel = (type: string, m: MsgFn): string =>
  type in EVENT_KEY ? m(EVENT_KEY[type]) : prettify(type);

/**
 * Localized name for an enum member, disambiguated by the payload field it sits
 * on — `kind.other` (an interruption) and `reason.other` (a retirement) are
 * different words in three of the four locales.
 */
export const enumLabel = (field: string, value: string, m: MsgFn): string => {
  for (const map of ENUM_VOCAB[field] ?? []) if (value in map) return m(map[value]);
  return humanize(value);
};

/**
 * Localized noun for a position segment, keyed by the engine's stable `key`.
 * `engineLabel` is that segment's own `label` — the engine's English, used
 * only for a key this app has no copy for yet, which is strictly better than
 * a humanized token ("Frame" beats "Frame" only by accident; "Half inning"
 * would lose to a real one).
 */
export const positionLabel = (key: string, m: MsgFn, engineLabel?: string): string =>
  key in POSITION_KEY ? m(POSITION_KEY[key]) : (engineLabel ?? humanize(key));

/**
 * Localized label for one player-stat row, scoped by sport (see
 * `PLAYER_STAT_KEY`). `engineLabel` is the module's own declared English, used
 * only for a row this app has no copy for yet: a sport can ship a metric a
 * release before its dictionary entry lands, and the engine's word beats a
 * humanized token ("PIM" survives, "Pim" would not).
 */
export const playerStatLabel = (
  sportKey: string, statKey: string, m: MsgFn, engineLabel?: string,
): string => {
  const key = `${sportKey}.${statKey}`;
  return key in PLAYER_STAT_KEY ? m(PLAYER_STAT_KEY[key]) : (engineLabel ?? humanize(statKey));
};

/** Localized name for a match award (`core.award`'s payload `key`), or null. */
export const awardLabel = (key: string, m: MsgFn): string | null =>
  key in AWARD_KEY ? m(AWARD_KEY[key]) : null;

/**
 * Localized copy for a `PadSpec` panel / action / field label, keyed by the
 * engine's own `PadLabel.key`. `engineLabel` is that label's baked English
 * fallback and is REQUIRED here (unlike `positionLabel`'s): the engine always
 * ships one, and a pad control with no text at all is not a thing a scorer can
 * press — a humanized token off a key like `pad.cricket.action.superOverBall`
 * would read "Superoverball".
 *
 * `vars` is OPTIONAL (Task 11 Ruling G) and threads straight through to
 * `m` -- additive, so every existing 3-argument call site is untouched.
 */
export const padLabel = (
  key: string,
  m: MsgFn,
  engineLabel: string,
  vars?: Record<string, string | number>,
): string => (PAD_LABEL_SET.has(key) ? m(key as MessageKey, vars) : engineLabel);

/** Localized name for a lineup slot's role (`player` | `coach` | `staff`). */
export const squadRoleLabel = (role: string, m: MsgFn): string =>
  role in SQUAD_ROLE_KEY ? m(SQUAD_ROLE_KEY[role as SquadRole]) : humanize(role);

/** Localized name for how a squad member got there (`named` | `added`). */
export const squadProvenanceLabel = (provenance: string, m: MsgFn): string =>
  provenance in SQUAD_PROVENANCE_KEY
    ? m(SQUAD_PROVENANCE_KEY[provenance as SquadProvenance])
    : humanize(provenance);

/**
 * Localized name for a sport CONFIG knob, or null when this app has no copy
 * for it. Deliberately null rather than a humanized token: an unlabelled cfg
 * knob should be invisible, not shown to an organiser as "Perinnings".
 */
export const configLabel = (key: string, m: MsgFn): string | null =>
  key in CONFIG_KEY ? m(CONFIG_KEY[key]) : null;

/** Localized copy for an engine refusal; null when the code isn't an engine one. */
export const engineErrorLabel = (code: string, m: MsgFn): string | null =>
  code in ENGINE_ERROR_KEY ? m(ENGINE_ERROR_KEY[code as EngineErrorCode]) : null;

/**
 * R3.5/Task G — a decided fixture's own `MatchOutcome` (kind/winner/loser/
 * method, `packages/engine/src/core/types.ts`) reaches both the public
 * fixture page and the organiser console as data, and until this task
 * neither rendered anything from it: a reader had to decode
 * "1 — 1 (3–0 pens)" for themselves. `method` is a plain string the sport
 * modules extend freely, so only a CLOSED, deliberately-curated set gets its
 * own clause here — everything else (an absent method, a plain `regulation`
 * result, or a method nobody has written copy for yet, e.g. cricket's `dls`/
 * `innings`) falls back to the plain winner sentence. That fallback is
 * deliberate, not a gap: the winner is still true even when the copy for HOW
 * isn't, and a method's raw token must never leak onto the page.
 */
const DECIDED_METHOD_KEY: Record<string, MessageKey> = {
  shootout: "fixture.decidedBy.shootout",
  super_over: "fixture.decidedBy.superOver",
  boundary_count: "fixture.decidedBy.boundaryCount",
  extra_time: "fixture.decidedBy.extraTime",
};

/** The minimal slice of `MatchOutcome` this module needs — structural rather
 *  than importing the engine's own type, the same posture the pad chassis
 *  takes on engine shapes elsewhere: a page that already has `outcome` as
 *  loose JSON (a DB column, an API response) can pass it straight through. */
export interface DecidedOutcomeLike {
  kind?: string;
  winner?: string;
  method?: string;
}

/**
 * The sentence a decided fixture owes its reader. `entrantNames` resolves
 * `outcome.winner` to a display name (falling back to the raw id, matching
 * every other id→name lookup in this app); `shootoutScore` is read out of
 * `ScoreSummary.detail.shootout` by the caller (see `shootoutScoreFromDetail`
 * below) — it is the ONE mapped method whose sentence needs a number, and
 * this function has no engine import and no opinion on any one sport's
 * `detail` shape, so the two numbers arrive already resolved.
 *
 * Returns null for anything this task was not asked to describe (`draw`,
 * `no_result`, or no outcome at all) — callers render nothing rather than
 * invent copy nobody specified.
 */
export function decidedOutcomeText(
  outcome: DecidedOutcomeLike | null | undefined,
  entrantNames: Record<string, string>,
  m: MsgFn,
  shootoutScore?: { home: number; away: number } | null,
): string | null {
  if (!outcome) return null;
  if (outcome.kind === "tie") return m("fixture.decidedBy.tie");
  if (outcome.kind !== "win" && outcome.kind !== "award") return null;
  if (!outcome.winner) return null;
  const winner = entrantNames[outcome.winner] ?? outcome.winner;
  const key = outcome.method ? DECIDED_METHOD_KEY[outcome.method] : undefined;
  if (key === "fixture.decidedBy.shootout" && shootoutScore) {
    return m(key, { winner, score: `${shootoutScore.home}–${shootoutScore.away}` });
  }
  if (key && key !== "fixture.decidedBy.shootout") return m(key, { winner });
  return m("fixture.decidedBy.plain", { winner });
}

/**
 * `ScoreSummary.detail` is `z.unknown()` (sport-specific breakdown) — this
 * narrows football's own shape (`{ shootout: { home, away } }`, set by
 * `summary()` whenever a shoot-out tally exists, R3.5/Task H) without an
 * engine import. Null for anything else, including every non-football
 * sport's own `detail` shape and a decision reached with no shoot-out at all.
 */
export function shootoutScoreFromDetail(detail: unknown): { home: number; away: number } | null {
  if (!detail || typeof detail !== "object") return null;
  const shootout = (detail as Record<string, unknown>).shootout;
  if (!shootout || typeof shootout !== "object") return null;
  const { home, away } = shootout as Record<string, unknown>;
  return typeof home === "number" && typeof away === "number" ? { home, away } : null;
}

/**
 * What a scoring surface should show when a write is refused. An engine code
 * wins, because its `message` is the engine's own English and is rendered
 * verbatim otherwise; anything else keeps the raw message (HTTP/auth failures
 * already carry localized or user-authored text), and an empty one falls back.
 */
export function scoringErrorText(
  code: string | null | undefined,
  rawMessage: string | null | undefined,
  m: MsgFn,
  fallback: MessageKey,
): string {
  const engine = code ? engineErrorLabel(code, m) : null;
  return engine ?? (rawMessage || m(fallback));
}

/** Every MessageKey this module can emit — used by the exhaustiveness test. */
export const SCORING_VOCAB_KEYS: readonly MessageKey[] = [
  ...Object.values(WICKET_KEY), ...Object.values(EXTRA_KEY),
  ...Object.values(SPORT_KEY), ...Object.values(SWATCH_KEY),
  ...Object.values(EVENT_KEY), ...Object.values(ENGINE_ERROR_KEY),
  ...Object.values(POSITION_KEY), ...Object.values(PLAYER_STAT_KEY),
  ...Object.values(AWARD_KEY),
  ...Object.values(SQUAD_ROLE_KEY), ...Object.values(SQUAD_PROVENANCE_KEY),
  ...Object.values(CONFIG_KEY), ...PAD_LABEL_KEYS,
  ...Object.values(DECIDED_METHOD_KEY), "fixture.decidedBy.plain", "fixture.decidedBy.tie",
  ...Object.values(ENUM_VOCAB).flatMap((maps) => maps.flatMap((m) => Object.values(m))),
];
