/**
 * Whether this server may hand a sign-in / claim link back over HTTP instead
 * of only emailing it.
 *
 * Three routes want this — `api/auth/magic-link`, `api/funnel/start` and
 * `api/auth/signup` — and before this helper existed each decided for itself.
 * Two of them decided it the same wrong way:
 *
 *     if (!sent || process.env.NODE_ENV !== "production") …
 *
 * `sendMagicLinkEmail` and its siblings pass `transactional: true`, so the
 * suppression branch is bypassed — but `send()` (`lib/email.ts:118-156`) still
 * returns `false` when `RESEND_API_KEY` is unset, when Resend answers non-2xx
 * (429, quota exceeded, unverified domain) or when the fetch throws. The
 * `!sent` half therefore fires IN PRODUCTION on any delivery failure, and the
 * response body carries a live sign-in link for whatever address was posted —
 * which `components/auth-form.tsx:57` then renders as a clickable button. An
 * email outage became account access, and a provider incident became a window
 * across the whole user base.
 *
 * That arm was never a deliberate production behaviour. It dates to the
 * magic-link route's ORIGINAL commit (`183f7cd9e`, #44, 2026-07-08) — the same
 * commit that added `e2e/auth.setup.ts` and `passwordless-login.spec.ts` — and
 * exists so the flow is testable without a verified sending domain. The
 * exposure is a side effect of `next start` and the standalone server both
 * running as `NODE_ENV=production`, which is what every harness server here
 * is.
 *
 * So the capability is kept and made EXPLICIT rather than inferred from a
 * failure: development still exposes links with no configuration, and a
 * production-mode harness opts in by setting `AUTH_DEV_LINKS=1`. Production
 * sets neither, and a broken mailer now fails closed.
 *
 * Deliberately ONE helper for all three routes. Three copies of a rule about
 * who may see a credential is how two of them ended up wrong in the same way,
 * and the next route to want a dev link should inherit the answer rather than
 * invent a third variant.
 */
export function mayExposeDevLink(): boolean {
  // `=== "1"`, not bare truthiness: `AUTH_DEV_LINKS=0` and `AUTH_DEV_LINKS=false`
  // both read as "on" under a truthy check, and a flag that cannot be turned
  // off by writing the obvious thing is a flag that will be left on.
  if (process.env.AUTH_DEV_LINKS === "1") return true;
  return process.env.NODE_ENV !== "production";
}
