export const dynamic = "force-dynamic";
import Link from "next/link";
import { BackLink } from "@/components/back-link";
import { redirect } from "next/navigation";
import { getCurrentUser, getUserOrgs } from "@/lib/auth";
import { newOrgDestination } from "@/server/page-auth";
import { Nav } from "@/components/nav";
import { CreateOrgForm } from "@/components/create-org-form";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function NewOrgPage({
  searchParams,
}: {
  // App Router hands these in as a promise in this Next (16.2.9) — the same
  // shape the /settings shim next door awaits. Reading it without awaiting
  // yields a promise object, not params.
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const orgs = await getUserOrgs(user.id);
  // Where the org-less bounce was headed before it landed here (`requirePageAuth`
  // → `orgLessRedirect`). Refused or absent → null, and the form keeps its
  // /dashboard default, i.e. exactly today's behaviour.
  const next = newOrgDestination(await searchParams);
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-md px-4 py-10">
        {orgs.length > 0 && <BackLink href="/dashboard" label={t(ui, "common.dashboard")} />}
        <div className="mb-6 text-center">
          <h1 className="page-title">
            {t(ui, "orgNew.title")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t(ui, "orgNew.subtitle")}
          </p>
        </div>
        {/* The bill picker links a FULL bill to its Add-ons tab (v17 gap #293),
            and every /o page is member-gated — so it needs org ids the visitor
            can open. */}
        <CreateOrgForm
          memberOrgIds={orgs.map((o) => o.id)}
          next={next}
        />
        {orgs.length > 0 && (
          <p className="mt-4 text-center text-sm text-slate-500">
            {t(ui, "orgNew.alreadyHave")}{" "}
            <Link href="/dashboard" className="text-purple-700 hover:underline">
              {t(ui, "orgNew.goToBoard")}
            </Link>
          </p>
        )}
      </main>
    </DictProvider>
  );
}
