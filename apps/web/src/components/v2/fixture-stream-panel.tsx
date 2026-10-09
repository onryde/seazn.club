"use client";

// The organiser's stream panel (Stream Overlay W1, task 6). Values are
// `_THEMES.md` §8 (panel), §8a (Phone tab) and §8b (credits card) — owner
// confirmed 2026-09-10. The design canvas the sheet was drawn on is gone, so
// the sheet is the authority and nothing here invents a value it does not state.
//
// THE REGISTRY IS THE POINT. The style strip renders `themesForSport(sportKey)`
// in registry order and opens on `defaultThemeFor(sportKey)`. Three themes
// today, four when a fourth lands — with no edit to this file. There is
// deliberately NO theme id written as a literal anywhere below, not even for
// the "this style is opaque" caption: that caption is looked up as
// `stream.preview.<id>` and rendered only where the dictionary declares one, so
// a future opaque theme ships its caption as a dictionary key rather than as a
// branch here.
//
// The preview is the REAL `<OverlayStage>`, never a picture of one: same
// component, same projection, same themes as the OBS browser source. Two
// consequences worth knowing before editing:
//
//   * `fit` is FALSE here. The stage's own `useLayoutEffect` then leaves
//     `scale(1)` on `.ovl-canvas`, so the reduction is applied to the WRAPPER
//     below (the prop's own doc says exactly this). A transform on that
//     wrapper also makes it the containing block for `.ovl-canvas`'s
//     `position: absolute`, which is what keeps §3's `bottom: 54px` bar
//     measured against 1080 authored pixels rather than against the strip.
//   * `initial` is SEEDED FROM THE ROW and upgraded by one fetch of the same
//     overlay endpoint the stage itself polls. The seed is why a fixture whose
//     public endpoint is unreachable still previews instead of showing an
//     empty strip.
import {
  Component, Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode,
} from "react";
import { Check, ChevronRight, CircleAlert, Copy, ExternalLink, RefreshCw, RotateCcw, TriangleAlert, X } from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { defaultThemeFor, themesForSport, type ThemeId } from "@/components/overlay/theme-registry";
import { fetchOverlayFixture, type OverlayLiveData } from "@/components/public-site/live-score-data";
import { useDict, useLocaleOrDefault, useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import { fetchRelayCheckoutClientSecret } from "@/lib/billing-checkout-client";
import { captureQrV2Text, type CaptureQrV2 } from "@/lib/capture-qr";
import { apiV1 } from "@/lib/client-v1";
import { loadCheckoutSheet } from "./stream-checkout-sheet-loader";
import { PlatformMark, platformName } from "./stream-platform-mark";
import { D3Warning, PhoneStripView, SignalChain } from "./stream-signal-chain";
import { SeaznQrImage, SeaznQrPlaceholder } from "./seazn-qr-image";
import { useSharedPhoneSession } from "./stream-session-provider";
import { useTabReturn } from "./use-tab-return";
import type { MessageKey } from "@/lib/messages";
import { overlayStartLabel, type OverlaySideInput } from "@/lib/overlay-model";
import { OVERLAY_KEY_PARAM } from "@/lib/realtime-purpose";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { formatMinor, type Currency } from "@/lib/currency";
import { chainFor, phoneDot } from "@/lib/stream-chain";
import { renderSeaznQr, seaznQrModules, type SeaznQr } from "@/lib/seazn-qr";
import {
  STREAM_CREDIT_PACKS, streamPackAmountMinor, streamPackPerMatchMinor, type StreamPackSize,
} from "@/lib/stream-credit-packs";
import {
  END_REASON_KEYS,
  FAIL_REASON_KEYS,
  STATE_PILL_KEYS,
  PRESENCE_WATCH_START,
  STREAM_POLL_MS,
  TARGET_REMOVED,
  canGoLive,
  isW5Refusal,
  presenceAfterRead,
  presenceAfterRefusal,
  type PresenceWatch,
  createErrorCode,
  createErrorHolder,
  createErrorIsNotFound,
  createErrorText,
  d3Warning,
  autoRefusalStrip,
  AUTO_WONT_START_KEY,
  autoSwitchNote,
  autoStopLine,
  elapsedLabel,
  healthChips,
  phoneDetails,
  phoneStrip,
  takeoverLineKey,
  takeoverNotice,
  phoneTabState,
  readyStateOf,
  restartLine,
  type CreateFailureCode,
  type CreateErrorHolder,
  type PhoneTabState,
  type StreamSessionView,
} from "@/lib/stream-session-view";
import { streamUrlSchema } from "@/lib/stream-url";
import { fmtNumber, fmtTime } from "@/lib/format";
// TYPES only: `@/server/**` is server code, and a runtime import from a client island breaks the build.
import type { StreamPhone, StreamSessionCurrent, StreamTarget } from "@/server/api-v1/schemas";

// I2: the embedded-checkout sheet, and Stripe.js with it, is its own chunk — never fetched with the fixtures tab.
// `@stripe/stripe-js` injects js.stripe.com as an IMPORT side effect, and this panel ships on every organiser fixtures
// tab, so nothing below may import `@stripe/*` or `@/lib/stripe-browser` statically (fixture-stream-panel.test.tsx walks
// the whole static graph to hold that). The chunk is fetched on the FIRST sign of a hand on a credit tile (M2: a
// pointerenter, a focus or a touchstart — never the chooser merely being open), and a tap AWAITS it before asking for a
// Checkout Session (R5a), so the lazy sheet below only ever mounts over code already in hand. N2: all of them go through
// the ONE loader in `stream-checkout-sheet-loader.ts`, so they name one chunk.
const StreamCheckoutModal = dynamic(loadCheckoutSheet, { ssr: false });

/**
 * M1 (Task 14 fix round 4): the checkout sheet's OWN error boundary. `next/dynamic` is `React.lazy` over the loader, so a
 * chunk that fails to load (a stale deploy is the usual way) throws during render — and without this the nearest
 * boundary was the route's error.tsx: the whole division page replaced, an on-air Stop with it, and the purchase lock
 * held for good. It wraps the sheet and nothing else; a failed sheet renders nothing and hands the failure to the
 * container, which frees the lock and says checkout did not open. React has no hook for this — a class is the only way.
 */
export class CheckoutSheetBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onFail();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The authored canvas every theme is drawn on — the OBS browser-source size
 *  `overlay-stage.tsx` fixes and `_THEMES.md` measures every inset against. */
export const CANVAS_W = 1920;
export const CANVAS_H = 1080;

/**
 * §8's preview strip is capped at 640 CSS px wide, and that is the ONLY thing
 * 640 still means here.
 *
 * §8's OBS-link copy and this panel's width maths rest on a 640-px preview, so
 * the strip does not grow past it on a wide console; below it the strip is
 * whatever the card gives it, and the scale FOLLOWS (see `previewScaleFor`).
 * The cap is what makes the sheet's "at a 640 px strip this still resolves to
 * 640/1920, so nothing changes on desktop" true by construction rather than by
 * luck about the card's width.
 */
export const PREVIEW_MAX_W_PX = 640;

/**
 * §8, SECOND correction 2026-09-10: **scale to the container**, never to a
 * constant — `scale(w/1920)` for the measured strip width `w`, in a strip
 * `w × 1080/1920` tall.
 *
 * Why a fixed scale could not work, and why the 360-px ruling below fixed only
 * half of it: `scale(640/1920)` paints a 640 CSS px canvas however wide the
 * strip actually is. The panel is ~296 px wide at a 320 px viewport, so about a
 * THIRD of the frame was visible, and §3's bar — which spans x ≈ 24→616 in
 * canvas px and is **cricket's default theme** — had its score cells cropped
 * off the right edge with nothing to scroll to reach them. Same defect as the
 * 96-px strip, one axis over, missed because the first ruling reasoned about
 * height alone.
 *
 * The earlier owner ruling (360 px, 2026-09-10, on the W1 Task 6 finding) is
 * NOT lost: 360 is `PREVIEW_MAX_W_PX × 1080/1920`, so a 640-px strip is still
 * 360 tall and still shows all 1080 authored px. It is now a consequence of the
 * aspect ratio instead of a number of its own, which is the point — the whole
 * canvas is visible at EVERY width, not just at the one that was measured.
 *
 * A pure function so the invariant is testable in `environment: "node"`, where
 * there is no layout and nothing can be measured.
 */
export function previewScaleFor(stripWidth: number): number {
  const w = Number.isFinite(stripWidth) && stripWidth > 0 ? stripWidth : PREVIEW_MAX_W_PX;
  return Math.min(w, PREVIEW_MAX_W_PX) / CANVAS_W;
}

/** What the panel needs off the row. Structurally a subset of
 *  `RunSheetFixture`, declared narrowly so the panel does not import the run
 *  sheet's own shape and become un-mountable anywhere else. */
export interface StreamPanelFixture {
  id: string;
  status: string;
  outcome: unknown;
  scheduled_at: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

/**
 * The per-PAGE half, resolved once on the server and threaded down
 * (`StagesPanel` → `RunSheet` → `RunSheetRow`) rather than re-resolved per row.
 *
 * `overlayDict` is the `overlay.*` slice of the active locale's PUBLIC
 * dictionary. It has to travel: the console layout provides the `ui`
 * namespace, the overlay's own copy lives in `public`, and `getDictionary` is
 * `server-only` so a client island cannot load it. Sliced to the prefix the
 * themes actually read so the RSC flight carries ~20 strings, not the whole
 * public catalogue.
 */
/** Task 14b (V426): the org's match-credit balance split by bucket — `monthly` (this month's free credits, which expire
 *  at the end of the UTC month) and `pack` (bought, never expire). `total` is the chip's number. Declared here rather than
 *  imported from the server usecase, which is `server-only`. */
export interface StreamCreditSplit {
  monthly: number;
  pack: number;
  total: number;
}

export interface StreamPanelContext {
  /** `streaming.overlay`, competition-scoped. False ⇒ no panel and no toggle
   *  at all — never an upsell here (ruling 5: the OBS-side upsell is R1's). */
  entitled: boolean;
  /** `streaming.relay`, competition-scoped — the §5.3 gate the Phone tab reads. Since V426 every plan grants it, so
   *  false means staff switched it off for this org (I4): the tab says so, and never sells a plan. */
  relayEntitled: boolean;
  /** I2 (Task 14b review): this deployment has no relay at all (R5 — drivers.ts `disabledRelayDrivers`), so every start
   *  and every pack checkout is refused. The Phone tab shows that instead of buy tiles and Go live; the stop probe
   *  stays, so a stream left over from before still has its way out. */
  relayDisabled: boolean;
  sportKey: string;
  overlayDict: Record<string, string>;
  /** The org the fixture belongs to — the stream-targets and relay-checkout routes address it. */
  orgId: string;
  /** C1 — the org's match-credit balance as the SERVER resolved it. The projection's `balance` only exists once a
   *  session does, so this is the idle tab's only source; without it a club that has just bought credits reads 0 and
   *  is shown the buy card again. */
  streamBalance: number;
  /** Task 14b (R4) — `streamBalance` split by bucket, as the same server read resolved it; null when the page read no
   *  credits (no relay). The tab shows the split only while it still adds up to the balance it shows. */
  streamSplit: StreamCreditSplit | null;
  /** Task 14b (R4) — the plan's free match credits per month (V426's `streaming.credits.monthly`), for the credits card's
   *  note. 0 when the page read no credits. */
  monthlyAllowance: number;
  /** P1 — the currency the relay-checkout route will CHARGE (`preferredCurrency`, resolved by the page for the same
   *  org and browser), so the tiles quote the amount the checkout's line shows — never a GBP number above a USD sheet. */
  currency: Currency;
  /** RT (lane-close fix, ruled 2026-09-29) — each listed fixture's signed overlay key (server/overlay/overlay-key.ts),
   *  minted by the page. The OBS URL this panel copies carries its row's key, and that key is what earns a community
   *  org's overlay real-time scores at the token route. A fixture missing here (no signing secret on the server) gets a
   *  keyless URL, and its overlay polls. */
  overlayKeys: Record<string, string>;
  /** Capture QR v2 (carry 2, owner 2026-10-04): the PostHog flag `capture-qr-v2` for this organiser's org — or
   *  `CAPTURE_QR_V2_ALWAYS=1` — as `server/stream-panel-context.ts` resolved it. False hides the phone-camera option
   *  (the Phone tab) and nothing else: the routes are not gated, and a stream already up keeps its Stop. */
  phoneCapture: boolean;
  /** W19 (§6.8.5): how long a live phone stream's phone may be gone (no beat AND no video) before the tick ends it
   *  `phone_lost` — config.ts `PHONE_LOST_LIVE_MINUTES` through `tunable`, as the SERVER reads it, the same expression the
   *  tick judges with. The ended chip names it; the panel never computes or defaults it. */
  phoneLostMinutes: number;
  /** PR-2 T10 (§7.1): the auto stop's delay in whole minutes (≥ 1) — config.ts `AUTO_STOP_AFTER_RESULT_SECONDS` through
   *  `tunable`, as the SERVER's tick reads it. The switch's caption and Live's read-only line name it; never a typed 3. */
  autoStopMinutes: number;
}

/** G5: what the checkout return put on the URL, and nothing else — every other param is kept. (Spec 2026-09-30 §2: the
 *  return lands on the fixture page, whose path IS the fixture, so it no longer carries a `fixture` param.) */
const RETURN_PARAMS = ["stream", "checkout", "session_id"] as const;

export function FixtureStreamPanel({
  fixture,
  entrantNames,
  tz,
  stream,
  openedByReturn,
}: {
  fixture: StreamPanelFixture;
  entrantNames: Record<string, string>;
  /** The VENUE zone (`scheduleSettings.tz`) — the same clock the row prints in,
   *  and what the seeded payload carries as `venueTz`. Never the org zone. */
  tz: string;
  stream: StreamPanelContext;
  /** Spec 2026-09-30 §2: the fixture page's `?stream=open` (server-read) — the checkout return, and the run sheet's
   *  chip. Opens the panel on its Phone tab, strips the return's params (G5) and scrolls it into view (B2). */
  openedByReturn?: boolean;
}) {
  const msg = useMsg();
  const dict = useDict() as Record<string, unknown>;
  const locale = useLocaleOrDefault();

  const themes = themesForSport(stream.sportKey);
  // The TAB half of the return: a lazy initialiser, so the page's word picks the opening tab and never overrides the
  // organiser's own choice afterwards. Read ONCE into state: G5 below strips the params, and the answer must survive it.
  const searchParams = useSearchParams();
  const [returnedHere] = useState(() => !!openedByReturn);
  // Spec §3.1 (T9b): Phone is the FIRST tab and the default — on a return and on any ordinary open alike. The return
  // still strips its params and scrolls (below); it no longer chooses the tab.
  const [tab, setTab] = useState<"obs" | "phone">("phone");
  // Capture QR v2 (carry 2): with the `capture-qr-v2` flag off the phone-camera option is not offered — no Phone tab and
  // no switch; the panel IS the OBS overlay. The organiser's own choice survives the flag coming back on a refresh.
  const shownTab = stream.phoneCapture ? tab : "obs";

  // G5: the return has done its job once this row is open on the Phone tab, so its params come off the URL — a reload
  // or a shared link must not re-open the panel, or re-run the page's reconcile, on a purchase that is finished. A
  // REPLACE (no history entry) that keeps every other param and does not scroll. The ref keeps it to one call: the
  // params change under it, and `router` need not be stable in every caller.
  const router = useRouter();
  const pathname = usePathname();
  const stripped = useRef(false);
  useEffect(() => {
    if (!returnedHere || stripped.current) return;
    stripped.current = true;
    const rest = new URLSearchParams(searchParams?.toString() ?? "");
    for (const name of RETURN_PARAMS) rest.delete(name);
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [returnedHere, searchParams, router, pathname]);

  // B2: a cold load from checkout lands at the top of a long run sheet with the opened row somewhere below. Scroll the
  // panel into view ONCE, on the auto-open only — a callback ref, so it runs when the node exists — instantly for a
  // reader who asked for reduced motion. `scroll-mt-24` on the section clears the console's sticky bars (run-sheet.tsx:
  // the 56-px app bar plus a sticky day heading) so the heading does not land underneath them.
  const scrolled = useRef(false);
  const landOn = useCallback(
    (el: HTMLElement | null) => {
      if (!el || !returnedHere || scrolled.current) return;
      scrolled.current = true;
      const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    },
    [returnedHere],
  );
  // OPENS ON the sport's own default, resolved through the registry — a lazy
  // initialiser so a re-render never re-seeds it over the organiser's choice.
  const [style, setStyle] = useState<ThemeId>(() => defaultThemeFor(stream.sportKey));
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<OverlayLiveData | null>(null);
  // §8's second correction: the preview scales to the STRIP'S OWN WIDTH, so
  // that width has to be measured. `null` until the first observation, and
  // `previewScaleFor` falls back to the cap — which is exactly the constant
  // this panel used to ship, so the pre-measurement frame is never worse than
  // the old behaviour.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [stripWidth, setStripWidth] = useState<number | null>(null);

  // The browser's own origin, read as an EXTERNAL STORE rather than seeded
  // into state from an effect: `react-hooks/set-state-in-effect` refuses the
  // latter (a synchronous setState in an effect body is a cascading render),
  // and reading `window` in the render body would trip `react-hooks/purity`.
  // `subscribe` is a no-op because an origin never changes for the life of a
  // document; the SERVER snapshot is "" so a server render and this repo's
  // node-environment tests both produce a relative `/overlay/...` path
  // instead of throwing on an absent `window`.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );

  // ONE fetch of the endpoint the stage itself polls. An async IIFE, not a
  // `.then` chain: `api()` can reject before returning, and an un-awaited
  // rejection is invisible to vitest. A failure is deliberately silent — the
  // seed below still previews.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await fetchOverlayFixture(fixture.id);
        if (!cancelled) setLive(next);
      } catch {
        // transient or unreachable (a private competition) — keep the seed
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixture.id]);

  // Measure the strip, never the viewport: the panel sits in a card inside a
  // run-sheet row, so the window's width says nothing useful about it.
  //
  // `ResizeObserver` fires an initial observation for every element it is given,
  // so there is no synchronous `measure()` here — that would be a setState in an
  // effect body, which `react-hooks/set-state-in-effect` refuses (see `origin`
  // above for the same constraint). `tab` is the dependency because the strip
  // only exists on the OBS tab: leaving it out attaches the observer to a node
  // that is gone the moment an organiser opens Phone and comes back.
  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setStripWidth(box.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [shownTab]);

  const previewScale = previewScaleFor(stripWidth ?? PREVIEW_MAX_W_PX);

  // RT: the row's OWN key rides the URL the organiser pastes into OBS — never another fixture's, and none when the page
  // minted none (the overlay then polls).
  const overlayKey = stream.overlayKeys[fixture.id];
  const overlayUrl = `${origin}/overlay/fixtures/${fixture.id}?style=${style}${
    overlayKey ? `&${OVERLAY_KEY_PARAM}=${encodeURIComponent(overlayKey)}` : ""
  }`;

  const sideOf = (entrantId: string | null, fallback: string): OverlaySideInput => ({
    id: entrantId ?? fallback,
    name: entrantId ? (entrantNames[entrantId] ?? "—") : "—",
  });

  const seed: OverlayLiveData = {
    status: fixture.status,
    summary: null,
    outcome: (fixture.outcome ?? null) as OverlayLiveData["outcome"],
    lastSeq: null,
    venueTz: tz,
  };

  // Declared by the DICTIONARY, never by a theme name: a style whose canvas is
  // opaque hides the green-field stand-in entirely, which reads as a broken
  // preview unless it is captioned. A theme that needs no caption ships no key.
  const captionKey = `stream.preview.${style}`;
  const caption = typeof dict[captionKey] === "string" ? msg(captionKey as MessageKey) : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(overlayUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // a browser that refuses the clipboard leaves the field selectable
    }
  }

  async function save() {
    setError(null);
    setSaved(false);
    // The SAME schema the write route parses (`lib/stream-url.ts`), so the
    // inline refusal and the 422 can never disagree about what an allowed host
    // is. `preprocess` turns an empty or blank field into `null`, which is how
    // an organiser CLEARS a link — that is not an error.
    const parsed = streamUrlSchema.safeParse(url);
    if (!parsed.success) {
      setError(msg("stream.error.link"));
      return;
    }
    setBusy(true);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}/stream`, {
        method: "PUT",
        json: { streamUrl: parsed.data as string | null },
      });
      setSaved(true);
    } catch {
      setError(msg("stream.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  // §8's tab grammar, shared by BOTH strips so the two cannot drift.
  //
  // Written MOBILE-FIRST rather than as `max-md:` overrides, deliberately:
  // every branch in this panel is "base = phone, `md:` = the §8 desktop
  // value", so no phone rule ever has to out-order a desktop one in the
  // generated CSS. `max-md:static` beating a base `absolute` was the one
  // place that would have depended on Tailwind's utility sort, and no unit
  // test in this repo can see a cascade.
  //
  // The tightest row on this surface is three 44px style tabs at 320 (plus
  // the OBS/Phone pair above them). `flex-wrap` + `grow basis-0` + a 4rem
  // floor is what makes that safe for ANY number of themes: three fit one row
  // inside the card's ~246px at 320, a fourth wraps to a second row, and a
  // tab whose label is too long wraps its TEXT (`leading-tight`) rather than
  // widening. There is no N at which the strip can put a horizontal scrollbar
  // on the panel.
  const tabClass = (selected: boolean) =>
    `min-h-11 min-w-[4rem] grow basis-0 rounded-md px-2.5 py-1 text-xs font-medium leading-tight transition md:min-h-0 md:min-w-0 md:grow-0 md:basis-auto ${
      selected
        ? "bg-purple-100 text-purple-800"
        : "text-slate-600 hover:bg-purple-50 hover:text-purple-700"
    }`;

  // Spec §3.1 / mockup option-a (T9b): the segmented Phone | OBS overlay switch. 44 px on a phone, 36 at ≥ 768.
  const modeTabClass = (selected: boolean) =>
    `min-h-11 rounded-md px-3 text-sm font-medium md:min-h-9 ${
      selected ? "bg-white text-purple-700 shadow-sm" : "text-slate-600 hover:text-slate-900"
    }`;

  return (
    // Mockup option-a (T9b): a light-violet frame inside the Scoring card. On a phone it bleeds to the card's edges as a
    // sheet (the console's wrapper takes the card's padding back). The heading is the console's ("Stream this match" on
    // the fallback card, "Scoring" above it otherwise); the frame names itself to assistive tech.
    <section
      ref={landOn}
      data-testid="stream-panel"
      aria-label={msg("stream.title")}
      className="scroll-mt-24 rounded-xl border border-purple-100 bg-[var(--mk-light-violet)] p-4 max-md:rounded-b-none max-md:rounded-t-2xl max-md:border-0 max-md:border-b max-md:p-3"
    >

      {/* Owner 2026-09-07: streaming is bought in the fixture console itself,
          so the panel carries both tiers. Tier B's session controls are R1's;
          W1 ships the tab and §5.3's gate. */}
      {/* Flag off: no switch, but a stream already up (started before, or by a phone — the routes are not gated) keeps its
          way out, exactly as G2's probe does for an org without the relay. Renders nothing without one. */}
      {!stream.phoneCapture && <PhoneStopProbe fixtureId={fixture.id} />}
      {stream.phoneCapture && (
      <div role="tablist" aria-label={msg("stream.tabs.label")} className="inline-flex rounded-lg bg-slate-100 p-1">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "phone"}
          data-testid="stream-tab-phone"
          onClick={() => setTab("phone")}
          className={modeTabClass(tab === "phone")}
        >
          {msg("stream.tab.phone")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "obs"}
          data-testid="stream-tab-obs"
          onClick={() => setTab("obs")}
          className={modeTabClass(tab === "obs")}
        >
          {msg("stream.tab.obs")}
        </button>
      </div>
      )}
      {/* B1: W1's lead line promises a scorebug to paste into OBS — the OBS tab's promise. §8a's Phone frame has no lead. */}
      {shownTab === "obs" && (
        <p data-testid="stream-lead" className={stream.phoneCapture ? "mt-3 text-xs text-slate-600" : "text-xs text-slate-600"}>
          {msg("stream.line")}
        </p>
      )}

      {shownTab === "obs" ? (
        <>
          <div
            role="tablist"
            aria-label={msg("stream.styles.label")}
            className="mt-3 flex flex-wrap gap-1.5"
          >
            {themes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                role="tab"
                aria-selected={style === theme.id}
                data-stream-style={theme.id}
                data-testid={`stream-tab-${theme.id}`}
                onClick={() => setStyle(theme.id)}
                className={tabClass(style === theme.id)}
              >
                {msg(theme.labelKey as MessageKey)}
              </button>
            ))}
          </div>

          {/* §8 as corrected: the strip is `w` wide and `w × 1080/1920` tall,
              and the canvas below is scaled to the SAME `w`, so the whole
              authored 1920×1080 frame is visible at every viewport instead of
              at the one width somebody measured. The ratio is an
              `aspect-ratio`, not a pixel height, so there is no second number
              to drift: 640 → 360 falls out of it, which is the owner's own
              strip figure. `overflow-hidden` is a backstop only now — the
              canvas exactly fills the box, give or take the 1-px border. */}
          <div
            ref={stripRef}
            data-testid="stream-preview"
            aria-hidden
            className="relative mt-3 w-full overflow-hidden rounded-lg border border-purple-100"
            style={{
              maxWidth: PREVIEW_MAX_W_PX,
              aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
              background: "linear-gradient(180deg, #3d7a3a, #2e6a2d)",
            }}
          >
            <div
              data-testid="stream-preview-canvas"
              className="absolute left-0 top-0"
              style={{
                width: CANVAS_W,
                height: CANVAS_H,
                transform: `scale(${previewScale})`,
                transformOrigin: "top left",
              }}
            >
              <OverlayStage
                // Remount when the first real payload lands: `useLiveFixture`
                // seeds its state ONCE, so a changed `initial` prop is
                // otherwise ignored for the life of the island.
                key={live === null ? "seed" : "live"}
                fixtureId={fixture.id}
                initial={live ?? seed}
                // m6/R1 (RT): no realtime, no declared purpose, no key — the console preview never mints a token.
                realtime={false}
                sportKey={stream.sportKey}
                style={style}
                sides={[sideOf(fixture.home_entrant_id, "home"), sideOf(fixture.away_entrant_id, "away")]}
                startLabel={overlayStartLabel(fixture.scheduled_at, locale, tz)}
                dict={stream.overlayDict}
                decidedTemplates={decidedOutcomeTemplates(msg, stream.sportKey)}
              />
            </div>
          </div>
          {caption !== null && (
            <p data-testid="stream-preview-note" className="mt-1 text-[11px] text-slate-600">
              {caption}
            </p>
          )}

          <div className="relative mt-3">
            <input
              readOnly
              data-testid="stream-link"
              aria-label={msg("stream.link.label")}
              value={overlayUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="h-11 w-full rounded-lg border border-purple-100 bg-slate-950 px-3 font-mono text-[11px] text-slate-100 md:h-10 md:pr-24"
            />
            <button
              type="button"
              data-testid="stream-copy"
              onClick={copy}
              className="btn btn-ghost mt-1.5 h-11 w-full text-xs md:absolute md:right-2 md:top-1.5 md:mt-0 md:h-7 md:w-auto md:px-2.5"
            >
              {copied ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5 text-green-600" />
                  {msg("stream.copied")}
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-3.5 w-3.5" />
                  {msg("stream.copy")}
                </>
              )}
            </button>
          </div>

          {/* An `ol`: it is a sequence, not a set (§8). */}
          <ol
            data-testid="stream-steps"
            className="mt-3 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-slate-700"
          >
            <li>{msg("stream.step1")}</li>
            <li>{msg("stream.step2")}</li>
            <li>{msg("stream.step3")}</li>
          </ol>

          <div className="mt-3 flex flex-col gap-2 md:flex-row">
            <input
              data-testid="stream-url-input"
              aria-label={msg("stream.url.label")}
              placeholder={msg("stream.url.placeholder")}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setSaved(false);
                setError(null);
              }}
              className="h-11 flex-1 rounded-lg border border-purple-200 bg-white px-3 text-[13px] text-slate-700 md:h-10"
            />
            <button
              type="button"
              data-testid="stream-save"
              disabled={busy}
              onClick={save}
              className="btn btn-primary h-11 w-full shrink-0 md:h-10 md:w-auto"
            >
              {saved ? msg("stream.saved") : msg("stream.save")}
            </button>
          </div>
          {error !== null && (
            <p data-testid="stream-error" className="mt-1 text-xs text-red-700">
              {error}
            </p>
          )}
          <p className="mt-2 text-[11px] text-slate-600">{msg("stream.footnote")}</p>
          {/* B8 re-review item 2: with the flag off there is no Phone tab, and the credit purchase that lived there before
              T11 stays on the panel, under the overlay — for an org the relay serves (the gate the Phone tab reads). */}
          {!stream.phoneCapture && stream.relayEntitled && !stream.relayDisabled && (
            <StreamCredits
              fixtureId={fixture.id}
              orgId={stream.orgId}
              streamBalance={stream.streamBalance}
              streamSplit={stream.streamSplit}
              monthlyAllowance={stream.monthlyAllowance}
              currency={stream.currency}
            />
          )}
        </>
      ) : (
        <div data-testid="stream-phone-gate" className="mt-3 min-w-0">
          {/* Spec §5.3. The "no `streaming.overlay`" row of that table cannot be
              reached from here — without it there is no toggle and no panel —
              so the gate this tab actually reads is the relay one. */}
          {!stream.relayEntitled || stream.relayDisabled ? (
            <>
              {/* G2: a stream started while the org HAD the relay stays stoppable after it lost it — the current and
                  stop routes gate on fixture write access, not on the entitlement. Renders nothing without a session
                  that is still up. The same holds for a deployment whose relay is off (I2). */}
              <PhoneStopProbe fixtureId={fixture.id} />
              {/* The org-specific state first: a switched-off org is told how to get it back, whatever the deployment. */}
              {!stream.relayEntitled ? switchedOff(msg) : relayUnavailable(msg)}
            </>
          ) : (
            <PhoneTab
              fixtureId={fixture.id}
              orgId={stream.orgId}
              streamBalance={stream.streamBalance}
              streamSplit={stream.streamSplit}
              monthlyAllowance={stream.monthlyAllowance}
              currency={stream.currency}
              phoneLostMinutes={stream.phoneLostMinutes}
              autoStopMinutes={stream.autoStopMinutes}
              tz={tz}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ─── The Phone tab (Streaming R1, lane D) ─────────────────────────────────────────────────────────────────────────────
// §8a option A ("Stepper") and §8b option A ("Three tiles"), values from `_THEMES.md`. Three pieces, each tested where
// it CAN be in a node harness: `PhoneTab` (the container — fetch, poll and every action), `PhoneTabBody` (pure: every
// state is a function of its props). Destinations are managed in Directory → Streaming (T8, D1): the tab only PICKS one
// (and saves it as the fixture's pre-pick, capture QR v2 §6.7.3), and links there.

/** §8a's `QR size` cap (amended 2026-10-01, B6 fix round 1 ruling I-2): 363 CSS px. Capture QR v2 (§6.12, Option B rev
 *  2): the v2 payload is a 57-module symbol (v8 + the quiet zone), which `SeaznQrImage` snaps to 6 px per module — 342 px
 *  wherever the code card gives it room (768 and up), and 4 px per module (228) in a 320-px phone's card. The symbol's
 *  EC level, quiet zone and logo are `lib/seazn-qr`'s (§8a's `QR encoding` row). */
const STREAM_QR_MAX_PX = 363;

/** The fixture's stream code as the body shows it (capture QR v2 §6.1): asked for, refused, or its paste text — the QR's
 *  own text, `captureQrV2Text` — with the image once the browser has encoded THAT text (never the previous code's). */
export type CodeCard =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; text: string; image: SeaznQr | null };

/** The org's destinations as the picker knows them (spec §3.3): a failed read is an ERROR with Retry, never "none" —
 *  "none" told an organiser with five saved destinations to go and add one. */
export type TargetsState = { status: "loading" } | { status: "error" } | { status: "ok"; list: StreamTarget[] };

/** Where destinations are managed (D1) — the Directory's Streaming tab. */
const MANAGE_DESTINATIONS_HREF = "/directory?tab=streaming";
const LINK = "font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700";

type CreateError = { code: CreateFailureCode; holder: CreateErrorHolder | null };
/** D13: which sentence a refused checkout gets — keyed on the route's STATUS (`CheckoutSecretResult` has no code). */
type CheckoutError = "owner" | "unknown";

/**
 * G2 — the Phone tab's stop controls, for an org that no longer holds `streaming.relay` (a downgrade, an expired
 * override) while one of its streams is still up. The gate below it sells the feature; this keeps what is ALREADY on
 * air stoppable. Nothing but the session's own state and its way out: no QR (no credentials), no destinations, no
 * buying. Renders nothing at all without a session that is still up, so an unentitled org with nothing running sees
 * the gate alone.
 *
 * F1 (spec 2026-09-30 §2): also mounted alone by the fixture page's stop-only mount, when a billing freeze or a
 * switched-off overlay has taken the whole panel away. The page names its fixture, so no label is passed. `label` is
 * left from the division page's probe stack, which T6 removed: nothing in production passes it (B5 review m-9).
 */
export function PhoneStopProbe({ fixtureId, label }: { fixtureId: string; label?: string }) {
  const msg = useMsg();
  const s = useSharedPhoneSession(fixtureId);
  const v = s.shown;
  if (!v || s.state === "idle" || s.state === "ended" || s.state === "failed") return null;
  return (
    <div data-testid="stream-stop-probe" className="mb-3 min-w-0 space-y-2 rounded-lg border border-slate-200 p-3">
      {label && (
        <p data-testid="stream-stop-probe-label" className="truncate text-sm font-medium text-slate-800" title={label}>
          {label}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {statePill(msg, s.state)}
        {s.state === "live" && recAndElapsed(msg, v.startedAt, s.now)}
      </div>
      {s.state === "live" && (
        <button
          type="button"
          data-testid="stream-stop"
          disabled={s.busy}
          onClick={() => void s.stop()}
          className={STOP_BUTTON}
        >
          {msg("stream.phone.stop")}
        </button>
      )}
      {(s.state === "provisioning" || s.state === "warming") && (
        <button
          type="button"
          data-testid="stream-cancel"
          disabled={s.busy}
          onClick={() => void s.cancel()}
          className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
        >
          {msg("stream.phone.cancel")}
        </button>
      )}
      {s.state === "ending" && (
        <p data-testid="stream-ending" className="text-xs text-slate-600">
          {msg("stream.phone.ending", { destination: v.target.label })}
        </p>
      )}
      {s.stopFailed && stopError(msg, s.state)}
    </div>
  );
}

/**
 * The Phone tab's container: fetch + poll + actions. Everything visible is `PhoneTabBody`, so the node harness renders
 * every state without a network. The session itself — its reads, its poll and its stop — is `usePhoneSession`.
 */
export function PhoneTab({
  fixtureId,
  orgId,
  streamBalance,
  streamSplit,
  monthlyAllowance,
  currency,
  phoneLostMinutes,
  autoStopMinutes,
  tz,
}: {
  fixtureId: string;
  orgId: string;
  streamBalance: number;
  streamSplit: StreamCreditSplit | null;
  monthlyAllowance: number;
  currency: Currency;
  /** W19: the server's phone-lost window (StreamPanelContext.phoneLostMinutes), handed to the body untouched. */
  phoneLostMinutes: number;
  /** PR-2 T10: the auto stop's delay (StreamPanelContext.autoStopMinutes), handed to the body untouched. */
  autoStopMinutes: number;
  /** PR-2 T12: the venue zone — the takeover notice's clock, as the row's. */
  tz: string;
}) {
  const msg = useMsg();
  // T9b: the page's ONE session (StreamSessionProvider, mounted by the console) — the Stream button's dot reads it too.
  const session = useSharedPhoneSession(fixtureId);
  const { view, shown, state, read, setBusy } = session;
  // The provider read `current` when the PAGE loaded; opening the tab reads it again, as opening it always did — an idle
  // page does not poll, so a session started elsewhere since then shows now rather than at the next reload. Only when a
  // read had ALREADY landed: a session still on its first read (the page just loaded, or no provider at all) is about to
  // answer, and a second request would only race it.
  const loadedAtOpen = useRef(session.loaded);
  useEffect(() => {
    if (loadedAtOpen.current) void read().catch(() => {});
  }, [read]);
  const [targets, setTargets] = useState<TargetsState>({ status: "loading" });
  // Bumped by Retry: re-runs the list's read.
  const [targetsTry, setTargetsTry] = useState(0);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<CreateError | null>(null);
  // The purchase: the chooser, its one Checkout Session, the embedded sheet and a plan refusal (C22 / D12) — the ONE
  // copy the flag-off credits section uses too (B8 re-review item 2).
  const { checkoutError, setCheckoutError, checkoutSecret, planGate, setPlanGate, showBuy, setShowBuy, onBuy, onTileIntent, sheet } =
    useCreditCheckout({ orgId, fixtureId, setBusy });
  // m2: the server refused a create for want of credits — the page's balance is stale, so this tab reads 0 until the
  // next page load (a checkout return is one).
  const [noCredits, setNoCredits] = useState(false);
  const [copied, setCopied] = useState(false);

  // One read of the org's destinations. LOUD (the mount, Retry) shows the read in flight, never the last answer; QUIET
  // (I1: the organiser came back from Directory, or a Go live found its destination gone) keeps the picker on screen
  // until the answer, and a quiet read that fails keeps a list already shown. Each read takes a sequence number: only
  // the NEWEST read's answer — list or failure — lands (m2), so a slow older read never overwrites a newer one.
  // Resolves to the list it applied, or null (failed, or superseded).
  const listSeq = useRef(0);
  const listInFlight = useRef(false);
  // §6.7.3 / §17.13 (B8 review I-1, controller ruling): ONE selection — what the picker shows is what Go live sends and
  // what n1 and the in-use lift act on. Until the organiser picks in this tab it FOLLOWS the server's answer, the read
  // model's `destination` (`fixtureStreamTarget`: the target the phone's own start opens on), shown only while the list
  // holds it — so the organiser sees what the phone would stream to. Nothing is chosen here (no "the first in the list"),
  // and opening the panel writes nothing. After a pick it is the pick; a pick removed in Directory is CLEARED, never
  // swapped for another destination, until the next pick (B4 re-review n1) — the server answers the same (a saved choice
  // archived is none). Every answer settles against the state as it is THEN (the refs), not as it was when it was asked.
  const selectedRef = useRef<string | null>(null);
  const pickedHere = useRef(false);
  // B8 re-review n-5: the last pick's save failed — the picker went back to the server's answer, and says so.
  const [pickFailed, setPickFailed] = useState(false);
  const serverPick = useRef<string | null>(null);
  const listShown = useRef<StreamTarget[] | null>(null);
  const settleSelection = useCallback((): string | null => {
    const list = listShown.current;
    let next: string | null = null;
    if (list !== null && list.length === 0) {
      // Nothing left to stand by: a later list follows the server again (which keeps a removed choice as none).
      pickedHere.current = false;
    } else if (list !== null) {
      const want = pickedHere.current ? selectedRef.current : serverPick.current;
      next = want !== null && list.some((t) => t.id === want) ? want : null;
    }
    selectedRef.current = next;
    setSelectedTargetId(next);
    return next;
  }, []);
  const readTargets = useCallback(
    async (loud: boolean): Promise<StreamTarget[] | null> => {
      const seq = ++listSeq.current;
      listInFlight.current = true;
      if (loud) setTargets({ status: "loading" });
      try {
        // created_at order (listStreamTargets), so the first is the org's oldest destination.
        const list = await apiV1<StreamTarget[]>(`/api/v1/orgs/${orgId}/stream-targets`);
        if (seq !== listSeq.current) return null;
        setTargets({ status: "ok", list });
        listShown.current = list;
        const next = settleSelection();
        // A destination another match held (`target_in_use`) that this read finds FREE — or gone — no longer explains
        // anything: the hold is lifted and Go live may try again. One still held keeps it. Judged on the SHOWN selection,
        // and only here, where the list's `inUse` is fresh.
        const shownTarget = next === null ? undefined : list.find((t) => t.id === next);
        setCreateError((e) => (e?.code === "target_in_use" && !shownTarget?.inUse ? null : e));
        // B5 review m-2: an EMPTY list has nothing to "pick another" from — the empty state (No destinations yet + Manage)
        // says what to do, and a "removed" line kept past it would later sit beside an enabled Go live.
        if (list.length === 0) setCreateError((e) => (e?.code === TARGET_REMOVED ? null : e));
        return list;
      } catch {
        if (seq !== listSeq.current) return null;
        // Spec §3.3: an unreadable list is an ERROR with Retry — never "none" (the silent catch this replaces).
        setTargets((cur) => (loud || cur.status !== "ok" ? { status: "error" } : cur));
        return null;
      } finally {
        if (seq === listSeq.current) listInFlight.current = false;
      }
    },
    [orgId, settleSelection],
  );
  // The mount and each Retry: a loud read. No cleanup is owed — another org's read (a new `readTargets`) takes a newer
  // sequence number, so the old answer is dropped by the rule above, and React ignores a set after unmount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the loud read shows "loading" before it asks (as before I1)
    void readTargets(true);
  }, [readTargets, targetsTry]);
  // Capture QR v2 §6.12: the phone's read model, polled every STREAM_POLL_MS while the tab is open — beside the session's
  // own poll, which idles at Ready. A failed read keeps the last answer (the next poll tries again); the first answer, or
  // its failure, is what lets the body render — a Ready state drawn before it would flash "no phone" at a paired one.
  // B8 review m-4: each read takes a sequence number, and only the NEWEST read's answer lands — an older poll answering
  // after a newer read (the reissue's, a tab return's) never puts stale facts back on screen.
  const [phone, setPhone] = useState<StreamPhone | null>(null);
  const [phoneLoaded, setPhoneLoaded] = useState(false);
  const phoneSeq = useRef(0);
  // Owner ruling 2026-10-09 ("A"): a Go live refused for want of a phone clears when this read FLIPS to present
  // (`presenceAfterRead`); the watch lives in a ref so the interval's callback never reads a stale one.
  const presence = useRef<PresenceWatch>(PRESENCE_WATCH_START);
  const readPhone = useCallback(async () => {
    const seq = ++phoneSeq.current;
    try {
      const got = await apiV1<StreamPhone>(`/api/v1/fixtures/${fixtureId}/stream-phone`);
      if (seq !== phoneSeq.current) return;
      setPhone(got);
      const seen = presenceAfterRead(presence.current, { seq, present: got.phone?.present === true });
      presence.current = seen.watch;
      if (seen.clearW5) setCreateError((e) => (e !== null && isW5Refusal(e.code) ? null : e));
      const answer = got.destination?.id ?? null;
      // B8 final re-review n-6: "couldn't save" is news only while the server's answer is the one it was said beside —
      // an answer that CHANGES (saved from another device or tab) retires it. A poll answering the same keeps it.
      if (answer !== serverPick.current) setPickFailed(false);
      serverPick.current = answer;
      settleSelection();
    } catch {
      // transient — the poll asks again
    } finally {
      setPhoneLoaded(true);
    }
  }, [fixtureId, settleSelection]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState in readPhone runs after its await
    void readPhone();
    const id = setInterval(() => void readPhone(), STREAM_POLL_MS);
    return () => clearInterval(id);
  }, [readPhone]);

  // PR-2 T10 (§7.1): the switch writes `PUT …/stream-settings { autoStream }` — the switch ALONE (the route writes only the
  // fields a PUT names, so the pick is untouched) — then reads the read model again: its `auto.enabled` is the answer the
  // switch shows. While the save is in flight the switch shows what was asked (`autoPending`), and is held; a failed save
  // goes back to the server's answer and says so. The PUT's own answer is never shown (its `targetId` is the SAVED pick,
  // not the destination the phone would stream to).
  const [autoPending, setAutoPending] = useState<boolean | null>(null);
  const [autoFailed, setAutoFailed] = useState(false);
  const onToggleAuto = async (on: boolean) => {
    setAutoPending(on);
    setAutoFailed(false);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/stream-settings`, { method: "PUT", json: { autoStream: on } });
      await readPhone();
    } catch {
      setAutoFailed(true);
    } finally {
      setAutoPending(null);
    }
  };

  // PR-2 T12 (§7.5): the takeover notice's X — remembered per takeover INSTANT for this fixture, in this browser only (a
  // per-viewer convenience: a storage that refuses, or a private window, just shows the notice again next time).
  const dismissKey = `seazn.stream.takeoverDismissed.${fixtureId}`;
  const [takeoverDismissedAt, setTakeoverDismissedAt] = useState<string | null>(() => {
    try {
      return localStorage.getItem(dismissKey);
    } catch {
      return null;
    }
  });
  const onDismissTakeover = (at: string) => {
    setTakeoverDismissedAt(at);
    try {
      localStorage.setItem(dismissKey, at);
    } catch {
      // the dismissal holds for this view; nothing else depends on it
    }
  };

  // I1: "Manage destinations" opens Directory in a NEW tab, so coming back never remounts this one — the return re-reads
  // the list, while the picker is up, and the read model with it: the destination the server would now stream to (one
  // added, or the choice archived) is what the picker shows. A real return fires focus AND visibilitychange: a read
  // already in flight answers both.
  const onTabReturn = useCallback(() => {
    if (listInFlight.current) return;
    void readTargets(false);
    void readPhone();
  }, [readTargets, readPhone]);
  useTabReturn(onTabReturn, state === "idle");

  // B8 review I-2: the PHONE starts sessions too (T8's start), and `current` rests at Ready — so the read model names the
  // fixture's open session, and one the shared session does not hold is read from `current`, ONCE per id. Otherwise the
  // organiser would watch "Paired · Go live" while the phone is warming, and Go live would meet `active_session`. A read
  // that fails is asked again on the next answer of the read model.
  const openSid = phone?.session?.id ?? null;
  const readForSid = useRef<string | null>(null);
  useEffect(() => {
    if (openSid === null || openSid === view?.id || readForSid.current === openSid) return;
    readForSid.current = openSid;
    void read().catch(() => {
      readForSid.current = null;
    });
  }, [openSid, view?.id, phone, read]);

  const ready = readyStateOf(phone, shown);
  const legacy = phone?.legacy ?? false;

  // The stream code (§6.1): asked for LAZILY — when Ready has no phone (the card shows it), or when the organiser opens
  // "Show the code again". Never for a legacy session or a match that is over (ensure answers 422 there). The QR is
  // rendered CLIENT-SIDE from the answer — never in page HTML — and the answer is never cached (`private, no-store`).
  type Code = { status: "idle" } | { status: "loading" } | { status: "error" } | { status: "ok"; qr: CaptureQrV2; issuedAt: string };
  const [code, setCode] = useState<Code>({ status: "idle" });
  const [codeOpen, setCodeOpen] = useState(false);
  const ensureCode = useCallback(async () => {
    setCode({ status: "loading" });
    try {
      const got = await apiV1<{ qr: CaptureQrV2; issuedAt: string }>(`/api/v1/fixtures/${fixtureId}/stream-code`, { method: "POST" });
      setCode({ status: "ok", qr: got.qr, issuedAt: got.issuedAt });
    } catch {
      setCode({ status: "error" });
    }
  }, [fixtureId]);
  const wantCode = phoneLoaded && !legacy && ready !== "code_ended" && (ready === "no_phone" ? state === "idle" : codeOpen);
  // The read model names the code the server holds NOW. One the card does not show — reissued from another tab, or the
  // shown one ended (expired) on a match no longer finished (C5) — is asked for again, ONCE per such answer, so a stale
  // read can never spin the ensure.
  const codeSeen = phone?.code ? `${phone.code.issuedAt}|${phone.code.state === "ended" ? "ended" : "open"}` : null;
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!wantCode) return;
    if (code.status === "idle") {
      askedFor.current = codeSeen;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the card shows the ask in flight before it answers
      void ensureCode();
      return;
    }
    if (code.status !== "ok" || codeSeen === null || askedFor.current === codeSeen || !phone?.code) return;
    const stale = phone.code.issuedAt !== code.issuedAt || (phone.code.state === "ended" && !phone.finished);
    if (!stale) return;
    askedFor.current = codeSeen;
    void ensureCode();
  }, [wantCode, code, codeSeen, phone, ensureCode]);
  const codeText = code.status === "ok" ? captureQrV2Text(code.qr) : null;
  const [codeImage, setCodeImage] = useState<{ text: string; qr: SeaznQr } | null>(null);
  useEffect(() => {
    if (!codeText) return;
    let cancelled = false;
    // An SVG: it scales, and the box decides the painted size (snapped to whole device px per module, §8a).
    void renderSeaznQr(codeText)
      .then((qr) => {
        if (!cancelled) setCodeImage({ text: codeText, qr });
      })
      .catch(() => {
        // the paste code under the QR is always rendered, so a failed encode still leaves a way in
      });
    return () => {
      cancelled = true;
    };
  }, [codeText]);
  const codeCard: CodeCard =
    code.status === "ok"
      ? { status: "ok", text: codeText!, image: codeImage && codeImage.text === codeText ? codeImage.qr : null }
      : code.status === "error"
        ? { status: "error" }
        : { status: "loading" };

  // Revoke & reissue (§6.12): the house confirm, danger tone. The old code stops at once (a phone already streaming keeps
  // its session — ruling A: the remedy for a stranger who scanned it); the answer IS the new code.
  const confirm = useConfirm();
  const onReissue = async () => {
    const ok = await confirm({
      title: msg("stream.code.reissue.confirm.title"),
      body: msg("stream.code.reissue.confirm.body"),
      confirmLabel: msg("stream.code.reissue.confirm.button"),
      tone: "danger",
      size: "touch",
    });
    if (!ok) return;
    setCode({ status: "loading" });
    try {
      const got = await apiV1<{ qr: CaptureQrV2; issuedAt: string }>(`/api/v1/fixtures/${fixtureId}/stream-code/reissue`, { method: "POST" });
      setCode({ status: "ok", qr: got.qr, issuedAt: got.issuedAt });
    } catch {
      setCode({ status: "error" });
    }
    void readPhone();
  };

  // C1: with a session, the projection's `balance` is the fresher number. With NO session there is no projection at
  // all, so the server-resolved one is the only source — unless the server has since refused for want of credits (m2).
  const balance = view ? view.balance : noCredits ? 0 : streamBalance;

  const onGoLive = async () => {
    const chosen = selectedTargetId;
    if (!chosen) return;
    setBusy(true);
    setCreateError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/stream-sessions`, {
        method: "POST",
        json: { mode: "passthrough", targetId: chosen },
      });
      // n-6: the start saved its destination — a pick that did not save is no longer news, at Ready after it either.
      setPickFailed(false);
    } catch (err) {
      const code = createErrorCode(err);
      // D12: "your plan, not your credits" is the upgrade surface, never a retry sentence.
      if (code === "plan_lacks_relay") {
        setPlanGate(true);
        setBusy(false);
        return;
      }
      // m2: "no credits" is answered where it is asked — the chooser opens, at the balance the server just reported.
      if (code === "no_credits") {
        setNoCredits(true);
        setShowBuy(true);
      }
      // I1: a 404 may be the destination removed in Directory while this tab stayed open (D2 answers an archived target
      // with the plain not-found shape). The list is read again: gone from it → say so, and the stale choice is cleared
      // (n1: never another destination in its place); still listed → the 404 was about something else, the generic
      // refusal.
      const reread = createErrorIsNotFound(err) ? await readTargets(false) : null;
      const removed = reread !== null && !reread.some((t) => t.id === chosen);
      // m-2: removed and NOTHING left — the empty state is the whole answer; "pick another" would point at nothing.
      if (!(removed && reread.length === 0)) {
        setCreateError({ code: removed ? TARGET_REMOVED : code, holder: createErrorHolder(err) });
        // "A": a W5 refusal is news that there was no phone — only a read asked from here on may clear it.
        presence.current = presenceAfterRefusal(presence.current, code, phoneSeq.current);
      }
    }
    // Either way the server's state is the answer: the new session, or — after a refusal — whatever is there (an
    // `active_session` refusal's running session IS the explanation; a dismissed card stays dismissed).
    await read().catch(() => {});
    setBusy(false);
  };

  const onCopy = async () => {
    if (!codeText) return;
    try {
      await navigator.clipboard.writeText(codeText);
    } catch {
      return; // a browser that refuses the clipboard leaves the field selectable; nothing was taken
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // I1: a plan refusal REPLACES the tab only when there is nothing to protect. With a session up, Stop (and Cancel)
  // must survive it — the body renders the gate in the buy slot instead.
  if (planGate && state === "idle") return switchedOff(msg);
  if (!session.loaded || !phoneLoaded) {
    return (
      <p data-testid="stream-loading" role="status" aria-busy="true" className="text-xs text-slate-600">
        <span aria-hidden>…</span>
        <span className="sr-only">{msg("stream.phone.loading")}</span>
      </p>
    );
  }
  return (
    <>
      <PhoneTabBody
        fixtureId={fixtureId}
        view={shown}
        balance={balance}
        targets={targets}
        busy={session.busy}
        createError={createError}
        checkoutError={checkoutError}
        selectedTargetId={selectedTargetId}
        phone={phone}
        code={codeCard}
        codeOpen={codeOpen}
        now={session.now}
        copied={copied}
        showBuy={showBuy}
        planGate={planGate}
        stopFailed={session.stopFailed}
        checkoutOpen={checkoutSecret !== null}
        currency={currency}
        split={streamSplit}
        monthlyAllowance={monthlyAllowance}
        phoneLostMinutes={phoneLostMinutes}
        autoStopMinutes={autoStopMinutes}
        autoPending={autoPending}
        autoFailed={autoFailed}
        onToggleAuto={(on) => void onToggleAuto(on)}
        takeoverDismissedAt={takeoverDismissedAt}
        onDismissTakeover={onDismissTakeover}
        tz={tz}
        // I-1: off the RAW view, not `shown` — Start another / Try again dismiss the card, and the fixture's reuse window
        // is exactly what the next start is asking about. No session ever → nothing consumed → no window (W23).
        restart={view?.restart ?? null}
        pickFailed={pickFailed}
        // n1: a pick is the organiser's own answer — the refusal that was about the previous choice (removed, or held by
        // another match) goes with it. Any other refusal stays until the next attempt. (The hold needs no reset: a picked
        // selection only empties again through another removal, which holds it again.)
        onSelectTarget={(id) => {
          pickedHere.current = true;
          selectedRef.current = id;
          setSelectedTargetId(id);
          setCreateError((e) => (e && (e.code === TARGET_REMOVED || e.code === "target_in_use") ? null : e));
          setPickFailed(false);
          // §6.7.3: the picker writes the fixture's pre-pick on change — what the phone's own start streams to. A PICK is
          // the only write: opening the panel, or following the server's answer, saves nothing (I-1).
          // B8 re-review n-5: the save is what keeps the phone's start in agreement with the picker (§17.13), so a failure
          // is not swallowed. If this pick is still the selection, the picker goes back to the server's answer — what the
          // phone streams to — and says the pick did not save. A failure for a pick already replaced is moot.
          void apiV1(`/api/v1/fixtures/${fixtureId}/stream-settings`, { method: "PUT", json: { targetId: id } }).catch(() => {
            if (!pickedHere.current || selectedRef.current !== id) return;
            pickedHere.current = false;
            settleSelection();
            setPickFailed(true);
          });
        }}
        onRetryTargets={() => setTargetsTry((n) => n + 1)}
        onGoLive={() => void onGoLive()}
        onStop={() => {
          setCreateError(null);
          void session.stop();
        }}
        // Cancel on the QR asks nothing while nothing is on air — `cancel` re-reads first and confirms if it now is.
        onCancel={() => {
          setCreateError(null);
          void session.cancel();
        }}
        onBuy={(pack) => void onBuy(pack)}
        onAgain={() => {
          session.dismiss();
          setCreateError(null);
          setCheckoutError(null);
        }}
        onCopy={() => void onCopy()}
        onToggleCode={setCodeOpen}
        onReissue={() => void onReissue()}
        onRetryCode={() => void ensureCode()}
        // Buy more and the chooser's Close (B6) are one toggle; either way a refusal from the last attempt goes.
        onShowBuy={() => {
          setShowBuy((v) => !v);
          setCheckoutError(null);
        }}
        onTileIntent={onTileIntent}
      />
      {sheet}
    </>
  );
}

/**
 * The relay credit purchase as ONE piece of container state (B8 re-review item 2): the chooser's open/closed, its one
 * Checkout Session at a time (N2), the sheet's chunk warmed on a hand on a tile (M2), a plan refusal (C22 / D12), and the
 * lazily loaded embedded sheet (owner ruling 8) with its own error boundary (M1). Two callers: the Phone tab, and — with
 * `capture-qr-v2` off — the credits section under the OBS overlay. `setBusy` is the caller's: the Phone tab's is the shared
 * session's, so a tile tap holds every session control too.
 */
function useCreditCheckout({ orgId, fixtureId, setBusy }: { orgId: string; fixtureId: string; setBusy: (busy: boolean) => void }) {
  const [checkoutError, setCheckoutError] = useState<CheckoutError | null>(null);
  const [checkoutSecret, setCheckoutSecret] = useState<string | null>(null);
  // C22 / D12: the ORG's plan lost the feature between the page load and the tap (a downgrade, an override expiring).
  const [planGate, setPlanGate] = useState(false);
  const [showBuy, setShowBuy] = useState(false);
  // N2: one Checkout Session per sheet. Held from the tap until the sheet closes or the attempt is refused — a ref, so a
  // double tap landing on ONE render's handler (before `busy` has disabled anything) is refused too.
  const buying = useRef(false);
  // M2 / D-B: the sheet's chunk (and Stripe.js with it) is warmed on the first hand on a tile — once, not on every
  // hover. A warm-up that FAILED is forgotten, so the next intent tries again; the tap itself loads it regardless.
  const warmed = useRef(false);
  const onTileIntent = () => {
    if (warmed.current) return;
    warmed.current = true;
    void loadCheckoutSheet().catch(() => {
      warmed.current = false;
    });
  };

  // EMBEDDED Checkout (owner ruling 8) — the buy-credits.tsx shape: fetch the client_secret UP FRONT and mount the
  // lazily loaded sheet only once it resolves; Stripe returns the buyer to the route's return_url (this row, Phone tab).
  const onBuy = async (pack: StreamPackSize) => {
    if (buying.current) return;
    buying.current = true;
    setBusy(true);
    setCheckoutError(null);
    // R5a: the sheet's code FIRST. A chunk that cannot load opens no Checkout Session — the lock frees and the
    // checkout's own copy shows — and the loader forgets the failure, so the next tap really fetches it again.
    try {
      await loadCheckoutSheet();
    } catch {
      buying.current = false;
      setBusy(false);
      setCheckoutError("unknown");
      return;
    }
    const result = await fetchRelayCheckoutClientSecret({ orgId, fixtureId, pack });
    setBusy(false);
    if (result.ok) {
      // `buying` stays held: the sheet's chunk may still be loading, and a forced chooser is still on screen behind it.
      setCheckoutSecret(result.clientSecret);
      setShowBuy(false);
      return;
    }
    buying.current = false;
    // C22: the route's 402 IS plan_lacks_relay (or, m5, plan_lacks_overlay — a stale tab after the overlay went off) —
    // the SAME switched-off state the entitled check renders (I4), so there is one surface for it. Keyed on STATUS: `CheckoutSecretResult` has no code field (D13). I1: it replaces the tab only at
    // idle — mid-session the body shows it in the buy slot and keeps every session control.
    if (result.status === 402) {
      setPlanGate(true);
      setShowBuy(false);
      return;
    }
    setCheckoutError(result.status === 403 ? "owner" : "unknown");
  };

  const sheet = checkoutSecret ? (
    // M1: a sheet that cannot load is the same outcome as a refused checkout — the lock freed, the chooser back with its
    // tiles, the checkout's own copy — and never the page's error screen.
    <CheckoutSheetBoundary
      onFail={() => {
        buying.current = false;
        setCheckoutSecret(null);
        setShowBuy(true);
        setCheckoutError("unknown");
      }}
    >
      <StreamCheckoutModal
        clientSecret={checkoutSecret}
        onClose={() => {
          buying.current = false;
          setCheckoutSecret(null);
        }}
      />
    </CheckoutSheetBoundary>
  ) : null;

  return { checkoutError, setCheckoutError, checkoutSecret, planGate, setPlanGate, showBuy, setShowBuy, onBuy, onTileIntent, sheet };
}

/**
 * B8 re-review item 2 (ruling: m-8 is a regression, fix it). With `capture-qr-v2` off the panel is the OBS overlay — and
 * before T11 every entitled organiser bought match credits in this panel, so the purchase stays: the balance and Buy
 * more, or at balance 0 the chooser itself, under the overlay. The SAME purchase as the Phone tab's (`useCreditCheckout`,
 * the chooser's own markup), and nothing of the phone path — no stream code, no read model, no session read. No session
 * projection here, so the balance is the page's server-resolved one (C1); a checkout return reloads it.
 */
export function StreamCredits({
  fixtureId,
  orgId,
  streamBalance,
  streamSplit,
  monthlyAllowance,
  currency,
}: {
  fixtureId: string;
  orgId: string;
  streamBalance: number;
  streamSplit: StreamCreditSplit | null;
  monthlyAllowance: number;
  currency: Currency;
}) {
  const [busy, setBusy] = useState(false);
  const c = useCreditCheckout({ orgId, fixtureId, setBusy });
  return (
    <>
      <StreamCreditsBody
        balance={streamBalance}
        split={streamSplit}
        monthlyAllowance={monthlyAllowance}
        currency={currency}
        busy={busy}
        showBuy={c.showBuy}
        planGate={c.planGate}
        checkoutOpen={c.checkoutSecret !== null}
        checkoutError={c.checkoutError}
        onBuy={(pack) => void c.onBuy(pack)}
        onShowBuy={() => {
          c.setShowBuy((v) => !v);
          c.setCheckoutError(null);
        }}
        onTileIntent={c.onTileIntent}
      />
      {c.sheet}
    </>
  );
}

export interface StreamCreditsBodyProps {
  balance: number;
  split: StreamCreditSplit | null;
  monthlyAllowance: number;
  currency: Currency;
  busy: boolean;
  showBuy: boolean;
  planGate: boolean;
  checkoutOpen: boolean;
  checkoutError: CheckoutError | null;
  onBuy: (pack: StreamPackSize) => void;
  onShowBuy: () => void;
  onTileIntent: () => void;
}

/** The flag-off credits section, pure: a function of its props, as `PhoneTabBody` is. Its own root marker
 *  (`data-credits-root`), never the Phone tab's `data-phone-body` — e2e reads that one as "the Phone tab is here". */
export function StreamCreditsBody(p: StreamCreditsBodyProps) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  // At balance 0 the chooser IS the section (nothing behind it to go back to), as the Phone tab's forced chooser is.
  const forced = p.balance < 1;
  const card = !p.planGate && (forced || p.showBuy);
  const parts: ReactNode[] = [];
  if (p.balance >= 1) parts.push(balancePart(msg, p.balance, shownSplit(p.split, p.balance)));
  if (p.balance >= 1 && !p.planGate) parts.push(buyMorePart(msg, { expanded: p.showBuy, disabled: false, onClick: p.onShowBuy }));
  return (
    <div data-testid="stream-credits-section" data-credits-root className="mt-4 min-w-0 border-t border-purple-100 pt-3">
      {p.planGate && switchedOff(msg)}
      {parts.length > 0 && (
        <p data-testid="stream-credits-line" className="text-xs text-slate-600">
          {parts.map((part, i) => (
            <Fragment key={i}>
              {i > 0 && <span aria-hidden>{" · "}</span>}
              {part}
            </Fragment>
          ))}
        </p>
      )}
      {card &&
        creditsCard(msg, locale, {
          currency: p.currency,
          monthlyAllowance: p.monthlyAllowance,
          tilesDisabled: p.busy || p.checkoutOpen,
          checkoutError: p.checkoutError,
          closable: p.showBuy && !forced,
          closeDisabled: false,
          rootMarker: "[data-credits-root]",
          onBuy: p.onBuy,
          onShowBuy: p.onShowBuy,
          onTileIntent: p.onTileIntent,
        })}
    </div>
  );
}

/** The credits chooser (§8b option A, "Three tiles"): every catalogue pack at the checkout's own currency, the monthly
 *  note, a refused checkout's copy, Close for an OPENED chooser (B6) and the footnote. A render function, not a component,
 *  so it is part of its caller's tree: the Phone tab's body and the flag-off credits section (B8 re-review item 2). */
function creditsCard(
  msg: Msg,
  locale: string,
  o: {
    currency: Currency;
    monthlyAllowance: number;
    tilesDisabled: boolean;
    checkoutError: CheckoutError | null;
    /** An OPENED chooser closes; a forced one has nothing behind it. */
    closable: boolean;
    closeDisabled: boolean;
    /** P5: the caller's root marker — Close hands focus back to Buy more inside it. */
    rootMarker: string;
    onBuy: (pack: StreamPackSize) => void;
    onShowBuy: () => void;
    onTileIntent: () => void;
  },
): ReactNode {
  return (
    <div className="mt-3">
          <h5 className="text-sm font-semibold text-slate-700">{msg("stream.credits.title")}</h5>
          <p className="mt-1 text-xs text-slate-600">{msg("stream.credits.line")}</p>
          {o.monthlyAllowance >= 1 && (
            // Task 14b (R4): why a club with free credits might still buy — and which ones expire.
            <p data-testid="stream-credits-monthly" className="mt-1 text-xs text-slate-600">
              {o.monthlyAllowance === 1
                ? msg("stream.credits.monthlyNote.one")
                : msg("stream.credits.monthlyNote.other", { n: o.monthlyAllowance })}
            </p>
          )}
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
            {STREAM_CREDIT_PACKS.map((pack) => {
              // P1: the amount the pack's Stripe price charges in the checkout's currency. A currency the price has no
              // option for quotes NOTHING rather than a GBP number under the wrong sign (the checkout would refuse it).
              const total = streamPackAmountMinor(pack, o.currency);
              const perMatch = streamPackPerMatchMinor(pack, o.currency);
              return (
              <button
                key={pack.size}
                type="button"
                disabled={o.tilesDisabled}
                data-testid={`stream-buy-pack-${pack.size}`}
                onClick={() => o.onBuy(pack.size)}
                onPointerEnter={o.onTileIntent}
                onFocus={o.onTileIntent}
                onTouchStart={o.onTileIntent}
                // B8: top-aligned, so the three tiles' first lines share a baseline however their text wraps.
                className={`flex min-h-11 w-full flex-col items-start justify-start rounded-lg border p-3 text-left hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-50 ${
                  pack.popular ? "border-purple-500" : "border-purple-200"
                }`}
              >
                <span className="block text-lg font-semibold text-slate-800">{msg(pack.labelKey)}</span>
                {total !== undefined && (
                  <span className="block text-sm text-slate-600">{formatMinor(total, o.currency, locale)}</span>
                )}
                {perMatch !== undefined && (
                  <span className="block text-[11px] text-slate-600">
                    {msg("stream.credits.perMatch", { price: formatMinor(perMatch, o.currency, locale) })}
                  </span>
                )}
                {pack.popular && (
                  <span className="mt-1 inline-block rounded-full bg-purple-100 px-2 text-[10px] text-purple-800">
                    {msg("stream.credits.popular")}
                  </span>
                )}
              </button>
              );
            })}
          </div>
          {o.checkoutError && (
            <p data-testid="stream-checkout-error" role="alert" className="mt-2 text-xs text-red-700">
              {msg(o.checkoutError === "owner" ? "stream.credits.error.owner" : "stream.credits.error.unknown")}
            </p>
          )}
          {o.closable && (
            // B6: an OPENED chooser says how to put it away — the same toggle as Buy more, handing back the controls it
            // covers. A forced one has nothing behind it, so no Close.
            <button
              type="button"
              data-testid="stream-credits-close"
              disabled={o.closeDisabled}
              onClick={(e) => {
                o.onShowBuy();
                // P5: this button unmounts with the chooser, which would drop focus to <body>. Hand it back to the
                // control that opened the chooser — still on screen above it.
                e.currentTarget
                  .closest(o.rootMarker)
                  ?.querySelector<HTMLButtonElement>('[data-testid="stream-buy-more"]')
                  ?.focus();
              }}
              className="btn btn-ghost mt-2 min-h-11 w-full md:min-h-10 md:w-auto"
            >
              {msg("stream.credits.close")}
            </button>
          )}
          <p className="mt-2 text-[11px] text-slate-600">{msg("stream.credits.footnote")}</p>
    </div>
  );
}

/** Task 14b (R4): the chip stays the TOTAL; the split is its footnote, and only when there is something to SPLIT — both
 *  buckets held (review M2, controller ruling) — and while it still adds up to the balance shown. */
function shownSplit(split: StreamCreditSplit | null, balance: number): StreamCreditSplit | null {
  return split !== null && split.monthly > 0 && split.pack > 0 && split.total === balance ? split : null;
}

/** The balance part of a credits line: the plural key's own text, the split as its `title` and a visually hidden copy
 *  (the title is not read by every screen reader, nor shown on touch). */
function balancePart(msg: Msg, balance: number, split: StreamCreditSplit | null): ReactNode {
  const credits = balance === 1 ? msg("stream.phone.credits.one") : msg("stream.phone.credits.other", { n: balance });
  const splitText = split ? msg("stream.credits.split", { m: split.monthly, p: split.pack }) : undefined;
  return (
    <span key="balance">
      <span data-testid="stream-balance" title={splitText} className="tabular-nums">
        {credits}
      </span>
      {splitText && (
        <span data-testid="stream-credits-split" className="sr-only">
          {` ${splitText}`}
        </span>
      )}
    </span>
  );
}

/** "Buy more": opens the CHOOSER, never a pack — a mid-match top-up that picked the 5-pack sent the organiser to a Stripe
 *  sheet for a pack they never chose. */
function buyMorePart(msg: Msg, o: { expanded: boolean; disabled: boolean; onClick: () => void }): ReactNode {
  return (
    <button
      key="buy"
      type="button"
      data-testid="stream-buy-more"
      aria-expanded={o.expanded}
      disabled={o.disabled}
      onClick={o.onClick}
      className="inline-flex min-h-11 items-center font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0"
    >
      {msg("stream.phone.buyMore")}
    </button>
  );
}

export interface PhoneTabBodyProps {
  /** m12: scopes the picker's DOM id, so two mounted panels never share one. */
  fixtureId: string;
  view: StreamSessionView | null;
  balance: number;
  /** Task 14b (R4): the page's split of the balance by bucket. Shown as "{m} free this month · {p} bought" under the
   *  chip only while the org holds free credits AND the split still adds up to `balance` — once a session's projection
   *  moves the balance, the page's split is stale and says nothing rather than something wrong. */
  split: StreamCreditSplit | null;
  /** Task 14b (R4): the plan's free match credits per month; the credits card's note names it. None below 1. */
  monthlyAllowance: number;
  /** W19: the server's phone-lost window in whole minutes (StreamPanelContext.phoneLostMinutes) — the `phone_lost` end
   *  chip names it. */
  phoneLostMinutes: number;
  /** PR-2 T10 (§7.1): the auto stop's delay in whole minutes (StreamPanelContext.autoStopMinutes) — the switch's caption
   *  and Live's read-only line name it. */
  autoStopMinutes: number;
  /** PR-2 T10: the switch's flip while its save is in flight (what was asked), else null — the read model answers. */
  autoPending: boolean | null;
  /** PR-2 T10: the last flip did not save — the switch shows the server's answer again, and a line says so. */
  autoFailed: boolean;
  onToggleAuto: (on: boolean) => void;
  /** PR-2 T12 (§7.5): the takeover instant this viewer dismissed (null: none) — that takeover's notice stays hidden. */
  takeoverDismissedAt: string | null;
  onDismissTakeover: (at: string) => void;
  /** PR-2 T12: the venue zone — the takeover notice's time is on the row's clock. */
  tz: string;
  /** The org's destinations (T8): loading, a failed read (Retry), or the list — managed in Directory, picked here. */
  targets: TargetsState;
  busy: boolean;
  createError: CreateError | null;
  checkoutError: CheckoutError | null;
  selectedTargetId: string | null;
  /** Capture QR v2 §6.12: the `stream-phone` read model — null until a read has answered (or while every read fails). */
  phone: StreamPhone | null;
  /** The fixture's stream code, for the code card and "Show the code again". */
  code: CodeCard;
  /** "Show the code again" is open — the code is asked for only then (or with no phone). */
  codeOpen: boolean;
  now: Date;
  copied: boolean;
  showBuy: boolean;
  /** I1: the relay was refused (a create or a checkout: plan_lacks_relay) while a session is up — the switched-off state
   *  (I4) takes the buy slot. */
  planGate: boolean;
  /** m1: a stop that neither landed nor could be confirmed by a re-read. */
  stopFailed: boolean;
  /** N2: a checkout sheet is open — or still loading its chunk — so no tile may start a second Checkout Session. */
  checkoutOpen: boolean;
  /** P1: the currency the checkout will charge; the tiles quote in it. */
  currency: Currency;
  /** W23 (I-1): the RAW projection's restart allowance — null with no reuse window open. `free` is what admission would
   *  waive the credit for; at balance 0 it is what keeps Go live reachable instead of the forced chooser. */
  restart: StreamSessionCurrent["restart"];
  onSelectTarget: (id: string) => void;
  /** B8 re-review n-5: the last pick did not save — the picker shows the server's answer again, and a line says why. */
  pickFailed: boolean;
  /** Re-read the destination list after a failed read. */
  onRetryTargets: () => void;
  onGoLive: () => void;
  onStop: () => void;
  onCancel: () => void;
  onBuy: (pack: StreamPackSize) => void;
  onAgain: () => void;
  onCopy: () => void;
  onToggleCode: (open: boolean) => void;
  onReissue: () => void;
  onRetryCode: () => void;
  onShowBuy: () => void;
  /** M2: a hand is on a credit tile (pointerenter, focus, touchstart) — warm the checkout sheet's chunk now. */
  onTileIntent: () => void;
}

const PILL: Record<PhoneTabState, string> = {
  idle: "bg-slate-100 text-slate-600",
  provisioning: "bg-amber-100 text-amber-800",
  warming: "bg-amber-100 text-amber-800",
  live: "bg-red-100 text-red-700",
  ending: "bg-slate-100 text-slate-600",
  ended: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-50 text-red-700",
};

const CHIP = "rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700";
/** A select or input: the 44-px phone floor, and `.input`'s own focus ring (globals.css) — no new focus style. `min-w-0`
 *  (B7) so a native select with a long option shrinks to its box instead of setting it. */
const FIELD =
  "min-h-11 w-full min-w-0 rounded-md border border-slate-200 bg-white text-sm text-slate-800 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200";

/** §8a: solid red, deliberately NOT `.btn-danger` (a white outline) — the one irreversible control on a panel that is
 *  on air. It opens the repo's confirm dialog. Shared by the tab and the stop probe (G2). */
const STOP_BUTTON =
  "min-h-11 w-full rounded-md bg-red-600 px-3 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-10 md:w-auto";
/** §3.3 Live (mockup state 3): the tab's Stop stream — full width at every width, the same solid red. */
const STOP_STREAM =
  "btn min-h-12 w-full bg-red-600 text-base font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50";
/** Spec §3.2: ended and failed keep their summary and failure boxes, in the new frame's card. */
const SUMMARY_CARD = "mt-4 space-y-3 rounded-lg bg-white p-4 ring-1 ring-purple-100";

type Msg = ReturnType<typeof useMsg>;

// Render HELPERS, not components: the tab and the stop probe share this markup, and a plain call keeps it inline in
// the caller's tree (the node harness expands one level, and so do the tests that pin these testids).

/** The §8a state pill. `aria-live` (m9): a state change — warming → live, live → ending — is announced. */
/** I4 (Task 14b review, controller ruling 2026-09-29): since V426 every plan grants `streaming.relay`, so an org without
 *  it was switched off by staff (an override set to false), and an override outranks every plan. A priced upgrade here
 *  sold a plan that could not lift it. One state for every place the relay is refused: the entitled check, a create's
 *  plan_lacks_relay and the checkout's 402. The address is the house support inbox (help-menu.tsx). */
const SUPPORT_EMAIL = "support@seazn.club";
function switchedOff(msg: Msg) {
  return (
    <p data-testid="stream-switched-off" className="text-xs text-slate-600">
      {msg("stream.phone.switchedOff")}{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-purple-700 underline">
        {SUPPORT_EMAIL}
      </a>
    </p>
  );
}

/** I2: the deployment has no relay. Its own line rather than `stream.error.ingest_unavailable`, whose "Try again in a
 *  minute" promises a recovery this state does not have; it points at what still works (the OBS tab). */
function relayUnavailable(msg: Msg) {
  return (
    <p data-testid="stream-phone-unavailable" role="status" className="text-xs text-slate-600">
      {msg("stream.phone.unavailable")}
    </p>
  );
}

function statePill(msg: Msg, state: PhoneTabState, srOnly = false) {
  return (
    <span
      data-testid="stream-state-pill"
      aria-live="polite"
      // T9b: in the Phone tab the Signal path shows the state, so there the pill is for assistive tech only.
      className={
        srOnly ? "sr-only" : `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${PILL[state]}`
      }
    >
      {state === "live" && !srOnly && (
        <span data-testid="stream-live-dot" aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
      )}
      {msg(STATE_PILL_KEYS[state])}
    </span>
  );
}

/** REC + the elapsed clock (live). */
function recAndElapsed(msg: Msg, startedAt: string | null, now: Date) {
  return (
    <>
      <span
        data-testid="stream-rec"
        className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white"
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
        />
        {msg("stream.phone.rec")}
      </span>
      <span data-testid="stream-elapsed" className="font-mono text-sm tabular-nums text-slate-700">
        {elapsedLabel(startedAt, now)}
      </span>
    </>
  );
}

/**
 * m1: a stop nobody could confirm — worded by the STATE the card is in, because the copy tells the organiser which
 * button to tap again. Before live the only control on screen is Cancel (N1: "tap Stop stream again" named a button
 * that is not there); once live it is Stop. While ending, or once a read finds it over, "did not stop" is false, so
 * nothing (N3: the tab and the stop probe share this one guard, so neither can show it beside "ending").
 */
function stopError(msg: Msg, state: PhoneTabState) {
  const key: MessageKey | null =
    state === "live"
      ? "stream.error.stop"
      : state === "provisioning" || state === "warming"
        ? "stream.error.cancel"
        : null;
  if (key === null) return null;
  return (
    <p data-testid="stream-stop-error" role="alert" className="text-xs text-red-700">
      {msg(key)}
    </p>
  );
}

/** §8a option A (Stepper) + §8b option A (Three tiles) — values from the sheet. Pure. */
export function PhoneTabBody(p: PhoneTabBodyProps) {
  const msg = useMsg();
  const msgPlural = useMsgPlural();
  const locale = useLocaleOrDefault();
  const state = phoneTabState(p.view);
  // The chooser opens either because the org cannot start without credits (FORCED — there is nothing behind it to go
  // back to), or because the organiser asked for it from "Buy more" — mid-session included. A plan refusal (I1) takes
  // its slot: buying is exactly what the plan refused. I-1: NOT forced when the restart is free — admission waives the
  // credit inside the fixture's reuse window, so balance 0 is no reason to withhold Go live. A match that is over (C5) has
  // nothing to start, so it never forces the chooser either.
  //
  // Capture QR v2 §6.12: the Ready row off the two projections, and a LEGACY session (C-1: open, no pairing — it opened
  // before stream codes) is drawn as the panel was: no phone strip, no code, the §3.2 chain.
  const ready = readyStateOf(p.phone, p.view);
  const legacy = p.phone?.legacy ?? false;
  const matchOver = state === "idle" && ready === "code_ended";
  const forced = state === "idle" && p.balance < 1 && !p.restart?.free && !matchOver;
  const buyCard = !p.planGate && (forced || p.showBuy);
  // B3: an idle org with no credits sees the heading and the credits card ONLY — a "Ready" pill and a three-step
  // stepper promise a stream it cannot start.
  const creditsOnly = forced && !p.planGate;
  // Task 14b (R4): the chip stays the TOTAL; the split is its footnote, and only when there is something to SPLIT — both
  // buckets held (review M2, controller ruling). One bucket alone is the chip's own number said twice.
  const split = shownSplit(p.split, p.balance);
  // m12: §8a's ending row — "every control disabled" while the last seconds flush.
  const frozen = state === "ending";
  const stopFailure = p.stopFailed ? stopError(msg, state) : null;
  const targetList = p.targets.status === "ok" ? p.targets.list : [];
  const selected = targetList.find((t) => t.id === p.selectedTargetId);
  const optionText = (t: StreamTarget) => `${t.label} (${platformName(msg, t.kind)})`;
  // A target_in_use refusal whose holder still has a page to open (T8): the Open Match link.
  const inUseHolder = p.createError?.code === "target_in_use" ? p.createError.holder : null;
  // §3.2: the Signal path is drawn to the session's destination, or — with none — to the picked one. Neither (credits
  // only, a list loading, failed or empty) draws no chain: a path to nowhere says nothing. Ended and failed draw none.
  const chainTarget = p.view ? p.view.target : selected ?? null;
  const capture = legacy ? undefined : { phone: p.phone?.phone ?? null, countdown: p.view?.countdown ?? null };
  const drawn =
    !creditsOnly && !matchOver && chainTarget
      ? {
          to: chainTarget,
          chain: chainFor(p.view, { destInUse: state === "idle" && p.createError?.code === "target_in_use", capture }),
        }
      : null;
  // Option B rev 2: the phone's one message, in a strip under the chain (caret on the Phone node). Go live names it.
  // PR-2 (§7.4): credits only (B3) still says why an automatic start did not begin — the refusal alone; the tiles are its
  // remedy, so the strip offers no second Buy credits.
  const strip = matchOver ? null : creditsOnly ? autoRefusalStrip(p.phone) : phoneStrip(p.phone, p.view);
  const stripBuy = buyCard ? undefined : p.onShowBuy;
  // PR-2 T12 (§7.5): the takeover notice — the server's 30 minutes, this viewer's dismissal, the button to press first
  // (Stop live, Cancel while waiting). Only where Revoke & reissue is in reach (the fold or the code card): not credits
  // only, a match over, a legacy session, Ending (B7 review M-1: the fold is not drawn there), or the ended and failed cards.
  const takeover =
    legacy || creditsOnly || matchOver || state === "ending" || state === "ended" || state === "failed"
      ? null
      : takeoverNotice(p.phone, state, p.takeoverDismissedAt);
  const stripId = `stream-why-${p.fixtureId}`;
  // D3: the server-measured 30 s (M6) — a warning under the chain; the stream keeps running. I-1: phone first. §6.12:
  // the phone's sentence gives way to the strip while it shows the countdown or the paused reason.
  const d3 = d3Warning(p.view);
  const warned = d3 === "phone" && strip !== null ? null : d3;
  // Ended and failed are summary cards that carry their own (visible) pill.
  const summary = state === "ended" || state === "failed";
  const pickerId = `stream-target-${p.fixtureId}`;
  const inUseId = `stream-in-use-${p.fixtureId}`;
  // Mockup state 5: a target_in_use refusal at Ready is drawn on the picker — the red field, the box under it, and Go
  // live held until the organiser picks again (or the destination is freed).
  const inUseBox = state === "idle" && !buyCard && p.createError?.code === "target_in_use";
  // Spec §3.1: "Uses 1 credit · {n} credits · Buy more" — three parts, never one interpolated sentence (word order and
  // plural agreement differ by locale). "Uses 1 credit" only while Go live is the action under it and the start would
  // spend one (not inside the reuse window, I-1). The balance keeps the plural key's own text (`stream.phone.credits.*`
  // — the mockup's "9 left" reads "9 credits": a plan decision, the plural key is what keeps every locale grammatical);
  // the monthly/bought split is its `title`, and a visually hidden copy keeps it for screen readers.
  // §6.12 (rev 2): inside the reuse window the restart line above Go live says it — "1 credit" is said once.
  const usesShown = state === "idle" && !buyCard && p.restart === null;
  const creditParts: ReactNode[] = [];
  if (usesShown) creditParts.push(<span key="uses">{msg("stream.credits.uses")}</span>);
  if (p.balance >= 1) creditParts.push(balancePart(msg, p.balance, split));
  if (p.balance >= 1 && !p.planGate) creditParts.push(buyMorePart(msg, { expanded: p.showBuy, disabled: frozen, onClick: p.onShowBuy }));
  const creditsLine =
    !creditsOnly && creditParts.length > 0 ? (
      <p data-testid="stream-credits-line" className="mt-2 text-center text-xs text-slate-600">
        {creditParts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <span aria-hidden>{" · "}</span>}
            {part}
          </Fragment>
        ))}
      </p>
    ) : null;

  // W23: "Free restarts used (n of 3)" above Go live (and on the ended card) — emerald below the limit, amber at it.
  const restart = restartLine(p.restart);
  const restartEl = restart ? (
    <p
      data-testid="stream-restart"
      data-tone={restart.tone}
      className={`flex items-start gap-1.5 text-xs ${restart.tone === "emerald" ? "text-emerald-800" : "text-amber-800"}`}
    >
      <RotateCcw
        aria-hidden
        className={`mt-px h-3.5 w-3.5 shrink-0 ${restart.tone === "emerald" ? "text-emerald-600" : "text-amber-600"}`}
        strokeWidth={1.8}
      />
      <span>{msg(restart.key, restart.vars)}</span>
    </p>
  ) : null;

  // §6.12 (Option B rev 2): the code's QR, its paste code with Copy beneath it at every width, and Revoke & reissue —
  // the card's own content at Ready with no phone, and the body of "Show the code again" otherwise. The QR and the paste
  // code both carry a live tok: `ph-no-capture` on each (the QR's is `sensitive`). A finished match has no reissue (the
  // route refuses it, 422).
  const codeInner = (
    <>
      <div className="mt-2">
        {p.code.status === "ok" ? (
          p.code.image ? (
            <SeaznQrImage testId="stream-qr" sensitive qr={p.code.image} alt={msg("stream.phone.qr.alt")} maxSize={STREAM_QR_MAX_PX} />
          ) : (
            // The QR's own square and caption line, so the card keeps its size when the symbol lands (review m-7).
            <SeaznQrPlaceholder maxSize={STREAM_QR_MAX_PX} modules={seaznQrModules(p.code.text)} />
          )
        ) : p.code.status === "error" ? (
          <div data-testid="stream-code-error" role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-700">
            <span>{msg("stream.code.error")}</span>
            <button type="button" data-testid="stream-code-retry" onClick={p.onRetryCode} className="btn btn-ghost min-h-11 md:min-h-10">
              {msg("stream.dest.retry")}
            </button>
          </div>
        ) : (
          <SeaznQrPlaceholder maxSize={STREAM_QR_MAX_PX} modules={null} />
        )}
      </div>
      {p.code.status === "ok" && (
        <div data-testid="stream-qr-field" className="relative mt-2 w-full">
          <input
            data-testid="stream-qr-text"
            readOnly
            aria-label={msg("stream.phone.qr.field")}
            value={p.code.text}
            onFocus={(e) => e.currentTarget.select()}
            className="ph-no-capture h-11 w-full rounded-lg border border-purple-100 bg-slate-950 px-3 font-mono text-[11px] text-slate-100 outline-none focus:ring-2 focus:ring-purple-200"
          />
          <button type="button" data-testid="stream-qr-copy" onClick={p.onCopy} className="btn btn-ghost mt-1.5 h-11 w-full text-xs">
            {p.copied ? <Check aria-hidden className="h-3.5 w-3.5 text-green-600" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
            <span aria-live="polite">{p.copied ? msg("stream.phone.qr.copied") : msg("stream.phone.qr.copy")}</span>
          </button>
        </div>
      )}
      {!p.phone?.finished && (
        <div className="mt-1 flex justify-center">
          <button
            type="button"
            data-testid="stream-code-reissue"
            disabled={p.code.status === "loading"}
            onClick={p.onReissue}
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-red-700 underline decoration-red-300 underline-offset-2 hover:decoration-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.8} />
            {msg("stream.code.reissue")}
          </button>
        </div>
      )}
    </>
  );
  // Ready, paired (or silent): the card folds to one line. Ruling A (carry 3): Reissue is the organiser's remedy for a
  // stranger who scanned the code, so the same line stays while the session waits and while it is live.
  // The dot is the Phone node's and the strip's statement too (B8 re-review ruling): one fact, `phoneDot`.
  const facts = p.phone?.phone ?? null;
  const dot = phoneDot({ phone: facts, countdown: capture?.countdown ?? null });
  const codeDisclosure = (
    <details
      data-testid="stream-code-disclosure"
      open={p.codeOpen}
      onToggle={(e) => p.onToggleCode(e.currentTarget.open)}
      className="group min-w-0 rounded-lg bg-white ring-1 ring-purple-100"
    >
      {/* flex-wrap: on a narrow card "Show the code again" drops to its own line before "Paired · Pixel 8" would
          truncate (a label sized to its content, capped at the row, wraps the next item instead of shrinking). */}
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-sm [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          data-tone={dot}
          className={`h-2 w-2 shrink-0 rounded-full ${
            dot === "lime" ? "bg-[var(--mk-lime)] ring-1 ring-lime-600" : dot === "amber" ? "bg-amber-400" : "bg-slate-300"
          }`}
        />
        {facts && (
          // PR-2 T12 (§7.5, Option A): "Paired · Pixel 8" — the model the phone named, truncating first on a narrow card.
          <span data-testid="stream-code-paired" className="min-w-0 max-w-[calc(100%-1rem)] truncate">
            <span className="font-medium text-slate-800">{msg("stream.code.paired")}</span>
            {facts.model !== null && (
              <>
                <span aria-hidden className="text-slate-400">
                  {" · "}
                </span>
                <span className="text-slate-700">{facts.model}</span>
              </>
            )}
          </span>
        )}
        <span className="ml-auto shrink-0 pl-1 font-medium text-purple-700 underline decoration-purple-300 underline-offset-2">
          {msg("stream.code.showAgain")}
        </span>
        <ChevronRight
          aria-hidden
          className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          strokeWidth={1.8}
        />
      </summary>
      {p.codeOpen && <div className="px-3 pb-3">{codeInner}</div>}
    </details>
  );

  // PR-2 T10 (§7.1, Option A states 1–2): the switch under the picker — the whole row is the control (44 px), its caption
  // (the server's delay) only while on. Checked is the read model's `auto.enabled`, or the flip in flight.
  const autoOn = p.autoPending ?? p.phone?.auto?.enabled ?? false;
  const autoTitleId = `stream-auto-title-${p.fixtureId}`;
  const autoHintId = `stream-auto-hint-${p.fixtureId}`;
  // Owner-approved 2026-10-08: the note under the switch while it is on — why it will not start for this match (the server's
  // latch, final review I-1), else the paired phone in Operator (the beat's mode). One line, the latch first.
  const autoNote = autoSwitchNote(p.phone, autoOn);
  const autoNoteId = autoNote?.kind === "wontStart" ? `stream-auto-wont-start-${p.fixtureId}` : `stream-auto-operator-${p.fixtureId}`;
  const autoSwitch = (
    <div data-testid="stream-auto" className="mt-3">
      <button
        type="button"
        role="switch"
        data-testid="stream-auto-switch"
        aria-checked={autoOn}
        aria-labelledby={autoTitleId}
        aria-describedby={autoOn ? (autoNote ? `${autoHintId} ${autoNoteId}` : autoHintId) : undefined}
        disabled={p.autoPending !== null}
        onClick={() => p.onToggleAuto(!autoOn)}
        className="flex min-h-11 w-full items-start gap-3 rounded-lg bg-white p-3 text-left ring-1 ring-purple-100 disabled:cursor-wait"
      >
        <span
          aria-hidden
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors motion-reduce:transition-none ${autoOn ? "bg-[#1a1033]" : "bg-slate-300"}`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] motion-reduce:transition-none ${autoOn ? "left-[22px]" : "left-0.5"}`}
          />
        </span>
        <span className="min-w-0">
          <span id={autoTitleId} className="block text-sm font-medium text-slate-800">
            {msg("stream.auto.switch")}
          </span>
          {autoOn && (
            <span id={autoHintId} data-testid="stream-auto-hint" className="mt-0.5 block text-xs text-slate-600">
              {msgPlural("stream.auto.switchHint", p.autoStopMinutes, { count: p.autoStopMinutes })}
            </span>
          )}
        </span>
      </button>
      {autoNote && (
        <p
          id={autoNoteId}
          data-testid={autoNote.kind === "wontStart" ? "stream-auto-wont-start" : "stream-auto-operator"}
          data-reason={autoNote.kind === "wontStart" ? autoNote.reason : undefined}
          className="mt-1 flex gap-1.5 px-1 text-xs text-amber-800"
        >
          <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" strokeWidth={1.8} />
          <span className="min-w-0">{msg(autoNote.kind === "wontStart" ? AUTO_WONT_START_KEY[autoNote.reason] : "stream.auto.operatorHint")}</span>
        </p>
      )}
      {p.autoFailed && (
        <p data-testid="stream-auto-error" role="alert" className="mt-1 text-sm text-red-700">
          {msg("stream.error.failed")}
        </p>
      )}
    </div>
  );
  // §7.1: Live's read-only line — only when the server says §7.3 will stop this session (B7 review M-3), the server's delay.
  const autoLive = state === "live" && autoStopLine(p.phone, state);
  // §7.4 "behind a tap" (Q-D): the phone's data used and app version, after the runner's chips in Details (Live/Ending).
  const extraChips = phoneDetails(p.phone);

  return (
    // P5: the root marker the chooser's Close looks Buy more up from.
    <div data-phone-body>
      {/* T9b (spec §3.1): no heading and no visible pill — the Signal path below says the state, and the ended and failed
          cards carry the pill themselves. Here it stays for assistive tech (aria-live announces each change). Credits only
          (B3) has no state to announce. */}
      {!creditsOnly && !summary && statePill(msg, state, true)}

      {/* §3.2 (T9a): the Signal path replaces §8a's stepper — one drawing at every width; only its destination label
          moves (under its node at ≥ 768, its own line below). None at all while credits-only (B3). */}
      {drawn?.chain && (
        <SignalChain chain={drawn.chain} destination={{ kind: drawn.to.kind, label: drawn.to.label }}>
          {strip && <PhoneStripView id={stripId} strip={strip} caret onBuy={stripBuy} />}
        </SignalChain>
      )}
      {/* No chain to point at (no destination yet): the strip still says what the phone needs, without its caret. */}
      {!drawn?.chain && strip && <PhoneStripView id={stripId} strip={strip} caret={false} onBuy={stripBuy} />}
      {warned && p.view && <D3Warning cause={warned} kind={p.view.target.kind} />}
      {takeover && (
        // §7.5 (Option A 9a/9b): an inline amber strip with its own X — the time on the venue's clock.
        <div data-testid="stream-takeover" role="status" className="mt-3 flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert aria-hidden className="mt-px h-4 w-4 shrink-0 text-amber-600" strokeWidth={1.8} />
          <p data-testid="stream-takeover-text" className="min-w-0 flex-1">
            {takeover.model !== null
              ? msg(takeoverLineKey(takeover.act, true), { model: takeover.model, time: fmtTime(p.tz, takeover.at) })
              : msg(takeoverLineKey(takeover.act, false), { time: fmtTime(p.tz, takeover.at) })}
          </p>
          <button
            type="button"
            data-testid="stream-takeover-dismiss"
            aria-label={msg("stream.takeover.dismiss")}
            onClick={() => p.onDismissTakeover(takeover.at)}
            className="-my-1 -mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-md text-amber-700 hover:bg-amber-100 md:h-8 md:w-8"
          >
            <X aria-hidden className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
      )}

      {p.view?.fixtureDecided && (state === "live" || state === "ending") && (
        <p
          data-testid="stream-decided-chip"
          className="mt-2 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800"
        >
          {msg("stream.phone.decided")}
        </p>
      )}

      {p.planGate && (
        // I1: the refusal where the buy card goes — the switched-off state (I4), never a priced upgrade.
        <div data-testid="stream-plan-gate" className="mt-3 min-w-0">
          {switchedOff(msg)}
        </div>
      )}

      {matchOver && (
        // §6.12 "Code ended": the match is over and its code with it — no QR and no Go live.
        <p data-testid="stream-match-over" className="mt-4 text-sm text-slate-700">
          {msg("stream.phone.matchOver")}
        </p>
      )}

      {state === "idle" && !buyCard && !matchOver && (
        // Option B rev 2 (§6.12): the destination; the code card beside it from 768 (370 px, equal columns from 1024),
        // below it on a phone; then the restart line, Go live and the credits line under the picker.
        <div
          data-testid="stream-ready"
          className="mt-4 grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_370px] md:grid-rows-[auto_1fr] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        >
          <div className="min-w-0 md:col-start-1 md:row-start-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              {p.targets.status === "ok" && targetList.length > 0 ? (
                <label htmlFor={pickerId} className="text-sm font-medium text-slate-800">
                  {msg("stream.dest.label")}
                </label>
              ) : (
                <span className="text-sm font-medium text-slate-800">{msg("stream.dest.label")}</span>
              )}
              {/* D1: destinations are added, renamed and removed in Directory only — never inline here. */}
              <a
                data-testid="stream-manage-destinations"
                href={MANAGE_DESTINATIONS_HREF}
                target="_blank"
                rel="noopener"
                className={`${LINK} inline-flex min-h-11 items-center gap-1 text-sm md:min-h-0`}
              >
                {msg("stream.dest.manage")}
                <ExternalLink aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} />
              </a>
            </div>
            {p.targets.status === "error" ? (
              <div data-testid="stream-dest-load-error" role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-red-700">
                <span>{msg("stream.dest.loadError")}</span>
                <button type="button" data-testid="stream-dest-retry" onClick={p.onRetryTargets} className="btn btn-ghost min-h-11 md:min-h-10">
                  {msg("stream.dest.retry")}
                </button>
              </div>
            ) : p.targets.status === "ok" && targetList.length === 0 ? (
              <p data-testid="stream-dest-empty" className="mt-1 text-sm text-slate-600">
                {msg("stream.dest.empty")}
              </p>
            ) : p.targets.status === "ok" ? (
              // Mockup state 1: the platform's mark inside the field, a chevron at its end. `min-w-0` down the chain and
              // `pr-9` so a long label stops before the chevron instead of running under it (B7, the 320 picker).
              <div className="relative mt-1 min-w-0">
                {selected && (
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
                    <PlatformMark kind={selected.kind} size="sm" />
                  </span>
                )}
                <select
                  id={pickerId}
                  data-testid="stream-target"
                  // B7: a phone's native select clips a long label — the title still names the selection.
                  title={selected ? optionText(selected) : undefined}
                  value={p.selectedTargetId ?? ""}
                  onChange={(e) => p.onSelectTarget(e.target.value)}
                  aria-invalid={inUseBox || undefined}
                  aria-describedby={inUseBox ? inUseId : undefined}
                  className={`${FIELD} appearance-none truncate pr-9 ${selected ? "pl-10" : "pl-3"} ${
                    inUseBox ? "border-red-300 ring-1 ring-red-200" : ""
                  }`}
                >
                  {!selected && (
                    // n1: nothing picked (the choice was removed in Directory) — a placeholder, never a destination
                    // chosen for them. Disabled, so it cannot be picked back.
                    <option value="" disabled>
                      {msg("stream.dest.pick")}
                    </option>
                  )}
                  {targetList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {optionText(t)}
                    </option>
                  ))}
                </select>
                <ChevronRight
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-slate-600"
                  strokeWidth={1.8}
                />
              </div>
            ) : null}
            {p.pickFailed && (
              <p data-testid="stream-pick-error" role="alert" className="mt-1 text-sm text-red-700">
                {msg("stream.dest.pickFailed")}
              </p>
            )}
            {inUseBox && p.createError && (
              // §3.3 / mockup state 5: the refusal sits under the picker it is about, with the holder's page beside it.
              <div id={inUseId} role="alert" className="mt-2 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <CircleAlert aria-hidden className="h-5 w-5 shrink-0" strokeWidth={1.8} />
                <p className="min-w-0">
                  <span data-testid="stream-create-error">{createErrorText(p.createError, msg)}</span>
                  {inUseHolder?.href && inUseHolder.matchNo !== null && (
                    <>
                      {" "}
                      <a
                        data-testid="stream-in-use-open"
                        href={inUseHolder.href}
                        className="inline-flex min-h-11 items-center font-medium text-red-800 underline decoration-red-300 underline-offset-2 hover:decoration-red-700 md:min-h-0"
                      >
                        {msg("stream.inUse.open", { match: msg("breadcrumb.match", { no: inUseHolder.matchNo }) })}
                      </a>
                    </>
                  )}
                </p>
              </div>
            )}
            {autoSwitch}
          </div>
          <div className={ready === "no_phone" ? "min-w-0 md:col-start-2 md:row-start-1 md:row-span-2" : "min-w-0 md:col-start-2 md:row-start-1 md:row-span-2 md:mt-6"}>
            {ready === "no_phone" ? (
              <div data-testid="stream-code-card" className="min-w-0 rounded-lg bg-white p-3 ring-1 ring-purple-100">
                <p className="text-sm font-semibold text-slate-900">{msg("stream.code.scan")}</p>
                {codeInner}
              </div>
            ) : (
              codeDisclosure
            )}
          </div>
          <div className="min-w-0 space-y-4 md:col-start-1 md:row-start-2">
            {restartEl}
            <div>
              <button
                type="button"
                data-testid="stream-go-live"
                // T8: only a LOADED, non-empty list can start — `targetList` is empty while the read is pending or failed, so a
                // failed or pending read offers nothing to stream to, and neither does a selection left over from before.
                // Mockup state 5: a destination another match holds cannot start until it is picked again or freed.
                // §6.12 (W5): and only with a phone paired and answering — the strip above says why not.
                disabled={p.busy || !p.selectedTargetId || targetList.length === 0 || inUseBox || !canGoLive(ready)}
                aria-describedby={strip ? stripId : undefined}
                onClick={p.onGoLive}
                className="btn btn-primary min-h-12 w-full text-base"
              >
                {msg("stream.phone.goLive")}
              </button>
              {creditsLine}
            </div>
          </div>
        </div>
      )}

      {(state === "provisioning" || state === "warming") && (
        // §6.12 Waiting: no QR (the phone is already paired) — the strip above says what it waits for, then the far
        // cadence's line (§6.6) while the phone is on it, and Cancel. (A legacy session has no phone facts at all —
        // stream-phone.ts serves `phone: null` with `legacy: true` — so the line needs no legacy test of its own.)
        <div data-testid="stream-waiting" className="mt-4 space-y-3">
          {p.phone?.phone?.farPoll && (
            <p data-testid="stream-poll-far" className="text-xs text-slate-600">
              {msg("stream.phone.pollFar")}
            </p>
          )}
          <button
            type="button"
            data-testid="stream-cancel"
            disabled={p.busy}
            onClick={p.onCancel}
            className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
          >
            {msg("stream.phone.cancel")}
          </button>
          {!legacy && codeDisclosure}
        </div>
      )}

      {(state === "live" || state === "ending") && p.view && (
        // §3.3 Live (mockup state 3): On air and the elapsed time, a full-width Stop, then the closed Details.
        <div className="mt-4 space-y-4">
          {autoLive && (
            <p data-testid="stream-auto-live" className="text-xs text-slate-600">
              {msgPlural("stream.auto.liveLine", p.autoStopMinutes, { count: p.autoStopMinutes })}
            </p>
          )}
          {state === "live" ? (
            <div className="grid items-center gap-3 md:grid-cols-[auto_1fr] md:gap-6">
              <div className="flex items-center gap-3 md:flex-col md:items-start md:gap-0.5">
                <span data-testid="stream-on-air" className="text-xs font-medium uppercase tracking-wide text-slate-600">
                  {msg("stream.onAir")}
                </span>
                <span data-testid="stream-elapsed" className="font-mono text-3xl font-semibold tabular-nums text-slate-900">
                  {elapsedLabel(p.view.startedAt, p.now)}
                </span>
              </div>
              <button type="button" data-testid="stream-stop" disabled={p.busy} onClick={p.onStop} className={STOP_STREAM}>
                {msg("stream.phone.stop")}
              </button>
            </div>
          ) : (
            <p data-testid="stream-ending" className="text-xs text-slate-600">
              {msg("stream.phone.ending", { destination: p.view.target.label })}
            </p>
          )}
          {/* §3.3 (T9a): the health chips are Details — closed by default; the chain above carries the state. */}
          <details data-testid="stream-details" className="group rounded-lg border border-slate-200 bg-white">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden className="h-4 w-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.8} />
              {msg("stream.details")}
            </summary>
            <div data-testid="stream-health" className="flex flex-wrap gap-2 px-3 pb-3">
              {healthChips(p.view, msg, p.now, locale).map((c, i) => (
                <span
                  key={i}
                  data-testid="stream-health-chip"
                  className={`rounded-md px-2 py-1 text-[11px] ${
                    c.stale ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {c.text}
                </span>
              ))}
              {extraChips.map((c) =>
                c.kind === "dataUsed" ? (
                  <span key="data" data-testid="stream-phone-data-used" className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700">
                    {msg("stream.phone.dataUsed", { n: fmtNumber(locale, c.mb, { maximumFractionDigits: 1 }) })}
                  </span>
                ) : (
                  <span key="app" data-testid="stream-phone-app-version" className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-700">
                    {msg("stream.phone.appVersion", { version: c.version })}
                  </span>
                ),
              )}
            </div>
          </details>
          {!legacy && state === "live" && codeDisclosure}
        </div>
      )}

      {state === "ended" && p.view && (
        <div data-testid="stream-ended" className={SUMMARY_CARD}>
          {statePill(msg, state)}
          <div className="flex flex-wrap gap-1">
            {/* P6: `startedAt` is stamped only when a session goes live (relay/domain/session.ts), so an ended one
                without it never went live — a Cancel on the QR, a camera that never connected. "Duration 0:00" read
                as a broadcast that happened; this says what did. */}
            {p.view.startedAt === null ? (
              <span data-testid="stream-ended-never-live" className={CHIP}>
                {msg("stream.phone.ended.neverLive")}
              </span>
            ) : (
              <span data-testid="stream-ended-duration" className={CHIP}>
                {msg("stream.phone.ended.duration", {
                  duration: elapsedLabel(p.view.startedAt, p.view.endedAt ? new Date(p.view.endedAt) : p.now),
                })}
              </span>
            )}
            {/* D3: only when THIS session's consume still stands — a restart inside the reuse window, or a refunded
                consume, used nothing, and the chip must not claim it did. */}
            {p.view.creditUsed && (
              <span data-testid="stream-credit-used" className={CHIP}>
                {msg("stream.phone.ended.credits")}
              </span>
            )}
            {/* P7: never live ⇒ the chip above is the whole story. Its end reason ("Stopped by you", on a Cancel from the
                QR) only restated what the organiser had just done, as a second chip for one fact. */}
            {p.view.endReason && p.view.startedAt !== null && (
              <span data-testid="stream-end-reason" className={CHIP}>
                {/* W19: `phone_lost` names the window the server ended it by — its own number, never one typed into the
                    copy. The other reasons carry no placeholder and ignore it. */}
                {msg(END_REASON_KEYS[p.view.endReason], { minutes: p.phoneLostMinutes })}
              </span>
            )}
          </div>
          {restartEl}
          <div className="flex flex-col gap-2 md:flex-row">
            {p.view.replayUrl && (
              <a
                data-testid="stream-replay"
                href={p.view.replayUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
              >
                {msg("stream.phone.replay")}
              </a>
            )}
            <button
              type="button"
              data-testid="stream-again"
              onClick={p.onAgain}
              className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
            >
              {msg("stream.phone.again")}
            </button>
          </div>
        </div>
      )}

      {state === "failed" && p.view && (
        <div data-testid="stream-failed" className={SUMMARY_CARD}>
          {statePill(msg, state)}
          <p
            data-testid="stream-fail-reason"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-800"
          >
            {/* m11: V410's fail_reason is a nullable text column with no CHECK — a row with none is not a machine crash. */}
            {msg(p.view.failReason ? FAIL_REASON_KEYS[p.view.failReason] : "stream.fail.unknown")}
          </p>
          <button
            type="button"
            data-testid="stream-retry"
            onClick={p.onAgain}
            className="btn btn-primary min-h-11 w-full md:min-h-10 md:w-auto"
          >
            {msg("stream.phone.retry")}
          </button>
        </div>
      )}

      {/* m1: D14's unreadable stop or cancel — only while the session is still up (the guard is `stopError`'s own). */}
      {stopFailure && <div className="mt-3">{stopFailure}</div>}

      {/* A refused create — in whatever state the refusal left the tab. An in-use refusal at Ready is under the picker. */}
      {p.createError && !inUseBox && (
        <p data-testid="stream-create-error" role="alert" className="mt-3 text-xs text-red-700">
          {createErrorText(p.createError, msg)}
        </p>
      )}
      {/* T8: the holding match's page, when it still has one — a deleted fixture has neither a number nor a page. */}
      {!inUseBox && inUseHolder?.href && inUseHolder.matchNo !== null && (
        <a data-testid="stream-in-use-open" href={inUseHolder.href} className={`${LINK} inline-flex min-h-11 items-center text-xs md:min-h-0`}>
          {msg("stream.inUse.open", { match: msg("breadcrumb.match", { no: inUseHolder.matchNo }) })}
        </a>
      )}

      {/* Spec §3.1: the credits are one line. At Ready it sits under Go live (above); in a session it closes the tab, where
          Buy more stays a mid-match top-up. */}
      {!(state === "idle" && !buyCard) && creditsLine}
      {buyCard &&
        creditsCard(msg, locale, {
          currency: p.currency,
          monthlyAllowance: p.monthlyAllowance,
          tilesDisabled: p.busy || frozen || p.checkoutOpen,
          checkoutError: p.checkoutError,
          closable: p.showBuy && !forced,
          closeDisabled: frozen,
          rootMarker: "[data-phone-body]",
          onBuy: p.onBuy,
          onShowBuy: p.onShowBuy,
          onTileIntent: p.onTileIntent,
        })}

    </div>
  );
}
