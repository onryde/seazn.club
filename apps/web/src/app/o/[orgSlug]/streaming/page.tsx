export const dynamic = "force-dynamic";
// The org's Streaming page (owner, 2026-10-27, amending spec D3): where your matches stream to, on a top-nav page of its own.
// It was the Directory's fifth tab; the Directory keeps four, and nothing forwards from `/directory?tab=streaming` (owner:
// "we don't need a forward") — an unknown tab simply opens the first one, as it always did.
//
// Offered in full exactly when the fixture panel offers Go live (`streamingPageOffered`, the predicate the connect start asks too):
// entitled to the panel AND the relay, on a deployment that can start a stream. An editor of an org that is NOT offered it, but still
// holds a YouTube connection, gets the disconnect-only page (T18, DP III: a downgrade never strands a grant) - `streamingPageAccess`,
// which the nav item asks too. Otherwise a real 404, and no destination is read — a stream key is only ever used by Go live, so a
// page for an org that cannot go live has nothing to show.
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { DictProvider } from "@/components/i18n/dict-provider";
import { StreamDestinationsPanel } from "@/components/v2/stream-destinations-panel";
import { YoutubeDisconnectOnlyPanel } from "@/components/v2/youtube-disconnect-only-panel";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { baseUrlFromHeaders } from "@/lib/base-url";
import { captureError } from "@/lib/sentry";
import { HttpError } from "@/lib/errors";
import { youtubeLandingFrom } from "@/lib/youtube";
import { searchOf } from "@/lib/routes";
import { requireOrgPage } from "@/server/page-auth";
import { streamingPageAccess } from "@/server/stream-panel-context";
import { listStreamTargets, seaznOfferOf } from "@/server/usecases/stream-targets";
import { seaznHostedLive } from "@/server/relay/config";
import { defaultDeps, expireTargetHolders } from "@/server/usecases/stream-sessions";

/** Task 33b: the org's Seazn switch for the Seazn Hosted card, read ONLY with SEAZN_HOSTED_LIVE on (off, nothing offers Seazn and the
 *  page draws no card). Read from the switch itself, never from the list: the list leaves Seazn out while the switch is off, and the card
 *  is the one control that turns it back on. An org with no active Seazn row (no product path makes one: V541's trigger makes it, and
 *  removing it is refused) is reported and gets the page without the card — never an error page in place of its own channels. */
async function seaznSwitchOf(orgId: string): Promise<{ offered: boolean } | null> {
  if (!seaznHostedLive()) return null;
  try {
    return await seaznOfferOf(orgId);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err;
    captureError(err, { orgId, route: "streaming.seazn_offer" });
    return null;
  }
}

// Spec 2026-09-30 §4 (D1) — the ONE place streaming destinations are managed. Every member sees the list; Add / Rename /
// Replace key / Remove render only for canEdit (owner or admin), matching the API's write gate. Read server-side
// through the same use-case the API serves, so the list, its key hints and its "in use" badges are the API's projection,
// never a second query.
export default async function StreamingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ youtube?: string | string[]; pending?: string | string[]; disconnected?: string | string[] }>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;
  // The ADDRESS decides the org (owner, 2026-11-18), never the seazn_org cookie: members only, a non-member 404s, and a renamed
  // org's old URL goes to the new one with its query (the connect landing's `?youtube=` included).
  const { auth, canEdit, org } = await requireOrgPage(orgSlug, { tail: "/streaming", search: searchOf(query) });
  const access = await streamingPageAccess(auth.orgId, canEdit);
  // An editor who has just disconnected the LAST channel of an org that cannot go live is sent here by the restricted page itself
  // (`STREAMING_DISCONNECTED_HREF`): the page re-renders so its nav drops the item, and must not turn into the 404 under the person
  // who is reading the confirmation. It lists nothing - there is nothing - and the query opens nothing else: every other case
  // (a viewer, any other value, no query) is the 404 it always was.
  const justEmptied = access === "none" && canEdit && query.disconnected === "1";
  if (access === "none" && !justEmptied) notFound();
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  if (access === "disconnect_only" || justEmptied) {
    // The channels only: no pasted key is read, no holder expiry is run, and the page says nothing of going live.
    const channels = justEmptied ? [] : await listStreamTargets(auth, auth.orgId, { channelsOnly: true });
    return (
      <DictProvider dict={ui} locale={locale}>
        <main className="mx-auto max-w-4xl px-4 py-8">
          <BackLink href="/dashboard" label={t(ui, "common.dashboard")} />
          <div className="mb-6">
            <p className="app-eyebrow mb-1">{t(ui, "streaming.eyebrow")}</p>
            <h1 className="page-title">{t(ui, "streaming.title")}</h1>
            <p data-testid="streaming-org" className="mt-1 text-sm font-medium text-slate-700">{org.name}</p>
          </div>
          <YoutubeDisconnectOnlyPanel orgId={auth.orgId} targets={channels} />
        </main>
      </DictProvider>
    );
  }

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
  const [targets, seazn] = await Promise.all([listStreamTargets(auth, auth.orgId), seaznSwitchOf(auth.orgId)]);
  // Where the YouTube connect round trip landed (`?youtube=<code>[&pending=<id>]`): read once, here, into the one shape the panel takes.
  const landing = youtubeLandingFrom(query);

  return (
    <DictProvider dict={ui} locale={locale}>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <BackLink href="/dashboard" label={t(ui, "common.dashboard")} />
        <div className="mb-6">
          <p className="app-eyebrow mb-1">{t(ui, "streaming.eyebrow")}</p>
          <h1 className="page-title">{t(ui, "streaming.title")}</h1>
          <p data-testid="streaming-org" className="mt-1 text-sm font-medium text-slate-700">{org.name}</p>
          <p className="mt-1 max-w-xl text-sm text-slate-500">{t(ui, "streaming.desc")}</p>
        </div>
        <StreamDestinationsPanel orgId={auth.orgId} canEdit={canEdit} targets={targets} locale={locale} landing={landing} seazn={seazn} />
      </main>
    </DictProvider>
  );
}
