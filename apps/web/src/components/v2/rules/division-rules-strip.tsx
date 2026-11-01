"use client";

// Match Day C2 (spec 2026-10-31 §12 Phase C; owner, 2026-10-31) — the Division rules strip, at the top of the division's
// Fixtures tab. It edits the DIVISION's defaults — the match format, the points and the tie-break order every stage plays
// unless its card sets its own — with the same three components the builder and the stage cards use (`MatchFormatEditor`,
// `PointsEditor`, `TiebreaksEditor`, scope "division"). It replaces Settings' Match rules block (variant, online play and its
// clock, Standings points, the rule grid; the Advanced overrides JSON is gone: owner, "we don't need"). "Format" — the stage
// structure, League / Swiss / Playoff — stays in Settings with its rebuild.
//
// Three toggle buttons open their panels INLINE under the strip (owner, 2026-10-31, mock option 2: "so that we can reuse the
// component here and division builder"); several can be open at once. A reader who may not edit gets the same panels
// read-only (mode "locked").
//
// Every save is `PATCH /divisions/{id}` and is judged by `patchDivision`: a field a started stage plays is refused and named
// (`refused`), the rest lands; a stage pinned at generate keeps what it started with (`stagesKeptPinned`) and the strip says so
// beside the Save that caused it. The division's tie-break order is `divisions.tiebreakers`, the field a stage on "Use the
// division's order" reads (`loadTableRules`: own ?? division ?? sport).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { TableStageKind, TiebreakerKey } from "@seazn/engine/sport";
import type { Dict } from "@/lib/i18n-constants";
import { configIssueText, settingsSaveErrorText } from "@/lib/config-issue-copy";
import { ONLINE_CHESS_DISABLED_CODE, onlinePlayShown } from "@/lib/online-chess";
import { CHESS_INDIVIDUAL_ONLY } from "@/lib/chess-individual-only";
import { LICHESS_CLOCK_FIELD_KEYS, selectedTimeControlKey, timeControlOptions, timeControlRuleValues } from "@/lib/online-time-control";
import { hasLinkGaps, linkGapSentence, type LinkGapsSummary } from "@/lib/online-link-gaps";
import { keptPinnedOf, refusedFieldsOf, type KeptPinnedStage, type RefusedField } from "@/lib/rule-errors";
import { hydrateRuleValues, rulesFor, visibleRuleFields } from "@/lib/match-rules";
import { moduleFor } from "@/lib/rule-scope";
import { rulesChipText } from "@/lib/rules-line";
import { variantHint, variantOptionLabel } from "@/lib/variant-label-keys";
import { configUnderVariant, divisionFormatPatch, ruleValuesAfterVariantSwitch } from "@/components/v2/division-format-patch";
import { RULE_LOCK_PARTIAL_KEY, lockLineFor, lockSentence, mergeLocks, refusedLines, type RefusedLine } from "@/components/v2/division-settings-locks";
import { ruleFormState } from "@/components/v2/match-rules-state";
import { divisionSummaryClauses } from "@/components/v2/stage-rules/stage-row-model";
import { LockLine } from "./lock-line";
import { MatchFormatEditor, divisionGridFields } from "./match-format-editor";
import { PointsEditor, divisionPointsDirty, divisionPointsKeys, divisionPointsOf, divisionPointsPatch, hydrateDivisionPoints } from "./points-editor";
import { TiebreaksEditor } from "./tiebreaks-editor";

export type RulesPanel = "format" | "points" | "tiebreaks";

export interface DivisionRulesStripProps {
  divisionId: string;
  sportKey: string;
  /** The division's saved variant; null hides the variant select (no variant to choose between). */
  variantKey: string | null;
  divisionConfig: Record<string, unknown>;
  /** `divisions.tiebreakers`: the division's own order, or null while it follows the sport's. */
  divisionTiebreakers: readonly TiebreakerKey[] | null;
  /** The table kinds among the division's stages. Empty: no stage keeps a table, and Points / Tie-breaks are not offered. */
  tableKinds: readonly TableStageKind[];
  canEdit: boolean;
  /** The public dictionary's `format.*` slice, for the format's words. */
  ruleDict?: Dict;
  /** The public dictionary's `format.points.*` slice (`pointsLineDict`), for the points' words. */
  pointsDict?: Dict;
  /** `listVariantOptions` for the sport (the variant select). */
  variants: readonly { key: string; name: string; system?: boolean; config?: Record<string, unknown> }[];
  /** `divisionLockedFields`: the fields a started stage plays, locked before anyone types (W2c Task 20, S4). */
  lockedFields: readonly RefusedField[];
  /** Online chess is offered to this club (T20): the online play select. */
  onlineChessOffered: boolean;
  lichessGaps?: LinkGapsSummary;
  /** Panels open on first render (tests, a deep link). */
  initialOpen?: readonly RulesPanel[];
}

interface Feedback {
  panel: RulesPanel;
  notice: string | null;
  error: string | null;
  refused: RefusedField[];
  partial: boolean;
  keptPinned: KeptPinnedStage[];
}

export const TOGGLE_ON = "border-purple-200 bg-purple-50 text-purple-800";
export const TOGGLE_OFF = "border-slate-200 bg-white text-slate-700 hover:bg-slate-50";

export function DivisionRulesStrip({
  divisionId,
  sportKey,
  variantKey: savedVariantKey,
  divisionConfig,
  divisionTiebreakers,
  tableKinds,
  canEdit,
  ruleDict,
  pointsDict,
  variants,
  lockedFields,
  onlineChessOffered,
  lichessGaps,
  initialOpen = [],
}: DivisionRulesStripProps) {
  const msg = useMsg();
  const plural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const router = useRouter();
  const panelId = useId();
  const sportModule = moduleFor(sportKey);
  const [open, setOpen] = useState<ReadonlySet<RulesPanel>>(() => new Set(initialOpen));
  const mode = canEdit ? "edit" : "locked";

  // --- The match format's form (absorbed from Settings' Match rules block). ---
  const [variantKey, setVariantKey] = useState<string>(savedVariantKey ?? "");
  const [ruleValues, setRuleValues] = useState<Record<string, string>>(() => hydrateRuleValues(sportKey, divisionConfig));
  const [onlinePlay, setOnlinePlay] = useState<"off" | "lichess">(divisionConfig.onlinePlay === "lichess" ? "lichess" : "off");
  const points = sportModule === null ? undefined : divisionPointsOf(sportModule, divisionConfig);
  const [pointsValues, setPointsValues] = useState<Record<string, string>>(() => hydrateDivisionPoints(sportKey, points));
  const [order, setOrder] = useState<TiebreakerKey[] | null>(() => (divisionTiebreakers === null ? null : [...divisionTiebreakers]));
  // A saved change (or another tab's) arrives as new props after `router.refresh()`: the forms re-read them. Compared by
  // CONTENT, never by reference (every refresh hands back new objects; R3.5 review F6).
  const signature = JSON.stringify([savedVariantKey, divisionConfig, divisionTiebreakers]);
  const [synced, setSynced] = useState(signature);
  if (synced !== signature) {
    setSynced(signature);
    setVariantKey(savedVariantKey ?? "");
    setRuleValues(hydrateRuleValues(sportKey, divisionConfig));
    setOnlinePlay(divisionConfig.onlinePlay === "lichess" ? "lichess" : "off");
    setPointsValues(hydrateDivisionPoints(sportKey, points));
    setOrder(divisionTiebreakers === null ? null : [...divisionTiebreakers]);
  }

  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // What a save says is said where the organiser is looking: the panel's Save can sit at the bottom edge of the screen
  // (the strip heads a long Fixtures tab), so the answer under it is brought into view, no further than it takes.
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (feedback !== null) feedbackRef.current?.scrollIntoView({ block: "nearest" });
  }, [feedback]);
  // Fields a save refused that the page did not know were locked (a stage started after it loaded); dropped when the page's
  // own list changes, since the refresh after that save carries them.
  const [learnedLocks, setLearnedLocks] = useState<RefusedField[]>([]);
  const lockedSignature = JSON.stringify(lockedFields);
  const [syncedLocked, setSyncedLocked] = useState(lockedSignature);
  if (lockedSignature !== syncedLocked) {
    setSyncedLocked(lockedSignature);
    setLearnedLocks([]);
  }
  const locks = mergeLocks(lockedFields, learnedLocks);

  if (sportModule === null) return null;

  const presetOf = (key: string | null) => (key === null ? undefined : variants.find((v) => v.key === key)?.config);
  const inheritedCfg = configUnderVariant(divisionConfig, presetOf(savedVariantKey), presetOf(variantKey), variantKey === (savedVariantKey ?? ""));
  const ruleState = ruleFormState({ sportKey, variantKey, values: ruleValues, base: inheritedCfg });
  const lichessClock = sportKey === "boardgame" && onlinePlay === "lichess";
  const timeControl = lichessClock ? selectedTimeControlKey(ruleValues, divisionConfig) : "";
  const variantLock = lockLineFor("variant_key", locks);
  const pointsLock = lockLineFor("points", locks);
  const clockLock = lockLineFor("clock", locks, ["variant"]);
  const hint = savedVariantKey === null ? undefined : variantHint(sportKey, variantKey, locale);
  // The Match format section says its lock ONCE (fix round 1, I1; spec §12 items 4 and 13): every control it draws, each with
  // its lock (undefined: open), in the order they are drawn - the variant, online play (never locked: a started stage does not
  // play it), the Lichess clock, then the rule grid's own fields (`divisionGridFields`, the grid's own list). The first lock
  // names the stage for the whole section; when EVERY control is locked the section is read-only - its chips, no Save.
  const variantShown = savedVariantKey !== null && variants.length > 0;
  const onlineShown = onlinePlayShown(sportKey, onlineChessOffered);
  const omitted = lichessClock ? LICHESS_CLOCK_FIELD_KEYS : undefined;
  const formatControls: (RefusedField | undefined)[] = [
    ...(variantShown ? [variantLock] : []),
    ...(onlineShown ? [undefined] : []),
    ...(lichessClock ? [clockLock] : []),
    ...divisionGridFields(sportKey, ruleValues, inheritedCfg, omitted, ruleState).map((f) => lockLineFor(f.key, locks, f.edits)),
  ];
  const formatLock = formatControls.find((l): l is RefusedField => l !== undefined);
  const formatAllLocked = formatLock !== undefined && formatControls.every((l) => l !== undefined);
  const offersTable = tableKinds.length > 0;
  const pointsKeys = divisionPointsKeys(sportKey, points);

  const toggle = (panel: RulesPanel) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(panel)) next.delete(panel);
      else next.add(panel);
      return next;
    });

  const pickVariantKey = (next: string) => {
    setRuleValues(
      ruleValuesAfterVariantSwitch({
        sportKey,
        ruleValues,
        divisionConfig,
        savedPreset: presetOf(savedVariantKey),
        fromPreset: presetOf(variantKey),
        toPreset: presetOf(next),
        savedKey: savedVariantKey ?? "",
        fromKey: variantKey,
        toKey: next,
      }),
    );
    setVariantKey(next);
  };

  // A refusal keeps what is STORED, so the control it locks shows that again, not what was typed.
  const restoreRefused = (refused: readonly RefusedField[]) => {
    if (lockLineFor("variant_key", refused) !== undefined) setVariantKey(savedVariantKey ?? "");
    if (lockLineFor("points", refused) !== undefined) setPointsValues(hydrateDivisionPoints(sportKey, points));
    const stored = hydrateRuleValues(sportKey, divisionConfig);
    const covered = rulesFor(sportKey).filter((f) => lockLineFor(f.key, refused, f.edits) !== undefined);
    setRuleValues((prev) => {
      const next = { ...prev };
      for (const f of covered) {
        if (Object.hasOwn(stored, f.key)) next[f.key] = stored[f.key]!;
        else delete next[f.key];
      }
      return next;
    });
  };

  /** One save: the PATCH, then what it kept and what it did not reach, said beside the panel's own Save. */
  async function save(panel: RulesPanel, body: () => Record<string, unknown>) {
    setBusy(true);
    setFeedback(null);
    try {
      const saved = await apiV1<unknown>(`/api/v1/divisions/${divisionId}`, { method: "PATCH", json: body() });
      const refused = refusedFieldsOf(saved) ?? [];
      if (refused.length > 0) {
        setLearnedLocks((prev) => mergeLocks(prev, refused));
        restoreRefused(refused);
      }
      setFeedback({
        panel,
        notice: refused.length > 0 ? null : msg("divset.notice.rulesSaved"),
        error: null,
        refused,
        partial: refused.length > 0,
        keptPinned: keptPinnedOf(saved),
      });
      router.refresh();
    } catch (err) {
      const refused = err instanceof ApiV1Error ? (refusedFieldsOf(err.extra) ?? []) : [];
      if (refused.length > 0) {
        setLearnedLocks((prev) => mergeLocks(prev, refused));
        restoreRefused(refused);
      }
      setFeedback({ panel, notice: null, error: saveErrorText(err), refused, partial: false, keptPinned: [] });
    } finally {
      setBusy(false);
    }
  }

  function saveErrorText(err: unknown): string {
    if (err instanceof ApiV1Error && err.code === "INVALID_TIME_CONTROL") {
      const controls = Array.isArray(err.extra.controls) ? err.extra.controls.map(String).join(", ") : "";
      return msg("divset.err.timeControlUnsupported", { controls });
    }
    if (err instanceof ApiV1Error && err.code === ONLINE_CHESS_DISABLED_CODE) return msg("divset.err.onlineChessDisabled");
    // A chess division stored with a legacy entrants override that names teams: the format save re-sends the config, and the
    // server refuses it (owner ruling 2026-10-26). Server English otherwise: localise the code.
    if (err instanceof ApiV1Error && err.code === CHESS_INDIVIDUAL_ONLY) return msg("divset.err.chessIndividualOnly");
    if (err instanceof Error && err.name === "FormProblem") return err.message;
    // A refused rules save names its problem (CONFIG_INVALID `issues`) in the reader's language (W2c P-5).
    return settingsSaveErrorText(err, msg, msg("divset.failed"));
  }

  const saveFormat = () =>
    void save("format", () => {
      // A format the write door would refuse is stopped here, beside the field it is about.
      const problem = ruleState.problems[0];
      if (problem !== undefined) {
        const e = new Error(configIssueText({ path: [], message: problem.sentence }, msg));
        e.name = "FormProblem";
        throw e;
      }
      const config = divisionFormatPatch({
        sportKey,
        divisionConfig,
        savedVariantKey: savedVariantKey ?? "",
        variantKey,
        savedVariantPreset: presetOf(savedVariantKey),
        variantPreset: presetOf(variantKey),
        ruleValues,
        // The points are the Points panel's: this Save leaves them as stored.
        pointsFieldKeys: [],
        pointsValues: {},
        savedPoints: undefined,
        advanced: null,
      });
      if (sportKey === "boardgame") {
        if (onlinePlay === "lichess") config.onlinePlay = "lichess";
        else delete config.onlinePlay;
      }
      return savedVariantKey === null ? { config } : { variant_key: variantKey, config };
    });

  const savePoints = () => void save("points", () => ({ config: { ...divisionConfig, points: divisionPointsPatch(sportKey, points, pointsValues) } }));
  const saveOrder = (next: TiebreakerKey[] | null) => void save("tiebreaks", () => ({ tiebreakers: next }));

  // --- Feedback, said once, under the Save that caused it. ---
  const keptLines = (refused: readonly RefusedField[]): RefusedLine[] =>
    refusedLines(visibleRuleFields(sportKey, ruleValues, inheritedCfg), refused, msg, pointsKeys.length > 0);
  const refusedItems = (lines: readonly RefusedLine[]) => (
    <ul className="mt-1 space-y-0.5">
      {lines.map((l) => (
        <li key={l.id} data-testid={`division-refused-${l.id}`}>
          <span className="font-medium">{l.label}</span>
          {": "}
          {lockSentence(l.lock, msg)}
        </li>
      ))}
    </ul>
  );
  const feedbackFor = (panel: RulesPanel): ReactNode => {
    if (feedback === null || feedback.panel !== panel) return null;
    const lines = keptLines(feedback.refused);
    return (
      <div ref={feedbackRef} className="space-y-2" data-testid="division-rules-feedback">
        {feedback.notice !== null && (
          <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700" data-testid="division-rules-saved">
            {feedback.notice}
          </p>
        )}
        {feedback.keptPinned.length > 0 && (
          <ul role="status" className="space-y-0.5 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700" data-testid="division-kept-pinned">
            {feedback.keptPinned.map((k) => (
              <li key={k.stageId} data-testid={`division-kept-pinned-${k.stageId}`}>
                {msg("divset.keptPinned", { stage: k.name })}
              </li>
            ))}
          </ul>
        )}
        {feedback.partial && lines.length > 0 && (
          <div role="status" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="division-partial-save">
            <p className="font-medium">{msg(RULE_LOCK_PARTIAL_KEY, { n: lines.length })}</p>
            {refusedItems(lines)}
          </div>
        )}
        {feedback.error !== null && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600" data-testid="division-settings-error">
            {feedback.error}
          </p>
        )}
        {feedback.error !== null && lines.length > 0 && (
          <div role="status" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600" data-testid="division-refused-list">
            {refusedItems(lines)}
          </div>
        )}
      </div>
    );
  };

  const summary = ruleDict === undefined ? [] : divisionSummaryClauses(sportKey, sportModule, divisionConfig).map((c) => rulesChipText(ruleDict, c));
  const panels: { id: RulesPanel; label: string }[] = [
    { id: "format", label: msg("rulesStrip.format") },
    ...(offersTable
      ? [
          { id: "points" as const, label: msg("stagePoints.title") },
          { id: "tiebreaks" as const, label: msg("stageTiebreaks.title") },
        ]
      : []),
  ];

  return (
    <section className="card min-w-0 p-0" aria-labelledby={`${panelId}-title`} data-testid="division-rules-strip">
      <div className="flex min-w-0 flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h2 id={`${panelId}-title`} className="text-sm font-semibold text-slate-900">
            {msg("rulesStrip.title")}
          </h2>
          <p className="mt-0.5 text-xs text-slate-600">{msg("rulesStrip.lead")}</p>
          {summary.length > 0 && (
            <p className="mt-1 min-w-0 break-words text-xs text-slate-800" data-testid="division-rules-summary">
              {summary.join(" · ")}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label={msg("rulesStrip.title")}>
          {panels.map((p) => {
            const on = open.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                aria-expanded={on}
                aria-controls={`${panelId}-${p.id}`}
                data-testid={`division-rules-toggle-${p.id}`}
                onClick={() => toggle(p.id)}
                className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600 ${on ? TOGGLE_ON : TOGGLE_OFF}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {open.has("format") && (
        <div id={`${panelId}-format`} role="region" aria-label={msg("rulesStrip.format")} className="space-y-3 border-t border-slate-100 px-4 py-3" data-testid="division-rules-panel-format">
          <h3 className="text-xs font-semibold text-slate-800">{msg("rulesStrip.format")}</h3>
          {mode === "locked" ? (
            <MatchFormatEditor scope="division" mode="locked" sportKey={sportKey} module={sportModule} values={ruleValues} onChange={setRuleValues} inherited={divisionConfig} ruleDict={ruleDict} />
          ) : formatAllLocked ? (
            // Every control is locked: the section reads, it does not offer a form it would refuse whole.
            <>
              <LockLine testId="division-locked-format" text={lockSentence(formatLock, msg)} />
              <MatchFormatEditor scope="division" mode="locked" sportKey={sportKey} module={sportModule} values={ruleValues} onChange={setRuleValues} inherited={divisionConfig} ruleDict={ruleDict} />
              {feedbackFor("format")}
            </>
          ) : (
            <>
              {formatLock !== undefined && <LockLine testId="division-locked-format" text={lockSentence(formatLock, msg)} />}
              {variantShown && (
                <div>
                  <label className="block text-xs text-slate-600">
                    {msg("divset.variant")}
                    <select
                      disabled={busy || variantLock !== undefined}
                      value={variantKey}
                      onChange={(e) => pickVariantKey(e.target.value)}
                      aria-describedby={hint === undefined ? undefined : `${panelId}-variant-hint`}
                      data-testid="division-settings-variant"
                      className="select mt-1 min-h-11 w-full sm:max-w-sm"
                    >
                      {variants.map((v) => (
                        <option key={v.key} value={v.key}>
                          {variantOptionLabel(sportKey, v, msg)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {hint !== undefined && (
                    <p id={`${panelId}-variant-hint`} role="note" data-testid="division-variant-hint" className="mt-2 min-w-0 rounded-md bg-slate-50 px-3 py-2 text-xs leading-snug text-slate-700">
                      {msg(hint.key, hint.vars)}
                    </p>
                  )}
                </div>
              )}

              {onlineShown && (
                <div>
                  <label className="block text-xs text-slate-600">
                    {msg("divset.onlinePlay.label")}
                    <select
                      disabled={busy}
                      value={onlinePlay}
                      onChange={(e) => setOnlinePlay(e.target.value as "off" | "lichess")}
                      className="select mt-1 min-h-11 w-full sm:max-w-sm"
                      data-testid="division-online-play"
                    >
                      <option value="off">{msg("divset.onlinePlay.off")}</option>
                      <option value="lichess">{msg("divset.onlinePlay.lichess")}</option>
                    </select>
                  </label>
                  <p className="mt-1 text-[11px] text-slate-600">{msg("divset.onlinePlay.help")}</p>
                  {/* WARN, never block: the select and Save stay live. */}
                  {onlinePlay === "lichess" && lichessGaps !== undefined && hasLinkGaps(lichessGaps) && (
                    <div
                      role="status"
                      data-testid="division-online-link-gaps"
                      className="mt-2 grid min-w-0 gap-2 break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                    >
                      {lichessGaps.unlinked.count > 0 && (
                        <p data-testid="division-online-unlinked" className="min-w-0 [overflow-wrap:anywhere]">
                          {linkGapSentence("unlinked", lichessGaps.unlinked, locale, plural)}
                        </p>
                      )}
                      {lichessGaps.reconnect.count > 0 && (
                        <p data-testid="division-online-reconnect" className="min-w-0 [overflow-wrap:anywhere]">
                          {linkGapSentence("reconnect", lichessGaps.reconnect, locale, plural)}
                        </p>
                      )}
                      {lichessGaps.empty.count > 0 && (
                        <p data-testid="division-online-empty" className="min-w-0 [overflow-wrap:anywhere]">
                          {linkGapSentence("empty", lichessGaps.empty, locale, plural)}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {lichessClock && (
                <div>
                  <label className="block text-xs text-slate-600">
                    {msg("divset.timeControl.label")}
                    <select
                      disabled={busy || clockLock !== undefined}
                      value={timeControl}
                      onChange={(e) => {
                        const picked = timeControlRuleValues(e.target.value);
                        if (picked) setRuleValues({ ...ruleValues, ...picked });
                      }}
                      className="select mt-1 min-h-11 w-full sm:max-w-sm"
                      data-testid="division-time-control"
                    >
                      {timeControl === "" && <option value="">{msg("divset.timeControl.choose")}</option>}
                      {timeControlOptions(msg).map((o) => (
                        <option key={o.key} value={o.key}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="mt-1 text-[11px] text-slate-600">{msg("divset.timeControl.help")}</p>
                  {timeControl === "" && <p className="mt-1 text-[11px] text-amber-700">{msg("divset.timeControl.unsupported")}</p>}
                </div>
              )}

              <MatchFormatEditor
                scope="division"
                mode="edit"
                sportKey={sportKey}
                module={sportModule}
                values={ruleValues}
                onChange={setRuleValues}
                inherited={inheritedCfg}
                ruleDict={ruleDict}
                lockedFields={locks}
                omit={omitted}
                state={ruleState}
                disabled={busy}
              />
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" disabled={busy} onClick={saveFormat} className="btn btn-primary min-h-11 px-3 text-xs" data-testid="division-rules-format-save">
                  {busy ? msg("schedule.working") : msg("rulesStrip.format.save")}
                </button>
              </div>
              {feedbackFor("format")}
            </>
          )}
        </div>
      )}

      {offersTable && open.has("points") && (
        <div id={`${panelId}-points`} role="region" aria-label={msg("stagePoints.title")} className="space-y-3 border-t border-slate-100 px-4 py-3" data-testid="division-rules-panel-points">
          <h3 className="text-xs font-semibold text-slate-800">{msg("stagePoints.title")}</h3>
          <PointsEditor
            scope="division"
            mode={mode === "edit" && pointsLock === undefined ? "edit" : "locked"}
            module={sportModule}
            divisionConfig={divisionConfig}
            value={pointsValues}
            onChange={setPointsValues}
            kinds={tableKinds}
            onSave={savePoints}
            dirty={divisionPointsDirty(sportKey, points, pointsValues)}
            saving={busy}
            lockText={pointsLock === undefined ? null : lockSentence(pointsLock, msg)}
            pointsDict={pointsDict}
          />
          {feedbackFor("points")}
        </div>
      )}

      {offersTable && open.has("tiebreaks") && (
        <div id={`${panelId}-tiebreaks`} role="region" aria-label={msg("stageTiebreaks.title")} className="space-y-3 border-t border-slate-100 px-4 py-3" data-testid="division-rules-panel-tiebreaks">
          <h3 className="text-xs font-semibold text-slate-800">{msg("stageTiebreaks.title")}</h3>
          <TiebreaksEditor
            scope="division"
            mode={mode}
            module={sportModule}
            value={order}
            stored={divisionTiebreakers}
            onChange={setOrder}
            divisionConfig={divisionConfig}
            kinds={tableKinds}
            onSave={saveOrder}
            saving={busy}
          />
          {feedbackFor("tiebreaks")}
        </div>
      )}
    </section>
  );
}
