"use client";

// Registration hub config panel — fetch/patch/save state (RS004 W3c/W4).
// Extracted out of the panel component itself so the state machine (GET on
// mount, local edits, the two-endpoint dual save, error reconciliation) is
// independently reason-about-able from the accordion chrome around it.
//
// Same GET endpoint, same initialConfigState/toDivisionPatchBody/
// toRegistrationSettingsPutBody builders, same Promise.allSettled dual
// save, same mapSaveError reconciliation, same saveOutcome naming (RS004
// review finding 1 — named by what FAILED, so the two partial states read
// naturally at call sites) as the panel always had.
import { useEffect, useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import {
  asIndividualOnly,
  holdsNonIndividualEntry,
  initialConfigState,
  toDivisionPatchBody,
  toRegistrationSettingsPutBody,
  type DivisionEligibility,
  type EntrantKindValue,
  type RegistrationConfigState,
  type RegistrationSettingsResponse,
} from "@/components/registration-hub-config-state";
import { mapSaveError, type ConfigFieldKey } from "@/components/registration-hub-save-error";

export interface RegistrationHubConfigDivisionLike extends DivisionEligibility {
  division_id: string;
  name: string;
  /** Chess (owner ruling 2026-10-26): the panel offers individual entry only. Optional so a caller that predates
   *  the ruling reads as "not restricted"; the page sets it from the division's sport. */
  individual_only?: boolean;
  /** FU1: the division's allowed entrant kinds (its effective entrant model, resolved on the server). The entrant-type
   *  select offers exactly these, and a stored kind outside them is shown as not allowed. Required, so a mount that forgets
   *  to pass it fails the typecheck rather than silently offering every kind. */
  allowed_kinds: readonly EntrantKindValue[];
}

/** Outcome of the two save requests, named by what FAILED. */
export type SaveOutcome = "success" | "patch-failed" | "put-failed" | "both-failed";

/** What the GET response carries but is never sent back on save. */
export interface ReadOnlyEcho {
  chargesEnabled: boolean;
  orgPaymentInstructions: string | null;
  /** An individual-only (chess) division whose STORED settings still hold a pair/team/solo-pool shape from before the
   *  ruling: the panel seeds individual and says that saving moves it. */
  storedEntryShapeLegacy: boolean;
}

interface Loaded {
  state: RegistrationConfigState;
  readOnly: ReadOnlyEcho;
  /** B7 T23: what the server holds as far as this editor knows — the row it loaded, AS STORED, moved forward by each request
   *  that LANDED, to what that request sent. The dirty check (use-config-dirty.ts) compares `state` against this, and
   *  `reset()` returns to it. Never the props the panel mounted with: after a save those are stale until the page refetches.
   *  As stored, not as seeded: a chess division's legacy team/pair/solo row is seeded individual, and that difference is an
   *  unsaved change until a save moves the row (B7 T23 review m2). */
  saved: RegistrationConfigState;
}

/** What one save did: the outcome, named by what failed, and the field errors it produced (empty when it succeeded). */
export interface SaveResult {
  outcome: SaveOutcome;
  errors: Partial<Record<ConfigFieldKey, string>>;
}

export function useRegistrationConfigPanelState(
  division: RegistrationHubConfigDivisionLike,
  onSaved: () => void,
  /** Localises a refusal code the server only words in English (see mapSaveError); null = show the server's text. */
  localiseCode?: (code: string) => string | null,
) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<ConfigFieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome | null>(null);

  // No reset of loaded/loadError here: the mount site keys this component
  // by division id, so a different row arrives as a REMOUNT with useState's
  // own initial null — resetting synchronously inside the effect instead is
  // a cascading render (react-hooks lint).
  useEffect(() => {
    let cancelled = false;
    apiV1<RegistrationSettingsResponse>(`/api/v1/divisions/${division.division_id}/registration-settings`)
      .then((data) => {
        if (cancelled) return;
        const individualOnly = division.individual_only === true;
        setLoaded({
          state: initialConfigState(data, division, individualOnly),
          saved: initialConfigState(data, division),
          readOnly: {
            chargesEnabled: data.charges_enabled,
            orgPaymentInstructions: data.org_payment_instructions,
            storedEntryShapeLegacy: individualOnly && holdsNonIndividualEntry(data),
          },
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

  /** Resolves with what the save did (null: nothing loaded, nothing sent).
   *  Returned rather than only stored so a caller can act on the failure at
   *  the moment it happens; reacting to the `errors` STATE in an effect
   *  instead is a cascading render, and lint rejects it. */
  async function save(): Promise<SaveResult | null> {
    if (!loaded) return null;
    setBusy(true);
    setErrors({});
    setFormError(null);
    setSaveOutcome(null);
    const patchBody = toDivisionPatchBody(loaded.state);
    const putBody = toRegistrationSettingsPutBody(loaded.state);
    const [patchResult, putResult] = await Promise.allSettled([
      apiV1(`/api/v1/divisions/${division.division_id}`, { method: "PATCH", json: patchBody }),
      apiV1(`/api/v1/divisions/${division.division_id}/registration-settings`, {
        method: "PUT",
        json: putBody,
      }),
    ]);
    setBusy(false);
    const patchOk = patchResult.status === "fulfilled";
    const putOk = putResult.status === "fulfilled";
    // Each body that landed is now what the server holds: move the saved values to what it SENT. Per body, because a partial
    // save is half saved — keeping the landed half "unsaved" would let Cancel restore values the server no longer has, and the
    // next save would quietly undo it. What was SENT, not the current draft: an edit typed while the save was in flight is
    // still unsaved.
    if (patchOk || putOk) {
      setLoaded((prev) =>
        prev
          ? { ...prev, saved: { ...prev.saved, ...(patchOk ? patchBody : {}), ...(putOk ? putBody : {}) } }
          : prev,
      );
    }
    if (patchOk && putOk) {
      setSaveOutcome("success");
      onSaved();
      return { outcome: "success", errors: {} };
    }
    const nextErrors: Partial<Record<ConfigFieldKey, string>> = {};
    let banner: string | null = null;
    for (const result of [patchResult, putResult]) {
      if (result.status !== "rejected") continue;
      const info = mapSaveError(result.reason);
      const text = (info.code ? localiseCode?.(info.code) : null) ?? info.message;
      if (info.field) nextErrors[info.field] = text;
      else banner = text;
    }
    const outcome: SaveOutcome = patchOk === putOk ? "both-failed" : patchOk ? "put-failed" : "patch-failed";
    setErrors(nextErrors);
    setFormError(banner);
    setSaveOutcome(outcome);
    return { outcome, errors: nextErrors };
  }

  /** B7 T23 (the page layout's Cancel): every field back to the saved values, and the outcome of the last save with them —
   *  its banner and field errors were about the edits just discarded. An individual-only division returns to the saved values
   *  in the one shape it takes, never to a legacy row's team/pair/solo shape the server refuses (so Cancel on such a row
   *  leaves it unsaved: the row itself has not moved). */
  function reset() {
    const individualOnly = division.individual_only === true;
    setLoaded((prev) => (prev ? { ...prev, state: individualOnly ? asIndividualOnly(prev.saved) : prev.saved } : prev));
    setErrors({});
    setFormError(null);
    setSaveOutcome(null);
  }

  return {
    state: loaded?.state ?? null,
    saved: loaded?.saved ?? null,
    readOnly: loaded?.readOnly ?? null,
    loadError,
    busy,
    errors,
    formError,
    saveOutcome,
    patch,
    save,
    reset,
  };
}
