// Hand-parsed workflow text, shared by ci-wiring.test.ts (ci.yml) and matrix-workflow.test.ts (matrix-truth.yml).
// There is no YAML dependency at the repo root and none is added (W1d review I8), so the parse is strict about the ONE
// shape it accepts: a reshaped step or job reds a test here rather than parsing into something vacuous.
// Moved (not copied) out of ci-wiring.test.ts in W1d Task 9, with `jobsOf` and `stepHeads` new.

export const indentOf = (line: string): number => line.length - line.trimStart().length;

/** A named step as GitHub sees it: its own keys, and its `run: |` block dedented. It throws unless exactly ONE
 *  `      - name: <name>` line exists in `text` — so a workflow whose jobs share a step name (the visibility guard) calls
 *  it on ONE job's text (`jobsOf`), never on the whole file. */
export function stepOf(text: string, name: string): { keys: string[]; body: string; script: string | null } {
  const head = `      - name: ${name}`;
  const lines = text.split("\n");
  const heads = lines.flatMap((l, i) => (l === head ? [i] : []));
  if (heads.length !== 1) throw new Error(`expected exactly one "${head.trim()}" line, found ${heads.length}`);
  const start = heads[0];
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) >= 8)) end++;
  const body = lines.slice(start + 1, end);
  const keys = ["name", ...body.flatMap((l) => /^ {8}([a-z][\w-]*):/.exec(l)?.slice(1) ?? [])];
  const runAt = body.indexOf("        run: |");
  if (runAt === -1) return { keys, body: body.join("\n"), script: null };
  const script: string[] = [];
  for (const l of body.slice(runAt + 1)) {
    if (l.trim() !== "" && indentOf(l) < 10) break;
    script.push(l.slice(10));
  }
  return { keys, body: body.join("\n"), script: script.join("\n").trimEnd() + "\n" };
}

/** A job-level (4-space) block of a job's YAML: its key line and every deeper line after it, or "" when the job has no
 *  such key. */
export function jobBlock(lines: string[], key: string): string {
  const at = lines.indexOf(`    ${key}:`);
  if (at === -1) return "";
  let end = at + 1;
  while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > 4)) end++;
  return lines.slice(at, end).join("\n");
}

/** Every job of a workflow: its name, mapped to its text (the `  <name>:` key line through the line before the next
 *  job). The jobs are the lines under `jobs:`; a job key is two spaces, a lower-case name and a colon. It throws on a
 *  workflow with no `jobs:` or no job, and on a repeated name (YAML would keep the last and drop the first silently). */
export function jobsOf(text: string): Record<string, string> {
  const lines = text.split("\n");
  const at = lines.indexOf("jobs:");
  if (at === -1) throw new Error("no `jobs:` key");
  const rest = lines.slice(at + 1);
  const stop = rest.findIndex((l) => l !== "" && !l.startsWith(" ") && !l.startsWith("#"));
  const body = stop === -1 ? rest : rest.slice(0, stop);
  const starts = body.flatMap((l, i) => (/^ {2}[a-z][\w-]*:$/.test(l) ? [i] : []));
  if (starts.length === 0) throw new Error("`jobs:` holds no job");
  const out: Record<string, string> = {};
  starts.forEach((from, n) => {
    const name = body[from].trim().slice(0, -1);
    if (Object.hasOwn(out, name)) throw new Error(`job "${name}" is declared twice`);
    out[name] = body.slice(from, starts[n + 1] ?? body.length).join("\n");
  });
  return out;
}

/** Every step line of a job, in order, named or not (`- uses: actions/checkout@v5` included): the `      - ` lines. It
 *  throws on a job with none. */
export function stepHeads(jobText: string): string[] {
  const heads = jobText.split("\n").filter((l) => l.startsWith("      - "));
  if (heads.length === 0) throw new Error("the job holds no step");
  return heads;
}

/** The `RUN_ID:` template the shard job's "Run the shard" step builds its run id from, as the workflow spells it. The
 *  tests that pin what the run id must survive (its own slug, run-sample's report directory) read it here, from the
 *  workflow text, and never from the code under test. */
export function runIdTemplate(workflow: string): string {
  const shard = jobsOf(workflow).shard;
  if (shard === undefined) throw new Error("the workflow has no `shard` job");
  const m = /^ {10}RUN_ID: (\S.*\S)$/m.exec(stepOf(shard, "Run the shard").body);
  if (m === null) throw new Error("the `Run the shard` step sets no RUN_ID");
  return m[1];
}

/** `template` with the GitHub expressions the run id is built from filled in: the run id, the attempt and the matrix job id. */
export function fillRunId(template: string, v: { runId: string; attempt: string; matrixId: string }): string {
  return template.replace("${{ github.run_id }}", v.runId).replace("${{ github.run_attempt }}", v.attempt).replace("${{ matrix.id }}", v.matrixId);
}
