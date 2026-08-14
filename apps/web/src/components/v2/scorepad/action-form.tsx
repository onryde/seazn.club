"use client";
// One PadActionView, rendered courtside-sized (S10/#419 W8, chassis item 2).
// A zero-field action with NO attribution requirement either (most admin
// actions — new ball, declare, follow-on) is a single tap: no expansion
// step, no confirm screen. An action with fields, a required attribution, or
// both expands inline instead — fields into an editor honouring each
// field's cfg-derived bounds (never hardcoded — the field IS the bound),
// attribution into whatever `renderAttribution` below supplies — then a
// confirm/cancel pair. `checkActionValidity`/`buildActionPayload`
// (view-model.ts) are the ONLY places that decide "can this fire" / "what
// payload does this build" — this file never re-derives either.
//
// Attribution collection itself is a typed seam, not built here:
// `renderAttribution`, when supplied (every real caller does — see
// pad-renderer.tsx's default wiring and each skin's own), is handed the
// action, the live values map and a setter so the picker writes into the
// SAME map `buildActionPayload` reads — never a parallel one. `handleTap`
// below must actually reach that seam before a payload can be built: every
// `PadAttributionItem` an action declares is REQUIRED — there is no
// per-item optional flag (`PadAttributionItem`'s own header,
// packages/engine/src/sport/module.ts) — so a non-empty `attribution` has to
// expand exactly like a non-empty `fields` does. S13 W11 fix: before, only
// `fields.length` gated the decision, so a zero-field action with a required
// attribution (`tennis.game.award`'s `winner`, and the same shape in
// carrom/generic/setbased-kernel's rally+sub actions) auto-submitted an
// incomplete payload on the very first tap — flagged but left unfixed by
// S5/#431 (docs/superpowers/specs/2026-08-06-scoringpad-v2-prompts/_INDEX.md,
// "gameAward panel" entry).
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
          className="select min-h-11"
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
          className="input min-h-11"
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
  /** S13 W11 follow-up — notified whenever THIS form's own expand/collapse
   *  state changes (tap to open, confirm/cancel to close). `expanded` lives
   *  entirely in this component's own state (module header: "ActionForm
   *  stays a REAL component"), so a parent that shares a visual grid row
   *  across several actions (panel.tsx's `grid`/`perSide` layouts) has no
   *  other way to learn "is my child currently the tall one" — the fact it
   *  needs to keep that row's DOM/tab order matching what is actually on
   *  screen. Omitted ⇒ no-op, exactly like every other optional render-prop
   *  here. */
  onExpandedChange?: (expanded: boolean) => void;
  /** S13 W11 follow-up — an explicit CSS `order` for this form's own root
   *  element (the collapsed button OR the expanded card). A parent may
   *  freely reorder this component in the DOM (e.g. so a keyboard tab walk
   *  never lands on a still-short sibling AFTER an expanded one) while
   *  pinning it to a FIXED on-screen position via `order` — which, unlike
   *  DOM position, plays no part in the browser's default tab sequence.
   *  Omitted ⇒ no inline style, i.e. today's plain DOM-order placement. */
  order?: number;
}

export function ActionForm({
  action,
  onSubmit,
  submitting = false,
  renderAttribution,
  onExpandedChange,
  order,
}: ActionFormProps) {
  const msg = useMsg();
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<ActionValues>(() => initialValues(action));
  const label = padLabel(action.labelKey.key, msg, action.labelKey.label);
  const validity = checkActionValidity(action, values);
  const orderStyle = order === undefined ? undefined : { order };

  function setValue(path: string, value: PadFieldValue | undefined) {
    setValues((v) => ({ ...v, [path]: value }));
  }

  function reset() {
    setValues(initialValues(action));
    setExpanded(false);
    onExpandedChange?.(false);
  }

  function handleTap() {
    if (submitting) return;
    // Fast-path only when NEITHER fields NOR attribution need input — every
    // declared attribution item is required (module header above), so a
    // non-empty `action.attribution` must expand exactly like a non-empty
    // `action.fields` already did, or the picker never runs and the built
    // payload is missing a required key.
    if (action.fields.length === 0 && action.attribution.length === 0) {
      onSubmit(buildActionPayload(action, values));
      return;
    }
    setExpanded(true);
    onExpandedChange?.(true);
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
        style={orderStyle}
      >
        {label}
      </button>
    );
  }

  // S12/#421 — `col-span-2` below sm. An EXPANDED form keeps the single grid
  // cell its collapsed button occupied, and two of the four panel layouts
  // (`grid`, `perSide`, panel.tsx) are `grid grid-cols-2` at every width. At
  // 320 that is a 110px form inside a 228px panel — measured, not estimated —
  // and everything inside it inherits the squeeze: a number input under 90px,
  // and attribution chips whose `overflow-x-auto` row now scrolls for a roster
  // that would otherwise have fitted. The page itself never scrolls
  // horizontally, so the 320 no-horizontal-scroll gate passes throughout; this
  // is only visible by looking. Found on the universal renderer's device-link
  // entry point, which is the courtside surface most likely to BE 320.
  //
  // A grid child spanning both columns is the whole fix: the collapsed button
  // still tiles 2-up (the density courtside wants), and only the one action
  // being filled in takes the full row. `sm:col-span-1` restores today's
  // side-by-side behaviour from 640 up, where half a row is 340px+ and reads
  // correctly — so 768 and 1280 are byte-identical to before. Inert in the
  // other two layouts: `col-span-*` does nothing to a flex child.
  return (
    <div className="card col-span-2 space-y-3 border-2 border-accent-line p-3 sm:col-span-1" style={orderStyle}>
      <p className="label !mb-0">{label}</p>
      {action.fields.map((field) => renderField(field, values[field.path], (v) => setValue(field.path, v), msg))}
      {renderAttribution?.(action, values, setValue)}
      {!validity.ok && <p className="text-xs text-amber-700">{msg(validity.reason.key)}</p>}
      <div className="flex gap-2">
        {/* `min-h-11` (44px), not the `.btn` class alone: `btn-ghost` renders
            38px here, under the repo's 44px touch floor, and Tailwind's
            utilities layer wins over the components-layer `.btn` — the same
            override that made cricket's over pickers 33px. Measured at
            320/375/1280 on both the console and the device pad (S13/#422). */}
        <button type="button" data-role="cancel" className="btn btn-ghost min-h-11 flex-1" onClick={reset}>
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
