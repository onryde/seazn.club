// /games — Seazn Games listing. Cards come straight from the registry;
// coming-soon games render as non-clickable cards with a badge.
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
import { GAMES } from "@/games/registry";
import { siteOrigin } from "@/lib/site-origin";

const TITLE = "Games — free browser games | Seazn Club";
const DESCRIPTION =
  "Play free browser games by Seazn Club. Learn-to-play quests and quick challenges — no install, no sign-up.";

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
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/games",
  },
};

export default function GamesPage() {
  return (
    <MarketingShell hideBackButton>
      <main className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="mk-display text-4xl font-bold text-[color:var(--cq-ink,oklch(29.1%_0.149_302.717))]">
          Games
        </h1>
        <p className="mt-3 max-w-2xl text-lg text-slate-600">
          Free games in your browser — pick one and play. No install, no sign-up.
        </p>
        {/* Absolute, not "/" — on the games.* subdomain the proxy rewrites "/"
            straight back to "/games" (see gamesHostRewrite in proxy.ts), so a
            relative href here would be a dead loop back to this same page
            instead of reaching the marketing home (found in review 2026-08-27). */}
        <Link
          href={`${siteOrigin()}/`}
          className="mt-1 inline-block text-xs text-slate-400 hover:text-[color:var(--cq-accent,oklch(55.8%_0.288_302.321))]"
        >
          Powered by <span className="font-semibold">Seazn Club</span>
        </Link>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GAMES.map((g) =>
            g.status === "live" ? (
              <Link
                key={g.slug}
                href={`/games/${g.slug}`}
                className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-[color:var(--cq-accent-line,oklch(82.7%_0.119_306.383))] hover:shadow-md"
              >
                <div className="text-5xl">{g.thumbnail}</div>
                <h2 className="mk-display mt-3 text-xl font-bold text-[color:var(--cq-ink,oklch(29.1%_0.149_302.717))] group-hover:text-[color:var(--cq-label,oklch(49.6%_0.265_301.924))]">
                  {g.title}
                </h2>
                <p className="mt-1 text-sm text-slate-500">{g.tagline}</p>
                <span className="mt-3 inline-block text-sm font-medium text-[color:var(--cq-accent,oklch(55.8%_0.288_302.321))]">
                  Play →
                </span>
              </Link>
            ) : (
              <div
                key={g.slug}
                className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5"
              >
                <div className="text-5xl opacity-60">{g.thumbnail}</div>
                <h2 className="mk-display mt-3 text-xl font-bold text-slate-500">{g.title}</h2>
                <p className="mt-1 text-sm text-slate-400">{g.tagline}</p>
                <span className="mt-3 inline-block rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  Coming soon
                </span>
              </div>
            ),
          )}
        </div>
      </main>
    </MarketingShell>
  );
}
