"use client";
// Match Day's playing court WITH a live stream (spec 2026-10-31 §6.2 "Playing, stream live"; §8 Phase 1; task A4, controller
// ruling: the preview is A4's). The dark panel is the stream: the "Live on YouTube" badge, the match's own video in the public
// match page's player (`ReplayEmbed`: a click-to-play facade on the video's thumbnail, the privacy-enhanced YouTube player on a
// tap, "Open on YouTube" under it), and the sport's score under the picture.
//
// Under, not over: the player's own terms put nothing on top of the embedded player or its controls (replay-embed.tsx), and a
// composed stream already carries the overlay's scorebug in its picture. The score line is Match Day's own rule (`scoreLine`):
// the sets or games won, tennis's games in the set, and the live points for a set sport, the sport's own headline otherwise — every sport.
//
// Only reached when `streamPreviewOf` found an embeddable video; any other live stream (a pasted key, a made-for-kids broadcast)
// keeps the C1 scoreboard with its corner badge. There is never an empty video box (§5).
import Link from "@/components/ui/console-link";
import { ReplayEmbed } from "@/components/public-site/match-centre/replay-embed";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import { servingSide } from "@/lib/public-site";
import type { MatchDayFixture } from "@/lib/match-day/types";
import { scoreLine } from "@/lib/match-day/view";
import type { PublicReplayPart } from "@/lib/youtube";

export function CourtStreamPreview({
  fixture,
  part,
  label,
  streamHref,
  dict,
  scoreDict,
  readOnly = false,
}: {
  fixture: MatchDayFixture;
  /** The video, from `streamPreviewOf` — already proven embeddable. */
  part: PublicReplayPart;
  /** The preview's accessible name: "Live stream on Court 3", or for a match on no court (B4) "Live stream: Ana v Ben". */
  label: string;
  /** A view-only reader (B4): the stream plays, but "Stream settings" — an organiser's door — is not offered. */
  readOnly?: boolean;
  /** The match's console page with its stream panel open. */
  streamHref: string;
  dict: Dict;
  scoreDict: Dict;
}) {
  const line = scoreLine(fixture);
  // Who serves: the wire's serve reader for a set kernel, else the summary's own (tennis) — the scoreboard's rule.
  const serving =
    fixture.serving ?? (fixture.summary === null ? null : servingSide(fixture.summary));
  const servingName = serving === "home" ? fixture.home : serving === "away" ? fixture.away : null;
  return (
    <section
      data-testid="md-stream-preview"
      aria-label={label}
      className="min-w-0 overflow-hidden rounded-2xl bg-court text-court-ink shadow-lg"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 px-4 pt-3 sm:px-5 sm:pt-4">
        <span data-md-stream="live" className="inline-flex items-center gap-2 py-1 text-sm font-semibold">
          <span aria-hidden className="animate-live-pulse h-2 w-2 rounded-full bg-red-500" />
          {t(dict, "stream.youtube.link.live")}
        </span>
        {!readOnly && (
          <Link
            href={streamHref}
            className="-mr-2 inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-court-muted underline-offset-2 hover:text-court-ink hover:underline lg:min-h-0 lg:py-1"
          >
            {t(dict, "matchDay.stream.settings")}
          </Link>
        )}
      </div>
      <div className="min-w-0 px-4 sm:px-5">
        <ReplayEmbed parts={[part]} labels={{ region: label, playerTitle: label, className: "mt-2" }} />
      </div>
      {line !== null && (
        <div
          data-testid="md-preview-score"
          className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-white/10 px-4 py-3 sm:px-5"
        >
          {line.kind === "sets" ? (
            <>
              <span className="font-display text-3xl font-bold leading-none tabular-nums">{`${line.levels.won[0]} – ${line.levels.won[1]}`}</span>
              {line.levels.mid !== null && (
                <span data-md-score-mid className="font-display text-2xl font-semibold leading-none tabular-nums text-court-ink/75">{`${line.levels.mid[0]}–${line.levels.mid[1]}`}</span>
              )}
              {line.levels.live !== null && (
                <span data-md-score-live className="font-display text-2xl font-semibold leading-none tabular-nums text-court-ink/75">{line.levels.live.label}</span>
              )}
            </>
          ) : (
            <span className="min-w-0 font-display text-2xl font-bold leading-tight tabular-nums [overflow-wrap:anywhere]">{line.text}</span>
          )}
          {servingName !== null && (
            <span data-md-serving className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">
              <span aria-hidden className="mr-1.5 text-amber-300">●</span>
              {`${servingName} `}
              <span className="font-medium text-court-muted">{t(scoreDict, "matchCentre.serving")}</span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}
