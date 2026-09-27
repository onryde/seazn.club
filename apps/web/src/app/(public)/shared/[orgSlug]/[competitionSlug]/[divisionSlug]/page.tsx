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
import { DictProvider } from "@/components/i18n/dict-provider";
import { Tabs } from "@/components/public-site/tabs";
import { Schedule } from "@/components/public-site/schedule";
import { publicScheduleCopy } from "@/server/public-site/schedule-copy";
import { StandingsTable } from "@/components/public-site/standings-table";
import { inTheField } from "@/lib/entrant-field";
import { Bracket } from "@/components/public-site/bracket";
import { ResultsMatrix } from "@/components/public-site/results-matrix";
import { SuspensionsStrip } from "@/components/public-site/suspensions-strip";
import { publicSuspensions } from "@/server/usecases/discipline";
import type { MetricSpecLike } from "@/lib/public-site";
import { playerLinkId } from "@/lib/name-display";
import { byPoolOrder } from "@/lib/pool-order";
import { toLocale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";
import type { AnySportModule } from "@seazn/engine/sport";
import { divisionQualification } from "@/server/public-site/division-qualification";
import { msgFor } from "@/lib/messages-i18n";
import { rulesLineText } from "@/lib/rules-line";
import { publicRoundNamer } from "@/server/public-site/feeder-slot-label";
import { variantLabel } from "@/server/public-site/variant-label";
import { stageFormatLines } from "@/server/public-site/stage-format-lines";
import { sportLabel } from "@/lib/scoring-vocab";
import { pickDictPrefixes } from "@/lib/i18n-subset";
import { linkOnlyRobots } from "@/lib/competition-listing";

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
  // The org's language, like every word on the page (ISR: never the viewer's).
  const dict = await getDictionary(toLocale(data.org.default_locale), "public");
  return {
    title: `${data.division.name} — ${data.competition.name}`,
    description: t(dict, "division.metaDescription", {
      division: data.division.name,
      competition: data.competition.name,
    }),
    // Doc 09 §1: link-only = crawlers out, page up. Unlisted, and — owner
    // decision 2026-09-27 — a DRAFT, which is unlisted until published.
    ...linkOnlyRobots(data.competition),
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
  let module_: AnySportModule | null = null;
  try {
    module_ = resolveModule(division.sport_key, division.module_version);
    metricSpecs = module_.metrics;
    cascade = division.tiebreakers ?? module_.defaultTiebreakers;
  } catch {
    // Unknown module version (e.g. retired build) — structural columns only.
  }

  const entrantNames = Object.fromEntries(entrants.map((e) => [e.id, e.display_name]));
  // A departed entrant keeps the row she earned in the standings — the
  // withdrawal (or the disqualification) settles the matches she had left and
  // leaves the ones she played — so the table carries her and MARKS her.
  // `StandingsRow` has no status field, so the statuses travel beside the rows.
  // Handed over RAW, one status per entrant: which of them counts as departed,
  // and what word it prints, is the TABLE's single decision
  // (`DEPARTED_STATUS_CHIPS`). Filtering to one status here is precisely what
  // left `disqualified` unmarked on all three of these pages at once (C1) —
  // `patchEntrant` accepts it, so a disqualified entrant reached the standings
  // ranked among the competing and styled exactly like them.
  //
  // This works because V412 widened `public_entrants_v` to publish departed
  // entrants. Before it, she reached this page not at all, and the standings
  // table printed her raw UUID because `entrantNames` had no entry (F10, seen
  // on the live page 2026-09-21). The flip side of that widening is the
  // `inTheField` filter on the entrants tab below: this page now holds
  // EVERYONE, and each consumer says which question it is asking.
  const entrantStatuses = Object.fromEntries(entrants.map((e) => [e.id, e.status]));
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
  // Per-stage match rules (T7): a stage whose effective rules differ from the
  // division's names them on its chip, in the org's words — the same line the
  // hub's Info tab prints and the match page labels its fixtures with. A stage
  // that plays the division's format gets nothing, so a division without
  // overrides reads exactly as before.
  const stageFormat = new Map(
    stageFormatLines(division.sport_key, module_, division.config, stages).map((s) => [
      s.stageId,
      rulesLineText(dict, s.line),
    ]),
  );
  // Standings qualification status (spec 2026-09-22 §4.2): the same assembly
  // the embed and the competition hub use — bounds and the walkover's ledger
  // from the PINNED module and live cfg (a retired module gives no bounds, so
  // no status), every word the org's, like the rest of this ISR page. Called
  // per table below with that table's own snapshot, which carries its pool.
  const qualificationFor = divisionQualification({
    module_,
    division,
    dict,
    locale: orgLocale,
    fixtures,
    entrantStatuses,
    entrantNames,
    cascade,
  });
  // `ShareButton` reads its label through `useMsg()` (ui.json), which needs a
  // `<DictProvider>` ancestor to see any locale but English — the fixture
  // page's own finding, and this page had none either (Task 16 review, I1).
  // Only the `share.*` keys: the provider's `dict` is a client prop, serialised
  // into this ISR page's flight payload, and the whole ui.json is 324–365 KB
  // for the two words ShareButton reads (T16b re-review I-r2-1). An island
  // added under this provider that reads another prefix adds it here.
  const ui = pickDictPrefixes(await getDictionary(orgLocale, "ui"), ["share."]);
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
    // `seat`, not `slot`: a sibling-fed seat of a `timing: "setup"` bracket
    // carries no stored label, so the stored-only path printed "TBD".
    if (!f.home_entrant_id) slotLabels[`${f.id}:home`] = namer.seat(f.id, "home", f.home_slot_label);
    if (!f.away_entrant_id) slotLabels[`${f.id}:away`] = namer.seat(f.id, "away", f.away_slot_label);
  }
  // N1d d5: the schedule tab's round view heads each group with the round's
  // NAME from the same namer ("Round {n}" in the org's locale only for a
  // fixture whose stage the namer does not know). N1e e5: every other word it
  // shows or announces comes from the page's org-locale dictionaries, and its
  // dates are written in the org's locale, as the embed schedule widget does.
  const roundLabels = Object.fromEntries(
    fixtures.map((f) => [f.id, namer.roundLabel(f.id) ?? lookup("schedule.round", { n: f.round_no })]),
  );
  const scheduleCopy = publicScheduleCopy(dict, lookup);
  // N1e e1: round_no restarts in every stage, so the round view orders its
  // groups by each stage's seq first, as the embed schedule widget does.
  const stageOrder = Object.fromEntries(stages.map((s) => [s.id, s.seq]));
  // N1f f2: two stages can name a round the same ("Final" in a knockout and in
  // its plate); the round view heads those groups with the stage as well.
  const stageNames = Object.fromEntries(stages.map((s) => [s.id, s.name]));

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
            {t(dict, "table.champion")}
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
          // The bracket resolves a seat's label ITSELF (it owns its own
          // `bracket.tbd`, a different word from the namer's `schedule.tbd`
          // in es/fr/nl), so it cannot take a pre-resolved string. What it
          // can take is the label the seat really has: `seatLabelOf` fills in
          // the FEED-derived one for a seat a `timing: "setup"` bracket left
          // stored-null. Without this the schedule tab named the final's
          // seats and the tree beside it said "TBD" — the same match, one
          // page, two answers.
          const stageFixtures = fixtures
            .filter((f) => f.stage_id === stage.id)
            .map((f) => ({
              ...f,
              home_slot_label: namer.seatLabelOf(f.id, "home", f.home_slot_label),
              away_slot_label: namer.seatLabelOf(f.id, "away", f.away_slot_label),
            }));
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
                copy={scheduleCopy}
                tz={tz}
                locale={orgLocale}
              />
            </section>
          );
        }
        const snapshots = standings
          .filter((s) => s.stage_id === stage.id)
          // Pool A above Pool B — the pool's own order, never its random id.
          .sort(byPoolOrder(pools));
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
              // This table's cut line and statuses (null: no cut, or anything
              // the builder cannot be sure of — then the table is as before).
              const qualification = qualificationFor(stage, snap);
              return (
                <div key={snap.pool_id ?? "overall"} className="mb-6 space-y-3">
                  <StandingsTable
                    rows={snap.rows as StandingsRow[]}
                    metricSpecs={metricSpecs}
                    cascade={cascade}
                    entrantNames={entrantNames}
                    entrantLogos={entrantLogos}
                    entrantStatuses={entrantStatuses}
                    caption={
                      snap.pool_id
                        ? `${stage.name} — ${poolName.get(snap.pool_id) ?? t(dict, "table.pool")}`
                        : stage.name
                    }
                    dict={dict}
                    qualification={qualification}
                  />
                  {poolFixtures.length > 0 && (
                    <details>
                      {/* `min-h-11 py-3.5` is the 44px tap floor (W2 contact
                          sheet img-135, owner approved): the toggle was plain
                          text, 16px tall at 320. The padding rather than a
                          `flex` is deliberate — a `<summary>` is `display:
                          list-item`, and changing its display takes the
                          disclosure triangle with it. */}
                      <summary className="min-h-11 cursor-pointer py-3.5 text-xs font-medium text-ink-muted hover:text-ink">
                        {t(dict, "division.resultsGrid")}
                      </summary>
                      <div className="mt-2">
                        <ResultsMatrix
                          entrantIds={ranked.map((r) => r.entrantId)}
                          entrantNames={entrantNames}
                          entrantLogos={entrantLogos}
                          fixtures={poolFixtures}
                          fixtureHref={(id) => `${basePath}/fixtures/${id}`}
                          dict={dict}
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
          {t(dict, "division.standingsEmpty")}
        </p>
      ) : null}
      <SuspensionsStrip suspensions={suspensions} dict={dict} locale={orgLocale} />
    </div>
  );

  // The entrants TAB is the field, not the history — the people a spectator can
  // still expect to see play. `data.entrants` carries the departed too since
  // V412, so the filter lives here, where the question is asked.
  const field = entrants.filter(inTheField);
  const entrantsPanel = (
    <ul className="grid gap-3 sm:grid-cols-2">
      {field.map((e) => (
        // `min-w-0` on the `li` is the one doing the work: a grid item's
        // automatic minimum is its content, so a 43-character name grew the
        // card past a 320 phone (+73px, T17 HB9d) and `truncate` never fired.
        <li
          key={e.id}
          className="min-w-0 rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm"
        >
          <p className="flex min-w-0 items-baseline justify-between gap-2 font-display text-lg font-semibold text-ink">
            <span className="min-w-0 truncate">{e.display_name}</span>
            {/* `!= null`, never truthiness: seed 0 is a seed. A division that
                hides its seeds (V416) is served `seed: null`, so no chip. */}
            {e.seed != null ? (
              <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-sans text-[11px] font-medium text-accent-strong">
                {t(dict, "division.seed", { seed: e.seed })}
              </span>
            ) : null}
          </p>
          {e.members.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-zinc-600">
              {e.members.map((m, i) => {
                const linkId = playerLinkId(m.person_id, division);
                return (
                  <li key={i} className="flex items-center gap-2">
                    {m.squad_number != null ? (
                      <span className="w-6 text-right font-display text-xs font-semibold tabular-nums text-ink-muted">
                        {m.squad_number}
                      </span>
                    ) : null}
                    {linkId ? (
                      <Link
                        href={`/shared/${org.slug}/${competition.slug}/players/${linkId}`}
                        className="underline decoration-accent-line underline-offset-2 hover:text-accent-strong hover:decoration-accent"
                      >
                        {m.name}
                      </Link>
                    ) : (
                      // No link on the hub Teams tab's terms (`playerLinkId`): no
                      // public-name consent, player pages not granted to the org,
                      // or a division that masks names (doc 06 §4.7). A masked
                      // member has no id to link either: `maskPublicEntrantNames`
                      // withholds it, because the card behind it would undo the mask.
                      <span>{m.name}</span>
                    )}
                    {m.position ? (
                      <span className="text-xs text-ink-muted">{m.position}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </li>
      ))}
      {field.length === 0 ? (
        <p className="text-sm text-ink-muted">{t(dict, "division.entrantsEmpty")}</p>
      ) : null}
    </ul>
  );

  return (
    <DictProvider dict={ui} locale={orgLocale}>
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
          {/* Below `md` the pair may shrink to the column and wrap onto two
              lines. As a `shrink-0` row it was as wide as its longest
              language: "Presentar ▸" + "Compartir en WhatsApp" is 319px in a
              288px column at 320, so the share button ran 15px off screen and
              the page's overflow clip cut it (T17 HB14; fr is as long). From
              `md` up it is the same one row beside the heading as before. */}
          <div className="flex shrink-0 items-center gap-2 max-md:min-w-0 max-md:shrink max-md:flex-wrap">
            {/* v13 (PROMPT-64): kiosk mode — cast this URL to any screen. */}
            <Link
              href={`/shared/${org.slug}/${competition.slug}/${division.slug}/present`}
              // Below `md` the pill takes a 44px tap, like the Share button
              // beside it (it was 28px, T17 HB14); from `md` up it is the same
              // compact pill as before. `gap-1` stands in for the space before
              // the ▸, which a flex container drops.
              className="rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted ring-1 ring-inset ring-zinc-200 transition hover:bg-zinc-200 hover:text-ink max-md:inline-flex max-md:min-h-11 max-md:items-center max-md:gap-1"
            >
              {/* N1e e7: the label in the org's locale; the ▸ is decoration. */}
              {t(dict, "division.present")} <span aria-hidden="true">▸</span>
            </Link>
            {/* Standings share (v3/10 #2) — the link unfurls into the OG card. */}
            <ShareButton
              title={`${division.name} — ${competition.name}`}
              text={t(dict, "division.share.text", { division: division.name, competition: competition.name })}
              url={`/shared/${org.slug}/${competition.slug}/${division.slug}`}
            />
          </div>
        </div>
        <p className="mb-6 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span className="font-medium text-zinc-600">
            {/* T16b fix round 4: `sport.<key>` in the org's locale, the same
                helper /discover names sports with — `sport_name` is the
                English `sports.name` catalog row. */}
            {sportLabel(division.sport_key, lookup)}
          </span>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 uppercase text-accent-strong">
            {variantLabel(
              { sportKey: division.sport_key, variantKey: division.variant_key, storedName: division.variant_name ?? null },
              lookup,
            )}
          </span>
          {stages.map((s) => (
            <span
              key={s.id}
              data-stage-id={s.id}
              // `min-w-0 max-w-full` + `[overflow-wrap:anywhere]`: a flex
              // item's floor is its longest word, so an unbroken stage name
              // (or name + rules line) would otherwise widen the page at 320.
              className={`min-w-0 max-w-full rounded-full px-2 py-0.5 [overflow-wrap:anywhere] ${
                s.status === "complete"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-zinc-100 text-zinc-600"
              }`}
            >
              {stageById.get(s.id)?.name}
              {stageFormat.has(s.id) ? (
                <span data-testid="division-stage-format"> · {stageFormat.get(s.id)}</span>
              ) : null}
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
              stageNames={stageNames}
              copy={scheduleCopy}
              locale={orgLocale}
            />,
            standingsPanel,
            entrantsPanel,
          ]}
        </Tabs>
      </div>
    </DictProvider>
  );
}
