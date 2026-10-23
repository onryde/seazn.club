// Test-only: what a key-route row ADDRESSES, read off the URL contract rather
// than off the row's own `pin` declaration.
//
// Why it exists: auth.ts resolves a pinned key's competition by looking the
// row's `resourceId` up in the table its `pin` names, and a miss returns null,
// which falls through on purpose (the handler 404s a missing row, so the pin
// adds no existence oracle). A row that declares the WRONG pin kind therefore
// misses on every lookup and the pin waves every request through — a key
// pinned to competition A reads or writes competition B. The guards built on
// this helper derive the kind independently of the declaration, so a wrong
// declaration cannot agree with itself.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchKeyRoute } from "../key-scopes";

export interface Addressed {
  /** Singular of the collection segment that owns the resource id: `/fixtures/:id/state` → `fixture`. */
  kind: string;
  /** Index (in `path.split("/")`) of the segment matchKeyRoute takes `resourceId` from. */
  idSegment: number;
}

const slot = (i: number) => `__slot${i}__`;

/**
 * The resource kind a pinned row's `resourceId` names. It asks matchKeyRoute
 * itself WHERE the id comes from — a distinct sentinel in every `:param` slot,
 * then see which one is handed back — and reads the collection segment right
 * before that slot. So if matchKeyRoute ever takes the id from somewhere else,
 * this follows it instead of assuming segment 2.
 *
 * Throws (a named refusal, never a silent skip) when the row cannot be read
 * that way: no match for its own template, no resourceId, a resourceId that
 * is not a path parameter, or an id slot not owned by a plural collection.
 */
export function addressedKind(method: string, path: string): Addressed {
  const segs = path.split("/");
  const concrete = segs.map((s, i) => (s.startsWith(":") ? slot(i) : s)).join("/");
  const match = matchKeyRoute(method, `/api/v1${concrete}`);
  if (!match) throw new Error(`${method} ${path}: matchKeyRoute does not match its own template`);
  if (match.resourceId === null) throw new Error(`${method} ${path}: matched with no resourceId`);
  const idSegment = segs.findIndex((s, i) => s.startsWith(":") && slot(i) === match.resourceId);
  if (idSegment === -1) {
    throw new Error(
      `${method} ${path}: resourceId '${match.resourceId}' is not one of the path's parameters — the pin would resolve a literal`,
    );
  }
  const collection = segs[idSegment - 1] ?? "";
  if (!/^[a-z][a-z-]*s$/.test(collection)) {
    throw new Error(
      `${method} ${path}: the id at segment ${idSegment} is not owned by a plural collection segment (got '${collection}')`,
    );
  }
  return { kind: collection.slice(0, -1), idSegment };
}

const V1_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app", "api", "v1");

export interface RouteFile {
  file: string;
  /** Next's own param name for each `:x` slot (the directory's `[name]`, which
   *  need not match the rule's spelling), by segment index. */
  params: { name: string; segment: number }[];
}

/** The `app/api/v1/**\/route.ts` serving a rule's path template, or null. */
export function routeFileFor(path: string): RouteFile | null {
  let dir = V1_DIR;
  const params: RouteFile["params"] = [];
  const segs = path.split("/");
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg.startsWith(":")) {
      const dyn = readdirSync(dir).filter((n) => /^\[[^.\]]+\]$/.test(n));
      if (dyn.length !== 1) return null;
      params.push({ name: dyn[0]!.slice(1, -1), segment: i });
      dir = join(dir, dyn[0]!);
    } else {
      if (!existsSync(join(dir, seg))) return null;
      dir = join(dir, seg);
    }
  }
  const file = join(dir, "route.ts");
  return existsSync(file) ? { file, params } : null;
}
