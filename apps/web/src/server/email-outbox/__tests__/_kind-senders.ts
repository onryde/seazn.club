// Three lists that must move together, kept in one place so a kind task edits one file and a test (outbox-kind-sweep.test.ts, "the
// three lists agree") fails when one of them is left behind. Each is TYPED here from the spec and from lib/email.ts, never derived
// from the others or from the code under test:
//
//  - SENDER_ALLOWLIST: the direct `send*` exports of lib/email.ts (no-second-path.test.ts checks it against the file, exactly).
//  - NOT_YET_MOVED: the kinds whose producer still mails through one of those (outbox-kind-sweep.test.ts sweeps the others).
//  - KIND_DIRECT_SENDER: for every kind, the `send*` its producer still calls, or null once the kind has moved to the outbox.
//
// When a kind task (wave 1 T8-T12, wave 2 T2-T9, wave 3 T2-T4, wave 4 T2-T4, wave 5 T3-T6) moves a kind: delete the kind from NOT_YET_MOVED, delete its `send*` from SENDER_ALLOWLIST
// AND from lib/email.ts, and set its KIND_DIRECT_SENDER entry to null. The allowlist's LENGTH follows by itself (allowlistLengthFor below: the
// spec's 49 less one per phase-3 kind that has moved, both counted from these lists), so there is no number to change. When a wave registers
// a kind before its producer moves, it adds the kind to NOT_YET_MOVED and names its `send*` in KIND_DIRECT_SENDER: the length is unchanged.
// What each omission turns red, each one run once:
//   - the kind stays in NOT_YET_MOVED               -> the lists-agree test (its sender is no longer in the allowlist)
//   - the map keeps the sender's name               -> the lists-agree test (a moved kind that still has a sender)
//   - lib/email.ts keeps the `send*` export         -> no-second-path.test.ts (the file is held to the allowlist, exactly)
//   - the allowlist keeps it, the file lost it      -> no-second-path.test.ts (the same comparison) and the length rule
//   - the sender is left in BOTH the file and the allowlist, while the map is nulled and the kind dropped: nothing names that sender any
//     more, so no list can disagree about it, and the file still matches the allowlist -> the length rule alone (the allowlist must be
//     shorter by exactly the kinds that have moved; asserted in the lists-agree test and in no-second-path.test.ts's allowlist test).
import type { OutboxKind } from "../constants";

/** The spec's number: 49 direct `send*` exports in lib/email.ts at the start of phase 3 (wave 1). Every phase-3 kind owns exactly one of
 *  them (the lists-agree test: no two kinds share a direct sender) and takes it with it when it moves. */
export const SENDERS_AT_START = 49;
/** The two phase-1 kinds. Their senders had left lib/email.ts before the spec counted its 49, so moving them took nothing from that count. */
export const KINDS_BEFORE_PHASE_3: readonly OutboxKind[] = ["magic_link", "chess_invite"];

/** The `send*` exports of lib/email.ts as of the start of phase 3 wave 1 (spec: "49 send* exports"), copied once from the file.
 *  `sendWithResult` is the outbox's own typed sender and is not among them. */
export const SENDER_ALLOWLIST: readonly string[] = [
  "sendAiRunCostAlertEmail",
  "sendEarnGrantVolumeAlertEmail",
  "sendExtraOrgAllowanceAlertEmail",
];

/** Kinds whose producer still mails through a `send*`. Wave 1 emptied it (T8-T12). Wave 2's T1 listed its ten kinds before their
 *  producers moved, each kind task (T2-T9) deleted its own, and T10 closed the list again. Wave 3's T1 listed its eight kinds the same
 *  way, each kind task (T2-T4) deleted its own, and the last move (T4c) closed the list again. Wave 4's T1 listed its nine kinds the same
 *  way, in the spec's table order: each kind task (T2-T4) deletes its own, and the last move closes the list again. Wave 5's T1 appended
 *  its seventeen after them, in the spec's table order, and each of its kind tasks (T3-T6) deletes its own. The sweep covers every kind
 *  not listed, and a-kind-body.test.ts sweeps every account kind not listed. */
export const NOT_YET_MOVED: readonly OutboxKind[] = [
  // Wave 5, in the spec's table order.
  "staff_ai_run_cost",
  "staff_earn_grant_volume",
  "staff_extra_org_allowance",
];

/** For every kind, the direct sender its producer still calls (null = the kind has moved: nothing direct is left for it). */
export const KIND_DIRECT_SENDER: Readonly<Record<OutboxKind, string | null>> = {
  magic_link: null,
  chess_invite: null,
  registration_confirmation: null,
  payment_reminder: null,
  registration_promoted: null,
  refund_issued: null,
  solo_signup_assigned: null,
  registration_dispute_alert: null,
  registration_dispute_lost: null,
  sponsor_invoice: null,
  sponsor_receipt: null,
  sponsor_refund: null,
  sponsor_dispute_alert: null,
  sponsor_dispute_won: null,
  sponsor_dispute_lost: null,
  pass_revoked: null,
  trial_ending: null,
  // Wave 3: every one has moved (T2-T4).
  email_verification: null,
  funnel_claim: null,
  email_change_confirmation: null,
  email_change_notice: null,
  account_deletion: null,
  org_invite: null,
  claim_invite: null,
  official_invite: null,
  // Wave 4: each kind's direct sender in lib/email.ts (the spec's kind table cites it by line; the wave-4 plan's table names it), null
  // once its kind task has moved it.
  official_assigned: null,
  official_assignment_changed: null,
  suspension_confirmed: null,
  suspension_served: null,
  match_report_submitted: null,
  group_transfer_offer: null,
  group_transfer_complete: null,
  group_org_removed: null,
  group_org_left: null,
  // Wave 5: each kind's direct sender in lib/email.ts (the spec's kind table cites it by line; the T0 re-pin names it), null once its
  // task has moved it (T3: the funnel reminder; T4: the money batch; T5: staff batch B; T6: staff batch C).
  funnel_reminder: null,
  staff_registration_refund_failed: null,
  staff_credit_pack_grant_failed: null,
  staff_size_pack_grant_failed: null,
  staff_stream_credit_grant_failed: null,
  staff_pass_credit_reversal_incomplete: null,
  staff_pass_rung_mismatch: null,
  staff_pass_unknown_competition: null,
  staff_stream_credit_clawback: null,
  staff_extra_org_reprice_failed: null,
  staff_dispute_alert: null,
  staff_connect_bank_changed: null,
  staff_stuck_events: null,
  staff_stream_pack_price_drift: null,
  staff_ai_run_cost: "sendAiRunCostAlertEmail",
  staff_earn_grant_volume: "sendEarnGrantVolumeAlertEmail",
  staff_extra_org_allowance: "sendExtraOrgAllowanceAlertEmail",
};

/** How long the allowlist must be while `unmoved` kinds are still on their direct sender: the spec's 49, less one for every phase-3 kind
 *  that has moved. The phase-3 kinds are the ones KIND_DIRECT_SENDER names, less the two phase-1 kinds; the moved ones are those less the
 *  `unmoved`. So registering a kind early (it joins the map and NOT_YET_MOVED together) changes nothing, and moving one takes one off. */
export const allowlistLengthFor = (unmoved: number): number => {
  const phase3Kinds = (Object.keys(KIND_DIRECT_SENDER) as OutboxKind[]).filter((k) => !KINDS_BEFORE_PHASE_3.includes(k)).length;
  return SENDERS_AT_START - (phase3Kinds - unmoved);
};
