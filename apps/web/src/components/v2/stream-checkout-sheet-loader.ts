// The match-credit checkout sheet's ONE loader (Streaming R1 lane D, Task 14).
//
// Shared by the panel's `next/dynamic(loadCheckoutSheet, { ssr: false })`, its tile-intent warm-up (M2) and the buy
// flow, which AWAITS it before asking for a Checkout Session (R5a: no code, no Session). Its own module so a test can
// count calls to it.
//
// R5a — why the cache drops a failure. `next/dynamic` is `React.lazy`, which pins whatever its first load settles to
// for the page's lifetime; so the sheet is mounted only AFTER this loader has resolved, and the lazy component can only
// ever pin a success. A failure stays here instead, and here it is forgotten: the next call runs `import()` again. That
// is a real retry in this build — Turbopack's chunk runtime deletes a failed chunk's resolver once its own single
// NetworkError retry is spent, so a fresh `import()` requests the chunk again (read from the built
// `static/chunks/turbopack-*.js`, 2026-09-29).
//
// This module is in the panel's STATIC import graph, which ships on every organiser fixtures tab. It must therefore
// import nothing: the sheet module pulls in `@stripe/stripe-js`, whose import side effect injects js.stripe.com, and
// only the dynamic `import()` below keeps that out of the tab until an organiser reaches for a pack (I2).

/** A loader that fetches once, shares an in-flight load, and forgets a FAILED one so the next call imports again. */
export function makeSheetLoader<M>(importer: () => Promise<M>): () => Promise<M> {
  let pending: Promise<M> | null = null;
  return () => {
    pending ??= importer().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}

export const loadCheckoutSheet = makeSheetLoader(() => import("./stream-checkout-modal"));
