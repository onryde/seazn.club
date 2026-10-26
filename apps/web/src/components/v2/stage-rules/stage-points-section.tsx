"use client";

// W2c Task 18 (S3, ST-G8; owner pick A on mockup S3) - a table stage's OWN points: win / draw / loss as a sentence, the
// walkover row and bonuses behind "More", and a live preview in the public line's words. It sits beside the stage format
// row (its own PUT arm, `{points}`) and follows the same lock: a started stage, or a viewer, reads it and cannot change it.
//
// WHAT IT OFFERS IS WHAT THE SERVER TAKES (every question is `stage-points-model.ts`'s, which asks the engine):
//   - the editor's boxes are a FLAT rule (one amount per win and per loss), so a stage whose sport pays an outcome its own
//     way (IIHF's overtime 2/1, FIVB's 3-2, ICC's tie and no result, ITTF's loss not played, FIH's shoot-out bonus) gets
//     "can't be set per stage yet" with the reason and NO inputs (W2d Task 10 fix round 1, I2, owner 2026-10-26:
//     `pointsEditorFits`, over the engine's payout) - a Save there would flatten that outcome onto the win or the loss. A
//     rule the stage STORES anyway is read beside the reason, with "Use the division's points" to clear it (`{points:
//     null}` flattens nothing). The server refuses a flat rule there too (POINTS_SPLIT_FLATTENED), as defence in depth;
//   - everywhere else, the editor; a rule that does not pay every outcome the stage reaches is refused by the server
//     (POINTS_OUTCOME_UNCOVERED), said in its own words beside the inputs;
//   - scoring is free on every plan (owner, 2026-10-19: "all scoring are free", V393 gives community `custom_points`), so
//     the section asks no plan question; the server's gate stays and a 402 is said in the server's own words;
//   - the walkover SCORE is shown only where the sport's table reads it (batch-3 I3: the server REFUSES it elsewhere, so a
//     shown input there would be a save that fails);
//   - bonus kinds are those the sport's metrics can feed.
// Save sends ONLY `{points}`: the endpoint's body is strict, and an omitted `rules` arm is left as stored.
import { Fragment, useState, type ReactNode } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { PhoneDisclosure } from "@/components/v2/phone-disclosure";
import type { AnySportModule } from "@seazn/engine/sport";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { ruleRefusalText } from "@/lib/rule-errors";
import { rulesLineText } from "@/lib/rules-line";
import {
  PARAM_BONUS_KINDS,
  divisionBasePoints,
  draftFromStored,
  draftIsDirty,
  offeredBonusKinds,
  offersWalkoverScore,
  pointsEditorFits,
  previewClauses,
  ruleFromDraft,
  storedPointsRule,
  type BonusWhen,
  type PointsDraft,
} from "./stage-points-model";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** A translated sentence with inline controls: the copy carries `{name}` slots, each replaced by a control. The slots are
 *  swapped for a marker first so the sentence is translated whole (word order differs by language) and split after. */
function slotted(msg: Msg, key: MessageKey, slots: Record<string, ReactNode>, vars: Record<string, string | number> = {}): ReactNode[] {
  const marks = Object.fromEntries(Object.keys(slots).map((name) => [name, `§${name}§`]));
  return msg(key, { ...vars, ...marks })
    .split(/§(\w+)§/)
    .map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{slots[part]}</Fragment> : part));
}

function NumberBox({
  value,
  onChange,
  label,
  testId,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (raw: string) => void;
  label: string;
  testId: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      step="any"
      inputMode="decimal"
      aria-label={label}
      data-testid={testId}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="input w-20 min-h-11 text-center"
    />
  );
}

/** What a failed Save says: a 402 in the server's own words (its `extra.reason`, else its message - the section holds no plan
 *  copy of its own), a rule refusal localized where this app owns it, else the server's own message. */
export function failureText(err: unknown, msg: Msg): string {
  if (err instanceof ApiV1Error) {
    if (err.status === 402) return typeof err.extra.reason === "string" ? err.extra.reason : err.message;
    return ruleRefusalText(err.code, err.extra, msg) ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

interface Saved {
  /** The row's `stage.config.points` prop when the save landed: while the prop is still this value the page has not
   *  re-read the stage since, and `points` is newer than it (the stage rules row's `SavedStageRules` pattern). */
  readonly against: unknown;
  readonly points: unknown;
}

export function StagePointsSection({
  stageId,
  module,
  kind,
  stageConfig,
  divisionConfig,
  stored,
  pointsDict,
  readOnly,
  onSaved,
}: {
  stageId: string;
  module: AnySportModule;
  /** The stage's kind and its own config (its `rules` move the outcomes it reaches): what the editor is asked to fit. */
  kind: string;
  stageConfig: unknown;
  divisionConfig: Record<string, unknown>;
  /** `stage.config.points` as the page read it. */
  stored: unknown;
  /** The public dictionary's `format.points.*` slice (`pointsLineDict`); absent, the section shows no preview. */
  pointsDict: Dict | undefined;
  /** A started stage (the S4 lock) or a viewer: the section reads, nothing writes. */
  readOnly: boolean;
  onSaved: () => void;
}) {
  const msg = useMsg();
  const [saved, setSaved] = useState<Saved | null>(null);
  const inForce = saved !== null && saved.against === stored ? saved.points : stored;
  const [draft, setDraft] = useState<PointsDraft>(() => draftFromStored(module, divisionConfig, stored));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fit = pointsEditorFits(module, divisionConfig, { kind, config: stageConfig });

  const heading = (
    <span className="text-xs font-semibold text-slate-800">{msg("stagePoints.title")}</span>
  );
  const shell = (children: ReactNode) => (
    <section
      aria-label={msg("stagePoints.title")}
      data-testid={`stage-points-${stageId}`}
      data-stage-points-state={!fit.fits ? "inexpressible" : readOnly ? "readonly" : "editor"}
      className="border-b border-slate-100 px-4 py-3"
    >
      {children}
    </section>
  );

  const ownRule = storedPointsRule(inForce);
  const preview = (d: PointsDraft): string => {
    if (pointsDict === undefined) return "";
    const clauses = previewClauses(module, divisionConfig, d);
    return clauses.length === 0 ? "" : rulesLineText(pointsDict, clauses);
  };

  /** One PUT, `{points}` only: the body is strict, and `rules` left out stays as stored. `null` removes the stage's own rule
   *  (never refused for itself: no plan gate). What the server answers is what the section then shows, until the page re-reads. */
  async function write(points: unknown) {
    setSaving(true);
    setError(null);
    try {
      const out = await apiV1<{ points?: unknown }>(`/api/v1/stages/${stageId}/rules`, { method: "PUT", json: { points } });
      const landed = out.points ?? null;
      setSaved({ against: stored, points: landed });
      setDraft(draftFromStored(module, divisionConfig, landed));
      onSaved();
    } catch (err) {
      setError(failureText(err, msg));
    } finally {
      setSaving(false);
    }
  }

  // Fix round 1 I2: the reason, in the reader's words, and no inputs. A rule the stage STORES anyway is not hidden behind the
  // reason (it is what the stage plays): it is read, and an editable stage can clear it - the one change that flattens
  // nothing. The server stays the authority (a flat rule there is POINTS_SPLIT_FLATTENED).
  if (!fit.fits) {
    const reason = ruleRefusalText("POINTS_SPLIT_FLATTENED", { splits: fit.reasons }, msg);
    const own = ownRule === null ? "" : preview(draftFromStored(module, divisionConfig, inForce));
    return shell(
      <div className="space-y-2">
        {heading}
        <p
          role="status"
          data-testid="stage-points-inexpressible"
          className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-snug text-slate-700"
        >
          {reason ?? msg("stagePoints.inexpressible")}
        </p>
        {ownRule !== null && (
          <div className="space-y-2">
            <p className="text-xs text-slate-600" data-testid="stage-points-readonly">
              {msg("stagePoints.ownPoints")}
            </p>
            {own !== "" && (
              <p className="text-xs text-slate-700" data-testid="stage-points-preview">
                {own}
              </p>
            )}
            {!readOnly && (
              <button
                type="button"
                className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
                data-testid="stage-points-clear"
                disabled={saving}
                onClick={() => void write(null)}
              >
                {saving ? msg("schedule.working") : msg("stagePoints.useDivision")}
              </button>
            )}
            {error !== null && (
              <p role="alert" className="text-xs text-red-600" data-testid="stage-points-error">
                {error}
              </p>
            )}
          </div>
        )}
      </div>,
    );
  }

  // A started stage, or a viewer: what the stage plays, in words. No control.
  if (readOnly) {
    const text = preview(draftFromStored(module, divisionConfig, inForce));
    return shell(
      <div className="space-y-1">
        {heading}
        <p className="text-xs text-slate-600" data-testid="stage-points-readonly">
          {msg(ownRule === null ? "stagePoints.divisionPoints" : "stagePoints.ownPoints")}
        </p>
        {text !== "" && (
          <p className="text-xs text-slate-700" data-testid="stage-points-preview">
            {text}
          </p>
        )}
      </div>,
    );
  }

  const patch = (p: Partial<PointsDraft>) => setDraft((d) => ({ ...d, ...p }));
  const built = ruleFromDraft(module, draft);
  const problem = built.ok ? null : built.problem;
  const dirty = draftIsDirty(module, draft, inForce);
  const canDraw = divisionBasePoints(module, divisionConfig).draw !== null;
  const previewText = preview(draft);
  const reaches = offersWalkoverScore(module);

  const save = () => {
    if (built.ok) void write(built.rule);
  };

  const baseBoxes = (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-slate-800" data-testid="stage-points-sentence">
      {slotted(msg, canDraw ? "stagePoints.sentence" : "stagePoints.sentenceNoDraw", {
        win: <NumberBox value={draft.win} onChange={(win) => patch({ win })} label={msg("stagePoints.win")} testId="stage-points-win" disabled={saving} />,
        draw: <NumberBox value={draft.draw} onChange={(draw) => patch({ draw })} label={msg("stagePoints.draw")} testId="stage-points-draw" disabled={saving} />,
        loss: <NumberBox value={draft.loss} onChange={(loss) => patch({ loss })} label={msg("stagePoints.loss")} testId="stage-points-loss" disabled={saving} />,
      })}
    </p>
  );

  const offered = offeredBonusKinds(module, divisionConfig);
  const addBonus = (when: BonusWhen) => patch({ bonuses: [...draft.bonuses, { when, param: "", points: "" }] });
  const setBonus = (i: number, p: Partial<PointsDraft["bonuses"][number]>) =>
    patch({ bonuses: draft.bonuses.map((b, j) => (j === i ? { ...b, ...p } : b)) });

  const walkoverAndBonuses = (
    <div className="space-y-4 pt-3">
      <div className="space-y-2" data-testid="stage-points-walkover">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-slate-800">
          {slotted(msg, "stagePoints.walkover", {
            w: (
              <NumberBox
                value={draft.walkoverW}
                onChange={(walkoverW) => patch({ walkoverW })}
                label={msg("stagePoints.walkoverW")}
                testId="stage-points-walkover-w"
                disabled={saving}
                placeholder={draft.win}
              />
            ),
            l: (
              <NumberBox
                value={draft.walkoverL}
                onChange={(walkoverL) => patch({ walkoverL })}
                label={msg("stagePoints.walkoverL")}
                testId="stage-points-walkover-l"
                disabled={saving}
                placeholder={draft.loss}
              />
            ),
          })}
        </p>
        {reaches && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-slate-800" data-testid="stage-points-award">
            {slotted(msg, "stagePoints.walkoverScore", {
              w: <NumberBox value={draft.awardW} onChange={(awardW) => patch({ awardW })} label={msg("stagePoints.awardW")} testId="stage-points-award-w" disabled={saving} />,
              l: <NumberBox value={draft.awardL} onChange={(awardL) => patch({ awardL })} label={msg("stagePoints.awardL")} testId="stage-points-award-l" disabled={saving} />,
            })}
          </p>
        )}
        <p className="text-xs text-slate-600" data-testid="stage-points-after-play-note">
          {msg("stagePoints.afterPlayNote")}
        </p>
      </div>

      <div className="space-y-2" data-testid="stage-points-bonuses">
        <span className="label">{msg("stagePoints.bonuses")}</span>
        {draft.bonuses.map((b, i) => (
          <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-2" data-testid={`stage-points-bonus-${i}`}>
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-sm text-slate-800">
              {slotted(msg, `stagePoints.bonus.${b.when}` as MessageKey, {
                ...(PARAM_BONUS_KINDS.has(b.when)
                  ? {
                      param: (
                        <NumberBox value={b.param} onChange={(param) => setBonus(i, { param })} label={msg("stagePoints.bonusParam")} testId={`stage-points-bonus-param-${i}`} disabled={saving} />
                      ),
                    }
                  : {}),
                points: (
                  <NumberBox value={b.points} onChange={(points) => setBonus(i, { points })} label={msg("stagePoints.bonusPoints")} testId={`stage-points-bonus-points-${i}`} disabled={saving} />
                ),
              })}
            </p>
            <button
              type="button"
              className="btn btn-ghost min-h-11 px-3 py-1.5 text-xs"
              aria-label={msg("stagePoints.bonusRemove", { n: i + 1 })}
              data-testid={`stage-points-bonus-remove-${i}`}
              disabled={saving}
              onClick={() => patch({ bonuses: draft.bonuses.filter((_, j) => j !== i) })}
            >
              ✕
            </button>
          </div>
        ))}
        {offered.length > 0 && (
          <select
            className="select min-h-11 min-w-[10rem] max-w-full"
            aria-label={msg("stagePoints.bonusAdd")}
            data-testid="stage-points-bonus-add"
            disabled={saving}
            value=""
            onChange={(e) => {
              if (e.target.value !== "") addBonus(e.target.value as BonusWhen);
            }}
          >
            <option value="">{msg("stagePoints.bonusAdd")}</option>
            {offered.map((when) => (
              <option key={when} value={when}>
                {msg(`stagePoints.bonus.${when}` as MessageKey, { param: "…", points: "…" })}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );

  return shell(
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {heading}
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            className="h-5 w-5 min-h-0 accent-purple-700"
            data-testid="stage-points-use-division"
            checked={draft.useDivision}
            disabled={saving}
            onChange={(e) => patch({ useDivision: e.target.checked })}
          />
          {msg("stagePoints.useDivision")}
        </label>
      </div>

      {previewText !== "" && (
        <p
          className="rounded-md border border-teal-200 bg-teal-50 px-3 py-2 text-xs leading-snug text-teal-900"
          data-testid="stage-points-preview"
        >
          {previewText}
        </p>
      )}

      {!draft.useDivision && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-3">
          {baseBoxes}
          <PhoneDisclosure
            summary={msg("stagePoints.more")}
            showLabel={msg("stagePoints.moreShow")}
            hideLabel={msg("stagePoints.moreHide")}
          >
            {walkoverAndBonuses}
          </PhoneDisclosure>
        </div>
      )}

      {problem !== null && !draft.useDivision && (
        <p role="alert" className="text-xs text-red-600" data-testid="stage-points-problem">
          {msg(`stagePoints.invalid.${problem}` as MessageKey)}
        </p>
      )}

      {(dirty || !draft.useDivision) && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary min-h-11 px-3 py-1.5 text-xs"
            data-testid="stage-points-save"
            disabled={saving || !dirty || problem !== null}
            onClick={save}
          >
            {saving ? msg("schedule.working") : msg("stagePoints.save")}
          </button>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-red-600" data-testid="stage-points-error">
          {error}
        </p>
      )}
    </div>,
  );
}
