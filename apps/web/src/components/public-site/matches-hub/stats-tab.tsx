// Spectator surface W2, Task 10 — the competition hub's Stats tab: every
// leader board the competition publishes, grouped under the division it
// belongs to.
//
// Like the Table tab beside it, this component decides very little. The
// BOARDS are `server/public-site/leaders.ts`'s: which counters get a board and
// in what order (`LEADER_SPECS`), who is on one, in what order, how many, and
// what each row is CALLED after the division's consent policy has been applied
// — all of that is settled before the document is built, and every string in
// it arrives pre-resolved (the board's `label` has already been through
// `playerStatLabel`). So nothing here looks a stat key up, re-ranks anybody, or
// re-derives a name.
//
// What it does decide is written out where it happens:
//
//  • the tab-level EMPTY sentence, which the hub itself cannot reach —
//    `deriveHubTabs` gives a competition no Stats tab until a board has a row;
//  • the RANK, which the document does not carry: `LeaderRow` has no rank
//    field, so the position in the list is the rank, and it restarts per board;
//  • whether a row is a LINK, which is `personHref` plus this file's own
//    masking guard — see `linkFor`;
//  • two-up from `md` only when a division publishes more than one board.
//
// NO `"use client"`. Nothing here is stateful, so Task 11 can render the tab in
// a server component and the whole board arrives in the HTML.
import Link from "next/link";
import { EntityLogo } from "@/components/ui/entity-logo";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type {
  CompetitionHubDocT,
  LeaderBoardT,
  LeaderRowT,
} from "@/server/public-site/competition-hub-schema";

export interface StatsTabProps {
  doc: CompetitionHubDocT;
  dict: PublicDict;
}

/**
 * `doc.leaders` under one entry per division, in first-appearance order.
 *
 * By `divisionId` and through a `Map`, for the reason `table-tab.tsx`'s own
 * `byDivision` writes up: grouping by adjacent RUN is the same function on
 * every document `competition-hub.ts` can build (it loops divisions
 * outermost), but on a document whose boards interleave, the run version
 * prints one division's heading twice with another wedged between them and a
 * spectator has no way to read that as one division.
 *
 * Deliberately a second small copy rather than a shared generic over
 * `{ divisionId }`: the two are four lines each, they are in sibling files, and
 * a generic here would be an abstraction earned by nothing but the shape of a
 * property name (AGENTS.md's anti-abstraction rule). If a third tab needs it,
 * that is the point to lift it.
 */
function byDivision(boards: readonly LeaderBoardT[]): LeaderBoardT[][] {
  const groups = new Map<string, LeaderBoardT[]>();
  for (const b of boards) {
    const group = groups.get(b.divisionId);
    if (group) group.push(b);
    else groups.set(b.divisionId, [b]);
  }
  return [...groups.values()];
}

/**
 * The player page to link a row at, or null for no link at all.
 *
 * `leaders.ts:224` already answers this — `personHref` is non-null only for
 * someone who both has a public profile and is not masked in this division —
 * so the second clause here is a DUPLICATE of a rule that lives upstream, and
 * this file otherwise refuses to restate the builder's decisions.
 *
 * It is duplicated on purpose, and only here. The schema makes `person.masked`
 * and `personHref` independent fields (`competition-hub-schema.ts:136-142`), so
 * nothing in the type system holds the invariant; and what the invariant
 * protects is a youth division's masking policy, one tap from a page that
 * renders the unmasked name. A guard whose failure mode is "a masked player's
 * real name is now reachable" is worth stating twice, and the suite kills this
 * one with a document the builder cannot produce but the schema accepts.
 */
export function linkFor(row: LeaderRowT): string | null {
  return row.person.masked ? null : row.personHref;
}

// One class for both arms of the row, so the linked and unlinked versions
// cannot drift into different geometry — and `min-h-11` because when the row IS
// a link, the row is the tap target (AGENTS.md's 44px bar). The whole row is
// the link rather than the name alone: it is `MatchCard`'s shape, it is what a
// thumb expects, and a five-row board of text-height links is not tappable.
const ROW_CLASS = "flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-1";

export function StatsTab({ doc, dict }: StatsTabProps) {
  // Stated first, before any grouping. Unreachable through the hub —
  // `deriveHubTabs` (`lib/matches-hub.ts:241`) only emits the `stats` tab when
  // `leaderRows > 0`, and `CompetitionHubDoc`'s refinement makes that a rule
  // the document must satisfy — so what this catches is a direct render and a
  // `?tab=stats` deep link that outlived its data. A blank panel reads as a
  // broken page; a sentence reads as an empty one.
  //
  // The panel ROOT is inside this branch too (review F6). Both merged siblings
  // return a bare `<p>` for their empty state, so `mh-matches` / `mh-table`
  // simply do not exist there — except neither of them has a root testid in
  // either state, so there is no parity to keep, and the brief mandates a
  // `TabPanel`-style root here. A handle that vanishes on one arm is not a
  // handle: Task 12 would write `[data-testid="mh-stats"]` and get a locator
  // that resolves on a populated competition and not on an empty one.
  if (doc.leaders.length === 0) {
    return (
      <div data-testid="mh-stats" className="min-w-0">
        <p data-testid="mh-stats-empty" className="py-8 text-center text-sm text-ink-muted">
          {t(dict, "leaders.empty")}
        </p>
      </div>
    );
  }

  return (
    // `min-w-0` on the root for the same reason both siblings carry one (Task
    // 8, review P3): everything below here is protected, but Task 11/12 mounts
    // this inside a layout nobody has written yet, and a flex or grid parent
    // breaks the truncate chain ABOVE this component.
    <div data-testid="mh-stats" className="min-w-0 space-y-6">
      {byDivision(doc.leaders).map((boards) => {
        const first = boards[0]!;
        return (
          <section key={first.divisionId} className="space-y-3">
            {/* `<h2>`, the same rank the Table tab's division heading holds, so
                the two tabs cannot disagree about the outline once Task 11 puts
                both under one page `<h1>`. `text-xl` at every width for the
                same reason it is there: the board's own caption below it is
                `text-sm`, and the grouping this tab is built around has to stay
                visible on a phone. Wraps rather than truncates — a heading is
                the one string here with room to take two lines. */}
            <h2
              data-testid={`mh-stats-division-${first.divisionSlug}`}
              className="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl"
            >
              {first.divisionName}
            </h2>
            {/* Two-up from `md` only when there IS a second board: a lone board
                stretched across half the page is narrower than it needs to be
                for no gain, and below `md` nothing goes two-up at all — a
                half-width board at 360 truncates every name on it. `min-w-0` on
                the cell because a grid item defaults to `min-width: auto`. */}
            <ul className={`grid gap-4${boards.length > 1 ? " md:grid-cols-2" : ""}`} role="list">
              {boards.map((b) => (
                <li key={b.key} className="min-w-0">
                  <section
                    data-testid={`mh-leaders-${b.divisionSlug}-${b.key}`}
                    className="min-w-0 rounded-xl border border-zinc-100 bg-white p-3 shadow-sm"
                  >
                    {/* The label the BUILDER resolved — `playerStatLabel`
                        against `stat.<sport>.<key>` in the org's locale
                        (`competition-hub.ts:637`). Never looked up here: this
                        tab has no sport key to resolve it with and no business
                        holding a second set of words for the same counters
                        (`leaders.ts`'s own ruling). */}
                    <h3 className="mb-1 min-w-0 truncate font-display text-sm font-semibold text-ink">
                      {b.label}
                    </h3>
                    <ol className="min-w-0" role="list">
                      {b.rows.map((row, i) => {
                        const href = linkFor(row);
                        // Bound ONCE and rendered by whichever wrapper the row
                        // gets. Writing the contents twice — once inside the
                        // `<Link>`, once inside the `<div>` — is how the two
                        // arms end up showing different things.
                        const body = (
                          <>
                            {/* The rank is the POSITION, because `LeaderRow`
                                carries none. It restarts per board, which is
                                what a leader board means; it is also why a tie
                                reads as two consecutive ranks rather than two
                                firsts — the document carries no tie
                                information, and inventing one here would be
                                this file deciding something the builder owns. */}
                            <span className="w-4 shrink-0 text-right text-xs tabular-nums text-ink-muted">
                              {i + 1}
                            </span>
                            <EntityLogo
                              src={row.badgeUrl}
                              name={row.entrantName ?? row.person.name}
                              size={20}
                            />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="min-w-0 truncate text-sm font-medium text-ink">
                                {row.person.name}
                              </span>
                              {row.entrantName ? (
                                <span className="min-w-0 truncate text-xs text-ink-muted">
                                  {row.entrantName}
                                </span>
                              ) : null}
                            </span>
                            {/* `tabular-nums` so a five-row column does not
                                dance, `font-display` because it is the same
                                number face the scorebug and the standings
                                table use. Already formatted by the builder. */}
                            <span className="shrink-0 font-display text-sm font-semibold tabular-nums text-ink">
                              {row.value}
                            </span>
                          </>
                        );
                        return (
                          <li
                            key={row.person.personId}
                            data-testid={`mh-leaders-${b.divisionSlug}-${b.key}-row-${row.person.personId}`}
                            className="min-w-0"
                          >
                            {href ? (
                              <Link href={href} className={`${ROW_CLASS} hover:bg-accent-soft`}>
                                {body}
                              </Link>
                            ) : (
                              <div className={ROW_CLASS}>{body}</div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
