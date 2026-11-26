"use client";
// "Open in app" (spec 2026-11-25 §5.4, plan "Approved look"): the button a person on the phone that will film or score
// taps instead of scanning the QR below it. Shown only with the release flag on, in an Android browser (read after
// mount, so the server and the first client render agree on nothing), and below `md`; otherwise the host panel is
// exactly as it was.
//
// THE HREF IS A LIVE CREDENTIAL (§5.5) on a page that runs analytics. Everything here sits inside ONE `ph-no-capture`
// element: PostHog autocapture ignores a click inside it, and its session replay records nothing of it. The anchor is
// a plain `<a>` with the link already built — no `next/link` (a client-side route change never reaches Android), no
// `target` (Chrome hands a same-tab navigation from the person's own tap to the app), no fetch-then-redirect — and
// `rel="noreferrer"`.
import { useSyncExternalStore, type ReactNode } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { isAndroidUa } from "@/lib/android-ua";
import { openInAppEnabled } from "@/lib/open-in-app";
import type { StreamHintKey } from "@/lib/open-in-app-hint";

const subscribeNever = () => () => {};
const readAndroid = () => isAndroidUa(navigator.userAgent);
const notOnServer = () => false;

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--mk-cream)]";

export function OpenInAppRow({ href, className, children }: { href: string | null; className?: string; children?: ReactNode }) {
  const android = useSyncExternalStore(subscribeNever, readAndroid, notOnServer);
  if (!openInAppEnabled() || !android || href === null) return null;
  return (
    <OpenInAppBlock href={href} className={className}>
      {children}
    </OpenInAppBlock>
  );
}

/** The block's markup, without the who-sees-it question — exported so a node test can read its classes and attributes.
 *  Its one caller is `OpenInAppRow`. */
export function OpenInAppBlock({ href, className, children }: { href: string; className?: string; children?: ReactNode }) {
  const msg = useMsg();
  return (
    <div data-testid="open-in-app-block" className={`ph-no-capture md:hidden min-w-0 space-y-2${className ? ` ${className}` : ""}`}>
      {/* `--mk-font-display` is the marketing tree's own variable; in the console the same condensed face is mounted
          on `--font-barlow` (lib/fonts.ts), so `mk-display` is pointed at it here. */}
      <div className="rounded-[10px] bg-[var(--mk-night)] p-1.5 [--mk-font-display:var(--font-barlow)]">
        <div className="flex min-w-0 flex-col gap-1.5 rounded-[7px] border-[1.5px] border-dashed border-[var(--mk-lime)] p-2">
          {/* The brand's own art at a fixed 18px: nothing for next/image to resize. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/seazn-logo-night-tight.png" alt="Seazn Club" width={78} height={18} className="mx-auto h-[18px] w-auto" />
          <a
            data-testid="open-in-app"
            href={href}
            rel="noreferrer"
            // `!`: `.mk-display` is unlayered and sets its own tracking, which would otherwise win.
            className={`mk-display flex min-h-11 w-full items-center justify-center rounded-lg bg-[var(--mk-lime)] px-3 text-center text-[15px] font-bold tracking-[0.06em]! text-[var(--mk-night)] ${FOCUS_RING}`}
          >
            {msg("openApp.button")}
          </a>
          {children}
        </div>
      </div>
      <p className="text-center text-xs text-slate-600">{msg("openApp.orScan")}</p>
    </div>
  );
}

/** The scoring link's own pad, for a person who would rather not use the app: a new tab, so the panel keeps the secret
 *  it is showing. Only ever a child of `OpenInAppRow`, which is what keeps it out of analytics. */
export function ScoreInBrowserLink({ href }: { href: string }) {
  const msg = useMsg();
  return (
    <a
      data-testid="score-in-browser-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      // Its own `ph-no-capture` as well as the block's: the pad URL stays covered wherever this link is placed.
      className={`ph-no-capture flex min-h-11 w-full items-center justify-center rounded-lg border border-[#4a378c] px-3 text-center text-[13px] font-semibold text-[var(--mk-cream)] ${FOCUS_RING}`}
    >
      {msg("openApp.scoreInBrowser")}
    </a>
  );
}

type HintKey = StreamHintKey | "openApp.stream.checkFirst";

/** The two lines that name something missing are amber; the rest are the box's own soft violet. */
const MISSING: ReadonlySet<HintKey> = new Set<HintKey>(["openApp.stream.needDestination", "openApp.stream.needCredit"]);

export function OpenInAppHint({ hint }: { hint: HintKey }) {
  const msg = useMsg();
  return (
    <p
      data-testid="open-in-app-hint"
      data-hint={hint}
      className={`text-center text-[11.5px] leading-snug ${MISSING.has(hint) ? "text-[#ffc66b]" : "text-[#c9bfee]"}`}
    >
      {msg(hint)}
    </p>
  );
}
