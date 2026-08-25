export const dynamic = "force-dynamic";
// Competition overview: divisions as match-day cards (v3/03 §2); settings
// live on their own page.
import Link from "@/components/ui/console-link";
import { CalendarRange, Globe, MonitorPlay, Printer, Settings } from "lucide-react";
import { requireCompetitionPage } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { listDivisionCardStats, nextLine, formatLabel } from "@/server/usecases/card-stats";
import { EntityCard } from "@/components/ui/entity-card";
import { CardMenu } from "@/components/ui/card-menu";
import { ViewToggleContainer } from "@/components/ui/view-toggle";
import { StatusChip, divisionChipState, CHIP_SORT } from "@/components/ui/status-chip";
import { divisionAccent, monogram } from "@/lib/division-hue";
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
  const [competition, divisions, stats, currency, [subRow]] = await Promise.all([
    getCompetition(auth, id),
    listDivisions(auth, id),
    listDivisionCardStats(auth, id),
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
            {/* Entry point 1 of 4 (task 19): the pass, offered in the
                competition's own header instead of only at a paywall. Renders
                itself away for a paid org — Pro already exceeds it, and shows
                the ENDED card instead of the offer once the pass has stopped
                applying (v17 gap #301): the layout judges that, this page only
                supplies every sentence it might need. */}
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
            <h1 className="page-title mt-1 truncate">
              {competition.name}
            </h1>
          </div>
          {/* Header actions: icon + label on desktop, icon-only under `sm`
              (v3/02 pattern 5 — labels move into aria-label, 44px targets). */}
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={routes.slideshowCompetition(competition.id)}
              target="_blank"
              aria-label={t(dict, "aria.slideshowNewTab")}
              className="btn btn-ghost gap-1.5"
            >
              <MonitorPlay className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.slideshow")} ↗</span>
            </Link>
            <Link
              href={routes.competitionSchedule(orgSlug, compSlug)}
              aria-label={t(dict, "aria.scheduleBoard")}
              className="btn btn-ghost gap-1.5"
            >
              <CalendarRange className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.scheduleBoard")}</span>
            </Link>
            {publicPath && (
              <Link
                href={publicPath}
                target="_blank"
                aria-label={t(dict, "aria.viewPublicNewTab")}
                className="btn btn-ghost gap-1.5"
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
                className="btn btn-ghost gap-1.5"
              >
                <Printer className="h-4 w-4" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t(dict, "action.qr")}</span>
              </a>
            )}
            {canEdit && (
              // Owner/admin only (RS004 prompt scope item 1) — a viewer or
              // scorer never sees this entry, matching the hub page's own
              // canEdit guard (registration/page.tsx).
              <RegistrationHubNavEntry
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
              className="btn btn-ghost gap-1.5"
            >
              <Settings className="h-4 w-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t(dict, "action.settings")}</span>
            </Link>
          </div>
        </div>

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
              <h2 className="text-sm font-semibold text-slate-700">{t(dict, "comp.detail.divisions")}</h2>
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
              <ViewToggleContainer storageKey="seazn.view.divisions" toggle={divisions.length > 20}>
                {divisions
                  .map((d) => ({
                    d,
                    chip: divisionChipState(d.status, {
                      registrationOpen: stats.get(d.id)?.registration_open,
                    }),
                  }))
                  .sort((a, b) => CHIP_SORT[a.chip] - CHIP_SORT[b.chip])
                  .map(({ d, chip }) => {
                    const s = stats.get(d.id);
                    // Plural picks the noun; the count string keeps the "used/cap"
                    // form, so force the plural noun whenever a capacity is shown.
                    const entrantsLabel = s
                      ? `${s.entrants}${s.capacity ? `/${s.capacity}` : ""} ${plural(dict, "card.meta.entrants", s.capacity ? 2 : s.entrants, locale)}`
                      : null;
                    return (
                      <EntityCard
                        key={d.id}
                        href={routes.division(orgSlug, compSlug, d.slug)}
                        media={{
                          kind: "tile",
                          logoUrl: resolveLogoUrl(d.logo_storage_path, d.logo_url),
                          monogram: monogram(d.name),
                          hue: divisionAccent(d.id),
                        }}
                        name={d.name}
                        accent={divisionAccent(d.id)}
                        locale={locale}
                        chip={<StatusChip state={chip} locale={locale} />}
                        meta={[formatLabel(s?.stage_kinds ?? []), entrantsLabel]
                          .filter(Boolean)
                          .join(" · ")}
                        next={s ? nextLine(s.next, locale) : null}
                        progress={s ? { played: s.played, total: s.total } : null}
                        menu={
                          <CardMenu
                            name={d.name}
                            items={[
                              { label: t(dict, "action.schedule"), href: routes.divisionSchedule(orgSlug, compSlug, d.slug) },
                              // action.registrations item removed (RS001
                              // demolition) — RS004's hub replaces it.
                              { label: t(dict, "action.slideshow"), href: routes.slideshowDivision(d.id), external: true },
                            ]}
                          />
                        }
                      />
                    );
                  })}
              </ViewToggleContainer>
            )}
          </section>
      </main>
    </>
  );
}
