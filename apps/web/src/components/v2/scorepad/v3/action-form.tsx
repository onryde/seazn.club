"use client";
// The v3 chassis's generic padSpec(cfg) action form (R2/task B, spec item
// 4 — "the More sheet"). Cricket's 13 non-`cricket.ball` event types dispatch
// through this — the 5 that get their own phase-aware tile ALSO reach this
// same generic path when THEIR tile opens (pad-host.tsx decides which; this
// file never knows or cares) — and the 8 that don't ride here behind the
// skin's single "More" tile (`MORE_SHEET_KEY`, types.ts).
//
// PORTED from the legacy universal renderer's own action-form.tsx +
// cricket-skin.tsx's AdminGroup (line 831/863) — never IMPORTED from
// either: cricket-skin.tsx is v2 skin surface R8 deletes outright, and the
// legacy renderer (pad-renderer.tsx/action-form.tsx/panel.tsx) is the
// visual/interaction layer v3 supersedes (design doc §1, "the v3 substrate
// survives; the visual/interaction layer does not"). What DOES survive and
// IS reused here, verbatim: view-model.ts's pure, sport-agnostic decision
// helpers (`checkActionValidity`/`buildActionPayload`/`deriveFieldPathLabel`
// /`PadActionView`) — those sit BELOW either renderer, already tested
// (view-model.test.ts/view-model-coverage.test.ts), and are exactly the
// "reuse an existing primitive" case, not a v2-skin dependency.
//
// "It must render any padSpec(cfg) action generically, so a future engine
// action appears without a skin edit" (task brief, item 4): this file has
// ZERO per-type branching anywhere — `ActionFormList` walks whatever
// `PadActionView[]` pad-host.tsx hands it (that list itself is computed
// generically there too — see its own `moreActions` builder), and
// `renderActionRow` below renders ANY action from its own declared
// fields/attribution/availability alone.
//
// ONE STATEFUL COMPONENT, NOT N (repo-wide `_hook-harness` constraint —
// same reasoning context-strip.tsx's/swap-sheet.tsx's own header gives for
// `renderCandidateRow`, and guided-sheet.tsx's for `renderChoiceRow`):
// apps/web's node-only harness renders one function component ONE level
// deep — a genuinely separate `<ActionTile/>` per action, each with its OWN
// `useState`, would make every field/button INSIDE it invisible to
// `walk()`/`textOf()`, since the harness never invokes a nested custom
// component's own function. The legacy renderer's `ActionForm` (which this
// ports) got away with per-action `useState` because the LEGACY suite tests
// it through `panel.tsx`'s own multi-component tree at a different layer;
// this file instead keeps ALL interactive state (which action is expanded,
// each one's in-progress field values) in `ActionFormList` alone, and
// `renderActionRow` is a PLAIN FUNCTION — data/callbacks in, JSX out, no
// hook of its own — called directly from `ActionFormList`'s own render body,
// so its output lands FLAT in the tree the harness walks.
//
// SPLIT (matches every other v3 primitive — scorebug/tile-grid/detail-dock/
// guided-sheet): `initialActionValues` is a pure, exported builder — data
// in, data out, no React — because apps/web vitest is environment:"node"
// with no jsdom. `ActionFormList`'s own rendering is proved through the
// shared `_hook-harness` (renderIsland/walk/textOf/propsOf), the same idiom
// guided-sheet.test.ts already establishes for a wizard-shaped v3 primitive.
//
// RENDERER DESIGN (frontend-design pass, R2/task B): this sheet sits beside
// guided-sheet.tsx/swap-sheet.tsx on the SAME "sheet" surface family (all
// three open from a tile's `{sheet}` action) and deliberately reuses their
// exact card idiom (plain white/slate-200 card) and button vocabulary
// (violet-600 = "the chosen thing" / Confirm, dashed slate-300 = quietest
// control / Cancel, matching guided-sheet.tsx's own cancelButtonClass
// precedent) rather than the legacy renderer's `.btn`/`.card` classes — a
// scorer moving from a guided sheet to the More sheet should not be able to
// tell the two were built by different code. A locked action gets the same
// amber-worded treatment recording-chip.tsx already uses for "never a bare
// padlock" (`text-amber-700`), never a disabled control with no
// explanation.
import { useState } from "react";
import type { ReactNode } from "react";
import { enumLabel, padLabel } from "@/lib/scoring-vocab";
import type { LineupPair, SquadState } from "@seazn/engine/core";
import type { PadAttributionItem, PadField, PadFieldValue } from "@seazn/engine/sport";
import { buildActionPayload, checkActionValidity, deriveFieldPathLabel, type PadActionView } from "../view-model";
// Attribution collection — the missing half of this file's own port (see
// this file's header, "attribution collection itself is a typed seam").
// `candidatesForPerson`/`attributionItemCaption` are PURE, sport-agnostic
// helpers (already unit-proved by attribution-picker.test.tsx's own "shape
// sweep") — reused verbatim exactly like view-model.ts's helpers above,
// never re-derived a third time (cricket-skin.tsx's own `renderSkinAttribution`
// is the second copy already; a v3 rewrite would be a third). Only the JSX
// is ported below (`renderAttributionRow`), in this file's own chip idiom —
// never the `AttributionPicker` COMPONENT itself, which calls `useMsg()` and
// would be invisible to `walk()` for the exact reason this file's header
// gives for keeping `renderActionRow`/`renderField` plain functions.
import { attributionItemCaption, candidatesForPerson } from "../attribution-picker";
import type { TFn } from "./context-strip";

export type ActionFormValues = Record<string, PadFieldValue | undefined>;

/**
 * The wizard's start values for one action: every `toggle` field defaults
 * to `false` (an ordinary checkbox's own default, so a toggle-only action
 * needs no forced tap before it validates); `enum`/`number` fields have no
 * honest default and stay unset until the scorer picks one — mirrors the
 * legacy renderer's own `initialValues` exactly (action-form.tsx), ported
 * rather than imported (this file's own header).
 */
export function initialActionValues(action: Pick<PadActionView, "fields">): ActionFormValues {
  const values: ActionFormValues = {};
  for (const field of action.fields) if (field.kind === "toggle") values[field.path] = false;
  return values;
}

const fieldLabelClass = "mk-eyebrow block text-slate-600";
const inputClass =
  "mt-1 w-full min-h-11 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400";

/**
 * A plain function, deliberately NOT its own JSX component — see this
 * file's own header. Same precedent as context-strip.tsx's
 * `renderCandidateRow` and the legacy action-form.tsx's own `renderField`
 * (which this ports).
 */
function renderField(
  field: PadField,
  value: PadFieldValue | undefined,
  onChange: (value: PadFieldValue | undefined) => void,
  t: TFn,
): ReactNode {
  const caption = field.labelKey ? padLabel(field.labelKey.key, t, field.labelKey.label) : deriveFieldPathLabel(field.path);

  if (field.kind === "enum") {
    const bareField = field.path.split(".").pop()!;
    return (
      <label key={field.path} className="block">
        {caption && <span className={fieldLabelClass}>{caption}</span>}
        <select
          className={inputClass}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="" disabled>
            {t("scorepad.field.choose")}
          </option>
          {field.values.map((v) => (
            <option key={v} value={v}>
              {enumLabel(bareField, v, t)}
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
        {caption && <span className={fieldLabelClass}>{caption}</span>}
        <input
          type="number"
          className={inputClass}
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
      {caption && <span className="text-sm text-slate-700">{caption}</span>}
    </label>
  );
}

/**
 * Candidate (value, label) pairs for one attribution item. "side" items
 * offer the two entrants by their real lineup id, worded Home/Away — never
 * a raw entrant id, and never sourced from the roster (a side is not a
 * person). "person" items reuse `candidatesForPerson` (attribution-picker.tsx),
 * which reads BOTH sides' squads: the engine's own `PadAttributionItem`
 * names no side for a person item — cricket's fielder may be either side's
 * player structurally — so a sport-agnostic picker cannot narrow further
 * than the item itself does.
 */
function attributionOptions(
  item: PadAttributionItem,
  squads: SquadState,
  lineups: LineupPair,
  personNames: Readonly<Record<string, string>>,
  t: TFn,
): readonly { value: string; label: string }[] {
  if (item.kind === "side") {
    return [
      { value: lineups.home.entrantId, label: t("scorepad.attribution.home") },
      { value: lineups.away.entrantId, label: t("scorepad.attribution.away") },
    ];
  }
  return candidatesForPerson(item, squads).map((c) => ({
    value: c.personId,
    label: personNames[c.personId] ?? t("eventCopy.unknownPerson"),
  }));
}

/**
 * One attribution item's own chip row — a plain function, deliberately NOT
 * a JSX-invoked component, called directly from `renderActionRow`'s
 * expanded branch so its chips land FLAT in the tree the harness walks
 * (this file's own header; same reasoning as `renderField` above and
 * attribution-picker.tsx's own `renderAttributionItem`, which this ports —
 * reusing its PURE caption helper verbatim and re-expressing only the JSX,
 * in THIS file's own violet-600-pressed/slate-200-idle chip idiom rather
 * than attribution-picker.tsx's `.card`-family chip class, matching this
 * file's own header note on why the sheet reuses v3's card idiom rather
 * than the legacy renderer's classes).
 *
 * R8/WS-B2 — "disabled-until-complete" (owner-picked design): a row whose
 * item is `required` (engine-stamped, `checkActionValidity`'s own new
 * gate — view-model.ts) gets a red asterisk plus a small "required"
 * microcopy line, purely presentational here; `renderActionRow` below is
 * what actually disables Confirm, by feeding the SAME `item.required`
 * through `checkActionValidity` — one flag, read in both places, never two
 * gates that could drift (this repo's most-repeated defect class). An
 * optional item (falsy/absent `required`) renders exactly as before.
 */
function renderAttributionRow(
  item: PadAttributionItem,
  index: number,
  actionLabel: string,
  value: PadFieldValue | undefined,
  onSelect: (v: PadFieldValue | undefined) => void,
  squads: SquadState,
  lineups: LineupPair,
  personNames: Readonly<Record<string, string>>,
  t: TFn,
): ReactNode {
  const caption = attributionItemCaption(item, index, t, actionLabel);
  const options = attributionOptions(item, squads, lineups, personNames, t);
  const required = item.required === true;
  const requiredMicrocopy = t("scorepad.attribution.required");
  return (
    <div
      key={item.path}
      data-attribution-path={item.path}
      data-required={required || undefined}
      role="group"
      aria-label={required ? `${caption} — ${requiredMicrocopy}` : caption}
      className="space-y-1"
    >
      <span className={fieldLabelClass}>
        {caption}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-red-600">
            *
          </span>
        )}
      </span>
      {required && <p className="text-xs font-medium text-red-600">{requiredMicrocopy}</p>}
      {options.length === 0 ? (
        <p className="text-xs text-slate-600">{t("scorepad.attribution.noRoster")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => {
            const pressed = value === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                data-value={opt.value}
                aria-pressed={pressed}
                onClick={() => onSelect(pressed ? undefined : opt.value)}
                style={{ minHeight: 44 }}
                className={`inline-flex shrink-0 items-center rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 ${
                  pressed
                    ? "border-transparent bg-violet-600 text-white hover:bg-violet-700"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * One action's row — a plain function (this file's own header), called
 * directly from `ActionFormList`'s render body. Collapsed: a single 44px
 * tap target naming the action; tapping it either submits immediately
 * (`onTap`, for a zero-field/zero-attribution action — the decision itself
 * lives in `ActionFormList`, this function only ever RENDERS whichever
 * state it is handed) or expands into the field editor. A locked action
 * (`availability.kind === "locked"`) renders the worded reason instead of
 * any tappable control at all — never a bare disabled tile.
 */
function renderActionRow(params: {
  action: PadActionView;
  t: TFn;
  expanded: boolean;
  values: ActionFormValues;
  submitting: boolean;
  squads: SquadState;
  lineups: LineupPair;
  personNames: Readonly<Record<string, string>>;
  onTap: () => void;
  onChange: (path: string, value: PadFieldValue | undefined) => void;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  const { action, t, expanded, values, submitting, squads, lineups, personNames, onTap, onChange, onConfirm, onCancel } = params;
  const label = padLabel(action.labelKey.key, t, action.labelKey.label);

  if (action.availability.kind === "locked") {
    return (
      <div key={action.type} className="rounded-xl border border-dashed border-slate-300 bg-transparent px-4 py-2.5">
        <p className="break-words text-sm font-medium text-slate-500">{label}</p>
        <p className="mt-0.5 break-words text-xs font-medium text-amber-700">{t(action.availability.reason.key)}</p>
      </div>
    );
  }

  if (!expanded) {
    return (
      <button
        key={action.type}
        type="button"
        onClick={onTap}
        disabled={submitting}
        style={{ minHeight: 44 }}
        className="w-full rounded-xl border-2 border-slate-200 bg-white px-4 text-center text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 disabled:opacity-40"
      >
        <span className="break-words">{label}</span>
      </button>
    );
  }

  const validity = checkActionValidity(action, values);
  return (
    <div key={action.type} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <p className="mk-eyebrow px-4 pt-3 text-slate-600">{label}</p>
      <div className="space-y-3 px-4 py-3">
        {action.fields.map((field) => renderField(field, values[field.path], (v) => onChange(field.path, v), t))}
        {action.attribution.map((item, index) =>
          renderAttributionRow(item, index, label, values[item.path], (v) => onChange(item.path, v), squads, lineups, personNames, t),
        )}
        {!validity.ok && <p className="text-xs font-medium text-amber-700">{t(validity.reason.key)}</p>}
      </div>
      <div className="flex gap-2 px-4 pb-3">
        <button
          type="button"
          onClick={onCancel}
          style={{ minHeight: 44 }}
          className="min-w-0 flex-1 shrink-0 break-words rounded-full border border-dashed border-slate-300 bg-transparent px-4 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
        >
          {t("scorepad.action.cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!validity.ok || submitting}
          style={{ minHeight: 44 }}
          className="min-w-0 flex-1 shrink-0 break-words rounded-full border border-transparent bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 disabled:opacity-40"
        >
          {t("scorepad.action.confirm")}
        </button>
      </div>
    </div>
  );
}

export interface ActionFormListProps {
  /** Every action this sheet hosts, in declaration order — pad-host.tsx's
   *  own `moreActions` builder computes this list generically (every
   *  `padSpec(cfg)` action not already reachable through a dedicated tile
   *  or guided sheet), so a future engine action appears here automatically
   *  with no edit to this file OR to any skin. */
  actions: readonly PadActionView[];
  t: TFn;
  /** The type currently mid-flight, or `null` — only the matching row reads
   *  as submitting; every other action in the list stays live. */
  submittingType: string | null;
  onSubmit: (type: string, payload: Record<string, unknown>) => void;
  /** Attribution candidate source — REQUIRED, not optional. An optional
   *  prop here is exactly how S10's own attribution picker shipped
   *  reachable only if a caller remembered to pass it (pad-renderer.tsx's
   *  own header states this explicitly as the programme's repeated
   *  defect); pad-host.tsx (this file's one real caller) always has all
   *  three already resolved, so there is no case where a required prop
   *  costs a real caller anything. */
  squads: SquadState;
  lineups: LineupPair;
  personNames: Readonly<Record<string, string>>;
}

/**
 * Renders every action in `actions` as its own row (`renderActionRow`), or
 * the `pad.host.moreEmpty` empty-state copy for a genuinely empty list
 * (never a blank sheet — same "worded, not blank" posture swap-sheet.tsx's
 * own empty state takes). A zero-field, zero-attribution action (most admin
 * actions: new ball, declare, follow-on) submits on the FIRST tap, no
 * expansion — every declared attribution item is required (engine's own
 * `PadAttribution` doc), so a non-empty `action.attribution` must expand
 * exactly like a non-empty `action.fields` already does, mirroring the
 * legacy renderer's own fast-path rule (action-form.tsx). Each action tracks
 * its OWN expand/values independently — collapsing one action never
 * discards another's in-progress entry.
 */
export function ActionFormList({ actions, t, submittingType, onSubmit, squads, lineups, personNames }: ActionFormListProps) {
  const [expandedTypes, setExpandedTypes] = useState<ReadonlySet<string>>(() => new Set());
  const [valuesByType, setValuesByType] = useState<Readonly<Record<string, ActionFormValues>>>({});

  function valuesFor(action: PadActionView): ActionFormValues {
    return valuesByType[action.type] ?? initialActionValues(action);
  }

  function resetAction(type: string) {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      next.delete(type);
      return next;
    });
    setValuesByType((prev) => {
      const rest = { ...prev };
      delete rest[type];
      return rest;
    });
  }

  if (actions.length === 0) {
    return <p className="px-1 py-2 text-sm text-slate-600">{t("pad.host.moreEmpty")}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {actions.map((action) =>
        renderActionRow({
          action,
          t,
          expanded: expandedTypes.has(action.type),
          values: valuesFor(action),
          submitting: submittingType === action.type,
          squads,
          lineups,
          personNames,
          onTap: () => {
            if (submittingType === action.type) return;
            // Fast path only when NEITHER fields NOR attribution need input.
            if (action.fields.length === 0 && action.attribution.length === 0) {
              onSubmit(action.type, buildActionPayload(action, valuesFor(action)));
              return;
            }
            setExpandedTypes((prev) => new Set(prev).add(action.type));
          },
          onChange: (path, value) => {
            setValuesByType((prev) => ({ ...prev, [action.type]: { ...valuesFor(action), [path]: value } }));
          },
          onConfirm: () => {
            const values = valuesFor(action);
            if (!checkActionValidity(action, values).ok || submittingType === action.type) return;
            onSubmit(action.type, buildActionPayload(action, values));
            resetAction(action.type);
          },
          onCancel: () => resetAction(action.type),
        }),
      )}
    </div>
  );
}
