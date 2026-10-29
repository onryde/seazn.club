import type { Metadata } from "next";

export const metadata: Metadata = { title: "Changelog & versioning" };

// One entry per meaningful API change — newest first. Keep entries additive
// and dated; this page IS the versioning promise (v3/08 §3).
const ENTRIES: { date: string; title: string; lines: string[] }[] = [
  {
    date: "2026-10-29",
    title: "Breaking: the standings export prints what the public standings table prints",
    lines: [
      "GET /divisions/{id}/exports/standings (PDF and XLSX) now builds its columns and cells from the same selection as the public table. After Pts it prints the sport's derived columns the stage's tie-break order uses (cricket NRR, set-sport ratios and differences, carrom ratios, chess Buchholz Cut-1, Buchholz and Sonneborn-Berger, hockey field goals, tennis game ratio), in the public order, with the public header and text. Every derived value is a text cell.",
      "A metric nobody recorded for an entrant is now the text \u2014 where it was the number 0: a team that has not played shows \u2014 for goals for, goals against and goal difference, as the public table does. A recorded 0 and the counts (played, won, drawn, lost, points) stay numbers; a half-point (chess) table's Pts is text (1\u00bd), as it has been since 2026-10-28. A metric the sport declares with decimals prints as the public table does and is a text cell only where that text is not the plain number (3 under one decimal is 3.0, text; 12.5 stays numeric); no built-in sport declares one today.",
      "# now prints the row's stored place, as the public table does, where it used to print the row's position in the document. The engine's places run 1 to n and are distinct, so a table the engine ranked prints the same numbers; a stored table whose places are not 1 to n prints them as stored. Positions up to and including Pts do not move.",
      "Read the sheet by header text, treat \u2014 as no value, and do not assume Pts is the last column. The PDF's standings columns are also sized from their own content now.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-29",
    title: "Breaking: a cricket test-variant stage no longer accepts superOverStillTied",
    lines: [
      "superOverStillTied is what a tied super over does (another super over, or a tied match). A cricket test match is two innings a side and has no super over, so the key is now offered only on the t20, odi and hundred variants.",
      "PUT /stages/{id}/rules on a cricket test-variant stage whose rules carry superOverStillTied answers 400 RULE_NOT_SETTABLE with error.field superOverStillTied, and nothing is written. The same key on a t20, odi or hundred stage is unchanged.",
      "Leave the key out of a test stage's rules. A stored superOverStillTied on a test stage was never read and is left as it is.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-29",
    title: "Breaking: expected_seq above 2147483647 is a 400",
    lines: [
      "POST /fixtures/{id}/events compares expected_seq with the ledger's seq, a 32-bit integer in the database. A larger value used to reach that comparison and answer 500; it is now refused at the door.",
      "The answer is 400 VALIDATION with error.issues naming expected_seq, before any authorisation or database work. Send the seq of the last event you read.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a hockey or ice hockey shoot-out config no longer carries suddenDeath",
    lines: [
      "config.shootout.suddenDeath (a boolean, true in both presets) had no effect on any kick or result and is removed: GET /divisions/{id} stops returning it once the stored copies are migrated.",
      "POST /competitions/{id}/divisions, PATCH /divisions/{id}, POST and PUT /divisions/{id}/stages, PUT /stages/{id}/rules and PUT /fixtures/{id}/rules do not refuse a hockey or ice hockey config that still sends it: the key is dropped and the rest of the shoot-out is read as before.",
      "Stored copies are removed by the release's migration, which runs before the deploy. Until the new server is up, PATCH /divisions/{id} on a hockey or ice hockey division with a shoot-out answers 422 CONFIG_INVALID (issue path shootout); a retry succeeds after the deploy, and scoring is not affected. The fold epochs are now 5 (hockey) and 3 (ice hockey): a native scoring client still on the old epoch must update.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a hockey or ice hockey shoot-out attempt out of the federation's order is refused",
    lines: [
      "A shoot-out pair used to be opened by the side that took the first attempt, every time. Now hockey follows FIH Appendix 12 (§20c, §21b): series of five, and the side that opened a series defends the first attempt of the next. Ice hockey follows IIHF Rule 84.4 IX: the team that shot second in the first five opens the tie-break shots and every pair after them. The first series and the second attempt of each pair are unchanged; football is unchanged.",
      "POST /fixtures/{id}/events answers 422 INVALID_EVENT (message: attempts must alternate: expected \"<entrant id>\") for a hockey.shootout.attempt or icehockey.shootout.attempt out of that order, and nothing is written. POST /divisions/{id}/events/import still returns 200; that stream is rejected with error.code import.fold_rejected and error.engineCode INVALID_EVENT.",
      "Record the attempts in the order they were taken. A shoot-out already recorded in the old order still replays to its result.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: The Hundred's net run rate is printed per five-ball over",
    lines: [
      "A cricket table's net run rate is runs per over (ECB The Hundred Playing Conditions 2026, 16.9.4(a)), and an over on The Hundred is five balls (17.1). The division table, the hub table and the qualification what-if now print NRR per over of the division's own length: five balls on The Hundred (config.ballsPerOver 5), six anywhere else.",
      "A side that scored 120 off 100 balls and conceded 100 off 100 balls printed +1.200 and now prints +1.000. thehundred.com's explainer divides by balls faced (+0.200 here), so the printed figure reads five times it.",
      "Nothing on the wire changes: GET /stages/{id}/standings carries the ledger in balls (runs_for, balls_faced_eff, runs_against, balls_bowled_eff), and the order of a table does not move. A client that works NRR out itself divides by config.ballsPerOver, not by six.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a dismissal a no ball or a wide does not admit is refused",
    lines: [
      "A cricket.ball or cricket.superover.ball whose runs.extras.kind is noball or wide is now refused when its wicket.kind is not one the delivery admits: off a no ball only hitballtwice, obstructed and runout stand (ICC Playing Conditions 21.18); off a wide only hitwicket, obstructed, runout and stumped (22.9). Retired and timedout are refused on both. A wicket on a legal delivery is unchanged.",
      "POST /fixtures/{id}/events answers 422 INVALID_EVENT (message: \"bowled\" cannot dismiss on a no ball) and nothing is written. POST /divisions/{id}/events/import still returns 200; that stream is rejected with error.code import.fold_rejected and error.engineCode INVALID_EVENT.",
      "Send the delivery without a wicket when the batter was not out. A delivery already recorded with such a dismissal still replays and can be voided.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a cricket match decided by DLS or with revised overs credits the first side as the ICC does",
    lines: [
      "For a one-innings cricket match that Duckworth-Lewis-Stern decided, or that was played with revised overs, the first side's net run rate ledger is no longer its own innings (ICC Playing Conditions 16.10.7). Abandoned with a DLS result, it is credited Team 2's par score off the balls Team 2 faced; with DLS applied earlier, or revised overs, it is credited one run less than Team 2's final target off the overs allocated to Team 2. Team 2 is credited as played, an all-out innings at its full allocated overs.",
      "GET /stages/{id}/standings moves runs_for, balls_faced_eff and run_diff for such a match: 200 off 20 overs, with a chase revised to 160 off 15 overs, now reads 159 off 90 balls (+1.267 for the match, was +0.667). A table whose order NRR decides can reorder. Every other match, a two-innings match and a forfeit are unchanged.",
      "A stored standings snapshot keeps its old figures until the stage's table is next recomputed. No recorded match changes its result.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a set target below 5, or a tennis best of 1 with a match tie-break, is refused when written",
    lines: [
      "POST /competitions/{id}/divisions, PATCH /divisions/{id}, POST and PUT /divisions/{id}/stages, PUT /stages/{id}/rules and PUT /fixtures/{id}/rules refuse a volleyball or table tennis config whose setTo or finalSetTo is below 5 with 422 CONFIG_INVALID, and nothing is written. error.issues carries the sentence: \"A set must be played to at least 5 points.\"",
      "The same paths refuse a tennis config of best of 1 whose final set is a match tie-break (finalSet.matchTiebreakTo) the same way: \"A match tie-break replaces a deciding set; best of 1 has none.\" Best of 1 with a final-set tie-break (finalSet.tiebreakTo) is still accepted.",
      "POST /competitions/from-template refuses a template whose division or stage would be such a config with 422 TEMPLATE_INSTANTIATION_FAILED (divisionIndex, stageIndex, cause).",
      "A division or stage save that would leave an unstarted match's own format (PUT /fixtures/{id}/rules) one of these configs is refused 422 CONFIG_INVALID naming the match (error.fixture_id).",
      "Configs stored before this release still load and play: only a new write is judged. The release's migration counts stored configs that break either rule and, if it finds any, stops the deploy and names each one. This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a short-set tie-break ends at 5–4 (Fast4 and short-sets)",
    lines: [
      "A tennis set may carry its own tie-break margin, set.tiebreakWinBy (optional). Absent, a set tie-break plays to tiebreak.winBy as before; the match tie-break and a final-set tie-break (finalSet.tiebreakTo) always do, whatever set.tiebreakWinBy says.",
      "A Fast4 division created from this release on, and the new short-sets format (tie-break at 4-all), play ITF Appendix VI's short-set tie-break: first to 5 with a deciding point at 4–4. A tennis.point at 4–4 ends the set; a summary of 4–3 with tb 5–4 is accepted; a tb block of 6–4 or 6–5 is refused 422 INVALID_EVENT.",
      "Any tie-break played to a margin of one (set.tiebreakWinBy 1 or tiebreak.winBy 1) refuses a tb block or match tie-break summary past its target (8–7 to seven) with INVALID_EVENT, on POST /fixtures/{id}/events and events/import alike.",
      "Fast4 divisions created before this release keep the margin they played: the release's migration writes each one's own tiebreak.winBy (2 unless the organiser chose a margin of one) into set.tiebreakWinBy. Summaries recorded before the change still replay as recorded. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a tennis set score no set can reach is refused",
    lines: [
      "POST /fixtures/{id}/events refuses a tennis.set_summary in plain games whose score no set can reach under its tie-break (8–6 or 9–7 with the tie-break at 6-all, 5–3 in a Fast4 set) with 422 SET_SCORE_UNREACHABLE, and nothing is written.",
      "POST /divisions/{id}/events/import rejects such a stream the same way: error.code import.fold_rejected, error.engineCode SET_SCORE_UNREACHABLE, nothing written for its fixture.",
      "A summary whose score before its last game was already a finished set (7–0, 8–0, 9–3, in any set including an advantage set) was refused INVALID_EVENT and is now refused SET_SCORE_UNREACHABLE.",
      "Send the score that was played; a set that went to the tie-break is 7–6 (or 4–3 in Fast4) with its tb points. Summaries recorded before the change still replay as recorded.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a match-ending sanction must be followed by its ending",
    lines: [
      "After a badminton disqualification (black card) or a tennis default, POST /fixtures/{id}/events refuses every event but core.forfeit and core.abandon with 422 ENDING_SANCTION_PENDING, and nothing is written.",
      "POST /divisions/{id}/events/import rejects such a stream the same way: error.code import.fold_rejected, error.engineCode ENDING_SANCTION_PENDING, nothing written for its fixture.",
      "Send the ending, core.forfeit with by the sanctioned entrant and reason \"disqualified\", or void the sanction. Ledgers recorded before the change still replay as recorded. Every other sanction level and sport is unchanged.",
      "A device link or an official scorer may now send that ending itself (201, was 403), but only as the event right after the sanction, against the same side; after a volleyball expulsion or disqualification the same holds for core.forfeit with reason \"retired\". Every other forfeit from a scorer is still 403 FORBIDDEN.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a generic division's config no longer carries progressScore",
    lines: [
      "The generic sport's division config had a progressScore flag, carried over from the v1 stepladder import. Nothing ever read it, so it is removed: GET /divisions/{id} stops returning config.progressScore once the stored copies are migrated.",
      "POST /competitions/{id}/divisions and PATCH /divisions/{id} do not refuse a config that still sends it: the key is dropped and the rest of the config is read as before. Stored copies are removed by the release's migration, which runs before the deploy. The generic sport's fold epoch is now 4: a native scoring client still on epoch 3 must update.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a carrom adjustment may not exceed the game target",
    lines: [
      "A carrom.game.adjust is now refused when its delta is more than gameTo points either way: 25 by default, 29 for the club-29 variant, or the match's own game target. The scorer's app already offered exactly that range.",
      "POST /fixtures/{id}/events answers 422 ADJUST_OUT_OF_RANGE and nothing is written. POST /divisions/{id}/events/import still returns 200; that stream is rejected with error.code import.fold_rejected and error.engineCode ADJUST_OUT_OF_RANGE.",
      "A delta of 0 or a fraction, and a deduction that would take a score below zero, were already refused as INVALID_EVENT and still are. An adjustment already recorded still replays and can be voided.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a board-game result's method must agree with its winner",
    lines: [
      "A boardgame.result is now refused when its method contradicts its winner: checkmate, resign, time or illegal_move with a null or omitted winner, or agreement, stalemate, insufficient, repetition, fifty_move or dead_position with a winner named.",
      "POST /fixtures/{id}/events answers 422 RESULT_METHOD_CONTRADICTS_WINNER and nothing is written. POST /divisions/{id}/events/import still returns 200; that stream is rejected with error.code import.fold_rejected and error.engineCode RESULT_METHOD_CONTRADICTS_WINNER.",
      "adjudication is accepted with or without a winner, and a result with no method is unchanged. A contradicting result already recorded still replays and can be voided.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: a cricket chase total may not pass the winning run",
    lines: [
      "A cricket.innings.summary for the chasing innings (the second of a one-innings match, the fourth of a two-innings match) is now refused when payload.runs is above the target minus 1 plus 7: a chase ends at the winning run, and the most the last ball adds from one run short is a no-ball hit for six.",
      "POST /fixtures/{id}/events answers 422 CHASE_OVERSHOOT (\"a chase ends at the winning run — check the total\") and nothing is written. POST /divisions/{id}/events/import still returns 200; that stream is rejected with error.code import.fold_rejected and error.engineCode CHASE_OVERSHOOT.",
      "The target is the other side's total plus 1, or a revised (DLS or confirmed) target. Earlier innings and ball-by-ball scoring are unchanged, and a chase total already recorded still replays and can be voided.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: the standings export refuses a table with no results",
    lines: [
      "GET /divisions/{id}/exports/standings with no stored table now answers 404 STANDINGS_NOT_AVAILABLE (\"no standings yet\"), not 404 NOT_FOUND.",
      "A division whose stored tables are all empty, or have no counted result yet, now gets the same 404 instead of a document with no rows or with the seed order printed as ranks. If a later stage's table is empty, the export prints the newest stage table that has results.",
      "Chess and other half-point tables now print Pts as the public table does (\"1½\", not the stored 3); in XLSX that cell is text. Whole-point sports keep a numeric Pts cell.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-28",
    title: "Breaking: an imported hockey goal must record its type",
    lines: [
      "POST /divisions/{id}/events/import now rejects a stream whose hockey.goal has no payload.kind, as POST /fixtures/{id}/events does since 2026-10-27.",
      "The call still returns 200. That stream's result is rejected with error.code import.fold_rejected and error.engineCode GOAL_KIND_REQUIRED, and nothing is written for its fixture. Other streams in the call are judged on their own.",
      "Send kind: \"fg\" if the type is unknown. Ice hockey and every other sport are unchanged.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-10-27",
    title: "Breaking: a hockey goal must record its type",
    lines: [
      "POST /fixtures/{id}/events with type hockey.goal now requires payload.kind: fg (field goal), pc (penalty corner), stroke (penalty stroke) or og (own goal, credited to the other side).",
      "An untyped hockey goal is refused with 422 GOAL_KIND_REQUIRED (\"a goal in this sport must record its type\") and nothing is written. Send kind: \"fg\" if the type is unknown — what an untyped goal always counted as.",
      "Untyped goals already recorded still replay as field goals and can still be voided. Ice hockey and every other sport are unchanged.",
      "This lands in v1 in place: no client outside the web app uses the API yet. Details: docs/api-v1-breaking-changes.md.",
    ],
  },
  {
    date: "2026-07-11",
    title: "Scoped keys, pins and rate-limit headers",
    lines: [
      "Key scopes are now read / score / manage (existing write keys migrated to manage — nothing breaks).",
      "New optional competition pin on keys: a pinned key 403s outside its competition.",
      "Every response carries X-RateLimit-Limit / -Remaining / -Reset; the per-key budget is 60 rpm (300 rpm on Pro).",
      "Published spec now documents x-required-scope per operation; session-only endpoints left the public spec.",
    ],
  },
  {
    date: "2026-07-10",
    title: "Registration v2 references",
    lines: [
      "Public self-withdraw by reference number: POST /public/registrations/by-ref/{ref}/withdraw.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        Changelog &amp; versioning
      </h1>
      <div className="mt-4 rounded-2xl bg-purple-50/60 p-5 text-sm leading-relaxed text-slate-700">
        <p className="font-semibold text-slate-900">The promise</p>
        <p className="mt-1">
          Additive changes (new endpoints, new optional fields) land in place and
          are announced here. Breaking changes are rare. Each one is listed here
          with its date, what changed and what to send instead.
        </p>
      </div>

      <ol className="mt-10 space-y-8 border-l-2 border-purple-100 pl-6">
        {ENTRIES.map((e) => (
          <li key={e.date + e.title} className="relative">
            <span
              aria-hidden
              className="absolute -left-[31px] top-1.5 h-2.5 w-2.5 rounded-full bg-purple-400 ring-4 ring-white"
            />
            <p className="font-mono text-xs uppercase tracking-wider text-slate-400">
              {e.date}
            </p>
            <h2 className="mt-1 font-semibold text-slate-900">{e.title}</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
              {e.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
