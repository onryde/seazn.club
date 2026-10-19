import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface ExternalPlayInviteArgs {
  orgName: string;
  opponentName: string;
  roundNo: number;
  /** opened_at + DEADLINE_AFTER_MS: the last moment to take the seat — the
   *  ONE time the invite names. It carried the board's scheduled start too
   *  until T14 (T19 review M2): the round is open when this is sent, so a
   *  start time either repeated the open or contradicted the deadline. */
  deadlineLabel: string;
  /** Batch 1 onwards (spec §3.2.1): when THIS board's check-in opens. Absent for batch 0, whose check-in opens at the Open
   *  press, so the mail says "ready to play now" as it always did; present, it says WHEN (`bodyLater`, `textLater`). */
  opensLabel?: string;
  /** The player's own match room (`routes.sharedFixturePlay`), carrying their
   *  personal link token when they have one. */
  fixtureUrl: string;
}

/** D12: the organiser opened the round. Sent once per player per board per
 *  pairing (T19). The CTA is the player's Seazn match room — the game is
 *  played on Seazn's board, never a lichess.org link (D3). */
export function externalPlayInviteTemplate(
  args: ExternalPlayInviteArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const vars = {
    opponentName: args.opponentName,
    roundNo: String(args.roundNo),
    deadline: args.deadlineLabel,
    opens: args.opensLabel ?? "",
    orgName: args.orgName,
    fixtureUrl: args.fixtureUrl,
  };
  const later = args.opensLabel !== undefined;
  // `paragraph` takes HTML: the names are organiser- and player-supplied text,
  // so they are escaped there (the claim-invite pattern). Subject, preheader,
  // title, footer and the text part are plain text and take them raw.
  const html = {
    ...vars,
    opponentName: escapeHtml(args.opponentName),
    orgName: escapeHtml(args.orgName),
    deadline: escapeHtml(args.deadlineLabel),
    opens: escapeHtml(args.opensLabel ?? ""),
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
        paragraph(t(dict, later ? "externalPlayInvite.bodyLater" : "externalPlayInvite.body", html)) +
        paragraph(t(dict, "externalPlayInvite.deadline", html)) +
        button(t(dict, "externalPlayInvite.button"), args.fixtureUrl) +
        linkFallback(args.fixtureUrl),
      footerNote: t(dict, "externalPlayInvite.footer", vars),
    }),
    text: t(dict, later ? "externalPlayInvite.textLater" : "externalPlayInvite.text", vars),
  };
}
