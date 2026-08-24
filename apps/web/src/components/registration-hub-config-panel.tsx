"use client";

// Registration hub — the row-click config panel (RS004 W3c/W4, design §5,
// "grouped sections, progressive disclosure" treatment). Fetches the
// division's full registration settings on open, edits every
// registration_settings field plus the division-level eligibility fields
// (category/age_min/age_max), and saves through both endpoints:
//
//   PATCH /api/v1/divisions/{id}                       category/age_min/age_max
//   PUT   /api/v1/divisions/{id}/registration-settings  everything else (FULL REPLACE)
//
// Built on <Modal> (components/modal.tsx) rather than a bespoke overlay —
// that component already carries the 320px-safe chrome this repo has been
// bitten by before (dvh not vh, bottom sheet under `sm`, safe-area padding,
// Esc-to-close, focus). State shaping (GET response -> edit state -> the
// two save payloads) lives in registration-hub-config-state.ts, error
// mapping in registration-hub-save-error.ts, and the fetch/patch/save
// plumbing in the useRegistrationConfigPanelState hook
// (registration-hub-config-panel-state.ts) — all pure/independently tested;
// this file is the wiring + presentation layer over them.
//
// The five zones below (Eligibility, Open & close, Capacity, Money,
// Sign-up form) are grouped into collapsible sections rather than one long
// scrolling form. Eligibility/Open & close/Capacity default OPEN (short,
// core fields most edits touch); Money and the sign-up form default
// COLLAPSED (heavier, less-frequently-touched sub-UIs). At 320px this is
// the whole point: a long modal form is punishing on a phone, and
// collapsing two of five sections meaningfully shortens the scroll without
// hiding anything permanently.
//
// A collapsed section that hides a validation error would be worse than a
// flat form, not better — so a 422 landing on a field inside a collapsed
// section auto-reveals that section once (see the effect below and
// registration-hub-config-panel-sections.ts).
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ReactEventHandler, ReactNode } from "react";
import { Modal } from "@/components/modal";
import Link from "@/components/ui/console-link";
import { useMsg } from "@/components/i18n/dict-provider";
import { routes } from "@/lib/routes";
import type { Currency } from "@/lib/currency";
import type { MessageKey } from "@/lib/messages";
import { FormBuilder } from "@/components/registration-hub-form-builder";
import type { DivisionCategoryValue } from "@/components/registration-hub-row-derive";
import type { RegistrationConfigState } from "@/components/registration-hub-config-state";
import type { ConfigFieldKey } from "@/components/registration-hub-save-error";
import {
  useRegistrationConfigPanelState,
  type RegistrationHubConfigDivisionLike,
} from "@/components/registration-hub-config-panel-state";
import {
  SECTION_IDS,
  SECTION_FIELDS,
  firstErrorSection,
  type SectionId,
} from "@/components/registration-hub-config-panel-sections";
import { instantToOrgTzInputValue, orgTzInputValueToInstant } from "@/components/registration-hub-tz-input";
import { fmtZoneAbbrev } from "@/lib/format";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

const DEFAULT_OPEN: Record<SectionId, boolean> = {
  eligibility: true,
  schedule: true,
  capacity: true,
  money: false,
  form: false,
};

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

// Exported (not a private closure) for the same reason the section
// components below are: _hook-harness.tsx's walk() never INVOKES a child
// component — it only reads the static `.props.children` already authored
// on it — so a test rendering this panel needs to call Disclosure(props)
// directly to see what it actually renders. Safe here because Disclosure
// holds no hooks of its own.
export function Disclosure({
  id,
  title,
  open,
  hasError,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  hasError: boolean;
  // The real DOM event type, not a hand-rolled `{ currentTarget: { open } }`
  // shape. That invented type is what let a real crash through tsc once: it
  // described `currentTarget` as always carrying an `open` boolean, so
  // reading it was a type error nowhere — while the native `toggle` event
  // fired during commit hands the handler a null `currentTarget`.
  onToggle: ReactEventHandler<HTMLDetailsElement>;
  children: ReactNode;
}) {
  return (
    <details
      data-accordion-section={id}
      className="card group overflow-hidden p-0"
      open={open}
      onToggle={onToggle}
    >
      {/* list-none + both marker rules: <summary> carries a native
          disclosure triangle via TWO different mechanisms depending on
          engine (::marker in modern engines, ::-webkit-details-marker in
          WebKit/Blink) — hiding only one leaves the native triangle
          showing alongside the custom chevron below. */}
      <summary className="marker:content-none flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-semibold text-slate-700 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          {title}
          {hasError && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />}
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
          strokeWidth={1.75}
          aria-hidden
        />
      </summary>
      <div className="space-y-3 border-t border-purple-100 p-4">{children}</div>
    </details>
  );
}

export function RegistrationHubConfigPanel({
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
  /** organizations.timezone (or DEFAULT_TZ) — windows are edited in this
   *  zone, never browser-local (owner decision 1). */
  orgTz: string;
  orgSlug: string;
  /** Org's registration currency (RS001b) — read-only chip, no input. */
  currency: Currency;
  /** registration.fee_percent entitlement, resolved server-side. */
  feePercentPct: number;
  /** Non-null when the org's connected Stripe account settles outside the
   *  registration currency allowlist — card collection is not viable. */
  cardUnsupportedCurrency: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const msg = useMsg();
  const { state, readOnly, loadError, busy, errors, formError, saveOutcome, patch, save } =
    useRegistrationConfigPanelState(division, onSaved);
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>(DEFAULT_OPEN);

  // Reveal (once) whichever section holds the first error after a failed
  // save. A plain state write on a state CHANGE, not a derived
  // `open={openSections[id] || hasError}` expression: <details> is not a
  // form control React re-asserts a controlled value against on every
  // render (unlike <input checked>), so a derived expression would stop
  // forcing the section open the instant it renders the SAME computed
  // value twice in a row — which happens the moment the organiser toggles
  // the section by hand while the error is still live. Folding the reveal
  // into stored state once, here, sidesteps that: it survives exactly
  // until the organiser deliberately closes the section again (which they
  // can, having seen the error), matching how every other disclosure here
  // behaves.
  useEffect(() => {
    const sectionId = firstErrorSection(errors);
    if (!sectionId) return;
    setOpenSections((prev) => (prev[sectionId] ? prev : { ...prev, [sectionId]: true }));
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
            {SECTION_IDS.map((id) => {
              const hasError = SECTION_FIELDS[id].some((f) => errors[f]);
              const content =
                id === "eligibility" ? (
                  <EligibilitySection state={state} errors={errors} patch={patch} msg={msg} />
                ) : id === "schedule" ? (
                  <OpenCloseSection state={state} errors={errors} patch={patch} msg={msg} orgTz={orgTz} />
                ) : id === "capacity" ? (
                  <CapacitySection state={state} errors={errors} patch={patch} msg={msg} />
                ) : id === "money" ? (
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
                );
              return (
                <Disclosure
                  key={id}
                  id={id}
                  title={sectionTitle(id, msg, state.form_fields.length)}
                  open={openSections[id]}
                  hasError={hasError}
                  // Reads `e.target`, NOT `e.currentTarget`. <details> fires a
                  // native `toggle` event, and the three sections that mount
                  // with open={true} fire it synchronously while React is
                  // still committing — `currentTarget` is only bound for the
                  // duration of the dispatch, so by the time this handler ran
                  // it was null and every first Configure click crashed the
                  // page with "Cannot read properties of null (reading
                  // 'open')". `target` is the <details> element itself here
                  // and stays valid.
                  onToggle={(e) =>
                    setOpenSections((prev) => ({
                      ...prev,
                      [id]: (e.target as HTMLDetailsElement).open,
                    }))
                  }
                >
                  {content}
                </Disclosure>
              );
            })}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export function EligibilitySection({
  state,
  errors,
  patch,
  msg,
}: {
  state: RegistrationConfigState;
  errors: Partial<Record<ConfigFieldKey, string>>;
  patch: (p: Partial<RegistrationConfigState>) => void;
  msg: Msg;
}) {
  const isTeam = state.entrant_kind === "team";
  return (
    <section className="card space-y-3 p-4">
      <h3 className="text-sm font-semibold text-slate-700">{msg("reg.hub.config.eligibility")}</h3>
      <label className="label">
        {msg("reg.hub.config.category")}
        <select
          data-field="category"
          className="input min-h-11 mt-1"
          value={state.category ?? "open"}
          onChange={(e) =>
            patch({ category: e.target.value === "open" ? null : (e.target.value as DivisionCategoryValue) })
          }
        >
          <option value="open">{msg("reg.hub.row.category.open")}</option>
          <option value="mens">{msg("reg.hub.row.category.mens")}</option>
          <option value="womens">{msg("reg.hub.row.category.womens")}</option>
          <option value="mixed">{msg("reg.hub.row.category.mixed")}</option>
        </select>
        {errors.category && (<p data-field-error="category" role="alert" className="mt-1 text-xs text-red-600">{errors.category}</p>)}
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="label">
          {msg("reg.hub.config.ageMin")}
          <input
            type="number"
            min={0}
            max={120}
            data-field="age_min"
            className="input mt-1"
            value={state.age_min ?? ""}
            onChange={(e) => patch({ age_min: e.target.value === "" ? null : Number(e.target.value) })}
          />
          {errors.age_min && (<p data-field-error="age_min" role="alert" className="mt-1 text-xs text-red-600">{errors.age_min}</p>)}
        </label>
        <label className="label">
          {msg("reg.hub.config.ageMax")}
          <input
            type="number"
            min={0}
            max={120}
            data-field="age_max"
            className="input mt-1"
            value={state.age_max ?? ""}
            onChange={(e) => patch({ age_max: e.target.value === "" ? null : Number(e.target.value) })}
          />
          {errors.age_max && (<p data-field-error="age_max" role="alert" className="mt-1 text-xs text-red-600">{errors.age_max}</p>)}
        </label>
      </div>
      <label className="label">
        {msg("reg.hub.config.approval")}
        <select
          data-field="approval"
          className="input min-h-11 mt-1"
          value={state.approval}
          onChange={(e) => patch({ approval: e.target.value as RegistrationConfigState["approval"] })}
        >
          <option value="auto">{msg("reg.hub.row.approval.auto")}</option>
          <option value="manual">{msg("reg.hub.row.approval.manual")}</option>
        </select>
        {errors.approval && (<p data-field-error="approval" role="alert" className="mt-1 text-xs text-red-600">{errors.approval}</p>)}
      </label>
      {isTeam ? (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            data-field="allow_free_agents"
            checked={state.allow_free_agents}
            onChange={(e) => patch({ allow_free_agents: e.target.checked })}
          />
          {msg("reg.hub.row.freeAgents")}
        </label>
      ) : (
        <p className="text-xs text-slate-400">{msg("reg.hub.config.freeAgentsHint")}</p>
      )}
      {errors.allow_free_agents && (<p data-field-error="allow_free_agents" role="alert" className="mt-1 text-xs text-red-600">{errors.allow_free_agents}</p>)}
    </section>
  );
}

export function OpenCloseSection({
  state,
  errors,
  patch,
  msg,
  orgTz,
}: {
  state: RegistrationConfigState;
  errors: Partial<Record<ConfigFieldKey, string>>;
  patch: (p: Partial<RegistrationConfigState>) => void;
  msg: Msg;
  orgTz: string;
}) {
  // A short, DST-correct abbreviation ("BST", "IST") rather than the raw
  // IANA string — matches the zone labelling the row already shows
  // (registration-hub-row-derive.ts's formatRegistrationWindow).
  const zone = fmtZoneAbbrev(orgTz, new Date());
  return (
    <section className="card space-y-3 p-4">
      <h3 className="text-sm font-semibold text-slate-700">{msg("reg.settings.openClose")}</h3>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          data-field="enabled"
          checked={state.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        {msg("reg.settings.openForPublic")}
      </label>
      <label className="label">
        {msg("reg.settings.entrantType")}
        <select
          data-field="entrant_kind"
          className="input min-h-11 mt-1"
          value={state.entrant_kind}
          onChange={(e) => {
            const v = e.target.value as RegistrationConfigState["entrant_kind"];
            // Team-only setting (server 422s otherwise) — clear it locally
            // the moment the division stops being a team division, so the
            // organiser never hits a preventable error.
            patch({ entrant_kind: v, allow_free_agents: v === "team" ? state.allow_free_agents : false });
          }}
        >
          <option value="individual">{msg("reg.settings.entrant.individual")}</option>
          <option value="team">{msg("reg.settings.entrant.team")}</option>
          <option value="pair">{msg("reg.settings.entrant.pair")}</option>
        </select>
      </label>
      <div className="grid grid-cols-1 gap-3">
        <label className="label">
          {msg("reg.settings.opens")} ({zone})
          <input
            type="datetime-local"
            data-field="opens_at"
            className="input mt-1"
            value={instantToOrgTzInputValue(state.opens_at, orgTz)}
            onChange={(e) => patch({ opens_at: orgTzInputValueToInstant(e.target.value, orgTz) })}
          />
        </label>
        <label className="label">
          {msg("reg.settings.closes")} ({zone})
          <input
            type="datetime-local"
            data-field="closes_at"
            className="input mt-1"
            value={instantToOrgTzInputValue(state.closes_at, orgTz)}
            onChange={(e) => patch({ closes_at: orgTzInputValueToInstant(e.target.value, orgTz) })}
          />
          {errors.closes_at && (<p data-field-error="closes_at" role="alert" className="mt-1 text-xs text-red-600">{errors.closes_at}</p>)}
        </label>
      </div>
    </section>
  );
}

export function CapacitySection({
  state,
  errors,
  patch,
  msg,
}: {
  state: RegistrationConfigState;
  errors: Partial<Record<ConfigFieldKey, string>>;
  patch: (p: Partial<RegistrationConfigState>) => void;
  msg: Msg;
}) {
  return (
    <section className="card space-y-3 p-4">
      <h3 className="text-sm font-semibold text-slate-700">{msg("reg.settings.capacity")}</h3>
      <label className="label">
        {msg("reg.settings.capacityHint")}
        <input
          type="number"
          min={1}
          data-field="capacity"
          className="input mt-1"
          value={state.capacity ?? ""}
          onChange={(e) => patch({ capacity: e.target.value === "" ? null : Number(e.target.value) })}
        />
        {errors.capacity && (<p data-field-error="capacity" role="alert" className="mt-1 text-xs text-red-600">{errors.capacity}</p>)}
      </label>
    </section>
  );
}

export function MoneySection({
  state,
  errors,
  patch,
  msg,
  orgTz,
  orgSlug,
  currency,
  feePercentPct,
  cardUnsupportedCurrency,
  chargesEnabled,
  orgPaymentInstructions,
}: {
  state: RegistrationConfigState;
  errors: Partial<Record<ConfigFieldKey, string>>;
  patch: (p: Partial<RegistrationConfigState>) => void;
  msg: Msg;
  orgTz: string;
  orgSlug: string;
  currency: Currency;
  feePercentPct: number;
  cardUnsupportedCurrency: string | null;
  chargesEnabled: boolean;
  orgPaymentInstructions: string | null;
}) {
  const currencyCode = currency.toUpperCase();
  const cardUnavailable = !chargesEnabled || cardUnsupportedCurrency !== null;
  const paidConfigured = state.fee_cents > 0;
  const zone = fmtZoneAbbrev(orgTz, new Date());

  return (
    <section className="card space-y-3 p-4" data-feature="registration.paid">
      <h3 className="text-sm font-semibold text-slate-700">{msg("reg.settings.money")}</h3>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-purple-100 bg-purple-50/60 px-3 py-2 text-xs text-purple-800">
        <span>{msg("reg.hub.config.currencyNote", { currency: currencyCode })}</span>
        <Link href={routes.orgSettings(orgSlug, "preferences")} className="font-medium underline underline-offset-2">
          {msg("reg.hub.config.manageCurrency")}
        </Link>
      </div>

      <label className="label">
        {msg("reg.settings.entryFee", { sym: currencyCode })}
        <input
          type="number"
          min={0}
          step="0.01"
          data-field="fee_cents"
          className="input mt-1"
          value={state.fee_cents / 100}
          onChange={(e) =>
            patch({ fee_cents: e.target.value === "" ? 0 : Math.round(Number(e.target.value) * 100) })
          }
        />
        {errors.fee_cents && (<p data-field-error="fee_cents" role="alert" className="mt-1 text-xs text-red-600">{errors.fee_cents}</p>)}
      </label>
      <p className="text-xs text-slate-500">
        {msg("reg.hub.config.feeCut", { keep: 100 - feePercentPct, pct: feePercentPct })}
      </p>

      <fieldset className="space-y-2">
        <legend className="text-xs text-slate-500">{msg("reg.settings.howCollected")}</legend>
        <label className="flex items-start gap-2.5 rounded-md border border-slate-200 bg-white p-3 text-xs">
          <input
            type="radio"
            name="payment_method"
            value="offline"
            data-field="payment_method_offline"
            className="mt-0.5"
            checked={state.payment_method === "offline"}
            onChange={() => patch({ payment_method: "offline" })}
          />
          <span>
            <span className="block font-medium text-slate-800">{msg("reg.settings.payOrganiser")}</span>
            <span className="mt-0.5 block text-slate-500">{msg("reg.settings.payOrganiserDesc")}</span>
          </span>
        </label>
        <label
          className={`flex items-start gap-2.5 rounded-md border border-slate-200 bg-white p-3 text-xs ${cardUnavailable ? "opacity-60" : ""}`}
        >
          <input
            type="radio"
            name="payment_method"
            value="stripe"
            data-field="payment_method_stripe"
            className="mt-0.5"
            disabled={cardUnavailable}
            checked={state.payment_method === "stripe"}
            onChange={() => patch({ payment_method: "stripe" })}
          />
          <span>
            <span className="font-medium text-slate-800">{msg("reg.settings.cardPayment")}</span>
            <span className="mt-0.5 block text-slate-500">{msg("reg.settings.cardPaymentDesc")}</span>
            {cardUnsupportedCurrency ? (
              <span className="mt-1 block font-medium text-amber-700">
                {msg("reg.hub.config.cardUnsupported", { currency: cardUnsupportedCurrency.toUpperCase() })}
              </span>
            ) : (
              !chargesEnabled && (
                <Link href={routes.connect(orgSlug)} className="mt-1 block font-medium text-purple-700 underline">
                  {msg("reg.settings.connectStripeFirst")}
                </Link>
              )
            )}
          </span>
        </label>
        {errors.payment_method && (<p data-field-error="payment_method" role="alert" className="mt-1 text-xs text-red-600">{errors.payment_method}</p>)}
      </fieldset>

      {state.payment_method === "offline" && (
        <label className="label">
          {msg("reg.settings.payInstructions")}
          <textarea
            data-field="payment_instructions"
            rows={3}
            maxLength={5000}
            className="input mt-1 font-mono text-xs"
            value={state.payment_instructions ?? ""}
            onChange={(e) => patch({ payment_instructions: e.target.value || null })}
            placeholder={
              orgPaymentInstructions
                ? msg("reg.settings.payInstructionsPlaceholderOrg")
                : msg("reg.settings.payInstructionsPlaceholder")
            }
          />
          {errors.payment_instructions && (<p data-field-error="payment_instructions" role="alert" className="mt-1 text-xs text-red-600">{errors.payment_instructions}</p>)}
        </label>
      )}

      {paidConfigured && (
        <label className="label">
          {msg("reg.settings.refundLock")} ({zone})
          <input
            type="datetime-local"
            data-field="refund_lock_at"
            className="input mt-1"
            value={instantToOrgTzInputValue(state.refund_lock_at, orgTz)}
            onChange={(e) => patch({ refund_lock_at: orgTzInputValueToInstant(e.target.value, orgTz) })}
          />
          {errors.refund_lock_at && (<p data-field-error="refund_lock_at" role="alert" className="mt-1 text-xs text-red-600">{errors.refund_lock_at}</p>)}
        </label>
      )}
    </section>
  );
}
