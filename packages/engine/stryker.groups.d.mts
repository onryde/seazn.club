// Types for stryker.groups.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is TS7016).
// Exactly the five exports the .mjs has; test/stryker-groups.test.ts holds the two equal, and holds the group-name union
// below to the .mjs's keys, in order.
export declare const STRYKER_GROUPS: Record<
  | "competition-tiebreakers"
  | "competition-progression"
  | "competition"
  | "core"
  | "modules-io"
  | "modules-sport"
  | "modules-people"
  | "draws-bracket"
  | "draws-pairing"
  | "sports-cricket"
  | "sports-cricket-kernel-1"
  | "sports-cricket-kernel-2"
  | "sports-cricket-kernel-3"
  | "sports-cricket-kernel-4"
  | "sports-football-1"
  | "sports-football-2"
  | "sports-football-3"
  | "sports-period-1"
  | "sports-period-2"
  | "sports-period-3"
  | "sports-setbased-1"
  | "sports-setbased-2"
  | "sports-nested-1"
  | "sports-nested-2"
  | "sports-other-carrom"
  | "sports-other-generic"
  | "sports-other"
  | "probe",
  string[]
>;
export declare const STRYKER_EXCLUDED: Record<string, string>;
export declare const STRYKER_PLACEMENT_OUT_OF_SCOPE: Record<string, string>;
export declare const STRYKER_VITEST_WORKERS: number;
export declare function strykerConcurrency(o: { cores: number; memBytes: number; workersPerSandbox: number }): number;
