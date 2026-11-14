// Quick match cricket (owner 2026-11-13 "yes" + 2026-11-14 "why still not cricket in the quick match?"; decision log
// 2026-11-13: QM cricket = fidelity bands 0–1 only, because its detail names players a guest's sides never have). The
// band ceiling a quick match pad scores a sport up to, read off the ENGINE's own pad declarations: the band of the first
// action that cannot be recorded without a named person, less one. Expected values come from the engine's `padSpec`
// (which events sit at which band, which attributions its own schema stamps required), never from the function under test.
import { describe, expect, it } from "vitest";
import type { AnySportModule, FidelityBand, PadSpec } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSport } from "@seazn/engine/testkit";
import { firstNamedPersonBand, personAttributedEvents, QUICK_MATCH_BAND_CAPPED_SPORTS, quickMatchBandCeiling } from "../quick-match-pad";

const modules = builtinModules as readonly AnySportModule[];
const moduleOf = (key: string): AnySportModule => {
  const m = modules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return m;
};
/** Every declared variant's resolved cfg (a band map may differ per cfg); a sport with none, its schema default. */
function cfgsOf(m: AnySportModule): unknown[] {
  const variants = Object.values((m.variants ?? {}) as Record<string, unknown>);
  return variants.length > 0 ? variants.map((v) => m.configSchema.parse(v)) : [m.configSchema.parse({})];
}
const specOf = (m: AnySportModule, cfg: unknown): PadSpec => {
  if (!m.padSpec) throw new Error(`${m.key} declares no padSpec`);
  return m.padSpec(cfg as never);
};
/** Does `action` need a named person: an attribution the engine's own schema stamps required (absent = required). */
const needsPerson = (a: PadSpec["panels"][number]["actions"][number]): boolean =>
  (a.attribution ?? []).some((x) => x.kind === "person" && x.required !== false && x.optional !== true);

describe("firstNamedPersonBand / quickMatchBandCeiling", () => {
  it("the empty cases first: a pad with no actions names nobody; an uncapped sport has no ceiling", () => {
    const empty: PadSpec = { panels: [], fidelity: {} };
    expect(firstNamedPersonBand(empty)).toBeNull();
    expect(quickMatchBandCeiling("badminton", empty)).toBeNull();
    // A capped sport whose pad names nobody has nothing to cap: no ceiling, never a guessed one.
    expect(quickMatchBandCeiling("cricket", empty)).toBeNull();
  });

  it("cricket's ceiling is band 1 on every variant: its band-2 player line and band-3 balls each need a named player", () => {
    // The decision (2026-11-13) as the engine states it: the player line sits at 2 and the ball at 3, each with a person
    // its schema requires; nothing at 0 or 1 requires one.
    const cricket = moduleOf("cricket");
    let checked = 0;
    for (const cfg of cfgsOf(cricket)) {
      const spec = specOf(cricket, cfg);
      expect(spec.fidelity["cricket.player.line"]).toBe(2);
      expect(spec.fidelity["cricket.ball"]).toBe(3);
      expect(spec.fidelity["cricket.innings.summary"]).toBe(0);
      expect(spec.fidelity["cricket.toss"]).toBe(1);
      const actions = spec.panels.flatMap((p) => p.actions);
      expect(actions.some((a) => a.type === "cricket.player.line" && needsPerson(a)), "premise: the line names a player").toBe(true);
      for (const a of actions) {
        const band = spec.fidelity[a.type];
        if (band !== undefined && band <= 1) expect(needsPerson(a), `${a.type} at band ${band}`).toBe(false);
      }
      expect(quickMatchBandCeiling("cricket", spec)).toBe(1);
      checked++;
    }
    expect(checked, "cricket cfgs checked").toBeGreaterThan(1);
  });

  it("across the registry: only a capped sport has a ceiling, and below it no action needs a named person", () => {
    let sports = 0;
    let capped = 0;
    const visited = forEachSport(({ module: m }) => {
      if (!m.padSpec) return;
      for (const cfg of cfgsOf(m)) {
        const spec = specOf(m, cfg);
        const ceiling = quickMatchBandCeiling(m.key, spec);
        if (!QUICK_MATCH_BAND_CAPPED_SPORTS.has(m.key)) {
          expect(ceiling, `${m.key}: not capped`).toBeNull();
          continue;
        }
        expect(ceiling, `${m.key}: capped`).not.toBeNull();
        const at = ceiling as FidelityBand;
        const actions = spec.panels.flatMap((p) => p.actions);
        // Tight: every action at or below the ceiling can be recorded with no name, and the band just above it holds one
        // that cannot (else the ceiling sits lower than the sport needs).
        for (const a of actions) {
          const band = spec.fidelity[a.type];
          if (band !== undefined && band <= at) expect(needsPerson(a), `${m.key} ${a.type}@${band}`).toBe(false);
        }
        expect(actions.some((a) => spec.fidelity[a.type] === at + 1 && needsPerson(a)), `${m.key}: band ${at + 1} names a player`).toBe(true);
        // A result can be recorded under the ceiling: the sport declares a band-0 action.
        expect(actions.some((a) => spec.fidelity[a.type] === 0), `${m.key}: a band-0 result action`).toBe(true);
        capped++;
      }
      sports++;
    }, modules);
    expect(visited, "sports visited").toBeGreaterThan(0);
    expect(sports).toBeGreaterThan(0);
    expect(capped, "capped cfgs checked").toBeGreaterThan(0);
  });

  it("a capped sport whose very first band names a player cannot be scored by a guest: refused, never a ceiling of -1", () => {
    const spec: PadSpec = {
      panels: [{ phase: "live", layout: "grid", actions: [{ type: "x.result", labelKey: { key: "k", label: "l" }, attribution: [{ kind: "person", path: "p" }] }] }],
      fidelity: { "x.result": 0 },
    } as unknown as PadSpec;
    expect(firstNamedPersonBand(spec)).toBe(0);
    expect(() => quickMatchBandCeiling("cricket", spec)).toThrow(/band 0/);
  });
});

// Sign-off 2026-11-14 (controller, PO rec): the guest's cricket pad still drew a Review tile. A review is about a player
// (which batter, which bowler: the engine stamps both as optional person attributions), so it sits at band 1 and the cap
// alone keeps it. The actions a quick match pad leaves out are read off the engine the same way: any person attribution.
describe("personAttributedEvents: the actions about a player, required or optional", () => {
  it("the empty case: a pad with no actions has none", () => {
    expect(personAttributedEvents({ panels: [], fidelity: {} }).size).toBe(0);
  });

  it("cricket, every variant: the review is one though it needs nobody; the result, the toss and the close are not", () => {
    const cricket = moduleOf("cricket");
    let checked = 0;
    for (const cfg of cfgsOf(cricket)) {
      const spec = specOf(cricket, cfg);
      const actions = spec.panels.flatMap((p) => p.actions);
      const review = actions.find((a) => a.type === "cricket.review");
      // Premise, from the engine: the review attributes people, requires none, and sits under the guest's ceiling, so
      // the band cap alone would keep its tile on the guest's pad.
      expect(review?.attribution?.some((x) => x.kind === "person"), "premise: the review attributes a person").toBe(true);
      expect(needsPerson(review!), "premise: the review needs no named person").toBe(false);
      expect(spec.fidelity["cricket.review"]!).toBeLessThanOrEqual(quickMatchBandCeiling("cricket", spec)!);
      const about = personAttributedEvents(spec);
      expect(about.has("cricket.review")).toBe(true);
      for (const type of ["cricket.innings.summary", "cricket.innings.close", "cricket.toss"]) {
        expect(about.has(type), type).toBe(false);
      }
      // The ball and the player line name a player too (required): above the ceiling already, and in the set.
      expect(about.has("cricket.ball")).toBe(true);
      expect(about.has("cricket.player.line")).toBe(true);
      checked++;
    }
    expect(checked, "cricket cfgs checked").toBeGreaterThan(1);
  });
});
