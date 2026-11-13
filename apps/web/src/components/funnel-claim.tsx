"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { ApiError, api } from "@/lib/client";
import { FUNNEL_CLAIM_INVALID, FUNNEL_CLAIM_PLAN_LIMIT, FUNNEL_CLAIM_SIGNED_IN } from "@/lib/funnel-claim-codes";

/** Where a claim that did not land leaves the visitor.
 *  - `signedIn` / `limit`: the route set the session, then the event could not be finished (`signedIn`: it may be part
 *    built) or the plan refused the competition before anything was written (`limit`). The token is spent either way,
 *    so the way on is the dashboard.
 *  - `tryLater`: the limiter refused the POST before the token was read, so the same link still works in a moment.
 *  - `missing` / `invalid` / `failed`: signed out, with a fresh start or a sign-in as the way on. */
type Failure = "missing" | "invalid" | "failed" | "tryLater" | "signedIn" | "limit";

/** The route names its refusals with a `code`; a 429 is the limiter's; anything else (a 5xx before the session, the
 *  network) is the generic failure. The route's English `error` is never shown — the card words every state from the
 *  dictionary. */
function failureOf(e: unknown): Exclude<Failure, "missing"> {
  if (!(e instanceof ApiError)) return "failed";
  if (e.code === FUNNEL_CLAIM_SIGNED_IN) return "signedIn";
  if (e.code === FUNNEL_CLAIM_PLAN_LIMIT) return "limit";
  if (e.code === FUNNEL_CLAIM_INVALID) return "invalid";
  if (e.status === 429) return "tryLater";
  return "failed";
}

/** Consumes a funnel draft token: signs the visitor in, creates the drafted
 *  competition, and routes inside it (v3/07 §6). Mirrors <MagicLink>. */
export function FunnelClaim({ token }: { token: string | null }) {
  const router = useRouter();
  const msg = useMsg();
  const [status, setStatus] = useState<"working" | "ok" | Failure>("working");
  const ran = useRef(false);

  const claim = useCallback(
    (t: string) => {
      api<{ redirect: string }>("/api/funnel/claim", {
        method: "POST",
        json: { token: t },
      })
        .then((res) => {
          setStatus("ok");
          router.push(res.redirect || "/dashboard");
          router.refresh();
        })
        .catch((e: unknown) => {
          const failure = failureOf(e);
          setStatus(failure);
          // The session cookie was set on this very response: the server-rendered nav above still says signed out.
          if (failure === "signedIn" || failure === "limit") router.refresh();
        });
    },
    [router],
  );

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) return; // nothing to claim — the error is derived below
    claim(token);
  }, [token, claim]);

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
      {(shown === "signedIn" || shown === "limit") && (
        <>
          <div className="mb-3 text-4xl">⚠️</div>
          <p className="font-semibold text-slate-800">{msg("funnel.claim.card.signedInTitle")}</p>
          <p className="mt-1 text-sm text-slate-600">
            {shown === "limit" ? msg("funnel.claim.card.limitBody") : msg("funnel.claim.card.signedInBody")}
          </p>
          <Link href="/dashboard" className="btn btn-primary mt-4 inline-block px-4">
            {msg("funnel.claim.card.dashboard")}
          </Link>
        </>
      )}
      {shown === "tryLater" && (
        <>
          <div className="mb-3 text-4xl">⏳</div>
          <p className="font-semibold text-slate-800">{msg("funnel.claim.card.tryLaterTitle")}</p>
          <p className="mt-1 text-sm text-slate-600">{msg("funnel.claim.card.tryLaterBody")}</p>
          <button
            type="button"
            className="btn btn-primary mt-4 inline-block px-4"
            onClick={() => {
              if (!token) return;
              setStatus("working");
              claim(token);
            }}
          >
            {msg("funnel.claim.card.tryAgain")}
          </button>
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
