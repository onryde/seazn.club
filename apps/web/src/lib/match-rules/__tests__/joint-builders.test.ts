// Fix round 1, M6. Three sports edit ONE engine key from SEVERAL form inputs: boardgame's clock (base + increment + delay),
// ice hockey's overtime (on/off + minutes + skaters) and football's shoot-out points (win + loss). The per-field contract
// (`run-contract.ts`) builds each input with an empty form, so it never sees the builder that reads its SIBLINGS. Here the whole
// form goes through `buildRuleOverride` (the producer the division settings use) and the result through the engine's own
// schema (the consumer), and the assertions are on the JOINT values: a sibling dropped by the assembler fails here.
//
// single-sport: each case names the sport whose inputs are joint; no other sport has an input that reads a sibling.
import { describe, expect, it } from "vitest";
import { moduleFor } from "@/lib/rule-scope";
import { buildRuleOverride } from "@/lib/match-rules";

const parse = (sport: string, override: Record<string, unknown>): Record<string, unknown> => {
  const m = moduleFor(sport);
  if (m === null) throw new Error(`no builtin ${sport}`);
  const base = m.configSchema.parse({}) as Record<string, unknown>;
  // What applyFormat does (division-settings.tsx): points are merged key by key, never replaced wholesale.
  const { points, ...rest } = override;
  const merged: Record<string, unknown> = { ...base, ...rest };
  if (points && typeof points === "object") {
    const p = { ...((base.points as Record<string, unknown>) ?? {}), ...(points as Record<string, unknown>) };
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    merged.points = p;
  }
  const r = m.configSchema.safeParse(merged);
  expect(r.success, JSON.stringify(r.success ? null : r.error.issues)).toBe(true);
  return (r as { data: Record<string, unknown> }).data;
};

describe("joint builders — one engine key assembled from several inputs", () => {
  it("boardgame: base minutes, increment and delay are ONE clock, each present only when typed", () => {
    const all = buildRuleOverride("boardgame", { clockBaseMinutes: "15", clockIncrementSeconds: "10", clockDelaySeconds: "5" });
    expect(all.clock).toEqual({ base: 15 * 60, increment: 10, delay: 5 });
    expect(parse("boardgame", all).clock).toMatchObject({ base: 900, increment: 10, delay: 5 });

    // Each sibling alone, so a builder that drops one cannot hide behind the other: the absent one is ABSENT, not 0.
    const incOnly = buildRuleOverride("boardgame", { clockBaseMinutes: "3", clockIncrementSeconds: "2", clockDelaySeconds: "" });
    expect(incOnly.clock).toEqual({ base: 180, increment: 2 });
    const delayOnly = buildRuleOverride("boardgame", { clockBaseMinutes: "3", clockIncrementSeconds: "", clockDelaySeconds: "4" });
    expect(delayOnly.clock).toEqual({ base: 180, delay: 4 });
    expect(parse("boardgame", incOnly).clock).toMatchObject({ base: 180, increment: 2 });
    expect(parse("boardgame", delayOnly).clock).toMatchObject({ base: 180, delay: 4 });

    // No base typed: no clock override at all, whatever the siblings hold (the field's own help says so).
    expect(buildRuleOverride("boardgame", { clockBaseMinutes: "", clockIncrementSeconds: "10", clockDelaySeconds: "5" })).toEqual({});
  });

  it("icehockey: overtime on carries its minutes AND skaters; the engine's defaults fill only what is blank; off is null", () => {
    const both = buildRuleOverride("icehockey", { overtime: "on", overtimeMinutes: "7", overtimeSkaters: "4" });
    expect(both.overtime).toEqual({ kind: "sudden_death", minutes: 7, skaters: 4 });
    expect(parse("icehockey", both).overtime).toMatchObject({ kind: "sudden_death", minutes: 7, skaters: 4 });

    const minutesOnly = buildRuleOverride("icehockey", { overtime: "on", overtimeMinutes: "7", overtimeSkaters: "" });
    expect(minutesOnly.overtime).toMatchObject({ minutes: 7, skaters: 3 });
    const skatersOnly = buildRuleOverride("icehockey", { overtime: "on", overtimeMinutes: "", overtimeSkaters: "4" });
    expect(skatersOnly.overtime).toMatchObject({ minutes: 5, skaters: 4 });
    expect(parse("icehockey", skatersOnly).overtime).toMatchObject({ minutes: 5, skaters: 4 });

    const off = buildRuleOverride("icehockey", { overtime: "off", overtimeMinutes: "7", overtimeSkaters: "4" });
    expect(off.overtime).toBeNull();
    expect(parse("icehockey", off).overtime).toBeNull();
  });

  it("football: the shoot-out win and loss points are a PAIR — both typed lands both, either blank deletes both", () => {
    const both = buildRuleOverride("football", { shootoutWin: "2", shootoutLoss: "1" });
    expect(both.points).toEqual({ shootoutWin: 2, shootoutLoss: 1 });
    expect(parse("football", both).points).toMatchObject({ shootoutWin: 2, shootoutLoss: 1 });

    // A half-typed pair is the half that must NOT land: Number("") is 0, a valid score that would pay a loser nothing.
    for (const half of [{ shootoutWin: "2", shootoutLoss: "" }, { shootoutWin: "", shootoutLoss: "1" }]) {
      const p = buildRuleOverride("football", half).points as Record<string, unknown>;
      expect(Object.keys(p).sort(), "both keys are named, so the merge can delete them").toEqual(["shootoutLoss", "shootoutWin"]);
      expect(p.shootoutWin).toBeUndefined();
      expect(p.shootoutLoss).toBeUndefined();
      const out = parse("football", { points: p }).points as Record<string, unknown>;
      expect(out).not.toHaveProperty("shootoutWin");
      expect(out).not.toHaveProperty("shootoutLoss");
    }
    // Neither input in the form at all: the points object is not touched.
    expect(buildRuleOverride("football", {})).not.toHaveProperty("points");
  });
});
