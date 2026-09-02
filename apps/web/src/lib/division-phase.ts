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
  /** The governing org clock (resolveVenueTz(null, organizations.timezone)). */
  tz: string;
  awaitingRegistrations: number;
}

export type Attention =
  | { kind: "needs_draw"; stageId: string; stageName: string }
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
  no_scorer: "red",
  unscheduled: "amber",
  result_missing: "amber",
  registrations_waiting: "slate",
};

const KIND_ORDER: Attention["kind"][] = [
  "needs_draw",
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

function lowestOpenStage(stages: PhaseStage[]): PhaseStage | null {
  return (
    [...stages].filter((s) => s.status !== "complete").sort((a, b) => a.seq - b.seq)[0] ?? null
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
  const open = lowestOpenStage(stages);
  const openStageOwesWork = !!open && (!open.hasFixtures || open.needsProposal);
  const TERMINAL = new Set(["decided", "finalized", "abandoned", "forfeited", "cancelled"]);
  const allPlayed = fixtures.length > 0 && fixtures.every((f) => TERMINAL.has(f.status));
  if (!openStageOwesWork && (everyStageComplete || (noOpenStage && noLiveFixture) || (allPlayed && noLiveFixture))) {
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
  // 4. setting_up: the next stage has nothing to play yet
  if (openStageOwesWork) return "setting_up";
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
  const anyPlayed = fixtures.some((f) => PLAYED_STATUSES.has(f.status));
  return anyPlayed ? "scheduled" : "setting_up";
}

export function resolveAttention(input: PhaseInput): Attention[] {
  const out: Attention[] = [];
  const nowMs = Date.parse(input.now);
  const open = lowestOpenStage(input.stages);
  if (open && open.needsProposal) {
    out.push({ kind: "needs_draw", stageId: open.id, stageName: open.name });
  }
  const unscheduled = input.fixtures.filter((f) => f.status === "scheduled" && f.scheduledAt === null).length;
  if (unscheduled > 0) out.push({ kind: "unscheduled", count: unscheduled });
  // F3+F4 fix (final review, Important): both aggregated per division below,
  // the same way `unscheduled` already is above — collected here, pushed once.
  const noScorer: { id: string; since: number | null }[] = [];
  const resultMissing: string[] = [];
  // G3 fix (fix round D, Important): this function used to never read
  // `divisionStatus` at all, so `no_scorer`/`result_missing` fired off raw
  // fixture facts alone. A division an organiser has never started (`setup`)
  // or has only published (`scheduled`) can still carry fixtures dated in
  // the past — scoring itself stays LOCKED until `division_started`
  // (scoring.ts:220, "A published-but-unstarted timetable stays read-only"),
  // so an elapsed match window there is not a missed result, it is an
  // organiser who has not pressed Start yet. Reproduced live: a brand-new,
  // never-started division read "Unstarted" (setting_up) one row UNDER a
  // Needs-you item reading "result missing … the match window has passed"
  // for the same fixture. `needs_draw`/`unscheduled`/`registrations_waiting`
  // are deliberately NOT gated here — every one of them is exactly the class
  // of thing an organiser legitimately still owes before or after Start.
  const canHaveLiveActivity = input.divisionStatus === "active";
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
        const since = f.scheduledAt ? Math.max(0, Math.round((nowMs - Date.parse(f.scheduledAt)) / 60_000)) : null;
        noScorer.push({ id: f.id, since });
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
