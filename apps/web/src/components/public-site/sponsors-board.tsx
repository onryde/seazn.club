// Spectator surface W2, Task 12 — the perimeter sponsor board, lifted out of
// the competition page so the page can hand it to the landing root as a slot.
//
// NO `"use client"`. It is rendered by `page.tsx` (a server component) and
// travels to `CompetitionLanding` as an already-rendered `ReactNode`, so this
// module never enters the client bundle — which is why it may `import type`
// from `@/server/usecases/sponsors` without dragging `lib/db` anywhere near a
// browser. Do not import it FROM a client component; that would change both
// facts at once and silently.
//
// ── WHAT THIS IS, VISUALLY (v10) ───────────────────────────────────────────
// Sponsors render the way a venue shows them — panels on the court-slab band
// that bookends the hero. Tier is encoded physically: title = the "presented
// by" lockup on the board, gold/silver = sized panels, partners = the quiet
// ticker line beneath. The board itself is the Pro presentation: free
// (un-tiered) orgs keep the modest flat chip strip, so a community sponsor
// never reads like a paid title placement.
//
// ── THE ONE THING THAT CHANGED IN THE LIFT ─────────────────────────────────
// `landing.presentedBy` is "Presented by {sponsor}" — a whole SENTENCE with the
// sponsor's name in it, in all four locales. The page it came from drew a small
// eyebrow reading "Presented by" with the names in display type underneath,
// and that shape cannot be rendered from this key without either inventing a
// second, name-less key or interpolating an empty string into a sentence.
//
// Rendering the sentence whole is the better answer regardless, and it is an
// i18n reason rather than a layout one: a fixed "label above, name below" pins
// English word order into the markup. A locale that puts the sponsor first, or
// that needs a different preposition before a name, has nowhere to go. So the
// lockup IS the sentence, in display type, with the logo beside it — which is
// also how a title board actually reads at a ground.
import Image from "next/image";
import type { ResolvedSponsor, SponsorTier } from "@/server/usecases/sponsors";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

export interface SponsorsBoardProps {
  /** The org's active sponsors, already resolved and ordered by the usecase.
   *  The CALLER renders this component only when the list is non-empty — the
   *  same contract `OverviewTab`/`InfoTab` state for their slots, because a
   *  heading over an absent block reads as content that failed to load. */
  sponsors: readonly ResolvedSponsor[];
  /** Pro `sponsors.tiers`. Without it every row collapses to the free flat
   *  partner strip, tier column or no tier column. */
  tiered: boolean;
  dict: PublicDict;
}

/** Panel sizing per tier — the physical encoding of rank. */
const PANEL: Record<SponsorTier, { text: string; logo: number; logoCls: string }> = {
  title: {
    text: "font-display text-3xl font-bold uppercase tracking-tight sm:text-4xl",
    logo: 48,
    logoCls: "h-12 w-12",
  },
  gold: { text: "font-display text-xl font-semibold uppercase tracking-tight", logo: 32, logoCls: "h-8 w-8" },
  silver: { text: "text-sm font-semibold text-court-muted", logo: 24, logoCls: "h-6 w-6" },
  partner: { text: "text-sm font-semibold text-court-muted", logo: 20, logoCls: "h-5 w-5" },
};

/**
 * The tracked redirect, or the raw URL for a blob-shim entry.
 *
 * Table rows go through `/s/{id}` so a click is counted; the shim entries that
 * still live in an org's `branding` jsonb have no row and therefore no id, and
 * link straight out. Exported for its own test: both rungs are reachable from
 * real data and the fallback is the one that silently stops counting clicks.
 */
export function sponsorHref(sponsor: Pick<ResolvedSponsor, "id" | "url">): string | null {
  if (!sponsor.url) return null;
  return sponsor.id ? `/s/${sponsor.id}` : sponsor.url;
}

export function SponsorsBoard({ sponsors, tiered, dict }: SponsorsBoardProps) {
  // Un-tiered orgs have no hierarchy to draw, so the three tiered groups are
  // empty BY CONSTRUCTION rather than by the data happening to be flat — a
  // free org whose rows carry a `title` tier (bought, then downgraded) still
  // gets the flat strip.
  const titleRow = tiered ? sponsors.filter((s) => s.tier === "title") : [];
  const boardRows = tiered ? sponsors.filter((s) => s.tier === "gold" || s.tier === "silver") : [];
  const tickerRows = tiered ? sponsors.filter((s) => s.tier === "partner") : [];

  const panel = (s: ResolvedSponsor) => PANEL[tiered ? s.tier : "partner"];

  // One shared logo site (public-image-contract pins this pair). Logos sit on a
  // light chip so dark marks survive the slab.
  const logo = (s: ResolvedSponsor) =>
    s.logo ? (
      <span className="shrink-0 rounded bg-white/95 p-0.5">
        <Image
          src={s.logo}
          alt=""
          width={panel(s).logo}
          height={panel(s).logo}
          className={`${panel(s).logoCls} object-contain`}
        />
      </span>
    ) : null;

  const linked = (s: ResolvedSponsor, node: React.ReactNode) => {
    const href = sponsorHref(s);
    // New tab: the reader keeps their place at the competition. `sponsored`
    // marks the paid placement for crawlers.
    return href ? (
      <a href={href} target="_blank" rel="nofollow noopener sponsored" className="transition hover:opacity-85">
        {node}
      </a>
    ) : (
      node
    );
  };

  return (
    <section data-testid="mh-sponsors" className="min-w-0">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-ink-muted">
        {t(dict, "landing.sponsors")}
      </h2>
      {titleRow.length > 0 || boardRows.length > 0 ? (
        <div
          data-testid="mh-sponsors-board"
          className="overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg"
        >
          {/* Accent line mirrors the hero's — the two slabs bookend the page. */}
          <div aria-hidden className="h-1 bg-accent" />
          {titleRow.length > 0 ? (
            <div
              data-testid="mh-sponsors-title"
              className={`px-6 py-6 text-center ${boardRows.length > 0 ? "border-b border-white/10" : ""}`}
            >
              <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3">
                {titleRow.map((s) => (
                  <span key={s.name}>
                    {linked(
                      s,
                      <span className="flex min-w-0 items-center gap-3.5">
                        {logo(s)}
                        <span className={PANEL.title.text}>
                          {t(dict, "landing.presentedBy", { sponsor: s.name })}
                        </span>
                      </span>,
                    )}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {boardRows.length > 0 ? (
            <ul
              data-testid="mh-sponsors-panels"
              className="flex flex-wrap items-center justify-center gap-2 px-4 py-3.5"
            >
              {boardRows.map((s) => (
                <li key={s.name}>
                  {linked(
                    s,
                    <span
                      className={`flex min-w-0 items-center gap-2.5 rounded-lg bg-white/5 px-5 py-2.5 ring-1 ring-white/10 transition hover:bg-white/10 ${panel(s).text}`}
                    >
                      {logo(s)}
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
              {linked(s, <span>{s.name}</span>)}
            </span>
          ))}
        </p>
      ) : null}
      {!tiered ? (
        // Free strip: quiet light chips, no board, no hierarchy.
        <ul data-testid="mh-sponsors-flat" className="flex flex-wrap items-center gap-3">
          {sponsors.map((s) => (
            <li key={s.name}>
              {linked(
                s,
                <span className="flex min-w-0 items-center gap-2 rounded-lg border border-zinc-200/80 bg-surface px-3 py-2 text-sm text-zinc-600 shadow-sm">
                  {logo(s)}
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
