// W2a Task 7 — the classified ledger for `status-set-sweep.test.ts` (spec §5.4.6). GENERATED from one reading of
// every found set's use site; each row's class was decided by READING that site (never by a set's name alone,
// AGENTS class 5). A later loop that adds a set adds its row here with a `why` read at its use site.
//
// The spec's classification is "played, not finished, needs attention". Reading the 124 sets found at W2a T7 showed that three
// words cannot carry the question honestly — a write-lock set and a void set are neither "played" nor "not
// finished", yet must both leave `needs_decision` OUT — so the ledger names the question each set asks:
//
// needs_decision must be OUT (a held fixture is played level, not finished, nobody seated, no play ahead):
//  - played:        a result exists / the match is finished / terminal for a completion check.
//  - to-play:       play is still AHEAD (scheduled/in_play): sheets, duties, next match, pending walkovers.
//  - locked:        a write lock (finalized/cancelled); a held fixture must still take a settle and a void.
//  - void:          the no-result trio (cancelled/abandoned/forfeited) or the engine's void reading.
//  - falls-through: a status→label mapping where needs_decision deliberately takes the default branch.
// needs_decision must be IN:
//  - not-finished:  live, open or awaiting something; absent, a held fixture reads as finished or idle.
//  - took-place:    "was played / holds its slot / will not be played again"; absent, it reads as never played.
//  - not-live:      no play is running (no clock); a held fixture has none running.
//  - needs-attention: the desk's attention/phase sets that ask an organiser to act.
//  - status-domain: a full list of values, or a per-status map every reachable status must have a key in.
// not checked (the `why` says why):
//  - historical-sql:   an applied migration statement superseded by a later delta, or a one-time backfill.
//  - other-vocabulary: a set over another enum (engine FixtureStatus, the match-centre header, DivisionPhase…).
//  - unreachable:      the set's consumer only ever sees DRAW kinds (or lists), where needs_decision never occurs.
//  - not-a-set:        a comment or a status rule's own ternary that the scanner matched.
export type StatusSetClass =
  | "played"
  | "to-play"
  | "locked"
  | "void"
  | "falls-through"
  | "not-finished"
  | "took-place"
  | "not-live"
  | "needs-attention"
  | "status-domain"
  | "historical-sql"
  | "other-vocabulary"
  | "unreachable"
  | "not-a-set";
export interface StatusSetRow {
  file: string;
  anchor: string;
  class: StatusSetClass;
  why: string;
}

export const STATUS_SET_LEDGER: readonly StatusSetRow[] = [
  { file: "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/fixture-subheading.ts", anchor: "nst PLAYED_STATUSES = new Set( :: decided,finalized", class: "played", why: "the two statuses statusOf folds into 'decided' (match OVER); a held fixture keeps the default 'Time TBD' branch with abandoned/cancelled, by this set's own design — public wording is Task 13's" },
  { file: "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx", anchor: "chain  decided = data.fixture.status :: decided,finalized", class: "played", why: "the decided-title line (score + result phrase); a held fixture has no result phrase" },
  { file: "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx", anchor: "chain entCancelled\" : fixture.status :: decided,finalized", class: "played", why: "schema.org EventCompleted means a result exists; a held fixture is not completed" },
  { file: "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/page.tsx", anchor: "chain reTextFor( fixture.status :: decided,finalized", class: "played", why: "share text 'X beat Y' needs a result; a held fixture has none" },
  { file: "apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/stream-link.ts", anchor: "REPLAYABLE_STATUSES = new Set( :: decided,finalized", class: "played", why: "a decided match keeps its replay link; a held match is not decided (abandoned/void lose it)" },
  { file: "apps/web/src/app/o/[orgSlug]/c/[compSlug]/settings/page.tsx", anchor: "t(*) filter (where f.status in :: decided,finalized,in_play,needs_decision", class: "took-place", why: "the 'underway' count: a fixture that has been played or is being played; a held fixture was played" },
  { file: "apps/web/src/app/o/[orgSlug]/c/[compSlug]/settings/page.tsx", anchor: "t(*) filter (where f.status in :: abandoned,cancelled,decided,finalized,forfeited", class: "played", why: "the 'done' count (finished or called off); a held fixture is not done" },
  { file: "apps/web/src/components/me/officiating-lane.tsx", anchor: "). const REPORTABLE = new Set( :: abandoned,decided,finalized", class: "played", why: "REPORTABLE: a finished match (decided/finalized/abandoned) takes a match report; a held match is not finished — mirrors match-reports.ts REPORTABLE" },
  { file: "apps/web/src/components/me/officiating-lane.tsx", anchor: ")} {response !== \"declined\" && :: in_play,scheduled", class: "to-play", why: "the official's open-the-pad link for a match still to be played; a held match has no play ahead (only the organiser's settle)" },
  { file: "apps/web/src/components/me/officiating-lane.tsx", anchor: "chain declined\" && (a.fixture_status :: in_play,scheduled", class: "to-play", why: "same expression as the span row: the open-the-pad link for a match still to be played" },
  { file: "apps/web/src/components/overlay/use-overlay-clock.ts", anchor: "ic-site/live-score-data\"; // ` :: decided,finalized,needs_decision,scheduled", class: "not-a-set", why: "a comment spelling NO_CLOCK_STATUSES's derivation, not a set the code reads" },
  { file: "apps/web/src/components/overlay/use-overlay-clock.ts", anchor: "t NO_CLOCK_STATUSES = new Set( :: abandoned,cancelled,decided,finalized,forfeited,needs_decision,scheduled", class: "not-live", why: "NO_CLOCK_STATUSES: no play is running, so no clock; a held fixture has no play running and must not hold the last reading" },
  { file: "apps/web/src/components/public-site/live-score.tsx", anchor: "chain \"; const decided = data.status :: decided,finalized", class: "played", why: "'decided' word on the live score: a result exists; a held fixture has none" },
  { file: "apps/web/src/components/public-site/live-score.tsx", anchor: "map _KEY: Record<string, string> = :: abandoned,cancelled,forfeited,needs_decision", class: "status-domain", why: "OTHER_STATUS_KEY: every status that reaches the 'other' word needs a line, or the RAW token reaches a spectator; needs_decision reaches it" },
  { file: "apps/web/src/components/public-site/match-centre/use-live-fixture.ts", anchor: "chain poll. const live = data.status :: in_play,needs_decision,scheduled", class: "not-finished", why: "`live` keeps the realtime channel and the poll; a held fixture still changes (the organiser's settle decides it)" },
  { file: "apps/web/src/components/public-site/results-matrix.tsx", anchor: " Dict; } const DONE = new Set( :: abandoned,decided,finalized,forfeited", class: "unreachable", why: "the round-robin results grid, rendered only inside a pool/standings table (league/group); needs_decision exists only in bracket kinds" },
  { file: "apps/web/src/components/public-site/schedule.tsx", anchor: "chain lay\"; const decided = f.status :: decided,finalized", class: "played", why: "the public schedule row's decided state (score + winner); a held fixture has no winner" },
  { file: "apps/web/src/components/v2/americano-panel.tsx", anchor: "chain ; const decided = match.status :: decided,finalized", class: "unreachable", why: "americano is a DRAW kind (forbidsLevelResult false); needs_decision never occurs there" },
  { file: "apps/web/src/components/v2/desk/phase-pill.tsx", anchor: "map  \"in_play\" | \"next\", string> = :: in_play,scheduled", class: "other-vocabulary", why: "keyed by DivisionPhase plus 'in_play'/'next', not by fixtures.status" },
  { file: "apps/web/src/components/v2/device-score-pad.tsx", anchor: "chain  } const scoring = live.status :: cancelled,finalized", class: "locked", why: "the device pad's write lock (finalized/cancelled); a held fixture must still take a void" },
  { file: "apps/web/src/components/v2/device-score-pad.tsx", anchor: "chain nlyReason | null = live.status :: cancelled,finalized", class: "locked", why: "view-only reasons for a locked fixture; a held fixture is not locked" },
  { file: "apps/web/src/components/v2/fixture-console.tsx", anchor: "chain oring = canEdit && live.status :: cancelled,finalized", class: "locked", why: "console `scoring` gate (finalized/cancelled); a held fixture must take a settle and a void" },
  { file: "apps/web/src/components/v2/fixture-console.tsx", anchor: "chain ring): boolean { return status :: cancelled,finalized", class: "locked", why: "decidedLock: finalized/cancelled; a held fixture is not locked" },
  { file: "apps/web/src/components/v2/fixture-console.tsx", anchor: "map TYLE: Record<string, string> = :: abandoned,cancelled,decided,finalized,forfeited,in_play,needs_decision,scheduled", class: "status-domain", why: "STATUS_STYLE: one chip style per status; a missing key renders an unstyled chip" },
  { file: "apps/web/src/components/v2/officials-panel.tsx", anchor: "nst RATEABLE_STATUS = new Set( :: decided,finalized", class: "played", why: "RATEABLE: officials are rated once a match is decided (official-marks.ts RATEABLE); a held match is not decided" },
  { file: "apps/web/src/components/v2/stages-panel.tsx", anchor: "stageFixtures.filter( (f) => :: decided,finalized", class: "played", why: "the stage's played/total count (a result exists); a held fixture is not counted played" },
  { file: "apps/web/src/components/v2/stages-panel.tsx", anchor: "d. !stageFixtures.some((f) => :: decided,finalized,in_play,needs_decision", class: "took-place", why: "the Delete-stage door: a stage whose fixtures were played cannot be deleted (mirrors stages.ts deleteStage); a held fixture was played" },
  { file: "apps/web/src/components/v2/stages-panel.tsx", anchor: "const VOID_STATUSES = new Set( :: abandoned,cancelled,forfeited", class: "void", why: "VOID_STATUSES: struck-through, no-result rows; a held fixture is not void" },
  { file: "apps/web/src/lib/division-phase.ts", anchor: " vanish. const LIVE = new Set( :: in_play,needs_decision,scheduled", class: "not-finished", why: "LIVE: a division is never 'finished' while a fixture is live; a held fixture still owes the organiser's settle (J2 shape: a held third-place playoff beside a complete knockout)" },
  { file: "apps/web/src/lib/division-phase.ts", anchor: "nst PLAYED_STATUSES = new Set( :: decided,finalized", class: "played", why: "PLAYED_STATUSES: 'a result exists' (card-stats PLAYED mirror); a held fixture has none" },
  { file: "apps/web/src/lib/division-phase.ts", anchor: "s)); const TERMINAL = new Set( :: abandoned,cancelled,decided,finalized,forfeited", class: "played", why: "TERMINAL for allPlayed: every fixture finished; a held fixture is not finished, so the division is not" },
  { file: "apps/web/src/lib/division-phase.ts", anchor: "_up\"; // 5. scheduled — a live :: in_play,scheduled", class: "not-a-set", why: "a comment naming rule 5's statuses, not a set the code reads" },
  { file: "apps/web/src/lib/fixture-row-action.ts", anchor: "r. */ const SETTLED = new Set( :: abandoned,cancelled,decided,finalized,forfeited", class: "played", why: "SETTLED: the run-sheet row's 'result' action; a held row falls to 'view' until Task 11 gives it its own chip and door (spec §5.5, finding 25)" },
  { file: "apps/web/src/lib/fixture-status.ts", anchor: "xport const FIXTURE_STATUSES = :: abandoned,cancelled,decided,finalized,forfeited,in_play,needs_decision,scheduled", class: "status-domain", why: "FIXTURE_STATUSES: every value of fixtures.status" },
  { file: "apps/web/src/lib/matches-hub.ts", anchor: "st TERMINAL = new Set<string>( :: abandoned,cancelled,decided,finalized,forfeited,needs_decision", class: "took-place", why: "TERMINAL: 'will not be played again' → the Completed list; a held fixture was played and is listed there with its own status line" },
  { file: "apps/web/src/lib/overlay-model.ts", anchor: "ERLAY_VOID_STATUSES = new Set( :: abandoned,cancelled,forfeited", class: "void", why: "OVERLAY_VOID_STATUSES: the overlay's void frame; a held fixture is not void" },
  { file: "apps/web/src/lib/overlay-model.ts", anchor: "onst ENDED_STATUSES = new Set( :: decided,finalized", class: "played", why: "ENDED_STATUSES: the overlay's 'Final' frame; a held fixture has no final result" },
  { file: "apps/web/src/lib/run-sheet-groups.ts", anchor: "se\"). */ const OPEN = new Set( :: in_play,scheduled", class: "to-play", why: "OPEN: an untimed fixture still to be PLAYED goes to the Unscheduled pile ('Set time'); bracket rows are routed before this check, and a held fixture has no play to schedule" },
  { file: "apps/web/src/lib/scan-screen.ts", anchor: "map ViewOnlyReason, MessageKey>> = :: cancelled,finalized", class: "other-vocabulary", why: "keyed by ViewOnlyReason (carried_forward/finalized/cancelled/no_opponent), not by fixtures.status" },
  { file: "apps/web/src/lib/scorer-sheets.ts", anchor: "ReadonlySet<string> = new Set( :: in_play,scheduled", class: "to-play", why: "PRINTABLE_STATUSES: a paper scorer sheet for a match still to be played; nobody scores a held match from paper" },
  { file: "apps/web/src/lib/swiss-shell.ts", anchor: "ISS_PLAYED_STATUSES = new Set( :: abandoned,decided,finalized,forfeited,in_play", class: "unreachable", why: "SWISS_PLAYED_STATUSES: swiss only — a DRAW kind, where needs_decision never occurs" },
  { file: "apps/web/src/lib/table-withdrawal.ts", anchor: "ReadonlySet<string> = new Set( :: decided,finalized,forfeited", class: "played", why: "WITHDRAWAL_PLAYED_STATUSES: needs_decision is OUT — table stages never hold it, and the bracket cascade maps a held row to 'void', which withdrawBracketEntrant skips (ruling C17)" },
  { file: "apps/web/src/lib/table-withdrawal.ts", anchor: "ReadonlySet<string> = new Set( :: in_play,scheduled", class: "to-play", why: "WITHDRAWAL_PENDING_STATUSES: a pending fixture is walked over on withdrawal; a held fixture stays held (C17; auto-walkover of a held fixture is W2b's, spec §2.3)" },
  { file: "apps/web/src/server/engine-db/append-event.ts", anchor: "ReadonlySet<string> = new Set( :: cancelled,finalized", class: "locked", why: "LOCKED_FIXTURE_STATUSES: needs_decision must accept settle and void" },
  { file: "apps/web/src/server/engine-db/append-event.ts", anchor: "map Kind: string | null, ): string :: forfeited,in_play", class: "not-a-set", why: "the status rule's own ternary returns inside fixtureStatusFromFold, not a status set" },
  { file: "apps/web/src/server/engine-db/competition.ts", anchor: "chain tatus(f.status); return status :: in_play,scheduled", class: "other-vocabulary", why: "engine FixtureStatus after toEngineStatus; engineFixtureStatus maps needs_decision to in_play, so a held fixture is open here" },
  { file: "apps/web/src/server/engine-db/level-seat.ts", anchor: "ReadonlySet<string> = new Set( :: decided,finalized,forfeited", class: "played", why: "SEATING_STATUSES (W2a T8, X-BR-1): the statuses whose outcome seats someone; a held fixture seats nobody, and with needs_decision IN every held fixture would throw LEVEL_RESULT_SEATED" },
  { file: "apps/web/src/server/og/match-poster.tsx", anchor: "chain hPosterVariant = header.status :: decided,in_play", class: "other-vocabulary", why: "MatchCentreHeader status (in_play/decided/scheduled/other), not fixtures.status" },
  { file: "apps/web/src/server/og/model.ts", anchor: "chain ? \"live\" : input.fixtureStatus :: decided,finalized", class: "played", why: "the OG card's 'result' variant needs a result; a held fixture has none (its card wording is Task 13's)" },
  { file: "apps/web/src/server/public-site/champion.ts", anchor: "ReadonlySet<string> = new Set( :: decided,finalized,forfeited", class: "played", why: "BRACKET_SETTLED: a fixture with a winner; a held fixture names none, so no champion" },
  { file: "apps/web/src/server/public-site/champion.ts", anchor: "chain : ChampionFixture) => f.status :: decided,finalized", class: "played", why: "`finished`: stage done when every fixture has a result; a held fixture blocks the champion" },
  { file: "apps/web/src/server/public-site/competition-hub.ts", anchor: "ReadonlySet<string> = new Set( :: abandoned,cancelled,forfeited,needs_decision", class: "status-domain", why: "STATUS_LINE_KEYS: every status reaching the 'other' header gets its own line (preflight C16)" },
  { file: "apps/web/src/server/public-site/match-centre-schema.ts", anchor: ": z.boolean(), status: z.enum( :: decided,in_play,scheduled", class: "other-vocabulary", why: "the match-centre header's four-value enum (scheduled/in_play/decided/other)" },
  { file: "apps/web/src/server/public-site/match-centre.ts", anchor: "map tus\"] { switch (fixtureStatus) :: decided,finalized,in_play,scheduled", class: "falls-through", why: "statusOf: DB status → header enum; needs_decision deliberately takes the default 'other', whose status line STATUS_LINE_KEYS now names" },
  { file: "apps/web/src/server/slideshow-data.ts", anchor: "ults = fixtures .filter((f) => :: decided,finalized,forfeited", class: "played", why: "the slideshow's Results list; a held fixture has no result" },
  { file: "apps/web/src/server/slideshow-data.ts", anchor: "= data.fixtures .filter((f) => :: decided,finalized,forfeited", class: "played", why: "the slideshow's Results list (second builder); a held fixture has no result" },
  { file: "apps/web/src/server/slideshow-labels.ts", anchor: "map et.round.qualifier2\"), status: :: abandoned,cancelled,decided,finalized,forfeited,scheduled", class: "unreachable", why: "per-status labels for the slideshow lists; no list carries needs_decision (live=in_play, results=decided/finalized/forfeited, upcoming=scheduled)" },
  { file: "apps/web/src/server/usecases/americano.ts", anchor: "d = ${stageId} and f.status in :: decided,finalized", class: "unreachable", why: "americano standings; a DRAW kind, needs_decision never occurs" },
  { file: "apps/web/src/server/usecases/card-stats.ts", anchor: "elled fixtures. const PLAYED = :: decided,finalized", class: "played", why: "PLAYED: the desk's 'N of M played' (a result exists); a held fixture is not played" },
  { file: "apps/web/src/server/usecases/card-stats.ts", anchor: "ed_at is null and f.status in :: in_play,scheduled", class: "to-play", why: "the competition card's 'what's next' match; a held fixture has no play ahead" },
  { file: "apps/web/src/server/usecases/card-stats.ts", anchor: "sion_id = d.id and f.status in :: in_play,scheduled", class: "to-play", why: "the division card's 'what's next' match; a held fixture has no play ahead" },
  { file: "apps/web/src/server/usecases/carried-forward.ts", anchor: "ReadonlySet<string> = new Set( :: abandoned,decided,forfeited", class: "played", why: "SETTLED_OPEN_STATUSES: settled rows whose winner may have been carried forward; a held fixture seated nobody, so it is never carried" },
  { file: "apps/web/src/server/usecases/competition-desk.ts", anchor: "ndidates = rows.filter( (f) => :: in_play,scheduled", class: "to-play", why: "resolveDivisionNext: the desk's next playable match; a held fixture has no play ahead" },
  { file: "apps/web/src/server/usecases/competition-desk.ts", anchor: "chain  rows.filter( (f) => (f.status :: in_play,scheduled", class: "to-play", why: "same expression as the span row: the desk's next playable match" },
  { file: "apps/web/src/server/usecases/device-links.ts", anchor: "chain us: string): boolean => status :: cancelled,finalized", class: "locked", why: "isFinishedFixtureStatus: no device link once finalized/cancelled; a held fixture can still take a scorer's void" },
  { file: "apps/web/src/server/usecases/discipline.ts", anchor: " <= s.decided_at) continue; if :: decided,finalized", class: "played", why: "a suspension is served by a decided match; a held match counts once settled" },
  { file: "apps/web/src/server/usecases/discipline.ts", anchor: "chain ded_at) continue; if (f.status :: decided,finalized", class: "played", why: "same expression as the span row: a suspension is served by a decided match" },
  { file: "apps/web/src/server/usecases/divisions.ts", anchor: "ision_id = ${id} and status in :: decided,finalized,forfeited", class: "played", why: "the audit count of results deleted with a division; a held fixture is not a result" },
  { file: "apps/web/src/server/usecases/exports.ts", anchor: " ${divisionId} and f.status in :: in_play,scheduled", class: "to-play", why: "the officials' duty export: matches still to be officiated; a held match has none left" },
  { file: "apps/web/src/server/usecases/fixture-results-sql.ts", anchor: "n); return tx`( ${f}.status in :: decided,finalized,in_play,needs_decision", class: "took-place", why: "fixtureHasResultSql: the rebuild/history 'started or finished' predicate; a held fixture was played" },
  { file: "apps/web/src/server/usecases/match-reports.ts", anchor: "t (SPEC-3). const REPORTABLE = :: abandoned,decided,finalized", class: "played", why: "REPORTABLE: reports open when a match ENDS (decided/finalized/abandoned); a held match has not ended — its result is pending" },
  { file: "apps/web/src/server/usecases/me-officiating.ts", anchor: "]; } const FINISHED_STATUSES = :: abandoned,cancelled,decided,finalized,forfeited", class: "played", why: "FINISHED_STATUSES: the completed lane; a held match is not finished" },
  { file: "apps/web/src/server/usecases/me-officiating.ts", anchor: " neither list. and f.status in :: in_play,needs_decision,scheduled", class: "not-finished", why: "outstanding duties: assigned and not finished (ruling D-F3) — a held match waits for the organiser's settle and must stay findable; FINISHED_STATUSES never holds it" },
  { file: "apps/web/src/server/usecases/me-officiating.ts", anchor: "} const fixture = rows[0]!; if :: cancelled,finalized", class: "locked", why: "responses close once finalized/cancelled" },
  { file: "apps/web/src/server/usecases/me-officiating.ts", anchor: "chain ]!; if (fixture.fixture_status :: cancelled,finalized", class: "locked", why: "same expression as the span row: responses close once finalized/cancelled" },
  { file: "apps/web/src/server/usecases/me.ts", anchor: "d_into is null and f.status in :: in_play,scheduled", class: "to-play", why: "a player's upcoming matches; a held match has no play ahead" },
  { file: "apps/web/src/server/usecases/me.ts", anchor: "iles\", \"NOT_YOUR_FIXTURE\"); if :: cancelled,finalized", class: "locked", why: "availability closes once finalized/cancelled" },
  { file: "apps/web/src/server/usecases/me.ts", anchor: "d); if (!mine) return null; if :: cancelled,finalized", class: "locked", why: "check-in closes once finalized/cancelled" },
  { file: "apps/web/src/server/usecases/me.ts", anchor: "chain URE\"); if (mine.fixture_status :: cancelled,finalized", class: "locked", why: "same expression as the span row: availability closes once finalized/cancelled" },
  { file: "apps/web/src/server/usecases/me.ts", anchor: "chain  null; if (mine.fixture_status :: cancelled,finalized", class: "locked", why: "same expression as the span row: check-in closes once finalized/cancelled" },
  { file: "apps/web/src/server/usecases/official-marks.ts", anchor: "e mark rated. const RATEABLE = :: decided,finalized", class: "played", why: "RATEABLE: an official is marked once a match is decided; a held match is not" },
  { file: "apps/web/src/server/usecases/org-posts.ts", anchor: "s\"]); const DECIDED = new Set( :: decided,finalized,forfeited", class: "played", why: "DECIDED: a result post needs a result" },
  { file: "apps/web/src/server/usecases/org-posts.ts", anchor: "*) filter (where status not in :: decided,finalized,forfeited", class: "played", why: "the round recap waits while any fixture is NOT in this result set; a held fixture keeps the round open" },
  { file: "apps/web/src/server/usecases/org-posts.ts", anchor: "_id = ${stageId} and status in :: decided,finalized,forfeited", class: "played", why: "recent-form results; a held fixture is not a result" },
  { file: "apps/web/src/server/usecases/org-posts.ts", anchor: "ng; } const DECIDED_STATUSES = :: decided,finalized,forfeited", class: "played", why: "DECIDED_STATUSES for the digest; a held fixture is not a result" },
  { file: "apps/web/src/server/usecases/player-stats.ts", anchor: "_STATUSES: readonly string[] = :: in_play,needs_decision,scheduled", class: "not-finished", why: "IN_PLAY_FIXTURE_STATUSES: not yet settled for the stats coverage; held stays out of the fold until settled, matching COMPLETED_FIXTURE_STATUSES ('5 goals · 0 matches' otherwise)" },
  { file: "apps/web/src/server/usecases/player-stats.ts", anchor: "_STATUSES: readonly string[] = :: decided,finalized,forfeited", class: "played", why: "COMPLETED_FIXTURE_STATUSES: the 'matches' count; a held match counts once settled" },
  { file: "apps/web/src/server/usecases/schedule-health.ts", anchor: "_id = ${stageId} and status in :: abandoned,decided,finalized,forfeited,in_play,needs_decision,scheduled", class: "took-place", why: "fixtures that occupied a court slot for the health metrics; a held fixture was played in its slot" },
  { file: "apps/web/src/server/usecases/schedule.ts", anchor: "s it. export const OCCUPYING = :: decided,finalized,forfeited,in_play,needs_decision,scheduled", class: "took-place", why: "OCCUPYING: statuses that hold a court; a held fixture was played in its slot (and is FIXED, not movable)" },
  { file: "apps/web/src/server/usecases/scoring.ts", anchor: "r }[]>` select count(*) filter :: decided,forfeited", class: "played", why: "the stage auto-complete probe counts fixtures NOT decided/forfeited as open; a held fixture keeps the stage open" },
  { file: "apps/web/src/server/usecases/stages.ts", anchor: "_id = ${stageId} and status in :: decided,finalized,in_play,needs_decision", class: "took-place", why: "deleteStage's guard: a stage with played fixtures cannot be deleted; a held fixture was played" },
  { file: "apps/web/src/server/usecases/stages.ts", anchor: " }; } const DECIDED = new Set( :: decided,finalized,forfeited", class: "unreachable", why: "DECIDED for the swiss pairing gates (:1095, :1181); swiss is a DRAW kind, needs_decision never occurs" },
  { file: "apps/web/src/server/usecases/stages.ts", anchor: "nst PENDING_FIXTURE_STATUSES = :: in_play,scheduled", class: "to-play", why: "PENDING_FIXTURE_STATUSES: roster drift — fixtures still expecting their entrants to turn up; a held fixture expects no play" },
  { file: "apps/web/src/server/usecases/stream-sessions.ts", anchor: "chain  }, fixtureDecided: fx?.status :: decided,finalized", class: "played", why: "fixtureDecided on the stream session; a held fixture is not decided" },
  { file: "apps/web/src/server/usecases/venues.ts", anchor: "st UNPLAYED_FIXTURE_STATUSES = :: in_play,scheduled", class: "to-play", why: "UNPLAYED_FIXTURE_STATUSES: fixtures that still need a court; a held fixture needs no court" },
  { file: "apps/web/src/server/usecases/withdrawal.ts", anchor: "cadeOut, ): Promise<void> { if :: cancelled,finalized", class: "locked", why: "the withdrawal cascade skips finalized/cancelled; a held bracket row is mapped to 'void' and skipped by the engine (C17)" },
  { file: "apps/web/src/server/usecases/withdrawal.ts", anchor: "chain ise<void> { if (fixture.status :: cancelled,finalized", class: "locked", why: "same expression as the span row" },
  { file: "db/migration/deltas/V116__discovery.sql", anchor: "d AND f.status IN :: decided,finalized", class: "historical-sql", why: "the discovery view, redefined by V238/V306/V419; V419 is live" },
  { file: "db/migration/deltas/V306__entitlement_resolver_parity.sql", anchor: "c.id and f.status in :: decided,finalized", class: "historical-sql", why: "the discovery view, redefined by V419" },
  { file: "db/migration/deltas/V354__division_slot_consumption.sql", anchor: "p_division_id and f.status in :: decided,finalized,forfeited", class: "historical-sql", why: "division_has_results, redefined by V355" },
  { file: "db/migration/deltas/V354__division_slot_consumption.sql", anchor: " (division_id) where status in :: decided,finalized,forfeited", class: "historical-sql", why: "fixtures_division_results_idx, dropped and recreated by V355" },
  { file: "db/migration/deltas/V355__division_results_abandoned_outcome.sql", anchor: "uard. It matched -- `status in :: decided,finalized,forfeited", class: "not-a-set", why: "a header comment quoting V354's predicate" },
  { file: "db/migration/deltas/V355__division_results_abandoned_outcome.sql", anchor: "p_division_id and (f.status in :: decided,finalized,forfeited", class: "historical-sql", why: "division_has_results, redefined by V432 (ruling D-F3)" },
  { file: "db/migration/deltas/V355__division_results_abandoned_outcome.sql", anchor: " (division_id) where status in :: abandoned,decided,finalized,forfeited", class: "historical-sql", why: "fixtures_division_results_idx, dropped and recreated by V432" },
  { file: "db/migration/deltas/V419__discovery_excludes_drafts.sql", anchor: "c.id and f.status in :: decided,finalized", class: "played", why: "discovery quality floor (live view): ≥1 decided fixture; a held fixture is not decided" },
  { file: "db/migration/deltas/V430__capture_stream_codes.sql", anchor: "l as $$ begin if new.status in :: abandoned,cancelled,decided,finalized,forfeited", class: "played", why: "fixtures_track_finished's finished set: needs_decision is played-not-finished, finished_at null" },
  { file: "db/migration/deltas/V430__capture_stream_codes.sql", anchor: "ow()); elsif old.status not in :: abandoned,cancelled,decided,finalized,forfeited", class: "played", why: "fixtures_track_finished's finished set (the elsif arm): the same set as :26" },
  { file: "db/migration/deltas/V430__capture_stream_codes.sql", anchor: "hed_at = now() where status in :: abandoned,cancelled,decided,finalized,forfeited", class: "historical-sql", why: "a one-time finished_at backfill, run once at V430" },
  { file: "db/migration/deltas/V432__fixture_status_needs_decision.sql", anchor: "_status_check check (status in :: abandoned,cancelled,decided,finalized,forfeited,in_play,needs_decision,scheduled", class: "status-domain", why: "the check constraint" },
  { file: "db/migration/deltas/V432__fixture_status_needs_decision.sql", anchor: "off','ladder') and f.status in :: decided,finalized", class: "historical-sql", why: "ruling 82's one-time backfill: the source statuses it moves TO needs_decision" },
  { file: "db/migration/deltas/V432__fixture_status_needs_decision.sql", anchor: "p_division_id and (f.status in :: decided,finalized,forfeited", class: "played", why: "division_has_results (live, ruling D-F3): the unconditional verdict arm; a held fixture enters through the outcome-checked arm beside it" },
  { file: "db/migration/deltas/V432__fixture_status_needs_decision.sql", anchor: "rfeited') or (f.status in :: abandoned,needs_decision", class: "took-place", why: "division_has_results's outcome-checked arm (ruling D-F3): a held fixture is recorded play and holds the quota slot, unless its outcome is no_result (V355's rule)" },
  { file: "db/migration/deltas/V432__fixture_status_needs_decision.sql", anchor: " (division_id) where status in :: abandoned,decided,finalized,forfeited,needs_decision", class: "took-place", why: "the partial index backing division_has_results; must cover both of its status arms or the planner ignores it" },
  { file: "db/migration/v2-engine/tables/V214__fixtures.sql", anchor: "d' check (status in :: abandoned,cancelled,decided,finalized,forfeited,in_play,scheduled", class: "historical-sql", why: "superseded by V432's fixtures_status_check" },
  { file: "db/migration/v2-engine/views/V238__view_public_discovery.sql", anchor: "c.id and f.status in :: decided,finalized", class: "historical-sql", why: "the discovery view, redefined by V306/V419" },
  { file: "tools/matrix/lib/model/state.ts", anchor: "only string[] = Object.freeze( :: abandoned,cancelled", class: "void", why: "the harness model's VOID_STATUSES (engine 'void'); a held fixture is not void" },
  { file: "tools/matrix/lib/observed.ts", anchor: "only string[] = Object.freeze( :: abandoned,cancelled,decided,finalized,forfeited", class: "played", why: "the harness's TERMINAL_STATUSES; a held fixture is not terminal — the harness must read it as open" },
  { file: "tools/matrix/lib/observed.ts", anchor: "only string[] = Object.freeze( :: in_play,scheduled", class: "to-play", why: "the harness's PENDING_STATUSES (lib/table-withdrawal.ts's reading)" },
  { file: "tools/matrix/lib/observed.ts", anchor: "only string[] = Object.freeze( :: cancelled,finalized", class: "locked", why: "the harness's LOCKED_STATUSES (withdrawal.ts:102)" },
  { file: "tools/matrix/lib/observed.ts", anchor: "SES.includes(before.status) && :: abandoned,forfeited", class: "void", why: "the walkover outcome statuses (abandoned/forfeited) a withdrawal writes" },
  { file: "tools/matrix/lib/observed.ts", anchor: "chain es(before.status) && (f.status :: abandoned,forfeited", class: "void", why: "same expression as the span row" },
  { file: "tools/matrix/lib/scenarios/r4-withdrawal.ts", anchor: "ed. */ const LOCKED = new Set( :: cancelled,finalized", class: "locked", why: "LOCKED (withdrawal.ts applyUpdate skip set)" },
  { file: "tools/matrix/lib/scenarios/r4-withdrawal.ts", anchor: "only string[] = Object.freeze( :: abandoned,cancelled,forfeited", class: "void", why: "NOT_PLAYED: the void/walkover statuses a withdrawal leaves" },
  { file: "scripts/smoke.ts", anchor: ".away_entrant_id) continue; if :: decided,finalized", class: "played", why: "skip a fixture that already has a result while deciding a round" },
  { file: "scripts/smoke.ts", anchor: "t_id && f.away_entrant_id && ! :: decided,finalized", class: "played", why: "decidable = no result yet" },
  { file: "scripts/smoke.ts", anchor: "chain ant_id) continue; if (f.status :: decided,finalized", class: "played", why: "same expression as the span row" },
  { file: "scripts/smoke.ts", anchor: "chain state.status}')`, state.status :: decided,finalized", class: "played", why: "the visual gate asserts full time DECIDES the seeded fixture" },
];
