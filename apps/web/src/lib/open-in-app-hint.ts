// lib/open-in-app-hint.ts — the line beside a stream "Open in app" button on the fixture panel (spec 2026-11-25 §5.4).
// The server refuses the app's own Go live without a destination or a credit, so when the page KNOWS one is missing the
// line names it; the button stays, because pairing needs neither.

export type StreamHintKey = "openApp.stream.thenGoLive" | "openApp.stream.needDestination" | "openApp.stream.needCredit";

/** The destination is named first. */
export function streamHintKey({ hasDestination, hasCredit }: { hasDestination: boolean; hasCredit: boolean }): StreamHintKey {
  if (!hasDestination) return "openApp.stream.needDestination";
  return hasCredit ? "openApp.stream.thenGoLive" : "openApp.stream.needCredit";
}

/** What the fixture panel knows is held, from what it already gates its own Go live on. With a session open
 *  (provisioning, warming, live, ending) nothing is missing: it was admitted with a destination and a credit, and the
 *  projected balance has already paid for it — a 0 there must not read as "you need a credit" mid-stream. */
export function streamHintNeeds(facts: {
  sessionOpen: boolean;
  selectedTargetId: string | null;
  balance: number;
  /** A restart inside the reuse window costs no credit (`restart.free`). */
  freeRestart: boolean;
}): { hasDestination: boolean; hasCredit: boolean } {
  if (facts.sessionOpen) return { hasDestination: true, hasCredit: true };
  return { hasDestination: Boolean(facts.selectedTargetId), hasCredit: facts.balance >= 1 || facts.freeRestart };
}
