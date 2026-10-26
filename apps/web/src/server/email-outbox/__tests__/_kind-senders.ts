// Three lists that must move together, kept in one place so a kind task edits one file and a test (outbox-kind-sweep.test.ts, "the
// three lists agree") fails when one of them is left behind. Each is TYPED here from the spec and from lib/email.ts, never derived
// from the others or from the code under test:
//
//  - SENDER_ALLOWLIST: the direct `send*` exports of lib/email.ts (no-second-path.test.ts checks it against the file, exactly).
//  - NOT_YET_MOVED: the kinds whose producer still mails through one of those (outbox-kind-sweep.test.ts sweeps the others).
//  - KIND_DIRECT_SENDER: for every kind, the `send*` its producer still calls, or null once the kind has moved to the outbox.
//
// When a kind task (T8-T12) moves a kind: delete the kind from NOT_YET_MOVED, delete its `send*` from SENDER_ALLOWLIST AND from
// lib/email.ts, and set its KIND_DIRECT_SENDER entry to null. The allowlist's LENGTH follows by itself (allowlistLengthFor below: the
// spec's 49 less one per kind that has moved), so there is no number to change. What each omission turns red, each one run once:
//   - the kind stays in NOT_YET_MOVED               -> the lists-agree test (its sender is no longer in the allowlist)
//   - the map keeps the sender's name               -> the lists-agree test (a moved kind that still has a sender)
//   - lib/email.ts keeps the `send*` export         -> no-second-path.test.ts (the file is held to the allowlist, exactly)
//   - the allowlist keeps it, the file lost it      -> no-second-path.test.ts (the same comparison) and the length rule
//   - the sender is left in BOTH the file and the allowlist, while the map is nulled and the kind dropped: nothing names that sender any
//     more, so no list can disagree about it, and the file still matches the allowlist -> the length rule alone (the allowlist must be
//     shorter by exactly the kinds that have moved; asserted in the lists-agree test and in no-second-path.test.ts's allowlist test).
import type { OutboxKind } from "../constants";

/** The spec's numbers: 49 direct `send*` exports in lib/email.ts at the start of wave 1, and wave 1 moves five kinds (T8-T12), one
 *  `send*` each, leaving 44. Typed from the spec; NOT_YET_MOVED is what says how many of the five have moved so far. */
export const SENDERS_AT_START = 49;
export const KINDS_MOVED_IN_WAVE_1 = 5;
/** How long the allowlist must be while `unmoved` kinds are still on their direct sender: 49 at the start, one fewer per kind moved. */
export const allowlistLengthFor = (unmoved: number): number => SENDERS_AT_START - (KINDS_MOVED_IN_WAVE_1 - unmoved);

/** The `send*` exports of lib/email.ts as of the start of phase 3 wave 1 (spec: "49 send* exports"), copied once from the file.
 *  `sendWithResult` is the outbox's own typed sender and is not among them. */
export const SENDER_ALLOWLIST: readonly string[] = [
  "sendAccountDeletionEmail",
  "sendAiRunCostAlertEmail",
  "sendClaimInviteEmail",
  "sendConnectBankAlertEmail",
  "sendCreditPackGrantFailedAlertEmail",
  "sendDisputeAlertEmail",
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
  "sendPaymentReminderEmail",
  "sendRefundIssuedEmail",
  "sendRegistrationEmail",
  "sendRegistrationPromotedEmail",
  "sendRegistrationRefundFailedAlertEmail",
  "sendReportSubmittedEmail",
  "sendSizePackGrantFailedAlertEmail",
  "sendSoloSignUpAssignedEmail",
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

/** Kinds whose producer still mails through a `send*` (T8-T12 move them, one each, and delete their entry). */
export const NOT_YET_MOVED: readonly OutboxKind[] = [
  "registration_confirmation",
  "payment_reminder",
  "registration_promoted",
  "refund_issued",
  "solo_signup_assigned",
];

/** For every kind, the direct sender its producer still calls (null = the kind has moved: nothing direct is left for it). */
export const KIND_DIRECT_SENDER: Readonly<Record<OutboxKind, string | null>> = {
  magic_link: null,
  chess_invite: null,
  registration_confirmation: "sendRegistrationEmail",
  payment_reminder: "sendPaymentReminderEmail",
  registration_promoted: "sendRegistrationPromotedEmail",
  refund_issued: "sendRefundIssuedEmail",
  solo_signup_assigned: "sendSoloSignUpAssignedEmail",
};
