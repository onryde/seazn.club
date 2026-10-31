// Spectator surface — the sponsor placement: a hero lockup for the title tier
// and a perimeter board for everyone else.
//
// NO `"use client"`. Both exports are rendered by `page.tsx` (a server
// component), which is why this module may `import type` from
// `@/server/usecases/sponsors` without dragging `lib/db` anywhere near a
// browser. Do not import it FROM a client component; that would change both
// facts at once and silently.
//
// ── WHERE SPONSORS RENDER, AND WHY IT MOVED ────────────────────────────────
// W2 Task 12 handed this board to `CompetitionLanding` as a slot, and the
// landing put it inside the Overview and Info tabs. That was a regression a
// spectator can see: a competition's sponsors disappeared the moment anyone
// tapped Matches, Table, Stats or Teams — which is most of the surface, and all
// of the surface a spectator actually watches a game on.
//
// The placement is now owner-ruled (2026-09-12, Option B):
//
//  • The TITLE tier sits in the hero, under the competition name. A title
//    sponsorship is the one tier sold on PROMINENCE rather than presence, and
//    the hero is the only part of this page every spectator sees before they
//    choose anything. `SponsorsHeroTitle` draws it.
//  • Everyone else sits on the perimeter board BELOW the tab panel, on the
//    page rather than inside a tab, so it is present whichever tab is open.
//    `SponsorsBoard` draws it.
//
// A free (un-tiered) org has no title tier by construction, so it gets the hero
// untouched and the modest flat chip strip on the board — a community sponsor
// never reads like a paid title placement.
//
// ── WHAT THIS MEANS FOR A `title` ROW REACHING `SponsorsBoard` ─────────────
// On the competition page it is ignored, BY DESIGN rather than by accident:
// both components take the org's whole resolved list and each filters to the
// tiers it owns, so the page never has to split the list correctly for them.
// The alternative — the caller slicing the array — is a contract that fails
// silently the first time someone passes the wrong half.
//
// The public MATCH page (owner rulings D15 + R8, R4 S10) has no hero, so it
// mounts the board with `includeTitle`: the title sponsor then leads the slab,
// as the same "Presented by" sentence, above the panels. The hero's lockup
// cannot simply move there — it is light type for the hero's dark slab, and
// the match page's own background is light.
//
// ── CLICK TAGS (R4 S10, spec 2026-10-27 §3.7) ───────────────────────────────
// Every tracked link says which page it sits on — `clickTag`, required, so a
// mount cannot forget it and quietly count as `unknown`: the competition page
// is `site`, a match page is `match` with that fixture.
//
// ── THE ONE THING THAT DID NOT CHANGE ──────────────────────────────────────
// `landing.presentedBy` is "Presented by {sponsor}" — a whole SENTENCE with the
// sponsor's name in it, in all four locales. It is rendered WHOLE, in display
// type, with the logo beside it. A fixed "label above, name below" lockup pins
// English word order into the markup: a locale that puts the sponsor first, or
// needs a different preposition before a name, has nowhere to go. The approved
// mock drew that two-line lockup; the sentence wins on the i18n argument, and a
// mock is not a dictionary.
import Image from "next/image";
import type { ResolvedSponsor, SponsorTier } from "@/server/usecases/sponsors";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { sponsorClickPath, type BoardClickTag } from "@/lib/sponsor-clicks";

/** Panel sizing per tier — the physical encoding of rank on the board. `title`
 *  is absent because the title tier is not drawn here any more; see the header. */
const PANEL: Record<
  Exclude<SponsorTier, "title">,
  { text: string; logo: number; logoCls: string }
> = {
  gold: {
    text: "font-display text-xl font-semibold uppercase tracking-tight",
    logo: 32,
    logoCls: "h-8 w-8",
  },
  silver: { text: "text-sm font-semibold text-court-muted", logo: 24, logoCls: "h-6 w-6" },
  partner: { text: "text-sm font-semibold text-court-muted", logo: 20, logoCls: "h-5 w-5" },
};

/**
 * The tracked redirect, tagged with the page the link sits on, or the raw URL
 * for a blob-shim entry.
 *
 * Table rows go through `/s/{id}?…` so a click is counted, and counted for its
 * page (and its match); the shim entries that still live in an org's
 * `branding` jsonb have no row and therefore no id, and link straight out.
 * Exported for its own test: both rungs are reachable from real data and the
 * fallback is the one that silently stops counting clicks.
 */
export function sponsorHref(sponsor: Pick<ResolvedSponsor, "id" | "url">, tag: BoardClickTag): string | null {
  if (!sponsor.url) return null;
  return sponsor.id ? sponsorClickPath(sponsor.id, tag) : sponsor.url;
}

/** One shared logo site (public-image-contract pins this pair). Logos sit on a
 *  light chip so dark marks survive the slab. */
function logoChip(sponsor: ResolvedSponsor, px: number, cls: string) {
  if (!sponsor.logo) return null;
  return (
    <span className="shrink-0 rounded bg-white/95 p-0.5">
      <Image src={sponsor.logo} alt="" width={px} height={px} className={`${cls} object-contain`} />
    </span>
  );
}

/** New tab: the reader keeps their place at the competition. `sponsored` marks
 *  the paid placement for crawlers. */
function linked(sponsor: ResolvedSponsor, tag: BoardClickTag, node: React.ReactNode) {
  const href = sponsorHref(sponsor, tag);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="nofollow noopener sponsored"
      className="transition hover:opacity-85"
    >
      {node}
    </a>
  ) : (
    node
  );
}

export interface SponsorsProps {
  /** The org's active sponsors, already resolved and ordered by the usecase —
   *  the WHOLE list, not a slice. Each component filters to the tiers it owns;
   *  see the header. */
  sponsors: readonly ResolvedSponsor[];
  /** Pro `sponsors.tiers`. Without it there is no title tier at all and every
   *  board row collapses to the free flat strip. */
  tiered: boolean;
  dict: PublicDict;
  /** What every tracked link claims (S10): `site` on the competition page, `match` + its fixture on a match page. */
  clickTag: BoardClickTag;
}

/** The title sponsor's line: logo and the whole "Presented by {sponsor}" sentence, light type for a dark slab. The
 *  hero and the match board draw this ONE node, so the two placements cannot word or size the title differently. */
function titleLine(s: ResolvedSponsor, dict: PublicDict, tag: BoardClickTag) {
  return linked(
    s,
    tag,
    <span className="flex min-w-0 items-center gap-2.5">
      {logoChip(s, 40, "h-10 w-10")}
      <span className="min-w-0 font-display text-lg font-semibold uppercase tracking-tight text-court-ink sm:text-xl">
        {t(dict, "landing.presentedBy", { sponsor: s.name })}
      </span>
    </span>,
  );
}

/**
 * The title sponsor, in the hero, under the competition name.
 *
 * Renders `null` when there is nothing to show, so the caller needs no
 * predicate — this sits in the hero's `flex flex-col`, where an absent child
 * costs no gap. (The `undefined`-not-an-empty-element contract that governs the
 * tab slots does not apply here: this is not a slot, and it owns no heading.)
 */
export function SponsorsHeroTitle({ sponsors, tiered, dict, clickTag }: SponsorsProps) {
  // Un-tiered orgs have no hierarchy to draw, so this is empty BY CONSTRUCTION
  // rather than by the data happening to be flat — a free org whose rows carry
  // a `title` tier (bought, then downgraded) gets no hero placement back.
  const titleRow = tiered ? sponsors.filter((s) => s.tier === "title") : [];
  if (titleRow.length === 0) return null;
  return (
    // `min-w-0` on every rung of this chain: a 43-character sponsor name inside
    // a flex child that cannot shrink is the exact shape that put 106px of
    // horizontal overflow on a phone once already (AGENTS.md, phone
    // composition). The name WRAPS here rather than truncating — a sponsor's
    // name is the thing they paid for, so it is never cut off.
    <p
      data-testid="mh-hero-sponsor"
      className="mt-3 flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2"
    >
      {titleRow.map((s) => (
        <span key={s.name} className="min-w-0">
          {titleLine(s, dict, clickTag)}
        </span>
      ))}
    </p>
  );
}

export interface SponsorsBoardProps extends SponsorsProps {
  /** The match page's board (D15 + R8): there is no hero there, so the title tier leads the slab. The competition
   *  page leaves it off — its hero draws the title sponsor. */
  includeTitle?: boolean;
}

/**
 * The perimeter board — gold and silver as panels, partners as the quiet ticker
 * line beneath, or the flat chip strip for a free org. With `includeTitle`
 * (the match page) the title sponsor's line heads the slab.
 *
 * Renders `null` when it has nothing to draw, which is why the page mounts it
 * unconditionally. A heading over an absent block reads as content that failed
 * to load, and a tiered org whose ONLY sponsor is the title tier reaches
 * exactly that state on the competition page — the hero has the sponsor and
 * this has nothing.
 */
export function SponsorsBoard({ sponsors, tiered, dict, clickTag, includeTitle = false }: SponsorsBoardProps) {
  const titleRows = tiered && includeTitle ? sponsors.filter((s) => s.tier === "title") : [];
  const boardRows = tiered ? sponsors.filter((s) => s.tier === "gold" || s.tier === "silver") : [];
  const tickerRows = tiered ? sponsors.filter((s) => s.tier === "partner") : [];
  const flatRows = tiered ? [] : sponsors;

  if (titleRows.length === 0 && boardRows.length === 0 && tickerRows.length === 0 && flatRows.length === 0) return null;

  // `s.tier` is narrowed to the board tiers by the filter above; the guard is
  // what makes that provable to the compiler rather than asserted.
  const panel = (s: ResolvedSponsor) => PANEL[s.tier === "title" ? "partner" : s.tier];

  return (
    <section data-testid="mh-sponsors" className="mt-6 min-w-0">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "landing.sponsors")}
      </h2>
      {titleRows.length > 0 || boardRows.length > 0 ? (
        <div
          data-testid="mh-sponsors-board"
          className="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg"
        >
          {/* Accent line mirrors the hero's — the two slabs bookend the page. */}
          <div aria-hidden className="h-1 bg-accent" />
          {titleRows.length > 0 ? (
            // The match page's naming-rights line: the title sponsor heads the
            // slab, centred over the panels like the name over a ground. It
            // WRAPS (min-w-0 down the chain, as in the hero) — never truncated.
            <p
              data-testid="mh-sponsors-title"
              className="flex min-w-0 flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 py-3.5 text-center"
            >
              {titleRows.map((s) => (
                <span key={s.name} className="min-w-0">
                  {titleLine(s, dict, clickTag)}
                </span>
              ))}
            </p>
          ) : null}
          {boardRows.length > 0 ? (
          <ul
            data-testid="mh-sponsors-panels"
            // A hairline between the title line and the panels marks the tier
            // boundary; without a title line there is no boundary to mark.
            className={`flex flex-wrap items-center justify-center gap-2 px-4 py-3.5${titleRows.length > 0 ? " border-t border-white/10" : ""}`}
            role="list"
          >
            {boardRows.map((s) => (
              <li key={s.name}>
                {linked(
                  s,
                  clickTag,
                  <span
                    className={`flex min-w-0 items-center gap-2.5 rounded-lg bg-white/5 px-5 py-2.5 ring-1 ring-white/10 transition hover:bg-white/10 ${panel(s).text}`}
                  >
                    {logoChip(s, panel(s).logo, panel(s).logoCls)}
                    {s.name}
                  </span>,
                )}
              </li>
            ))}
          </ul>
          ) : null}
        </div>
      ) : null}
      {tickerRows.length > 0 ? (
        <p
          data-testid="mh-sponsors-partners"
          className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-muted"
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em]">
            {t(dict, "landing.partners")}
          </span>
          {tickerRows.map((s, i) => (
            <span key={s.name} className="inline-flex items-baseline gap-x-3">
              {i > 0 ? <span aria-hidden>·</span> : null}
              {linked(s, clickTag, <span>{s.name}</span>)}
            </span>
          ))}
        </p>
      ) : null}
      {flatRows.length > 0 ? (
        // Free strip: quiet light chips, no board, no hierarchy.
        <ul data-testid="mh-sponsors-flat" className="flex flex-wrap items-center gap-3" role="list">
          {flatRows.map((s) => (
            <li key={s.name}>
              {linked(
                s,
                clickTag,
                <span className="flex min-w-0 items-center gap-2 rounded-lg border border-zinc-200/80 bg-surface px-3 py-2 text-sm text-zinc-600 shadow-sm">
                  {logoChip(s, PANEL.partner.logo, PANEL.partner.logoCls)}
                  {s.name}
                </span>,
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
