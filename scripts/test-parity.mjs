// scripts/test-parity.mjs
// The same tests before and after a move, or every difference accounted for in a ledger (engine-split spec §5.4, D23, D32a).
// Collect ids with `vitest run -t "__parity_collect_only__" --reporter=json`: no test body runs, every collected test
// (it.skip / skipIf / todo included) is reported. `vitest list --json` drops skipped tests, so it is not used.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEP = " › ";
const NEEDS_TARGET = new Set(["moved", "rehomed", "split", "rewritten"]);

export function testIds(report, root) {
  const ids = [];
  for (const file of report?.testResults ?? []) {
    const rel = path.relative(root, file.name).split(path.sep).join("/");
    for (const a of file.assertionResults ?? []) ids.push([rel, ...(a.ancestorTitles ?? []), a.title].join(SEP));
  }
  if (ids.length === 0) throw new Error(`zero tests in report under ${root}: a parity check over nothing is vacuous`);
  return ids.sort();
}

export function diffIds(before, after, ledger) {
  const a = new Set(before);
  const b = new Set(after);
  const onlyBefore = before.filter((id) => !b.has(id));
  const onlyAfter = after.filter((id) => !a.has(id));
  const both = before.filter((id) => b.has(id));
  const accounted = new Set();
  const missingTargets = [];
  for (const e of ledger?.entries ?? []) {
    if (NEEDS_TARGET.has(e.fate)) {
      if (!e.to || !b.has(e.to)) { missingTargets.push(`LEDGER-TARGET-MISSING ${e.to ?? "(none)"}`); continue; }
      accounted.add(e.id);
      accounted.add(e.to);
    } else if (e.fate === "added" && onlyAfter.includes(e.id)) accounted.add(e.id);
    else if (e.fate === "retired" && onlyBefore.includes(e.id) && e.reason) accounted.add(e.id);
  }
  const unaccounted = [...[...onlyBefore, ...onlyAfter].filter((id) => !accounted.has(id)), ...missingTargets];
  return { onlyBefore, onlyAfter, both, unaccounted };
}

function pairs(flag) {
  const out = [];
  process.argv.forEach((v, i) => {
    if (v === flag) {
      const [file, root] = process.argv[i + 1].split("=");
      out.push({ file, root: path.resolve(root ?? ".") });
    }
  });
  if (out.length === 0) throw new Error(`missing ${flag} <report.json>=<root>`);
  return out;
}
const ids = (flag) => pairs(flag).flatMap(({ file, root }) => testIds(JSON.parse(readFileSync(file, "utf8")), root));

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const li = process.argv.indexOf("--ledger");
    const ledger = li === -1 ? { entries: [] } : JSON.parse(readFileSync(process.argv[li + 1], "utf8"));
    const d = diffIds(ids("--before"), ids("--after"), ledger);
    console.log(`before-only ${d.onlyBefore.length} · after-only ${d.onlyAfter.length} · both ${d.both.length} · unaccounted ${d.unaccounted.length}`);
    for (const id of d.unaccounted) console.log(`UNACCOUNTED ${id}`);
    process.exit(d.unaccounted.length === 0 ? 0 : 1);
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(2);
  }
}
