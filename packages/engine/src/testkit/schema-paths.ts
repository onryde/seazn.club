// W2c Task 4 — does a cfg schema have this key path? The X-SR-1 sweep in
// `sport/rule-keys.test.ts` reads it to prove every declared `ruleKeys` path is
// real and every top-level key is classified.
//
// PURE: no node:fs, no registry. Reads zod 4's `_zod.def` (the convention
// `schema-fields.ts` already uses), not wrapper classes, so a `.readonly()`,
// `.catch()` or `.prefault()` wrapper reads through like `.optional()` does.
import type { z } from "zod";

/** The parts of a zod 4 node definition this file reads. */
interface Def {
  readonly type: string;
  readonly innerType?: unknown; // wrappers
  readonly getter?: () => unknown; // lazy
  readonly in?: unknown; // pipe
  readonly shape?: Readonly<Record<string, z.ZodType>>; // object
  readonly options?: readonly z.ZodType[]; // union
}
const defOf = (schema: unknown): Def | undefined => (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;

/** Wrappers that stand between a key and the schema that describes it. */
const WRAPPERS: ReadonlySet<string> = new Set(["optional", "nullable", "default", "prefault", "readonly", "nonoptional", "catch"]);

/** Peel wrappers until a structural node. A pipe is read on its INPUT side: a cfg fragment is written against the
 *  shape a transform takes in, not the one it hands out. */
function unwrap(schema: unknown): Def | undefined {
  let node = schema;
  for (let hop = 0; hop < 32; hop++) {
    const def = defOf(node);
    if (def === undefined) return undefined;
    if (WRAPPERS.has(def.type)) node = def.innerType;
    else if (def.type === "lazy") node = def.getter?.();
    else if (def.type === "pipe") node = def.in;
    else return def;
  }
  throw new Error("schema-paths: more than 32 wrappers — a self-referencing schema?");
}

/** True when some value the schema accepts can carry `path` (a union answers for any of its options). */
export function schemaHasPath(schema: z.ZodType, path: readonly string[]): boolean {
  if (path.length === 0) return true;
  const def = unwrap(schema);
  const shape = def?.type === "object" ? def.shape ?? {} : undefined;
  if (shape !== undefined) return Object.hasOwn(shape, path[0]!) && schemaHasPath(shape[path[0]!]!, path.slice(1));
  if (def?.type === "union") return (def.options ?? []).some((o) => schemaHasPath(o, path));
  return false;
}

/** The object's own top-level keys; [] for a schema that is not an object. */
export function schemaTopKeys(schema: z.ZodType): readonly string[] {
  const def = unwrap(schema);
  return def?.type === "object" ? Object.keys(def.shape ?? {}) : [];
}
