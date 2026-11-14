export const dynamic = "force-dynamic";
// Org home — the organisation's Competitions (Match Day C7, owner rulings 2026-11-01: concept C, the "today deck", with B's
// "nothing scheduled" stub on the quiet cards). Nav comes from the /o layout; auth comes from the URL (PROMPT-30).
//
//  - Titled "Competitions". The "Matchday console" eyebrow is gone everywhere, and so is this page's Directory button (the
//    top nav keeps Directory).
//  - Competitions with a match TODAY sit in the night deck at the top and carry Open Match Day, a Draft one included. "Today"
//    is Match Day's own count (`competitionsFixturesToday` = `countFixturesToday` for the whole list, in one bounded read), and
//    the deck is the competition page's own question of it (`homeGroupOf` → `needsYouHome`).
//  - Everything else is a quiet card, grouped Under way / Not started; one with nothing upcoming ends in B's stub.
//  - Finished competitions (completed or archived) are hidden by default; "Show finished" (`?finished=1`) shows them, last.
import Link from "@/components/ui/console-link";
import { Trophy } from "lucide-react";
import { BillingBanner } from "@/components/billing-banner";
import { requireOrgPage } from "@/server/page-auth";
import { listCompetitions } from "@/server/usecases/competitions";
import { listCompetitionCardStats } from "@/server/usecases/card-stats";
import { competitionsFixturesToday } from "@/server/usecases/match-day";
import { CardMenu } from "@/components/ui/card-menu";
import { StatusChip, competitionChipState, CHIP_SORT } from "@/components/ui/status-chip";
import { SwitchLink } from "@/components/v2/desk/switch-link";
import { homeGroupOf, nextLine, sportsLine, stubOf, type HomeGroup } from "@/components/v2/org-home/home-rules";
import {
  HomeGroupSection,
  QuietCard,
  TodayDeck,
  TodayEmpty,
  type HomeCardBase,
  type QuietCardData,
  type TodayRowData,
} from "@/components/v2/org-home/home-cards";
import { sql } from "@/lib/db";
import { isPaidPlan, isPassLocked, orgPlanKey, passLockReason } from "@/lib/entitlements";
import { formatMinor, isPassKey } from "@/lib/currency";
import { lowestPassRung } from "@/lib/pass-ladder";
import { PassSeal } from "@/components/pass-seal";
import { preferredCurrency } from "@/lib/currency-server";
import { routes, searchOf } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, plural } from "@/lib/i18n";
import { msgFor } from "@/lib/messages-i18n";
import { sportLabel } from "@/lib/scoring-vocab";

/** The roster's groups below the deck, in page order, and their headings. */
const ROSTER: { group: Exclude<HomeGroup, "today">; title: "org.home.group.underWay" | "org.home.group.notStarted" | "org.home.group.finished" }[] = [
  { group: "underWay", title: "org.home.group.underWay" },
  { group: "notStarted", title: "org.home.group.notStarted" },
  { group: "finished", title: "org.home.group.finished" },
];

export default async function OrgHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  // The switch's state is the URL (as the competition page's ledger does it): a reload or the back button keeps it.
  const sp = await searchParams;
  const showFinished = sp.finished === "1";
  const { auth, org, canEdit } = await requireOrgPage(orgSlug, { search: searchOf(sp) });

  // Reaching the dashboard is the end of first-run: mark onboarding done so a
  // user who left the wizard by any route (nav, back button) isn't sent back
  // to /onboarding on their next login. Idempotent — a no-op once set.
  if (auth.userId) {
    const { markOnboardingDone } = await import("@/lib/activation");
    await markOnboardingDone(auth.userId);
  }

  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  const { items: competitions } = await listCompetitions(auth, { cursor: null, limit: 100 });
  const [stats, today] = await Promise.all([
    listCompetitionCardStats(auth),
    // One bounded read for the whole list (three statements, however many cards), never a query per card.
    competitionsFixturesToday(
      auth,
      competitions.map((c) => c.id),
    ),
  ]);

  // Event Pass state for the list (task 19, entry point 4 of 4).
  //
  // Under a paid plan neither half applies and neither read happens: the pass
  // must not be OFFERED (Pro's matrix is a strict superset — the $29 would buy
  // strictly less), and a pass row that survives a later upgrade must not be
  // ADVERTISED either, because the resolver stops consulting it the moment the
  // plan is paid. That is exactly what `usePassGateState()` collapses to
  // "paid_plan"; the same precedence, from the same predicate, on the server.
  const paidPlan = isPaidPlan(await orgPlanKey(org.id));
  const [passRows, currency] = await Promise.all([
    paidPlan
      ? []
      : // Presence, never payment: a staff-granted pass has a null
        // `stripe_payment_intent` and is fully active.
        //
        // `pass_key` rides along (v17 #294): the seal on a passed card is the
        // ONLY thing this page says about the pass, and with M and L both live
        // "Event Pass active" names the $29 product to an org that paid $59.
        //
        // status/ends_on ride along too (v17 gap #301). The seal read row
        // EXISTENCE alone, so it kept saying "active" on a competition that had
        // finished months ago — the resolver had long since stopped honouring
        // that row. Joined rather than read separately so the row and the
        // verdict about it cannot come from two different moments.
        sql<
          // `Date | string | null`, matching the four other sites that feed this
          // predicate: `ends_on` is a `date` column and the driver hands back a
          // Date. Declaring it `string` here contradicted `passLockReason`'s own
          // note that production never passes it a string — the reason its NaN
          // arm is considered unreachable — and invited a `.slice(0, 10)` that
          // would throw.
          {
            competition_id: string;
            pass_key: string;
            status: string;
            ends_on: Date | string | null;
          }[]
        >`
          select cp.competition_id, cp.pass_key, c.status, c.ends_on
          from competition_passes cp
          join competitions c on c.id = cp.competition_id
          where cp.org_id = ${org.id}`,
    preferredCurrency(org.id),
  ]);
  // isPassKey, not a cast: the column is `not null default 'event_pass'` and a
  // row written by a future rung this build predates must still land on a real
  // label rather than an undefined lookup.
  const passed = new Map(
    passRows.map((r) => [r.competition_id, isPassKey(r.pass_key) ? r.pass_key : "event_pass"] as const),
  );
  // WHY each held pass has stopped applying, or null while it still does. The
  // arms stay in `passLockReason` — a second copy here is exactly how the badge
  // and the resolver drift apart again.
  const passLock = new Map(
    passRows.map((r) => [r.competition_id, passLockReason(r.status, r.ends_on)] as const),
  );
  // The card menu's "Event Pass — from {price}" quotes the ladder FLOOR: the
  // menu item offers no choice of rung, and the choice itself lives on the
  // upgrade page it links to (v17 #294).
  const passLabel = formatMinor(lowestPassRung(currency).amountMinor, currency);

  // The card's chip is read off its divisions (UI5 item 6, owner 2026-11-03: a published competition said "Registration
  // open" with no division window open). The signals ride on the card stats' one query for the whole list. A card with no
  // stats row (a competition deleted between the two reads) says nothing about its divisions.
  // Live first, then Registration open, In progress, Draft, Completed (v3/03 §2); secondary = the query's recency order,
  // kept by stable sort.
  const chipOf = (c: (typeof competitions)[number]) => {
    const s = stats.get(c.id);
    return competitionChipState(c.status, {
      inPlay: s?.in_play ?? 0,
      registrationOpen: s?.registration_open ?? false,
      divisions: s?.divisions ?? 0,
      divisionsActive: s?.divisions_active ?? 0,
      divisionsCompleted: s?.divisions_completed ?? 0,
      played: s?.played ?? 0,
    });
  };
  const sorted = competitions
    .map((c) => ({ c, chip: chipOf(c) }))
    .sort((a, b) => CHIP_SORT[a.chip] - CHIP_SORT[b.chip]);

  const sportName = (k: string) => sportLabel(k, (key) => msgFor(locale, key));
  const sportsCount = (n: number) => plural(dict, "org.home.sports", n, locale);

  type Entry = (typeof sorted)[number];
  const base = ({ c, chip }: Entry, tone: "night" | "light"): HomeCardBase => {
    const s = stats.get(c.id);
    const heldRung = passed.get(c.id) ?? null;
    return {
      slug: c.slug,
      name: c.name,
      href: routes.competition(orgSlug, c.slug),
      chip: (
        <span className="flex shrink-0 items-center gap-1.5">
          <StatusChip state={c.frozen ? "frozen" : chip} locale={locale} />
          {/* A seal, not a second word: the status chip owns the card's word; this says the pass is on and carries its label
              on the element itself. v17 gap #301: the whole decision (lime vs ended) lives in <PassSeal>, which renders in a
              test. */}
          {heldRung && <PassSeal dict={dict} rung={heldRung} lockReason={passLock.get(c.id) ?? null} />}
        </span>
      ),
      sports: sportsLine(s?.sports ?? [], locale, { name: sportName, count: sportsCount }),
      meta: s
        ? `${plural(dict, "org.home.meta.divisions", s.divisions, locale)}, ${plural(dict, "org.home.meta.entrants", s.entrants, locale)}`
        : null,
      progress: { played: s?.played ?? 0, total: s?.total ?? 0 },
      menu: (
        <CardMenu
          name={c.name}
          tone={tone}
          tap
          items={[
            { label: t(dict, "org.home.menu.schedule"), href: routes.competitionSchedule(orgSlug, c.slug) },
            { label: t(dict, "org.home.menu.settings"), href: routes.competitionSettings(orgSlug, c.slug) },
            { label: t(dict, "org.home.menu.slideshow"), href: routes.slideshowCompetition(c.id), external: true },
            // The pass, where every other per-competition action lives. Absent once held (the chip says so) and absent on a
            // paid plan (`passed` is empty and `paidPlan` suppresses the offer) — never re-sold, never a downgrade. Editors
            // only: the buy itself is owner-only.
            //
            // ...and absent once the COMPETITION is over (v17 gap #353): money for a pass that would apply to nothing, and on
            // the terminal arm unrecoverable (#248 Q4: one pass per competition, forever). `isPassLocked` is the same predicate
            // the seal uses, from the row's own columns — `listCompetitions` already selects `status` and `ends_on` (COLS).
            ...(!paidPlan && !heldRung && canEdit && !isPassLocked(c.status, c.ends_on)
              ? [{ label: t(dict, "pass.menu.buy", { price: passLabel }), href: routes.competitionUpgrade(orgSlug, c.slug) }]
              : []),
          ]}
        />
      ),
    };
  };

  const banded = sorted.map((e) => {
    const s = stats.get(e.c.id);
    return {
      e,
      group: homeGroupOf({
        status: e.c.status,
        played: s?.played ?? 0,
        fixturesToday: today.counts.get(e.c.id) ?? 0,
        // The chip's own division counts (`chipOf` above), so the band and the chip agree on "finished" (UI5 fix round 1, m5).
        divisions: s?.divisions ?? 0,
        divisionsCompleted: s?.divisions_completed ?? 0,
      }),
    };
  });
  const finishedCount = banded.filter((b) => b.group === "finished").length;
  const todayRows: TodayRowData[] = banded
    .filter((b) => b.group === "today")
    .map(({ e }) => ({
      ...base(e, "night"),
      // Today's own headline (C7 review M2), never the card stats' next of any date.
      next: today.next.get(e.c.id) ?? null,
      matchesToday: today.counts.get(e.c.id) ?? 0,
      matchDayHref: routes.competitionMatchDay(orgSlug, e.c.slug),
    }));
  const quiet = (e: Entry, group: HomeGroup): QuietCardData => {
    const s = stats.get(e.c.id);
    // A finished competition has nothing coming up as its normal state, and no next step: B's stub is for one still running.
    const kind = group === "finished" ? null : stubOf({ total: s?.total ?? 0, next: s?.next ?? null });
    // The stub's action is an editor's: a viewer is shown the state, never a button for work the landing page will not let
    // them do (the desk ledger's rule).
    const action =
      !kind || !canEdit
        ? null
        : kind === "no_fixtures"
          ? {
              href: routes.competition(orgSlug, e.c.slug),
              label: t(dict, "org.home.stub.setUp"),
              aria: t(dict, "org.home.stub.setUpFor", { name: e.c.name }),
            }
          : {
              href: routes.competitionSchedule(orgSlug, e.c.slug),
              label: t(dict, "org.home.stub.schedule"),
              aria: t(dict, "org.home.stub.scheduleFor", { name: e.c.name }),
            };
    return { ...base(e, "light"), next: nextLine(s?.next ?? null, { locale, tz: today.tz, day: today.day, vs: t(dict, "schedule.vs") }), stub: kind ? { kind, action } : null };
  };
  const roster = ROSTER.filter((r) => r.group !== "finished" || showFinished)
    .map((r) => ({ ...r, cards: banded.filter((b) => b.group === r.group).map((b) => quiet(b.e, b.group)) }))
    .filter((r) => r.cards.length > 0);
  const visible = todayRows.length + roster.reduce((n, r) => n + r.cards.length, 0);

  return (
    <>
      <BillingBanner orgId={org.id} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="page-title">{t(dict, "org.home.title")}</h1>
              <span className={`badge ${roleBadge(org.role)}`}>{org.role}</span>
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {canEdit ? t(dict, "org.home.subtitle.editor") : t(dict, "org.home.subtitle.viewer")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Nothing to toggle - no finished competition - prints nothing at all. A link wearing role="switch" with the
                state in aria-checked, as the competition page's ledger does it (`SwitchLink`: Space toggles as Enter does). */}
            {finishedCount > 0 && (
              <SwitchLink
                href={showFinished ? routes.orgHome(orgSlug) : `${routes.orgHome(orgSlug)}?finished=1`}
                role="switch"
                aria-checked={showFinished}
                data-testid="org-home-finished-toggle"
                className="btn btn-ghost min-h-11 gap-2 border-transparent bg-transparent px-2 text-sm text-slate-700 hover:bg-purple-50"
              >
                <span
                  aria-hidden="true"
                  className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors motion-reduce:transition-none ${showFinished ? "bg-purple-600" : "bg-slate-300"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${showFinished ? "translate-x-4" : ""}`}
                  />
                </span>
                {t(dict, "org.home.showFinished", { n: finishedCount })}
              </SwitchLink>
            )}
            {/* The Sponsors hub (R4; owner rulings 2026-10-31 "a" and 2026-11-01). The top bar carries a labelled Sponsors
                link but hides it under 350px (390px for an org with a logo), so this entry is the way in at EVERY width: no breakpoint hides it, and it is
                shown to every role (the hub gives a non-editor its read-only Overview and Sponsors, as Settings → Sponsors did). */}
            <Link href={routes.orgSponsors(orgSlug)} data-testid="org-home-sponsors" className="btn btn-ghost min-h-11">
              {t(dict, "sponsors.title")}
            </Link>
            {canEdit && (
              <Link href={routes.competitionNew(orgSlug)} data-tour="new-competition" className="btn btn-primary min-h-11">
                {t(dict, "org.home.newCompetition")}
              </Link>
            )}
          </div>
        </div>

        {competitions.length === 0 ? (
          canEdit ? (
            <div className="mt-12 flex flex-col items-center gap-6 text-center">
              {/* An unlit stadium waiting for a season (spec §5). */}
              <div className="app-empty-tile grid h-16 w-16 place-items-center rounded-2xl">
                <Trophy className="h-8 w-8" strokeWidth={1.5} />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-slate-800">{t(dict, "card.empty.competitions")}</h2>
              </div>
              <Link href={routes.competitionNew(orgSlug)} className="btn btn-primary">
                {t(dict, "card.empty.competitions.cta")}
              </Link>
            </div>
          ) : (
            <p className="text-sm text-slate-500">{t(dict, "org.home.empty.viewer")}</p>
          )
        ) : visible === 0 ? (
          // Every competition is finished and hidden: the page says so and the switch above is the way out - never an empty
          // page, which would read as "this organisation has no competitions" (the desk ledger's own rule).
          <p data-testid="org-home-all-finished" className="card p-6 text-center text-sm text-slate-500">
            {t(dict, "org.home.allFinished")}
          </p>
        ) : (
          <>
            {todayRows.length > 0 ? (
              <TodayDeck rows={todayRows} dict={dict} locale={locale} tz={today.tz} day={today.day} />
            ) : (
              <TodayEmpty dict={dict} locale={locale} day={today.day} />
            )}
            {roster.map((r) => (
              <HomeGroupSection key={r.group} group={r.group} title={t(dict, r.title)} count={r.cards.length}>
                {r.cards.map((card) => (
                  <QuietCard key={card.slug} card={card} dict={dict} />
                ))}
              </HomeGroupSection>
            ))}
          </>
        )}
      </main>
    </>
  );
}

function roleBadge(role: string): string {
  if (role === "owner") return "bg-amber-100 text-amber-700";
  if (role === "admin") return "bg-purple-100 text-purple-700";
  return "bg-slate-100 text-slate-600";
}
