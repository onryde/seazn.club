"use client";

// Match Day C2 (spec 2026-10-31 §12 Phase C items 4, 5, 10) — THE Points component: one editor for what a table pays, reused
// wherever those points are set or read (owner, 2026-10-31: "single component for each and reuse in builder, fixture and match
// pages"). Two scopes, one set of modes:
//
//   - scope "stage"    — a table stage's OWN points on the stage card (absorbed from `stage-points-section.tsx`, W2c Task 18 /
//                        W2d Task 16): one row per outcome the stage can reach, the sport's preset chips, the walkover row and
//                        bonuses behind "More". Save sends ONLY `{points}` to the stage rules PUT (strict body; an omitted
//                        `rules` arm is left as stored). A stage PINNED at generate with no rule of its own plays its pin (W2d
//                        final review I1): its checkbox reads "Keep the points it started with".
//   - scope "division" — the division's default points: the win / draw / loss the sport's config keeps (`config.points`;
//                        absorbed from Settings' "Standings points", R3.5 F7: which boxes show is read off the config's OWN
//                        points shape, never the sport key). The division builder's Format tab (controlled, sent with the
//                        create) and the Division rules strip on the Fixtures tab (saved with `PATCH /divisions/{id}`). A sport
//                        whose config keeps no such points (a set sport: badminton pays per game score) shows what the sport
//                        pays, read-only.
//   - there is no "fixture" scope: one match has no table (`PointsEditorProps` refuses it at the type level).
//
// Modes: "edit" as above; "locked" — read-only, said ONCE (item 5): "Win 2 · Loss 0" when every set score pays the same, the
// per-score rows only when they differ (C1 `summarisePoints`, a SET-TABLE summary only), and a sport that can draw keeps its
// own outcome rows ("A win: 3", "A draw: 1"). A started stage says one lock line (item 4), never "Changes to the division's
// points don't reach it".
//
// WHAT IT OFFERS IS WHAT THE SERVER TAKES (every question is `stage-points-model.ts`'s, which asks the engine): scoring is free
// on every plan (owner, 2026-10-19), so the editor asks no plan question; a 402 is said in the server's own words.
import { Fragment, useState, type ReactNode } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { PhoneDisclosure } from "@/components/v2/phone-disclosure";
import type { OutcomeKey, PointsRule } from "@seazn/engine/competition";
import type { AnySportModule, TableStageKind } from "@seazn/engine/sport";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";
import { ruleRefusalText } from "@/lib/rule-errors";
import { rulesLineText } from "@/lib/rules-line";
import { summarisePoints } from "@/lib/stage-card/summaries";
import { pointsLine, type PointsClause } from "@/lib/points-line";
import { rulesFor } from "@/lib/match-rules";
import { LockLine, type RulesMode } from "./lock-line";
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
} from "@/components/v2/stage-rules/stage-points-model";

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

/** The set-table clauses (`pointsLine`'s per-score sentences): what `summarisePoints` says instead. */
const SET_CLAUSE = new Set(["format.points.setScore", "format.points.setScoreOther"]);

/**
 * What a points rule pays, said ONCE (item 5). A set table that pays every reachable score the same is one line, "Win 2 · Loss 0"
 * (C1 `summarisePoints`), never "pays 2-0 points"; a set table whose scores differ keeps a row per score. A rule with no set
 * table (a sport that can draw, an overtime split) is the public line's own sentence (`pointsLine`). Either way the rest of the
 * line — a walkover, bonuses — follows in the same words. Without the public dictionary (the builder) the outcome rows say it.
 * Numbers in points (a half-point rule shows "1½").
 */
export function PointsSummary({
  rule,
  reachable,
  clauses,
  pointsDict,
}: {
  rule: PointsRule;
  reachable: readonly OutcomeKey[];
  /** `pointsLine` of the rule (or the stage's `previewClauses`): the words, and the tail after the table. */
  clauses: readonly PointsClause[];
  pointsDict: Dict | undefined;
}) {
  const msg = useMsg();
  const rows = pointsRows(reachable, rule);
  const pts = (n: number) => pointsText(rule.unit === "half" ? n / 2 : n);
  const map = rule.bySetScore;
  const words = (cs: readonly PointsClause[]) => (pointsDict === undefined || cs.length === 0 ? "" : rulesLineText(pointsDict, [...cs]));
  if (map === undefined) {
    const line = words(clauses);
    if (line === "") return <RowsList rows={rows} unit={rule.unit} msg={msg} />;
    return (
      <p className="text-sm text-slate-800" data-testid="stage-points-preview">
        {line}
      </p>
    );
  }
  const tail = words(clauses.filter((c) => !SET_CLAUSE.has(c.key)));
  const payouts = rows.flatMap((r) => (r.pair === null ? [] : [{ score: setScore(r.key as `set:${number}-${number}`), winner: r.pair[0], loser: r.pair[1] }]));
  const star = Object.hasOwn(map, "*") ? map["*"]! : null;
  const summary = summarisePoints(payouts, star === null ? null : { winner: star[0], loser: star[1] });
  if (summary.kind === "uniform") {
    const head = msg("stageCard.points.uniform", { w: pts(summary.win), l: pts(summary.loss) });
    return (
      <p className="text-sm text-slate-800" data-testid="stage-points-summary" data-kind="uniform">
        {tail === "" ? head : `${head} · ${tail}`}
      </p>
    );
  }
  return (
    <div className="space-y-1.5" data-testid="stage-points-summary" data-kind="table">
      {summary.rows.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white text-sm text-slate-800">
          {summary.rows.map((r) => (
            <li key={r.score} className="px-3 py-2" data-testid={`stage-points-row-set-${r.score.replace(/[.:]/g, "-")}`}>
              {msg("stagePoints.row.set", { score: r.score, w: pts(r.winner), l: pts(r.loser) })}
            </li>
          ))}
        </ul>
      )}
      {tail !== "" && <p className="text-xs text-slate-700">{tail}</p>}
    </div>
  );
}

/**
 * Match Day C3 (spec §12 items 5 and 12): what a stage pays, in ONE phrase for the stage card's summary line. A set table that pays
 * every reachable score the same is "Win 2 · Loss 0" (C1's `summarisePoints`, the numbers in the stage's own unit); any other
 * rule is the first clause of the public points sentence (its base: "win 3, draw 1, loss 0"), capitalised - the walkover, the
 * bonuses and the per-score table are the Points panel's to say. Reads the same rule the panel's read-only branch does (its own,
 * else its pin's, else the live layers'). Null for a kind with no table, a cfg the sport refuses, and (outside a uniform set
 * table) when the public dictionary is absent: no English is made up here.
 */
export function stagePointsHeadline(
  a: {
    module: AnySportModule;
    kind: string;
    stageConfig: unknown;
    divisionConfig: Record<string, unknown>;
    stored: unknown;
    pinned?: unknown;
    pointsDict: Dict | undefined;
  },
  msg: Msg,
): string | null {
  const stage = { kind: a.kind, config: a.stageConfig };
  const ctx = stagePointsContext(a.module, a.divisionConfig, stage);
  if (ctx === null) return null;
  const pin = pinInForce(a.stored, a.pinned ?? null);
  const playing = storedPointsRule(a.stored) ?? pin ?? ctx.rule;
  const pts = (n: number) => pointsText(playing.unit === "half" ? n / 2 : n);
  const map = playing.bySetScore;
  if (map !== undefined) {
    const rows = pointsRows(ctx.reachable, playing);
    const payouts = rows.flatMap((r) => (r.pair === null ? [] : [{ score: setScore(r.key as `set:${number}-${number}`), winner: r.pair[0], loser: r.pair[1] }]));
    const star = Object.hasOwn(map, "*") ? map["*"]! : null;
    const summary = summarisePoints(payouts, star === null ? null : { winner: star[0], loser: star[1] });
    if (summary.kind === "uniform") return msg("stageCard.points.uniform", { w: pts(summary.win), l: pts(summary.loss) });
  }
  if (a.pointsDict === undefined) return null;
  const clauses = previewClauses(a.module, a.divisionConfig, draftFromStored(a.module, a.divisionConfig, a.stored, a.pinned ?? null, stage), pin, stage);
  const head = clauses[0];
  if (head === undefined) return null;
  const text = rulesLineText(a.pointsDict, [head]);
  return text === "" ? null : text;
}

interface Saved {
  /** The row's `stage.config.points` prop when the save landed: while the prop is still this value the page has not
   *  re-read the stage since, and `points` is newer than it (the stage rules row's `SavedStageRules` pattern). */
  readonly against: unknown;
  readonly points: unknown;
}

export interface StagePointsProps {
  scope: "stage";
  /** "locked": a started stage (the S4 lock) or a viewer — the section reads, nothing writes. */
  mode: RulesMode;
  /** The server's lock (`formatLockedStageIds`): the section says it once. */
  started: boolean;
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
  /** I1: the points the stage's PIN pays (`listPinnedStagePoints`, the one loader's pin), or null/absent for a stage still
   *  reading the live layers. */
  pinned?: unknown;
  onSaved: () => void;
}

export interface DivisionPointsProps {
  scope: "division";
  mode: RulesMode;
  module: AnySportModule;
  /** The division's config as it stands (the builder: the variant's preset; the strip: the stored config). Its `points` shape
   *  decides which boxes show (`divisionPointsKeys`). */
  divisionConfig: Record<string, unknown>;
  /** The boxes' raw values, by points key (`hydrateDivisionPoints`). */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** The table kinds that will play these points; the first decides the outcomes said in read-only. Empty: a league. */
  kinds: readonly TableStageKind[];
  /** The strip's Save, offered while `dirty`; absent (the builder) the value is the parent's to send. */
  onSave?: () => void;
  dirty?: boolean;
  saving?: boolean;
  error?: string | null;
  /** A started stage that plays these points (`lockLineFor("points", …)`): its sentence, said once, and no box. */
  lockText?: string | null;
  /** The public dictionary's `format.points.*` slice (`pointsLineDict`): the read-only words. Absent (the builder), the rows. */
  pointsDict?: Dict;
}

export type PointsEditorProps = StagePointsProps | DivisionPointsProps;

export function PointsEditor(props: PointsEditorProps) {
  return props.scope === "stage" ? <StagePoints {...props} /> : <DivisionPoints {...props} />;
}

export function StagePoints({ mode, started, stageId, module, kind, stageConfig, divisionConfig, stored, pointsDict, pinned = null, onSaved }: StagePointsProps) {
  const readOnly = mode === "locked";
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

  // A started stage, or a viewer: what the stage plays, said ONCE (item 5: no preview line repeating the rows). No control. A
  // started stage says its one lock line (item 4). Whose points it plays is said where it is true going forward - its own,
  // or the division's (an unpinned stage follows a division save) - and never for a pin ("Changes to the division's points
  // don't reach it" is internals: the lock line already says the stage is fixed).
  if (readOnly) {
    const source = basis === "pin" ? null : basis === "own" ? "stagePoints.ownPoints" : "stagePoints.divisionPoints";
    return shell(
      <div className="space-y-2" data-testid="stage-points-readonly">
        {heading}
        {started && <LockLine testId="stage-points-locked" />}
        {source !== null && (
          <p className="text-xs text-slate-600" data-testid="stage-points-source">
            {msg(source)}
          </p>
        )}
        <PointsSummary
          rule={playing}
          reachable={ctx.reachable}
          clauses={previewClauses(module, divisionConfig, draftFromStored(module, divisionConfig, inForce, pin, stage), pin, stage)}
          pointsDict={pointsDict}
        />
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

      {draft.useDivision && <RowsList rows={pointsRows(ctx.reachable, playing)} unit={playing.unit} msg={msg} />}

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

// ---------------------------------------------------------------------------------------------------------------------
// The division's default points (absorbed from Settings' "Standings points", R3.5 review F7).
// ---------------------------------------------------------------------------------------------------------------------

/** The win / draw / loss concepts a division's `config.points` may spell (generic writes w/d/l, the rest win/draw/loss), in
 *  display order with their labels. Cricket's tie / no result, ice hockey's overtime pair and the rest are deliberately NOT
 *  boxes here (owner, R3.5 review: making them editable is its own capability, with its own copy) — a stage's own points edit
 *  every outcome it reaches. */
const POINTS_KEY_CONCEPT: Record<string, { order: number; labelKey: MessageKey }> = {
  w: { order: 0, labelKey: "divset.win" },
  win: { order: 0, labelKey: "divset.win" },
  d: { order: 1, labelKey: "divset.draw" },
  draw: { order: 1, labelKey: "divset.draw" },
  l: { order: 2, labelKey: "divset.loss" },
  loss: { order: 2, labelKey: "divset.loss" },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The division's own points as its config holds them, else as the sport's schema defaults them (the builder: no config yet). */
export function divisionPointsOf(module: AnySportModule, divisionConfig: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isObj(divisionConfig.points)) return divisionConfig.points;
  const parsed = module.configSchema.safeParse(divisionConfig);
  const points = parsed.success ? (parsed.data as Record<string, unknown>).points : undefined;
  return isObj(points) ? points : undefined;
}

/** The boxes this division shows: the keys its OWN points shape has that name a win, a draw or a loss — read off the config,
 *  never the sport key (R3.5 F7: generic's w/d/l, football's win/draw/loss, a set sport none). */
export function divisionPointsKeys(sportKey: string, points: Record<string, unknown> | undefined): string[] {
  if (points === undefined) return [];
  // A key a match-rules field already edits (none today) stays that field's, so the two editors never double up on one key.
  const dedicated = new Set(rulesFor(sportKey).map((f) => f.key));
  return Object.keys(points)
    .filter((k) => Object.hasOwn(POINTS_KEY_CONCEPT, k) && !dedicated.has(k) && typeof points[k] === "number")
    .sort((a, b) => POINTS_KEY_CONCEPT[a]!.order - POINTS_KEY_CONCEPT[b]!.order);
}

/** The boxes' starting values: the numbers the points hold, as text. */
export function hydrateDivisionPoints(sportKey: string, points: Record<string, unknown> | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of divisionPointsKeys(sportKey, points)) values[key] = String(points![key]);
  return values;
}

/** The `points` a save sends: the stored map with the boxes laid over it (a blank box keeps the stored number), every other
 *  key the map holds (a shoot-out pair, cricket's tie) kept as it is. Undefined when the division keeps no points. */
export function divisionPointsPatch(
  sportKey: string,
  points: Record<string, unknown> | undefined,
  values: Record<string, string>,
): Record<string, unknown> | undefined {
  if (points === undefined) return undefined;
  const out: Record<string, unknown> = { ...points };
  for (const key of divisionPointsKeys(sportKey, points)) {
    const raw = values[key];
    if (raw !== undefined && raw.trim() !== "" && Number.isFinite(Number(raw))) out[key] = Number(raw);
  }
  return out;
}

/** The boxes differ from what the config holds. */
export function divisionPointsDirty(sportKey: string, points: Record<string, unknown> | undefined, values: Record<string, string>): boolean {
  return JSON.stringify(divisionPointsPatch(sportKey, points, values)) !== JSON.stringify(points);
}

function DivisionPoints({ mode, module, divisionConfig, value, onChange, kinds, onSave, dirty = false, saving = false, error = null, lockText = null, pointsDict }: DivisionPointsProps) {
  const msg = useMsg();
  const points = divisionPointsOf(module, divisionConfig);
  const keys = divisionPointsKeys(module.key, points);
  const kind = kinds[0] ?? "league";
  // What the division pays as the boxes stand: the config with the boxes laid over it, through the sport's own rule.
  const patched = divisionPointsPatch(module.key, points, value);
  const cfg = patched === undefined ? divisionConfig : { ...divisionConfig, points: patched };
  const ctx = stagePointsContext(module, cfg, { kind, config: {} });
  const readOnly = mode === "locked" || keys.length === 0;
  return (
    <section
      aria-label={msg("stagePoints.title")}
      data-testid="division-points"
      data-state={mode === "locked" ? "readonly" : keys.length === 0 ? "sport" : "editor"}
      className="min-w-0 space-y-2"
    >
      {lockText !== null && (
        <p className="text-[11px] leading-snug text-slate-700" data-testid="division-locked-points">
          <span aria-hidden="true">🔒 </span>
          {lockText}
        </p>
      )}
      {readOnly ? (
        ctx === null ? null : (
          <PointsSummary
            rule={ctx.rule}
            reachable={ctx.reachable}
            clauses={pointsLine(ctx.rule, { awardReaches: offersWalkoverScore(module) })}
            pointsDict={pointsDict}
          />
        )
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:max-w-sm">
          {keys.map((key) => (
            <label key={key} className="block min-w-0 text-xs text-slate-600">
              {msg(POINTS_KEY_CONCEPT[key]!.labelKey)}
              <input
                type="number"
                min={0}
                max={99}
                inputMode="numeric"
                data-testid={`division-points-${key}`}
                disabled={saving}
                value={value[key] ?? ""}
                onChange={(e) => onChange({ ...value, [key]: e.target.value })}
                className="input mt-1 min-h-11 w-full"
              />
            </label>
          ))}
        </div>
      )}
      {keys.length === 0 && mode === "edit" && (
        <p className="text-xs text-slate-600" data-testid="division-points-per-stage">
          {msg("rulesStrip.points.perStage")}
        </p>
      )}
      {!readOnly && onSave !== undefined && dirty && (
        <button type="button" className="btn btn-primary min-h-11 px-3 py-1.5 text-xs" data-testid="division-points-save" disabled={saving} onClick={onSave}>
          {saving ? msg("schedule.working") : msg("stagePoints.save")}
        </button>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-red-600" data-testid="division-points-error">
          {error}
        </p>
      )}
    </section>
  );
}
