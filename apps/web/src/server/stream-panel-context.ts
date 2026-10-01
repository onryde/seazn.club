import "server-only";
// server/stream-panel-context.ts — THE authority for the stream panel's per-page context (spec 2026-09-30 §2 "Shared
// context loader"). Moved from the division page (Stream Overlay W1 task 6 + Streaming R1 lane D); the fixture page is
// now its main caller. Every comment below the header came with the code.
//
// Cost, accepted and measured (plan review #11): this runs on every render of the fixture page for an organiser with
// Stream offered, including each `router.refresh()` after a scoring `send`. Each dependency is read AT MOST once per
// call (pinned: stream-panel-context.test.ts "the loader's reads"), and `offered: false` — a spectator, a scorer without
// `canEdit`, a frozen page — returns before any read.
import type { StreamPanelContext } from "@/components/v2/fixture-stream-panel";
import { hasFeature } from "@/lib/entitlements";
import { getDictionary, type Locale } from "@/lib/i18n";
import { preferredCurrency } from "@/lib/currency-server";
import type { AuthCtx } from "@/server/api-v1/auth";
import { overlayKeyFor } from "@/server/overlay/overlay-key";
import { relayUnavailable } from "@/server/relay/drivers";
import { reconcileStreamCreditsCheckout } from "@/server/usecases/stream-credits-checkout";
import { relayCredits } from "@/server/usecases/stream-sessions";

/** The ONE decision of whether Stream is offered, and how far (M-5, final review: the Directory's Streaming tab asks
 *  this too, so it and the fixture panel cannot disagree). `entitled` is the panel (`streaming.overlay`); `relayEntitled`
 *  adds the Phone tab's relay (`streaming.relay`, read only when entitled); `relayDisabled` is a relay-entitled org on a
 *  deployment that cannot start a stream.
 *
 *  I2 (Task 14b review): a deployment with no relay (R5 — RELAY_DRIVERS unset in production) refuses every start and
 *  every pack checkout, so the Phone tab shows that instead of buy tiles and Go live. It also skips the credits read in
 *  the loader below: that read GRANTS the month's free credits, and a relay-less deployment has no business writing them.
 *  N1 (fix round 2): asked WITHOUT constructing the drivers — a live deploy missing a Cloudflare secret must not take the
 *  page down. m1 (lane-close review): nor may it offer Go live and buy tiles — such a deploy cannot start anything, so
 *  it reads as unavailable too (drivers.ts `relayUnavailable`).
 *
 *  `competitionId` scopes both reads the way the overlay route's own gate does (an Event Pass grants for the competition
 *  it was bought for); without one — the org-wide Directory — they resolve for the org. */
export async function relayOffer(
  orgId: string, competitionId?: string,
): Promise<{ entitled: boolean; relayEntitled: boolean; relayDisabled: boolean }> {
  const entitled = await hasFeature(orgId, "streaming.overlay", competitionId);
  const relayEntitled = entitled && (await hasFeature(orgId, "streaming.relay", competitionId));
  const relayDisabled = relayEntitled && relayUnavailable();
  return { entitled, relayEntitled, relayDisabled };
}

export async function loadStreamPanelContext(args: {
  auth: AuthCtx;
  competitionId: string;
  sportKey: string;
  /** The fixtures whose OBS URL the panel copies — one per mount point (one on the fixture page). */
  fixtureIds: readonly string[];
  locale: Locale;
  /** The caller's gate: an organiser on an editable, not billing-frozen page. False reads nothing. */
  offered: boolean;
  checkout?: { status?: string; sessionId?: string };
}): Promise<StreamPanelContext | undefined> {
  if (!args.offered) return undefined;
  const { auth, competitionId } = args;
  // Both entitlement reads carry the competition id, the same way `news.auto` and `embeds.enabled` do and the same way
  // the overlay route's own gate does (`app/overlay/fixtures/[fixtureId]/page.tsx`): an Event Pass grants for the
  // competition it was bought for, so an org-wide resolve would deny a pass holder the fixture they paid for.
  //
  // Everything after the FIRST read is behind `entitled`. Since V426 (Task 14b) every plan grants both keys, so the
  // reads below run; an org a staff override switched off still costs exactly one entitlement query and neither the
  // second read, the `public` dictionary import, nor a byte of it on the RSC flight.
  const { entitled, relayEntitled, relayDisabled } = await relayOffer(auth.orgId, competitionId);
  // G1 (Task 14 fix round 1): the match-credit checkout returns to the FIXTURE page now (relay-checkout/route.ts,
  // `?checkout=success&session_id=…`), and this render can beat Stripe's webhook — so reconcile the session before
  // reading the balance, exactly as the billing, upgrade and registration pages do on their own returns. Best-effort and
  // idempotent (it and the webhook converge on one ledger row), it never throws, and it grants only a COMPLETE
  // match-credit session that names this org.
  if (args.checkout?.status === "success" && args.checkout.sessionId) {
    await reconcileStreamCreditsCheckout(auth.orgId, args.checkout.sessionId);
  }
  // M4 (Task 14 fix round 4): the credits and the currency are independent reads — ledger queries and one
  // cookies/headers read — so they run together, not one after the other. Both only with the relay (D9's query budget).
  // Task 14b (R3b): `relayCredits` grants this month's free match credits BEFORE it reads (idempotent), and answers the
  // balance split by bucket beside the plan's monthly allowance — the chip stays the total.
  const [credits, currency] =
    relayEntitled && !relayDisabled
      ? await Promise.all([relayCredits(auth, auth.orgId), preferredCurrency(auth.orgId)])
      : [null, "gbp" as const];
  return {
    entitled,
    relayEntitled,
    relayDisabled,
    // Streaming R1 lane D: the Phone tab's routes address the org, and its idle state needs the balance before any
    // session exists (C1). Read only when the relay is entitled and running — otherwise the tab shows its switched-off
    // or unavailable state (fixture-stream-panel.tsx), which reads no balance.
    orgId: auth.orgId,
    streamBalance: credits?.total ?? 0,
    // Task 14b (R4): the split behind the chip ("{m} free this month · {p} bought") and the plan's monthly allowance for
    // the credits card's note. Null / 0 without the relay, where no tab reads them.
    streamSplit: credits ? { monthly: credits.monthly, pack: credits.pack, total: credits.total } : null,
    monthlyAllowance: credits?.monthlyAllowance ?? 0,
    // P1: the currency `/api/billing/relay-checkout` will CHARGE — the same `preferredCurrency` for the same org and
    // browser (subscription → cookie → Accept-Language) — so the tiles quote the checkout's own amount. Without the
    // relay there are no tiles, and nothing reads it.
    currency,
    sportKey: args.sportKey,
    // RT (lane-close fix, ruled 2026-09-29): each listed fixture's signed overlay key, for the OBS URL its panel copies —
    // the grant a community org's overlay presents to the realtime-token route. Only with the panel (`entitled`); a
    // fixture the server cannot sign for (no AUTH_SECRET) is left out and its URL goes keyless.
    overlayKeys: entitled
      ? Object.fromEntries(
          args.fixtureIds.flatMap((id) => {
            const key = overlayKeyFor(id);
            return key ? [[id, key] as const] : [];
          }),
        )
      : {},
    // `overlayDict` travels because it has to: the console layout provides the `ui` namespace, the overlay's own copy is
    // `public.overlay.*`, and `getDictionary` is `server-only` so the client island cannot load it. Sliced to that
    // prefix, so the flight carries ~20 strings and not the whole public catalogue.
    overlayDict: entitled
      ? (Object.fromEntries(
          Object.entries(await getDictionary(args.locale, "public")).filter(([k]) => k.startsWith("overlay.")),
        ) as Record<string, string>)
      : {},
  };
}
