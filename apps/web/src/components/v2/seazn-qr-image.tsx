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
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useMsg } from "@/components/i18n/dict-provider";
import { enlargedQrSize, holdScreenWakeLock } from "@/lib/qr-enlarge";

/** The replay-blocking class, applied to every element that paints a sensitive QR. */
export const QR_NO_CAPTURE = "ph-no-capture";
export const qrCaptureClass = (sensitive: boolean): string => (sensitive ? QR_NO_CAPTURE : "");

export function SeaznQrImage(p: {
  src: string;
  alt: string;
  testId: string;
  sensitive: boolean;
  className?: string;
  width?: number;
  height?: number;
}) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid={`${p.testId}-enlarge`}
        aria-haspopup="dialog"
        aria-label={msg("qr.enlarge")}
        onClick={() => setOpen(true)}
        className="mx-auto block w-full touch-manipulation rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
      >
        {/* A data: URL encoded in the browser — nothing for next/image to optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          data-testid={p.testId}
          src={p.src}
          alt={p.alt}
          className={[qrCaptureClass(p.sensitive), p.className].filter(Boolean).join(" ")}
          width={p.width}
          height={p.height}
        />
      </button>
      {/* slate-600, not 500: the caption sits on whatever its host paints (white, slate-50, the stream frame's violet),
          and slate-500 falls under AA on the violet (stream-signal-chain's own note). */}
      <p className="mt-1 text-center text-xs text-slate-600">{msg("qr.tapToEnlarge")}</p>
      {open && (
        <QrEnlarged
          src={p.src}
          alt={p.alt}
          sensitive={p.sensitive}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </>
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
      <p className="max-w-xs px-4 text-center text-sm text-slate-600">{caption}</p>
    </div>
  );
}

/** The open overlay: the portal, the size kept to the viewport, Esc and the focus trap, and the wake lock. Exported
 *  only so the node test can drive its effects through the hook harness; its one caller is `SeaznQrImage`. */
export function QrEnlarged({
  src,
  alt,
  sensitive,
  onClose,
}: {
  src: string;
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
  const [size, setSize] = useState(() => enlargedQrSize(window.innerWidth, window.innerHeight));
  useEffect(() => {
    closeBtn.current?.focus();
    const onResize = () => setSize(enlargedQrSize(window.innerWidth, window.innerHeight));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "Tab") {
        // the ✕ is the dialog's only control: keep focus inside
        e.preventDefault();
        closeBtn.current?.focus();
      }
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKey);
    const release = holdScreenWakeLock(navigator as Parameters<typeof holdScreenWakeLock>[0]);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKey);
      release();
    };
  }, []);
  return createPortal(
    <QrEnlargedView
      src={src}
      alt={alt}
      sensitive={sensitive}
      size={size}
      label={msg("qr.enlarged.name")}
      closeLabel={msg("qr.enlarged.close")}
      caption={msg("qr.enlarged.brightness")}
      onClose={onClose}
      closeRef={closeBtn}
    />,
    document.body,
  );
}
