// W2c X-SR-1 / X-SR-2 (spec §4.1 as amended; plan D2) — which curated rule fields belong to which form, read from the
// engine's `ruleKeys` declaration instead of a list kept in the web.
//
// Every `RuleField` names the engine keys it `edits` (`lib/match-rules/types.ts`). The engine says, per sport, stage kind
// and variant, which of those keys are MATCH keys (one match may differ from its stage), STAGE keys (the stage sets
// them) and POINTS keys (the stage's table points, the points screen). A field belongs to the form whose key set holds
// every key it edits. The stage form, the match form and the points screen are built on these three lists.
//
// Client-safe like `lib/match-rules/**`: no "use client", no JSX, no `@/server` import. It imports the engine's
// `/sport` and `/sports` package subpaths and the field table, and the `StageKind` TYPE from `/core` (an `import type`,
// erased at build, so no runtime import of the core subpath), nothing else.
import type { StageKind } from "@seazn/engine/core";
import { fixtureKeysFor, pointsKeysFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { SPORT_RULES } from "@/lib/match-rules";
import { ownOr } from "@/lib/match-rules/shared";
import type { RuleField } from "@/lib/match-rules/types";

/** Where a form is being built: a sport, and the stage kind and variant that narrow its keys. A null kind (the division
 *  level, before any stage) or a null variant is never narrowed — the engine's own rule. */
export interface RuleContext {
  readonly module: AnySportModule;
  readonly stageKind: StageKind | null;
  readonly variant: string | null;
}

/** The shipped module for a sport key, or null. The web's own lookup of the registry the engine ships (`builtinModules`):
 *  a client component has no server-side `resolveModule`. */
export function moduleFor(sportKey: string): AnySportModule | null {
  return builtinModules.find((m) => m.key === sportKey) ?? null;
}

/** A sport's curated fields. `ownOr`, not `SPORT_RULES[key] ?? []`: a module named "constructor" would answer the
 *  Object constructor, and a loop over it throws (the same trap as `match-rules/index.ts`'s `rulesFor`). */
const fieldsOf = (ctx: RuleContext): RuleField[] => ownOr<RuleField[]>(SPORT_RULES, ctx.module.key, []);

/** The fields (in table order) whose every edited key is in `keys`. A field that edits nothing belongs to no form: an
 *  empty list would otherwise satisfy `every` for all of them. */
export function fieldsWithin(fields: readonly RuleField[], keys: readonly string[]): RuleField[] {
  const allowed = new Set(keys);
  return fields.filter((f) => f.edits.length > 0 && f.edits.every((k) => allowed.has(k)));
}

/** The stage rules form: every field whose keys are stage or match scope for this kind and variant. */
export const stageFieldsFor = (ctx: RuleContext): RuleField[] =>
  fieldsWithin(fieldsOf(ctx), stageKeysFor(ctx.module, ctx.stageKind, ctx.variant));

/** The match override form: the fields whose keys are all match scope. A subset of the stage form. */
export const matchFieldsFor = (ctx: RuleContext): RuleField[] =>
  fieldsWithin(fieldsOf(ctx), fixtureKeysFor(ctx.module, ctx.stageKind, ctx.variant));

/** The stage points screen: the fields whose keys are all table-points keys. Never in the rules picker. */
export const pointsFieldsFor = (ctx: RuleContext): RuleField[] =>
  fieldsWithin(fieldsOf(ctx), pointsKeysFor(ctx.module, ctx.stageKind, ctx.variant));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function setPath(o: Record<string, unknown>, p: readonly string[], v: unknown): Record<string, unknown> {
  if (p.length === 1) return { ...o, [p[0]!]: v };
  return { ...o, [p[0]!]: setPath(isObj(o[p[0]!]) ? (o[p[0]!] as Record<string, unknown>) : {}, p.slice(1), v) };
}

/**
 * The override a match carries, from the form's raw values: for each field with a value, the LEAF it edits, laid onto the
 * stage's own object. The override the engine checks (`checkFixtureOverride`) carries whole top-level values, so a match
 * that shortens overtime sends the stage's overtime object with one number changed, never a guess at its other leaves.
 *
 * A field's `build` may write the whole nested object (hockey's `periods` carries the stage-wide period count) or
 * nothing at all (a sub-field whose parent field assembles the object, ice hockey's overtime length); the leaf is read
 * from the build at each edited path, or is the number typed when the build writes nothing. Empty values write nothing.
 * Under a stage object that is not an object (a decider the stage has off: `null`, or absent) there is nothing to
 * shorten, so the field is skipped — a match may switch a decider off or shorten it, never switch it on.
 */
export function buildFragment(
  fields: readonly RuleField[], values: Record<string, string>, stageResolved: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined || v === "") continue;
    const built = f.build(v, values, stageResolved);
    for (const key of f.edits) {
      const path = key.split(".");
      const leaf = Object.keys(built).length > 0 ? path.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), built) : Number(v);
      if (leaf === undefined) continue;
      if (path.length === 1) { out[path[0]!] = leaf; continue; }
      const base = out[path[0]!] ?? stageResolved[path[0]!];
      if (!isObj(base)) continue;
      out[path[0]!] = setPath(structuredClone(base), path.slice(1), leaf);
    }
  }
  return out;
}

/** A match's override: `buildFragment` over the MATCH fields only, so a stage-only value in the form is never sent. */
export const buildMatchFragment = (
  ctx: RuleContext, values: Record<string, string>, stageResolved: Record<string, unknown>,
): Record<string, unknown> => buildFragment(matchFieldsFor(ctx), values, stageResolved);
