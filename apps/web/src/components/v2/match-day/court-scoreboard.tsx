"use client";
// Match Day's playing court (spec 2026-10-31 §6.2, task A3). The dark panel at the top of a playing court IS the sport's
// scoreboard: the public match page's own `LiveScoreBody`, fed the engine's whole folded summary and both sides' names, so a
// set sport shows games in large type with the set table and who serves, a football pitch its goals and periods, cricket its
// innings — never a badminton widget (§5). Its corner carries the match's stream: the Live badge and a link to watch while one
// is live, "+ Connect a stream" while none is up (owner pick C1: no empty black video box, ever). Both links open the match's
// console page with its stream panel open — the existing per-match stream flow (§8 Phase 1).
//
// "Live" on this page means a STREAM is live (the list's red badge, the corner link). The panel's own status line says the
// match is in play, in the public dictionary's own words for that status (review V1).
import Link from "@/components/ui/console-link";
import { LiveScoreBody } from "@/components/public-site/live-score";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { MatchDayFixture } from "@/lib/match-day/types";

/** `LiveScoreBody` prints a decided outcome's sentence from these; a playing court's match has no outcome (it is passed
 *  `outcome: null`), so no template is ever read. */
const NO_OUTCOME: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };

export function CourtScoreboard({
  fixture,
  courtName,
  streamHref,
  dict,
  scoreDict,
}: {
  fixture: MatchDayFixture;
  courtName: string;
  /** The match's console page with its stream panel open. */
  streamHref: string;
  dict: Dict;
  /** The `public` dictionary's scoreboard words (`matchCentre.*`, `forfeit.*`), in the reader's language. */
  scoreDict: Dict;
}) {
  // LiveScoreBody prints `matchCentre.status.live` over an in-play match; here that word belongs to streams.
  const panelDict: Dict = { ...scoreDict, "matchCentre.status.live": t(scoreDict, "matchCentre.status.in_play") };
  const entrantNames: Record<string, string> = {};
  if (fixture.home_entrant_id !== null && fixture.home !== null) entrantNames[fixture.home_entrant_id] = fixture.home;
  if (fixture.away_entrant_id !== null && fixture.away !== null) entrantNames[fixture.away_entrant_id] = fixture.away;
  const stream =
    fixture.stream === "live" ? (
      <Link
        href={streamHref}
        className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-medium ring-1 ring-inset ring-red-100 hover:bg-red-50 md:min-h-0 md:bg-white/10 md:py-1 md:ring-0 md:hover:bg-white/15"
      >
        <span data-md-stream="live" className="inline-flex items-center gap-1.5 font-semibold text-red-700 md:text-court-ink">
          <span aria-hidden className="h-2 w-2 rounded-full bg-red-500" />
          {t(dict, "matchDay.stream.live")}
        </span>
        <span className="text-slate-600 md:text-court-muted">{t(dict, "matchDay.stream.watch")}</span>
      </Link>
    ) : fixture.stream === "waiting" ? (
      <Link
        href={streamHref}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 md:min-h-0 md:bg-white/10 md:py-1 md:text-court-ink md:ring-0 md:hover:bg-white/15"
      >
        <span aria-hidden className="h-2 w-2 rounded-full bg-amber-400" />
        {t(dict, "matchDay.stream.waiting")}
      </Link>
    ) : (
      <Link
        href={streamHref}
        className="inline-flex min-h-11 items-center rounded-full px-2 text-xs font-medium text-purple-700 underline-offset-2 hover:underline md:min-h-0 md:py-1 md:text-court-muted md:hover:text-court-ink"
      >
        {t(dict, "matchDay.stream.connect")}
      </Link>
    );
  return (
    <section
      data-testid="md-scoreboard"
      aria-label={t(dict, "matchDay.focus.scoreboard", { court: courtName })}
      // Phones: the headline steps down one size (LiveScoreBody sets it at text-5xl for a full-width match page; a 320 column
      // broke "1 – 0 (14-9)" at its hyphen), and the stream link sits above the panel, where a 44 px target cannot cover the
      // score. From md it is the panel's corner.
      className="relative flex flex-col max-md:[&_.text-5xl]:text-4xl"
    >
      <div className="mb-2 flex justify-end md:absolute md:right-5 md:top-5 md:z-10 md:mb-0 md:max-w-[60%]">{stream}</div>
      {fixture.summary === null || !fixture.summary.headline ? (
        // Started, but its engine has published no scoreline yet. `LiveScoreBody` would print "Not started" under its own
        // status line for a summary with no headline — a contradiction on a court that is playing — so this says what is true.
        <div className="rounded-2xl bg-court p-5 text-court-ink shadow-lg sm:p-6">
          <p className="mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-300">
            <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-400" />
            {t(scoreDict, "matchCentre.status.in_play")}
          </p>
          <p className="font-display text-2xl font-semibold">{t(dict, "matchDay.focus.noScore")}</p>
        </div>
      ) : (
        <LiveScoreBody
          data={{ status: "in_play", summary: fixture.summary, outcome: null }}
          entrantNames={entrantNames}
          sportKey={fixture.sport_key}
          decidedTemplates={NO_OUTCOME}
          dict={panelDict}
        />
      )}
    </section>
  );
}
