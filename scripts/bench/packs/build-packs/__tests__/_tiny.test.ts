// build-packs/__tests__/_tiny.test.ts — the drift/determinism gate for
// `packs/_tiny.json`, plus the T5 acceptance checks: the badminton division
// folds to its declared scores through the REAL engine (never a fixture
// compared against another fixture), and `buildSeedPlan` resolves BOTH
// divisions of the shared pack.
//
// Pure: no DB, no HTTP, no env, no disk write (the CLI write path in
// `../_tiny.ts` is guarded to run only when that file is invoked directly —
// importing `buildTinyPack`/`buildTinyPackJson` here never touches disk).
// The ONE disk read below is the committed artefact itself, which is exactly
// what the determinism test is proving agrees with the generator.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage } from "@seazn/engine/core";
import { badminton } from "@seazn/engine/sports/setbased";
import { buildTinyPack, buildTinyPackJson } from "../_tiny.ts";
import { PackSchema, type PackStream } from "../../../lib/pack-schema.ts";
import { buildSeedPlan } from "../../../lib/seed-plan.ts";
import {
  PACK_FOLD_OPTIONS,
  packEnvelopes,
  packLineupPair,
  resolveDivisionCfg,
  validatePack,
  type PackFinding,
} from "../../../lib/validate-pack.ts";

const TINY_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "_tiny.json");

const errorsOf = (findings: readonly PackFinding[]): readonly PackFinding[] =>
  findings.filter((f) => f.severity === "error");
const warningsOf = (findings: readonly PackFinding[]): readonly PackFinding[] =>
  findings.filter((f) => f.severity === "warning");

describe("build-packs/_tiny.ts — the determinism gate", () => {
  it("regenerates BYTE-IDENTICAL output to the committed packs/_tiny.json", () => {
    // The whole point of task (A): provenance is a mechanical fact, checked
    // here, rather than an assertion a reviewer has to trust. Mutating
    // BADMINTON_SEED in ../_tiny.ts and rerunning THIS test is how the guard
    // was proven live (see the task report) — the committed file freezes the
    // old seed's bytes, so a changed seed reproduces different rally bytes
    // and this equality reds.
    const committed = readFileSync(TINY_JSON_PATH, "utf8");
    expect(buildTinyPackJson()).toBe(committed);
  });

  it("the committed file parses as valid JSON and its generator's OWN object matches it structurally", () => {
    // Belt and suspenders alongside the byte-identical check above: proves
    // the committed bytes round-trip to the exact same VALUE the generator
    // holds in memory, not merely the same text.
    const committed = JSON.parse(readFileSync(TINY_JSON_PATH, "utf8")) as unknown;
    expect(committed).toEqual(buildTinyPack());
  });
});

describe("packs/_tiny.json — two divisions, stage 0, no new errors", () => {
  it("declares TWO divisions (generic d-tiny, badminton d-badminton)", () => {
    const pack = PackSchema.parse(JSON.parse(readFileSync(TINY_JSON_PATH, "utf8")));
    expect(pack.divisions.map((d) => d.ref)).toEqual(["d-tiny", "d-badminton"]);
  });

  it("validates GREEN through the real stage-0 validator, with exactly the two permanent not_derived warnings", () => {
    const raw = JSON.parse(readFileSync(TINY_JSON_PATH, "utf8"));
    const result = validatePack(raw, { expectedSuite: "_tiny" });
    expect(errorsOf(result.findings)).toEqual([]);
    expect(result.ok).toBe(true);
    // The two permanent warnings _tiny has always carried (leaderboards +
    // champions, both declared only by d-tiny) — MUST survive, per the task
    // brief, and nothing else should have appeared alongside them. A
    // "drop a stream" mutant (removing streams[3], the badminton stream,
    // while its expected.matches row stays) reds THIS test: `checkExpected`
    // then reports "no stream declares fixture ... d-badminton" as an ERROR,
    // so `result.ok` goes false and `errorsOf(...)` stops being empty.
    expect(warningsOf(result.findings).map((f) => f.code).sort()).toEqual([
      "champions.not_derived",
      "leaderboards.not_derived",
    ]);
    // Both divisions actually folded — not just parsed. `overall.real` is the
    // two `d-tiny` "real" streams; `overall.reconstructed` is d-tiny's
    // hand-written reconstructed stream PLUS the badminton one this task adds.
    expect(result.provenance.overall.reconstructed).toBe(2);
  });

  it("the badminton stream folds to its declared 21-15, 21-18 through the REAL engine — not a fixture asserted against a fixture", () => {
    const pack = PackSchema.parse(JSON.parse(readFileSync(TINY_JSON_PATH, "utf8")));
    const division = pack.divisions.find((d) => d.ref === "d-badminton");
    if (division === undefined) throw new Error("test fixture: d-badminton division missing");
    const stream = pack.streams.find(
      (s): s is PackStream => s.divisionRef === "d-badminton" && s.fixtureExtKey === "rr-r1-c1",
    );
    if (stream === undefined) throw new Error("test fixture: badminton stream missing");

    const cfgResolution = resolveDivisionCfg(badminton, division);
    if (!cfgResolution.ok) throw new Error(`badminton cfg failed to resolve: ${JSON.stringify(cfgResolution)}`);

    const { state } = foldMatchWithStoppage(
      badminton,
      cfgResolution.cfg,
      packLineupPair(stream),
      packEnvelopes(stream),
      PACK_FOLD_OPTIONS,
    );
    const detail = badminton.summary(state).detail as {
      sets: { home: number; away: number; closed: boolean }[];
    };
    // Read off the module's own public ledger, exactly as
    // `lib/__tests__/reconstruct.test.ts`'s own `foldedSets` helper does —
    // never recomputed or asserted against the generator's own idea of what
    // it produced. Changing `BADMINTON_SETS` in ../_tiny.ts (e.g. the second
    // set's target) and rerunning THIS test is how "change an expected
    // score" was proven live: the folded ledger keeps the OLD committed
    // scores until the file is regenerated, so it stops matching the pack's
    // (also-unregenerated) `expected.matches` row and the fold disagrees
    // with what was asked for.
    expect(detail.sets).toEqual([
      { home: 21, away: 15, closed: true },
      { home: 21, away: 18, closed: true },
    ]);
    expect(state.setsWon).toEqual({ home: 2, away: 0 });
  });
});

describe("buildSeedPlan — the T4 generalisation, exercised on a REAL two-division pack", () => {
  it("resolves BOTH divisions, with each one's own entrants, persons and expected fixture count", () => {
    const pack = PackSchema.parse(JSON.parse(readFileSync(TINY_JSON_PATH, "utf8")));
    const plan = buildSeedPlan(pack);

    expect(plan.divisions.map((d) => d.ref)).toEqual(["d-tiny", "d-badminton"]);

    const badmintonEntrants = plan.entrants.filter((e) => e.divisionRef === "d-badminton");
    expect(badmintonEntrants.map((e) => e.ref).sort()).toEqual(["e-cho", "e-dahl"]);
    const tinyEntrants = plan.entrants.filter((e) => e.divisionRef === "d-tiny");
    expect(tinyEntrants.map((e) => e.ref).sort()).toEqual(["e-alpha", "e-bravo"]);

    // Every player-lane person, from BOTH divisions, becomes a `persons` row;
    // Dee Duarte (d-tiny's official) does not.
    expect(plan.persons.map((p) => p.ref).sort()).toEqual(["p-ana", "p-bo", "p-cho", "p-dahl"]);
    expect(plan.officialPersonRefs).toEqual(["p-dee"]);

    // ONE entry per league stage, per division — the fixture-count
    // generalisation `expectedFixtureCount` (pack-io.ts:154) exists for.
    // d-tiny: 2 entrants over 3 legs = 3. d-badminton: 2 entrants over 1
    // leg = 1.
    expect(plan.expectedFixtureCounts).toEqual([
      { divisionRef: "d-tiny", stageRef: "s-league", count: 3 },
      { divisionRef: "d-badminton", stageRef: "s-badminton-league", count: 1 },
    ]);
  });
});
