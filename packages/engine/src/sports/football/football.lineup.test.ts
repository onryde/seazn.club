// S3/W4b (#426) — football on the kernel-owned lineup model (`core/lineup.ts`).
//
// What this file is for, in one sentence: football used to answer "who is on
// the pitch, where, and may another one come off" out of a private
// `squadFromLineup` + a private `maxSubs` reader, and this pins that it now
// answers all three out of the shared kernel — the SAME kernel the
// `core.lineup.*` family folds through, so the two vocabularies cannot drift.
//
// The three deferred `DOMAIN.md` rows this closes are named per describe block.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, type EventEnvelope } from "../../core/events.ts";
import { personsAtPosition } from "../../core/lineup.ts";
import type { Lineup, LineupPair } from "../../core/types.ts";
import { lineupFromCatalog, makeEnvelope } from "../../testkit/index.ts";
import { football, type FootballCfg } from "./football.ts";

// A catalog-valid XI (p1 is the catalog's GK slot) plus a six-man bench whose
// first man is the SUBSTITUTE KEEPER — the fixture has to be able to express a
// keeper change both ways (a swap of gloves, and a keeper substitution) or the
// two rows below cannot be told apart.
function lineupWithBench(entrantId: string, benchSize = 6): Lineup {
  const base = lineupFromCatalog(football.positions, entrantId);
  return {
    ...base,
    slots: [
      ...base.slots,
      ...Array.from({ length: benchSize }, (_, i) => ({
        personId: `${entrantId}-b${i + 1}`,
        slot: "bench" as const,
        orderNo: 12 + i,
        // Only the first bench man is a keeper; the rest are outfield.
        ...(i === 0 ? { positionKey: "GK" } : {}),
      })),
    ],
  };
}

const lineups: LineupPair = { home: lineupWithBench("H"), away: lineupWithBench("A") };
const cfgOf = (raw: unknown): FootballCfg => football.configSchema.parse(raw);

// PAD-SHAPED. Every stream below is a scorer entering events, which is the
// write path, and a cfg-derived refusal only exists there (§3.3).
const STRICT = { strictFromSeq: 0 } as const;

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}

/** The legacy, football-private substitution vocabulary. */
const legacySub = (off: string, on: string): [string, unknown] => [
  "football.sub",
  { by: "H", off, on },
];

/** The kernel vocabulary. `positionKey` is what the legacy one cannot carry. */
const kernelSub = (off: string, on: string, positionKey?: string): [string, unknown] => [
  "core.lineup.substitution",
  {
    side: "H",
    off,
    on: {
      personId: on,
      slot: "bench" as const,
      orderNo: 20,
      ...(positionKey === undefined ? {} : { positionKey }),
    },
  },
];

const keeperOf = (squads: { home: Parameters<typeof personsAtPosition>[0] }): string | undefined =>
  personsAtPosition(squads.home, "GK")[0];

// ---------------------------------------------------------------------------
// DOMAIN.md row "Goalkeeper confirmed pre-match" (:72) and the numbered finding
// "The goalkeeper is never named in State" (:129).
// ---------------------------------------------------------------------------

describe("the keeper is nameable by personId at every fold point", () => {
  it("names the starting keeper from the team sheet", () => {
    const { squads } = foldMatchWithStoppage(football, cfgOf({}), lineups, stream(["core.start"]), STRICT);
    expect(keeperOf(squads)).toBe("H-p1");
  });

  it("names the new keeper after a change of gloves, with nobody substituted", () => {
    const { squads } = foldMatchWithStoppage(
      football,
      cfgOf({}),
      lineups,
      stream(["core.start"], ["core.lineup.position", { side: "H", personId: "H-p2", positionKey: "GK" }]),
      STRICT,
    );
    // Both are now in goal as far as identity goes — the catalog's max:1 is a
    // LINEUP rule, not a fold rule — but the point of the row is that the
    // question is answerable at all, by person id, after the change.
    expect(personsAtPosition(squads.home, "GK")).toContain("H-p2");
  });

  it("names the substitute keeper after he comes on, and puts him on football's own pitch", () => {
    const state = foldMatch(
      football,
      cfgOf({}),
      lineups,
      stream(["core.start"], kernelSub("H-p1", "H-b1", "GK")),
      STRICT,
    );
    // The half that reds without football's `onLineup`: the kernel accepted the
    // change, so football's own pitch must know about it — otherwise the very
    // next goal by the substitute is refused as "not on the pitch".
    expect(state.squads.home.onPitch).toContain("H-b1");
    expect(state.squads.home.onPitch).not.toContain("H-p1");
    expect(state.squads.home.offUsed).toEqual(["H-p1"]);
  });

  it("lets the substitute who came on through the kernel then score", () => {
    const state = foldMatch(
      football,
      cfgOf({}),
      lineups,
      stream(["core.start"], kernelSub("H-p1", "H-b1", "GK"), ["football.goal", { by: "H", scorer: "H-b1" }]),
      STRICT,
    );
    expect(state.goals.home).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DOMAIN.md row "Goalkeeper change without a substitution" (:73), and #426's
// explicit requirement: "Swap the goalkeeper without spending a substitution."
// ---------------------------------------------------------------------------

describe("a goalkeeper change costs no substitution", () => {
  const capOne = () => cfgOf({ maxSubs: 1 });

  it("leaves the whole substitution allowance intact after a change of gloves", () => {
    const { squads, state } = foldMatchWithStoppage(
      football,
      capOne(),
      lineups,
      stream(
        ["core.start"],
        ["core.lineup.position", { side: "H", personId: "H-p2", positionKey: "GK" }],
        kernelSub("H-p3", "H-b2"),
      ),
      STRICT,
    );
    expect(squads.home.subsUsed).toBe(1);
    expect(state.squads.home.offUsed).toEqual(["H-p3"]);
  });

  it("still refuses the substitution BEYOND the cap, so the cap is really reaching the kernel", () => {
    // Without this half the test above is vacuous: a cap that never bites
    // cannot prove that a keeper change did not spend one.
    expect(() =>
      foldMatch(
        football,
        capOne(),
        lineups,
        stream(
          ["core.start"],
          ["core.lineup.position", { side: "H", personId: "H-p2", positionKey: "GK" }],
          kernelSub("H-p3", "H-b2"),
          kernelSub("H-p4", "H-b3"),
        ),
        STRICT,
      ),
    ).toThrowError(expect.objectContaining({ code: "LINEUP_INVALID" }));
  });
});

// ---------------------------------------------------------------------------
// DOMAIN.md row "Concussion (additional permanent) substitution" (:69).
// Owner ruling: exemptions live in cfg, never hard-coded.
// ---------------------------------------------------------------------------

describe("a concussion replacement is exempt from cfg.maxSubs", () => {
  // ONE fixture, ONE squad state, TWO verdicts. The cap and the exemption have
  // to DISAGREE here or the test cannot tell them apart.
  const cfg = () => cfgOf({ maxSubs: 1, concussionSubs: 1 });
  const atTheCap = stream(["core.start"], kernelSub("H-p2", "H-b2"));

  const concussion = (off: string, on: string): EventEnvelope =>
    makeEnvelope(atTheCap.length, {
      type: "core.lineup.replacement",
      payload: {
        side: "H",
        off,
        on: { personId: on, slot: "bench" as const, orderNo: 21 },
        exemption: "concussion",
      },
    });

  const ordinary = makeEnvelope(atTheCap.length, {
    type: "core.lineup.substitution",
    payload: { side: "H", off: "H-p3", on: { personId: "H-b3", slot: "bench" as const, orderNo: 22 } },
  });

  it("refuses an ORDINARY substitution once the cap is spent", () => {
    expect(() => foldMatch(football, cfg(), lineups, [...atTheCap, ordinary], STRICT)).toThrowError(
      expect.objectContaining({ code: "LINEUP_INVALID" }),
    );
  });

  it("accepts a CONCUSSION replacement from the very same squad state", () => {
    const { squads, state } = foldMatchWithStoppage(
      football,
      cfg(),
      lineups,
      [...atTheCap, concussion("H-p3", "H-b3")],
      STRICT,
    );
    expect(squads.home.exemptUsed).toEqual({ concussion: 1 });
    // Charged to the exemption, NOT to the cap — that separation is the row.
    expect(squads.home.subsUsed).toBe(1);
    expect(state.squads.home.onPitch).toContain("H-b3");
    expect(state.squads.home.exemptUsed).toEqual({ concussion: 1 });
  });

  it("does not let the exemption reopen the ordinary allowance", () => {
    // The replacement is permanent and it must not refund a substitution: an
    // ordinary sub after it is still refused.
    expect(() =>
      foldMatch(
        football,
        cfg(),
        lineups,
        [
          ...atTheCap,
          concussion("H-p3", "H-b3"),
          makeEnvelope(atTheCap.length + 1, {
            type: "core.lineup.substitution",
            payload: {
              side: "H",
              off: "H-p4",
              on: { personId: "H-b4", slot: "bench" as const, orderNo: 23 },
            },
          }),
        ],
        STRICT,
      ),
    ).toThrowError(expect.objectContaining({ code: "LINEUP_INVALID" }));
  });

  it("refuses the exemption entirely when the competition has not adopted the trial", () => {
    // `concussionSubs` absent = the IFAB trial is not in force here. Refused,
    // and refused for the RIGHT reason.
    try {
      foldMatch(football, cfgOf({ maxSubs: 1 }), lineups, [...atTheCap, concussion("H-p3", "H-b3")], STRICT);
      expect.unreachable("an undeclared exemption must be refused");
    } catch (error) {
      expect(EngineError.is(error, "LINEUP_INVALID")).toBe(true);
      expect((error as EngineError).data).toMatchObject({ reason: "exemption-not-declared" });
    }
  });

  it("bounds the exemption itself", () => {
    expect(() =>
      foldMatch(
        football,
        cfg(),
        lineups,
        [...atTheCap, concussion("H-p3", "H-b3"), { ...concussion("H-p4", "H-b4"), seq: 99 }],
        STRICT,
      ),
    ).toThrowError(expect.objectContaining({ code: "LINEUP_INVALID" }));
  });
});

// ---------------------------------------------------------------------------
// The fork. `football.sub` and `core.lineup.substitution` are two vocabularies
// for one Law, and this repo has shipped a placer/verifier divergence three
// times in one session. ONE function decides, so both must return the SAME
// NUMBER — not merely "each works".
// ---------------------------------------------------------------------------

describe("both substitution vocabularies return the same number", () => {
  /** How many substitutions this vocabulary lets through before it refuses. */
  function permitted(cfg: FootballCfg, make: (i: number) => [string, unknown]): number {
    const events = stream(["core.start"], ...Array.from({ length: 5 }, (_, i) => make(i)));
    for (let n = 1; n < events.length; n++) {
      try {
        foldMatch(football, cfg, lineups, events.slice(0, n + 1), STRICT);
      } catch {
        return n - 1;
      }
    }
    return events.length - 1;
  }

  const legacy = (i: number) => legacySub(`H-p${i + 2}`, `H-b${i + 1}`);
  const kernel = (i: number) => kernelSub(`H-p${i + 2}`, `H-b${i + 1}`);

  it("agrees under a competition cap", () => {
    const cfg = cfgOf({ maxSubs: 2 });
    const viaLegacy = permitted(cfg, legacy);
    expect(viaLegacy).toBe(2);
    expect(permitted(cfg, kernel)).toBe(viaLegacy);
  });

  it("agrees when the competition declares no cap", () => {
    const cfg = cfgOf({});
    const viaLegacy = permitted(cfg, legacy);
    expect(viaLegacy).toBe(5);
    expect(permitted(cfg, kernel)).toBe(viaLegacy);
  });

  it("agrees that a rolling variant is uncapped", () => {
    const cfg = cfgOf({ rollingSubs: true, maxSubs: 1 });
    const viaLegacy = permitted(cfg, legacy);
    expect(viaLegacy).toBe(5);
    expect(permitted(cfg, kernel)).toBe(viaLegacy);
  });
});

// ---------------------------------------------------------------------------
// OWNER RULING 2 — re-entry is a cfg knob, per sport AND per variant. Football
// Law 3.3 is no-return; the grassroots / small-sided dispensations ARE rolling.
// ---------------------------------------------------------------------------

describe("re-entry follows the variant, not the sport", () => {
  const off = kernelSub("H-p2", "H-b2");
  const back: [string, unknown] = [
    "core.lineup.substitution",
    { side: "H", off: "H-b2", on: { personId: "H-p2", slot: "starting" as const, orderNo: 2 } },
  ];

  it("permits the return under rollingSubs", () => {
    const state = foldMatch(
      football,
      cfgOf({ rollingSubs: true }),
      lineups,
      stream(["core.start"], off, back),
      STRICT,
    );
    expect(state.squads.home.onPitch).toContain("H-p2");
    expect(state.squads.home.offUsed).toEqual([]);
  });

  it("refuses the same return on 11-a-side", () => {
    try {
      foldMatch(football, cfgOf({}), lineups, stream(["core.start"], off, back), STRICT);
      expect.unreachable("Law 3.3 forbids a return");
    } catch (error) {
      expect(EngineError.is(error, "LINEUP_INVALID")).toBe(true);
      expect((error as EngineError).data).toMatchObject({ reason: "reentry-forbidden" });
    }
  });
});

// ---------------------------------------------------------------------------
// OWNER RULING 1 — squad growth is a cfg knob, DEFAULT OFF. Football
// substitutes from a pre-named bench and loses nothing by keeping it off.
// ---------------------------------------------------------------------------

describe("football never grows its squad mid-fixture", () => {
  it("refuses a substitute the team sheet never named", () => {
    try {
      foldMatch(
        football,
        cfgOf({}),
        lineups,
        stream(["core.start"], kernelSub("H-p2", "H-ghost")),
        STRICT,
      );
      expect.unreachable("a person off the team sheet cannot take the field");
    } catch (error) {
      expect(EngineError.is(error, "LINEUP_INVALID")).toBe(true);
      expect((error as EngineError).data).toMatchObject({ reason: "squad-growth-forbidden" });
    }
  });
});

// ---------------------------------------------------------------------------
// The additive tripwire, asserted here rather than left to the golden corpus:
// `init` now builds its squads from `initSquads`, and the SHAPE it serialises
// has to be exactly what `squadFromLineup` produced or every frozen football
// stream reds.
// ---------------------------------------------------------------------------

describe("the projection init writes is unchanged", () => {
  it("serialises the same squads a private squadFromLineup did", () => {
    const state = football.init(cfgOf({}), lineups);
    expect(JSON.stringify(state.squads.home)).toBe(
      JSON.stringify({
        onPitch: ["H-p1", "H-p2", "H-p3", "H-p4", "H-p5", "H-p6", "H-p7", "H-p8", "H-p9", "H-p10", "H-p11"],
        bench: ["H-b1", "H-b2", "H-b3", "H-b4", "H-b5", "H-b6"],
        offUsed: [],
        sentOff: [],
      }),
    );
  });

  it("keeps the same shape after the kernel has folded a lineup change", () => {
    const state = foldMatch(
      football,
      cfgOf({}),
      lineups,
      stream(["core.start"], kernelSub("H-p1", "H-b1", "GK")),
      STRICT,
    );
    expect(Object.keys(state.squads.home)).toEqual(["onPitch", "bench", "offUsed", "sentOff"]);
    expect(state.squads.home.bench).not.toContain("H-b1");
  });
});
