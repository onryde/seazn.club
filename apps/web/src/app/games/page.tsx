// /games — Seazn Games listing. Cards come straight from the registry;
// coming-soon games render as non-clickable cards with a badge.
//
// Layout: owner-approved "Option A — game-box cards" (games-canvas gen.py,
// a_card / option_a_desktop / option_a_phone). Each live game is ONE link:
// its GameArt miniature full-bleed on top, then title, tagline and a pill
// "Play →" CTA. 1 column on phones, 2 at sm, 3 at lg.
//
// W3 (chrome tokens, Amendment 2): this page's purple-* classes now read
// from chess-quest's --cq-* custom properties (chess-quest.css), each with
// an inline var(--cq-x, <same oklch>) fallback. The fallback is load-bearing
// here specifically: this page never mounts chess-quest (registry.ts is
// pure data — no component import), so chess-quest.css's :root block is
// never guaranteed present on this route. Fallback values are copied
// verbatim from that file's token table — see chess-quest-chrome-tokens.test.ts.
import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { GameArt } from "@/games/_shared/game-art";
import { GAMES } from "@/games/registry";
import { siteOrigin } from "@/lib/site-origin";

const TITLE = "Games — free browser games | Seazn Club";
const DESCRIPTION =
  "Play free browser games by Seazn Club. Learn-to-play quests and quick challenges — no install, no sign-up, no ads.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  // Relative — resolved against the root layout's metadataBase.
  alternates: { canonical: "/games" },
  // Metadata objects are shallowly merged per segment: since this page
  // defines its OWN openGraph key, the root layout's openGraph (type,
  // siteName only — no title/description) is REPLACED here, not merged, so
  // og:title/og:description must be set explicitly or a shared link (e.g.
  // WhatsApp) shows no page-specific preview at all (found in review
  // 2026-08-27, confirmed against node_modules/next/dist/docs's own
  // metadata-merging rules — "duplicate keys are replaced", "the absence of
  // openGraph.description" is their own example of exactly this gap).
  //
  // No `images` key, deliberately — not even an empty one. The share picture
  // is games/opengraph-image.tsx, and Next applies a segment's file-based
  // image only when that level's openGraph does not own `images`
  // (resolve-metadata.js, mergeStaticMetadata). page.test.tsx pins this.
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/games",
  },
};

/**
 * The card's art panel: 150px tall on phones, 188px from `sm` (the mockups'
 * two heights). GameArt is satori-safe — inline styles only, sized in px off
 * its height — so a media query cannot resize it; each height is its own
 * instance and exactly one is displayed at any width. Both are decorative
 * (aria-hidden), so neither reaches the link's accessible name.
 */
function CardArt({ slug, className = "" }: { slug: string; className?: string }) {
  return (
    <>
      <div className={`sm:hidden ${className}`}>
        <GameArt slug={slug} width="100%" height={150} />
      </div>
      <div className={`max-sm:hidden ${className}`}>
        <GameArt slug={slug} width="100%" height={188} />
      </div>
    </>
  );
}

export default function GamesPage() {
  return (
    <MarketingShell hideBackButton>
      <main className="mx-auto max-w-5xl px-4 pt-10 pb-12 sm:pt-14 sm:pb-[72px]">
        <h1 className="mk-display text-5xl leading-[0.95] font-bold text-[color:var(--cq-ink,oklch(29.1%_0.149_302.717))] sm:text-[4rem]">
          Games
        </h1>
        <p className="mt-2.5 max-w-[620px] text-[17px] leading-[1.4] text-slate-600 sm:text-xl">
          {/* "sign-up" is held on one line: a hyphen is a line-break
              opportunity, and at 768 and 1280 the subline wrapped as
              "no sign-" / "up, no ads." */}
          Free games in your browser — pick one and play. No install,{" "}
          <span className="whitespace-nowrap">no sign-up,</span> no ads.
        </p>
        {/* Absolute, not "/" — on the games.* subdomain the proxy rewrites "/"
            straight back to "/games" (see gamesHostRewrite in proxy.ts), so a
            relative href here would be a dead loop back to this same page
            instead of reaching the marketing home (found in review 2026-08-27). */}
        <Link
          href={`${siteOrigin()}/`}
          className="mt-2.5 inline-block text-[13px] text-slate-500 hover:text-[color:var(--cq-accent,oklch(55.8%_0.288_302.321))]"
        >
          Powered by <span className="font-semibold">Seazn Club</span>
        </Link>

        <div className="mt-6 grid gap-4 sm:mt-8 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
          {GAMES.map((g) =>
            g.status === "live" ? (
              <Link
                key={g.slug}
                href={`/games/${g.slug}`}
                className="group flex flex-col overflow-hidden rounded-[20px] border border-slate-200 bg-white shadow-[0_1px_0_rgba(59,7,100,0.04)] transition hover:border-[color:var(--cq-accent-line,oklch(82.7%_0.119_306.383))] hover:shadow-md"
              >
                <CardArt slug={g.slug} />
                <div className="flex flex-1 flex-col gap-2 px-5 pt-[18px] pb-5">
                  <h2 className="mk-display text-[26px] leading-none font-bold text-[color:var(--cq-ink,oklch(29.1%_0.149_302.717))] group-hover:text-[color:var(--cq-label,oklch(49.6%_0.265_301.924))] sm:text-[28px]">
                    {g.title}
                  </h2>
                  <p className="mb-2 flex-1 text-[15px] leading-[1.45] text-slate-600">{g.tagline}</p>
                  {/* The arrow is decoration, hidden from assistive tech so the
                      link is not announced as "… Play right arrow"; the pill's
                      text is still "Play →". gap-1 stands in for the space,
                      which inline-flex drops between its two items. */}
                  <span className="inline-flex h-11 items-center gap-1 self-start rounded-full bg-[color:var(--cq-accent,oklch(55.8%_0.288_302.321))] px-[18px] text-[15px] font-semibold text-white transition group-hover:bg-[color:var(--cq-accent-strong,oklch(43.8%_0.218_303.724))]">
                    Play <span aria-hidden="true">→</span>
                  </span>
                </div>
              </Link>
            ) : (
              <div
                key={g.slug}
                className="flex flex-col overflow-hidden rounded-[20px] border border-dashed border-slate-300 bg-slate-50"
              >
                <CardArt slug={g.slug} className="opacity-60" />
                <div className="flex flex-1 flex-col gap-2 px-5 pt-[18px] pb-5">
                  <h2 className="mk-display text-[26px] leading-none font-bold text-slate-500 sm:text-[28px]">
                    {g.title}
                  </h2>
                  <p className="mb-2 flex-1 text-[15px] leading-[1.45] text-slate-500">{g.tagline}</p>
                  <span className="self-start rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                    Coming soon
                  </span>
                </div>
              </div>
            ),
          )}
        </div>
      </main>
    </MarketingShell>
  );
}
