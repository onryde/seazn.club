// The On stream tab's preview (R4 sponsors on stream S12; spec 2026-10-27 §5.1; ruling R11). Pure and client-safe: it folds
// nothing and reads no engine. The caller hands it the breaks of a REAL finished match (`DerivedReplay.breaks`, folded by the
// server through the sport's own `naturalBreaks.opensAt`), and it runs the SAME planner the overlay runs on every poll over them.
//
// "How many cards would that match have drawn?" is answered by replaying the match's polls: one `planSponsors` call per break, at
// the moment that break opened, with the assignments the earlier calls made frozen - exactly what the live overlay does, so the
// dial, the hidden/cooldown/freshness rules and the rotation all count. Nothing here restates a rule.
import {
  eligibleBreaks,
  planSponsors,
  type BreakOpened,
  type SponsorAssignment,
  type SponsorCard,
  type SponsorFrequency,
} from "@/lib/sponsor-plan";

export interface SponsorPreview {
  /** The breaks the dial lets through (`eligibleBreaks`): Light = the majors, Normal = majors + every 3rd minor, Busy = all. */
  breaks: number;
  /** The cards the planner would have handed out over the match: the eligible breaks, less the minors the 90 s cooldown thins.
   *  0 with no ticked sponsor. */
  cards: number;
}

/**
 * @param f      the dial position previewed.
 * @param breaks the whole match's natural breaks, ascending seq (a real finished fixture's).
 * @param cards  the TICKED cards (what the rotation draws on). Their order and tiers move who gets which break, never how many.
 */
export function previewForSport(
  f: SponsorFrequency,
  breaks: readonly BreakOpened[],
  cards: readonly SponsorCard[],
): SponsorPreview {
  const eligible = eligibleBreaks(breaks, f).length;
  const assigned: SponsorAssignment[] = [];
  for (let i = 0; i < breaks.length; i++) {
    const at = breaks[i]!;
    const { newAssignments } = planSponsors({
      breaks: breaks.slice(0, i + 1),
      windowSeqs: [at.seq],
      settings: { enabled: true, frequency: f },
      cards,
      assignedCards: [],
      assigned,
      operatorLog: [],
      nextPosition: assigned.length,
      now: Date.parse(at.at),
      complete: true,
    });
    assigned.push(...newAssignments);
  }
  return { breaks: eligible, cards: assigned.length };
}
