// The player's payment page, /r/pay/[token] (plan 2026-11-11-player-payment-page, Task 4): the page a reminder mail links, instead
// of a raw Stripe Checkout URL. No login. It follows the sponsor pages' contract (../sponsor/[token]/page.tsx) exactly:
//   - the token is looked up by its hash and never logged or shape-checked (`payPageDocByToken`): an unknown, malformed, withdrawn
//     or rejected entry is the same opaque 404 (./not-found.tsx);
//   - per request, never cached (`force-dynamic`): the entry's state AT VIEW TIME decides what it shows;
//   - noindex, nofollow, no referrer; the scrubbers drop the token from analytics, Sentry and replay (`/r/pay/` in
//     lib/scrub-score-url.ts) and the one element that paints it (the Pay form) is `ph-no-capture`.
// Rate-limited per client IP by `publicRateLimit` BEFORE the lookup: a throttled visit gets its own screen and touches no row.
//
// A Stripe return (`?checkout=success&session_id=...`) is reconciled once - `reconcileRegistrationByPaySession` compares the
// session to the entry's own pay session before any Stripe call - and the page re-read; a payment the webhook has not recorded
// yet shows "confirming" and the island polls. A `session_id` that is not the entry's current one changes nothing.
//
// The entry is in ITS language (the mail's: `doc.locale`); the head, the 404 and the throttled screen are in the reader's, since
// they are answered before - or without - knowing which entry.
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { isPayConfirming, registrationPayPath, type PayPageQuery } from "@/lib/registration-pay";
import { PayPageNotice, PayPageView } from "@/components/registrations/pay-page-view";
import { log } from "@/server/logger";
import { payPageDocByToken, reconcileRegistrationByPaySession } from "@/server/usecases/registrations";
import { publicRateLimit } from "@/server/usecases/public";

export async function generateMetadata(): Promise<Metadata> {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return {
    title: t(ui, "regPay.meta.title"),
    description: t(ui, "regPay.meta.description"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/** True when this client is over the public read budget. Any other limiter failure is a real error. */
async function throttled(): Promise<boolean> {
  try {
    await publicRateLimit(new Request("http://registration-pay.invalid/", { headers: await headers() }));
    return false;
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return true;
    throw err;
  }
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  /** Every query param, untyped on purpose: only `checkout`, `session_id` and `notice` are read. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  if (await throttled()) {
    const ui = await getDictionary(await resolveLocale(), "ui");
    return <PayPageNotice testId="pay-throttled" title={t(ui, "regPay.throttled.title")} body={t(ui, "regPay.throttled.body")} />;
  }
  const raw = await searchParams;
  const q: PayPageQuery = { checkout: one(raw.checkout), session_id: one(raw.session_id), notice: one(raw.notice) };

  let doc = await payPageDocByToken(token, new Date());
  if (doc === null) notFound();
  if (q.checkout === "success" && q.session_id) {
    let changed = false;
    try {
      changed = await reconcileRegistrationByPaySession(doc.registrationId, q.session_id);
    } catch (err) {
      // The page must still render: the webhook is the primary path, this is the return's shortcut.
      log.error({ err, registrationId: doc.registrationId }, "registration pay page: reconcile on return failed");
    }
    if (changed) {
      doc = await payPageDocByToken(token, new Date());
      if (doc === null) notFound();
    }
  }
  const ui = await getDictionary(doc.locale, "ui");
  return <PayPageView doc={doc} ui={ui} payAction={`${registrationPayPath(token)}/pay`} confirming={isPayConfirming(doc, q)} />;
}
