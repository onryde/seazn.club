"use client";

// W2c Task 19 (S2, X-SR-2, X-SR-3, X-SR-5) - the fixture console's "Match rules" block: the format this ONE match plays, over
// its stage's. Before the match starts the organiser changes it (a best of 1, no extra time) and can set it back with "Use
// stage rules"; once it is under way "Correct format" opens the same form with a warning that the match so far is kept (the
// writer refolds the recorded play under the corrected format and refuses a correction it does not fit); a finished match
// shows the lock and no form.
//
// WHAT THE BLOCK READS is the RESOLVED cfg the page hands it (`loadFixtureMatchRules`: the stage's own format, the format
// the match plays now), never a raw stored config. Which fields exist, and what each offers, is the engine's declaration
// (`match-rules-block-model.ts`): a decider opens at the stage's value and is offered only off or shorter (X-SR-2).
//
// One DOM at every width (AGENTS.md "The phone composition"): the console wraps this block in a PhoneDisclosure, so a phone
// folds it and >= 768 is a plain card.
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { rulesWriteErrorText } from "@/lib/config-issue-copy";
import type { MessageKey } from "@/lib/messages";
import { FIXTURE_LOCK_KEYS } from "@/lib/rule-errors";
import { moduleFor } from "@/lib/rule-scope";
import { setRuleValue } from "@/lib/match-rules";
import { RuleFieldControl } from "./stage-rules/rule-field-control";
import {
  hydrateMatchValues,
  blockSeedKey,
  matchFormDirty,
  matchFormFields,
  matchFragment,
  matchSource,
  type MatchFormCtx,
  type MatchFormLabels,
  type MatchRulesBlockProps,
} from "./match-rules-block-model";

export type { MatchRulesBlockProps, MatchRulesState } from "./match-rules-block-model";

type LockReason = "decided" | "cancelled" | "finished";
const LOCK_KEY = {
  decided: FIXTURE_LOCK_KEYS.decided,
  cancelled: FIXTURE_LOCK_KEYS.cancelled,
  finished: "matchRules.locked",
} as const satisfies Record<LockReason, MessageKey>;

/** The testid segment of a field: the top segment of the first key it edits (the stage row's own, `stage-rule-field-*`). */
const topSegment = (edits: readonly string[]): string => edits[0]!.split(".")[0]!;

export function MatchRulesBlock(props: MatchRulesBlockProps) {
  // The page re-reads the rules after a save (`router.refresh()`): a NEW answer re-seeds the form from it.
  return <MatchRulesBlockBody key={blockSeedKey(props)} {...props} />;
}

function MatchRulesBlockBody({ fixtureId, sportKey, stageKind, variant, stageLine, stageResolved, effective, effectiveLine, override, state, cancelled }: MatchRulesBlockProps) {
  const msg = useMsg();
  const router = useRouter();
  const formId = useId();
  const sportModule = moduleFor(sportKey);
  const labels = useMemo<MatchFormLabels>(
    () => ({ off: msg("rules.off"), halfMinutes: (n) => msg("matchRules.halfMinutes", { n }) }),
    [msg],
  );
  const ctx = useMemo<MatchFormCtx | null>(
    () => (sportModule === null ? null : { sportKey, module: sportModule, stageKind, variant }),
    [sportKey, sportModule, stageKind, variant],
  );
  const stageValues = useMemo(() => (ctx === null ? {} : hydrateMatchValues(ctx, stageResolved, stageResolved, labels)), [ctx, stageResolved, labels]);
  const seed = useMemo(() => (ctx === null ? {} : hydrateMatchValues(ctx, stageResolved, effective, labels)), [ctx, stageResolved, effective, labels]);

  const [values, setValues] = useState<Record<string, string>>(seed);
  const [opened, setOpened] = useState<Record<string, string>>(seed);
  const [overridden, setOverridden] = useState(override !== null);
  // A live match keeps its form closed until "Correct format" (X-SR-5): a correction is a deliberate act.
  const [correcting, setCorrecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ctx === null) return null;
  const fields = matchFormFields(ctx, stageResolved, values, labels);
  const dirty = matchFormDirty(opened, values);
  // Finished, or decided without play with no award to refit (a bye): either way the writer refuses every change.
  const locked = state === "locked" || state === "decided";
  // Why it is locked: a bye (decided without play), a cancelled match, or a finished one - each in its own words.
  const lockReason: LockReason = state === "decided" ? "decided" : cancelled ? "cancelled" : "finished";
  // A finished match has no form (X-SR-3); a live one opens it only on "Correct format" (X-SR-5); an unstarted one always.
  const formOpen = state === "unstarted" || (state === "live" && correcting);

  async function put(rules: Record<string, unknown> | null, then: () => void) {
    setSaving(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/rules`, { method: "PUT", json: { rules } });
      then();
      router.refresh();
    } catch (err) {
      // A refusal is said in the reader's language off its code (`FORMAT_DOES_NOT_FIT_PLAY`, `RULE_NOT_SETTABLE`, a lock...).
      setError(rulesWriteErrorText(err, msg));
    } finally {
      setSaving(false);
    }
  }

  const save = () => {
    if (ctx === null) return;
    const fragment = matchFragment(ctx, values, stageValues, stageResolved, override);
    // Nothing differs from the stage's any more: `{}` sets the match back to it, as the server reads it.
    void put(fragment, () => {
      setOverridden(Object.keys(fragment).length > 0);
      setOpened(values);
      setCorrecting(false);
    });
  };
  const reset = () =>
    void put(null, () => {
      setOverridden(false);
      setValues(stageValues);
      setOpened(stageValues);
      setCorrecting(false);
    });
  const cancel = () => {
    setValues(opened);
    setError(null);
    setCorrecting(false);
  };

  return (
    <section
      aria-labelledby={`${formId}-title`}
      data-testid="match-rules-block"
      data-state={state}
      className="card min-w-0 space-y-3 p-4 max-md:p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${formId}-title`} className="text-sm font-semibold text-slate-700">
          {msg("matchRules.title")}
        </h2>
        {overridden && (
          <span
            data-testid="match-rules-overridden"
            className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-800"
          >
            {msg("matchRules.overridden")}
          </span>
        )}
      </div>

      {stageLine !== "" && (
        <p data-testid="match-rules-stage-line" className="min-w-0 text-xs text-slate-600 [overflow-wrap:anywhere]">
          {msg("matchRules.fromStage", { format: stageLine })}
        </p>
      )}

      {/* The format this match plays (or played) whenever it carries its own: the chip alone says THAT it differs, not WHAT it
          plays - in a finished or live-closed match nothing else on the card does (review I2). The page's `override` and its
          `effectiveLine` are one answer (a refresh brings both), so the line follows the page, as the form re-seeds from it. */}
      {override !== null && effectiveLine !== "" && (
        <p data-testid="match-rules-played-as" className="min-w-0 text-xs font-medium text-slate-800 [overflow-wrap:anywhere]">
          {msg("matchRules.playedAs", { format: effectiveLine })}
        </p>
      )}

      {locked && (
        <p data-testid="match-rules-locked" data-reason={lockReason} className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {msg(LOCK_KEY[lockReason])}
        </p>
      )}

      {state === "live" && !correcting && (
        <button type="button" data-testid="match-rules-correct" onClick={() => setCorrecting(true)} className="btn btn-ghost min-h-11 text-sm">
          {msg("matchRules.correctLive")}
        </button>
      )}

      {formOpen && (
        <div className="space-y-3">
          {state === "live" && (
            <p data-testid="match-rules-warning" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
              {msg("matchRules.correctWarning")}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&_input]:min-h-11 [&_select]:min-h-11">
            {fields.map(({ field, held }) => {
              const source = matchSource(field.key, values, stageValues);
              return (
                <div
                  key={field.key}
                  data-testid={`stage-rule-field-${topSegment(field.edits)}`}
                  data-source={source}
                  data-held={held ? "true" : undefined}
                  className={`min-w-0 rounded-lg border border-slate-200 px-3 py-2 ${held ? "bg-slate-50 [&_input]:bg-slate-100" : "bg-white"} ${field.kind === "sequence" ? "sm:col-span-2" : ""}`}
                >
                  <RuleFieldControl
                    sportKey={sportKey}
                    field={field}
                    value={values[field.key] ?? ""}
                    onEdit={(raw) => setValues(setRuleValue(sportKey, values, field.key, raw, stageResolved))}
                    disabled={held || saving}
                    inherited={stageResolved}
                    sequenceInherits={stageResolved}
                  />
                  <span className={`mt-1 block text-[11px] ${source === "match" ? "text-teal-800" : "text-slate-600"}`}>
                    {msg(source === "match" ? "matchRules.source.match" : "matchRules.source.stage")}
                  </span>
                  {held && (
                    <span className="mt-1 block text-[11px] text-slate-600" data-testid={`match-rules-held-${topSegment(field.edits)}`}>
                      {msg("matchRules.heldOff")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {error !== null && (
            <p data-testid="match-rules-error" role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 [overflow-wrap:anywhere]">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-testid="match-rules-save" disabled={!dirty || saving} onClick={save} className="btn btn-primary min-h-11">
              {msg(saving ? "schedule.saving" : "schedule.save")}
            </button>
            {state === "live" && (
              <button type="button" data-testid="match-rules-cancel" disabled={saving} onClick={cancel} className="btn btn-ghost min-h-11">
                {msg("schedule.cancel")}
              </button>
            )}
            {overridden && (
              <button type="button" data-testid="match-rules-reset" disabled={saving} onClick={reset} className="btn btn-ghost min-h-11">
                {msg("matchRules.reset")}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
