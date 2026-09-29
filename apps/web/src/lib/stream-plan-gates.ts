// lib/stream-plan-gates.ts — the plan gates a relay create refuses on, in ONE place.
//
// createSession (server/usecases/stream-sessions.ts `refuse`) throws
// PaymentRequiredError(<key>) for an org whose plan lacks the overlay tier or the
// relay; the v1 envelope carries that key as `extra.feature_key`; and the Phone
// tab's view model (lib/stream-session-view.ts `createErrorCode`) reads it back to
// show the UpgradeGate instead of a retry sentence. Two copies of these strings
// that drift apart turn a plan refusal into "That did not start. Try again." — so
// the server's throw and the client's read both come from here.
//
// ZERO imports, by design: client-safe, so the view model can import it, and
// importable by the server without dragging anything client-side along.
export const RELAY_PLAN_GATES = {
  overlay: "streaming.overlay",
  relay: "streaming.relay",
} as const;
