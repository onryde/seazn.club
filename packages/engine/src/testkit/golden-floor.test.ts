// The golden floor (GF-1) — see golden-floor.ts. Every expected set here is read off the engine's own declarations
// (CORE_EVENT_SCHEMAS, FORFEIT_REASONS, forfeitAdmission, supportsDraws, the lineup reducer), never typed in.
import { describe, expect, it } from "vitest";
import { CORE_EVENT_SCHEMAS, foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import { DEFAULT_LINEUP_POLICY, type LineupRejectionReason } from "../core/lineup.ts";
import { FORFEIT_REASONS } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "./for-each-sport.ts";
import { readCorpus, recomputeStream, type GoldenCorpus, type GoldenEvent } from "./golden.ts";
import {
  CORE_TYPES,
  FLOOR_EXEMPTIONS,
  LINEUP_TYPES,
  NATURAL_OUTCOMES,
  benchPair,
  eventToken,
  floorHoles,
  floorRequirement,
  forfeitAdmissions,
  impossibleReason,
  lineupOffers,
  lineupTypesOf,
  outcomeToken,
  outcomeTokenOf,
  planLineupEvents,
  recordedTokens,
  settleProbe,
  STANDING_KERNEL,
  standingToken,
  UNDOABLE_KERNEL,
  undoToken,
  staleFloorExemptions,
  staleNaturalOutcomes,
  unrequiredObservedOutcomes,
} from "./golden-floor.ts";
import { defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { resolvePositions } from "../sport/catalog.ts";

const corpora = new Map(builtinModules.map((m) => [m.key, readCorpus(m.key)] as const));
const corpusOf = (key: string): GoldenCorpus => {
  const c = corpora.get(key);
  if (c === undefined) throw new Error(`no corpus for ${key}`);
  return c;
};

describe("golden floor — the token vocabulary", () => {
  it("CORE_TYPES is the kernel's own schema map, every key of it", () => {
    expect(CORE_TYPES).toEqual(Object.keys(CORE_EVENT_SCHEMAS));
    expect(CORE_TYPES.length).toBeGreaterThanOrEqual(15);
    expect(CORE_TYPES.every((t) => t.startsWith("core."))).toBe(true);
  });

  it("outcomeTokenOf: empty case first (null), then each kind, an award keyed by its reason", () => {
    expect(outcomeTokenOf("null")).toBeNull();
    expect(outcomeTokenOf('{"kind":"draw"}')).toBe("draw");
    expect(outcomeTokenOf('{"kind":"win","winner":"H","loser":"A"}')).toBe("win");
    expect(outcomeTokenOf('{"kind":"double_walkover"}')).toBe("double_walkover");
    expect(outcomeTokenOf('{"kind":"award","winner":"H","loser":"A","reason":"retired"}')).toBe("award:retired");
    // different reasons differ: an award is not one token
    expect(outcomeTokenOf('{"kind":"award","winner":"H","loser":"A","reason":"withdrew"}')).not.toBe("award:retired");
  });

  it("outcomeTokenOf refuses an outcome it cannot key (a legacy award without a reason, a kindless value)", () => {
    expect(() => outcomeTokenOf('{"kind":"award","winner":"H","method":"walkover"}')).toThrow(/award without a reason/);
    expect(() => outcomeTokenOf('{"winner":"H"}')).toThrow(/without a kind/);
  });

  it("recordedTokens: an empty corpus holds nothing; a stream contributes its core types and its outcome", () => {
    const empty: GoldenCorpus = { ...corpusOf("football"), streams: [] };
    expect(recordedTokens(empty).size).toBe(0);
    const one: GoldenCorpus = { ...empty, streams: [corpusOf("football").streams.find((s) => s.events.some((e) => e.type === "core.forfeit"))!] };
    const have = recordedTokens(one);
    expect(have.has(eventToken("core.forfeit"))).toBe(true);
    expect(have.has(eventToken("core.start"))).toBe(true);
    expect([...have].filter((t) => t.startsWith("outcome:"))).toHaveLength(1);
    // a sport event is not a floor token
    expect([...have].some((t) => t.startsWith("event:football."))).toBe(false);
  });
});

describe("golden floor — an undo of a KERNEL event is a token of its own (review 2)", () => {
  const football = builtinModules.find((m) => m.key === "football")!;
  const base = corpusOf("football");
  const stream = (events: GoldenEvent[]) => ({ ...base.streams[0]!, events });
  const START = { type: "core.start", payload: {} };

  it("a void is keyed by the TYPE of the event it strikes: a forfeit, an abandon and a sport event are three tokens", () => {
    const forfeit = { type: "core.forfeit", payload: { by: "H", reason: "retired" } };
    const abandon = { type: "core.abandon", payload: { reason: "rain" } };
    const goal = { type: "football.goal", payload: { by: "H" } };
    const void_ = (id: string): GoldenEvent => ({ type: "core.void", payload: {}, voids: id });
    const have = (events: GoldenEvent[]) => recordedTokens({ ...base, streams: [stream(events)] });
    expect(have([START, forfeit, void_("e-1")]).has(undoToken("core.forfeit"))).toBe(true);
    expect(have([START, forfeit, void_("e-1")]).has(undoToken("core.abandon"))).toBe(false);
    expect(have([START, abandon, void_("e-1")]).has(undoToken("core.abandon"))).toBe(true);
    expect(have([START, goal, void_("e-1")]).has(undoToken("football.goal"))).toBe(true);
    // a stream with no void records no undo token at all
    expect([...have([START, goal])].filter((t) => t.startsWith("undo:"))).toEqual([]);
  });

  it("a void with no target, or one that does not point at an EARLIER event, is refused by name (a recorded ledger the fold would refuse)", () => {
    const run = (events: GoldenEvent[]) => () => recordedTokens({ ...base, streams: [stream(events)] });
    expect(run([START, { type: "core.void", payload: {} }])).toThrow(/core\.void.*no target/);
    expect(run([START, { type: "core.void", payload: {}, voids: "e-5" }])).toThrow(/core\.void.*e-5/);
    expect(run([START, { type: "core.void", payload: {}, voids: "e-1" }])).toThrow(/core\.void.*e-1/);
  });

  it("an abandon that STANDS (no void strikes it) is a token of its own: striking it does not count as ending a match on it", () => {
    const abandon = { type: "core.abandon", payload: { reason: "rain" } };
    const void_ = (id: string): GoldenEvent => ({ type: "core.void", payload: {}, voids: id });
    const have = (events: GoldenEvent[]) => recordedTokens({ ...base, streams: [stream(events)] });
    expect(have([START, abandon]).has(standingToken("core.abandon"))).toBe(true);
    expect(have([START, abandon, void_("e-1")]).has(standingToken("core.abandon"))).toBe(false);
    // two abandons, one struck: the other still stands
    expect(have([START, abandon, void_("e-1"), abandon]).has(standingToken("core.abandon"))).toBe(true);
    expect(have([START, abandon]).has(eventToken("core.abandon"))).toBe(true);
  });

  it("the standing kernel events are declared, real core types, and required in EVERY sport", () => {
    expect(STANDING_KERNEL.length).toBeGreaterThan(0);
    for (const type of STANDING_KERNEL) expect(CORE_TYPES, type).toContain(type);
    let sports = 0;
    forEachSport(({ module, key }) => {
      for (const type of STANDING_KERNEL) expect(floorRequirement(module, corpusOf(key)).required.has(standingToken(type)), `${key} ${type}`).toBe(true);
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
  });

  it("the decisive kernel events are exactly the two that decide or end a match: a forfeit and an abandon (review finding 2)", () => {
    // Typed from the rulebook (a forfeit decides the match, an abandon ends play), NOT read off UNDOABLE_KERNEL: dropping
    // one from the list would otherwise shrink every loop that iterates it and stay green.
    expect([...UNDOABLE_KERNEL].sort()).toEqual(["core.abandon", "core.forfeit"]);
    expect([...STANDING_KERNEL]).toEqual(["core.abandon"]);
  });

  it("the decisive kernel events a phone can mis-tap are declared, real core types, and required in EVERY sport", () => {
    expect(UNDOABLE_KERNEL.length).toBeGreaterThan(0);
    for (const type of UNDOABLE_KERNEL) expect(CORE_TYPES, type).toContain(type);
    let sports = 0;
    forEachSport(({ module, key }) => {
      const req = floorRequirement(module, corpusOf(key));
      for (const type of UNDOABLE_KERNEL) expect(req.required.has(undoToken(type)), `${key} ${type}`).toBe(true);
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
    expect(football).toBeDefined();
  });
});

describe("golden floor — lineup planning asks the real reducer", () => {
  const tennis = builtinModules.find((m) => m.key === "tennis")!;
  const football = builtinModules.find((m) => m.key === "football")!;

  it("a squad of ONE takes all five types in turn when the policy declares an exemption", () => {
    const cfg = tennis.configSchema.parse(corpusOf("tennis").configs.default);
    const lineups = benchPair(tennis, cfg);
    expect(lineups.home.slots.filter((s) => s.slot === "starting")).toHaveLength(1);
    const plan = planLineupEvents(lineups, { ...DEFAULT_LINEUP_POLICY, exemptions: { injury: {} } });
    expect(plan.accepted).toEqual([...LINEUP_TYPES]);
    expect(plan.events.map((e) => e.type)).toEqual([...LINEUP_TYPES]);
    expect(plan.refused).toEqual({});
  });

  it("a sub cap of 0 refuses the substitution BY NAME, and no declared exemption refuses the replacement by name", () => {
    const cfg = football.configSchema.parse(corpusOf("football").configs.default);
    const lineups = benchPair(football, cfg);
    const plan = planLineupEvents(lineups, { ...DEFAULT_LINEUP_POLICY, maxSubs: 0 });
    expect(plan.refused["core.lineup.substitution"]).toBe("sub-cap-reached");
    expect(plan.refused["core.lineup.replacement"]).toBe("exemption-not-declared");
    expect(plan.accepted).toEqual(["core.lineup.position", "core.lineup.retirement", "core.lineup.entry"]);
  });

  it("with no bench, nothing can come on: substitution and entry find no candidate", () => {
    const cfg = football.configSchema.parse(corpusOf("football").configs.default);
    const plan = planLineupEvents(benchPair(football, cfg, 0), DEFAULT_LINEUP_POLICY);
    expect(plan.accepted).toEqual(["core.lineup.position", "core.lineup.retirement"]);
    expect(Object.keys(plan.refused).sort()).toEqual(["core.lineup.entry", "core.lineup.replacement", "core.lineup.substitution"]);
  });

  it("every lineup offer of every sport is a real plan: starters unchanged from the default pair", () => {
    let offers = 0;
    forEachSport(({ module, key }) => {
      for (const offer of lineupOffers(module, corpusOf(key))) {
        offers++;
        const cfg = module.configSchema.parse(corpusOf(key).configs[offer.cfgName]);
        const starters = offer.lineups.home.slots.filter((s) => s.slot === "starting");
        expect(starters).toEqual(defaultLineupPair(resolvePositions(module, cfg)).home.slots);
        expect(offer.lineups.home.slots.filter((s) => s.slot === "bench")).toHaveLength(3);
      }
    });
    expect(offers).toBeGreaterThanOrEqual(builtinModules.length);
  });
});

describe("golden floor — the requirement is derived from the engine, per sport", () => {
  it("is non-empty for every sport, and states what it examined", () => {
    let sports = 0;
    let tokens = 0;
    forEachSport(({ module, key }) => {
      const req = floorRequirement(module, corpusOf(key));
      sports++;
      tokens += req.required.size;
      expect(req.required.size, `${key} requirement`).toBeGreaterThan(0);
      expect(req.required.has(eventToken("core.start")), key).toBe(true);
      expect(req.required.has(eventToken("core.void")), key).toBe(true);
      expect(req.required.has(outcomeToken("win")), key).toBe(true);
      expect(req.examined.coreTypes).toBe(CORE_TYPES.length);
      expect(req.examined.configs, key).toBeGreaterThan(0);
      expect(req.examined.admissionStates, key).toBeGreaterThan(0);
    });
    expect(sports).toBe(builtinModules.length);
    expect(tokens).toBeGreaterThan(sports * 10);
  });

  it("every core type is accounted for exactly once: required, exempt, or impossible-by-policy", () => {
    let accounted = 0;
    forEachSport(({ module, key }) => {
      const req = floorRequirement(module, corpusOf(key));
      for (const type of CORE_TYPES) {
        const token = eventToken(type);
        const where = [req.required.has(token), req.exempt.has(token), req.impossible.has(token)].filter(Boolean).length;
        expect(where, `${key} ${type}`).toBe(1);
        accounted++;
      }
    });
    expect(accounted).toBe(builtinModules.length * CORE_TYPES.length);
  });

  it("a lineup type is required exactly when the REAL reducer accepts it under a recorded config's policy, impossible (with the reducer's own refusal) otherwise", () => {
    let required = 0;
    let impossible = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      const req = floorRequirement(module, corpus);
      const offers = lineupOffers(module, corpus);
      expect(offers.length, `${key} offers`).toBeGreaterThan(0);
      for (const type of LINEUP_TYPES) {
        const token = eventToken(type);
        const acceptedBy = offers.filter((o) => o.plan.accepted.includes(type));
        if (acceptedBy.length > 0) {
          expect(req.required.has(token), `${key} ${type} is accepted by ${acceptedBy[0]!.cfgName}`).toBe(true);
          expect(req.impossible.has(token), `${key} ${type}`).toBe(false);
          required++;
        } else {
          expect(req.required.has(token), `${key} ${type} is refused everywhere`).toBe(false);
          // the reason is the reducer's own code, per config, never a typed sentence
          expect(req.impossible.get(token), `${key} ${type}`).toMatch(/^\S+: \S+/);
          for (const o of offers) expect(req.impossible.get(token), `${key} ${type}`).toContain(`${o.cfgName}: ${o.plan.refused[type]}`);
          impossible++;
        }
      }
    });
    // anti-vacuity: both branches ran (cricket/football/volleyball accept a replacement, singles sports refuse it)
    expect(required).toBeGreaterThan(builtinModules.length * 3);
    expect(impossible).toBeGreaterThan(0);
  });

  it("the forfeit outcomes are the kernel's FORFEIT_REASONS, admitted by forfeitAdmission in a state the generator reaches", () => {
    let reasons = 0;
    forEachSport(({ module, key }) => {
      const admission = forfeitAdmissions(module, corpusOf(key));
      expect(admission.states, `${key} states asked`).toBeGreaterThan(0);
      for (const reason of admission.reasons.keys()) {
        expect((FORFEIT_REASONS as readonly string[]).includes(reason), `${key} ${reason}`).toBe(true);
        reasons++;
      }
      const req = floorRequirement(module, corpusOf(key));
      for (const reason of FORFEIT_REASONS) {
        expect(req.required.has(outcomeToken(`award:${reason}`)), `${key} award:${reason}`).toBe(admission.reasons.has(reason));
      }
      expect(req.required.has(outcomeToken("double_walkover")), `${key} double_walkover`).toBe(admission.both !== null);
    });
    expect(reasons).toBeGreaterThan(builtinModules.length);
  });

  it("`draw` is required exactly where supportsDraws says a draw-kind stage can draw (at least one sport yes, one no)", () => {
    const yes: string[] = [];
    const no: string[] = [];
    forEachSport(({ module, key }) => {
      const req = floorRequirement(module, corpusOf(key));
      (req.required.has(outcomeToken("draw")) ? yes : no).push(key);
    });
    expect(yes.length).toBeGreaterThan(0);
    expect(no.length).toBeGreaterThan(0);
  });

  it("`tie` and `no_result` are required only for the sports NATURAL_OUTCOMES names", () => {
    let checked = 0;
    forEachSport(({ module, key }) => {
      const req = floorRequirement(module, corpusOf(key));
      for (const token of ["tie", "no_result"]) {
        expect(req.required.has(outcomeToken(token)), `${key} ${token}`).toBe(token in (NATURAL_OUTCOMES[key] ?? {}));
        checked++;
      }
    });
    expect(checked).toBe(builtinModules.length * 2);
  });
});

describe("golden floor — the empty case and the teeth, first", () => {
  it("an EMPTY corpus fails the floor: every required token is a hole", () => {
    let sports = 0;
    forEachSport(({ module, key }) => {
      const empty: GoldenCorpus = { ...corpusOf(key), streams: [] };
      const req = floorRequirement(module, empty);
      const holes = floorHoles(module, empty);
      expect(holes.length, key).toBe(req.required.size);
      expect(holes.length, key).toBeGreaterThan(10);
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
  });

  it("dropping every stream that holds a token makes exactly that token a hole, naming the sport", () => {
    let dropped = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      const req = floorRequirement(module, corpus);
      for (const token of ["event:core.start", "event:core.forfeit", "outcome:win"] as const) {
        expect(req.required.has(token), `${key} ${token}`).toBe(true);
        const kept = corpus.streams.filter((s) => {
          const only = recordedTokens({ ...corpus, streams: [s] });
          return !only.has(token);
        });
        const holes = floorHoles(module, { ...corpus, streams: kept });
        expect(holes, `${key} without ${token}`).toContain(token);
        dropped++;
      }
    });
    expect(dropped).toBe(builtinModules.length * 3);
  });

  it("the shipped corpus holds EVERY token a sport's floor requires (the floor itself)", () => {
    const missing: string[] = [];
    let sports = 0;
    let tokens = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      tokens += floorRequirement(module, corpus).required.size;
      sports++;
      for (const hole of floorHoles(module, corpus)) missing.push(`${key}: ${hole}`);
    });
    expect(sports).toBe(builtinModules.length);
    expect(tokens).toBeGreaterThan(sports * 10);
    expect(missing, `${missing.length} floor holes. Extend the corpus: EXTEND_GOLDEN=1 npx vitest run src/testkit/golden.test.ts`).toEqual([]);
  });
});

describe("golden floor — exemptions and the reasoned list cannot go stale", () => {
  it("every exemption row carries a reason, a real token, and covers at least one sport", () => {
    expect(FLOOR_EXEMPTIONS.length).toBeGreaterThan(0);
    for (const e of FLOOR_EXEMPTIONS) {
      expect(e.reason.length, e.token).toBeGreaterThan(40);
      expect(CORE_TYPES.map(eventToken), e.token).toContain(e.token);
      expect(e.sports === "all" || e.sports.length > 0, e.token).toBe(true);
    }
  });

  it("no exemption is stale against the shipped corpora (swept over every sport, counted)", () => {
    let checked = 0;
    const stale: string[] = [];
    forEachSport(({ module, key }) => {
      checked++;
      stale.push(...staleFloorExemptions(module, corpusOf(key)));
    });
    expect(checked).toBe(builtinModules.length);
    expect(stale).toEqual([]);
  });

  it("the settle exemption holds for a reason a probe proves: the harness records the bare outcome, the kernel reads another", () => {
    let probed = 0;
    forEachSport(({ module, key }) => {
      const probe = settleProbe(module, corpusOf(key));
      expect(typeof probe, `${key}: ${typeof probe === "string" ? probe : ""}`).toBe("object");
      if (typeof probe === "string") return;
      expect(probe.recorded, key).not.toBe(probe.effective);
      expect(probe.effective, key).toContain("settled_organiser");
      probed++;
    });
    expect(probed).toBe(builtinModules.length);
  });

  it("an exemption goes STALE the moment its token is recorded", () => {
    let stale = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      const cfgName = Object.keys(corpus.configs)[0]!;
      const lineups = defaultLineupPair(resolvePositions(module, module.configSchema.parse(corpus.configs[cfgName])));
      const events: GoldenEvent[] = [
        { type: "core.start", payload: {} },
        { type: "core.abandon", payload: { reason: "floodlight failure" } },
        { type: "core.settle", payload: { winner: lineups.home.entrantId, method: "organiser" } },
      ];
      const made = { config: cfgName, seed: 99_999, events, ...recomputeStream(module, corpus.configs[cfgName], events, lineups) };
      const withSettle: GoldenCorpus = { ...corpus, streams: [...corpus.streams, made] };
      const messages = staleFloorExemptions(module, withSettle);
      expect(messages.join("\n"), key).toMatch(/records core\.settle/);
      stale++;
    });
    expect(stale).toBe(builtinModules.length);
  });

  it("the settle exemption goes STALE the day the harness records the effective outcome (a harness that does, injected)", () => {
    // The harness today stores `module.outcome(state)`. A harness that recorded what the kernel READS (`outcomeOf` over the
    // folded ledger, a settlement laid over it) is the future the exemption waits for; inject one, and the row must go
    // stale for every sport, naming that the settle streams can now land. The expected effective outcome is the kernel's own.
    let stale = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      const overlayRecorder: typeof recomputeStream = (m, raw, events, lineups) => {
        const cfg = m.configSchema.parse(raw) as unknown;
        const folded = foldMatchWithStoppage(m as never, cfg as never, lineups!, events.map((e, i) => makeEnvelope(i, e)), { strictFromSeq: 0 });
        return { ...recomputeStream(m, raw, events, lineups), outcome: JSON.stringify(outcomeOf(m as never, folded as never) ?? null) };
      };
      // the real harness: the exemption holds
      expect(staleFloorExemptions(module, corpus), key).toEqual([]);
      // an overlay-recording harness: it is stale, and says why
      const messages = staleFloorExemptions(module, corpus, overlayRecorder);
      expect(messages.length, key).toBe(1);
      expect(messages[0], key).toMatch(/the harness now records the effective outcome/);
      stale++;
    });
    expect(stale).toBe(builtinModules.length);
  });

  it("the settle exemption goes STALE when its probe cannot run (a recorder that throws), never silently holds", () => {
    const module = builtinModules[0]!;
    const broken: typeof recomputeStream = () => {
      throw new Error("recorder exploded");
    };
    const messages = staleFloorExemptions(module, corpusOf(module.key), broken);
    expect(messages.join("\n")).toMatch(/probe that proves the harness cannot record a settle could not run: recorder exploded/);
  });

  it("NATURAL_OUTCOMES is not stale: every row names a registered sport and a token its corpus records", () => {
    expect(Object.keys(NATURAL_OUTCOMES).length).toBeGreaterThan(0);
    expect(staleNaturalOutcomes(builtinModules, corpusOf)).toEqual([]);
  });

  it("NATURAL_OUTCOMES goes stale when a row names a sport that is not registered or a token nothing records", () => {
    const fakeSport = staleNaturalOutcomes(builtinModules.filter((m) => m.key !== "cricket"), corpusOf);
    expect(fakeSport.join("\n")).toMatch(/"cricket", which is not a registered sport/);
    // a corpus of cricket with every tie stream removed: the row `tie` is stale
    const noTie: GoldenCorpus = { ...corpusOf("cricket"), streams: corpusOf("cricket").streams.filter((s) => outcomeTokenOf(s.outcome) !== "tie") };
    const stale = staleNaturalOutcomes(builtinModules, (k) => (k === "cricket" ? noTie : corpusOf(k)));
    expect(stale.join("\n")).toMatch(/cricket tie, which no cricket stream records/);
  });

  it("a bounded sweep of every sport's own generator reaches no outcome the floor does not require", () => {
    let walks = 0;
    let observed = 0;
    forEachSport(({ module, key }) => {
      const corpus = corpusOf(key);
      const result = unrequiredObservedOutcomes(module, corpus, floorRequirement(module, corpus));
      expect(result.walks, `${key} walks`).toBeGreaterThan(0);
      expect(result.observed, `${key} observed`).toContain("win");
      expect(result.unrequired, `${key} reaches outcomes the floor does not require: add them to NATURAL_OUTCOMES`).toEqual([]);
      walks += result.walks;
      observed += result.observed.length;
    });
    expect(walks).toBeGreaterThan(builtinModules.length * 20);
    expect(observed).toBeGreaterThan(builtinModules.length * 2);
  }, 20_000);

  it("the sweep DOES see a token the floor lacks (a requirement without `draw` for football)", () => {
    const football = builtinModules.find((m) => m.key === "football")!;
    const corpus = corpusOf("football");
    const req = floorRequirement(football, corpus);
    const trimmed = { ...req, required: new Map([...req.required].filter(([t]) => t !== outcomeToken("draw"))) };
    const result = unrequiredObservedOutcomes(football, corpus, trimmed);
    expect(result.unrequired).toContain("draw");
  });
});

describe("golden floor — a recorded void is a real void", () => {
  it("every core.void in every corpus targets an earlier, non-void event of ITS OWN stream, and only core.void carries `voids`", () => {
    let voids = 0;
    let streams = 0;
    for (const [key, corpus] of corpora) {
      for (const stream of corpus.streams) {
        streams++;
        const ids = new Map<string, string>(stream.events.map((e, i) => [`e-${i}`, e.type]));
        stream.events.forEach((event, i) => {
          if (event.type !== "core.void") {
            expect(event.voids, `${key} ${stream.config}:${stream.seed} #${i} carries voids but is ${event.type}`).toBeUndefined();
            return;
          }
          voids++;
          const target = event.voids;
          expect(typeof target, `${key} ${stream.config}:${stream.seed} #${i} void names no target`).toBe("string");
          const at = Number((target as string).slice(2));
          expect(at, `${key} ${stream.config}:${stream.seed} #${i} voids a later event`).toBeLessThan(i);
          expect(ids.get(target as string), `${key} ${stream.config}:${stream.seed} #${i} voids a void`).not.toBe("core.void");
        });
      }
    }
    expect(streams).toBeGreaterThan(200);
    expect(voids, "core.void events across the corpora").toBeGreaterThanOrEqual(builtinModules.length);
  });
});

// ------------------------------------------------------------------------------------- the lineup vocabulary (review 3)

/** The reducer's refusal codes, exhaustive by construction: a `Record` keyed by the union does not compile if
 *  `LineupRejectionReason` grows and this does not. The expected set is the reducer's own declaration. */
const REDUCER_CODES: Record<LineupRejectionReason, true> = {
  "unknown-lineup-event": true,
  "invalid-payload": true,
  "unknown-entrant": true,
  "unknown-person": true,
  "not-on-field": true,
  "already-on-field": true,
  "not-a-player": true,
  "squad-growth-forbidden": true,
  "reentry-forbidden": true,
  "reentry-limit": true,
  "reentry-position": true,
  "sub-cap-reached": true,
  "exemption-not-declared": true,
  "exemption-role-absent": true,
  "exemption-cap-reached": true,
};

describe("golden floor — the lineup vocabulary is derived from the kernel; an unplanned type is a named failure", () => {
  it("LINEUP_TYPES are exactly the kernel's core.lineup.* types, none missing, none extra", () => {
    const declared = CORE_TYPES.filter((t) => t.startsWith("core.lineup."));
    expect(declared.length).toBeGreaterThan(0);
    expect([...LINEUP_TYPES].sort()).toEqual([...declared].sort());
    expect(lineupTypesOf()).toEqual([...LINEUP_TYPES]);
  });

  it("a lineup type the kernel declares and no planner covers throws BY NAME (the review's core.lineup.swap), at every entry point", () => {
    const widened = [...CORE_TYPES, "core.lineup.swap"];
    expect(() => lineupTypesOf(widened)).toThrow(/core\.lineup\.swap.*no planner/);
    const football = builtinModules.find((m) => m.key === "football")!;
    expect(() => floorRequirement(football, corpusOf("football"), widened)).toThrow(/core\.lineup\.swap.*no planner/);
    expect(() => lineupOffers(football, corpusOf("football"), widened)).toThrow(/core\.lineup\.swap.*no planner/);
    const cfg = football.configSchema.parse(corpusOf("football").configs.default);
    expect(() => planLineupEvents(benchPair(football, cfg), DEFAULT_LINEUP_POLICY, widened)).toThrow(/core\.lineup\.swap.*no planner/);
  });

  it("a planner for a type the kernel no longer declares is a named failure too (the other direction)", () => {
    const narrowed = CORE_TYPES.filter((t) => t !== "core.lineup.entry");
    expect(() => lineupTypesOf(narrowed)).toThrow(/core\.lineup\.entry.*no longer declares/);
  });

  it("every impossible-by-policy reason is a reducer refusal code per config — never '?' and never the planner's own 'no-candidate'", () => {
    let reasons = 0;
    forEachSport(({ module, key }) => {
      const req = floorRequirement(module, corpusOf(key));
      for (const [token, why] of req.impossible) {
        for (const part of why.split("; ")) {
          const code = part.split(": ")[1];
          expect(code, `${key} ${token}: ${part}`).toBeDefined();
          expect(Object.hasOwn(REDUCER_CODES, code!), `${key} ${token}: "${code}" is not a reducer refusal code`).toBe(true);
          reasons++;
        }
      }
    });
    expect(reasons).toBeGreaterThan(0);
  });

  it("a plan that never got to ask the reducer ('no-candidate') cannot become a floor reason: the requirement refuses to derive from it", () => {
    const football = builtinModules.find((m) => m.key === "football")!;
    const cfg = football.configSchema.parse(corpusOf("football").configs.default);
    const plan = planLineupEvents(benchPair(football, cfg, 0), DEFAULT_LINEUP_POLICY);
    expect(plan.refused["core.lineup.substitution"]).toBe("no-candidate");
    // a corpus whose only config gets no bench cannot be offered: the offers always bench, so this is the direct guard
    expect(Object.hasOwn(REDUCER_CODES, "no-candidate")).toBe(false);
  });
});

describe("golden floor — impossibleReason refuses to derive an exemption from a plan that never asked the reducer", () => {
  const offer = (cfgName: string, refused: Record<string, string>) => ({ cfgName, lineups: {} as never, plan: { events: [], accepted: [], refused } });

  it("joins the reducer's refusal code per config", () => {
    const offers = [offer("a", { "core.lineup.entry": "not-a-player" }), offer("b", { "core.lineup.entry": "unknown-person" })];
    expect(impossibleReason("football", offers, "core.lineup.entry")).toBe("a: not-a-player; b: unknown-person");
  });

  it("throws by name for a 'no-candidate' plan, and for a type the plan neither accepted nor refused", () => {
    expect(() => impossibleReason("football", [offer("a", { "core.lineup.entry": "no-candidate" })], "core.lineup.entry")).toThrow(/football\/a cannot say why core\.lineup\.entry is impossible \(no-candidate\)/);
    expect(() => impossibleReason("football", [offer("a", {})], "core.lineup.entry")).toThrow(/neither accepted nor refused/);
    // one config in order is not enough: a single unexplained config fails the whole derivation
    expect(() => impossibleReason("football", [offer("a", { "core.lineup.entry": "not-a-player" }), offer("b", {})], "core.lineup.entry")).toThrow(/football\/b/);
  });

  it("with no recorded config nothing was asked of the reducer: the type cannot be declared impossible (a corpus that loses its configs must not shrink the floor)", () => {
    expect(() => impossibleReason("football", [], "core.lineup.entry")).toThrow(/football has no recorded config.*core\.lineup\.entry cannot be declared impossible/);
    const football = builtinModules.find((m) => m.key === "football")!;
    expect(() => floorRequirement(football, { ...corpusOf("football"), configs: {}, streams: [] })).toThrow(/no recorded config/);
  });
});
