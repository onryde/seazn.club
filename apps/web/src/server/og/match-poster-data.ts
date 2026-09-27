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
import { getPublicFixture } from "@/server/public-site/data";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale } from "@/lib/i18n-constants";
import { servingSide } from "@/lib/public-site";
import { matchPosterModel, type MatchPosterModel } from "./match-poster";
import { posterImageDataUrl } from "./poster-image";
import type { MatchCentreDocT, MsgT } from "@/server/public-site/match-centre-schema";

/**
 * "6–4 3–6 · 2–1" — the set-by-set score, for the poster's foot.
 *
 * SETS ONLY. `SetsView` also serves period sports, and an unlabelled
 * "1–0 · 1–1" for a football match could be halves or anything else; a set
 * score is notation every spectator already reads. Columns nobody has played
 * are dropped rather than printed as "–", so a best-of-five that is one set in
 * says "6–4" and not "6–4 · – · – · – · –".
 *
 * The en dash is this repo's house style for a score pair (`shootoutScoreFromDetail`,
 * `resultMsg`), so one match cannot read two ways on two surfaces.
 */
function setLineOf(sets: MatchCentreDocT["sets"]): string | null {
  if (sets === null || sets.kind !== "sets") return null;
  const [home, away] = sets.rows;
  const pairs = sets.columns
    .map((_, i) => {
      const h = home[i];
      const a = away[i];
      return h == null && a == null ? null : `${h ?? "–"}–${a ?? "–"}`;
    })
    .filter((pair): pair is string => pair !== null);
  return pairs.length === 0 ? null : pairs.join(" · ");
}

export async function loadMatchPosterModel(
  orgSlug: string,
  competitionSlug: string,
  divisionSlug: string,
  fixtureId: string,
): Promise<MatchPosterModel | null> {
  const data = await getPublicFixture(orgSlug, competitionSlug, divisionSlug, fixtureId);
  if (!data) return null;
  // `stageName` is the board's hero line on an upcoming poster ("League
  // match", "Quarter-final") — the page's own read of `stages.name`, not a
  // second one here (T4). It follows the page's cache, as every other line on
  // the poster does.
  const { org, competition, division, fixture, matchCentre, stageName } = data;
  const header = matchCentre.header;

  // Which side is DOING something. Cricket's answer is on the header; a racket
  // sport's is `serving` in the kernel summary, read through the SAME shared
  // reader `timeline.ts` uses for hold-or-break rather than a second parse of
  // `summary.detail` here. A period sport has neither and stays null — nothing
  // tracks possession, and guessing "whoever is ahead" would be editorial.
  const serving = servingSide(fixture.summary);
  const activeIndex: 0 | 1 | null =
    header.battingIndex ?? (serving === "home" ? 0 : serving === "away" ? 1 : null);

  const locale = toLocale(org.default_locale);
  // `public` carries the match-centre copy the header's own Msgs name; `ui`
  // carries `schedule.vs`, the same word the page's <h1> renders between the
  // two names.
  const [pub, ui] = await Promise.all([getDictionary(locale, "public"), getDictionary(locale, "ui")]);
  const say = (m: MsgT | null): string | null => (m === null ? null : t(pub, m.key, m.params));

  // Every remote image the two match surfaces draw is fetched HERE, through
  // the one guarded fetcher, and reaches satori as bytes. Left as URLs, satori
  // would make these requests itself — server-side, on a public route, to
  // whatever host an organiser typed into `entrants.badge_url`. In parallel
  // because each is independently bounded by its own timeout, so three of them
  // cost one; `posterImageDataUrl` never rejects, so no failure here can take
  // the image down.
  const [logo, homeBadge, awayBadge] = await Promise.all([
    posterImageDataUrl(org.logo),
    posterImageDataUrl(header.sides[0].badgeUrl),
    posterImageDataUrl(header.sides[1].badgeUrl),
  ]);

  return matchPosterModel({
    branding: [competition.branding, org.branding],
    orgName: org.name,
    logo,
    badges: [homeBadge, awayBadge],
    competitionName: competition.name,
    divisionName: division.name,
    stageName: stageName ?? null,
    header,
    activeIndex,
    setLine: setLineOf(matchCentre.sets),
    topPerformers: matchCentre.cricket?.topPerformers ?? null,
    copy: {
      statusLine: say(header.statusLine),
      pillNote: say(header.pillNote),
      live: t(pub, "matchCentre.status.live"),
      result: t(pub, "news.kind.result"),
      vs: t(ui, "schedule.vs"),
      topBatter: t(pub, "matchCentre.topBatter"),
      topBowler: t(pub, "matchCentre.topBowler"),
      poweredBy: t(pub, "layout.poweredBy", { brand: "seazn" }),
    },
  });
}
