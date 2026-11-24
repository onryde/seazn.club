"use client";

import { Component, Fragment, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { fetchRelayCheckoutClientSecret } from "@/lib/billing-checkout-client";
import { loadCheckoutSheet } from "../stream-checkout-sheet-loader";
import { formatMinor, type Currency } from "@/lib/currency";
import { STREAM_CREDIT_PACKS, streamPackAmountMinor, streamPackPerMatchMinor, type StreamPackSize } from "@/lib/stream-credit-packs";
import type { StreamCreditSplit, CheckoutError } from "./types";
import { type Msg, switchedOff } from "./shared";

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

/**
 * The relay credit purchase as ONE piece of container state (B8 re-review item 2): the chooser's open/closed, its one
 * Checkout Session at a time (N2), the sheet's chunk warmed on a hand on a tile (M2), a plan refusal (C22 / D12), and the
 * lazily loaded embedded sheet (owner ruling 8) with its own error boundary (M1). Two callers: the Phone tab, and — with
 * `capture-qr-v2` off — the credits section under the OBS overlay. `setBusy` is the caller's: the Phone tab's is the shared
 * session's, so a tile tap holds every session control too.
 */
export function useCreditCheckout({ orgId, fixtureId, setBusy }: { orgId: string; fixtureId: string; setBusy: (busy: boolean) => void }) {
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
export function creditsCard(
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
export function shownSplit(split: StreamCreditSplit | null, balance: number): StreamCreditSplit | null {
  return split !== null && split.monthly > 0 && split.pack > 0 && split.total === balance ? split : null;
}

/** The balance part of a credits line: the plural key's own text, the split as its `title` and a visually hidden copy
 *  (the title is not read by every screen reader, nor shown on touch). */
export function balancePart(msg: Msg, balance: number, split: StreamCreditSplit | null): ReactNode {
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
export function buyMorePart(msg: Msg, o: { expanded: boolean; disabled: boolean; onClick: () => void }): ReactNode {
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
