// Task 3 (R1 chassis): ribbon copy builder. R1 ships the FALLBACK path only
// — no per-sport `pad.<sport>.ribbon.<suffix>` dictionary copy exists yet
// (that lands with each conversion wave, R2+), so this suite only exercises
// `buildRibbon` falling through to the generic `pad.ribbon.fallback`
// template. See .superpowers/sdd/2026-08-15-scorepad-v3-r1-chassis/task-3-brief.md.
import { describe, it, expect } from "vitest";
import { buildRibbon } from "../ribbon";

const t = (k: string, v?: Record<string, string>) =>
  k === "pad.ribbon.fallback" ? `${v!.event} recorded` : k;

describe("buildRibbon", () => {
  it("falls back to the generic ribbon with the vocab'd event name", () => {
    const r = buildRibbon("football.goal", { side: "home" }, () => "?", t as never);
    expect(r).toEqual({ text: "football.goal recorded", undoable: true });
  });
});
