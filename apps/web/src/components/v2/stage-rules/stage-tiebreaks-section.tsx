"use client";

// W2d Task 15 (spec §9 "Tie-breaks" section, D3, D5, D11, OC1, OC2; X-TB-1..3) — a table stage's tie-break order in the
// stage card's rules editor, after the Points section. Every decision is `stage-tiebreaks-model.ts`'s (pure, unit-killed);
// this file renders what it answers.
//
//   - the list: numbered rows, the sport's primary measure pinned first and the drawing of lots pinned last (non-Swiss,
//     OC1), the middle rows with ↑ / ↓ / ✕ (the `SequenceField` pattern), each refused step with the engine's reason
//     inline (`validateCascade`, the PUT's own question, said in the TIEBREAK_KEY_INVALID words);
//   - "+ Add step" offers exactly `offerableKeys` at the insertion point (before the closing lots);
//   - "Reset to sport default" sets the server's `sportDefault` (PS-7b), or for a sport with named orders (football:
//     FIFA 2026 / UEFA / Classic, D5) a small menu of them;
//   - the badge: Inherited (division / sport default), Overridden, Pinned at start with its source (X-TB-1);
//   - the lock is the SERVER's (`formatLockedStageIds`, W2c's monotonic "played" predicate): between generate and the
//     first score the order stays editable (OC2); after it, no control and one 🔒 line (X-TB-2);
//   - a pooled stage a later stage takes a best-Nth from shows the read-only "Between groups" line (§5.9).
// Save sends ONLY `{tiebreakers}` to the stage rules PUT (strict body; the other arms stay as stored); "Use the division's
// order" sends `{tiebreakers: null}`.
//
// Phone composition: the heading, badge and lock line stay visible; the list folds behind a `PhoneDisclosure` below `md`
// (one DOM, branched; AGENTS.md class 22 — the e2e opens the fold before asserting the rows).
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { PhoneDisclosure } from "@/components/v2/phone-disclosure";
import { validateCascade, type CascadeContext } from "@seazn/engine/competition";
import type { AnySportModule, TiebreakerKey } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import type { StageTableRules } from "@/server/api-v1/schemas";
import { ruleRefusalText } from "@/lib/rule-errors";
import { liveStageCfg } from "@/lib/stage-decider-off";
import { failureText } from "./stage-points-section";
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
  sectionLocked,
  tiebreakBadge,
  tiebreakRows,
  type StageLike,
} from "./stage-tiebreaks-model";

const ICON = "h-4 w-4";
const BUTTON =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-purple-600 disabled:cursor-not-allowed disabled:opacity-40";

const BADGE_CLASS = {
  inherited: "border-slate-200 bg-slate-100 text-slate-700",
  overridden: "border-purple-200 bg-purple-50 text-purple-800",
  pinned: "border-teal-200 bg-teal-50 text-teal-800",
} as const;

/** The PUT's answer to a Save/Clear, tagged with the `tableRules` prop it was made against: while the prop is still that
 *  object the page has not re-read the stage, and the saved order is newer than it. */
interface Saved {
  readonly against: StageTableRules;
  readonly keys: readonly TiebreakerKey[];
}

export function StageTiebreaksSection({
  stage,
  stageName,
  module,
  divisionConfig,
  stageConfig,
  formatLockedStageIds,
  canEdit,
  onSaved,
}: {
  stage: StageLike;
  stageName: string;
  module: AnySportModule;
  divisionConfig: Record<string, unknown>;
  stageConfig: Record<string, unknown>;
  /** The server's lock (`formatLockedStageIds`): the stages that have a first score. */
  formatLockedStageIds: readonly string[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const msg = useMsg();
  const stepName = (key: string): string => msg(`div.detail.tiebreak.rule.${key}` as MessageKey);
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

  const locked = sectionLocked(stage, formatLockedStageIds);
  const readOnly = locked || !canEdit;
  const parsed = module.configSchema.safeParse(liveStageCfg(divisionConfig, { kind: stage.kind, config: stageConfig }, module));
  const ctx: CascadeContext = {
    module,
    cfg: parsed.success ? parsed.data : liveStageCfg(divisionConfig, { kind: stage.kind, config: stageConfig }, module),
    stageKind: stage.kind,
    crossGroup: false,
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const rows = tiebreakRows(draft, ctx, readOnly);
  const controls = sectionControls(readOnly, rules);
  const badge = tiebreakBadge(rules);
  const hint = readOnly ? null : orderHint(dirty ? { ...rules, tiebreakers: { ...rules.tiebreakers, keys: draft, source: "stage" } } : rules, ctx);
  const refused = validateCascade(draft, ctx).length > 0;
  const crossGroup = crossGroupLine(stage);
  const at = addPosition(draft, stage.kind);
  const addable = controls.add ? addableAt(draft, at, ctx) : [];
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

  const badgeEl =
    badge.kind === "unknown" ? null : (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-tight">
        <span
          className={`rounded-full border px-2 py-0.5 font-medium ${BADGE_CLASS[badge.kind]}`}
          data-testid="stage-tiebreaks-badge"
          data-badge={badge.kind}
          data-source={badge.kind === "overridden" ? "stage" : badge.from}
        >
          {msg(`stageTiebreaks.badge.${badge.kind}` as MessageKey)}
        </span>
        {badge.kind !== "overridden" && <span className="text-slate-600">{msg(`stageTiebreaks.source.${badge.from}` as MessageKey)}</span>}
      </span>
    );

  const summary = draft.slice(0, 3).map(stepName).join(", ") + (draft.length > 3 ? ", …" : "");

  const list = (
    <div className="rounded-lg border border-slate-200 bg-white" data-testid="stage-tiebreaks-body">
      {draft.length === 0 ? (
        <p className="px-3 py-3 text-xs text-slate-700" data-testid="stage-tiebreaks-empty">
          {msg("rules.err.tiebreakOrderEmpty")}
        </p>
      ) : (
        <ol className="divide-y divide-slate-100" data-testid="stage-tiebreaks-list">
          {rows.map((r, i) => {
            const name = stepName(r.key);
            const why = r.refusal === undefined ? null : ruleRefusalText("TIEBREAK_KEY_INVALID", { refusals: [r.refusal] }, msg);
            return (
              <li
                key={`${r.key}-${i}`}
                data-testid={`stage-tiebreaks-row-${i}`}
                data-key={r.key}
                data-pinned={r.pinned ?? undefined}
                className="pl-3 pr-1"
              >
                <div className="flex items-center gap-1">
                  <span className="w-5 shrink-0 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                  <span className="min-w-0 flex-1 break-words py-2 text-sm leading-snug text-slate-800">
                    {name}
                    {r.pinned !== null && (
                      <span className="ml-2 text-[11px] text-slate-500" data-testid={`stage-tiebreaks-pinned-${i}`}>
                        {msg(r.pinned === "first" ? "stageTiebreaks.alwaysFirst" : "stageTiebreaks.alwaysLast")}
                      </span>
                    )}
                  </span>
                  {!readOnly && r.pinned === null && (
                    <>
                      <button
                        type="button"
                        className={BUTTON}
                        aria-label={msg("stageTiebreaks.moveUp", { step: name })}
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
                        aria-label={msg("stageTiebreaks.moveDown", { step: name })}
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
                        aria-label={msg("stageTiebreaks.remove", { step: name })}
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
      {hint !== null && hint.inherited && (
        <p className="border-t border-slate-100 px-3 py-2 text-xs text-red-700" data-testid="stage-tiebreaks-hint">
          {msg("stageTiebreaks.inheritedHint")}
        </p>
      )}
      {(controls.add || controls.reset) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-2 py-2">
          {controls.add && addable.length > 0 && (
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
                  {stepName(key)}
                </option>
              ))}
            </select>
          )}
          {controls.reset && choices.length === 1 && (
            <button
              type="button"
              className="btn btn-ghost min-h-11 px-3 text-xs"
              data-testid="stage-tiebreaks-reset"
              disabled={saving}
              onClick={() => setDraft([...choices[0]!.keys])}
            >
              {msg("stageTiebreaks.reset")}
            </button>
          )}
          {controls.reset && choices.length > 1 && (
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
          )}
        </div>
      )}
    </div>
  );

  return (
    <section
      aria-label={msg("stageTiebreaks.title")}
      data-testid={`stage-tiebreaks-${stage.id}`}
      data-state={locked ? "locked" : readOnly ? "readonly" : "editor"}
      className="border-b border-slate-100 px-4 py-3"
    >
      <div className="space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-semibold text-slate-800">{msg("stageTiebreaks.title")}</span>
          {badgeEl}
        </div>
        {locked && (
          <p className="text-[11px] leading-snug text-slate-700" data-testid="stage-tiebreaks-locked">
            <span aria-hidden="true">🔒 </span>
            {msg("stageTiebreaks.locked", { stage: stageName })}
          </p>
        )}
        <PhoneDisclosure summary={summary} showLabel={msg("stageTiebreaks.show")} hideLabel={msg("stageTiebreaks.hide")}>
          {list}
        </PhoneDisclosure>
        {crossGroup !== null && crossGroup.length > 0 && (
          <p className="text-xs text-slate-600" data-testid="stage-tiebreaks-cross-group">
            {msg("stageTiebreaks.crossGroup", { steps: crossGroup.map(stepName).join(", ") })}
          </p>
        )}
        {!readOnly && (dirty || controls.clear) && (
          <div className="flex flex-wrap items-center gap-3">
            {dirty && (
              <button
                type="button"
                className="btn btn-primary min-h-11 px-3 py-1.5 text-xs"
                data-testid="stage-tiebreaks-save"
                disabled={saving || refused}
                onClick={() => void write(draft)}
              >
                {saving ? msg("schedule.working") : msg("stageTiebreaks.save")}
              </button>
            )}
            {controls.clear && (
              <button
                type="button"
                className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
                data-testid="stage-tiebreaks-clear"
                disabled={saving}
                onClick={() => void write(null)}
              >
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

/** The panel's stage row reduced to the section's `StageLike` (`pooled` / `bestNth` are the panel's answers). */
export function stageLikeOf(
  stage: { id: string; kind: string },
  tableRules: StageTableRules,
  pooled: boolean,
  bestNth: boolean,
): StageLike {
  return { id: stage.id, kind: stage.kind as StageLike["kind"], pooled, bestNth, tableRules };
}
