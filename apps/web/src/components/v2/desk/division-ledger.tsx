import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { routes } from "@/lib/routes";
import { sportEmoji } from "@/components/discovery-cards";
import { whenLabel } from "@/lib/division-status-line";
import type { Attention } from "@/lib/division-phase";
import type { DeskDivision } from "@/server/usecases/competition-desk";
import { PhasePill } from "./phase-pill";

export interface LedgerRow {
  id: string;
  name: string;
  slug: string;
  sportKey: string;
  logoUrl: string | null;
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

function nextLine(dict: Dict, d: DeskDivision, locale: string, nowMs: number, orgTz: string): string {
  // V4 fix (review round 1): nothing left to schedule is not itself
  // information — the row already says "finished" / "N of N played". An
  // empty cell here (rather than "Nothing scheduled next" on every settled
  // row) is the whole point of a desk that only speaks when something is
  // actually owed.
  if (!d.next) return "";
  const home = d.next.home ?? "—";
  const away = d.next.away ?? "—";
  if (d.next.in_play) return t(dict, "desk.ledger.now", { home, away });
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
  // fix-round-c, Defect (c): the DAY half comes from the org (governing)
  // zone — the same zone the masthead's own "Next {when}" pill always used —
  // so this cell can never name a different day than the pill above it; only
  // the clock digits stay venue-local (`d.display_tz`).
  const when = whenLabel(at, locale, orgTz, d.display_tz);
  return t(dict, "desk.ledger.next", { when, home, away }).replace("  ", " ");
}

/** The mobile card's one action: a red attention's own label/href, or none.
 *  Owner ruling (review round 1, mobile-card redesign): the card itself is
 *  the tap target to the division — a button only earns its place when
 *  there's something that specifically needs doing (needs_draw / no_scorer),
 *  mirroring what NeedsYou would already surface for this division. */
function redAction(dict: Dict, d: DeskDivision, org: string, comp: string, slug: string): { label: string; href: string } | null {
  const a = d.attention.find(
    (x): x is Extract<Attention, { kind: "needs_draw" | "no_scorer" }> =>
      x.kind === "needs_draw" || x.kind === "no_scorer",
  );
  if (!a) return null;
  if (a.kind === "needs_draw") {
    return { label: t(dict, "desk.needsYou.needs_draw.action"), href: routes.division(org, comp, slug, "fixtures") };
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
  dict, rows, org, comp, locale, now, orgTz,
}: {
  dict: Dict; rows: LedgerRow[]; org: string; comp: string; locale: string; now: string;
  /** fix-round-c, Defect (c) — the governing org clock, threaded down to
   *  `nextLine`'s own `whenLabel` call so the desktop "Next: …" cell's date
   *  half agrees with the masthead pill above it. */
  orgTz: string;
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
  const nowMs = Date.parse(now);
  const nextByRow = rows.map((r) => (r.desk ? nextLine(dict, r.desk, locale, nowMs, orgTz) : ""));
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
      <div className="card divide-y divide-purple-50">
        {rows.map((r, i) => {
          const d = r.desk;
          const pct = d && d.total > 0 ? Math.round((d.played / d.total) * 100) : 0;
          const href = routes.division(org, comp, r.slug);
          const next = nextByRow[i];
          const action = d ? redAction(dict, d, org, comp, r.slug) : null;
          const tile = (sizeClass: string) => (
            <span
              aria-hidden
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
                  <div className="flex items-center gap-2">
                    {tile("text-2xl")}
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{r.name}</span>
                    {d && <PhasePill dict={dict} phase={d.phase} attention={d.attention} className="shrink-0" />}
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-purple-100">
                    <i className={`block h-full rounded-full ${d ? BAR[d.phase] : "bg-purple-300"}`} style={{ width: `${pct}%` }} />
                  </div>
                  {/* Never truncates, never clamps — wraps to whatever it
                      needs (owner ruling: "the STATUS LINE wraps to as many
                      lines as it needs"). */}
                  <p className="mt-2 text-xs text-slate-600">{r.statusLine}</p>
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
                  {/* V3 fix (review round 1): was `truncate` (single line,
                      cut off exactly where the meaning is — "28 of 28
                      played · Final…"). Wraps up to two lines instead. */}
                  <p className="line-clamp-2 text-xs text-slate-600">{r.statusLine}</p>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-purple-100">
                  <i className={`block h-full rounded-full ${d ? BAR[d.phase] : "bg-purple-300"}`} style={{ width: `${pct}%` }} />
                </div>
                <div>{d && <PhasePill dict={dict} phase={d.phase} attention={d.attention} />}</div>
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
    </section>
  );
}
