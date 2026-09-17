"use client";
// The player card's refusal (owner ruling 2026-09-17, finding D2): the page
// calls `notFound()` whenever `getPublicPlayer` is null — the person never
// consented to a public name, the org is not granted player pages, or there is
// no such person. All three land here and read the SAME: this page takes no
// input about the person, so it cannot say which one it was, or that anyone by
// that id exists.
//
// Before this file the card fell through to `[orgSlug]/not-found.tsx`, whose
// copy is for an expired registration link, in English whatever the org
// speaks. The copy here is the org's, resolved by the card's `layout.tsx` and
// read through `usePlayerNotFoundCopy` (a not-found page takes no props). The link goes to the org home — the org
// resolved, or its layout would have refused first — not the competition,
// which may be the thing that is not public.
import Link from "next/link";
import { useParams } from "next/navigation";
import { usePlayerNotFoundCopy } from "@/components/public-site/player-not-found-copy";

export default function PlayerNotFound() {
  const copy = usePlayerNotFoundCopy();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return (
    <div data-testid="player-not-found" className="flex flex-col items-center px-4 py-16 text-center">
      <div aria-hidden className="mb-6 h-0.5 w-10 bg-accent" />
      <h1 className="font-display text-2xl font-semibold text-ink">{copy.heading}</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-muted">{copy.body}</p>
      <Link
        href={`/shared/${orgSlug}`}
        className="mt-6 inline-flex min-h-11 items-center text-sm font-medium text-accent-strong underline underline-offset-2"
      >
        {copy.cta}
      </Link>
    </div>
  );
}
