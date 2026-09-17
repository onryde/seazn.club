// The player card's own layout, which adds no markup: it exists so the card's
// not-found page (`not-found.tsx` beside it) can speak the ORG's language
// (owner ruling 2026-09-17, finding D2).
//
// A not-found page takes no props, so it cannot read the org. A layout wraps
// its own segment's not-found boundary, so the copy is handed down from here —
// three resolved strings in a context of their own
// (`PlayerNotFoundCopyProvider`), never a dictionary: the layout wraps the card
// page too, and that file says why a `DictProvider` there would be a trap.
// The org read is `[orgSlug]/layout.tsx`'s own door (`publicOrgOr404`, cached
// on the org), and the locale is the org's `default_locale`, never the
// viewer's: this route is ISR, and a request-scoped read would make it dynamic.
//
// An UNKNOWN org never reaches this layout: `[orgSlug]/layout.tsx` calls
// notFound() first, and a layout's notFound() skips its own segment's
// boundary, so that URL gets Next's bare built-in 404 — the same page as
// `/shared/<missing-org>` (pre-existing, observed on a prod build in review).
// Whether an org exists is public anyway; nothing about a person is revealed.
import type { ReactNode } from "react";
import { PlayerNotFoundCopyProvider } from "@/components/public-site/player-not-found-copy";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";
import { publicOrgOr404 } from "@/server/public-site/org-guard";

export default async function PlayerCardLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await publicOrgOr404(orgSlug);
  const dict = await getDictionary(toLocale(org.default_locale), "public");
  const copy = {
    heading: t(dict, "player.notFound.heading"),
    body: t(dict, "player.notFound.body"),
    cta: t(dict, "player.notFound.cta"),
  };
  return <PlayerNotFoundCopyProvider copy={copy}>{children}</PlayerNotFoundCopyProvider>;
}
