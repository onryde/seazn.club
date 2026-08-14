// Fixture share card (v3/10 #1): matchup + score headline — "share the
// result to the group chat" becomes a scoreboard, not a bare link.
import { ImageResponse } from "next/og";
import { sql } from "@/lib/db";
import { getPublicDivision } from "@/server/public-site/data";
import { fixtureCardModel } from "@/server/og/model";
import { CardFrame, LivePill, OG_SIZE } from "@/server/og/card";
import { resolveSlotLabel } from "@/lib/slot-label";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 60; // fixtures move faster than tables

type Props = {
  params: Promise<{
    orgSlug: string;
    competitionSlug: string;
    divisionSlug: string;
    fixtureId: string;
  }>;
};

export default async function Image({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug, fixtureId } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  const fixture = data?.fixtures.find((f) => f.id === fixtureId) ?? null;
  const [priv] = data
    ? await sql<{ youth: boolean }[]>`select youth from divisions where id = ${data.division.id}`
    : [];

  const names = Object.fromEntries((data?.entrants ?? []).map((e) => [e.id, e.display_name]));
  const summary = (fixture?.summary ?? null) as { headline?: string } | null;
  // P6 fix round 1, finding #2 (CRITICAL) — org.default_locale, same
  // pattern as data.ts:502-503; also threaded into fixtureCardModel's own
  // `lookup` for the residual "fixture not found at all" fallback.
  const orgLocale = toLocale(data?.org.default_locale);
  const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) =>
    msgFor(orgLocale, k, v);
  const model = fixtureCardModel({
    orgName: data?.org.name ?? "seazn.club",
    competitionName: data?.competition.name ?? "",
    divisionName: data?.division.name ?? "Match",
    logo: data?.org.logo ?? null,
    branding: [data?.competition.branding, data?.org.branding],
    youth: priv?.youth ?? false,
    entrantKind: data?.entrants[0]?.kind ?? null,
    homeName: fixture?.home_entrant_id
      ? (names[fixture.home_entrant_id] ?? null)
      : fixture
        ? resolveSlotLabel(fixture.home_slot_label, lookup, "schedule.tbd")
        : null,
    awayName: fixture?.away_entrant_id
      ? (names[fixture.away_entrant_id] ?? null)
      : fixture
        ? resolveSlotLabel(fixture.away_slot_label, lookup, "schedule.tbd")
        : null,
    headline: summary?.headline ?? null,
    fixtureStatus: fixture?.status ?? "scheduled",
    lookup,
  });
  const theme = model.theme;

  return new ImageResponse(
    (
      <CardFrame theme={theme} orgName={model.orgName} logo={model.logo}>
        <div style={{ display: "flex", fontSize: 24, color: theme.muted }}>
          {`${model.divisionName} · ${model.competitionName}`}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            justifyContent: "center",
            gap: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 56,
              fontWeight: 800,
              textTransform: "uppercase",
              lineHeight: 1.1,
            }}
          >
            {model.home}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <div
              style={{
                display: "flex",
                width: 54,
                height: 4,
                background: theme.accent,
              }}
            />
            <div style={{ display: "flex", fontSize: 26, color: theme.muted, letterSpacing: 4 }}>
              VS
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 56,
              fontWeight: 800,
              textTransform: "uppercase",
              lineHeight: 1.1,
            }}
          >
            {model.away}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 14 }}>
          {model.status === "live" ? <LivePill theme={theme} label="Live now" /> : null}
          {model.headline ? (
            <div
              style={{
                display: "flex",
                fontSize: 40,
                fontWeight: 800,
                color: theme.accent,
              }}
            >
              {model.headline}
            </div>
          ) : null}
        </div>
      </CardFrame>
    ),
    size,
  );
}
