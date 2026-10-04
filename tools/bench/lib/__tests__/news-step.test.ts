// B07a Task 12 — the news step publishes the semis and the final, not the
// whole last stage. `publishTargets` is the pure decision (which ext keys of
// ONE stage's streams get published); `runPackSuite` maps them to fixture
// ids through `fixtureKey` exactly as before Task 12 (never a delimiter
// join — `pack-schema.ts:1579` keys by `JSON.stringify([divisionRef,
// extKey])`, so a join misses every entry SILENTLY).
//
// Ruling R70 (`.superpowers/sdd/2026-09-11-bench-b07a-match-day/progress.md`):
//   1. `publishTargets(streams)` is pure over the last stage's streams,
//      returns ext keys in round-then-index order. Exported despite the
//      brief's own "no new export" — the brief's tests import it, so the
//      tests win.
//   2. Round parsed from `se-r{n}-i{i}` with n/i as integers — numeric sort,
//      never string sort (`se-r10` must follow `se-r9`).
//   3. Empty case FIRST: no streams => []. One round => that round only, no
//      invented semi.
//   4. A key that does not parse as `se-r{n}-i{i}` is excluded from the
//      published set, never silently dropped-and-forgotten nor silently
//      included: it is surfaced on the returned array's `unparsedKeys` (a
//      NON-enumerable property, so the brief's three `toEqual(array)`
//      assertions keep comparing plain arrays) for `runPackSuite` to warn
//      about by name.
//   5. `_tiny` (d-tiny's `s-playoff`, ONE stream `se-r0-i0`) keeps publishing
//      that one fixture — asserted from the real `packs/_tiny.json`.
//   6. `suite11`: division0 (`d-worlds`)'s last stage (`s-worlds-main`)
//      publishes exactly its top two rounds, and a strict subset stays draft.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PackSchema, type Pack, type PackStream } from "../pack-schema.ts";
import { publishTargets } from "../suites/run-suite.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TINY_PACK_PATH = path.join(REPO_ROOT, "tools/bench/packs/_tiny.json");
const SUITE11_PACK_PATH = path.join(REPO_ROOT, "tools/bench/packs/suite11.json");

function parsedPack(pathToFile: string): Pack {
  const raw: unknown = JSON.parse(readFileSync(pathToFile, "utf8"));
  const result = PackSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${pathToFile} failed to parse: ${JSON.stringify(result.error.issues, null, 2)}`);
  }
  return result.data;
}

/** The last stage's streams of a pack's division0, exactly as `runPackSuite`
 *  computes them at the call site — used so the real-pack tests below prove
 *  the same input `publishTargets` actually receives in production. */
function division0LastStageStreams(pack: Pack): readonly PackStream[] {
  const division0 = pack.divisions[0];
  if (division0 === undefined) return [];
  const lastStage = division0.stages[division0.stages.length - 1];
  if (lastStage === undefined) return [];
  return pack.streams.filter((st) => st.divisionRef === division0.ref && st.stageRef === lastStage.ref);
}

/** A minimal stream — `publishTargets` reads only `fixtureExtKey`. */
function streamOf(fixtureExtKey: string): Pick<PackStream, "fixtureExtKey"> {
  return { fixtureExtKey };
}

/** Two quarters (r0, 4 fixtures), two semis (r1) and one final (r2) — the
 *  brief's own knockout shape. */
function knockoutStreams(): Pick<PackStream, "fixtureExtKey">[] {
  return [
    streamOf("se-r0-i0"),
    streamOf("se-r0-i1"),
    streamOf("se-r0-i2"),
    streamOf("se-r0-i3"),
    streamOf("se-r1-i0"),
    streamOf("se-r1-i1"),
    streamOf("se-r2-i0"),
  ];
}

/** A one-round stage — a 2-slot bracket with a single fixture, like
 *  `_tiny`'s `s-playoff`. */
function oneRoundStream(): Pick<PackStream, "fixtureExtKey">[] {
  return [streamOf("se-r0-i0")];
}

describe("publishTargets", () => {
  it("publishes the final and both semis, and leaves the quarters drafted", () => {
    const published = publishTargets(knockoutStreams());
    expect(published).toEqual(["se-r1-i0", "se-r1-i1", "se-r2-i0"]);
  });

  it("publishes nothing when the last stage has no streams — the empty case", () => {
    expect(publishTargets([])).toEqual([]);
  });

  it("publishes the single fixture of a one-round stage without inventing a semi", () => {
    expect(publishTargets(oneRoundStream())).toEqual(["se-r0-i0"]);
  });

  it("sorts rounds NUMERICALLY, not as strings — se-r10 follows se-r9, not se-r1", () => {
    // A string sort puts "se-r10" between "se-r1x" and "se-r2x" — here that
    // would land r10 ahead of r9, so the "top two" would wrongly pick r10+r2
    // (lexicographically largest strings) instead of r10+r9 (numerically
    // largest rounds).
    const streams = [
      streamOf("se-r9-i0"),
      streamOf("se-r9-i1"),
      streamOf("se-r2-i0"),
      streamOf("se-r10-i0"),
    ];
    expect(publishTargets(streams)).toEqual(["se-r9-i0", "se-r9-i1", "se-r10-i0"]);
  });

  it("excludes a key that doesn't parse as se-r{n}-i{i} and reports it on unparsedKeys, never silently", () => {
    const streams = [streamOf("se-r0-i0"), streamOf("se-r1-i0"), streamOf("rr-r1-c1")];
    const published = publishTargets(streams);
    // The brief's own toEqual(array) shape still holds — rr-r1-c1 is simply
    // absent from the published set, not present and not crashing.
    expect(published).toEqual(["se-r0-i0", "se-r1-i0"]);
    expect(published.unparsedKeys).toEqual(["rr-r1-c1"]);
  });

  it("when NOTHING parses, publishes nothing and names every key as unparsed", () => {
    // m2 (Task 12 fix round 1 review, Minor-2): this title used to also
    // claim "the caller reads NO SUBJECT from this" — true, but proven by
    // a DIFFERENT test (the wired integration test in
    // tiny-suite-simulate.test.ts, "a last-stage key that fails to parse
    // as se-r{n}-i{i}..."), not by this pure `publishTargets` call, which
    // asserts only the two lines below.
    const streams = [streamOf("rr-r1-c1"), streamOf("rr-r2-c1")];
    const published = publishTargets(streams);
    expect(published).toEqual([]);
    expect(published.unparsedKeys).toEqual(["rr-r1-c1", "rr-r2-c1"]);
  });

  it("_tiny: d-tiny's real s-playoff stage (one stream, se-r0-i0) publishes that one fixture", () => {
    const pack = parsedPack(TINY_PACK_PATH);
    const division0 = pack.divisions[0];
    expect(division0?.ref).toBe("d-tiny");
    const lastStageStreams = division0LastStageStreams(pack);
    expect(lastStageStreams.map((s) => s.fixtureExtKey)).toEqual(["se-r0-i0"]);
    const published = publishTargets(lastStageStreams);
    expect(published).toEqual(["se-r0-i0"]);
    expect(published.unparsedKeys).toEqual([]);
  });

  it("suite11: division0's (d-worlds) real last stage publishes exactly its top two rounds, and a strict subset stays draft", () => {
    const pack = parsedPack(SUITE11_PACK_PATH);
    const division0 = pack.divisions[0];
    expect(division0?.ref).toBe("d-worlds");
    const lastStageStreams = division0LastStageStreams(pack);
    // d-worlds' single-elim bracket runs se-r0..se-r6 — r6 is the final (one
    // fixture), r5 the semis (two fixtures) — the two highest rounds present.
    expect(lastStageStreams.length).toBeGreaterThan(2);
    const published = publishTargets(lastStageStreams);
    expect(published).toEqual(["se-r5-i0", "se-r5-i1", "se-r6-i0"]);
    expect(published.unparsedKeys).toEqual([]);
    // "stillDraft > 0 must remain provable": the published set is a strict
    // subset of the stage's streams, so — since every one of those streams
    // gets drafted by the fold — at least one fixture is left un-published.
    expect(published.length).toBeLessThan(lastStageStreams.length);
  });
});
