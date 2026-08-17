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
    // Fix round 2 (review, Critical): the oracle MUST discriminate by its
    // input. A constant oracle (`() => "Wicket!"`) returns the same text on
    // the hit path (padLabel → mocked → m(key)) and the fallback path
    // (t("pad.ribbon.fallback", {...})), so an inverted branch condition in
    // buildRibbon — the exact bug fix round 1 corrected — would still leave
    // this test green. Templating the key into the output makes the two
    // paths' outputs provably different: the hit path calls
    // tHit("pad.cricket.ribbon.wicket"), the fallback path (if the branch
    // were broken) would call tHit("pad.ribbon.fallback", {...}) instead —
    // different key in, different text out, either way.
    const tHit: MsgFn = (k) => `HIT:${k}`;
    const r = buildRibbon("cricket.wicket", { side: "home" }, () => "?", tHit);
    expect(r).toEqual({ text: "HIT:pad.cricket.ribbon.wicket", undoable: true });
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

// D1 fix (sign-off review, 2026-08-17): a real 320px screenshot of a live
// cricket match showed a row reading verbatim "core.start recorded" — the
// raw internal event type leaking to a scorer via the generic
// `pad.ribbon.fallback` path. `core.*` events are kernel-owned and never
// register in PAD_LABEL_KEYS (they are not part of any sport's PadSpec),
// so they could never take the per-sport hit branch either — `buildRibbon`
// now checks a small LOCAL core map first, before either of the two paths
// the tests above already cover.
describe("buildRibbon — core.* events (D1)", () => {
  // Oracle style matches the file's own established pattern above: template
  // the key into the output so a hit and a miss produce PROVABLY different
  // text, not a constant a broken branch could coincidentally also produce.
  const tCore: MsgFn = (k, v) =>
    k === "pad.ribbon.fallback" ? `${v!.event} recorded` : `CORE:${k}`;

  it("core.start never renders its raw event type", () => {
    const r = buildRibbon("core.start", {}, () => "?", tCore);
    expect(r.text).not.toContain("core.start recorded");
    expect(r.text).toBe("CORE:pad.ribbon.core.start");
  });

  it("core.void — the event that IS an undo — gets its own caption, not the raw type", () => {
    const r = buildRibbon("core.void", {}, () => "?", tCore);
    expect(r.text).toBe("CORE:pad.ribbon.core.void");
  });

  it.each([
    ["core.forfeit", "pad.ribbon.core.forfeit"],
    ["core.abandon", "pad.ribbon.core.abandon"],
    ["core.finalize", "pad.ribbon.core.finalize"],
    ["core.note", "pad.ribbon.core.note"],
    ["core.award", "pad.ribbon.core.award"],
    ["core.suspend", "pad.ribbon.core.suspend"],
    ["core.resume", "pad.ribbon.core.resume"],
    ["core.lineup.substitution", "pad.ribbon.core.lineup.substitution"],
    ["core.lineup.replacement", "pad.ribbon.core.lineup.replacement"],
    ["core.lineup.position", "pad.ribbon.core.lineup.position"],
    ["core.lineup.retirement", "pad.ribbon.core.lineup.retirement"],
    ["core.lineup.entry", "pad.ribbon.core.lineup.entry"],
  ])("%s resolves to its own %s caption, not the generic fallback", (type, key) => {
    const r = buildRibbon(type, {}, () => "?", tCore);
    // Proves the CORE branch fired, not the fallback one: a regression that
    // dropped `type` from `CORE_RIBBON_KEY` would fall through to
    // `t("pad.ribbon.fallback", {event: type})`, which `tCore` renders as
    // "{type} recorded" — a provably DIFFERENT string from `CORE:${key}`.
    expect(r.text).toBe(`CORE:${key}`);
    expect(r.text).not.toBe(`${type} recorded`);
  });

  it("a HYPOTHETICAL future core.* type with no registered copy degrades to the SAME generic fallback every other un-vocab'd type gets — never a broken t() call", () => {
    const r = buildRibbon("core.hypothetical", {}, () => "?", tCore);
    expect(r.text).toBe("core.hypothetical recorded");
  });
});

// D2 fix (sign-off review, 2026-08-17): three `cricket.ball` rows in the
// same screenshot all read identically "Ball recorded" — buildRibbon
// resolved a label per event TYPE and ignored `payload` entirely, even
// though it already received it. `detail` is the new, optional seam a
// caller (ActivityPanel's `resolveDetail` prop, computed by the SKIN so
// the chassis itself stays sport-agnostic) can use to distinguish rows of
// the same type.
describe("buildRibbon — detail parameter (D2)", () => {
  const t: MsgFn = (k, v) => {
    if (k === "pad.ribbon.fallback") return `${v!.event} recorded`;
    if (k === "pad.ribbon.withDetail") return `${v!.base} — ${v!.detail}`;
    return k;
  };

  it("omitting detail reproduces EXACTLY today's per-type-only text — the only path production exercises until resolveDetail is wired", () => {
    const r = buildRibbon("football.goal", { side: "home" }, () => "?", t);
    expect(r.text).toBe("football.goal recorded");
  });

  it("a supplied detail is woven onto the base caption via pad.ribbon.withDetail, not string-concatenated", () => {
    const r = buildRibbon("football.goal", {}, () => "?", t, "left foot");
    expect(r.text).toBe("football.goal recorded — left foot");
  });

  it("two calls with the SAME type but DIFFERENT detail produce DIFFERENT text — the actual defect fix", () => {
    const dot = buildRibbon("cricket.ball", {}, () => "?", t, "Dot ball");
    const four = buildRibbon("cricket.ball", {}, () => "?", t, "4 runs");
    expect(dot.text).not.toBe(four.text);
  });

  it("an empty-string detail is treated as absent (falsy), not woven in", () => {
    const r = buildRibbon("football.goal", {}, () => "?", t, "");
    expect(r.text).toBe("football.goal recorded");
  });

  it("detail composes with the core.* path too (e.g. a future core.award enrichment)", () => {
    const tCore: MsgFn = (k, v) => {
      if (k === "pad.ribbon.core.award") return "Award recorded";
      if (k === "pad.ribbon.withDetail") return `${v!.base} — ${v!.detail}`;
      return k;
    };
    const r = buildRibbon("core.award", {}, () => "?", tCore, "Player of the Match");
    expect(r.text).toBe("Award recorded — Player of the Match");
  });
});
