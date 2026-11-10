// Where the product's stage-batch gates live, read from its own source (batch-6 fix, I-4): W2c Task 13 fix round 1
// (838b02485e) moved the entitlement gates out of `createStages`' body into `assertStageBatchGates`, which `createStages`
// and `replaceStages` BOTH call before they write. The scans that read the gates (denied.test.ts, format-gates-copy.test.ts)
// follow that call instead of reading `createStages` alone: a scan of `createStages`' body now finds zero gates, and zero
// gates is a vacuous table, not an ungated product (the DENIED scenario's fake refused nothing and 15 tests went red for
// the wrong reason).
//
// The follow is itself checked, so it cannot go quiet: a `createStages` or `replaceStages` that no longer calls the batch
// gates function, or a gates function that cannot be found, THROWS here, naming what moved.
//
// FMT5 (the Format dialog's dry run): `replaceStages` and `previewReplaceStages` are now thin entries over ONE module-local
// `runReplaceStages`, which asks the gates. So a caller may reach the call through exactly ONE delegate it calls itself
// (`MAX_DELEGATION`), never further: a gates call that disappears from the delegate still throws, it is not found in some
// other function two hops away.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stagesSource } from "./stages-source.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const readProduct = (p: string): string => readFileSync(resolve(REPO, p), "utf8");
/** The stages use-case is a folder; its text is every module in it (see stages-source.ts). */
export const readStages = (): string => stagesSource(REPO);
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
/** The batch callers: each must ask the gates before it writes (R-T13-2), so the PUT is gated by the table the POST is -
 *  and the PUT's dry run (FMT5) refuses what the PUT would, so the Format dialog's confirm never offers a 402. */
export const BATCH_CALLERS = ["createStages", "replaceStages", "previewReplaceStages"] as const;
/** How many delegates a batch caller may pass through before the gates call: its own body, or ONE function it calls. */
export const MAX_DELEGATION = 1;

/** `name`'s body when it is a module-level function of `src` (exported or not, async or not), else null. */
export function functionBody(src: string, name: string): string | null {
  const at = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m").exec(src);
  if (!at) return null;
  const end = src.indexOf("\n}\n", at.index);
  if (end < 0) throw new Error(`product-gates-source: ${name} has no closing brace`);
  return src.slice(at.index, end);
}

/**
 * The chain from `caller` to the function whose body calls `BATCH_GATES_FN`: `[caller]` when it asks the gates itself,
 * `[caller, delegate]` when a module-level function it calls does (at most `MAX_DELEGATION` hops). THROWS when no chain
 * reaches the call, naming the caller.
 */
export function gatesChain(src: string, caller: string): string[] {
  const walk = (name: string, path: readonly string[]): string[] | null => {
    const body = functionBody(src, name);
    if (body === null) return null;
    const chain = [...path, name];
    if (body.includes(`${BATCH_GATES_FN}(`)) return chain;
    if (path.length >= MAX_DELEGATION) return null;
    for (const call of new Set([...body.matchAll(/\b([A-Za-z_]\w*)\(/g)].map((m) => m[1] ?? ""))) {
      if (chain.includes(call)) continue;
      const found = walk(call, chain);
      if (found) return found;
    }
    return null;
  };
  if (functionBody(src, caller) === null) throw new Error(`product-gates-source: ${caller} not found`);
  const chain = walk(caller, []);
  if (!chain) throw new Error(`product-gates-source: ${caller} no longer calls ${BATCH_GATES_FN} - find where its gates live now`);
  return chain;
}

/**
 * The body of the product's stage-batch gates function, found by FOLLOWING the call from each batch caller: every one must
 * reach it (else the gates it holds guard nothing), and the body returned is the one they call.
 */
export function batchGatesBody(stagesSrc: string): string {
  for (const caller of BATCH_CALLERS) gatesChain(stagesSrc, caller);
  return bodyOf(stagesSrc, `export async function ${BATCH_GATES_FN}(`);
}

/** The product's format gates in the order the batch asks them: which feature each requires and which stage kinds its body
 *  names (format-gates.ts). Read from the text of `batchGatesBody`, never from `expectedGate`. */
export function productFormatGates(): { fn: string; key: string; kinds: string[] }[] {
  const batch = batchGatesBody(readStages());
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
