// Format recommendation (v3/06 §4): a pure function over entrant count,
// courts and the time budget → the 2–3 families that actually fit, each with
// a one-sentence trade-off. No AI, no I/O — the golden test pins the ranking.
import { omit } from "./omit";
import {
  FUNNEL_FORMATS,
  FUNNEL_MORE_FORMATS,
  funnelFormatMatches,
  funnelFormatMin,
  funnelFormatPerEntrant,
  type FunnelFormat,
} from "./funnel-formats";

export interface RecommendInput {
  entrants: number;
  courts: number;
  hours: number;
  /** Minutes a match blocks a court; 30 is a sane cross-sport default. */
  matchMinutes?: number;
}

export interface Recommendation {
  slug: string;
  title: string;
  matches: number;
  estHours: number;
  /** Rough matches per entrant — the "how much do people play" number. */
  perEntrant: number;
  reason: string;
}

interface Model {
  slug: string;
  title: string;
  matches: (n: number) => number;
  perEntrant: (n: number) => number;
  line: string;
}

const ceilLog2 = (n: number) => Math.ceil(Math.log2(Math.max(2, n)));

// Deliberately excludes ladder (no clock to budget) and stepladder (a finale
// bolted onto a league, not a standalone answer to "what fits my day").
const MODELS: Model[] = [
  {
    slug: "league",
    title: "League (round robin)",
    matches: (n) => (n * (n - 1)) / 2,
    perEntrant: (n) => n - 1,
    line: "everyone plays everyone — the fairest table if the clock allows",
  },
  {
    slug: "groups-knockout",
    title: "Groups + knockout",
    // pools of ~4 round robin, top 2 per pool into a bracket
    matches: (n) => {
      const pools = Math.max(2, Math.ceil(n / 4));
      const size = Math.ceil(n / pools);
      const group = pools * ((size * (size - 1)) / 2);
      const bracket = 2 * pools - 1;
      return group + bracket;
    },
    perEntrant: (n) => Math.ceil(n / Math.max(2, Math.ceil(n / 4))) - 1 + 1,
    line: "guaranteed group matches for all, a bracket finish for the best",
  },
  {
    slug: "swiss",
    title: "Swiss",
    matches: (n) => (ceilLog2(n) + 1) * Math.floor(n / 2),
    perEntrant: (n) => ceilLog2(n) + 1,
    line: "fixed rounds, nobody eliminated, equals meet equals",
  },
  {
    slug: "double_elim",
    title: "Double elimination",
    matches: (n) => 2 * n - 2,
    perEntrant: () => 2,
    line: "a second life for everyone — twice the matches of a knockout",
  },
  {
    slug: "knockout",
    title: "Knockout",
    matches: (n) => n - 1,
    perEntrant: () => 1,
    line: "fastest to a champion — but half the field plays once",
  },
];

export function recommendFormats(input: RecommendInput): Recommendation[] {
  const n = Math.max(2, Math.floor(input.entrants));
  const courts = Math.max(1, Math.floor(input.courts));
  const minutes = input.matchMinutes ?? 30;
  const capacity = Math.floor((input.hours * 60 * courts) / minutes);

  const scored = MODELS.map((m) => {
    const matches = Math.round(m.matches(n));
    const estHours = Math.round(((matches * minutes) / 60 / courts) * 10) / 10;
    return {
      slug: m.slug,
      title: m.title,
      matches,
      estHours,
      perEntrant: Math.round(m.perEntrant(n) * 10) / 10,
      fits: matches <= capacity,
      reason: `≈${matches} matches ≈ ${estHours}h on ${courts} court${courts === 1 ? "" : "s"} — ${m.line}.`,
    };
  });

  // Formats that fit the day first, richest play (matches per entrant) on
  // top; if nothing fits, least-overrun first so the advice stays honest.
  scored.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    if (a.fits) return b.perEntrant - a.perEntrant || a.matches - b.matches;
    return a.matches - b.matches;
  });

  return scored.slice(0, 3).map((r) => omit(r, "fits"));
}

// ---------------------------------------------------------------------------------------------------------------------
// The /start funnel's cards (start-wizard redesign, 2026-11-13). Unlike `recommendFormats` above (the console's strip),
// every count is the format layer's own (lib/funnel-formats.ts), read off the same knobs the claim builds the stages at,
// and nothing is dropped or reordered: every card in its fixed place, each telling whether it can be built at all
// (`available`) and whether it fits the day (`fits`). Best fit is a separate, honest question (`bestFitSlug`).
// ---------------------------------------------------------------------------------------------------------------------

export interface RankedFormat {
  slug: FunnelFormat;
  matches: number;
  estHours: number;
  perEntrant: number;
  /** Built AND inside the courts × hours budget. */
  fits: boolean;
  /** The field meets the format's minimum (`funnelFormatMin`). */
  available: boolean;
}

/** Every funnel format, FUNNEL_FORMATS then FUNNEL_MORE_FORMATS, in that fixed order. Refuses courts that are not a whole
 *  number of at least 1 and a day or match length that is not a positive number; a field that is not a whole number of
 *  at least 2 is refused by the format layer itself (`funnelFormatKnobs`). */
export function rankFormats(input: RecommendInput): RankedFormat[] {
  const n = input.entrants;
  const courts = input.courts;
  const minutes = input.matchMinutes ?? 30;
  if (!Number.isInteger(courts) || courts < 1) throw new RangeError(`courts must be a whole number of at least 1 (got ${courts})`);
  if (!Number.isFinite(input.hours) || input.hours <= 0) throw new RangeError(`hours must be positive (got ${input.hours})`);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new RangeError(`matchMinutes must be positive (got ${minutes})`);
  const capacity = Math.floor((input.hours * 60 * courts) / minutes);

  return [...FUNNEL_FORMATS, ...FUNNEL_MORE_FORMATS].map((slug) => {
    const matches = funnelFormatMatches(slug, n);
    const available = n >= funnelFormatMin(slug);
    return {
      slug,
      matches,
      estHours: Math.round(((matches * minutes) / 60 / courts) * 10) / 10,
      perEntrant: funnelFormatPerEntrant(slug, n),
      fits: available && matches <= capacity,
      available,
    };
  });
}

/** The card that wears Best fit: of the cards that fit, the one giving each entrant the most play, then the one with
 *  fewer matches, then the first on the page. Null when nothing fits — no badge rather than a badge on a format that
 *  runs over. */
export function bestFitSlug(ranked: readonly RankedFormat[]): FunnelFormat | null {
  let best: RankedFormat | null = null;
  for (const r of ranked) {
    if (!r.fits) continue;
    if (best === null || r.perEntrant > best.perEntrant || (r.perEntrant === best.perEntrant && r.matches < best.matches)) {
      best = r;
    }
  }
  return best?.slug ?? null;
}
