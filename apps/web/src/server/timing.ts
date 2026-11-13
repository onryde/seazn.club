import "server-only";
// Per-stage wall-clock timer for one request (registration redesign B0, spec 2026-11-13-registration-redesign-design.md §3.2).
// The public register route creates one per submit, threads it through `submitRegistrationGroup` and `mintGroupCheckout`, and
// reports it twice: a `register.submit.timing` log line on every submit, and a `Server-Timing` response header only when
// REGISTER_SERVER_TIMING=1 (stage names are internal detail). Callers without a timer pass nothing and pay nothing: `timed`
// below runs the bare fn when the timer is absent.
//
// Nesting rides AsyncLocalStorage, not a push/pop stack, so stages that run concurrently (`Promise.all` of sibling reads) each
// nest under their own parent rather than under whichever sibling happened to start first.
import { AsyncLocalStorage } from "node:async_hooks";

export type StageTimer = {
  /** Time `fn` under `name`. Called inside another stage of the same timer, the name is dotted (`pre_tx.settings`). A stage entered
   *  twice sums its durations. A throwing `fn` is still recorded, then its error propagates unchanged. */
  stage<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Record the time since the timer was created under `name` (`total`), replacing any earlier mark of that name. */
  mark(name: string): void;
  /** `Server-Timing` value: "rate_limit;dur=3.1, turnstile;dur=210.4, …", in the order stages were first entered; "" when none. */
  header(): string;
  /** Milliseconds per stage, rounded to 0.1. */
  durations(): Record<string, number>;
};

/** One segment of a stage path: also a Server-Timing metric name, so a token, and never a dot (the dot is the nesting). */
const STAGE_NAME = /^[a-z_]+$/;

function assertStageName(name: string): void {
  if (!STAGE_NAME.test(name)) throw new Error(`timing: stage name must match ${STAGE_NAME}, got ${JSON.stringify(name)}`);
}

/** The stage path currently open, per async context, tagged with the timer that opened it. */
const openStage = new AsyncLocalStorage<{ timer: StageTimer; path: string }>();

const round1 = (ms: number): number => Math.round(ms * 10) / 10;

export function createStageTimer(now: () => number = () => performance.now()): StageTimer {
  const startedAt = now();
  // Insertion order is first-entry order, which `header()` and `durations()` keep.
  const totals = new Map<string, number>();

  const timer: StageTimer = {
    async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
      assertStageName(name);
      const parent = openStage.getStore();
      const path = parent && parent.timer === timer ? `${parent.path}.${name}` : name;
      if (!totals.has(path)) totals.set(path, 0);
      const t0 = now();
      try {
        return await openStage.run({ timer, path }, fn);
      } finally {
        totals.set(path, totals.get(path)! + (now() - t0));
      }
    },
    mark(name: string): void {
      assertStageName(name);
      totals.set(name, now() - startedAt);
    },
    header(): string {
      return [...totals].map(([path, ms]) => `${path};dur=${round1(ms)}`).join(", ");
    },
    durations(): Record<string, number> {
      return Object.fromEntries([...totals].map(([path, ms]) => [path, round1(ms)]));
    },
  };
  return timer;
}

/** `timer.stage(name, fn)` when a timer was passed, else `fn()` itself: an optional timer allocates nothing when absent. */
export function timed<T>(timer: StageTimer | undefined, name: string, fn: () => Promise<T>): Promise<T> {
  return timer ? timer.stage(name, fn) : fn();
}
