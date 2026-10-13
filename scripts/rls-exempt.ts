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
  // Streaming relay (V410): the four org_id tables are reached only through the
  // superuser `sql` client and are RLS FORCEd with ZERO client policies (deny by
  // default, stricter than a tenant policy); relay/__tests__/migration-shape.test.ts
  // asserts enabled + forced + zero policies on all eight V410 tables.
  // Stream destinations (the encrypted RTMP url + key); superuser client only, zero policies.
  "org_stream_targets",
  // Relay sessions; organisers get a projection, never the row; superuser client only, zero policies.
  "fixture_stream_sessions",
  // Stream credit ledger (money); superuser client only, zero policies.
  "org_stream_credits",
  // Append-only relay history (capture); superuser client only, zero policies.
  "fixture_stream_events",
  // Capture QR v2 (V430, ruling R1 / spec §17.1): V410's pattern — RLS FORCEd, ZERO policies, no
  // trg_set_org, no app_user grant; the use-case writes org_id from the code row (the phone routes
  // carry no org session). relay/__tests__/rls-static.test.ts and migration-shape.test.ts assert
  // enabled + forced + zero policies on all four.
  // The stable per-fixture stream code (the sealed tok); non-tenant sql only, zero policies, R1.
  "fixture_stream_codes",
  // Per-fixture stream settings, org_id from the code row; non-tenant sql only, zero policies, R1.
  "fixture_stream_settings",
  // Phone pairings to a code (claim / takeover history); non-tenant sql only, zero policies, R1.
  "fixture_stream_pairings",
  // The phone-beat history (24 h retention); non-tenant sql only, zero policies, R1.
  "fixture_stream_phone_beats",
  // Capture record upload (V437, spec 2026-10-12 §9): V410's pattern — RLS FORCEd, ZERO policies, no trg_set_org, no
  // app_user grant; the phone route writes it through the non-tenant client (the tok is its auth) and only staff read
  // it, in /admin (P7). Its link table capture_record_sessions has no org_id, so the guard never selects it; it is
  // enabled + forced all the same (rls-static.test.ts reads both).
  "capture_records",
  // Online chess (V439, chess in-page board design §5): V410's pattern. RLS is FORCEd with ZERO policies, there is no
  // trg_set_org and no app_user grant, so an app_user query is refused (42501), never silently empty. Every reader and
  // writer is on the privileged pool: `sql`, `sql.begin`, or withTenant's privilegedPrelude, which runs BEFORE the
  // role drops. Organisers and players see projections, never rows. Checked site by site, 2026-10-13: 58 SQL sites
  // on V439/V442's six sealed tables, none inside a withTenant body. online-chess-video-schema.test.ts asserts all
  // six are sealed and that app_user holds no privilege on them.
  // The organiser's "Open round" stamp; the authority for a window that can forfeit a player.
  "stage_round_opens",
  // One RealtimeKit meeting per fixture (meeting ids); the room and the arbiter panel get a projection.
  "fixture_video_meetings",
  // Camera and out-of-band flags; the organiser reads and closes them through use-cases on the privileged client.
  "fixture_play_flags",
  // Video-override audit (D11): who overrode an outage, and on which fixture. An org must not be able to edit its own
  // audit trail.
  "online_chess_audit",
]);
