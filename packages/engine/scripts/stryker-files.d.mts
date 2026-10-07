// Types for scripts/stryker-files.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is TS7016).
// Exactly the exports the .mjs has.
export declare function globMatches(glob: string, file: string): boolean;
export declare function filesOf(entries: readonly string[], root: string): string[];
