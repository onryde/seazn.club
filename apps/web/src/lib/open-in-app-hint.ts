// lib/open-in-app-hint.ts — the line beside a stream "Open in app" button on the fixture panel (spec 2026-11-25 §5.4).
// The server refuses the app's own Go live without a destination or a credit, so when the page KNOWS one is missing the
// line names it; the button stays, because pairing needs neither.

import type { PhoneTabState } from "@/lib/stream-session-view";

export type StreamHintKey = "openApp.stream.thenGoLive" | "openApp.stream.needDestination" | "openApp.stream.needCredit";

/** The destination is named first. */
export function streamHintKey({ hasDestination, hasCredit }: { hasDestination: boolean; hasCredit: boolean }): StreamHintKey {
  if (!hasDestination) return "openApp.stream.needDestination";
  return hasCredit ? "openApp.stream.thenGoLive" : "openApp.stream.needCredit";
}

/** Is a session open in this phone-tab state? A Record, so a new state does not compile until it is answered here. */
const SESSION_OPEN: Record<PhoneTabState, boolean> = {
  idle: false,
  provisioning: true,
  warming: true,
  live: true,
  ending: true,
  ended: false,
  failed: false,
};

/** What the fixture panel knows is held, from what it already gates its own Go live on. With a session open
 *  (`SESSION_OPEN`) nothing is missing: it was admitted with a destination and a credit, and the projected balance has
 *  already paid for it — a 0 there must not read as "you need a credit" mid-stream. */
export function streamHintNeeds(facts: {
  state: PhoneTabState;
  selectedTargetId: string | null;
  balance: number;
  /** A restart inside the reuse window costs no credit (`restart.free`). */
  freeRestart: boolean;
}): { hasDestination: boolean; hasCredit: boolean } {
  if (SESSION_OPEN[facts.state]) return { hasDestination: true, hasCredit: true };
  return { hasDestination: Boolean(facts.selectedTargetId), hasCredit: facts.balance >= 1 || facts.freeRestart };
}
