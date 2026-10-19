"use client";

// W2c Task 17 (S1): the stage format row's field sections for ANY sport - Match format, Deciders, If abandoned - each
// field with the source of the value it shows ("Division" while the stage inherits it, "This stage" once it sets it).
// Which fields exist comes from the engine's `ruleKeys` (`stageSections`), never a list of sports; the controls are the
// same `RuleFieldControl` the division editor renders, so the two cannot drift.
//
// One DOM at every width: the sections are plain blocks and each section's fields are a grid that stacks on a phone
// (`grid-cols-1`, two columns from `sm`), so a phone needs no second tree.
import { useId, useMemo } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { buildRuleOverride, setRuleValue, visibleRuleFields, type RuleField } from "@/lib/match-rules";
import type { StageKind } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import { RuleFieldControl, type OptionState } from "./rule-field-control";
import { abandonOptionStates, deciderOfDetail, detailIsInert, stageSections, type StageSectionId } from "./stage-row-model";

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
  const visible = useMemo(() => {
    const byKey = new Map(visibleRuleFields(sportKey, values, divisionConfig).map((f) => [f.key, f] as const));
    return sections.map((s) => ({
      id: s.id,
      fields: s.fields.map((f) => byKey.get(f.key)).filter((f): f is RuleField => f !== undefined),
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
                const switchLabel = decider === null ? undefined : sections.flatMap((x) => x.fields).find((f) => f.edits[0] === decider)?.label;
                return (
                  <div
                    key={field.key}
                    data-testid={`stage-rule-field-${topSegment(field)}`}
                    data-source={set ? "stage" : "division"}
                    className={`min-w-0 rounded-lg border border-slate-200 px-3 py-2 ${inert ? "bg-slate-50 [&_input]:bg-slate-100" : "bg-white"} ${field.kind === "sequence" ? "sm:col-span-2 lg:col-span-3" : ""}`}
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
                            {field.options?.find((o) => o.value === value)?.label ?? value}: {msg(state.reasonKey!)}
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
