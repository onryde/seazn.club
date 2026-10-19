"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client";
import { AuthForm } from "@/components/auth-form";
import { LegalNotice } from "@/components/legal-notice";
import { useMsg } from "@/components/i18n/dict-provider";

/**
 * One-tap claim for a visitor who is NOT signed in, opened from the invite EMAIL
 * (`/claim/[token]` with the secret that only ever went into that mail). The
 * link proves the inbox, so the tap signs the invitee in and claims the profile
 * together — see claimByEmailLink in server/usecases/person-claims.ts.
 *
 * It is a button, not something that fires on load: mail scanners and link
 * previews open links, and a sign-in must wait for a person. `email` is the
 * invited address already masked by the page, shown so the person can see
 * which account they are about to be signed in as.
 *
 * The page decided this card was right when it LOADED; the link's one-tap power
 * is time-limited (CLAIM_EMAIL_SIGNIN_MS), so a tap can land after it ended. The
 * server — which owns the clock — answers that with CLAIM_SIGNIN_EXPIRED, and the
 * card turns, in place, into the normal sign-in the console link gets (coming
 * back to this claim page once signed in): no reload, no raw refusal.
 */
export function ClaimSignIn({ token, email }: { token: string; email: string }) {
  const msg = useMsg();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);

  async function claim() {
    // A second tap while the first is in flight would only meet the server's
    // "already claimed" answer; the disabled button below stops it earlier.
    setError(null);
    setBusy(true);
    try {
      const out = await api<{ redirect: string }>(`/api/claims/${token}/accept`, { method: "POST" });
      router.push(out.redirect);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "CLAIM_SIGNIN_EXPIRED") {
        setExpired(true);
        setBusy(false);
        return;
      }
      setError(err instanceof Error && err.message ? err.message : msg("claim.signin.failed"));
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <>
        <p role="status" className="mb-4 text-center text-sm text-cream/70">
          {msg("claim.signin.expired")}
        </p>
        <AuthForm next={`/claim/${token}`} />
      </>
    );
  }

  return (
    <div className="card p-6">
      <p className="mb-4 min-w-0 break-words text-sm text-slate-600">
        {msg("claim.signin.invited", { email })}
      </p>
      <button onClick={claim} disabled={busy} className="btn btn-primary min-h-11 w-full py-2.5">
        {busy ? msg("claim.signin.busy") : msg("claim.signin.cta")}
      </button>
      <p className="mt-3 text-center text-xs text-slate-500">{msg("claim.signin.hint")}</p>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      <LegalNotice className="mt-4 text-center" />
    </div>
  );
}
