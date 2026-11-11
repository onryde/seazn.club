// Division standings share card (v3/10 #1): the top of the table as a
// branded mini-scoreboard. Youth rule (v3/11 gap 8): individual/pair youth
// divisions never print player names — the model decides, this renders.
import { ImageResponse } from "next/og";
import { sql } from "@/lib/db";
import { getPublicDivision } from "@/server/public-site/data";
import { CHAMPION_NAME_WIDTH, standingsCardModel } from "@/server/og/model";
import { CardFrame, OG_SIZE } from "@/server/og/card";
import { posterImageDataUrl } from "@/server/og/poster-image";
import { BRACKET_KINDS, decisiveStageOf, divisionTitle } from "@/server/public-site/champion";
import type { StandingsSnapshotRow } from "@/server/public-site/data";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 300;

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
};

export default async function Image({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  // The ORG's language, like the page this card previews. With no division
  // there is no org either, so English is the only locale there is.
  const dict = await getDictionary(toLocale(data?.org.default_locale), "public");

  // Youth flag lives outside the public views on purpose — read it directly.
  const [priv] = data
    ? await sql<{ youth: boolean }[]>`select youth from divisions where id = ${data.division.id}`
    : [];

  // ST-G26 (W4 app A Task 23): the first TABLE snapshot, in the read's stage-then-pool order. A bracket's snapshot is
  // the placement table it writes on completion (rank only, every count zero) — never a table to show.
  // Owner ruling (OG pick A, R24 item 6; B6b fix round 1): a division whose FINAL stage is a bracket — bracket-only, or
  // a group/league feeding it — names its champion instead, once that bracket is complete: its final decided
  // (`divisionTitle`, the moment the division page's banner crowns). Until then a division with a table keeps its
  // table, and a bracket-only one its empty line. A final stage that is a table never crowns here.
  const stages = data?.stages ?? [];
  const isBracket = (stageId: string) => BRACKET_KINDS.has(stages.find((s) => s.id === stageId)?.kind ?? "");
  const table = data?.standings.find((s) => !isBracket(s.stage_id));
  // C16: the DECISIVE stage, off the progression graph — a Plate is stored last but never titles the division.
  const finalStage = decisiveStageOf(stages);
  const title = data && finalStage && BRACKET_KINDS.has(finalStage.kind) ? divisionTitle(data.stages, data.fixtures, data.standings) : null;
  const rows = (table?.rows ?? []) as StandingsSnapshotRow[];
  // W2d T17: the table's own stage's rules — how its points print (RB2B-17).
  const rules = data?.stages.find((s) => s.id === table?.stage_id)?.table_rules ?? null;
  // The crest reaches satori as BYTES. Handed the URL, satori would make the
  // request itself — server-side, on a public route, to whatever host the
  // org's logo points at — and would draw an uploaded `.webp` as an empty box.
  const logo = await posterImageDataUrl(data?.org.logo);
  const model = standingsCardModel({
    orgName: data?.org.name ?? "seazn.club",
    competitionName: data?.competition.name ?? "",
    divisionName: data?.division.name ?? t(dict, "og.division"),
    logo,
    branding: [data?.competition.branding, data?.org.branding],
    youth: priv?.youth ?? false,
    entrantKind: data?.entrants[0]?.kind ?? null,
    rows: rows.map((r) => ({
      rank: r.rank ?? null,
      entrantId: r.entrantId,
      played: r.played,
      points: r.points,
      ...(r.level === true ? { level: true } : {}),
    })),
    names: Object.fromEntries((data?.entrants ?? []).map((e) => [e.id, e.display_name])),
    rules,
    title,
    joinNames: (a, b) => t(dict, "title.jointNames", { a, b }),
  });
  const theme = model.theme;

  return new ImageResponse(
    (
      <CardFrame
        theme={theme}
        orgName={model.orgName}
        logo={model.logo}
        tagline={t(dict, "og.tagline")}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              display: "flex",
              fontSize: 54,
              fontWeight: 800,
              textTransform: "uppercase",
              lineHeight: 1.05,
            }}
          >
            {model.divisionName}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: theme.muted }}>
            {model.competitionName}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            marginTop: 22,
          }}
        >
          {model.champion ? (
            <ChampionLine
              name={model.champion.name}
              size={model.champion.size}
              label={t(dict, model.champion.joint ? "title.joint" : "table.champion")}
              accent={theme.accent}
              muted={theme.muted}
            />
          ) : model.fallbackKey ? (
            <div
              style={{
                display: "flex",
                flexGrow: 1,
                alignItems: "center",
                fontSize: 34,
                color: theme.muted,
              }}
            >
              {t(dict, model.fallbackKey, { brand: "seazn.club" })}
            </div>
          ) : (
            model.rows.map((row, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "9px 0",
                  borderBottom: "1px solid rgba(255,255,255,0.14)",
                  fontSize: 28,
                }}
              >
                <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                  <div
                    style={{
                      display: "flex",
                      width: 44,
                      color: row.leader ? theme.accent : theme.muted,
                      fontWeight: 800,
                    }}
                  >
                    {row.rank}
                  </div>
                  <div style={{ display: "flex", fontWeight: 700 }}>{row.name}</div>
                </div>
                <div style={{ display: "flex", gap: 36, color: theme.muted }}>
                  <div style={{ display: "flex" }}>{`P ${row.played}`}</div>
                  <div style={{ display: "flex", color: theme.ink, fontWeight: 700 }}>
                    {`Pts ${row.points}`}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </CardFrame>
    ),
    size,
  );
}

/**
 * ST-G26 — the champion of a bracket-only division (owner pick, R24 item 6, option A): the name large beside a trophy,
 * the word "Champion" beneath it, aligned with the name. It reads at thumbnail size, where most people see the card (a
 * chat preview is about 240px wide). The trophy is an SVG in the card's accent, so satori needs no emoji font.
 */
function ChampionLine({ name, size, label, accent, muted }: { name: string; size: number; label: string; accent: string; muted: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 30 }}>
        <svg width={120} height={120} viewBox="0 0 64 64" style={{ flexShrink: 0 }}>
          <path d="M20 8h24v14a12 12 0 0 1-24 0z" fill={accent} />
          <path d="M20 12H10v4a10 10 0 0 0 10 10M44 12h10v4a10 10 0 0 1-10 10" fill="none" stroke={accent} strokeWidth={4} />
          <rect x={29} y={34} width={6} height={10} fill={accent} />
          <rect x={20} y={44} width={24} height={6} rx={2} fill={accent} />
        </svg>
        <div
          style={{
            display: "flex",
            maxWidth: CHAMPION_NAME_WIDTH,
            fontSize: size,
            fontWeight: 800,
            lineHeight: 1.04,
            letterSpacing: size >= 96 ? -2 : -1,
          }}
        >
          {name}
        </div>
      </div>
      <div style={{ display: "flex", fontSize: 30, color: muted, margin: "14px 0 0 150px" }}>{label}</div>
    </div>
  );
}
