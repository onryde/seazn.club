import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";
import { fixtureWhen, officialRoleLabel } from "./official-assigned";

export interface OfficialAssignmentChangedArgs {
  orgName: string;
  officialName: string;
  roleKey: string;
  label: string;
  prevAt: string | null;
  nextAt: string | null;
  venueTz: string | null;
  court: string | null;
  venue: string | null;
  meUrl: string;
}

/** A match the official is assigned to moved (PROMPT-57): old vs new slot in
 *  the venue zone, CTA back to /me. Sent for real timetable/venue changes
 *  only, never declined assignments. Everything in it is in `locale` (the
 *  official's, F5): the copy, the role, both times and "TBC". */
export function officialAssignmentChangedTemplate(
  args: OfficialAssignmentChangedArgs,
  dict: Dict,
  locale: Locale = "en",
): { subject: string; html: string; text: string } {
  const subject = t(dict, "officialChanged.subject", { orgName: args.orgName });
  const tbc = t(dict, "officialEmail.tbc");
  const where = [args.court, args.venue].filter(Boolean).join(" · ");
  const now = `${fixtureWhen(args.nextAt, args.venueTz, locale, tbc)}${where ? ` · ${where}` : ""}`;
  const was = fixtureWhen(args.prevAt, args.venueTz, locale, tbc);
  const detail =
    t(dict, "officialChanged.now", { detail: now }) +
    "\n" +
    t(dict, "officialChanged.was", { detail: was });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "officialChanged.preheader"),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "officialChanged.title"),
      contentHtml:
        paragraph(
          t(dict, "officialChanged.body", { orgName: args.orgName, role: officialRoleLabel(args.roleKey, dict) }),
        ) +
        panel(args.label, detail) +
        button(t(dict, "officialChanged.button"), args.meUrl) +
        linkFallback(args.meUrl),
      footerNote: t(dict, "officialChanged.footer", { orgName: args.orgName }),
    }),
    text:
      t(dict, "officialChanged.text", { orgName: args.orgName, meUrl: args.meUrl }) +
      `\n${args.label}\n${detail}`,
  };
}
