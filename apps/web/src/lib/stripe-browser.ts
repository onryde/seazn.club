import { loadStripe, type Stripe } from "@stripe/stripe-js";

let loaded: Promise<Stripe | null> | null = null;
function load(): Promise<Stripe | null> {
  if (!loaded) {
    const p = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "");
    loaded = p;
    // Parked (d): a FAILED load (js.stripe.com unreachable) is dropped, so the next checkout loads afresh.
    // @stripe/stripe-js resets its own cache on error; holding the rejected promise here pinned every embedded
    // checkout in the app to that one failure until a full reload. The catch also marks the preload's rejection handled.
    p.catch(() => {
      if (loaded === p) loaded = null;
    });
  }
  return loaded;
}
load(); // the preload, as before: Stripe.js starts loading when this module does.

/** Load Stripe.js once for the whole app (publishable key is public). Shared
 *  by embedded checkout and the in-app billing manage surface (v3/11). A
 *  thenable rather than the load's own promise, so each read asks `load()` —
 *  a successful load is shared by every reader, a failed one is retried by the
 *  next. Every consumer takes a PromiseLike (`<Elements stripe>`,
 *  `<EmbeddedCheckoutProvider stripe>`, `await`). */
export const stripePromise: PromiseLike<Stripe | null> = {
  then: (onFulfilled, onRejected) => load().then(onFulfilled, onRejected),
};

/** Elements appearance matched to the app's form system (.input / btn-primary):
 *  purple focus ring, rounded-lg, slate text. */
export const stripeAppearance = {
  variables: {
    colorPrimary: "#9333ea",
    colorText: "#1e293b",
    colorDanger: "#ef4444",
    borderRadius: "8px",
    fontSizeBase: "14px",
  },
} as const;
