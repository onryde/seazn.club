"use client";

// One curated rule field as a control: a number input, a Default/On/Off select for a boolean, a select for an option
// list, or the ordered-list control for a `sequence`. Extracted verbatim from `MatchRuleFields` (the division builder's
// and settings' grid) so the stage format row (`stage-rule-fields.tsx`) renders the same markup, the same D9 synthetic
// option for a saved value the picker cannot offer, and the same inherited placeholder: two editors that cannot drift.
//
// Every field's label, help and option text is drawn from the dictionary in all four locales (W2e Task 33a: `labelKey` is
// REQUIRED on a `RuleField`, `helpKey` is on any field that has a help, an option's `labelKey` on any option that names one),
// next to the picker chrome (Default / On / Off). The table's English `label` / `help` / option `label` is the fallback of its
// key, never what renders while the key resolves (`field-copy.test.ts` pins that the two say the same).
import { useMsg } from "@/components/i18n/dict-provider";
import type { RuleField } from "@/lib/match-rules";
import { optionText, ruleOptionText } from "@/lib/match-rules";
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
  problem,
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
  /** W2e Task 29: the sentence a write door would refuse this field's value with, drawn beside it (role="alert") and named by
   *  the control's `aria-describedby`; the control is `aria-invalid`. Absent: nothing is wrong with it.
   *  W2e T33a: the sentence comes WITH the scope that keeps its element id unique on the page. It is named by id, and the same
   *  field is drawn once per stage row as well as once in the division grid, so an id built from the field alone would repeat; one
   *  prop (not two) makes a sentence with no scope impossible to write. */
  problem?: { readonly text: string; readonly idScope: string };
}) {
  const msg = useMsg();
  // Derived, not `useId`: the test harness that expands this control (`expandWithHooks`) reads context hooks only. The caller's
  // `idScope` (a stage row's own `useId`, the division grid's constant) is what keeps two grids on a page from sharing an id.
  const problemId = `rule-problem-${problem?.idScope ?? "none"}-${sportKey}-${field.key}`;
  const described = [describedBy, problem === undefined ? undefined : problemId].filter((id) => id !== undefined).join(" ") || undefined;
  const invalidMark = problem === undefined ? undefined : true;
  const label = msg(field.labelKey);
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
    <>
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
          aria-describedby={described}
          aria-invalid={invalidMark}
          className="input"
        />
      ) : (
        <select
          disabled={disabled}
          value={value}
          onChange={(e) => onEdit(e.target.value)}
          aria-describedby={described}
          aria-invalid={invalidMark}
          className="select"
        >
          <option value="">{msg("rules.default")}</option>
          {/* D9 (owner ruling 2026-09-18) - a SAVED value this select cannot offer must be shown, not swallowed.
              Badminton's `bestOf` offers [1,3,5] while `{"bestOf":7}` is a perfectly valid saved config, and without
              this option the browser has nothing to land on and falls back to "Default" - telling the organiser the
              field is unset over a config that really carries a value. That misreading is one tap from data loss on the
              stage panel, whose PUT is a FRAGMENT where an omitted key means INHERIT.

              Labelled through `ruleOptionText` (`ruleOptionLabel` in the viewer's language) - the SAME lookup the stage card's summary line uses. This option
              shipped as a bare value, so the open dropdown read `Default · 5 · Best of 1 · Best of 3` directly under a
              summary line saying "Best of 5": one value, two labels, one screen. Falls back to the raw value when NO
              sport declares one - inventing copy for a value the table does not declare would be a second lie. */}
          {unofferable && <option value={value}>{ruleOptionText(sportKey, field.key, value, msg) ?? value}</option>}
          {field.kind === "bool" ? (
            <>
              <option value="on">{msg("rules.on")}</option>
              <option value="off">{msg("rules.off")}</option>
            </>
          ) : (
            (field.options ?? []).map((o) => (
              <option key={o.value} value={o.value} disabled={optionStates?.get(o.value)?.disabled === true}>
                {optionText(o, msg)}
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
    {/* Outside the label, so the sentence is not read as part of the control's name; the control names it by aria-describedby. */}
    {problem !== undefined && (
      <span id={problemId} role="alert" className="mt-1 block text-[11px] font-medium leading-snug text-red-700">
        {problem.text}
      </span>
    )}
    </>
  );
}
