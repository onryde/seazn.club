// The /start "Sent stepper" (owner-approved 2026-11-14, mock sss14a: section 1 Option A, section 4): the five steps from the
// Sent screen to a scheduled event, and which one is the organiser's now. Pure and client-safe: the Sent screen
// (start-wizard.tsx) and the division page the claim lands on both render it through <GettingStartedStepper/>, and the
// landing's progress is the server's getting-started read (server/usecases/getting-started.ts), passed in as data.

/** The steps, in the owner's order. */
export const GETTING_STARTED_STEPS = ["open", "rename", "players", "generate", "schedule"] as const;
export type GettingStartedStep = (typeof GETTING_STARTED_STEPS)[number];
export type StepState = "done" | "current" | "todo";
export interface StepRow {
  key: GettingStartedStep;
  state: StepState;
}

/** The getting-started read's shape (`GettingStarted`, server-only), restated so a client module can hold it. */
export interface GettingStartedProgress {
  orgRenamed: boolean;
  entrants: { count: number; target: number | null };
  fixturesGenerated: boolean;
  fixtureScheduled: boolean;
}

/** Ticks in step order to rows: the first step not done is current, the others not done wait. */
function rows(done: Readonly<Record<GettingStartedStep, boolean>>): StepRow[] {
  const current = GETTING_STARTED_STEPS.find((k) => !done[k]);
  return GETTING_STARTED_STEPS.map((key) => ({ key, state: done[key] ? "done" : key === current ? "current" : "todo" }));
}

/** The Sent screen: the link is in the inbox, nothing has happened yet. */
export function sentSteps(): StepRow[] {
  return rows({ open: false, rename: false, players: false, generate: false, schedule: false });
}

/** The landing after the claim, from the getting-started read; null when it is not shown.
 *
 *  Shown only for a competition a /start draft built (`target` set: the size chosen there) and only until a match is
 *  scheduled — step 5 done leaves nothing to lead to, so the stepper hides rather than showing five ticks. Each tick is
 *  real state: the link was opened (this page exists), the starter name is gone, the field reached the size chosen OR
 *  fixtures exist (Generate fixed the field: a smaller field the organiser chose to run is their field), any fixture,
 *  any fixture with a time. `done` is the count of ticks. */
export function landingSteps(p: GettingStartedProgress): { steps: StepRow[]; done: number } | null {
  const { target, count } = p.entrants;
  if (target === null || p.fixtureScheduled) return null;
  const done: Record<GettingStartedStep, boolean> = {
    open: true,
    rename: p.orgRenamed,
    players: p.fixturesGenerated || count >= target,
    generate: p.fixturesGenerated,
    schedule: p.fixtureScheduled,
  };
  return { steps: rows(done), done: GETTING_STARTED_STEPS.filter((k) => done[k]).length };
}

/** Step 5's hint: the courts when the organiser has some (Planning opened on /start; on the landing, the club's live courts),
 *  the first day when one was picked, neither when neither. Courts are a count the caller words with its own plural; the
 *  date an ISO day it formats. No court at all reads as no courts, never "0 courts". */
export function scheduleHint(
  courts: number | null,
  date: string | null,
): { key: string; vars: { courts?: number; date?: string } } {
  const hasCourts = courts !== null && courts > 0;
  if (hasCourts && date !== null) return { key: "start.next.schedule.courtsDate", vars: { courts, date } };
  if (hasCourts) return { key: "start.next.schedule.courts", vars: { courts } };
  if (date !== null) return { key: "start.next.schedule.date", vars: { date } };
  return { key: "start.next.schedule.plain", vars: {} };
}
