export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { TemplateGallery } from "@/components/v2/template-gallery";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
// Server Component only — see template-gallery.tsx's header for why the
// client island receives this as a prop rather than importing it itself.
import { TEMPLATE_CATALOG } from "@/server/templates/catalog";

export default async function NewCompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { canEdit } = await requireOrgPage(orgSlug);
  if (!canEdit) redirect(routes.orgHome(orgSlug));
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  return (
    <main className="mx-auto max-w-4xl px-4 py-8" data-tour="competition-wizard">
      <h1 className="mb-6 text-xl font-semibold tracking-tight text-slate-900">
        {t(dict, "comp.new.title")}
      </h1>
      <TemplateGallery orgSlug={orgSlug} templates={TEMPLATE_CATALOG} />
    </main>
  );
}
