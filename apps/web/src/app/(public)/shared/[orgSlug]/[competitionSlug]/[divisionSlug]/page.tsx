// Division home (doc 09 §2): Schedule / Standings / Entrants tabs. Standings
// columns are driven by the pinned SportModule's MetricSpec[] — zero
// per-sport table components. Knockout stages render brackets; stepladder a
// ladder. Roster names are consent-filtered in the view (initials otherwise).
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { resolveModule } from "@/server/engine-db";
import type { StandingsRow } from "@seazn/engine/competition";
import { getPublicDivision } from "@/server/public-site/data";
import { BRACKET_KINDS, divisionChampion } from "@/server/public-site/champion";
import { resolveEntrantBadge } from "@/lib/entrant-badge";
import { sharedRenameTarget } from "@/server/slug-resolve";
import { publicThemeStyle } from "@/lib/public-theme";
import { renderProse } from "@/lib/prose";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { ShareButton } from "@/components/share-button";
import { Tabs } from "@/components/public-site/tabs";
import { Schedule } from "@/components/public-site/schedule";
import { StandingsTable } from "@/components/public-site/standings-table";
import { Bracket } from "@/components/public-site/bracket";
import { ResultsMatrix } from "@/components/public-site/results-matrix";
import { SuspensionsStrip } from "@/components/public-site/suspensions-strip";
import { publicSuspensions } from "@/server/usecases/discipline";
import type { MetricSpecLike } from "@/lib/public-site";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { publicRoundNamer } from "@/server/public-site/feeder-slot-label";

export const revalidate = 30;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) return {};
  return {
    title: `${data.division.name} — ${data.competition.name}`,
    description: `Schedule, standings and entrants for ${data.division.name} at ${data.competition.name}`,
    ...(data.competition.visibility === "unlisted"
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}

export default async function DivisionHomePage({ params }: Props) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) {
    const renamed = await sharedRenameTarget(orgSlug, competitionSlug, divisionSlug);
    if (renamed) permanentRedirect(renamed);
    notFound();
  }
  const { org, competition, division, stages, pools, fixtures, standings, entrants, tz } = data;

  // MetricSpec[] + cascade from the division's PINNED module version.
  let metricSpecs: MetricSpecLike[] = [];
  let cascade: readonly string[] = [];
  try {
    const module_ = resolveModule(division.sport_key, division.module_version);
    metricSpecs = module_.metrics;
    cascade = division.tiebreakers ?? module_.defaultTiebreakers;
  } catch {
    // Unknown module version (e.g. retired build) — structural columns only.
  }

  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  // Badge chips (v3/03 §5 + PROMPT-60): the entrant's own badge_url wins,
  // then team → club logo resolved by the view.
  const entrantLogos = Object.fromEntries(
    entrants.map((e) => [
      e.id,
      resolveEntrantBadge({
        badge_url: e.badge_url,
        team_logo_path: e.team_display?.logo_path ?? null,
      }),
    ]),
  );
  const basePath = `/shared/${org.slug}/${competition.slug}/${division.slug}`;
  const poolName = new Map(pools.map((p) => [p.id, p.name]));
  const stageById = new Map(stages.map((s) => [s.id, s]));

  // P6 fix round 1, finding #2 (CRITICAL): slot-label copy for a spectator
  // — the org's own default_locale (v5 i18n §4), same pattern as
  // data.ts:502-503. Deliberately NOT resolveLocale(): this route has no
  // request-scoped cookies()/headers() call to make and every visitor sees
  // the SAME page regardless of who they are.
  const orgLocale = toLocale(org.default_locale);
  // Same org-locale rule as `lookup` below, and for the same reason: this page
  // is ISR, so the dictionary is chosen by the ORG, never by the visitor's
  // Accept-Language — a per-visitor choice would need a request-scoped read and
  // would make every cached copy wrong for somebody.
  const dict = await getDictionary(orgLocale, "public");
  const lookup = (k: Parameters<typeof msgFor>[1], v?: Record<string, string | number>) =>
    msgFor(orgLocale, k, v);
  // R10d n4: the Bracket names a side still waiting on a match through the
  // public round namer ("Winner of Semi-finals, match 1"), as the hub, the
  // match centre and the embed widgets do.
  const namer = publicRoundNamer({
    ui: lookup,
    dict,
    fixtures,
    stageKind: (stageId) => stageById.get(stageId)?.kind,
  });
  // <Schedule> is a Client Component — it cannot call msgFor() itself
  // (server-only), so every unfilled slot's text is pre-resolved HERE and
  // handed down as a plain Record<string,string>, same shape as
  // `entrantNames` above. N1c c5: through the SAME namer as the Bracket, so the
  // schedule tab and the bracket name one waiting side with one text.
  const slotLabels: Record<string, string> = {};
  for (const f of fixtures) {
    if (!f.home_entrant_id) slotLabels[`${f.id}:home`] = namer.slot(f.stage_id, f.home_slot_label);
    if (!f.away_entrant_id) slotLabels[`${f.id}:away`] = namer.slot(f.stage_id, f.away_slot_label);
  }
  // N1d d5: the schedule tab's round view heads each group with the round's
  // NAME from the same namer ("Round {n}" in the org's locale only for a
  // fixture whose stage the namer does not know), and its two phrases come
  // from the page's org-locale dictionary, as the embed schedule widget does.
  const roundLabels = Object.fromEntries(
    fixtures.map((f) => [f.id, namer.roundLabel(f.id) ?? lookup("schedule.round", { n: f.round_no })]),
  );
  const scheduleCopy = {
    timeTbd: t(dict, "matchCentre.status.timeTbd"),
    allEntrants: t(dict, "division.filter.allEntrants"),
  };
  // N1e e1: round_no restarts in every stage, so the round view orders its
  // groups by each stage's seq first, as the embed schedule widget does.
  const stageOrder = Object.fromEntries(stages.map((s) => [s.id, s.seq]));

  // SPEC-1: active suspensions under the standings (consent-gated names). Public
  // read; a published ban is public information. Never throws the page down.
  const suspensions = await publicSuspensions(orgSlug, competitionSlug, divisionSlug).catch(() => []);

  // Live stage first: the knockout that's underway reads before the finished
  // league table it qualified from.
  const stagesByRelevance = [...stages].sort(
    (a, b) =>
      (a.status === "complete" ? 1 : 0) - (b.status === "complete" ? 1 : 0) || a.seq - b.seq,
  );

  // Champion (v1 parity): crown the winner above the table. A bracket is
  // crowned by `bracketChampion` (`server/public-site/champion.ts`) — its final,
  // settled with a winner, on the engine's rule: a forfeit counts, and an
  // unplayed bronze match does not hold the crown back. A league/group crowns
  // rank 1 of the final overall standings once its decisive stage is done.
  //
  // Both rules live in that file — the competition hub crowns the same entrant
  // on every table and in its knockout view, and two copies would be two
  // crowns that agree only until one of them moves.
  const championId: string | null = divisionChampion(stages, fixtures, standings);

  // Rendered at the very top of the division page (above the tabs) so the
  // winner is visible on Schedule/Standings/Entrants alike — v1 parity.
  // Gold is fixed podium vocabulary, deliberately outside the org theme.
  const championBanner = championId ? (
    <div className="relative mb-6 overflow-hidden rounded-xl bg-court p-4 text-court-ink shadow-md">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-amber-400" />
      <div className="flex items-center gap-4 pl-2">
        <span className="animate-trophy text-4xl" aria-hidden>🏆</span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">
            Champion
          </p>
          <p className="truncate font-display text-3xl font-bold uppercase leading-tight tracking-tight">
            {entrantNames[championId] ?? "—"}
          </p>
        </div>
      </div>
    </div>
  ) : null;

  const standingsPanel = (
    <div className="space-y-8">
      {stagesByRelevance.map((stage) => {
        if (BRACKET_KINDS.has(stage.kind)) {
          const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
          if (stageFixtures.length === 0) return null;
          return (
            <section key={stage.id}>
              <h3 className="mb-3 font-display text-lg font-semibold text-ink">{stage.name}</h3>
              <Bracket
                kind={stage.kind as "knockout" | "double_elim" | "stepladder" | "page_playoff"}
                fixtures={stageFixtures}
                entrantNames={entrantNames}
                entrantLogos={entrantLogos}
                fixtureHref={(id) => `${basePath}/fixtures/${id}`}
                lookup={lookup}
                slotText={namer.slot}
              />
            </section>
          );
        }
        const snapshots = standings
          .filter((s) => s.stage_id === stage.id)
          .sort((a, b) => (a.pool_id ?? "").localeCompare(b.pool_id ?? ""));
        if (snapshots.length === 0) return null;
        return (
          <section key={stage.id}>
            {snapshots.map((snap) => {
              // G2 — crosstable under each round-robin table, in rank order.
              const ranked = [...(snap.rows as StandingsRow[])].sort(
                (a, b) => (a.rank ?? 99) - (b.rank ?? 99),
              );
              const poolFixtures = fixtures.filter(
                (f) => f.stage_id === stage.id && (f.pool_id ?? null) === (snap.pool_id ?? null),
              );
              return (
                <div key={snap.pool_id ?? "overall"} className="mb-6 space-y-3">
                  <StandingsTable
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
                  {poolFixtures.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-xs font-medium text-ink-muted hover:text-ink">
                        Results grid
                      </summary>
                      <div className="mt-2">
                        <ResultsMatrix
                          entrantIds={ranked.map((r) => r.entrantId)}
                          entrantNames={entrantNames}
                          entrantLogos={entrantLogos}
                          fixtures={poolFixtures}
                          fixtureHref={(id) => `${basePath}/fixtures/${id}`}
                        />
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
      {standings.length === 0 && !stages.some((s) => BRACKET_KINDS.has(s.kind)) ? (
        <p className="rounded-xl border border-dashed border-zinc-300 bg-surface p-6 text-center text-sm text-ink-muted">
          Standings appear after the first results.
        </p>
      ) : null}
      <SuspensionsStrip suspensions={suspensions} />
    </div>
  );

  const entrantsPanel = (
    <ul className="grid gap-3 sm:grid-cols-2">
      {entrants.map((e) => (
        <li
          key={e.id}
          className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm"
        >
          <p className="flex items-baseline justify-between gap-2 font-display text-lg font-semibold text-ink">
            <span className="truncate">{e.display_name}</span>
            {e.seed ? (
              <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-sans text-[11px] font-medium text-accent-strong">
                Seed {e.seed}
              </span>
            ) : null}
          </p>
          {e.members.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-zinc-600">
              {e.members.map((m, i) => (
                <li key={i} className="flex items-center gap-2">
                  {m.squad_number != null ? (
                    <span className="w-6 text-right font-display text-xs font-semibold tabular-nums text-ink-muted">
                      {m.squad_number}
                    </span>
                  ) : null}
                  {m.person_id ? (
                    <Link
                      href={`/shared/${org.slug}/${competition.slug}/players/${m.person_id}`}
                      className="underline decoration-accent-line underline-offset-2 hover:text-accent-strong hover:decoration-accent"
                    >
                      {m.name}
                    </Link>
                  ) : (
                    // No public-name consent: initials, no link (doc 06 §4.7).
                    <span>{m.name}</span>
                  )}
                  {m.position ? (
                    <span className="text-xs text-ink-muted">{m.position}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
      {entrants.length === 0 ? (
        <p className="text-sm text-ink-muted">No entrants yet.</p>
      ) : null}
    </ul>
  );

  return (
    <div style={publicThemeStyle(competition.branding)}>
      <nav className="mb-4 text-xs text-ink-muted">
        <Link href={`/shared/${org.slug}`} className="hover:text-accent-strong hover:underline">
          {org.name}
        </Link>{" "}
        /{" "}
        <Link
          href={`/shared/${org.slug}/${competition.slug}`}
          className="hover:text-accent-strong hover:underline"
        >
          {competition.name}
        </Link>
      </nav>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-display text-4xl font-bold uppercase leading-none tracking-tight text-ink sm:text-5xl">
          {division.name}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          {/* v13 (PROMPT-64): kiosk mode — cast this URL to any screen. */}
          <Link
            href={`/shared/${org.slug}/${competition.slug}/${division.slug}/present`}
            className="rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted ring-1 ring-inset ring-zinc-200 transition hover:bg-zinc-200 hover:text-ink"
          >
            Present ▸
          </Link>
          {/* Standings share (v3/10 #2) — the link unfurls into the OG card. */}
          <ShareButton
            title={`${division.name} — ${competition.name}`}
            text={`${division.name} standings & fixtures — ${competition.name}:`}
            url={`/shared/${org.slug}/${competition.slug}/${division.slug}`}
          />
        </div>
      </div>
      <p className="mb-6 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className="font-medium text-zinc-600">
          {division.sport_name ?? division.sport_key}
        </span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 uppercase text-accent-strong">
          {division.variant_key}
        </span>
        {stages.map((s) => (
          <span
            key={s.id}
            className={`rounded-full px-2 py-0.5 ${
              s.status === "complete"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-zinc-100 text-zinc-600"
            }`}
          >
            {stageById.get(s.id)?.name}
            {s.status === "complete" ? " ✓" : ""}
          </span>
        ))}
      </p>

      {championBanner}

      {division.description ? (
        <section className="mb-6">
          <CompetitionProse html={await renderProse(division.description)} />
        </section>
      ) : null}

      {/* The ids are the `?tab=` values the hub already links to
          (`competition-hub.ts:584,608`) and are deliberately NOT translated —
          a shared link has to survive the reader's locale. The LABELS are, and
          were English in every locale until now: the four keys have shipped in
          en/es/fr/nl all along and nothing rendered them, so their only
          consumer was the coverage test asserting they exist. */}
      <Tabs
        ids={["schedule", "standings", "entrants"]}
        labels={[
          t(dict, "division.tab.schedule"),
          t(dict, "division.tab.standings"),
          t(dict, "division.tab.entrants"),
        ]}
        label={t(dict, "division.tabsLabel")}
      >
        {[
          <Schedule
            key="schedule"
            fixtures={fixtures}
            entrantNames={entrantNames}
            divisionPath={basePath}
            tz={tz}
            slotLabels={slotLabels}
            roundLabels={roundLabels}
            stageOrder={stageOrder}
            copy={scheduleCopy}
          />,
          standingsPanel,
          entrantsPanel,
        ]}
      </Tabs>
    </div>
  );
}
