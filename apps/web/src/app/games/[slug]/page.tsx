// /games/<slug> — game player page. Slim chrome (no marketing footer):
// header bar + full-height game area. Coming-soon games get a teaser panel.
//
// W3 (chrome tokens, Amendment 2): this header's purple-* classes now read
// from chess-quest's --cq-* custom properties (chess-quest.css), each with
// an inline var(--cq-x, <same oklch>) fallback. Load-bearing here: chess-quest
// mounts through player-map.tsx's next/dynamic({ ssr:false }) — a separate,
// client-only chunk — so this server-rendered header can paint before (or
// for a non-chess-quest slug, without ever) that chunk's CSS loads. Fallback
// values are copied verbatim from chess-quest.css's token table — see
// chess-quest-chrome-tokens.test.ts.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getGame } from "@/games/registry";
import { siteOrigin } from "@/lib/site-origin";
import { GamePlayer } from "./game-player";

type Params = { slug: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) return {};
  const title = `${game.title} — play free | Seazn Club`;
  return {
    title,
    description: game.description,
    // Canonical always on the apex domain so games.seazn.club doesn't split SEO.
    alternates: { canonical: `https://seazn.club/games/${slug}` },
    // This page defines its own openGraph key, which REPLACES (not merges
    // with) the root layout's openGraph — see games/page.tsx's comment for
    // the full reasoning. Without this, sharing a game (e.g. the WhatsApp
    // share button Daily Word now has) showed no page-specific preview.
    openGraph: {
      title,
      description: game.description,
      url: `https://seazn.club/games/${slug}`,
    },
  };
}

export default async function GamePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const game = getGame(slug);
  if (!game) notFound();

  return (
    <div className="flex min-h-dvh flex-col bg-white">
      {/* Phone composition (design of record: "Game page header"): at 320 the
          three-item row wrapped into two or three lines with orphaned
          dividers. Below 768 it is "← Games" + the title on ONE row — the
          dividers fold, the title truncates — and the attribution moves to
          the footer line under <main>. One DOM: the two attribution copies
          hide at each other's width, so exactly one is ever visible. */}
      <header className="flex flex-wrap items-center justify-center gap-3 border-b border-slate-200 px-4 py-2 max-md:flex-nowrap max-md:justify-start">
        <Link
          href="/games"
          className="shrink-0 text-sm font-medium text-[color:var(--cq-accent,oklch(55.8%_0.288_302.321))] hover:text-[color:var(--cq-accent-strong,oklch(43.8%_0.218_303.724))] max-md:flex max-md:min-h-11 max-md:items-center"
        >
          ← Games
        </Link>
        <span className="text-sm text-slate-300 max-md:hidden">|</span>
        <h1 className="mk-display text-base font-bold text-[color:var(--cq-ink,oklch(29.1%_0.149_302.717))] max-md:min-w-0 max-md:truncate">
          {game.title}
        </h1>
        <span className="text-sm text-slate-300 max-md:hidden">|</span>
        {/* Absolute, not "/" — on the games.* subdomain the proxy rewrites "/"
            straight back to "/games" (see gamesHostRewrite in proxy.ts), so a
            relative href here would be a dead loop back into this game
            instead of reaching the marketing home (found in review 2026-08-27). */}
        <Link
          href={`${siteOrigin()}/`}
          className="text-xs text-slate-400 hover:text-[color:var(--cq-accent,oklch(55.8%_0.288_302.321))] max-md:hidden"
        >
          Powered by <span className="font-semibold">Seazn Club</span>
        </Link>
      </header>
      <main className="min-h-0 flex-1">
        {game.status === "live" ? (
          <GamePlayer slug={game.slug} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <div className="text-6xl">{game.thumbnail}</div>
            <h2 className="mk-display text-2xl font-bold text-[color:var(--cq-ink,oklch(29.1%_0.149_302.717))]">
              {game.title} is coming soon
            </h2>
            <p className="max-w-md text-sm text-slate-500">{game.description}</p>
            <Link href="/games" className="btn btn-ghost mt-2">
              Browse other games
            </Link>
          </div>
        )}
      </main>
      {/* The phone half of the attribution pair above — same href, same
          classes (the token-fallback test reads both), md:hidden so it never
          doubles the header copy. */}
      <footer className="border-t border-slate-200 px-4 py-3 text-center md:hidden">
        <Link
          href={`${siteOrigin()}/`}
          className="text-xs text-slate-400 hover:text-[color:var(--cq-accent,oklch(55.8%_0.288_302.321))]"
        >
          Powered by <span className="font-semibold">Seazn Club</span>
        </Link>
      </footer>
    </div>
  );
}
