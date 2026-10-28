// scripts/smoke-manifest.ts — records how many checks each suite of a smoke run made, in the order it ran them, so a refactor
// of scripts/smoke.ts can be diffed against a baseline (scripts/smoke-manifest-diff.ts). Pure, so its contract is unit-tested
// (scripts/__tests__/smoke-manifest.test.ts): the caller hands in `total` (checks made so far) and owns writing the result.
import { SmokeManifestError, type SmokeManifestEntry } from "./smoke-manifest-diff.ts";

/** The entry `entries()` appends for checks made outside any `run`; a suite may not take the name. */
export const INLINE_SUITE = "(inline)";

export function createManifestRecorder(total: () => number) {
  const recorded: SmokeManifestEntry[] = [];
  const taken = new Set<string>([INLINE_SUITE]);
  let running: string | undefined;

  /** Runs `fn` as the suite `name` and records `total()` after minus before, also when `fn` throws (then rethrows). A repeated
   *  name is refused before `fn` runs: the diff parses a manifest that repeats a suite as an error. A run started while another
   *  is in flight is refused too, since both would count the same checks and `(inline)` would go negative. */
  async function run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (taken.has(name)) throw new SmokeManifestError(`suite name used twice (or reserved): ${name}`);
    if (running !== undefined) throw new SmokeManifestError(`suite ${name} started inside ${running}: runs must not overlap`);
    taken.add(name);
    running = name;
    const before = total();
    try {
      return await fn();
    } finally {
      recorded.push({ suite: name, checks: total() - before });
      running = undefined;
    }
  }

  /** Each suite in call order, then `(inline)`: everything `total()` counted that no suite did. Always present, even at 0. */
  function entries(): SmokeManifestEntry[] {
    const inSuites = recorded.reduce((sum, e) => sum + e.checks, 0);
    return [...recorded.map((e) => ({ ...e })), { suite: INLINE_SUITE, checks: total() - inSuites }];
  }

  return { run, entries };
}
