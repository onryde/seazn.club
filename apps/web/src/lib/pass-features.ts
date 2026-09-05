/**
 * Feature keys an Event Pass lifts — every key whose `event_pass` row in
 * `plan_entitlements` beats the `community` row.
 *
 * ONE key the pass lifts is deliberately absent: `registration.fee_percent`
 * (Free's rate → the pass's, 5% → 4% since V398). It is a deduction RATE read
 * through `getLimit`
 * (server/usecases/registrations.ts) and never throws PaymentRequiredError, so
 * no paywall can ever render for it — listing it would be dead weight, not a
 * lost sale.
 *
 * Do not hand-edit this set against a spec doc: it drifted that way once and
 * cost the pass five paywalls.
 * `components/__tests__/upgrade-gate-pass-features.test.ts` derives the same set
 * from the live matrix and fails if the two disagree.
 *
 * ── Why this lives in lib/ and not in the component that reads it ────────────
 * `components/upgrade-gate.tsx` is `"use client"`. In the RSC graph every export
 * of a client module is replaced by a client *reference*, so a SERVER component
 * importing `PASS_FEATURES` from there would receive a proxy and
 * `PASS_FEATURES.has(...)` would throw. The upgrade page (a server component)
 * needs exactly this question — "is the key that sent them here one the pass
 * could ever lift?" — to tell its ceiling copy apart, and it must be the SAME
 * set the paywall uses or the two surfaces will describe one blocked feature
 * two different ways. So the set is a pure module and both sides import it;
 * `upgrade-gate.tsx` re-exports it so its existing importers are untouched.
 */
export const PASS_FEATURES = new Set([
  "divisions.per_competition.max",
  "entrants.per_division.max",
  "formats.advanced",
  "realtime",
  "exports.branded",
  "sponsors.tiers",
  "sponsors.monetize",
  // V393 (entitlements v18 W2): the pass rungs became the Community org's route
  // to the whole match-day layer, so seven more keys now beat the community row
  // and every one of them can throw at a real paywall.
  //
  // These land AFTER the enforcement sites learned to resolve them against the
  // competition (usecases/device-links, history, match-reports, player-stats,
  // stages, templates — W2 T6 and T13), and that order is load-bearing: offering
  // the pass for a key whose gate still refuses it takes $29 and leaves the user
  // exactly as blocked, which is strictly worse than never offering it.
  "officials.auto",
  "stats.player",
  "discipline.enforced",
  "scoring.device_links",
  "scoring.audit_export",
  "stages.per_division.max",
  "schedule.checkpoints.max",
  // V396 (entitlements v18 W2 T15, owner ruling 2026-09-03): the three share
  // loops became paid on Free while both pass rungs kept them, so all three
  // beat the community row again and each can throw at a real paywall.
  // `dashboard.player_profiles` RE-ENTERS this set for that reason — it left at
  // V393 when community caught up, and the catch-up has been reversed.
  //
  // Same ordering rule as the V393 block above, and it was followed: the
  // enforcement sites learned the competition first (embed-data, the division
  // console page, usecases/divisions, usecases/scoring, and the weekly digest's
  // own per-competition scope in usecases/org-posts), and only then does the
  // paywall start offering a pass for them.
  "dashboard.player_profiles",
  "embeds.enabled",
  "news.auto",
  // Two keys LEFT this set at V393, and not because the pass stopped lifting
  // them — because `community` caught up: `formats.double_elim` and
  // `scheduling.multi_division` are TRUE on every plan key including community,
  // so no paywall can ever render for them and a pass CTA offering them would
  // promise something already free. (`dashboard.player_profiles` was the third
  // and is back above — V396 re-gated it.)
  //
  // scheduling.ai.runs_per_division.max retired earlier (v17 Phase 2 Task 5,
  // V322) — the AI credit wallet meters runs on every tier now, so it no longer
  // has a plan_entitlements row for the pass to lift.
]);
