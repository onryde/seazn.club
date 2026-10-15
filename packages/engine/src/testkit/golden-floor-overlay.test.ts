// The golden floor's "recorded, overlay unpinned" class (GF-1 review finding 1, option b).
//
// The floor checks that a corpus RECORDS each core event. It cannot check that recording one PINS it: the harness stores
// the module's state, outcome, summary and deltas and not the kernel overlay (stoppage clock, squads, settlement), so a
// kernel-owned event — or one a module folds as `return state` — can sit in a stream and move nothing the epoch guard
// compares. Those events are CLASSED, not hidden: each claim below says which events are inert in which sports and why,
// the inertness is DERIVED by a probe (ablate the event, compare every recorded field), and a claim whose probe starts
// finding movement is stale (the day the harness records the overlay, every claim here goes red and is deleted).
//
// Expected values come from the engine's own declarations (`module.onLineup`, CORE_EVENT_SCHEMAS) and from the probe,
// never from a table typed here.
import { describe, expect, it } from "vitest";
import { CORE_EVENT_SCHEMAS, foldMatchWithStoppage, isKernelOwnedEventType, outcomeOf } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import { readCorpus, recomputeStream, type GoldenCorpus, type GoldenEvent } from "./golden.ts";
import {
  ablateEvents,
  CORE_TYPES,
  LINEUP_TYPES,
  OVERLAY_CLAIMS,
  OVERLAY_CONTROLS,
  eventToken,
  floorRequirement,
  recordedTokens,
  overlayVerdicts,
  staleOverlayClaims,
  uncoveredUnpinned,
  type FloorToken,
} from "./golden-floor.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { resolvePositions } from "../sport/catalog.ts";

const corpora = new Map(builtinModules.map((m) => [m.key, readCorpus(m.key)] as const));
const corpusOf = (key: string): GoldenCorpus => {
  const c = corpora.get(key);
  if (c === undefined) throw new Error(`no corpus for ${key}`);
  return c;
};

/** How many claimed tokens the sport's own policy leaves possible: the ones a claim is held over. */
const claimedTokens = (module: (typeof builtinModules)[number], corpus: GoldenCorpus): number => {
  const impossible = floorRequirement(module, corpus).impossible;
  return OVERLAY_CLAIMS.filter((c) => c.assertedFor(module)).reduce((n, c) => n + c.tokens.filter((t) => !impossible.has(t)).length, 0);
};

describe("golden floor — the overlay-unpinned class is declared, reasoned and derived", () => {
  it("every claim row names real core types, a reason, and applies to at least one sport", () => {
    expect(OVERLAY_CLAIMS.length).toBeGreaterThan(0);
    const allTokens = new Set(CORE_TYPES.map(eventToken));
    let applied = 0;
    for (const claim of OVERLAY_CLAIMS) {
      expect(claim.reason.length, claim.id).toBeGreaterThan(40);
      expect(claim.tokens.length, claim.id).toBeGreaterThan(0);
      for (const token of claim.tokens) expect(allTokens.has(token), `${claim.id}: ${token}`).toBe(true);
      const sports = builtinModules.filter((m) => claim.assertedFor(m));
      expect(sports.length, `${claim.id} applies to no sport`).toBeGreaterThan(0);
      applied += sports.length;
    }
    expect(applied).toBeGreaterThanOrEqual(builtinModules.length * 3);
  });

  it("the shipped corpora hold every claim: each claimed event is recorded and inert in each sport it applies to (swept, counted)", () => {
    let holds = 0;
    const stale: string[] = [];
    forEachSport(({ module, key }) => {
      stale.push(...staleOverlayClaims(module, corpusOf(key)));
      for (const claim of OVERLAY_CLAIMS) if (claim.assertedFor(module)) holds += claim.tokens.length;
    });
    expect(stale).toEqual([]);
    expect(holds).toBeGreaterThan(builtinModules.length * 4);
  }, 30_000);

  it("pause is unpinned in EVERY sport: suspend and resume move no recorded golden anywhere (the review's finding 1)", () => {
    let sports = 0;
    forEachSport(({ module, key }) => {
      const verdicts = overlayVerdicts(module, corpusOf(key));
      for (const type of ["core.suspend", "core.resume"]) {
        const v = verdicts.get(eventToken(type));
        expect(v?.verdict, `${key} ${type}`).toBe("unpinned");
        expect(v?.streams, `${key} ${type} streams probed`).toBeGreaterThan(0);
      }
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
  });

  // ASSERTED, not exhaustive: without onLineup every lineup type is unpinned; with it the probe must SEE some movement. Which
  // types a hook-declaring module still ignores (football's position) is the per-token sweep below, not this `some`.
  it("a lineup event is unpinned in EVERY recorded type where the module declares no onLineup; where it declares one, the probe sees movement in at least one type", () => {
    let withHook = 0;
    let withoutHook = 0;
    forEachSport(({ module, key }) => {
      const verdicts = overlayVerdicts(module, corpusOf(key));
      const recorded = LINEUP_TYPES.map(eventToken).filter((t) => (verdicts.get(t)?.streams ?? 0) > 0);
      expect(recorded.length, `${key} records lineup events`).toBeGreaterThan(0);
      if (module.onLineup === undefined) {
        for (const t of recorded) expect(verdicts.get(t)?.verdict, `${key} ${t}`).toBe("unpinned");
        withoutHook++;
      } else {
        expect(
          recorded.some((t) => verdicts.get(t)?.verdict === "pinned"),
          `${key} declares onLineup, so some lineup event must move a recorded golden`,
        ).toBe(true);
        withHook++;
      }
    });
    expect(withHook).toBeGreaterThan(0);
    expect(withoutHook).toBeGreaterThan(0);
  });

  it("EVERY recorded core event whose ablation says 'unpinned' is covered by a claim: swept per sport x token, counted (review N1)", () => {
    let probed = 0;
    let unpinned = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      const r = uncoveredUnpinned(module, corpus);
      expect(r.uncovered, `${key}: an unpinned core event no claim covers`).toEqual([]);
      // the sweep reached EVERY core event the corpus records (read off the corpus, not off the probe)
      const recordedCore = [...recordedTokens(corpus)].filter((t) => t.startsWith("event:core."));
      expect(r.probed, `${key}: probed every recorded core event`).toBe(recordedCore.length);
      expect(r.unpinned, `${key}: pause, note and award at least`).toBeGreaterThanOrEqual(4);
      probed += r.probed;
      unpinned += r.unpinned;
    });
    expect(probed).toBeGreaterThan(builtinModules.length * 8);
    expect(unpinned).toBeGreaterThan(builtinModules.length * 4);
  }, 30_000);

  it("football declares onLineup yet its position change moves no golden: the claim COVERS it by the verdict, though it is not asserted for football", () => {
    const football = builtinModules.find((m) => m.key === "football")!;
    expect(football.onLineup, "football reacts to lineup changes").toBeDefined();
    const position = eventToken("core.lineup.position");
    const verdicts = overlayVerdicts(football, corpusOf("football"));
    expect(verdicts.get(position)?.verdict).toBe("unpinned");
    expect(verdicts.get(position)?.streams).toBeGreaterThan(0);
    // and the rest of football's lineup changes DO move it (the class is not 'all lineups' there)
    expect(["core.lineup.substitution", "core.lineup.retirement", "core.lineup.entry"].map((t) => verdicts.get(eventToken(t))?.verdict)).toEqual(["pinned", "pinned", "pinned"]);
    const lineup = OVERLAY_CLAIMS.find((c) => c.id === "lineup")!;
    expect(lineup.assertedFor(football)).toBe(false);
    expect(lineup.covers(football, position, "unpinned")).toBe(true);
    expect(lineup.covers(football, eventToken("core.lineup.substitution"), "pinned")).toBe(false);
    expect(uncoveredUnpinned(football, corpusOf("football")).uncovered).toEqual([]);
  });

  it("the sweep has teeth: the old declaration-only rule (lineups claimed where onLineup is undefined) leaves football's position change uncovered, by name", () => {
    const football = builtinModules.find((m) => m.key === "football")!;
    const declarationOnly = OVERLAY_CLAIMS.map((c) => (c.id === "lineup" ? { ...c, covers: (m: typeof football) => m.onLineup === undefined } : c));
    const r = uncoveredUnpinned(football, corpusOf("football"), undefined, declarationOnly);
    expect(r.uncovered).toEqual([expect.stringMatching(/^football event:core\.lineup\.position: moves no recorded golden/)]);
    // and a claim table that forgets a whole class names it in every sport
    const withoutNote = OVERLAY_CLAIMS.filter((c) => c.id !== "note");
    let named = 0;
    forEachSport(({ module, key }) => {
      const missing = uncoveredUnpinned(module, corpusOf(key), undefined, withoutNote).uncovered;
      expect(missing.some((m) => m.startsWith(`${key} event:core.note:`)), `${key} names core.note`).toBe(true);
      named++;
    });
    expect(named).toBe(builtinModules.length);
  }, 30_000);

  it("the controls are NOT in the class: finalize, abandon and forfeit each move a recorded golden in every sport (the probe can answer 'pinned')", () => {
    expect(OVERLAY_CONTROLS.length).toBeGreaterThanOrEqual(3);
    const claimed = new Set<FloorToken>(OVERLAY_CLAIMS.flatMap((c) => [...c.tokens]));
    let checked = 0;
    forEachSport(({ module, key }) => {
      const verdicts = overlayVerdicts(module, corpusOf(key));
      for (const token of OVERLAY_CONTROLS) {
        expect(claimed.has(token), `${token} must not also be claimed unpinned`).toBe(false);
        const v = verdicts.get(token);
        expect(v?.streams, `${key} ${token} streams probed`).toBeGreaterThan(0);
        expect(v?.verdict, `${key} ${token}`).toBe("pinned");
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * OVERLAY_CONTROLS.length);
  });

  it("the probe answers 'pinned' for a lineup event once a module reacts to it (a boardgame given an onLineup that writes state)", () => {
    const boardgame = builtinModules.find((m) => m.key === "boardgame")!;
    expect(boardgame.onLineup).toBeUndefined();
    // (the kernel also offers the hook the INITIAL squads, so a hook that merely stamps the state is equal at every step;
    // one that writes the squads it was handed differs exactly when a lineup event changed them)
    const reacting = { ...boardgame, onLineup: (state: object, squads: unknown) => ({ ...state, squadDigest: JSON.stringify(squads) }) } as unknown as typeof boardgame;
    const verdicts = overlayVerdicts(reacting, corpusOf("boardgame"));
    const recorded = LINEUP_TYPES.map(eventToken).filter((t) => (verdicts.get(t)?.streams ?? 0) > 0);
    expect(recorded.length).toBeGreaterThan(0);
    for (const t of recorded) expect(verdicts.get(t)?.verdict, t).toBe("pinned");
  });

  it("the lineup chain credits each type with only what it ADDS: a hook that reacts to who is on the field sees substitution, retirement and entry, not a position change", () => {
    const boardgame = builtinModules.find((m) => m.key === "boardgame")!;
    // the kernel hands the hook the squads after every lineup change; this one writes only WHO is on the field, which a
    // substitution, a retirement and an entry change and a position change does not
    const onFieldOnly = {
      ...boardgame,
      onLineup: (state: object, squads: { home: { members: { onField: boolean; personId: string }[] }; away: { members: { onField: boolean; personId: string }[] } }) => ({
        ...state,
        onField: [...squads.home.members, ...squads.away.members].filter((m) => m.onField).map((m) => m.personId).join(","),
      }),
    } as unknown as typeof boardgame;
    const verdicts = overlayVerdicts(onFieldOnly, corpusOf("boardgame"));
    const verdictOf = (type: string) => verdicts.get(eventToken(type))?.verdict;
    expect(verdictOf("core.lineup.position"), "a position change moves nobody on or off the field").toBe("unpinned");
    expect(verdictOf("core.lineup.substitution")).toBe("pinned");
    expect(verdictOf("core.lineup.retirement")).toBe("pinned");
    expect(verdictOf("core.lineup.entry")).toBe("pinned");
  });

  it("an unrecorded event is 'unrecorded', never 'unpinned' (an empty corpus claims nothing, so no claim can hold vacuously)", () => {
    forEachSport(({ module, key }) => {
      const empty: GoldenCorpus = { ...corpusOf(key), streams: [] };
      const verdicts = overlayVerdicts(module, empty);
      for (const claim of OVERLAY_CLAIMS) for (const token of claim.tokens) expect(verdicts.get(token)?.verdict, `${key} ${token}`).toBe("unrecorded");
      const stale = staleOverlayClaims(module, empty);
      const applicable = claimedTokens(module, empty);
      expect(stale.length, `${key}: every claimed, possible token is stale when nothing is recorded`).toBe(applicable);
    });
  });

  it("the day the harness records the kernel overlay, the KERNEL-OWNED claims go stale and the module-folded ones do not (an overlay-recording harness, injected)", () => {
    // The future this class waits for: `recomputeStream` storing what the kernel READS (stoppage, squads, settlement)
    // beside module state. Injected here as a recorder whose per-step record includes the overlay. A pause and a lineup
    // change are kernel-owned (`isKernelOwnedEventType`), so recording the overlay pins them; a note or an award reaches the
    // module, which folds it as `return state`, so recording the overlay changes nothing for them — they stay unpinned
    // until a module starts folding them. The split is read off the kernel's own declaration, not typed here.
    let kernelStale = 0;
    let moduleHeld = 0;
    forEachSport(({ module, key }) => {
      const overlayRecorder: typeof recomputeStream = (m, raw, events, lineups) => {
        const cfg = m.configSchema.parse(raw) as unknown;
        const base = recomputeStream(m, raw, events, lineups);
        const pair = lineups ?? defaultLineupPair(resolvePositions(m, cfg));
        const states = events.map((_, i) => {
          const folded = foldMatchWithStoppage(m as never, cfg as never, pair, events.slice(0, i + 1).map((e, j) => makeEnvelope(j, e, e.voids)), { strictFromSeq: 0 });
          return JSON.stringify({ state: folded.state, stoppage: folded.stoppage, squads: folded.squads, effective: outcomeOf(m as never, folded as never) });
        });
        return { ...base, states };
      };
      const corpus = corpusOf(key);
      expect(staleOverlayClaims(module, corpus), `${key} (real harness)`).toEqual([]);
      const messages = staleOverlayClaims(module, corpus, overlayRecorder);
      const impossible = floorRequirement(module, corpus).impossible;
      const kernelTokens: FloorToken[] = [];
      const moduleTokens: FloorToken[] = [];
      for (const claim of OVERLAY_CLAIMS) {
        if (!claim.assertedFor(module)) continue;
        for (const token of claim.tokens) {
          if (impossible.has(token)) continue;
          (isKernelOwnedEventType(token.slice("event:".length)) ? kernelTokens : moduleTokens).push(token);
        }
      }
      expect(kernelTokens.length, `${key} claims a kernel-owned event`).toBeGreaterThan(0);
      expect(moduleTokens.length, `${key} claims a module-folded event`).toBeGreaterThan(0);
      for (const token of kernelTokens) {
        expect(messages.filter((m) => m.includes(` ${token}: moves a recorded golden`)), `${key} ${token} goes stale`).toHaveLength(1);
        kernelStale++;
      }
      for (const token of moduleTokens) {
        expect(messages.filter((m) => m.includes(` ${token}:`)), `${key} ${token} is still unpinned`).toEqual([]);
        moduleHeld++;
      }
      expect(messages.length, `${key}: nothing else goes stale`).toBe(kernelTokens.length);
    });
    expect(kernelStale).toBeGreaterThan(builtinModules.length * 2);
    expect(moduleHeld).toBe(builtinModules.length * 2);
    // (4.8 s under the CI coverage run: an explicit budget, not the 5 s default, for a sweep that folds every prefix of every
    // recorded stream twice)
  }, 30_000);

  it("a claimed event that cannot be probed (a recorder that throws) is stale, never silently held", () => {
    const module = builtinModules[0]!;
    const broken: typeof recomputeStream = () => {
      throw new Error("recorder exploded");
    };
    const messages = staleOverlayClaims(module, corpusOf(module.key), broken);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join("\n")).toMatch(/recorder exploded/);
  });

  it("the claims name only events the kernel declares (the vocabulary is CORE_EVENT_SCHEMAS)", () => {
    const declared = new Set(Object.keys(CORE_EVENT_SCHEMAS).map(eventToken));
    const claimed = new Set<FloorToken>(OVERLAY_CLAIMS.flatMap((c) => [...c.tokens]));
    expect(claimed.size).toBeGreaterThan(0);
    for (const token of claimed) expect(declared.has(token), token).toBe(true);
  });
});

describe("ablateEvents — the ledger without a set of types, voids renumbered to where their targets now sit", () => {
  const e = (type: string, voids?: string): GoldenEvent => ({ type, payload: {}, ...(voids === undefined ? {} : { voids }) });

  it("removing events in FRONT of a void's target shifts the void's id by exactly the number removed before the target", () => {
    // 0 start, 1 note, 2 goal, 3 note, 4 goal, 5 void->e-4 (the second goal)
    const ledger = [e("core.start"), e("core.note"), e("x.goal"), e("core.note"), e("x.goal"), e("core.void", "e-4")];
    const out = ablateEvents(ledger, new Set(["core.note"]));
    expect(out?.kept.map((k) => k.type)).toEqual(["core.start", "x.goal", "x.goal", "core.void"]);
    // the second goal moved from index 4 to index 2
    expect(out?.kept[3]?.voids).toBe("e-2");
    // and a void whose target is not shifted keeps its id
    const early = ablateEvents([e("core.start"), e("x.goal"), e("core.void", "e-1"), e("core.note")], new Set(["core.note"]));
    expect(early?.kept[2]?.voids).toBe("e-1");
  });

  it("a void whose target is removed leaves nothing sound to compare: null, not a guess", () => {
    const ledger = [e("core.start"), e("x.goal"), e("core.void", "e-1")];
    expect(ablateEvents(ledger, new Set(["x.goal"]))).toBeNull();
  });

  it("an empty removal set returns the ledger unchanged, and the input is never mutated", () => {
    const ledger = [e("core.start"), e("x.goal"), e("core.void", "e-1")];
    const before = JSON.stringify(ledger);
    expect(ablateEvents(ledger, new Set())?.kept).toEqual(ledger);
    expect(JSON.stringify(ledger)).toBe(before);
  });
});
