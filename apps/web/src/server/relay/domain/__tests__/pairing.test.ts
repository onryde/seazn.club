// Capture QR v2 §5.2, §5.5 (T1–T8), §6.5 (A14's clock) and §6.9 (present / silent / not responding) —
// domain/pairing.ts. Pure: `now` is passed in. Every threshold below is computed from the declared constants, so a
// change to config.ts moves these tests with it (AGENTS.md #19).
import { describe, expect, it } from "vitest";
import {
  DEAD_PHONE_TAKEOVER_SECONDS, NOT_RESPONDING_BEATS, PHONE_SILENT_FLOOR_SECONDS, PHONE_SILENT_SLACK_SECONDS,
  POLL_FAR_SECONDS, POLL_NEAR_SECONDS, POLL_STARTING_SECONDS,
} from "../../config";
import { type ClaimInput, type ClaimOutcome, decideClaim, deadForTakeover, isNotResponding, isPresent, isSilent } from "../pairing";
import type { SlotState } from "../slot";

const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const S = 1000;
const ME = "phone-aaaaaaaaaaaaaaaa";
const OTHER = "phone-bbbbbbbbbbbbbbbb";
const SLOTS: readonly SlotState[] = ["empty", "paired", "starting", "armed", "live", "live_dead"];
const CADENCES = [POLL_STARTING_SECONDS, POLL_NEAR_SECONDS, POLL_FAR_SECONDS] as const;

const claim = (kind: ClaimInput["kind"], current: "none" | "me" | "other", slot: SlotState): ClaimOutcome =>
  decideClaim({ kind, caller: ME, current: current === "none" ? null : { phone: current === "me" ? ME : OTHER }, slot });

describe("decideClaim — T1–T8, first row that applies wins", () => {
  it("the empty case first: a `new` claim on an empty slot (no current phone) is accepted by T1", () => {
    expect(claim("new", "none", "empty")).toEqual({ result: "accept", row: "T1" });
  });

  it("T1: `new` from the current phone is accepted in every slot state — process death is not a takeover, even live", () => {
    for (const slot of SLOTS) expect(claim("new", "me", slot), slot).toEqual({ result: "accept", row: "T1" });
  });

  it("T1: `new` with no current phone is accepted whatever the session (T19: starting or armed with no current pairing)", () => {
    for (const slot of ["starting", "armed"] as const) expect(claim("new", "none", slot), slot).toEqual({ result: "accept", row: "T1" });
  });

  it("T2: `new` from another phone takes over a paired, starting or armed slot", () => {
    for (const slot of ["paired", "starting", "armed"] as const) {
      expect(claim("new", "other", slot), slot).toEqual({ result: "takeover", row: "T2" });
    }
  });

  it("T3: `new` from another phone on a live slot whose phone is not dead is refused — taken", () => {
    expect(claim("new", "other", "live")).toEqual({ result: "taken", row: "T3" });
  });

  it("T4: `new` from another phone on a live·dead slot takes over (A14)", () => {
    expect(claim("new", "other", "live_dead")).toEqual({ result: "takeover", row: "T4" });
  });

  it("T5: `resume` from the current phone, or for a slot with NO current phone, is accepted — ask 2, even for a phone once replaced", () => {
    expect(claim("resume", "me", "live")).toEqual({ result: "accept", row: "T5" });
    // ME was replaced earlier (that pairing is ENDED): the slot has no current phone now, so its resume is accepted.
    for (const slot of SLOTS) expect(claim("resume", "none", slot), slot).toEqual({ result: "accept", row: "T5" });
  });

  it("T6: resume from a phone that is not current — replaced, in every slot state (resume never steals, not even a dead live slot)", () => {
    for (const slot of SLOTS) expect(claim("resume", "other", slot), slot).toEqual({ result: "replaced", row: "T6" });
  });

  it("T7: a beat with no claim from a phone that is not current — replaced (and with no current phone at all)", () => {
    expect(claim(null, "other", "live")).toEqual({ result: "replaced", row: "T7" });
    expect(claim(null, "none", "empty")).toEqual({ result: "replaced", row: "T7" });
  });

  it("T8: a beat from the current phone — none (the latest beat is stored; nothing about the pairing changes)", () => {
    for (const slot of SLOTS) expect(claim(null, "me", slot), slot).toEqual({ result: "none", row: "T8" });
  });

  it("every (kind × current × slot) input: the spec's invariants hold, and all eight rows are reached", () => {
    const rows = new Set<ClaimOutcome["row"]>();
    let checked = 0;
    for (const kind of ["new", "resume", null] as const) {
      for (const current of ["none", "me", "other"] as const) {
        for (const slot of SLOTS) {
          const o = claim(kind, current, slot);
          rows.add(o.row);
          checked++;
          if (kind === "resume") expect(o.result, "resume never steals").not.toBe("takeover");
          if (kind === null) expect(["none", "replaced"], "a beat with no claim never claims").toContain(o.result);
          if (current === "other") expect(o.result, "another phone is never simply accepted").not.toBe("accept");
          if (o.result === "taken") expect(slot, "taken only on a live slot that is not dead").toBe("live");
          if (o.result === "takeover") expect(current, "a takeover displaces ANOTHER phone").toBe("other");
        }
      }
    }
    expect(checked).toBe(3 * 3 * SLOTS.length);
    expect([...rows].sort()).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]);
  });
});

describe("deadForTakeover — A14's three conjuncts (§6.5)", () => {
  const DEAD_MS = DEAD_PHONE_TAKEOVER_SECONDS * S;
  const dead = { lastBeatAt: ago(DEAD_MS), freshReadConnected: false, lastConnectedAt: ago(DEAD_MS), liveSince: ago(DEAD_MS * 5) };

  it("all three hold → dead, at the boundary exactly", () => {
    expect(deadForTakeover(dead, NOW)).toBe(true);
  });

  it("conjunct 1 fails alone: a beat inside the window (1 ms short) — not dead", () => {
    expect(deadForTakeover({ ...dead, lastBeatAt: ago(DEAD_MS - 1) }, NOW)).toBe(false);
  });

  it("conjunct 2 fails alone: a fresh Cloudflare read says the input IS connected — not dead (the phone still pushes video)", () => {
    expect(deadForTakeover({ ...dead, freshReadConnected: true }, NOW)).toBe(false);
  });

  it("conjunct 3 fails alone: a poll sample read connected inside the window (1 ms short) — not dead", () => {
    expect(deadForTakeover({ ...dead, lastConnectedAt: ago(DEAD_MS - 1) }, NOW)).toBe(false);
  });

  it("no connected sample at all: the clock runs from liveSince (first ingest), as §6.8.5 words it", () => {
    expect(deadForTakeover({ ...dead, lastConnectedAt: null, liveSince: ago(DEAD_MS - 1) }, NOW)).toBe(false);
    expect(deadForTakeover({ ...dead, lastConnectedAt: null, liveSince: ago(DEAD_MS) }, NOW)).toBe(true);
  });

  it("the window is a parameter, so tunable() can shorten it (§6.15): at 3 s, a phone silent 3 s is dead", () => {
    const short = { lastBeatAt: ago(3 * S), freshReadConnected: false, lastConnectedAt: ago(3 * S), liveSince: ago(3 * S) };
    expect(deadForTakeover(short, NOW)).toBe(false);
    expect(deadForTakeover(short, NOW, 3)).toBe(true);
  });
});

describe("isSilent / isPresent / isNotResponding (§6.9)", () => {
  const silentAfter = (c: number): number => Math.max(PHONE_SILENT_FLOOR_SECONDS, c + PHONE_SILENT_SLACK_SECONDS) * S;

  it("silent at the boundary for each answered cadence: 1 ms short is not silent, the threshold exactly is", () => {
    let checked = 0;
    for (const c of CADENCES) {
      expect(isSilent(ago(silentAfter(c) - 1), c, NOW), `${c}s: 1 ms short`).toBe(false);
      expect(isSilent(ago(silentAfter(c)), c, NOW), `${c}s: at the threshold`).toBe(true);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("ordering differential: 60 s without a beat is silent on a 10 s cadence but NOT on a 60 s one (not yet due)", () => {
    expect(isSilent(ago(60 * S), POLL_NEAR_SECONDS, NOW)).toBe(true);
    expect(isSilent(ago(60 * S), POLL_FAR_SECONDS, NOW)).toBe(false);
  });

  it("the floor is a parameter, so tunable() can shorten it; the slack is not (plan R10)", () => {
    expect(isSilent(ago(10 * S), POLL_STARTING_SECONDS, NOW, 5)).toBe(false);       // max(5, 5 + slack) = 5 + slack
    expect(isSilent(ago((POLL_STARTING_SECONDS + PHONE_SILENT_SLACK_SECONDS) * S), POLL_STARTING_SECONDS, NOW, 5)).toBe(true);
  });

  it("present = current AND not silent, at each cadence's boundary", () => {
    let checked = 0;
    for (const c of CADENCES) {
      expect(isPresent({ current: true, lastBeatAt: ago(silentAfter(c) - 1), answeredPoll: c }, NOW), `${c}s fresh`).toBe(true);
      expect(isPresent({ current: true, lastBeatAt: ago(silentAfter(c)), answeredPoll: c }, NOW), `${c}s silent`).toBe(false);
      expect(isPresent({ current: false, lastBeatAt: NOW, answeredPoll: c }, NOW), `${c}s not current`).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it(`not responding = held AND ${NOT_RESPONDING_BEATS} × the answered cadence without a beat, at each cadence's boundary`, () => {
    let checked = 0;
    for (const c of CADENCES) {
      const at = NOT_RESPONDING_BEATS * c * S;
      expect(isNotResponding({ held: true, lastBeatAt: ago(at - 1), answeredPoll: c }, NOW), `${c}s short`).toBe(false);
      expect(isNotResponding({ held: true, lastBeatAt: ago(at), answeredPoll: c }, NOW), `${c}s at`).toBe(true);
      expect(isNotResponding({ held: false, lastBeatAt: ago(at * 10), answeredPoll: c }, NOW), `${c}s not held`).toBe(false);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("an answered cadence that is not a positive number is refused by name, never read as instantly silent", () => {
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => isSilent(NOW, bad, NOW), String(bad)).toThrow(/answeredPoll/);
      expect(() => isNotResponding({ held: true, lastBeatAt: NOW, answeredPoll: bad }, NOW), String(bad)).toThrow(/answeredPoll/);
    }
  });
});
