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
export declare function exportSpecifiers(input: { manifest: { exports?: unknown }; sportDirs: readonly string[]; name?: string }): string[];
export declare function sportDirsOf(files: Iterable<string>): string[];
export declare function sourceSportDirs(engineDir: string): string[];
export declare function assertSameSet(label: string, actual: readonly string[], expected: readonly string[]): void;
export declare function declaredAppRoutes(files: readonly string[]): string[];
export declare function installedVersion(dir: string, name: string): string;
export declare function assertExactVersions(label: string, deps: Record<string, unknown> | undefined, opts?: { fileSpecs?: readonly string[] }): number;
export declare function installSignalCleanup(input: {
  dir: string;
  keep: () => boolean;
  before?: () => void;
  proc?: { once(signal: string, handler: () => void): unknown; exit(code: number): unknown };
}): void;
export declare function phoneSpecifiers(input: { subpaths: readonly string[]; manifest: { exports?: unknown }; sportDirs: readonly string[]; name?: string }): string[];
export declare function distTwin(srcPath: string): string;
export declare function engineDistPaths(paths: readonly string[], names: readonly string[]): string[];
export declare function assertBundleMatchesWalk(input: { bundle: readonly string[]; walked: readonly string[] }): number;
export declare function assertPhoneRuleGreen(phone: { walked: readonly string[]; violations: readonly { kind: string; file: string; detail: string }[] }): number;
