import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import { PhasePill, AttentionChip } from "@/components/v2/desk/phase-pill";
import { needsYouItems } from "@/components/v2/desk/needs-you";
import { ProgressionPanel, type SeedProposal } from "@/components/v2/progression-panel";
import { statusLine, finalDecidedStageName } from "@/lib/division-status-line";
import { leadingAttention,
  ATTENTION_SEVERITY, DIVISION_PHASES, DRAW_DOORS, resolveAttention, resolvePhase, sortAttentions,
  type Attention, type DivisionPhase, type DrawDoor, type PhaseFixture, type PhaseInput, type PhaseStage,
} from "@/lib/division-phase";
import { competitionPhase, type CompetitionDesk, type DeskDivision } from "@/server/usecases/competition-desk";
import type { DeskInPlayFixture } from "@/server/usecases/competition-desk";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => false) }));

/**
 * ENUMERATION 2 (fix round I): every RENDERING x every reachable
 * phase/attention pair.
 *
 * Instances 9 through 12 of this wave's signature defect are one class —
 * reachability asserted from a TYPE or a WORD rather than from the SCREEN —
 * and every one of them was a rendering that disagreed with another
 * rendering of the SAME division. Four surfaces state a division's condition:
 *
 *   1. the competition masthead pill   (competitionPhase + PhasePill)
 *   2. the ledger row pill             (PhasePill)
 *   3. the row's status line           (statusLine)
 *   4. the Needs-you item              (needsYouItems)
 *
 * (A fifth, the division page's start-locks tip in StagesPanel, was removed
 * with the banner itself in UI5, 2026-11-03.)
 *
 * They were fixed one at a time, in rounds F, G and H, each time by finding
 * the ONE surface that had not learned the rule. This file asks all of them at
 * once, for every pair that can actually occur.
 *
 * WHY IT FAILS WHEN A ROW IS DROPPED: the expectation is anchored OUTSIDE the
 * table. `REQUIRED_PAIRS` is the full cross product of `DIVISION_PHASES` x
 * (`ATTENTION_SEVERITY`'s keys + "none") minus `UNREACHABLE`, each exclusion
 * carrying the rule that makes it impossible. The sweep then asserts the
 * shapes cover exactly that set. Delete a shape and its pair goes uncovered;
 * add a phase or an attention kind and the cross product grows and stays
 * uncovered until someone either builds it or justifies it. Neither a value
 * change nor a deletion can pass quietly.
 */

const ATTENTION_KINDS = Object.keys(ATTENTION_SEVERITY) as Attention["kind"][];
const LEADING = [...ATTENTION_KINDS, "none"] as const;
type Leading = (typeof LEADING)[number];

/** Pairs the model makes impossible, each with the rule that forbids it. */
const UNREACHABLE: Record<string, string> = {
  // W4 T11: a waiting marker is written only after Start, and the row is never raised in a `setup` division. A started
  // division reads `setting_up` only by rule 4 — an open stage owing work, whose red row leads — or by rule 6, nothing
  // dated and nothing played, where every match still to play is undated and `unscheduled` (ordered first) leads.
  "setting_up/late_players_waiting": "raised only after Start, where setting_up means a red row or unscheduled leads",
  // Rule 2 refuses `finished` while any open stage owes work, and both of
  // these rows ARE an open stage owing work.
  "finished/needs_draw": "an open stage owing its draw blocks rule 2",
  "finished/needs_fixtures": "an open stage with no fixtures blocks rule 2",
  // Rule 2 (J2) also refuses `finished` while any fixture is still LIVE
  // (`scheduled` or `in_play`), and all three of these rows require one.
  // An `in_play` fixture IS rule 3's match day, unconditionally and before
  // rules 4 and 5 are reached — so the one row that requires one can only
  // ever sit beside `match_day`.
  "finished/no_scorer": "no_scorer needs an in_play fixture, which is match day",
  "setting_up/no_scorer": "no_scorer needs an in_play fixture, which is match day",
  "scheduled/no_scorer": "no_scorer needs an in_play fixture, which is match day",
  // `not_recording` (round J) needs an in_play fixture for exactly the same
  // reason its complement does — the two differ only on whether a scorer is
  // assigned, never on the fixture status either one requires.
  "finished/not_recording": "not_recording needs an in_play fixture, which is match day",
  "setting_up/not_recording": "not_recording needs an in_play fixture, which is match day",
  "scheduled/not_recording": "not_recording needs an in_play fixture, which is match day",
  "finished/unscheduled": "unscheduled needs a `scheduled` fixture, which is live",
  // Owner ruling 2026-11-26: only a STARTED match owes a result, so this row needs an in_play fixture too — match day.
  "finished/result_missing": "result_missing needs an in_play fixture, which is match day",
  // `needs_draw` is raised for the FIRST open stage (a later one needs
  // `noLive`, and its own generated TBD fixtures are `scheduled`, i.e. live),
  // and a first open stage owing work is exactly rule 4's `setting_up` —
  // unless rule 3 gets there first. So the draw row can only ever sit beside
  // `setting_up` or `match_day`.
  "scheduled/needs_draw": "rule 4 fires whenever the first open stage owes its draw",
  "setting_up/result_missing": "result_missing needs an in_play fixture, which is match day",
  "scheduled/result_missing": "result_missing needs an in_play fixture, which is match day",
  // W2a (addendum 9): a HELD fixture — `needs_decision`, or a recorded abandon awaiting its settle — is live
  // (`isLiveFixture`), so rule 2 refuses `finished` while one exists. That is the whole point of the row.
  "finished/needs_decision": "a held fixture is live, which blocks rule 2",
  // W4 T21: a decided final is a PLAYED match. Rule 1's `setup` division has none; rule 4 needs the lowest open stage to
  // owe work, and the stage whose final is decided owes none (it has fixtures and no draw); rule 6 falls back to
  // `setting_up` only when nothing has been played.
  "setting_up/final_decided": "a decided final is played, and the stage holding it owes no work",
  // W5 T6 fix round 1: the row needs a COMPLETE root table — played matches — and is never raised in a `setup` division.
  // Rule 6's `setting_up` needs nothing played, so a started division reads `setting_up` only by rule 4: an open stage owing
  // work, whose red row leads.
  "setting_up/late_unplaced": "a finished table is played, so setting_up means an open stage owing work, whose red row leads",
  // W5 T8b review I2 (b): an owed withdrawal exists only after Start, over a drawn table. A started division reads setting_up
  // by rule 6 only while nothing is dated or played — and then its undated lines raise `unscheduled`, which leads (KIND_ORDER).
  "setting_up/withdrawal_owed": "after Start a drawn table with nothing dated raises unscheduled, which leads",
  // Match Day online (T4): a held board is a LIVE fixture (`scheduled`/`in_play` - the lister reads no other), and rule 2 refuses
  // `finished` while any fixture is live. A flagged board is the opposite case (a decided board with an open flag IS a finished
  // division's attention), so it is covered below.
  "finished/board_held": "a held board is a live fixture, which blocks rule 2",
  // ...while `setting_up` beside a started division means rule 4's red row or rule 6's undated lines, and `unscheduled` is ordered
  // before `board_flagged` (KIND_ORDER), so the flag row can never be the one that leads there.
  "setting_up/board_flagged": "setting_up means a red row or unscheduled leads, both ahead of board_flagged",
};

type Shape = {
  /** What an organiser did to get here — the state, not the assertion. */
  why: string;
  stages: PhaseStage[];
  fixtures: PhaseFixture[];
  divisionStatus?: PhaseInput["divisionStatus"];
  awaitingRegistrations?: number;
  /** Pending bans in a division whose discipline rules are on (owner-approved 3A). */
  bansToReview?: number;
  /** W4 T11: late players waiting to join a started root knockout, per stage. */
  lateWaiting?: PhaseInput["lateWaiting"];
  /** W5 T6 fix round 1: players who arrived after the root table finished, per stage. */
  lateUnplaced?: PhaseInput["lateUnplaced"];
  /** W5 T8b review I2 (b): entrants owed a withdrawal that did not finish. */
  withdrawalOwed?: PhaseInput["withdrawalOwed"];
  /**
   * Match Day online (T4): the PER-BOARD attentions the desk APPENDS to `resolveAttention`'s list (competition-desk.ts), then sorts
   * the whole with the same `sortAttentions`. They are no function of the division's fixtures (an online hold is a bridge row), so
   * a shape names them; the resolved list is built the way the desk builds it, never by this file's own ordering.
   */
  boardAttention?: Attention[];
  entrants?: number;
};

const NOW = "2026-09-05T09:42:00Z"; // Sat 10:42 Europe/London
const TZ = "Europe/London";
const TODAY = "2026-09-05T14:00:00Z";
const PAST = "2026-09-05T06:00:00Z"; // today, and its window has closed
const QUIET = "2026-09-05T08:42:00Z"; // an hour ago, its window still open
const FUTURE = "2026-09-19T09:00:00Z";

const st = (o: Partial<PhaseStage> = {}): PhaseStage => ({
  id: "s1", name: "League", seq: 1, status: "active", hasFixtures: true,
  timing: null, sourceReady: false, proposal: "none", finalDecided: false, ...o,
});
/** A stage whose TBD bracket is generated and whose sources are complete —
 *  the ONLY state in which the panel's draw door both renders and works. */
const drawableStage = (o: Partial<PhaseStage> = {}) =>
  st({ id: "fin", name: "Finals", seq: 2, status: "active", hasFixtures: true,
       timing: "setup", sourceReady: true, ...o });
const fxt = (o: Partial<PhaseFixture> = {}): PhaseFixture => ({
  id: "f1", status: "decided", scheduledAt: FUTURE, startedAt: null, eventCount: 0, matchMinutes: 90,
  hasScorer: true, stageId: "s1", awaitsSeedDraw: false, awaitsSettle: false, awaitsRoundOpen: false, ...o,
});
const awaitsDraw = (o: Partial<PhaseFixture> = {}) =>
  fxt({ id: "tbd1", stageId: "fin", awaitsSeedDraw: true, status: "scheduled", scheduledAt: null, ...o });

const BOARD_HELD: Attention = {
  kind: "board_held", fixtureId: "a", stageId: "s1", roundNo: 1, boardNo: 1, home: "Alpha", away: "Bravo", reason: "no_show_white", reopen: false,
};
const BOARD_FLAGGED: Attention = { kind: "board_flagged", fixtureId: "a", roundNo: 1, boardNo: 1, home: "Alpha", away: "Bravo", flags: 1 };

const SHAPES: Shape[] = [
  {
    why: "setting_up/needs_draw — league complete, the finals bracket generated and its draw owed",
    stages: [st({ status: "complete" }), drawableStage()],
    fixtures: [fxt({ id: "a" }), awaitsDraw()],
  },
  {
    why: "setting_up/needs_fixtures — league complete, the next stage never generated",
    stages: [st({ status: "complete" }), st({ id: "fin", name: "Finals", seq: 2, hasFixtures: false })],
    fixtures: [fxt({ id: "a" })],
  },
  {
    why: "setting_up/unscheduled — nothing dated yet, nothing played",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: null })],
  },
  {
    why: "setting_up/registrations_waiting — a brand-new division still taking entries",
    stages: [], fixtures: [], divisionStatus: "setup", awaitingRegistrations: 3, entrants: 4,
  },
  {
    why: "setting_up/bans_waiting — a ban recorded by hand before a ball was kicked, not yet reviewed",
    stages: [], fixtures: [], divisionStatus: "setup", bansToReview: 1, entrants: 4,
  },
  {
    why: "setting_up/none — a division created and not yet touched",
    stages: [], fixtures: [], divisionStatus: "setup", entrants: 4,
  },
  {
    why: "scheduled/needs_fixtures — INSTANCE TWELVE's shape: the league is played out but never completed, and the finals bracket was never generated",
    stages: [st(), st({ id: "fin", name: "Finals", seq: 2, hasFixtures: false, timing: "setup", sourceReady: false })],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b" })],
  },
  {
    why: "scheduled/unscheduled — a mid-season league with the next round undated",
    stages: [st()],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b", status: "scheduled", scheduledAt: null })],
  },
  {
    why: "scheduled/registrations_waiting — a running division with late entries to approve",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: FUTURE })],
    awaitingRegistrations: 2,
  },
  {
    why: "scheduled/bans_waiting — a red card last week, the next round dated, the ban not yet reviewed",
    stages: [st()],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b", status: "scheduled", scheduledAt: FUTURE })],
    bansToReview: 1,
  },
  {
    why: "scheduled/none — a settled, dated season",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: FUTURE })],
  },
  {
    why: "match_day/needs_draw — today's last group match is dated and the finals draw is owed",
    stages: [st({ status: "complete" }), drawableStage()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: TODAY }), awaitsDraw()],
  },
  {
    why: "match_day/needs_fixtures — today's match is dated and the next stage is empty",
    stages: [st({ status: "complete" }), st({ id: "fin", name: "Finals", seq: 2, hasFixtures: false })],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: TODAY })],
  },
  {
    why: "match_day/no_scorer — kicked off, nothing being recorded",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: false, scheduledAt: PAST })],
  },
  {
    // The complement of the row above: a scorer IS assigned, and nothing has
    // arrived from them. `QUIET` is an hour before NOW: well past the grace and
    // well inside the 90-minute window (past it the match is owed a result
    // instead), so the shape sits on neither boundary.
    why: "match_day/not_recording — kicked off with a scorer assigned, still nothing recorded",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true, eventCount: 0, scheduledAt: QUIET })],
  },
  {
    why: "match_day/unscheduled — playing today, later rounds undated",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true }),
               fxt({ id: "b", status: "scheduled", scheduledAt: null })],
  },
  {
    why: "match_day/result_missing — this morning's match started and still has no result",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", scheduledAt: PAST })],
  },
  {
    why: "match_day/registrations_waiting — playing today with entries pending",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true })],
    awaitingRegistrations: 1,
  },
  {
    why: "match_day/bans_waiting — playing today with two bans from the last round still unreviewed",
    stages: [st()],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b", status: "in_play", hasScorer: true })],
    bansToReview: 2,
  },
  {
    why: "match_day/none — playing today, everything in hand",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true })],
  },
  // W2a (addendum 9): a held bracket fixture, in each phase it can sit beside. Both held shapes are used: the level
  // result (`needs_decision`) and the recorded abandon awaiting its settle (stored `abandoned`, `awaitsSettle`).
  // Fix round 1 (ruling D-H2): a held fixture counts as PLAYED, so a level final alone in its division is in progress
  // (`scheduled`), and `setting_up` beside a held fixture is reached only through rule 4 — an earlier open stage that
  // still owes its fixtures. That stage raises a red `needs_fixtures` (ordered before `needs_decision`) in every
  // division status but `setup`, whose gate keeps it quiet — so the held row leads only there.
  {
    why: "scheduled/needs_decision — a two-entrant final ended level and nothing else has been played (D-H2)",
    stages: [st({ id: "ko", name: "Final" })],
    fixtures: [fxt({ id: "a", stageId: "ko", status: "needs_decision", scheduledAt: null })],
  },
  {
    why: "setting_up/needs_decision — a setup division: an earlier stage still owes its fixtures while a later stage's match ended level",
    stages: [st({ id: "pl", name: "Plate", seq: 1, status: "pending", hasFixtures: false }), st({ id: "ko", name: "Final", seq: 2 })],
    fixtures: [fxt({ id: "a", stageId: "ko", status: "needs_decision", scheduledAt: null })],
    divisionStatus: "setup",
  },
  {
    why: "scheduled/needs_decision — a semi-final abandoned with nobody decided, the other semi played, the final dated",
    stages: [st({ id: "ko", name: "Knockout" })],
    fixtures: [fxt({ id: "a", stageId: "ko" }),
               fxt({ id: "b", stageId: "ko", status: "abandoned", awaitsSettle: true, scheduledAt: null }),
               fxt({ id: "c", stageId: "ko", status: "scheduled", scheduledAt: FUTURE })],
  },
  {
    why: "match_day/needs_decision — one quarter-final ended level while another is being played",
    stages: [st({ id: "ko", name: "Knockout" })],
    fixtures: [fxt({ id: "a", stageId: "ko", status: "needs_decision", scheduledAt: null }),
               fxt({ id: "b", stageId: "ko", status: "in_play", hasScorer: true })],
  },
  // W4 T21 (AN-1, X-CH-8): the main draw's final decided, its stage never completed (auto-advance off). Alone it reads
  // Finished — the AN-1 desk; beside a Plate still being played or dated it reads match day or scheduled.
  {
    why: "finished/final_decided — AN-1: every match of the knockout decided, the stage never completed",
    stages: [st({ id: "ko", name: "Knockout", finalDecided: true })],
    fixtures: [fxt({ id: "a", stageId: "ko" }), fxt({ id: "b", stageId: "ko" }), fxt({ id: "c", stageId: "ko" })],
  },
  {
    why: "match_day/final_decided — the main draw decided and never completed, its Plate being played",
    stages: [st({ id: "ko", name: "Knockout", finalDecided: true }), st({ id: "pl", name: "Plate", seq: 2 })],
    fixtures: [fxt({ id: "a", stageId: "ko" }), fxt({ id: "b", stageId: "pl", status: "in_play", hasScorer: true })],
  },
  {
    why: "scheduled/final_decided — the main draw decided and never completed, its Plate final dated",
    stages: [st({ id: "ko", name: "Knockout", finalDecided: true }), st({ id: "pl", name: "Plate", seq: 2 })],
    fixtures: [fxt({ id: "a", stageId: "ko" }), fxt({ id: "b", stageId: "pl", status: "scheduled", scheduledAt: FUTURE })],
  },
  {
    why: "finished/registrations_waiting — the season is over and an entry was never dealt with",
    stages: [st({ status: "complete" })],
    fixtures: [fxt({ id: "a" })],
    divisionStatus: "completed", awaitingRegistrations: 1,
  },
  {
    why: "finished/bans_waiting — a red card in the last match of the season, its ban never reviewed",
    stages: [st({ status: "complete" })],
    fixtures: [fxt({ id: "a" })],
    divisionStatus: "completed", bansToReview: 1,
  },
  // W4 T11 (X-LE-10): a paid player waiting to join a started knockout's bracket, in each phase the row can lead.
  {
    why: "scheduled/late_players_waiting — a knockout under way, the next round dated, a paid player not yet in the bracket",
    stages: [st({ id: "ko", name: "Cup" })],
    fixtures: [fxt({ id: "a", stageId: "ko" }), fxt({ id: "b", stageId: "ko", status: "scheduled", scheduledAt: FUTURE })],
    lateWaiting: [{ stageName: "Cup", count: 1 }],
  },
  {
    why: "match_day/late_players_waiting — round 1 being played today, two late arrivals waiting",
    stages: [st({ id: "ko", name: "Cup" })],
    fixtures: [fxt({ id: "a", stageId: "ko", status: "in_play", hasScorer: true })],
    lateWaiting: [{ stageName: "Cup", count: 2 }],
  },
  {
    why: "finished/late_players_waiting — every bracket match played, the stage not completed, a reinstated player still waiting",
    stages: [st({ id: "ko", name: "Cup" })],
    fixtures: [fxt({ id: "a", stageId: "ko" })],
    lateWaiting: [{ stageName: "Cup", count: 1 }],
  },
  // W5 T6 fix round 1 (X-CU-8): a paid player confirmed after the root league finished — in the field, in none of its fixtures.
  {
    why: "finished/late_unplaced — the league played out and completed, a registration confirmed afterwards",
    stages: [st({ status: "complete" })],
    fixtures: [fxt({ id: "a" })],
    lateUnplaced: [{ stageName: "League", names: ["Lou Late"] }],
  },
  {
    why: "scheduled/late_unplaced — the league finished, the knockout after it dated, a late arrival not in the league",
    stages: [st({ status: "complete" }), st({ id: "ko", name: "Cup", seq: 2 })],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b", stageId: "ko", status: "scheduled", scheduledAt: FUTURE })],
    lateUnplaced: [{ stageName: "League", names: ["Lou Late"] }],
  },
  {
    why: "match_day/late_unplaced — the league finished, the knockout being played today, a late arrival not in the league",
    stages: [st({ status: "complete" }), st({ id: "ko", name: "Cup", seq: 2 })],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b", stageId: "ko", status: "in_play", hasScorer: true })],
    lateUnplaced: [{ stageName: "League", names: ["Lou Late"] }],
  },
  // W5 T8b review I2 (b): a player's own withdrawal (or an in-match DQ) whose cascade failed — still in the field.
  {
    why: "scheduled/withdrawal_owed — a dated league; a player withdrew after Start and the cascade failed",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: FUTURE })],
    withdrawalOwed: ["Rae Registrant"],
  },
  {
    why: "match_day/withdrawal_owed — the league being played today; a disqualification's cascade failed",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true })],
    withdrawalOwed: ["Rae Registrant"],
  },
  {
    why: "finished/withdrawal_owed — every league match played; the last one's disqualification did not finish its withdrawal",
    stages: [st({ status: "complete" })],
    fixtures: [fxt({ id: "a" })],
    withdrawalOwed: ["Rae Registrant"],
  },
  // Match Day online (T4): the two per-board kinds, in each phase they can lead. The held board is red, so it outranks the phase and
  // every amber; the flagged one is amber and leads only where nothing red and no earlier amber stands before it.
  {
    why: "setting_up/board_held — an online round opened and its boards still undated, one held on a link",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: null })],
    boardAttention: [BOARD_HELD],
  },
  {
    why: "scheduled/board_held — an online round dated for next week, one board already held",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "scheduled", scheduledAt: FUTURE })],
    boardAttention: [BOARD_HELD],
  },
  {
    why: "match_day/board_held — online boards being played today, one held",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true }), fxt({ id: "b", status: "scheduled", scheduledAt: TODAY })],
    boardAttention: [BOARD_HELD],
  },
  {
    why: "scheduled/board_flagged — a dated online round; the previous one carries a camera report",
    stages: [st()],
    fixtures: [fxt({ id: "a" }), fxt({ id: "b", status: "scheduled", scheduledAt: FUTURE })],
    boardAttention: [BOARD_FLAGGED],
  },
  {
    why: "match_day/board_flagged — online boards being played today, one with a camera report",
    stages: [st()],
    fixtures: [fxt({ id: "a", status: "in_play", hasScorer: true })],
    boardAttention: [BOARD_FLAGGED],
  },
  {
    why: "finished/board_flagged — every board decided and one still carries a camera report to review",
    stages: [st({ status: "complete" })],
    fixtures: [fxt({ id: "a" })],
    divisionStatus: "completed",
    boardAttention: [BOARD_FLAGGED],
  },
  {
    why: "finished/none — a completed season",
    stages: [st({ status: "complete" })],
    fixtures: [fxt({ id: "a" })],
    divisionStatus: "completed",
  },
];

// card-stats.ts's PLAYED, mirrored (it is what the desk's "N of M played" counts) — with D-H2's held level result.
const PLAYED = new Set(["decided", "finalized", "needs_decision"]);

function resolve(shape: Shape) {
  const input: PhaseInput = {
    divisionStatus: shape.divisionStatus ?? "active",
    stages: shape.stages, fixtures: shape.fixtures, now: NOW, tz: TZ,
    awaitingRegistrations: shape.awaitingRegistrations ?? 0,
    bansToReview: shape.bansToReview ?? 0,
    lateWaiting: shape.lateWaiting ?? [],
    lateUnplaced: shape.lateUnplaced ?? [],
    withdrawalOwed: shape.withdrawalOwed ?? [],
  };
  const phase = resolvePhase(input);
  const attention = sortAttentions([...resolveAttention(input), ...(shape.boardAttention ?? [])]);
  const leading: Leading = attention[0]?.kind ?? "none";
  const played = shape.fixtures.filter((f) => PLAYED.has(f.status)).length;
  const needsDraw = attention.find((a) => a.kind === "needs_draw");
  const desk: DeskDivision = {
    phase, attention,
    played, total: shape.fixtures.length,
    unscheduled: shape.fixtures.filter((f) => f.status === "scheduled" && f.scheduledAt === null).length,
    in_play: shape.fixtures.filter((f) => f.status === "in_play").length,
    entrants: shape.entrants ?? 6,
    next: null,
    needs_draw_stage: needsDraw && needsDraw.kind === "needs_draw" ? { name: needsDraw.stageName } : null,
    fixture_names: Object.fromEntries(shape.fixtures.map((f, i) => [f.id, { home: "Alpha", away: "Bravo", fixture_no: i + 1 }])),
    display_tz: TZ,
  };
  return { input, phase, attention, leading, desk, played };
}

describe("enumeration 2: the four renderings agree on every reachable phase/attention pair", () => {
  const resolved = SHAPES.map((s) => ({ shape: s, ...resolve(s) }));

  it("the table covers exactly the reachable cross product — a dropped row leaves a pair uncovered", () => {
    const required = DIVISION_PHASES.flatMap((p) => LEADING.map((l) => `${p}/${l}`))
      .filter((pair) => !(pair in UNREACHABLE))
      .sort();
    const covered = [...new Set(resolved.map((r) => `${r.phase}/${r.leading}`))].sort();
    expect(covered).toEqual(required);
    // And every declared exclusion still names a pair in the domain, so a
    // renamed phase or kind cannot leave a stale excuse behind.
    for (const pair of Object.keys(UNREACHABLE)) {
      const [p, l] = pair.split("/") as [DivisionPhase, Leading];
      expect(DIVISION_PHASES as readonly string[]).toContain(p);
      expect(LEADING as readonly string[]).toContain(l);
    }
  });

  it("each shape reaches the pair its own `why` claims — a shape cannot drift off its case", () => {
    for (const r of resolved) {
      // The `why` string LEADS with the pair it claims, so a shape that
      // drifts onto another case is caught by its own label rather than
      // quietly covering a pair it was not written for.
      expect(`${r.phase}/${r.leading}`, r.shape.why).toBe(r.shape.why.split(" ")[0]);
    }
  });

// Review finding m8: `competition-desk.ts` documents (and
// `competition-desk.test.ts` pins) `in_play === in_play_fixtures.length`
// ALWAYS. These fixtures used to pair a non-zero `in_play` with an empty
// `in_play_fixtures`, which no consumer in these two files reads today but
// which is an impossible desk — the next consumer that trusts the documented
// invariant would be exercised against a shape the producer cannot emit. The
// list is now derived FROM the count, so the two can never drift apart here.
const inPlayFixtures = (n: number, divisionId = "d1"): DeskInPlayFixture[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `ip${i + 1}`,
    division_id: divisionId,
    division_name: "Premier Division",
    home: "Alpha",
    away: "Bravo",
    fixture_no: i + 1,
    event_count: 0,
    headline: null,
    started_at: null,
  }));

  describe.each(resolved.map((r) => [r.shape.why, r] as const))("%s", (_why, r) => {
    const red = r.attention.find((a) => ATTENTION_SEVERITY[a.kind] === "red");

    it("1+2: the masthead and the row pill never say a division is setting up when it has played", () => {
      const rowPill = renderToStaticMarkup(
        <PhasePill dict={en} phase={r.phase} inPlay={r.desk.in_play} attention={r.attention} />,
      );
      // Task 6: this file's cases don't exercise the band itself — but the
      // fixture list is DERIVED from the count (see `inPlayFixtures`), never
      // an empty array beside a non-zero one (review m8).
      const desk: CompetitionDesk = {
        in_play: r.desk.in_play, in_play_fixtures: inPlayFixtures(r.desk.in_play), up_next: null, fixtures_today: 0,
        divisions: new Map([["d1", r.desk]]), now: NOW,
      };
      const cp = competitionPhase(desk);
      // Review 7, Minor 9: this rendered the masthead with `attention={[]}`,
      // so the file written to make the renderings AGREE did not exercise the
      // masthead's own attention wiring at all and could not see a regression
      // in it. It mirrors the page now — the phase pill, plus the separate
      // attention chip beside it (page.tsx).
      const leading = leadingAttention([r.desk]);
      const masthead = renderToStaticMarkup(
        <>
          <PhasePill dict={en} phase={cp.kind === "in_play" ? "in_play" : cp.kind === "next" ? "next" : cp.kind}
            inPlay={cp.kind === "in_play" ? cp.n : 0} when="Sat 12 Sep" />
          <AttentionChip dict={en} attention={leading} />
        </>,
      );
      if (r.played > 0) {
        expect(rowPill).not.toContain(en["desk.phase.setting_up"]);
        expect(masthead).not.toContain(en["desk.phase.setting_up"]);
      }
      // A red attention outranks the phase on the row pill — the model rule,
      // asserted here for EVERY pair rather than for the one kind a fix
      // happened to be about.
      // And the masthead names the SAME red kind — the F4 rule, swept over
      // every reachable pair rather than proven on the one shape a test
      // happened to build. It keeps the phase BESIDE it (review 7, Minor 7):
      // a red attention must never delete the live count.
      if (red) {
        expect(rowPill).toContain(`data-pill="${red.kind}"`);
        expect(masthead).toContain(`data-attention-chip="${red.kind}"`);
        if (cp.kind === "in_play") expect(masthead).toContain(en["desk.phase.in_play"].replace("{n}", String(cp.n)));
      } else {
        expect(rowPill).toContain(`data-pill="${r.phase}"`);
        expect(masthead).not.toContain("data-attention-chip");
      }
    });

    it("3: the status line agrees with the pill — it never claims setting-up progress a played row contradicts", () => {
      const line = statusLine(en, {
        phase: r.phase, played: r.played, total: r.desk.total, unscheduled: r.desk.unscheduled,
        inPlay: r.desk.in_play, entrants: r.desk.entrants, next: null,
        needsDrawStageName: r.desk.needs_draw_stage?.name ?? null,
        finalDecidedStageName: finalDecidedStageName(r.desk.attention),
        locale: "en", displayTz: TZ, now: NOW,
      });
      if (r.played > 0 || r.desk.total > 0) expect(line).not.toContain("entrants");
      // M1 minor: whenever a draw is owed and nothing is being played, the
      // sentence NAMES the stage — it used to do that only under the
      // `setting_up` word.
      if (r.desk.needs_draw_stage && r.desk.in_play === 0) {
        expect(line).toContain(`${r.desk.needs_draw_stage.name} not drawn`);
      }
      // W4 T21 M2: a decided final whose stage is still open never reads "complete" beside its red pill.
      const decided = finalDecidedStageName(r.desk.attention);
      if (decided !== null && !r.desk.needs_draw_stage && r.desk.in_play === 0) {
        expect(line).toContain(`${decided} not completed`);
        expect(line).not.toContain("· complete");
      }
    });

    it("4: a red attention always has a Needs-you row of the same kind, with an action", () => {
      const items = needsYouItems(
        en,
        { in_play: r.desk.in_play, in_play_fixtures: inPlayFixtures(r.desk.in_play), up_next: null, fixtures_today: 0, divisions: new Map([["d1", r.desk]]), now: NOW },
        [{ id: "d1", name: "Premier", slug: "premier" }], "org", "comp", "en",
      );
      // registrations_waiting is aggregated to ONE competition-level row, so
      // it is keyed differently by design; every other kind is per division.
      for (const a of r.attention) {
        const item = items.find((i) => i.kind === a.kind);
        expect(item, `${a.kind} has no Needs-you row`).toBeDefined();
        expect(item?.action.label.length, `${a.kind} action label is empty`).toBeGreaterThan(0);
        expect(item?.action.href.startsWith("/o/org/c/comp"), `${a.kind} href`).toBe(true);
      }
      if (red) expect(items[0]?.kind).toBe(red.kind);
    });
  });
});

/**
 * M1 (fix round I): the `needs_draw` row's action must name a button the
 * PANEL IS ACTUALLY SHOWING — the whole reason the label renders the panel's
 * own dictionary key instead of a copy of its words.
 *
 * Not a tautology: the expected string is not read from `DRAW_DOOR_KEY` but
 * extracted from a REAL `ProgressionPanel` rendered in the matching state, so
 * it dies if either side moves — the map, the panel's copy, or the panel's
 * branch structure. Mutating `DRAW_DOOR_KEY.confirm` to `computeCta` left the
 * whole 256-test desk suite green before this existed.
 */
const PANEL_QUALIFIERS = {
  qualifiers: [
    { rank: 1, source: { stageId: "grp", group: "A", rank: 1 }, entrantId: "e1", destinationSlot: "f1:home" },
    { rank: 2, source: { stageId: "grp", group: "B", rank: 1 }, entrantId: "e2", destinationSlot: "f1:away" },
  ],
  ties: [],
  standingsHash: "h1",
};
const PANEL_PROPOSAL: Record<DrawDoor, SeedProposal | null> = {
  compute: null,
  confirm: { id: "p1", stageId: "ko1", status: "draft", computed: PANEL_QUALIFIERS },
  recompute: { id: "p1", stageId: "ko1", status: "stale", computed: PANEL_QUALIFIERS },
};

describe("the needs_draw action names a button the seed-proposal panel is showing", () => {
  it.each(DRAW_DOORS)("%s", (door) => {
    const desk: DeskDivision = {
      phase: "setting_up", attention: [{ kind: "needs_draw", stageName: "Finals", door }],
      played: 6, total: 6, unscheduled: 0, in_play: 0, entrants: 4, next: null,
      needs_draw_stage: { name: "Finals" }, fixture_names: {}, display_tz: TZ,
    };
    const items = needsYouItems(
      en,
      { in_play: 0, in_play_fixtures: [], up_next: null, fixtures_today: 0, divisions: new Map([["d1", desk]]), now: NOW },
      [{ id: "d1", name: "Premier", slug: "premier" }], "org", "comp", "en",
    );
    const label = items.find((i) => i.kind === "needs_draw")?.action.label;
    expect(label, `no needs_draw row for the ${door} door`).toBeTruthy();

    const html = renderToStaticMarkup(
      <ProgressionPanel stageId="ko1" stageName="Finals" proposal={PANEL_PROPOSAL[door]} sourceReady
        fixtures={[{ id: "f1", home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
                     away_slot_label: { key: "slot.winner_group", params: { g: "B" } } }]}
        entrantNames={{ e1: "Alice", e2: "Bob" }} stageNames={{ grp: "Groups" }} departedEntrantIds={[]}
        confirmedDrawReopens={false} locale="en" canEdit />,
    );
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => m[1]!.replace(/<[^>]*>/g, "").trim())
      .filter(Boolean);
    expect(buttons.length, `the ${door} panel state renders no button at all`).toBeGreaterThan(0);
    expect(buttons, `the desk offers "${label}" but the panel's ${door} state shows ${JSON.stringify(buttons)}`)
      .toContain(label);
  });
});
