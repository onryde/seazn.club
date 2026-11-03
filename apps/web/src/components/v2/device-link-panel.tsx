"use client";

// "Hand this device over" (doc 13 §7, PROMPT-21; scorer sheets §4.2): the
// organiser shows the fixture's device link as a QR + link, revokes it, or
// revokes & reissues it. Links are sealed server-side and last until the
// fixture is over, so "Show QR" goes through ENSURE (POST /device-links) and
// re-shows the SAME secret every time — a hand-over never kills a sheet that
// was already printed for this match. Only the explicit, confirmed "Revoke &
// reissue" (POST /device-links/reissue) mints a new one. Plain "Revoke" (and
// "Revoke now" under a shown QR) kills a printed sheet just the same, so it
// asks first too, with the same on-screen question (owner ruling, T3 fix
// round 2). One question at a time.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { failureKey, liveCopy } from "@/components/v2/device-link-copy";
// The Remote scoring QR is painted at `PHONE_HANDOVER_QR_MAX_PX`, the cap it shares with the stream camera's QR (owner
// 2026-11-03) — its rationale is beside the constant.
import { PHONE_HANDOVER_QR_MAX_PX, SeaznQrImage } from "@/components/v2/seazn-qr-image";
import { renderSeaznQr, type SeaznQr } from "@/lib/seazn-qr";
import { officialLabelKey } from "@/lib/official-label";
import { useSessionStorageItem, writeSessionStorageItem } from "@/lib/use-client-snapshot";
import type { ViewerPlan } from "@/lib/viewer-plan";

/**
 * Match Day's opt-in "Hide" (E2 item 6): a compact panel that can be put away. Hidden, it is one row — the host's heading,
 * whether a link is ready, and Show QR / Copy link; open, it is the panel with a Hide button in its heading row. Nothing
 * here applies unless a host passes it, so every other mount (the fixture console's) is unchanged.
 */
export interface DeviceLinkHide {
  /** The `sessionStorage` item that remembers the organiser's choice ("open" | "hidden") — the host keys it per court. */
  storageKey: string;
  /** The host's heading content (title, scorer mark): shown in both shapes, so the panel does not own the court's wording. */
  heading: ReactNode;
  /** Open before anything is remembered or read? For a host that KNOWS (`followLink` false). With `followLink`, it is only what
   *  shows if the first read of the link FAILS, so the panel is never left blank. */
  initiallyOpen: boolean;
  /** The host cannot know whether a link is live (Match Day: the desk's score events say nothing about one). Decide from the
   *  panel's FIRST read of the fixture's link instead — open iff none is live — until the organiser chooses. Until that read lands
   *  the panel is the hidden row, so a live link is never opened and then collapsed under the organiser's eyes (fix round 1, m8).
   *  Latched at the first read, so making a link under the organiser's hands does not close the panel they are looking at. */
  followLink: boolean;
}

interface ActiveLink {
  id: string;
  label: string | null;
  /** `null` for a sealed link: it lives until the fixture is over. */
  expires_at: string | null;
  created_at: string;
}

/** Put `url` on the clipboard: true when it took it; false when there is no clipboard (an insecure page, an old browser) or it refused
 *  (no permission), so the caller offers the link to select instead of claiming "Copied" (m8). */
async function copyToClipboard(url: string): Promise<boolean> {
  try {
    // A missing clipboard throws (a TypeError on `undefined`), the same as a refusal does: both land on "offer it to select".
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

export function DeviceLinkPanel({
  fixtureId,
  sportKey,
  embedded = false,
  compact = false,
  onChanged,
  hide,
}: {
  fixtureId: string;
  /** Names the sport's official in the viewer's locale (doc 13 §1:
   *  'Umpire' / 'Referee' / 'Arbiter' / 'Scorer'), never the engine's English
   *  label — see `officialLabelKey`. */
  sportKey: string;
  /**
   * R7/C3 (D-19) — rendered INSIDE the scoring card, opened from its heading
   * row, instead of as the last card on the page. Drops this component's own
   * card chrome and heading: a card inside a card reads as a nesting bug, and
   * the disclosure button the organiser just pressed already said what this
   * is. Everything below the heading is unchanged.
   */
  embedded?: boolean;
  /**
   * Match Day (task A4 fix round 1, V5): the hand-over a court needs at a glance — the Create / Show QR button, then the QR
   * and Copy — with everything else (what the link is, the raw pad URL, "same QR every time", the live line, Revoke,
   * Revoke & reissue and their questions) behind one "More" fold (`device-link-more`). Same state, same handlers, same
   * testids as the full panel; implies `embedded`'s chrome.
   */
  compact?: boolean;
  /** Called after any change this panel made to the fixture's link (created or re-shown, reissued, revoked) succeeded,
   *  so a host that reads the link elsewhere (Match Day's "No scorer" mark: a live link IS a scorer) can re-read. */
  onChanged?: () => void;
  /** No longer read: remote scoring is free on every plan, so this panel has no paywall to word. Optional only so the
   *  Match Day mount (another lane's file) keeps compiling; delete it from both mounts when that lane lands. */
  viewerPlan?: ViewerPlan;
  /** Opt-in (Match Day, `compact` only): the organiser can Hide the panel to one row. Absent = the panel as it always was. */
  hide?: DeviceLinkHide;
}) {
  const msg = useMsg();
  const [active, setActive] = useState<ActiveLink | null>(null);
  const [minted, setMinted] = useState<{ secret: string; qr: SeaznQr; expires_at: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The open "this kills the QR" question, if any. */
  const [confirm, setConfirm] = useState<"reissue" | "revoke" | null>(null);
  /** The fixture is finalized or cancelled: nothing left to hand over. */
  const [over, setOver] = useState(false);
  /** Hide (opt-in): this tab's own choice, the remembered one, and what the FIRST read of the link said (`true` = none live). */
  const [picked, setPicked] = useState<"open" | "hidden" | null>(null);
  const remembered = useSessionStorageItem(hide?.storageKey ?? null);
  const [firstRead, setFirstRead] = useState<"pending" | "none" | "found" | "failed">("pending");
  // The default is decided ONCE, at mount: a link made under the organiser's hands clears the desk's "No scorer" and flips the
  // host's `initiallyOpen`, and the panel they are looking at must not close because of it.
  const [defaults] = useState(() => ({ open: hide?.initiallyOpen ?? true, followLink: hide?.followLink ?? false }));
  const [copied, setCopied] = useState(false);
  /** The link offered to be selected and copied by hand, when the clipboard is missing or refuses (m8). */
  const [selectUrl, setSelectUrl] = useState<string | null>(null);
  const selectField = useRef<HTMLInputElement>(null);
  const rowButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the panel changes shape (the control that was pressed is gone): the row's button, or Hide. */
  const focusNext = useRef<"row" | "hide" | null>(null);
  const choice = picked ?? (remembered === "open" || remembered === "hidden" ? remembered : null);
  const bodyShown =
    hide === undefined
      ? true
      : choice !== null
        ? choice === "open"
        : defaults.followLink
          ? firstRead === "pending"
            ? false
            : firstRead === "failed"
              ? defaults.open
              : firstRead === "none"
          : defaults.open;
  const fmtDate = (iso: string) => new Date(iso).toLocaleString();

  /** Every refusal below lands here, localised by code and status — never the
   *  server's English (T3 review finding 3). A match that is over is not an
   *  error to retry: the routes' only 422 means finalized or cancelled, and
   *  from then on the panel offers no control at all, only that line (owner
   *  ruling 2026-09-23). The console unmounts this panel on its OWN status, so
   *  the refusal is how a finalize from another session reaches it. */
  function refused(err: unknown) {
    const key = failureKey(err);
    if (key === "dlink.error.matchOver") {
      setOver(true);
      setMinted(null);
      setConfirm(null);
      setError(null);
    } else {
      setError(msg(key));
    }
  }

  const fetchActive = useCallback(
    () => apiV1<ActiveLink | null>(`/api/v1/fixtures/${fixtureId}/device-links`),
    [fixtureId],
  );

  /** Re-read after an action (an event, so awaiting in place is fine). */
  const refresh = useCallback(async () => {
    try {
      setActive(await fetchActive());
    } catch {
      // non-editor or transient — panel just shows the create button
    }
  }, [fetchActive]);

  // The first read: set from the request's own callback (never synchronously
  // in the effect); a superseded one — another fixture, an unmount — is
  // ignored rather than showing the wrong fixture's link.
  useEffect(() => {
    let ignore = false;
    fetchActive().then(
      (link) => {
        if (ignore) return;
        setActive(link);
        setFirstRead(link === null ? "none" : "found");
      },
      () => {
        // non-editor or transient — panel just shows the create button
        if (!ignore) setFirstRead("failed");
      },
    );
    return () => {
      ignore = true;
    };
  }, [fetchActive]);

  async function showLink(link: ActiveLink & { secret: string }) {
    const url = `${window.location.origin}/score/${link.secret}`;
    const qr = await renderSeaznQr(url);
    setMinted({ secret: link.secret, qr, expires_at: link.expires_at });
  }

  /** Create (no link yet) and Show QR (a live link): ENSURE — re-shows the
   *  live sealed link, or mints the first one. Never revokes. */
  async function show() {
    setBusy(true);
    setError(null);
    setConfirm(null);
    try {
      const link = await apiV1<ActiveLink & { secret: string }>(
        `/api/v1/fixtures/${fixtureId}/device-links`,
        { method: "POST", json: {} },
      );
      await showLink(link);
      await refresh();
      onChanged?.();
    } catch (err) {
      refused(err);
    } finally {
      setBusy(false);
    }
  }

  /** Hide / Show: remembered for this tab (a tab that refuses storage still follows the choice for as long as it lives). */
  function choose(next: "open" | "hidden") {
    setPicked(next);
    setCopied(false);
    setSelectUrl(null);
    if (hide !== undefined) writeSessionStorageItem(hide.storageKey, next);
    focusNext.current = next === "hidden" ? "row" : "hide";
  }

  // The control the organiser just pressed is gone with the shape it belonged to: hand focus to its counterpart.
  useEffect(() => {
    const want = focusNext.current;
    if (want === null) return;
    focusNext.current = null;
    (want === "row" ? rowButton : hideButton).current?.focus();
  }, [bodyShown]);

  // The fallback field arrives selected, so Ctrl/Cmd-C (or the system's Copy) is the only step left (m8).
  useEffect(() => {
    if (selectUrl === null) return;
    selectField.current?.focus();
    selectField.current?.select();
  }, [selectUrl]);

  /** The hidden row's Show QR (and Create): open the panel, then make or re-show the link in it, where the QR will be. */
  async function showFromRow() {
    choose("open");
    await show();
  }

  /** The hidden row's Copy link: ENSURE re-shows the SAME sealed link (a copy never revokes), and its URL goes to the clipboard. */
  async function copyFromRow() {
    setBusy(true);
    setError(null);
    setCopied(false);
    setSelectUrl(null);
    try {
      const link = await apiV1<ActiveLink & { secret: string }>(
        `/api/v1/fixtures/${fixtureId}/device-links`,
        { method: "POST", json: {} },
      );
      const url = `${window.location.origin}/score/${link.secret}`;
      // "Copied" only when the clipboard really took it; otherwise the link is offered to select (m8).
      if (await copyToClipboard(url)) setCopied(true);
      else setSelectUrl(url);
    } catch (err) {
      refused(err);
    } finally {
      setBusy(false);
    }
  }

  /** Revoke & reissue, only from the on-screen confirm: every QR already
   *  handed out or printed for this match stops working. */
  async function reissue() {
    setBusy(true);
    setError(null);
    try {
      const link = await apiV1<ActiveLink & { secret: string }>(
        `/api/v1/fixtures/${fixtureId}/device-links/reissue`,
        { method: "POST", json: {} },
      );
      await showLink(link);
      setConfirm(null);
      await refresh();
      onChanged?.();
    } catch (err) {
      // Same rule as a refused revoke: never leave "Yes, reissue" on screen
      // after the server said no. Close the question and re-read what is live.
      setConfirm(null);
      refused(err);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /** Revoke, only from the on-screen confirm: every QR already handed out or
   *  printed for this match stops working, and no new one is made. */
  async function revoke(linkId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixtureId}/device-links/${linkId}`, { method: "DELETE" });
      setMinted(null);
      setConfirm(null);
      await refresh();
      onChanged?.();
    } catch (err) {
      // A refused revoke must not leave "Yes, revoke" on screen — on a 404 the
      // link is already gone. Close the question and re-read what is live.
      setConfirm(null);
      refused(err);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const padUrl = minted ? `${window.location.origin}/score/${minted.secret}` : null;
  const live = active ? liveCopy(active.expires_at, fmtDate) : null;

  /** The on-screen question both destructive doors open — a native dialog
   *  would be invisible to e2e and easy to dismiss by reflex. */
  const question =
    confirm && active ? (
      <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-left">
        <p role="alert" className="text-xs text-amber-800">
          {msg(confirm === "revoke" ? "dlink.revokeWarn" : "dlink.reissueWarn")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid={confirm === "revoke" ? "device-link-revoke-confirm" : "device-link-reissue-confirm"}
            disabled={busy}
            onClick={confirm === "revoke" ? () => revoke(active.id) : reissue}
            className="btn btn-danger min-h-11 text-xs"
          >
            {msg(confirm === "revoke" ? "dlink.revokeConfirm" : "dlink.reissueConfirm")}
          </button>
          <button
            type="button"
            data-testid="device-link-keep"
            disabled={busy}
            onClick={() => setConfirm(null)}
            className="btn btn-ghost min-h-11 text-xs"
          >
            {msg("dlink.keep")}
          </button>
        </div>
      </div>
    ) : null;

  /** The link, selected, for a browser whose clipboard is missing or refuses (m8): the one honest thing to say is "Select and copy". */
  const selectBlock =
    selectUrl === null ? null : (
      <div data-testid="device-link-select" className="mt-2 min-w-0 space-y-1 text-left">
        <input
          ref={selectField}
          data-testid="device-link-select-input"
          readOnly
          value={selectUrl}
          aria-label={msg("dlink.selectCopy")}
          onFocus={(e) => e.currentTarget.select()}
          className="input ph-no-capture min-h-11 w-full min-w-0 font-mono text-xs"
        />
        <p role="status" className="text-xs text-slate-600">
          {msg("dlink.selectCopy")}
        </p>
      </div>
    );

  if (over) {
    return (
      <section
        className={embedded || compact ? "rounded-xl border border-purple-100 bg-purple-50/40 p-4" : "card p-5"}
        data-role="device-link-panel"
      >
        {!embedded && !compact && <h2 className="text-sm font-semibold text-slate-700">{msg("dlink.title")}</h2>}
        <p
          data-testid="device-link-match-over"
          role="status"
          className={`text-xs text-slate-600 ${embedded || compact ? "" : "mt-1"}`}
        >
          {msg("dlink.error.matchOver")}
        </p>
      </section>
    );
  }

  if (compact) {
    const desc = (
      <p className="text-xs text-slate-600">{msg("dlink.desc", { scorer: msg(officialLabelKey(sportKey)).toLowerCase() })}</p>
    );
    const more = (body: ReactNode) => (
      <details data-testid="device-link-more" className="group/more mt-3 min-w-0 text-left">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg text-xs font-semibold text-purple-800 hover:text-purple-900 lg:min-h-0 lg:py-1 [&::-webkit-details-marker]:hidden">
          <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 fill-none stroke-current transition-transform group-open/more:rotate-90 motion-reduce:transition-none" strokeWidth={1.8}>
            <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {msg("dlink.more")}
        </summary>
        <div className="mt-2 min-w-0 space-y-2">{body}</div>
      </details>
    );
    if (hide !== undefined && !bodyShown) {
      const ready = firstRead === "none" || firstRead === "found" ? active !== null : null;
      return (
        <section
          className="rounded-xl border border-purple-100 bg-purple-50/40 px-3 py-1"
          data-role="device-link-panel"
          data-compact="true"
          data-hide-state="hidden"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{hide.heading}</div>
            {ready !== null && (
              <p data-testid="device-link-row-state" className="flex min-w-0 items-center gap-2 text-xs text-slate-600">
                <span aria-hidden>·</span>
                {msg(ready ? "dlink.linkReady" : "dlink.noLink")}
              </p>
            )}
            <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
              <button
                ref={rowButton}
                type="button"
                data-testid={active ? "device-link-row-show" : "device-link-row-create"}
                disabled={busy}
                onClick={showFromRow}
                className="btn btn-primary min-h-11 text-xs"
              >
                {msg(active ? "dlink.showQr" : "dlink.create")}
              </button>
              {active && (
                <button
                  type="button"
                  data-testid="device-link-row-copy"
                  disabled={busy}
                  onClick={copyFromRow}
                  className="btn btn-ghost min-h-11 text-xs"
                >
                  {msg(copied ? "dlink.copied" : "dlink.copy")}
                </button>
              )}
            </div>
          </div>
          <span role="status" className="sr-only">
            {copied ? msg("dlink.copied") : ""}
          </span>
          {selectBlock}
          {error && <p className="mb-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
        </section>
      );
    }
    return (
      <section
        className="rounded-xl border border-purple-100 bg-purple-50/40 p-4"
        data-role="device-link-panel"
        data-compact="true"
        data-hide-state={hide === undefined ? undefined : "open"}
      >
        {hide !== undefined && (
          <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">{hide.heading}</div>
            <button
              ref={hideButton}
              type="button"
              data-testid="device-link-hide"
              aria-label={msg("dlink.hideLabel")}
              onClick={() => choose("hidden")}
              className="btn btn-ghost inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 text-xs"
            >
              {msg("dlink.hide")}
              <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3 shrink-0 fill-none stroke-current" strokeWidth={1.8}>
                <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
        {minted ? (
          <div className="min-w-0">
            <div className="space-y-2 text-center">
              {/* `ph-no-capture` on the QR and the URL, exactly as the full panel below (session replay). */}
              <SeaznQrImage testId="dlink-qr" sensitive qr={minted.qr} alt={msg("dlink.alt")} maxSize={PHONE_HANDOVER_QR_MAX_PX} />
              <button
                type="button"
                data-testid="device-link-copy"
                className="btn btn-ghost min-h-11 text-xs"
                onClick={() => {
                  if (padUrl !== null) void copyToClipboard(padUrl).then((ok) => setSelectUrl(ok ? null : padUrl));
                }}
              >
                {msg("dlink.copy")}
              </button>
              {selectBlock}
            </div>
            {more(
              <>
                {desc}
                <p
                  data-testid="device-link-url"
                  className="ph-no-capture break-all rounded bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-500"
                >
                  {padUrl}
                </p>
                <p className="text-xs text-slate-500">{msg("dlink.sameQr")}</p>
                {active && (
                  <button
                    type="button"
                    data-testid="device-link-revoke-now"
                    disabled={busy}
                    onClick={() => setConfirm("revoke")}
                    className="btn btn-danger min-h-11 text-xs"
                  >
                    {msg("dlink.revokeNow")}
                  </button>
                )}
                {question}
              </>,
            )}
          </div>
        ) : active && live ? (
          <div className="min-w-0">
            <button
              type="button"
              data-testid="device-link-show"
              disabled={busy}
              onClick={show}
              className="btn btn-primary min-h-11 text-xs"
            >
              {msg("dlink.showQr")}
            </button>
            {more(
              <>
                {desc}
                <p className="text-xs text-slate-600">{msg(live.key, live.vars)}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="device-link-revoke"
                    disabled={busy}
                    onClick={() => setConfirm("revoke")}
                    className="btn btn-danger min-h-11 text-xs"
                  >
                    {msg("dlink.revoke")}
                  </button>
                  <button
                    type="button"
                    data-testid="device-link-reissue"
                    disabled={busy}
                    onClick={() => setConfirm("reissue")}
                    className="btn btn-ghost min-h-11 text-xs"
                  >
                    {msg("dlink.reissue")}
                  </button>
                </div>
                {question}
              </>,
            )}
          </div>
        ) : (
          <div className="min-w-0">
            <button
              type="button"
              data-testid="device-link-mint"
              disabled={busy}
              onClick={show}
              className="btn btn-primary min-h-11"
            >
              {busy ? "…" : msg("dlink.create")}
            </button>
            {more(desc)}
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      className={embedded ? "rounded-xl border border-purple-100 bg-purple-50/40 p-4" : "card p-5"}
      data-role="device-link-panel"
    >
      {!embedded && <h2 className="text-sm font-semibold text-slate-700">{msg("dlink.title")}</h2>}
      <p className={`text-xs text-slate-600 ${embedded ? "" : "mt-1"}`}>
        {msg("dlink.desc", { scorer: msg(officialLabelKey(sportKey)).toLowerCase() })}
      </p>

      {error && <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {minted ? (
        <div className="mt-3 space-y-3 text-center">
          {/* `ph-no-capture` on the QR and the URL text: both paint the live
              secret, and PostHog replay compresses its DOM frames before the
              `before_send` scrub can see them — its recorder blocks this class
              outright (no children, no src). The QR's class is the shared
              component's, applied because it is `sensitive` — on the inline
              image and on the tap-to-enlarge overlay (D10). */}
          <SeaznQrImage testId="dlink-qr" sensitive qr={minted.qr} alt={msg("dlink.alt")} maxSize={PHONE_HANDOVER_QR_MAX_PX} />
          <p
            data-testid="device-link-url"
            className="ph-no-capture break-all rounded bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-500"
          >
            {padUrl}
          </p>
          <p className="text-xs text-slate-500">{msg("dlink.sameQr")}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className="btn btn-ghost min-h-11 text-xs"
              onClick={() => padUrl && navigator.clipboard?.writeText(padUrl)}
            >
              {msg("dlink.copy")}
            </button>
            {active && (
              <button
                type="button"
                data-testid="device-link-revoke-now"
                disabled={busy}
                onClick={() => setConfirm("revoke")}
                className="btn btn-danger min-h-11 text-xs"
              >
                {msg("dlink.revokeNow")}
              </button>
            )}
          </div>
          {question}
        </div>
      ) : active && live ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-slate-600">{msg(live.key, live.vars)}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="device-link-show"
              disabled={busy}
              onClick={show}
              className="btn btn-primary min-h-11 text-xs"
            >
              {msg("dlink.showQr")}
            </button>
            <button
              type="button"
              data-testid="device-link-revoke"
              disabled={busy}
              onClick={() => setConfirm("revoke")}
              className="btn btn-danger min-h-11 text-xs"
            >
              {msg("dlink.revoke")}
            </button>
            <button
              type="button"
              data-testid="device-link-reissue"
              disabled={busy}
              onClick={() => setConfirm("reissue")}
              className="btn btn-ghost min-h-11 text-xs"
            >
              {msg("dlink.reissue")}
            </button>
          </div>
          {question}
        </div>
      ) : (
        <button
          type="button"
          data-testid="device-link-mint"
          disabled={busy}
          onClick={show}
          className="btn btn-primary mt-3 min-h-11"
        >
          {busy ? "…" : msg("dlink.create")}
        </button>
      )}
    </section>
  );
}
