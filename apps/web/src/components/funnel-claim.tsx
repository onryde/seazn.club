"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { ApiError, api } from "@/lib/client";
import { FUNNEL_CLAIM_INVALID, FUNNEL_CLAIM_SIGNED_IN } from "@/lib/funnel-claim-codes";

/** Where a claim that did not land leaves the visitor. `signedIn` is the one the route names after it set the session:
 *  the event may be partly built and the token is spent, so the way on is the dashboard. Everything else is signed out. */
type Failure = "missing" | "invalid" | "failed" | "signedIn";

/** The route names its two refusals with a `code`; anything else (a 5xx before the session, a limiter, the network) is
 *  the generic failure. The route's English `error` is never shown — the card words every state from the dictionary. */
function failureOf(e: unknown): Exclude<Failure, "missing"> {
  if (e instanceof ApiError && e.code === FUNNEL_CLAIM_SIGNED_IN) return "signedIn";
  if (e instanceof ApiError && e.code === FUNNEL_CLAIM_INVALID) return "invalid";
  return "failed";
}

/** Consumes a funnel draft token: signs the visitor in, creates the drafted
 *  competition, and routes inside it (v3/07 §6). Mirrors <MagicLink>. */
export function FunnelClaim({ token }: { token: string | null }) {
  const router = useRouter();
  const msg = useMsg();
  const [status, setStatus] = useState<"working" | "ok" | Failure>("working");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) return; // nothing to claim — the error is derived below
    api<{ redirect: string }>("/api/funnel/claim", {
      method: "POST",
      json: { token },
    })
      .then((res) => {
        setStatus("ok");
        router.push(res.redirect || "/dashboard");
        router.refresh();
      })
      .catch((e: unknown) => setStatus(failureOf(e)));
  }, [token, router]);

  // No token is known on the very first render (the server's included): show
  // the error straight away instead of a "Creating…" frame an effect replaces.
  const shown: "working" | "ok" | Failure = token ? status : "missing";

  return (
    <div className="card p-6 text-center" data-funnel-claim>
      {shown === "working" && (
        <>
          <div className="mb-3 text-4xl">🏗️</div>
          <p className="font-semibold text-slate-800">{msg("funnel.claim.card.working")}</p>
          <p className="mt-1 text-sm text-slate-500">{msg("funnel.claim.card.workingBody")}</p>
        </>
      )}
      {shown === "ok" && <p className="text-sm text-slate-600">{msg("funnel.claim.card.done")}</p>}
      {shown === "signedIn" && (
        <>
          <div className="mb-3 text-4xl">⚠️</div>
          <p className="font-semibold text-slate-800">{msg("funnel.claim.card.signedInTitle")}</p>
          <p className="mt-1 text-sm text-slate-600">{msg("funnel.claim.card.signedInBody")}</p>
          <Link href="/dashboard" className="btn btn-primary mt-4 inline-block px-4">
            {msg("funnel.claim.card.dashboard")}
          </Link>
        </>
      )}
      {(shown === "missing" || shown === "invalid" || shown === "failed") && (
        <>
          <div className="mb-3 text-4xl">⛔</div>
          <p className="font-semibold text-slate-800">
            {shown === "failed" ? msg("funnel.claim.card.failedTitle") : msg("funnel.claim.card.invalidTitle")}
          </p>
          <p className="mt-1 text-sm text-red-600">
            {shown === "missing"
              ? msg("funnel.claim.card.missingToken")
              : shown === "invalid"
                ? msg("funnel.claim.card.invalidDetail")
                : msg("funnel.claim.card.failedDetail")}
          </p>
          <p className="mt-4 text-sm text-slate-500">
            {msg("funnel.claim.card.retryHint")}{" "}
            <Link href="/start" className="font-medium text-purple-700 underline">
              {msg("funnel.claim.card.startAgain")}
            </Link>{" "}
            {msg("funnel.claim.card.or")}{" "}
            <Link href="/login" className="font-medium text-purple-700 underline">
              {msg("funnel.claim.card.signIn")}
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
