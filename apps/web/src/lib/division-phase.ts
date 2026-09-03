// Competition Desk (spec 2026-09-02 §"The shared model"): a division's phase is
// DERIVED from stage + fixture + status facts, never stored. Pure so the same
// answer renders on server and client and the matrix is unit-testable.

export type DivisionStatus = "setup" | "scheduled" | "active" | "completed";
export type DivisionPhase = "setting_up" | "scheduled" | "match_day" | "finished";

export interface PhaseStage {
  id: string;
  name: string;
  seq: number;
  status: string; // pending | active | complete
  hasFixtures: boolean;
  needsProposal: boolean;
}

export interface PhaseFixture {
  id: string;
  status: string; // scheduled | in_play | decided | finalized | abandoned | forfeited | cancelled
  scheduledAt: string | null;
  eventCount: number;
  matchMinutes: number;
  /** F4 fix (final review, Important): does ANY scorer_assignment cover this
   *  fixture — fixture-scoped OR division-scoped (competition-desk.ts reads
   *  both; competition-scoped assignments are deliberately not checked here,
   *  per the finding's own wording). Resolved by the caller so this module
   *  stays pure and DB-free. */
  hasScorer: boolean;
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

export type Attention =
  | { kind: "needs_draw"; stageId: string; stageName: string }
  // K1 fix (fix round G, Critical — instance NINE). `needs_draw`'s sibling,
  // for a stage that has nothing to play and no PROPOSAL to compute: an
  // `on_complete` stage waiting to be seeded by the stage before it, or a
  // stage whose fixtures were never generated at all. It is deliberately NOT
  // `needs_draw`: the "Compute proposal" panel it points at
  // (d/[divSlug]/page.tsx's `seedingStages`) is rendered only for a
  // `timing: "setup"` stage, so re-using that row would send an organiser to
  // a control that does not exist on their screen. Both of this row's real
  // doors — "Complete stage" on the stage before it, and "Generate fixtures"
  // — live on the division's fixtures tab, which is where its action goes.
  | { kind: "needs_fixtures"; stageId: string; stageName: string }
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

export function ledgerRank(desk: { phase: DivisionPhase; attention: readonly Attention[] } | null): number {
  if (!desk) return 9;
  if (desk.attention.some((a) => ATTENTION_SEVERITY[a.kind] === "red")) return -1;
  return LEDGER_PHASE_RANK[desk.phase];
}

const KIND_ORDER: Attention["kind"][] = [
  "needs_draw",
  "needs_fixtures",
  "no_scorer",
  "unscheduled",
  "result_missing",
  "registrations_waiting",
];
const SEVERITY_ORDER: Severity[] = ["red", "amber", "slate"];

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
 * drift class in this wave (see `stageNeedsProposal`, K3).
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

/** "This stage cannot be played yet": it has no fixtures, or it has them and
 *  still owes its draw. */
function stageOwesWork(s: PhaseStage): boolean {
  return !s.hasFixtures || s.needsProposal;
}

/**
 * K3 (fix round G): the ONE derivation of `PhaseStage.needsProposal` — "this
 * stage owes a propose/confirm DRAW before anything can be generated for it".
 *
 * It used to be an expression written out TWICE — once in
 * competition-desk.ts's stage mapper and once, hand-copied, in
 * `o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` — and it was untested at
 * every layer: mutating either copy to a constant left the whole desk suite
 * (137/137) green, even though `needs_draw`, the "Needs draw" pill, the
 * "Compute proposal" action and resolvePhase's rule 4 ALL reach production
 * only through it. A hand-copied predicate is a recorded drift class in this
 * repo, so both call sites now share this function and it is pinned where it
 * is DERIVED, against a real database: competition-desk.test.ts's
 * "K3: needsProposal is derived from the stage's own progression timing".
 *
 * `timing` is `progression ->> 'timing'` — `null`/`undefined` for a stage
 * carrying no progression at all, which is NOT a draw it owes (its fixtures
 * are generated, not seeded).
 */
export function stageNeedsProposal(stage: {
  status: string;
  timing: string | null | undefined;
  hasFixtures: boolean;
}): boolean {
  return stage.status === "pending" && stage.timing === "setup" && !stage.hasFixtures;
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
  const anyOpenStageOwesWork = open.some(stageOwesWork);
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
  if (nextOpenStage && stageOwesWork(nextOpenStage)) return "setting_up";
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
  const blocked = openStages(input.stages).find((s, i) => stageOwesWork(s) && (i === 0 || noLive));
  if (blocked?.needsProposal) {
    out.push({ kind: "needs_draw", stageId: blocked.id, stageName: blocked.name });
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
    out.push({ kind: "needs_fixtures", stageId: blocked.id, stageName: blocked.name });
  }
  const unscheduled = input.fixtures.filter((f) => f.status === "scheduled" && f.scheduledAt === null).length;
  if (unscheduled > 0) out.push({ kind: "unscheduled", count: unscheduled });
  // F3+F4 fix (final review, Important): both aggregated per division below,
  // the same way `unscheduled` already is above — collected here, pushed once.
  const noScorer: { id: string; since: number | null }[] = [];
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
      if (f.status === "in_play" && f.eventCount === 0 && !f.hasScorer) {
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
        const kickoffMs = f.scheduledAt === null ? NaN : Date.parse(f.scheduledAt);
        const elapsed = Number.isNaN(kickoffMs) ? null : Math.round((nowMs - kickoffMs) / 60_000);
        noScorer.push({ id: f.id, since: elapsed !== null && elapsed >= 0 ? elapsed : null });
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
