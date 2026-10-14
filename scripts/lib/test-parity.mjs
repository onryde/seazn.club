// scripts/lib/test-parity.mjs
// The same tests before and after a move, or every difference accounted for in a ledger (engine-split spec §5.4, D23, D32a).
// Collect ids with `vitest run --isolate -t "__parity_collect_only__" --reporter=json`: no test body runs, every collected test
// (it.skip / skipIf / todo included) is reported. `vitest list --json` drops skipped tests, so it is not used.
// ALWAYS pass `--isolate`, on BOTH sides. The engine's vitest config has `isolate: false`, and a test file that imports another test file
// (src/import/plan.property.test.ts imports ./plan.test.ts) then has that file's tests attributed to whichever worker reached it first: 19 ids
// move between the two files depending on scheduling, so a default collection reports "unaccounted" ids that are not gone (batch 1b review m4).
// Ids are a MULTISET: a test file may hold two tests with the same title (scripts/__tests__/mutate.test.ts and z3-retirement-drift.test.ts do).
// A duplicate that exists identically before and after is `both`, copy for copy; a change in the COUNT is before-only or after-only, one
// copy each, and a ledger entry accounts exactly one copy. The same id arriving from two reports of one side is still refused: that is
// an operator error (a report listed twice, or two roots whose relative paths collide), not a duplicate title.
// Exit codes: 0 everything accounted, 1 ids unaccounted, 2 invalid or vacuous input.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./main-module.ts";

const SEP = " › ";
const NEEDS_TARGET = new Set(["moved", "rehomed", "split", "rewritten"]);
const FATES = new Set([...NEEDS_TARGET, "added", "retired"]);

// How many copies of each id. A Set would collapse a duplicate into one entry, so a deleted twin would pass.
function counts(ids) {
  const n = new Map();
  for (const id of ids) n.set(id, (n.get(id) ?? 0) + 1);
  return n;
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
  const nBefore = counts(before);
  const nAfter = counts(after);
  // The k-th copy of an id is shared while k fits under the other side's count; the rest is that side's surplus.
  const split = (ids, other) => {
    const seen = new Map();
    const shared = [];
    const surplus = [];
    for (const id of ids) {
      const k = (seen.get(id) ?? 0) + 1;
      seen.set(id, k);
      (k <= (other.get(id) ?? 0) ? shared : surplus).push(id);
    }
    return { shared, surplus };
  };
  const { shared: both, surplus: onlyBefore } = split(before, nAfter);
  const { surplus: onlyAfter } = split(after, nBefore);
  const surplusBefore = counts(onlyBefore);
  const surplusAfter = counts(onlyAfter);
  // An id's surplus is on one side only (its counts differ one way), so the two maps never share a key. `claimed*` holds the copies a
  // ledger entry has accounted; an entry accounts ONE copy, so `claimedX(id) < surplusX(id)` says an unclaimed copy is left.
  const claimedBefore = new Map();
  const claimedAfter = new Map();
  const open = (claimed, surplus, id) => (claimed.get(id) ?? 0) < (surplus.get(id) ?? 0);
  const claim = (claimed, id) => claimed.set(id, (claimed.get(id) ?? 0) + 1);
  const problems = [];
  for (const e of ledger.entries) {
    if (NEEDS_TARGET.has(e.fate)) {
      // The id must really have gone and the target must really be new, else a deleted test passes as a move.
      // A target copy may be claimed once; a `split` is several entries with one id and different targets, so a source
      // copy that is already claimed is shared rather than refused.
      if (!e.to || !nAfter.has(e.to)) problems.push(`LEDGER-TARGET-MISSING ${e.to ?? "(none)"}`);
      else if (!surplusBefore.has(e.id) || !open(claimedAfter, surplusAfter, e.to)) problems.push(`LEDGER-INVALID ${e.id} -> ${e.to}`);
      else {
        claim(claimedBefore, e.id);
        claim(claimedAfter, e.to);
      }
    } else if (e.fate === "added" && open(claimedAfter, surplusAfter, e.id)) claim(claimedAfter, e.id);
    else if (e.fate === "retired" && open(claimedBefore, surplusBefore, e.id) && e.reason) claim(claimedBefore, e.id);
    else problems.push(`LEDGER-UNUSED ${e.id}`); // a stale or malformed entry accounts nothing
  }
  // Walk the surplus copies and spend each claim on one of them; what is left over is unaccounted.
  const left = (ids, claimed) => {
    const spent = new Map(claimed);
    return ids.filter((id) => {
      const n = spent.get(id) ?? 0;
      if (n > 0) spent.set(id, n - 1);
      return n === 0;
    });
  };
  const unaccounted = [...left(onlyBefore, claimedBefore), ...left(onlyAfter, claimedAfter)];
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
// One side is the reports it was given, summed. A duplicate title inside one report is a multiset entry, but an id that arrives from
// two reports is the same file listed twice or two roots whose relative paths collide: refuse it rather than count it as a twin.
const ids = (flag) => {
  const from = new Map();
  return pairs(flag).flatMap(({ file, root }) => {
    const got = testIds(JSON.parse(readFileSync(file, "utf8")), root);
    for (const id of new Set(got)) {
      if (from.has(id)) throw new Error(`duplicate test id across the reports of ${flag}: ${id} (in ${from.get(id)} and ${file})`);
      from.set(id, file);
    }
    return got;
  });
};

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
