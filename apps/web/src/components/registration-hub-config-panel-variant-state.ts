"use client";

// TEMP(RS004 variants) — shared fetch/patch/save state for config-panel
// variants B (registration-hub-config-panel-b.tsx, accordion) and C
// (registration-hub-config-panel-c.tsx, tabs). Extracted so the two
// variants — which differ ONLY in how they arrange the same fields, never
// in what they fetch or send — don't carry two copies of the identical
// Promise.allSettled dual-save logic.
//
// Variant A (registration-hub-config-panel.tsx) does NOT use this hook and
// is not touched by this file — it keeps its own inline copy of the same
// shape. That duplication is deliberate: A is the control and must stay
// exactly what it was before this task; this hook exists only for the two
// NEW variants, both of which are deleted alongside it once the owner
// picks a direction (see registration-hub-variant.ts).
//
// Byte-for-byte the same behaviour as variant A's inline logic: same GET
// endpoint, same initialConfigState/toDivisionPatchBody/
// toRegistrationSettingsPutBody builders, same Promise.allSettled dual
// save, same mapSaveError reconciliation, same saveOutcome naming (RS004
// review finding 1 — named by what FAILED, so the two partial states read
// naturally at call sites).
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

/** Outcome of the two save requests, named by what FAILED — same shape and
 *  reasoning as variant A's own (private) SaveOutcome type. */
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

  // No reset of loaded/loadError here, same as variant A: the mount site
  // keys this component by division id, so a different row arrives as a
  // REMOUNT with useState's own initial null — resetting synchronously
  // inside the effect instead is a cascading render (react-hooks lint).
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
      return;
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
