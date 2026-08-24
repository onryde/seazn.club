"use client";

// Registration hub — the row-click config panel (RS004 W3c, design §5).
// Fetches the division's full registration settings on open, edits every
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
// two save payloads) lives in registration-hub-config-state.ts, and error
// mapping in registration-hub-save-error.ts — both pure and independently
// tested; this file is the wiring + presentation layer over them.
import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import Link from "@/components/ui/console-link";
import { useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import { routes } from "@/lib/routes";
import type { Currency } from "@/lib/currency";
import type { MessageKey } from "@/lib/messages";
import { FormBuilder } from "@/components/registration-hub-form-builder";
import type { DivisionCategoryValue } from "@/components/registration-hub-row-derive";
import {
  initialConfigState,
  toDivisionPatchBody,
  toRegistrationSettingsPutBody,
  type DivisionEligibility,
  type EntrantKindValue,
  type RegistrationConfigState,
  type RegistrationSettingsResponse,
} from "@/components/registration-hub-config-state";
import { mapSaveError, type ConfigFieldKey } from "@/components/registration-hub-save-error";
import { instantToOrgTzInputValue, orgTzInputValueToInstant } from "@/components/registration-hub-tz-input";
import { fmtZoneAbbrev } from "@/lib/format";

export interface RegistrationHubConfigDivision extends DivisionEligibility {
  division_id: string;
  name: string;
}

/** What the GET response carries but is never sent back on save — kept
 *  alongside the editable state so the money section can render it. */
interface ReadOnlyEcho {
  chargesEnabled: boolean;
  orgPaymentInstructions: string | null;
}

interface Loaded {
  state: RegistrationConfigState;
  readOnly: ReadOnlyEcho;
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
  division: RegistrationHubConfigDivision;
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
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<ConfigFieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // No `setLoaded(null)`/`setLoadError(null)` reset here: the mount site keys
  // this component by division id, so a different row arrives as a REMOUNT
  // with `useState`'s own initial null. Resetting synchronously inside the
  // effect instead is what react-hooks flags as a cascading render.
  useEffect(() => {
    let cancelled = false;
    apiV1<RegistrationSettingsResponse>(`/api/v1/divisions/${division.division_id}/registration-settings`)
      .then((data) => {
        if (cancelled) return;
        setLoaded({
          state: initialConfigState(data, division),
          readOnly: { chargesEnabled: data.charges_enabled, orgPaymentInstructions: data.org_payment_instructions },
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [division.division_id]);

  function patch(p: Partial<RegistrationConfigState>) {
    setLoaded((prev) => (prev ? { ...prev, state: { ...prev.state, ...p } } : prev));
  }

  async function save() {
    if (!loaded) return;
    setBusy(true);
    setErrors({});
    setFormError(null);
    const patchBody = toDivisionPatchBody(loaded.state);
    const putBody = toRegistrationSettingsPutBody(loaded.state);
    const [patchResult, putResult] = await Promise.allSettled([
      apiV1(`/api/v1/divisions/${division.division_id}`, { method: "PATCH", json: patchBody }),
      apiV1(`/api/v1/divisions/${division.division_id}/registration-settings`, {
        method: "PUT",
        json: putBody,
      }),
    ]);
    const nextErrors: Partial<Record<ConfigFieldKey, string>> = {};
    let banner: string | null = null;
    for (const result of [patchResult, putResult]) {
      if (result.status !== "rejected") continue;
      const info = mapSaveError(result.reason);
      if (info.field) nextErrors[info.field] = info.message;
      else banner = info.message;
    }
    setBusy(false);
    if (Object.keys(nextErrors).length > 0 || banner) {
      setErrors(nextErrors);
      setFormError(banner);
      return;
    }
    onSaved();
  }

  const state = loaded?.state ?? null;

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
      <div data-registration-hub-config-panel data-division-id={division.division_id} className="space-y-5">
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
            <EligibilitySection state={state} errors={errors} patch={patch} msg={msg} />
            <OpenCloseSection state={state} errors={errors} patch={patch} msg={msg} orgTz={orgTz} />
            <CapacitySection state={state} errors={errors} patch={patch} msg={msg} />
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
              chargesEnabled={loaded!.readOnly.chargesEnabled}
              orgPaymentInstructions={loaded!.readOnly.orgPaymentInstructions}
            />
            <section className="card space-y-3 p-4">
              <h3 className="text-sm font-semibold text-slate-700">
                {msg("reg.settings.signupForm")} · {msg("reg.settings.extraQuestions", { n: state.form_fields.length })}
              </h3>
              <FormBuilder fields={state.form_fields} canEdit onChange={(form_fields) => patch({ form_fields })} />
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

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
            const v = e.target.value as EntrantKindValue;
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
