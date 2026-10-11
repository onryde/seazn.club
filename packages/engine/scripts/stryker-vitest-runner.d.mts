// Types for scripts/stryker-vitest-runner.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is
// TS7016). Exactly the exports the .mjs has.
/** A vitest task as the decorator reads it: a file (it has `filepath`), a suite or a test, each with its own result. */
export interface VitestTaskLike {
  type?: string;
  name?: string;
  result?: { state?: string; errors?: { message?: string }[] };
  tasks?: VitestTaskLike[];
}
export interface VitestFileLike extends VitestTaskLike {
  filepath: string;
}
export declare const RUNNER_NAME: string;
export declare const DRY_RUN_TESTS_FILE: string;
export declare const FILE_FAILED_TEST_NAME: string;
export declare const FILE_FAILED_REASON: string;
export declare function filesFailedAsAWhole(files: readonly VitestFileLike[]): VitestFileLike[];
export declare function describeFailures(failed: readonly VitestFileLike[], cwd: string): string;
export declare function vitestRunnerOf<P extends { kind: string; name: string }>(plugins: readonly P[]): P;
export declare class FileFailureKills {
  constructor(inner: unknown, cwd?: string);
  capabilities(): unknown;
  init(): Promise<void>;
  dispose(): Promise<void>;
  /** The inner runner's dry run; an error naming the files when one failed as a whole; on a complete run, writes the map. */
  dryRun(options: unknown): Promise<unknown>;
  /** The inner runner's verdict, a `survived` turned `killed` when a test file, or a suite or hook in it, failed as a whole. */
  mutantRun(options: unknown): Promise<unknown>;
  /** The dry run's map in the sandbox (absolute test-file path -> first test id); no map is `{}`, any other read failure throws. */
  dryRunTests(): Record<string, string>;
}
export declare const strykerPlugins: { kind: string; name: string; factory: ((injector: unknown) => FileFailureKills) & { inject: readonly string[] } }[];
