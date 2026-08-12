"use client";
// One PadActionView, rendered courtside-sized (S10/#419 W8, chassis item 2).
// A zero-field action (most admin actions — new ball, declare, follow-on) is
// a single tap: no expansion step, no confirm screen. An action WITH fields
// expands inline into an editor honouring each field's cfg-derived bounds
// (never hardcoded — the field IS the bound), then a confirm/cancel pair.
// `checkActionValidity`/`buildActionPayload` (view-model.ts) are the ONLY
// places that decide "can this fire" / "what payload does this build" — this
// file never re-derives either.
//
// Attribution is a typed seam, not built here: the attribution picker is a
// later pass (S10 dispatch scope). `renderAttribution`, when supplied, is
// handed the action, the live values map and a setter so a future picker
// writes into the SAME map `buildActionPayload` reads — never a parallel
// one. Absent (the default today), attribution simply stays unset, which
// `buildActionPayload` (via `buildPathObject`) omits from the payload.
import { useState, type ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { enumLabel, padLabel } from "@/lib/scoring-vocab";
import type { PadField, PadFieldValue } from "@seazn/engine/sport";
import { buildActionPayload, checkActionValidity, deriveFieldPathLabel, type PadActionView } from "./view-model";

export type ActionValues = Record<string, PadFieldValue | undefined>;

function initialValues(action: Pick<PadActionView, "fields">): ActionValues {
  // Toggles default to `false` (an ordinary checkbox's own default) so a
  // toggle-only action needs no forced tap before it validates; enum/number
  // fields have no honest default and stay unset until the scorer picks one.
  const values: ActionValues = {};
  for (const field of action.fields) if (field.kind === "toggle") values[field.path] = false;
  return values;
}

type MsgFn = ReturnType<typeof useMsg>;

/**
 * A plain function, deliberately NOT a JSX-invoked component: it is called
 * directly from `ActionForm`'s own render (`{renderField(...)}`), so its
 * returned elements land FLAT in the tree `ActionForm` returns rather than
 * behind a second, separately-instantiated component boundary. That is load-
 * bearing for testability, not merely style — this repo's node-only
 * `_hook-harness` walks a rendered tree by descending into `.props.children`
 * ONLY; it never invokes a nested custom component function, so a genuinely
 * separate `<FieldControl/>` component would make every input/select inside
 * it permanently invisible to `walk()`/`textOf()` (see
 * reference_hook_harness_click_without_dom.md — "keep it HOOKLESS and call
 * it directly"). Takes `msg` as a parameter rather than calling `useMsg()`
 * itself for the same reason: no hook of its own to desync from the caller's
 * cell list.
 */
function renderField(
  field: PadField,
  value: PadFieldValue | undefined,
  onChange: (value: PadFieldValue | undefined) => void,
  msg: MsgFn,
): ReactNode {
  // A declared `labelKey` always wins (S7/#427's dictionary copy). Absent
  // one, S10/#419 W8 fix 1 derives a REAL, VISIBLE caption from the field's
  // own dotted `path` (`deriveFieldPathLabel`, view-model.ts) — never the
  // `${action} #${n}` ordinal this replaces (the reported defect: cricket's
  // seven-field player-line action had no visible label at all, only an
  // invisible "Scorecard line #1".."#7" aria-label). `deriveFieldPathLabel`
  // is generated from an engine-supplied path string, not authored copy, so
  // it is deliberately never routed through msg()/a dictionary key — see its
  // own header in view-model.ts for why that is correct rather than a gap
  // `i18n:check` should catch (that gate only walks `src/dictionaries/**`
  // and never sees this string at all).
  //
  // `caption` is therefore always non-empty, so every field kind below gets
  // a real visible `<span>` wrapped by the same `<label>` that also wraps
  // its control — implicit label association, the same mechanism a
  // `labelKey`-bearing field already relied on, so no `aria-label` override
  // is needed (or rendered) for either case any more: the accessible name
  // and the visible text are now structurally the SAME string.
  const caption = field.labelKey ? padLabel(field.labelKey.key, msg, field.labelKey.label) : deriveFieldPathLabel(field.path);

  if (field.kind === "enum") {
    const bareField = field.path.split(".").pop()!;
    return (
      <label key={field.path} className="block">
        {caption && <span className="label">{caption}</span>}
        <select
          className="select"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="" disabled>
            {msg("scorepad.field.choose")}
          </option>
          {field.values.map((v) => (
            <option key={v} value={v}>
              {enumLabel(bareField, v, msg)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === "number") {
    const step = field.step ?? 1;
    return (
      <label key={field.path} className="block">
        {caption && <span className="label">{caption}</span>}
        <input
          type="number"
          className="input"
          min={field.min}
          max={field.max}
          step={step}
          value={value === undefined ? "" : (value as number)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const n = Number(raw);
            if (Number.isNaN(n)) return;
            // Clamp — a number field must never accept an out-of-range
            // value, whatever the input widget itself permits typing.
            onChange(Math.min(field.max, Math.max(field.min, n)));
          }}
        />
      </label>
    );
  }

  // toggle
  return (
    <label key={field.path} className="flex items-center gap-2">
      <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      {caption && <span className="label !mb-0">{caption}</span>}
    </label>
  );
}

export interface ActionFormProps {
  action: PadActionView;
  onSubmit: (payload: Record<string, unknown>) => void;
  /** True while a previous submit from this SAME tile is still in flight —
   *  disables the tap/confirm target so a slow network can't double-fire. */
  submitting?: boolean;
  /** Typed seam for the attribution picker (a later pass) — see the module
   *  header. */
  renderAttribution?: (
    action: PadActionView,
    values: ActionValues,
    setValue: (path: string, value: PadFieldValue | undefined) => void,
  ) => ReactNode;
}

export function ActionForm({ action, onSubmit, submitting = false, renderAttribution }: ActionFormProps) {
  const msg = useMsg();
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<ActionValues>(() => initialValues(action));
  const label = padLabel(action.labelKey.key, msg, action.labelKey.label);
  const validity = checkActionValidity(action, values);

  function setValue(path: string, value: PadFieldValue | undefined) {
    setValues((v) => ({ ...v, [path]: value }));
  }

  function reset() {
    setValues(initialValues(action));
    setExpanded(false);
  }

  function handleTap() {
    if (submitting) return;
    if (action.fields.length === 0) {
      onSubmit(buildActionPayload(action, values));
      return;
    }
    setExpanded(true);
  }

  function handleConfirm() {
    if (!validity.ok || submitting) return;
    onSubmit(buildActionPayload(action, values));
    reset();
  }

  if (!expanded) {
    return (
      <button
        type="button"
        className="btn btn-primary h-14 w-full text-base"
        onClick={handleTap}
        disabled={submitting}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="card space-y-3 border-2 border-accent-line p-3">
      <p className="label !mb-0">{label}</p>
      {action.fields.map((field) => renderField(field, values[field.path], (v) => setValue(field.path, v), msg))}
      {renderAttribution?.(action, values, setValue)}
      {!validity.ok && <p className="text-xs text-amber-700">{msg(validity.reason.key)}</p>}
      <div className="flex gap-2">
        <button type="button" data-role="cancel" className="btn btn-ghost flex-1" onClick={reset}>
          {msg("scorepad.action.cancel")}
        </button>
        <button
          type="button"
          data-role="confirm"
          className="btn btn-primary flex-1"
          onClick={handleConfirm}
          disabled={!validity.ok || submitting}
        >
          {msg("scorepad.action.confirm")}
        </button>
      </div>
    </div>
  );
}
