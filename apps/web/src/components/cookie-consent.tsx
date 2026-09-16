"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import {
  CONSENT_KEY,
  CONSENT_VERSION_KEY,
  CONSENT_REOPEN_EVENT,
  COOKIE_POLICY_VERSION,
  needsConsentPrompt,
  type ConsentChoice,
} from "@/lib/consent";
import { readActiveLocale, clientCommon } from "@/lib/client-dict";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n-constants";

/** The one route prefix that renders no chrome at all. Named rather than
 *  inlined so a future overlay route cannot forget it. */
const OVERLAY_SEGMENT = "/overlay/";

/** The kiosk board's own last segment (`/shared/<org>/<comp>[/<div>]/present`). */
const KIOSK_SEGMENT = "present";

/**
 * A /present board (OWNER RULING, 2026-09-16). Same reasoning as the overlay
 * segment: the board is what an organiser puts on a venue TV, where nobody is
 * there to dismiss a banner, so it sits over the board all day — and there is
 * nothing to dismiss, because PostHog inits `opt_out_capturing_by_default` and
 * only opts in on an explicit Accept (`instrumentation-client.ts`), which a
 * banner-free page can never collect. Essential cookies are unaffected.
 *
 * Below the TV cut-off the same route shows the "made for a TV" card, where the
 * banner covered the card's only real control at 320 — the defect this closes.
 * A visitor who taps through to the hub gets the banner there, as before.
 *
 * Matched on the SHAPE of the path, not a bare suffix: a competition slugged
 * "present" is `/shared/<org>/present`, a hub page that must keep its banner.
 */
function isKioskBoard(pathname: string | null | undefined): boolean {
  const parts = pathname?.split("/").filter(Boolean) ?? [];
  // shared / org / comp / present, or shared / org / comp / division / present
  return parts[0] === "shared" && parts.at(-1) === KIOSK_SEGMENT && (parts.length === 4 || parts.length === 5);
}

/**
 * Consent banner. Essential cookies (login) always run; analytics (PostHog) is
 * opt-in per GDPR. "Accept" opts PostHog into capturing; "Reject" keeps it
 * opted out. The choice is remembered so the banner shows once, and can be
 * changed later via a "Cookie settings" control (see CookieSettingsButton),
 * which re-dispatches CONSENT_REOPEN_EVENT to reopen this banner —
 * withdrawal is as easy as granting. instrumentation-client reads the same key
 * on load to decide whether to capture before hydration.
 */
export function CookieConsent() {
  const [visible, setVisible] = useState(false);
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const pathname = usePathname();

  useEffect(() => {
    setLocale(readActiveLocale());
    // Show on first visit, or when the policy version moved on since the
    // visitor last chose (policy change / new third party → re-consent).
    if (needsConsentPrompt()) setVisible(true);
    // Re-open on demand so users can withdraw/change consent at any time.
    const reopen = () => setVisible(true);
    window.addEventListener(CONSENT_REOPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_REOPEN_EVENT, reopen);
  }, []);

  function decide(choice: ConsentChoice) {
    localStorage.setItem(CONSENT_KEY, choice);
    // Stamp the version this choice covers, so a later policy bump re-prompts.
    localStorage.setItem(CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION);
    try {
      if (posthog.__loaded) {
        if (choice === "accepted") {
          posthog.opt_in_capturing();
          posthog.capture("$pageview"); // count the current page now that we may
        } else {
          posthog.opt_out_capturing();
        }
      }
    } catch {
      // Never let an analytics hiccup block dismissing the banner.
    }
    // Server-side proof-of-consent (GDPR). Best-effort — never blocks the UI.
    void fetch("/api/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice, policy_version: COOKIE_POLICY_VERSION }),
    }).catch(() => {});
    setVisible(false);
  }

  // The overlay segment renders no banner (owner answer 13, Q2). OBS
  // composites whatever is painted, so a consent banner burned into a club's
  // broadcast goes out to every viewer until someone dismisses it in the
  // capture browser — and there is nothing to consent to: the segment sets no
  // cookies (proved in stream-overlay.spec.ts, Task 8).
  //
  // WHY HERE, and not in the overlay layout. `CookieConsent` is mounted ONCE,
  // in the ROOT layout (`app/layout.tsx`), as a SIBLING of `children` — a
  // nested segment layout cannot unmount it. Next's only other route to a
  // banner-free segment is deleting `app/layout.tsx` and giving every route
  // group its own root layout with its own `<html>`, which is a repo-wide
  // restructure for one page. One condition, in the component that owns the
  // decision, is the smallest correct change; `AnalyticsBootstrap` already
  // reads `usePathname` from this same root-layout position, so the pattern
  // is the tree's, not this wave's.
  if (pathname?.startsWith(OVERLAY_SEGMENT)) return null;
  // The kiosk board, for the reasons on isKioskBoard above. Here rather than in
  // the kiosk layout for the same reason the overlay rule is here: this
  // component is mounted once in the ROOT layout, as a sibling of `children`,
  // so no nested layout can unmount it.
  if (isKioskBoard(pathname)) return null;

  if (!visible) return null;

  return (
    <div
      data-testid="cookie-consent"
      // Bottom-left, opposite corner from the dev-mode route indicator
      // (next.config.js devIndicators.position: "bottom-right" —
      // design/fix-ui audit, cross-cutting finding #1). On mobile this
      // banner still spans most of the viewport width (left-4..right-20,
      // not full-bleed), so it keeps clearing that corner instead of
      // resting flush against it.
      //
      // z-40, BELOW every dialog overlay (globals.css `.modal-overlay` and the
      // confirm providers are all z-50). At z-50 it tied with them and won on
      // DOM order — it is mounted last in the root layout — so on a phone it
      // painted over the Event Pass checkout sheet and ate the click on "Pay".
      // The buyers who see this banner are first-time buyers, which is every
      // buyer of a $29 pass. Nothing needs to sit above a modal; sticky headers
      // are z-40 too and this still beats them on the same DOM-order tie.
      className="fixed bottom-4 left-4 right-20 z-40 mx-auto max-w-xl rounded-2xl border border-purple-100 bg-white p-4 shadow-xl sm:left-6 sm:right-auto sm:max-w-sm"
    >
      <p className="text-sm text-slate-600">
        {clientCommon(locale, "cookie.message")}{" "}
        <Link href="/legal/cookie-policy" className="text-purple-600 underline">
          {clientCommon(locale, "cookie.policyLink")}
        </Link>
        .
      </p>
      <div className="mt-3 flex gap-2">
        <button data-testid="cookie-accept" onClick={() => decide("accepted")} className="btn btn-primary text-xs">
          {clientCommon(locale, "cookie.accept")}
        </button>
        <button onClick={() => decide("rejected")} className="btn btn-ghost text-xs">
          {clientCommon(locale, "cookie.reject")}
        </button>
      </div>
    </div>
  );
}
