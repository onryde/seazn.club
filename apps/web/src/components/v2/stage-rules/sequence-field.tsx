"use client";

// The control for an ORDERED-LIST rule field (`kind: "sequence"`): chess's knockout tie-break games, played in the order
// the stage lists them (BG-KO-1, BG-KO-3). A list of items you reorder and remove, and a menu that adds one of the
// field's declared options not already in it.
//
// Three states, because a blank raw value means "unset" everywhere in the editor:
//   - blank  -> the engine's own default (every declared option, in declared order). Shown as the list, so it can be
//               reordered; the first edit makes it the stage's own list, and "Use the default order" puts it back.
//   - a list -> the stage's own list, in the order shown.
//   - EMPTY  -> `field.emptyValue` ("no tie-break games"): a drawn game is held for the organiser, who decides it. This
//               is a value of its own, never a blank - a blank would drop the stage's saved empty list on the next save
//               (carry I2, Task 8's review).
// One DOM at every width: every button is a 44px tap target, and the list is a single column, so a phone needs no second
// tree.
import { useMsg } from "@/components/i18n/dict-provider";
import type { RuleField } from "@/lib/match-rules";

/** The raw value as a list: the field's own default order for a blank, `[]` for the empty token, else the items in order. */
export function sequenceItems(field: RuleField, value: string): string[] {
  if (value === "") return (field.options ?? []).map((o) => o.value);
  if (field.emptyValue !== undefined && value === field.emptyValue) return [];
  return value.split(",").filter((v) => v !== "");
}

/** A list as the raw value. An empty list is the field's empty token (never a blank, which means "unset"); a field with
 *  no such token has no way to say "empty on purpose" and falls back to unset. */
export function sequenceValue(field: RuleField, items: readonly string[]): string {
  return items.length === 0 ? (field.emptyValue ?? "") : items.join(",");
}

/** The list with the item at `index` moved one place (`by` -1 up, +1 down); the same list when the move would leave it. */
export function moveSequenceItem(items: readonly string[], index: number, by: -1 | 1): string[] {
  const to = index + by;
  if (index < 0 || index >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item!);
  return next;
}

const ICON = "h-4 w-4";
const BUTTON =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple-600 disabled:cursor-not-allowed disabled:opacity-40";

export function SequenceField({
  field,
  value,
  onChange,
  disabled = false,
}: {
  field: RuleField;
  value: string;
  onChange: (raw: string) => void;
  disabled?: boolean;
}) {
  const msg = useMsg();
  const items = sequenceItems(field, value);
  const isDefault = value === "";
  const labelOf = (v: string): string => field.options?.find((o) => o.value === v)?.label ?? v;
  const remaining = (field.options ?? []).filter((o) => !items.includes(o.value));
  const set = (next: readonly string[]) => onChange(sequenceValue(field, next));
  const move = (i: number, by: -1 | 1) => set(moveSequenceItem(items, i, by));
  const testId = `stage-rule-sequence-${field.key}`;

  return (
    <div role="group" aria-label={field.label} data-testid={testId} className="mt-1 rounded-lg border border-slate-200 bg-white">
      {items.length === 0 ? (
        <p className="px-3 py-3 text-xs text-slate-700" data-testid={`${testId}-empty`}>
          {msg("stageRules.sequence.empty")}
        </p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {items.map((v, i) => (
            <li key={v} data-testid={`${testId}-item-${i}`} className="flex items-center gap-1 pl-3 pr-1">
              <span className="min-w-0 flex-1 truncate py-2 text-sm text-slate-800">{labelOf(v)}</span>
              <button
                type="button"
                className={BUTTON}
                aria-label={msg("stageRules.sequence.moveUp", { item: labelOf(v) })}
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3.5 10 8 5.5 12.5 10" />
                </svg>
              </button>
              <button
                type="button"
                className={BUTTON}
                aria-label={msg("stageRules.sequence.moveDown", { item: labelOf(v) })}
                disabled={disabled || i === items.length - 1}
                onClick={() => move(i, 1)}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3.5 6 8 10.5 12.5 6" />
                </svg>
              </button>
              <button
                type="button"
                className={BUTTON}
                aria-label={msg("stageRules.sequence.remove", { item: labelOf(v) })}
                disabled={disabled}
                onClick={() => set(items.filter((x) => x !== v))}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            </li>
          ))}
        </ol>
      )}
      {(remaining.length > 0 || !isDefault) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-2 py-2">
          {remaining.length > 0 && (
            <select
              className="select min-h-11 min-w-0 flex-1"
              aria-label={`${field.label}: ${msg("stageRules.sequence.add")}`}
              data-testid={`${testId}-add`}
              disabled={disabled}
              value=""
              onChange={(e) => {
                if (e.target.value !== "") set([...items, e.target.value]);
              }}
            >
              <option value="">{msg("stageRules.sequence.add")}</option>
              {remaining.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {!isDefault && (
            <button type="button" className="btn btn-ghost min-h-11 px-3 text-xs" data-testid={`${testId}-reset`} disabled={disabled} onClick={() => onChange("")}>
              {msg("stageRules.sequence.reset")}
            </button>
          )}
        </div>
      )}
      {isDefault && <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-600">{msg("stageRules.sequence.default")}</p>}
    </div>
  );
}
