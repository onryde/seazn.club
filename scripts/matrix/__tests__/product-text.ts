// Product rules the model's fake and its pins READ from the product's source
// instead of typing them (Task 13 fix round 1, ruling C-1): a product change
// moves the fake with it, and turns the model's pin red.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

/** api-v1 http.ts statusCode(): the code an HttpError that carries none of its
 *  own reaches the wire with. */
export function wireCodeFor(status: number): string {
  const body = /\nfunction statusCode\(status: number\): string \{\n([\s\S]*?)\n\}\n/.exec(read("apps/web/src/server/api-v1/http.ts"))?.[1];
  if (body === undefined) throw new Error("product-text: http.ts statusCode() not found");
  for (const [, s, c] of body.matchAll(/case (\d{3}): return "([A-Z_]+)";/g)) if (Number(s) === status) return c;
  const fallback = /default: return status >= 500 \? "([A-Z_]+)" : "([A-Z_]+)";/.exec(body);
  if (fallback === null) throw new Error("product-text: http.ts statusCode() has no default arm in the expected shape");
  return status >= 500 ? fallback[1] : fallback[2];
}

export interface RosterLockText {
  /** divisions.status values that lock the roster. */
  statuses: string[];
  /** Stage kinds that keep a started roster open. */
  openKinds: string[];
  status: number;
  /** The HttpError's own code, or null (none: the wire carries wireCode). */
  code: string | null;
  /** What a client reads: the code, or http.ts's generic one for the status. */
  wireCode: string;
  message: string;
}

/** entrants.ts createEntrants: a started tournament's entrant list is locked
 *  unless one of its stages is an open-window format. */
export function rosterLockText(): RosterLockText {
  const src = read("apps/web/src/server/usecases/entrants.ts");
  const m = /\n\s*if \(((?:division\.status === "[a-z_]+"(?: \|\| )?)+)\) \{\s*const \[openFormat\] = await tx`[\s\S]*?kind in \(([^)]*)\)[\s\S]*?if \(!openFormat\) \{\s*throw new HttpError\(\s*(\d{3}),\s*"([^"]*)",?\s*(?:("[A-Z_]+"|[A-Za-z_]\w*),?\s*)?\);/.exec(src);
  if (m === null) throw new Error("product-text: entrants.ts roster lock not found in the expected shape — re-read it and update the model's ROSTER_LOCK");
  const statuses = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  const openKinds = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  const status = Number(m[3]);
  const arg = m[5];
  let code: string | null = null;
  if (arg !== undefined) {
    if (arg.startsWith("\"")) code = arg.slice(1, -1);
    else {
      const def = new RegExp(`\\bconst ${arg} = "([A-Z_]+)"`).exec(src);
      if (def === null) throw new Error(`product-text: the roster lock's code ${arg} is not a string constant in entrants.ts — resolve it`);
      code = def[1];
    }
  }
  return { statuses, openKinds, status, code, wireCode: code ?? wireCodeFor(status), message: m[4] };
}

/** schedule.ts roundRobinStageIds: the stage kinds the product generates as a
 *  round robin — the ones #879's positional reconcile can duplicate. */
export function roundRobinKindsText(): string[] {
  const m = /export async function roundRobinStageIds\([\s\S]*?kind in \(([^)]*)\)/.exec(read("apps/web/src/server/usecases/schedule.ts"));
  if (m === null) throw new Error("product-text: schedule.ts roundRobinStageIds not found");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

/** withdrawal.ts REASON: the reason every cascade event carries. */
export function withdrawalReason(): string {
  const r = /\nconst REASON = "([^"]+)";/.exec(read("apps/web/src/server/usecases/withdrawal.ts"));
  if (r === null) throw new Error("product-text: withdrawal.ts REASON not found");
  return r[1];
}
