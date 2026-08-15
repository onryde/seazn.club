// Task 3 (R1 chassis): ribbon copy builder. R1 ships the FALLBACK path only
// — no per-sport `pad.<sport>.ribbon.<suffix>` dictionary copy exists yet
// (that lands with each conversion wave, R2+), so `buildRibbon`'s fallback
// branch is what real traffic exercises today. See
// .superpowers/sdd/2026-08-15-scorepad-v3-r1-chassis/task-3-brief.md.
//
// Fix round 1 (review findings 1-2) adds two things a single fallback-only
// test couldn't prove:
//   - `ribbonKeyFor`'s sport/suffix split for a multi-dot event type,
//     asserted directly and independent of PAD_LABEL_KEYS membership.
//   - the per-sport lookup (hit) branch, which no REAL PAD_LABEL_KEYS entry
//     exercises yet (no ribbon key is registered there in R1) — mocking
//     `@/lib/scoring-vocab` is the only way to reach it without registering
//     a real key, which is out of this task's scope.
import { describe, it, expect, vi } from "vitest";
import { buildRibbon, ribbonKeyFor, type MsgFn } from "../ribbon";

vi.mock("@/lib/scoring-vocab", () => ({
  PAD_LABEL_KEYS: ["pad.cricket.ribbon.wicket"],
  padLabel: (key: string, m: (k: string) => string, engineLabel: string) =>
    key === "pad.cricket.ribbon.wicket" ? m(key) : engineLabel,
}));

const t: MsgFn = (k, v) => (k === "pad.ribbon.fallback" ? `${v!.event} recorded` : k);

describe("buildRibbon", () => {
  it("falls back to the generic ribbon with the vocab'd event name", () => {
    const r = buildRibbon("football.goal", { side: "home" }, () => "?", t);
    expect(r).toEqual({ text: "football.goal recorded", undoable: true });
  });

  it("takes the per-sport lookup branch when the key is registered in PAD_LABEL_KEYS", () => {
    // Unconditional: the mocked padLabel above already does the real
    // key-routing (it only calls through for "pad.cricket.ribbon.wicket"),
    // so tHit just needs a distinguishable return value — no need to
    // re-compare against a synthetic key that (correctly) isn't a member of
    // the real MessageKey union.
    const tHit: MsgFn = () => "Wicket!";
    const r = buildRibbon("cricket.wicket", { side: "home" }, () => "?", tHit);
    expect(r).toEqual({ text: "Wicket!", undoable: true });
  });
});

describe("ribbonKeyFor", () => {
  it("splits on the FIRST dot only, preserving further dots in the suffix", () => {
    expect(ribbonKeyFor("tabletennis.expedite.start")).toBe(
      "pad.tabletennis.ribbon.expedite.start",
    );
  });

  it("builds the key for a simple two-segment event type", () => {
    expect(ribbonKeyFor("football.goal")).toBe("pad.football.ribbon.goal");
  });
});
