// S8/#417 — pure, DB-free half of the entrant-membership loader. The
// DB-backed proof that `loadEntrantMembersForDivision` itself queries the
// right rows is in player-stats.test.ts / org-posts.test.ts (through the
// real recomputePlayerStats / extractScorers call sites, per the owner's
// ruling that an engine unit test is not the acceptance bar here — mirrors
// fixture-cfg.test.ts's split: pure logic here, DB proof at the usecase).
import { describe, expect, it } from "vitest";
import { entrantFoldCtx, type EntrantMembership } from "../entrant-members";

describe("entrantFoldCtx", () => {
  it("builds ctx.entrants as exactly [home, away] with each one's kind, and wires personsOf", () => {
    const members = new Map<string, EntrantMembership>([
      ["home-1", { kind: "individual", personIds: ["p-home"] }],
      ["away-1", { kind: "pair", personIds: ["p-away-1", "p-away-2"] }],
    ]);
    const ctx = entrantFoldCtx("home-1", "away-1", members, { setTo: 21 });

    // Order matters for the engine's folded fold (setBasedMatchOutcomesFold
    // reads ctx.entrants[0]/[1] as its two synthetic sides) even though which
    // physical side is "first" doesn't change attribution correctness — see
    // that function's own doc comment. What matters here is BOTH are present,
    // exactly once each, with the kind this map recorded.
    expect(ctx.entrants).toEqual([
      { id: "home-1", kind: "individual" },
      { id: "away-1", kind: "pair" },
    ]);
    expect(ctx.personsOf("home-1")).toEqual(["p-home"]);
    expect(ctx.personsOf("away-1")).toEqual(["p-away-1", "p-away-2"]);
    expect(ctx.cfg).toEqual({ setTo: 21 });
  });

  // THE load-bearing property (packages/engine/src/sports/setbased/kernel.ts
  // `setBasedMatchOutcomesFold`): `if (ctx.entrants.length !== 2) return [];`
  // — passing the WHOLE division's entrant roster instead of just this
  // fixture's two sides would silently zero out sets_won/matches for every
  // fixture. A bye/TBD side (null id) must still degrade to fewer than 2
  // entries, never be padded or substituted.
  it("drops a null (bye/TBD) side rather than padding it", () => {
    const members = new Map<string, EntrantMembership>([
      ["home-1", { kind: "individual", personIds: ["p-home"] }],
    ]);
    const ctx = entrantFoldCtx("home-1", null, members, undefined);
    expect(ctx.entrants).toEqual([{ id: "home-1", kind: "individual" }]);
    expect(ctx.entrants).toHaveLength(1); // NOT 2 — the fold's own guard relies on this
  });

  it("both sides null yields an empty entrants list, never a throw", () => {
    const ctx = entrantFoldCtx(null, null, new Map(), undefined);
    expect(ctx.entrants).toEqual([]);
  });

  it("defaults an entrant missing from the membership map to kind 'team' (never throws, never credits)", () => {
    // House rule: no throw on a data-derived condition in the fold path. An
    // entrant id the loader's query somehow didn't return (should not happen
    // under real FK integrity, but this function must never assume it) must
    // degrade safely — "team" is the SAFE default because the engine's own
    // mandatory kind guard then credits nobody, rather than "individual"
    // which would fabricate an attribution out of missing data.
    const ctx = entrantFoldCtx("ghost-1", "home-1", new Map([["home-1", { kind: "individual", personIds: ["p"] }]]), undefined);
    expect(ctx.entrants).toEqual([
      { id: "ghost-1", kind: "team" },
      { id: "home-1", kind: "individual" },
    ]);
    expect(ctx.personsOf("ghost-1")).toEqual([]);
  });

  it("personsOf reads the whole membership map, not just ctx.entrants", () => {
    // Deliberate: the engine only ever calls personsOf for an id it already
    // found in ctx.entrants (resolveMetricPersons looks the id up first), so
    // scoping personsOf to the division-wide map is harmless — and simpler
    // than rebuilding a second, narrower closure per fixture.
    const members = new Map<string, EntrantMembership>([
      ["elsewhere", { kind: "individual", personIds: ["p-elsewhere"] }],
    ]);
    const ctx = entrantFoldCtx(null, null, members, undefined);
    expect(ctx.personsOf("elsewhere")).toEqual(["p-elsewhere"]);
  });
});
