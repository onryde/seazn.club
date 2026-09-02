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
  | { kind: "no_scorer"; fixtureId: string; minutesSinceKickoff: number }
  | { kind: "result_missing"; fixtureId: string }
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
  // 2. finished
  const everyStageComplete = stages.length > 0 && stages.every((s) => s.status === "complete");
  const noOpenStage = !stages.some((s) => s.status === "pending" || s.status === "active");
  const noLiveFixture = !fixtures.some((f) => LIVE.has(f.status));
  if (everyStageComplete || (noOpenStage && noLiveFixture)) return "finished";
  // 3. match_day
  const today = localDateKey(input.now, input.tz);
  const matchDay = fixtures.some(
    (f) =>
      f.status === "in_play" ||
      (f.status === "scheduled" && f.scheduledAt !== null && localDateKey(f.scheduledAt, input.tz) === today),
  );
  if (matchDay) return "match_day";
  // 4. setting_up: the next stage has nothing to play yet
  const open = lowestOpenStage(stages);
  if (open && (!open.hasFixtures || open.needsProposal)) return "setting_up";
  // 5.
  return "scheduled";
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
  for (const f of input.fixtures) {
    if (f.status === "in_play" && f.eventCount === 0) {
      const since = f.scheduledAt ? Math.max(0, Math.round((nowMs - Date.parse(f.scheduledAt)) / 60_000)) : 0;
      out.push({ kind: "no_scorer", fixtureId: f.id, minutesSinceKickoff: since });
    } else if (
      f.status === "scheduled" &&
      f.scheduledAt !== null &&
      Date.parse(f.scheduledAt) + f.matchMinutes * 60_000 < nowMs
    ) {
      out.push({ kind: "result_missing", fixtureId: f.id });
    }
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
