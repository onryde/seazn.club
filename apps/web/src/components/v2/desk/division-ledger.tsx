import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { sportEmoji } from "@/components/discovery-cards";
import { whenLabel } from "@/lib/division-status-line";
import { ledgerHref, pageLedger } from "@/lib/ledger-page";
import type { Attention } from "@/lib/division-phase";
import type { DeskDivision } from "@/server/usecases/competition-desk";
import { BansToReviewPill, PhasePill } from "./phase-pill";
import { DRAW_DOOR_KEY } from "./needs-you";

export interface LedgerRow {
  id: string;
  name: string;
  slug: string;
  sportKey: string;
  logoUrl: string | null;
  /** "Knockout", "League + Groups"... — null/absent once every stage was
   *  deleted. Distinct from `statusLine` (progress/next), restored from
   *  `card-stats`' `formatLabel(stage_kinds)` after W1 dropped it wiring off
   *  the EntityCard grid. Optional (not just nullable) so existing test
   *  fixtures that predate this field don't all need updating. */
  formatLabel?: string | null;
  /** null when getCompetitionDesk failed: the row still renders from card stats. */
  desk: DeskDivision | null;
  statusLine: string;
  menu?: ReactNode;
}

// D fix (review round 1, desktop addendum): phase-coloured, not always
// purple — a finished division at 100% must read "done" (green), not look
// identical to one still mid-season. This already covered every phase
// before the addendum landed; V1's phase fix (division-phase.ts) is what
// actually gets a fully-played division INTO the "finished" bucket here.
const BAR: Record<DeskDivision["phase"], string> = {
  setting_up: "bg-purple-600", scheduled: "bg-purple-600", match_day: "bg-amber-600", finished: "bg-green-700",
};

function nextLine(dict: Dict, d: DeskDivision, locale: string, nowMs: number): string {
  // V4 fix (review round 1): nothing left to schedule is not itself
  // information — the row already says "finished" / "N of N played". An
  // empty cell here (rather than "Nothing scheduled next" on every settled
  // row) is the whole point of a desk that only speaks when something is
  // actually owed.
  if (!d.next) return "";
  // Match Day B1 (spec 2026-10-31 §9, "remove the divisions list's Now: column"): a match being played is Match Day's to show,
  // and this page no longer repeats it — the row's pill already says the division is in play. Not "Next" either: it has
  // started. Empty, at every width (the phone card prints this same value).
  if (d.next.in_play) return "";
  const home = d.next.home ?? "—";
  const away = d.next.away ?? "—";
  // F5 fix (final review, Important): `d.next` is card-stats.ts's shared
  // "next fixture" query (out of this wave's scope to change — see
  // card-stats.ts:145-151) — it carries no `>= now()` floor and can name a
  // fixture whose kick-off has already passed, or one with no time at all.
  // A past kick-off is not "next", and neither is an undated one (the
  // ledger's own copy already contradicted both live: "result missing —
  // the match window has passed" sat directly above "Next: … 11:27" for the
  // SAME fixture). Same malformed-instant guard `statusLine` got in
  // b2fdef833, applied here at the one call site that renders it.
  const at = d.next.scheduled_at;
  if (!at) return "";
  const ms = Date.parse(at);
  if (Number.isNaN(ms) || ms < nowMs) return "";
  // G2 fix (fix round D, corrected ruling): formatted entirely in the
  // DISPLAY zone (`d.display_tz`) — the venue's own local time, both the
  // day and the clock face. The old two-zone split (day from org, clock
  // from display) could name an instant that existed in neither zone; see
  // `whenLabel`'s own doc comment (division-status-line.ts).
  const when = whenLabel(at, locale, d.display_tz);
  return t(dict, "desk.ledger.next", { when, home, away }).replace("  ", " ");
}

/** The mobile card's one action: a red attention's own label/href, or none.
 *  Owner ruling (review round 1, mobile-card redesign): the card itself is
 *  the tap target to the division — a button only earns its place when
 *  there's something that specifically needs doing, mirroring what NeedsYou
 *  would already surface for this division.
 *
 *  K1 (fix round G): `needs_fixtures` joins the list. It is the kind the
 *  finding is about — an unseeded stage — so a row that raises it and
 *  offers NO action would leave the mobile card in exactly the state the
 *  ruling exists to remove ("the row carries an action the organiser can
 *  take"). Its door is the fixtures tab, which holds both "Complete stage"
 *  on the stage before it and "Generate fixtures". */
function redAction(dict: Dict, d: DeskDivision, org: string, comp: string, slug: string): { label: string; href: string } | null {
  const a = d.attention.find(
    (x): x is Extract<Attention, { kind: "needs_draw" | "needs_fixtures" | "no_scorer" }> =>
      x.kind === "needs_draw" || x.kind === "needs_fixtures" || x.kind === "no_scorer",
  );
  if (!a) return null;
  if (a.kind === "needs_draw") {
    // M1 (fix round I): the panel's OWN key for whichever door it is showing
    // — see needs-you.tsx's `DRAW_DOOR_KEY`. This row and the Needs-you row
    // above it are the same promise made twice, so they read the same map;
    // they used to read the same hand-copied string instead.
    return { label: t(dict, DRAW_DOOR_KEY[a.door]), href: routes.division(org, comp, slug, "fixtures") };
  }
  if (a.kind === "needs_fixtures") {
    return { label: t(dict, "desk.needsYou.needs_fixtures.action"), href: routes.division(org, comp, slug, "fixtures") };
  }
  // F3 fix (final review, Important): `no_scorer` is now aggregated per
  // division (`fixtureIds`, not a single `fixtureId`) — one fixture still
  // deep-links straight to it, several go to the fixtures tab that shows
  // them all, same as needs-you.tsx's own copy of this rule.
  if (a.fixtureIds.length === 1) {
    const f = d.fixture_names[a.fixtureIds[0]!];
    return { label: t(dict, "desk.needsYou.no_scorer.action"), href: routes.fixture(org, comp, slug, f?.fixture_no ?? 0) };
  }
  return { label: t(dict, "desk.needsYou.no_scorer.action"), href: routes.division(org, comp, slug, "fixtures") };
}

export function DivisionLedger({
  dict, rows: allRows, org, comp, locale, now, canEdit, page, showFinished, query = [],
}: {
  dict: Dict; rows: LedgerRow[]; org: string; comp: string; locale: string; now: string;
  /** Match Day B2 (spec 2026-10-31 §9, owner request): the list shows five at a time and hides finished divisions until asked.
   *  Both are REQUIRED, not defaulted: a ledger whose page forgot to hand them over would silently show every division again,
   *  which is the seam this prop exists to keep from going inert (the page reads them from `?dpage=` / `?finished=1`). */
  page: number;
  showFinished: boolean;
  /** The page's other query params, which the pager and the toggle keep (`ledgerQueryOf(...).rest`). */
  query?: readonly (readonly [string, string])[];
  /** IMPORTANT (review 7): the phone card's red action was NOT gated, while
   *  `needsYouItems` on the page above it always has been. A viewer — an
   *  ordinary org role that reaches this page, and one RS005 deliberately let
   *  in — was offered a full-width primary "Compute proposal" landing on a
   *  fixtures tab where `progression-panel.tsx` returns `null` for them.
   *  That is instance twelve's exact shape, one audience over: a label naming
   *  a control the landing page does not have. The pills and the status line
   *  stay — a viewer may SEE that a division is blocked; they may not be
   *  handed a button for work they cannot do. */
  canEdit: boolean;
}) {
  // Fix round 2: nextLine() computed ONCE per row here, reused below — never
  // re-derived, and never called twice for the same row. `hasNext` decides
  // the WHOLE ledger's desktop grid template (not a per-row template, which
  // would misalign columns across rows the moment only some have a next
  // fixture): with V4's fix (empty string, not "Nothing scheduled next"),
  // a competition where nothing has a next fixture must not reserve a
  // ~1.4fr track for a column no row will ever fill.
  // `now` is REQUIRED (F5 fix), not defaulted to `Date.now()` here — a
  // component reading the wall clock during its own render is impure
  // (react-hooks/purity) and non-deterministic across re-renders/replay.
  // The page captures one `now` and passes it down explicitly so the
  // "is this kick-off past?" check (below) agrees with whatever instant
  // the rest of the render used.
  // B2: the page of rows to draw. A row whose desk failed to load has no phase to be finished in, and no attention to
  // exempt - it is never hidden (`pageLedger` reads "unknown" as a phase that is not finished).
  const view = pageLedger(
    allRows.map((row) => ({ row, phase: row.desk?.phase ?? "unknown", attention: row.desk?.attention ?? [] })),
    { page, showFinished },
  );
  const rows = view.rows.map((v) => v.row);
  const base = routes.competition(org, comp);
  const nowMs = Date.parse(now);
  const nextByRow = rows.map((r) => (r.desk ? nextLine(dict, r.desk, locale, nowMs) : ""));
  const hasNext = nextByRow.some((n) => n !== "");
  const desktopGridCols = hasNext
    ? "md:grid-cols-[36px_1fr_140px_130px_minmax(0,1.4fr)_auto]"
    : "md:grid-cols-[36px_1fr_140px_130px_auto]";
  return (
    <section data-testid="desk-ledger">
      {/* V5 fix (review round 1): the page's own "Divisions" heading (with
          the "+ Add division" control) already owns this section — a second
          "DIVISIONS · N" heading here duplicated it. The page passes the
          count into its own heading now. */}
      {/* B2: the filter. Nothing to toggle - no finished division the default view hides - prints nothing at all. A link, not a
          button: the state is the URL (`?finished=1`), so a reload or the back button keeps it, and it opens page 1 because
          the rows the pages are cut from have changed. 44px tall below `md`, the tap floor. */}
      {view.finishedCount > 0 && (
        <div className="mb-2 flex justify-end">
          <Link
            href={ledgerHref(base, query, { page: 1, showFinished: !showFinished })}
            data-testid="desk-ledger-finished-toggle"
            data-showing={showFinished ? "1" : "0"}
            data-finished-count={view.finishedCount}
            className="btn btn-ghost px-3 py-1.5 text-xs max-md:min-h-11"
          >
            {t(dict, showFinished ? "desk.ledger.hideFinished" : "desk.ledger.showFinished", { n: view.finishedCount })}
          </Link>
        </div>
      )}
      <div className="card divide-y divide-purple-50">
        {/* Every division is finished and hidden: the card says so and the toggle above is the way out. Not an empty box - an
            empty list would read as "this competition has no divisions", which is the page's own, different empty state. */}
        {rows.length === 0 && view.finishedCount > 0 && (
          <p data-testid="desk-ledger-all-finished" className="p-6 text-center text-sm text-slate-500">
            {t(dict, "desk.ledger.allFinished")}
          </p>
        )}
        {rows.map((r, i) => {
          const d = r.desk;
          const pct = d && d.total > 0 ? Math.round((d.played / d.total) * 100) : 0;
          const href = routes.division(org, comp, r.slug);
          const next = nextByRow[i];
          // Gated on `canEdit` for the reason the prop's own note gives: a
          // viewer is shown the state, never a button for work the landing
          // page will not let them do.
          const action = canEdit && d ? redAction(dict, d, org, comp, r.slug) : null;
          const tile = (sizeClass: string) => (
            <span
              aria-hidden
              data-testid="desk-ledger-avatar"
              className={`grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-purple-50 leading-none ${sizeClass}`}
            >
              {r.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- tenant-uploaded logo
                <img src={r.logoUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                sportEmoji(r.sportKey)
              )}
            </span>
          );
          return (
            <div key={r.id} data-testid="desk-ledger-row" data-phase={d ? d.phase : "unknown"}>
              {/* Mobile card (review round 1, owner ruling supersedes the
                  earlier V2/V3 patch): below `md` this is NOT the desktop
                  grid reflowed — it is its own composition. The whole card
                  (icon + name + bar + status) is ONE link to the division;
                  the action button (only when a red attention exists) is a
                  SIBLING, never nested inside that link (a nested <a> is
                  invalid HTML). No "Open" button, no "⋯" menu at this width
                  — the card itself is the tap target, and its two menu items
                  (Schedule, Slideshow) already live on the division page. */}
              <div className="p-4 md:hidden">
                <Link href={href} className="block rounded-lg focus-visible:outline-offset-4">
                  {/* `flex-wrap`, so the pill can take its own line below `md`
                      — see the wrapper below for why. */}
                  <div className="flex flex-wrap items-center gap-2">
                    {tile("text-2xl")}
                    {/* Round J, from looking at 320: `truncate` cut
                        "Championship Cup" to "Champions…" beside its pill —
                        on a phone the division NAME is the identifier, and an
                        ellipsis three characters in makes two divisions
                        indistinguishable. Two lines below `md`, unchanged
                        single-line truncation above it. */}
                    <span className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-slate-900 md:truncate">{r.name}</span>
                    {r.formatLabel && (
                      <span className="w-full text-xs text-slate-500" data-testid="desk-ledger-format">
                        {r.formatLabel}
                      </span>
                    )}
                    {/* The pill gets its OWN LINE on a phone. Sharing one with
                        the name left about 110px for the name at 320, which
                        wrapped "Championship Cup" mid-word to "Championshi /
                        Cup" — the same defect the pad's own rule names (a
                        person or entrant chip gets its own row, because a name
                        squeezed into a shared cell stops being readable).
                        The wrapper is what takes `basis-full`, not the badge:
                        a full-width flex item would stretch the badge's own
                        background across the card. */}
                    {/* `pl-10`, never `ml-10`: a full-basis flex item plus a
                        left MARGIN is 100% + 40px, which put 7px of horizontal
                        scroll on the page at 320 (the no-h-scroll gate caught
                        it). Padding sits inside the border box and indents
                        without widening. */}
                    {/* Discipline (3A): the bans pill rides the phase pill's own line, wrapping under it when both do
                        not fit — organiser-only, like the action below (reviewing a ban is an organiser's job). */}
                    {d && (
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5 max-md:order-3 max-md:basis-full max-md:pl-10">
                        <PhasePill dict={dict} phase={d.phase} attention={d.attention} />
                        {canEdit && <BansToReviewPill dict={dict} attention={d.attention} locale={locale as Locale} />}
                      </div>
                    )}
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-purple-100">
                    <i className={`block h-full rounded-full ${d ? BAR[d.phase] : "bg-purple-300"}`} style={{ width: `${pct}%` }} />
                  </div>
                  {/* Never truncates, never clamps — wraps to whatever it
                      needs (owner ruling: "the STATUS LINE wraps to as many
                      lines as it needs"). */}
                  <p className="mt-2 text-xs text-slate-600">{r.statusLine}</p>
                  {/* F5 (round J): the phone card used to DROP this line, so
                      the two widths disagreed about the same row (then:
                      "Now: Alpha v Bravo", a live line B1 has since moved to
                      Match Day). Same `nextLine` value the desktop row
                      prints (computed once per row above, never re-derived):
                      a second derivation of one displayed fact is how this
                      wave produced its worst defects. Empty stays empty —
                      "nothing left to schedule" is not information — and it
                      wraps rather than truncating, like the status line it
                      sits under. */}
                  {next !== "" && <p className="mt-1 text-xs font-medium text-slate-900">{next}</p>}
                </Link>
                {action && (
                  <Link href={action.href} className="btn btn-primary mt-3 flex w-full items-center justify-center py-3 text-sm">
                    {action.label}
                  </Link>
                )}
              </div>

              {/* Desktop row, `md` and up — unchanged composition, cosmetics
                  fixed per the desktop addendum (A-G): one vertical centre
                  axis (the bar's own caption is gone — B — so its column is
                  now a single centred element, same as every other column);
                  the bar gets a modest fixed width instead of a full
                  flexible column (C) and reads as a glance, not the loudest
                  thing in the row; consistent gaps with the name column
                  absorbing the flexible space (E); the glyph fills more of
                  its tile (F). */}
              <div className={`hidden items-center gap-3 px-4 py-3 md:grid ${desktopGridCols}`}>
                {tile("text-xl")}
                <div className="min-w-0">
                  <Link href={href} className="block truncate text-sm font-semibold text-slate-900">{r.name}</Link>
                  {r.formatLabel && (
                    <p className="truncate text-xs text-slate-500" data-testid="desk-ledger-format">
                      {r.formatLabel}
                    </p>
                  )}
                  {/* V3 fix (review round 1): was `truncate` (single line,
                      cut off exactly where the meaning is — "28 of 28
                      played · Final…"). Wraps up to two lines instead. */}
                  <p className="line-clamp-2 text-xs text-slate-600">{r.statusLine}</p>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-purple-100">
                  <i className={`block h-full rounded-full ${d ? BAR[d.phase] : "bg-purple-300"}`} style={{ width: `${pct}%` }} />
                </div>
                {/* The pill track is ledger-wide (130px); a second pill stacks under the phase rather than widening it. */}
                <div className="flex flex-col items-start gap-1">
                  {d && <PhasePill dict={dict} phase={d.phase} attention={d.attention} />}
                  {d && canEdit && <BansToReviewPill dict={dict} attention={d.attention} locale={locale as Locale} />}
                </div>
                {/* Fix round 2: this cell exists ONLY when the ledger's
                    template reserves its track (`hasNext`) — and then on
                    EVERY row, even one whose own `next` is empty, so the
                    Open column stays on the same grid axis as its
                    neighbours. When no row in the whole ledger has a next
                    fixture, the track itself is dropped above and this cell
                    must not render at all — an empty `<p>` in a dropped
                    track would shift Open into it. */}
                {hasNext && <p className="text-xs text-slate-900">{next}</p>}
                <div className="flex items-center gap-2">
                  <Link href={href} className="btn btn-ghost px-3 py-1.5 text-xs">{t(dict, "desk.ledger.open")}</Link>
                  {r.menu}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* B2: the pager, only when there is a second page. Previous/Next are links that keep the other query params; at either
          end the missing one is an inert placeholder of the same size, so "Next" does not jump left on the last page. */}
      {view.pages > 1 && (
        <nav
          aria-label={t(dict, "desk.ledger.pager.label")}
          data-testid="desk-ledger-pager"
          data-page={view.page}
          data-pages={view.pages}
          className="mt-3 flex items-center justify-between gap-2"
        >
          {view.page > 1 ? (
            <Link
              href={ledgerHref(base, query, { page: view.page - 1, showFinished })}
              rel="prev"
              data-testid="desk-ledger-prev"
              className="btn btn-ghost px-3 py-1.5 text-xs max-md:min-h-11"
            >
              {t(dict, "desk.ledger.pager.prev")}
            </Link>
          ) : (
            <span aria-disabled="true" data-testid="desk-ledger-prev" className="btn btn-ghost pointer-events-none px-3 py-1.5 text-xs opacity-40 max-md:min-h-11">
              {t(dict, "desk.ledger.pager.prev")}
            </span>
          )}
          <span className="text-xs text-slate-600" data-testid="desk-ledger-page-of">
            {t(dict, "desk.ledger.pager.page", { page: view.page, pages: view.pages })}
          </span>
          {view.page < view.pages ? (
            <Link
              href={ledgerHref(base, query, { page: view.page + 1, showFinished })}
              rel="next"
              data-testid="desk-ledger-next"
              className="btn btn-ghost px-3 py-1.5 text-xs max-md:min-h-11"
            >
              {t(dict, "desk.ledger.pager.next")}
            </Link>
          ) : (
            <span aria-disabled="true" data-testid="desk-ledger-next" className="btn btn-ghost pointer-events-none px-3 py-1.5 text-xs opacity-40 max-md:min-h-11">
              {t(dict, "desk.ledger.pager.next")}
            </span>
          )}
        </nav>
      )}
    </section>
  );
}
