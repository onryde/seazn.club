// R26: tests that sweep sports walk the registry through here — in the
// registry's own order, which is wave order (never sort it; AGENTS.md class
// 18). An empty registry is a refusal, not a vacuous pass (R25). Pure: no
// node:fs, so it belongs in the published testkit barrel.
//
// forEachSport is for SYNCHRONOUS bodies. TypeScript lets an async function
// stand in for a void-returning one, and a body whose promise nobody awaits
// runs nothing before the count comes back — so a body that returns a
// thenable is refused by name (AsyncBody). Async bodies use forEachSportAsync,
// which awaits each sport in turn.
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";

export interface SportCase { readonly key: string; readonly index: number; readonly module: AnySportModule }

export class EmptySportRegistry extends Error {
  constructor() {
    super("forEachSport: the sport registry is empty — a sweep over nothing proves nothing (R25)");
    this.name = "EmptySportRegistry";
  }
}

export class AsyncBody extends Error {
  readonly sport: string;
  constructor(sport: string) {
    super(`forEachSport: the body for sport ${sport} returned a promise, which forEachSport cannot await — use forEachSportAsync`);
    this.name = "AsyncBody";
    this.sport = sport;
  }
}

/** One case per module, in the list's own order; `index` is its position. */
export function sportCases(modules: readonly AnySportModule[] = builtinModules): SportCase[] {
  if (modules.length === 0) throw new EmptySportRegistry();
  return modules.map((module, index) => ({ key: module.key, index, module }));
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";

// The fields vitest's reporter reads to print an assertion diff. A wrapper
// without them would turn a failing `expect` inside a sweep into a bare
// message (review M-3), so they are carried across.
const DIFF_FIELDS = ["actual", "expected", "showDiff", "operator"] as const;

function named(key: string, e: unknown): Error {
  const wrapped = new Error(`sport ${key}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  if (typeof e === "object" && e !== null) {
    for (const f of DIFF_FIELDS) if (f in e) Object.assign(wrapped, { [f]: (e as Record<string, unknown>)[f] });
  }
  return wrapped;
}

/** Runs fn once per sport, in registry order, and returns how many it
 *  visited. A throw is rethrown naming the sport, with the original as cause.
 *  A body that returns a thenable is refused (AsyncBody). */
export function forEachSport(fn: (c: SportCase) => void, modules: readonly AnySportModule[] = builtinModules): number {
  const cases = sportCases(modules);
  for (const c of cases) {
    let out: unknown;
    try {
      out = fn(c);
    } catch (e) {
      throw named(c.key, e);
    }
    if (isThenable(out)) {
      // Nobody will await it; a later rejection must not surface as an
      // unattributed unhandledRejection on top of this refusal.
      out.then(undefined, () => undefined);
      throw new AsyncBody(c.key);
    }
  }
  return cases.length;
}

/** The async sweep: awaits each body in registry order, one at a time, and
 *  resolves with how many it visited only after every body has settled. A
 *  rejection is rethrown naming the sport, with the original as cause. */
export async function forEachSportAsync(fn: (c: SportCase) => unknown, modules: readonly AnySportModule[] = builtinModules): Promise<number> {
  const cases = sportCases(modules);
  for (const c of cases) {
    try {
      await fn(c);
    } catch (e) {
      throw named(c.key, e);
    }
  }
  return cases.length;
}
