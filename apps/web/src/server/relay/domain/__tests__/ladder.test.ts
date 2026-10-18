// domain/ladder.ts — the compositor's degrade-ladder rungs on the wire, and the sizing alarm's decision.
//
// The rungs are typed HERE from the compositor's declaration (seazn.club.compositor `crates/domain/src/ladder.rs`
// `Rung { Full, OverlayHalfRate }`, snake_case on the wire, C07 `heartbeat_wire`), never read off the module. The owner
// removed the third rung on 2026-10-18 (compositor `docs/_INDEX.md` Owed 20): the score is never taken off air, so the
// ladder is `full → overlay_half_rate` and the bottom holds. Any step down in production is a SIZING alarm: the Machine
// is short of CPU, and ops raise its size (compositor C17 runbook).
//
// The alarm fires on ENTRY to a stepped rung, never on every beat (a match runs ~2 000 beats): the transition table
// below is the whole rule, swept over every previous × current a beat can carry — the declared rungs, an unreported one
// (absent, null), and a stored word this build no longer declares (a beat kept from before the removal).
//
// Pure — no DB, no sport (the relay is sport-agnostic; nothing here reads one).
import { describe, expect, it } from "vitest";
import { LADDER_RUNGS, type LadderRung, steppedDownTo } from "../ladder";

/** The compositor's `Rung`, top first (C05, as amended by the owner 2026-10-18). */
const COMPOSITOR_RUNGS = ["full", "overlay_half_rate"];
/** The word the 2026-10-18 ruling retired: the old third rung, whose only meaning was "drop the overlay entirely". */
const RETIRED = "fast_preset";

describe("the ladder's rungs on the wire", () => {
  it("are exactly the compositor's, top first: full, then overlay_half_rate, which is the bottom", () => {
    expect([...LADDER_RUNGS]).toEqual(COMPOSITOR_RUNGS);
    expect(LADDER_RUNGS[0], "the top: nothing stepped").toBe("full");
    expect(LADDER_RUNGS.at(-1), "the bottom keeps the score on air").toBe("overlay_half_rate");
    expect(LADDER_RUNGS as readonly string[], "the retired rung is gone").not.toContain(RETIRED);
  });
});

describe("the sizing alarm fires once per step down, never on every beat", () => {
  it("the sequence a match produces: full, a step, the same rung again, a climb, a second step, an unreported beat, a third", () => {
    // Each pair is (the previous beat's stored rung, this beat's rung) → what the alarm names. `undefined` is a first
    // beat (no previous body) or a beat that omitted the field.
    const sequence: [previous: unknown, current: LadderRung | null | undefined, alarm: LadderRung | null][] = [
      [undefined, "full", null],                                  // the first beat, on the top rung
      ["full", "full", null],                                     // a second call on the top rung
      ["full", "overlay_half_rate", "overlay_half_rate"],         // THE step down: the alarm
      ["overlay_half_rate", "overlay_half_rate", null],           // the bottom holds: no second alarm for one step
      ["overlay_half_rate", "full", null],                        // a climb back is not an alarm (R2 never climbs; web does not assume it)
      ["full", "overlay_half_rate", "overlay_half_rate"],         // a second step after a climb is a second alarm
      ["overlay_half_rate", undefined, null],                     // an unreported rung alarms nothing
      [undefined, "overlay_half_rate", "overlay_half_rate"],      // after it, the rung is unknown: alarm again (never miss one)
      [null, "overlay_half_rate", "overlay_half_rate"],           // null is unreported too
      [RETIRED, "overlay_half_rate", "overlay_half_rate"],        // a stored retired word is not this rung
    ];
    let fired = 0;
    for (const [previous, current, alarm] of sequence) {
      expect(steppedDownTo(previous, current), `${String(previous)} → ${String(current)}`).toBe(alarm);
      fired += alarm === null ? 0 : 1;
    }
    expect(fired, "the sequence names five alarms: two steps, then three after an unknown previous rung").toBe(5);
  });

  it("swept over every previous × current: it names the current rung exactly when that rung is below the top and the previous beat was not already on it (counted)", () => {
    const previous: unknown[] = [...COMPOSITOR_RUNGS, null, undefined, RETIRED, 0, { rung: "overlay_half_rate" }];
    const current: (LadderRung | null | undefined)[] = [...(COMPOSITOR_RUNGS as LadderRung[]), null, undefined];
    let checked = 0, fired = 0, quiet = 0;
    for (const p of previous) {
      for (const c of current) {
        // The rule, from the ruling: a step DOWN is any rung below the compositor's top; an alarm is the ENTRY to one.
        const below = typeof c === "string" && COMPOSITOR_RUNGS.indexOf(c) > 0;
        const want = below && p !== c ? c : null;
        expect(steppedDownTo(p, c), `${JSON.stringify(p) ?? "undefined"} → ${String(c)}`).toBe(want);
        checked++;
        if (want === null) quiet++; else fired++;
      }
    }
    console.log(`sizing-alarm transitions checked: ${checked} (${fired} alarm, ${quiet} quiet)`);
    expect(checked, "every previous × current").toBe(previous.length * current.length);
    expect(fired, "anti-vacuity: the sweep reached an alarm").toBeGreaterThan(0);
    expect(quiet, "anti-vacuity: the sweep reached a quiet beat").toBeGreaterThan(0);
  });
});
