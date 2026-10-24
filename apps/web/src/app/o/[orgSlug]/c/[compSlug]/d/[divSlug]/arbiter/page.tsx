export const dynamic = "force-dynamic";
// T15 — the arbiter panel (chess design §5.3): the organiser watches the
// division's open round, one board at a time, receive-only. Organisers only
// (a viewer gets a 404, as a page that does not exist for them), and only a
// division that plays online. The round is read here; the video token is NOT
// — the panel's own browser asks for it after mount (spec §10), so the HTML
// carries nothing a copied page could join a meeting with. The org layout
// already provides the `ui` dictionary.
//
// Phase 2 (spec 2026-10-24-arbiter-round-column-design.md §7): the panel also
// follows the online-chess flag - a club not offered online chess gets the
// same 404 - and the page reads everything the round column paints (the open
// rounds, the held and flagged boards, the venue zone, whether the division
// has started) in ONE Promise.all beside the round.
import { notFound } from "next/navigation";
import { divisionScoringClosed } from "@/lib/division-phase";
import { requireDivisionPage } from "@/server/page-auth";
import { getDivision } from "@/server/usecases/divisions";
import {
  arbiterRequestedRound,
  listFlaggedExternalPlay,
  listNeedsOrganiserExternalPlay,
  listOpenRounds,
  loadArbiterRound,
} from "@/server/usecases/external-play";
import { arbiterPanelOffered } from "@/server/arbiter-panel-offered";
import { getScheduleSettings } from "@/server/usecases/schedule";
import { ArbiterPanel } from "@/components/v2/arbiter-panel";

export default async function DivisionArbiterPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string }>;
  searchParams: Promise<{ fixture?: string | string[] }>;
}) {
  const [{ orgSlug, compSlug, divSlug }, { fixture }] = await Promise.all([params, searchParams]);
  const page = await requireDivisionPage(orgSlug, compSlug, divSlug, { tail: "/arbiter" });
  // A viewer does not even load the division: this first `canEdit` only saves the read, the predicate below owns the rule.
  if (!page.canEdit) notFound();
  const division = await getDivision(page.auth, page.division.id);
  // Spec §7: the panel's one door, shared with the division page's Fixtures tab (`arbiterPanelOffered`): the viewer can edit, the
  // division plays online (a chess division set to Lichess), then the PostHog flag `online-chess`, asked last - so it is never
  // asked for a viewer, a non-chess division or one that does not play online - and answered the way every other refusal is.
  if (!(await arbiterPanelOffered(page.auth, { canEdit: page.canEdit, sport_key: division.sport_key, config: division.config }))) notFound();
  const divisionId = page.division.id;
  // I3: `?fixture=` opens exactly that board — in its own round, an earlier
  // one included — or the panel says it is not here. No round is loaded for
  // a board that is not here, so no other board can be opened in its place.
  const fixtureId = typeof fixture === "string" ? fixture : null;
  const readRound = async () => {
    const asked = fixtureId === null ? null : await arbiterRequestedRound(page.auth, divisionId, fixtureId);
    const requested = asked === null || asked.kind === "round" ? null : asked.kind;
    const round =
      requested !== null
        ? null
        : await loadArbiterRound(page.auth, divisionId, asked?.kind === "round" ? { round: { stageId: asked.stageId, roundNo: asked.roundNo } } : {});
    return { requested, round };
  };
  // The round and the column's four reads are independent, so they start together. The column's reads run whatever the board
  // asked for said ("unavailable" included): what a notice shows is the panel's decision, not the page's.
  const [{ requested, round }, views, held, flagged, schedule] = await Promise.all([
    readRound(),
    listOpenRounds(page.auth, divisionId),
    listNeedsOrganiserExternalPlay(page.auth, divisionId),
    listFlaggedExternalPlay(page.auth, divisionId),
    getScheduleSettings(page.auth, divisionId),
  ]);
  return (
    <ArbiterPanel
      round={round}
      requested={requested}
      slugs={{ org: orgSlug, comp: compSlug, div: divSlug }}
      initialFixtureId={fixtureId}
      column={{
        views,
        held,
        flagged: flagged.boards,
        ownFlagged: flagged.ownBoards,
        // The venue zone: the division page hands its stage cards the same `scheduleSettings.tz`.
        tz: schedule.tz,
        // The division page's own reader for "start the division first" (`onlineAwaitsStart` in the division's own page.tsx): the shared
        // not-started predicate. `listOpenRounds` answers [] before the start, so "nothing paired" would also be true; the
        // column lets this win.
        awaitsStart: divisionScoringClosed(division.status),
      }}
    />
  );
}
