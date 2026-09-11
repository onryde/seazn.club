// Spectator surface W2, Task 10 — the competition hub's Teams tab: every
// entrant the competition carries, grouped under its division, each a card
// linking to that division's Entrants tab.
//
// The document decides who is here and what they are called: `doc.teams` is
// built one division at a time (`competition-hub.ts:598-610`), already through
// `maskPublicEntrantNames`, already carrying its resolved badge and its own
// `?tab=entrants` href. Nothing here re-derives a name or a link.
//
// What it does decide is the tab-level EMPTY sentence, which the hub itself
// cannot reach. Everything else it lays out.
//
// THE CREST IS NO LONGER THIS FILE'S. It shipped here as a private `Crest`
// with its own 32px class and its own WCAG ink derivation, on the argument
// that `EntityLogo` "has no arm for an entrant's own colour, and adding one
// would change every surface that renders a badge". Adding one changed none of
// them — the arm only exists for a caller that passes a colour — and the split
// had a cost: `Side.colour` reached `match-card.tsx` and was read by nothing,
// so the same badge-less club was painted here and grey on every match card of
// the same page. `Crest`, `CREST_CLASS` and `monogramInk` now live in
// `components/ui/entity-logo.tsx`, gate and reasoning intact, and this file
// asks for `size={32}` like any other caller.
//
// NO `"use client"` — nothing here is stateful, so Task 11 can render it in a
// server component.
import Link from "next/link";
import { EntityLogo } from "@/components/ui/entity-logo";
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
  //
  // The panel ROOT is inside this branch too — same reasoning as
  // `stats-tab.tsx`'s (review F6): a testid that exists only on the populated
  // arm is not a panel handle.
  if (doc.teams.length === 0) {
    return (
      <div data-testid="mh-teams" className="min-w-0">
        <p data-testid="mh-teams-empty" className="py-8 text-center text-sm text-ink-muted">
          {t(dict, "division.entrantsEmpty")}
        </p>
      </div>
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
                    {/* 32, the size this card's crest has always been — a
                        card here is a crest, a name and sometimes a seed
                        chip, so the badge is most of what tells one card
                        from the next. `colour` is what makes a badge-less
                        club its own colour rather than the neutral tile. */}
                    <EntityLogo
                      src={tm.badgeUrl}
                      name={tm.name}
                      colour={tm.colour}
                      size={32}
                    />
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
