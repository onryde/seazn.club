import "server-only";
// The one loader behind BOTH match images — the fixture's OG card and the
// downloadable poster. Written once because the two are the same picture in
// two shapes: a fact that appears on one and not the other would be a defect,
// not a feature.
//
// It reads the SAME `getPublicFixture` the match page itself renders from, so
// the poster cannot disagree with the page it came from — and, just as
// importantly, it inherits that loader's masking. Entrant names go through
// `maskPublicEntrantNames` and player names through the division's
// `player_name_display`/`youth` rules inside `loadMatchCentre`, so a youth
// division's poster is already safe here without this module deciding masking
// a second time. (The old fixture OG card ran its own `select youth from
// divisions` and applied its own rule; one authority is better than two.)
import { sql } from "@/lib/db";
import { getPublicFixture } from "@/server/public-site/data";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { matchPosterModel, type MatchPosterModel } from "./match-poster";
import type { MsgT } from "@/server/public-site/match-centre-schema";

export async function loadMatchPosterModel(
  orgSlug: string,
  competitionSlug: string,
  divisionSlug: string,
  fixtureId: string,
): Promise<MatchPosterModel | null> {
  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) return null;
  const { org, competition, division, fixture, matchCentre } = data;

  // The board's hero line on an upcoming poster is the STAGE ("League match",
  // "Quarter-final"), which `getPublicFixture` reads but does not return.
  // One indexed lookup inside an already-revalidated image route.
  const [stageRow] = fixture.stage_id
    ? await sql<{ name: string }[]>`select name from stages where id = ${fixture.stage_id}`
    : [];

  const locale = toLocale(org.default_locale);
  // `public` carries the match-centre copy the header's own Msgs name; `ui`
  // carries `schedule.vs`, the same word the page's <h1> renders between the
  // two names.
  const [pub, ui] = await Promise.all([getDictionary(locale, "public"), getDictionary(locale, "ui")]);
  const say = (m: MsgT | null): string | null => (m === null ? null : t(pub, m.key, m.params));

  return matchPosterModel({
    branding: [competition.branding, org.branding],
    orgName: org.name,
    logo: org.logo,
    competitionName: competition.name,
    divisionName: division.name,
    stageName: stageRow?.name ?? null,
    header: matchCentre.header,
    topPerformers: matchCentre.cricket?.topPerformers ?? null,
    copy: {
      statusLine: say(matchCentre.header.statusLine),
      pillNote: say(matchCentre.header.pillNote),
      live: t(pub, "matchCentre.status.live"),
      result: t(pub, "news.kind.result"),
      vs: t(ui, "schedule.vs"),
      topBatter: t(pub, "matchCentre.topBatter"),
      topBowler: t(pub, "matchCentre.topBowler"),
      poweredBy: t(pub, "layout.poweredBy", { brand: "seazn" }),
    },
  });
}
