// The golden floor's "recorded, overlay unpinned" class (GF-1 review finding 1, option b; retired in part by GF-2 T3).
//
// The floor checks that a corpus RECORDS each core event. It cannot check that recording one PINS it: an event a module folds as
// `return state` can sit in a stream and move nothing the epoch guard compares. Those events are CLASSED, not hidden: each claim
// says which events are inert and why, the inertness is DERIVED by a probe (ablate the event, compare every recorded field), and
// a claim whose probe starts finding movement is stale.
//
// Before GF-2 the class also held every kernel-owned event, because the harness recorded the module's answers only. Format 2
// records the overlay and a summary digest after every event, the probe compares those too, and two claims flipped under the real
// recorder: `stoppage` (11 sports) and `lineup` (boardgame, carrom, generic, and football's position change). This file holds
// the flip: the SAME probe over the SAME corpora answers "unpinned" under the module-only recorder (what the harness recorded
// before, the control that shows the claim was true) and "pinned" under the real one.
//
// GF-2 T4 flipped a third: `core.award`, in the three sports that DECLARE an award key (`playerStats.awards`). Format 3 records
// the final player-stats rows, and an award there adds `<key>_awards` to a person; the eight sports that declare none still
// ignore it, so the claim narrows to them instead of vanishing.
//
// Expected values come from the engine's own declarations (`module.onLineup`, `module.playerStats.awards`, CORE_EVENT_SCHEMAS)
// and from the probe, and the list of what flipped is the policy text of record before this task (GOLDEN-POLICY.md, "What the
// guard cannot see") — never a table read off the code under test.
import { describe, expect, it } from "vitest";
import { CORE_EVENT_SCHEMAS } from "../core/events.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import { readCorpus, type GoldenCorpus, type GoldenEvent, type Recomputed } from "./golden.ts";
import { FLOOR_SEED_STRIDE } from "./golden-floor-streams.ts";
import { sweepBudget } from "./golden-budget.ts";
import {
  ablateEvents,
  CORE_TYPES,
  LINEUP_TYPES,
  OVERLAY_CLAIMS,
  OVERLAY_CONTROLS,
  eventToken,
  floorRequirement,
  kernelRecorder,
  moduleRecorder,
  recordedTokens,
  overlayVerdicts,
  staleOverlayClaims,
  statsRecorder,
  uncoveredUnpinned,
  type FloorToken,
  type OverlayClaim,
  type OverlayVerdict,
  type Recorder,
} from "./golden-floor.ts";

const corpora = new Map(builtinModules.map((m) => [m.key, readCorpus(m.key)] as const));
const corpusOf = (key: string): GoldenCorpus => {
  const c = corpora.get(key);
  if (c === undefined) throw new Error(`no corpus for ${key}`);
  return c;
};

/** How many claimed tokens the sport's own policy leaves possible: the ones a claim is held over. */
const claimedTokens = (module: (typeof builtinModules)[number], corpus: GoldenCorpus, claims: readonly OverlayClaim[] = OVERLAY_CLAIMS): number => {
  const impossible = floorRequirement(module, corpus).impossible;
  return claims.filter((c) => c.assertedFor(module)).reduce((n, c) => n + c.tokens.filter((t) => !impossible.has(t)).length, 0);
};

/** The two claims GF-2 T3 retired, as they stood (the control of the flip: the probe, under the module-only recorder, still holds
 *  them). They are test fixtures now: the production table no longer carries them. */
const RETIRED_STOPPAGE: OverlayClaim = {
  id: "stoppage",
  tokens: [eventToken("core.suspend"), eventToken("core.resume")],
  mode: "together",
  assertedFor: () => true,
  covers: (_m, _t, verdict) => verdict === "unpinned",
  reason: "kernel-owned: core.suspend / core.resume never reach module.apply, and the stoppage clock lives in the overlay the harness did not record",
};
const RETIRED_LINEUP: OverlayClaim = {
  id: "lineup",
  tokens: LINEUP_TYPES.map(eventToken),
  mode: "chain",
  assertedFor: (module) => module.onLineup === undefined,
  covers: (_m, _t, verdict) => verdict === "unpinned",
  reason: "kernel-owned squads: a module reacts to a lineup change only through onLineup, so one that declares none never sees it",
};
/** The award claim as it stood (every sport, nothing declared): the control of the T4 flip. A sport that declares an award key is
 *  where the probe, under the format-3 recorder, now finds it moving a recorded golden. */
const RETIRED_AWARD: OverlayClaim = {
  id: "award",
  tokens: [eventToken("core.award")],
  mode: "together",
  assertedFor: () => true,
  covers: (_m, _t, verdict) => verdict === "unpinned",
  reason: "an award reaches module.apply but every module folds it as `return state`, and the player statistics were not recorded, so nothing recorded depends on it",
};
const RETIRED = [RETIRED_STOPPAGE, RETIRED_LINEUP];

/** The award keys the module's OWN declaration lists (the expected sets below are the engine's, never typed here). */
const declaredAwards = (module: (typeof builtinModules)[number]): string[] => (module.playerStats?.awards ?? []).map((a) => a.key);

/** The verdict of every recorded token of a claim, per sport, under one recorder. */
const verdictsOf = (key: string, record: Recorder, claims: readonly OverlayClaim[]): Map<FloorToken, { verdict: OverlayVerdict; streams: number }> => {
  const module = builtinModules.find((m) => m.key === key)!;
  return overlayVerdicts(module, corpusOf(key), record, claims);
};

describe("golden floor — the overlay-unpinned class is declared, reasoned and derived", () => {
  it("the table holds exactly the two classes no recorded fact depends on, and the two GF-2 retired are gone", () => {
    // typed from the retirement ruling: a pause and a lineup change are in the recorded overlay since format 2
    expect(OVERLAY_CLAIMS.map((c) => c.id)).toEqual(["note", "award"]);
    expect(OVERLAY_CLAIMS.flatMap((c) => c.tokens)).not.toContain(eventToken("core.suspend"));
    expect(OVERLAY_CLAIMS.flatMap((c) => c.tokens)).not.toContain(eventToken("core.resume"));
    for (const type of LINEUP_TYPES) expect(OVERLAY_CLAIMS.flatMap((c) => c.tokens), type).not.toContain(eventToken(type));
  });

  it("every claim row names real core types, a reason, and applies to at least one sport; the note claim says nothing computes from a note (Q4)", () => {
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
    // the note claim applies everywhere; the award claim only where the sport declares no award key (its own declaration)
    const awardSports = builtinModules.filter((m) => declaredAwards(m).length === 0).length;
    expect(awardSports, "some sport declares an award and some does not: the claim is narrowed, not dropped").toBeGreaterThan(0);
    expect(awardSports).toBeLessThan(builtinModules.length);
    expect(applied).toBe(builtinModules.length + awardSports);
    expect(OVERLAY_CLAIMS.find((c) => c.id === "note")!.reason).toContain("nothing computes from a note");
  });

  it("the shipped corpora hold every claim: each claimed event is recorded and inert in each sport it applies to (swept, counted)", () => {
    let holds = 0;
    const stale: string[] = [];
    forEachSport(({ module, key }) => {
      stale.push(...staleOverlayClaims(module, corpusOf(key)));
      for (const claim of OVERLAY_CLAIMS) if (claim.assertedFor(module)) holds += claim.tokens.length;
    });
    expect(stale).toEqual([]);
    // one note per sport, one award where the sport declares no key for it
    expect(holds).toBe(builtinModules.length + builtinModules.filter((m) => declaredAwards(m).length === 0).length);
  }, 30_000);

  it("RETIRED stoppage: suspend and resume are unpinned under the module-only recorder and PINNED under the real format-2 recorder, in EVERY sport", () => {
    let flipped = 0;
    forEachSport(({ key }) => {
      const before = verdictsOf(key, moduleRecorder, [RETIRED_STOPPAGE]);
      const after = verdictsOf(key, kernelRecorder, [RETIRED_STOPPAGE]);
      for (const token of RETIRED_STOPPAGE.tokens) {
        expect(before.get(token)?.streams, `${key} ${token}: recorded`).toBeGreaterThan(0);
        expect(before.get(token)?.verdict, `${key} ${token} under the module-only recorder`).toBe("unpinned");
        expect(after.get(token)?.verdict, `${key} ${token} under the real recorder`).toBe("pinned");
        expect(after.get(token)?.streams, `${key} ${token}: same streams probed`).toBe(before.get(token)?.streams);
        flipped++;
      }
    });
    expect(flipped).toBe(builtinModules.length * 2);
  }, sweepBudget("probe"));

  it("the probe's DEFAULT recorder is the real one (format 3, a superset of format 2): with no recorder named, a retired class reads as pinned in every sport (overlayVerdicts and staleOverlayClaims)", () => {
    let checked = 0;
    forEachSport(({ key, module }) => {
      const verdicts = overlayVerdicts(module, corpusOf(key), undefined, [RETIRED_STOPPAGE]);
      for (const token of RETIRED_STOPPAGE.tokens) {
        expect(verdicts.get(token)?.verdict, `${key} ${token}`).toBe("pinned");
        checked++;
      }
      const stale = staleOverlayClaims(module, corpusOf(key), undefined, [RETIRED_STOPPAGE]);
      expect(stale.length, `${key}: the retired claim is stale under the default recorder`).toBeGreaterThan(0);
    });
    expect(checked).toBe(builtinModules.length * RETIRED_STOPPAGE.tokens.length);
  }, sweepBudget("probe"));

  it("RETIRED lineup: exactly boardgame, carrom and generic (every recorded type) and football's position change flip from unpinned to pinned; the other sports were pinned already", () => {
    // The set that was unpinned is the policy of record before this task: "inert in boardgame, carrom and generic (no onLineup,
    // every type), and core.lineup.position is inert in football too". It is typed here from that text, and the probe must agree.
    const wasUnpinned = (key: string, type: string): boolean => key === "boardgame" || key === "carrom" || key === "generic" || (key === "football" && type === "core.lineup.position");
    const flips: string[] = [];
    let probed = 0;
    forEachSport(({ key }) => {
      const before = verdictsOf(key, moduleRecorder, [RETIRED_LINEUP]);
      const after = verdictsOf(key, kernelRecorder, [RETIRED_LINEUP]);
      for (const type of LINEUP_TYPES) {
        const token = eventToken(type);
        const was = before.get(token)!;
        const now = after.get(token)!;
        if (was.verdict === "unrecorded") {
          expect(now.verdict, `${key} ${type}: recorded under neither`).toBe("unrecorded");
          continue; // a type the sport's policy never lets a stream record
        }
        probed++;
        expect(was.verdict === "unpinned", `${key} ${type}: unpinned under the module-only recorder iff the policy of record listed it`).toBe(wasUnpinned(key, type));
        expect(now.verdict, `${key} ${type} under the real recorder`).toBe("pinned");
        if (was.verdict === "unpinned") flips.push(`${key} ${type}`);
      }
    });
    expect(probed, "every recorded lineup type of every sport was probed").toBeGreaterThan(builtinModules.length * 3);
    expect(new Set(flips.map((f) => f.split(" ")[0])), "the sports that flip").toEqual(new Set(["boardgame", "carrom", "generic", "football"]));
    expect(flips.filter((f) => f.startsWith("football ")), "football flips on its position change only").toEqual(["football core.lineup.position"]);
    expect(flips.length).toBeGreaterThanOrEqual(7);
  }, sweepBudget("probe"));

  it("the retirement is DETECTED by the staleness check itself: under the real recorder every retired claim is stale in every sport it applied to, under the module-only recorder none is", () => {
    let stale = 0;
    let held = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      const under = (record: Recorder) => staleOverlayClaims(module, corpus, record, RETIRED);
      expect(under(moduleRecorder), `${key}: the retired claims were true before GF-2`).toEqual([]);
      const messages = under(kernelRecorder);
      const impossible = floorRequirement(module, corpus).impossible;
      for (const claim of RETIRED) {
        if (!claim.assertedFor(module)) continue;
        for (const token of claim.tokens) {
          if (impossible.has(token)) continue;
          expect(messages.filter((m) => m.includes(` ${token}: moves a recorded golden`)), `${key} ${token} goes stale`).toHaveLength(1);
          stale++;
        }
      }
      held += claimedTokens(module, corpus, RETIRED);
    });
    expect(stale).toBe(held);
    expect(stale).toBeGreaterThan(builtinModules.length * 2);
  }, sweepBudget("probe"));

  it("EVERY recorded core event whose ablation says 'unpinned' is covered by a claim: a note everywhere, an award exactly where the sport declares no key for it (swept per sport x token, counted)", () => {
    let probed = 0;
    let unpinned = 0;
    let loose = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      const r = uncoveredUnpinned(module, corpus);
      expect(r.uncovered, `${key}: an unpinned core event no claim covers`).toEqual([]);
      // the sweep reached EVERY core event the corpus records (read off the corpus, not off the probe)
      const recordedCore = [...recordedTokens(corpus)].filter((t) => t.startsWith("event:core."));
      expect(r.probed, `${key}: probed every recorded core event`).toBe(recordedCore.length);
      // what is still unpinned is what nothing computes from: a note, and an award the sport declares no key for (the engine's declaration)
      const expected = ["event:core.note", ...(declaredAwards(module).length === 0 ? ["event:core.award"] : [])].sort();
      const sheet = overlayVerdicts(module, corpus, statsRecorder, [], "all");
      expect([...sheet].filter(([, v]) => v.verdict === "unpinned").map(([t]) => t).sort(), `${key}: the events no recorded fact depends on`).toEqual(expected);
      expect(r.unpinned, key).toBe(expected.length);
      // the control: before format 3 an award moved no recorded field in ANY sport (this is what the flip is measured against)
      const before = overlayVerdicts(module, corpus, kernelRecorder, [], "all");
      expect([...before].filter(([, v]) => v.verdict === "unpinned").map(([t]) => t).sort(), `${key}: under the format-2 recorder`).toEqual(["event:core.award", "event:core.note"]);
      probed += r.probed;
      unpinned += r.unpinned;
      loose += expected.length;
    });
    expect(probed).toBeGreaterThan(builtinModules.length * 8);
    expect(unpinned).toBe(loose);
    expect(unpinned, "the award class narrowed: fewer unpinned than two per sport").toBeLessThan(builtinModules.length * 2);
  }, sweepBudget("probe"));

  it("RETIRED award: core.award is unpinned under the module-only and the format-2 recorders in EVERY sport, and PINNED under the real format-3 recorder exactly where the sport declares an award key", () => {
    const flipped: string[] = [];
    let steady = 0;
    forEachSport(({ module, key }) => {
      const token = eventToken("core.award");
      const was = verdictsOf(key, moduleRecorder, [RETIRED_AWARD]).get(token)!;
      const mid = verdictsOf(key, kernelRecorder, [RETIRED_AWARD]).get(token)!;
      const now = verdictsOf(key, statsRecorder, [RETIRED_AWARD]).get(token)!;
      expect(was.streams, `${key}: an award is recorded`).toBeGreaterThan(0);
      expect(was.verdict, `${key} under the module-only recorder`).toBe("unpinned");
      expect(mid.verdict, `${key} under the format-2 recorder`).toBe("unpinned");
      expect(now.streams, `${key}: same streams probed`).toBe(was.streams);
      if (declaredAwards(module).length > 0) {
        expect(now.verdict, `${key} declares an award: the stats rows record its credit`).toBe("pinned");
        flipped.push(key);
      } else {
        expect(now.verdict, `${key} declares none: the stats fold ignores the event`).toBe("unpinned");
        steady++;
      }
    });
    expect(flipped.length, "the sports that flip").toBeGreaterThan(0);
    expect(steady, "the sports that do not").toBeGreaterThan(0);
    expect(flipped.length + steady).toBe(builtinModules.length);
  }, sweepBudget("probe"));

  it("the award retirement is DETECTED by the staleness check itself: stale under the real recorder exactly where a key is declared, quiet under the format-2 recorder everywhere", () => {
    let stale = 0;
    let quiet = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      expect(staleOverlayClaims(module, corpus, kernelRecorder, [RETIRED_AWARD]), `${key}: the claim held before format 3`).toEqual([]);
      const messages = staleOverlayClaims(module, corpus, statsRecorder, [RETIRED_AWARD]);
      if (declaredAwards(module).length > 0) {
        expect(messages, `${key}: the claim goes stale`).toHaveLength(1);
        expect(messages[0], key).toContain(" event:core.award: moves a recorded golden");
        stale++;
      } else {
        expect(messages, `${key}: and holds`).toEqual([]);
        quiet++;
      }
      // the PRODUCTION table is never stale: it asserts the award claim only where it holds
      expect(staleOverlayClaims(module, corpus), `${key}: production claims hold`).toEqual([]);
    });
    expect(stale).toBeGreaterThan(0);
    expect(quiet).toBeGreaterThan(0);
  }, sweepBudget("probe"));

  it("core.settle is recorded and PINNED in every sport: it is the one event whose every recorded instance is struck once, so the probe must ablate the void with it", () => {
    let probed = 0;
    forEachSport(({ module, key }) => {
      const verdict = overlayVerdicts(module, corpusOf(key), kernelRecorder, [], "all").get(eventToken("core.settle"));
      expect(verdict?.streams, `${key}: a stream records a settle`).toBeGreaterThan(0);
      expect(verdict?.verdict, `${key}: core.settle moves a recorded golden`).toBe("pinned");
      // the settle stream strikes its first settle, so a probe that refused a struck target would have answered "unrecorded"
      const struck = corpusOf(key).streams.filter((s) => s.events.some((e, i) => e.type === "core.settle" && s.events.some((x) => x.voids === `e-${i}`)));
      expect(struck.length, `${key}: a recorded settle is struck by a void`).toBeGreaterThan(0);
      probed++;
    });
    expect(probed).toBe(builtinModules.length);
  }, sweepBudget("probe"));

  it("the sweep has teeth: a claim table that forgets a class names it in every sport", () => {
    const withoutNote = OVERLAY_CLAIMS.filter((c) => c.id !== "note");
    let named = 0;
    forEachSport(({ module, key }) => {
      const missing = uncoveredUnpinned(module, corpusOf(key), undefined, withoutNote).uncovered;
      expect(missing.some((m) => m.startsWith(`${key} event:core.note:`)), `${key} names core.note`).toBe(true);
      named++;
    });
    expect(named).toBe(builtinModules.length);
  }, sweepBudget("probe"));

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

  // The probe answers both ways whatever the claim table holds: these use the retired lineup row only as a CHAIN definition, under
  // the module-only recorder, because they are about how `overlayVerdicts` credits each type with what it adds.
  it("the probe answers 'pinned' for a lineup event once a module reacts to it (a boardgame given an onLineup that writes state)", () => {
    const boardgame = builtinModules.find((m) => m.key === "boardgame")!;
    expect(boardgame.onLineup).toBeUndefined();
    // (the kernel also offers the hook the INITIAL squads, so a hook that merely stamps the state is equal at every step;
    // one that writes the squads it was handed differs exactly when a lineup event changed them)
    const reacting = { ...boardgame, onLineup: (state: object, squads: unknown) => ({ ...state, squadDigest: JSON.stringify(squads) }) } as unknown as typeof boardgame;
    const verdicts = overlayVerdicts(reacting, corpusOf("boardgame"), moduleRecorder, [RETIRED_LINEUP]);
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
    const verdicts = overlayVerdicts(onFieldOnly, corpusOf("boardgame"), moduleRecorder, [RETIRED_LINEUP]);
    const verdictOf = (type: string) => verdicts.get(eventToken(type))?.verdict;
    expect(verdictOf("core.lineup.position"), "a position change moves nobody on or off the field").toBe("unpinned");
    expect(verdictOf("core.lineup.substitution")).toBe("pinned");
    expect(verdictOf("core.lineup.retirement")).toBe("pinned");
    expect(verdictOf("core.lineup.entry")).toBe("pinned");
  });

  it("an unrecorded event is 'unrecorded', never 'unpinned' (an empty corpus claims nothing, so no claim can hold vacuously)", () => {
    let checked = 0;
    forEachSport(({ module, key }) => {
      const empty: GoldenCorpus = { ...corpusOf(key), streams: [] };
      const verdicts = overlayVerdicts(module, empty);
      for (const claim of OVERLAY_CLAIMS) for (const token of claim.tokens) expect(verdicts.get(token)?.verdict, `${key} ${token}`).toBe("unrecorded");
      const stale = staleOverlayClaims(module, empty);
      const applicable = claimedTokens(module, empty);
      expect(stale.length, `${key}: every claimed, possible token is stale when nothing is recorded`).toBe(applicable);
      expect(applicable, key).toBeGreaterThan(0);
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });

  it("a claimed event that cannot be probed (a recorder that throws) is stale, never silently held", () => {
    const module = builtinModules[0]!;
    const broken: Recorder = () => {
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

describe("ablationProbe — every clause of the format-2 comparison is reached (a comparison nothing kills is not tested)", () => {
  // single-sport: the clauses compare recorded columns and digests, whichever sport recorded them; badminton's corpus holds a note
  // stream with play before and after the note (asserted below), and the all-sports sweeps are the tests above
  const badminton = builtinModules.find((m) => m.key === "badminton")!;
  const corpus = corpusOf("badminton");
  const noted = corpus.streams.find((s) => s.events.some((e) => e.type === "core.note"))!;
  const noteAt = noted.events.findIndex((e) => e.type === "core.note");
  const only = (stream: typeof noted): GoldenCorpus => ({ ...corpus, streams: [stream] });
  const noteClaim = OVERLAY_CLAIMS.filter((c) => c.id === "note");
  const verdictOf = (recorder: Recorder, c: GoldenCorpus = only(noted)) => overlayVerdicts(badminton, c, recorder, noteClaim).get(eventToken("core.note"))!;
  /** The real recorder, with one field of the recording that CONTAINS the event under test perturbed (the ablated ledger is
   *  recorded unperturbed, so any difference the probe sees is the perturbation). */
  const perturbed = (patch: (rec: Recomputed) => Recomputed): Recorder => (m, raw, events, lineups) => {
    const rec = kernelRecorder(m, raw, events, lineups);
    return events.some((e) => e.type === "core.note") ? patch(rec) : rec;
  };
  const withSummary = (index: number): Recorder => perturbed((rec) => ({ ...rec, summaries: rec.summaries!.map((d, i) => (i === index ? "#0000000000000000" : d)) }));
  const withColumn = (column: "squads" | "stoppage", index: number, value: string): Recorder =>
    perturbed((rec) => ({ ...rec, dense: { ...rec.dense!, steps: { ...rec.dense!.steps, [column]: rec.dense!.steps[column].map((v, i) => (i === index ? value : v)) } } }));

  it("precondition: the note stream has steps before the note (retained) and the unperturbed probe says 'unpinned' over it", () => {
    expect(noteAt).toBeGreaterThan(0);
    expect(noted.events.length).toBeGreaterThan(noteAt + 1);
    const v = verdictOf(kernelRecorder);
    expect(v.streams).toBe(1);
    expect(v.verdict).toBe("unpinned");
  });

  it("a summary digest that differs at a RETAINED step moves the verdict", () => {
    expect(verdictOf(withSummary(0)).verdict).toBe("pinned");
    expect(verdictOf(withSummary(noteAt + 1)).verdict, "a step after the note").toBe("pinned");
  });

  it("a summary digest that differs at the ablated event's OWN step moves the verdict (the event is not neutral)", () => {
    expect(verdictOf(withSummary(noteAt)).verdict).toBe("pinned");
  });

  it("an overlay column that differs at a RETAINED step moves the verdict, whichever column", () => {
    expect(verdictOf(withColumn("squads", 0, `"#0000000000000000"`)).verdict).toBe("pinned");
    expect(verdictOf(withColumn("stoppage", noteAt + 1, `{"eventId":"e-99"}`)).verdict).toBe("pinned");
  });

  it("an overlay column that differs at the ablated event's OWN step moves the verdict (a note that opened a stoppage would not be inert)", () => {
    expect(verdictOf(withColumn("stoppage", noteAt, `{"eventId":"e-99"}`)).verdict).toBe("pinned");
  });

  it("a stoppage that the removal RENUMBERS is not a difference: the suspend sits at e-4 with a note in front of it and at e-3 without, and the probe maps the id", () => {
    const walk = corpus.streams.find((s) => s.seed < FLOOR_SEED_STRIDE && s.events.length >= 6 && s.events.every((e) => !e.type.startsWith("core.") || e.type === "core.start"))!;
    const note: GoldenEvent = { type: "core.note", payload: { text: "before the pause" } };
    const ledger: GoldenEvent[] = [
      walk.events[0]!,
      note,
      walk.events[1]!,
      walk.events[2]!,
      { type: "core.suspend", payload: { reason: "floodlight failure" } },
      { type: "core.resume", payload: {} },
      ...walk.events.slice(3),
    ];
    const rec = kernelRecorder(badminton, corpus.configs[walk.config], ledger, walk.lineups);
    expect(rec.dense!.steps.stoppage[4], "the stoppage names the suspend at e-4").toContain(`"eventId":"e-4"`);
    const v = verdictOf(kernelRecorder, only({ ...walk, events: ledger }));
    expect(v.streams).toBe(1);
    expect(v.verdict, "ablating the note moves the suspend from e-4 to e-3 and nothing else").toBe("unpinned");
  });

  it("a note BEFORE the start sits at step 0, where the neutral reference is the pre-match headline: unperturbed it is inert, and a digest that is not the pre-match one at step 0 is a difference", () => {
    const walk = corpus.streams.find((s) => s.seed < FLOOR_SEED_STRIDE && s.events.length >= 3)!;
    const ledger: GoldenEvent[] = [{ type: "core.note", payload: { text: "before anything" } }, ...walk.events];
    const lone = only({ ...walk, events: ledger });
    const v = verdictOf(kernelRecorder, lone);
    expect(v.streams).toBe(1);
    expect(v.verdict, "a note at step 0 changes neither the state, the overlay nor the headline").toBe("unpinned");
    expect(verdictOf(withSummary(0), lone).verdict, "its own step is step 0: compared with the pre-match headline, not with step -1 of nothing").toBe("pinned");
  });

  it("but an id whose event is GONE is a difference: ablating the suspend itself is pinned", () => {
    const suspend = [{ id: "stoppage", tokens: [eventToken("core.suspend"), eventToken("core.resume")] as const, mode: "together" as const, assertedFor: () => true, covers: () => true, reason: "x".repeat(50) }];
    const v = overlayVerdicts(badminton, only(noted), kernelRecorder, suspend).get(eventToken("core.suspend"))!;
    expect(v.verdict).toBe("pinned");
  });

  it("a MODULE state that differs at a retained step moves the verdict by itself — the overlay, the summary and the outcome all agree (the narrower, format-1 clause still stands under format 2)", () => {
    const withState = (index: number): Recorder => perturbed((rec) => ({ ...rec, states: rec.states.map((st, i) => (i === index ? `{"perturbed":true}` : st)) }));
    expect(verdictOf(kernelRecorder).verdict, "control: unperturbed").toBe("unpinned");
    expect(verdictOf(withState(0)).verdict, "the first retained step").toBe("pinned");
    expect(verdictOf(withState(noteAt + 1)).verdict, "a step after the note").toBe("pinned");
  });

  it("a void that WENT WITH its ablated target is not an ablated event: its own step re-folds the ledger without the target, which is the change under test", () => {
    const walk = corpus.streams.find((s) => s.seed < FLOOR_SEED_STRIDE && s.events.length >= 6 && s.events.every((e) => !e.type.startsWith("core.") || e.type === "core.start"))!;
    // [start, note, void(note), ...the rest of the walk]: the note and its void both leave when the note is ablated
    const ledger: GoldenEvent[] = [walk.events[0]!, { type: "core.note", payload: { text: "mis-tap" } }, { type: "core.void", payload: {}, voids: "e-1" }, ...walk.events.slice(1)];
    const lone = only({ ...walk, events: ledger });
    const real = kernelRecorder(badminton, corpus.configs[walk.config], ledger, walk.lineups);
    expect(real.summaries![2], "precondition: really recorded, the void's step reads as the step before it").toBe(real.summaries![1]);
    expect(verdictOf(kernelRecorder, lone).streams).toBe(1);
    expect(verdictOf(kernelRecorder, lone).verdict, "control: a note and its void are inert").toBe("unpinned");
    // a digest at the VOID's step (index 2) that is not the step before it is no evidence about the note — the void is not compared
    expect(verdictOf(withSummary(2), lone).verdict, "perturbing the collateral void's own step does not move the verdict").toBe("unpinned");
    // while the same perturbation at the NOTE's own step (index 1) does: the ablated event itself must be neutral
    expect(verdictOf(withSummary(1), lone).verdict, "perturbing the note's own step does").toBe("pinned");
  });
});

describe("ablateEvents — the ledger without a set of types, voids renumbered to where their targets now sit", () => {
  const e = (type: string, voids?: string): GoldenEvent => ({ type, payload: {}, ...(voids === undefined ? {} : { voids }) });

  it("removing events in FRONT of a void's target shifts the void's id by exactly the number removed before the target", () => {
    // 0 start, 1 note, 2 goal, 3 note, 4 goal, 5 void->e-4 (the second goal)
    const ledger = [e("core.start"), e("core.note"), e("x.goal"), e("core.note"), e("x.goal"), e("core.void", "e-4")];
    const out = ablateEvents(ledger, new Set(["core.note"]));
    expect(out.kept.map((k) => k.type)).toEqual(["core.start", "x.goal", "x.goal", "core.void"]);
    expect(out.origin).toEqual([0, 2, 4, 5]);
    // the second goal moved from index 4 to index 2
    expect(out.kept[3]?.voids).toBe("e-2");
    // and a void whose target is not shifted keeps its id
    const early = ablateEvents([e("core.start"), e("x.goal"), e("core.void", "e-1"), e("core.note")], new Set(["core.note"]));
    expect(early.kept[2]?.voids).toBe("e-1");
  });

  it("a void whose target is removed goes with it (it struck nothing that is left), and the survivors' ids and origins follow", () => {
    const ledger = [e("core.start"), e("x.goal"), e("core.void", "e-1"), e("x.point"), e("x.goal"), e("core.void", "e-3")];
    const out = ablateEvents(ledger, new Set(["x.goal"]));
    expect(out.kept.map((k) => k.type)).toEqual(["core.start", "x.point", "core.void"]);
    expect(out.origin).toEqual([0, 3, 5]);
    // the surviving void struck the point, which moved from index 3 to index 1
    expect(out.kept[2]?.voids).toBe("e-1");
  });

  it("a void of a void whose target is removed goes too (the chain is followed), and a void of something that stays is kept", () => {
    const ledger = [e("core.start"), e("x.goal"), e("core.void", "e-1"), e("core.void", "e-2"), e("x.point"), e("core.void", "e-4")];
    const out = ablateEvents(ledger, new Set(["x.goal"]));
    expect(out.kept.map((k) => k.type)).toEqual(["core.start", "x.point", "core.void"]);
    expect(out.origin).toEqual([0, 4, 5]);
    expect(out.kept[2]?.voids).toBe("e-1");
  });

  it("an empty removal set returns the ledger unchanged, and the input is never mutated", () => {
    const ledger = [e("core.start"), e("x.goal"), e("core.void", "e-1")];
    const before = JSON.stringify(ledger);
    expect(ablateEvents(ledger, new Set()).kept).toEqual(ledger);
    expect(ablateEvents(ledger, new Set()).origin).toEqual([0, 1, 2]);
    expect(JSON.stringify(ledger)).toBe(before);
  });
});
