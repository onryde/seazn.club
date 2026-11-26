"use client";
// The quick match home's hero Score, with "Score in app" (owner 2026-11-26, two taps; spec
// docs/superpowers/specs/2026-11-25-open-in-app-web-design.md §5.6). The browser's Score is `QuickMatchScoreForm`, as
// before. On an Android phone with the release flag on, a second button sits under it:
//   - tap one asks the SAME Score URL for the match's scoring link (`QUICK_MATCH_APP_HEADER`, answered as JSON; the
//     route's refusals, limits and activity touch are the form's own);
//   - the approved "Open in app" block then takes the button's place. Tap two is the person's own tap on its plain
//     anchor: nothing here navigates to the link, so Android hands it to the app. Score steps back to an outline
//     "Score in browser" and works as before.
//
// THE LINK IS A LIVE SCORING CREDENTIAL. It lives in this island's memory only: not in the address bar, history or
// storage, so it is gone after a reload. It is painted in one place, the anchor inside the block's `ph-no-capture`.
//
// It belongs to ONE match. Everything the island remembers carries the fixture it was asked for, and is shown only while
// the hero still offers that fixture (a live refresh, a finished or a skipped match moves the hero on).
//
// No dead control: a refusal goes where the form's 303 would have gone (the home with its flash); a failure leaves the
// button and says the home's generic line; a page restored from the back-forward cache starts again. With no script
// there is no second button at all.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useMdUp } from "@/components/ui/use-md-up";
import { OpenInAppBlock, OpenInAppHint, useOpenInAppGate } from "@/components/v2/open-in-app";
import { scoreAppLink } from "@/lib/open-in-app";
import { QUICK_MATCH_APP_HEADER } from "@/lib/quick-match-constants";
import { QuickMatchScoreForm, quickMatchHeroButton } from "./score-form";

export interface QuickMatchHeroScoreProps {
  /** `/q/<token>/score/<fixtureId>`, built by the page: the form's action, and where tap one asks. */
  action: string;
  /** The match the hero offers now. */
  fixtureId: string;
  /** The browser button's words in state 1: "Score this match" or "Continue scoring". */
  label: string;
  /** The home's generic failure line, `quickMatch.flash.generic`. */
  failed: string;
}

/** A device link's shape: `dl_` and 32 bytes as base64url. Nothing else is ever put behind "Open in app". */
const DEVICE_LINK = /^dl_[A-Za-z0-9_-]{43}$/;
/** A path on this site: one leading slash, not "//" or "/\\", which a browser reads as another host. */
const SAME_SITE_PATH = /^\/(?![/\\])/;
/** A request still out after this long is a failed tap: the button comes back. */
const ASK_TIMEOUT_MS = 15_000;

type Answer = { secret: string } | { location: string } | null;

async function askForLink(action: string): Promise<Answer> {
  try {
    const res = await fetch(action, {
      method: "POST",
      headers: { [QUICK_MATCH_APP_HEADER]: "1" },
      // Never follow: were the header lost on the way, the answer would be the form's 303 to `/score/<link>`.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const { secret, location } = ((await res.json()) ?? {}) as { secret?: unknown; location?: unknown };
    if (typeof secret === "string" && DEVICE_LINK.test(secret)) return { secret };
    if (typeof location === "string" && SAME_SITE_PATH.test(location)) return { location };
    return null;
  } catch {
    return null;
  }
}

type Asked = { fixtureId: string } & ({ step: "asking" } | { step: "ready"; secret: string } | { step: "failed" });

export function QuickMatchHeroScore({ action, fixtureId, label, failed }: QuickMatchHeroScoreProps) {
  const msg = useMsg();
  const hintId = useId();
  const android = useOpenInAppGate();
  const phone = useMdUp() === false;
  const offered = android && phone;
  const [asked, setAsked] = useState<Asked | null>(null);
  /** What is known about the match on screen: nothing, if it was asked about another one. */
  const mine = asked?.fixtureId === fixtureId ? asked : null;
  const secret = offered && mine?.step === "ready" ? mine.secret : null;

  /** The match being asked about, read before state can repaint: a second click in the same frame asks nothing. */
  const inFlight = useRef<string | null>(null);
  /** Only the newest ask's answer counts. */
  const newest = useRef(0);

  // Back from the pad or the app's fallback page (bfcache): the page returns as it was left. Start again.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      newest.current += 1;
      inFlight.current = null;
      setAsked(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // The button the person tapped is gone: put them on the anchor, which reads out its hint. Never a click.
  const focusAnchor = useCallback((anchor: HTMLAnchorElement | null) => {
    anchor?.focus();
  }, []);

  async function ask() {
    if (inFlight.current === fixtureId) return;
    inFlight.current = fixtureId;
    const ticket = ++newest.current;
    setAsked({ fixtureId, step: "asking" });
    const answer = await askForLink(action);
    if (ticket !== newest.current) return;
    if (answer && "location" in answer) {
      // The page is leaving for the home's own flash; the button stays busy until it has.
      window.location.assign(answer.location);
      return;
    }
    inFlight.current = null;
    setAsked(answer ? { fixtureId, step: "ready", secret: answer.secret } : { fixtureId, step: "failed" });
  }

  return (
    <div className="min-w-0 space-y-3">
      <QuickMatchScoreForm
        action={action}
        place="hero"
        tone={secret ? "outline" : "lime"}
        label={secret ? msg("openApp.scoreInBrowser") : label}
      />
      {secret ? (
        <OpenInAppBlock
          href={scoreAppLink(window.location.origin, secret)}
          orScan={false}
          describedBy={hintId}
          anchorRef={focusAnchor}
        >
          <OpenInAppHint hint="openApp.tapAgain" id={hintId} />
        </OpenInAppBlock>
      ) : offered ? (
        <button
          type="button"
          data-testid="qm-score-in-app"
          onClick={() => void ask()}
          aria-disabled={mine?.step === "asking" || undefined}
          className={quickMatchHeroButton("outline")}
        >
          {msg("openApp.scoreInApp")}
        </button>
      ) : null}
      {offered && mine?.step === "failed" ? (
        <p
          role="alert"
          data-testid="qm-score-in-app-failed"
          className="min-w-0 rounded-xl border border-[rgb(239_68_68/0.55)] bg-[rgb(239_68_68/0.14)] px-3 py-2.5 text-sm leading-snug text-cream [overflow-wrap:anywhere]"
        >
          {failed}
        </p>
      ) : null}
    </div>
  );
}
