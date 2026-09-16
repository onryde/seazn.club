/**
 * Tables that carry `org_id` but are intentionally reached only through the
 * superuser connection (billing/admin), never as `app_user`, and are therefore
 * exempt from the RLS guard.
 *
 * Its own module so `scripts/check-rls.ts` and the vitest regression suite
 * (`apps/web/src/server/__tests__/rls-coverage.test.ts`) read ONE list. Two
 * hand-kept copies would drift, and the copy that drifts is always the one the
 * gate reads — which is exactly the class of failure that let the guard itself
 * check zero tables for so long (it filtered on schema `public`; everything
 * here lives in `seazn_club`).
 *
 * Keep this list tight. Everything else with `org_id` must enable+FORCE RLS and
 * carry a policy. Adding a name here is a claim that no `app_user` connection
 * can ever reach the table — it needs a reason, on the line.
 *
 * Two entries (`subscriptions`, `impersonation_sessions`) carry no `org_id`
 * column today, so the guard never selects them and their exemption is inert.
 * Kept pre-emptively: the reason each is exempt does not depend on the column,
 * and if one ever grows an `org_id` the exemption should already be the decided
 * answer rather than a fresh CI red to rubber-stamp.
 */
export const SUPERUSER_ONLY: ReadonlySet<string> = new Set([
  // Stripe subscription mirror; read by billing/entitlements on the superuser
  // client and by /admin, never by a tenant session.
  "subscriptions",
  // Staff-set entitlement overrides — deliberately not visible or writable to
  // the org they apply to.
  "org_entitlement_overrides",
  // Raw Stripe webhook ledger, /admin only.
  "billing_events",
  // Staff impersonation audit; an org must not be able to read who impersonated
  // into it.
  "impersonation_sessions",
  // Growth/activation telemetry, /admin only.
  "activation_events",
  // Streaming relay (V408): the four org_id tables are reached only through the
  // superuser `sql` client and are RLS FORCEd with ZERO client policies (deny by
  // default, stricter than a tenant policy); relay/__tests__/migration-shape.test.ts
  // asserts enabled + forced + zero policies on all eight V408 tables.
  // Stream destinations (the encrypted RTMP url + key); superuser client only, zero policies.
  "org_stream_targets",
  // Relay sessions; organisers get a projection, never the row; superuser client only, zero policies.
  "fixture_stream_sessions",
  // Stream credit ledger (money); superuser client only, zero policies.
  "org_stream_credits",
  // Append-only relay history (capture); superuser client only, zero policies.
  "fixture_stream_events",
]);
