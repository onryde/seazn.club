"use client";

// FMT5 (owner-approved mock "Format on the Division rules card", 2026-11-03): the division's format — its stage structure,
// League / Groups + Knockout / Swiss … — is chosen from the Fixtures tab's Division rules card, beside Match rules, Points
// and Tie-breaks. It replaces Settings › Format.
//
//   - The Format button opens the C9 builder's own picker (`formatPickerFields`, components/v2/format-picker.tsx), its
//     estimates worked out for the division's real entrants and courts.
//   - Save asks the server what the change would clear (`PUT …/stages?dry_run=1`). Nothing generated: the stages are
//     replaced at once. Fixtures but no result: one confirm names what goes (N stages by name, M unplayed fixtures, K time
//     slots on C courts, and the setup that rides on them), then ONE call clears and rebuilds (`?clear=<token>`); a board
//     that moved under the open confirm answers FORMAT_CHANGE_STALE with the fresh counts, shown in place.
//   - Once a result exists the button is greyed (`aria-disabled`, so it stays in the tab order) and says why from the
//     control itself (WithReasonTip): "Format is locked once scoring starts." The page asks the server's own predicate
//     (`divisionFormatLocked`), the one `replaceStages` refuses on.
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/modal";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useLocale, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { WithReasonTip } from "@/components/v2/desk/reason-tip";
import { formatPickerFields, useFormatKnobs } from "@/components/v2/format-picker";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import {
  formatBoundIssue,
  formatChoiceFromStages,
  formatKnobsShown,
  formatPickerView,
  formatStagesFor,
  type SavedStage,
} from "@/lib/division-builder/format-choice";
import { OPENING_PLAN, openingTemplate } from "@/lib/division-builder/model";
import { FORMAT_CHANGE_REFUSALS, previewOf, type FormatChangePreview } from "@/lib/format-change";
import { formatChangeRefusalText } from "@/lib/format-change-copy";
import { detectTemplate } from "@/lib/format-templates";
import type { MessageKey } from "@/lib/messages";
import { swissRoundsDefault } from "@/lib/swiss-rounds";
import { venueNoun } from "@/lib/venue";
import type { ViewerPlan } from "@/lib/viewer-plan";

export interface DivisionFormatStage extends SavedStage {
  name: string;
}

export interface DivisionFormatProps {
  divisionId: string;
  sportKey: string;
  /** The division's stages as stored, in board order: the chip's name and the picker's opening knobs. */
  stages: DivisionFormatStage[];
  /** The template keys the division is offered (`templatesForSport` over its entrant kinds, less what they cannot play). */
  offer: readonly string[];
  /** The kinds the division takes: the opening format skips one they cannot play. */
  entrantKinds: readonly string[];
  /** Template key → the plan feature it needs and the organisation lacks (the stage writers' own gates). */
  templateLocks: Readonly<Record<string, string>>;
  /** `standings.carry_over`. */
  carryAllowed: boolean;
  viewerPlan: ViewerPlan;
  /** The division's active entrants: the estimates and the Swiss rounds guidance count them. */
  entrants: number;
  /** Courts (tables, boards, pitches) played on at once: the schedule's, else the organisation's. */
  places: number;
  matchMinutes: number;
  /** A result exists (`divisionFormatLocked`): the button is greyed with its reason. */
  locked: boolean;
  canEdit: boolean;
  /** Open on first render: the old Settings › Format link lands here (`?tab=fixtures&format=open`). */
  initialOpen?: boolean;
}

type Msg = ReturnType<typeof useMsg>;

const templateLabel = (key: string, msg: Msg) => msg(`format.template.${key}.label` as MessageKey);

/** The card's chip: the current format's name, "Custom format" for a graph no template builds, "No format yet" for none. */
export function formatChipText(stages: readonly DivisionFormatStage[], msg: Msg): string {
  if (stages.length === 0) return msg("formatChange.chip.none");
  const key = detectTemplate(stages.map((st) => ({ ...st, config: st.config ?? null })));
  return key === null ? msg("formatChange.chip.custom") : templateLabel(key, msg);
}

function LockGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
    </svg>
  );
}

/** The Format button: first on the card and the purple one, the card's biggest decision (mock, decision 3). */
export function DivisionFormatButton(props: DivisionFormatProps) {
  const msg = useMsg();
  const tipId = useId();
  const { locked, canEdit, initialOpen = false } = props;
  const [open, setOpen] = useState(initialOpen && canEdit && !locked);
  if (!canEdit) return null;
  const base =
    "inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600";
  if (locked) {
    return (
      <WithReasonTip id={tipId} reason={msg(FORMAT_CHANGE_REFUSALS.FORMAT_LOCKED.key)} reasonTestId="division-rules-format-reason">
        <button
          type="button"
          aria-disabled="true"
          aria-describedby={tipId}
          data-testid="division-rules-format"
          className={`${base} cursor-help border-slate-200 bg-slate-50 text-slate-500`}
        >
          <LockGlyph />
          {msg("formatChange.button")}
        </button>
      </WithReasonTip>
    );
  }
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        data-testid="division-rules-format"
        onClick={() => setOpen(true)}
        className={`${base} border-purple-600 bg-purple-600 text-white hover:border-purple-700 hover:bg-purple-700`}
      >
        {msg("formatChange.button")}
      </button>
      {open && <DivisionFormatDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The dialog: the picker, then — only when fixtures exist — the confirm naming what the change clears. */
export function DivisionFormatDialog({
  divisionId,
  sportKey,
  stages,
  offer,
  entrantKinds,
  templateLocks,
  carryAllowed,
  viewerPlan,
  entrants,
  places,
  matchMinutes,
  onClose,
}: DivisionFormatProps & { onClose: () => void }) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const locale = useLocale();
  const router = useRouter();

  // The picker opens on the division's own format and knobs as stored; a custom graph (or one the division is no longer
  // offered) opens on the builder's opening format instead, as a new division would.
  const [stored] = useState(() => formatChoiceFromStages(stages));
  const current = stored.template !== null && offer.includes(stored.template) ? stored.template : null;
  const knobs = useFormatKnobs({ ...stored, template: current });
  const template = knobs.templatePicked ?? openingTemplate(offer, matchMinutes, entrantKinds, Object.keys(templateLocks));
  // The plan the estimates are worked out for: the division's own entrants and courts. Before anyone has entered, the
  // builder's opening field stands in, and the lead says so.
  const counted = entrants >= 2;
  const plan = {
    entrants: counted ? entrants : OPENING_PLAN.entrants,
    venues: Math.max(1, places),
    hours: OPENING_PLAN.hours,
    matchMinutes: matchMinutes >= 1 ? matchMinutes : 30,
  };
  const swissRounds = knobs.swissRoundsPicked ?? swissRoundsDefault(plan.entrants);
  const shown = formatKnobsShown(template);
  const values = { qualified: knobs.qualified, swissRounds, poolCount: knobs.poolCount, legs: knobs.legs, standingsCarry: knobs.standingsCarry, thirdPlace: knobs.thirdPlace };
  const drafts = formatStagesFor(template, values, counted ? entrants : 0);
  const view = formatPickerView({ offer, plan, template, stages: drafts, showAll: knobs.showAll, templateLocks, carryAllowed, standingsCarry: knobs.standingsCarry });
  const venue = venueNoun(sportKey);
  const placesText = (n: number) => msgPlural(`divBuilder.places.${venue}`, n, { count: n });

  const [step, setStep] = useState<"pick" | "confirm">("pick");
  const [preview, setPreview] = useState<FormatChangePreview | null>(null);
  // The body the confirm sends: the one its preview was asked for, never a picker that moved behind it.
  const [sent, setSent] = useState<{ body: unknown[]; template: string } | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  // The three PUTs spell their path out in full (no shared `url`): components/__tests__/api-v1-call-paths.test.ts reads each
  // apiV1 target as a literal and checks it is an absolute /api path.

  function refused(err: unknown) {
    if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setPaywall(String(err.extra.feature_key ?? ""));
    else setError(formatChangeRefusalText(err, msg, msg("divset.failed")));
    // Fix round 1 (review m6b): a first result landed while the dialog was open. The page re-reads the lock, so the
    // Format button behind the dialog greys with its reason instead of staying live until a reload.
    if (err instanceof ApiV1Error && err.code === "FORMAT_LOCKED") router.refresh();
  }

  /** A CONFIRM or STALE refusal's own preview, if it carries one: the board the change would clear now. */
  function freshPreview(err: unknown): FormatChangePreview | null {
    return err instanceof ApiV1Error && (err.code === "FORMAT_CHANGE_STALE" || err.code === "FORMAT_CHANGE_CONFIRM") ? previewOf(err.extra) : null;
  }

  function finish() {
    onClose();
    router.refresh();
  }

  async function save() {
    setError(null);
    setPaywall(null);
    const issue = formatBoundIssue(template, values);
    if (issue !== null) {
      setError(msg("wizard.err.formatBound", { field: msg(issue.label), min: issue.min, max: issue.max }));
      return;
    }
    const body = drafts.map((d, i) => ({ ...d, seq: i + 1 }));
    setBusy(true);
    let asked: FormatChangePreview | null = null;
    try {
      asked = await apiV1<FormatChangePreview>(`/api/v1/divisions/${divisionId}/stages?dry_run=1`, { method: "PUT", json: body });
      if (asked.token === null) {
        // Nothing generated: nothing to clear, so nothing to confirm.
        await apiV1(`/api/v1/divisions/${divisionId}/stages`, { method: "PUT", json: body });
        finish();
        return;
      }
      setPreview(asked);
      setSent({ body, template });
      setStale(false);
      setStep("confirm");
    } catch (err) {
      // Fix round 1 (review m6a): fixtures appeared between the dry run (nothing to clear) and the direct save. The
      // refusal carries the board as it is now, so the confirm opens on it - flagged as changed - rather than an error
      // that asks for a confirm step the dialog never showed.
      const fresh = asked !== null ? freshPreview(err) : null;
      if (fresh !== null) {
        setPreview(fresh);
        setSent({ body, template });
        setStale(true);
        setStep("confirm");
      } else {
        refused(err);
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (preview === null || sent === null) return;
    setError(null);
    setPaywall(null);
    setBusy(true);
    try {
      const clear = preview.token === null ? "" : `?clear=${encodeURIComponent(preview.token)}`;
      await apiV1(`/api/v1/divisions/${divisionId}/stages${clear}`, { method: "PUT", json: sent.body });
      finish();
    } catch (err) {
      // The board moved under the open confirm: the refusal carries the fresh counts, shown here for a second look.
      const fresh = freshPreview(err);
      if (fresh !== null) {
        setPreview(fresh);
        setStale(true);
      } else {
        refused(err);
      }
    } finally {
      setBusy(false);
    }
  }

  const feedback = (
    <>
      {paywall !== null && <UpgradeGate feature={paywall} compact viewerPlan={viewerPlan} />}
      {error !== null && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="division-format-error">
          {error}
        </p>
      )}
    </>
  );

  if (step === "confirm" && preview !== null && sent !== null) {
    const cleared: { key: string; text: string }[] = [
      {
        key: "stages",
        text: msgPlural("formatChange.confirm.stages", preview.stages.length, {
          count: preview.stages.length,
          names: preview.stages.map((s) => s.name).join(", "),
        }),
      },
    ];
    // A board emptied under the open confirm (someone else's change, review m2) has no fixture line: "0 unplayed fixtures"
    // would name nothing.
    if (preview.fixtures > 0) {
      cleared.push({ key: "fixtures", text: msgPlural("formatChange.confirm.fixtures", preview.fixtures, { count: preview.fixtures }) });
    }
    if (preview.slots > 0) {
      cleared.push({
        key: "slots",
        text:
          preview.courts > 0
            ? msgPlural("formatChange.confirm.slots", preview.slots, { count: preview.slots, places: placesText(preview.courts) })
            : msgPlural("formatChange.confirm.slotsNoCourt", preview.slots, { count: preview.slots }),
      });
    }
    if (preview.officials > 0) cleared.push({ key: "officials", text: msg("progression.rosterDrift.alsoOfficials", { count: preview.officials }) });
    if (preview.lineups > 0) cleared.push({ key: "lineups", text: msg("progression.rosterDrift.alsoLineups", { count: preview.lineups }) });
    // Controller ruling I1: a live remote-scoring link is not refused; the confirm names how many stop working (the
    // server counts the live ones only, so a revoked or expired link never shows a line).
    if (preview.device_links > 0) {
      cleared.push({ key: "remoteLinks", text: msgPlural("formatChange.confirm.remoteLinks", preview.device_links, { count: preview.device_links }) });
    }
    if (preview.calls > 0) cleared.push({ key: "calls", text: msgPlural("formatChange.confirm.calls", preview.calls, { count: preview.calls }) });
    return (
      <Modal
        size="lg"
        title={msg("formatChange.confirm.title", { format: templateLabel(sent.template, msg) })}
        onClose={onClose}
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
            <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost min-h-11" data-testid="division-format-keep">
              {msg("formatChange.confirm.keep", { format: formatChipText(stages, msg) })}
            </button>
            <button type="button" onClick={() => void confirm()} disabled={busy} className="btn btn-danger min-h-11" data-testid="division-format-clear">
              {busy ? "…" : msg("formatChange.confirm.clear")}
            </button>
          </div>
        }
      >
        <div className="space-y-3" data-testid="division-format-confirm">
          {stale && (
            <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="division-format-stale">
              {msg(FORMAT_CHANGE_REFUSALS.FORMAT_CHANGE_STALE.key)}
            </p>
          )}
          {/* Re-review r1-m1: a board whose only scores were all voided is unlocked (ruling I2), but the clear deletes those
              voided entries - so the lead names them instead of saying nothing has been played. */}
          <p className="text-slate-800" data-testid="division-format-safe">
            {preview.voided_scores > 0
              ? msgPlural("formatChange.confirm.safeVoided", preview.voided_scores, { count: preview.voided_scores })
              : msg("formatChange.confirm.safe")}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-slate-800" data-testid="division-format-clears">
            {cleared.map((c) => (
              <li key={c.key} data-clear={c.key} className="min-w-0 [overflow-wrap:anywhere]">
                {c.text}
              </li>
            ))}
          </ul>
          <p className="text-slate-600">{msg("formatChange.confirm.stay")}</p>
          {preview.device_links > 0 && <p className="text-slate-600">{msg("formatChange.confirm.sheetsStop")}</p>}
          {feedback}
        </div>
      </Modal>
    );
  }

  const blocked = view.templateLock !== undefined || view.carryLocked;
  return (
    <Modal
      size="lg"
      title={msg("formatChange.button")}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="btn btn-ghost min-h-11" data-testid="division-format-cancel">
            {msg("wizard.cancel")}
          </button>
          <button type="button" onClick={() => void save()} disabled={busy || blocked} className="btn btn-primary min-h-11 disabled:opacity-50" data-testid="division-format-save">
            {busy ? "…" : msg("formatChange.save")}
          </button>
        </>
      }
    >
      <div className="space-y-4" data-testid="division-format-dialog">
        <p className="text-slate-700" data-testid="division-format-lead">
          {counted
            ? msgPlural("formatChange.lead", entrants, { count: entrants, places: placesText(plan.venues) })
            : msg("formatChange.lead.noEntrants", { count: plan.entrants, places: placesText(plan.venues) })}
        </p>
        {stages.length > 0 && stored.template === null && <p className="text-xs text-amber-800">{msg("formatChange.customNote")}</p>}
        {formatPickerFields({
          msg,
          msgPlural,
          locale,
          template,
          knobs,
          swissRounds,
          shown,
          view,
          stages: drafts,
          guidanceEntrants: plan.entrants,
          thirdPlaceEntrants: counted ? entrants : 0,
          templateLocks,
          viewerPlan,
        })}
        {feedback}
      </div>
    </Modal>
  );
}
