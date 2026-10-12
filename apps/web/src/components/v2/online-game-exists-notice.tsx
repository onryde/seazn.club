"use client";
// T16 (T19 carry): the organiser's answer when Unpair, Rebuild or deleting an entrant is refused because an online
// game stands behind a board it would clear (409 ONLINE_GAME_EXISTS). The way out is settling that board in the
// arbiter panel, so the notice links there — or, on a page with no panel to link to, says so alone.
import Link from "next/link";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { ONLINE_GAME_EXISTS_KEY } from "@/lib/open-round";

export function OnlineGameExistsNotice({ arbiterHref }: { arbiterHref: string | null }) {
  const msg = useMsg();
  return (
    <div
      role="alert"
      data-testid="online-game-exists"
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      <span className="min-w-0">{msg(ONLINE_GAME_EXISTS_KEY as MessageKey)}</span>
      {arbiterHref !== null && (
        <Link
          data-testid="online-game-exists-link"
          href={arbiterHref}
          className="inline-flex min-h-11 items-center font-semibold text-[#5b21b6] underline"
        >
          {msg("externalPlay.gameExistsCta")}
        </Link>
      )}
    </div>
  );
}
