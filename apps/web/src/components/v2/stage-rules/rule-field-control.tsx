"use client";

// One curated rule field as a control: a number input, a Default/On/Off select for a boolean, a select for an option
// list, or the ordered-list control for a `sequence`. Extracted verbatim from `MatchRuleFields` (the division builder's
// and settings' grid) so the stage format row (`stage-rule-fields.tsx`) renders the same markup, the same D9 synthetic
// option for a saved value the picker cannot offer, and the same inherited placeholder: two editors that cannot drift.
//
// Field labels and options are sport-rules vocabulary, kept canonical English like sport and format names; only the
// picker chrome (Default / On / Off) localizes - EXCEPT a field that names a dictionary key (`labelKey`, `helpKey`, an
// option's `labelKey`): W2e Task 28 (owner D5) asks the five ruling-157 fields for all four locales, so those are drawn
// from the dictionary and every other field keeps its English `label`. The English text is the fallback either way.
import { useMsg } from "@/components/i18n/dict-provider";
import type { RuleField } from "@/lib/match-rules";
import { ruleOptionLabel } from "@/lib/match-rules";
import type { MessageKey } from "@/lib/messages";
import { SequenceField } from "./sequence-field";

/** An option the control shows but does not let the organiser pick, with the dictionary key of why (owner P-5). */
export interface OptionState {
  readonly disabled: boolean;
  readonly reasonKey: MessageKey | null;
}

/**
 * What a BLANK number field says it falls back to. "Default" alone hid the number: on a best-of-1 volleyball stage the
 * single "Points to win" field read "Default" while the match plays to the division's deciding set, 15 - not the 25 an
 * organiser would guess. Where the editor is told what a blank inherits (`inherited`: the stage editor's division config,
 * the settings editor's variant), the placeholder names it; where it is not (the builder), it stays "Default" rather than
 * invent one.
 */
export function inheritedPlaceholder(defaultWord: string, inheritedValue: unknown): string {
  return typeof inheritedValue === "number" && Number.isFinite(inheritedValue)
    ? `${defaultWord} (${inheritedValue})`
    : defaultWord;
}

export function RuleFieldControl({
  sportKey,
  field,
  value,
  onEdit,
  disabled = false,
  inherited,
  sequenceInherits,
  optionStates,
  describedBy,
}: {
  sportKey: string;
  field: RuleField;
  /** The raw value now, "" when blank. */
  value: string;
  onEdit: (raw: string) => void;
  disabled?: boolean;
  inherited?: Record<string, unknown>;
  /** The config an ordered list's BLANK value inherits - the stage editor's division. Left out by the division editor, where a
   *  blank list is the engine's default order (G1, round 2). */
  sequenceInherits?: Record<string, unknown>;
  /** Per option value: unavailable, with why (the abandon select's `share`). */
  optionStates?: ReadonlyMap<string, OptionState>;
  /** The id of the element that says why an option is unavailable, so the select is described by it. */
  describedBy?: string;
}) {
  const msg = useMsg();
  const label = field.labelKey === undefined ? field.label : msg(field.labelKey);
  const help = field.helpKey === undefined ? field.help : msg(field.helpKey);
  const offered = field.kind === "bool" ? ["on", "off"] : (field.options ?? []).map((o) => o.value);
  const unofferable = field.kind !== "sequence" && value !== "" && !offered.includes(value);

  if (field.kind === "sequence") {
    return (
      <div className="block">
        <span className="label">{label}</span>
        <SequenceField
          field={field}
          value={value}
          onChange={onEdit}
          disabled={disabled}
          inheritedValue={sequenceInherits === undefined ? undefined : field.read?.(sequenceInherits)}
        />
        {help && <span className="mt-0.5 block text-[11px] text-slate-600">{help}</span>}
      </div>
    );
  }

  return (
    <label className="block">
      <span className="label">{label}</span>
      {field.kind === "number" ? (
        <input
          type="number"
          min={field.min}
          max={field.max}
          disabled={disabled}
          value={value}
          onChange={(e) => onEdit(e.target.value)}
          placeholder={inheritedPlaceholder(msg("rules.default"), inherited?.[field.key])}
          className="input"
        />
      ) : (
        <select
          disabled={disabled}
          value={value}
          onChange={(e) => onEdit(e.target.value)}
          aria-describedby={describedBy}
          className="select"
        >
          <option value="">{msg("rules.default")}</option>
          {/* D9 (owner ruling 2026-09-18) - a SAVED value this select cannot offer must be shown, not swallowed.
              Badminton's `bestOf` offers [1,3,5] while `{"bestOf":7}` is a perfectly valid saved config, and without
              this option the browser has nothing to land on and falls back to "Default" - telling the organiser the
              field is unset over a config that really carries a value. That misreading is one tap from data loss on the
              stage panel, whose PUT is a FRAGMENT where an omitted key means INHERIT.

              Labelled through `ruleOptionLabel` - the SAME lookup the stage card's summary line uses. This option
              shipped as a bare value, so the open dropdown read `Default · 5 · Best of 1 · Best of 3` directly under a
              summary line saying "Best of 5": one value, two labels, one screen. Falls back to the raw value when NO
              sport declares one - inventing copy for a value the table does not declare would be a second lie. */}
          {unofferable && <option value={value}>{ruleOptionLabel(sportKey, field.key, value) ?? value}</option>}
          {field.kind === "bool" ? (
            <>
              <option value="on">{msg("rules.on")}</option>
              <option value="off">{msg("rules.off")}</option>
            </>
          ) : (
            (field.options ?? []).map((o) => (
              <option key={o.value} value={o.value} disabled={optionStates?.get(o.value)?.disabled === true}>
                {o.labelKey === undefined ? o.label : msg(o.labelKey)}
              </option>
            ))
          )}
        </select>
      )}
      {help && (
        /* R3.5/Task P - was text-slate-400 (2.63:1 on the .card this span renders inside at both call sites, under the
           WCAG AA 4.5:1 floor); text-slate-600 clears 7.58:1. Every field's help text renders through here. */
        <span className="mt-0.5 block text-[11px] text-slate-600">{help}</span>
      )}
    </label>
  );
}
