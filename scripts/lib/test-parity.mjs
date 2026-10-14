// scripts/lib/test-parity.mjs
// The same tests before and after a move, or every difference accounted for in a ledger (engine-split spec §5.4, D23, D32a).
// Collect ids with `vitest run --isolate -t "__parity_collect_only__" --reporter=json`: no test body runs, every collected test
// (it.skip / skipIf / todo included) is reported. `vitest list --json` drops skipped tests, so it is not used.
// ALWAYS pass `--isolate`, on BOTH sides. The engine's vitest config has `isolate: false`, and a test file that imports another test file
// (src/import/plan.property.test.ts imports ./plan.test.ts) then has that file's tests attributed to whichever worker reached it first: 19 ids
// move between the two files depending on scheduling, so a default collection reports "unaccounted" ids that are not gone (batch 1b review m4).
// Exit codes: 0 everything accounted, 1 ids unaccounted, 2 invalid or vacuous input.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./main-module.ts";

const SEP = " › ";
const NEEDS_TARGET = new Set(["moved", "rehomed", "split", "rewritten"]);
const FATES = new Set([...NEEDS_TARGET, "added", "retired"]);

// Ids that occur more than once. A duplicate would collapse into one entry in a Set, so a deleted twin would pass.
function duplicates(ids) {
  const seen = new Set();
  const dup = new Set();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

export function testIds(report, root) {
  const files = report?.testResults ?? [];
  // A file that failed to collect lists fewer tests than it holds (or none), and the rest of the report still looks healthy.
  const failed = files.filter((f) => f.status === "failed").map((f) => f.name);
  const failedSuites = report?.numFailedTestSuites ?? 0;
  if (failed.length > 0 || failedSuites > 0) {
    throw new Error(`failed collection in report under ${root}: ${failedSuites} failed suite(s); failed files: ${failed.join(", ") || "(none named)"}`);
  }
  const ids = [];
  for (const file of files) {
    const rel = path.relative(root, file.name).split(path.sep).join("/");
    for (const a of file.assertionResults ?? []) ids.push([rel, ...(a.ancestorTitles ?? []), a.title].join(SEP));
  }
  if (ids.length === 0) throw new Error(`zero tests in report under ${root}: a parity check over nothing is vacuous`);
  const dup = duplicates(ids);
  if (dup.length > 0) throw new Error(`duplicate test id in report under ${root}: ${dup.join("; ")}`);
  return ids.sort();
}

// A ledger that is not `{ entries: [{ id, fate, ... }] }` is a refusal, never an empty ledger.
function checkLedger(ledger) {
  if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger)) throw new Error(`ledger must be an object { "entries": [...] }, got ${JSON.stringify(ledger) ?? String(ledger)}`);
  if (!Array.isArray(ledger.entries)) throw new Error(`ledger must hold an "entries" array`);
  ledger.entries.forEach((e, i) => {
    if (e === null || typeof e !== "object" || Array.isArray(e)) throw new Error(`ledger entry #${i} is not an object`);
    if (typeof e.id !== "string" || e.id === "") throw new Error(`ledger entry #${i} has no id`);
    if (!FATES.has(e.fate)) throw new Error(`ledger entry #${i} (${e.id}) has unknown fate ${JSON.stringify(e.fate) ?? "undefined"}; want one of ${[...FATES].join(", ")}`);
  });
}

export function diffIds(before, after, ledger) {
  checkLedger(ledger);
  for (const [side, ids] of [["before", before], ["after", after]]) {
    const dup = duplicates(ids);
    if (dup.length > 0) throw new Error(`duplicate test id in ${side}: ${dup.join("; ")}`);
  }
  const a = new Set(before);
  const b = new Set(after);
  const onlyBefore = before.filter((id) => !b.has(id));
  const onlyAfter = after.filter((id) => !a.has(id));
  const both = before.filter((id) => b.has(id));
  const isOnlyBefore = new Set(onlyBefore);
  const isOnlyAfter = new Set(onlyAfter);
  // onlyBefore and onlyAfter are disjoint, so one set holds what the ledger has accounted on either side.
  const accounted = new Set();
  const problems = [];
  for (const e of ledger.entries) {
    if (NEEDS_TARGET.has(e.fate)) {
      // The id must really have gone and the target must really be new, else a deleted test passes as a move.
      // A target may be claimed once; a `split` is several entries with one id and different targets.
      if (!e.to || !b.has(e.to)) problems.push(`LEDGER-TARGET-MISSING ${e.to ?? "(none)"}`);
      else if (!isOnlyBefore.has(e.id) || !isOnlyAfter.has(e.to) || accounted.has(e.to)) problems.push(`LEDGER-INVALID ${e.id} -> ${e.to}`);
      else { accounted.add(e.id); accounted.add(e.to); }
    } else if (e.fate === "added" && isOnlyAfter.has(e.id) && !accounted.has(e.id)) accounted.add(e.id);
    else if (e.fate === "retired" && isOnlyBefore.has(e.id) && !accounted.has(e.id) && e.reason) accounted.add(e.id);
    else problems.push(`LEDGER-UNUSED ${e.id}`); // a stale or malformed entry accounts nothing
  }
  const unaccounted = [...onlyBefore, ...onlyAfter].filter((id) => !accounted.has(id));
  return { onlyBefore, onlyAfter, both, unaccounted: [...unaccounted, ...problems] };
}

function valueOf(flag, i) {
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

function pairs(flag) {
  const out = [];
  process.argv.forEach((v, i) => {
    if (v !== flag) return;
    const arg = valueOf(flag, i);
    const eq = arg.lastIndexOf("="); // a file path may hold an `=`; the root never does
    const file = eq === -1 ? "" : arg.slice(0, eq);
    const root = eq === -1 ? "" : arg.slice(eq + 1);
    if (!file || !root) throw new Error(`${flag} wants <report.json>=<root>, got "${arg}"`);
    out.push({ file, root: path.resolve(root) });
  });
  if (out.length === 0) throw new Error(`missing ${flag} <report.json>=<root>`);
  return out;
}
const ids = (flag) => pairs(flag).flatMap(({ file, root }) => testIds(JSON.parse(readFileSync(file, "utf8")), root));

if (isMainModule(import.meta.url)) {
  try {
    const li = process.argv.indexOf("--ledger");
    const ledger = li === -1 ? { entries: [] } : JSON.parse(readFileSync(valueOf("--ledger", li), "utf8"));
    const d = diffIds(ids("--before"), ids("--after"), ledger);
    console.log(`before-only ${d.onlyBefore.length} · after-only ${d.onlyAfter.length} · both ${d.both.length} · unaccounted ${d.unaccounted.length}`);
    for (const id of d.unaccounted) console.log(`UNACCOUNTED ${id}`);
    process.exitCode = d.unaccounted.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exitCode = 2;
  }
}
