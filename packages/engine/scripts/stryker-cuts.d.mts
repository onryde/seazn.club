// Types for scripts/stryker-cuts.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is TS7016).
// Exactly the exports the .mjs has; test/stryker-cuts.test.ts holds the two equal.
/** A top-level statement of a source file: the names it declares and its first and last line (1-based). */
export interface TopLevelStatement { index: number; names: string[]; startLine: number; endLine: number }
export declare const TO_END_OF_FILE: number;
export declare function topLevelStatements(text: string): TopLevelStatement[];
export declare function resolveSplit(text: string, anchors: readonly string[], label?: string): [number, number][];
export declare function resolveEntries(entries: readonly string[], splits: Record<string, readonly string[]>, readText: (file: string) => string): string[];
export declare function resolveGroup(group: string, cwd?: string): string[];
export declare function statementMutants(statements: readonly TopLevelStatement[], startLines: readonly number[]): number[];
export declare function planSplit(o: { weights: readonly number[]; cutable: readonly boolean[]; parts: number; extra?: number }): { cuts: number[]; sizes: number[]; max: number } | null;
