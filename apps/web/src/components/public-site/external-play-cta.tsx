import type { PublicExternalPlay } from "@/server/external-play/public-view";

type Msg = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Player-facing online-play strip for the public fixture page.
 * pending → wait copy; needs_organiser → wait for organiser; anything else →
 * nothing. There is no "Play on Lichess" link: D3 deleted the lichess.org
 * mode, and the game is played on the in-page board (T14's surfaces).
 */
export function ExternalPlayCta({
  externalPlay,
  scheduledLabel,
  msg,
}: {
  externalPlay: PublicExternalPlay;
  scheduledLabel: string | null;
  msg: Msg;
}) {
  if (externalPlay.status === "pending") {
    return (
      <p
        data-testid="external-play-waiting"
        className="mb-4 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600"
      >
        {msg("externalPlay.waitingForLink", {
          when: scheduledLabel ?? msg("externalPlay.soon"),
        })}
      </p>
    );
  }

  if (externalPlay.status === "needs_organiser") {
    // The reason stays off the public page: it lives in last_error, which is
    // operator text. A legacy delay clock no longer reaches here at all (the
    // guard treats its division as not online).
    return (
      <p
        data-testid="external-play-needs-organiser"
        className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
      >
        {msg("externalPlay.needsOrganiser")}
      </p>
    );
  }

  return null;
}
