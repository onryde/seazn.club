import { button, linkFallback, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";

// Quick match mail (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §7.6, C2): the link and the friendly name only,
// no marketing copy. The name is the guest's own text: it goes into the subject, the title (renderEmail escapes it, once) and
// the plain text, never into an HTML block unescaped. The link carries the home token in its PATH (C19); this mail is the one
// place besides the address bar it may appear.

export interface QuickMatchEmailArgs {
  /** The match's friendly name, as the guest typed it. */
  name: string;
  /** The match's home, `<base>/q/<token>` (`routes.quickMatch`). */
  link: string;
  /** When the match expires if nobody scores or saves it. Carried for the producers' sake; the copy names no date (a guest's
   *  time zone is unknown). */
  expiresAt: Date;
}

/** The reminder's arguments (plan 3 Amend T1 [D4]): the home link, and the Save link, `<base>/q/<token>/save`, a PATH, never a
 *  query (C19). Defined here so the reminder's producer (plan 3 Task 2) reopens no template file. */
export interface QuickMatchReminderArgs extends QuickMatchEmailArgs {
  saveLink: string;
}

type Rendered = { subject: string; html: string; text: string };

/** The link mail at creation (§7.6): sent once, to the address the guest typed, so the match can be found again. `dict` = the
 *  emails namespace in the setup form's language. */
export function quickMatchLinkTemplate(args: QuickMatchEmailArgs, dict: Dict): Rendered {
  const subject = t(dict, "quickMatchLink.subject", { name: args.name });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "quickMatchLink.preheader"),
      eyebrow: t(dict, "quickMatchLink.eyebrow"),
      title: args.name,
      contentHtml: paragraph(t(dict, "quickMatchLink.body")) + button(t(dict, "quickMatchLink.button"), args.link) + linkFallback(args.link),
      footerNote: t(dict, "quickMatchLink.footer"),
    }),
    text: t(dict, "quickMatchLink.text", { name: args.name, link: args.link }),
  };
}

/** The one reminder before expiry (C2): the home link and a "Save it" button. Its copy says "tomorrow", which holds while the
 *  reminder goes at most QUICK_MATCH_REMINDER_HOURS_BEFORE (24) hours before expiry; quick-match-email.test.ts pins that bound. */
export function quickMatchReminderTemplate(args: QuickMatchReminderArgs, dict: Dict): Rendered {
  const subject = t(dict, "quickMatchReminder.subject", { name: args.name });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "quickMatchReminder.preheader"),
      eyebrow: t(dict, "quickMatchReminder.eyebrow"),
      title: args.name,
      contentHtml:
        paragraph(t(dict, "quickMatchReminder.body")) +
        button(t(dict, "quickMatchReminder.save"), args.saveLink) +
        button(t(dict, "quickMatchReminder.button"), args.link) +
        linkFallback(args.link),
      footerNote: t(dict, "quickMatchReminder.footer"),
    }),
    text: t(dict, "quickMatchReminder.text", { name: args.name, link: args.link, saveLink: args.saveLink }),
  };
}
