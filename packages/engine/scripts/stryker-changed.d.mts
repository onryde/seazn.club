// Types for scripts/stryker-changed.mjs (the engine tsconfig includes test/**, and a .ts test importing an untyped .mjs is TS7016).
export function parseMutateRanges(value: string, engine: string): string[];
export function rangesFromDiff(diff: string, onSkip?: (file: string, why: string) => void): string[];
export function rangesFromUntracked(files: { path: string; lines: number }[], onSkip?: (file: string, why: string) => void): string[];
export function snapshotForm(config: Record<string, unknown>, group: string, engine: string): Record<string, unknown>;
export function reportScopeProblems(report: unknown, ranges: string[]): string[];
export function rangesWithoutMutants(report: unknown, ranges: string[]): string[];
export interface ChangedRow { file: string; line: number; mutator: string; status: string; killedBy: string[] }
export function verdictsFromReport(report: unknown): { rows: ChangedRow[]; failures: number };
