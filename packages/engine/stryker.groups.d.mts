// Types for stryker.groups.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is TS7016).
// Exactly the five exports the .mjs has; test/stryker-groups.test.ts holds the two equal, and holds the group-name union
// below to the .mjs's keys, in order.
export declare const STRYKER_GROUPS: Record<
  | "competition"
  | "core"
  | "modules"
  | "draws"
  | "sports-cricket"
  | "sports-cricket-kernel"
  | "sports-football"
  | "sports-period"
  | "sports-setbased"
  | "sports-nested"
  | "sports-other"
  | "probe",
  string[]
>;
export declare const STRYKER_EXCLUDED: Record<string, string>;
export declare const STRYKER_PLACEMENT_OUT_OF_SCOPE: Record<string, string>;
export declare const STRYKER_VITEST_WORKERS: number;
export declare function strykerConcurrency(o: { cores: number; memBytes: number; workersPerSandbox: number }): number;
