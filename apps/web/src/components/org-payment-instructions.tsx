"use client";

// Org payments card (spec 2026-07-12 §8): Stripe Connect status + onboarding,
// the org's default payment method for new divisions, and the org-wide
// offline instructions (divisions can override both per-division).
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/client";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { ProseEditor } from "@/components/prose-editor";
import { useMsg } from "@/components/i18n/dict-provider";

type Msg = ReturnType<typeof useMsg>;

/** The copy an owner reads when CONNECT ONBOARDING is refused.
 *
 *  Keyed on STATUS, never on the server's sentence — every message behind
 *  these statuses is server-authored English, and rendering one put
 *  untranslated copy on a money screen in all four locales.
 *
 *  Two different rules decide the rows, which is why this is not one generic:
 *
 *   - A refusal that tells the owner what to DO, or WHO to ask, keeps that
 *     actionability as a translated key saying the same thing. The 422 is the
 *     one refusal here an owner can clear unaided ("tick the box"), so
 *     collapsing it into "something went wrong" would be a REGRESSION.
 *   - A refusal that only means "it did not work" gets the generic. 404
 *     ("organization not found") is one of those: true, and useless.
 *
 *  Reads `status` rather than `code` because the v1 envelope collapses 500
 *  and 502 onto the same code (`INTERNAL`) — see server/api-v1/http.ts.
 *  Statuses not named here (400 from `parseBody`/`assertUuid`, 429 from the
 *  API-key limiter, 500) are developer- or integration-facing and land on the
 *  generic by design. */
function onboardingCopy(err: unknown, msg: Msg): string {
  if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") return msg("pay.needPro");
  const status = err instanceof ApiV1Error ? err.status : 0;
  switch (status) {
    // "Agree to the Terms of Service (entry-fee chargebacks) before
    // connecting Stripe" — the gate in createConnectOnboardingLink.
    case 422:
      return msg("pay.connectTosFirst");
    // Both of the use-case's 403s ("Wrong organization", "Only the org owner
    // can manage Stripe Connect") and requireOrgAuth's "Insufficient
    // permissions". All three mean the same thing to a human: you are not the
    // owner, and an owner has to do this.
    case 403:
      return msg("pay.connectOwnerOnly");
    default:
      return msg("pay.onboardErr");
  }
}

/** The copy an organiser reads when SAVING the payments card is refused.
 *
 *  Same rule, different statuses — these two writes go to the legacy
 *  `/api/orgs/{id}` envelope, whose handler maps AuthError onto 401 rather
 *  than 403 (lib/http.ts), so "not allowed" arrives as 401 here. */
function saveCopy(err: unknown, msg: Msg): string {
  const status = err instanceof ApiError ? err.status : 0;
  switch (status) {
    // requireOrgRole's AuthError — signed out, not a member, or a member
    // without an editor role. One sentence covers all three honestly, and it
    // names who to ask.
    case 401:
      return msg("pay.saveNotAllowed");
    // "Stripe is not ready to accept charges yet" — the server's half of the
    // rule the radio already enforces client-side, so this is the state a
    // stale page lands in. Actionable: finish verification. (The route's
    // other 409, the settlement-currency lock, is a different field and is
    // not reachable from this card.)
    case 409:
      return msg("pay.methodNeedsCharges");
    default:
      return msg("pay.saveFailed");
  }
}

interface ConnectStatus {
  connected: boolean;
  charges_enabled: boolean;
  details_submitted: boolean | null;
  payouts_enabled: boolean;
  disabled_reason: string | null;
  requirements_due: number;
}

export function OrgPaymentInstructions({
  orgId,
  initialValue,
  initialDefaultMethod = "offline",
  chargesEnabled = false,
  isOwner = false,
}: {
  orgId: string;
  initialValue: string | null;
  initialDefaultMethod?: "offline" | "stripe";
  chargesEnabled?: boolean;
  isOwner?: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialValue ?? "");
  const [method, setMethod] = useState<"offline" | "stripe">(initialDefaultMethod);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [dashBusy, setDashBusy] = useState(false);
  const [tosAgreed, setTosAgreed] = useState(false);
  const dirty = value.trim() !== (initialValue ?? "").trim();

  // Connect status is owner-only server-side; returning from Stripe
  // onboarding (?connect=return) forces a live re-read (reconcile-on-return).
  useEffect(() => {
    if (!isOwner) return;
    const refresh = searchParams.get("connect") === "return" ? "?refresh=1" : "";
    apiV1<ConnectStatus>(`/api/v1/orgs/${orgId}/connect${refresh}`)
      .then(setConnect)
      .catch(() => setConnect(null));
  }, [orgId, isOwner, searchParams]);

  async function saveInstructions() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/api/orgs/${orgId}`, {
        method: "PATCH",
        json: { payment_instructions: value.trim() || null },
      });
      setSaved(true);
      router.refresh();
    } catch (err) {
      console.error("save payment instructions failed", err);
      setError(saveCopy(err, msg));
    } finally {
      setBusy(false);
    }
  }

  async function saveMethod(next: "offline" | "stripe") {
    const prev = method;
    setMethod(next);
    try {
      await api(`/api/orgs/${orgId}`, {
        method: "PATCH",
        json: { default_payment_method: next },
      });
      router.refresh();
    } catch (err) {
      setMethod(prev);
      console.error("save default payment method failed", err);
      setError(saveCopy(err, msg));
    }
  }

  async function startOnboarding() {
    setConnectBusy(true);
    setConnectError(null);
    try {
      const { url } = await apiV1<{ url: string }>(`/api/v1/orgs/${orgId}/connect`, {
        method: "POST",
        json: { return_path: "/settings/connect", tos_agreed: tosAgreed },
      });
      window.location.assign(url);
    } catch (err) {
      // The server's sentence is never what the owner reads — onboardingCopy
      // above picks a translated key per status, and the English goes here.
      console.error("connect onboarding failed", err);
      setConnectError(onboardingCopy(err, msg));
      setConnectBusy(false);
    }
  }

  // Express Dashboard: payouts, charge history, and Stripe's own
  // "more information needed" prompts. Links are one-time — mint per click.
  // Opens a NEW tab so the console stays put; the window is opened
  // synchronously (inside the click) so popup blockers allow it, then
  // pointed at the minted URL.
  async function openDashboard() {
    setDashBusy(true);
    setConnectError(null);
    const win = window.open("about:blank", "_blank");
    try {
      const { url } = await apiV1<{ url: string }>(
        `/api/v1/orgs/${orgId}/connect/dashboard`,
        { method: "POST" },
      );
      if (win) win.location.href = url;
      else window.location.assign(url); // popup denied — same tab beats nothing
      setDashBusy(false);
    } catch (err) {
      win?.close();
      // Never surface Stripe's raw error (it names the platform key and
      // account id) — human copy only; the detail stays in the console.
      console.error("connect dashboard link failed", err);
      setConnectError(msg("pay.dashErr"));
      setDashBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Setup panels — Stripe onboarding (owners only), then the org's own
          cash/bank instructions, each its own full-width row. Two independent
          things to configure; the actual default-method choice lives in the
          fieldset below. */}
      {isOwner && (
        <div data-tour="connect-stripe" className="rounded-lg border border-slate-200 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-slate-800">{msg("pay.cardTitle")}</p>
              <p className="mt-0.5 text-xs text-slate-500">{msg("pay.cardBlurb")}</p>
            </div>
            {connect?.charges_enabled ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
                {msg("pay.statusLive")}
              </span>
            ) : connect?.connected ? (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
                {msg("pay.statusIncomplete")}
              </span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                {msg("pay.statusNone")}
              </span>
            )}
          </div>
          {/* Health mirror (P1-8): a connected account can silently lose
              payouts (verification lapse) while charges keep landing. Surface
              it so the owner resumes onboarding before Stripe support has to. */}
          {connect?.connected &&
            (!connect.payouts_enabled || connect.requirements_due > 0) && (
              <div
                data-testid="connect-attention"
                className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4"
              >
                <p className="text-sm font-semibold text-amber-800">
                  {msg("connect.attention.title")}
                </p>
                <p className="mt-1 text-xs text-amber-700">{msg("connect.attention.body")}</p>
              </div>
            )}
          {/* What connecting involves — the three stops on the way to taking
              card entry fees, with the current one highlighted. */}
          <ol className="mt-3 space-y-2">
            {[
              {
                label: msg("pay.stepConnect"),
                detail: msg("pay.stepConnectDetail"),
                done: !!connect?.connected,
                active: !connect?.connected,
              },
              {
                label: msg("pay.stepVerify"),
                detail: msg("pay.stepVerifyDetail"),
                done: !!connect?.charges_enabled,
                active: !!connect?.connected && !connect?.charges_enabled,
              },
              {
                label: msg("pay.stepGoLive"),
                detail: msg("pay.stepGoLiveDetail"),
                done: !!connect?.charges_enabled,
                active: !!connect?.charges_enabled,
              },
            ].map((step, i) => (
              <li key={step.label} className="flex items-start gap-2.5">
                <span
                  className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                    step.done
                      ? "bg-emerald-100 text-emerald-700"
                      : step.active
                        ? "bg-purple-100 text-purple-700"
                        : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {step.done ? "✓" : i + 1}
                </span>
                <p className="text-xs leading-5 text-slate-500">
                  <span
                    className={`font-medium ${
                      step.active ? "text-purple-700" : "text-slate-700"
                    }`}
                  >
                    {step.label}
                  </span>{" "}
                  — {step.detail}
                </p>
              </li>
            ))}
          </ol>
          {/* ToS gate (PROMPT-55): the first connect creates the Express
              account, so the chargeback clause is accepted before it exists.
              Resuming an existing onboarding never re-asks. */}
          {!connect?.charges_enabled && !connect?.connected && (
            <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-600">
              <input
                type="checkbox"
                checked={tosAgreed}
                onChange={(e) => setTosAgreed(e.target.checked)}
                className="mt-0.5 accent-purple-600"
              />
              <span>
                {msg("pay.tosAgree")
                  .split("{terms}")
                  .flatMap((part, i) =>
                    i === 0
                      ? [part]
                      : [
                          <a
                            key="terms"
                            href="/legal/terms"
                            target="_blank"
                            rel="noreferrer"
                            className="text-purple-600 underline"
                          >
                            {msg("pay.tosTerms")}
                          </a>,
                          part,
                        ],
                  )}
              </span>
            </label>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Onboarding CTA — also shown on a LIVE account when Stripe wants
                more info (requirements due / payouts paused): the same
                account_onboarding link collects whatever is currently due. */}
            {(!connect?.charges_enabled ||
              !connect.payouts_enabled ||
              connect.requirements_due > 0) && (
              <button
                type="button"
                onClick={startOnboarding}
                disabled={connectBusy || (!connect?.connected && !tosAgreed)}
                className="btn btn-primary px-4 text-sm"
              >
                {connectBusy
                  ? msg("pay.opening")
                  : !connect?.connected
                    ? msg("pay.connect")
                    : connect.charges_enabled
                      ? msg("pay.finishVerification")
                      : msg("pay.resume")}
              </button>
            )}
            {/* Payouts, charge history, account details — Stripe-hosted. */}
            {connect?.connected && (
              <button
                type="button"
                onClick={openDashboard}
                disabled={dashBusy}
                className="btn btn-ghost px-4 text-sm"
                data-testid="connect-dashboard"
              >
                {dashBusy ? msg("pay.opening") : msg("pay.openDashboard")}
              </button>
            )}
          </div>
          {connectError && <p className="mt-2 text-xs text-red-600">{connectError}</p>}
        </div>
      )}

      {/* Org-wide offline instructions. */}
      <div className="rounded-lg border border-slate-200 p-4">
        <span className="label">{msg("pay.cashTitle")}</span>
        <p className="mb-2 text-xs text-slate-500">
          {msg("pay.cashHintPre")}
          <code className="rounded bg-slate-100 px-1">{"{{reference}}"}</code>
          {msg("pay.cashHintPost")}
        </p>
        <ProseEditor
          value={value}
          onChange={(md) => {
            setValue(md);
            setSaved(false);
          }}
          orgId={orgId}
          placeholder={"Bank: Example Bank\nAccount name: Riverside FC\nSort code: 00-00-00\nAccount no: 12345678\nReference: {{reference}}"}
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={saveInstructions}
            disabled={busy || !dirty}
            className="btn btn-primary px-4"
          >
            {busy ? msg("pay.saving") : msg("pay.save")}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
          {saved && !error && (
            <span className="text-xs text-green-600">{msg("pay.saved")}</span>
          )}
        </div>
      </div>

      {/* Default method for new divisions. */}
      <fieldset>
        <legend className="label">{msg("pay.methodLegend")}</legend>
        <p className="mb-2 text-xs text-slate-500">{msg("pay.methodHint")}</p>
        <div className="flex gap-2">
          {(
            [
              { key: "offline", label: msg("pay.methodOffline"), disabled: false },
              { key: "stripe", label: msg("pay.methodStripe"), disabled: !chargesEnabled },
            ] as const
          ).map((opt) => (
            <label
              key={opt.key}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                opt.disabled
                  ? "cursor-not-allowed border-slate-200 text-slate-400"
                  : method === opt.key
                    ? "cursor-pointer border-purple-300 bg-purple-50 text-slate-900"
                    : "cursor-pointer border-slate-200 text-slate-600 hover:border-slate-300"
              }`}
            >
              <input
                type="radio"
                name="org_default_method"
                data-testid={`method-${opt.key}`}
                checked={method === opt.key}
                disabled={opt.disabled}
                onChange={() => void saveMethod(opt.key)}
              />
              {opt.label}
            </label>
          ))}
        </div>
        {!chargesEnabled && (
          <p className="mt-2 text-xs text-slate-500">{msg("pay.methodStripeNeedsConnect")}</p>
        )}
      </fieldset>
    </div>
  );
}
