"use client";

// TEMP(RS004 variants) — Panel design C: "Segmented sections" (tabs, one
// section visible at a time).
//
// One of three design directions under review for the registration hub's
// row-click config panel (see registration-hub-variant.ts's header for the
// full scaffold explanation and deletion instructions). Reachable via
// ?variant=c; variant A (registration-hub-config-panel.tsx) is the
// untouched control.
//
// Design idea: where panel B (registration-hub-config-panel-b.tsx) keeps
// every section reachable at once and just collapses the heavier two, this
// variant goes further — a small segmented control at the top switches
// between the SAME five zones, and only the active one ever renders its
// fields. At 320px this is the most aggressive scroll reduction of the
// three panel directions: never more than one section's worth of inputs on
// screen. Deliberately NOT built on the repo's existing `.scroll-x` tab-
// strip pattern (the page-level Settings/Registrants tabs use it) — that
// pattern is known to hide its own active tab once tabs overflow a narrow
// viewport (see this file's own history for the incident it's based on:
// apps/directory's fourth-tab overflow), which is exactly the failure mode
// a MODAL's internal navigation can least afford. The five segment labels
// are short enough to flex-wrap onto two lines at 320px instead, so
// there's nothing to scroll and nothing that can end up off-screen.
//
// A failed save switches to whichever tab holds the first error (see the
// effect below and registration-hub-config-panel-sections.ts) — otherwise
// a validation error on an inactive tab would render into the DOM but
// never be seen.
//
// Built on <Modal> (keeps its focus trap) and the SAME exported
// EligibilitySection/OpenCloseSection/CapacitySection/MoneySection variant
// A uses, plus the shared useRegistrationConfigPanelState hook for fetch/
// patch/save.
import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { useMsg } from "@/components/i18n/dict-provider";
import { FormBuilder } from "@/components/registration-hub-form-builder";
import type { Currency } from "@/lib/currency";
import {
  EligibilitySection,
  OpenCloseSection,
  CapacitySection,
  MoneySection,
} from "@/components/registration-hub-config-panel";
import {
  useRegistrationConfigPanelState,
  type RegistrationHubConfigDivisionLike,
} from "@/components/registration-hub-config-panel-variant-state";
import { SECTION_IDS, SECTION_FIELDS, firstErrorSection, type SectionId } from "@/components/registration-hub-config-panel-sections";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

function sectionTitle(id: SectionId, msg: Msg, formFieldCount: number): string {
  switch (id) {
    case "eligibility":
      return msg("reg.hub.config.eligibility");
    case "schedule":
      return msg("reg.settings.openClose");
    case "capacity":
      return msg("reg.settings.capacity");
    case "money":
      return msg("reg.settings.money");
    case "form":
      return `${msg("reg.settings.signupForm")} · ${msg("reg.settings.extraQuestions", { n: formFieldCount })}`;
  }
}

export function RegistrationHubConfigPanelC({
  division,
  orgTz,
  orgSlug,
  currency,
  feePercentPct,
  cardUnsupportedCurrency,
  onClose,
  onSaved,
}: {
  division: RegistrationHubConfigDivisionLike;
  orgTz: string;
  orgSlug: string;
  currency: Currency;
  feePercentPct: number;
  cardUnsupportedCurrency: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const msg = useMsg();
  const { state, readOnly, loadError, busy, errors, formError, saveOutcome, patch, save } =
    useRegistrationConfigPanelState(division, onSaved);
  const [active, setActive] = useState<SectionId>("eligibility");

  // Switch to whichever tab holds the first error after a failed save — a
  // conditional tab (unlike panel B's accordion) doesn't even keep the
  // erroring field IN the visible pane, so there is no "reveal", only a
  // hard switch. Harmless to also fire on a successful save (errors resets
  // to {} first inside save() itself, and firstErrorSection({}) is null).
  useEffect(() => {
    const sectionId = firstErrorSection(errors);
    if (sectionId) setActive(sectionId);
  }, [errors]);

  return (
    <Modal
      title={msg("reg.hub.config.title", { name: division.name })}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" data-action="cancel" className="btn btn-ghost min-h-11" onClick={onClose}>
            {msg("reg.hub.config.cancel")}
          </button>
          {state && (
            <button
              type="button"
              data-action="save"
              disabled={busy}
              className="btn btn-primary min-h-11"
              onClick={save}
            >
              {busy ? msg("reg.hub.config.saving") : msg("reg.hub.config.save")}
            </button>
          )}
        </>
      }
    >
      <div
        data-registration-hub-config-panel
        data-division-id={division.division_id}
        data-save-outcome={saveOutcome ?? undefined}
        className="space-y-3"
      >
        {saveOutcome === "put-failed" && (
          <p
            role="alert"
            data-save-outcome="put-failed"
            className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800"
          >
            {msg("reg.hub.config.partialSavePatchOk")}
          </p>
        )}
        {saveOutcome === "patch-failed" && (
          <p
            role="alert"
            data-save-outcome="patch-failed"
            className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800"
          >
            {msg("reg.hub.config.partialSavePutOk")}
          </p>
        )}
        {formError && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-600">
            {formError}
          </p>
        )}

        {!state && !loadError && <p className="text-sm text-slate-500">{msg("reg.hub.config.loading")}</p>}
        {loadError && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-600">
            {msg("reg.hub.config.loadError")}
          </p>
        )}

        {state && (
          <>
            {/* flex-wrap, never `.scroll-x` — see this file's header for
                why a horizontally-scrolling tab strip is the wrong choice
                inside a modal. */}
            <div role="tablist" className="flex flex-wrap gap-1.5">
              {SECTION_IDS.map((id) => {
                const isActive = active === id;
                const hasError = SECTION_FIELDS[id].some((f) => errors[f]);
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`rhcp-c-tab-${id}`}
                    aria-selected={isActive}
                    aria-controls={`rhcp-c-panel-${id}`}
                    data-config-tab={id}
                    onClick={() => setActive(id)}
                    className={`btn min-h-9 gap-1.5 text-xs ${isActive ? "btn-primary" : "btn-ghost"}`}
                  >
                    {sectionTitle(id, msg, state.form_fields.length)}
                    {hasError && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-red-500" />}
                  </button>
                );
              })}
            </div>

            <div
              role="tabpanel"
              id={`rhcp-c-panel-${active}`}
              aria-labelledby={`rhcp-c-tab-${active}`}
              data-config-panel-section={active}
              className="card space-y-3 p-4"
            >
              {active === "eligibility" ? (
                <EligibilitySection state={state} errors={errors} patch={patch} msg={msg} />
              ) : active === "schedule" ? (
                <OpenCloseSection state={state} errors={errors} patch={patch} msg={msg} orgTz={orgTz} />
              ) : active === "capacity" ? (
                <CapacitySection state={state} errors={errors} patch={patch} msg={msg} />
              ) : active === "money" ? (
                <MoneySection
                  state={state}
                  errors={errors}
                  patch={patch}
                  msg={msg}
                  orgTz={orgTz}
                  orgSlug={orgSlug}
                  currency={currency}
                  feePercentPct={feePercentPct}
                  cardUnsupportedCurrency={cardUnsupportedCurrency}
                  chargesEnabled={readOnly!.chargesEnabled}
                  orgPaymentInstructions={readOnly!.orgPaymentInstructions}
                />
              ) : (
                <FormBuilder fields={state.form_fields} canEdit onChange={(form_fields) => patch({ form_fields })} />
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
