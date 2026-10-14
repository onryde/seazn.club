// scripts/test-parity.d.mts — declaration twin; scripts/__tests__ is type-checked by tsc -p tsconfig.tools-tests.json (ci.yml:123) [R6]
export interface ParityReport { numTotalTests?: number; numFailedTestSuites?: number; testResults?: { name: string; status?: string; assertionResults?: { ancestorTitles?: string[]; title: string; status?: string }[] }[] }
export interface LedgerEntry { id: string; fate: "moved" | "rehomed" | "split" | "rewritten" | "added" | "retired"; to?: string; reason: string }
export function testIds(report: ParityReport, root: string): string[];
export function diffIds(before: string[], after: string[], ledger: { entries: LedgerEntry[] }): { onlyBefore: string[]; onlyAfter: string[]; both: string[]; unaccounted: string[] };
