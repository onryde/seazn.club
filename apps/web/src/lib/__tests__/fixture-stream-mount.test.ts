// Spec 2026-09-30 §2 — the fixture page's Stream gate and the console's one-open-panel rule. Pure, so every row of both
// tables is pinned here; the console and page tests pin the wiring.
import { describe, expect, it } from "vitest";
import { fixtureStreamMode, nextOpenPanel, streamButtonState, type OpenPanel } from "../fixture-stream-mount";
import { OUTPUT_WARNING_AFTER_MS } from "../stream-session-view";
import { StreamOutput, StreamSessionState } from "@/server/api-v1/schemas";
import { TERMINAL_STATES } from "@/server/relay/domain/session";

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

// Spec 2026-09-30 §2 (T9b): the Stream button's dot and label. Expectations restate §2's sentence — "no dot when idle;
// amber while provisioning or warming, or during the D3 warning; red while live; its label is 'Stream', or 'Live' while
// live" — never the function. `ending` is a PLAN decision (§2 names no dot for it): amber "Stream", still up, not live.
// No clock argument: D3's 30 s is the SERVER's `elapsedMs` (M6), so the button and the chain read one measure.
describe("streamButtonState — the Stream button's dot and label (spec §2)", () => {
  const W = OUTPUT_WARNING_AFTER_MS;
  const view = (state: string, output: { state: string; elapsedMs: number } | null = null) =>
    ({ state, output: output ? { ...output, since: "2026-09-30T12:00:00.000Z" } : null }) as never;

  it("no dot while idle or over; amber while requested/provisioning/warming; red while live; label 'Live' only while live", () => {
    expect(streamButtonState(null)).toEqual({ dot: null, labelKey: "stream.button" });
    let checked = 0;
    for (const s of ["requested", "provisioning", "warming"]) {
      expect(streamButtonState(view(s)), s).toEqual({ dot: "amber", labelKey: "stream.button" });
      checked++;
    }
    for (const s of TERMINAL_STATES) {
      expect(streamButtonState(view(s)), s).toEqual({ dot: null, labelKey: "stream.button" });
      checked++;
    }
    expect(streamButtonState(view("live", { state: "ok", elapsedMs: 0 }))).toEqual({ dot: "red", labelKey: "stream.buttonLive" });
    expect(checked).toBe(3 + TERMINAL_STATES.length);
    expect(TERMINAL_STATES.length, "anti-vacuity: the declared terminal set is not empty").toBeGreaterThan(0);
  });

  it("D3 turns the live dot AMBER at the warning threshold, and not before — the label stays 'Live'", () => {
    const at = (ms: number) => streamButtonState(view("live", { state: "connecting", elapsedMs: ms }));
    expect(at(W - 1)).toEqual({ dot: "red", labelKey: "stream.buttonLive" });
    expect(at(W)).toEqual({ dot: "amber", labelKey: "stream.buttonLive" });
  });

  it("I-1: the phone box is a D3 warning too — the dot is amber whichever way the box points, and red under the hold", () => {
    const silent = (ms: number, out: string) =>
      streamButtonState({ state: "live", ingest: { state: "disconnected", protocol: null }, output: { state: out, since: "2026-09-30T12:00:00.000Z", elapsedMs: ms } } as never);
    expect(silent(W, "unknown")).toEqual({ dot: "amber", labelKey: "stream.buttonLive" });
    expect(silent(W - 1, "unknown")).toEqual({ dot: "red", labelKey: "stream.buttonLive" });
    expect(silent(W, "ok"), "a silent phone with the destination still ok: no box, no amber").toEqual({ dot: "red", labelKey: "stream.buttonLive" });
  });

  it("ending: amber, labelled Stream (the session is still up, but no longer live)", () => {
    expect(streamButtonState(view("ending"))).toEqual({ dot: "amber", labelKey: "stream.button" });
  });

  it("the whole table: every wire state × every output (none included) × elapsed either side of 30 s", () => {
    const outputs: ({ state: string } | null)[] = [null, ...StreamOutput.shape.state.options.map((state) => ({ state }))];
    let checked = 0;
    let amberLive = 0;
    for (const state of StreamSessionState.options) for (const out of outputs) for (const ms of [0, W - 1, W, 10 * W]) {
      const got = streamButtonState(view(state, out ? { state: out.state, elapsedMs: ms } : null));
      // §2 restated: live → "Live", red unless the destination has been not-ok for 30 s or more (D3); up but not live
      // (requested, provisioning, warming, ending) → amber "Stream"; over → nothing.
      const d3 = state === "live" && out !== null && out.state !== "ok" && ms >= W;
      const want =
        state === "live"
          ? { dot: d3 ? "amber" : "red", labelKey: "stream.buttonLive" }
          : state === "completed" || state === "failed"
            ? { dot: null, labelKey: "stream.button" }
            : { dot: "amber", labelKey: "stream.button" };
      expect(got, `${state} ${out?.state ?? "none"} ${ms}`).toEqual(want);
      if (d3) amberLive++;
      checked++;
    }
    expect(checked).toBe(StreamSessionState.options.length * outputs.length * 4);
    expect(amberLive, "anti-vacuity: D3 rows were reached").toBeGreaterThan(0);
  });
});
