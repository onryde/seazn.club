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
  Component, useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode,
} from "react";
import { Check, Copy, RotateCcw, Smartphone, Video } from "lucide-react";
import QRCode from "qrcode";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { defaultThemeFor, themesForSport, type ThemeId } from "@/components/overlay/theme-registry";
import { fetchOverlayFixture, type OverlayLiveData } from "@/components/public-site/live-score-data";
import { useConfirm } from "@/components/ui/confirm-provider";
import { useDict, useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { fetchRelayCheckoutClientSecret } from "@/lib/billing-checkout-client";
import { apiV1 } from "@/lib/client-v1";
import { loadCheckoutSheet } from "./stream-checkout-sheet-loader";
import type { MessageKey } from "@/lib/messages";
import { overlayStartLabel, type OverlaySideInput } from "@/lib/overlay-model";
import { OVERLAY_KEY_PARAM } from "@/lib/realtime-purpose";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { formatMinor, type Currency } from "@/lib/currency";
import {
  STREAM_CREDIT_PACKS, streamPackAmountMinor, streamPackPerMatchMinor, type StreamPackSize,
} from "@/lib/stream-credit-packs";
import { STREAM_PLATFORMS, type StreamPlatform } from "@/lib/stream-destinations";
import {
  DESTINATION_REFUSAL_KEYS,
  END_REASON_KEYS,
  FAIL_REASON_KEYS,
  STATE_PILL_KEYS,
  STEP_KEYS,
  STREAM_POLL_MS,
  createErrorCode,
  createErrorHolder,
  createErrorText,
  elapsedLabel,
  healthChips,
  phoneTabState,
  qrText,
  stepFor,
  targetRefusalRule,
  type CreateErrorCode,
  type CreateErrorHolder,
  type PhoneTabState,
  type StreamSessionView,
} from "@/lib/stream-session-view";
import { streamUrlSchema } from "@/lib/stream-url";
// TYPES only: `@/server/**` is server code, and a runtime import from a client island breaks the build.
import type { StreamTarget } from "@/server/api-v1/schemas";

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
  const [tab, setTab] = useState<"obs" | "phone">(() => (returnedHere ? "phone" : "obs"));

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
  }, [tab]);

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
        : "text-slate-500 hover:bg-purple-50 hover:text-purple-700"
    }`;

  return (
    // §8a: the Phone tab's card drops to `p-4` below 768 (the QR box lives inside it, and `p-5` costs the symbol 8 CSS
    // px at 320); §8's OBS card keeps `p-5` at every width. The two tabs are never side by side.
    <section
      ref={landOn}
      data-testid="stream-panel"
      className={`card mt-2 scroll-mt-24 ${tab === "phone" ? "p-4 md:p-5" : "p-5"}`}
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <Video className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
        {msg("stream.title")}
      </h3>
      {/* B1: W1's lead line promises a scorebug to paste into OBS — the OBS tab's promise. §8a's Phone frame has no lead. */}
      {tab === "obs" && (
        <p data-testid="stream-lead" className="mt-1 text-xs text-slate-500">
          {msg("stream.line")}
        </p>
      )}

      {/* Owner 2026-09-07: streaming is bought in the fixture console itself,
          so the panel carries both tiers. Tier B's session controls are R1's;
          W1 ships the tab and §5.3's gate. */}
      <div role="tablist" aria-label={msg("stream.tabs.label")} className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "obs"}
          data-testid="stream-tab-obs"
          onClick={() => setTab("obs")}
          className={tabClass(tab === "obs")}
        >
          {msg("stream.tab.obs")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "phone"}
          data-testid="stream-tab-phone"
          onClick={() => setTab("phone")}
          className={tabClass(tab === "phone")}
        >
          {msg("stream.tab.phone")}
        </button>
      </div>

      {tab === "obs" ? (
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
            <p data-testid="stream-preview-note" className="mt-1 text-[11px] text-slate-500">
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
            <p data-testid="stream-error" className="mt-1 text-xs text-red-600">
              {error}
            </p>
          )}
          <p className="mt-2 text-[11px] text-slate-500">{msg("stream.footnote")}</p>
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
            />
          )}
        </div>
      )}
    </section>
  );
}

// ─── The Phone tab (Streaming R1, lane D) ─────────────────────────────────────────────────────────────────────────────
// §8a option A ("Stepper") and §8b option A ("Three tiles"), values from `_THEMES.md`. Three pieces, each tested where
// it CAN be in a node harness: `PhoneTab` (the container — fetch, poll, reveal and every action), `PhoneTabBody` (pure:
// every state is a function of its props) and `TargetForm` (the destination form, which holds its own fields).

/** §7.6 via §8a's `QR encoding` row: EC-M and a 4-module quiet zone. `width` is the RASTER size — twice §8a's 264 CSS
 *  px box, so the symbol stays crisp on a 2× screen; the box, not this number, decides the painted size. */
export const QR_RENDER_OPTIONS = { errorCorrectionLevel: "M", margin: 4, width: 528 } as const;

/** §8a's QR box: 264 CSS px of symbol + its `p-3` twice + its 1-px border twice. The paste-code field takes the SAME
 *  class, which is what "the QR box's own width, not the card's" means — two elements that cannot drift apart. */
const QR_COLUMN_W = "w-full max-w-[290px]";

/** The platform select's options (D6: YouTube and Twitch only) — lib/stream-destinations.ts STREAM_PLATFORMS itself,
 *  held EQUAL to the create schema's `StreamPlatform` enum by the panel test. */
export const TARGET_KINDS = STREAM_PLATFORMS;

/** Brand names are not copy. D6: the form offers the two platforms only — never an enum id, never LinkedIn. */
const KIND_BRAND: Record<StreamPlatform, string> = {
  youtube: "YouTube",
  twitch: "Twitch",
};

/**
 * Arrow-key movement through a radiogroup (WAI-ARIA radio pattern): Right/Down forward, Left/Up back, wrapping, and
 * over the ENABLED options only — composed ("With scorebug") is disabled this wave, so an arrow never selects it. Any
 * other key leaves the selection where it is. Pure, so the node harness can pin it.
 */
export function stepRadio(options: readonly { id: string; enabled: boolean }[], current: string, key: string): string {
  const dir = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (dir === 0) return current;
  const enabled = options.filter((o) => o.enabled);
  const at = enabled.findIndex((o) => o.id === current);
  if (at === -1) return enabled[0]?.id ?? current;
  return enabled[(at + dir + enabled.length) % enabled.length]!.id;
}

type FeedMode = "clean" | "scorebug";
const MODE_OPTIONS = [
  { id: "clean", enabled: true },
  { id: "scorebug", enabled: false },
] as const;
const ARROW = /^Arrow(Up|Down|Left|Right)$/;

type CreateError = { code: CreateErrorCode; holder: CreateErrorHolder | null };
/** D13: which sentence a refused checkout gets — keyed on the route's STATUS (`CheckoutSecretResult` has no code). */
type CheckoutError = "owner" | "unknown";
type TargetFormValues = { kind: StreamPlatform; label: string; streamKey: string; watchUrl: string };

/**
 * One fixture's relay session as the organiser sees it — shared by the Phone tab and the unentitled stop probe (G2), so
 * the two cannot disagree about what "stop" means. Reads `current` on mount and polls it at STREAM_POLL_MS while the
 * session is not terminal, or no read has landed yet (m3) (the SERVER flips warming → live on that read; the client
 * never decides), ticks a 1-s clock
 * while live, and owns the two ways out: Stop (confirmed — it is on air) and Cancel (re-read first — m3).
 */
function usePhoneSession(fixtureId: string) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [view, setView] = useState<StreamSessionView | null>(null);
  // "Start another" / "Try again" put the tab back to idle WITHOUT forgetting the server's answer. `current` returns
  // the LATEST session in any state, terminal ones included, so every later read (the refresh after a refused create,
  // in particular) would otherwise resurrect the finished card over the refusal it was meant to explain.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // m1: a stop that neither landed nor could be confirmed by a re-read. Its own state and its own sentence — the create
  // copy ("That did not start") says the opposite of what happened.
  const [stopFailed, setStopFailed] = useState(false);
  // m3 (lane-close fix): the mount's read FAILED, so "no view" is not known to mean "nothing is up". Until a read lands,
  // the idle it shows is a guess and is polled like any other unsettled state — a stream on air behind one dropped
  // request would otherwise leave the stop probe drawing nothing, and the tab offering Go live, until a reload.
  const [readFailed, setReadFailed] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // `reveal` marks a read as the organiser DISCLOSING the credentials rather than the 5-second poll (De). Only two
  // things set it: the first showing of a session's QR, and a tap on Copy. Mount, poll and post-action reads are polls.
  const read = useCallback(
    async (reveal = false) => {
      const cur = await apiV1<StreamSessionView | null>(
        `/api/v1/fixtures/${fixtureId}/stream-sessions/current${reveal ? "?reveal=1" : ""}`,
      );
      setView(cur);
      setLoaded(true);
      setReadFailed(false);
      setNow(new Date());
      return cur;
    },
    [fixtureId],
  );

  useEffect(() => {
    void (async () => {
      try {
        await read();
      } catch {
        setLoaded(true); // an unreadable first read still leaves the tab usable: idle, from the page's balance
        setReadFailed(true);
      }
    })();
  }, [read]);

  const shown = view && view.id !== dismissedId ? view : null;
  const state = phoneTabState(shown);
  const terminal = state === "idle" || state === "ended" || state === "failed";
  useEffect(() => {
    if (terminal && !readFailed) return;
    const id = setInterval(() => {
      void read().catch(() => {});
    }, STREAM_POLL_MS);
    return () => clearInterval(id);
  }, [terminal, readFailed, read]);

  // The elapsed clock ticks every second while live, rather than jumping by the poll interval.
  useEffect(() => {
    if (state !== "live") return;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [state]);

  const stopNow = async (target: StreamSessionView) => {
    setBusy(true);
    setStopFailed(false);
    try {
      setView(
        await apiV1<StreamSessionView>(`/api/v1/fixtures/${fixtureId}/stream-sessions/${target.id}/stop`, {
          method: "POST",
        }),
      );
    } catch {
      // D14: a refused stop is most often a session that has already ended (409 not_active) — read the server again
      // and show what is there. Only when that read fails too is there nothing true to show but "tap Stop again".
      try {
        await read();
      } catch {
        setStopFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmThenStop = async (target: StreamSessionView) => {
    const ok = await confirm({
      title: msg("stream.phone.stop.title"),
      body: msg("stream.phone.stop.body"),
      confirmLabel: msg("stream.phone.stop"),
      tone: "danger",
      // P3: the cancel says what it does, in the PAGE's locale — the provider's default reads the `seazn_locale` cookie.
      cancelLabel: msg("stream.phone.stop.keep"),
      // P4: the most consequential button in the flow gets the 44-px phone floor.
      size: "touch",
    });
    if (ok) await stopNow(target);
  };

  const stop = async () => {
    if (shown) await confirmThenStop(shown);
  };

  // m3: Cancel is offered on the QR, where nothing is on air — so it asks nothing. But the phone can connect while the
  // QR is on screen, and a Cancel tapped then is a LIVE stop that must be confirmed like any other. So it reads first:
  // still provisioning / warming → stop now; live → the confirming stop; anything else (it ended or failed on its own)
  // → the read already shows it. A read that FAILS leaves nobody knowing whether it is on air, so it asks.
  const cancel = async () => {
    if (!shown) return;
    const target = shown;
    setBusy(true);
    let fresh: StreamSessionView | null;
    try {
      fresh = await read();
    } catch {
      setBusy(false);
      await confirmThenStop(target);
      return;
    }
    setBusy(false);
    if (!fresh || fresh.id !== target.id) return;
    const at = phoneTabState(fresh);
    if (at === "live") await confirmThenStop(fresh);
    else if (at === "provisioning" || at === "warming") await stopNow(fresh);
  };

  const dismiss = () => {
    setDismissedId(view?.id ?? null);
    setStopFailed(false);
  };

  return { view, shown, state, loaded, busy, setBusy, now, read, stop, cancel, stopFailed, dismiss };
}

/**
 * G2 — the Phone tab's stop controls, for an org that no longer holds `streaming.relay` (a downgrade, an expired
 * override) while one of its streams is still up. The gate below it sells the feature; this keeps what is ALREADY on
 * air stoppable. Nothing but the session's own state and its way out: no QR (no credentials), no destinations, no
 * buying. Renders nothing at all without a session that is still up, so an unentitled org with nothing running sees
 * the gate alone.
 *
 * F1: also mounted by the division page itself, once per fixture still on air, when a BILLING freeze has taken the
 * whole stream panel away (the panel is gated on `editable`). Several can stack there, so each names its fixture
 * (`label`); inside a row's own panel the row already says which fixture it is, and no label is passed.
 */
export function PhoneStopProbe({ fixtureId, label }: { fixtureId: string; label?: string }) {
  const msg = useMsg();
  const s = usePhoneSession(fixtureId);
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
        <p data-testid="stream-ending" className="text-xs text-slate-500">
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
}: {
  fixtureId: string;
  orgId: string;
  streamBalance: number;
  streamSplit: StreamCreditSplit | null;
  monthlyAllowance: number;
  currency: Currency;
}) {
  const msg = useMsg();
  const session = usePhoneSession(fixtureId);
  const { view, shown, state, read, setBusy } = session;
  const [targets, setTargets] = useState<StreamTarget[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [mode, setMode] = useState<FeedMode>("clean");
  const [createError, setCreateError] = useState<CreateError | null>(null);
  const [checkoutError, setCheckoutError] = useState<CheckoutError | null>(null);
  const [checkoutSecret, setCheckoutSecret] = useState<string | null>(null);
  // C22 / D12: the ORG's plan lost the feature between the page load and the tap (a downgrade, an override expiring).
  const [planGate, setPlanGate] = useState(false);
  // m2: the server refused a create for want of credits — the page's balance is stale, so this tab reads 0 until the
  // next page load (a checkout return is one).
  const [noCredits, setNoCredits] = useState(false);
  const [qrImage, setQrImage] = useState<{ text: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [showTargetForm, setShowTargetForm] = useState(false);
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

  useEffect(() => {
    void (async () => {
      try {
        // created_at order (listStreamTargets), so the first is the org's oldest destination.
        const list = await apiV1<StreamTarget[]>(`/api/v1/orgs/${orgId}/stream-targets`);
        setTargets(list);
        setSelectedTargetId((cur) => cur ?? list[0]?.id ?? null);
      } catch {
        // an unreadable list reads as none: the select says to add one and Go live stays disabled
      }
    })();
  }, [orgId]);

  // The QR is rendered CLIENT-SIDE from the projection — never in page HTML. m10: keyed on the payload STRING, not the
  // object — every poll is a fresh object off the wire, and an object key re-encoded the same symbol on each. The ref
  // keeps the reveal to ONCE per session (De), not once per poll.
  const qr = shown?.qr ?? null;
  const sessionId = shown?.id ?? null;
  const qrPayload = qr ? qrText(qr) : null;
  const revealedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!qrPayload || !sessionId) return;
    if (revealedFor.current !== sessionId) {
      revealedFor.current = sessionId;
      void read(true).catch(() => {});
    }
    let cancelled = false;
    void QRCode.toDataURL(qrPayload, QR_RENDER_OPTIONS)
      .then((url) => {
        if (!cancelled) setQrImage({ text: qrPayload, url });
      })
      .catch(() => {
        // the paste code below the box is always rendered (§8a), so a failed encode still leaves a way in
      });
    return () => {
      cancelled = true;
    };
  }, [qrPayload, sessionId, read]);
  // Only the image of THIS payload: until the encoder answers for a new one, the box is the placeholder, never the
  // previous session's symbol under the new session's paste code.
  const qrDataUrl = qrImage && qrImage.text === qrPayload ? qrImage.url : null;

  // C1: with a session, the projection's `balance` is the fresher number. With NO session there is no projection at
  // all, so the server-resolved one is the only source — unless the server has since refused for want of credits (m2).
  const balance = view ? view.balance : noCredits ? 0 : streamBalance;

  const onGoLive = async () => {
    if (!selectedTargetId) return;
    setBusy(true);
    setCreateError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/stream-sessions`, {
        method: "POST",
        json: { mode: "passthrough", targetId: selectedTargetId },
      });
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
      setCreateError({ code, holder: createErrorHolder(err) });
    }
    // Either way the server's state is the answer: the new session, or — after a refusal — whatever is there (an
    // `active_session` refusal's running session IS the explanation; a dismissed card stays dismissed).
    await read().catch(() => {});
    setBusy(false);
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

  const onCopy = async () => {
    if (!shown?.qr) return;
    try {
      await navigator.clipboard.writeText(qrText(shown.qr));
    } catch {
      return; // a browser that refuses the clipboard leaves the field selectable; nothing was taken
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    void read(true).catch(() => {}); // De: taking the paste code IS a reveal
  };

  const onSaveTarget = async (form: TargetFormValues) => {
    const watchUrl = form.watchUrl.trim();
    const made = await apiV1<StreamTarget>(`/api/v1/orgs/${orgId}/stream-targets`, {
      method: "POST",
      json: {
        kind: form.kind,
        label: form.label,
        streamKey: form.streamKey,
        ...(watchUrl ? { watchUrl } : {}),
      },
    });
    // D11: A19 answers a re-save of the SAME destination with the existing row — replace it by id, never append a twin
    // (a duplicate option and a duplicate React key).
    setTargets((list) =>
      list.some((t) => t.id === made.id) ? list.map((t) => (t.id === made.id ? made : t)) : [...list, made],
    );
    setSelectedTargetId(made.id);
    setShowTargetForm(false);
  };

  // I1: a plan refusal REPLACES the tab only when there is nothing to protect. With a session up, Stop (and Cancel)
  // must survive it — the body renders the gate in the buy slot instead.
  if (planGate && state === "idle") return switchedOff(msg);
  if (!session.loaded) {
    return (
      <p data-testid="stream-loading" role="status" aria-busy="true" className="text-xs text-slate-500">
        <span aria-hidden>…</span>
        <span className="sr-only">{msg("stream.phone.loading")}</span>
      </p>
    );
  }
  return (
    <>
      <PhoneTabBody
        view={shown}
        balance={balance}
        targets={targets}
        busy={session.busy}
        createError={createError}
        checkoutError={checkoutError}
        selectedTargetId={selectedTargetId}
        mode={mode}
        qrDataUrl={qrDataUrl}
        now={session.now}
        copied={copied}
        showTargetForm={showTargetForm}
        showBuy={showBuy}
        planGate={planGate}
        stopFailed={session.stopFailed}
        checkoutOpen={checkoutSecret !== null}
        currency={currency}
        split={streamSplit}
        monthlyAllowance={monthlyAllowance}
        // I-1: off the RAW view, not `shown` — Start another / Try again dismiss the card, and the fixture's reuse window
        // is exactly what the next start is asking about. No session ever → nothing consumed → no window.
        restartFree={view?.restartFree ?? false}
        onSelectTarget={setSelectedTargetId}
        onAddTarget={() => setShowTargetForm((v) => !v)}
        onMode={setMode}
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
        // Buy more and the chooser's Close (B6) are one toggle; either way a refusal from the last attempt goes.
        onShowBuy={() => {
          setShowBuy((v) => !v);
          setCheckoutError(null);
        }}
        onSaveTarget={onSaveTarget}
        onTileIntent={onTileIntent}
      />
      {checkoutSecret && (
        // M1: a sheet that cannot load is the same outcome as a refused checkout — the lock freed, the chooser back
        // with its tiles, the checkout's own copy — and never the page's error screen.
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
      )}
    </>
  );
}

export interface PhoneTabBodyProps {
  view: StreamSessionView | null;
  balance: number;
  /** Task 14b (R4): the page's split of the balance by bucket. Shown as "{m} free this month · {p} bought" under the
   *  chip only while the org holds free credits AND the split still adds up to `balance` — once a session's projection
   *  moves the balance, the page's split is stale and says nothing rather than something wrong. */
  split: StreamCreditSplit | null;
  /** Task 14b (R4): the plan's free match credits per month; the credits card's note names it. None below 1. */
  monthlyAllowance: number;
  targets: StreamTarget[];
  busy: boolean;
  createError: CreateError | null;
  checkoutError: CheckoutError | null;
  selectedTargetId: string | null;
  mode: FeedMode;
  qrDataUrl: string | null;
  now: Date;
  copied: boolean;
  showTargetForm: boolean;
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
  /** I-1: the projection's `restartFree` — a start on this fixture now would be admitted without a credit (the reuse
   *  window). At balance 0 it is what keeps Go live reachable instead of the forced chooser. */
  restartFree: boolean;
  onSelectTarget: (id: string) => void;
  onAddTarget: () => void;
  onMode: (m: FeedMode) => void;
  onGoLive: () => void;
  onStop: () => void;
  onCancel: () => void;
  onBuy: (pack: StreamPackSize) => void;
  onAgain: () => void;
  onCopy: () => void;
  onShowBuy: () => void;
  onSaveTarget: (form: TargetFormValues) => Promise<void>;
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
  "mt-1 min-h-11 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200 md:min-h-10";

/** §8a: solid red, deliberately NOT `.btn-danger` (a white outline) — the one irreversible control on a panel that is
 *  on air. It opens the repo's confirm dialog. Shared by the tab and the stop probe (G2). */
const STOP_BUTTON =
  "min-h-11 w-full rounded-md bg-red-600 px-3 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-10 md:w-auto";

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

function statePill(msg: Msg, state: PhoneTabState) {
  return (
    <span
      data-testid="stream-state-pill"
      aria-live="polite"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${PILL[state]}`}
    >
      {state === "live" && (
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
    <p data-testid="stream-stop-error" role="alert" className="text-xs text-red-600">
      {msg(key)}
    </p>
  );
}

/** §8a option A (Stepper) + §8b option A (Three tiles) — values from the sheet. Pure. */
export function PhoneTabBody(p: PhoneTabBodyProps) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const state = phoneTabState(p.view);
  const step = stepFor(state);
  const credits =
    p.balance === 1 ? msg("stream.phone.credits.one") : msg("stream.phone.credits.other", { n: p.balance });
  // The chooser opens either because the org cannot start without credits (FORCED — there is nothing behind it to go
  // back to), or because the organiser asked for it from "Buy more" — mid-session included. A plan refusal (I1) takes
  // its slot: buying is exactly what the plan refused. I-1: NOT forced when the restart is free — admission waives the
  // credit inside the fixture's reuse window, so balance 0 is no reason to withhold Go live.
  const forced = state === "idle" && p.balance < 1 && !p.restartFree;
  const buyCard = !p.planGate && (forced || p.showBuy);
  // B3: an idle org with no credits sees the heading and the credits card ONLY — a "Ready" pill and a three-step
  // stepper promise a stream it cannot start.
  const creditsOnly = forced && !p.planGate;
  // Task 14b (R4): the chip stays the TOTAL; the split is its footnote, and only when there is something to SPLIT — both
  // buckets held (review M2, controller ruling). One bucket alone is the chip's own number said twice.
  const split =
    p.split !== null && p.split.monthly > 0 && p.split.pack > 0 && p.split.total === p.balance ? p.split : null;
  // m12: §8a's ending row — "every control disabled" while the last seconds flush.
  const frozen = state === "ending";
  const stopFailure = p.stopFailed ? stopError(msg, state) : null;
  const selectedLabel =
    p.targets.find((t) => t.id === p.selectedTargetId)?.label ??
    (p.targets.length === 0 ? msg("stream.phone.destination.none") : undefined);

  const onModeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!ARROW.test(e.key)) return;
    e.preventDefault();
    const next = stepRadio(MODE_OPTIONS, p.mode, e.key) as FeedMode;
    if (next === p.mode) return;
    p.onMode(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  };

  return (
    // P5: the root marker the chooser's Close looks Buy more up from.
    <div data-phone-body>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Smartphone aria-hidden className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
          {msg("stream.phone.title")}
        </h4>
        {!creditsOnly && statePill(msg, state)}
        {p.balance >= 1 && (
          <span
            data-testid="stream-balance"
            className="ml-auto rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800"
          >
            {credits}
          </span>
        )}
        {p.balance >= 1 && !p.planGate && (
          // Opens the CHOOSER, never a pack: a mid-match top-up that picked the 5-pack sent the organiser to a Stripe
          // sheet for a pack they never chose.
          <button
            type="button"
            data-testid="stream-buy-more"
            aria-expanded={p.showBuy}
            disabled={frozen}
            onClick={p.onShowBuy}
            className="min-h-11 rounded text-xs text-purple-700 underline hover:text-purple-800 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0"
          >
            {msg("stream.phone.buyMore")}
          </button>
        )}
      </div>
      {split && (
        <p data-testid="stream-credits-split" className="mt-1 text-right text-[11px] text-slate-500 tabular-nums">
          {msg("stream.credits.split", { m: split.monthly, p: split.pack })}
        </p>
      )}

      {/* Steps: the ol at ≥ 768, ONE line below — same tree, two branches (§8a). None at all while credits-only (B3). */}
      {!creditsOnly && (
        <ol data-testid="stream-steps" className="mt-3 space-y-1 text-[13px] text-slate-700 max-md:hidden">
          {STEP_KEYS.map((k, i) => {
            const n = i + 1;
            const cls = n === step ? "font-semibold text-purple-800" : n < step ? "text-slate-500" : "";
            return (
              <li key={k} aria-current={n === step ? "step" : undefined} className={`flex items-center gap-2 ${cls}`}>
                <span
                  aria-hidden
                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] ${
                    n === step ? "bg-purple-100" : "bg-slate-100"
                  }`}
                >
                  {n < step ? <Check className="h-3.5 w-3.5" strokeWidth={2} /> : n}
                </span>
                {msg(k)}
              </li>
            );
          })}
        </ol>
      )}
      {!creditsOnly && (
        <p data-testid="stream-step" className="mt-3 text-[13px] font-semibold text-purple-800 md:hidden">
          {msg("stream.phone.stepOf", { n: step, label: msg(STEP_KEYS[step - 1]) })}
        </p>
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

      {buyCard && (
        <div className="mt-3">
          <h5 className="text-sm font-semibold text-slate-700">{msg("stream.credits.title")}</h5>
          <p className="mt-1 text-xs text-slate-500">{msg("stream.credits.line")}</p>
          {p.monthlyAllowance >= 1 && (
            // Task 14b (R4): why a club with free credits might still buy — and which ones expire.
            <p data-testid="stream-credits-monthly" className="mt-1 text-xs text-slate-500">
              {p.monthlyAllowance === 1
                ? msg("stream.credits.monthlyNote.one")
                : msg("stream.credits.monthlyNote.other", { n: p.monthlyAllowance })}
            </p>
          )}
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
            {STREAM_CREDIT_PACKS.map((pack) => {
              // P1: the amount the pack's Stripe price charges in the checkout's currency. A currency the price has no
              // option for quotes NOTHING rather than a GBP number under the wrong sign (the checkout would refuse it).
              const total = streamPackAmountMinor(pack, p.currency);
              const perMatch = streamPackPerMatchMinor(pack, p.currency);
              return (
              <button
                key={pack.size}
                type="button"
                disabled={p.busy || frozen || p.checkoutOpen}
                data-testid={`stream-buy-pack-${pack.size}`}
                onClick={() => p.onBuy(pack.size)}
                onPointerEnter={p.onTileIntent}
                onFocus={p.onTileIntent}
                onTouchStart={p.onTileIntent}
                // B8: top-aligned, so the three tiles' first lines share a baseline however their text wraps.
                className={`flex min-h-11 w-full flex-col items-start justify-start rounded-lg border p-3 text-left hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-50 ${
                  pack.popular ? "border-purple-500" : "border-purple-200"
                }`}
              >
                <span className="block text-lg font-semibold text-slate-800">{msg(pack.labelKey)}</span>
                {total !== undefined && (
                  <span className="block text-sm text-slate-600">{formatMinor(total, p.currency, locale)}</span>
                )}
                {perMatch !== undefined && (
                  <span className="block text-[11px] text-slate-500">
                    {msg("stream.credits.perMatch", { price: formatMinor(perMatch, p.currency, locale) })}
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
          {p.checkoutError && (
            <p data-testid="stream-checkout-error" role="alert" className="mt-2 text-xs text-red-600">
              {msg(p.checkoutError === "owner" ? "stream.credits.error.owner" : "stream.credits.error.unknown")}
            </p>
          )}
          {p.showBuy && !forced && (
            // B6: an OPENED chooser says how to put it away — the same toggle as Buy more, handing back the controls it
            // covers. A forced one has nothing behind it, so no Close.
            <button
              type="button"
              data-testid="stream-credits-close"
              disabled={frozen}
              onClick={(e) => {
                p.onShowBuy();
                // P5: this button unmounts with the chooser, which would drop focus to <body>. Hand it back to the
                // control that opened the chooser — still on screen above it.
                e.currentTarget
                  .closest("[data-phone-body]")
                  ?.querySelector<HTMLButtonElement>('[data-testid="stream-buy-more"]')
                  ?.focus();
              }}
              className="btn btn-ghost mt-2 min-h-11 w-full md:min-h-10 md:w-auto"
            >
              {msg("stream.credits.close")}
            </button>
          )}
          <p className="mt-2 text-[11px] text-slate-500">{msg("stream.credits.footnote")}</p>
        </div>
      )}

      {state === "idle" && !buyCard && (
        <div className="mt-3 space-y-3">
          <label className="block text-xs text-slate-500">
            {msg("stream.phone.destination")}
            <select
              data-testid="stream-target"
              // B7: a phone's native select clips a long label — the title still names the selection.
              title={selectedLabel}
              value={p.selectedTargetId ?? ""}
              onChange={(e) => p.onSelectTarget(e.target.value)}
              className={FIELD}
            >
              {p.targets.length === 0 && <option value="">{msg("stream.phone.destination.none")}</option>}
              {p.targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="stream-target-add"
            aria-expanded={p.showTargetForm}
            onClick={p.onAddTarget}
            className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
          >
            {msg("stream.phone.addDestination")}
          </button>
          {p.showTargetForm && <TargetForm onSave={p.onSaveTarget} onCancel={p.onAddTarget} />}
          <div
            role="radiogroup"
            aria-label={msg("stream.phone.mode")}
            data-testid="stream-mode"
            onKeyDown={onModeKey}
            className="grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1"
          >
            <button
              type="button"
              role="radio"
              aria-checked={p.mode === "clean"}
              tabIndex={p.mode === "clean" ? 0 : -1}
              data-mode="clean"
              data-testid="stream-mode-clean"
              onClick={() => p.onMode("clean")}
              className={`min-h-11 rounded text-sm md:min-h-9 ${
                p.mode === "clean" ? "bg-white font-semibold text-slate-800 shadow-sm" : "text-slate-600"
              }`}
            >
              {msg("stream.phone.mode.clean")}
            </button>
            {/* Composed is R2's: the seam is VISIBLE (disabled, captioned) rather than absent. */}
            <button
              type="button"
              role="radio"
              aria-checked={p.mode === "scorebug"}
              tabIndex={-1}
              disabled
              data-mode="scorebug"
              data-testid="stream-mode-scorebug"
              title={msg("stream.phone.mode.soon")}
              className="min-h-11 cursor-not-allowed rounded px-1 text-sm leading-tight text-slate-400 md:min-h-9"
            >
              {msg("stream.phone.mode.scorebug")}
              <span className="block text-[10px]">{msg("stream.phone.mode.soon")}</span>
            </button>
          </div>
          {p.restartFree && (
            // I-1: why a zero (or unchanged) balance can start — the line Go live stands on, in the chip's emerald.
            <p data-testid="stream-restart-free" className="flex items-start gap-1.5 text-xs text-emerald-800">
              <RotateCcw aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-600" strokeWidth={2} />
              {msg("stream.phone.restartFree")}
            </p>
          )}
          <button
            type="button"
            data-testid="stream-go-live"
            disabled={p.busy || !p.selectedTargetId}
            onClick={p.onGoLive}
            className="btn btn-primary min-h-11 w-full md:min-h-10"
          >
            {msg("stream.phone.goLive")}
          </button>
        </div>
      )}

      {(state === "provisioning" || state === "warming") && (
        // §8a: ONE CENTRED COLUMN — the QR box, then the paste code at the box's own width, the caption and Cancel.
        <div data-testid="stream-qr-column" className="mt-3 flex flex-col items-center gap-2 text-center">
          <div data-testid="stream-qr-box" className={`${QR_COLUMN_W} rounded-lg border border-purple-100 bg-white p-3`}>
            {p.qrDataUrl ? (
              // A data: URL encoded in the browser — nothing for next/image to optimise, and never in page HTML.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                data-testid="stream-qr"
                src={p.qrDataUrl}
                alt={msg("stream.phone.qr.alt")}
                className="mx-auto block aspect-square h-auto w-[min(264px,100%)]"
              />
            ) : (
              <div
                aria-hidden
                className="mx-auto aspect-square w-[min(264px,100%)] animate-pulse rounded bg-slate-100 motion-reduce:animate-none"
              />
            )}
          </div>
          {p.view?.qr && (
            <div data-testid="stream-qr-field" className={`relative ${QR_COLUMN_W}`}>
              <input
                data-testid="stream-qr-text"
                readOnly
                aria-label={msg("stream.phone.qr.field")}
                value={qrText(p.view.qr)}
                onFocus={(e) => e.currentTarget.select()}
                className="h-11 w-full rounded-lg border border-purple-100 bg-slate-950 px-3 font-mono text-[11px] text-slate-100 outline-none focus:ring-2 focus:ring-purple-200 md:h-10 md:pr-10"
              />
              {/* §8's copy-button rule: 28 px inside the field at ≥ 768 (its name is the sr-only label), full width
                  and 44 px beneath it below. */}
              <button
                type="button"
                data-testid="stream-qr-copy"
                onClick={p.onCopy}
                className="btn btn-ghost mt-1.5 h-11 w-full text-xs md:absolute md:right-1.5 md:top-1.5 md:mt-0 md:h-7 md:w-7 md:p-0"
              >
                {p.copied ? (
                  <Check aria-hidden className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <Copy aria-hidden className="h-3.5 w-3.5" />
                )}
                <span aria-live="polite" className="md:sr-only">
                  {p.copied ? msg("stream.phone.qr.copied") : msg("stream.phone.qr.copy")}
                </span>
              </button>
            </div>
          )}
          <p className="text-xs text-slate-500">{msg("stream.phone.qr.caption")}</p>
          <button
            type="button"
            data-testid="stream-cancel"
            disabled={p.busy}
            onClick={p.onCancel}
            className={`btn btn-ghost min-h-11 ${QR_COLUMN_W} md:min-h-10 md:w-auto`}
          >
            {msg("stream.phone.cancel")}
          </button>
        </div>
      )}

      {(state === "live" || state === "ending") && p.view && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">{recAndElapsed(msg, p.view.startedAt, p.now)}</div>
          <div data-testid="stream-health" className="flex flex-wrap gap-1">
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
          </div>
          {state === "ending" ? (
            <p data-testid="stream-ending" className="text-xs text-slate-500">
              {msg("stream.phone.ending", { destination: p.view.target.label })}
            </p>
          ) : (
            <button type="button" data-testid="stream-stop" disabled={p.busy} onClick={p.onStop} className={STOP_BUTTON}>
              {msg("stream.phone.stop")}
            </button>
          )}
        </div>
      )}

      {state === "ended" && p.view && (
        <div data-testid="stream-ended" className="mt-3 space-y-2">
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
                {msg(END_REASON_KEYS[p.view.endReason])}
              </span>
            )}
          </div>
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
        <div className="mt-3 space-y-2">
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

      {/* A refused create — in whatever state the refusal left the tab. */}
      {p.createError && (
        <p data-testid="stream-create-error" role="alert" className="mt-3 text-xs text-red-600">
          {createErrorText(p.createError, msg)}
        </p>
      )}
    </div>
  );
}

/**
 * The destination form (D10). The platform is LABELLED, never an enum id. D6: there is no ingest-URL field — the server
 * fills it from the platform's preset — and a server 422 DESTINATION_NOT_ALLOWED still maps to its rule sentence.
 * (Kept minimal here; destinations move to Directory in T8.)
 */
export function TargetForm({ onSave, onCancel }: { onSave: PhoneTabBodyProps["onSaveTarget"]; onCancel: () => void }) {
  const msg = useMsg();
  const [kind, setKind] = useState<StreamPlatform>("youtube");
  const [label, setLabel] = useState("");
  const [streamKey, setStreamKey] = useState("");
  const [watchUrl, setWatchUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSave({ kind, label, streamKey, watchUrl });
    } catch (err) {
      const rule = targetRefusalRule(err);
      setError(msg(rule ? DESTINATION_REFUSAL_KEYS[rule] : "stream.target.error"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form data-testid="stream-target-form" onSubmit={submit} className="space-y-2 rounded-lg border border-slate-200 p-3">
      <label className="block text-xs text-slate-500">
        {msg("stream.target.label")}
        <input
          data-testid="stream-target-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          maxLength={80}
          autoComplete="off"
          className={FIELD}
        />
      </label>
      <label className="block text-xs text-slate-500">
        {msg("stream.target.kind")}
        <select
          data-testid="stream-target-kind"
          title={KIND_BRAND[kind]}
          value={kind}
          onChange={(e) => setKind(e.target.value as StreamPlatform)}
          className={FIELD}
        >
          {TARGET_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_BRAND[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-slate-500">
        {msg("stream.target.key")}
        <input
          data-testid="stream-target-key"
          type="password"
          value={streamKey}
          onChange={(e) => setStreamKey(e.target.value)}
          required
          maxLength={200}
          // m8: a stream key is not a login. `new-password` stops the browser autofilling a saved password into it,
          // and the two data attributes keep 1Password and LastPass from offering to save or fill it.
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          className={FIELD}
        />
      </label>
      <label className="block text-xs text-slate-500">
        {msg("stream.target.watch")}
        <input
          data-testid="stream-target-watch"
          value={watchUrl}
          onChange={(e) => setWatchUrl(e.target.value)}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className={FIELD}
        />
      </label>
      {error !== null && (
        <p data-testid="stream-target-error" role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2 md:flex-row">
        <button
          type="submit"
          data-testid="stream-target-save"
          disabled={saving}
          className="btn btn-primary min-h-11 w-full md:min-h-10 md:w-auto"
        >
          {msg("stream.target.save")}
        </button>
        <button
          type="button"
          data-testid="stream-target-cancel"
          onClick={onCancel}
          className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto"
        >
          {msg("stream.target.cancel")}
        </button>
      </div>
    </form>
  );
}
