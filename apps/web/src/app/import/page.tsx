export const dynamic = "force-dynamic";
// Bulk participant import wizard (Jul3/01, PROMPT-21): upload → column map →
// preview (the plan, rendered) → commit.
import Link from "next/link";
import { BackLink } from "@/components/back-link";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { orgPlanKey } from "@/lib/entitlements";
import { viewerPlanFrom } from "@/lib/viewer-plan";
import { ImportWizard } from "@/components/v2/import-wizard";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function ImportPage() {
  const { auth } = await requirePageAuth();
  // Every paywall states the viewer's plan (v18 W3-B). This page had
  // discarded the auth it was already awaiting; `requirePageAuth()` always
  // resolves an org, so there is nothing here that cannot answer.
  const viewerPlan = viewerPlanFrom(await orgPlanKey(auth.orgId));
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <BackLink href="/dashboard" label={t(ui, "common.dashboard")} />
        <div className="mb-6">
          <p className="app-eyebrow mb-1">{t(ui, "import.eyebrow")}</p>
          <h1 className="page-title">
            {t(ui, "import.title")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t(ui, "import.desc.pre")}{" "}
            <Link href="/dashboard" className="underline">
              {t(ui, "import.desc.link")}
            </Link>{" "}
            {t(ui, "import.desc.post")}
          </p>
        </div>
        {/* Bulk import is a global tool, not org-scoped in server scope here
            (v18 W3-B rule C) — "unknown" is the honest answer. */}
        <ImportWizard viewerPlan={viewerPlan} />
      </main>
    </DictProvider>
  );
}
