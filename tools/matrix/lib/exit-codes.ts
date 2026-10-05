// D8 (W1d item 6): one meaning per exit code across every tools/matrix CLI. Each
// CLI's header comment states its own codes in these words; exit-codes.test.ts
// reads every header and holds it to this table.
//
// Before W1d the CLIs disagreed: parity.ts and findings-table.ts filed unreadable
// input under 3 (merge-shards.ts, render.ts and lock-append-only.ts filed it under
// 2), and findings-table.ts and draw-counts.ts filed a REFUSAL under 1, the code a
// verdict uses. A workflow that switches on the code then read a bad file as a
// crash, or a refusal as drift.
//
// The codes are per CLI in WHAT they detect (run.ts's 1 is "zero cases", gen-catalogue's
// is "drift"), and shared in what KIND of thing they are: 0 a verdict or data was
// written; 1 a negative signal about the thing judged; 2 the CLI refused to judge;
// 3 it started and could not finish.
export const EXIT_CODES = Object.freeze({
  0: "done — a verdict or data was written",
  1: "a negative signal: a difference, drift, zero cases, a regression, a harness fault",
  2: "refused, nothing written: usage, unreadable input, a refused precondition",
  3: "aborted after start, or a crash while loading (through the package script's preload)",
} as const);
