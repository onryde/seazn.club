import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface ExternalPlayInviteArgs {
  orgName: string;
  opponentName: string;
  roundNo: number;
  /** The board's scheduled start — what players are SHOWN (D12). */
  scheduledLabel: string;
  /** opened_at + DEADLINE_AFTER_MS: the last moment to take the seat. */
  deadlineLabel: string;
  fixtureUrl: string;
}

/** D12: the organiser opened the round. Sent once per player per board per
 *  pairing (T19). The CTA is the Seazn fixture page — the game is played on
 *  Seazn's board, never a lichess.org link (D3). */
export function externalPlayInviteTemplate(
  args: ExternalPlayInviteArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const vars = {
    opponentName: args.opponentName,
    roundNo: String(args.roundNo),
    when: args.scheduledLabel,
    deadline: args.deadlineLabel,
    orgName: args.orgName,
    fixtureUrl: args.fixtureUrl,
  };
  // `paragraph` takes HTML: the names are organiser- and player-supplied text,
  // so they are escaped there (the claim-invite pattern). Subject, preheader,
  // title, footer and the text part are plain text and take them raw.
  const html = {
    ...vars,
    opponentName: escapeHtml(args.opponentName),
    orgName: escapeHtml(args.orgName),
    when: escapeHtml(args.scheduledLabel),
    deadline: escapeHtml(args.deadlineLabel),
  };
  const subject = t(dict, "externalPlayInvite.subject", vars);
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "externalPlayInvite.preheader", vars),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "externalPlayInvite.title", vars),
      contentHtml:
        paragraph(t(dict, "externalPlayInvite.body", html)) +
        paragraph(t(dict, "externalPlayInvite.deadline", html)) +
        button(t(dict, "externalPlayInvite.button"), args.fixtureUrl) +
        linkFallback(args.fixtureUrl),
      footerNote: t(dict, "externalPlayInvite.footer", vars),
    }),
    text: t(dict, "externalPlayInvite.text", vars),
  };
}
