// Where the product's stage-batch gates live, read from its own source (batch-6 fix, I-4): W2c Task 13 fix round 1
// (838b02485e) moved the entitlement gates out of `createStages`' body into `assertStageBatchGates`, which `createStages`
// and `replaceStages` BOTH call before they write. The scans that read the gates (denied.test.ts, format-gates-copy.test.ts)
// follow that call instead of reading `createStages` alone: a scan of `createStages`' body now finds zero gates, and zero
// gates is a vacuous table, not an ungated product (the DENIED scenario's fake refused nothing and 15 tests went red for
// the wrong reason).
//
// The follow is itself checked, so it cannot go quiet: a `createStages` or `replaceStages` that no longer calls the batch
// gates function, or a gates function that cannot be found, THROWS here, naming what moved.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const readProduct = (p: string): string => readFileSync(resolve(REPO, p), "utf8");
export const STAGES_PATH = "apps/web/src/server/usecases/stages.ts";
export const FORMAT_GATES_PATH = "apps/web/src/server/usecases/format-gates.ts";

/** The text of `head`'s body: from its signature to the first closing brace at column 0. */
export function bodyOf(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`product-gates-source: ${head} not found`);
  const end = src.indexOf("\n}\n", at);
  if (end < 0) throw new Error(`product-gates-source: ${head} has no closing brace`);
  return src.slice(at, end);
}

/** The function the stage-batch callers delegate their gates to. */
export const BATCH_GATES_FN = "assertStageBatchGates";
/** The batch callers: each must ask the gates before it writes (R-T13-2), so the PUT is gated by the table the POST is. */
export const BATCH_CALLERS = ["createStages", "replaceStages"] as const;

/**
 * The body of the product's stage-batch gates function, found by FOLLOWING the call from each batch caller: both must call
 * it (else the gates it holds guard nothing), and the body returned is the one they call.
 */
export function batchGatesBody(stagesSrc: string): string {
  for (const caller of BATCH_CALLERS) {
    const body = bodyOf(stagesSrc, `export async function ${caller}(`);
    if (!body.includes(`${BATCH_GATES_FN}(`)) {
      throw new Error(`product-gates-source: ${caller} no longer calls ${BATCH_GATES_FN} - find where its gates live now`);
    }
  }
  return bodyOf(stagesSrc, `export async function ${BATCH_GATES_FN}(`);
}

/** The product's format gates in the order the batch asks them: which feature each requires and which stage kinds its body
 *  names (format-gates.ts). Read from the text of `batchGatesBody`, never from `expectedGate`. */
export function productFormatGates(): { fn: string; key: string; kinds: string[] }[] {
  const batch = batchGatesBody(readProduct(STAGES_PATH));
  const gates = readProduct(FORMAT_GATES_PATH);
  return [...batch.matchAll(/(stageNeeds\w+Gate)\([\s\S]*?requireFeature\(auth\.orgId, "([^"]+)"/g)].map((m) => ({
    fn: m[1] ?? "",
    key: m[2] ?? "",
    kinds: [...bodyOf(gates, `export function ${m[1] ?? ""}(`).matchAll(/kind === "([a-z_]+)"/g)].map((k) => k[1] ?? ""),
  }));
}

/** Every stage gate function format-gates.ts exports (`stageNeeds…Gate`): the set the batch is expected to ask. */
export function exportedStageGateFns(): string[] {
  return [...readProduct(FORMAT_GATES_PATH).matchAll(/^export function (stageNeeds\w+Gate)\(/gm)].map((m) => m[1] ?? "");
}
