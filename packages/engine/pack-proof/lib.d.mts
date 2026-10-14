// Types for pack-proof/lib.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is TS7016).
// Exactly the exports the .mjs has.
export declare function assertOutsideRepo(dir: string, repoRoot: string): void;
export declare function requireChecked(name: string, n: unknown): number;
export declare function checkTarballExports(input: {
  manifest: { exports?: unknown };
  files: ReadonlySet<string>;
  expectedKeys: readonly string[];
  where?: string;
}): number;
export interface PnpmCandidate {
  label: string;
  command: string;
  prefix: readonly string[];
}
export declare function pickPnpm(
  pinned: string,
  candidates: readonly PnpmCandidate[],
  versionOf: (candidate: PnpmCandidate) => string,
): PnpmCandidate & { version: string };
export declare function devBundleModules(bundle: string): string[];
export declare function engineModules(paths: readonly string[], names: readonly string[]): string[];
export declare function runFixtures<Ctx>(
  names: readonly string[],
  fixtures: Readonly<Record<string, (ctx: Ctx) => Promise<number> | number>>,
  ctx: Ctx,
  log: (line: string) => void,
): Promise<{ results: { name: string; n: number }[]; failures: { name: string; error: Error }[] }>;
