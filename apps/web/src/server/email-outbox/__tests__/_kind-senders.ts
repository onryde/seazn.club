// Three lists that must move together, kept in one place so a kind task edits one file and a test (outbox-kind-sweep.test.ts, "the
// three lists agree") fails when one of them is left behind. Each is TYPED here from the spec and from lib/email.ts, never derived
// from the others or from the code under test:
//
//  - SENDER_ALLOWLIST: the direct `send*` exports of lib/email.ts (no-second-path.test.ts checks it against the file, exactly).
//  - NOT_YET_MOVED: the kinds whose producer still mails through one of those (outbox-kind-sweep.test.ts sweeps the others).
//  - KIND_DIRECT_SENDER: for every kind, the `send*` its producer still calls, or null once the kind has moved to the outbox.
//
// When a kind task (T8-T12) moves a kind: delete the kind from NOT_YET_MOVED, delete its `send*` from SENDER_ALLOWLIST (and change the
// length pin in no-second-path.test.ts), and set its KIND_DIRECT_SENDER entry to null. Leaving any one of the three behind is red.
import type { OutboxKind } from "../constants";

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
