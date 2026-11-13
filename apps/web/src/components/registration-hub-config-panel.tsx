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
//
// B7 T23 (spec §9.3) — `layout: "page"` renders the same sections as a
// division's own hub tab instead of a dialog: a heading, the sections in the
// page, and a Save bar pinned to the bottom of the viewport that says whether
// anything is unsaved ("All changes saved" / "{n} unsaved changes"), with
// Cancel (back to the saved values; the tab stays) and Save changes (saves and
// stays). From md up every section is a plain open section under its own
// heading, with a sticky section index beside them; below md they stay
// accordions. Dirty is the draft against the SAVED values the hook keeps
// (use-config-dirty.ts) plus any clock still half-typed, and a "Changed" tag
// marks each section holding an unsaved edit. A save that does not go through
// says so in the bar and scrolls to what refused it. The modal layout is
// unchanged until T24 retires it.
import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { Modal } from "@/components/modal";
import Link from "@/components/ui/console-link";
import { useMsg, useMsgPlural, useLocaleOrDefault } from "@/components/i18n/dict-provider";
import { useMdUp } from "@/components/ui/use-md-up";
import { useConfigDirty, type ConfigDirty } from "@/components/use-config-dirty";
import {
  ConfigSaveBar,
  ConfigSectionIndex,
  revealSection,
  sectionAnchor,
  type SaveBarState,
} from "@/components/registration-hub-config-page-chrome";
import { Disclosure, sectionTitle, type Msg } from "@/components/registration-hub-config-section";
import { routes } from "@/lib/routes";
import type { Currency } from "@/lib/currency";
import { FormBuilder } from "@/components/registration-hub-form-builder";
import type { DivisionCategoryValue } from "@/components/registration-hub-row-derive";
import {
  validateConfigState,
  type EntrantKindValue,
  type RegistrationConfigState,
  type ConfigValidationIssue,
} from "@/components/registration-hub-config-state";
import type { ConfigFieldKey } from "@/components/registration-hub-save-error";
import { CHESS_INDIVIDUAL_ONLY } from "@/lib/chess-individual-only";
import { ENTRANT_KIND_NOT_ALLOWED, divisionTakesKind } from "@/lib/division-entrant-kinds";
import {
  useRegistrationConfigPanelState,
  type RegistrationHubConfigDivisionLike,
  type SaveOutcome,
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


/** The entrant-type select's order, unchanged from before FU1; filtered to the division's allowed kinds. */
const KIND_OPTION_ORDER: readonly EntrantKindValue[] = ["individual", "team", "pair"];
/** The refused-kind hint's id, for the select's aria-describedby. Static: one config panel is open at a time (a Modal), and
 *  OpenCloseSection must stay hookless (its tests call it directly), so useId is not available. */
const ENTRANT_KIND_HINT_ID = "reg-config-entrant-kind-hint";

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
    case "entrantKindNotAllowed":
      return msg("reg.settings.entrant.notAllowedError");
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

/** B7 T23: where the panel lives. `"modal"` (the default, today's Settings-list dialog) closes on Cancel; `"page"` is a
 *  division's own hub tab, where Cancel returns every field to the saved values and the tab stays open — so it takes no
 *  `onClose`. */
type ConfigPanelLayout = { layout?: "modal"; onClose: () => void } | { layout: "page"; onClose?: undefined };

/** B7 T23: what one Save did. `"refused"`: nothing was sent — the page's own checks stopped it (a half-typed clock, a value out
 *  of range), or nothing had loaded to save. The rest are the hook's outcomes, named by what failed. */
export type ConfigSaveResult = "refused" | SaveOutcome;

/** B7 T23: Save, driven from outside the panel — the hub's division tabs ask to save before a tab closes (T24). The same save
 *  as the bar's button: the page's checks first, then both requests, then the reveal of whatever refused it. */
export interface ConfigSaveHandle {
  save: () => Promise<ConfigSaveResult>;
}

export function RegistrationHubConfigPanel({
  division,
  orgTz,
  orgSlug,
  currency,
  feePercentPct,
  cardUnsupportedCurrency,
  waitlistedCount,
  layout = "modal",
  onClose,
  onSaved,
  onDirtyChange,
  saveHandleRef,
}: ConfigPanelLayout & {
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
  onSaved: () => void;
  /** B7 T23: told whenever the unsaved-changes answer moves (and once on mount, clean) — never on a keystroke that leaves the
   *  count and sections as they were. The tab host's dirty dot and close/evict dialogs read it. */
  onDirtyChange?: (dirty: ConfigDirty) => void;
  /** B7 T23: filled with a save handle while the panel is mounted (null after it unmounts). */
  saveHandleRef?: RefObject<ConfigSaveHandle | null>;
}) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const headingId = useId();
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
  const { state, saved, readOnly, loadError, busy, errors, formError, saveOutcome, patch, save, reset, clearFailure } =
    useRegistrationConfigPanelState(division, onSaved, (code) =>
      code === CHESS_INDIVIDUAL_ONLY
        ? msg("divset.err.chessIndividualOnly")
        : code === ENTRANT_KIND_NOT_ALLOWED
          ? msg("reg.settings.entrant.notAllowedError")
          : null,
    );
  // Page layout from md up: every section open, with the index beside them (spec §9.3). Null until the browser has been asked;
  // the sections only render once the GET has answered, by which time it has.
  const mdUp = useMdUp();
  const wide = layout === "page" && mdUp === true;
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
  // A clock with one half typed and the other blank never reaches `state` (onDateTimeHalfChange below), and Save refuses it —
  // so it is unsaved, and counted, in its own section (B7 T23 review I-1).
  const pendingClocks = DATETIME_FIELDS.filter((f) => {
    const draft = dtDrafts[f];
    return draft !== undefined && isDateTimeHalvesIncomplete(draft);
  });
  const dirty = useConfigDirty(saved, state, pendingClocks);
  // Back to the saved values (edited back by hand, or the failed half of a partial save restored): what the last failed save
  // said was about edits that no longer exist, so it goes — the bar reading "All changes saved" over a failure banner is a
  // contradiction (B7 T23 re-review m4). The sanctioned "adjust state when a value changes" shape: during render, on the
  // transition only, never in an effect.
  const [wasDirty, setWasDirty] = useState(false);
  if (wasDirty !== dirty.dirty) {
    setWasDirty(dirty.dirty);
    if (!dirty.dirty) {
      clearFailure();
      setClientErrors((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    }
  }
  // Latest callback in a ref, written in an effect (never during render), so the report below fires on the ANSWER moving and
  // not on a parent handing down a fresh inline function each render — which, with a parent that stores the report in
  // state, would be a render loop.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  function onDateTimeHalfChange(field: DateTimeFieldKey, half: "date" | "time", value: string) {
    const current = dtDrafts[field] ?? orgTzDateTimeHalves(state![field], orgTz);
    const result = editOrgTzDateTimeHalf(current, half, value, orgTz);
    // Never patch `state` while incomplete — that would be the exact bug
    // this task fixes, just moved one layer up: an in-progress half-typed
    // pair silently becoming a committed "unset". Leaving the committed
    // value untouched here means a save attempted mid-edit still saves
    // whatever was there BEFORE (blocked below by the incomplete check,
    // never silently nulled).
    // The value before the draft: a renderer that does not batch the two (the static test harness) then never sees the
    // finished draft over the old value — a clean moment that would read as "edited back" (re-review m4).
    if (!result.incomplete) {
      patch({ [field]: result.instant });
      // A refusal of this clock for being half-typed is answered once both halves are in (B7 T23 re-review m4).
      setClientErrors((prev) => {
        if (!(field in prev)) return prev;
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
    setDtDrafts((prev) => ({ ...prev, [field]: result.halves }));
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
  async function saveAndReveal(onlyChanged: boolean): Promise<ConfigSaveResult> {
    // Nothing loaded: nothing to check or send (a host's Save before the GET answered).
    if (!state) return "refused";
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
    const issues = validateConfigState(state, division.allowed_kinds);
    for (const key of Object.keys(issues) as ConfigFieldKey[]) {
      if (nextClientErrors[key]) continue;
      nextClientErrors[key] = validationMessage(issues[key]!, msg);
    }
    if (Object.keys(nextClientErrors).length > 0) {
      setClientErrors(nextClientErrors);
      reveal(firstErrorSection(nextClientErrors));
      return "refused";
    }
    setClientErrors({});
    const result = await save({ onlyChanged });
    if (result.outcome !== "success") reveal(firstErrorSection(result.errors));
    return result.outcome;
  }

  // One save at a time (B7 T23 re-review m2): a second ask while one is in flight — the bar's button, a host's handle — gets the
  // SAME promise, so nothing is sent twice and `onSaved` fires once. A ref, written only by these handlers, never in render.
  const inFlight = useRef<Promise<ConfigSaveResult> | null>(null);
  function saveOnce(onlyChanged: boolean): Promise<ConfigSaveResult> {
    if (inFlight.current) return inFlight.current;
    const pending = saveAndReveal(onlyChanged).finally(() => {
      inFlight.current = null;
    });
    inFlight.current = pending;
    return pending;
  }

  // Open the section that refused the save; on the page, also scroll to it and move focus there (to the page's heading when
  // the refusal is a banner with no field — the banners sit at the top) — the Save bar is pinned, so on a long page the
  // refusal would otherwise be out of sight (B7 T23 review m5). The modal opens the section only, as it always has.
  function reveal(sectionId: SectionId | null) {
    if (sectionId) setOpenSections((prev) => (prev[sectionId] ? prev : { ...prev, [sectionId]: true }));
    if (layout === "page") revealSection(sectionId ? sectionAnchor(sectionId, division.division_id) : headingId);
  }

  // The latest save, for a host that saves from outside (T24's tab close): refreshed after every render, emptied on unmount.
  // It sends only the half that changed (re-review m3): a close must not fail on a request that carried nothing.
  useEffect(() => {
    if (!saveHandleRef) return;
    saveHandleRef.current = { save: () => saveOnce(true) };
    return () => {
      saveHandleRef.current = null;
    };
  });

  // The page layout's Cancel: every field back to the saved values, and the in-progress drafts the state never holds (the
  // fee text, a half-typed clock) with them — or the inputs would keep showing what was just discarded.
  function cancelEdits() {
    reset();
    setFeeText(null);
    setSoloFeeText(null);
    setDtDrafts({});
    setClientErrors({});
  }

  const page = layout === "page";

  const notices = (
    <>
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
    </>
  );

  const sections =
    state &&
    SECTION_IDS.map((id) => {
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
            individualOnly={division.individual_only === true}
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
            individualOnly={division.individual_only === true}
            entryShapeLegacy={readOnly!.storedEntryShapeLegacy}
            allowedKinds={division.allowed_kinds}
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
          page={
            page
              ? {
                  anchorId: sectionAnchor(id, division.division_id),
                  alwaysOpen: wide,
                  changedLabel: dirty.sections.includes(id) ? msg("reg.config.changed") : null,
                }
              : undefined
          }
          // Reads `e.target`, NOT `e.currentTarget`. <details> fires a
          // native `toggle` event, and the three sections that mount
          // with open={true} fire it synchronously while React is
          // still committing — `currentTarget` is only bound for the
          // duration of the dispatch, so by the time this handler ran
          // it was null and every first Configure click crashed the
          // page with "Cannot read properties of null (reading
          // 'open')". `target` is the <details> element itself here
          // and stays valid.
          onToggle={(e) => {
            setOpenSections((prev) => ({
              ...prev,
              [id]: (e.target as HTMLDetailsElement).open,
            }));
          }}
        >
          {content}
        </Disclosure>
      );
    });

  if (page) {
    const sectionTitles = Object.fromEntries(
      SECTION_IDS.map((id) => [id, id === "form" ? msg("reg.settings.signupForm") : sectionTitle(id, msg, 0)]),
    ) as Record<SectionId, string>;
    // A save that did not go through (refused on the page, or by the server) while edits are still unsaved: the bar says so in
    // place of the count, until the next save or Cancel. Clean wins — once nothing is unsaved, "All changes saved" is true.
    // The page's own refusal sent nothing, which the line says (re-review m8); a server failure may have saved half.
    const refusedHere = Object.keys(clientErrors).length > 0;
    const saveFailed = (saveOutcome !== null && saveOutcome !== "success") || refusedHere;
    const barState: SaveBarState = !dirty.dirty ? "clean" : saveFailed ? "failed" : "dirty";
    return (
      <section
        data-registration-hub-config-panel
        data-layout="page"
        data-division-id={division.division_id}
        data-save-outcome={saveOutcome ?? undefined}
        aria-labelledby={headingId}
        // While the page is in the document, the viewport's bottom 9rem is the pinned Save bar's (at most 129px tall: 320 wide,
        // the failed save's line wrapped in French — measured in Chromium). As SCROLL PADDING on the root scroller, a control
        // brought into view by focus (Tab, a tap, a failed save's reveal) stops above the bar instead of under it, which the
        // browser would otherwise count as visible (WCAG 2.4.11). On the root, not as a margin on each control: Chromium reveals
        // a focused textarea by its caret, which ignores the control's own scroll margin. Plus the home-indicator inset the bar
        // pads itself by below md (re-review m6).
        className="min-w-0 space-y-4 [html:has(&)]:scroll-pb-[calc(9rem+env(safe-area-inset-bottom))]"
      >
        {/* tabIndex -1: where focus goes after a save refused by a banner (they sit just below). */}
        <h2
          id={headingId}
          tabIndex={-1}
          className="scroll-mt-[calc(var(--app-header-h)+1rem)] break-words rounded-sm text-lg font-semibold text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
        >
          {division.name}
        </h2>
        {notices}
        {state && (
          <div className="md:grid md:grid-cols-[10rem_minmax(0,1fr)] md:items-start md:gap-6">
            <ConfigSectionIndex
              divisionId={division.division_id}
              label={msg("reg.config.sectionIndex")}
              titles={sectionTitles}
              changed={dirty.sections}
              changedLabel={msg("reg.config.changed")}
            />
            <div className="min-w-0 space-y-3">{sections}</div>
          </div>
        )}
        {state && (
          <ConfigSaveBar
            state={barState}
            status={
              barState === "clean"
                ? msg("reg.config.allSaved")
                : barState === "failed"
                  ? msg(refusedHere ? "reg.config.saveRefused" : "reg.config.saveFailed")
                  : msgPlural("reg.config.unsaved", dirty.count)
            }
            busy={busy}
            cancelLabel={msg("reg.hub.config.cancel")}
            saveLabel={busy ? msg("reg.hub.config.saving") : msg("reg.hub.config.save")}
            onCancel={cancelEdits}
            onSave={() => saveOnce(false)}
          />
        )}
      </section>
    );
  }

  return (
    <Modal
      title={msg("reg.hub.config.title", { name: division.name })}
      onClose={onClose!}
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
              onClick={() => saveOnce(false)}
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
        {notices}
        {sections}
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
// screenshots: "Eligibility" above "Eligibility"). `sectionTitle` (registration-hub-config-section.tsx) is the
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
  individualOnly = false,
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
  /** Chess (owner ruling 2026-10-26): no solo sign-up pool, whatever the state holds. */
  individualOnly?: boolean;
}) {
  const isTeam = state.entrant_kind === "team" && !individualOnly;
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
  individualOnly = false,
  entryShapeLegacy = false,
  allowedKinds,
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
  /** Chess (owner ruling 2026-10-26): Individual is the only entrant type offered, with the reason beside it. */
  individualOnly?: boolean;
  /** The stored settings still hold a pair/team/solo-pool shape from before the ruling (seeded as Individual here). */
  entryShapeLegacy?: boolean;
  /** FU1: the division's allowed entrant kinds - the only ones the select offers. */
  allowedKinds: readonly EntrantKindValue[];
}) {
  // A short, DST-correct abbreviation ("BST", "IST") rather than the raw
  // IANA string — matches the zone labelling the row already shows
  // (registration-hub-row-derive.ts's formatRegistrationWindow).
  const zone = fmtZoneAbbrev(orgTz, new Date());
  const timeLabel = msg("datetime.timeLabel");
  // FU1: offer exactly the kinds the division takes (chess keeps its own locked Individual). A stored kind outside them -
  // a row saved before this check, or the division's Entrant kinds narrowed since - is NOT swapped for a valid one behind
  // the organiser's back: it stays selected, marked as not allowed, with the way out beside it, and a save is refused
  // until they pick an offered kind.
  const offeredKinds: readonly EntrantKindValue[] = individualOnly
    ? ["individual"]
    : KIND_OPTION_ORDER.filter((k) => divisionTakesKind(allowedKinds, k));
  const storedKindRefused = !individualOnly && !divisionTakesKind(allowedKinds, state.entrant_kind);
  const storedKindName = msg(`divset.entrants.kind.${state.entrant_kind}`);
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
      <div>
        <label className="label">
          {msg("reg.settings.entrantType")}
          <select
            data-field="entrant_kind"
            className={`input min-h-11 mt-1${storedKindRefused ? " border-amber-400" : ""}`}
            value={state.entrant_kind}
            disabled={individualOnly}
            // FU1 fix round 2: a refused kind is an invalid value the save will not take; the hint below says why. Wired by
            // describedby (not nested in the label) so the select's NAME stays "Entrant type".
            aria-invalid={storedKindRefused || undefined}
            aria-describedby={storedKindRefused ? ENTRANT_KIND_HINT_ID : undefined}
            onChange={(e) => {
              const v = e.target.value as RegistrationConfigState["entrant_kind"];
              // Team-only setting (server 422s otherwise) — clear it locally
              // the moment the division stops being a team division, so the
              // organiser never hits a preventable error.
              patch({ entrant_kind: v, allow_free_agents: v === "team" ? state.allow_free_agents : false });
            }}
          >
            {/* FU1 fix round 1 (m6): the option shows the kind's own word only. "(not allowed)" beside it was measured not
                to fit this select at 320 in ANY locale (en needs 219px of a 202px control; nl far more), and a select cannot
                wrap. The reason is the amber hint directly beneath (the select's description); the full sentence stays the
                option's accessible name for the open picker. */}
            {storedKindRefused && (
              <option
                value={state.entrant_kind}
                disabled
                aria-label={msg("reg.settings.entrant.notAllowedOption", { kind: storedKindName })}
              >
                {storedKindName}
              </option>
            )}
            {/* FU1 fix round 2: every option's visible text must fit the 202px select at 320 in every locale (measured by
                the walkthrough), so "Individual" is the kind's word alone; "(creates a player)" stays its accessible name. */}
            {offeredKinds.map((k) => (
              <option
                key={k}
                value={k}
                aria-label={k === "individual" ? msg("reg.settings.entrant.individualAria") : undefined}
              >
                {msg(`reg.settings.entrant.${k}`)}
              </option>
            ))}
          </select>
          {individualOnly && (
            <span data-testid="entrant-kind-individual-only" className="mt-1 block text-xs font-normal text-slate-500">
              {msg("reg.settings.entrant.chessOnly")}
            </span>
          )}
          {individualOnly && entryShapeLegacy && (
            <span
              data-testid="entrant-kind-legacy"
              role="status"
              className="mt-1 block rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-normal text-amber-800"
            >
              {msg("reg.settings.entrant.chessLegacy")}
            </span>
          )}
        </label>
        {storedKindRefused && (
          <p
            id={ENTRANT_KIND_HINT_ID}
            data-testid="entrant-kind-not-allowed"
            role="status"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            {msg("reg.settings.entrant.notAllowedHint", { kind: storedKindName })}
          </p>
        )}
        {errors.entrant_kind && (<p data-field-error="entrant_kind" role="alert" className="mt-1 text-xs text-red-600">{errors.entrant_kind}</p>)}
      </div>
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
   *  now. `promoteWaitlistedRow` (usecases/registrations/waitlist.ts) reads the LIVE
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
  // (usecases/registrations/), and an offline entry has no payment intent, so
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
