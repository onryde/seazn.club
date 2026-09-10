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
import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Copy, Video } from "lucide-react";
import { OverlayStage } from "@/components/overlay/overlay-stage";
import { defaultThemeFor, themesForSport, type ThemeId } from "@/components/overlay/theme-registry";
import { fetchOverlayFixture, type OverlayLiveData } from "@/components/public-site/live-score-data";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useDict, useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";
import { overlayStartLabel, type OverlaySideInput } from "@/lib/overlay-model";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { streamUrlSchema } from "@/lib/stream-url";
import type { ViewerPlan } from "@/lib/viewer-plan";

/** §8: the real stage at `scale(640/1920)`. Written as the sheet writes it. */
const PREVIEW_SCALE = 640 / 1920;

/**
 * §8b, picked option A ("Three tiles", owner 2026-09-08). SANDBOX PLACEHOLDERS
 * — spec §5.2; the real prices are an owner ruling before the GA flip, and R1
 * replaces this constant with the live pack catalogue plus a working Checkout.
 * Exported so a test asserts the rendered tiles against THIS table rather than
 * against a second copy typed into the test.
 */
export const CREDIT_PACKS: readonly {
  matches: number;
  labelKey: MessageKey;
  price: string;
  perMatch: string;
  /** §8b: the 5-pack carries `border-purple-500` and the "Most clubs" chip.
   *  Declared on every row rather than left off two, so the flag is a fact
   *  about the table and not the absence of one. */
  popular: boolean;
}[] = [
  { matches: 1, labelKey: "stream.credits.pack1", price: "£6", perMatch: "£6", popular: false },
  { matches: 5, labelKey: "stream.credits.pack5", price: "£25", perMatch: "£5", popular: true },
  { matches: 20, labelKey: "stream.credits.pack20", price: "£80", perMatch: "£4", popular: false },
];

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
export interface StreamPanelContext {
  /** `streaming.overlay`, competition-scoped. False ⇒ no panel and no toggle
   *  at all — never an upsell here (ruling 5: the OBS-side upsell is R1's). */
  entitled: boolean;
  /** `streaming.relay`, competition-scoped — the §5.3 gate the Phone tab reads. */
  relayEntitled: boolean;
  sportKey: string;
  overlayDict: Record<string, string>;
  viewerPlan: ViewerPlan;
}

/** The row's own control. Separate from the panel body because the two mount in
 *  different places: the toggle sits beside the run sheet's time cell, the body
 *  spans the row underneath it. The open state therefore lives in the row. */
export function FixtureStreamToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const msg = useMsg();
  return (
    <button
      type="button"
      data-testid="fixture-stream-toggle"
      aria-expanded={open}
      aria-label={msg("stream.toggle")}
      title={msg("stream.toggle")}
      onClick={onToggle}
      className={`-my-1 flex min-h-11 w-8 shrink-0 items-center justify-center rounded-md hover:text-purple-700 ${
        open ? "text-purple-700" : "text-slate-400"
      }`}
    >
      <Video className="h-4 w-4" strokeWidth={1.75} />
    </button>
  );
}

export function FixtureStreamPanel({
  fixture,
  entrantNames,
  tz,
  stream,
}: {
  fixture: StreamPanelFixture;
  entrantNames: Record<string, string>;
  /** The VENUE zone (`scheduleSettings.tz`) — the same clock the row prints in,
   *  and what the seeded payload carries as `venueTz`. Never the org zone. */
  tz: string;
  stream: StreamPanelContext;
}) {
  const msg = useMsg();
  const dict = useDict() as Record<string, unknown>;
  const locale = useLocaleOrDefault();

  const themes = themesForSport(stream.sportKey);
  const [tab, setTab] = useState<"obs" | "phone">("obs");
  // OPENS ON the sport's own default, resolved through the registry — a lazy
  // initialiser so a re-render never re-seeds it over the organiser's choice.
  const [style, setStyle] = useState<ThemeId>(() => defaultThemeFor(stream.sportKey));
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<OverlayLiveData | null>(null);

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

  const overlayUrl = `${origin}/overlay/fixtures/${fixture.id}?style=${style}`;

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
    <section data-testid="stream-panel" className="card mt-2 p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <Video className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
        {msg("stream.title")}
      </h3>
      <p className="mt-1 text-xs text-slate-500">{msg("stream.line")}</p>

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

          {/* §8: a 96px strip on the green-field stand-in. `overflow-hidden`
              clips whatever the scale does not fit — see the report's finding
              about §3's bar, which is authored at the BOTTOM of the 1080px
              canvas and therefore falls outside a 96px window at this scale. */}
          <div
            data-testid="stream-preview"
            aria-hidden
            className="relative mt-3 h-24 w-full overflow-hidden rounded-lg border border-purple-100"
            style={{ background: "linear-gradient(180deg, #3d7a3a, #2e6a2d)" }}
          >
            <div
              className="absolute left-0 top-0"
              style={{
                width: 1920,
                height: 1080,
                transform: `scale(${PREVIEW_SCALE})`,
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
        <div data-testid="stream-phone-gate" className="mt-3">
          {/* Spec §5.3. The "no `streaming.overlay`" row of that table cannot be
              reached from here — without it there is no toggle and no panel —
              so the gate this tab actually reads is the relay one. */}
          {!stream.relayEntitled ? (
            <UpgradeGate feature="streaming.relay" compact viewerPlan={stream.viewerPlan} />
          ) : (
            <>
              <h4 className="text-sm font-semibold text-slate-700">{msg("stream.credits.title")}</h4>
              <p className="mt-1 text-xs text-slate-500">{msg("stream.credits.line")}</p>
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                {CREDIT_PACKS.map((pack) => (
                  <button
                    key={pack.matches}
                    type="button"
                    disabled
                    data-testid="stream-credit-pack"
                    data-pack={pack.matches}
                    className={`min-h-11 w-full rounded-lg border p-3 text-left ${
                      pack.popular ? "border-purple-500" : "border-purple-200"
                    }`}
                  >
                    <span className="block text-lg font-semibold text-slate-800">
                      {msg(pack.labelKey)}
                    </span>
                    <span className="block text-sm text-slate-600">{pack.price}</span>
                    <span className="block text-[11px] text-slate-500">
                      {msg("stream.credits.perMatch", { price: pack.perMatch })}
                    </span>
                    {pack.popular && (
                      <span className="mt-1 inline-block rounded-full bg-purple-100 px-2 text-[10px] text-purple-800">
                        {msg("stream.credits.popular")}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled
                data-testid="stream-buy-soon"
                className="btn btn-primary mt-2 h-11 w-full md:h-10 md:w-auto"
              >
                {msg("stream.credits.soon")}
              </button>
              <p className="mt-2 text-[11px] text-slate-500">{msg("stream.credits.footnote")}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
