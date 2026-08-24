export const dynamic = "force-dynamic";
// Registration hub shell (RS004 W2): route, two-tab chrome, guard, and
// fully designed placeholders (never an unfinished-stub string) for both tabs.
//
// `?tab=settings|registrants` is read server-side, mirroring the division
// page's pattern (d/[divSlug]/page.tsx:77-118) — there is no shared TabStrip
// component and no client tabs component in this repo, so this inlines its
// own <nav> the same way that page does.
//
// Settings' real content (division rows + the row-click config panel) is
// RS004 W3; Registrants' real content is RS005. This wave ships the frame
// only — see docs/superpowers/specs/2026-08-16-registration-redesign-
// prompts/{RS004-hub-settings-tab.md,RS005-hub-registrants-tab.md}.
import { notFound } from "next/navigation";
import Link from "@/components/ui/console-link";
import { requireCompetitionPage } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import {
  REGISTRATION_HUB_TABS,
  resolveRegistrationHubTab,
  type RegistrationHubTab,
} from "@/components/registration-hub-tab";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { RegistrationHubRegistrantsPanel } from "@/components/registration-hub-registrants-panel";

export default async function RegistrationHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ orgSlug, compSlug }, { tab: rawTab }] = await Promise.all([params, searchParams]);
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/registration" });
  const { auth, canEdit } = page;
  // requireCompetitionPage (page-auth.ts:192-201) only 404s a SCORER — a
  // viewer reaches it fine with canEdit:false. Registration data (contacts,
  // payment state) is more sensitive than the read-only competition-settings
  // page a viewer may already open, so this hub is owner/admin only, matching
  // the RS004 prompt's scope item 1 ("Owner/admin only … scorer/viewer never
  // see the nav entry") — the extra role check is this page's own.
  if (!canEdit) notFound();
  const id = page.competition.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const competition = await getCompetition(auth, id);
  const tab: RegistrationHubTab = resolveRegistrationHubTab(rawTab);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="page-title mb-6">{t(dict, "reg.hub.title", { name: competition.name })}</h1>

      <nav className="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200">
        {REGISTRATION_HUB_TABS.map((tabKey) => (
          <Link
            key={tabKey}
            href={routes.competitionRegistration(orgSlug, compSlug, tabKey)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === tabKey
                ? "border-purple-600 text-purple-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t(dict, `reg.hub.tab.${tabKey}`)}
          </Link>
        ))}
      </nav>

      {tab === "registrants" ? (
        <RegistrationHubRegistrantsPanel
          title={t(dict, "reg.hub.registrants.title")}
          body={t(dict, "reg.hub.registrants.body")}
          ctaLabel={t(dict, "reg.hub.registrants.cta")}
          ctaHref={routes.competitionRegistration(orgSlug, compSlug, "settings")}
        />
      ) : (
        <RegistrationHubSettingsPanel
          title={t(dict, "reg.hub.settings.title")}
          body={t(dict, "reg.hub.settings.body")}
        />
      )}
    </main>
  );
}
