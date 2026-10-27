import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { t, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";

export interface OfficialAssignedArgs {
  orgName: string;
  officialName: string;
  meUrl: string;
  fixtures: {
    label: string;
    role_key: string;
    scheduled_at: string | null;
    /** Venue zone; emails can't know the reader's zone, so times are always
     *  rendered in the venue zone WITH the zone labelled. */
    venue_tz: string | null;
    venue: string | null;
    court_label: string | null;
  }[];
}

/** The Intl tag an email's locale formats dates with (en keeps the day-month order it always had). */
const DATE_TAG: Record<Locale, string> = { en: "en-GB", fr: "fr-FR", es: "es-ES", nl: "nl-NL" };

/** Venue-zone datetime with the zone labelled, in `locale`'s words and order; `tbc` when unscheduled. The defaults are the
 *  English the officials' exports print (`exports.ts`); an email passes its own locale and the dictionary's "TBC". */
export function fixtureWhen(at: string | null, tz: string | null, locale: Locale = "en", tbc = "TBC"): string {
  if (!at) return tbc;
  const zone = tz ?? "UTC";
  try {
    const s = new Date(at).toLocaleString(DATE_TAG[locale], {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${s} (${zone})`;
  } catch {
    return `${new Date(at).toISOString()} (UTC)`;
  }
}

// Static map, not a template literal: the repo's i18n convention keeps message keys enumerable. The preset crews' roles
// (lib/official-roles.ts ALL_OFFICIAL_ROLES); a custom role an organiser typed is shown as typed.
const ROLE_LABEL_KEY = new Map<string, string>([
  ["referee", "officialRole.referee"],
  ["chair_umpire", "officialRole.chair_umpire"],
  ["line_umpire", "officialRole.line_umpire"],
  ["linesman", "officialRole.linesman"],
  ["scorekeeper", "officialRole.scorekeeper"],
  ["timekeeper", "officialRole.timekeeper"],
  ["umpire", "officialRole.umpire"],
  ["technical_officer", "officialRole.technical_officer"],
  ["reserve_umpire", "officialRole.reserve_umpire"],
  ["judge", "officialRole.judge"],
  ["scorer", "officialRole.scorer"],
]);

/** An officiating role in the email's language: a preset role from the dictionary, a custom one as the organiser typed it. */
export function officialRoleLabel(roleKey: string, dict: Dict): string {
  const key = ROLE_LABEL_KEY.get(roleKey);
  return key !== undefined ? t(dict, key) : roleKey;
}

/** New officiating assignment(s) (PROMPT-57): one panel per match, CTA to the /me officiating lane where accept/decline lives.
 *  Everything in it is in `locale` (the official's: their account's, else the org's, F5): the dictionary copy, the role, the
 *  match time and "TBC". The caller builds the match labels in the same locale. */
export function officialAssignedTemplate(
  args: OfficialAssignedArgs,
  dict: Dict,
  locale: Locale = "en",
): { subject: string; html: string; text: string } {
  const subject = t(dict, "officialAssigned.subject", { orgName: args.orgName });
  const tbc = t(dict, "officialEmail.tbc");
  const lines = args.fixtures.map((f) => {
    const where = [f.court_label, f.venue].filter(Boolean).join(" · ");
    return {
      title: f.label,
      body: `${officialRoleLabel(f.role_key, dict)} · ${fixtureWhen(f.scheduled_at, f.venue_tz, locale, tbc)}${where ? ` · ${where}` : ""}`,
    };
  });
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "officialAssigned.preheader"),
      mastheadTag: args.orgName,
      eyebrow: args.orgName,
      title: t(dict, "officialAssigned.title"),
      contentHtml:
        paragraph(t(dict, "officialAssigned.body", { orgName: args.orgName })) +
        lines.map((l) => panel(l.title, l.body)).join("") +
        button(t(dict, "officialAssigned.button"), args.meUrl) +
        linkFallback(args.meUrl),
      footerNote: t(dict, "officialAssigned.footer", { orgName: args.orgName }),
    }),
    text:
      t(dict, "officialAssigned.text", { orgName: args.orgName, meUrl: args.meUrl }) +
      "\n" +
      lines.map((l) => `- ${l.title}: ${l.body}`).join("\n"),
  };
}
