// Unit coverage for the pack loader (lib/pack-io.ts) — the ONE way a pack
// reaches a bench runner.
//
// Two things this file exists to pin, both named by the controller as seams
// that go inert if nobody drives them:
//
//  1. `expectedSuite` is DERIVED FROM THE FILENAME and actually reaches the
//     validator. The check is a no-op if the caller passes the pack's own
//     `suite`, or a constant, or nothing — and in all three cases a pack loads
//     green, which is exactly what an inert seam looks like. So the assertions
//     below pin the VALUE in the message, never merely the issue code.
//  2. Warnings and errors are SEPARATE FIELDS, not one list a caller has to
//     remember to filter. `_tiny` carries two permanent warnings by design, so
//     "any finding at all" would red it forever and the honest warning would be
//     deleted to make it pass.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedFixtureCount,
  formatFinding,
  loadPackFile,
  loadPackValue,
  splitBySeverity,
  suiteKeyFromPackPath,
  type PackLoad,
} from "../pack-io.ts";
import type { Pack } from "../pack-schema.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TINY_PACK_PATH = path.join(REPO_ROOT, "scripts/bench/packs/_tiny.json");
const TINY_TEXT = readFileSync(TINY_PACK_PATH, "utf8");

const tinyRaw = (): unknown => JSON.parse(TINY_TEXT) as unknown;

/**
 * `_tiny` declares leaderboards, a champion, (B05 T3 — d-tiny's second stage,
 * s-playoff) a finalRanks order, and (B05 T5b) a cross-division career
 * rollup, and stage 0 derives NONE of them, so every green `_tiny` load
 * carries exactly these four warnings. Spelled out rather than filtered away
 * — the whole point of a not-derived warning is that a reader sees it.
 */
const TINY_WARNINGS = [
  "leaderboards.not_derived",
  "champions.not_derived",
  "finalRanks.not_derived",
  "careers.not_derived",
  // B05 T5b-3 — and a discipline carry-over (`p-hotel` banned from
  // d-tiebreak's `rr-r3-c1`). Five now, in validate-pack.ts's emission order.
  "suspensions.not_derived",
];

const codes = (load: PackLoad): { errors: string[]; warnings: string[] } => ({
  errors: load.ok ? [] : load.errors.map((f) => f.code),
  warnings: load.warnings.map((f) => f.code),
});

describe("suiteKeyFromPackPath", () => {
  it("is the basename without its extension — the pack's own filename identity", () => {
    expect(suiteKeyFromPackPath("/a/b/scripts/bench/packs/_tiny.json")).toBe("_tiny");
    expect(suiteKeyFromPackPath("packs/wimbledon-2019.json")).toBe("wimbledon-2019");
  });
});

describe("splitBySeverity", () => {
  it("routes by the severity FIELD, never by position or count", () => {
    const findings = [
      { code: "a", severity: "warning", where: "w", message: "m" },
      { code: "b", severity: "error", where: "w", message: "m" },
      { code: "c", severity: "warning", where: "w", message: "m" },
    ] as const;
    const split = splitBySeverity(findings);
    expect(split.errors.map((f) => f.code)).toEqual(["b"]);
    expect(split.warnings.map((f) => f.code)).toEqual(["a", "c"]);
  });
});

describe("loadPackValue — the committed micro-pack", () => {
  it("loads GREEN and still surfaces its three permanent warnings", () => {
    const load = loadPackValue(tinyRaw(), TINY_PACK_PATH);
    expect(codes(load)).toEqual({ errors: [], warnings: TINY_WARNINGS });
    expect(load.ok).toBe(true);
    if (!load.ok) throw new Error("unreachable");
    expect(load.pack.suite).toBe("_tiny");
    // The warnings are not decoration: each names its block and says what is
    // not checked offline, so a reader can act on it.
    expect(load.warnings.map((f) => f.where)).toEqual([
      "expected.leaderboards",
      "expected.champions",
      "expected.finalRanks",
      // B05 T5b — the cross-division career rollup.
      "expected.careers",
      // B05 T5b-3 — the discipline carry-over.
      "expected.suspensions",
    ]);
  });
});

describe("loadPackValue — the pack/filename check is WIRED, not declared", () => {
  it("reds when the pack's declared suite disagrees with the file it came from", () => {
    // The very same bytes that load green as `_tiny.json`, loaded from a file
    // called something else.
    const load = loadPackValue(tinyRaw(), "/somewhere/packs/wimbledon-2019.json");
    expect(codes(load).errors).toEqual(["pack.suite_mismatch"]);
    expect(load.ok).toBe(false);
    if (load.ok) throw new Error("unreachable");
    // BOTH values, not just the code. A call site that dropped `expectedSuite`
    // still raises `pack.suite_mismatch` — against `undefined` — so a test
    // pinning only the code proves nothing about the wiring.
    const message = load.errors[0]?.message ?? "";
    expect(message).toContain('pack declares suite "_tiny"');
    expect(message).toContain('the caller expected "wimbledon-2019"');
  });

  it("accepts the same bytes under the filename they belong to", () => {
    expect(loadPackValue(tinyRaw(), "/elsewhere/entirely/_tiny.json").ok).toBe(true);
  });
});

describe("loadPackValue — refusals", () => {
  it("hands back NO pack when the schema refuses it, so nothing can run on a bad one", () => {
    const broken = tinyRaw() as { entrants: unknown[] };
    broken.entrants = [];
    const load = loadPackValue(broken, TINY_PACK_PATH);
    expect(load.ok).toBe(false);
    expect(codes(load).errors.every((c) => c.startsWith("schema."))).toBe(true);
    // `pack` is not a field on the refused branch at all — a runner cannot
    // read it without narrowing on `ok` first, and tsc enforces that.
    expect(Object.prototype.hasOwnProperty.call(load, "pack")).toBe(false);
  });

  it("reds a fold divergence as an ERROR, not a warning", () => {
    const corrupted = tinyRaw() as {
      streams: { events: { type: string; payload?: Record<string, number> }[] }[];
    };
    // rr-r1-c1's declared 3-1 becomes 1-3: the fold now names the other winner.
    const result = corrupted.streams[0]?.events[1];
    if (result === undefined) throw new Error("fixture shape changed");
    result.payload = { p1Score: 1, p2Score: 3 };
    const load = loadPackValue(corrupted, TINY_PACK_PATH);
    expect(load.ok).toBe(false);
    expect(codes(load).errors).toContain("match.outcome_winner");
    // …and the warnings still come through beside it, including the one that
    // says the table was SKIPPED because of the error above it.
    expect(codes(load).warnings).toEqual(["standings.upstream_fold_failed", ...TINY_WARNINGS]);
  });
});

describe("stage 0 cross-checks a league stage's stream count against its own declaration", () => {
  // `_tiny` declares `legs: 3` AND three streams and is consistent because it
  // was AUTHORED that way, not because anything compared the two. Move `legs`
  // without moving the streams and the pack used to validate green offline and
  // red only minutes into a live run against a real server — the class stage 0
  // exists to kill in seconds.
  const withLegs = (legs: number): unknown => {
    const raw = tinyRaw() as { divisions: { stages: { config: { legs: number } }[] }[] };
    const stage = raw.divisions[0]?.stages[0];
    if (stage === undefined) throw new Error("fixture shape changed");
    stage.config.legs = legs;
    return raw;
  };

  it("is silent when the streams match what the entrants and legs imply", () => {
    expect(codes(loadPackValue(tinyRaw(), TINY_PACK_PATH)).warnings).toEqual(TINY_WARNINGS);
  });

  it("warns, with BOTH counts, when the legs move and the streams do not", () => {
    const load = loadPackValue(withLegs(5), TINY_PACK_PATH);
    expect(codes(load).warnings).toEqual(["streams.count_mismatch", ...TINY_WARNINGS]);
    const said = load.warnings[0]?.message ?? "";
    // The implied count AND the carried count — an existence assertion here
    // would pass against any pair of numbers.
    expect(said).toContain("implies 5 fixture(s)");
    expect(said).toContain("2 entrants over 5 leg(s)");
    expect(said).toContain("carries 3 stream(s)");
    // …and it is a WARNING, never a gate: whether a partially-recorded season
    // is an authoring defect is a human judgement.
    expect(load.ok).toBe(true);
  });

  it("warns in the OTHER direction too — fewer implied than carried", () => {
    const load = loadPackValue(withLegs(1), TINY_PACK_PATH);
    expect(codes(load).warnings).toContain("streams.count_mismatch");
    const said = load.warnings.map((f) => f.message).join(" ");
    expect(said).toContain("implies 1 fixture(s)");
    expect(said).toContain("carries 3 stream(s)");
  });

  it("stays silent past the product's own leg clamp rather than warning a wrong number", () => {
    // The product clamps legs to 8 (`usecases/stages.ts:756`), so at 9 the
    // implied count is NOT the count the generator would mint and a warning
    // built from it would be wrong rather than merely unhelpful. Refusing to
    // answer beats answering wrongly; `expectedFixtureCount` refuses out loud
    // on the same input, which is where an author gets told.
    expect(codes(loadPackValue(withLegs(9), TINY_PACK_PATH)).warnings).not.toContain(
      "streams.count_mismatch",
    );
    // …and 8 — the last legal value — is still checked.
    expect(codes(loadPackValue(withLegs(8), TINY_PACK_PATH)).warnings).toContain(
      "streams.count_mismatch",
    );
  });

  it("stays silent on a stage with no streams bound to it at all", () => {
    // An unplayed stage is not a count mismatch; a division that declares a
    // second stage nobody has played yet must not be warned about here, and
    // `standings.no_expected_table` already covers the reverse.
    const raw = tinyRaw() as {
      divisions: { stages: Record<string, unknown>[] }[];
      streams: { stageRef?: string }[];
    };
    const stages = raw.divisions[0]?.stages;
    if (stages === undefined) throw new Error("fixture shape changed");
    stages.push({ ref: "s-empty", seq: 2, kind: "league", name: "Empty", config: { legs: 4 } });
    for (const stream of raw.streams) stream.stageRef = "s-league";
    expect(codes(loadPackValue(raw, TINY_PACK_PATH)).warnings).not.toContain(
      "streams.count_mismatch",
    );
  });

  it("stays silent on a stage kind whose count is not a round robin", () => {
    const raw = tinyRaw() as { divisions: { stages: { kind: string; config: { legs: number } }[] }[] };
    const stage = raw.divisions[0]?.stages[0];
    if (stage === undefined) throw new Error("fixture shape changed");
    stage.config.legs = 5;
    stage.kind = "knockout";
    // The knockout makes the expected TABLE underivable, so errors appear —
    // but no count warning, because a bracket's fixture count is a bracket
    // shape rather than a round robin.
    expect(codes(loadPackValue(raw, TINY_PACK_PATH)).warnings).not.toContain(
      "streams.count_mismatch",
    );
  });
});

describe("loadPackFile", () => {
  it("reads the committed pack off disk and loads it green", async () => {
    const load = await loadPackFile(TINY_PACK_PATH);
    expect(codes(load)).toEqual({ errors: [], warnings: TINY_WARNINGS });
  });

  it("names an unreadable file rather than throwing at the runner", async () => {
    const load = await loadPackFile(path.join(REPO_ROOT, "scripts/bench/packs/_nope.json"));
    expect(load.ok).toBe(false);
    expect(codes(load).errors).toEqual(["pack.unreadable"]);
    expect(load.ok ? "" : (load.errors[0]?.message ?? "")).toContain("_nope.json");
  });
});

describe("formatFinding", () => {
  it("carries the code, the element and the message — a report line a human can act on", () => {
    const line = formatFinding({
      code: "standings.value",
      severity: "error",
      where: "expected.tables[0] (d-tiny/s-league)",
      message: 'rank 1 "e-alpha" points: pack expects 7, the fold produced 6',
    });
    expect(line).toContain("standings.value");
    expect(line).toContain("expected.tables[0] (d-tiny/s-league)");
    expect(line).toContain("the fold produced 6");
  });
});

describe("expectedFixtureCount — derived from the pack, never typed in", () => {
  const tinyPack = (): Pack => {
    const load = loadPackValue(tinyRaw(), TINY_PACK_PATH);
    if (!load.ok) throw new Error("the committed _tiny.json no longer loads");
    return load.pack;
  };

  it("is the round-robin count for the pack's OWN entrants and legs", () => {
    // `_tiny` declares 2 entrants and `legs: 3` — one pairing, three times.
    expect(expectedFixtureCount(tinyPack(), "d-tiny", "s-league")).toBe(3);
  });

  it("MOVES when the pack's legs move", () => {
    const raw = tinyRaw() as { divisions: { stages: { config: { legs: number } }[] }[] };
    const stage = raw.divisions[0]?.stages[0];
    if (stage === undefined) throw new Error("fixture shape changed");
    stage.config.legs = 5;
    const load = loadPackValue(raw, TINY_PACK_PATH);
    if (!load.ok) throw new Error(`_tiny with legs:5 no longer loads: ${JSON.stringify(codes(load))}`);
    // Five, not three — a bound typed into the runner could not move at all.
    expect(expectedFixtureCount(load.pack, "d-tiny", "s-league")).toBe(5);
  });

  it("MOVES when the division's entrant count moves", () => {
    // Four entrants over three legs is six pairings, eighteen fixtures. Built
    // by hand rather than by loading, because adding two entrants to `_tiny`
    // would invalidate every one of its expected values.
    const pack = {
      ...tinyPack(),
      entrants: [
        ...tinyPack().entrants,
        { ...(tinyPack().entrants[0] as object), ref: "e-charlie", roster: [] },
        { ...(tinyPack().entrants[0] as object), ref: "e-delta", roster: [] },
      ],
    } as Pack;
    expect(expectedFixtureCount(pack, "d-tiny", "s-league")).toBe(18);
  });

  it("counts only the entrants of THAT division", () => {
    // `_tiny` has exactly one division, so a count that ignored `divisionRef`
    // would agree with the right answer on it — the fixture has to carry a
    // SECOND division for the filter to be witnessable at all.
    const pack = tinyPack();
    const first = pack.divisions[0] as Pack["divisions"][number];
    const anEntrant = pack.entrants[0] as Pack["entrants"][number];
    const two = {
      ...pack,
      divisions: [first, { ...first, ref: "d-other" }],
      entrants: [
        ...pack.entrants,
        { ...anEntrant, ref: "e-x", divisionRef: "d-other" },
        { ...anEntrant, ref: "e-y", divisionRef: "d-other" },
        { ...anEntrant, ref: "e-z", divisionRef: "d-other" },
      ],
    } as Pack;
    // Two entrants over three legs, not five.
    expect(expectedFixtureCount(two, "d-tiny", "s-league")).toBe(3);
    // Three entrants over three legs is nine.
    expect(expectedFixtureCount(two, "d-other", "s-league")).toBe(9);
  });

  it("defaults to a single leg when the stage declares none", () => {
    const pack = tinyPack();
    const single = {
      ...pack,
      divisions: [
        {
          ...pack.divisions[0],
          stages: [{ ...(pack.divisions[0]?.stages[0] as object), config: {} }],
        },
      ],
    } as Pack;
    expect(expectedFixtureCount(single, "d-tiny", "s-league")).toBe(1);
  });

  it("refuses a stage kind whose fixture count is not a round robin", () => {
    const pack = tinyPack();
    const knockout = {
      ...pack,
      divisions: [
        {
          ...pack.divisions[0],
          stages: [{ ...(pack.divisions[0]?.stages[0] as object), kind: "knockout" }],
        },
      ],
    } as Pack;
    expect(() => expectedFixtureCount(knockout, "d-tiny", "s-league")).toThrow(/kind "knockout"/);
  });

  it("refuses more legs than the product's own generator will mint", () => {
    const pack = tinyPack();
    const many = {
      ...pack,
      divisions: [
        {
          ...pack.divisions[0],
          stages: [
            { ...(pack.divisions[0]?.stages[0] as object), config: { legs: 9 } },
          ],
        },
      ],
    } as Pack;
    expect(() => expectedFixtureCount(many, "d-tiny", "s-league")).toThrow(/clamps/);
  });

  it("refuses an unknown division or stage rather than answering zero", () => {
    expect(() => expectedFixtureCount(tinyPack(), "d-nope", "s-league")).toThrow(/d-nope/);
    expect(() => expectedFixtureCount(tinyPack(), "d-tiny", "s-nope")).toThrow(/s-nope/);
  });
});
