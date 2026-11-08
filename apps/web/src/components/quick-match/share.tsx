"use client";
// The quick match home's Share (plan 2 Task 7; spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, O3;
// pre-flight B7, D14; mockup docs/superpowers/specs/mockups/2026-11-03-quick-match/home.html, the actions row's "Share link").
// One "Share link" toggle, closed on first paint. Opened, it holds the three ways a guest hands the match on: the link in a
// read-only field with Copy, the phone's own share sheet (`ShareButton`, only where `navigator.share` exists, D14), and
// the Seazn QR of the link (a standing rule: every QR carries the logo) for a friend standing at the court.
//
//   - The link is the HOME's, `routes.quickMatch(token)`, on the page's own origin (`window.location.origin`): the page
//     hands over the path only, so no forwarded host is ever trusted (B7). It is never the pad's device link.
//   - The home token is the scoring credential (O3): nothing of it is in the server's HTML (the panel renders only once
//     opened), and every element that holds it carries `ph-no-capture` (scrub-secret-painters.test.ts). The QR is
//     painted `sensitive`, which blocks the image AND its enlarged overlay, a portal outside this tree.
//   - The QR is drawn on the tap, with its encoder loaded then (`checkin-qr.tsx`'s way): `renderSeaznQr` fetches the
//     logo in the browser, and only it draws the logo-carrying symbol.
//   - Copy says "Copied" only when the clipboard took the link. With no clipboard (an insecure page, an old browser) or
//     a refusal, it selects the link in its field, so the system's own Copy is one step away (device-link-panel m8).
//
// Words come in as props in the viewer's language (the page's dictionary); `ShareButton` and `SeaznQrImage` read their
// own (`share.*`, `qr.*`) from the `DictProvider` the page puts around this island.
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Link as LinkIcon } from "lucide-react";
import { ShareButton } from "@/components/share-button";
import { PHONE_HANDOVER_QR_MAX_PX, SeaznQrImage, SeaznQrPlaceholder } from "@/components/v2/seazn-qr-image";
// A TYPE only: the encoder (`qrcode`) and the logo fetch load on the tap.
import type { SeaznQr } from "@/lib/seazn-qr";
import { useOrigin } from "@/lib/use-client-snapshot";

export interface QuickMatchShareProps {
  /** `routes.quickMatch(token)`: the home's own path. The island puts it on the page's origin. */
  path: string;
  /** The match's name: the share sheet's title. */
  title: string;
  labels: {
    /** "Share link": the toggle, and the name of the link's field. */
    share: string;
    copy: string;
    copied: string;
    qrAlt: string;
    /** The share sheet's message; the sheet appends the link itself. */
    shareNative: string;
  };
}

/** How long "Copied" stays before the button reads "Copy link" again. */
const COPIED_MS = 2000;

const capabilityNeverChanges = () => () => {};
const readCanShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";
const cannotShareOnServer = () => false;

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream";
/** The mockup's ghost button: a violet rule on night, cream words, a 44px target. */
const GHOST = `app-display inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-lg border border-[#4a3885] px-4 py-2 text-center text-sm font-semibold leading-tight text-cream [overflow-wrap:anywhere] transition-colors hover:border-[#b7aede] motion-reduce:transition-none ${FOCUS}`;

export function QuickMatchShare({ path, title, labels }: QuickMatchShareProps) {
  // "" on the server and through hydration; the panel that shows the link only renders after a tap, so by then it is live.
  const origin = useOrigin();
  const canShare = useSyncExternalStore(capabilityNeverChanges, readCanShare, cannotShareOnServer);
  const [open, setOpen] = useState(false);
  /** The drawn symbol; null while none is drawn (or one is being drawn); "failed" when the last try did not land. */
  const [qr, setQr] = useState<SeaznQr | "failed" | null>(null);
  const [copied, setCopied] = useState(false);
  const drawing = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const url = origin ? new URL(path, origin).href : path;

  /** The link as this page is addressed, read at the tap. */
  const homeUrl = () => new URL(path, window.location.origin).href;

  async function drawQr() {
    if (drawing.current) return;
    drawing.current = true;
    setQr(null);
    try {
      const { renderSeaznQr } = await import("@/lib/seazn-qr");
      setQr(await renderSeaznQr(homeUrl()));
    } catch {
      // No symbol (the encoder's chunk or the page went away): the link and Copy still work, and opening again retries.
      setQr("failed");
    } finally {
      drawing.current = false;
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && (qr === null || qr === "failed")) void drawQr();
  }

  async function copy() {
    const link = homeUrl();
    try {
      // A missing clipboard throws (a TypeError on `undefined`), the same as a refusal: both select the link instead.
      await navigator.clipboard.writeText(link);
    } catch {
      const el = field.current;
      el?.focus();
      el?.select();
      el?.setSelectionRange(0, link.length);
      return;
    }
    setCopied(true);
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null;
      setCopied(false);
    }, COPIED_MS);
  }

  return (
    <div data-testid="qm-share" className="flex w-full min-w-0 flex-col gap-3">
      <button
        type="button"
        data-testid="qm-share-toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
        className={`${GHOST} w-full`}
      >
        <LinkIcon aria-hidden="true" className="h-4 w-4 flex-none" strokeWidth={1.75} />
        <span className="min-w-0">{labels.share}</span>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 flex-none transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <div
          id={panelId}
          data-testid="qm-share-panel"
          className="flex min-w-0 flex-col gap-3 rounded-2xl border border-[#4a3885] bg-night-2 p-3"
        >
          <input
            ref={field}
            data-testid="qm-share-url"
            type="text"
            readOnly
            value={url}
            aria-label={labels.share}
            onFocus={(e) => e.currentTarget.select()}
            className={`ph-no-capture min-h-11 w-full min-w-0 truncate rounded-lg border border-[#4a3885] bg-night px-3 text-sm text-cream ${FOCUS}`}
          />
          <div data-testid="qm-share-actions" className="flex min-w-0 flex-wrap gap-2">
            <button
              type="button"
              data-testid="qm-share-copy"
              onClick={copy}
              className={`${GHOST} flex-1 basis-32 ${copied ? "border-[color:var(--mk-lime)] text-[color:var(--mk-lime)]" : ""}`}
            >
              {copied ? labels.copied : labels.copy}
            </button>
            {canShare ? <ShareButton text={labels.shareNative} url={url} title={title} className={`${GHOST} flex-1 basis-32`} /> : null}
          </div>
          {/* "Copied" read out, not only shown: the button's own words change silently for a screen reader. */}
          <span data-testid="qm-share-status" role="status" className="sr-only">
            {copied ? labels.copied : ""}
          </span>
          {qr === "failed" ? null : (
            // White under the symbol and its caption: a QR scans dark on light, and the caption is slate on white.
            <div className="ph-no-capture mx-auto w-full max-w-[24rem] min-w-0 rounded-xl bg-white p-3">
              {qr === null ? (
                <SeaznQrPlaceholder maxSize={PHONE_HANDOVER_QR_MAX_PX} modules={null} />
              ) : (
                <SeaznQrImage qr={qr} alt={labels.qrAlt} testId="qm-share-qr" sensitive maxSize={PHONE_HANDOVER_QR_MAX_PX} />
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
