// Capture QR v2 PR-2 T2 (spec §7.4 the phone-health line, W8 and W9; §6.10's history flags; FP14, FP21). ONE derivation
// feeds both the panel's amber line and the history `flags`, so the two cannot disagree.
//
// The priority order is read out of the spec's own numbered list, the thresholds come from config.ts's declarations
// (themselves pinned to the spec by config.test.ts), and the history flag ORDER is the pre-T2 `flagsOf` output order that
// capture-beat.test.ts pins end to end through the database.
//
// ONE SPORT, on purpose (TEST-STRATEGY rule 6): the inputs are a phone's own readings; no sport is involved.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOT_THERMAL_STATUS, LOW_BATTERY_PERCENT } from "../../config";
import { HEALTH_REASONS, phoneFlagsOf, phoneHealthOf, type HealthInput, type HealthReason } from "../phone-health";

const SPEC = readFileSync(resolve(import.meta.dirname, "../../../../../../../docs/superpowers/specs/2026-10-01-capture-qr-v2-design.md"), "utf8");

/** §7.4's "Amber, … in priority order" list: `1. **not responding**: …` → `not_responding`. */
const SPEC_PRIORITY: string[] = (SPEC.split("**Amber,**")[1]?.split("**Other parts of the line:**")[0] ?? "")
  .split("\n")
  .map((l) => /^\d+\. \*\*([a-z ]+)\*\*/.exec(l.trim())?.[1]?.replace(/ /g, "_"))
  .filter((n): n is string => n !== undefined);

/** A phone with nothing wrong: responding, delivering, cool, and charged. */
const BENIGN: HealthInput = { notResponding: false, delivery: "ok", thermal: 0, battery: { percent: 80, charging: false } };
/** What makes each reason apply on its own. Typed `Record<HealthReason, …>` so a new reason cannot go untested. */
const APPLY: Record<HealthReason, Partial<HealthInput>> = {
  not_responding: { notResponding: true },
  stalled: { delivery: "stalled" },
  hot: { thermal: HOT_THERMAL_STATUS },
  battery_low: { battery: { percent: LOW_BATTERY_PERCENT - 1, charging: false } },
};

describe("phoneHealthOf — the amber line's one reason (§7.4)", () => {
  it("the priority is the spec's numbered list: not responding, stalled, hot, battery low (anti-vacuity: four read)", () => {
    expect(SPEC_PRIORITY.length).toBe(4);
    expect([...HEALTH_REASONS]).toEqual(SPEC_PRIORITY);
    expect(Object.keys(APPLY).sort()).toEqual([...HEALTH_REASONS].sort());
  });

  it("a phone with nothing wrong is null (the positive pair for every case below)", () => {
    expect(phoneHealthOf(BENIGN)).toBeNull();
  });

  it("each reason alone is that reason", () => {
    let checked = 0;
    for (const reason of HEALTH_REASONS) {
      expect(phoneHealthOf({ ...BENIGN, ...APPLY[reason] }), reason).toBe(reason);
      checked++;
    }
    expect(checked).toBe(HEALTH_REASONS.length);
    expect(checked).toBe(4);
  });

  it("every pair in priority order: the earlier reason wins (6 pairs), and all four at once is the first", () => {
    let checked = 0;
    for (let i = 0; i < HEALTH_REASONS.length; i++) {
      for (let j = i + 1; j < HEALTH_REASONS.length; j++) {
        const [first, later] = [HEALTH_REASONS[i]!, HEALTH_REASONS[j]!];
        expect(phoneHealthOf({ ...BENIGN, ...APPLY[first], ...APPLY[later] }), `${first} beats ${later}`).toBe(first);
        checked++;
      }
    }
    expect(checked).toBe(6);
    const everything = HEALTH_REASONS.reduce<HealthInput>((acc, r) => ({ ...acc, ...APPLY[r] }), BENIGN);
    expect(phoneHealthOf(everything)).toBe(HEALTH_REASONS[0]);
  });

  it("battery low is percent < LOW_BATTERY_PERCENT and not charging: 19 is low, 20 is not, a charging 5 is not", () => {
    const battery = (percent: number, charging: boolean) => phoneHealthOf({ ...BENIGN, battery: { percent, charging } });
    expect(battery(LOW_BATTERY_PERCENT - 1, false)).toBe("battery_low");
    expect(battery(LOW_BATTERY_PERCENT, false)).toBeNull();
    expect(battery(LOW_BATTERY_PERCENT + 1, false)).toBeNull();
    expect(battery(5, true)).toBeNull();
    expect(battery(0, false)).toBe("battery_low");
    expect(battery(0, true)).toBeNull();
  });

  it("hot is thermal >= HOT_THERMAL_STATUS: one below is not, the threshold and one above are", () => {
    const thermal = (n: number) => phoneHealthOf({ ...BENIGN, thermal: n });
    expect(thermal(HOT_THERMAL_STATUS - 1)).toBeNull();
    expect(thermal(HOT_THERMAL_STATUS)).toBe("hot");
    expect(thermal(HOT_THERMAL_STATUS + 1)).toBe("hot");
    expect(thermal(0)).toBeNull();   // a real 0 is "nominal", not "absent"
  });

  it("stalled is delivery 'stalled' only: ok and unknown are not", () => {
    expect(phoneHealthOf({ ...BENIGN, delivery: "stalled" })).toBe("stalled");
    expect(phoneHealthOf({ ...BENIGN, delivery: "ok" })).toBeNull();
    expect(phoneHealthOf({ ...BENIGN, delivery: "unknown" })).toBeNull();
  });

  // FP14: battery and thermal are null through the whole Paired phase, delivery before the first reading. A null part
  // contributes nothing — and it must not hide a part that IS reported.
  it("a null battery, thermal or delivery contributes nothing; the other reasons still show (FP14)", () => {
    let checked = 0;
    for (const patch of [{ battery: null }, { thermal: null }, { delivery: null }, { battery: null, thermal: null, delivery: null }] as Partial<HealthInput>[]) {
      expect(phoneHealthOf({ ...BENIGN, ...patch }), JSON.stringify(patch)).toBeNull();
      checked++;
    }
    expect(checked).toBe(4);
    const allNull: Partial<HealthInput> = { battery: null, thermal: null, delivery: null };
    for (const reason of HEALTH_REASONS) {
      const present = phoneHealthOf({ ...BENIGN, ...allNull, ...APPLY[reason] });
      // each reason reported while the OTHER readings are null still shows
      expect(present, `${reason} with the others null`).toBe(reason);
    }
  });

  it("not responding needs no reading at all: a phone silent from Paired (everything null) is still not responding", () => {
    expect(phoneHealthOf({ notResponding: true, delivery: null, thermal: null, battery: null })).toBe("not_responding");
    expect(phoneHealthOf({ notResponding: false, delivery: null, thermal: null, battery: null })).toBeNull();
  });
});

// ---- the history flags ---------------------------------------------------------------------------------------------
/** The pre-T2 `flagsOf` output order (capture-phone.ts, pinned through the database by capture-beat.test.ts). */
const FLAG_ORDER = ["battery_low", "hot", "stalled", "not_ready", "not_responding"] as const;
type Flag = (typeof FLAG_ORDER)[number];
/** What makes each flag apply, the five inputs the old function read. */
const FLAG_PATCH: Record<Flag, Partial<HealthInput & { notReady: boolean }>> = {
  battery_low: APPLY.battery_low, hot: APPLY.hot, stalled: APPLY.stalled, not_responding: APPLY.not_responding,
  not_ready: { notReady: true },
};

describe("phoneFlagsOf — the history flags (§6.10), unchanged by the move", () => {
  it("all 2^5 combinations of the five conditions yield exactly the flags that apply, in the old order (32 checked)", () => {
    let checked = 0;
    for (let mask = 0; mask < 1 << FLAG_ORDER.length; mask++) {
      const on = FLAG_ORDER.filter((_, bit) => (mask & (1 << bit)) !== 0);
      const input = on.reduce<HealthInput & { notReady: boolean }>((acc, f) => ({ ...acc, ...FLAG_PATCH[f] }), { ...BENIGN, notReady: false });
      expect(phoneFlagsOf(input), `mask ${mask}: ${on.join("+") || "none"}`).toEqual(on);
      checked++;
    }
    expect(checked).toBe(32);
  });

  it("the panel and the history cannot disagree: over all 32 combinations phoneHealthOf is the first priority reason among the flags phoneFlagsOf carries", () => {
    let checked = 0;
    let named = 0;
    for (let mask = 0; mask < 1 << FLAG_ORDER.length; mask++) {
      const on = FLAG_ORDER.filter((_, bit) => (mask & (1 << bit)) !== 0);
      const input = on.reduce<HealthInput & { notReady: boolean }>((acc, f) => ({ ...acc, ...FLAG_PATCH[f] }), { ...BENIGN, notReady: false });
      // expected from the MASK, not from either function: the first spec-priority reason whose condition is switched on
      const expected = SPEC_PRIORITY.find((r) => (on as readonly string[]).includes(r)) ?? null;
      expect(phoneHealthOf(input), `mask ${mask}: ${on.join("+") || "none"}`).toBe(expected);
      if (expected !== null) {
        expect(phoneFlagsOf(input), `mask ${mask}`).toContain(expected);
        named++;
      }
      checked++;
    }
    expect(checked).toBe(32);
    expect(named).toBe(30);   // every combination except the two with none of the four amber conditions (notReady alone or not)
  });

  it("null readings contribute no flag (FP14); notReady alone is a flag but never an amber reason", () => {
    expect(phoneFlagsOf({ notResponding: false, delivery: null, thermal: null, battery: null, notReady: false })).toEqual([]);
    expect(phoneFlagsOf({ notResponding: false, delivery: null, thermal: null, battery: null, notReady: true })).toEqual(["not_ready"]);
    expect(phoneHealthOf({ ...BENIGN })).toBeNull();
  });

  it("a charging low battery and a one-below-hot thermal raise nothing in the history either", () => {
    expect(phoneFlagsOf({ ...BENIGN, battery: { percent: LOW_BATTERY_PERCENT - 1, charging: true }, thermal: HOT_THERMAL_STATUS - 1, notReady: false })).toEqual([]);
    expect(phoneFlagsOf({ ...BENIGN, battery: { percent: LOW_BATTERY_PERCENT, charging: false }, notReady: false })).toEqual([]);
  });
});
