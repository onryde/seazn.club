// Spectator surface W2, Task 10 — the competition hub's Teams tab: every
// entrant the competition carries, grouped under its division.
//
// DIVISION-PAGE PARITY (owner ruling 2026-09-16). Each card is a native
// `<details>` whose body is the team's SQUAD — number, name, position or a
// Suspended tag — and its own "Add to calendar" link, which is what the
// division page's Entrants tab showed. The card used to LINK to that tab; it
// no longer does, because the division page is about to redirect here and the
// link would loop. `TeamCard.href` stays in the document for that decision.
// Cards open independently (no `name` on the details), and an open card spans
// the whole grid row so a squad is never read in a 150px column.
//
// The document decides who is here and what they are called: `doc.teams` is
// built one division at a time, already through `maskPublicEntrantNames`,
// already carrying its resolved badge, its members (masked, with a player-page
// href only where the name is public) and its `.ics` href. Nothing here
// re-derives a name or a link.
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
// `"use client"` since `?division=` (same ruling): the filter is state. Its only
// importer is `competition-landing.tsx`, itself a client island.
"use client";

import Link from "next/link";
import { useState } from "react";
import { EntityLogo } from "@/components/ui/entity-logo";
import type { Dict as PublicDict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import type { CompetitionHubDocT, HubMemberT, TeamCardT } from "@/server/public-site/competition-hub-schema";
import { writeDivisionParam } from "../use-tab-param";
import { divisionChoices, divisionRail } from "./hub-chip";

export interface TeamsTabProps {
  doc: CompetitionHubDocT;
  dict: PublicDict;
  /** The viewer's locale, for the member count's plural category. */
  locale: Locale;
  /** `?division=` — a SEED, as on the Matches, Knockout and Table tabs. */
  initialDivision?: string | null;
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

/** One squad line: number, name, and the position OR the Suspended tag. */
function MemberLine({ entrantId, index, m, dict }: { entrantId: string; index: number; m: HubMemberT; dict: PublicDict }) {
  const testid = `mh-team-${entrantId}-member-${index}`;
  return (
    <li data-testid={testid} className="grid min-h-11 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2">
      {/* `!== null`: squad number 0 is a number. */}
      <span className="font-display text-sm font-semibold tabular-nums text-ink-muted">
        {m.squadNumber !== null ? m.squadNumber : "—"}
      </span>
      {/* A link ONLY where the document gives one — the builder withholds it
          for every masked name, and this line never invents one. */}
      {m.playerHref ? (
        <Link
          href={m.playerHref}
          title={m.name}
          // `py-3` + the 20px line is the 44px tap target; `block` so
          // `truncate` ellipsises the text itself.
          className="block min-w-0 truncate py-3 text-sm font-medium text-ink hover:text-accent-strong"
        >
          {m.name}
        </Link>
      ) : (
        <span title={m.name} className="min-w-0 truncate text-sm text-ink">
          {m.name}
        </span>
      )}
      {/* The tag WINS: a suspended player's position is not what a spectator
          needs to read on that line. Red-700 on red-50 is 5.9:1. The position is
          the raw key — no position dictionary exists (`HubMember.position`). */}
      {m.suspendedRemaining !== null ? (
        <span
          data-testid={`${testid}-suspended`}
          className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700"
        >
          {t(dict, "teams.suspended")}
        </span>
      ) : m.position ? (
        <span className="shrink-0 text-xs text-ink-muted">{m.position}</span>
      ) : (
        <span />
      )}
    </li>
  );
}

export function TeamsTab({ doc, dict, locale, initialDivision }: TeamsTabProps) {
  const [chosenDivision, setDivision] = useState<string | null>(initialDivision ?? null);
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

  // Reconciled against the chips on screen — the Knockout tab's rule.
  const choices = divisionChoices(doc.teams);
  const division = choices.some((d) => d.slug === chosenDivision) ? chosenDivision : null;
  const shown = doc.teams.filter((tm) => division === null || tm.divisionSlug === division);
  const chooseDivision = (slug: string | null) => {
    setDivision(slug);
    writeDivisionParam(slug);
  };

  return (
    // `min-w-0` on the root for the mount site nobody has written yet — the
    // same reason `matches-tab.tsx` and `table-tab.tsx` carry one.
    <div data-testid="mh-teams" className="min-w-0 space-y-6">
      {divisionRail("mh-teams", dict, choices, division, chooseDivision)}
      {byDivision(shown).map((teams) => {
        const first = teams[0]!;
        return (
          <section key={first.divisionId} className="space-y-3">
            {/* `mh-teams-heading-`: the rail's chips own `mh-teams-division-`. */}
            <h2
              data-testid={`mh-teams-heading-${first.divisionSlug}`}
              className="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl"
            >
              {first.divisionName}
            </h2>
            {/* One column on the smallest phones and two from 380-ish: a card
                is a crest, a 30-character name and sometimes a seed chip, and
                two of those at 320 truncate to nothing. R1's one-DOM rule —
                the same cards, laid out wider, no control appears or
                disappears. */}
            <ul className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4" role="list">
              {teams.map((tm) => {
                // Absent on a document cached before squads existed — the
                // schema keeps both fields optional for exactly that hit. Such
                // a card says NOTHING about its squad: "0 members" and "No
                // squad listed yet" would both be claims the document never
                // made.
                const members = tm.members;
                const nameId = `mh-team-${tm.entrantId}-name`;
                const calendarId = `mh-team-${tm.entrantId}-calendar`;
                return (
                  // An OPEN card takes the whole row. The class is on the GRID
                  // ITEM (the `<li>`), because `grid-column` is the item's.
                  <li key={tm.entrantId} className="min-w-0 [&:has(details[open])]:col-span-full">
                    <details
                      data-testid={`mh-team-${tm.entrantId}`}
                      className="group min-w-0 rounded-xl border border-zinc-200/80 bg-surface"
                    >
                      <summary className="flex min-h-11 min-w-0 cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
                        {/* 32, the size this card's crest has always been. */}
                        <EntityLogo src={tm.badgeUrl} name={tm.name} colour={tm.colour} size={32} />
                        {/* `truncate` needs `min-w-0` on the whole chain — the
                            item, the details, the summary and this column. */}
                        <span className="min-w-0 flex-1">
                          <span className="block min-w-0 truncate text-sm font-medium text-ink" id={nameId} title={tm.name}>
                            {tm.name}
                          </span>
                          {members !== undefined ? (
                            <span className="block text-xs text-ink-muted">
                              {plural(dict, "teams.members", members.length, locale)}
                            </span>
                          ) : null}
                        </span>
                        {/* `!== null`, never truthiness: seed 0 is a seed. */}
                        {tm.seed !== null ? (
                          <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                            {t(dict, "teams.seed", { seed: tm.seed })}
                          </span>
                        ) : null}
                        {/* The house disclosure chevron (spec §3,
                            `scorecard-tab.tsx`): points right, turns down. */}
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 12 12"
                          className="h-3 w-3 shrink-0 text-ink-muted transition-transform group-open:rotate-90"
                        >
                          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.75" />
                        </svg>
                      </summary>
                      <div className="space-y-2 border-t border-zinc-100 px-3 pb-3 pt-1">
                        {members === undefined ? null : members.length === 0 ? (
                          <p data-testid={`mh-team-${tm.entrantId}-squad-empty`} className="py-2 text-sm text-ink-muted">
                            {t(dict, "teams.squadEmpty")}
                          </p>
                        ) : (
                          <ul className="divide-y divide-zinc-100" role="list">
                            {members.map((m, i) => (
                              <MemberLine key={i} entrantId={tm.entrantId} index={i} m={m} dict={dict} />
                            ))}
                          </ul>
                        )}
                        {tm.calendarHref ? (
                          // Named "Add to calendar" + the team, so a screen
                          // reader's link list is not N identical entries.
                          <Link
                            data-testid={calendarId}
                            id={calendarId}
                            href={tm.calendarHref}
                            aria-labelledby={`${calendarId} ${nameId}`}
                            className="inline-flex min-h-11 items-center rounded-lg border border-zinc-200/80 px-3 text-sm font-medium text-ink transition hover:border-accent hover:text-accent-strong"
                          >
                            {t(dict, "info.calendar")}
                          </Link>
                        ) : null}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
