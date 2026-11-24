"use client";

// The organiser's stream panel (Stream Overlay W1, task 6). Values are
// `_THEMES.md` §8 (panel), §8a (Phone tab) and §8b (credits card) — owner
// confirmed 2026-09-10. The design canvas the sheet was drawn on is gone, so
// the sheet is the authority and nothing here invents a value it does not state.
//
// THE REGISTRY IS THE POINT. The score style picker (stream-template-picker.tsx) renders
// `templatesForSport(sportKey)` in registry order and opens on the fixture's STORED style resolved through
// `resolveTemplate` (the sport's default when none is stored). There is deliberately NO theme id written as a literal
// anywhere below.
//
// R2006 (owner ruling 2026-10-19, "Option C"): the picker replaced the OBS tab's style strip AND its big preview — each
// option's thumbnail is the real `<OverlayPreview>` (the one render function, D6), so nothing is lost. Its data is
// SEEDED FROM THE ROW and upgraded by one fetch of the same overlay endpoint the stage itself polls; the seed is why a
// fixture whose public endpoint is unreachable still previews. The same picker sits in the Phone tab's score card, the
// score being the default there: one stored style per fixture, read by the OBS URL and the composed session alike.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Copy } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { resolveTemplate, templatesForSport, type TemplateId } from "@/components/overlay/template-registry";
import { fetchOverlayFixture, type OverlayLiveData } from "@/components/public-site/live-score-data";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { apiV1 } from "@/lib/client-v1";
import { useProvidedPhoneSession } from "../stream-session-provider";
import { fmtDelaySeconds, ScoreTiming, useStreamPrefs } from "../stream-score-settings";
import { StreamTemplatePicker, type TemplatePreviewData } from "../stream-template-picker";
import { overlayStartLabel, type OverlaySideInput } from "@/lib/overlay-model";
import { OVERLAY_KEY_PARAM } from "@/lib/realtime-purpose";
import { decidedOutcomeTemplates } from "@/lib/scoring-vocab";
import { effectiveTemplateId, NO_STREAM_PREFS_READ } from "@/lib/stream-settings";
import type { MessageKey } from "@/lib/messages";
import { composedSessionOpen } from "@/lib/stream-session-view";
import { streamUrlSchema } from "@/lib/stream-url";
import type { StreamPanelFixture, StreamPanelContext } from "./types";
import { type Msg, switchedOff } from "./shared";
import { StreamCredits } from "./credits";
import { PhoneStopProbe } from "./stop-probe";
import { PhoneTab } from "./phone-tab";

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
  const locale = useLocaleOrDefault();

  const themes = templatesForSport(stream.sportKey);
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
  // R2006: the fixture's STORED score preferences (mode, style, timing) — seeded from the page's read, each change shown
  // at once and saved; a failed save shows the stored value again. ONE copy for both tabs, so the OBS URL, the Phone
  // tab's score card and its Go live never disagree about the style.
  const prefs = useStreamPrefs(fixture.id, stream.streamPrefs[fixture.id] ?? NO_STREAM_PREFS_READ);
  // OPENS ON the stored style resolved through the registry (the sport's own default when none is stored, a retired
  // one's replacement) — never a second rule here.
  // Task 38: the chain the server copies at a stream's start — the match's own choice, else the CLUB's, else the sport's default.
  const club = stream.clubStyle;
  const style: TemplateId = effectiveTemplateId({ match: prefs.prefs.overlayTemplate, club: club.overlayTemplate, sportKey: stream.sportKey });
  // The match has its OWN style or timing (an override of the club's): its box stays open, with the way back. Otherwise the club's
  // row is a closed line the organiser may open ("Change for this match").
  const overridden = prefs.prefs.overlayTemplate !== null || prefs.prefs.overlayDelayMs !== null;
  const [changing, setChanging] = useState(false);
  // PR #989 review m1: the page's ONE session (the console's provider — read, never a poll of its own). While a composed
  // one is up, the OBS tab's grid says a pick applies to the next stream: the running session copied its style.
  const pageSession = useProvidedPhoneSession(fixture.id);
  const nextStreamOnly = composedSessionOpen(pageSession?.view ?? null);
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
        // Read-only (`?preview=1`): previewing must not hand out the stream's sponsor cards (R4 S5 fix round 1, m6).
        const next = await fetchOverlayFixture(fixture.id, undefined, { preview: true });
        if (!cancelled) setLive(next);
      } catch {
        // transient or unreachable (a private competition) — keep the seed
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixture.id]);

  // RT: the row's OWN key rides the URL the organiser pastes into OBS — never another fixture's, and none when the page
  // minted none (the overlay then polls).
  const overlayKey = stream.overlayKeys[fixture.id];
  // R2006 (spec §4.4): `template=` — the canonical parameter; the page reads `?style=` forever (R2007), but the panel no
  // longer writes it.
  const overlayUrl = `${origin}/overlay/fixtures/${fixture.id}?template=${style}${
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

  // R2006: every thumbnail renders THIS fixture — its snapshot (the seed until the fetch lands), sides, start label and
  // the page's overlay dictionary.
  const previewData: TemplatePreviewData = {
    sportKey: stream.sportKey,
    snapshot: live ?? seed,
    // I3: the AIRED sides (the overlay page's own loader), so the codes are the ones that go out; the row's own names
    // only when the loader answered nothing for this fixture.
    sides: stream.overlaySides[fixture.id] ?? [sideOf(fixture.home_entrant_id, "home"), sideOf(fixture.away_entrant_id, "away")],
    startLabel: overlayStartLabel(fixture.scheduled_at, locale, tz),
    dict: stream.overlayDict,
    decidedTemplates: decidedOutcomeTemplates(msg, stream.sportKey),
  };
  const picker = (where: "obs" | "phone") => (
    <StreamTemplatePicker
      templates={themes}
      selected={style}
      onPick={(id) => prefs.save("overlayTemplate", id)}
      preview={previewData}
      idPrefix={`stream-${where}-${fixture.id}`}
      saveFailed={prefs.failed === "overlayTemplate"}
      // The Phone tab's editor is Ready's alone (a running session shows its read-only summary there instead).
      note={where === "obs" && nextStreamOnly ? msg("stream.template.nextStream") : null}
    />
  );
  // R2006: Ready's score card body, the Phone tab's picker and Score timing, with the default the next session would serve.
  // Task 38: with a CLUB default set, the body opens as one compact row — "Club style: X · N s — Change for this match" — and the
  // controls are the match's own override: open once the organiser asks (or the match already has its own), with "Use club style"
  // writing null for both fields in ONE save. A court session takes the club's STYLE and never its timing (its default stays 0 s), so
  // its row names the style alone and its timing default is the court's own.
  const scoreEditor = (defaultMs: number, court: boolean) => {
    const clubTiming = !court && club.overlayDelayMs !== null;
    const controls = (
      <>
        {picker("phone")}
        <div className="mt-3 border-t border-purple-100 pt-1">
          <ScoreTiming
            idPrefix={`stream-timing-${fixture.id}`}
            storedMs={prefs.prefs.overlayDelayMs}
            defaultMs={clubTiming ? club.overlayDelayMs! : defaultMs}
            clubDefault={clubTiming}
            onSave={(ms) => prefs.save("overlayDelayMs", ms)}
            saveFailed={prefs.failed === "overlayDelayMs"}
          />
        </div>
      </>
    );
    const styleSet = club.overlayTemplate !== null;
    if (!styleSet && !clubTiming) return controls;
    const seconds = clubTiming ? fmtDelaySeconds(locale, club.overlayDelayMs!) : "";
    const styleLabel = styleSet ? msg(resolveTemplate(club.overlayTemplate, stream.sportKey).labelKey as MessageKey) : msg("stream.club.styleAny");
    const rowText = styleSet && clubTiming
      ? msg("stream.club.row", { style: styleLabel, seconds })
      : styleSet
        ? msg("stream.club.rowStyle", { style: styleLabel })
        : msg("stream.club.rowTiming", { seconds });
    const open = overridden || changing;
    return (
      <div data-testid="stream-club">
        <div data-testid="stream-club-row" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span data-testid="stream-club-text" className="min-w-0 break-words text-sm font-medium text-slate-800">{rowText}</span>
          {!overridden && (
            <button
              type="button"
              data-testid="stream-club-change"
              aria-expanded={open}
              onClick={() => setChanging(!changing)}
              className="inline-flex min-h-11 items-center text-sm font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700 md:ml-auto md:min-h-9"
            >
              {changing ? msg("stream.club.keep") : msg("stream.club.change")}
            </button>
          )}
        </div>
        {open && (
          <div data-testid="stream-club-override" className="mt-2 min-w-0 rounded-lg border border-purple-200 bg-purple-50/40 p-3">
            {/* The title says the match HAS its own; it shows only once it does (a stored value), not while the organiser has only opened Change. */}
            {overridden && (
              <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span data-testid="stream-club-override-title" className="text-sm font-medium text-slate-800">{msg("stream.club.overrideTitle")}</span>
                <span data-testid="stream-club-override-tag" className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                  {msg("stream.club.overrideTag")}
                </span>
              </div>
            )}
            {controls}
            <p className="mt-2 text-xs text-slate-600">{msg("stream.club.overrideNote")}</p>
            {overridden && (
              <button
                type="button"
                data-testid="stream-club-use"
                onClick={() => {
                  prefs.saveMany({ overlayTemplate: null, overlayDelayMs: null });
                  setChanging(false);
                }}
                className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-purple-700 underline decoration-purple-300 underline-offset-2 hover:decoration-purple-700 md:min-h-9"
              >
                {msg("stream.club.use")}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

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
          {/* R2006 (Option C): the score style picker replaces the style strip and the big preview — each option's
              thumbnail IS the preview, at its own width. */}
          <div className="mt-3 min-w-0">{picker("obs")}</div>

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
              pasteCodeShown={stream.pasteCodeShown}
              tz={tz}
              score={{
                available: stream.composedAvailable,
                stored: prefs.prefs.streamMode,
                // The match's OWN style only (null sends none): the club's is the server's to apply (Task 38).
                template: prefs.prefs.overlayTemplate === null ? null : resolveTemplate(prefs.prefs.overlayTemplate, stream.sportKey).id,
                delayMs: prefs.prefs.overlayDelayMs,
                sportKey: stream.sportKey,
                editor: scoreEditor(stream.overlayDelayDefaultMs, false),
                // Court stream device check 3 (D1): a court-streamed match's session is a court session, whose default is its own.
                courtEditor: scoreEditor(stream.courtOverlayDelayDefaultMs, true),
                modeFailed: prefs.failed === "streamMode",
                onMode: (m) => prefs.save("streamMode", m),
              }}
            />
          )}
        </div>
      )}
    </section>
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
