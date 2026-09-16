import type { PublicExternalPlay } from "@/server/external-play/public-view";
import { playUrlForStatus } from "@/server/external-play/public-view";

type Msg = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Player-facing online-play strip for the public fixture page.
 * Ready/live → Play on Lichess; pending → wait copy; needs_organiser → wait for organiser.
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
  const playUrl = playUrlForStatus(externalPlay);

  if (playUrl) {
    return (
      <p className="mb-4">
        <a
          data-testid="external-play-cta"
          href={playUrl}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink shadow-sm transition hover:opacity-90"
        >
          {msg("externalPlay.playOnLichess")}
        </a>
      </p>
    );
  }

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
    const delay = externalPlay.lastError === "delay_unsupported";
    return (
      <p
        data-testid="external-play-needs-organiser"
        className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
      >
        {msg(delay ? "externalPlay.reason.delayUnsupported" : "externalPlay.needsOrganiser")}
      </p>
    );
  }

  return null;
}
