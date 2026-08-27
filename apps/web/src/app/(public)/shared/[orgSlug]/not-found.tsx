// Branded 404 for anything under /shared/[orgSlug]/** whose org itself
// doesn't resolve — a reserved slug, or an org that no longer exists
// ([orgSlug]/layout.tsx's own notFound() calls, doc 09 §1). Before this
// file existed there was no not-found.tsx anywhere in the app, so Next's
// notFound() bubbled all the way to its bare, unbranded built-in page —
// exactly what every registration status link 404s to once its token
// rotates, its entry is cancelled, or old mail gets forwarded. (That
// page's OWN bad-rid/bad-token case is a different, already-handled
// branch inside register/status/page.tsx — this file only catches the
// org-level miss that happens BEFORE that page ever runs.)
//
// Deliberately renders no org/competition data: notFound() fires before
// getPublicOrg's result exists, so there is nothing here to leak even by
// accident — a reserved slug and a genuinely nonexistent org hit this
// exact same static output, which is the point (indistinguishable, per
// the layout's own "no existence leak" comment). Next auto-injects
// `<meta name=robots content=noindex>` and a 404 status for any page
// reached via notFound() — nothing extra to do here for either.
import Link from "next/link";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";

export default async function SharedOrgNotFound() {
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-16 text-center">
      <div aria-hidden className="mb-6 h-0.5 w-10 bg-accent" />
      <h1 className="font-display text-2xl font-semibold text-ink">{t(ui, "shared.notFound.heading")}</h1>
      <p className="mt-2 max-w-sm text-sm text-ink-muted">{t(ui, "shared.notFound.body")}</p>
      <Link href="/" className="mt-6 text-sm font-medium text-accent-strong underline underline-offset-2">
        {t(ui, "shared.notFound.cta")}
      </Link>
    </div>
  );
}
