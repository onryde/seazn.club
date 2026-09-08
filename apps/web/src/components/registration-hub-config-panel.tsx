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
// (use-registration-hub-config.ts) — all pure/independently tested;
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
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ReactEventHandler, ReactNode } from "react";
import { Modal } from "@/components/modal";
import Link from "@/components/ui/console-link";
import { useMsg, useLocaleOrDefault } from "@/components/i18n/dict-provider";
import { routes } from "@/lib/routes";
import type { Currency } from "@/lib/currency";
import type { MessageKey } from "@/lib/messages";
import { FormBuilder } from "@/components/registration-hub-form-builder";
import type { DivisionCategoryValue } from "@/components/registration-hub-row-derive";
import {
  validateConfigState,
  type RegistrationConfigState,
  type ConfigValidationIssue,
} from "@/components/registration-hub-config-state";
import type { ConfigFieldKey } from "@/components/registration-hub-save-error";
import {
  useRegistrationConfigPanelState,
  type RegistrationHubConfigDivisionLike,
} from "@/components/use-registration-hub-config";
import {
  SECTION_IDS,
  SECTION_FIELDS,
  firstErrorSection,
  type SectionId,
} from "@/components/registration-hub-config-panel-sections";
import {
  orgTzDateTimeHalves,
  editOrgTzDateTimeHalf,
  isDateTimeHalvesIncomplete,
  type DateTimeHalves,
} from "@/components/registration-hub-tz-input";
import { DateTimeField } from "@/components/v2/shared/datetime-field";
import { fmtZoneAbbrev } from "@/lib/format";

/** Appended to the time list on the two CUTOFF fields. The quarter-hour grid
 *  ends at 23:45, and a deadline that lands there closes the door 15 minutes
 *  early — the same reason the division wizard's deadlines pass this. */
const CUTOFF_TIME_OPTIONS = ["23:59"];

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The four fields this panel edits as a date+time PAIR rather than a
 *  single value — see registration-hub-tz-input.ts's header for why (the
 *  half-filled-value bug, RS005 R4 task 2). */
const DATETIME_FIELDS = ["opens_at", "closes_at", "refund_lock_at", "place_by_at"] as const;
type DateTimeFieldKey = (typeof DATETIME_FIELDS)[number];

/** ConfigValidationIssue -> organiser-facing copy. The ONE place that maps
 *  validateConfigState's rule keys to dictionary strings — keeps that pure
 *  function message-free (its own header comment) while every message still
 *  lives in the four dictionaries, never hardcoded here. */
function validationMessage(issue: ConfigValidationIssue, msg: Msg): string {
  switch (issue) {
    case "capacityRange":
      return msg("reg.hub.config.capacityRangeError");
    case "feeCentsRange":
      return msg("reg.hub.config.feeCentsRangeError");
    case "cardFeeMinimum":
      return msg("reg.hub.config.cardFeeMinimumError");
    case "soloCardFeeMinimum":
      return msg("reg.hub.config.soloCardFeeMinimumError");
    case "datesOrder":
      // Reuses the pre-existing (previously unused) key rather than minting
      // a near-duplicate — same wording the pre-deletion component showed
      // for this exact rule.
      return msg("reg.settings.datesError");
    case "duplicateFormFieldKeys":
      return msg("reg.hub.config.duplicateFormFieldKeysError");
    case "selectNeedsOptions":
      return msg("reg.hub.config.selectNeedsOptionsError");
  }
}

const DEFAULT_OPEN: Record<SectionId, boolean> = {
  eligibility: true,
  schedule: true,
  capacity: true,
  money: false,
  form: false,
};

function sectionTitle(
  id: SectionId,
  msg: Msg,
  formFieldCount: number,
): string {
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
      // NOT `usePlural`: it throws outside a `DictProvider` and this panel is
      // rendered without one — the same reason and the same shape as
      // create-org-form.tsx:134-140, which documents it. Safe rather than a
      // shortcut: all four shipped locales (en/es/fr/nl) put the one/other
      // boundary at exactly 1, so this ternary IS the plural rule for every
      // locale the product has. A locale with a dual or paucal form would
      // need the real Intl.PluralRules path.
      //
      // It said "1 extra questions" before, and a division with one extra
      // question is the COMMON case, not an edge one.
      return `${msg("reg.settings.signupForm")} · ${msg(
        formFieldCount === 1 ? "reg.settings.extraQuestions.one" : "reg.settings.extraQuestions.other",
        { count: formFieldCount },
      )}`;
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

/**
 * One org-timezone date+time pair (RS005 R4 task 2), rendered as two native
 * controls — a date input, a time select — rather than through
 * `DateTimeField`'s own `kind="datetime-local"` (which delegates to
 * `DateTimeSplitField`, v2/shared/datetime-split-field.tsx). That component
 * owns its two halves as INTERNAL `useState`, seeded once, and only ever
 * reports the JOINED value back out through `onChange` — by design (its own
 * file doc): a half-filled pair joins to `""`, identical to a full clear,
 * specifically so a caller never has to handle an unparseable intermediate
 * value. That is exactly the information this panel needs and cannot get
 * through it — `orgTzInputValueToInstant("")` returning null is correct for
 * that string, but "date typed, time still blank" and "both blank" reach it
 * as the identical string, so it cannot tell a genuine clear from a
 * half-finished edit.
 *
 * So this panel renders the two halves itself, and tracks them as LIFTED
 * state (`dtDrafts`, owned by `RegistrationHubConfigPanel` below and passed
 * down as a prop) — the same pattern `MoneySection`'s `feeText`/`onFeeText`
 * already uses, and for the identical reason: `OpenCloseSection`/
 * `MoneySection` are invoked DIRECTLY by this panel's own test harness
 * (deepExpand/OPAQUE_TYPES in the test file), which installs no hook
 * dispatcher, so every exported Section-shaped helper here — this one
 * included — must stay hookless.
 *
 * Exported (not a private closure) for the same reason `Disclosure` is: a
 * test adds it to OPAQUE_TYPES to descend into it, the same way it already
 * does for `Disclosure` and the five Sections.
 */
export function OrgTzDateTimePair({
  label,
  dataField,
  halves,
  timeLabel,
  extraOptions,
  onHalfChange,
}: {
  label: string;
  /** Base name, UNSUFFIXED — suffixed `_date`/`_time` on the two rendered
   *  controls below, and left bare on this component's own wrapping `<div>`
   *  (so `findField`-style lookups by the PANEL's own field name still
   *  resolve one element, exactly the way every other field here works).
   *  Same suffixing convention DateTimeSplitField itself already
   *  established — a bare name on either half would be a locator
   *  addressing half a value. */
  dataField: string;
  halves: DateTimeHalves;
  timeLabel: string;
  extraOptions?: string[];
  onHalfChange: (half: "date" | "time", value: string) => void;
}) {
  return (
    // Same container-query shell as DateTimeSplitField: stacks under 18rem
    // of its OWN width, sits side by side at or above it, regardless of the
    // viewport around it (see that component's own regression test/comment
    // for why a viewport media query is the wrong question here).
    <div className="@container" data-field={dataField}>
      <div className="flex flex-col gap-2 @[18rem]:flex-row @[18rem]:items-end">
        <div className="min-w-0 flex-[3]">
          <DateTimeField
            kind="date"
            label={label}
            dataField={`${dataField}_date`}
            value={halves.date}
            onChange={(v) => onHalfChange("date", v)}
          />
        </div>
        <div className="min-w-0 flex-[2]">
          <DateTimeField
            kind="time"
            label={label}
            labelHidden
            selectAriaLabel={timeLabel}
            extraOptions={extraOptions}
            dataField={`${dataField}_time`}
            value={halves.time}
            onChange={(v) => onHalfChange("time", v)}
          />
        </div>
      </div>
    </div>
  );
}

export function RegistrationHubConfigPanel({
  division,
  orgTz,
  orgSlug,
  currency,
  feePercentPct,
  cardUnsupportedCurrency,
  waitlistedCount,
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
  /** Registrations in `waitlisted` status for this division RIGHT NOW
   *  (RS005 F4, fetchDivisionRows -> RegistrationHubRowData.waitlisted).
   *  The Money section warns with this count that promoting any of them
   *  charges whatever fee is live at promotion time, not what they saw when
   *  they joined — see MoneySection's own comment. */
  waitlistedCount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const msg = useMsg();
  // RS007/V380 — the cutoff fields' month <select> needs localised month
  // names (matching the division-creation wizard's own cutoff fields,
  // division-builder.tsx). Read here and passed down as a prop, same as
  // `msg` above: EligibilitySection is called directly, outside React, by
  // this panel's own test harness (see its "hookless" comment below), so it
  // cannot call a hook itself. useLocaleOrDefault, not useLocale: this
  // island is rendered bare (no <DictProvider>) in that harness and in a
  // static-render pass, and the locale here is FORMATTING-only (month
  // names) — a silent English fallback there is correct, not a bug (see
  // useLocaleOrDefault's own doc comment, dict-provider.tsx).
  const locale = useLocaleOrDefault();
  const { state, readOnly, loadError, busy, errors, formError, saveOutcome, patch, save } =
    useRegistrationConfigPanelState(division, onSaved);
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>(DEFAULT_OPEN);
  // Finding 3: the fee input's draft text, independent of fee_cents. Owned
  // HERE (not inside MoneySection) rather than as a useState in the section
  // itself — MoneySection is invoked directly, outside React, by this
  // panel's own test harness (registration-hub-config-panel.test.tsx's
  // deepExpand/OPAQUE_TYPES and the finding-1 enumerating test both call
  // Section functions as plain JS, with no hook dispatcher installed at
  // that point — see _hook-harness.tsx's header), so every Section must
  // stay hookless. Null until the organiser actually types; MoneySection
  // falls back to a formatted (state.fee_cents / 100) whenever it's null,
  // so there's no separate "seed on load" step to get out of sync.
  const [feeText, setFeeText] = useState<string | null>(null);
  // RS009's solo-sign-up price, lifted for the same reason feeText is. Its
  // fallback differs: an EMPTY string is a meaningful value here ("no
  // separate price"), so MoneySection falls back to "" rather than a
  // formatted zero — 0 would read as "free", which is a different setting.
  const [soloFeeText, setSoloFeeText] = useState<string | null>(null);
  // RS005 R4 task 2 — the three clock fields' in-progress halves, lifted
  // here for the SAME reason feeText is (see its own comment above):
  // OpenCloseSection/MoneySection are invoked directly by this panel's own
  // test harness and must stay hookless. Empty until the organiser touches
  // a half; `OrgTzDateTimePair`'s own comment and registration-hub-tz-
  // input.ts explain why this can't just live inside `state` — a half-typed
  // pair must NEVER collapse into state as a (wrong) null "clear".
  const [dtDrafts, setDtDrafts] = useState<Partial<Record<DateTimeFieldKey, DateTimeHalves>>>({});
  // Client-only validation errors (RS005 R4 task 2) — kept SEPARATE from the
  // hook's own `errors` (server round-trip state) rather than written into
  // it: these never touch the network, and folding them into `errors` would
  // make a client-side rejection look like a failed save (wrong
  // saveOutcome, a misleading "everything else saved" partial-save banner).
  const [clientErrors, setClientErrors] = useState<Partial<Record<ConfigFieldKey, string>>>({});
  // What every Section actually renders against — server errors first,
  // client-only ones layered on top so the freshest, most-actionable
  // message wins on a field that somehow has both.
  const fieldErrors: Partial<Record<ConfigFieldKey, string>> = { ...errors, ...clientErrors };

  function onDateTimeHalfChange(field: DateTimeFieldKey, half: "date" | "time", value: string) {
    const current = dtDrafts[field] ?? orgTzDateTimeHalves(state![field], orgTz);
    const result = editOrgTzDateTimeHalf(current, half, value, orgTz);
    setDtDrafts((prev) => ({ ...prev, [field]: result.halves }));
    // Never patch `state` while incomplete — that would be the exact bug
    // this task fixes, just moved one layer up: an in-progress half-typed
    // pair silently becoming a committed "unset". Leaving the committed
    // value untouched here means a save attempted mid-edit still saves
    // whatever was there BEFORE (blocked below by the incomplete check,
    // never silently nulled).
    if (!result.incomplete) patch({ [field]: result.instant });
  }

  // Reveal whichever section holds the first error, at the moment the save
  // reports one. Deliberately NOT a `useEffect` on `errors`: writing state
  // synchronously inside an effect is a cascading render (lint rejects it),
  // and the effect also re-fired on every unrelated `errors` identity change.
  //
  // Equally deliberately not a derived `open={openSections[id] || hasError}`:
  // <details> is not a controlled input React re-asserts on every render, so a
  // derived value stops forcing the section open as soon as it renders the same
  // computed value twice — which happens the moment the organiser toggles the
  // section by hand while the error is still live. Writing it once here means
  // the reveal survives until they deliberately close it again.
  async function saveAndReveal() {
    if (!state) return;
    // Client-side gate BEFORE the network round trip (RS005 R4 task 2): an
    // incomplete clock field, or anything validateConfigState catches, must
    // block the save outright — never merely warn after the fact. Datetime
    // incompleteness wins over a validateConfigState issue on the SAME
    // field (closes_at can be both mid-edit AND, on the last COMMITTED
    // value, dates-order-invalid; the mid-edit problem is the one the
    // organiser needs to resolve first).
    const nextClientErrors: Partial<Record<ConfigFieldKey, string>> = {};
    for (const field of DATETIME_FIELDS) {
      const draft = dtDrafts[field];
      if (draft && isDateTimeHalvesIncomplete(draft)) {
        nextClientErrors[field] = msg("reg.hub.config.incompleteDateTime");
      }
    }
    const issues = validateConfigState(state);
    for (const key of Object.keys(issues) as ConfigFieldKey[]) {
      if (nextClientErrors[key]) continue;
      nextClientErrors[key] = validationMessage(issues[key]!, msg);
    }
    if (Object.keys(nextClientErrors).length > 0) {
      setClientErrors(nextClientErrors);
      const sectionId = firstErrorSection(nextClientErrors);
      if (sectionId) setOpenSections((prev) => (prev[sectionId] ? prev : { ...prev, [sectionId]: true }));
      return;
    }
    setClientErrors({});
    const failed = await save();
    const sectionId = firstErrorSection(failed);
    if (!sectionId) return;
    setOpenSections((prev) => (prev[sectionId] ? prev : { ...prev, [sectionId]: true }));
  }

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
              onClick={saveAndReveal}
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
              const hasError = SECTION_FIELDS[id].some((f) => fieldErrors[f]);
              const content =
                id === "eligibility" ? (
                  <EligibilitySection
                    state={state}
                    errors={fieldErrors}
                    patch={patch}
                    msg={msg}
                    locale={locale}
                    orgTz={orgTz}
                    dtDrafts={dtDrafts}
                    onDateTimeHalfChange={onDateTimeHalfChange}
                  />
                ) : id === "schedule" ? (
                  <OpenCloseSection
                    state={state}
                    errors={fieldErrors}
                    patch={patch}
                    msg={msg}
                    orgTz={orgTz}
                    dtDrafts={dtDrafts}
                    onDateTimeHalfChange={onDateTimeHalfChange}
                  />
                ) : id === "capacity" ? (
                  <CapacitySection state={state} errors={fieldErrors} patch={patch} msg={msg} />
                ) : id === "money" ? (
                  <MoneySection
                    state={state}
                    errors={fieldErrors}
                    patch={patch}
                    msg={msg}
                    orgTz={orgTz}
                    orgSlug={orgSlug}
                    currency={currency}
                    feePercentPct={feePercentPct}
                    cardUnsupportedCurrency={cardUnsupportedCurrency}
                    waitlistedCount={waitlistedCount}
                    chargesEnabled={readOnly!.chargesEnabled}
                    orgPaymentInstructions={readOnly!.orgPaymentInstructions}
                    feeText={feeText}
                    onFeeText={setFeeText}
                    soloFeeText={soloFeeText}
                    onSoloFeeText={setSoloFeeText}
                    dtDrafts={dtDrafts}
                    onDateTimeHalfChange={onDateTimeHalfChange}
                  />
                ) : (
                  <FormSection state={state} errors={fieldErrors} patch={patch} />
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

// The sections carry NO heading of their own. Each is rendered inside a
// disclosure whose summary already states the section name, so a heading here
// printed the same word twice, one line apart (visible in the sign-off
// screenshots: "Eligibility" above "Eligibility"). `sectionTitle` above is the
// single place a section is named.
export function EligibilitySection({
  state,
  errors,
  patch,
  msg,
  locale,
  orgTz,
  dtDrafts,
  onDateTimeHalfChange,
}: {
  state: RegistrationConfigState;
  errors: Partial<Record<ConfigFieldKey, string>>;
  patch: (p: Partial<RegistrationConfigState>) => void;
  msg: Msg;
  /** RS007/V380 — month names for the cutoff <select> below. */
  locale: string;
  orgTz: string;
  /** RS012/V389 — place_by_at's in-progress date/time halves, owned by the
   *  panel (OrgTzDateTimePair's own comment explains why). */
  dtDrafts: Partial<Record<DateTimeFieldKey, DateTimeHalves>>;
  onDateTimeHalfChange: (field: DateTimeFieldKey, half: "date" | "time", value: string) => void;
}) {
  const isTeam = state.entrant_kind === "team";
  const zone = fmtZoneAbbrev(orgTz, new Date());
  // Meaningless outside a division that accepts solo sign-ups at all — same
  // "shown when it applies, but still shown if the server names an error on
  // it" rule refundLockApplies (MoneySection, below) uses, for the same
  // reason (a value can survive a toggle-off and a save error must still
  // have somewhere to render).
  const placeByApplies = state.allow_free_agents || Boolean(errors.place_by_at);
  // A cutoff means nothing without an age band to anchor it — disabled
  // rather than hidden, mirroring the division-creation wizard's own
  // `disabled={!maxAge}` on its cutoff fields (division-builder.tsx).
  const hasAgeBand = state.age_min != null || state.age_max != null;
  return (
    <section className="card space-y-3 p-4">
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
            onChange={(e) => {
              const value = e.target.value === "" ? null : Number(e.target.value);
              // Review fix: clearing the LAST side still holding the age
              // band must also clear the cutoff — otherwise it strands
              // behind `disabled` (below) with no way left for the
              // organiser to remove it, and the PATCH body still carries
              // it (toDivisionPatchBody sends all six eligibility keys
              // together on every save).
              const bandCleared = value == null && state.age_max == null;
              patch(
                bandCleared
                  ? { age_min: value, age_cutoff_month: null, age_cutoff_day: null }
                  : { age_min: value },
              );
            }}
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
            onChange={(e) => {
              const value = e.target.value === "" ? null : Number(e.target.value);
              // Same rule, other side — see age_min's onChange above.
              const bandCleared = value == null && state.age_min == null;
              patch(
                bandCleared
                  ? { age_max: value, age_cutoff_month: null, age_cutoff_day: null }
                  : { age_max: value },
              );
            }}
          />
          {errors.age_max && (<p data-field-error="age_max" role="alert" className="mt-1 text-xs text-red-600">{errors.age_max}</p>)}
        </label>
      </div>
      {/* RS007/V380 — the age-band cutoff override (default 1 January when
          neither side is set) and the retired jsonb "custom rule" note, now
          first-class columns alongside category/age_min/age_max above. Month
          + day always move TOGETHER (both-or-neither, the DB CHECK's own
          rule — divisions_age_cutoff_check): clearing one clears both, and
          setting one defaults the other to its first value, so this control
          can never leave the pair half-set the way two independently
          nullable inputs could. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="label">
          {msg("wizard.cutoffMonth")}
          <select
            data-field="age_cutoff_month"
            className="input min-h-11 mt-1"
            disabled={!hasAgeBand}
            value={state.age_cutoff_month ?? ""}
            onChange={(e) => {
              const month = e.target.value === "" ? null : Number(e.target.value);
              patch({
                age_cutoff_month: month,
                age_cutoff_day: month === null ? null : (state.age_cutoff_day ?? 1),
              });
            }}
          >
            <option value="">—</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {new Date(2000, n - 1, 1).toLocaleString(locale, { month: "long" })}
              </option>
            ))}
          </select>
          {errors.age_cutoff_month && (<p data-field-error="age_cutoff_month" role="alert" className="mt-1 text-xs text-red-600">{errors.age_cutoff_month}</p>)}
        </label>
        <label className="label">
          {msg("wizard.cutoffDay")}
          <input
            type="number"
            min={1}
            max={31}
            data-field="age_cutoff_day"
            className="input mt-1"
            disabled={!hasAgeBand}
            value={state.age_cutoff_day ?? ""}
            onChange={(e) => {
              const day = e.target.value === "" ? null : Number(e.target.value);
              patch({
                age_cutoff_day: day,
                age_cutoff_month: day === null ? null : (state.age_cutoff_month ?? 1),
              });
            }}
          />
          {errors.age_cutoff_day && (<p data-field-error="age_cutoff_day" role="alert" className="mt-1 text-xs text-red-600">{errors.age_cutoff_day}</p>)}
        </label>
      </div>
      <label className="label">
        {msg("reg.hub.config.eligibilityNote")}
        <textarea
          data-field="eligibility_note"
          rows={2}
          maxLength={2000}
          className="input mt-1"
          value={state.eligibility_note ?? ""}
          onChange={(e) => patch({ eligibility_note: e.target.value || null })}
          placeholder={msg("wizard.customRulePlaceholder")}
        />
        {errors.eligibility_note && (<p data-field-error="eligibility_note" role="alert" className="mt-1 text-xs text-red-600">{errors.eligibility_note}</p>)}
      </label>
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
      {/* Nothing at all for a non-team division, rather than a line explaining
          why a control they cannot use is missing. The hint ("Only available
          for team divisions.") answered a question an organiser configuring a
          Pair division never asked — the setting is not theirs to make, so its
          absence needs no apology. Switching entrant_kind re-renders this, and
          the select below already forces allow_free_agents false on the way
          out of 'team', so no state is stranded. */}
      {isTeam && (
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            data-field="allow_free_agents"
            checked={state.allow_free_agents}
            onChange={(e) => patch({ allow_free_agents: e.target.checked })}
          />
          {msg("reg.hub.config.allowSolo")}
        </label>
      )}
      {errors.allow_free_agents && (<p data-field-error="allow_free_agents" role="alert" className="mt-1 text-xs text-red-600">{errors.allow_free_agents}</p>)}
      {placeByApplies && (
        <div>
          <OrgTzDateTimePair
            label={`${msg("reg.settings.placeByDate")} (${zone})`}
            dataField="place_by_at"
            extraOptions={CUTOFF_TIME_OPTIONS}
            halves={dtDrafts.place_by_at ?? orgTzDateTimeHalves(state.place_by_at, orgTz)}
            timeLabel={msg("datetime.timeLabel")}
            onHalfChange={(half, v) => onDateTimeHalfChange("place_by_at", half, v)}
          />
          {errors.place_by_at && (<p data-field-error="place_by_at" role="alert" className="mt-1 text-xs text-red-600">{errors.place_by_at}</p>)}
        </div>
      )}
    </section>
  );
}

export function OpenCloseSection({
  state,
  errors,
  patch,
  msg,
  orgTz,
  dtDrafts,
  onDateTimeHalfChange,
}: {
  state: RegistrationConfigState;
  errors: Partial<Record<ConfigFieldKey, string>>;
  patch: (p: Partial<RegistrationConfigState>) => void;
  msg: Msg;
  orgTz: string;
  /** RS005 R4 task 2 — this field's in-progress date/time halves, owned by
   *  the panel (OrgTzDateTimePair's own comment explains why). */
  dtDrafts: Partial<Record<DateTimeFieldKey, DateTimeHalves>>;
  onDateTimeHalfChange: (field: DateTimeFieldKey, half: "date" | "time", value: string) => void;
}) {
  // A short, DST-correct abbreviation ("BST", "IST") rather than the raw
  // IANA string — matches the zone labelling the row already shows
  // (registration-hub-row-derive.ts's formatRegistrationWindow).
  const zone = fmtZoneAbbrev(orgTz, new Date());
  const timeLabel = msg("datetime.timeLabel");
  return (
    <section className="card space-y-3 p-4">
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          data-field="enabled"
          checked={state.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        {msg("reg.settings.openForPublic")}
      </label>
      {errors.enabled && (<p data-field-error="enabled" role="alert" className="mt-1 text-xs text-red-600">{errors.enabled}</p>)}
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
        {errors.entrant_kind && (<p data-field-error="entrant_kind" role="alert" className="mt-1 text-xs text-red-600">{errors.entrant_kind}</p>)}
      </label>
      <div className="grid grid-cols-1 gap-3">
        {/* OrgTzDateTimePair, not DateTimeField's own `kind="datetime-local"`
            — see that component's header comment for why: this panel needs
            to see a half-filled pair (RS005 R4 task 2), which
            DateTimeSplitField's own internal state deliberately hides from
            every caller. Still built on DateTimeField's `kind="date"`/
            `kind="time"` underneath, so v2/shared/__tests__/time-step-
            coverage.test.ts's sweep for raw clock inputs still covers these
            three — nothing here reaches for a bare `<input type="date">` or
            `<select>` of its own. */}
        <div>
          <OrgTzDateTimePair
            label={`${msg("reg.settings.opens")} (${zone})`}
            dataField="opens_at"
            halves={dtDrafts.opens_at ?? orgTzDateTimeHalves(state.opens_at, orgTz)}
            timeLabel={timeLabel}
            onHalfChange={(half, v) => onDateTimeHalfChange("opens_at", half, v)}
          />
          {errors.opens_at && (<p data-field-error="opens_at" role="alert" className="mt-1 text-xs text-red-600">{errors.opens_at}</p>)}
        </div>
        <div>
          <OrgTzDateTimePair
            label={`${msg("reg.settings.closes")} (${zone})`}
            dataField="closes_at"
            // A close is a DEADLINE, so it needs the one time the quarter-hour
            // grid cannot express: the grid tops out at 23:45, and "closes at
            // 23:45" is not what an organiser means by "closes that day".
            extraOptions={CUTOFF_TIME_OPTIONS}
            halves={dtDrafts.closes_at ?? orgTzDateTimeHalves(state.closes_at, orgTz)}
            timeLabel={timeLabel}
            onHalfChange={(half, v) => onDateTimeHalfChange("closes_at", half, v)}
          />
          {errors.closes_at && (<p data-field-error="closes_at" role="alert" className="mt-1 text-xs text-red-600">{errors.closes_at}</p>)}
        </div>
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
  waitlistedCount,
  chargesEnabled,
  orgPaymentInstructions,
  feeText,
  onFeeText,
  soloFeeText,
  onSoloFeeText,
  dtDrafts,
  onDateTimeHalfChange,
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
  /** RS005 F4 — registrations in `waitlisted` status for this division right
   *  now. `promoteWaitlistedRow` (registrations.ts, ~:875) reads the LIVE
   *  fee at promotion time, never whatever fee was showing when a
   *  waitlisted entrant joined (they hold `amount_cents = 0`, so there is
   *  no earlier quote to honour) — so a fee edited here silently re-prices
   *  every one of them the moment they're promoted. Shown only when > 0. */
  waitlistedCount: number;
  chargesEnabled: boolean;
  orgPaymentInstructions: string | null;
  /** Finding 3 — the fee input's in-progress draft, owned by the panel
   *  (see its own comment): null until the organiser types, so this section
   *  stays hookless. */
  feeText: string | null;
  onFeeText: (text: string) => void;
  /** RS009 — the solo-sign-up price's in-progress draft. Same ownership rule
   *  as feeText; "" is a real value (clear back to the team fee), not a
   *  missing one. */
  soloFeeText: string | null;
  onSoloFeeText: (text: string) => void;
  /** RS005 R4 task 2 — refund_lock_at's in-progress date/time halves, owned
   *  by the panel (OrgTzDateTimePair's own comment explains why). */
  dtDrafts: Partial<Record<DateTimeFieldKey, DateTimeHalves>>;
  onDateTimeHalfChange: (field: DateTimeFieldKey, half: "date" | "time", value: string) => void;
}) {
  const currencyCode = currency.toUpperCase();
  const cardUnavailable = !chargesEnabled || cardUnsupportedCurrency !== null;
  const paidConfigured = state.fee_cents > 0;
  // The auto-refund the lock governs can ONLY happen on a card entry:
  // withdrawCore's own predicate is `locked.payment_intent_id && …`
  // (registrations.ts), and an offline entry has no payment intent, so
  // nothing auto-refunds and the cutoff governs nothing. Shown for
  // pay-the-organiser it asks the organiser to configure a policy that will
  // never run — the same false-claim class as the platform-cut line above.
  //
  // A stored value SURVIVES a switch to offline and still applies to entries
  // already paid by card; hiding the field does not clear it. That is the
  // right trade: the field is a division setting, and the division is no
  // longer taking cards.
  // Rendered when it applies OR when a save error names it. The panel has an
  // invariant test — "every routable field has a render site, never routed
  // into a void" — and it is right: `errors.refund_lock_at` can arrive from
  // the server for a value still stored from before the division switched to
  // offline, and an error with nowhere to render is an error the organiser
  // never sees while the save keeps failing.
  const refundLockApplies =
    (paidConfigured && state.payment_method === "stripe") || Boolean(errors.refund_lock_at);
  const zone = fmtZoneAbbrev(orgTz, new Date());
  // Falls back to the committed value, formatted, whenever there is no
  // in-progress draft — covers both "never touched yet" and "just blurred".
  const feeDisplay = feeText ?? (state.fee_cents / 100).toFixed(2);
  // Same independent-draft pattern as feeText above, and for the same reason.
  // The difference: an EMPTY string is meaningful here (it clears back to
  // "no separate price"), so the fallback is "" rather than a formatted zero.
  const soloFeeDisplay =
    soloFeeText ??
    (state.free_agent_fee_cents === null ? "" : (state.free_agent_fee_cents / 100).toFixed(2));

  return (
    <section className="card space-y-3 p-4" data-feature="registration.paid">

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-purple-100 bg-purple-50/60 px-3 py-2 text-xs text-purple-800">
        <span>{msg("reg.hub.config.currencyNote", { currency: currencyCode })}</span>
        <Link href={routes.orgSettings(orgSlug, "preferences")} className="font-medium underline underline-offset-2">
          {msg("reg.hub.config.manageCurrency")}
        </Link>
      </div>

      <label className="label">
        {msg("reg.settings.entryFee", { sym: currencyCode })}
        {/* Finding 3: type="number" sanitises an in-progress value like
            "12." to value === "" (browser-level, before onChange ever
            sees it), so the old handler read that as "clear the field" and
            wrote fee_cents back to 0 mid-keystroke — decimal fees were
            effectively unenterable. text + inputMode="decimal" reports the
            EXACT typed string, with feeDisplay/onFeeText (above) as the
            independent draft — same fix as the pre-deletion component
            (git show 850cc6308^:apps/web/src/components/v2/
            registration-settings.tsx, ~204-221). */}
        <input
          type="text"
          inputMode="decimal"
          data-field="fee_cents"
          className="input mt-1"
          value={feeDisplay}
          onChange={(e) => {
            const next = e.target.value;
            // Reject anything that isn't a plausible in-progress decimal
            // (optional digits, optional single ".", up to 2 more digits)
            // rather than trying to sanitise it — an invalid keystroke is
            // simply not applied, so fee_cents can never go NaN.
            if (!/^\d*\.?\d{0,2}$/.test(next)) return;
            onFeeText(next);
            const pounds = Number.parseFloat(next);
            patch({ fee_cents: Number.isFinite(pounds) ? Math.round(pounds * 100) : 0 });
          }}
          onBlur={() => onFeeText((state.fee_cents / 100).toFixed(2))}
        />
        {errors.fee_cents && (<p data-field-error="fee_cents" role="alert" className="mt-1 text-xs text-red-600">{errors.fee_cents}</p>)}
      </label>

      {/* RS009 — the price for ONE person entering a team division alone.
          Rendered only where solo sign-ups are actually allowed: a price for
          something the division does not offer reads as a promise, and the
          usecase refuses it anyway.

          Empty means "no separate price — charge the team fee", which is the
          default and what every division did before this existed. It is NOT
          the same as 0, which means free, so the placeholder says what empty
          does rather than showing a misleading "0.00". The column, the API
          and the submit path all treat null and 0 as different for exactly
          this reason. */}
      {state.allow_free_agents && state.entrant_kind === "team" && (
        <label className="label">
          {msg("reg.hub.config.soloFee", { sym: currencyCode })}
          <input
            type="text"
            inputMode="decimal"
            data-field="free_agent_fee_cents"
            className="input mt-1"
            placeholder={msg("reg.hub.config.soloFeePlaceholder", {
              fee: (state.fee_cents / 100).toFixed(2),
            })}
            value={soloFeeDisplay}
            onChange={(e) => {
              const next = e.target.value;
              if (!/^\d*\.?\d{0,2}$/.test(next)) return;
              onSoloFeeText(next);
              // Empty string clears back to null ("no separate price"),
              // which is why this cannot reuse the fee_cents handler above:
              // that one falls back to 0, and 0 here means FREE.
              const pounds = Number.parseFloat(next);
              patch({
                free_agent_fee_cents:
                  next.trim() === "" ? null : Number.isFinite(pounds) ? Math.round(pounds * 100) : null,
              });
            }}
          />
          <span className="mt-1 block text-xs text-slate-500">
            {msg("reg.hub.config.soloFeeHint")}
          </span>
          {/* F15 — this input had no render site at all: a real
              free_agent_fee_cents 422 rendered onto fee_cents, the wrong
              field, because the two guards used to throw an identical
              message and nothing here could show the right one anyway. */}
          {errors.free_agent_fee_cents && (
            <p data-field-error="free_agent_fee_cents" role="alert" className="mt-1 text-xs text-red-600">
              {errors.free_agent_fee_cents}
            </p>
          )}
        </label>
      )}
      {/* RS005 F4: only ever a WARNING about entries already queued, never a
          block on saving — the fee change itself is legitimate, the
          organiser just needs to know who it reaches and when. Absent
          entirely at zero, same discipline every other conditional notice
          in this panel already follows (feeCut/refundLock/allowSolo below,
          and the "does not make claims that are false for this division"
          tests that pin them) — a fact that does not apply gets no
          sentence explaining its own absence. */}
      {waitlistedCount > 0 && (
        <p
          data-registration-hub-waitlist-warning
          className="rounded-lg border border-amber-100 bg-amber-50 p-2 text-xs text-amber-800"
        >
          {msg(
            waitlistedCount === 1
              ? "reg.hub.config.waitlistRepriceWarning.one"
              : "reg.hub.config.waitlistRepriceWarning.other",
            { count: waitlistedCount },
          )}
        </p>
      )}
      {/* The platform cut applies to CARD entries only — it is Stripe's
          application fee, taken as the money passes through. On "pay the
          organiser" the money never touches the platform and we take nothing,
          so rendering this line unconditionally told an organiser collecting
          cash at the door that we were taking 8% of it. That is a false claim
          about their money, which is a worse defect than a missing sentence. */}
      {state.payment_method === "stripe" && (
        <p className="text-xs text-slate-500">
          {msg("reg.hub.config.feeCut", { keep: 100 - feePercentPct, pct: feePercentPct })}
        </p>
      )}

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

      {refundLockApplies && (
        <div>
          <OrgTzDateTimePair
            label={`${msg("reg.settings.refundLock")} (${zone})`}
            dataField="refund_lock_at"
            // A cutoff, same as `closes_at` above.
            extraOptions={CUTOFF_TIME_OPTIONS}
            halves={dtDrafts.refund_lock_at ?? orgTzDateTimeHalves(state.refund_lock_at, orgTz)}
            timeLabel={msg("datetime.timeLabel")}
            onHalfChange={(half, v) => onDateTimeHalfChange("refund_lock_at", half, v)}
          />
          {errors.refund_lock_at && (<p data-field-error="refund_lock_at" role="alert" className="mt-1 text-xs text-red-600">{errors.refund_lock_at}</p>)}
        </div>
      )}
    </section>
  );
}

// Extracted from an inline ternary in the panel's SECTION_IDS.map so it can
// be invoked directly the same way the other four sections are (needed for
// finding 1's enumerating test below).
export function FormSection({
  state,
  errors,
  patch,
}: {
  state: RegistrationConfigState;
  errors: Partial<Record<ConfigFieldKey, string>>;
  patch: (p: Partial<RegistrationConfigState>) => void;
}) {
  return (
    <div className="space-y-2">
      <FormBuilder fields={state.form_fields} canEdit onChange={(form_fields) => patch({ form_fields })} />
      {errors.form_fields && (
        <p data-field-error="form_fields" role="alert" className="mt-1 text-xs text-red-600">
          {errors.form_fields}
        </p>
      )}
    </div>
  );
}
