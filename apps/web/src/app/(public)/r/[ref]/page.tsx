export const dynamic = "force-dynamic";
// Public registration status by reference (v3/05 §3, PROMPT-34; RS006
// re-point). The ref is a lookup, not auth — this shows nothing beyond the
// success screen (see publicCartByRef's own doc comment for exactly what
// that excludes), and self-withdraw still needs the emailed token (?token=).
// Doubles as the organiser's day-of check-in lookup.
//
// RS001 stubbed this page to an unconditional "registration is closed" on
// the premise that nothing could submit a registration yet. RS002/RS003
// invalidated that — registrations submit for real now, including
// Stripe-paid ones — so this re-points at the real read model.
//
// RS006 also settled a question `regByRef`'s own comment used to leave to
// RS007: a cart can hold more than one entry now, so this shows the WHOLE
// cart via `publicCartByRef` (masked per entry), not just the oldest one.
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import QRCode from "qrcode";
import {
  publicCartByRef,
  reconcileRegistrationBySession,
} from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { TearOffTicket } from "@/components/public-site/ticket";
import { WithdrawByRef } from "@/components/public-site/withdraw-by-ref";
import { ShareButton } from "@/components/share-button";
import { baseUrlFromHeaders } from "@/lib/base-url";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ ref: string }>;
  searchParams: Promise<{ token?: string; checkout?: string; session_id?: string }>;
};

export default async function RefStatusPage({ params, searchParams }: Props) {
  const [{ ref }, { token, checkout, session_id }] = await Promise.all([params, searchParams]);
  const refCode = decodeURIComponent(ref);

  // Token-free checkout return (email-minted sessions —
  // registrations.ts's own createRegistrationCheckout mints
  // `/r/{ref}?src=email` as returnBase, then appends exactly
  // `&checkout=success&session_id={CHECKOUT_SESSION_ID}` on success):
  // reconcile BEFORE the read so a paid cart shows confirmed even ahead of
  // the webhook. Best-effort — reconcileRegistrationBySession never throws.
  if (checkout === "success" && session_id) {
    await reconcileRegistrationBySession(refCode, session_id);
  }

  let view;
  try {
    view = await publicCartByRef(refCode, token ?? null);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }

  const origin = await baseUrlFromHeaders();
  const qrDataUrl = await QRCode.toDataURL(`${origin}/r/${view.ref_code}`, {
    margin: 1,
    width: 224,
  });
  const competitionHref = `/shared/${view.org_slug}/${view.competition_slug}`;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <main className="mx-auto max-w-xl px-4 py-10">
        <TearOffTicket
          refCode={view.ref_code}
          entries={view.entries.map((e) => ({
            id: e.id,
            status: e.status,
            displayName: e.display_name,
            divisionName: e.division_name,
          }))}
          competitionName={view.competition_name}
          orgName={view.org_name}
          startsOn={view.starts_on}
          endsOn={view.ends_on}
          qrDataUrl={qrDataUrl}
          locale={locale}
          actions={
            <>
              <Link
                href={competitionHref}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500"
              >
                {t(ui, "ref.viewDashboard")}
              </Link>
              {/* v3/10 #2 — "I'm in!" straight to the family group chat. */}
              <ShareButton
                title={view.competition_name}
                text={t(ui, "ref.shareTextCart", {
                  competition: view.competition_name,
                  ref: view.ref_code,
                })}
                url={competitionHref}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500"
              />
              {view.can_withdraw && token && (
                <WithdrawByRef refCode={view.ref_code} token={token} />
              )}
            </>
          }
        />
      </main>
    </DictProvider>
  );
}
