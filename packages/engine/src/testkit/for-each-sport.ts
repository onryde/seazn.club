// R26: tests that sweep sports walk the registry through here — in the
// registry's own order, which is wave order (never sort it; AGENTS.md class
// 18). An empty registry is a refusal, not a vacuous pass (R25). Pure: no
// node:fs, so it belongs in the published testkit barrel.
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";

export interface SportCase { readonly key: string; readonly index: number; readonly module: AnySportModule }

export class EmptySportRegistry extends Error {
  constructor() {
    super("forEachSport: the sport registry is empty — a sweep over nothing proves nothing (R25)");
    this.name = "EmptySportRegistry";
  }
}

/** One case per module, in the list's own order; `index` is its position. */
export function sportCases(modules: readonly AnySportModule[] = builtinModules): SportCase[] {
  if (modules.length === 0) throw new EmptySportRegistry();
  return modules.map((module, index) => ({ key: module.key, index, module }));
}

/** Runs fn once per sport, in registry order, and returns how many it
 *  visited. A throw is rethrown naming the sport, with the original as cause. */
export function forEachSport(fn: (c: SportCase) => void, modules: readonly AnySportModule[] = builtinModules): number {
  const cases = sportCases(modules);
  for (const c of cases) {
    try {
      fn(c);
    } catch (e) {
      throw new Error(`sport ${c.key}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  return cases.length;
}
