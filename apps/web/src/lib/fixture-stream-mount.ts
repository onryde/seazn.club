// lib/fixture-stream-mount.ts — which Stream mount the organiser fixture page renders (spec 2026-09-30 §2 "Fixture page
// mount"), and the console's one-open-panel rule. Pure, so the whole truth table is pinned in node vitest
// (`lib/__tests__/fixture-stream-mount.test.ts`) rather than through a page render.

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
  /** This fixture has a session in an ACTIVE state (`openStreamFixtureIds`). */
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
