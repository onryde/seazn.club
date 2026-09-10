// B06a Task 1 — the one table that answers both "is this a known suite?" and
// "what runs it?". `bench.ts` used to answer those separately (a `KNOWN_SUITES`
// literal and an `if (key === "_tiny")`), which is two places to edit per pack
// and two ways for them to disagree.
//
// B06b adds suite 11 by adding a row here. Nothing in `bench.ts` changes.
import { TINY_PACK_PATH, runTinySuite } from "./tiny.ts";
import type { SuiteDefinition, SuiteKey } from "./types.ts";

const DEFINITIONS: readonly SuiteDefinition[] = [
  {
    key: "_tiny",
    title: "Tiny proof suite",
    packPath: TINY_PACK_PATH,
    run: runTinySuite,
  },
];

export const SUITE_REGISTRY: ReadonlyMap<SuiteKey, SuiteDefinition> = new Map(
  DEFINITIONS.map((d) => [d.key, d] as const),
);

/** The CLI's known-suite list — insertion order, so `--help` and error text
 *  read in programme order rather than alphabetically. */
export function suiteKeys(): readonly SuiteKey[] {
  return [...SUITE_REGISTRY.keys()];
}

/** `undefined` rather than a throw: the caller decides whether an unknown key
 *  is a parse-time error (it is, in `parseCliArgs`) or something softer. */
export function lookupSuite(key: string): SuiteDefinition | undefined {
  return SUITE_REGISTRY.get(key);
}
