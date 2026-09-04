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
import { routes } from "@/lib/routes";

export default async function LegacySettings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ org }, sp] = await Promise.all([requirePageAuth(), searchParams]);
  const qs = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => v !== undefined) as [string, string][],
  ).toString();
  redirect(routes.orgSettings(org.slug) + (qs ? `?${qs}` : ""));
}
