// S6/#416 (W5) regression — `records` becomes a genuine CFG field.
//
// Before this change, `SetBasedPreset.records` was a whole-module constant
// read ONCE at `makeSetBasedModule` call time (closure-captured, never
// touched again). `beach` and `indoor` are both volleyball, sharing one
// module, so they necessarily shared one `records` answer — and since
// `indoor` needs `substitutions: true`, `beach` silently inherited it too,
// even though FIVB beach volleyball (2-player pairs, no bench) has no
// substitutions at all. `apply()` wrongly accepted `volleyball.sub` for a
// beach fixture.
//
// The fix moves `records` into `SetBasedCfg` (SetBasedRecordFlags,
// setbased/kernel.ts), so `apply()` reads `state.cfg.records` PER FIXTURE.
// `badminton`/`tabletennis` never vary `records` by variant, so they are
// covered here only as a "nothing else moved" check.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { badminton } from "./badminton.ts";
import type { SetBasedCfg, SetBasedEv, SetBasedState } from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function foldVolleyball(cfg: SetBasedCfg, events: ModuleEvent[]): SetBasedState {
  const lineups = defaultLineupPair(resolvePositions(volleyball, cfg));
  return foldMatch(volleyball, cfg, lineups, envelopes(events), STRICT_ALL);
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    return `not-an-EngineError: ${String(error)}`;
  }
  return "no-throw";
}

const start: ModuleEvent = { type: "core.start", payload: {} };
const sub = (by: string): ModuleEvent => ({
  type: "volleyball.sub",
  payload: { by, off: `${by}-p1`, on: `${by}-p7` },
});

describe("SetBasedRecordFlags — records is a resolved cfg field, not a module constant", () => {
  it("indoor (default cfg) resolves records.substitutions to true", () => {
    const cfg = volleyball.configSchema.parse({});
    expect(cfg.records).toEqual({
      timeouts: true,
      sanctions: true,
      substitutions: true,
      expedite: false,
    });
  });

  it("beach resolves records.substitutions to false, everything else preserved", () => {
    const cfg = volleyball.configSchema.parse(volleyball.variants.beach);
    expect(cfg.records).toEqual({
      timeouts: true,
      sanctions: true,
      substitutions: false,
      expedite: false,
    });
  });

  it("badminton and tabletennis are unaffected by the volleyball-only override", () => {
    expect(badminton.configSchema.parse({}).records).toEqual({
      timeouts: false,
      sanctions: true,
      substitutions: false,
      expedite: false,
    });
    expect(tabletennis.configSchema.parse({}).records).toEqual({
      timeouts: true,
      sanctions: true,
      substitutions: false,
      expedite: true,
    });
  });
});

describe("REGRESSION — beach volleyball must refuse volleyball.sub (indoor keeps accepting it)", () => {
  it("indoor accepts a substitution", () => {
    const cfg = volleyball.configSchema.parse({});
    const state = foldVolleyball(cfg, [start, sub("H")]);
    expect(state.subs?.home).toBe(1);
  });

  it("beach REFUSES a substitution with INVALID_EVENT, naming the sport", () => {
    const cfg = volleyball.configSchema.parse(volleyball.variants.beach);
    expect(codeOf(() => foldVolleyball(cfg, [start, sub("H")]))).toBe("INVALID_EVENT");
    let message = "";
    try {
      foldVolleyball(cfg, [start, sub("H")]);
    } catch (error) {
      message = error instanceof EngineError ? error.message : String(error);
    }
    expect(message).toBe('"volleyball" does not record substitutions');
  });

  it("beach's arbitraryEvent generator never emits volleyball.sub (would throw on its own apply())", () => {
    const cfg = volleyball.configSchema.parse(volleyball.variants.beach);
    const lineups = defaultLineupPair(resolvePositions(volleyball, cfg));
    const generate = volleyball.arbitraryEvent;
    if (!generate) throw new Error("volleyball has no arbitraryEvent");
    for (let seed = 1; seed <= 200; seed++) {
      let state = volleyball.init(cfg, lineups);
      const rng = (() => {
        let s = seed;
        return () => {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          return s / 0x7fffffff;
        };
      })();
      for (let i = 0; i < 60; i++) {
        const next = generate.call(volleyball, state, rng);
        if (!next) break;
        expect(next.type, `seed ${seed} step ${i}`).not.toBe("volleyball.sub");
        const envelope = makeEnvelope(i, next);
        // apply() must not throw either — this is the direct mutation-shaped
        // proof that the generator and the fold agree.
        state = volleyball.apply(state, envelope as EventEnvelope<SetBasedEv | CoreEv>);
      }
    }
  });
});

// review (cfg-replay.conformance.test.ts §3.3) — moving `records` into cfg
// means the refusal above is CFG-DERIVED, and cfg is read live: every read
// (state route, score page, standings) refolds the whole stream from
// `init`. An UNGATED refusal would brick an already-recorded fixture the
// moment an organiser's config edit disagrees with what was legal when the
// event was written — exactly the bug class this engine has fixed 6 times
// before (NestedInterruptionRules, the period kernel's `periodSeconds`,
// …). `apply()` gates every `records`-derived check on `strict`
// (`isStrictFold`), so this file's own beach-refuses-a-sub test above uses
// `STRICT_ALL` (the write-path shape) and this describe block proves the
// other half: a stream legitimately recorded under `substitutions: true`
// must stay READABLE after a later edit disables it.
describe("§3.3 — a records cfg edit must never brick an already-recorded fixture", () => {
  it("a sub recorded under indoor cfg still replays after the config is edited to beach's shape (no strict options — the real read path)", () => {
    const recordedCfg = volleyball.configSchema.parse({}); // indoor: substitutions true
    const lineups = defaultLineupPair(resolvePositions(volleyball, recordedCfg));
    const events = envelopes([start, sub("H")]);
    // Written legally under indoor.
    const asRecorded = foldMatch(volleyball, recordedCfg, lineups, events, STRICT_ALL);
    expect(asRecorded.subs?.home).toBe(1);

    // Replayed under beach's cfg (substitutions: false) — the READ path
    // (no strict options), exactly what the state route/score page/
    // standings actually call. Must not throw.
    const editedCfg = volleyball.configSchema.parse(volleyball.variants.beach);
    expect(() => foldMatch(volleyball, editedCfg, lineups, events)).not.toThrow();
    const replayed = foldMatch(volleyball, editedCfg, lineups, events);
    expect(replayed.subs?.home).toBe(1); // the recorded sub still folded
  });

  it("a fresh (strict) sub attempt is still refused under beach even after this fix", () => {
    const editedCfg = volleyball.configSchema.parse(volleyball.variants.beach);
    expect(codeOf(() => foldVolleyball(editedCfg, [start, sub("H")]))).toBe("INVALID_EVENT");
  });
});
