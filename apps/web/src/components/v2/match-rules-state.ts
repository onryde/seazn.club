// W2e Task 29 (B1-2; rows TN-CF-1, VB-CF-1, TT-CF-1; PO decision on cricket's `minOversForResult`) - what the division editors'
// rule grid (`MatchRuleFields`, shared by the builder and Settings) knows about the form BEFORE Save, as a pure function with
// unit killers (`__tests__/w2e-rule-problems.test.tsx`): the write doors' refusals attached to the fields they are about, the
// fields a variant has no use for, and the detail a switch holds.
//
// Client-safe like `lib/match-rules/**`: no "use client", no JSX. Everything is read from the engine - its write door
// (`writeConfigIssues`), its `ruleKeys` (`ruleKeyApplies`, `detailOf`) and the stage editor's own reader of "is the switch on"
// (`detailHostIsOn`) - so this editor, the stage editor and the server cannot say three things about one config.
import { BO1_MATCH_TIEBREAK, SET_TARGET_BELOW_FLOOR, ruleKeyApplies, writeConfigIssues } from "@seazn/engine/sport";
import { sentenceSlots } from "@/lib/config-issue-copy";
import type { MessageKey } from "@/lib/messages";
import { buildRuleOverride, rulesFor } from "@/lib/match-rules";
import { moduleFor } from "@/lib/rule-scope";
import { SWITCH_DESCRIBED_KEYS, detailHostIsOn } from "@/server/public-site/describe-rules";
import { deciderOfDetail } from "./stage-rules/stage-row-model";

/** One sentence a write door would refuse the form with, and the fields it is about. The sentence is the ENGINE's (English):
 *  the reader localizes it (`configIssueText`). */
export interface RuleProblem {
  readonly sentence: string;
  readonly fields: readonly string[];
}

export interface RuleFormState {
  /** Field keys the variant has no use for (the engine's `appliesTo`): not drawn, their values untouched, as the stage editor does. */
  readonly hidden: ReadonlySet<string>;
  /** Field key -> the dictionary key of the label of the switch that holds it: drawn disabled, with the reason beside it
   *  (cricket's result floor while DLS is off). A KEY, not text: this module has no `msg`, and the screen resolves it. */
  readonly held: ReadonlyMap<string, MessageKey>;
  readonly problems: readonly RuleProblem[];
  /** Field key -> the sentences about it, for the control to draw beside itself. */
  readonly invalid: ReadonlyMap<string, readonly string[]>;
}

const NONE: RuleFormState = { hidden: new Set(), held: new Map(), problems: [], invalid: new Map() };

const topOf = (path: string): string => path.split(".")[0]!;

/**
 * The state of the rule grid for `values` laid over `base`:
 *  - `base` is the config the values are laid over - the saved one in Settings (under the variant the form holds), the
 *    variant's preset in the builder. Absent: nothing to judge against, so no state (a caller that does not pass one keeps
 *    the grid exactly as it was).
 *  - A problem is whatever the sport's write door would refuse the merged config with. Issues carry no path, so they are
 *    mapped to fields here by sentence: a best of 1 with a match tie-break to the fields of the pair, a set target below the
 *    floor to the set-target fields whose value is below it. A config the schema itself refuses says nothing: that is the
 *    door's first answer and it speaks for itself.
 *  - A field is hidden where every key it edits that the engine declares does not apply to the variant.
 *  - A field is held where it is a detail of a SWITCH (not of a decider: those are the stage row's, and a division-level hold
 *    there would lock fields organisers set today) that is off in the merged config, and the form has a field to turn it on.
 */
export function ruleFormState(input: {
  sportKey: string;
  variantKey: string | null;
  values: Record<string, string>;
  base: Record<string, unknown> | undefined;
}): RuleFormState {
  const sportModule = moduleFor(input.sportKey);
  if (sportModule === null || input.base === undefined) return NONE;
  const fields = rulesFor(input.sportKey);
  const facts = sportModule.ruleKeys ?? {};

  const hidden = new Set<string>();
  for (const f of fields) {
    const declared = f.edits.filter((e) => Object.hasOwn(facts, e));
    if (declared.length > 0 && declared.every((e) => !ruleKeyApplies(facts[e]!, null, input.variantKey))) hidden.add(f.key);
  }

  // The merged config the way Save sends it: the form's override laid over the base (a shallow assign - the door's own merge).
  const effective: Record<string, unknown> = { ...input.base };
  for (const [k, v] of Object.entries(buildRuleOverride(input.sportKey, input.values, input.base))) if (v !== undefined) effective[k] = v;
  const parsed = sportModule.configSchema.safeParse(effective);
  if (!parsed.success) return { ...NONE, hidden };
  const resolved = parsed.data as Record<string, unknown>;

  const held = new Map<string, MessageKey>();
  for (const f of fields) {
    if (hidden.has(f.key)) continue;
    const host = deciderOfDetail(sportModule, f);
    if (host === null || !SWITCH_DESCRIBED_KEYS.includes(host) || detailHostIsOn(sportModule, host, resolved)) continue;
    const switchField = fields.find((x) => x.edits[0] === host && !hidden.has(x.key));
    if (switchField !== undefined) held.set(f.key, switchField.labelKey);
  }

  return { hidden, held, ...ruleProblemsOf(input.sportKey, resolved, hidden) };
}

/**
 * The write doors' refusals of a RESOLVED config, mapped to the fields they are about: the part of `ruleFormState` the stage
 * editor shares (W2e T33a - it holds the config its stage would play with, `resolvedStageCfg`, and shows the sentence beside the
 * fields instead of only on Save). `hidden` is the fields the caller does not draw; a sentence is never mapped to one of them.
 * An unknown sport has no door: no problems.
 */
export function ruleProblemsOf(
  sportKey: string,
  resolved: Record<string, unknown>,
  hidden: ReadonlySet<string> = new Set(),
): Pick<RuleFormState, "problems" | "invalid"> {
  const sportModule = moduleFor(sportKey);
  if (sportModule === null) return { problems: [], invalid: new Map() };
  const fields = rulesFor(sportKey);
  const editing = (keys: readonly string[]) => fields.filter((f) => !hidden.has(f.key) && f.edits.some((e) => keys.includes(topOf(e))));
  const fieldsOf = (sentence: string): string[] => {
    if (sentence === BO1_MATCH_TIEBREAK) return editing(["bestOf", "finalSet"]).map((f) => f.key);
    const slots = sentenceSlots(sentence, SET_TARGET_BELOW_FLOOR);
    if (slots !== null) {
      const floor = Number(slots.min);
      return editing(["setTo", "finalSetTo"])
        .filter((f) => f.edits.every((e) => typeof resolved[e] === "number" && resolved[e] < floor))
        .map((f) => f.key);
    }
    return [];
  };
  const problems: RuleProblem[] = writeConfigIssues(sportModule, resolved).map((sentence) => ({ sentence, fields: fieldsOf(sentence) }));

  const invalid = new Map<string, string[]>();
  for (const p of problems) for (const key of p.fields) invalid.set(key, [...(invalid.get(key) ?? []), p.sentence]);
  return { problems, invalid };
}
