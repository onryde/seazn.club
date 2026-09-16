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

// ---------------------------------------------------------------------------
// B07a T7 — HOW a division is played
// ---------------------------------------------------------------------------

/**
 * The three write paths a division's streams can take.
 *
 * - `"api"` — one `POST /fixtures/{id}/events` per event, strictly sequential
 *   per fixture. The path a live scorer's device actually uses.
 * - `"import"` — one chunked `POST /divisions/{id}/events/import`. The bulk
 *   path, and the only one that exercises the importer's own idempotency and
 *   cap handling.
 * - `"tap"` — played through the UI by a real scorer driver. NO writer exists
 *   until Task 10; the runner refuses it loudly rather than quietly falling
 *   back to a write path nobody asked for, because a silent fallback here
 *   would be indistinguishable from the dispatch never being reached at all.
 */
export type PlayMode = "tap" | "api" | "import";

/**
 * The one field `playModeFor` reads, declared on its own so that BOTH the
 * registry row (`SuiteDefinition` below) and the runner's own options
 * (`RunPackSuiteOptions`, in `run-suite.ts`) can satisfy it without either
 * module importing the other — the same cycle this file's header exists to
 * avoid.
 */
export interface PlayDeclaration {
  /** Keyed by DIVISION ref. A division the map does not name falls through to
   *  the positional default — see `playModeFor`. */
  readonly play?: Readonly<Record<string, PlayMode>>;
}

/**
 * How a suite plays the division at `index`, in `plan.divisions` order.
 *
 * **The default is the load-bearing half.** Before this task the write path
 * was positional and implicit: `plan.divisions[0]` folded through the
 * single-event scoring route and every other division through the batch-import
 * route. Two live exercises depend on that split staying exactly where it is —
 * `_RULES.md` §3 keeps one suite on the single-POST path, and the import path
 * needs a live subject of its own — so the default reproduces it VERBATIM
 * rather than approximately. `_tiny` (`d-tiny` -> api, `d-badminton`/
 * `d-registration`/`d-tiebreak` -> import) and suite 11 (`d-worlds` -> api,
 * `d-womens` -> import) declare nothing and are therefore unchanged.
 *
 * A declaration wins over the position in BOTH directions: it can move the
 * first division off the single-event route and a later one onto it.
 */
export function playModeFor(
  definition: PlayDeclaration,
  divisionRef: string,
  index: number,
): PlayMode {
  const declared = definition.play?.[divisionRef];
  if (declared !== undefined) return declared;
  // The pre-B07a behaviour, kept verbatim: division 0 single-POSTs (the path
  // live scoring uses), every other division imports.
  return index === 0 ? "api" : "import";
}

/** One row of the registry: what the CLI needs to validate a `--suite` value,
 *  and what it needs to run it. */
export interface SuiteDefinition extends PlayDeclaration {
  readonly key: SuiteKey;
  /** Human-readable, for CLI errors and report headers. */
  readonly title: string;
  /** ABSOLUTE, resolved from the defining module — never `process.cwd()`. */
  readonly packPath: string;
  /**
   * B07a T7 fix round 1 (I1) — `run` takes the row's OWN `play` declaration
   * as an explicit second parameter, rather than trusting an entry-point
   * function to read `this.play` off the row it was defined on (it can't;
   * `runTinySuite`/`runSuite11` are free functions, not methods). Every
   * caller of `.run` — `bench.ts`'s forwarding seam is the one production
   * caller — must pass `definition.play` through, or a suite's declared
   * play mode never reaches `runPackSuite`'s dispatch (the exact defect this
   * parameter exists to close; see `run-suite.ts`'s `RunPackSuiteOptions`
   * and `playModeFor`).
   */
  readonly run: (input: PackSuiteInput, play?: PlayDeclaration["play"]) => Promise<SuiteReport>;
}
