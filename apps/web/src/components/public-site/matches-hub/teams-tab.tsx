// Spectator surface W2, Task 10 — the competition hub's Teams tab: every
// entrant the competition carries, grouped under its division.
//
// DIVISION-PAGE PARITY (owner ruling 2026-09-16). A team's or a pair's card is
// a native `<details>` whose body is its SQUAD — number, name, position or a
// Suspended tag — which is what the division page's Entrants tab showed. The
// card used to LINK to that tab; it no longer does, because the division page
// is about to redirect here and the link would loop. `TeamCard.href` stays in
// the document for that decision. Cards open independently (no `name` on the
// details), and an open card spans the whole grid row so a squad is never read
// in a 150px column.
//
// A SINGLES ENTRANT IS NOT A TEAM (owner ruling 2026-09-17, option A). An
// `individual` card has no squad to disclose, so it is one flat row — crest,
// name, seed chip — with no chevron, no member count and no "No squad listed
// yet". Those three were claims the product could not make, and a live singles
// division published all three under a lone player ("0 members"). The branch
// is on `TeamCard.kind`, and a document that carries no `kind` (an ISR entry
// baked before the field shipped) keeps the disclosure.
//
// THE CALENDAR IS A CORNER TAB (owner ruling 2026-09-17, option A of three
// mockups). Both card kinds carry one icon-only `.ics` link, half-overlapping
// the card's top-right edge, and on BOTH it is a sibling of the card rather
// than a child — a `<details>` hides its body from the page and from the
// accessibility tree until it opens, so the squad-body link this replaced was
// unreachable on every card as it arrived. See `calendarIcon` below.
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

  // WHO HAS SOMETHING TO PUT IN A CALENDAR (owner ruling 2026-09-17). Built
  // ONCE per document, not per card: `doc.matches` is every fixture the
  // competition carries, so re-scanning it inside the render loop would be
  // O(entrants × fixtures) for an answer that does not vary by card.
  //
  // `tm.calendarHref` cannot answer this — the builder writes one for every
  // entrant unconditionally, so it is non-null even for a division whose
  // fixtures are all still TBD, and the `.ics` it points at would hold no
  // dated event. "Scheduled" means a REAL `scheduledAt`, not a placeholder:
  // `HubMatch.scheduledAt` is null exactly while the fixture has no time yet
  // (schema: "ISO instant, or null when the fixture has no time yet"), which
  // is the same null a TBD/unresolved slot carries.
  const scheduledEntrants = new Set<string>();
  for (const match of doc.matches) {
    if (match.scheduledAt === null) continue;
    for (const s of match.header.sides) scheduledEntrants.add(s.entrantId);
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
            {/* Columns chosen from MEASURED card widths (R11, Chromium), not
                from device names. A closed card spends 86px on everything but
                the name — border, padding, the 32px crest, the chevron and two
                gaps — and a realistic 24-character name paints up to 185px
                ("West Wimbledon Wanderers", Geist 14px medium), so a card needs
                ~280px. In the org layout's `max-w-5xl px-4` column that is one
                column below `sm` (the old two at 380 left a name 28px), two
                from `sm` (300px cards at 640) and three from `lg` (325px); four
                would be 242px even at the 992px cap, which cut "Millbrook Ro…"
                at 1280. `stats-teams-info-tabs.test.tsx` redoes this arithmetic
                from these classes. R1's one-DOM rule — the same cards, laid out
                wider, no control appears or disappears. */}
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" role="list">
              {teams.map((tm) => {
                // Absent on a document cached before squads existed — the
                // schema keeps both fields optional for exactly that hit. Such
                // a card says NOTHING about its squad: "0 members" and "No
                // squad listed yet" would both be claims the document never
                // made.
                const members = tm.members;
                const nameId = `mh-team-${tm.entrantId}-name`;
                const calendarId = `mh-team-${tm.entrantId}-calendar`;
                // ONE person is not a team of zero. A singles entrant has no
                // squad to disclose, so the count, the chevron and "No squad
                // listed yet" are three claims its card cannot make — a live
                // singles division published exactly that under a lone player.
                // `individual` gets a flat row instead; team and pair keep the
                // disclosure. A document that does not SAY (cached before
                // `kind` shipped) is read as today's card, never as a person.
                const flat = tm.kind === "individual";
                // The one squad row a singles entrant does carry is where its
                // player page lived, and the flat card no longer renders it —
                // so the name takes the link rather than the hub losing its
                // only route to a singles player's card. Withheld exactly as
                // `MemberLine` withholds it: no href in the document, no link
                // here, because the card behind a masked name would undo the
                // mask.
                const solo = flat && members?.length === 1 ? members[0]! : null;
                // `py-3` + the 20px line is the 44px tap target (as
                // `MemberLine`); `-my-2` gives it back to the layout, so the
                // row keeps the closed card's height. Both arms carry it, so
                // a card is the same height whether the person is linked.
                const nameClass = "block min-w-0 truncate py-3 -my-2 text-sm font-medium text-ink";
                // ONE calendar control, drawn identically on both card kinds:
                // an icon-only CORNER TAB, half-overlapping the card's
                // top-right edge (owner's pick, option A, from the 2026-09-17
                // mockup round). It replaced a text link that read "Add to
                // calendar" on the row.
                //
                // It is rendered as a SIBLING of the card, never inside it,
                // and both arms below wrap it in a `relative` `<li>`. That is
                // not cosmetic: on a team or pair card the body is a native
                // `<details>`, which hides EVERYTHING after its `<summary>`
                // from the page and from the accessibility tree until it
                // opens — so a calendar link nested in the squad body (where
                // this one lived) was unreachable without first opening the
                // squad. Outside the `<details>`, it is reachable closed.
                //
                // Named "Add to calendar" + the entrant on `aria-label`, for
                // the reason the old text link gave for its `aria-labelledby`:
                // every card's control means the same three words, and a
                // screen reader's link list must not be N identical entries.
                // `aria-labelledby` pointed at the link's own visible text,
                // and an icon-only control has none left to point at.
                const calendarLabel = `${t(dict, "info.calendar")} — ${tm.name}`;
                // The tap target is the LINK: 44×44, as `MemberLine`'s rows
                // and the summary are. The visible disc is 28px drawn inside
                // it, so the corner tab reads as a small tab without the
                // control being a 28px target (`mobile.spec.ts`'s bar, and it
                // measures the interactive element, not a box beside it).
                // `-top-4 -right-4` centres that disc on `-top-2 -right-2` —
                // 8px proud of the corner, which is exactly the grid's `gap-2`
                // row gap, so the disc meets the card above rather than
                // crossing into it.
                // BOTH conditions, and the schedule one is the stricter: the
                // document offers an `.ics` for every entrant, so on its own
                // the href renders a corner tab on a division nobody has
                // given a time to yet. Nothing takes its place when it is
                // withheld — no empty corner, no placeholder.
                const calendarIcon = tm.calendarHref && scheduledEntrants.has(tm.entrantId) ? (
                  <Link
                    data-testid={calendarId}
                    href={tm.calendarHref}
                    aria-label={calendarLabel}
                    title={calendarLabel}
                    className="group absolute -top-4 -right-4 z-10 flex h-11 w-11 items-center justify-center"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200/80 bg-surface text-ink-muted shadow-sm transition group-hover:border-accent group-hover:text-accent-strong">
                      {/* Inlined like the chevron below it — this file draws
                          its own glyphs rather than importing an icon set. */}
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      >
                        <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
                        <path d="M2.25 6.75h11.5" />
                        <path d="M5.5 1.75v3" />
                        <path d="M10.5 1.75v3" />
                      </svg>
                    </span>
                  </Link>
                ) : null;
                if (flat) {
                  return (
                    // `relative`: the corner tab below is positioned against
                    // this cell. The flat card has no disclosure to sit
                    // outside of, but it is wrapped the same way so both card
                    // kinds carry the identical control in the identical
                    // place.
                    <li key={tm.entrantId} className="relative min-w-0">
                      <div
                        data-testid={`mh-team-${tm.entrantId}`}
                        className="min-w-0 rounded-xl border border-zinc-200/80 bg-surface"
                      >
                        {/* The closed card's own row, without the chevron. The
                            calendar no longer rides the SECOND line here — it
                            is the corner tab now — so this row is crest, name
                            and, when the entrant has one, the seed chip.
                            Measured in Chromium on this page, a one-row card
                            (crest, name, calendar) left the name 121px at
                            1280, 160 at 768 and 84 at 320, against 239/278/202
                            on a team card — "Alexander Montgomery-Fitzwilliam"
                            cut to "Alexander Mo…" on a desktop with a whole
                            row spare. Lifting the calendar out of the row is
                            what gives that width back. */}
                        <div className="flex min-h-11 min-w-0 items-center gap-2 px-3 py-2">
                          <EntityLogo src={tm.badgeUrl} name={tm.name} colour={tm.colour} size={32} />
                          <span className="min-w-0 flex-1">
                            {solo?.playerHref ? (
                              <Link
                                href={solo.playerHref}
                                id={nameId}
                                title={tm.name}
                                className={`${nameClass} hover:text-accent-strong`}
                              >
                                {tm.name}
                              </Link>
                            ) : (
                              <span className={nameClass} id={nameId} title={tm.name}>
                                {tm.name}
                              </span>
                            )}
                            {/* `!== null`, never truthiness: seed 0 is a seed,
                                and a singles entrant can be seeded. */}
                            {tm.seed !== null ? (
                              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="shrink-0 whitespace-nowrap rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                                  {t(dict, "teams.seed", { seed: tm.seed })}
                                </span>
                              </span>
                            ) : null}
                          </span>
                        </div>
                      </div>
                      {calendarIcon}
                    </li>
                  );
                }
                return (
                  // An OPEN card takes the whole row. The class is on the GRID
                  // ITEM (the `<li>`), because `grid-column` is the item's.
                  // `relative` for the corner tab, which is a SIBLING of the
                  // `<details>` — nested inside it, the browser would hide it
                  // whenever the squad is closed, which is every card on
                  // arrival. The tab corners itself against this cell, so it
                  // lands on the card's top-right whether the cell is one
                  // column wide or spanning the whole row.
                  <li key={tm.entrantId} className="relative min-w-0 [&:has(details[open])]:col-span-full">
                    <details
                      data-testid={`mh-team-${tm.entrantId}`}
                      className="group min-w-0 rounded-xl border border-zinc-200/80 bg-surface"
                    >
                      {/* `select-none`: a pointer or touch tap on the name puts a
                          collapsed selection (a caret) in its text node, and
                          Chromium lays out a line holding the caret WITHOUT its
                          `text-overflow` ellipsis — the name stayed cut
                          mid-letter, open or closed, until the selection moved
                          (R11 at 320; keyboard Enter and the chevron place no
                          caret and kept it). The summary is a control, so no
                          caret belongs in it; the full name stays in `title`. */}
                      <summary className="flex min-h-11 min-w-0 cursor-pointer select-none list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
                        {/* 32, the size this card's crest has always been. */}
                        <EntityLogo src={tm.badgeUrl} name={tm.name} colour={tm.colour} size={32} />
                        {/* `truncate` needs `min-w-0` on the whole chain — the
                            item, the details, the summary and this column. */}
                        <span className="min-w-0 flex-1">
                          <span className="block min-w-0 truncate text-sm font-medium text-ink" id={nameId} title={tm.name}>
                            {tm.name}
                          </span>
                          {/* The seed chip rides this second line, beside the
                              count, rather than the name's row: beside the name
                              it took 61px of a 202px column at 320 (more in
                              Spanish, "Cabeza de serie 1"). Neither can wrap
                              inside itself; the chip drops below the count
                              before either would. */}
                          {members !== undefined || tm.seed !== null ? (
                            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              {members !== undefined ? (
                                <span className="whitespace-nowrap text-xs text-ink-muted">
                                  {plural(dict, "teams.members", members.length, locale)}
                                </span>
                              ) : null}
                              {/* `!== null`, never truthiness: seed 0 is a seed. */}
                              {tm.seed !== null ? (
                                <span className="shrink-0 whitespace-nowrap rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                                  {t(dict, "teams.seed", { seed: tm.seed })}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
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
                      </div>
                    </details>
                    {calendarIcon}
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
