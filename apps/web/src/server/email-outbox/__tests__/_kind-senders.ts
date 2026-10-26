// Three lists that must move together, kept in one place so a kind task edits one file and a test (outbox-kind-sweep.test.ts, "the
// three lists agree") fails when one of them is left behind. Each is TYPED here from the spec and from lib/email.ts, never derived
// from the others or from the code under test:
//
//  - SENDER_ALLOWLIST: the direct `send*` exports of lib/email.ts (no-second-path.test.ts checks it against the file, exactly).
//  - NOT_YET_MOVED: the kinds whose producer still mails through one of those (outbox-kind-sweep.test.ts sweeps the others).
//  - KIND_DIRECT_SENDER: for every kind, the `send*` its producer still calls, or null once the kind has moved to the outbox.
//
// When a kind task (wave 1 T8-T12, wave 2 T2-T9) moves a kind: delete the kind from NOT_YET_MOVED, delete its `send*` from SENDER_ALLOWLIST
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
  "sendAccountDeletionEmail",
  "sendAiRunCostAlertEmail",
  "sendClaimInviteEmail",
  "sendConnectBankAlertEmail",
  "sendCreditPackGrantFailedAlertEmail",
  "sendDisputeLostEmail",
  "sendEarnGrantVolumeAlertEmail",
  "sendEmailChangeConfirmation",
  "sendEmailChangeNotice",
  "sendExtraOrgAllowanceAlertEmail",
  "sendExtraOrgRepriceFailedAlertEmail",
  "sendFunnelClaimEmail",
  "sendFunnelReminderEmail",
  "sendGroupOrgLeftEmail",
  "sendGroupOrgRemovedEmail",
  "sendInviteEmail",
  "sendOfficialAssignedEmail",
  "sendOfficialAssignmentChangedEmail",
  "sendOfficialInviteEmail",
  "sendPassCreditReversalIncompleteAlertEmail",
  "sendPassRevokedEmail",
  "sendPassRungMismatchAlertEmail",
  "sendPassUnknownCompetitionAlertEmail",
  "sendRegistrationRefundFailedAlertEmail",
  "sendReportSubmittedEmail",
  "sendSizePackGrantFailedAlertEmail",
  "sendSponsorDisputeAlertEmail",
  "sendSponsorDisputeLostEmail",
  "sendSponsorDisputeWonEmail",
  "sendSponsorInvoiceEmail",
  "sendSponsorReceiptEmail",
  "sendSponsorRefundEmail",
  "sendStaffDisputeAlertEmail",
  "sendStreamCreditClawbackAlertEmail",
  "sendStreamCreditGrantFailedAlertEmail",
  "sendStreamPackPriceDriftAlertEmail",
  "sendStuckEventsAlertEmail",
  "sendSuspensionConfirmedEmail",
  "sendSuspensionServedEmail",
  "sendTransferCompleteEmail",
  "sendTransferOfferEmail",
  "sendTrialEndingEmail",
  "sendVerificationEmail",
];

/** Kinds whose producer still mails through a `send*`. Wave 1 emptied it (T8-T12); wave 2's T1 registered its ten kinds before their
 *  producers moved, so they are listed here until their kind task (T2-T9) deletes each one. The sweep covers every kind not listed. */
export const NOT_YET_MOVED: readonly OutboxKind[] = [
  "registration_dispute_lost",
  "sponsor_invoice",
  "sponsor_receipt",
  "sponsor_refund",
  "sponsor_dispute_alert",
  "sponsor_dispute_won",
  "sponsor_dispute_lost",
  "pass_revoked",
  "trial_ending",
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
  registration_dispute_lost: "sendDisputeLostEmail",
  sponsor_invoice: "sendSponsorInvoiceEmail",
  sponsor_receipt: "sendSponsorReceiptEmail",
  sponsor_refund: "sendSponsorRefundEmail",
  sponsor_dispute_alert: "sendSponsorDisputeAlertEmail",
  sponsor_dispute_won: "sendSponsorDisputeWonEmail",
  sponsor_dispute_lost: "sendSponsorDisputeLostEmail",
  pass_revoked: "sendPassRevokedEmail",
  trial_ending: "sendTrialEndingEmail",
};

/** How long the allowlist must be while `unmoved` kinds are still on their direct sender: the spec's 49, less one for every phase-3 kind
 *  that has moved. The phase-3 kinds are the ones KIND_DIRECT_SENDER names, less the two phase-1 kinds; the moved ones are those less the
 *  `unmoved`. So registering a kind early (it joins the map and NOT_YET_MOVED together) changes nothing, and moving one takes one off. */
export const allowlistLengthFor = (unmoved: number): number => {
  const phase3Kinds = (Object.keys(KIND_DIRECT_SENDER) as OutboxKind[]).filter((k) => !KINDS_BEFORE_PHASE_3.includes(k)).length;
  return SENDERS_AT_START - (phase3Kinds - unmoved);
};
