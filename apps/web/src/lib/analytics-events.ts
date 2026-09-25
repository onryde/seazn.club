/**
 * Canonical PostHog event names, shared by the client tracker (lib/analytics)
 * and the server capture path (lib/posthog-server). No imports here so both
 * runtimes can pull it in freely.
 *
 * Funnels these power:
 *  - Activation (feature 1): signup → onboarding → COMPETITION_CREATED →
 *    DIVISION_CREATED → RESULT_ENTERED (the true "aha": a live scoreline)
 *  - Revenue (feature 2): PRICING_VIEWED / BILLING_VIEWED → CHECKOUT_STARTED
 *    → SUBSCRIPTION_STARTED (or PAYMENT_FAILED / SUBSCRIPTION_CANCELED)
 */
export const EVENTS = {
  PRICING_VIEWED: "pricing_viewed",
  BILLING_VIEWED: "billing_viewed",
  CHECKOUT_STARTED: "checkout_started",
  // Start-a-competition funnel (v3/07 §6): draft-created → claimed, then
  // COMPETITION_CREATED continues into the activation funnel below.
  FUNNEL_DRAFT_CREATED: "funnel_draft_created",
  FUNNEL_CLAIMED: "funnel_claimed",
  COMPETITION_CREATED: "competition_created",
  DIVISION_CREATED: "division_created",
  SCHEDULE_GENERATED: "schedule_generated",
  REGISTRATION_SUBMITTED: "registration_submitted",
  COMPETITION_STARTED: "competition_started",
  RESULT_ENTERED: "result_entered",
  COMPETITION_COMPLETED: "competition_completed",
  SUBSCRIPTION_STARTED: "subscription_started",
  SUBSCRIPTION_CANCELED: "subscription_canceled",
  PAYMENT_FAILED: "payment_failed",
  // In-app billing management (v3/11) — the portal-replacement surface.
  // `BILLING_PLAN_CHANGED` lived here and was never emitted: the plan-change
  // surface it belonged to was retired in #805, and the constant outlived it.
  // Dropped 2026-09-20 on the owner's ruling — there is no production traffic
  // and no PostHog history yet, so nothing is keyed on `billing_plan_changed`
  // and keeping it only preserves a name for an event the product does not
  // send. Re-add it with its emitter, not ahead of one.
  BILLING_CARD_ADDED: "billing_card_added",
  BILLING_INTERVAL_CHANGED: "billing_interval_changed",
  SUBSCRIPTION_CANCEL_SCHEDULED: "subscription_cancel_scheduled",
  SUBSCRIPTION_RESUMED: "subscription_resumed",
  // PLG growth loops (2026-07-17 plan) — distribution + referral.
  ATTRIBUTION_CLICKED: "attribution_clicked",
  SHARE_FIRED: "share_fired",
  PLAYER_STARTED_OWN_ORG: "player_started_own_org",
  COMPETITION_MADE_PUBLIC: "competition_made_public",
  EMBED_RENDERED: "embed_rendered",
  /** A public org profile was rendered. Distribution baseline (entitlements
   *  v18 item 0) — consent-gated, so a consented-traffic count, not a total. */
  PUBLIC_PROFILE_VIEWED: "public_profile_viewed",
  /** An auto-draft was GENERATED. Distinct from post_published{auto:true},
   *  which only fires once a human publishes that draft. */
  POST_AUTO_DRAFTED: "post_auto_drafted",
  /** Pricing page: visitor opened the hidden Pro Plus offer. */
  PRICING_PLUS_REVEALED: "pricing_plus_revealed",
  // Org news (SPEC-2) — composer + publish (server-side) and the public share
  // loop (client-side). post_published carries { kind, auto } so the funnel can
  // split organiser-authored from one-tap auto-draft publishes.
  POST_CREATED: "post_created",
  POST_PUBLISHED: "post_published",
  POST_SHARED: "post_shared",
  POST_CARD_DOWNLOADED: "post_card_downloaded",
  /** Spectator surface: a match poster (the 1080×1350 Option A PNG) was
   *  downloaded from a public match page. The SAME share loop POST_SHARED
   *  measures for news, on the surface a spectator actually lands on — carries
   *  { variant } so an upcoming/live/result split is visible without a join. */
  MATCH_POSTER_DOWNLOADED: "match_poster_downloaded",
  /** v4 AI Schedule Architect (design/v4/00 §5): one metered architect run —
   *  fired on success AND on a 422 AI_PLAN_FAILED so refused spend is visible. */
  AI_PLAN_RUN: "ai_plan_run",
  /** v4 brief step (design/v4/03 §5): organiser tapped a pre-flight warn row's
   *  deep link to go fix a data gap (no windows, no officials, …) before running. */
  AI_PREFLIGHT_GAP_FIXED: "ai_preflight_gap_fixed",
  /** v4 apply step (design/v4/02 §6): organiser discarded a verified proposal
   *  from the apply step instead of applying it — the abandon signal for the run. */
  AI_PLAN_DISCARDED: "ai_plan_discarded",
  /** v4 Task 16 repair nudges: the board's client-derived amber banner became
   *  visible over the grid — fired ONCE per board load when it first shows, so a
   *  disrupted schedule (a blackout, a removed court, a postponed match holding a
   *  slot) is a visible re-entry signal into the architect. */
  AI_REPAIR_NUDGE_SHOWN: "ai_repair_nudge_shown",
  /** v4 Task 16: organiser tapped the nudge's "Fix with AI" CTA, deep-linking
   *  into the console pre-armed in repair mode + the disrupted scope. */
  AI_REPAIR_NUDGE_CLICKED: "ai_repair_nudge_clicked",
  /** Scorer sheets: an organiser printed a day's scorer sheets (the export
   *  route, server-side, only once the PDF is built — a refusal prints nothing
   *  and counts nothing). Carries { competition_id, date, fixture_count,
   *  court_count, courtless_count }; never a token, URL or link id, because
   *  every card's QR is a live scoring credential. */
  SCORER_SHEETS_PRINTED: "scorer_sheets_printed",
} as const;

export type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS];

/** PostHog group type for our multi-tenant model — one group per club/org. */
export const ORG_GROUP = "organization";
