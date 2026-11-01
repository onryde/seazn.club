// The PATCH twin of a create (or full) object schema: every field optional, and a field the body omits stays OMITTED.
//
// Why not `.partial()`: in zod 4 the optional wrapper hands an omitted field's `undefined` on to the field's own schema,
// and a `.default()` (or `.prefault()`) answers it with its value. So `Create.partial()` fills every defaulted field the
// body never named, and a usecase that writes the body's keys as columns overwrites those columns with the defaults
// (fix/patch-schema-partial-defaults, 2026-11-01: a court rename wiped its tags, a venue save reset its sort).
// `patchOf` unwraps each field's default first, then makes it optional — the create schema keeps its defaults.
//
// Guarded by server/api-v1/__tests__/patch-omitted-fields.test.ts, which parses every PATCH body's fields from
// `undefined` and reds on any that come back with a value. Pure zod, no imports beyond it: schemas.ts (which
// scripts/openapi-gen.ts loads outside Next's bundler) imports this file by relative path.
import { z } from "zod";

type WithoutDefault<T> = T extends z.ZodDefault<infer I> ? I : T extends z.ZodPrefault<infer I> ? I : T;

export type PatchShape<S extends z.ZodRawShape> = { -readonly [K in keyof S]: z.ZodOptional<WithoutDefault<S[K]>> };

export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<PatchShape<S>> {
  const fields: z.core.$ZodShape = schema.shape;
  const shape: Record<string, z.core.$ZodType> = {};
  for (const [key, field] of Object.entries(fields)) {
    const built = z.optional(field instanceof z.ZodDefault || field instanceof z.ZodPrefault ? field.unwrap() : field);
    // Only an OUTERMOST default is unwrapped. One under another wrapper (`.default(v).nullable()`, `.optional()`,
    // `.readonly()`) still answers `undefined` with its value, so the twin would fill it: refuse at build, naming the key.
    const omitted = built.safeParse(undefined);
    if (omitted.success && omitted.data !== undefined) {
      throw new Error(
        `patchOf: field "${key}" still fills an omitted value (${JSON.stringify(omitted.data)}) — its default sits under ` +
          `another wrapper; make .default() the outermost call or give the patch its own field`,
      );
    }
    shape[key] = built;
  }
  // `.partial()` first for what it refuses (an object with refinements: they would run on a partial body) and what it
  // keeps (the object's unknown-key policy); `.extend()` then replaces every field with its undefaulted optional.
  return schema.partial().extend(shape) as unknown as z.ZodObject<PatchShape<S>>;
}
