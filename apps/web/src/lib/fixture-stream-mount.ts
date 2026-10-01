// lib/fixture-stream-mount.ts — which Stream mount the organiser fixture page renders (spec 2026-09-30 §2 "Fixture page
// mount"), and the console's one-open-panel rule. Pure, so the whole truth table is pinned in node vitest
// (`lib/__tests__/fixture-stream-mount.test.ts`) rather than through a page render.
import { destinationWarning, type StreamSessionView } from "@/lib/stream-session-view";

/** "panel" — the full Stream panel. "stop-only" — the Phone tab's Stop control alone (a frozen or de-entitled page
 *  with a session still on air: Stop must stay reachable, spec F1). null — no Stream control at all. */
export type FixtureStreamMode = "panel" | "stop-only" | null;

export function fixtureStreamMode(i: {
  /** The PAGE's organiser gate — `canEdit` for the competition, NOT the fixture's decided/cancelled state. */
  canEdit: boolean;
  /** `streaming.overlay` resolved for the competition (the loader's `entitled`). */
  entitled: boolean;
  /** The org is billing-frozen. */
  frozen: boolean;
  /** This fixture has a session in an ACTIVE state (`openStreamStates`). */
  activeSession: boolean;
}): FixtureStreamMode {
  if (!i.canEdit) return null;
  if (i.entitled && !i.frozen) return "panel";
  return i.activeSession ? "stop-only" : null;
}

/** The console opens at most ONE of its two disclosure panels at a time — Remote scoring (hand-over) or Stream. */
export type OpenPanel = "handover" | "stream" | null;

/** A click on a panel's control: the open one closes, any other one takes over. */
export function nextOpenPanel(current: OpenPanel, clicked: "handover" | "stream"): OpenPanel {
  return current === clicked ? null : clicked;
}

/** Spec §2 — the Stream button's dot: none idle or over, amber while the session is up but not on air (requested,
 *  provisioning, warming) or during the D3 warning, red while live; the label reads "Live" while live. `ending` is not
 *  named by the spec — a PLAN decision: amber "Stream", still up, no longer live. No clock: D3's 30 s is the server's
 *  `elapsedMs` (M6), the same measure the Signal path reads, so the button and the chain cannot disagree. */
export function streamButtonState(view: Pick<StreamSessionView, "state" | "output"> | null): {
  dot: null | "amber" | "red";
  labelKey: "stream.button" | "stream.buttonLive";
} {
  if (!view) return { dot: null, labelKey: "stream.button" };
  switch (view.state) {
    case "requested":
    case "provisioning":
    case "warming":
    case "ending":
      return { dot: "amber", labelKey: "stream.button" };
    case "live":
      return { dot: destinationWarning(view) ? "amber" : "red", labelKey: "stream.buttonLive" };
    case "completed":
    case "failed":
      return { dot: null, labelKey: "stream.button" };
  }
}
