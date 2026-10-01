"use client";
// Owner ruling D10 (2026-10-04): every Seazn QR opens full screen on a SINGLE tap (a double tap is the browser's zoom),
// on white, as large as the viewport allows, with the screen kept awake. Esc, the ✕ or any tap closes it, and focus
// returns to the QR.
//
// `sensitive` is REQUIRED, never defaulted: a QR that paints a live secret (the capture credentials, the Remote
// scoring `/score/<secret>` link, the check-in bearer link) carries `ph-no-capture` on the inline image AND on the
// enlarged overlay, because PostHog replay compresses its DOM frames before the `before_send` scrub can see them and
// its recorder blocks only this class (device-link-panel.tsx, the comment above its QR). The overlay is a portal on
// `document.body`, outside any ancestor that carries the class, so it must carry it itself.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useMsg } from "@/components/i18n/dict-provider";
import { enlargedQrSize, holdScreenWakeLock, snapQrSize } from "@/lib/qr-enlarge";
// A TYPE only: the encoder (`qrcode`) stays out of this component's bundle — the check-in QR loads it on the tap.
import type { SeaznQr } from "@/lib/seazn-qr";

/** The replay-blocking class, applied to every element that paints a sensitive QR. */
export const QR_NO_CAPTURE = "ph-no-capture";
export const qrCaptureClass = (sensitive: boolean): string => (sensitive ? QR_NO_CAPTURE : "");

/** "Tap to enlarge" under every inline QR — slate-600, not 500: the caption sits on whatever its host paints (white,
 *  slate-50, the stream frame's violet), and slate-500 falls under AA on the violet (stream-signal-chain's own note).
 *  The placeholder renders it INVISIBLE, so the box keeps the same height when the symbol lands (review m-7). */
const CAPTION_CLASS = "mt-1 text-center text-xs text-slate-600";

/** The frame's width and the screen's DPR, kept current. The ResizeObserver announces the first size itself (before
 *  the first paint) and every change of the box after it; the window's resize announces a zoom or a move to another
 *  screen, which changes the DPR and not always the box. With no ResizeObserver (a very old browser) nothing is
 *  measured and the QR paints its cap, snapped, inside `max-width: 100%`. */
function useFrame(frame: HTMLElement | null): { width: number; dpr: number } | null {
  const [box, setBox] = useState<{ width: number; dpr: number } | null>(null);
  useLayoutEffect(() => {
    if (!frame || typeof ResizeObserver !== "function") return;
    const read = () => {
      const width = frame.getBoundingClientRect().width;
      const dpr = window.devicePixelRatio || 1;
      setBox((b) => (b && b.width === width && b.dpr === dpr ? b : { width, dpr }));
    };
    const ro = new ResizeObserver(read);
    ro.observe(frame);
    window.addEventListener("resize", read);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [frame]);
  return box;
}

/** The CSS px a QR is painted at in its frame: the frame (or the cap, before it is measured), capped, snapped to whole
 *  device px per module (B6 fix round 1, ruling I-2). `modules: null` (no payload yet) is the box itself. */
function paintedSize(box: { width: number; dpr: number } | null, maxSize: number, modules: number | null): number {
  const room = Math.min(maxSize, box?.width ?? maxSize);
  return modules === null ? room : snapQrSize(room, modules, box?.dpr ?? 1);
}

export function SeaznQrImage({
  qr,
  alt,
  testId,
  sensitive,
  maxSize,
  className,
}: {
  qr: SeaznQr;
  alt: string;
  testId: string;
  sensitive: boolean;
  /** The largest CSS px this QR may paint at; the frame it sits in may give it less. Snapped either way. */
  maxSize: number;
  /** Decoration only (a border, a radius): the size is the component's. */
  className?: string;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // A callback ref, so the measuring effect runs once the frame exists (an object ref would not re-run it).
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const size = paintedSize(useFrame(frame), maxSize, qr.modules);
  return (
    <div ref={setFrame} className="w-full">
      <button
        ref={trigger}
        type="button"
        data-testid={`${testId}-enlarge`}
        aria-haspopup="dialog"
        aria-label={msg("qr.enlarge")}
        onClick={() => setOpen(true)}
        className="mx-auto block w-full touch-manipulation rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
      >
        {/* A data: URL encoded in the browser — nothing for next/image to optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          data-testid={testId}
          src={qr.src}
          alt={alt}
          className={[qrCaptureClass(sensitive), "mx-auto block", className].filter(Boolean).join(" ")}
          style={{ width: size, height: size }}
        />
      </button>
      <p className={CAPTION_CLASS}>{msg("qr.tapToEnlarge")}</p>
      {open && (
        <QrEnlarged
          qr={qr}
          alt={alt}
          sensitive={sensitive}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}

/** Where a QR will land, before its symbol has: the same frame, the same snapped square (when the payload, and so the
 *  module count, is known) and the caption's line held by an invisible copy of it — so the box does not change height
 *  when the symbol lands (review m-7). */
export function SeaznQrPlaceholder({ maxSize, modules }: { maxSize: number; modules: number | null }) {
  const msg = useMsg();
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const size = paintedSize(useFrame(frame), maxSize, modules);
  return (
    <div ref={setFrame} aria-hidden className="w-full">
      <div
        className="mx-auto max-w-full animate-pulse rounded bg-slate-100 motion-reduce:animate-none"
        style={{ width: size, height: size }}
      />
      <p className={`${CAPTION_CLASS} invisible`}>{msg("qr.tapToEnlarge")}</p>
    </div>
  );
}

/** The overlay's markup, with no effects and no portal — exported so a node test can render it and pin its classes
 *  (the effects and the portal are the browser's, and the e2e witnesses them). Portrait stacks the caption under the
 *  QR; landscape (`landscape:flex-row`) puts it beside the QR, where the free space is, so the QR keeps the ruling's
 *  full `min(vw, vh) − 32` and never overlaps the caption or leaves the viewport (review R6). */
export function QrEnlargedView({
  src,
  alt,
  sensitive,
  size,
  label,
  closeLabel,
  caption,
  onClose,
  closeRef,
}: {
  src: string;
  alt: string;
  sensitive: boolean;
  size: number;
  label: string;
  closeLabel: string;
  caption: string;
  onClose: () => void;
  closeRef?: RefObject<HTMLButtonElement | null>;
}) {
  // Destructured, not `p.*`: a props object that carries a ref reads, to the React compiler, as a ref read in render.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid="qr-enlarged"
      onClick={(e) => {
        e.stopPropagation(); // a portal still bubbles through the React tree to its owner
        onClose();
      }}
      className={`${qrCaptureClass(sensitive)} fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-white landscape:flex-row`}
    >
      <button
        ref={closeRef}
        type="button"
        data-testid="qr-enlarged-close"
        aria-label={closeLabel}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-lg text-2xl text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
      >
        ✕
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        data-testid="qr-enlarged-img"
        src={src}
        alt={alt}
        className={`${qrCaptureClass(sensitive)} shrink-0`}
        style={{ width: size, height: size }}
      />
      {/* Beside the QR in landscape at a FIXED width, under it in portrait: the room `enlargedQrSize` reserves for it. */}
      <p className="max-w-xs px-4 text-center text-sm text-slate-600 landscape:w-40 landscape:shrink-0">{caption}</p>
    </div>
  );
}

/** The enlarged QR's room and the screen's DPR, read from the window at the moment of asking. */
const readViewport = () => ({ room: enlargedQrSize(window.innerWidth, window.innerHeight), dpr: window.devicePixelRatio || 1 });

/** The open overlay: the portal, the size kept to the viewport and snapped, Esc and the focus trap, and the wake lock.
 *  Exported only so the node test can drive its effects through the hook harness; its one caller is `SeaznQrImage`. */
export function QrEnlarged({
  qr,
  alt,
  sensitive,
  onClose,
}: {
  qr: SeaznQr;
  alt: string;
  sensitive: boolean;
  onClose: () => void;
}) {
  const msg = useMsg();
  const closeBtn = useRef<HTMLButtonElement>(null);
  // The LATEST onClose, read when a key is pressed: the effect below runs once per opening, and a handler captured
  // at mount would close over a stale parent render. Synced in an effect — writing a ref during render is a lint error.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    closeBtn.current?.focus();
    const onResize = () => setViewport(readViewport());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "Tab") {
        // the ✕ is the dialog's only control: keep focus inside
        e.preventDefault();
        closeBtn.current?.focus();
      }
    };
    // The browser drops a screen wake lock whenever the page is hidden and never gives it back (review m-1): let the
    // dropped one go on hide, and ask again when the page is shown while the QR is still enlarged.
    const nav = navigator as Parameters<typeof holdScreenWakeLock>[0];
    let release = holdScreenWakeLock(nav);
    const onVisibility = () => {
      release();
      release = document.visibilityState === "visible" ? holdScreenWakeLock(nav) : () => {};
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, []);
  return createPortal(
    <QrEnlargedView
      src={qr.src}
      alt={alt}
      sensitive={sensitive}
      size={snapQrSize(viewport.room, qr.modules, viewport.dpr)}
      label={msg("qr.enlarged.name")}
      closeLabel={msg("qr.enlarged.close")}
      caption={msg("qr.enlarged.brightness")}
      onClose={onClose}
      closeRef={closeBtn}
    />,
    document.body,
  );
}
