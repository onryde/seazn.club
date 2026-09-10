// Spectator surface W2, Task 10 — the competition hub's Teams tab: every
// entrant the competition carries, grouped under its division, each a card
// linking to that division's Entrants tab.
//
// The document decides who is here and what they are called: `doc.teams` is
// built one division at a time (`competition-hub.ts:598-610`), already through
// `maskPublicEntrantNames`, already carrying its resolved badge and its own
// `?tab=entrants` href. Nothing here re-derives a name or a link.
//
// What it does decide is written out where it happens:
//
//  • the tab-level EMPTY sentence, which the hub itself cannot reach;
//  • the CREST, which is a three-armed decision the document does not make —
//    badge, painted monogram, or neutral monogram (see `Crest`);
//  • the monogram's INK, derived from the tile's own colour rather than fixed
//    (see `monogramInk`).
//
// NO `"use client"` — nothing here is stateful, so Task 11 can render it in a
// server component.
import Link from "next/link";
import { initials } from "@/components/ui/entity-logo";
import { contrastRatio } from "@/lib/contrast";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { CompetitionHubDocT, TeamCardT } from "@/server/public-site/competition-hub-schema";

export interface TeamsTabProps {
  doc: CompetitionHubDocT;
  dict: PublicDict;
}

/** `doc.teams` under one entry per division, in first-appearance order. Same
 *  shape and the same reasoning as `table-tab.tsx`'s and `stats-tab.tsx`'s —
 *  a `Map` keyed on `divisionId`, so a document whose entrants interleave
 *  still gets one heading per division rather than the same heading twice. */
function byDivision(teams: readonly TeamCardT[]): TeamCardT[][] {
  const groups = new Map<string, TeamCardT[]>();
  for (const tm of teams) {
    const group = groups.get(tm.divisionId);
    if (group) group.push(tm);
    else groups.set(tm.divisionId, [tm]);
  }
  return [...groups.values()];
}

/** The two inks a monogram may be set in. Fixed values rather than theme
 *  tokens, because the ratio below is computed against them: a token that
 *  resolves at paint time cannot be measured here. `#0f172a` is `slate-900`,
 *  the ink `EntityLogo`'s own neutral tile sits near. */
const LIGHT_INK = "#ffffff";
const DARK_INK = "#0f172a";

/**
 * How to paint an entrant's monogram tile, or null to leave it neutral.
 *
 * TWO reasons this is a function and not `style={{ background: colour }}`,
 * which is what the brief asked for:
 *
 * 1. `entrants.colour` is free text (`TeamCard.colour` is
 *    `z.string().nullable()`), and `lib/contrast.ts`'s `expandHex` THROWS on
 *    anything that is not a hex colour — measured: `relativeLuminance("puce")`
 *    raises `not a hex colour: puce`. An unguarded call would take the whole
 *    spectator page down for one bad value typed into a form years ago.
 *    Anything unmeasurable therefore falls back to the neutral tile, and
 *    nothing unmeasurable ever reaches `style`.
 * 2. A fixed ink is wrong for half the colour wheel. White on `#123456` is
 *    12.7:1; white on a club's yellow `#ffdd00` is 1.3:1, which is not text.
 *    The ink is picked by the WCAG ratio itself rather than by a luminance
 *    threshold typed in here, using the repo's own formula — the same
 *    derivation `_THEMES.md §5` makes for the moments slab, so a red-branded
 *    org and a yellow-branded one both get a readable monogram.
 *
 * Returned as a pair rather than as two calls, so the background a ratio was
 * computed against and the ink it chose cannot come apart.
 */
export function monogramInk(colour: string | null): { bg: string; ink: string } | null {
  if (!colour) return null;
  try {
    const ink =
      contrastRatio(colour, LIGHT_INK) >= contrastRatio(colour, DARK_INK) ? LIGHT_INK : DARK_INK;
    return { bg: colour, ink };
  } catch {
    return null;
  }
}

// One geometry for all three crest arms — a badge, a painted monogram and a
// neutral one are the same box at the same size, and three copies of these
// classes is how they stop being.
const CREST_CLASS =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md align-middle text-[10px] font-semibold";

/** Badge → the image. Colour → a monogram painted in it. Neither → a neutral
 *  monogram. `aria-hidden` throughout, exactly as `EntityLogo` does it: the
 *  entrant's NAME is beside the crest, so announcing initials as well reads
 *  the same team twice.
 *
 *  Not `EntityLogo` itself, which is otherwise THE badge renderer here: its
 *  fallback chain ends in a fixed slate tile and has no arm for an entrant's
 *  own colour, and adding one would change every surface that renders a badge.
 *  This tile is the Teams tab's, and the shared component keeps its contract. */
function Crest({ team }: { team: TeamCardT }) {
  if (team.badgeUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={team.badgeUrl}
        alt=""
        aria-hidden
        className={`${CREST_CLASS} bg-white object-contain`}
      />
    );
  }
  const paint = monogramInk(team.colour);
  if (paint) {
    return (
      <span
        aria-hidden
        className={CREST_CLASS}
        style={{ background: paint.bg, color: paint.ink }}
      >
        {initials(team.name)}
      </span>
    );
  }
  return (
    <span aria-hidden className={`${CREST_CLASS} bg-slate-100 text-slate-500`}>
      {initials(team.name)}
    </span>
  );
}

export function TeamsTab({ doc, dict }: TeamsTabProps) {
  // Stated first, like both siblings. Unreachable through the hub —
  // `deriveHubTabs` (`lib/matches-hub.ts:242`) only emits the `teams` tab when
  // `teams > 0` — so what this catches is a direct render and a `?tab=teams`
  // deep link that outlived its data.
  //
  // `division.entrantsEmpty`, NOT a `teams.empty` of its own, and that is a
  // deliberate reuse rather than an oversight. There is no `teams.empty` key in
  // any of the four dictionaries; the sentence this tab needs is word for word
  // the one the division page already shows above the same list of the same
  // people ("No entrants yet" / "Aún no hay participantes"), and this tab's
  // cards link INTO that list. A second key would be a second set of words for
  // one sentence, which is how translations drift apart. The namespace reads
  // oddly here and the owner may prefer a `teams.empty`; that is a
  // four-dictionary addition plus a `gen-keys` regeneration, recorded in the
  // task report rather than taken unilaterally.
  if (doc.teams.length === 0) {
    return (
      <p data-testid="mh-teams-empty" className="py-8 text-center text-sm text-ink-muted">
        {t(dict, "division.entrantsEmpty")}
      </p>
    );
  }

  return (
    // `min-w-0` on the root for the mount site nobody has written yet — the
    // same reason `matches-tab.tsx` and `table-tab.tsx` carry one.
    <div data-testid="mh-teams" className="min-w-0 space-y-6">
      {byDivision(doc.teams).map((teams) => {
        const first = teams[0]!;
        return (
          <section key={first.divisionId} className="space-y-3">
            <h2
              data-testid={`mh-teams-division-${first.divisionSlug}`}
              className="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl"
            >
              {first.divisionName}
            </h2>
            {/* One column on the smallest phones and two from 380-ish: a card
                is a crest, a 30-character name and sometimes a seed chip, and
                two of those at 320 truncate to nothing. R1's one-DOM rule —
                the same cards, laid out wider, no control appears or
                disappears. */}
            <ul className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
              {teams.map((tm) => (
                <li key={tm.entrantId} className="min-w-0">
                  {/* The whole card is the link and the whole card is the
                      44px tap target — `MatchCard`'s shape. The href is the
                      document's (`competition-hub.ts:608`), pointing at the
                      division page's Entrants tab, which became a real
                      destination in `9150768cd`: `Tabs` reads `?tab=` now,
                      where it was `useState(0)` and every one of these links
                      would have landed the spectator on Schedule. */}
                  <Link
                    data-testid={`mh-team-${tm.entrantId}`}
                    href={tm.href}
                    className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-zinc-100 bg-white px-3 py-2 shadow-sm transition hover:border-accent hover:shadow"
                  >
                    <Crest team={tm} />
                    {/* `truncate` needs `min-w-0` on the whole ancestor chain —
                        the card, the cell and this span all carry it. `title`
                        so the full name is still reachable on a pointer. */}
                    <span
                      className="min-w-0 flex-1 truncate text-sm font-medium text-ink"
                      title={tm.name}
                    >
                      {tm.name}
                    </span>
                    {/* `!== null`, never a truthiness test: `seed` is
                        `number | null` and 0 is a number. A `{tm.seed ? …}`
                        here drops the chip for a zero-seeded entrant, which is
                        the same family of defect as `Number("")` reading as a
                        real zero. */}
                    {tm.seed !== null ? (
                      <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                        {t(dict, "teams.seed", { seed: tm.seed })}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
