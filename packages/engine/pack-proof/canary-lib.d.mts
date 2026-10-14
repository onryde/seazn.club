// Types for pack-proof/canary-lib.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is TS7016).
// Exactly the exports the .mjs has.
export declare const CANARY_BASE: "0.0.0";
export declare function canaryVersion(input: { runNumber: unknown; sha: unknown }): string;
export declare function assertCanaryVersion(version: unknown): string;
export declare function withVersion(manifestText: string, version: string): string;
export declare function readTarball(tgz: string): { manifest: { name?: string; version?: string; exports?: unknown }; files: Set<string> };
export declare function checkCanaryTarball(input: {
  manifest: { name?: string; version?: string; exports?: unknown };
  files: Iterable<string>;
  expectedKeys: readonly string[];
  name: string;
  version: string;
}): { files: number; distFiles: number; exportTargets: number };
export interface CanaryIo {
  out(line: string): void;
  err(line: string): void;
}
export declare function main(argv: readonly string[], env: Record<string, string | undefined>, io: CanaryIo, options: { manifestFile: string }): number;
