// Competition hero share card (v3/10 #1): every WhatsApp/iMessage/X preview
// of the dashboard link becomes a branded mini-poster.
import { ImageResponse } from "next/og";
import { getPublicCompetition } from "@/server/public-site/data";
import { ogTheme } from "@/server/og/model";
import { CardFrame, LivePill, OG_SIZE } from "@/server/og/card";
import { posterImageDataUrl } from "@/server/og/poster-image";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, plural, t } from "@/lib/i18n";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 300; // ISR-aligned with the page (gap 15)

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

export default async function Image({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const data = await getPublicCompetition(orgSlug, competitionSlug);
  const theme = ogTheme(data?.competition.branding, data?.org.branding);
  // The ORG's language, like the page this card previews. With no competition
  // there is no org either, so the English default is the only locale there is.
  const locale = toLocale(data?.org.default_locale);
  const dict = await getDictionary(locale, "public");

  // IN UTC, and that is load-bearing. `starts_on`/`ends_on` are pg `date`
  // columns — CALENDAR days, not instants — so `new Date("2026-09-01")` is UTC
  // midnight, and formatting it in any zone behind UTC prints the day before
  // ("31 Aug 2026" in America/New_York). This card is every WhatsApp/iMessage/X
  // preview of the link, so the wrong day here reaches spectators who never
  // open the page. Reasoning in full on matches-hub/info-tab.tsx.
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  const dates = data?.competition.starts_on
    ? `${fmt(data.competition.starts_on)}${
        data.competition.ends_on ? ` – ${fmt(data.competition.ends_on)}` : ""
      }`
    : null;
  const divisions = data?.divisions.length ?? 0;
  const entrants = data?.divisions.reduce((n, d) => n + d.entrant_count, 0) ?? 0;
  const live = data?.liveNow.length ?? 0;

  // The crest reaches satori as BYTES. Handed the URL, satori would make the
  // request itself — server-side, on a public route, to whatever host the
  // org's logo points at — and would draw an uploaded `.webp` as an empty box.
  const logo = await posterImageDataUrl(data?.org.logo);

  return new ImageResponse(
    (
      <CardFrame
        theme={theme}
        orgName={data?.org.name ?? "seazn.club"}
        logo={logo}
        tagline={t(dict, "og.tagline")}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            justifyContent: "center",
            gap: 22,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              textTransform: "uppercase",
            }}
          >
            {data?.competition.name ?? "Competition"}
          </div>
          {dates ? (
            <div style={{ display: "flex", fontSize: 30, color: theme.muted }}>{dates}</div>
          ) : null}
          <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
            {live > 0 ? <LivePill theme={theme} label={plural(dict, "org.live", live, locale)} /> : null}
            <div
              style={{
                display: "flex",
                borderRadius: 999,
                background: "rgba(255,255,255,0.12)",
                padding: "8px 20px",
                fontSize: 22,
              }}
            >
              {plural(dict, "landing.divisions", divisions, locale)}
            </div>
            <div
              style={{
                display: "flex",
                borderRadius: 999,
                background: "rgba(255,255,255,0.12)",
                padding: "8px 20px",
                fontSize: 22,
              }}
            >
              {plural(dict, "landing.entrants", entrants, locale)}
            </div>
          </div>
        </div>
      </CardFrame>
    ),
    size,
  );
}
