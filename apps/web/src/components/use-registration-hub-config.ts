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
  initialConfigState,
  toDivisionPatchBody,
  toRegistrationSettingsPutBody,
  type DivisionEligibility,
  type RegistrationConfigState,
  type RegistrationSettingsResponse,
} from "@/components/registration-hub-config-state";
import { mapSaveError, type ConfigFieldKey } from "@/components/registration-hub-save-error";

export interface RegistrationHubConfigDivisionLike extends DivisionEligibility {
  division_id: string;
  name: string;
}

/** Outcome of the two save requests, named by what FAILED. */
export type SaveOutcome = "success" | "patch-failed" | "put-failed" | "both-failed";

/** What the GET response carries but is never sent back on save. */
export interface ReadOnlyEcho {
  chargesEnabled: boolean;
  orgPaymentInstructions: string | null;
}

interface Loaded {
  state: RegistrationConfigState;
  readOnly: ReadOnlyEcho;
}

export function useRegistrationConfigPanelState(
  division: RegistrationHubConfigDivisionLike,
  onSaved: () => void,
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

  /** Resolves with the field errors this save produced — empty when it
   *  succeeded. Returned rather than only stored so a caller can act on the
   *  failure at the moment it happens; reacting to the `errors` STATE in an
   *  effect instead is a cascading render, and lint rejects it. */
  async function save(): Promise<Partial<Record<ConfigFieldKey, string>>> {
    if (!loaded) return {};
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
    if (patchOk && putOk) {
      setSaveOutcome("success");
      onSaved();
      return {};
    }
    const nextErrors: Partial<Record<ConfigFieldKey, string>> = {};
    let banner: string | null = null;
    for (const result of [patchResult, putResult]) {
      if (result.status !== "rejected") continue;
      const info = mapSaveError(result.reason);
      if (info.field) nextErrors[info.field] = info.message;
      else banner = info.message;
    }
    setErrors(nextErrors);
    setFormError(banner);
    setSaveOutcome(patchOk === putOk ? "both-failed" : patchOk ? "put-failed" : "patch-failed");
    return nextErrors;
  }

  return {
    state: loaded?.state ?? null,
    readOnly: loaded?.readOnly ?? null,
    loadError,
    busy,
    errors,
    formError,
    saveOutcome,
    patch,
    save,
  };
}
