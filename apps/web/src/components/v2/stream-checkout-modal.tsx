"use client";

// The match-credit checkout sheet (Streaming R1 lane D, Task 14 fix round 1, I2).
//
// Its OWN module so it can be its own chunk. `@stripe/stripe-js` injects
// js.stripe.com as an import side effect, and the stream panel ships on every
// organiser fixtures tab (run-sheet-row.tsx) — a static import there loaded
// Stripe.js for every organiser who never opens a checkout. The panel reaches
// this module ONLY through `stream-checkout-sheet-loader.ts` — warmed on the
// first hand on a credit tile, and mounted by `next/dynamic(..., { ssr: false })`
// once a client secret exists — and `fixture-stream-panel.test.tsx` walks the
// panel's static import graph to keep it that way.
//
// Same chrome as buy-credits.tsx: EMBEDDED Checkout (owner ruling 8), Stripe's
// iframe self-sizes, and the repo's Modal caps it at 85vh. P2: `bleed`, because at 320 the Modal's own padding left the
// iframe 270 px and Stripe's form was cut off on the right.
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Modal } from "@/components/modal";
import { useMsg } from "@/components/i18n/dict-provider";
import { stripePromise } from "@/lib/stripe-browser";

export default function StreamCheckoutModal({ clientSecret, onClose }: { clientSecret: string; onClose: () => void }) {
  const msg = useMsg();
  return (
    <Modal title={msg("stream.credits.title")} size="lg" bleed onClose={onClose}>
      <div data-testid="stream-checkout-modal">
        <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
    </Modal>
  );
}
