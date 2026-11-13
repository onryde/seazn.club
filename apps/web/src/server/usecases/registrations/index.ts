import "server-only";
// Online registration & entry fees (doc 16 §1.1, PROMPT-20a).
//
// Lifecycle: public submit → pending (holds a spot) | waitlisted (over
// capacity) → paid (Stripe checkout completed) → confirmed (entrant
// materialised, entrant_id set EXACTLY once — idempotent) → withdrawn
// (frees the spot; oldest waitlisted auto-promotes; auto-refund before
// refund_lock_at, organiser-discretion after — all audited on the
// competition_events ledger).
//
// Public paths (submit / status / withdraw / pay) run on the superuser
// connection like the public read models — registrants have no org session;
// the access token (sha256 stored, shown once) is their credential.
// Organiser paths ride withTenant/RLS as usual.
//
// Split by concern (src/server/MODULARIZATION.md). This folder replaces the
// single `registrations.ts`; importers keep `from "@/server/usecases/registrations"`
// and land here. The barrel re-exports exactly the public surface the file had;
// siblings never import it.
//
//   types                the row shapes, the division context and the SQL handle types the siblings share; types only
//   helpers              pure helpers: token prefix and hash, fee math, #402 link policy, form answers
//   lookups              shared loaders: settings, division context (and its projection from the submit's own read), registration rows by token / ref / org, token match
//   people               the person behind a registration: lookup / create / reconcile, and claim invites
//   materialise          confirmed entry -> entrant: materialise, join an existing entrant, clear the expiry
//   waitlist             waitlist promotion: the seat gate, promote the oldest, the promoted notice
//   mail                 registration mail: cart confirmation (submit, resend) and the payment reminder message
//   lifecycle-mail       the registrant's lifecycle mails (payment received, approved, released, withdrawn by the organiser, joined, rejected, promotion lapsed): one queue producer per kind
//   settings             organiser settings (defaults, get / put) and the public register-panel info
//   checkout             minting and resuming a Stripe checkout for a registration or a cart
//   pay-token            the player payment page's token: mint, record, issue a link, resolve a token to its entry
//   pay-page             the player payment page's document: what /r/pay/<token> shows, decided by an ordered state table
//   pay-page-checkout    the payment page's Pay: reuse-or-expire on the entry's own session, mint for the entry, return to the page
//   checkout-completion  payment completion: the checkout webhooks, confirmPaidRegistration, reconcile-on-return
//   refunds              refund money and policy: stripeRefund, receipts, the failure alert, the resolved policy
//   disputes             chargeback handling and the dispute evidence pack
//   withdraw             withdrawal core shared by the public and organiser paths, and the solo placement release
//   public-status        token- and ref-gated public views: status, cart, public withdraw
//   group-status         the group (cart) read model behind the /r/[ref] status page
//   sweep                the hourly pay-window sweep: reminders, expiries, promotions
//   list                 organiser list read and the solo-pool capacity helpers it shares
//   organiser-actions    organiser actions: confirm, mark paid, waive, remind, waitlist, withdraw, refund
//   csv-ics              files: the organiser CSV export and the registrant .ics attachment

export type {
  RegistrationSettingsRow,
  RegistrationRow,
  RegistrationGroupRow,
  RegistrationPlayerRow,
  RegistrationWithGroupRow,
  DivisionCtx,
  KnownCart,
} from "./types";
export {
  REGISTRATION_TOKEN_PREFIX,
  feePercentFor,
  effectiveFeePercentFor,
  applicationFeeCents,
  hashRegistrationToken,
  deriveLinkUserId,
  ageAt,
  isMinor,
  requiresDob,
  validateAnswers,
} from "./helpers";
export {
  regGroupCols,
  SPOT_HOLDERS,
  loadSettings,
  audit,
  divisionCtx,
  knownCtxOf,
  fallbackOrigin,
  windowOpen,
  orgReg,
  orgRegAfter,
} from "./lookups";
export {
  resolvePlayerPerson,
  findPlayerPersonByEmail,
  playerPersonConsentsByEmail,
  backfillPersonEmail,
  reconcileClaimedPerson,
  inviteUnclaimedMembers,
} from "./people";
export { clearExpiresIfNoLongerNeeded, materialise, joinExistingEntrant } from "./materialise";
export {
  freesTeamSlot,
  promoteOldestWaitlisted,
  promotionSeats,
  openPromotionSeatGate,
  openRegistrationSeatGateFor,
  promoteWaitlistedRow,
  notifyPromoted,
} from "./waitlist";
export {
  notifySubmitted,
  resendRegistrationConfirmation,
  resendRegistrationConfirmationPublic,
  payDeadlineOf,
} from "./mail";
export { getRegistrationSettings, putRegistrationSettings, publicRegistrationInfo } from "./settings";
export type { OrgPaymentDefaults, PublicDivisionInfo, PublicRegistrationInfoResult } from "./settings";
export { mintGroupCheckout, resumeRegistrationCheckout, registrationLineItems } from "./checkout";
export type { RegistrationLineItem, RegistrationCheckoutOpts } from "./checkout";
export { mintPayToken, recordPayToken, issuePayLink, registrationIdByPayToken } from "./pay-token";
export { PAY_PAGE_STATES, payPageState, payPageDocByToken } from "./pay-page";
export type { PayPageState, PayPageDoc, PayPageFacts } from "./pay-page";
export { PAY_SESSION_REUSE_MARGIN_MS, payFromPayPage } from "./pay-page-checkout";
export {
  handleRegistrationCheckoutCompleted,
  handleRegistrationCheckoutAsyncPaymentFailed,
  reconcileRegistration,
  reconcileRegistrationBySession,
  reconcileRegistrationGroupBySession,
  reconcileRegistrationByPaySession,
} from "./checkout-completion";
export {
  syncRegistrationRefund,
  stripeRefund,
  queueRefundReceipt,
  maybeAlertRegistrationRefundFailed,
  refundEntryUnderLock,
  registrationRefundKey,
  resolveRefundPolicy,
} from "./refunds";
export type { ResolvedRefundPolicy } from "./refunds";
export { handleRegistrationDispute, buildDisputeEvidence } from "./disputes";
export { releaseSoloSignUpPlacement } from "./withdraw";
export { queueRegistrationApprovedMails, queueRegistrationJoinedMail, queueRegistrationRejectedMails } from "./lifecycle-mail";
export {
  publicRegistrationStatus,
  withdrawRegistrationPublic,
  anyOptedOutByRegistration,
  publicRegistrationStatusByRef,
  withdrawRegistrationByRef,
  publicCartByRef,
} from "./public-status";
export type { PublicStatusView, PublicRefView, PublicCartEntryView, PublicCartView } from "./public-status";
export { groupByRef, groupById } from "./group-status";
export type { GroupEntryPlayerView, GroupEntryView, GroupStatusView } from "./group-status";
export { sweepRegistrations } from "./sweep";
export { rosterCapExpr, effectivePoolDeadline, soloPoolIsFull, listRegistrations } from "./list";
export type { ListRegistrationsFilters, RegistrationListRow } from "./list";
export {
  confirmRegistration,
  markRegistrationPaidOffline,
  confirmRegistrationWaived,
  sendPaymentReminder,
  waitlistRegistration,
  withdrawRegistrationOrganiser,
  refundRegistration,
} from "./organiser-actions";
export { exportRegistrationsCsv, registrationIcs } from "./csv-ics";
