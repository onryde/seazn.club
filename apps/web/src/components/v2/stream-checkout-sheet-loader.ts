// The match-credit checkout sheet's ONE loader (Streaming R1 lane D, Task 14).
//
// Shared by the panel's `next/dynamic(loadCheckoutSheet, { ssr: false })` and its tile-intent warm-up, so the two can
// never name different chunks (N2). Its own module for one reason: a test can count calls to it (M2 — opening the
// credits chooser must load nothing; a hand on a tile loads it once).
//
// This module is in the panel's STATIC import graph, which ships on every organiser fixtures tab. It must therefore
// import nothing: the sheet module pulls in `@stripe/stripe-js`, whose import side effect injects js.stripe.com, and
// only this dynamic `import()` keeps that out of the tab until an organiser reaches for a pack (I2).
export const loadCheckoutSheet = () => import("./stream-checkout-modal");
