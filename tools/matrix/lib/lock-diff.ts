// Item 1 (W1d D10): plans.lock.json is append-only. An entry present in the
// base must be value-identical in the head; entries may be added. Keys are
// sorted before comparing, so a formatter reordering an object is not an edit.
export type LockFile = { runs: Record<string, unknown> };
export type LockChange = { run: string; kind: "removed" | "edited" };

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function lockChanges(base: LockFile, head: LockFile): { compared: number; added: string[]; changed: LockChange[] } {
  const changed: LockChange[] = [];
  let compared = 0;
  for (const [run, entry] of Object.entries(base.runs)) {
    compared++;
    if (!Object.hasOwn(head.runs, run)) changed.push({ run, kind: "removed" });
    else if (canonical(entry) !== canonical(head.runs[run])) changed.push({ run, kind: "edited" });
  }
  const added = Object.keys(head.runs).filter((r) => !Object.hasOwn(base.runs, r));
  return { compared, added, changed };
}
