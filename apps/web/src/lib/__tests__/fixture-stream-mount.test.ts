// Spec 2026-09-30 §2 — the fixture page's Stream gate and the console's one-open-panel rule. Pure, so every row of both
// tables is pinned here; the console and page tests pin the wiring.
import { describe, expect, it } from "vitest";
import { fixtureStreamMode, nextOpenPanel, type OpenPanel } from "../fixture-stream-mount";

describe("fixtureStreamMode — who sees Stream on the fixture page (spec §2)", () => {
  it("the whole 16-row truth table: never without page canEdit; the panel only when entitled and not frozen; otherwise Stop-only while a session is up", () => {
    let checked = 0;
    for (const canEdit of [false, true]) for (const entitled of [false, true]) for (const frozen of [false, true]) for (const activeSession of [false, true]) {
      const got = fixtureStreamMode({ canEdit, entitled, frozen, activeSession });
      // An independent restatement of spec §2's sentence, not a copy of the function.
      const want = !canEdit ? null : entitled && !frozen ? "panel" : activeSession ? "stop-only" : null;
      expect(got, JSON.stringify({ canEdit, entitled, frozen, activeSession })).toBe(want);
      checked++;
    }
    expect(checked).toBe(16);
  });

  it("Stop is ALWAYS reachable for an organiser with a session up — every entitled/frozen combination", () => {
    let checked = 0;
    for (const entitled of [false, true]) for (const frozen of [false, true]) {
      expect(fixtureStreamMode({ canEdit: true, entitled, frozen, activeSession: true })).not.toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the empty case: an organiser on an unentitled org with nothing on air sees no Stream at all", () => {
    expect(fixtureStreamMode({ canEdit: true, entitled: false, frozen: false, activeSession: false })).toBeNull();
    // …and a viewer who cannot edit never does, whatever is on air (the organisers-only gate).
    expect(fixtureStreamMode({ canEdit: false, entitled: true, frozen: false, activeSession: true })).toBeNull();
  });
});

describe("nextOpenPanel — one panel open at a time (spec §2)", () => {
  it("opening one closes the other; tapping the open one closes it; every (current, clicked) pair", () => {
    const table: [OpenPanel, "handover" | "stream", OpenPanel][] = [
      [null, "handover", "handover"], [null, "stream", "stream"],
      ["handover", "handover", null], ["handover", "stream", "stream"],
      ["stream", "stream", null], ["stream", "handover", "handover"],
    ];
    for (const [cur, clicked, want] of table) expect(nextOpenPanel(cur, clicked), `${cur}+${clicked}`).toBe(want);
    expect(table).toHaveLength(6);
  });
});
