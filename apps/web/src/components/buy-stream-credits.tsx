"use client";

// The match-credit packs on Settings → Credits → Streaming: three tiles that open the SAME embedded Checkout the fixture
// page's Phone tab opens (components/v2/stream-checkout-modal.tsx, through the ONE lazy loader, so Stripe.js is fetched
// when somebody reaches for a pack and never before). What differs from the panel is only where Stripe sends the buyer
// back: this screen has no fixture, so the request names `returnTo: "settings"` and the route returns to
// Credits → Streaming, which reconciles the payment before it reads the balance.
//
// The pack catalogue, its prices and its captions are the panel's own (lib/stream-credit-packs.ts), so a price changed in
// the one table moves both screens. The panel keeps its own copy of the purchase state machine (its busy lock is the
// phone session's); this one holds the same rules: the sheet's code is in hand BEFORE a Checkout Session is asked for
// (R5a), one Session per sheet (N2), and a sheet that cannot load is a refused checkout, never the page's error screen (M1).
import { Component, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useLocaleOrDefault, useMsg } from "@/components/i18n/dict-provider";
import { loadCheckoutSheet } from "@/components/v2/stream-checkout-sheet-loader";
import { fetchRelayCheckoutClientSecret } from "@/lib/billing-checkout-client";
import { formatMinor, type Currency } from "@/lib/currency";
import {
  STREAM_CREDIT_PACKS, streamPackAmountMinor, streamPackPerMatchMinor, type StreamPackSize,
} from "@/lib/stream-credit-packs";

const StreamCheckoutModal = dynamic(loadCheckoutSheet, { ssr: false });

/** The sheet's own error boundary: a chunk that fails to load (a stale deploy is the usual way) throws during render, and
 *  without this the page's error screen replaces the whole tab. Renders nothing once failed and tells the container. */
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

type BuyError = "owner" | "unknown";

export function BuyStreamCredits({ orgId, currency }: { orgId: string; currency: Currency }) {
  const msg = useMsg();
  const locale = useLocaleOrDefault();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<BuyError | null>(null);
  // The plan lost streaming between the page load and the tap (a downgrade, an override): the route's 402.
  const [planGate, setPlanGate] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  // N2: held from the tap until the sheet closes or the attempt is refused. A ref, so a double tap landing on ONE render's
  // handler — before `busy` has disabled anything — is refused too.
  const buying = useRef(false);
  const warmed = useRef(false);
  const onTileIntent = () => {
    if (warmed.current) return;
    warmed.current = true;
    void loadCheckoutSheet().catch(() => {
      warmed.current = false;
    });
  };

  const onBuy = async (pack: StreamPackSize) => {
    if (buying.current) return;
    buying.current = true;
    setBusy(true);
    setError(null);
    try {
      await loadCheckoutSheet();
    } catch {
      buying.current = false;
      setBusy(false);
      setError("unknown");
      return;
    }
    const result = await fetchRelayCheckoutClientSecret({ orgId, pack, returnTo: "settings" });
    setBusy(false);
    if (result.ok) {
      // `buying` stays held until the sheet is closed.
      setSecret(result.clientSecret);
      return;
    }
    buying.current = false;
    if (result.status === 402) {
      setPlanGate(true);
      return;
    }
    setError(result.status === 403 ? "owner" : "unknown");
  };

  return (
    <div data-testid="credits-stream-buy">
      <h3 className="text-sm font-semibold text-slate-700">{msg("stream.credits.title")}</h3>
      <p className="mt-0.5 text-xs text-slate-500">{msg("stream.credits.line")}</p>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
        {STREAM_CREDIT_PACKS.map((pack) => {
          // The amount the pack's Stripe price charges in the checkout's currency. A currency the price has no option for
          // quotes NOTHING rather than a GBP number under the wrong sign (the checkout would refuse it).
          const total = streamPackAmountMinor(pack, currency);
          const perMatch = streamPackPerMatchMinor(pack, currency);
          return (
            <button
              key={pack.size}
              type="button"
              disabled={busy || planGate}
              data-testid={`credits-stream-buy-pack-${pack.size}`}
              onClick={() => void onBuy(pack.size)}
              onPointerEnter={onTileIntent}
              onFocus={onTileIntent}
              onTouchStart={onTileIntent}
              className={`flex min-h-11 w-full flex-col items-start justify-start rounded-lg border bg-white p-3 text-left hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-50 ${
                pack.popular ? "border-purple-500" : "border-purple-200"
              }`}
            >
              <span className="block text-lg font-semibold text-slate-800">{msg(pack.labelKey)}</span>
              {total !== undefined && (
                <span className="block text-sm text-slate-600">{formatMinor(total, currency, locale)}</span>
              )}
              {perMatch !== undefined && (
                <span className="block text-xs text-slate-600">
                  {msg("stream.credits.perMatch", { price: formatMinor(perMatch, currency, locale) })}
                </span>
              )}
              {pack.popular && (
                <span className="mt-1 inline-block rounded-full bg-purple-100 px-2 text-xs text-purple-800">
                  {msg("stream.credits.popular")}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {error && (
        <p data-testid="credits-stream-buy-error" role="alert" className="mt-2 text-sm text-red-700">
          {msg(error === "owner" ? "stream.credits.error.owner" : "stream.credits.error.unknown")}
        </p>
      )}
      {planGate && (
        <p data-testid="credits-stream-buy-gate" role="alert" className="mt-2 text-sm text-red-700">
          {msg("stream.phone.switchedOff")}
        </p>
      )}
      {secret && (
        <CheckoutSheetBoundary
          onFail={() => {
            buying.current = false;
            setSecret(null);
            setError("unknown");
          }}
        >
          <StreamCheckoutModal
            clientSecret={secret}
            onClose={() => {
              buying.current = false;
              setSecret(null);
            }}
          />
        </CheckoutSheetBoundary>
      )}
    </div>
  );
}
