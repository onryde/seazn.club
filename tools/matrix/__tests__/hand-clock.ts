// Fix round 4 (re-review 1 I-1, ruling T12-R5): the turn tests run on no wall
// time. A family's deadlines go on a clock the test fires by hand, and every
// other ordering is a deferred the test resolves — so an abort test asserts
// what the order GUARANTEES, never what a timer race made likely.
import type { TurnClock } from "../lib/workers.ts";

/** A promise the test settles by hand. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

interface HandTimer { fire: () => void; ms: number; live: boolean }

/** A TurnClock nothing fires but the test. `timers` keeps every deadline ever
 *  set, in order; a cleared or fired one is no longer live. */
export function handClock(): { clock: TurnClock; timers: HandTimer[]; live: () => HandTimer[]; fireTheOne: () => void } {
  const timers: HandTimer[] = [];
  const clock: TurnClock = {
    setTimeout: (fire, ms) => { const t: HandTimer = { fire, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (handle) => { (handle as HandTimer).live = false; },
  };
  const live = () => timers.filter((t) => t.live);
  /** Fires the ONE live deadline. Refuses when there is not exactly one, so a
   *  test can only ever trip the turn it means — never a bystander's. */
  const fireTheOne = () => {
    const l = live();
    const [t] = l;
    if (l.length !== 1 || t === undefined) throw new Error(`hand clock: ${l.length} live deadlines, expected exactly 1`);
    t.live = false;
    t.fire();
  };
  return { clock, timers, live, fireTheOne };
}
