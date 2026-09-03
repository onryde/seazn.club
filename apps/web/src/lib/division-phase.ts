// Competition Desk (spec 2026-09-02 §"The shared model"): a division's phase is
// DERIVED from stage + fixture + status facts, never stored. Pure so the same
// answer renders on server and client and the matrix is unit-testable.

export type DivisionStatus = "setup" | "scheduled" | "active" | "completed";
/** Every phase, as a VALUE, so an enumeration test can cross-product over
 *  the domain instead of hand-typing it — add one here and the five-rendering
 *  agreement sweep (`desk-renderings-agree.test.tsx`) fails until the new
 *  phase is either covered or declared unreachable with a reason. */
export const DIVISION_PHASES = ["setting_up", "scheduled", "match_day", "finished"] as const;
export type DivisionPhase = (typeof DIVISION_PHASES)[number];

/** The latest `stage_seed_proposals` row's status for a stage, mirroring
 *  `getSeedProposal` (stages.ts — "latest by created_at desc, id desc, ANY
 *  status"), with `"none"` for a stage that has never had one.
 *
 *  M1 (fix round I, Critical — instance TWELVE). Read for exactly ONE thing:
 *  WHICH control the seed-proposal panel is currently showing, so the
 *  `needs_draw` row's action can name it instead of guessing. It is never
 *  read by `resolvePhase` — pinned by a test — because the phase must be the
 *  same for every viewer and a proposal read is organiser-only. */
export type SeedProposalState = "none" | "draft" | "stale" | "confirmed";

export interface PhaseStage {
  id: string;
  name: string;
  seq: number;
  status: string; // pending | active | complete
  hasFixtures: boolean;
  /** `progression ->> 'timing'` — `"setup"` is the propose/confirm draw,
   *  `"on_complete"` is auto-seeding, `null` is a stage with no progression
   *  at all (its fixtures are generated, never seeded). */
  timing: string | null;
  /** `seedingSourceReady` (lib/seeding-source-ready.ts) — every source stage
   *  this one draws standings from has status `complete`. Resolved by the
   *  caller from the same in-memory stage list, so this module stays pure. */
  sourceReady: boolean;
  /** @see SeedProposalState — the action LABEL only, never the phase. */
  proposal: SeedProposalState;
}

export interface PhaseFixture {
  id: string;
  status: string; // scheduled | in_play | decided | finalized | abandoned | forfeited | cancelled
  scheduledAt: string | null;
  /** When the fixture was actually KICKED OFF — `core.start`'s own
   *  `recorded_at` (competition-desk.ts). Review 7 (Minor 8b): `fixtures` has
   *  no kick-off column at all, so "Kicked off N min ago" used to be measured
   *  from `scheduledAt`, a PLAN. For a match starting 90 minutes late — an
   *  ordinary venue event — that fired the row the instant it went live,
   *  reading "Kicked off 90 min ago", with the grace period worth nothing.
   *  `null` for anything not in play; a fixture cannot BE in play without a
   *  `core.start`, so for the rows that read this it is always present. */
  startedAt: string | null;
  /** How many events have arrived SINCE the kick-off — `core.start` itself is
   *  excluded (competition-desk.ts). Counting it made `eventCount === 0`
   *  unreachable and both live-recording rows inert: review 7, Blocker 1. */
  eventCount: number;
  matchMinutes: number;
  /** F4 fix (final review, Important): does ANY scorer_assignment cover this
   *  fixture — fixture-scoped OR division-scoped (competition-desk.ts reads
   *  both; competition-scoped assignments are deliberately not checked here,
   *  per the finding's own wording). Resolved by the caller so this module
   *  stays pure and DB-free. */
  hasScorer: boolean;
  /** Which stage this fixture belongs to. M1 (fix round I): "has this
   *  bracket been drawn yet?" is a question about a STAGE answered by ITS
   *  fixtures, so the two have to be relatable here. */
  stageId: string;
  /** Either side still unfilled — a generated bracket slot waiting on the
   *  draw. This is the DRAWN/NOT-DRAWN fact, deliberately derived from the
   *  entrants on the fixtures themselves rather than from a proposal row:
   *  it is pure, identical for every viewer, and it is what the organiser
   *  actually sees on the fixtures tab ("TBD v TBD"). */
  tbd: boolean;
}

export interface PhaseInput {
  divisionStatus: DivisionStatus;
  stages: PhaseStage[];
  fixtures: PhaseFixture[];
  /** ISO instant "now". Injected so tests and SSR agree. */
  now: string;
  /** H1 fix (final review round 3, Critical — corrected ruling, again): a
   *  fixture's DAY is its VENUE's day, for both bucketing (`localDateKey`
   *  below) and printing (division-status-line.ts's `whenLabel`) — ONE zone
   *  per fixture, everywhere. Callers pass `resolveVenueTz(divisionTz,
   *  orgTz)` here (the division's own schedule_settings.tz override, falling
   *  back to the org's timezone only when the division has none) — never the
   *  bare org zone. Getting this backwards was the bug: bucketing in the org
   *  zone while every printed label already used the venue zone put a
   *  "Match day" pill beside a date reading tomorrow, and hid match day
   *  entirely for a division whose venue was ahead of its org. */
  tz: string;
  awaitingRegistrations: number;
}

/** WHICH control the seed-proposal panel is showing for a stage that owes
 *  its draw — `progression-panel.tsx`'s four branches, one for one:
 *  no proposal ⇒ "Compute proposal", a draft ⇒ "Confirm proposal", a stale
 *  one ⇒ "Recompute". The `needs_draw` row's action carries this so it can
 *  render the panel's OWN dictionary key instead of a hand-copied name — the
 *  label and the button it points at then cannot drift apart. */
export const DRAW_DOORS = ["compute", "confirm", "recompute"] as const;
export type DrawDoor = (typeof DRAW_DOORS)[number];

/** `SeedProposalState` -> the door the panel offers for it. A `Record`, not a
 *  ternary, so adding a proposal status is a COMPILE error rather than a
 *  silently mislabelled action (phase-pill.tsx's `RED_PILL_KEY` precedent).
 *  `confirmed` maps to `compute` and is unreachable in a `needs_draw` row:
 *  confirming FILLS every slot, so no fixture of that stage is `tbd` any
 *  more and `stageOwesDraw` below is false. */
const DOOR_FOR_PROPOSAL: Record<SeedProposalState, DrawDoor> = {
  none: "compute",
  draft: "confirm",
  stale: "recompute",
  confirmed: "compute",
};

export type Attention =
  // M1 (fix round I): `stageId` used to ride along here and reached exactly
  // one consumer, `competition-desk.ts`'s `needs_draw_stage.id`, which
  // nothing read either — deleted with it, same class as the `org_tz` and
  // `court_label` deletions this wave already made.
  | { kind: "needs_draw"; stageName: string; door: DrawDoor }
  // K1 fix (fix round G, Critical — instance NINE). `needs_draw`'s sibling,
  // for a stage that has nothing to play and no PROPOSAL to compute: an
  // `on_complete` stage waiting to be seeded by the stage before it, or a
  // stage whose fixtures were never generated at all. It is deliberately NOT
  // `needs_draw`: the "Compute proposal" panel that row points at is hidden
  // for a non-`setup` stage AND, per M1 (fix round I), refuses to compute
  // anything at all until the stage's TBD fixtures exist — so re-using that
  // row would send an organiser to a control that is either absent or dead.
  // Both of THIS row's real doors — "Complete stage" on the stage before it,
  // and "Generate fixtures" — live on the division's fixtures tab, which is
  // where its action goes; both were counted on that screen at 11:39Z on
  // 2026-09-03 and are pinned by the action-label sweep
  // (`competition-desk-actions.spec.ts`).
  | { kind: "needs_fixtures"; stageName: string }
  | { kind: "unscheduled"; count: number }
  // F3 fix (final review, Important): used to be one row PER FIXTURE — a
  // division with 6 overdue fixtures produced 6 identical "Needs you" rows.
  // Aggregated per division now, the same way `unscheduled` already was;
  // `fixtureIds` rides along so the caller can still deep-link straight to
  // the one fixture when there's only one. `minutesSinceKickoff` is the
  // WORST (longest-overdue) fixture in the group — the most urgent fact —
  // and is `null` when every one of them has no `scheduledAt` at all (never
  // a permanent, misleading "0 min ago").
  | { kind: "no_scorer"; count: number; fixtureIds: string[]; minutesSinceKickoff: number | null }
  // F3 (round J): `no_scorer`'s twin, and the other half of the question that
  // one deliberately left open (fix-round-b-report.md: "an assigned-but-silent
  // scorer well past kick-off gets NO attention at all in this round"). Same
  // aggregate shape, and `minutesSinceKickoff` is never null here — the row
  // cannot exist without a known elapsed time (see NOT_RECORDING_GRACE_MINUTES).
  | { kind: "not_recording"; count: number; fixtureIds: string[]; minutesSinceKickoff: number }
  | { kind: "result_missing"; count: number; fixtureIds: string[] }
  | { kind: "registrations_waiting"; count: number };

export type Severity = "red" | "amber" | "slate";

/** Severity is a property of the KIND, fixed here, never chosen at a call site. */
export const ATTENTION_SEVERITY: Record<Attention["kind"], Severity> = {
  needs_draw: "red",
  // Red for the same reason `needs_draw` is: an entire stage cannot be played
  // until the organiser acts, and nothing else on the page says so. The
  // finding that produced this row watched a whole knockout sit unseeded
  // behind a "Finished" pill.
  needs_fixtures: "red",
  no_scorer: "red",
  // AMBER, not red, and the grace period is why. `no_scorer` is red because
  // nobody is even nominated: the organiser must act or the match goes
  // unrecorded. Here someone IS nominated and simply has not started —
  // overwhelmingly a slow start rather than an abandonment, and a red on
  // every slow start would teach organisers to ignore the colour that
  // `no_scorer` needs them to trust.
  not_recording: "amber",
  unscheduled: "amber",
  result_missing: "amber",
  registrations_waiting: "slate",
};

/**
 * Ledger order: RED FIRST, then phase. L3 (fix round H, Important).
 *
 * "A red attention OUTRANKS the phase" is a MODEL rule (design of record,
 * §"The shared model"), not a page detail — the pill already obeys it
 * (phase-pill.tsx) — so the ledger's expression of it lives here, beside
 * `ATTENTION_SEVERITY`, the single authority for which kinds are red. It used
 * to sit inline in `o/[orgSlug]/c/[compSlug]/page.tsx`, an async server
 * component vitest cannot reach: deleting the red clause left 147/147 green
 * and no e2e asserted row order either, so the ordering had no test at ANY
 * layer. `competition-desk.spec.ts` now asserts the rendered ROW ORDER on top
 * of this, and `division-phase.test.ts` mutates the rule itself.
 *
 * `null` (getCompetitionDesk failed for this row — the row still renders from
 * card stats alone) sorts LAST: a row we know nothing about must never be
 * ranked above one we do.
 */
const LEDGER_PHASE_RANK: Record<DivisionPhase, number> = {
  match_day: 0,
  scheduled: 1,
  setting_up: 2,
  finished: 3,
};

/**
 * F4 (round J): the ONE attention a competition-level pill should show, or
 * `null`.
 *
 * The division rows put a red attention on their pill and the masthead showed
 * only the phase, so a competition whose divisions were collectively blocked
 * read calm at the top of its own page — the same "two screens, each correct,
 * contradicting each other" shape this wave keeps producing.
 *
 * It picks, never summarises: the highest severity wins, ties inside a band
 * broken by `KIND_ORDER`, and the winner is handed to the SAME `PhasePill`
 * the rows use so it prints the same words. Deliberately no invented
 * "several things need you" copy and no count — a second authority for one
 * displayed fact is exactly what produced this wave's worst defects, and a
 * competition-level number would be one.
 *
 * Lives here rather than inline in the page for the reason `ledgerRank`
 * does: the page is an async server component that node-env vitest cannot
 * reach, so a rule written there has no unit test at any layer.
 */
export function leadingAttention(
  desks: Iterable<{ attention: readonly Attention[] } | null>,
): Attention | null {
  let best: Attention | null = null;
  for (const d of desks) {
    if (!d) continue;
    for (const a of d.attention) {
      if (best === null || attentionRank(a) < attentionRank(best)) best = a;
    }
  }
  return best;
}

function attentionRank(a: Attention): number {
  return SEVERITY_ORDER.indexOf(ATTENTION_SEVERITY[a.kind]) * 100 + KIND_ORDER.indexOf(a.kind);
}

export function ledgerRank(desk: { phase: DivisionPhase; attention: readonly Attention[] } | null): number {
  if (!desk) return 9;
  if (desk.attention.some((a) => ATTENTION_SEVERITY[a.kind] === "red")) return -1;
  return LEDGER_PHASE_RANK[desk.phase];
}

const KIND_ORDER: Attention["kind"][] = [
  "needs_draw",
  "needs_fixtures",
  "no_scorer",
  // Directly after `no_scorer`, and the position is the MEANING, not a
  // formatting choice: the two describe the same failure — a live match going
  // unrecorded — at two different distances from the organiser's hand. Read
  // in order they are one escalation ("nobody is assigned" / "someone is, and
  // nothing is arriving"); split apart by an unrelated kind they read as two
  // unrelated problems. Ties inside a severity band are broken by this array,
  // so moving this line changes what an organiser sees first.
  "not_recording",
  "unscheduled",
  "result_missing",
  "registrations_waiting",
];
const SEVERITY_ORDER: Severity[] = ["red", "amber", "slate"];

/**
 * How long a live match may show no recorded events before `not_recording`
 * is raised, in minutes.
 *
 * The grace is the whole difference between a useful row and a nag: a scorer
 * who has not typed anything in the first minutes of a match is normal (the
 * toss, the walk-out, a pad that is open but not yet tapped), and a row that
 * fires there would appear on almost every fixture at kick-off. Fifteen
 * minutes into a live match with nothing recorded is not a slow start.
 *
 * Exported so tests derive their boundary from the constant instead of
 * typing `15` — a table typed into a test asserts yesterday's number the
 * moment this one moves (recurring failure class 19).
 */
export const NOT_RECORDING_GRACE_MINUTES = 15;

/** YYYY-MM-DD of an instant in a zone. en-CA gives ISO order natively. */
export function localDateKey(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return ""; // never "today"; mirrors resolveAttention's silent NaN
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

const LIVE = new Set(["scheduled", "in_play"]);
/** card-stats.ts's own PLAYED set ("a result exists"), mirrored here so a
 *  purely-derived phase check agrees with what the desk's own played/total
 *  count shows — never abandoned/forfeited/cancelled, which are terminal but
 *  not a played result. */
const PLAYED_STATUSES = new Set(["decided", "finalized"]);

/**
 * "Has anything actually been played?" — the PROGRESS question, which is the
 * one to ask wherever a consumer would otherwise read the WORD `setting_up`
 * as "nothing has happened yet".
 *
 * L1 (fix round H, Critical — instance ELEVEN): `setting_up` does NOT mean
 * that. `resolvePhase`'s rule 4 returns it for a division whose whole league
 * is played and complete while a LATER stage still owes its fixtures, so the
 * word survives an entire season. Three consumers have now had to learn this
 * separately — the pill (a red attention outranks the phase,
 * phase-pill.tsx), the masthead (`competitionPhase`'s `nothingHasHappened`,
 * competition-desk.ts) and the fixtures tab's start-locks tip
 * (stages-panel.tsx) — and the third was still asking the phase word alone
 * after the first two were fixed. The predicate lives here, once, rather than
 * being written out a fourth time: a hand-copied predicate is a recorded
 * drift class in this wave (see `stageOwesDraw`, K3/M1).
 *
 * Derived from the SAME `PLAYED_STATUSES` set the desk's own played/total
 * count comes from, so an answer here can never disagree with the number the
 * row beside it already shows.
 */
export function hasPlayedFixture(fixtures: readonly { status: string }[]): boolean {
  return fixtures.some((f) => PLAYED_STATUSES.has(f.status));
}

/** Every stage that is not complete, in play order. K1 (fix round G,
 *  Critical) replaced `lowestOpenStage`, which returned ONE stage: two of its
 *  three callers were asking a question about ALL of them, and a helper whose
 *  CARDINALITY is wrong is invisible to every test of the expression that
 *  calls it. */
function openStages(stages: PhaseStage[]): PhaseStage[] {
  return [...stages].filter((s) => s.status !== "complete").sort((a, b) => a.seq - b.seq);
}

/** "This stage cannot be played yet": it has no fixtures at all, or it has
 *  its generated TBD bracket and still owes the draw that fills it. */
function stageOwesWork(s: PhaseStage, fixtures: readonly PhaseFixture[]): boolean {
  return !s.hasFixtures || stageOwesDraw(s, fixtures);
}

/**
 * M1 (fix round I, Critical — instance TWELVE), replacing K3's
 * `stageNeedsProposal`: the ONE derivation of "this stage owes a
 * propose/confirm DRAW **that the organiser can actually go and do right
 * now**".
 *
 * K3's predicate was `status === "pending" && timing === "setup" &&
 * !hasFixtures`, and every conjunct of that is right except the last, which
 * is the exact OPPOSITE of the truth. `computeSeedProposal`
 * (server/usecases/stages.ts) resolves the proposal against the stage's
 * GENERATED TBD fixtures and 422s `SEEDING_RULES_MISSING` — "this stage has
 * no generated TBD fixtures yet — generate its fixtures first" — when there
 * are none. So `needs_draw` was raised in exactly, and only, the states
 * where its "Compute proposal" action could not succeed.
 *
 * Driven live at 11:39-11:40Z on 2026-09-03 against HEAD's own bundle, in
 * the shape the sixth review used as its healthy CONTROL (league complete,
 * finals `{timing:"setup"}`, no fixtures generated): the desk raised red
 * "Needs draw · Compute proposal", the landing `?tab=fixtures` DID render a
 * "Compute proposal" button, and CLICKING it returned the panel's error
 * banner — "This stage has no seeding rules, or its generated fixtures no
 * longer match them." — with the panel still in its `empty` state. Presence
 * was never the question.
 *
 * The four conjuncts are the union of the panel's own visibility gate and
 * the API's own preconditions, each one traceable to a line that refuses:
 *   - `timing === "setup"`   — `on_complete` stages auto-seed and never go
 *                              through propose/confirm (Decision 3);
 *   - `sourceReady`          — `progression-panel.tsx:304`
 *                              (`if (!sourceReady) return null`) and
 *                              `sourcesToTables`' 409
 *                              SEEDING_SOURCE_INCOMPLETE;
 *   - a `tbd` fixture OF THIS STAGE — `computeSeedProposal`'s
 *                              `destinationSlotsBySeed` 422 above (no
 *                              generated bracket, nothing to resolve
 *                              against), AND the "already drawn" case, since
 *                              confirming FILLS every slot and a drawn
 *                              bracket has no `tbd` fixture left.
 *
 * PRECONDITION: the stage is OPEN. Every caller reaches this through
 * `openStages`, which is the ONE place "not complete" is decided, so the
 * function is module-private and does not restate it. Two conjuncts that
 * looked load-bearing were removed for the same reason after a mutation
 * sweep proved neither could die on its own: `status !== "complete"` (the
 * caller's filter already guarantees it) and `hasFixtures` (a stage with no
 * fixtures has no `tbd` fixture either, so the last term subsumes it). A
 * term the caller already guarantees is not a guard, it is a second
 * authority — this wave's own recurring defect — and this file's own history
 * carries the same shape: the predicate this one replaces made
 * `stageOwesWork`'s `|| needsProposal` disjunct dead, because
 * `needsProposal` implied `!hasFixtures`.
 *
 * NOT keyed on `status === "pending"`, which K3 used and which is
 * unreachable here: generating a stage's TBD bracket moves it to `active`,
 * so the very act this row asks for takes the stage out of `pending` (read
 * off a live division at 11:39Z on 2026-09-03: Finals seq 2, status
 * `active`, timing `setup`, 3 fixtures, 0 filled).
 *
 * Everything it excludes falls through to `needs_fixtures`, whose two doors
 * ("Complete stage", "Generate fixtures") are on that same screen — the
 * ruling of the sixth review, reached here by the wider gate its own control
 * run disproved.
 *
 * Pure and DB-free on purpose: `sourceReady` is `seedingSourceReady` over
 * the caller's own in-memory stage list, and "is this bracket still TBD?" is
 * read off the fixtures' entrants rather than a `stage_seed_proposals` row,
 * so BOTH callers (the desk and `d/[divSlug]/page.tsx`, which computes the
 * phase for the start-locks tip) can answer it identically without a
 * viewer-gated read. Two authorities disagreeing about one division is this
 * wave's other recurring defect.
 */
function stageOwesDraw(stage: PhaseStage, fixtures: readonly PhaseFixture[]): boolean {
  return (
    stage.timing === "setup" &&
    stage.sourceReady &&
    fixtures.some((f) => f.stageId === stage.id && f.tbd)
  );
}

export function resolvePhase(input: PhaseInput): DivisionPhase {
  const { stages, fixtures } = input;
  // 1. setting_up: not started. Checked BEFORE "finished": a brand-new
  // division with zero stages and zero fixtures satisfies rule 2's "nothing
  // open, nothing live" vacuously (Task 3 competition-desk.test.ts, "a fresh
  // division with no stage is setting_up") — divisionStatus wins so it never
  // reads as finished before it has even begun.
  if (input.divisionStatus === "setup") return "setting_up";
  // 1b. setting_up: no stage graph at all — reachable even when
  // divisionStatus is NOT "setup". Final review's "open question": deleteStage
  // (stages.ts) lets an organiser remove the sole, last, UNPLAYED stage of an
  // already-`active` division — fixtures.stage_id FK-cascades, so the fixture
  // list empties with it, but divisionStatus is untouched. Confirmed reachable
  // against a live "active" division with 6 unplayed "scheduled" fixtures and
  // one stage (fix-round-b-report.md): deleting that stage leaves stages=[],
  // fixtures=[], status='active', which rule 2 below reads as `finished`
  // vacuously — the exact same "empty set answers no to every question" shape
  // rule 1 above guards against, one level down, mirroring amendment 3's
  // competition-level ruling ("zero divisions ⇒ setting_up, not finished").
  // Nothing has actually been played (deleteStage refuses a stage with any
  // in_play/decided/finalized fixture), so "setting_up" is correct regardless
  // of whatever divisionStatus says. Checked before rule 2 for the same
  // reason rule 1 is.
  if (stages.length === 0) return "setting_up";
  // 2. finished
  const everyStageComplete = stages.length > 0 && stages.every((s) => s.status === "complete");
  const noOpenStage = !stages.some((s) => s.status === "pending" || s.status === "active");
  const noLiveFixture = !fixtures.some((f) => LIVE.has(f.status));
  // V1 fix (review round 1): a division whose fixtures are ALL played reads
  // "finished" even when the organiser never clicked "Complete stage" — the
  // stage's own `status` lagging the fixtures underneath it must not read
  // as "scheduled · nothing scheduled". `openStageOwesWork` guards this: a
  // fully-played league with a later stage still awaiting its draw (the
  // U16 Cup shape) must stay NOT finished so it can fall through to rule 4
  // and read "setting_up" (with a needs_draw attention on top).
  // K1 fix (fix round G, Critical — instance NINE). This asked
  // `lowestOpenStage`, i.e. ONE stage, a question that is about all of them:
  // "does anything still open owe work?" A LATER `pending` stage with zero
  // fixtures was therefore invisible and `allPlayed && noLiveFixture` won
  // rule 2 below. Driven end to end through the production API only (`POST
  // /fixtures/{id}/events`, no SQL): a two-stage division whose stage 2 is
  // `{timing: "on_complete"}`, with all six league fixtures scored, leaves
  // stage 1 `active`, stage 2 `pending` with zero fixtures and the division
  // `active` — and the desk read masthead "Finished", row pill "Finished",
  // "6 of 6 played · complete" and NO Needs-you item at all, with an entire
  // knockout never played and never seeded. (Sibling shape, same root: stage
  // 1 `complete` instead of `active` read `setting_up`, equally silent.)
  // Pressing "Complete stage" seeds the finals and the row corrects itself,
  // so the product was fine — the desk simply never asked.
  const open = openStages(stages);
  const anyOpenStageOwesWork = open.some((st) => stageOwesWork(st, fixtures));
  const TERMINAL = new Set(["decided", "finalized", "abandoned", "forfeited", "cancelled"]);
  const allPlayed = fixtures.length > 0 && fixtures.every((f) => TERMINAL.has(f.status));
  // J2 fix (fix round F, Critical): `noLiveFixture` was factored out of only
  // TWO of the three disjuncts, so `everyStageComplete` on its own declared a
  // division finished no matter what its fixtures were still doing — a fact
  // about STAGES answering a question about FIXTURES, the same vacuous shape
  // rules 1 and 1b guard one level up. Reachable, and driven end to end
  // through the real API (fix-round-f-report.md): a knockout with a
  // third-place playoff completes on its FINAL alone (isBracketStageComplete,
  // packages/engine/src/competition/stage.ts:134, requires only the `isFinal`
  // fixtures), so `POST /stages/{id}/complete` marks the stage complete and
  // the division `completed` while the playoff is still `scheduled` and dated.
  // The desk then read "3 of 4 played · complete · Finished" directly beside a
  // red "result missing … Enter result" for that very fixture — the wave's
  // signature defect, a row contradicting itself, for the eighth time.
  //
  // The pill was the wrong half, not the attention: scoring stays OPEN on a
  // `completed` division (scoring.ts gates `setup`/`scheduled` only), so
  // "Enter result" is a live door, and entering the result takes the row to
  // "4 of 4 played · complete · Finished" with no attention at all. So a
  // division is never finished while a fixture is still LIVE — `scheduled` or
  // `in_play`. Terminal-but-unplayed fixtures (cancelled/abandoned/forfeited/
  // void) are NOT live and still read finished, which is the direction the
  // "remaining fixtures are terminal, not live" test pins.
  if (!anyOpenStageOwesWork && noLiveFixture && (everyStageComplete || noOpenStage || allPlayed)) {
    return "finished";
  }
  // 3. match_day
  const today = localDateKey(input.now, input.tz);
  const matchDay = fixtures.some(
    (f) =>
      f.status === "in_play" ||
      (f.status === "scheduled" && f.scheduledAt !== null && localDateKey(f.scheduledAt, input.tz) === today),
  );
  if (matchDay) return "match_day";
  // 4. setting_up: the next stage has nothing to play yet.
  //
  // This rung deliberately asks only the NEXT open stage, NOT every one of
  // them the way rule 2 above now does — the two consumers of the old
  // single-stage helper were asking different questions and only one of them
  // was wrong. "Nothing has happened yet" is a claim about the division as a
  // whole: a league three rounds into its season with a knockout that seeds
  // on its completion has plenty to play, and answering `anyOpenStageOwesWork`
  // here would print "Setting up" beside "3 of 6 played" for the entire
  // season — the wave's own signature defect, introduced by over-applying its
  // fix. Rule 2 asks "is there anything left at all?"; rule 4 asks "is the
  // thing that is next up playable?".
  const nextOpenStage = open[0];
  if (nextOpenStage && stageOwesWork(nextOpenStage, fixtures)) return "setting_up";
  // 5. scheduled — a live (non-terminal, i.e. status "scheduled"; "in_play"
  // always won rule 3 above) fixture actually carries a time.
  // F1 fix (final review, Critical): the old rule 5 was a bare "otherwise",
  // so a started division whose fixtures were all generated with no time
  // read "Scheduled" while its own status line said "nothing scheduled" —
  // three contradicting facts in one row.
  const hasScheduledFixture = fixtures.some((f) => f.status === "scheduled" && f.scheduledAt !== null);
  if (hasScheduledFixture) return "scheduled";
  // fix-round-c, Defect 2 / owner ruling 2026-09-02: F1's fallback (nothing
  // dated ⇒ "setting_up") over-applied. `setting_up` may only mean "nothing
  // has happened yet" — a mid-season division that has already played
  // fixtures but has not yet dated its NEXT round (a league dated a round at
  // a time, the normal way one runs) is IN PROGRESS, not "setting up", even
  // though nothing is currently dated. Reproduced live: a division 1 of 6
  // played, 5 unscheduled, read "Setting up" beside a part-filled progress
  // bar. `played` is derived from the SAME fixtures list the desk's own
  // played/total count comes from (card-stats.ts's PLAYED_STATUSES mirrored
  // above), so this never drifts from the number the row already shows.
  //
  // F1's own original case is unaffected: 0 played AND nothing dated still
  // has `anyPlayed` false, so it falls through to `setting_up` exactly as
  // before — the `unscheduled` attention already says so in words.
  const anyPlayed = hasPlayedFixture(fixtures);
  return anyPlayed ? "scheduled" : "setting_up";
}

export function resolveAttention(input: PhaseInput): Attention[] {
  const out: Attention[] = [];
  const nowMs = Date.parse(input.now);
  // K1 fix (fix round G, Critical — instance NINE), the other half. This read
  // `lowestOpenStage` and raised ONLY `needs_draw`, so the unseeded stage the
  // finding names had no row of any kind: nothing on the page asked the
  // organiser for the one action that unblocks it.
  //
  // The lowest OPEN stage that owes work raises a row — `needs_draw` when it
  // owes a propose/confirm proposal, `needs_fixtures` otherwise (see that
  // kind's own note above for why re-using `needs_draw` would point at a
  // control the organiser cannot see).
  //
  // A LATER open stage is reported only once there is nothing LIVE left to
  // play — the same `noLiveFixture` predicate rule 2 uses. While earlier
  // fixtures are still `scheduled` or `in_play`, a later stage's emptiness is
  // not yet the organiser's problem and neither of its doors is usable
  // (`seedingSourceReady`, lib/seeding-source-ready.ts, hides the proposal
  // panel until every source stage has completed), so a red row there would
  // be a prompt for an action that cannot be taken. For the lowest open stage
  // the condition is unchanged from before this fix, deliberately: that arm
  // never consulted the fixtures and must keep not consulting them.
  const noLive = !input.fixtures.some((f) => LIVE.has(f.status));
  const blocked = openStages(input.stages).find(
    (s, i) => stageOwesWork(s, input.fixtures) && (i === 0 || noLive),
  );
  // M1 (fix round I, Critical — instance TWELVE): `needs_draw` is raised
  // only when the panel's draw door is BOTH rendered and operable — see
  // `stageOwesDraw` above for its three terms and the live click that
  // disproved the sixth review's control run. `door` names which of the
  // panel's three buttons is on screen, so the row can print that button's
  // own dictionary key rather than a hand-copied name.
  if (blocked && stageOwesDraw(blocked, input.fixtures)) {
    out.push({ kind: "needs_draw", stageName: blocked.name, door: DOOR_FOR_PROPOSAL[blocked.proposal] });
  } else if (blocked && input.divisionStatus !== "setup") {
    // `needs_fixtures` is gated on the division being REAL, and `needs_draw`
    // deliberately is not (H2's ruling: a draw is owed the moment the stage
    // exists). A `setup` division has no published timetable at all — every
    // stage in it is legitimately empty while the organiser is still
    // assembling entrants, and the wizard itself creates the stage graph
    // before a single entrant exists, so an ungated row would put a red
    // "Needs fixtures" on every division the moment it is created, pointing
    // at a Generate button that cannot succeed yet. The row already states
    // that case in words ("Setting up · 4 entrants"), and nothing is blocked.
    // Every shape this fix exists for is `scheduled`/`active`/`completed` —
    // fixtures cannot have been played otherwise — so the gate cannot hide
    // one.
    out.push({ kind: "needs_fixtures", stageName: blocked.name });
  }
  const unscheduled = input.fixtures.filter((f) => f.status === "scheduled" && f.scheduledAt === null).length;
  if (unscheduled > 0) out.push({ kind: "unscheduled", count: unscheduled });
  // F3+F4 fix (final review, Important): both aggregated per division below,
  // the same way `unscheduled` already is above — collected here, pushed once.
  const noScorer: { id: string; since: number | null }[] = [];
  const notRecording: { id: string; since: number }[] = [];
  const resultMissing: string[] = [];
  // G3 fix (fix round D, Important), CORRECTED by H2 (final review round 3,
  // Important): G3's gate was `divisionStatus === "active"`, which also
  // excludes `scheduled` — but `scheduled` is exactly what the ordinary
  // Publish action sets (schedule.ts's `publishSchedule`), not a state
  // reserved for "not yet real". Live: six fixtures dated YESTERDAY on a
  // published (`scheduled`), never-started division produced NO "Needs you"
  // section at all — an organiser who published a timetable and never
  // pressed Start got no prompt of any kind. Silence is the worse failure
  // than G3's original wrongly-worded row: this wave exists to tell an
  // organiser what needs them.
  //
  // RULING: the gate excludes `setup` only. `setup`, `scheduled`, `active`
  // and `completed` are the full set (divisions_status_check) — a division
  // whose timetable is published (`scheduled`) or further along, with a
  // match time that has passed, genuinely owes a result; only `setup` (no
  // timetable published at all — scoring can't even be locked-open yet,
  // scoring.ts:220) is the "not yet real" state G3 meant to exclude.
  // `needs_draw`/`unscheduled`/`registrations_waiting` are still deliberately
  // NOT gated here — every one of them is exactly the class of thing an
  // organiser legitimately still owes before or after Start.
  const canHaveLiveActivity = input.divisionStatus !== "setup";
  if (canHaveLiveActivity) {
    for (const f of input.fixtures) {
      // F4 fix: the old test was bare `eventCount === 0` — a division- or
      // fixture-scoped scorer sitting on a 0-0 read as "missing", and
      // assigning one never cleared the row (only the first score event did).
      // `hasScorer` is resolved by the caller from scorer_assignments at both
      // scopes; once someone is assigned, the organiser's own job here is
      // done, so the row clears immediately — matching design doc line 101
      // ("a scorerless fixture reads 'No scorer' until it is assigned"), not
      // left waiting on whether that scorer has actually typed anything yet.
      // (Deliberate scope decision, recorded in fix-round-b-report.md: an
      // assigned-but-silent scorer well past kick-off gets NO attention at
      // all in this round, not a weaker one — a genuinely separate product
      // question this fix does not take on.)
      // Hoisted out of the `no_scorer` arm (round J): `not_recording` asks the
      // same question of the same clock, and a second copy of this derivation
      // is a second authority for one displayed fact — the shape that produced
      // this wave's worst defects.
      //
      // division-phase.ts:134 minor fix: a fixture with no `scheduledAt` at
      // all can never answer "minutes since kickoff" — `null`, not a
      // permanent, misleading "0 min ago".
      //
      // Minor 1 (fix round G): the clamp that used to sit here,
      // `Math.max(0, …)`, reintroduced the very zero it was meant to
      // prevent — an `in_play` fixture dated in the FUTURE (an organiser
      // starts a match early, or re-dates one after kick-off) printed
      // "Kicked off 0 min ago", and a malformed `scheduledAt` printed
      // "Kicked off NaN min ago", since `Math.max(0, NaN)` is `NaN`. An
      // elapsed time we cannot state is `null` — the same "unknown"
      // sub-line the no-date case already renders — never a number that
      // reads as a fact.
      // Review 7 (Minor 8b): the clock is the KICK-OFF, not the plan.
      // `startedAt` is `core.start`'s own `recorded_at`; `scheduledAt` remains
      // the fallback only for a fixture that has no start event, which for the
      // two rows below cannot happen (a fixture is not in play without one) —
      // it is kept so the derivation stays total for every other caller.
      const kickoff = f.startedAt ?? f.scheduledAt;
      const kickoffMs = kickoff === null ? NaN : Date.parse(kickoff);
      const rawElapsed = Number.isNaN(kickoffMs) ? null : Math.round((nowMs - kickoffMs) / 60_000);
      const elapsed = rawElapsed !== null && rawElapsed >= 0 ? rawElapsed : null;
      if (f.status === "in_play" && f.eventCount === 0 && !f.hasScorer) {
        noScorer.push({ id: f.id, since: elapsed });
      }
      // A SEPARATE `if`, deliberately not chained onto the one above. Chained,
      // `!f.hasScorer` on the first arm made `f.hasScorer` on this one
      // redundant — a mutation sweep deleted that conjunct and all 79 tests
      // stayed green, because branch ORDER was doing the work the conjunct
      // claimed to do. Two guards covering for each other are each untested
      // (recurring failure class 3), and the pair's whole promise here is that
      // one match can never raise both rows. Independent predicates, each
      // killable on its own.
      if (
        // F3 (round J). `no_scorer`'s exact complement: same status, same zero
        // event count, `hasScorer` the other way round — so no fixture can ever
        // raise both, and the two rows can never contradict each other on the
        // same match.
        //
        // `elapsed === null` raises NOTHING, deliberately. The row's whole
        // claim is that recording is LATE; a fixture whose kick-off we cannot
        // state (no `scheduledAt`, or a malformed one) cannot support that
        // claim, and inventing a zero would make every undated live fixture
        // permanently late. Silence is the correct answer to a question we
        // cannot answer — the same rule the `no_scorer` sub-line follows.
        f.status === "in_play" &&
        f.eventCount === 0 &&
        f.hasScorer &&
        // Behaviourally redundant at today's grace — `null >= 15` is already
        // false — and kept anyway for two reasons a mutant cannot show: it is
        // what narrows `elapsed` to a number for `since` below (without it the
        // push needs a non-null assertion, which this repo does not allow),
        // and it is the one thing standing between a grace of 0 and a row
        // whose `minutesSinceKickoff` is null, which the type forbids.
        elapsed !== null &&
        elapsed >= NOT_RECORDING_GRACE_MINUTES
      ) {
        notRecording.push({ id: f.id, since: elapsed });
      } else if (
        f.status === "scheduled" &&
        f.scheduledAt !== null &&
        Date.parse(f.scheduledAt) + f.matchMinutes * 60_000 < nowMs
      ) {
        resultMissing.push(f.id);
      }
    }
  }
  if (noScorer.length > 0) {
    const known = noScorer.map((n) => n.since).filter((s): s is number => s !== null);
    out.push({
      kind: "no_scorer",
      count: noScorer.length,
      fixtureIds: noScorer.map((n) => n.id),
      minutesSinceKickoff: known.length > 0 ? Math.max(...known) : null,
    });
  }
  if (notRecording.length > 0) {
    // `since` is a number by construction here (the predicate refuses a null
    // elapsed), so unlike `no_scorer` this row always has a figure to print
    // and needs no "unknown" sub-line. The WORST — longest silent — fixture
    // is the one worth naming, same choice `no_scorer` makes.
    out.push({
      kind: "not_recording",
      count: notRecording.length,
      fixtureIds: notRecording.map((n) => n.id),
      minutesSinceKickoff: Math.max(...notRecording.map((n) => n.since)),
    });
  }
  if (resultMissing.length > 0) {
    out.push({ kind: "result_missing", count: resultMissing.length, fixtureIds: resultMissing });
  }
  if (input.awaitingRegistrations > 0) {
    out.push({ kind: "registrations_waiting", count: input.awaitingRegistrations });
  }
  return out.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(ATTENTION_SEVERITY[a.kind]) - SEVERITY_ORDER.indexOf(ATTENTION_SEVERITY[b.kind]) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
}
