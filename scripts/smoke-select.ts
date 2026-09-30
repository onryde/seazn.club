// scripts/smoke-select.ts — which smoke suites a run executes. Pure, so its contract is unit-tested
// (scripts/__tests__/smoke-select.test.ts) rather than witnessed by a full local smoke run.
export type SmokeSelection = { mode: "all" } | { mode: "subset"; names: readonly string[] };

export class SmokeSelectionError extends Error {}

/** `raw` is `process.env.SMOKE_ONLY`. UNSET is the default and means `main()` runs exactly as before — CI never sets
 *  it, so CI's smoke is unchanged. SET means "only these": a set-but-empty value, a list of only commas, or any name
 *  outside `known` fails loudly rather than running fewer suites than the caller believes. */
export function selectSmokeSuites(known: readonly string[], raw: string | undefined): SmokeSelection {
  if (raw === undefined) return { mode: "all" };
  const names = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  if (names.length === 0) {
    throw new SmokeSelectionError(`SMOKE_ONLY is set but names no suite (${JSON.stringify(raw)}); unset it to run everything`);
  }
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length > 0) {
    throw new SmokeSelectionError(`SMOKE_ONLY names unknown suite(s): ${unknown.join(", ")}. Selectable: ${known.join(", ")}`);
  }
  return { mode: "subset", names };
}
