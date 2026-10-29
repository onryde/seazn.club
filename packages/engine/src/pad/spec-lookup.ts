// Lookups over a PadSpec (pad wave P0.1): the one way the pad rule records read a bound or a value set the module already declares
// in `padSpec(cfg)`, instead of typing it a second time. Pure data in, pure data out: no node:*, no React.
//
// A field is addressed by the event type of the action that collects it and its dotted payload path. That pair is NOT unique in the
// real specs: one event type can have two buttons that collect the same path with different bounds (boardgame.result's `method`:
// the decisive methods on one button, the drawn ones on the other; carrom.game.adjust's `delta`: +1..+25 and -25..-1; generic.score's
// `points`). Answering with whichever button came first would be a silent wrong answer for exactly those paths, so a lookup answers
// only when every action that declares the pair agrees on what the lookup RETURNS, and otherwise refuses by name, listing the actions
// (their `labelKey.key`) that disagree. `scope.action` then addresses one of them: an action has no id, and its label key is the one
// identity it has (held unique per module by the pad conformance suite's checkLabelKeysUnique, bar byte-identical per-phase restatements,
// which agree by construction).
import type { PadField, PadSpec } from "../sport/module.ts";

/** Narrows a lookup to the one action whose `labelKey.key` is `action`. An action key that is not an action of the event type throws. */
export interface PadFieldScope {
  readonly action?: string;
}

/** Structural equality of two plain-data values (a PadField is strings, numbers, booleans, arrays and plain objects). Two objects are
 *  equal only if they hold the same keys: a key that is present with the value undefined is not the same as a key that is absent. */
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

/** What padEnumValues and padNumberBound return of a field: its kind, and its values or its bounds. Nothing of its presentation (label,
 *  chips, step, optional, group), so two buttons that word a field differently still agree. */
function returnedOf(field: PadField): unknown {
  if (field.kind === "enum") return { kind: field.kind, values: field.values };
  if (field.kind === "number") return { kind: field.kind, min: field.min, max: field.max };
  return { kind: field.kind };
}

interface Candidate {
  readonly action: string;
  readonly field: PadField;
}

/** The fields at `path` of the actions of `eventType` (all of them, or the one `scope.action` names), in panel order. */
function candidatesOf(who: string, spec: PadSpec, eventType: string, path: string, scope: PadFieldScope | undefined): Candidate[] {
  const actions = spec.panels.flatMap((panel) => panel.actions).filter((action) => action.type === eventType);
  const wanted = scope?.action;
  const chosen = wanted === undefined ? actions : actions.filter((action) => action.labelKey.key === wanted);
  if (wanted !== undefined && chosen.length === 0) {
    const keys = [...new Set(actions.map((action) => action.labelKey.key))];
    throw new Error(`${who}(${q(eventType)}, ${q(path)}): scope.action ${q(wanted)} is not an action of that event type (its actions: ${keys.length === 0 ? "none" : keys.join(", ")})`);
  }
  return chosen.flatMap((action) => action.fields.filter((field) => field.path === path).map((field) => ({ action: action.labelKey.key, field })));
}

/** The single definition of (eventType, path) the actions agree on under `view`, or undefined when none declares it. Throws when they
 *  disagree. */
function lookup(who: string, spec: PadSpec, eventType: string, path: string, scope: PadFieldScope | undefined, view: (field: PadField) => unknown): PadField | undefined {
  const found = candidatesOf(who, spec, eventType, path, scope);
  const first = found[0];
  if (first === undefined) return undefined;
  if (found.some((c) => !sameData(view(c.field), view(first.field)))) {
    const keys = [...new Set(found.map((c) => c.action))];
    const within = scope?.action === undefined ? `; pass a scope { action } (one of ${keys.join(", ")}) to say which` : `, even within ${q(scope.action)} itself`;
    throw new Error(`${who}(${q(eventType)}, ${q(path)}): ambiguous - the spec's actions declare this field different ways (${keys.join(", ")})${within}`);
  }
  return first.field;
}

/** The field the spec declares at `path` for `eventType`, or undefined when no action of that type (or the scoped action) has one.
 *  Throws (naming eventType and path, and the candidate action keys) when the actions declare the path with different definitions;
 *  `scope.action` picks one. Throws when `scope.action` is not an action of `eventType`. */
export function padFieldOf(spec: PadSpec, eventType: string, path: string, scope?: PadFieldScope): PadField | undefined {
  return lookup("padFieldOf", spec, eventType, path, scope, (field) => field);
}

function required(who: string, spec: PadSpec, eventType: string, path: string, scope: PadFieldScope | undefined): PadField {
  const field = lookup(who, spec, eventType, path, scope, returnedOf);
  if (field === undefined) throw new Error(`${who}(${q(eventType)}, ${q(path)}): the spec declares no such field`);
  return field;
}

/** The values of an enum field. Throws (an Error naming eventType and path) when the field is absent or not an enum: a missing
 *  field is a build bug, never []. Also throws when the actions disagree on the values (not on their presentation); `scope.action`
 *  picks one. */
export function padEnumValues(spec: PadSpec, eventType: string, path: string, scope?: PadFieldScope): readonly string[] {
  const field = required("padEnumValues", spec, eventType, path, scope);
  if (field.kind !== "enum") throw new Error(`padEnumValues(${q(eventType)}, ${q(path)}): the field is a ${field.kind} field, not an enum`);
  return field.values;
}

/** The bound of a number field. Throws likewise when the field is absent or not a number field, or when the actions disagree on the
 *  bound; `scope.action` picks one. */
export function padNumberBound(spec: PadSpec, eventType: string, path: string, scope?: PadFieldScope): { min: number; max: number } {
  const field = required("padNumberBound", spec, eventType, path, scope);
  if (field.kind !== "number") throw new Error(`padNumberBound(${q(eventType)}, ${q(path)}): the field is a ${field.kind} field, not a number`);
  return { min: field.min, max: field.max };
}
