import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
} from "@/lib/payment-instructions";

/** One cart entry, as it renders in the confirmation email — its own
 *  display name, status and fee. `status` is the raw `registrations.status`
 *  word (`pending|paid|confirmed|waitlisted|withdrawn|expired|rejected`);
 *  an unrecognised value falls back to itself rather than throwing, the
 *  same defensiveness `formatDeadline` et al. already apply to caller
 *  input. */
export interface RegistrationEmailEntry {
  displayName: string;
  status: string;
  feeCents: number;
}

/** RS005 W4 — cart-shaped (owner ruling 2026-08-25): one email per cart,
 *  every entry with its own status/fee, one total, one pay link. A
 *  single-entry cart (most carts) still renders as a clean single-entry
 *  email — see `registrationTemplate`'s own branch below — not a list of
 *  one. */
export interface RegistrationEmailArgs {
  orgName: string;
  competitionName: string;
  /** Always at least one entry. */
  entries: RegistrationEmailEntry[];
  /** The cart's payable subtotal (`registration_groups.amount_cents` —
   *  sum of NON-waitlisted entries' fees). NOT recomputed from
   *  `entries[].feeCents` here — callers own that invariant, same as every
   *  other cart-total reader in this codebase (registrations.ts). */
  totalCents: number;
  currency: string;
  paymentInstructions: string | null;
  /** Card entries (spec §3): direct pay link + the 48h deadline. */
  payUrl?: string | null;
  payDeadline?: Date | string | null;
  statusUrl: string;
  /** Quotable reference (v3/05 §3) + its public status page. */
  refCode?: string | null;
  refStatusUrl?: string | null;
}

export function formatDeadline(d: Date | string): string {
  return new Date(d).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  });
}

/** `registrations.status` → its i18n key. Every value the column can hold
 *  (RegistrationRow["status"], registrations.ts) has one here — unlike the
 *  ICS description's partial map (registrations.ts's REG_ICS_STATUS_KEY),
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

function entryStatusLabel(dict: Dict, status: string): string {
  const key = ENTRY_STATUS_KEYS[status];
  return key ? t(dict, key) : status;
}

/** One line of the entries panel/text list. Word order is entirely the
 *  dict's call (registration.entryLine{With,No}Fee take displayName/status/
 *  amount as named placeholders, never string-built here) — some locales
 *  put the status before the name. Deliberately NOT escapeHtml'd here: the
 *  HTML rendering escapes the WHOLE joined block once, in panel() (see
 *  registrationTemplate below) — escaping per-line here would double-escape
 *  a name like "A & B". */
function entryLine(dict: Dict, e: RegistrationEmailEntry, currency: string): string {
  const status = entryStatusLabel(dict, e.status);
  return e.feeCents > 0
    ? t(dict, "registration.entryLineWithFee", { displayName: e.displayName, status, amount: money(e.feeCents, currency) })
    : t(dict, "registration.entryLineNoFee", { displayName: e.displayName, status });
}

/** Registration confirmation — carries the offline (cash/bank) payment
 *  instructions for a paid cart. `dict` = emails namespace for the
 *  recipient's locale (see lib/email.ts senders). */
export function registrationTemplate(
  opts: RegistrationEmailArgs,
  dict: Dict,
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
  // or withdrawn/rejected (registrations.ts's buildCartMail sums exactly
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
  const amount = money(owedCents, opts.currency);
  // Markdown instructions → plain text for the panel, with the registrant's
  // reference substituted for {{reference}}.
  const instructions = opts.paymentInstructions
    ? paymentInstructionsText(fillPaymentInstructions(opts.paymentInstructions, opts.refCode))
    : null;
  const intro = single
    ? waitlisted
      ? t(dict, "registration.introWaitlist", { competitionName: escapeHtml(opts.competitionName) })
      : t(dict, "registration.intro", {
          displayName: escapeHtml(first.displayName),
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
        opts.entries.map((e) => entryLine(dict, e, opts.currency)).join("\n"),
      );
  const entriesText = single
    ? ""
    : "\n\n" +
      t(dict, "registration.textEntriesHeading") +
      "\n" +
      opts.entries.map((e) => entryLine(dict, e, opts.currency)).join("\n");

  const card = paid && !!opts.payUrl;
  const deadline = opts.payDeadline ? formatDeadline(opts.payDeadline) : null;

  const paymentBlock = card
    ? panel(
        t(dict, "registration.feePanelTitle", { amount }),
        deadline
          ? t(dict, "registration.feeHeldUntil", { deadline })
          : t(dict, "registration.feeHeld"),
      ) + button(t(dict, "registration.payNow", { amount }), opts.payUrl as string)
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
      opts.payUrl
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
      "\n\n" +
      t(dict, "registration.textView", { url: opts.statusUrl }),
  };
}
