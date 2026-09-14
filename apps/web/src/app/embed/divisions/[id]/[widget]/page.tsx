// Embeddable widgets (v3/10 #4): /embed/divisions/<id>/{standings|schedule|
// bracket} — read-only, minimal chrome, honours visibility (embed-data),
// keeps itself fresh via ISR. Clubs paste the snippet from the division
// console; the iframe never needs touching again.
import { notFound } from "next/navigation";
import { resolveModule } from "@/server/engine-db";
import { embedDivisionData } from "@/server/embed-data";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { publicThemeStyle } from "@/lib/public-theme";
import type { MetricSpecLike } from "@/lib/public-site";
import { StandingsTable } from "@/components/public-site/standings-table";
import { Schedule } from "@/components/public-site/schedule";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { Bracket } from "@/components/public-site/bracket";
import type { StandingsRow } from "@seazn/engine/competition";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { publicRoundNamer } from "@/server/public-site/feeder-slot-label";

export const revalidate = 30;

// ISR (task-8): same fix as the /shared tree — empty-array generateStaticParams
// is required for on-demand ISR on a dynamic segment in this Next version
// (docs: api-reference/functions/generate-static-params.md).
export async function generateStaticParams() {
  return [];
}

const WIDGETS = new Set(["standings", "schedule", "bracket"]);
const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder", "page_playoff"]);

type Props = { params: Promise<{ id: string; widget: string }> };

export default async function EmbedWidgetPage({ params }: Props) {
  const { id, widget } = await params;
  if (!WIDGETS.has(widget)) notFound();
  const resolved = await embedDivisionData(id);
  // Both failure modes 404: a stranger's iframe is no place for a paywall.
  if (!resolved.ok) notFound();
  const { org, competition, division, stages, pools, fixtures, standings, entrants, tz } =
    resolved.data;

  // Item 0: this event has existed since the PLG loops shipped and has never
  // been fired. No user is in scope on an embed, so the org carries the
  // identity, per CaptureArgs' own note on synthetic ids. This route is
  // ISR-cached (revalidate=30 above) — the capture fires on RENDER, not per
  // viewer request, so it counts cache fills, not loads. A consented-traffic
  // count of renders, never a total (captureServer no-ops without a PostHog
  // key, and is consent-gated).
  await captureServer({
    event: EVENTS.EMBED_RENDERED,
    distinctId: `org:${org.id}`,
    orgId: org.id,
    properties: { widget, divisionId: division.id, competitionId: competition.id },
  });

  let metricSpecs: MetricSpecLike[] = [];
  let cascade: readonly string[] = [];
  try {
    const module_ = resolveModule(division.sport_key, division.module_version);
    metricSpecs = module_.metrics;
    cascade = division.tiebreakers ?? module_.defaultTiebreakers;
  } catch {
    // retired module build — structural columns only
  }
  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  // PROMPT-60: the entrant's own badge_url wins over the team logo.
  const entrantLogos = Object.fromEntries(
    entrants.map((e) => [
      e.id,
      resolveEntrantBadge({
        badge_url: e.badge_url,
        team_logo_path: e.team_display?.logo_path ?? null,
      }),
    ]),
  );
  const poolName = new Map(pools.map((p) => [p.id, p.name]));
  const publicPath = `/shared/${org.slug}/${competition.slug}/${division.slug}`;

  // P6 fix round 1, finding #2 (CRITICAL) — same treatment as the public
  // division page: the org's own default_locale, never resolveLocale()
  // (no per-viewer request scope; every embed viewer sees the same iframe).
  const orgLocale = toLocale(org.default_locale);
  const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) =>
    msgFor(orgLocale, k, v);
  // N1 fix round 1, M8: a side still waiting on a match names that match's
  // round as the public hub's rail does ("Winner of Semi-finals, match 1"),
  // through the same namer the hub, the match centre and the calendar use; any
  // other label keeps the board's text (`resolveSlotLabel`, inside the namer).
  const stageKind = new Map(stages.map((s) => [s.id, s.kind]));
  const dict = await getDictionary(orgLocale, "public");
  const namer = publicRoundNamer({
    ui: lookup,
    dict,
    fixtures,
    stageKind: (stageId) => stageKind.get(stageId),
  });
  const slotLabels: Record<string, string> = {};
  for (const f of fixtures) {
    if (!f.home_entrant_id) slotLabels[`${f.id}:home`] = namer.slot(f.stage_id, f.home_slot_label);
    if (!f.away_entrant_id) slotLabels[`${f.id}:away`] = namer.slot(f.stage_id, f.away_slot_label);
  }
  // N1d d5: the schedule's round view heads each group with the round's NAME,
  // the hub rail's own label ("Round {n}" in the org's locale only for a
  // fixture whose stage the namer does not know). N1e e5: every other word it
  // shows or announces comes from the same org-locale dictionaries, and its
  // dates are written in the org's locale.
  const roundLabels = Object.fromEntries(
    fixtures.map((f) => [f.id, namer.roundLabel(f.id) ?? lookup("schedule.round", { n: f.round_no })]),
  );
  const scheduleCopy = publicScheduleCopy(dict, lookup);
  // N1e e1: round_no restarts in every stage, so the round view orders its
  // groups by each stage's seq first.
  const stageOrder = Object.fromEntries(stages.map((s) => [s.id, s.seq]));

  let body: React.ReactNode;
  if (widget === "schedule") {
    body = (
      <Schedule
        fixtures={fixtures}
        entrantNames={entrantNames}
        divisionPath={publicPath}
        tz={tz}
        slotLabels={slotLabels}
        roundLabels={roundLabels}
        stageOrder={stageOrder}
        copy={scheduleCopy}
        locale={orgLocale}
      />
    );
  } else if (widget === "bracket") {
    const stage = stages.find((s) => BRACKET_KINDS.has(s.kind));
    body = stage ? (
      <Bracket
        kind={stage.kind as "knockout" | "double_elim" | "stepladder" | "page_playoff"}
        fixtures={fixtures.filter((f) => f.stage_id === stage.id)}
        entrantNames={entrantNames}
        entrantLogos={entrantLogos}
        fixtureHref={(fixtureId) => `${publicPath}/fixtures/${fixtureId}`}
        lookup={lookup}
        slotText={namer.slot}
      />
    ) : (
      <p className="p-2 text-sm text-zinc-500">No bracket stage in this division.</p>
    );
  } else {
    body = (
      <div className="space-y-5">
        {stages.map((stage) => {
          const snaps = standings.filter((s) => s.stage_id === stage.id);
          if (snaps.length === 0) return null;
          return snaps.map((snap) => (
            <StandingsTable
              key={`${stage.id}-${snap.pool_id ?? "overall"}`}
              rows={snap.rows as StandingsRow[]}
              metricSpecs={metricSpecs}
              cascade={cascade}
              entrantNames={entrantNames}
              entrantLogos={entrantLogos}
              caption={
                snap.pool_id
                  ? `${stage.name} — ${poolName.get(snap.pool_id) ?? "Pool"}`
                  : stage.name
              }
            />
          ));
        })}
      </div>
    );
  }

  return <div style={publicThemeStyle(competition.branding)}>{body}</div>;
}
