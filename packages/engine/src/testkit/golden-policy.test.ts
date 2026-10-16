// #429 scope item 1 — the golden corpus WRITE POLICY, made enforceable.
//
// The policy is in GOLDEN-POLICY.md next to this file: a re-baseline is
// legitimate only when it is DELIBERATE, ISOLATED IN ITS OWN COMMIT, and
// REVIEWED AS A STATE DIFF. The mechanism for it (`REBASELINE_GOLDEN=1`)
// already existed and enforced none of those three clauses — it would rewrite
// eleven corpora on top of a half-finished branch and print nothing about what
// moved, which produces a commit no reviewer can read: a state that moved
// because the fold changed is indistinguishable from one that moved because
// the tree was dirty.
//
// Both halves under test here are PURE and take their inputs as data — a
// porcelain listing, a pair of corpora — so nothing below manufactures dirty
// git state or runs a re-baseline. The impure wiring is two `execFileSync`
// probes, and the only thing asserted of them is the one behaviour that must
// fail closed: outside a checkout there is no diff to review.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { football } from "../sports/football/index.ts";
import { sweepBudget } from "./golden-budget.ts";
import * as floorStreams from "./golden-floor-streams.ts";
import * as golden from "./golden.ts";
import { buildWalk, defaultLineupPair, makeEnvelope } from "./helpers.ts";
import {
  MAX_EVENTS,
  MIN_EVENTS,
  corpusStateDiff,
  corpusWritablePaths,
  corpusWriteVerdict,
  formatCorpusStateDiff,
  gitPorcelain,
  gitRepoRoot,
  readCorpus,
  stateDigest,
  type GoldenCorpus,
  type GoldenStream,
} from "./golden.ts";

const FOOTBALL = "packages/engine/src/sports/football/football.golden.json";
const CRICKET = "packages/engine/src/sports/cricket/cricket.golden.json";

// ------------------------------------------------------- the cleanliness probe

describe("corpusWriteVerdict — a corpus write refuses a dirty working tree", () => {
  it("passes on a completely clean tree", () => {
    const verdict = corpusWriteVerdict([], [FOOTBALL, CRICKET]);
    expect(verdict.ok).toBe(true);
    expect(verdict.offending).toEqual([]);
  });

  it("passes when the only dirty paths are corpus files it is about to rewrite", () => {
    expect(corpusWriteVerdict([` M ${FOOTBALL}`, ` M ${CRICKET}`], [FOOTBALL, CRICKET]).ok).toBe(
      true,
    );
  });

  it("REFUSES when a non-corpus path is dirty, and names it", () => {
    const kernel = "packages/engine/src/sports/football/kernel.ts";
    const verdict = corpusWriteVerdict([` M ${FOOTBALL}`, ` M ${kernel}`], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual([kernel]);
    // The message has to name the path — "your tree is dirty" sends the reader
    // back to `git status`, which is where they already were.
    expect(verdict.reason).toContain(kernel);
  });

  it("REFUSES on an untracked file", () => {
    const verdict = corpusWriteVerdict(["?? scratch/probe.ts"], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual(["scratch/probe.ts"]);
  });

  it("REFUSES a staged change as readily as an unstaged one", () => {
    const verdict = corpusWriteVerdict(["M  apps/web/src/app/page.tsx"], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual(["apps/web/src/app/page.tsx"]);
  });

  it("REFUSES a corpus file the run is NOT about to rewrite", () => {
    // The allowance is the exact set the run will write, not "any golden".
    const verdict = corpusWriteVerdict([` M ${CRICKET}`], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual([CRICKET]);
  });

  it("names BOTH sides of a rename", () => {
    const verdict = corpusWriteVerdict(["R  src/old.ts -> src/new.ts"], [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.offending).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("reads a quoted porcelain path with a space in it", () => {
    const verdict = corpusWriteVerdict([' M "docs/a b/c.md"'], [FOOTBALL]);
    expect(verdict.offending).toEqual(["docs/a b/c.md"]);
  });

  it("reports each offending path once, sorted", () => {
    const verdict = corpusWriteVerdict([" M b.ts", " M a.ts", "?? b.ts"], [FOOTBALL]);
    expect(verdict.offending).toEqual(["a.ts", "b.ts"]);
  });

  it("FAILS CLOSED when the directory is not a git checkout", () => {
    // Not an edge case: with no diff there is nothing to review, so the run
    // cannot satisfy the clause it is being gated on.
    const verdict = corpusWriteVerdict(null, [FOOTBALL]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("not a git checkout");
  });
});

/** A corpus path as the checkout names it: with the `.stryker-tmp/sandbox-<id>/` a Stryker run copies the package into taken out
 *  (exactly one such segment, straight after `packages/engine/`, and nothing else is rewritten), so a mutation run's dry run
 *  reads the same paths a plain run does. A path outside a sandbox comes back as it went in. */
const SANDBOX = /^(packages\/engine\/)\.stryker-tmp\/sandbox-[A-Za-z0-9_-]+\//;
function outOfSandbox(path: string): string {
  return path.replace(SANDBOX, "$1");
}

describe("outOfSandbox, the one rewrite the corpus-path test makes", () => {
  const COPY = "packages/engine/.stryker-tmp/sandbox-36Ol7J/src/sports/football/football.golden.json";
  it("takes the sandbox segment out of a Stryker copy's path and leaves the checkout's own paths alone", () => {
    expect(outOfSandbox(COPY)).toBe(FOOTBALL);
    expect(outOfSandbox(FOOTBALL)).toBe(FOOTBALL);
    expect(outOfSandbox(CRICKET)).toBe(CRICKET);
  });
  it("rewrites only that segment: a different directory, a second segment, or a path that is not in the engine is NOT mapped onto a checkout path", () => {
    for (const other of [
      "packages/engine/.stryker-tmp/other/src/sports/football/football.golden.json",
      "packages/engine/.stryker-tmp/sandbox-/src/sports/football/football.golden.json",
      "packages/other/.stryker-tmp/sandbox-36Ol7J/src/sports/football/football.golden.json",
      "packages/engine/src/.stryker-tmp/sandbox-36Ol7J/sports/football/football.golden.json",
    ]) expect(outOfSandbox(other), other).toBe(other);
    expect(outOfSandbox("packages/engine/.stryker-tmp/sandbox-a/.stryker-tmp/sandbox-b/x.json")).toBe("packages/engine/.stryker-tmp/sandbox-b/x.json");
  });
});

describe("the git probes behind the guard", () => {
  it("returns null outside a checkout, which is what fails the guard closed", () => {
    const outside = mkdtempSync(join(tmpdir(), "golden-policy-"));
    expect(gitRepoRoot(outside)).toBeNull();
    expect(gitPorcelain(outside)).toBeNull();
    expect(corpusWriteVerdict(gitPorcelain(outside), []).ok).toBe(false);
  });

  it("reads this checkout", () => {
    const root = gitRepoRoot(process.cwd());
    expect(root).not.toBeNull();
    expect(gitPorcelain(process.cwd())).not.toBeNull();
  });

  it("allows exactly the committed corpus files, repo-relative and on disk", () => {
    const root = gitRepoRoot(process.cwd()) as string;
    // Under Stryker the suite runs from a COPY of the package, `packages/engine/.stryker-tmp/sandbox-<id>/`, and the corpus
    // paths are derived from where the module sits; the checkout's own path is what the policy names (see outOfSandbox).
    const paths = corpusWritablePaths(root).map(outOfSandbox);
    expect(paths).toHaveLength(11);
    expect(paths).toContain(FOOTBALL);
    expect(paths).toContain(CRICKET);
    for (const path of paths) {
      expect(path.startsWith("packages/engine/src/sports/"), path).toBe(true);
      expect(path.endsWith(".golden.json"), path).toBe(true);
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  });
});

// -------------------------------------------------------- the state-diff summary

function stream(over: Partial<GoldenStream>): GoldenStream {
  return {
    config: "default",
    seed: 1,
    events: [{ type: "football.goal", payload: { by: "home" } }],
    states: [`{"cfg":{"halfMinutes":45},"phase":"live","goals":{"home":0,"away":0}}`],
    outcome: "null",
    summary: "{}",
    deltas: "{}",
    ...over,
  };
}

function corpus(streams: GoldenStream[]): GoldenCorpus {
  return {
    key: "football",
    version: "1.0.0",
    recordedBy: "testkit/golden.ts",
    params: { minEvents: MIN_EVENTS, maxEvents: MAX_EVENTS },
    configs: { default: {} },
    streams,
  };
}

describe("corpusStateDiff — what a re-baseline moved, as reviewable data", () => {
  it("reports nothing when nothing moved", () => {
    const before = corpus([stream({})]);
    const diff = corpusStateDiff(before, corpus([stream({})]));
    expect(diff.streams).toEqual([]);
    expect(diff.changedStreams).toBe(0);
    expect(diff.changedStates).toBe(0);
    expect(diff.eventsMoved).toBe(false);
    expect(formatCorpusStateDiff(diff)).toContain("nothing moved");
  });

  it("names the stream, the changed STEP indices and the changed state KEYS", () => {
    const states = [
      `{"cfg":{"a":1},"phase":"pre","goals":0}`,
      `{"cfg":{"a":1},"phase":"live","goals":0}`,
      `{"cfg":{"a":1},"phase":"live","goals":1}`,
    ];
    const before = corpus([stream({ config: "knockout", seed: 7, states })]);
    const after = corpus([
      stream({
        config: "knockout",
        seed: 7,
        states: [states[0] as string, `{"cfg":{"a":1},"phase":"live","goals":9}`, states[2] as string],
      }),
    ]);
    const diff = corpusStateDiff(before, after);
    expect(diff.changedStreams).toBe(1);
    expect(diff.changedStates).toBe(1);
    expect(diff.streams[0]?.index).toBe(0);
    expect(diff.streams[0]?.config).toBe("knockout");
    expect(diff.streams[0]?.seed).toBe(7);
    expect(diff.streams[0]?.changedSteps).toEqual([1]);
    expect(diff.streams[0]?.changedStateKeys).toEqual(["goals"]);
    expect(diff.changedStateKeys).toEqual(["goals"]);
  });

  it("attributes a change nested inside a value to its TOP-LEVEL key", () => {
    const before = corpus([stream({ states: [`{"cfg":{"a":1},"goals":{"home":0,"away":0}}`] })]);
    const after = corpus([stream({ states: [`{"cfg":{"a":1},"goals":{"home":2,"away":0}}`] })]);
    expect(corpusStateDiff(before, after).changedStateKeys).toEqual(["goals"]);
  });

  it("reports a state key that only one side carries", () => {
    const before = corpus([stream({ states: [`{"cfg":{"a":1},"phase":"live"}`] })]);
    const after = corpus([stream({ states: [`{"cfg":{"a":1},"phase":"live","shootout":null}`] })]);
    expect(corpusStateDiff(before, after).changedStateKeys).toEqual(["shootout"]);
  });

  it("reports integer-like state keys without reordering them into the diff", () => {
    const before = corpus([stream({ states: ['{"cfg":{"a":1},"2":"b","1":"a"}'] })]);
    const after = corpus([stream({ states: ['{"cfg":{"a":1},"2":"z","1":"a"}'] })]);
    expect(corpusStateDiff(before, after).changedStateKeys).toEqual(["2"]);
  });

  it("reports outcome, summary and deltas independently of the states", () => {
    const before = corpus([stream({})]);
    const after = corpus([stream({ outcome: `{"winner":"home"}`, deltas: `{"league":[3,0]}` })]);
    const diff = corpusStateDiff(before, after);
    expect(diff.changedStreams).toBe(1);
    expect(diff.streams[0]?.changedSteps).toEqual([]);
    expect(diff.streams[0]?.outcomeMoved).toBe(true);
    expect(diff.streams[0]?.summaryMoved).toBe(false);
    expect(diff.streams[0]?.deltasMoved).toBe(true);
  });

  it("lists only the streams that moved", () => {
    const before = corpus([stream({ seed: 1 }), stream({ seed: 2 })]);
    const after = corpus([
      stream({ seed: 1 }),
      stream({ seed: 2, states: [`{"cfg":{"a":1},"phase":"done"}`] }),
    ]);
    const diff = corpusStateDiff(before, after);
    expect(diff.streams.map((s) => s.index)).toEqual([1]);
  });

  it("FLAGS a moved recorded event — that is a re-record, not a re-baseline", () => {
    const before = corpus([stream({})]);
    const after = corpus([
      stream({ events: [{ type: "football.goal", payload: { by: "away" } }] }),
    ]);
    const diff = corpusStateDiff(before, after);
    expect(diff.eventsMoved).toBe(true);
    expect(diff.streams[0]?.eventsMoved).toBe(true);
    expect(formatCorpusStateDiff(diff)).toContain("RECORDED EVENTS MOVED");
  });

  it("FLAGS a changed stream count as an events move", () => {
    const diff = corpusStateDiff(corpus([stream({})]), corpus([stream({}), stream({ seed: 2 })]));
    expect(diff.eventsMoved).toBe(true);
  });

  // ------------------------------------------------------ #429 scope item 3
  //
  // Slimming the corpora to per-step digests takes away exactly what this
  // summary is made of: for a digest-only step there is no stored state on
  // either side, so no key can be named — the old value is a hash in git too.
  // The degradation is bounded and stated rather than hidden. A digest-only
  // move is still REPORTED, it is called out as digest-only, and the printout
  // says where the detail can be recovered from.

  it("reports a digest-only step as MOVED, with no key attribution", () => {
    const before = corpus([stream({ states: ["#aaaaaaaaaaaaaaaa"] })]);
    const after = corpus([stream({ states: ["#bbbbbbbbbbbbbbbb"] })]);
    const diff = corpusStateDiff(before, after);
    expect(diff.changedStates).toBe(1);
    expect(diff.streams[0]?.changedSteps).toEqual([0]);
    expect(diff.streams[0]?.digestOnlySteps).toEqual([0]);
    // No key, and above all NOT the "(state is not a JSON object)" sentinel —
    // that would put noise into the one line a reviewer reads as the
    // minimality claim.
    expect(diff.streams[0]?.changedStateKeys).toEqual([]);
    expect(diff.changedStateKeys).toEqual([]);
  });

  it("says nothing moved when two identical digests are compared", () => {
    const same = corpus([stream({ states: ["#aaaaaaaaaaaaaaaa"] })]);
    expect(corpusStateDiff(same, corpus([stream({ states: ["#aaaaaaaaaaaaaaaa"] })])).streams)
      .toEqual([]);
  });

  it("still names keys at the steps that DID keep a full state", () => {
    const before = corpus([
      stream({ states: [`{"cfg":{"a":1},"phase":"live"}`, "#aaaaaaaaaaaaaaaa"] }),
    ]);
    const after = corpus([
      stream({ states: [`{"cfg":{"a":1},"phase":"done"}`, "#bbbbbbbbbbbbbbbb"] }),
    ]);
    const diff = corpusStateDiff(before, after);
    expect(diff.streams[0]?.changedSteps).toEqual([0, 1]);
    expect(diff.streams[0]?.digestOnlySteps).toEqual([1]);
    expect(diff.streams[0]?.changedStateKeys).toEqual(["phase"]);
  });

  // The run that slims the corpora rewrites every non-anchor step from a full
  // state to a digest. Without this, that one re-baseline reports ~2,450 states
  // "moved" and the printout — the whole point of which is minimality — becomes
  // unreadable at the exact moment it matters most.
  it("does NOT report a full state REPLACED BY ITS OWN DIGEST as a move", () => {
    const state = `{"cfg":{"a":1},"phase":"live"}`;
    const before = corpus([stream({ states: [state, state] })]);
    const after = corpus([stream({ states: [state, stateDigest(state, "cfg")] })]);
    const diff = corpusStateDiff(before, after, football);
    expect(diff.streams).toEqual([]);
    expect(diff.reformattedStates).toBe(1);
    expect(formatCorpusStateDiff(diff)).toContain("1 state(s) re-formatted");
  });

  it("DOES report a state that moved AND was digested in the same run", () => {
    const state = `{"cfg":{"a":1},"phase":"live"}`;
    const before = corpus([stream({ states: [state, state] })]);
    const after = corpus([
      stream({ states: [state, stateDigest(`{"cfg":{"a":1},"phase":"done"}`, "cfg")] }),
    ]);
    const diff = corpusStateDiff(before, after, football);
    expect(diff.streams[0]?.changedSteps).toEqual([1]);
    expect(diff.streams[0]?.digestOnlySteps).toEqual([1]);
  });

  // Without the module there is no way to know where the config lives, so the
  // digest of the full side cannot be computed. Fail LOUD: report the step.
  it("reports a form change as a move when no module is supplied to resolve it", () => {
    const state = `{"cfg":{"a":1},"phase":"live"}`;
    const after = corpus([stream({ states: [state, stateDigest(state, "cfg")] })]);
    const diff = corpusStateDiff(corpus([stream({ states: [state, state] })]), after);
    expect(diff.streams[0]?.changedSteps).toEqual([1]);
  });

  it("prints the digest-only steps and how to recover their detail", () => {
    const before = corpus([stream({ states: ["#aaaaaaaaaaaaaaaa"] })]);
    const after = corpus([stream({ states: ["#bbbbbbbbbbbbbbbb"] })]);
    const text = formatCorpusStateDiff(corpusStateDiff(before, after));
    expect(text).toContain("digests=[0]");
    expect(text).toContain("recomputeStream");
  });

  it("prints the module, the step indices and the moved keys", () => {
    const before = corpus([stream({ states: [`{"cfg":{"a":1},"phase":"live"}`] })]);
    const after = corpus([stream({ states: [`{"cfg":{"a":1},"phase":"done"}`] })]);
    const text = formatCorpusStateDiff(corpusStateDiff(before, after));
    expect(text).toContain("football");
    expect(text).toContain("steps=[0]");
    expect(text).toContain("keys=[phase]");
    expect(text).toContain("state keys moved: phase");
  });
});

// ------------------------------------------------- the "cannot see" section stays true (GF-2 T3 review)

describe("GOLDEN-POLICY.md — what the guard cannot see names what the engine says it cannot", () => {
  const policy = readFileSync(join(import.meta.dirname, "GOLDEN-POLICY.md"), "utf8");
  const bullet = (title: string): string => {
    const at = policy.indexOf(`- **${title}`);
    expect(at, `the bullet "${title}" exists`).toBeGreaterThan(-1);
    const next = policy.indexOf("\n- **", at + 1);
    return policy.slice(at, next === -1 ? undefined : next);
  };

  /** Over live prefixes of natural walks: how many abandons the fold accepted, and how many of those the MODULE answered with an
   *  outcome (the kernel's `outcomeOf`, no settlement, no expunge). */
  const afterAbandon = (module: AnySportModule, raw: unknown): { attempted: number; answered: number } => {
    const cfg = module.configSchema.parse(raw) as unknown;
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    let attempted = 0;
    let answered = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const walk = buildWalk(module, cfg, lineups, seed, 80).events;
      for (const k of new Set([1, Math.ceil(walk.length / 3), Math.ceil((2 * walk.length) / 3), walk.length - 1])) {
        if (k < 1) continue;
        const ledger = [...walk.slice(0, k), makeEnvelope(k, { type: "core.abandon", payload: { reason: "rain" } })];
        try {
          const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, ledger, { strictFromSeq: 0 });
          attempted++;
          if (outcomeOf(module as never, folded as never) !== null) answered++;
        } catch (error) {
          if (!(error instanceof EngineError)) throw error; // a refused abandon (already decided) is not an attempt
        }
      }
    }
    return { attempted, answered };
  };

  it("the sports whose abandonPolicy defaults to 'replay' are the ones the policy names, 'award' makes the module answer an outcome after an abandon, and each records an award stream whose standing expunge the recorded outcome shows (W2c Task 16c closed it)", () => {
    const text = bullet("A kernel overlay a corpus never exercises.");
    const withKnob: string[] = [];
    let witnesses = 0;
    for (const module of builtinModules) {
      const corpus = readCorpus(module.key);
      const raws = Object.values(corpus.configs);
      const knob = (raw: unknown): unknown => (module.configSchema.parse(raw) as { abandonPolicy?: unknown }).abandonPolicy;
      if (knob(raws[0]) === undefined) continue;
      withKnob.push(module.key);
      expect(knob(raws[0]), `${module.key}: the default config says replay`).toBe("replay");
      const replay = afterAbandon(module, raws[0]);
      const award = afterAbandon(module, { ...(raws[0] as object), abandonPolicy: "award" });
      expect(replay.attempted, `${module.key}: abandons were accepted under replay`).toBeGreaterThan(0);
      expect(replay.answered, `${module.key}: under replay the module answers no outcome`).toBe(0);
      expect(award.attempted, `${module.key}: abandons were accepted under award`).toBeGreaterThan(0);
      expect(award.answered, `${module.key}: under award the module answers an outcome`).toBeGreaterThan(0);
      expect(text, `the policy names ${module.key}`).toMatch(new RegExp(`\\b${module.key}\\b`, "i"));
      // The gap this bullet named, closed: a recorded `award` config with a stream whose withdrawal expunge STANDS over the award the
      // module answered, recorded with no outcome. Dropping `outcomeOf`'s expunge guard moves that stream's recorded outcome.
      const closing = corpus.streams.filter((stream) => {
        const raw = corpus.configs[stream.config];
        if (knob(raw) !== "award") return false;
        const cfg = module.configSchema.parse(raw) as unknown;
        const lineups = stream.lineups ?? defaultLineupPair(resolvePositions(module, cfg));
        const folded = foldMatchWithStoppage(module as never, cfg as never, lineups, stream.events.map((e, i) => makeEnvelope(i, e, e.voids)), { strictFromSeq: 0 });
        return folded.expunged && module.outcome(folded.state) !== null && stream.outcome === "null";
      });
      expect(closing.length, `${module.key}: an award stream whose standing expunge the recorded outcome shows`).toBeGreaterThan(0);
      for (const stream of closing) expect(text, `the policy names ${module.key}'s ${stream.config}#${stream.seed}`).toContain(`#${stream.seed}`);
      witnesses += closing.length;
    }
    expect(withKnob.sort(), "football, and hockey and icehockey through the period kernel").toEqual(["football", "hockey", "icehockey"]);
    expect(witnesses, "one per sport at least").toBeGreaterThanOrEqual(withKnob.length);
    expect(text).toContain("abandonPolicy");
  });

  it("under the recorded configs a module answers an outcome after an abandon in cricket (its own rule) and exactly where a recorded config sets a policy other than 'replay' (the sentence the policy rests on), swept over every sport", () => {
    const answering: string[] = [];
    const nonReplay: string[] = [];
    let attempted = 0;
    for (const module of builtinModules) {
      for (const raw of Object.values(readCorpus(module.key).configs)) {
        const r = afterAbandon(module, raw);
        attempted += r.attempted;
        if (r.answered > 0 && !answering.includes(module.key)) answering.push(module.key);
        const policy = (module.configSchema.parse(raw) as { abandonPolicy?: unknown }).abandonPolicy;
        if (policy !== undefined && policy !== "replay" && !nonReplay.includes(module.key)) nonReplay.push(module.key);
      }
    }
    expect(attempted, "abandons were attempted across the registry").toBeGreaterThan(builtinModules.length);
    expect(nonReplay.length, "W2c records award, share and q4_stands configs").toBeGreaterThan(0);
    expect(answering.sort()).toEqual(["cricket", ...nonReplay].sort());
    const text = bullet("A kernel overlay a corpus never exercises.");
    for (const key of answering) expect(text, `the policy names ${key}`).toMatch(new RegExp(`\\b${key}\\b`, "i"));
  }, sweepBudget("probe"));

  it("the widening-a-refusal bullet names both refusals by the code the kernel throws, and the kernel still throws them", () => {
    const text = bullet("Kernel refusals, and widening what the kernel accepts.");
    const events = readFileSync(join(import.meta.dirname, "../core/events.ts"), "utf8");
    for (const code of ["ABANDONED_SETTLE_OR_VOID", "SETTLE_NOT_APPLICABLE"]) {
      expect(text, `the policy names ${code}`).toContain(code);
      expect(events, `events.ts still throws ${code}`).toContain(`"${code}"`);
    }
    expect(text).toContain("manual MAJOR bump");
    expect(text).toContain("abandonActive");
    expect(events, "the flag the policy names exists").toContain("let abandonActive");
  });
});

// ------------------------------------------------- the in-place re-record of a floor stream is documented against real machinery

describe("GOLDEN-POLICY.md — \"Re-recording a floor-batch stream in place\" names real machinery and real examples", () => {
  const policy = readFileSync(join(import.meta.dirname, "GOLDEN-POLICY.md"), "utf8");
  const HEADING = "## Re-recording a floor-batch stream in place";
  const at = policy.indexOf(HEADING);
  const section = at < 0 ? "" : policy.slice(at, policy.indexOf("\n## ", at + 1));

  it("the section exists, and the write-modes table points at it by its title", () => {
    expect(at, "the heading exists").toBeGreaterThan(-1);
    expect(section.length, "the section has a body").toBeGreaterThan(500);
    expect(policy.slice(0, at), "the table row cites the section").toContain('see "Re-recording a floor-batch stream in place"');
  });

  it("every helper it tells you to call is a real export, and it names the obligations: the major, the guard, the refusal to write more than the one stream", () => {
    const exported: Record<string, unknown> = { ...floorStreams, ...golden };
    const named = ["floorBatches", "reproduceFloorBatch", "corpusBefore", "extendFloor", "FLOOR_SEED_STRIDE", "writeCorpus", "corpusWriteVerdict"];
    let found = 0;
    for (const name of named) {
      expect(section, `the section names ${name}`).toContain(name);
      expect(exported[name], `${name} is exported`).toBeDefined();
      found++;
    }
    expect(found).toBe(named.length);
    for (const phrase of ["MAJOR", "FOLD_EPOCH", "fold-epoch:check", "removed and added", "refuses to write unless exactly", "config#seed"]) expect(section, phrase).toContain(phrase);
    const scripts = (JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["fold-epoch:check"], "the script the section runs exists").toBeDefined();
    for (const file of ["golden.test.ts", "golden-floor-streams.test.ts"]) expect(existsSync(join(import.meta.dirname, file)), `${file} exists`).toBe(true);
  });

  it("its two worked examples are what the corpora hold: #100008 records the colour-naming Armageddon in a floor batch; the 800008 withdrawal streams carry no lineup event", () => {
    const boardgame = readCorpus("boardgame");
    const index = boardgame.streams.findIndex((s) => s.config === "knockoutTiebreak" && s.seed === 100008);
    expect(index, "boardgame knockoutTiebreak#100008 exists").toBeGreaterThan(-1);
    const stream = boardgame.streams[index]!;
    expect(floorStreams.isFloorStream(stream), "it is a floor stream").toBe(true);
    expect(floorStreams.floorBatches(boardgame).some((b) => b.start <= index && index < b.start + b.streams.length), "it sits in a floor batch").toBe(true);
    const armageddon = stream.events.filter((e) => e.type === "boardgame.tiebreak").map((e) => e.payload as Record<string, unknown>);
    expect(armageddon.some((p) => p.rung === "armageddon" && p.black !== undefined && p.winner === undefined), "its Armageddon names who had Black and derives the winner").toBe(true);
    let checked = 0;
    for (const key of ["boardgame", "carrom", "generic"]) {
      const withdrawal = readCorpus(key).streams.filter((s) => s.seed === 800008);
      expect(withdrawal.length, `${key} records an 800008 withdrawal stream`).toBeGreaterThan(0);
      for (const s of withdrawal) {
        expect(s.events.filter((e) => e.type.startsWith("core.lineup.")), `${key} ${s.config}#${s.seed}: no lineup event`).toEqual([]);
        checked++;
      }
    }
    expect(checked, "one 800008 stream per sport the section names").toBe(3);
  });
});
