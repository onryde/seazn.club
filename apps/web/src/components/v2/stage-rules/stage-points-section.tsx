"use client";

// W2c Task 18 (S3, ST-G8; owner pick A on mockup S3) - a table stage's OWN points, with the walkover row and bonuses behind
// "More" and a live preview in the public line's words. It sits beside the stage format row (its own PUT arm, `{points}`)
// and follows the same lock: a started stage, or a viewer, reads it and cannot change it.
//
// W2d Task 16 (spec §9 "Points section, widened"): ONE ROW PER OUTCOME THE STAGE CAN REACH (`pointsRows` over the engine's
// `reachableOutcomes`) — overtime and shoot-out rows, B2's "after a shoot-out: counts as a draw; the winner gets +[1]",
// a row per set score where the rule pays a set table, a loss not played (ITTF), a tie and a no result (ICC) — and the
// sport's preset chips (`tablePresets`). The editor says every split, so W2d Task 10 fix round 1 I2's "can't be set per
// stage yet" state is gone: what the server would refuse (POINTS_OUTCOME_UNCOVERED, POINTS_SPLIT_FLATTENED) is said
// inline, in its own words, before Save (`draftRefusal`). Only a stage whose sport rule cannot be read at all (a cfg the
// sport refuses) is fail-closed, with no inputs.
//
// WHAT IT OFFERS IS WHAT THE SERVER TAKES (every question is `stage-points-model.ts`'s, which asks the engine):
//   - scoring is free on every plan (owner, 2026-10-19), so the section asks no plan question; a 402 is said in the
//     server's own words;
//   - the walkover SCORE is shown only where the sport's table reads it (batch-3 I3);
//   - bonus kinds are those the sport's metrics can feed.
// Save sends ONLY `{points}`: the endpoint's body is strict, and an omitted `rules` arm is left as stored.
//
// W2d final review I1 (controller ruling, 2026-10-26): a stage PINNED at generate pays its pin, and a division points save
// after that lands but never reaches it. With no rule of its own, such a stage's card says and previews the PIN's points,
// in words that say they were fixed when it started ("stagePoints.startedPoints"), its checkbox reads "Keep the points it
// started with" (PR B carry: never "Use the division's points" over a number the table does not pay), and its editor
// prefills from the pin. An unpinned stage reads the live layers.
import { Fragment, useState, type ReactNode } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { PhoneDisclosure } from "@/components/v2/phone-disclosure";
import type { OutcomeKey } from "@seazn/engine/competition";
import type { AnySportModule } from "@seazn/engine/sport";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { ruleRefusalText } from "@/lib/rule-errors";
import { rulesLineText } from "@/lib/rules-line";
import {
  PARAM_BONUS_KINDS,
  draftFromStored,
  draftIsDirty,
  draftOfPreset,
  draftRefusal,
  offeredBonusKinds,
  offersWalkoverScore,
  pinInForce,
  pointsBasis,
  pointsPresets,
  pointsRows,
  presetActive,
  presetOffered,
  previewClauses,
  ruleFromDraft,
  stagePointsContext,
  storedPointsRule,
  type BonusWhen,
  type PointsDraft,
  type PointsRow,
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

/** A number in points as a reader writes it: a half as "½" (chess's 1½, spec §9), never "1.5". */
export function pointsText(n: number): string {
  const whole = Math.trunc(n);
  if (Math.abs(n - whole) !== 0.5) return String(n);
  return `${n < 0 && whole === 0 ? "-" : ""}${whole === 0 ? "" : whole}½`;
}

/** The row's words, each outcome key its own message: the dictionary holds one entry per key. */
const ROW_LABEL: Record<Exclude<OutcomeKey, `set:${string}`>, MessageKey> = {
  "win.regulation": "stagePoints.row.win",
  "win.ot": "stagePoints.row.winOt",
  "win.so": "stagePoints.row.winSo",
  "loss.regulation": "stagePoints.row.loss",
  "loss.ot": "stagePoints.row.lossOt",
  "loss.so": "stagePoints.row.lossSo",
  "loss.unplayed": "stagePoints.row.lossUnplayed",
  draw: "stagePoints.row.draw",
  tie: "stagePoints.row.tie",
  noResult: "stagePoints.row.noResult",
};
const isSetRow = (key: OutcomeKey): key is `set:${number}-${number}` => key.startsWith("set:");
const setScore = (key: `set:${number}-${number}`): string => key.slice("set:".length);
const rowTestId = (key: OutcomeKey): string => `stage-points-row-${key.replace(/[.:]/g, "-")}`;

/** The rows as words: what the stage plays (read-only, inheriting, or a viewer). */
function RowsList({ rows, unit, msg }: { rows: readonly PointsRow[]; unit: "whole" | "half"; msg: Msg }) {
  const shown = rows.filter((r) => r.shown);
  if (shown.length === 0) return null;
  const pts = (n: number) => pointsText(unit === "half" ? n / 2 : n);
  return (
    <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white text-sm text-slate-800" data-testid="stage-points-rows">
      {shown.map((r) => {
        let words: string;
        if (isSetRow(r.key)) {
          words = msg("stagePoints.row.set", { score: setScore(r.key), w: r.pair === null ? "—" : pts(r.pair[0]), l: r.pair === null ? "—" : pts(r.pair[1]) });
        } else if (r.drawPlusBonus !== null) {
          words = msg("stagePoints.row.soDraw", { bonus: pts(r.drawPlusBonus) });
        } else {
          words = `${msg(ROW_LABEL[r.key])}: ${r.value === null ? "—" : pts(r.value)}`;
        }
        return (
          <li key={r.key} className="px-3 py-2" data-testid={rowTestId(r.key)} data-uncovered={r.value === null ? "true" : undefined}>
            {words}
          </li>
        );
      })}
    </ul>
  );
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
  pinned = null,
  onSaved,
}: {
  stageId: string;
  module: AnySportModule;
  /** The stage's kind and its own config (its `rules` move the outcomes it reaches): the rows the editor shows. */
  kind: string;
  stageConfig: unknown;
  divisionConfig: Record<string, unknown>;
  /** `stage.config.points` as the page read it. */
  stored: unknown;
  /** The public dictionary's `format.points.*` slice (`pointsLineDict`); absent, the section shows no preview. */
  pointsDict: Dict | undefined;
  /** A started stage (the S4 lock) or a viewer: the section reads, nothing writes. */
  readOnly: boolean;
  /** I1: the points the stage's PIN pays (`listPinnedStagePoints`, the one loader's pin), or null/absent for a stage still
   *  reading the live layers. */
  pinned?: unknown;
  onSaved: () => void;
}) {
  const msg = useMsg();
  const stage = { kind, config: stageConfig };
  const [saved, setSaved] = useState<Saved | null>(null);
  const unread = saved !== null && saved.against === stored;
  const inForce = unread ? saved.points : stored;
  // I1: the pin as old as the page's props. Until the page re-reads after a save it says nothing: a cleared rule was re-pinned
  // to the live layers (`repinStageOwnRules`), and an own rule outranks any pin.
  const seedPin = unread ? null : pinned;
  const pin = pinInForce(inForce, seedPin);
  const basis = pointsBasis(inForce, pin);
  const [draft, setDraft] = useState<PointsDraft>(() => draftFromStored(module, divisionConfig, inForce, seedPin, stage));
  // T16 fix round 1 (review I1): the draft holds the stage's rows, so it follows what they are read from. A format save (best
  // of 5 → 3, overtime off) refreshes the page with new `rules`, a points save with a new rule, a re-pin with a new pin: each
  // re-seeds the draft (the Tie-breaks section's pattern). A refresh that changes none of them keeps a dirty draft.
  const stageRules = typeof stageConfig === "object" && stageConfig !== null ? ((stageConfig as { rules?: unknown }).rules ?? null) : null;
  const seedFor = JSON.stringify([kind, stageRules, divisionConfig ?? null, inForce ?? null, seedPin ?? null]);
  const [seededFor, setSeededFor] = useState(seedFor);
  if (seededFor !== seedFor) {
    setSeededFor(seedFor);
    setDraft(draftFromStored(module, divisionConfig, inForce, seedPin, stage));
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctx = stagePointsContext(module, divisionConfig, stage);

  const heading = <span className="text-xs font-semibold text-slate-800">{msg("stagePoints.title")}</span>;
  const shell = (children: ReactNode) => (
    <section
      aria-label={msg("stagePoints.title")}
      data-testid={`stage-points-${stageId}`}
      data-stage-points-state={ctx === null ? "inexpressible" : readOnly ? "readonly" : "editor"}
      data-stage-points-basis={basis}
      className="border-b border-slate-100 px-4 py-3"
    >
      {children}
    </section>
  );

  const ownRule = storedPointsRule(inForce);
  const preview = (d: PointsDraft): string => {
    if (pointsDict === undefined) return "";
    const clauses = previewClauses(module, divisionConfig, d, pin, stage);
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
      // No pin: a cleared rule now plays the live layers (the re-pin), an own one itself.
      setDraft(draftFromStored(module, divisionConfig, landed, null, stage));
      onSaved();
    } catch (err) {
      setError(failureText(err, msg));
    } finally {
      setSaving(false);
    }
  }

  // Fail-closed: the sport cannot read this stage's cfg, so there is no rule and no outcome to ask. The general sentence and
  // no inputs; a rule the stage STORES anyway is read, and an editable stage can clear it (`{points: null}`).
  if (ctx === null) {
    const own = ownRule === null ? "" : preview(draftFromStored(module, divisionConfig, inForce, null, stage));
    return shell(
      <div className="space-y-2">
        {heading}
        <p
          role="status"
          data-testid="stage-points-inexpressible"
          className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-snug text-slate-700"
        >
          {msg("stagePoints.inexpressible")}
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

  /** What the stage plays now: its own rule, its pin's, else the sport's own for the stage. */
  const playing = ownRule ?? pin ?? ctx.rule;
  const playingRows = pointsRows(ctx.reachable, playing);

  // A started stage, or a viewer: what the stage plays, in words. No control.
  if (readOnly) {
    const text = preview(draftFromStored(module, divisionConfig, inForce, pin, stage));
    return shell(
      <div className="space-y-2">
        {heading}
        <p className="text-xs text-slate-600" data-testid="stage-points-readonly">
          {msg(basis === "own" ? "stagePoints.ownPoints" : basis === "pin" ? "stagePoints.startedPoints" : "stagePoints.divisionPoints")}
        </p>
        <RowsList rows={playingRows} unit={playing.unit} msg={msg} />
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
  const refusal = draftRefusal(module, divisionConfig, stage, draft);
  const refusalText =
    refusal === null
      ? null
      : refusal.code === "POINTS_OUTCOME_UNCOVERED"
        ? ruleRefusalText(refusal.code, { uncovered: refusal.uncovered }, msg)
        : ruleRefusalText(refusal.code, { splits: refusal.splits }, msg);
  const dirty = draftIsDirty(module, draft, inForce);
  const previewText = preview(draft);
  const reaches = offersWalkoverScore(module);
  // m5: a chip that pays what the stage plays on every outcome it can reach changes nothing, so it is not offered.
  const presets = pointsPresets(module, kind).filter((p) => presetOffered(module, ctx, playing, draft, p.rule));
  // The rows' shape (which are shown) is the draft's rule where it is one, else what the stage plays: the draft never
  // changes a rule's shape except through a preset, which is always a rule.
  const editRows = pointsRows(ctx.reachable, built.ok && built.rule !== null ? built.rule : playing);

  const save = () => {
    if (built.ok && refusal === null) void write(built.rule);
  };

  const box = (field: keyof PointsDraft & string, testId: string, label: string, placeholder?: string) => (
    <NumberBox
      value={draft[field] as string}
      onChange={(raw) => patch({ [field]: raw } as Partial<PointsDraft>)}
      label={label}
      testId={testId}
      disabled={saving}
      placeholder={placeholder}
    />
  );
  const setBox = (score: string, side: 0 | 1) => {
    const label = msg(side === 0 ? "stagePoints.row.setW" : "stagePoints.row.setL", { score });
    return (
      <NumberBox
        value={draft.sets[score]?.[side] ?? ""}
        onChange={(raw) => {
          const pair: [string, string] = [...(draft.sets[score] ?? ["", ""])] as [string, string];
          pair[side] = raw;
          patch({ sets: { ...draft.sets, [score]: pair } });
        }}
        label={label}
        testId={`stage-points-set-${score}-${side === 0 ? "w" : "l"}`}
        disabled={saving}
        placeholder={side === 0 ? draft.win : draft.loss}
      />
    );
  };

  /** One editable row: its words and its box(es). */
  const editRow = (r: PointsRow): ReactNode => {
    if (isSetRow(r.key)) {
      const score = setScore(r.key);
      return slotted(msg, "stagePoints.row.set", { w: setBox(score, 0), l: setBox(score, 1) }, { score });
    }
    if (r.drawPlusBonus !== null) {
      return slotted(msg, "stagePoints.row.soDraw", { bonus: box("soBonus", "stage-points-so-bonus", msg("stagePoints.row.soBonus"), "1") });
    }
    const label = msg(ROW_LABEL[r.key]);
    const field: Record<Exclude<OutcomeKey, `set:${string}`>, [keyof PointsDraft & string, string, string | undefined]> = {
      "win.regulation": ["win", "stage-points-win", undefined],
      "win.ot": ["winOt", "stage-points-win-ot", draft.win],
      "win.so": ["winSo", "stage-points-win-so", draft.winOt || draft.win],
      "loss.regulation": ["loss", "stage-points-loss", undefined],
      "loss.ot": ["lossOt", "stage-points-loss-ot", draft.loss],
      "loss.so": ["lossSo", "stage-points-loss-so", draft.lossOt || draft.loss],
      "loss.unplayed": ["lossUnplayed", "stage-points-loss-unplayed", draft.loss],
      draw: ["draw", "stage-points-draw", undefined],
      tie: ["tie", "stage-points-tie", undefined],
      noResult: ["noResult", "stage-points-no-result", "0"],
    };
    const [name, testId, placeholder] = field[r.key];
    return (
      <>
        <span className="min-w-0 flex-1">{label}</span>
        {box(name, testId, label, placeholder)}
      </>
    );
  };

  const rowsEditor = (
    <ul className="divide-y divide-slate-200/70 text-sm text-slate-800" data-testid="stage-points-rows">
      {editRows
        .filter((r) => r.shown)
        .map((r) => {
          const uncovered = built.ok && r.value === null;
          return (
            <li
              key={r.key}
              data-testid={rowTestId(r.key)}
              data-uncovered={uncovered ? "true" : undefined}
              className={`flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 ${uncovered ? "text-red-700" : ""}`}
            >
              {editRow(r)}
            </li>
          );
        })}
    </ul>
  );

  const presetChips =
    presets.length === 0 ? null : (
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={msg("stagePoints.presets")} data-testid="stage-points-presets">
        <span className="text-xs text-slate-600">{msg("stagePoints.presets")}</span>
        {presets.map((p) => {
          const on = presetActive(module, draft, p.rule);
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              data-testid={`stage-points-preset-${p.id}`}
              disabled={saving}
              onClick={() => setDraft(draftOfPreset(module, divisionConfig, stage, p.rule))}
              className={`min-h-11 rounded-full border px-3 text-xs font-medium ${
                on ? "border-purple-700 bg-purple-700 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-purple-400"
              }`}
            >
              {msg(`stagePoints.preset.${p.id}` as MessageKey)}
            </button>
          );
        })}
      </div>
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
            w: box("walkoverW", "stage-points-walkover-w", msg("stagePoints.walkoverW"), draft.win),
            l: box("walkoverL", "stage-points-walkover-l", msg("stagePoints.walkoverL"), draft.loss),
          })}
        </p>
        {reaches && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-slate-800" data-testid="stage-points-award">
            {slotted(msg, "stagePoints.walkoverScore", {
              w: box("awardW", "stage-points-award-w", msg("stagePoints.awardW")),
              l: box("awardL", "stage-points-award-l", msg("stagePoints.awardL")),
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
          {/* PR B carry: a pinned stage with no rule of its own plays its PIN, not the division's points. */}
          {msg(basis === "pin" ? "stagePoints.keepStarted" : "stagePoints.useDivision")}
        </label>
      </div>

      {basis === "pin" && draft.useDivision && (
        <p className="text-xs text-slate-600" data-testid="stage-points-started">
          {msg("stagePoints.startedPoints")}
        </p>
      )}

      {draft.useDivision && <RowsList rows={playingRows} unit={playing.unit} msg={msg} />}

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
          {presetChips}
          {rowsEditor}
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

      {refusalText !== null && !draft.useDivision && (
        <p role="alert" className="text-xs text-red-600" data-testid="stage-points-refusal">
          {refusalText}
        </p>
      )}

      {(dirty || !draft.useDivision) && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary min-h-11 px-3 py-1.5 text-xs"
            data-testid="stage-points-save"
            disabled={saving || !dirty || problem !== null || refusal !== null}
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
