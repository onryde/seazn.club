import { button, linkFallback, panel, paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { fixtureWhen } from "./official-assigned";
import { plural, t, type Dict } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n-constants";

/** One match the ban covers, as `coveredMatches` (usecases/discipline.ts) projects it. `round` is the round's name,
 *  already in the reader's language (the ui catalogue's `bracket.round.*`); `null` is a PLACEHOLDER — the team has
 *  fewer fixtures left than the ban has matches to run. */
export interface SuspensionMiss {
  round: string | null;
  /** The other side; null while that seat is undecided. */
  opponent: string | null;
  scheduledAt: string | null;
  /** The venue zone the time is printed in (and labelled with) — an email cannot know its reader's. */
  tz: string | null;
}

export interface SuspensionConfirmedArgs {
  orgName: string;
  divisionName: string;
  reason: string;
  matchesTotal: number;
  /** The matches the player will miss, in order. Empty ⇒ no "You'll miss" line at all. */
  misses: SuspensionMiss[];
  meUrl: string;
}

/** Localized "N match(es)" phrase — the codebase has no plural engine, so we
 *  pick between two keys on n === 1. */
export function matchesPhrase(dict: Dict, n: number): string {
  return t(dict, n === 1 ? "suspension.match" : "suspension.matches", { n });
}

/**
 * "Round 4 vs Rovers · Sat 2 Nov, 10:00 (Europe/London), Next match (not scheduled yet)" — or `null` when there is
 * nothing to miss. Consecutive placeholders fold into ONE counted phrase ("Next 2 matches (not scheduled yet)"), so a
 * long ban at the end of a season does not repeat itself.
 */
export function missesLine(dict: Dict, misses: readonly SuspensionMiss[], locale: Locale): string | null {
  if (misses.length === 0) return null;
  const parts: string[] = [];
  let unscheduled = 0;
  const flush = () => {
    if (unscheduled > 0) parts.push(plural(dict, "suspensionConfirmed.missUnscheduled", unscheduled, locale));
    unscheduled = 0;
  };
  for (const m of misses) {
    if (m.round === null) {
      unscheduled++;
      continue;
    }
    flush();
    const match = t(dict, "suspensionConfirmed.missMatch", {
      round: m.round,
      opponent: m.opponent ?? t(dict, "suspensionConfirmed.missTbd"),
    });
    parts.push(m.scheduledAt === null ? match : `${match} · ${fixtureWhen(m.scheduledAt, m.tz, locale)}`);
  }
  flush();
  return t(dict, "suspensionConfirmed.misses", { fixtures: parts.join(", ") });
}

/** Sent to a claimed player when an organiser CONFIRMS a suspension (SPEC-1) —
 *  never for pending/auto rows. Courtside shell, system font stack (PR #134). */
export function suspensionConfirmedTemplate(
  args: SuspensionConfirmedArgs,
  dict: Dict,
  locale: Locale = "en",
): { subject: string; html: string; text: string } {
  const matches = matchesPhrase(dict, args.matchesTotal);
  const subject = t(dict, "suspensionConfirmed.subject", { division: args.divisionName });
  // Owner-approved 4A: which matches — opponent names are organiser-typed, so the line is escaped before it is HTML.
  const misses = missesLine(dict, args.misses, locale);
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "suspensionConfirmed.preheader", { matches }),
      mastheadTag: args.orgName,
      eyebrow: `${args.orgName} · ${args.divisionName}`,
      title: t(dict, "suspensionConfirmed.title"),
      contentHtml:
        paragraph(
          t(dict, "suspensionConfirmed.body", {
            org: args.orgName,
            division: args.divisionName,
            reason: args.reason,
            matches,
          }),
        ) +
        panel(args.divisionName, `${args.reason} · ${matches}`) +
        (misses === null ? "" : paragraph(escapeHtml(misses))) +
        button(t(dict, "suspensionConfirmed.button"), args.meUrl) +
        linkFallback(args.meUrl),
      footerNote: t(dict, "suspensionConfirmed.footer", { division: args.divisionName }),
    }),
    text:
      t(dict, "suspensionConfirmed.text", {
        org: args.orgName,
        division: args.divisionName,
        reason: args.reason,
        matches,
        meUrl: args.meUrl,
      }) + (misses === null ? "" : `\n\n${misses}`),
  };
}
