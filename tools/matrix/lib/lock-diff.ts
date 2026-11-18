// Item 1 (W1d D10): plans.lock.json is append-only. An entry present in the
// base must be value-identical in the head; entries may be added. Keys are
// sorted before comparing (the matrix's one `canon`), so a formatter reordering an object is not an edit.
import { canon } from "./streams/types.ts";

export type LockFile = { runs: Record<string, unknown> };
export type LockChange = { run: string; kind: "removed" | "edited" };

export function lockChanges(base: LockFile, head: LockFile): { compared: number; added: string[]; changed: LockChange[] } {
  const changed: LockChange[] = [];
  let compared = 0;
  for (const [run, entry] of Object.entries(base.runs)) {
    compared++;
    if (!Object.hasOwn(head.runs, run)) changed.push({ run, kind: "removed" });
    // The same object in both is the same value: a caller that shares entries (the real-lock sweep in lock-append-only.test.ts tampers one
    // entry of ~300) skips their canon. Two locks parsed apart never share, so the CLI compares every entry as before.
    else if (entry !== head.runs[run] && canon(entry) !== canon(head.runs[run])) changed.push({ run, kind: "edited" });
  }
  const added = Object.keys(head.runs).filter((r) => !Object.hasOwn(base.runs, r));
  return { compared, added, changed };
}
