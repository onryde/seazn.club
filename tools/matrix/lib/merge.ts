// W1d D5: N shard results of ONE layer back into one run, in plan order. Every
// way a shard can be short is refused by name (Review Focus 1, R25, class 1):
// a shard that is absent, failed (exit.txt missing or not 0), empty, aborted,
// short of its stripe, duplicated, from another commit / plan / scope / layer /
// grid / plan size, or carrying a secret. Nothing is merged around a hole.
//
// The refusals, each an Error whose `name` is its own:
//   ShardMissing    no shard at all, or a stripe that holds items and was not given;
//   ShardFailed     exit.txt absent (the shard died before writing it) or not 0;
//   ShardEmpty      no results.json, or one that holds no case;
//   ShardInvalid    results the schema refuses, or a case marked planned that is not
//                   in the planned shape (a driven result relabelled, class 6);
//   ShardSecret     a secret-shaped string in a shard (by count, never by value);
//   ShardAborted    the shard's run aborted: its cases are a partial grid;
//   ShardMismatch   not a shard (no shard header), or shards that disagree on the
//                   commit, plan, scope, layer, driver, grid, shard count or plan
//                   size, or a case whose layer is not its run's;
//   ShardDuplicate  one shard index given twice;
//   ShardSize       a shard whose case count is not its stripe's;
//   CaseCollision   one case id in two places of the merged plan.
// Each refusal names the shard (its `name`) first, so an operator reads which
// directory to look at.
import { ZodError } from "zod";
import { findSecrets } from "./redact.ts";
import { isPlannedShape, parseResults, stringsIn, type AnyRunResults, type CaseResult, type RunResults } from "./results.ts";
import { stripeSize } from "./shard.ts";

/** A shard as the merge receives it: where it came from, the text of its exit.txt
 *  (null when the file is absent), and its results.json parsed but unvalidated
 *  (null when absent). */
export type ShardInput = { name: string; exit: string | null; results: unknown };

function refusal(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

/** The run-level fields every shard of one run must agree on. `scope` is
 *  optional in the schema, so shards that all lack it agree, and one that has it
 *  against one that lacks it disagree (T3-SCOPE). */
const SAME = ["harnessCommit", "layer", "driver", "plan", "scope"] as const;

/** The schema's refusal as a named one that fits a CLI line: the first three issues, by path. */
function invalid(who: string, e: ZodError): Error {
  const shown = e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return refusal("ShardInvalid", `${who}: not a results.json this harness wrote — ${shown}${e.issues.length > 3 ? `; and ${e.issues.length - 3} more` : ""}`);
}

/** A shard's results, parsed: a v3 run with a shard header, or the named reason it is not. */
function parseShardRun(name: string, results: unknown): RunResults & { shard: NonNullable<RunResults["shard"]> } {
  let parsed: AnyRunResults;
  try {
    parsed = parseResults(results);
  } catch (e) {
    if (e instanceof ZodError) throw invalid(name, e);
    throw e;
  }
  if (parsed.schemaVersion !== 3) throw refusal("ShardMismatch", `${name}: not a shard (a v${parsed.schemaVersion} run, which has no shard header)`);
  if (parsed.shard === undefined) throw refusal("ShardMismatch", `${name}: not a shard (no shard header${parsed.shards === undefined ? "" : `; it is itself the merge of ${parsed.shards} shards`})`);
  return { ...parsed, shard: parsed.shard };
}

export function mergeShards(inputs: readonly ShardInput[], runId: string): { merged: RunResults; checked: number } {
  if (inputs.length === 0) throw refusal("ShardMissing", "zero shards given — nothing to merge (vacuous)");
  for (const i of inputs) {
    if (i.exit === null) throw refusal("ShardFailed", `${i.name}: no exit.txt — the shard died before writing its exit code`);
    if (i.exit.trim() !== "0") throw refusal("ShardFailed", `${i.name}: exit ${i.exit.trim() === "" ? "(empty)" : i.exit.trim()} (run.ts: 1 zero cases, 2 refused, 3 aborted)`);
    if (i.results === null || i.results === undefined) throw refusal("ShardEmpty", `${i.name}: no results.json`);
    // The RAW strings, never the JSON text: JSON.stringify spells a newline `\n`, which erases the \b
    // in front of a secret that starts a line (writeResults' review I1).
    const leaks = stringsIn(i.results).flatMap((s) => findSecrets(s));
    if (leaks.length > 0) throw refusal("ShardSecret", `${i.name}: ${leaks.length} secret-shaped string(s) — refused before anything is written`);
  }
  const shards = inputs.map((i) => ({ name: i.name, r: parseShardRun(i.name, i.results) }));
  const first = shards[0].r;
  const { of, planSize } = first.shard;
  const byIndex = new Map<number, RunResults>();
  for (const { name, r } of shards) {
    if (r.aborted !== undefined) throw refusal("ShardAborted", `${name}: aborted at ${r.aborted.turn}`);
    for (const k of SAME) {
      if (JSON.stringify(r[k]) !== JSON.stringify(first[k])) throw refusal("ShardMismatch", `${name}: ${k} ${JSON.stringify(r[k]) ?? "(absent)"} ≠ ${JSON.stringify(first[k]) ?? "(absent)"} of ${shards[0].name}`);
    }
    if (JSON.stringify(r.grid) !== JSON.stringify(first.grid) || r.shard.of !== of || r.shard.planSize !== planSize) {
      throw refusal("ShardMismatch", `${name}: grid, shard count or plan size differs from ${shards[0].name}`);
    }
    if (byIndex.has(r.shard.index)) throw refusal("ShardDuplicate", `${name}: shard ${r.shard.index}/${of} given twice`);
    if (r.cases.length === 0) throw refusal("ShardEmpty", `${name}: zero cases`);
    const want = stripeSize(planSize, r.shard);
    if (r.cases.length !== want) throw refusal("ShardSize", `${name}: ${r.cases.length} cases, its stripe of ${planSize} holds ${want}`);
    for (const c of r.cases) {
      if (c.layer !== r.layer) throw refusal("ShardMismatch", `${name}: case ${c.caseId} is ${c.layer} in an ${r.layer} run`);
      // T2-PRED: a marker is a claim about the case's shape, and this is the one predicate that judges it.
      if (c.planned === true && !isPlannedShape(c)) {
        throw refusal("ShardInvalid", `${name}: case ${c.caseId} is marked planned but is ${c.state} with ${c.checks.length} check(s) — a driven result relabelled as planned`);
      }
    }
    byIndex.set(r.shard.index, r);
  }
  for (let k = 1; k <= of; k++) {
    if (!byIndex.has(k) && stripeSize(planSize, { index: k, of }) > 0) throw refusal("ShardMissing", `shard ${k}/${of} is absent`);
  }
  // Plan order: item i is the (i div N)th case of shard (i mod N) + 1 — the stripe's own inverse.
  const cases: CaseResult[] = [];
  const at = new Map<string, number>();
  for (let i = 0; i < planSize; i++) {
    const k = (i % of) + 1;
    const c = (byIndex.get(k) as RunResults).cases[Math.floor(i / of)];
    const earlier = at.get(c.caseId);
    if (earlier !== undefined) throw refusal("CaseCollision", `case ${c.caseId} appears twice: in shard ${(earlier % of) + 1}/${of} and in shard ${k}/${of}`);
    at.set(c.caseId, i);
    cases.push(c);
  }
  const all = [...byIndex.values()];
  const maxWorkers = Math.max(...all.map((r) => r.workers ?? 1));
  // Written out, never `...first` minus a few keys: a header field added to the schema later must be
  // carried or dropped HERE, on purpose (merge.test.ts holds the list to the schema's own keys).
  const merged: RunResults = {
    schemaVersion: 3, runId, harnessCommit: first.harnessCommit,
    startedAt: all.map((r) => r.startedAt).sort()[0],
    finishedAt: all.map((r) => r.finishedAt).sort().at(-1) as string,
    grid: first.grid, layer: first.layer, driver: first.driver,
    ...(first.plan === undefined ? {} : { plan: first.plan }),
    ...(first.scope === undefined ? {} : { scope: first.scope }),
    shards: of,
    ...(maxWorkers > 1 ? { workers: maxWorkers } : {}),
    cases,
  };
  let valid: RunResults;
  try {
    valid = parseResults(merged) as RunResults;
  } catch (e) {
    if (e instanceof ZodError) throw invalid("the merge", e);
    throw e;
  }
  return { merged: valid, checked: cases.length };
}
