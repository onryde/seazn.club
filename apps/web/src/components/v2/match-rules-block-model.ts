// W2c Task 19 (S2, X-SR-2) - the fixture console's "Match rules" form, as pure functions with unit killers
// (`__tests__/match-rules-block-model.test.ts`). The block (`match-rules-block.tsx`) renders what these answer; a decision
// that needed a browser to reach would have no `scripts/mutate.ts` killer.
//
// Client-safe like `lib/match-rules/**`: no "use client", no JSX, no `@/server` import except the pure readers the stage row
// already uses (`stage-rules/stage-row-model.ts`).
//
// WHAT A MATCH MAY CHANGE is the engine's declaration, not a list here: the fields are `matchFieldsFor` (the keys scoped
// `match`), and a key the engine BOUNDS (`matchBound`) is offered only inside its bound - X-SR-2, signed: "a decider may
// only be switched off or shortened for one match". So the form opens AT the value the match plays now, and:
//  - `off_or_shorter` (football's extra time, `{enabled, halfMinutes}`): a select of Off and every half length up to the
//    STAGE's - never the field's own "On, 15 minutes" (the stage's may be 10: that is longer, and the engine refuses it);
//  - `shorter` (kicks of a shoot-out, minutes of an overtime): a number with a max of the stage's value (or the engine's
//    declared `whenAbsent` where the stage writes none);
//  - a decider the stage has OFF is held: a match cannot switch it on.
//
// WHAT THE FORM SENDS is the PUT body of `/fixtures/{id}/rules`, a WHOLE-FRAGMENT replace: exactly the fields whose value
// differs from the stage's (so a field whose `read` cannot round-trip its `build` never invents a change), plus any key the
// stored override carries that no field edits (a replace must not drop it silently).
import type { StageKind } from "@seazn/engine/core";
import { ruleKeyOwning, type AnySportModule, type RuleKeyFact } from "@seazn/engine/sport";
import type { MatchRulesState } from "@/lib/fixture-status";
import { visibleRuleFields, type RuleField } from "@/lib/match-rules";
import { buildFragment, matchFieldsFor, type RuleContext } from "@/lib/rule-scope";
import { detailIsInert } from "./stage-rules/stage-row-model";

export type { MatchRulesState } from "@/lib/fixture-status";

/** What crosses from the server page to the client block: JSON only (the loader's `fields` hold functions and are rebuilt
 *  on the client from the sport). */
export interface MatchRulesBlockProps {
  readonly fixtureId: string;
  readonly sportKey: string;
  readonly stageKind: StageKind | null;
  readonly variant: string | null;
  /** The stage's format in words, in the reader's language ("" when the describer has none to say). */
  readonly stageLine: string;
  readonly stageResolved: Record<string, unknown>;
  readonly effective: Record<string, unknown>;
  readonly override: Record<string, unknown> | null;
  readonly state: MatchRulesState;
}

/**
 * Who is offered the block at all: an organiser (the writer is organiser auth - a block shown to a scorer or a viewer would
 * only earn a 403) on a competition that is not billing-frozen. The page reads the facts only when this says yes.
 */
export function offersMatchRules(who: { readonly canEdit: boolean; readonly frozen: boolean }): boolean {
  return who.canEdit && !who.frozen;
}

/**
 * The loader's answer as the page hands it to the console: exactly the serialisable facts, listed by name so a field the
 * loader grows later (a function-valued one, like `fields`) cannot ride along into an RSC payload that cannot carry it.
 * `undefined` for a sport with nothing to change for one match (no match field: the block would be an empty card).
 */
export function matchRulesBlockProps(
  fixtureId: string,
  r: Omit<MatchRulesBlockProps, "fixtureId"> & { readonly fields: readonly unknown[] },
): MatchRulesBlockProps | undefined {
  if (r.fields.length === 0) return undefined;
  return {
    fixtureId,
    sportKey: r.sportKey,
    stageKind: r.stageKind,
    variant: r.variant,
    stageLine: r.stageLine,
    stageResolved: r.stageResolved,
    effective: r.effective,
    override: r.override,
    state: r.state,
  };
}

/** The sport the form is for, and the stage kind and variant that narrow its keys (`RuleContext` + the sport's key). */
export interface MatchFormCtx extends RuleContext {
  readonly sportKey: string;
  readonly module: AnySportModule;
  readonly stageKind: StageKind | null;
  readonly variant: string | null;
}

/** The words the adapted controls need, in the reader's language (the model has no dictionary). */
export interface MatchFormLabels {
  readonly off: string;
  readonly halfMinutes: (n: number) => string;
}

type Bound = NonNullable<RuleKeyFact["matchBound"]>;

export interface MatchFormField {
  /** The field AS RENDERED: the sport's curated field, adapted to its bound where it has one. */
  readonly field: RuleField;
  readonly bound: Bound | null;
  /** The stage plays this decider (or the decider this is a detail of) OFF: a match cannot switch it on. */
  readonly held: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A length the bound compares: a finite number (the engine's own definition - `rule-keys.ts` `isLength`). */
const isLength = (v: unknown): v is number => Number.isFinite(v);
const valueAt = (cfg: Record<string, unknown>, key: string): unknown =>
  key.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), cfg);

/** The bound a field's keys share, as the engine declares it; null for a field with no bounded key (or a mix). */
function boundOf(m: AnySportModule, field: RuleField): { bound: Bound; fact: RuleKeyFact; key: string } | null {
  const owned = field.edits.map((k) => ({ key: k, owner: ruleKeyOwning(m, k.split(".")) }));
  const first = owned[0]?.owner;
  const bound = first?.fact.matchBound;
  if (first === undefined || first === null || bound === undefined) return null;
  return owned.every((o) => o.owner?.fact.matchBound === bound) ? { bound, fact: first.fact, key: owned[0]!.key } : null;
}

/** Every half length a match may play: the stage's down to one minute (the engine: `halfMinutes <= stage's`). */
const lengthsUpTo = (n: number): number[] => Array.from({ length: n }, (_, i) => n - i);

/** One curated field, adapted to its bound against the stage's resolved format. */
function adapt(
  ctx: MatchFormCtx,
  field: RuleField,
  stageResolved: Record<string, unknown>,
  labels: MatchFormLabels,
): MatchFormField {
  const owned = boundOf(ctx.module, field);
  const inert = detailIsInert(ctx.module, field, stageResolved);
  if (owned === null) return { field, bound: null, held: inert };

  const stageValue = valueAt(stageResolved, owned.key);
  if (owned.bound === "off_or_shorter") {
    // `{enabled, halfMinutes}`, the shape the engine's bound reads. The stage "plays it" when enabled with a real length.
    const base = isObj(stageValue) ? stageValue : {};
    const length = base.enabled === true && isLength(base.halfMinutes) ? base.halfMinutes : null;
    const adapted: RuleField = {
      ...field,
      kind: "select",
      options: [
        ...(length === null ? [] : lengthsUpTo(length).map((n) => ({ value: String(n), label: labels.halfMinutes(n) }))),
        { value: "off", label: labels.off },
      ],
      build: (v) => ({
        [owned.key]: v === "off" ? { ...base, enabled: false } : { ...base, enabled: true, halfMinutes: Number(v) },
      }),
      read: (cfg) => {
        const x = valueAt(cfg, owned.key);
        if (!isObj(x)) return undefined;
        if (x.enabled === true && isLength(x.halfMinutes)) return String(x.halfMinutes);
        return x.enabled === false ? "off" : undefined;
      },
    };
    return { field: adapted, bound: owned.bound, held: length === null || inert };
  }

  // `shorter`: the stage's value, else the engine's declared effective default; none = the stage plays it off.
  const ceiling = isLength(stageValue) ? stageValue : owned.fact.whenAbsent;
  if (!isLength(ceiling)) return { field, bound: owned.bound, held: true };
  return {
    field: { ...field, max: ceiling, min: Math.min(field.min ?? 1, ceiling) },
    bound: owned.bound,
    held: inert,
  };
}

/** Every match field of this cell, adapted - unfiltered by what the current values show (hydration reads them all). */
function allAdapted(ctx: MatchFormCtx, stageResolved: Record<string, unknown>, labels: MatchFormLabels): MatchFormField[] {
  return matchFieldsFor(ctx).map((f) => adapt(ctx, f, stageResolved, labels));
}

/**
 * The fields the form shows for these values, in table order: the match fields, through the same best-of-1 fold as the
 * stage and division editors (one "Points to win", the shadow key hidden - `visibleRuleFields`, against the stage's
 * format), each adapted to its bound.
 */
export function matchFormFields(
  ctx: MatchFormCtx,
  stageResolved: Record<string, unknown>,
  values: Record<string, string>,
  labels: MatchFormLabels,
): MatchFormField[] {
  const visible = new Map(visibleRuleFields(ctx.sportKey, values, stageResolved).map((f) => [f.key, f] as const));
  return allAdapted(ctx, stageResolved, labels).flatMap((a) => {
    const shown = visible.get(a.field.key);
    // The best-of-1 relabel (`Points to win`) lands on the visible copy; the adaptation is kept.
    return shown === undefined ? [] : [{ ...a, field: { ...a.field, label: shown.label } }];
  });
}

/** The raw form values a cfg reads as: each adapted field's own inverse (`read`), blank where the cfg says nothing. */
export function hydrateMatchValues(
  ctx: MatchFormCtx,
  stageResolved: Record<string, unknown>,
  cfg: Record<string, unknown>,
  labels: MatchFormLabels,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const a of allAdapted(ctx, stageResolved, labels)) {
    const v = a.field.read?.(cfg);
    if (v !== undefined) values[a.field.key] = v;
  }
  return values;
}

/** Where a field's value comes from: "match" when the form holds a value the stage does not play, else "stage" (blank
 *  is "use the stage's"). */
export function matchSource(key: string, values: Record<string, string>, stageValues: Record<string, string>): "stage" | "match" {
  const v = values[key] ?? "";
  return v !== "" && v !== (stageValues[key] ?? "") ? "match" : "stage";
}

/** Whether the form holds a change against the values it opened with (an absent value and a blank are the same). */
export function matchFormDirty(opened: Record<string, string>, values: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(opened), ...Object.keys(values)]);
  return [...keys].some((k) => (opened[k] ?? "") !== (values[k] ?? ""));
}

/**
 * The `rules` a Save PUTs: every field (not held, VISIBLE OR NOT - the best-of-1 shadow key is hidden but still written, as
 * the stage and division editors write it) whose value differs from the stage's, laid onto the stage's own objects
 * (`buildFragment`: a decider's length changes one leaf of the stage's object), plus the stored override's keys that no
 * match field edits. `{}` clears the override (the PUT sets the match back to its stage's), which is right when every value
 * has been set back to the stage's.
 */
export function matchFragment(
  ctx: MatchFormCtx,
  values: Record<string, string>,
  stageValues: Record<string, string>,
  stageResolved: Record<string, unknown>,
  storedOverride: Record<string, unknown> | null = null,
): Record<string, unknown> {
  // `build`/`read` never use the labels: the words only decorate the options.
  const all = allAdapted(ctx, stageResolved, { off: "", halfMinutes: () => "" });
  const sent = all.filter((f) => !f.held && matchSource(f.field.key, values, stageValues) === "match");
  // Built over EVERY field, the best-of-1 shadow key too: `setRuleValue` keeps the pair equal in the values, so a changed
  // "Points to win" writes both keys (`BEST_OF_ONE_PAIR`), as the stage and division editors do - no later alignment needed.
  const built = buildFragment(sent.map((f) => f.field), values, stageResolved);
  if (storedOverride === null) return built;
  // Top-level keys some match field edits: those are the form's to say. Any other key the override carries stays.
  const edited = new Set(all.flatMap((a) => a.field.edits.map((k) => k.split(".")[0]!)));
  const kept = Object.fromEntries(Object.entries(storedOverride).filter(([k]) => !edited.has(k)));
  return { ...kept, ...built };
}

/** What the block re-seeds on: the facts a refreshed page can change under it (`router.refresh()` after a save, a tab
 *  return). A new key remounts the block from the page's truth. */
export function blockSeedKey(p: Pick<MatchRulesBlockProps, "override" | "state" | "effective" | "stageResolved">): string {
  return JSON.stringify([p.override, p.state, p.effective, p.stageResolved]);
}
