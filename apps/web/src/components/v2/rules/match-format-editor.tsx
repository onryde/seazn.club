"use client";

// Match Day C2 (spec 2026-10-31 §12 Phase C item 10) — THE Match format component: one editor for how a match is played,
// reused wherever a format is set or read (owner, 2026-10-31: "single component for each and reuse in builder, fixture and
// match pages"). Three scopes, one set of modes:
//
//   - scope "division" — the division's default format: the division builder's Basics and the Division rules strip on the
//                        Fixtures tab. The field grid absorbed from `match-rules.tsx` (`MatchRuleFields`), controlled: the
//                        parent owns the values and the save.
//   - scope "stage"    — a stage's own format on its stage card: the grid absorbed from `stage-rules/stage-rule-fields.tsx`
//                        (`StageRuleFields`, W2c Task 17), each field saying where its value comes from.
//   - scope "fixture"  — one match: in edit, the per-match block (`MatchRulesBlock`, W2c Task 19, organisers only); locked,
//                        the format the match plays in one line (the fixture page for a non-organiser, the Match Day court).
//
// Modes: "edit" as above; "locked" — read-only, the format as chips worded by the public line's own describers (no input,
// no select), and for a stage that has started the ONE lock line (item 4).
//
// Which fields exist comes from the engine's `ruleKeys` (`visibleRuleFields` / `stageSections`), never a list of sports; every
// control is the same `RuleFieldControl`, so the scopes cannot drift. One DOM at every width: the grids stack on a phone.
import { useId, useMemo } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { buildRuleOverride, fieldOptionText, setRuleValue, visibleRuleFields, type RuleField } from "@/lib/match-rules";
import { divisionOnlyStageKeys } from "@/lib/online-time-control";
import type { StageKind } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import type { RefusedField } from "@/lib/rule-errors";
import { rulesChipText } from "@/lib/rules-line";
import { configIssueText } from "@/lib/config-issue-copy";
import { lockLineFor } from "@/components/v2/division-settings-locks";
import { MatchRulesBlock, type MatchRulesBlockProps } from "@/components/v2/match-rules-block";
import { ruleProblemsOf, type RuleFormState } from "@/components/v2/match-rules-state";
import { RuleFieldControl, type OptionState } from "@/components/v2/stage-rules/rule-field-control";
import {
  abandonOptionStates,
  deciderOfDetail,
  detailIsInert,
  divisionSummaryClauses,
  stageSections,
  stageSummaryClauses,
  type StageSectionId,
} from "@/components/v2/stage-rules/stage-row-model";
import { LockLine, type RulesMode } from "./lock-line";

export type { RulesMode } from "./lock-line";
export type { RuleField } from "@/lib/match-rules";
export { buildRuleOverride, hydrateRuleValues, rulesFor } from "@/lib/match-rules";

const SECTION_TITLE: Record<StageSectionId, MessageKey> = {
  format: "stageRules.section.format",
  deciders: "stageRules.section.deciders",
  abandon: "stageRules.section.abandon",
};

/** The segment of the stage's testid for a field: the top segment of the first key it edits. */
const topSegment = (f: RuleField): string => f.edits[0]!.split(".")[0]!;

export function StageRuleFields({
  sportKey,
  module,
  kind,
  variant,
  values,
  onChange,
  disabled,
  divisionConfig,
  resolved,
}: {
  sportKey: string;
  module: AnySportModule;
  kind: StageKind;
  variant: string | null;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled: boolean;
  divisionConfig: Record<string, unknown>;
  /** The cfg this stage would play with the edit (`resolvedStageCfg`), or null when the schema refuses it. A decider's
   *  detail (the kicks of a shoot-out) is held while the decider is off in it (review M-4). */
  resolved: Record<string, unknown> | null;
}) {
  const msg = useMsg();
  const reasonId = useId();
  const sections = useMemo(() => stageSections(module, kind, variant), [module, kind, variant]);
  // The fields the grid shows: the engine's stage fields, through the same best-of-1 fold as the division editor (one
  // "Points to win", the shadow key hidden).
  // Rebase ruling D1: a field that edits a key the DIVISION keeps for itself (an online chess division's clock and clock
  // family) is not drawn - the stage save refuses it with the same answer (`divisionOnlyStageKeys`).
  const visible = useMemo(() => {
    const kept = divisionOnlyStageKeys(sportKey, divisionConfig);
    const byKey = new Map(visibleRuleFields(sportKey, values, divisionConfig).map((f) => [f.key, f] as const));
    return sections.map((s) => ({
      id: s.id,
      fields: s.fields
        .map((f) => byKey.get(f.key))
        .filter((f): f is RuleField => f !== undefined && !f.edits.some((path) => kept.has(path.split(".")[0]!))),
    }));
  }, [sportKey, values, divisionConfig, sections]);
  // The abandon select's unavailable options (owner P-5), judged against the cfg this stage would play with the edit.
  const optionStates = useMemo(() => {
    const built = buildRuleOverride(sportKey, values, divisionConfig);
    const effective: Record<string, unknown> = { ...divisionConfig };
    for (const [k, v] of Object.entries(built)) if (v !== undefined) effective[k] = v;
    return new Map<string, OptionState>(abandonOptionStates(module, effective).map((o) => [o.value, o] as const));
  }, [module, sportKey, values, divisionConfig]);
  const reasons = [...optionStates.entries()].filter(([, s]) => s.disabled && s.reasonKey !== null);
  // W2e T33a: what a write door would refuse the cfg this stage would play with, beside the fields it is about (a best of 1 with a
  // match tie-break; a set target under the floor), not only after Save. The save's own refusal is unchanged.
  const problems = useMemo(() => (resolved === null ? null : ruleProblemsOf(sportKey, resolved).invalid), [sportKey, resolved]);

  const edit = (key: string, raw: string) => onChange(setRuleValue(sportKey, values, key, raw, divisionConfig));

  return (
    // The row's own controls hold the 44px tap floor (the shared `.select` / `.input` are 42px): scoped to this editor
    // so the division builder, which shares RuleFieldControl, keeps its look.
    <div className="space-y-4 [&_input]:min-h-11 [&_select]:min-h-11">
      {visible
        .filter((s) => s.fields.length > 0)
        .map((s) => (
          <section key={s.id} aria-labelledby={`${reasonId}-${s.id}`} data-testid={`stage-rules-section-${s.id}`}>
            <h4 id={`${reasonId}-${s.id}`} className="mb-2 text-xs font-semibold text-slate-800">
              {msg(SECTION_TITLE[s.id])}
            </h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {s.fields.map((field) => {
                const set = (values[field.key] ?? "") !== "";
                // A decider's detail while that decider is off: held, with the reason beside it (the decider is named by
                // the label of the field that switches it).
                const inert = detailIsInert(module, field, resolved);
                const decider = inert ? deciderOfDetail(module, field) : null;
                const switchField = decider === null ? undefined : sections.flatMap((x) => x.fields).find((f) => f.edits[0] === decider);
                const switchLabel = switchField === undefined ? undefined : msg(switchField.labelKey);
                return (
                  <div
                    key={field.key}
                    data-testid={`stage-rule-field-${topSegment(field)}`}
                    data-source={set ? "stage" : "division"}
                    className={`min-w-0 rounded-lg border border-slate-200 px-3 py-2 ${inert ? "bg-slate-50 [&_input]:bg-slate-100 [&_select]:bg-slate-100" : "bg-white"} ${field.kind === "sequence" ? "sm:col-span-2 lg:col-span-3" : ""}`}
                  >
                    <RuleFieldControl
                      sportKey={sportKey}
                      field={field}
                      value={values[field.key] ?? ""}
                      onEdit={(raw) => edit(field.key, raw)}
                      disabled={disabled || inert}
                      inherited={divisionConfig}
                      sequenceInherits={divisionConfig}
                      optionStates={s.id === "abandon" ? optionStates : undefined}
                      describedBy={s.id === "abandon" && reasons.length > 0 ? reasonId : undefined}
                      problem={
                        problems?.get(field.key) === undefined
                          ? undefined
                          : { text: problems.get(field.key)!.map((message) => configIssueText({ path: [], message }, msg)).join(" "), idScope: reasonId }
                      }
                    />
                    <span className={`mt-1 block text-[11px] ${set ? "text-teal-800" : "text-slate-600"}`}>
                      {msg(set ? "stageRules.source.stage" : "stageRules.source.division")}
                    </span>
                    {inert && switchLabel !== undefined && (
                      <span className="mt-1 block text-[11px] text-slate-600" data-testid={`stage-rule-detail-off-${topSegment(field)}`}>
                        {msg("stageRules.detail.off", { decider: switchLabel })}
                      </span>
                    )}
                    {s.id === "abandon" && reasons.length > 0 && (
                      <ul id={reasonId} className="mt-1 space-y-0.5 text-[11px] text-slate-600">
                        {reasons.map(([value, state]) => (
                          <li key={value} data-testid={`stage-abandon-unavailable-${value}`}>
                            {fieldOptionText(field, value, msg)}: {msg(state.reasonKey!)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
    </div>
  );
}

/** The fields the division's grid draws: the sport's visible rule fields, less those another control stands in for (`omit`)
 *  and those the variant has no use for (`state.hidden`). The grid and the strip's lock count read this one list, so the
 *  section's "every field is locked" is asked of exactly what is on screen. */
export function divisionGridFields(
  sportKey: string,
  values: Record<string, string>,
  inherited: Record<string, unknown> | undefined,
  omit: readonly string[] | undefined,
  state: RuleFormState | undefined,
): RuleField[] {
  return visibleRuleFields(sportKey, values, inherited).filter((f) => !omit?.includes(f.key) && state?.hidden.has(f.key) !== true);
}

/** The division's field grid (absorbed verbatim from `match-rules.tsx`): the builder's Basics and the Division rules strip. */
export function MatchRuleFields({
  sportKey,
  values,
  onChange,
  disabled = false,
  inherited,
  omit,
  lockedFields = [],
  state,
}: {
  sportKey: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
  /** The config `values` fall back to where a field is blank — the saved division config. Read for one thing only: whether
   *  the EFFECTIVE best-of is 1, in which case the grid shows one "Points to win" field that writes both points keys (owner
   *  ruling 2026-09-25 — see `visibleRuleFields`). */
  inherited?: Record<string, unknown>;
  /** Field keys another control stands in for (chess under Online play = Lichess: the clock picker). Their values stay in
   *  `values` and are still built on save — they are only not drawn. */
  omit?: readonly string[];
  /** W2c Task 20 (S4): the fields a started stage locks (`divisionLockedFields`, plus whatever a save has since refused). A
   *  locked field renders read-only (`data-locked`) before the organiser types, not after Save. Matched by the field's own
   *  key or any engine key it edits (`lockLineFor`). The lock is SAID once, by the section that holds the grid (Match Day C2
   *  fix round 1, I1: spec §12 items 4 and 13 - one lock line per section, never one per field). Left out by the division
   *  builder, which has no stage yet. */
  lockedFields?: readonly RefusedField[];
  /** W2e Task 29: what the form knows before Save (`ruleFormState`) - the write doors' sentences beside the fields they are
   *  about, the fields the variant has no use for (not drawn), and the detail a switch holds (drawn disabled, with why). */
  state?: RuleFormState;
}) {
  const msg = useMsg();
  const fields = divisionGridFields(sportKey, values, inherited, omit, state);
  if (fields.length === 0) return null;
  const edit = (key: string, raw: string) => onChange(setRuleValue(sportKey, values, key, raw, inherited));
  return (
    // Every box and picker holds the 44px tap floor (fix round 1, M7).
    <div className="grid gap-4 sm:grid-cols-3 [&_input]:min-h-11 [&_select]:min-h-11">
      {fields.map((field) => {
        const lock = lockLineFor(field.key, lockedFields, field.edits);
        const heldBy = state?.held.get(field.key);
        const problems = state?.invalid.get(field.key);
        return (
          // An ordered list needs the row's width; a number or a picker sits in a column.
          <div
            key={field.key}
            data-testid={`rule-field-${field.key}`}
            data-held={heldBy === undefined ? undefined : "true"}
            data-locked={lock === undefined ? undefined : "true"}
            className={field.kind === "sequence" ? "sm:col-span-3" : undefined}
          >
            <RuleFieldControl
              sportKey={sportKey}
              field={field}
              value={values[field.key] ?? ""}
              onEdit={(raw) => edit(field.key, raw)}
              disabled={disabled || lock !== undefined || heldBy !== undefined}
              inherited={inherited}
              problem={problems === undefined ? undefined : { text: problems.map((message) => configIssueText({ path: [], message }, msg)).join(" "), idScope: "division" }}
            />
            {heldBy !== undefined && (
              <p className="mt-1 text-[11px] leading-snug text-slate-700" data-testid={`rule-field-off-${field.key}`}>
                {msg("stageRules.detail.off", { decider: msg(heldBy) })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The read-only format: chips worded by the public line's describers, and the lock line for a stage that has started. No
 *  input, no select: what `mode: "locked"` means in every scope. */
function FormatChips({ chips, label, testId }: { chips: readonly string[]; label: string; testId: string }) {
  if (chips.length === 0) return null;
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label={label} data-testid={testId}>
      {chips.map((chip, i) => (
        <li
          key={`${chip}:${i}`}
          className="max-w-full break-words rounded-xl border border-slate-300 bg-white px-2.5 py-0.5 text-[11.5px] leading-snug text-slate-700"
        >
          {chip}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The props: one component, three scopes, two modes.
// ---------------------------------------------------------------------------------------------------------------------

export interface DivisionFormatProps {
  scope: "division";
  mode: RulesMode;
  sportKey: string;
  /** The sport's module: the locked chips' describers. */
  module: AnySportModule;
  /** The grid's raw values (`hydrateRuleValues`), the parent's state. */
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** The config the blanks fall back to (see `MatchRuleFields`), and in locked mode the format the chips say. Absent in the
   *  builder, which has no saved config yet. */
  inherited?: Record<string, unknown>;
  /** The public dictionary's `format.*` slice: the chips' words. Absent, locked mode says nothing. */
  ruleDict?: Dict;
  omit?: readonly string[];
  lockedFields?: readonly RefusedField[];
  state?: RuleFormState;
  disabled?: boolean;
}

export interface StageFormatProps {
  scope: "stage";
  mode: RulesMode;
  /** The server's lock (`formatLockedStageIds`: the stage has a first score): the lock line, said once. */
  started: boolean;
  /** Match Day C3 (review I3): whether a locked section says its own lock line. Default true (the section is the one place the lock is
   *  said). The stage card passes false: its summary line already carries the card's ONE lock line, and a panel opened under it must not
   *  repeat it. */
  showLockLine?: boolean;
  sportKey: string;
  module: AnySportModule;
  kind: StageKind;
  variant: string | null;
  /** The stage fragment's raw values (`stageFormatEditorValues`), the parent's state. */
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  divisionConfig: Record<string, unknown>;
  /** The cfg this stage plays with the edit (`resolvedStageCfg`), or null when the schema refuses it. */
  resolved: Record<string, unknown> | null;
  /** The public dictionary's `format.*` slice: the locked chips' words. */
  ruleDict?: Dict;
  disabled?: boolean;
}

export type FixtureFormatProps =
  | { scope: "fixture"; mode: "edit"; block: MatchRulesBlockProps }
  /** The format the match plays, in the public line's words (`effectiveLine`, `formatLineOf`). */
  | { scope: "fixture"; mode: "locked"; line: string };

export type MatchFormatEditorProps = DivisionFormatProps | StageFormatProps | FixtureFormatProps;

export function MatchFormatEditor(props: MatchFormatEditorProps) {
  const msg = useMsg();
  const label = msg("schedule.stageFormat.heading");
  if (props.scope === "fixture") {
    if (props.mode === "edit") return <MatchRulesBlock {...props.block} />;
    return (
      <div data-testid="match-format-readonly" data-scope="fixture">
        <FormatChips chips={props.line === "" ? [] : [props.line]} label={label} testId="match-format-chips" />
      </div>
    );
  }
  if (props.scope === "division") {
    if (props.mode === "locked") {
      const chips = props.ruleDict === undefined ? [] : divisionSummaryClauses(props.sportKey, props.module, props.inherited ?? {}).map((c) => rulesChipText(props.ruleDict!, c));
      return (
        <div data-testid="match-format-readonly" data-scope="division">
          <FormatChips chips={chips} label={label} testId="match-format-chips" />
        </div>
      );
    }
    return (
      <MatchRuleFields
        sportKey={props.sportKey}
        values={props.values}
        onChange={props.onChange}
        disabled={props.disabled}
        inherited={props.inherited}
        omit={props.omit}
        lockedFields={props.lockedFields}
        state={props.state}
      />
    );
  }
  if (props.mode === "locked") {
    const chips = props.ruleDict === undefined ? [] : stageSummaryClauses(props.sportKey, props.module, props.kind, props.resolved).map((c) => rulesChipText(props.ruleDict!, c));
    return (
      <div className="space-y-2" data-testid="match-format-readonly" data-scope="stage">
        {props.started && props.showLockLine !== false && <LockLine testId="stage-format-locked" />}
        <FormatChips chips={chips} label={label} testId="stage-format-chips" />
      </div>
    );
  }
  return (
    <StageRuleFields
      sportKey={props.sportKey}
      module={props.module}
      kind={props.kind}
      variant={props.variant}
      values={props.values}
      onChange={props.onChange}
      disabled={props.disabled ?? false}
      divisionConfig={props.divisionConfig}
      resolved={props.resolved}
    />
  );
}
