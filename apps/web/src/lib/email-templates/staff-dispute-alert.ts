import { panel, paragraph, renderEmail } from "./compose";
import { escapeHtml, money } from "./shared";
import { t, type Dict } from "@/lib/i18n";
import type { PassKey } from "@/lib/currency";
import type { DictionaryKey } from "@/lib/i18n-keys";

/** The dict key naming each disputed product. `Record<StaffDisputeKind, …>` over the pass
 *  rungs (v17 #294): a new rung in PASS_KEYS without a label here is a compile
 *  error, not a $59 chargeback triaged as the $29 product. */
const KIND_LABEL_KEY: Record<StaffDisputeKind, DictionaryKey> = {
  subscription: "staffDisputeAlert.kind.subscription",
  stream_credits: "staffDisputeAlert.kind.streamCredits",
  event_pass: "staffDisputeAlert.kind.pass",
  event_pass_l: "staffDisputeAlert.kind.passL",
  entry_fee: "staffDisputeAlert.kind.entryFee",
};

/** A disputed PLATFORM charge: a subscription, a match-credit pack (streaming R1) or the Event Pass rung that was bought (v17 #294). */
export type PlatformDisputeKind = "subscription" | "stream_credits" | PassKey;
/** Every charge a staff dispute alert can be about: the platform's own, plus a registrant's ENTRY FEE (a destination charge, so the
 *  dispute lands on the platform account and the organiser's Express account has no dispute screen). */
export type StaffDisputeKind = PlatformDisputeKind | "entry_fee";

/** What staff need to act on a disputed entry fee (registration defects fix round 1, I3). */
export interface EntryFeeDisputeDetail {
  competitionName: string;
  /** The entry's reference code, as the registrant and the organiser see it. */
  entryRef: string;
  /** Where the evidence pack is: the organiser-authenticated download for this entry (a URL, absolute). */
  evidenceUrl: string;
  /** Stripe's evidence deadline (`evidence_details.due_by`), null when the webhook did not carry one. */
  dueBy: Date | null;
  /** A LOST dispute only: what the transfer recovery pulled back off the organiser's connected balance, 0 when nothing. Absent
   *  before the dispute closes and on a won one. */
  recoveredCents?: number;
}

interface StaffDisputeAlertBase {
  orgName: string;
  phase: "created" | "closed";
  /** Stripe dispute status (needs_response / won / lost / …). */
  status: string;
  amountCents: number;
  currency: string;
  disputeId: string;
}

export type StaffDisputeAlertArgs =
  | (StaffDisputeAlertBase & { kind: PlatformDisputeKind })
  | (StaffDisputeAlertBase & { kind: "entry_fee"; entry: EntryFeeDisputeDetail });

/** Internal staff alert (payments-hardening Task 7, decisions §6.2): a PLATFORM
 *  charge — a Pro/Pro Plus subscription invoice or an Event Pass purchase — was
 *  disputed. Unlike a destination-charge dispute there is no transfer to
 *  reverse; recovery is entitlement truth-up, and this mail records what the
 *  webhook already did: flagged (created), cleared (won), auto-downgraded (a
 *  lost subscription) or revoked (a lost pass). Goes to STAFF_ALERT_EMAIL, so
 *  `dict` is the platform locale (en). */
export function staffDisputeAlertTemplate(
  opts: StaffDisputeAlertArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const amount = money(opts.amountCents, opts.currency);
  const kindLabel = t(dict, KIND_LABEL_KEY[opts.kind]);
  const outcomeKey = outcomeKeyFor(opts);
  // `kind` is handed to EVERY outcome, and only `revoked` interpolates it: that
  // line said a flat "the Event Pass has been revoked" for both rungs, so a lost
  // $59 L chargeback read as the $29 product in the one sentence that says what
  // was taken away. The other branches ignore the var. Dictionary-sourced, so
  // there is nothing to escape.
  const outcome = t(dict, outcomeKey, {
    kind: kindLabel,
    recovered: opts.kind === "entry_fee" ? money(opts.entry.recoveredCents ?? 0, opts.currency) : "",
  });
  const subject = t(dict, "staffDisputeAlert.subject", { orgName: opts.orgName, kind: kindLabel });
  const entry = opts.kind === "entry_fee" ? opts.entry : null;
  // An entry-fee dispute names the competition, the entry, the evidence deadline and where the pack is: what staff need to respond.
  const dueBy = entry?.dueBy ? `${entry.dueBy.toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
  const entryLines = entry
    ? [
        t(dict, "staffDisputeAlert.entry.line", { competitionName: entry.competitionName, entryRef: entry.entryRef }),
        dueBy ? t(dict, "staffDisputeAlert.entry.due", { dueBy }) : t(dict, "staffDisputeAlert.entry.dueUnknown"),
        t(dict, "staffDisputeAlert.entry.evidence", { evidenceUrl: entry.evidenceUrl }),
      ]
    : [];
  const title = t(dict, entry ? "staffDisputeAlert.entry.title" : "staffDisputeAlert.title");
  const bodyKey = entry ? "staffDisputeAlert.entry.body" : "staffDisputeAlert.body";
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "staffDisputeAlert.preheader", {
        amount,
        kind: kindLabel,
        orgName: opts.orgName,
      }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${kindLabel}`,
      title,
      contentHtml:
        paragraph(
          t(dict, bodyKey, {
            kind: kindLabel,
            orgName: escapeHtml(opts.orgName),
            amount,
            disputeId: escapeHtml(opts.disputeId),
            status: escapeHtml(opts.status),
          }),
        ) +
        entryLines.map((line) => paragraph(escapeHtml(line))).join("") +
        panel(t(dict, "staffDisputeAlert.panelTitle"), outcome),
      footerNote: t(dict, "staffDisputeAlert.footer"),
    }),
    text:
      t(dict, "staffDisputeAlert.textLine", { kind: kindLabel, orgName: opts.orgName }) +
      "\n" +
      t(dict, "staffDisputeAlert.textAmount", {
        amount,
        disputeId: opts.disputeId,
        status: opts.status,
      }) +
      "\n" +
      entryLines.map((line) => `${line}\n`).join("") +
      outcome,
  };
}

/** The outcome sentence a staffer acts on. An entry fee has its own arms: it is not a plan or a pass, so nothing is downgraded or
 *  revoked, and a LOST one says whether the amount was pulled back off the organiser's connected balance (`recoveredCents`). */
function outcomeKeyFor(opts: StaffDisputeAlertArgs): DictionaryKey {
  if (opts.kind === "entry_fee") {
    if (opts.phase === "created") return "staffDisputeAlert.outcome.entryFee.created";
    // `warning_closed` is an inquiry the bank dropped without a chargeback: no money was taken, the same ending as a win.
    if (opts.status === "won" || opts.status === "warning_closed") return "staffDisputeAlert.outcome.entryFee.won";
    if (opts.status === "lost") {
      return (opts.entry.recoveredCents ?? 0) > 0
        ? "staffDisputeAlert.outcome.entryFee.lostRecovered"
        : "staffDisputeAlert.outcome.entryFee.lostNotRecovered";
    }
    return "staffDisputeAlert.outcome.closed";
  }
  if (opts.phase === "created") return "staffDisputeAlert.outcome.created";
  if (opts.status === "won") return "staffDisputeAlert.outcome.won";
  if (opts.status === "lost") {
    if (opts.kind === "subscription") return "staffDisputeAlert.outcome.downgraded";
    // A lost match-credit dispute claws credits back CAPPED at the
    // balance and returns no competition to any allowance, so the
    // pass sentence ("the competition returns to the plan allowance")
    // would be false in both halves. The outcome line is the one
    // sentence a staffer acts on, so it gets its own key.
    return opts.kind === "stream_credits" ? "staffDisputeAlert.outcome.creditsClawedBack" : "staffDisputeAlert.outcome.revoked";
  }
  return "staffDisputeAlert.outcome.closed";
}
