// B06a Task 1 — the contracts the registry and (from Task 2) the shared
// runner both speak. Kept in their own module rather than in `registry.ts`
// so a suite module can import the types without importing the table that
// lists it, which would be a cycle.
import type { SuiteReport } from "../report.ts";
import type { TinySuiteInput } from "./tiny.ts";

export type SuiteKey = string;

/** What `bench.ts` hands a suite: the CLI's resolved configuration, the run
 *  identity, the SQL escape hatch and the optional test seams.
 *
 *  It is `TinySuiteInput` today because `_tiny` is the only suite and its
 *  input shape IS the general one — every field on it (`base`, `engine`,
 *  `keep`, `log`, `sql`, `reportDir`, `runId`, `cliEntry`, and the injected
 *  transports) is suite-agnostic. Task 2 narrows this to the pipeline's own
 *  input once the runner is extracted; until then an alias states the
 *  relationship honestly instead of duplicating twelve fields that would
 *  then drift. */
export type PackSuiteInput = TinySuiteInput;

/** One row of the registry: what the CLI needs to validate a `--suite` value,
 *  and what it needs to run it. */
export interface SuiteDefinition {
  readonly key: SuiteKey;
  /** Human-readable, for CLI errors and report headers. */
  readonly title: string;
  /** ABSOLUTE, resolved from the defining module — never `process.cwd()`. */
  readonly packPath: string;
  readonly run: (input: PackSuiteInput) => Promise<SuiteReport>;
}
