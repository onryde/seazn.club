export const dynamic = "force-dynamic";
// Competition overview: divisions as match-day cards (v3/03 §2); settings
// live on their own page.
import Link from "@/components/ui/console-link";
import { CalendarRange, Globe, MonitorPlay, Printer, Settings } from "lucide-react";
import { requireCompetitionPage } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { listDivisionCardStats, formatLabel } from "@/server/usecases/card-stats";
import { CardMenu } from "@/components/ui/card-menu";
import { resolveLogoUrl } from "@/server/public-site/data";
import { RegistrationHubNavEntry } from "@/components/registration-hub-nav-entry";
import { CompetitionPassEntry } from "@/components/competition-pass-entry";
import { CompetitionWrapUpPrompt } from "@/components/competition-wrap-up-prompt";
import { needsWrapUp } from "@/lib/competition-wrapup";
import { fmtDate, UTC } from "@/lib/format";
import { formatMinor } from "@/lib/currency";
import { lowestPassRung, passActiveLabels, passEndedReasons } from "@/lib/pass-ladder";
import { preferredCurrency } from "@/lib/currency-server";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, plural } from "@/lib/i18n";
import { sql } from "@/lib/db";
import { checkoutTrialDays } from "@/lib/billing";
import { getCompetitionDesk, competitionPhase } from "@/server/usecases/competition-desk";
import { statusLine, nextDateLabel } from "@/lib/division-status-line";
import { ledgerRank, leadingAttention } from "@/lib/division-phase";
import { PhasePill, AttentionChip } from "@/components/v2/desk/phase-pill";
import { DeskToolsMore } from "@/components/v2/desk/desk-tools-more";
import { NeedsYou, needsYouItems } from "@/components/v2/desk/needs-you";
import { DivisionLedger, type LedgerRow } from "@/components/v2/desk/division-ledger";
import { log } from "@/server/logger";

export default async function CompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug);
  const { auth, canEdit } = page;
  const id = page.competition.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const [competition, divisions, stats, desk, currency, [subRow]] = await Promise.all([
    getCompetition(auth, id),
    listDivisions(auth, id),
    listDivisionCardStats(auth, id),
    // Spec §Error handling: a summary failure never blanks the page.
    getCompetitionDesk(auth, id).catch((err: unknown) => {
      log.error({ event: "competition_desk_failed", competitionId: id, err }, "competition_desk_failed");
      return null;
    }),
    // The pass price is currency-switcher-dependent, and the entry point is a
    // client island — so it is formatted here and crosses as a finished string.
    preferredCurrency(page.org.id),
    // v17 gap #354 — the "ended" pass card below offers a Go Pro link whose
    // label must not promise a trial the checkout won't grant. Same read
    // `checkoutTrialDays` (lib/billing.ts) itself consults.
    sql<{ trial_used_at: string | null }[]>`
      select s.trial_used_at from organizations o
      join subscriptions s on s.id = o.subscription_id
      where o.id = ${page.org.id}`,
  ]);
  const trialAvailable = checkoutTrialDays(subRow) > 0;
  const compPhase = desk ? competitionPhase(desk) : null;
  // F5 fix: DivisionLedger's own "is this kick-off past?" check (its
  // nextLine) needs a fixed instant, never `Date.now()` read inside its own
  // render (react-hooks/purity). `desk.now` already IS that instant — every
  // division's phase in this render was resolved against it — so this reads
  // it straight through rather than sampling a second, slightly different
  // clock; the desk-summary-failed path (`desk` null) has no ledger `next`
  // data to judge either way, so any well-formed instant is harmless there.
  const now = desk?.now ?? new Date().toISOString();
  const divisionNames = divisions.map((d) => ({ id: d.id, name: d.name, slug: d.slug }));
  const needs = desk && canEdit ? needsYouItems(dict, desk, divisionNames, orgSlug, compSlug, locale) : [];
  const ledgerRows: LedgerRow[] = divisions.map((d) => {
    const dd = desk?.divisions.get(d.id) ?? null;
    const s = stats.get(d.id);
    if (!dd) {
      return {
        id: d.id, name: d.name, slug: d.slug, sportKey: d.sport_key,
        logoUrl: resolveLogoUrl(d.logo_storage_path, d.logo_url), desk: null,
        formatLabel: formatLabel(s?.stage_kinds ?? []),
        statusLine: t(dict, "card.progress.played", { played: s?.played ?? 0, total: s?.total ?? 0 }),
      };
    }
    return {
      id: d.id,
      name: d.name,
      slug: d.slug,
      sportKey: d.sport_key,
      logoUrl: resolveLogoUrl(d.logo_storage_path, d.logo_url),
      formatLabel: formatLabel(s?.stage_kinds ?? []),
      desk: dd,
      statusLine: statusLine(dict, {
        phase: dd.phase, played: dd.played, total: dd.total, unscheduled: dd.unscheduled, inPlay: dd.in_play,
        entrants: dd.entrants,
        next: dd.next ? { scheduledAt: dd.next.scheduled_at, home: dd.next.home, away: dd.next.away } : null,
        needsDrawStageName: dd.needs_draw_stage?.name ?? null, locale, displayTz: dd.display_tz,
        // G1 fix (fix round D, Critical): this consumer had no `now` at
        // all before — the SAME `now` every division's phase in this render
        // was already resolved against (see the `const now =` derivation
        // above), never a second, slightly different wall-clock read.
        now,
      }),
      menu: (
        <CardMenu
          name={d.name}
          items={[
            { label: t(dict, "action.schedule"), href: routes.divisionSchedule(orgSlug, compSlug, d.slug) },
            { label: t(dict, "action.slideshow"), href: routes.slideshowDivision(d.id), external: true },
          ]}
        />
      ),
    };
  });
  // K1 (fix round G): the rank used to name the two red kinds by hand — a
  // THIRD hand-copy of "which kinds are red", after phase-pill.tsx's ternary
  // and division-ledger.tsx's filter, and one a new red kind would silently
  // drop to the bottom of the ledger. L3 (fix round H): it now lives in
  // `ledgerRank` (division-phase.ts) rather than inline here, because "a red
  // attention outranks the phase" is a MODEL rule and this file is an async
  // server component no unit test can reach — deleting the red clause left
  // 147/147 green and no e2e asserted row order either. The ORDER of the
  // sort is still this page's own (rank, then name), and is pinned by
  // competition-desk.spec.ts's row-order test.
  ledgerRows.sort((a, b) => ledgerRank(a.desk) - ledgerRank(b.desk) || a.name.localeCompare(b.name));
  // Read off the ledger rows rather than `desk.divisions` so the masthead can
  // never disagree with what is actually on the page: a division the ledger
  // renders from card stats alone (its desk entry missing) contributes no
  // attention here either.
  const mastheadAttention = leadingAttention(ledgerRows.map((r) => r.desk));
  const publicPath =
    competition.visibility !== "private" ? routes.shared(orgSlug, competition.slug) : null;
  // RS004 W2 scope item 2: the Registration hub's nav entry carries live
  // counts, computed from the SAME card-stats query this page already runs
  // above — no second query, no client fetch, no N+1 per division.
  //
  // W2b review finding 1: `totalRegistered` used to sum `stats.get(d.id)
  // ?.entrants`, but an `entrants` row only exists once an entry is
  // MATERIALISED (registrations.ts's materialise(), at submit for a
  // free/auto/non-waitlisted entry, or at organiser approval otherwise) —
  // so a paid entry still awaiting manual approval, and every waitlisted
  // entry, read as zero, undercounting exactly what this pill exists so an
  // organiser can act on. `registered`/`awaiting_confirmation`
  // (card-stats.ts) count straight from `registrations.status` instead,
  // still off the SAME single query above — zero extra round trips.
  const openRegistrationDivisions = divisions.filter(
    (d) => stats.get(d.id)?.registration_open,
  ).length;
  const totalRegistered = divisions.reduce(
    (sum, d) => sum + (stats.get(d.id)?.registered ?? 0),
    0,
  );
  // The subset of `totalRegistered` not yet confirmed (pending, paid,
  // waitlisted) — surfaced as its own badge rather than folded into
  // `totalRegistered` alone, which would read as "all done" (finding 1:
  // "surface it honestly").
  const awaitingConfirmation = divisions.reduce(
    (sum, d) => sum + (stats.get(d.id)?.awaiting_confirmation ?? 0),
    0,
  );
  // The nav entry shows ONE number and puts these on hover/focus (owner call,
  // 2026-08-25 — three filled pills outshouted every other header action).
  // Confirmed is derived here rather than counted again: `awaiting` is a
  // strict subset of `registered` (card-stats.ts), so the two lines add up to
  // the number on the button and an organiser can check the arithmetic.
  // The awaiting line is OMITTED, not rendered at zero — same rule the amber
  // badge had.
  // Leads the accessible name (see the prop below) — and is NOT a tooltip
  // line: "56 registrants" then "34 confirmed, 22 awaiting confirmation"
  // would print the same population twice for a sighted reader who already
  // has the 56 on the button.
  const registeredLine = `${totalRegistered} ${plural(dict, "reg.hub.registeredCount", totalRegistered, locale)}`;
  const registrationDetails = [
    `${openRegistrationDivisions} ${plural(dict, "reg.hub.openCount", openRegistrationDivisions, locale)}`,
    `${totalRegistered - awaitingConfirmation} ${plural(dict, "reg.hub.confirmedCount", totalRegistered - awaitingConfirmation, locale)}`,
    ...(awaitingConfirmation > 0
      ? [`${awaitingConfirmation} ${t(dict, "reg.hub.awaitingConfirmation")}`]
      : []),
  ];

  return (
    <>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="page-title truncate">
              {competition.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              {compPhase && (
                <PhasePill
                  dict={dict}
                  phase={compPhase.kind}
                  inPlay={compPhase.kind === "in_play" ? compPhase.n : 0}
                  when={compPhase.kind === "next" ? nextDateLabel(compPhase.at, locale, compPhase.tz) : undefined}
                  testId="desk-masthead-pill"
                />
              )}
              {/* F4 (round J), corrected by review 7: the rows put a red
                  attention on their pill and this masthead showed only the
                  phase, so a competition whose divisions were collectively
                  blocked read calm at the top of its own page.
                  The first fix handed the attention to the pill itself, which
                  SUPPRESSES the phase — and that made "a future stage needs
                  its draw" delete "5 matches are live right now", the only
                  competition-level live count on the page. A row has to make
                  that trade (one pill, and its alternative is a phase word);
                  the masthead does not. Both facts, side by side. */}
              <AttentionChip dict={dict} attention={mastheadAttention} testId="desk-masthead-attention" />
              {/* Minor fix (review round 1): was the raw lowercase sport_key
                  ("football") — the `sport.<key>` dictionary already carries
                  a proper display name ("Ice hockey", "Table tennis") for
                  every sport, in all 4 locales, so read it from there
                  instead of hand-title-casing an internal key. */}
              <span>{[...new Set(divisions.map((d) => d.sport_key))].map((k) => t(dict, `sport.${k}`)).join(" · ")}</span>
              <span>·</span>
              {/* C4 fix (review round 3): was a bare `{n} divisions` — "1
                  divisions" on a fresh competition. `plural()` picks the
                  `.one`/`.other` dictionary form via Intl.PluralRules. */}
              <span>{plural(dict, "desk.masthead.divisions", divisions.length, locale)}</span>
            </div>
          </div>
          {/* Header actions.
              `sm` and up: unchanged — icon + label, wrapped in a row.
              Below `sm` (F2, round J): NOT the same row shrunk. It stacks,
              full width, and the set itself changes — one primary action
              (Schedule board), the one tool that carries status
              (Registration, with its count), and everything else folded into
              a labelled "More" disclosure. Before this, all five tools
              collapsed to unlabelled 46x34 icon tiles under the 44px tap
              floor, which is a groomed shrink of the desktop row. */}
          <div
            data-testid="desk-tool-row"
            className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:flex-col max-sm:items-stretch"
          >
            {/* Entry point 1 of 4 (task 19): the pass, offered in the
                competition's own header instead of only at a paywall. Renders
                itself away for a paid org — Pro already exceeds it, and shows
                the ENDED card instead of the offer once the pass has stopped
                applying (v17 gap #301): the layout judges that, this page only
                supplies every sentence it might need. */}
            {/* IMPORTANT (review 7) — instance THIRTEEN. This carries no order
                class, so on a phone it took CSS `order: 0` and led the stack:
                a 26px full-width upsell sitting above the control this
                redesign calls "THE action", 18px under the tap floor the
                redesign exists to enforce. Invisible to the seven-width sweep
                because every Playwright project runs as a Pro org, where this
                renders nothing at all.
                It is a discovery chip, not a tool: last on a phone, and never
                between the organiser and their work. */}
            <div className="max-sm:order-5">
            <CompetitionPassEntry
              href={routes.competitionUpgrade(orgSlug, compSlug)}
              buyLabel={t(dict, "pass.entry.buy", {
                // The ladder's FLOOR, derived — the copy says "from" and this
                // link leads to the page where the rung is actually chosen.
                price: formatMinor(lowestPassRung(currency).amountMinor, currency),
              })}
              activeLabels={passActiveLabels(dict)}
              endedLabel={t(dict, "pass.entry.ended")}
              endedReasons={passEndedReasons(dict)}
              nextEditionHref={routes.competitionNew(orgSlug)}
              nextEditionLabel={t(dict, "pass.entry.ended.nextEdition")}
              closedLinks={{
                terminal: {
                  href: routes.competitionNew(orgSlug),
                  label: t(dict, "pass.entry.ended.nextEdition"),
                },
                past_ends_on: {
                  href: routes.competitionSettings(orgSlug, compSlug),
                  label: t(dict, "pass.entry.closed.updateEndDate"),
                },
              }}
              goProHref={routes.billing(orgSlug)}
              goProLabel={t(dict, trialAvailable ? "upgrade.proCard.cta" : "upgrade.proCard.ctaNoTrial")}
              canBuy={canEdit}
            />
            </div>
            <Link
              href={routes.slideshowCompetition(competition.id)}
              target="_blank"
              aria-label={t(dict, "aria.slideshowNewTab")}
              className="btn btn-ghost gap-1.5 max-sm:hidden"
            >
              <MonitorPlay className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.slideshow")} ↗</span>
            </Link>
            {/* The organiser's most likely action at a venue, so on a phone it
                is THE action: first, full width, filled, and labelled. */}
            <Link
              href={routes.competitionSchedule(orgSlug, compSlug)}
              aria-label={t(dict, "aria.scheduleBoard")}
              data-testid="desk-tool-schedule"
              // `max-sm:hover:*` is not decoration: `btn-ghost` carries
              // `hover:bg-purple-50 hover:text-purple-700`, and a `hover:`
              // utility outranks a plain one — so on a phone, touching the
              // primary turned it pale lavender with purple text, i.e. it
              // stopped looking primary at the exact moment it was pressed.
              // Found by the owner photographing it, not by any gate: no
              // assertion in this repo reads a hover state.
              //
              // `justify-start`, matching Registration and More: three stacked
              // full-width controls with one of them centred read as three
              // unrelated things. The fill is what marks the primary now, not
              // a different alignment.
              className="btn btn-ghost gap-1.5 max-sm:order-1 max-sm:min-h-11 max-sm:w-full max-sm:justify-start max-sm:border-purple-600 max-sm:bg-purple-600 max-sm:px-4 max-sm:text-white max-sm:hover:border-purple-700 max-sm:hover:bg-purple-700 max-sm:hover:text-white"
            >
              <CalendarRange className="h-4 w-4" strokeWidth={1.75} />
              <span className="sm:inline">{t(dict, "action.scheduleBoard")}</span>
            </Link>
            {publicPath && (
              <Link
                href={publicPath}
                target="_blank"
                aria-label={t(dict, "aria.viewPublicNewTab")}
                className="btn btn-ghost gap-1.5 max-sm:hidden"
              >
                <Globe className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.viewPublic")} ↗</span>
              </Link>
            )}
            {publicPath && (
              // v3/10 #3: A4 PDF with a big QR to the dashboard — print it,
              // tape it to the venue door.
              <a
                href={`${publicPath}/poster.pdf`}
                target="_blank"
                aria-label={t(dict, "aria.qrPoster")}
                className="btn btn-ghost gap-1.5 max-sm:hidden"
              >
                <Printer className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.qr")}</span>
              </a>
            )}
            {(
              // NOT gated on canEdit. RS004 shipped this as owner/admin-only
              // to match the hub page's own `if (!canEdit) notFound()`; the
              // owner reversed that on 2026-08-25 (viewers get the hub
              // read-only) and RS005 deleted the guard, which left this entry
              // as the last thing hiding the tab from the audience the ruling
              // was FOR — readable by URL, unreachable by clicking.
              //
              // `requireCompetitionPage` already excludes a scorer (404), and
              // this page does not render for one at all, so no gate is owed
              // here: whoever sees this overview may see the hub.
              <RegistrationHubNavEntry
                className="max-sm:order-2"
                href={routes.competitionRegistration(orgSlug, compSlug)}
                label={t(dict, "action.registration")}
                // The breakdown, not just "Registration": the tooltip that
                // shows these same lines is aria-hidden, so this is the only
                // path a screen reader has to them.
                //
                // It LEADS with the registrant total because that is the
                // number printed on the button, and WCAG 2.5.3 (Label in
                // Name) wants the visible label inside the accessible name.
                // The breakdown alone failed that the moment anything was
                // awaiting: the visible "56" appeared nowhere in a name whose
                // own figures were 34 and 22 — the exact state the amber dot
                // exists for, and a speech-input user asking for "fifty-six"
                // would have matched nothing.
                ariaLabel={`${t(dict, "aria.registration")} — ${registeredLine}: ${registrationDetails.join(", ")}`}
                count={String(totalRegistered)}
                details={registrationDetails}
                awaiting={awaitingConfirmation > 0}
              />
            )}
            <Link
              href={routes.competitionSettings(orgSlug, compSlug)}
              aria-label={t(dict, "aria.settings")}
              className="btn btn-ghost gap-1.5 max-sm:hidden"
            >
              <Settings className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.settings")}</span>
            </Link>
            {/* Phone only, and the counterpart of the four `max-sm:hidden`
                tools above: the same destinations, as labelled full-width
                rows at the tap floor instead of unreadable glyphs. Its own
                `sm:hidden` is what keeps 640-and-up literally unchanged. */}
            <DeskToolsMore
              className="max-sm:order-3 sm:hidden"
              label={t(dict, "desk.tools.more")}
              items={[
                { label: t(dict, "action.slideshow"), href: routes.slideshowCompetition(competition.id), external: true },
                ...(publicPath
                  ? [
                      { label: t(dict, "action.viewPublic"), href: publicPath, external: true },
                      { label: t(dict, "action.qr"), href: `${publicPath}/poster.pdf`, external: true },
                    ]
                  : []),
                { label: t(dict, "action.settings"), href: routes.competitionSettings(orgSlug, compSlug) },
              ]}
            />
          </div>
        </div>

          <NeedsYou dict={dict} items={needs} />

          {/* v17 gap #362 — nothing retires a competition past its end date, so
              the product asks instead of sweeping. Editors only: the two
              answers are both writes, and a scorer has neither the permission
              nor the standing to retire someone else's competition.

              NOT gated on `frozen`. A frozen competition is read-only, but
              `isRetirePatch` (usecases/competitions.ts) exempts a bare
              status→completed precisely so an over-quota org can get back under
              it — which makes this prompt MORE useful there, not less.

              `ends_on` is a DATE, so it formats in UTC: the local-zone reading
              of a bare date is a day off for half the world, and this sentence
              quotes the same boundary the lock arm judges. */}
          {canEdit && needsWrapUp(competition.status, competition.ends_on) && (
            <CompetitionWrapUpPrompt
              competitionId={competition.id}
              endedOnLabel={fmtDate(UTC, competition.ends_on, {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
              settingsHref={routes.competitionSettings(orgSlug, compSlug)}
            />
          )}

          <section>
            <div className="mb-3 flex items-center justify-between">
              {/* V5 fix (review round 1): DivisionLedger no longer renders its
                  own "Divisions · N" heading — this heading is the ONE
                  "Divisions" heading on the page now, and carries the
                  count DivisionLedger used to print itself. */}
              <h2 className="text-sm font-semibold text-slate-700">{t(dict, "comp.detail.divisions")} · {divisions.length}</h2>
              {canEdit && !competition.frozen && (
                <Link
                  href={routes.divisionNew(orgSlug, compSlug)}
                  className="btn btn-primary"
                >
                  + {t(dict, "action.addDivision")}
                </Link>
              )}
            </div>
            {divisions.length === 0 ? (
              <div className="card p-6 text-center text-sm text-slate-500">
                <p>{t(dict, "card.empty.divisions")}</p>
                {canEdit && !competition.frozen && (
                  <Link href={routes.divisionNew(orgSlug, compSlug)} className="btn btn-primary mt-4">
                    {t(dict, "card.empty.divisions.cta")}
                  </Link>
                )}
              </div>
            ) : (
              <DivisionLedger
                dict={dict} rows={ledgerRows} org={orgSlug} comp={compSlug} locale={locale} now={now}
                canEdit={canEdit}
              />
            )}
          </section>
      </main>
    </>
  );
}
