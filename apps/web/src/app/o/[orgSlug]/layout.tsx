// Console shell for the /o/[orgSlug] tree (PROMPT-30): one Nav + breadcrumb
// bar for every page underneath — pages stop wiring their own chrome. Auth
// here allows scorers AND non-members through so fixture deep-links can reach
// requireFixturePage (design v2 §A2: an accepted official is usually NOT an
// org member); every non-fixture page re-checks membership and bounces them.
import { Nav } from "@/components/nav";
import { ActiveOrgSync } from "@/components/active-org-sync";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, getActiveOrgId, getUserOrgs } from "@/lib/auth";
import { orgBySlug, breadcrumbNames } from "@/server/slug-resolve";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const resolved = await orgBySlug(orgSlug);
  if (!resolved) notFound();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  // A renamed org is left to the page (review I3): a layout holds only the org slug, so a redirect from here dropped the
  // competition, the division, the tab and the query (the /present kiosk layout's F2, the same rule). Every page under
  // /o redirects through page-auth with its whole path; a page's thrown redirect wins the response, so this bare shell
  // is never what is served.
  if ("renamedTo" in resolved) return <DictProvider dict={ui} locale={locale}>{children}</DictProvider>;

  const orgs = await getUserOrgs(user.id);
  const membership = orgs.find((o) => o.id === resolved.id);

  // Full console chrome only for members. Non-members reaching a fixture
  // deep-link (an accepted official — design v2 §A2) get the stripped courtside
  // shell: no org nav or breadcrumbs, no active-org sync into an org they don't
  // belong to. The child page does the real gate — a non-member hitting
  // anything but the fixture console 404s there.
  const chromed = !!membership;
  if (!chromed) {
    return (
      <DictProvider dict={ui} locale={locale}>
        {membership && <ActiveOrgSync orgId={resolved.id} stale={false} />}
        {children}
      </DictProvider>
    );
  }

  const [activeOrgId, names] = await Promise.all([
    getActiveOrgId(),
    breadcrumbNames(resolved.id),
  ]);
  return (
    <DictProvider dict={ui} locale={locale}>
      {/* The path owns which org the chrome shows; the cookie is corrected
          afterwards by ActiveOrgSync, so the nav must not wait for it. */}
      <Nav orgSlug={resolved.slug} />
      <ActiveOrgSync orgId={resolved.id} stale={activeOrgId !== resolved.id} />
      <Breadcrumbs orgName={resolved.name} names={names} />
      {children}
    </DictProvider>
  );
}
