// Types for scripts/stryker-vitest-runner.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is
// TS7016). Exactly the exports the .mjs has.
export interface VitestFileLike {
  filepath: string;
  result?: { state?: string; errors?: { message?: string }[] };
}
export declare const RUNNER_NAME: string;
export declare const DRY_RUN_TESTS_FILE: string;
export declare const FILE_FAILED_TEST_NAME: string;
export declare const FILE_FAILED_REASON: string;
export declare function filesFailedAsAWhole(files: readonly VitestFileLike[]): VitestFileLike[];
export declare function describeFailures(failed: readonly VitestFileLike[], cwd: string): string;
export declare class FileFailureKills {
  constructor(inner: unknown, cwd?: string);
}
export declare const strykerPlugins: { kind: string; name: string; factory: ((injector: unknown) => FileFailureKills) & { inject: readonly string[] } }[];
