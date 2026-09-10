import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";
import { featureReason } from "@/lib/feature-copy";
import { log } from "@/server/logger";
import { runRequestContext } from "@/server/request-context";
import * as Sentry from "@sentry/nextjs";

export { HttpError, PaymentRequiredError } from "@/lib/errors";

/**
 * Redirect to a path on THIS site, with a RELATIVE `Location`.
 *
 * Use this for every redirect whose destination is a path we own. The two
 * spellings it replaces both bake an origin into the header, and both get that
 * origin wrong in exactly the environments we do not test on:
 *
 *   NextResponse.redirect(new URL(path, req.url))       // the bind address
 *   NextResponse.redirect(new URL(path, baseUrl(req)))  // ditto, one hop later
 *
 * `req.url` is the server's INTERNAL BINDING, not the address the browser is
 * on — `lib/oauth.ts:25-26` says so — and `baseUrl(req)` only escapes it when
 * a proxy actually sets `x-forwarded-host` or an env override is present;
 * otherwise it falls through to `new URL(req.url).origin` and reproduces it.
 *
 * A standalone server started without HOSTNAME binds 0.0.0.0, so the header
 * read `http://0.0.0.0:3000/settings?…` while the user was on
 * `http://localhost:3000`. The browser withholds the session cookie across
 * that origin hop, so the destination sees a signed-OUT visitor. That is how
 * an email-change confirmation ended up on `/login` AFTER committing the new
 * address (CI run 33968571673).
 *
 * A relative Location has no origin to get wrong: the browser resolves it
 * against the URL it requested. Correct behind a proxy, in a container, and on
 * a laptop alike, with no env configuration to keep in sync.
 *
 * The one thing that must stay ABSOLUTE is a URL a third party resolves rather
 * than the browser — `googleRedirectUri()` is registered with Google and has
 * to name a real origin. This helper is for our own paths only.
 */
export function redirectLocal(path: string, status: 307 | 308 = 307): NextResponse {
  // PERCENT-ENCODE, because a Location header is a ByteString. Setting one to
  // a value containing any character above U+00FF throws — not a bad
  // redirect, a 500. The absolute spellings this helper replaces did the
  // encoding for us as a side effect of building a URL, so dropping the origin
  // without keeping the encoding turned `?next=/o/中文` into a crash.
  // `safeNextPath` accepts non-Latin-1, so that input is reachable:
  // `/api/auth/google?next=/o/中文` stores it raw behind a `startsWith("/")`
  // check and hands it to the callback.
  //
  // REJECT anything that is not a path on this site. `//evil.com` and
  // `https://evil.com` are both valid `Location` values and neither is ours;
  // the helper's name and contract promise a local path, so it enforces one
  // rather than trusting every present and future caller to have used
  // `safeNextPath` first. Parsing against an opaque base also normalises `.`
  // and `..` segments, so a traversal cannot climb out.
  const local = /^\/(?![/\\])/.test(path) ? path : "/";
  const u = new URL(local, "http://redirect-local.invalid");
  return new NextResponse(null, {
    status,
    headers: { location: `${u.pathname}${u.search}${u.hash}` },
  });
}

/** Wraps a route handler with consistent JSON error handling. Runs inside a
 *  request-context ALS scope (server/request-context.ts) so every log line
 *  for this request carries the same requestId, same as /api/v1's v1(). */
export function handler<T>(fn: () => Promise<T>) {
  return runRequestContext(randomUUID(), () => handlerInner(fn));
}

function handlerInner<T>(fn: () => Promise<T>) {
  return fn()
    .then((data) =>
      // A handler that builds its own Response (file downloads, redirects,
      // custom content-types) is passed straight through — wrapping it in the
      // { ok, data } envelope would corrupt the payload (e.g. GDPR export).
      data instanceof Response ? data : NextResponse.json({ ok: true, data }),
    )
    .catch((err: unknown) => {
      if (err instanceof ZodError) {
        return NextResponse.json(
          { ok: false, error: "Invalid input", issues: err.issues },
          { status: 400 },
        );
      }
      if (err instanceof AuthError) {
        return NextResponse.json(
          { ok: false, error: err.message },
          { status: 401 },
        );
      }
      if (err instanceof PaymentRequiredError) {
        // Upgrade-moment contract (doc 10 §3): feature_key + human reason let
        // the client render a contextual paywall (<UpgradeGate>). `extra`
        // merges in machine-readable hints — e.g. a purchase offer (v17 gap
        // #293). NOTE this is the ONLY branch in this file that forwards
        // `extra`: the generic HttpError branch below forwards
        // `code` when one was set but still drops `extra` (only the /api/v1
        // envelope keeps `extra`). Do not read this as a file-wide convention.
        return NextResponse.json(
          {
            ok: false,
            error: err.message,
            feature_key: err.featureKey,
            reason: featureReason(err.featureKey),
            ...err.extra,
          },
          { status: 402 },
        );
      }
      if (err instanceof HttpError) {
        // 4xx are expected; only capture 5xx
        if (err.status >= 500) {
          Sentry.captureException(err);
          log.error({ err, status: err.status, code: err.code }, "handler: HttpError reached 500");
        }
        // `code` is forwarded when the thrower set one; `extra` still is not
        // (see the 402 branch above). Throwers that bother to pass a code mean
        // it to be acted on: /api/claims/[token] documents CLAIM_INVALID /
        // CLAIM_EXPIRED / CLAIM_REVOKED / CLAIM_CLAIMED as the four states a
        // client distinguishes, and until this line they were built by
        // `person-claims.ts` and then dropped here, so no HTTP client could
        // tell "expired" from "already claimed" — only the /claim page could,
        // because it calls the usecase directly and never crosses this
        // envelope. Omitted entirely when undefined, so the shape is unchanged
        // for the throwers that pass no code.
        return NextResponse.json(
          { ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) },
          { status: err.status },
        );
      }
      // Unexpected error — always capture
      Sentry.captureException(err);
      const message = err instanceof Error ? err.message : "Server error";
      log.error({ err }, "handler: unhandled error");
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    });
}
