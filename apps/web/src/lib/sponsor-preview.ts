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
  type BreakDecl,
  type BreakOpened,
  type SponsorAssignment,
  type SponsorCard,
  type SponsorFrequency,
} from "@/lib/sponsor-plan";

/** What the server reads for one sport the scope plays (`loadOnStreamScope`), and all the tab needs to draw its strip. */
export interface SportPreviewSource {
  sportKey: string;
  /** The sport's declared break kinds with their sizes (`naturalBreaks.kinds`); null when it declares none (generic, chess,
   *  carrom): sponsors then appear on scene screens only. */
  kinds: readonly BreakDecl[] | null;
  /** The breaks of the org's most recent finished fixture of this sport, ascending seq; null when there is no such fixture,
   *  its replay did not run to the end, or it opened no break. Always null when `kinds` is. */
  sample: BreakOpened[] | null;
  /** The competition the sample's fixture belongs to; null exactly when `sample` is. The overlay draws a fixture's cards from
   *  the org-wide sponsors plus its OWN competition's, so the preview counts the same and not another competition's. */
  sampleCompetitionId: string | null;
  /** Whether the sample's competition carries sponsor tiers (`sponsorTiersOn`, the overlay's own question: an Event Pass
   *  counts on its competition only); null exactly when `sample` is (final review S12). */
  sampleTiered: boolean | null;
}

export interface SponsorPreview {
  /** The breaks the dial lets through (`eligibleBreaks`): Light = the majors, Normal = majors + every 3rd minor, Busy = all. */
  breaks: number;
  /** The cards the planner would have handed out over the match: the eligible breaks, less the minors the 90 s cooldown thins.
   *  0 with no ticked sponsor. */
  cards: number;
  /** The moment id (`sponsorMomentId(seq, kind)`) of each break that drew a card, in match order - what the strip fills in.
   *  Not the bare seq: one event can open two breaks. `aired.length === cards`. */
  aired: readonly string[];
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
  return { breaks: eligible, cards: assigned.length, aired: assigned.map((a) => a.momentId) };
}
