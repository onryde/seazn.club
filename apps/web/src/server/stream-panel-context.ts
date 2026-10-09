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
import { isServerFeatureEnabled } from "@/lib/posthog-server";
import type { AuthCtx } from "@/server/api-v1/auth";
import { overlayKeyFor } from "@/server/overlay/overlay-key";
import { AUTO_STOP_AFTER_RESULT_SECONDS, PHONE_LOST_LIVE_MINUTES, tunable } from "@/server/relay/config";
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

/** Capture QR v2 (carry 2, owner 2026-10-04): the PostHog flag that offers the phone-camera option — UI-only (the routes
 *  are not gated). Org-targeted (the `organization` group, keyed by the org id); `fallback: false`, so PostHog
 *  unconfigured or down hides it. `CAPTURE_QR_V2_ALWAYS=1` forces it on — CI and e2e set it; staging and production leave
 *  it unset. Deliberately not NODE_ENV. */
export const CAPTURE_QR_V2_FLAG = "capture-qr-v2";
/** B8 review m-2: the flag is a REMOTE call (no local evaluation), and this loader runs on every fixture-page render —
 *  each `router.refresh()` after a scoring send included. So one answer per (org, distinct id) PAIR — exactly what
 *  PostHog is asked with — is kept for this long, in-process, and shared by every render inside it — the first render's
 *  own call included, so concurrent renders ask once. Keyed on the pair, not the org (B8 re-review n-3): the live flag is
 *  org-aggregated today, but one re-targeted by person must never serve one user's answer to their whole org. A flip in
 *  PostHog shows within a minute; nothing else reads the cache. */
export const CAPTURE_FLAG_TTL_MS = 60_000;
const flagByAsk = new Map<string, { until: number; on: Promise<boolean> }>();
/** Test seam: forget every cached answer (each test starts from a cold process). */
export function forgetCaptureFlagCache(): void {
  flagByAsk.clear();
}
async function phoneCaptureOffered(auth: AuthCtx): Promise<boolean> {
  if (process.env.CAPTURE_QR_V2_ALWAYS === "1") return true;
  const now = Date.now();
  const distinctId = auth.userId ?? auth.orgId;
  // JSON, so no id can run into the other: ["a|b","c"] and ["a","b|c"] are different keys.
  const key = JSON.stringify([auth.orgId, distinctId]);
  const hit = flagByAsk.get(key);
  if (hit && now < hit.until) return hit.on;
  // `isServerFeatureEnabled` never rejects (PostHog down → the `false` fallback), so a cached promise is an answer.
  const on = isServerFeatureEnabled(CAPTURE_QR_V2_FLAG, distinctId, { orgId: auth.orgId, fallback: false });
  // Bounded: an expired answer is dropped whenever the map grows past a thousand pairs.
  if (flagByAsk.size >= 1000) for (const [k, v] of flagByAsk) if (now >= v.until) flagByAsk.delete(k);
  flagByAsk.set(key, { until: now + CAPTURE_FLAG_TTL_MS, on });
  return on;
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
  // The capture-qr-v2 flag rides the same Promise.all: an independent read, only with the panel (`entitled`).
  const relayOn = relayEntitled && !relayDisabled;
  const [credits, currency, phoneCapture] = await Promise.all([
    relayOn ? relayCredits(auth, auth.orgId) : null,
    relayOn ? preferredCurrency(auth.orgId) : ("gbp" as const),
    entitled ? phoneCaptureOffered(auth) : false,
  ]);
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
    // Capture QR v2 (carry 2): false hides the Phone tab (the phone-camera option) and nothing else.
    phoneCapture,
    // W19 (§6.8.5): the window the ended chip names — the tick's own expression (stream-sessions.ts), so an override the
    // tick honours (ci/local) is the number the organiser reads, and one it ignores is not. No read: a constant and env.
    phoneLostMinutes: tunable("PHONE_LOST_LIVE_MINUTES", PHONE_LOST_LIVE_MINUTES),
    // PR-2 T10 (§7.1): "stops about {n} minutes after the result" — the auto stop's delay as the tick reads it
    // (stream-sessions.ts), in whole minutes and never below 1 ("about 0 minutes" is not a sentence). No read.
    autoStopMinutes: Math.max(1, Math.round(tunable("AUTO_STOP_AFTER_RESULT_SECONDS", AUTO_STOP_AFTER_RESULT_SECONDS) / 60)),
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
