import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

export interface ExternalPlayReadyArgs {
  orgName: string;
  opponentName: string;
  scheduledLabel: string;
  fixtureUrl: string;
}

/** T−15 play-ready notice — CTA is the Seazn fixture page (durable), not a raw Lichess URL. */
export function externalPlayReadyTemplate(
  args: ExternalPlayReadyArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "externalPlayReady.subject", { opponentName: args.opponentName });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "externalPlayReady.preheader"),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "externalPlayReady.title"),
      contentHtml:
        paragraph(
          t(dict, "externalPlayReady.body", {
            opponentName: args.opponentName,
            when: args.scheduledLabel,
          }),
        ) +
        button(t(dict, "externalPlayReady.button"), args.fixtureUrl) +
        linkFallback(args.fixtureUrl),
      footerNote: t(dict, "externalPlayReady.footer", { orgName: args.orgName }),
    }),
    text: t(dict, "externalPlayReady.text", {
      opponentName: args.opponentName,
      when: args.scheduledLabel,
      fixtureUrl: args.fixtureUrl,
    }),
  };
}
