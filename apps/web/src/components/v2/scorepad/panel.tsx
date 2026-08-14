"use client";
// One PadPanelView, drawn per its declared `layout` (S10/#419 W8, chassis
// item 2). Every action's `availability` was already decided by
// view-model.ts — this file draws exactly what it is handed: "available"
// gets a working `ActionForm`; "locked" gets a static, dimmed tile with its
// renderable reason and no submit path at all (never a form that would fail
// server-side, never a silently-missing action either — see view-model.ts's
// module header on why "locked" exists as a THIRD state).
//
// The locked tile and the action-list wrapper are PLAIN FUNCTIONS, called
// directly rather than JSX-instantiated as their own components, for the
// same reason action-form.tsx's `renderField` is — see that file's header.
// `ActionForm` stays a REAL component (it owns real per-instance hook
// state), so this file's own test asserts on the `<ActionForm>` ELEMENT's
// props (action/onSubmit) rather than its rendered interior — "children are
// elements, not markup", the established pattern for a nested stateful
// child under this repo's node-only test harness.
import type { ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { padLabel } from "@/lib/scoring-vocab";
import type { PadFieldValue } from "@seazn/engine/sport";
import { ActionForm, type ActionValues } from "./action-form";
import type { ChassisLabel, PadActionView, PadPanelView } from "./view-model";

type MsgFn = ReturnType<typeof useMsg>;

/** Layout -> the Tailwind arrangement its actions render in. `drawer` is a
 *  native `<details>` disclosure — secondary/administrative actions default
 *  collapsed so they don't eat courtside thumb real estate; `perSide` splits
 *  its actions two columns wide (the natural shape for a home/away pair);
 *  `grid` is a denser 2-up tap grid; `primary` is the full-width stack a
 *  live scoring panel needs at courtside size. */
const ACTIONS_CLASS: Record<PadPanelView["layout"], string> = {
  primary: "flex flex-col gap-2",
  grid: "grid grid-cols-2 gap-2",
  drawer: "flex flex-col gap-2",
  perSide: "grid grid-cols-2 gap-2",
};

/**
 * S10/#419 W8 fix 2 — a `grid` panel with exactly ONE action (football's
 * real Cards/Substitutions/Shots panels, each a single button) used to sit
 * in column 1 of a 2-col grid with an empty sibling cell beside it: correct
 * density at 375/320 (task ruling: already reads right there, untouched
 * below), but a plainly broken half-width button in an otherwise-empty card
 * at 768/1280, where there is no sibling to fill the row. `md:grid-cols-1`
 * collapses the grid to one column from md (768px) up, so the lone action
 * spans its whole row instead. A panel with two or more grid actions is
 * unaffected either way — it has real siblings to fill every column, at
 * every width, so nothing here changes for it. */
function actionsClassName(panel: PadPanelView): string {
  const base = ACTIONS_CLASS[panel.layout];
  if (panel.layout === "grid" && panel.actions.length === 1) return `${base} md:grid-cols-1`;
  return base;
}

function renderLockedTile(action: PadActionView, reason: ChassisLabel, msg: MsgFn): ReactNode {
  const label = padLabel(action.labelKey.key, msg, action.labelKey.label);
  return (
    <div
      key={action.type + action.labelKey.key}
      className="flex h-14 w-full flex-col items-center justify-center gap-0.5 rounded-lg border border-amber-200 bg-amber-50 px-3 text-center opacity-75"
      aria-disabled="true"
    >
      <span className="text-sm font-medium text-amber-900">{label}</span>
      <span className="text-[11px] text-amber-700">{msg(reason.key)}</span>
    </div>
  );
}

export interface PanelProps {
  panel: PadPanelView;
  onSubmit: (type: string, payload: Record<string, unknown>) => void;
  /** Idempotency-ish guard: the type currently mid-submit, if any — passed
   *  through to that ONE action's `ActionForm` so a slow network can't
   *  double-fire it. Every other action in the panel stays interactive. */
  submittingType?: string | null;
  renderAttribution?: (
    action: PadActionView,
    values: ActionValues,
    setValue: (path: string, value: PadFieldValue | undefined) => void,
  ) => ReactNode;
}

function renderActions(props: PanelProps, msg: MsgFn): ReactNode {
  const { panel, onSubmit, submittingType, renderAttribution } = props;
  return (
    <div data-role="panel-actions" className={actionsClassName(panel)}>
      {panel.actions.map((action) =>
        action.availability.kind === "locked" ? (
          renderLockedTile(action, action.availability.reason, msg)
        ) : (
          <ActionForm
            key={action.type + action.labelKey.key}
            action={action}
            submitting={submittingType === action.type}
            onSubmit={(payload) => onSubmit(action.type, payload)}
            renderAttribution={renderAttribution}
          />
        ),
      )}
    </div>
  );
}

export function Panel(props: PanelProps) {
  const msg = useMsg();
  const label = padLabel(props.panel.labelKey.key, msg, props.panel.labelKey.label);

  if (props.panel.layout === "drawer") {
    return (
      <details className="card group p-3">
        <summary className="btn btn-ghost w-full cursor-pointer list-none justify-between">
          <span>{label}</span>
          {/* S13/#422 W11 cutover — text-purple-400 on this white .card
           *  measures ~2.79:1 (aria-hidden does not exempt it from axe's
           *  color-contrast rule: that only skips elements hidden from
           *  SCREEN READERS, a visual-contrast check still evaluates any
           *  CSS-visible node). text-purple-700 clears 4.5:1 at 7.07:1 and
           *  matches the label right beside it (.btn-ghost's own
           *  text-purple-700), so this is one consistent purple, not two. */}
          <span aria-hidden className="text-xs text-purple-700 group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="mt-3">{renderActions(props, msg)}</div>
      </details>
    );
  }

  return (
    <section className="card p-3">
      <h3 className="label !mb-2">{label}</h3>
      {renderActions(props, msg)}
    </section>
  );
}
