// scripts/smoke-manifest-diff.ts — proves a refactor of scripts/smoke.ts changed no suite. Pure, so its contract is
// unit-tested (scripts/__tests__/smoke-manifest-diff.test.ts). A manifest is what a smoke run reports per suite, in the
// order it ran them; two manifests match only if the names, the order and every check count are identical.
import { readFileSync } from "node:fs";

export type SmokeManifestEntry = { suite: string; checks: number };

export class SmokeManifestError extends Error {}

/** Every difference between `before` and `after`, one line each; empty means identical. An empty manifest on either side
 *  is an error, not a match: zero suites compared would pass vacuously. */
export function diffSmokeManifests(before: readonly SmokeManifestEntry[], after: readonly SmokeManifestEntry[]): string[] {
  if (before.length === 0 || after.length === 0) {
    throw new SmokeManifestError(`cannot compare an empty manifest (before: ${before.length} suites, after: ${after.length})`);
  }
  const out: string[] = [];
  const aftBy = new Map(after.map((e) => [e.suite, e.checks]));
  const befBy = new Map(before.map((e) => [e.suite, e.checks]));
  for (const e of before) if (!aftBy.has(e.suite)) out.push(`missing after: ${e.suite}`);
  for (const e of after) if (!befBy.has(e.suite)) out.push(`new after: ${e.suite}`);
  for (const e of before) {
    const n = aftBy.get(e.suite);
    if (n !== undefined && n !== e.checks) out.push(`checks changed: ${e.suite} ${e.checks} -> ${n}`);
  }
  const common = (xs: readonly SmokeManifestEntry[], other: Map<string, number>) => xs.map((e) => e.suite).filter((s) => other.has(s));
  const bo = common(before, aftBy);
  const ao = common(after, befBy);
  if (bo.join("\n") !== ao.join("\n")) out.push(`order changed: [${bo.join(", ")}] -> [${ao.join(", ")}]`);
  return out;
}

export function parseSmokeManifest(raw: string): SmokeManifestEntry[] {
  const v: unknown = JSON.parse(raw);
  const isEntry = (e: unknown): e is SmokeManifestEntry => {
    const r = e as Partial<Record<keyof SmokeManifestEntry, unknown>> | null;
    return !!r && typeof r.suite === "string" && typeof r.checks === "number" && Number.isInteger(r.checks) && r.checks >= 0;
  };
  const ok = Array.isArray(v) && v.every(isEntry);
  if (!ok) throw new SmokeManifestError("manifest must be an array of { suite: string, checks: non-negative integer }");
  const names = v.map((e) => e.suite);
  if (new Set(names).size !== names.length) throw new SmokeManifestError("manifest repeats a suite name");
  return v;
}

if (process.argv[1]?.endsWith("smoke-manifest-diff.ts")) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: smoke-manifest-diff.ts <before.json> <after.json>");
    process.exit(2);
  }
  try {
    const diffs = diffSmokeManifests(parseSmokeManifest(readFileSync(a, "utf8")), parseSmokeManifest(readFileSync(b, "utf8")));
    for (const d of diffs) console.log(d);
    console.log(diffs.length === 0 ? "smoke manifests identical" : `${diffs.length} difference(s)`);
    process.exit(diffs.length === 0 ? 0 : 1);
  } catch (e) {
    console.error("ERROR:", e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
