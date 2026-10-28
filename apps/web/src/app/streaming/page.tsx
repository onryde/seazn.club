export const dynamic = "force-dynamic";
// The org's Streaming page (owner, 2026-10-27, amending spec D3): where your matches stream to, on a top-nav page of its own.
// It was the Directory's fifth tab; the Directory keeps four, and nothing forwards from `/directory?tab=streaming` (owner:
// "we don't need a forward") — an unknown tab simply opens the first one, as it always did.
//
// Offered exactly when the fixture panel offers Go live (`streamingPageOffered`, the one predicate the nav item and the connect
// start ask too): entitled to the panel AND the relay, on a deployment that can start a stream. Otherwise a real 404, and no
// destination is read — a stream key is only ever used by Go live, so a page for an org that cannot go live has nothing to show.
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { Nav } from "@/components/nav";
import { DictProvider } from "@/components/i18n/dict-provider";
import { StreamDestinationsPanel } from "@/components/v2/stream-destinations-panel";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { baseUrlFromHeaders } from "@/lib/base-url";
import { captureError } from "@/lib/sentry";
import { youtubeLandingFrom } from "@/lib/youtube";
import { requirePageAuth } from "@/server/page-auth";
import { streamingPageOffered } from "@/server/stream-panel-context";
import { listStreamTargets } from "@/server/usecases/stream-targets";
import { defaultDeps, expireTargetHolders } from "@/server/usecases/stream-sessions";

// Spec 2026-09-30 §4 (D1) — the ONE place streaming destinations are managed. Every member sees the list; Add / Rename /
// Replace key / Remove render only for canEdit (owner or admin), matching the API's write gate. Read server-side
// through the same use-case the API serves, so the list, its key hints and its "in use" badges are the API's projection,
// never a second query.
export default async function StreamingPage({ searchParams }: { searchParams: Promise<{ youtube?: string | string[]; pending?: string | string[] }> }) {
  const { auth, canEdit } = await requirePageAuth();
  if (!(await streamingPageOffered(auth.orgId))) notFound();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  // M-3 (final review): every holder of the org's destinations gets its lazy expiry BEFORE the list is read. The list's
  // "In use" lock disables Replace and Remove — the very buttons whose routes tick a held target — so an abandoned Go
  // live otherwise kept the lock up until someone opened that match or the daily sweep ran. Nothing due: no change.
  // R-3 (re-review): BEST-EFFORT. A due expiry's effect can throw (a provider call recordEffect rethrows); that is
  // reported once and the list is read anyway — the lock is then merely stale until the next load, M-3's old state —
  // never an error page in place of the Streaming page.
  try {
    await expireTargetHolders(auth.orgId, null, defaultDeps(await baseUrlFromHeaders()));
  } catch (err) {
    captureError(err, { orgId: auth.orgId, route: "streaming.expire_holders" });
  }
  const targets = await listStreamTargets(auth, auth.orgId);
  // Where the YouTube connect round trip landed (`?youtube=<code>[&pending=<id>]`): read once, here, into the one shape the panel takes.
  const landing = youtubeLandingFrom(await searchParams);

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <BackLink href="/dashboard" label={t(ui, "common.dashboard")} />
        <div className="mb-6">
          <p className="app-eyebrow mb-1">{t(ui, "streaming.eyebrow")}</p>
          <h1 className="page-title">{t(ui, "streaming.title")}</h1>
          <p className="mt-1 max-w-xl text-sm text-slate-500">{t(ui, "streaming.desc")}</p>
        </div>
        <StreamDestinationsPanel orgId={auth.orgId} canEdit={canEdit} targets={targets} locale={locale} landing={landing} />
      </main>
    </DictProvider>
  );
}
