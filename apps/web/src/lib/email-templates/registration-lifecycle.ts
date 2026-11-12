// The registrant's lifecycle mails (polish wave P2: walkthrough W1-W4, W10, W11, W13) - what happens to an entry AFTER the confirmation:
// the payment landed, the organiser approved it, the unpaid place was released, the organiser withdrew it, a teammate joined it.
// Five small templates on one shared shell, so the copy of "who is this for, which entry, where do I look" is written once.
// `dict` = the emails namespace for the recipient's locale (see lib/email.ts).
import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";

type Content = { subject: string; html: string; text: string };

/** What every lifecycle mail names: the club, the competition, the division, and the entry the mail is about. */
export interface LifecycleBase {
  orgName: string;
  competitionName: string;
  /** Two entries of one person are otherwise the same mail: the division says which one. */
  divisionName: string;
  /** The entry (a person, pair or team name). Named in the body; never the greeting (a team is not a person). */
  displayName: string;
  /** The quotable reference, when the recipient owns it (the contact does; a teammate does not). */
  refCode?: string | null;
}

const shell = (dict: Dict, ns: string, base: LifecycleBase) => ({
  mastheadTag: base.orgName,
  eyebrow: `${base.orgName} · ${base.competitionName}`,
  footerNote: t(dict, `${ns}.footer`, { competitionName: base.competitionName, orgName: base.orgName }),
});

const referenceHtml = (dict: Dict, ns: string, refCode: string | null | undefined): string =>
  refCode ? paragraph(t(dict, `${ns}.reference`, { refCode: escapeHtml(refCode) })) : "";

const referenceText = (dict: Dict, ns: string, refCode: string | null | undefined): string =>
  refCode ? "\n" + t(dict, `${ns}.textReference`, { refCode }) : "";

// ------------------------------------------------------------------------------------------------------------------------------
// registration_paid

export interface RegistrationPaidArgs extends LifecycleBase {
  /** The person the mail is for: the registration's contact. */
  contactName: string;
  /** THIS entry's own payment (never the cart's total). */
  amountCents: number;
  currency: string;
  /** What the entry IS now, read from the row after the write: `true` = confirmed; `false` = paid and waiting for the organiser's
   *  approval. Never a promise the producer made before the write. */
  confirmed: boolean;
  /** The entry's own status page (`/r/<ref>`). */
  statusUrl?: string | null;
}

/** The payment landed (card webhook, or the organiser marking an offline payment): the amount, the entry, and the honest state. */
export function registrationPaidTemplate(opts: RegistrationPaidArgs, dict: Dict): Content {
  const ns = "registrationPaid";
  const amount = money(opts.amountCents, opts.currency);
  const subject = t(dict, `${ns}.subject`, { competitionName: opts.competitionName });
  const stateTitle = t(dict, opts.confirmed ? `${ns}.confirmedTitle` : `${ns}.approvalTitle`);
  const stateBody = t(dict, opts.confirmed ? `${ns}.confirmedBody` : `${ns}.approvalBody`);
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, `${ns}.preheader`, { amount, competitionName: opts.competitionName }),
      ...shell(dict, ns, opts),
      title: t(dict, `${ns}.title`),
      contentHtml:
        paragraph(
          t(dict, `${ns}.intro`, {
            contactName: escapeHtml(opts.contactName),
            amount,
            displayName: escapeHtml(opts.displayName),
            divisionName: escapeHtml(opts.divisionName),
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        panel(stateTitle, stateBody) +
        (opts.statusUrl ? button(t(dict, `${ns}.viewEntry`), opts.statusUrl) + linkFallback(opts.statusUrl) : "") +
        referenceHtml(dict, ns, opts.refCode),
    }),
    text:
      t(dict, `${ns}.text`, { competitionName: opts.competitionName, orgName: opts.orgName }) +
      "\n" +
      t(dict, `${ns}.textAmount`, { amount, displayName: opts.displayName, divisionName: opts.divisionName }) +
      "\n\n" +
      stateTitle +
      "\n" +
      stateBody +
      (opts.statusUrl ? "\n\n" + t(dict, `${ns}.textStatus`, { url: opts.statusUrl }) : "") +
      referenceText(dict, ns, opts.refCode),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// registration_approved

export interface RegistrationApprovedArgs extends LifecycleBase {
  /** Who this copy is for: the contact, or a teammate with an address on the entry. */
  recipientName: string;
  /** The public competition page. A teammate has no status token, so this is never the status page. */
  competitionUrl?: string | null;
}

/** The organiser approved the entry: the place is confirmed. */
export function registrationApprovedTemplate(opts: RegistrationApprovedArgs, dict: Dict): Content {
  const ns = "registrationApproved";
  const subject = t(dict, `${ns}.subject`, { competitionName: opts.competitionName });
  const names = { displayName: opts.displayName, divisionName: opts.divisionName };
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, `${ns}.preheader`, { displayName: opts.displayName, competitionName: opts.competitionName }),
      ...shell(dict, ns, opts),
      title: t(dict, `${ns}.title`),
      contentHtml:
        paragraph(
          t(dict, `${ns}.intro`, {
            recipientName: escapeHtml(opts.recipientName),
            displayName: escapeHtml(names.displayName),
            divisionName: escapeHtml(names.divisionName),
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        (opts.competitionUrl ? button(t(dict, `${ns}.viewCompetition`), opts.competitionUrl) + linkFallback(opts.competitionUrl) : "") +
        referenceHtml(dict, ns, opts.refCode),
    }),
    text:
      t(dict, `${ns}.text`, { competitionName: opts.competitionName, orgName: opts.orgName }) +
      "\n" +
      t(dict, `${ns}.textBody`, names) +
      (opts.competitionUrl ? "\n\n" + opts.competitionUrl : "") +
      referenceText(dict, ns, opts.refCode),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// registration_expired

export interface RegistrationExpiredArgs extends LifecycleBase {
  contactName: string;
  /** The competition's public registration page: how to register again. */
  registerUrl?: string | null;
}

/** The sweep released an unpaid place: say so, and how to try again. */
export function registrationExpiredTemplate(opts: RegistrationExpiredArgs, dict: Dict): Content {
  const ns = "registrationExpired";
  const subject = t(dict, `${ns}.subject`, { competitionName: opts.competitionName });
  const names = { displayName: opts.displayName, divisionName: opts.divisionName };
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, `${ns}.preheader`, { competitionName: opts.competitionName }),
      ...shell(dict, ns, opts),
      title: t(dict, `${ns}.title`),
      contentHtml:
        paragraph(
          t(dict, `${ns}.intro`, {
            contactName: escapeHtml(opts.contactName),
            displayName: escapeHtml(names.displayName),
            divisionName: escapeHtml(names.divisionName),
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        panel(t(dict, `${ns}.panelTitle`), t(dict, `${ns}.panelBody`)) +
        (opts.registerUrl ? button(t(dict, `${ns}.registerAgain`), opts.registerUrl) + linkFallback(opts.registerUrl) : "") +
        referenceHtml(dict, ns, opts.refCode),
    }),
    text:
      t(dict, `${ns}.text`, { competitionName: opts.competitionName, orgName: opts.orgName }) +
      "\n" +
      t(dict, `${ns}.textBody`, names) +
      (opts.registerUrl ? "\n\n" + t(dict, `${ns}.textRegisterAgain`) + "\n" + opts.registerUrl : "") +
      referenceText(dict, ns, opts.refCode),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// registration_withdrawn

export interface RegistrationWithdrawnArgs extends LifecycleBase {
  contactName: string;
}

/** The ORGANISER withdrew the entry (a self-withdrawal mails nothing: the person did it themselves). */
export function registrationWithdrawnTemplate(opts: RegistrationWithdrawnArgs, dict: Dict): Content {
  const ns = "registrationWithdrawn";
  const subject = t(dict, `${ns}.subject`, { competitionName: opts.competitionName });
  const names = { displayName: opts.displayName, divisionName: opts.divisionName };
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, `${ns}.preheader`, { displayName: opts.displayName, competitionName: opts.competitionName }),
      ...shell(dict, ns, opts),
      title: t(dict, `${ns}.title`),
      contentHtml:
        paragraph(
          t(dict, `${ns}.intro`, {
            contactName: escapeHtml(opts.contactName),
            displayName: escapeHtml(names.displayName),
            divisionName: escapeHtml(names.divisionName),
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        panel(t(dict, `${ns}.panelTitle`), t(dict, `${ns}.panelBody`)) +
        referenceHtml(dict, ns, opts.refCode),
    }),
    text:
      t(dict, `${ns}.text`, { competitionName: opts.competitionName, orgName: opts.orgName }) +
      "\n" +
      t(dict, `${ns}.textBody`, names) +
      referenceText(dict, ns, opts.refCode),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------
// registration_joined

/** What the entry the player joined IS right now. `null` = the producer could not name a state it can stand behind: the mail then
 *  says nothing about the entry's standing rather than something false. */
export type JoinedState = "confirmed" | "waitlisted" | "payment" | "approval" | "payment_and_approval";

const JOINED_STATE_KEYS: Record<JoinedState, { title: string; body: string }> = {
  confirmed: { title: "registrationJoined.stateConfirmedTitle", body: "registrationJoined.stateConfirmedBody" },
  waitlisted: { title: "registrationJoined.stateWaitlistedTitle", body: "registrationJoined.stateWaitlistedBody" },
  payment: { title: "registrationJoined.statePaymentTitle", body: "registrationJoined.statePaymentBody" },
  approval: { title: "registrationJoined.stateApprovalTitle", body: "registrationJoined.stateApprovalBody" },
  payment_and_approval: { title: "registrationJoined.statePaymentApprovalTitle", body: "registrationJoined.statePaymentApprovalBody" },
};

export interface RegistrationJoinedArgs extends LifecycleBase {
  playerName: string;
  state: JoinedState | null;
  /** The public competition page (a joiner holds no status token). */
  competitionUrl?: string | null;
}

/** A teammate claimed a slot on an entry: which entry, and honestly where it stands (a joiner on an unpaid or unapproved team is
 *  NOT "in" yet, and the mail says what the entry is waiting on). */
export function registrationJoinedTemplate(opts: RegistrationJoinedArgs, dict: Dict): Content {
  const ns = "registrationJoined";
  const subject = t(dict, `${ns}.subject`, { displayName: opts.displayName, competitionName: opts.competitionName });
  const keys = opts.state ? JOINED_STATE_KEYS[opts.state] : null;
  const stateTitle = keys ? t(dict, keys.title) : "";
  const stateBody = keys ? t(dict, keys.body) : "";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, `${ns}.preheader`, { displayName: opts.displayName, competitionName: opts.competitionName }),
      ...shell(dict, ns, opts),
      title: t(dict, `${ns}.title`),
      contentHtml:
        paragraph(
          t(dict, `${ns}.intro`, {
            playerName: escapeHtml(opts.playerName),
            displayName: escapeHtml(opts.displayName),
            divisionName: escapeHtml(opts.divisionName),
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        (keys ? panel(stateTitle, stateBody) : "") +
        (opts.competitionUrl ? button(t(dict, `${ns}.viewCompetition`), opts.competitionUrl) + linkFallback(opts.competitionUrl) : ""),
    }),
    text:
      t(dict, `${ns}.text`, { displayName: opts.displayName, competitionName: opts.competitionName, orgName: opts.orgName }) +
      "\n" +
      t(dict, `${ns}.textDivision`, { divisionName: opts.divisionName }) +
      (keys ? "\n\n" + stateTitle + "\n" + stateBody : "") +
      (opts.competitionUrl ? "\n\n" + opts.competitionUrl : ""),
  };
}
