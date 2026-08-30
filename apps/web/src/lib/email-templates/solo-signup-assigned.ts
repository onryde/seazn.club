import { paragraph, renderEmail } from "./compose";
import { escapeHtml } from "./shared";
import { t, type Dict } from "@/lib/i18n";

export interface SoloSignUpAssignedArgs {
  orgName: string;
  competitionName: string;
  divisionName: string;
  /** The person who was placed — their own name, not the entry's. */
  playerName: string;
  /** The team they are now on. */
  teamName: string;
  /** Their group status page, so they can see it for themselves. */
  refStatusUrl?: string | null;
}

/**
 * RS009 — "you're on a team now".
 *
 * The one message this feature owes. Someone entered a team division alone,
 * was told by the public stepper that "the organiser will assign you to a
 * team once one has space", and then waited. This is the answer to that
 * promise, and without it the placement happens entirely inside the
 * organiser's console with the person it concerns never told.
 *
 * Owner ruling (2026-08-30): notify, but no veto — entering the pool IS the
 * request to be placed, and declining is already expressible as withdraw. So
 * this email has no accept/decline control and does not pretend to offer one.
 * Ruled the same day that only the PLACED PLAYER is emailed, not the
 * receiving captain: the captain sees the roster change on their own status
 * page, and this system already carries two unthrottled organiser-triggered
 * mailers without adding a third for the weaker half of the pair.
 *
 * Deliberately short. It answers who, which team, and where to look — there
 * is no money in it (they paid at submit) and no deadline to meet.
 */
export function soloSignUpAssignedTemplate(
  opts: SoloSignUpAssignedArgs,
  dict: Dict,
): { subject: string; html: string; text: string } {
  const subject = t(dict, "soloSignUpAssigned.subject", { teamName: opts.teamName });
  const intro = {
    playerName: opts.playerName,
    teamName: opts.teamName,
    divisionName: opts.divisionName,
    competitionName: opts.competitionName,
  };
  return {
    subject,
    html: renderEmail({
      subject,
      preheader: t(dict, "soloSignUpAssigned.preheader", { teamName: opts.teamName }),
      mastheadTag: opts.orgName,
      eyebrow: `${opts.orgName} · ${opts.competitionName}`,
      title: t(dict, "soloSignUpAssigned.title"),
      contentHtml:
        paragraph(
          t(dict, "soloSignUpAssigned.intro", {
            playerName: escapeHtml(opts.playerName),
            teamName: escapeHtml(opts.teamName),
            divisionName: escapeHtml(opts.divisionName),
            competitionName: escapeHtml(opts.competitionName),
          }),
        ) +
        (opts.refStatusUrl
          ? paragraph(
              t(dict, "soloSignUpAssigned.viewStatus", { url: opts.refStatusUrl }),
            )
          : ""),
    }),
    text:
      t(dict, "soloSignUpAssigned.intro", intro) +
      (opts.refStatusUrl ? `\n\n${opts.refStatusUrl}` : ""),
  };
}
