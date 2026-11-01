"use client";

// Match Day C2 (spec 2026-10-31 §12 Phase C items 6, 7, 10) — THE Tie-breaks component: one editor for the order a table ranks
// by, reused wherever that order is set or read (owner, 2026-10-31: "single component for each and reuse in builder, fixture and
// match pages"). Two scopes, one set of modes:
//
//   - scope "stage"    — a table stage's own order on the stage card (W2d Task 15, absorbed from `stage-tiebreaks-section.tsx`):
//                        Save sends ONLY `{tiebreakers}` to the stage rules PUT, "Use the division's order" sends
//                        `{tiebreakers: null}` and the stage then reads the division's order.
//   - scope "division" — the division's default order (`divisions.tiebreakers`, the field "Use the division's order" reads — the
//                        loader's `divisionTiebreakers`): the division builder's Format tab (controlled, sent with the create)
//                        and the Division rules strip on the Fixtures tab (saved with `PATCH /divisions/{id}`). Null = the
//                        sport's own order.
//   - there is no "fixture" scope: one match has no table (`TiebreaksEditorProps` refuses it at the type level).
//
// Modes: "edit" — numbered rows, the sport's primary measure pinned first and the drawing of lots pinned last (non-Swiss, OC1),
// the middle rows with ↑ / ↓ / ✕, "+ Add step" offering exactly the engine's `offerableKeys`, each refused step with the
// engine's reason inline (`validateCascade`); "locked" — read-only, in the C1 summary's words (`foldTiebreaks`): the real
// criteria numbered in order, the two-way head-to-head rung said ONCE as a sentence (item 6), every label in the sport's own
// unit (`unitLabelKey`: badminton's "game difference", item 7), and one lock line for a stage that has started (item 4).
//
// Every decision is `stage-rules/stage-tiebreaks-model.ts`'s or the engine's; this file renders what they answer.
//
// Phone composition: the heading, badge and lock line stay visible; the list folds behind a `PhoneDisclosure` below `md`
// (one DOM, branched; AGENTS.md class 22 — the e2e opens the fold before asserting the rows).
import { useState, type ReactNode } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { PhoneDisclosure } from "@/components/v2/phone-disclosure";
import { validateCascade, type CascadeContext, type CascadeRefusal } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import type { StageTableRules } from "@/server/api-v1/schemas";
import { ruleRefusalText } from "@/lib/rule-errors";
import { liveStageCfg } from "@/lib/stage-decider-off";
import { foldTiebreaks, unitLabelKey } from "@/lib/stage-card/summaries";
import {
  addPosition,
  addableAt,
  crossGroupLine,
  insertStep,
  moveStep,
  orderHint,
  removeStep,
  resetChoices,
  sectionControls,
  tiebreakBadge,
  tiebreakRows,
  type StageLike,
  type TiebreakBadge,
} from "@/components/v2/stage-rules/stage-tiebreaks-model";
import { failureText } from "./points-editor";
import { LockLine, type RulesMode } from "./lock-line";

const ICON = "h-4 w-4";
const BUTTON =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple-600 disabled:cursor-not-allowed disabled:opacity-40";

const BADGE_CLASS = {
  inherited: "border-slate-200 bg-slate-100 text-slate-700",
  overridden: "border-purple-200 bg-purple-50 text-purple-800",
  differs: "border-purple-200 bg-purple-50 text-purple-800",
} as const;

type Msg = ReturnType<typeof useMsg>;

/** The badge the editor shows: where the order comes from, in organiser words. A stage pinned at generate ranks by the layer
 *  it was pinned from, so its badge says THAT layer (item 4: "Pinned at start · from before this update" is internals); a pin
 *  from before the W2d migration names no layer the organiser knows, and says nothing. */
export type ShownBadge = { kind: "inherited"; from: "division" | "sport" } | { kind: "overridden" } | { kind: "differs" } | null;
export function shownBadge(badge: TiebreakBadge): ShownBadge {
  if (badge.kind === "overridden" || badge.kind === "inherited" || badge.kind === "differs") return badge;
  if (badge.kind === "pinned") {
    if (badge.from === "stage") return { kind: "overridden" };
    if (badge.from === "division" || badge.from === "sport") return { kind: "inherited", from: badge.from };
  }
  return null;
}

/** A step's name in the sport's own unit (C1 `unitLabelKey`, item 7). */
const stepNameOf = (msg: Msg, sportKey: string) => (key: string): string => msg(unitLabelKey(key, sportKey));

/** The phone row's summary: the first three real criteria. */
function foldedSummary(keys: readonly TiebreakerKey[], name: (k: string) => string): string {
  const steps = foldTiebreaks(keys).steps;
  return steps.slice(0, 3).map(name).join(", ") + (steps.length > 3 ? ", …" : "");
}

/** The read-only order (item 6): the real criteria numbered in order, the two-way head-to-head rung as ONE sentence. */
function FoldedOrder({ keys, sportKey }: { keys: readonly TiebreakerKey[]; sportKey: string }) {
  const msg = useMsg();
  const name = stepNameOf(msg, sportKey);
  const { steps, twoWayH2h } = foldTiebreaks(keys);
  return (
    <div className="rounded-lg border border-slate-200 bg-white" data-testid="stage-tiebreaks-body">
      {steps.length === 0 ? (
        <p className="px-3 py-3 text-xs text-slate-700" data-testid="stage-tiebreaks-empty">
          {msg("rules.err.tiebreakOrderEmpty")}
        </p>
      ) : (
        <ol className="divide-y divide-slate-100" data-testid="stage-tiebreaks-list">
          {steps.map((key, i) => (
            <li key={`${key}-${i}`} data-testid={`stage-tiebreaks-row-${i}`} data-key={key} className="flex items-center gap-2 px-3 py-2">
              <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
              <span className="min-w-0 flex-1 break-words text-sm leading-snug text-slate-800">{name(key)}</span>
            </li>
          ))}
        </ol>
      )}
      {twoWayH2h && (
        <p className="border-t border-slate-100 bg-purple-50/60 px-3 py-2 text-xs leading-snug text-purple-900" data-testid="stage-tiebreaks-h2h">
          {msg("stageCard.tiebreaks.h2hTwo")}
        </p>
      )}
    </div>
  );
}

/** The editable order: numbered rows with the move and remove buttons, each refused step with its reason, then the add select
 *  and the reset control. Shared by both scopes, so the stage card and the division's default edit one way. */
function OrderEditor({
  draft,
  setDraft,
  ctx,
  refusals,
  sportKey,
  saving,
  hint,
  reset,
}: {
  draft: readonly TiebreakerKey[];
  setDraft: (next: TiebreakerKey[]) => void;
  /** The context the rows are pinned and the add offer is asked in. */
  ctx: CascadeContext;
  /** The engine's refusals of the draft (every context it must fit), the first per step shown beside it. */
  refusals: readonly CascadeRefusal[];
  sportKey: string;
  saving: boolean;
  /** The line under the list: an inherited order the engine refuses for this stage. */
  hint: ReactNode;
  /** The reset control (a button, or a menu of named orders); null where there is none. */
  reset: ReactNode;
}) {
  const msg = useMsg();
  const name = stepNameOf(msg, sportKey);
  const rows = tiebreakRows(draft, ctx, false);
  const at = addPosition(draft);
  const addable = addableAt(draft, at, ctx);
  return (
    <div className="rounded-lg border border-slate-200 bg-white" data-testid="stage-tiebreaks-body">
      {draft.length === 0 ? (
        <p className="px-3 py-3 text-xs text-slate-700" data-testid="stage-tiebreaks-empty">
          {msg("rules.err.tiebreakOrderEmpty")}
        </p>
      ) : (
        <ol className="divide-y divide-slate-100" data-testid="stage-tiebreaks-list">
          {rows.map((r, i) => {
            const stepName = name(r.key);
            const refusal = refusals.find((x) => x.index === i);
            const why = refusal === undefined ? null : ruleRefusalText("TIEBREAK_KEY_INVALID", { refusals: [refusal] }, msg);
            return (
              <li key={`${r.key}-${i}`} data-testid={`stage-tiebreaks-row-${i}`} data-key={r.key} data-pinned={r.pinned ?? undefined} className="pl-3 pr-1">
                <div className="flex items-center gap-1">
                  <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                  <span className="min-w-0 flex-1 break-words py-2 text-sm leading-snug text-slate-800">
                    {stepName}
                    {r.pinned !== null && (
                      <span className="ml-2 text-[11px] text-slate-500" data-testid={`stage-tiebreaks-pinned-${i}`}>
                        {msg(r.pinned === "first" ? "stageTiebreaks.alwaysFirst" : "stageTiebreaks.alwaysLast")}
                      </span>
                    )}
                  </span>
                  {r.pinned === null && (
                    <>
                      <button
                        type="button"
                        className={BUTTON}
                        aria-label={msg("stageTiebreaks.moveUp", { step: stepName })}
                        data-testid={`stage-tiebreaks-up-${i}`}
                        disabled={saving || !r.canUp}
                        onClick={() => setDraft(moveStep(draft, i, -1))}
                      >
                        <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3.5 10 8 5.5 12.5 10" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={BUTTON}
                        aria-label={msg("stageTiebreaks.moveDown", { step: stepName })}
                        data-testid={`stage-tiebreaks-down-${i}`}
                        disabled={saving || !r.canDown}
                        onClick={() => setDraft(moveStep(draft, i, 1))}
                      >
                        <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3.5 6 8 10.5 12.5 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={BUTTON}
                        aria-label={msg("stageTiebreaks.remove", { step: stepName })}
                        data-testid={`stage-tiebreaks-remove-${i}`}
                        disabled={saving || !r.canRemove}
                        onClick={() => setDraft(removeStep(draft, i))}
                      >
                        <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m4 4 8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
                {why !== null && (
                  <p role="alert" className="pb-2 pl-6 text-xs text-red-600" data-testid={`stage-tiebreaks-refusal-${i}`}>
                    {why}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {hint}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-2 py-2">
        {addable.length > 0 && (
          <select
            className="select min-h-11 min-w-[10rem] flex-1"
            aria-label={msg("stageTiebreaks.add")}
            data-testid="stage-tiebreaks-add"
            disabled={saving}
            value=""
            onChange={(e) => {
              if (e.target.value !== "") setDraft(insertStep(draft, at, e.target.value as TiebreakerKey));
            }}
          >
            <option value="">{msg("stageTiebreaks.add")}</option>
            {addable.map((key) => (
              <option key={key} value={key}>
                {name(key)}
              </option>
            ))}
          </select>
        )}
        {reset}
      </div>
    </div>
  );
}

function BadgeChip({ badge }: { badge: ShownBadge }) {
  const msg = useMsg();
  if (badge === null) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-tight">
      <span
        className={`rounded-full border px-2 py-0.5 font-medium ${BADGE_CLASS[badge.kind]}`}
        data-testid="stage-tiebreaks-badge"
        data-badge={badge.kind}
        data-source={badge.kind === "inherited" ? badge.from : "stage"}
      >
        {msg(`stageTiebreaks.badge.${badge.kind}` as MessageKey)}
      </span>
      {badge.kind === "inherited" && <span className="text-slate-600">{msg(`stageTiebreaks.source.${badge.from}` as MessageKey)}</span>}
      {badge.kind === "differs" && <span className="text-slate-600">{msg("stageTiebreaks.source.started")}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// The props: one component, two scopes. A match has no table, so `scope: "fixture"` is not a member (refused by tsc).
// ---------------------------------------------------------------------------------------------------------------------

/** The PUT's answer to a Save/Clear, tagged with the `tableRules` prop it was made against: while the prop is still that
 *  object the page has not re-read the stage, and the saved order is newer than it. */
interface Saved {
  readonly against: StageTableRules;
  readonly keys: readonly TiebreakerKey[];
}

export interface StageTiebreaksProps {
  scope: "stage";
  /** "locked": read-only (the stage has started, or a viewer). */
  mode: RulesMode;
  /** The server's lock (`formatLockedStageIds`: the stage has a first score): the section says it once. Never activation —
   *  between generate and the first score the order stays editable (OC2). */
  started: boolean;
  /** Match Day C3 (review I3): whether a locked section says its own lock line. Default true (the section is the one place the lock is
   *  said). The stage card passes false: its summary line already carries the card's ONE lock line, and a panel opened under it must not
   *  repeat it. */
  showLockLine?: boolean;
  stage: StageLike;
  module: AnySportModule;
  divisionConfig: Record<string, unknown>;
  stageConfig: Record<string, unknown>;
  /** Match Day C3 (C2's deferred M4): the order the stage would rank by if it followed the division TODAY - the division's own
   *  order, else the sport's. A pinned stage that keeps a different order says it differs instead of "inherited". Absent, the
   *  badge claims only what the server gave it. */
  inheritedOrder?: readonly TiebreakerKey[];
  onSaved: () => void;
}

export interface DivisionTiebreaksProps {
  scope: "division";
  mode: RulesMode;
  module: AnySportModule;
  /** The order being edited: the division's own (`divisions.tiebreakers`), or null while it follows the sport's. */
  value: readonly TiebreakerKey[] | null;
  /** What the division stores now (the strip's Save is offered while `value` differs from it). Absent in the builder, where
   *  nothing is stored yet and the value travels with the create. */
  stored?: readonly TiebreakerKey[] | null;
  onChange: (next: TiebreakerKey[] | null) => void;
  /** The division's config, for the sport's default and the cascade's cfg (football's fair play). */
  divisionConfig: Record<string, unknown>;
  /** The table stage kinds that will inherit the order (each validates it); the first decides the sport default shown and the
   *  steps offered. Empty: a league. */
  kinds: readonly TableStageKind[];
  /** The strip's Save: present, a Save renders while the value differs from `stored`; absent (the builder) the value is the
   *  parent's to send. */
  onSave?: (next: TiebreakerKey[] | null) => void;
  saving?: boolean;
  error?: string | null;
}

export type TiebreaksEditorProps = StageTiebreaksProps | DivisionTiebreaksProps;

export function TiebreaksEditor(props: TiebreaksEditorProps) {
  return props.scope === "stage" ? <StageTiebreaks {...props} /> : <DivisionTiebreaks {...props} />;
}

export function StageTiebreaks({ mode, started, showLockLine = true, stage, module, divisionConfig, stageConfig, inheritedOrder, onSaved }: StageTiebreaksProps) {
  const msg = useMsg();
  const name = stepNameOf(msg, module.key);
  const [saved, setSaved] = useState<Saved | null>(null);
  const unread = saved !== null && saved.against === stage.tableRules;
  const rules: StageTableRules = unread
    ? { ...stage.tableRules, tiebreakers: { ...stage.tableRules.tiebreakers, keys: [...saved.keys], source: "stage" } }
    : stage.tableRules;
  const stored = rules.tiebreakers.keys;
  const [draft, setDraft] = useState<TiebreakerKey[]>(() => [...stored]);
  // A new order from the page (a refresh after a save, another tab's change) replaces the draft.
  const signature = JSON.stringify(rules.tiebreakers);
  const [syncedFor, setSyncedFor] = useState(signature);
  if (syncedFor !== signature) {
    setSyncedFor(signature);
    setDraft([...stored]);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readOnly = mode === "locked";
  const parsed = module.configSchema.safeParse(liveStageCfg(divisionConfig, { kind: stage.kind, config: stageConfig }, module));
  const ctx: CascadeContext = {
    module,
    cfg: parsed.success ? parsed.data : liveStageCfg(divisionConfig, { kind: stage.kind, config: stageConfig }, module),
    stageKind: stage.kind,
    crossGroup: false,
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const controls = sectionControls(readOnly, rules);
  const hint = readOnly ? null : orderHint(dirty ? { ...rules, tiebreakers: { ...rules.tiebreakers, keys: draft, source: "stage" } } : rules, ctx);
  const refusals = readOnly ? [] : validateCascade(draft, ctx);
  const crossGroup = crossGroupLine(stage);
  const choices = resetChoices(module.tablePresets?.(stage.kind), rules);

  async function write(tiebreakers: TiebreakerKey[] | null) {
    setSaving(true);
    setError(null);
    try {
      await apiV1(`/api/v1/stages/${stage.id}/rules`, { method: "PUT", json: { tiebreakers } });
      // A cleared order now plays the division's or the sport's: the page's refresh says which.
      if (tiebreakers !== null) setSaved({ against: stage.tableRules, keys: tiebreakers });
      onSaved();
    } catch (err) {
      setError(failureText(err, msg));
    } finally {
      setSaving(false);
    }
  }

  const reset =
    controls.reset && choices.length === 1 ? (
      <button type="button" className="btn btn-ghost min-h-11 px-3 text-xs" data-testid="stage-tiebreaks-reset" disabled={saving} onClick={() => setDraft([...choices[0]!.keys])}>
        {msg("stageTiebreaks.reset")}
      </button>
    ) : controls.reset && choices.length > 1 ? (
      <select
        className="select min-h-11 min-w-[10rem]"
        aria-label={msg("stageTiebreaks.resetMenu")}
        data-testid="stage-tiebreaks-reset"
        disabled={saving}
        value=""
        onChange={(e) => {
          const choice = choices.find((c) => c.id === e.target.value);
          if (choice !== undefined) setDraft([...choice.keys]);
        }}
      >
        <option value="">{msg("stageTiebreaks.resetMenu")}</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {msg(`stageTiebreaks.preset.${c.id}` as MessageKey)}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <section
      aria-label={msg("stageTiebreaks.title")}
      data-testid={`stage-tiebreaks-${stage.id}`}
      data-state={started ? "locked" : readOnly ? "readonly" : "editor"}
      className="border-b border-slate-100 px-4 py-3"
    >
      <div className="space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-semibold text-slate-800">{msg("stageTiebreaks.title")}</span>
          {!readOnly && <BadgeChip badge={shownBadge(tiebreakBadge(rules, inheritedOrder))} />}
        </div>
        {started && showLockLine && <LockLine testId="stage-tiebreaks-locked" />}
        <PhoneDisclosure summary={foldedSummary(readOnly ? stored : draft, name)} showLabel={msg("stageTiebreaks.show")} hideLabel={msg("stageTiebreaks.hide")}>
          {readOnly ? (
            <FoldedOrder keys={stored} sportKey={module.key} />
          ) : (
            <OrderEditor
              draft={draft}
              setDraft={setDraft}
              ctx={ctx}
              refusals={refusals}
              sportKey={module.key}
              saving={saving}
              hint={
                hint !== null && hint.inherited ? (
                  <p className="border-t border-slate-100 px-3 py-2 text-xs text-red-700" data-testid="stage-tiebreaks-hint">
                    {msg("stageTiebreaks.inheritedHint")}
                  </p>
                ) : null
              }
              reset={reset}
            />
          )}
        </PhoneDisclosure>
        {crossGroup !== null && crossGroup.length > 0 && (
          <p className="text-xs text-slate-600" data-testid="stage-tiebreaks-cross-group">
            {msg("stageTiebreaks.crossGroup", { steps: crossGroup.map(name).join(", ") })}
          </p>
        )}
        {!readOnly && (dirty || controls.clear) && (
          <div className="flex flex-wrap items-center gap-3">
            {dirty && (
              <button
                type="button"
                className="btn btn-primary min-h-11 px-3 py-1.5 text-xs"
                data-testid="stage-tiebreaks-save"
                disabled={saving || refusals.length > 0}
                onClick={() => void write(draft)}
              >
                {saving ? msg("schedule.working") : msg("stageTiebreaks.save")}
              </button>
            )}
            {controls.clear && (
              <button type="button" className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs" data-testid="stage-tiebreaks-clear" disabled={saving} onClick={() => void write(null)}>
                {msg("stageTiebreaks.useDivision")}
              </button>
            )}
          </div>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-red-600" data-testid="stage-tiebreaks-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/** The cascade context the division's order is read in for one stage kind: the division's cfg as the sport parses it. */
export function divisionCascadeCtx(module: AnySportModule, divisionConfig: Record<string, unknown>, kind: TableStageKind): CascadeContext {
  const raw = liveStageCfg(divisionConfig, { kind, config: {} }, module);
  const parsed = module.configSchema.safeParse(raw);
  return { module, cfg: parsed.success ? parsed.data : raw, stageKind: kind, crossGroup: false };
}

/** The sport's own order for the division's first table kind: what a null division order means (the loader's last layer).
 *  Null when the division's cfg does not parse: nothing honest to show. */
export function divisionSportOrder(module: AnySportModule, divisionConfig: Record<string, unknown>, kinds: readonly TableStageKind[]): TiebreakerKey[] | null {
  const kind = kinds[0] ?? "league";
  const parsed = module.configSchema.safeParse(liveStageCfg(divisionConfig, { kind, config: {} }, module));
  return parsed.success ? module.defaultTiebreakers(kind, parsed.data) : null;
}

/** Every refusal the division's order earns from any kind that will inherit it, the first per step: the engine's own question,
 *  the one `patchDivision` asks of every unpinned table stage. */
export function divisionOrderRefusals(
  module: AnySportModule,
  divisionConfig: Record<string, unknown>,
  kinds: readonly TableStageKind[],
  keys: readonly TiebreakerKey[],
): CascadeRefusal[] {
  const out: CascadeRefusal[] = [];
  for (const kind of kinds.length === 0 ? (["league"] as const) : kinds) {
    for (const r of validateCascade(keys, divisionCascadeCtx(module, divisionConfig, kind))) {
      if (!out.some((o) => o.index === r.index)) out.push(r);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

function DivisionTiebreaks({ mode, module, value, stored, onChange, divisionConfig, kinds, onSave, saving = false, error = null }: DivisionTiebreaksProps) {
  const msg = useMsg();
  const name = stepNameOf(msg, module.key);
  const kind = kinds[0] ?? "league";
  const shown = value ?? divisionSportOrder(module, divisionConfig, kinds) ?? [];
  const readOnly = mode === "locked";
  const refusals = readOnly ? [] : divisionOrderRefusals(module, divisionConfig, kinds, shown);
  const dirty = stored !== undefined && JSON.stringify(value) !== JSON.stringify(stored);
  return (
    <section
      aria-label={msg("stageTiebreaks.title")}
      data-testid="division-tiebreaks"
      data-state={readOnly ? "readonly" : "editor"}
      data-source={value === null ? "sport" : "division"}
      className="min-w-0 space-y-2"
    >
      <p className="text-xs text-slate-600" data-testid="division-tiebreaks-source">
        {msg(value === null ? "rulesStrip.tiebreaks.sportDefault" : "rulesStrip.tiebreaks.own")}
      </p>
      <PhoneDisclosure summary={foldedSummary(shown, name)} showLabel={msg("stageTiebreaks.show")} hideLabel={msg("stageTiebreaks.hide")}>
        {readOnly ? (
          <FoldedOrder keys={shown} sportKey={module.key} />
        ) : (
          <OrderEditor
            draft={shown}
            setDraft={(next) => onChange(next)}
            ctx={divisionCascadeCtx(module, divisionConfig, kind)}
            refusals={refusals}
            sportKey={module.key}
            saving={saving}
            hint={null}
            reset={
              value !== null ? (
                <button type="button" className="btn btn-ghost min-h-11 px-3 text-xs" data-testid="division-tiebreaks-sport" disabled={saving} onClick={() => onChange(null)}>
                  {msg("rulesStrip.tiebreaks.useSport")}
                </button>
              ) : null
            }
          />
        )}
      </PhoneDisclosure>
      {!readOnly && onSave !== undefined && dirty && (
        <button
          type="button"
          className="btn btn-primary min-h-11 px-3 py-1.5 text-xs"
          data-testid="division-tiebreaks-save"
          disabled={saving || refusals.length > 0}
          onClick={() => onSave(value === null ? null : [...value])}
        >
          {saving ? msg("schedule.working") : msg("stageTiebreaks.save")}
        </button>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-red-600" data-testid="division-tiebreaks-error">
          {error}
        </p>
      )}
    </section>
  );
}

/** The panel's stage row reduced to the section's `StageLike` (`pooled` / `bestNth` are the panel's answers). */
export function stageLikeOf(
  stage: { id: string; kind: string },
  tableRules: StageTableRules,
  pooled: boolean,
  bestNth: boolean,
): StageLike {
  return { id: stage.id, kind: stage.kind as StageLike["kind"], pooled, bestNth, tableRules };
}
