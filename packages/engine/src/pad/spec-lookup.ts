// Lookups over a PadSpec (pad wave P0.1): the one way the pad rule records read a bound or a value set the module already declares
// in `padSpec(cfg)`, instead of typing it a second time. Pure data in, pure data out: no node:*, no React.
//
// A field is addressed by the event type of the action that collects it and its dotted payload path. That pair is NOT unique in the
// real specs: one event type can have two buttons that collect the same path with different bounds (boardgame.result's `method`:
// the decisive methods on one button, the drawn ones on the other; carrom.game.adjust's `delta`: +1..+25 and -25..-1; generic.score's
// `points`). Answering with whichever button came first would be a silent wrong answer for exactly those paths, so the lookup
// answers only when every action that declares the pair agrees, and otherwise refuses by name.
import type { PadField, PadSpec } from "../sport/module.ts";

/** Structural equality of two plain-data values (a PadField is strings, numbers, booleans, arrays and plain objects). */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const q = (s: string) => JSON.stringify(s);

/** The distinct definitions of (eventType, path) across every panel and action of the spec, in the order first met. */
function definitionsOf(spec: PadSpec, eventType: string, path: string): PadField[] {
  const out: PadField[] = [];
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      if (action.type !== eventType) continue;
      for (const field of action.fields) {
        if (field.path === path && !out.some((seen) => sameData(seen, field))) out.push(field);
      }
    }
  }
  return out;
}

function lookup(who: string, spec: PadSpec, eventType: string, path: string): PadField | undefined {
  const defs = definitionsOf(spec, eventType, path);
  if (defs.length > 1) {
    throw new Error(`${who}(${q(eventType)}, ${q(path)}): ambiguous - the spec's actions declare this field ${defs.length} different ways, and a lookup by event type and path cannot say which one is meant`);
  }
  return defs[0];
}

/** The field the spec declares at `path` for `eventType`, or undefined when no action of that type has one.
 *  Throws (naming eventType and path) when the actions of that type declare the path with different definitions. */
export function padFieldOf(spec: PadSpec, eventType: string, path: string): PadField | undefined {
  return lookup("padFieldOf", spec, eventType, path);
}

function required(who: string, spec: PadSpec, eventType: string, path: string): PadField {
  const field = lookup(who, spec, eventType, path);
  if (field === undefined) throw new Error(`${who}(${q(eventType)}, ${q(path)}): the spec declares no such field`);
  return field;
}

/** The values of an enum field. Throws (an Error naming eventType and path) when the field is absent or not an enum: a missing
 *  field is a build bug, never []. */
export function padEnumValues(spec: PadSpec, eventType: string, path: string): readonly string[] {
  const field = required("padEnumValues", spec, eventType, path);
  if (field.kind !== "enum") throw new Error(`padEnumValues(${q(eventType)}, ${q(path)}): the field is a ${field.kind} field, not an enum`);
  return field.values;
}

/** The bound of a number field. Throws likewise when the field is absent or not a number field. */
export function padNumberBound(spec: PadSpec, eventType: string, path: string): { min: number; max: number } {
  const field = required("padNumberBound", spec, eventType, path);
  if (field.kind !== "number") throw new Error(`padNumberBound(${q(eventType)}, ${q(path)}): the field is a ${field.kind} field, not a number`);
  return { min: field.min, max: field.max };
}
