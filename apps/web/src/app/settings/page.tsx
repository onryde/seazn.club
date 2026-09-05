export const dynamic = "force-dynamic";
// Legacy settings — org-scoped now (PROMPT-30). Forwards the WHOLE query, the
// same way /settings/billing, /settings/connect and /settings/payments do.
//
// It used to forward `tab` alone, which quietly ate the only other param the
// destination reads: `/api/auth/change-email/confirm` redirects all five of its
// outcomes to `/settings?tab=account&email_change=success|invalid|expired|
// taken|error` (confirm/route.ts:26-57), and the org-scoped page renders its
// banner off exactly that param (o/[orgSlug]/settings/page.tsx:270). Dropping
// it here landed every email-change confirmation — success and "that address is
// taken" alike — on an identical bannerless page.
import { redirect } from "next/navigation";
import { requirePageAuth } from "@/server/page-auth";
import { getCurrentUser } from "@/lib/auth";
import { routes } from "@/lib/routes";

export default async function LegacySettings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => v !== undefined) as [string, string][],
  ).toString();

  // Auth is checked HERE, before requirePageAuth(), for one reason: its
  // unauthenticated branch is a bare `redirect("/login")` (page-auth.ts:37)
  // that carries no destination, and it runs before any of the forwarding
  // below. That is the DEFAULT path for the query this shim exists to carry —
  // /api/auth/change-email/confirm needs no session (it acts on the token
  // alone) and its link is mailed to the user's NEW address, so it is normally
  // opened in a browser with no seazn cookie. Without this, the address change
  // commits and the outcome is still discarded, one hop later than before.
  //
  // `next` round-trips through machinery that already exists: AuthForm forwards
  // it to the magic-link/signup/google routes, safeNextPath rejects anything
  // not a site-relative path (so no open redirect), and postAuthLanding honours
  // it. Coming back here signed in, the forward below runs normally.
  const target = `/settings${qs ? `?${qs}` : ""}`;
  if (!(await getCurrentUser())) redirect(`/login?next=${encodeURIComponent(target)}`);

  const { org } = await requirePageAuth();
  redirect(routes.orgSettings(org.slug) + (qs ? `?${qs}` : ""));
}
