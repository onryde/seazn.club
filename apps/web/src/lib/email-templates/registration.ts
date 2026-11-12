import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { fmtPublicDeadline } from "@/lib/format";
import { t, type Dict } from "@/lib/i18n";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
} from "@/lib/payment-instructions";
import { entryWaitingOn } from "@/lib/registration-status";

/** One cart entry, as it renders in the confirmation email — its own
 *  display name, division, status and fee. `status` is the raw
 *  `registrations.status` word (`pending|paid|confirmed|waitlisted|withdrawn|expired|rejected`);
 *  an unrecognised value falls back to itself rather than throwing, the
 *  same defensiveness `formatDeadline` et al. already apply to caller
 *  input. `approval` is the entry's division's review mode: with the status and the
 *  fee it decides what the line says the entry is WAITING ON (`entryWaitingOn`) instead of a bare "Pending". */
export interface RegistrationEmailEntry {
  displayName: string;
  /** The division this entry is in: two entries for one person are otherwise the same line (polish wave W7). */
  divisionName: string;
  status: string;
  feeCents: number;
  approval: "auto" | "manual";
  /** The organiser approved this entry while its fee was owed (V511, polish wave P5 W12): it waits on payment alone. Absent = not
   *  approved, which is every entry at submit; the cart mail's rebuild (resend, dispute evidence) reads the live column. */
  approved?: boolean;
}

/** One "forward this link" line of the confirmation mail (polish wave P6): the team's join link for a team, the partner's claim
 *  link for a pair. `url` is the ABSOLUTE join url - a capability (whoever holds the code can join the entry), so only a producer
 *  that already holds the cart token passes one (`buildCartMail` gates it exactly like the Pay button). */
export interface RegistrationEmailInvite {
  displayName: string;
  divisionName: string;
  kind: "team" | "pair";
  url: string;
}

/** RS005 W4 — cart-shaped (owner ruling 2026-08-25): one email per cart,
 *  every entry with its own status/fee, one total, one pay link. A
 *  single-entry cart (most carts) still renders as a clean single-entry
 *  email — see `registrationTemplate`'s own branch below — not a list of
 *  one. */
export interface RegistrationEmailArgs {
  orgName: string;
  competitionName: string;
  /** The person the mail is for (`registration_groups.contact_name`): the greeting names them, never the entry
   *  (a team's name is not a person; polish wave W4). */
  contactName: string;
  /** Always at least one entry. */
  entries: RegistrationEmailEntry[];
  /** The cart's payable subtotal (`registration_groups.amount_cents` —
   *  sum of NON-waitlisted entries' fees). NOT recomputed from
   *  `entries[].feeCents` here — callers own that invariant, same as every
   *  other cart-total reader in this codebase (usecases/registrations/). */
  totalCents: number;
  currency: string;
  paymentInstructions: string | null;
  /** Card carts with a fee still owed: where the Pay button goes - the cart's own token-bearing status page (our details-first
   *  page, which pays the whole cart), never a Checkout url. Null: no Pay button. */
  payPageUrl?: string | null;
  payDeadline?: Date | string | null;
  /** The organiser's zone (`organizations.timezone` resolved): the deadline is written in it. UTC when absent. */
  timeZone?: string | null;
  statusUrl: string;
  /** Quotable reference (v3/05 §3) + its public status page. */
  refCode?: string | null;
  refStatusUrl?: string | null;
  /** Team / pair entries the recipient (the captain) can invite people to: one block each, after the payment block. Absent or empty
   *  = no invite block, which is every mail that carries no cart token (dispute evidence, the organiser's resend). */
  invites?: RegistrationEmailInvite[];
}

/** A pay-by moment as the mails write it: the status page's own spelling ("14 Nov 2026, 11:15 UTC", `fmtPublicDeadline`), in the org's
 *  zone and the recipient's locale. A producer that names neither gets UTC and English, which is what the mails always wrote. */
export function formatDeadline(d: Date | string, locale = "en", timeZone: string | null | undefined = null): string {
  return fmtPublicDeadline(locale, timeZone ?? "UTC", d);
}

/** `registrations.status` → its i18n key. Every value the column can hold
 *  (RegistrationRow["status"], usecases/registrations/types.ts) has one here — unlike the
 *  ICS description's partial map (usecases/registrations/csv-ics.ts's REG_ICS_STATUS_KEY),
 *  which falls back to the raw English word: that shortcut is fine for a
 *  calendar attachment nobody reads closely, not for the body of the mail
 *  itself, so this map is total. */
const ENTRY_STATUS_KEYS: Record<string, string> = {
  pending: "registration.entryStatusPending",
  paid: "registration.entryStatusPaid",
  confirmed: "registration.entryStatusConfirmed",
  waitlisted: "registration.entryStatusWaitlisted",
  withdrawn: "registration.entryStatusWithdrawn",
  expired: "registration.entryStatusExpired",
  rejected: "registration.entryStatusRejected",
};

/** What an entry that is waiting says it is waiting on, keyed by (waiting-on, status): a `paid` entry has already paid, so its
 *  approval-only wait reads "Paid, awaiting approval", where a `pending` one reads "Awaiting approval". */
const WAITING_KEYS = {
  payment: "registration.entryStatusAwaitingPayment",
  approval: "registration.entryStatusAwaitingApproval",
  payment_and_approval: "registration.entryStatusAwaitingPaymentApproval",
} as const;

function entryStatusLabel(dict: Dict, e: RegistrationEmailEntry): string {
  const waiting = entryWaitingOn(e.status, e.feeCents, e.approval, e.approved ?? false);
  if (waiting) {
    return t(dict, e.status === "paid" && waiting === "approval" ? "registration.entryStatusPaidAwaitingApproval" : WAITING_KEYS[waiting]);
  }
  const key = ENTRY_STATUS_KEYS[e.status];
  return key ? t(dict, key) : e.status;
}

/** One line of the entries panel/text list. Word order is entirely the
 *  dict's call (registration.entryLine{With,No}Fee take displayName/status/
 *  amount as named placeholders, never string-built here) — some locales
 *  put the status before the name. Deliberately NOT escapeHtml'd here: the
 *  HTML rendering escapes the WHOLE joined block once, in panel() (see
 *  registrationTemplate below) — escaping per-line here would double-escape
 *  a name like "A & B". */
function entryLine(dict: Dict, e: RegistrationEmailEntry, currency: string, locale: string): string {
  const status = entryStatusLabel(dict, e);
  const names = { displayName: e.displayName, divisionName: e.divisionName };
  return e.feeCents > 0
    ? t(dict, "registration.entryLineWithFee", { ...names, status, amount: money(e.feeCents, currency, locale) })
    : t(dict, "registration.entryLineNoFee", { ...names, status });
}

/** Registration confirmation — carries the offline (cash/bank) payment
 *  instructions for a paid cart. `dict` = emails namespace for the
 *  recipient's locale (see lib/email.ts senders). */
export function registrationTemplate(
  opts: RegistrationEmailArgs,
  dict: Dict,
  /** The language the mail is written in: the deadline's own spelling follows it. */
  locale = "en",
): { subject: string; html: string; text: string } {
  const single = opts.entries.length === 1;
  const first = opts.entries[0]!;
  // "Waitlisted" as the email's overall tone only applies to a single-entry
  // cart — a mixed cart (one confirmed, one waitlisted) has no one true
  // state to lead with, so it always uses the neutral "received" framing
  // and lets the entries panel below carry the per-entry nuance.
  const waitlisted = single && first.status === "waitlisted";
  // `totalCents` is the cart's whole payable SUBTOTAL — every non-waitlisted
  // entry's fee, INCLUDING one that is already `paid`/`confirmed` (settled)
  // or withdrawn/rejected (usecases/registrations/mail.ts's buildCartMail sums exactly
  // that). It answers "what did/does this cart cost", not "what is still
  // owed right now" — and this template is reused for more than the fresh
  // submit-time send: an organiser's resend on an already-settled entry, or
  // a dispute-evidence reconstruction, both call it long after money changed
  // hands. Gating the fee panel on `totalCents > 0` re-asked a PAID/
  // CONFIRMED registrant for money they had already given (RS005 F1 finding
  // 1) — `pending` is the one status that genuinely still owes: `paid`/
  // `confirmed` already collected it, `waitlisted` never had a fee due, and
  // withdrawn/rejected/expired never will again. Summing only THOSE
  // entries' fees is what the payment block should gate and quote — for a
  // fresh single-entry submit-time cart (the common case) every entry is
  // `pending`, so this is byte-identical to the old `totalCents > 0`.
  const owedCents = opts.entries.reduce(
    (sum, e) => sum + (e.status === "pending" ? e.feeCents : 0),
    0,
  );
  const paid = owedCents > 0;
  const amount = money(owedCents, opts.currency, locale);
  // Markdown instructions → plain text for the panel, with the registrant's
  // reference substituted for {{reference}}.
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;
  const intro = single
    ? waitlisted
      ? t(dict, "registration.introWaitlist", { competitionName: escapeHtml(opts.competitionName) })
      : t(dict, "registration.intro", {
          contactName: escapeHtml(opts.contactName),
          displayName: escapeHtml(first.displayName),
          divisionName: escapeHtml(first.divisionName),
          competitionName: escapeHtml(opts.competitionName),
        })
    : t(dict, "registration.introCart", { competitionName: escapeHtml(opts.competitionName) });

  // Entries panel — only for a genuine cart. A single entry already says
  // its own name/status in the intro line above; listing it again would
  // read like a list of one, which the owner ruling explicitly rejects.
  const entriesPanel = single
    ? ""
    : panel(
        t(dict, "registration.entriesPanelTitle"),
        opts.entries.map((e) => entryLine(dict, e, opts.currency, locale)).join("\n"),
      );
  const entriesText = single
    ? ""
    : "\n\n" +
      t(dict, "registration.textEntriesHeading") +
      "\n" +
      opts.entries.map((e) => entryLine(dict, e, opts.currency, locale)).join("\n");

  const card = paid && !!opts.payPageUrl;
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline, locale, opts.timeZone) : null;

  const paymentBlock = card
    ? panel(
        t(dict, "registration.feePanelTitle", { amount }),
        deadline
          ? t(dict, "registration.feeHeldUntil", { deadline })
          : t(dict, "registration.feeHeld"),
      ) + button(t(dict, "registration.payNow", { amount }), opts.payPageUrl as string)
    : paid && instructions
      ? panel(t(dict, "registration.feePanelTitle", { amount }), instructions as string)
      : paid
        ? paragraph(t(dict, "registration.feeContactOrganiser", { amount }))
        : "";

  const paymentText = card
    ? "\n\n" +
      t(dict, "registration.textFee", { amount }) +
      "\n" +
      (deadline
        ? t(dict, "registration.textHeldUntil", { deadline })
        : t(dict, "registration.textHeld")) +
      "\n" +
      opts.payPageUrl
    : paid && instructions
      ? "\n\n" +
        t(dict, "registration.textFee", { amount }) +
        "\n" +
        t(dict, "registration.textHowToPay") +
        "\n" +
        instructions
      : paid
        ? "\n\n" + t(dict, "registration.textFeeContactOrganiser", { amount })
        : "";

  // "Invite your teammates": the join link is meant to be FORWARDED, so it is a panel the captain copies from, not a button.
  // The panel's own escaping covers the url's `&`; the text part carries it verbatim.
  const invites = opts.invites ?? [];
  const inviteParts = invites.map((i) => {
    const names = { displayName: i.displayName, divisionName: i.divisionName };
    const title = t(dict, i.kind === "pair" ? "registration.invitePanelTitlePair" : "registration.invitePanelTitleTeam", names);
    const body = t(dict, i.kind === "pair" ? "registration.inviteBodyPair" : "registration.inviteBodyTeam", names);
    return { title, body, url: i.url };
  });
  const inviteBlock = inviteParts.map((i) => panel(i.title, i.body + "\n" + i.url)).join("");
  const inviteText = inviteParts.map((i) => "\n\n" + i.title + "\n" + i.body + "\n" + i.url).join("");

  const subject = t(dict, "registration.subject", { competitionName: opts.competitionName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: waitlisted
        ? t(dict, "registration.preheaderWaitlist", { competitionName: opts.competitionName })
        : paid
          ? t(dict, "registration.preheaderPaid", { competitionName: opts.competitionName })
          : t(dict, "registration.preheaderFree", { competitionName: opts.competitionName }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: waitlisted
        ? t(dict, "registration.titleWaitlist")
        : t(dict, "registration.title"),
      contentHtml:
        paragraph(intro) +
        entriesPanel +
        (opts.refCode
          ? panel(
              t(dict, "registration.refPanelTitle", { refCode: opts.refCode }),
              opts.refStatusUrl
                ? t(dict, "registration.refPanelBodyAt", { url: opts.refStatusUrl })
                : t(dict, "registration.refPanelBody"),
            )
          : "") +
        paymentBlock +
        inviteBlock +
        button(t(dict, "registration.viewButton"), opts.statusUrl) +
        linkFallback(opts.statusUrl),
      footerNote: t(dict, "registration.footer", {
        competitionName: opts.competitionName,
        orgName: opts.orgName,
      }),
    }),
    text:
      (waitlisted
        ? t(dict, "registration.textIntroWaitlist", {
            competitionName: opts.competitionName,
            orgName: opts.orgName,
          })
        : single
          ? t(dict, "registration.textIntro", {
              competitionName: opts.competitionName,
              orgName: opts.orgName,
            })
          : t(dict, "registration.textIntroCart", {
              competitionName: opts.competitionName,
              orgName: opts.orgName,
            })) +
      entriesText +
      (opts.refCode
        ? "\n\n" +
          t(dict, "registration.textRef", { refCode: opts.refCode }) +
          (opts.refStatusUrl
            ? "\n" + t(dict, "registration.textRefStatus", { url: opts.refStatusUrl })
            : "")
        : "") +
      paymentText +
      inviteText +
      "\n\n" +
      t(dict, "registration.textView", { url: opts.statusUrl }),
  };
}
