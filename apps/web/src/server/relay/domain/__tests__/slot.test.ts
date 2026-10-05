// Capture QR v2 §5.4 — domain/slot.ts, the slot state derived from the pairing and the open session.
// §3: a "live slot" is one whose open session has received ingest (`first_ingest_at` is not null).
// T19 (§5.5) is the premise for the ORDER: a slot can be `starting` or `armed` with NO current pairing, so the
// session rows are judged before `empty`/`paired`, which describe a slot with no open session.
import { describe, expect, it } from "vitest";
import { ACTIVE_STATES, type SessionState, TERMINAL_STATES } from "../session";
import { type SlotState, slotState } from "../slot";

const INGEST = new Date("2026-10-01T11:59:00Z");
const open = (state: SessionState, firstIngestAt: Date | null = null) => ({ state, firstIngestAt });

describe("slotState — every §5.4 row", () => {
  it("the empty case first: no current pairing and no open session → empty", () => {
    expect(slotState({ hasCurrent: false, open: null, dead: false })).toBe("empty");
  });

  it("paired: a current pairing and no open session", () => {
    expect(slotState({ hasCurrent: true, open: null, dead: false })).toBe("paired");
  });

  it("starting: an open session in requested or provisioning — with or without a current pairing (T19)", () => {
    for (const state of ["requested", "provisioning"] as const) {
      for (const hasCurrent of [true, false]) {
        expect(slotState({ hasCurrent, open: open(state), dead: false }), `${state} current=${hasCurrent}`).toBe("starting");
      }
    }
  });

  it("armed: an open session in warming with no ingest yet — with or without a current pairing (T19)", () => {
    expect(slotState({ hasCurrent: true, open: open("warming"), dead: false })).toBe("armed");
    expect(slotState({ hasCurrent: false, open: open("warming"), dead: false })).toBe("armed");
  });

  it("live: first_ingest_at set, in warming (a reconnect), live or ending", () => {
    for (const state of ["warming", "live", "ending"] as const) {
      expect(slotState({ hasCurrent: true, open: open(state, INGEST), dead: false }), state).toBe("live");
    }
  });

  it("live·dead: live, and the A14 condition holds — in each of the three live session states", () => {
    for (const state of ["warming", "live", "ending"] as const) {
      expect(slotState({ hasCurrent: true, open: open(state, INGEST), dead: true }), state).toBe("live_dead");
    }
  });

  it("`dead` only qualifies a LIVE slot: armed, starting and paired stay what they are", () => {
    expect(slotState({ hasCurrent: true, open: open("warming"), dead: true })).toBe("armed");
    expect(slotState({ hasCurrent: true, open: open("requested"), dead: true })).toBe("starting");
    expect(slotState({ hasCurrent: true, open: null, dead: true })).toBe("paired");
  });

  // Two combinations §5.4 does not list (recorded for the controller as a spec gap):
  it("gap 1: a session already `live` before first_ingest_at is recorded (a composed runner playing first) → live, so a publishing phone keeps publishing", () => {
    expect(slotState({ hasCurrent: true, open: open("live"), dead: false })).toBe("live");
  });

  it("gap 2: a session `ending` that never received ingest (stopped while starting or armed) → starting, so the phone waits instead of going live into a stop", () => {
    expect(slotState({ hasCurrent: true, open: open("ending"), dead: false })).toBe("starting");
  });

  it("a terminal session passed as the OPEN one is refused by name — completed and failed are never open", () => {
    for (const state of ["completed", "failed"] as const) {
      expect(() => slotState({ hasCurrent: true, open: open(state, INGEST), dead: false }), state).toThrow(/not open/);
    }
  });

  it("every (session state × ingest × current × dead) input: terminal refuses, the rest land on a slot, and all six slots are reached", () => {
    // session.ts's own lists, so a state added there is swept here and a missing §5.4 row reds by name.
    const STATES: readonly SessionState[] = [...ACTIVE_STATES, ...TERMINAL_STATES];
    expect(ACTIVE_STATES.length).toBeGreaterThan(0);
    const reached = new Set<SlotState>();
    let landed = 0, refused = 0;
    for (const state of [null, ...STATES]) {
      for (const ingest of [null, INGEST]) {
        for (const hasCurrent of [true, false]) {
          for (const dead of [true, false]) {
            const input = { hasCurrent, open: state === null ? null : open(state, ingest), dead };
            if (state !== null && TERMINAL_STATES.includes(state)) {
              expect(() => slotState(input)).toThrow();
              refused++;
            } else {
              reached.add(slotState(input));
              landed++;
            }
          }
        }
      }
    }
    expect(landed + refused).toBe((STATES.length + 1) * 2 * 2 * 2);
    expect(refused).toBe(TERMINAL_STATES.length * 2 * 2 * 2);
    expect([...reached].sort()).toEqual(["armed", "empty", "live", "live_dead", "paired", "starting"]);
  });
});
