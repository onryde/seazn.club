// Unit coverage for PackSchema (lib/pack-schema.ts) and the template-subset
// strip function (lib/pack-template.ts). Pure: no DB, no HTTP, no env — the
// only I/O is reading two committed files off disk (packs/_tiny.json, and
// apps/web's template schema as TEXT). Runs in CI's DB-free job.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PackRef, PackSchema, fixtureKey, type Pack } from "../pack-schema.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TINY_PACK_PATH = path.join(REPO_ROOT, "scripts/bench/packs/_tiny.json");

// ---------------------------------------------------------------------------
// Fixture builder — a minimal well-formed pack. Every test clones it and
// breaks exactly ONE thing, so a red names the rule under test and nothing
// else. Deliberately NOT _tiny.json: a shared mutable fixture that also has
// to stay a runnable bench artifact ends up serving neither purpose.
// ---------------------------------------------------------------------------
function basePack(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    suite: "_unit",
    org: { name: "Unit Org", slug: "unit-org", timezone: "UTC" },
    competition: {
      name: "Unit Cup",
      slug: "unit-cup",
      startsOn: "2099-01-01",
      endsOn: "2099-01-03",
    },
    divisions: [
      {
        ref: "d-main",
        name: "Main",
        sportKey: "generic",
        variantKey: "score",
        moduleVersion: "1.0.0",
        cfgOverrides: { resultMode: "score", allowDraws: true },
        tiebreakers: ["points", "diff"],
        stages: [{ ref: "s-league", seq: 1, kind: "league", name: "League", config: { legs: 1 } }],
      },
    ],
    persons: [
      { ref: "p-ana", fullName: "Ana Alvarez", lane: "player" },
      { ref: "p-bo", fullName: "Bo Baptiste", lane: "player" },
    ],
    entrants: [
      {
        ref: "e-alpha",
        divisionRef: "d-main",
        kind: "individual",
        displayName: "Ana Alvarez",
        seed: 1,
        roster: [{ person: "p-ana", captain: true }],
      },
      {
        ref: "e-bravo",
        divisionRef: "d-main",
        kind: "individual",
        displayName: "Bo Baptiste",
        seed: 2,
        roster: [{ person: "p-bo", captain: true }],
      },
    ],
    streams: [
      {
        divisionRef: "d-main",
        fixtureExtKey: "rr-r1-c1",
        provenance: "real",
        events: [
          { type: "core.start" },
          { type: "generic.result", payload: { p1Score: 3, p2Score: 1 } },
        ],
      },
    ],
    expected: {
      matches: [
        {
          divisionRef: "d-main",
          fixtureExtKey: "rr-r1-c1",
          outcome: { kind: "win", winner: "e-alpha", loser: "e-bravo", method: "regulation" },
        },
      ],
    },
    meta: { synthetic: true, sources: [], adaptations: [] },
  };
}

/** Deep-clone so a test's mutation can never leak into the next test. */
function pack(mutate: (p: Record<string, unknown>) => void): Record<string, unknown> {
  const draft = structuredClone(basePack());
  mutate(draft);
  return draft;
}

/** Asserts the parse FAILED and that some issue sits at `path`, with a message
 *  matching `message`. Both halves matter: a rejection at the wrong path is
 *  a different bug wearing this test's name. */
function expectIssue(
  input: unknown,
  atPath: (string | number)[],
  message: RegExp,
): void {
  const result = PackSchema.safeParse(input);
  expect(result.success, "expected the pack to be REJECTED, but it parsed").toBe(false);
  if (result.success) return;
  const issues = result.error.issues;
  const at = issues.filter((i) => JSON.stringify(i.path) === JSON.stringify(atPath));
  expect(
    at.length,
    `no issue at path ${JSON.stringify(atPath)}; issues were ${JSON.stringify(
      issues.map((i) => ({ path: i.path, message: i.message })),
    )}`,
  ).toBeGreaterThan(0);
  expect(at.some((i) => message.test(i.message)), `no issue at ${JSON.stringify(atPath)} matched ${message}; got ${JSON.stringify(at.map((i) => i.message))}`).toBe(true);
}

function parsed(input: unknown): Pack {
  const result = PackSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`expected the pack to PARSE; issues: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}

describe("fixtureKey — the division + ext_key join", () => {
  it("is injective over arbitrary strings, not just today's PackRef charset", () => {
    // The whole point of the helper. A `${division} ${extKey}` join would merge
    // these two into one bucket ("d-a b rr-1"), and a genuinely duplicated
    // ext_key would then hide behind the collision. Today's PackRef happens to
    // forbid spaces so the delimiter join is accidentally safe — this test is
    // what stops that accident from being load-bearing.
    expect(fixtureKey("d-a", "b rr-1")).not.toBe(fixtureKey("d-a b", "rr-1"));
    expect(fixtureKey("d", '"x')).not.toBe(fixtureKey('d"', "x"));
  });

  it("is stable — the same pair always yields the same key", () => {
    expect(fixtureKey("d-main", "rr-r1-c1")).toBe(fixtureKey("d-main", "rr-r1-c1"));
  });

  it("a pack ref is not free text — a space is refused", () => {
    // The invariant the delimiter join would have been leaning on. Pinned here
    // so widening PackRef is a deliberate act with a visible cost.
    expect(PackRef.safeParse("d main").success).toBe(false);
    expect(PackRef.safeParse("d-main").success).toBe(true);
  });
});

describe("PackSchema — the happy path", () => {
  it("parses the minimal well-formed pack", () => {
    const p = parsed(basePack());
    expect(p.schemaVersion).toBe(1);
    expect(p.divisions[0]?.moduleVersion).toBe("1.0.0");
    // Array-valued oracle blocks default to [] rather than staying undefined:
    // "no champion declared" and "the champion key is missing" must not be two
    // different shapes downstream.
    expect(p.expected.champions).toEqual([]);
    expect(p.expected.specials).toEqual([]);
  });

  it("refuses an unknown top-level key rather than stripping it (strict)", () => {
    const result = PackSchema.safeParse(pack((p) => { p.rosters = []; }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
  });
});

describe("PackSchema — entrants and rosters", () => {
  it("a pair entrant carries exactly two player-lane roster members", () => {
    const ok = pack((p) => {
      (p.persons as unknown[]).push({ ref: "p-cy", fullName: "Cy Chen", lane: "player" });
      const entrants = p.entrants as Record<string, unknown>[];
      entrants[0] = {
        ref: "e-alpha",
        divisionRef: "d-main",
        kind: "pair",
        displayName: "Alvarez / Chen",
        seed: 1,
        roster: [
          { person: "p-ana", captain: true, squadNumber: 1 },
          { person: "p-cy", squadNumber: 2 },
        ],
      };
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });

  it("a pair entrant with one player is refused, naming the entrant's roster", () => {
    expectIssue(
      pack((p) => {
        const entrants = p.entrants as Record<string, unknown>[];
        const first = entrants[0] as Record<string, unknown>;
        first.kind = "pair";
      }),
      ["entrants", 0, "roster"],
      /pair.*exactly two/i,
    );
  });

  it("a coach-lane member does NOT count toward a pair's two players", () => {
    const withCoach = pack((p) => {
      (p.persons as unknown[]).push(
        { ref: "p-cy", fullName: "Cy Chen", lane: "player" },
        { ref: "p-mgr", fullName: "Dee Duarte", lane: "coach" },
      );
      const entrants = p.entrants as Record<string, unknown>[];
      entrants[0] = {
        ref: "e-alpha",
        divisionRef: "d-main",
        kind: "pair",
        displayName: "Alvarez / Chen",
        seed: 1,
        roster: [
          { person: "p-ana", captain: true },
          { person: "p-cy" },
          { person: "p-mgr" },
        ],
      };
    });
    // Three roster rows, two of them players — legal, and the coach is kept.
    const p = parsed(withCoach);
    expect(p.entrants[0]?.roster).toHaveLength(3);
  });

  it("a roster may not name two captains", () => {
    expectIssue(
      pack((p) => {
        (p.persons as unknown[]).push({ ref: "p-cy", fullName: "Cy Chen", lane: "player" });
        const entrants = p.entrants as Record<string, unknown>[];
        const first = entrants[0] as Record<string, unknown>;
        first.kind = "team";
        first.roster = [
          { person: "p-ana", captain: true },
          { person: "p-cy", captain: true },
        ];
      }),
      ["entrants", 0, "roster"],
      /captain/i,
    );
  });

  it("a roster may not reuse a squad number", () => {
    expectIssue(
      pack((p) => {
        (p.persons as unknown[]).push({ ref: "p-cy", fullName: "Cy Chen", lane: "player" });
        const entrants = p.entrants as Record<string, unknown>[];
        const first = entrants[0] as Record<string, unknown>;
        first.kind = "team";
        first.roster = [
          { person: "p-ana", squadNumber: 7 },
          { person: "p-cy", squadNumber: 7 },
        ];
      }),
      ["entrants", 0, "roster"],
      /squad number/i,
    );
  });

  it("a roster may not name a person the pack never declared", () => {
    expectIssue(
      pack((p) => {
        const entrants = p.entrants as Record<string, unknown>[];
        const first = entrants[0] as Record<string, unknown>;
        first.roster = [{ person: "p-ghost" }];
      }),
      ["entrants", 0, "roster", 0, "person"],
      /unknown person ref/i,
    );
  });

  it("libero is a roster ROLE, not a boolean — entrant_members.roles is a jsonb array", () => {
    const p = parsed(
      pack((draft) => {
        const entrants = draft.entrants as Record<string, unknown>[];
        const first = entrants[0] as Record<string, unknown>;
        first.roster = [{ person: "p-ana", captain: true, roles: ["libero"] }];
      }),
    );
    expect(p.entrants[0]?.roster[0]?.roles).toEqual(["libero"]);
  });

  it("a division must declare at least two entrants", () => {
    expectIssue(
      pack((p) => {
        const entrants = p.entrants as unknown[];
        entrants.pop();
      }),
      ["divisions", 0, "ref"],
      /at least two entrants/i,
    );
  });
});

describe("PackSchema — stages, seeding and brackets", () => {
  it("a bracket slot names a real entrant of that division", () => {
    const ok = pack((p) => {
      const divisions = p.divisions as Record<string, unknown>[];
      const stages = (divisions[0] as Record<string, unknown>).stages as Record<string, unknown>[];
      stages.push({
        ref: "s-ko",
        seq: 2,
        kind: "knockout",
        name: "Final",
        bracket: [
          { slot: "f-1", entrant: "e-alpha" },
          { slot: "f-2", entrant: "e-bravo" },
        ],
      });
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });

  it("a bracket cannot carry a TBD placeholder — it has no entrant to name", () => {
    expectIssue(
      pack((p) => {
        const divisions = p.divisions as Record<string, unknown>[];
        const stages = (divisions[0] as Record<string, unknown>).stages as Record<string, unknown>[];
        stages.push({
          ref: "s-ko",
          seq: 2,
          kind: "knockout",
          name: "Final",
          bracket: [
            { slot: "f-1", entrant: "e-alpha" },
            { slot: "f-2", entrant: "TBD" },
          ],
        });
      }),
      ["divisions", 0, "stages", 1, "bracket", 1, "entrant"],
      /unknown entrant ref/i,
    );
  });

  it("stage seeding may not name an entrant from another division", () => {
    expectIssue(
      pack((p) => {
        const divisions = p.divisions as Record<string, unknown>[];
        divisions.push({
          ref: "d-other",
          name: "Other",
          sportKey: "generic",
          variantKey: "score",
          moduleVersion: "1.0.0",
          stages: [{ ref: "s-other", seq: 1, kind: "league", name: "L" }],
        });
        (p.entrants as unknown[]).push(
          { ref: "e-x", divisionRef: "d-other", kind: "individual", displayName: "X" },
          { ref: "e-y", divisionRef: "d-other", kind: "individual", displayName: "Y" },
        );
        const stages = (divisions[0] as Record<string, unknown>).stages as Record<string, unknown>[];
        (stages[0] as Record<string, unknown>).seeding = ["e-alpha", "e-x"];
      }),
      ["divisions", 0, "stages", 0, "seeding", 1],
      /unknown entrant ref/i,
    );
  });
});

describe("PackSchema — streams and events", () => {
  it("a fixture ext_key is unique per DIVISION, stricter than the DB's per-stage index", () => {
    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        streams.push(structuredClone(streams[0]) as Record<string, unknown>);
      }),
      ["streams", 1, "fixtureExtKey"],
      /duplicate fixture ext_key/i,
    );
  });

  it("the SAME ext_key in two divisions is legal", () => {
    const ok = pack((p) => {
      const divisions = p.divisions as Record<string, unknown>[];
      divisions.push({
        ref: "d-other",
        name: "Other",
        sportKey: "generic",
        variantKey: "score",
        moduleVersion: "1.0.0",
        stages: [{ ref: "s-other", seq: 1, kind: "league", name: "L" }],
      });
      (p.entrants as unknown[]).push(
        { ref: "e-x", divisionRef: "d-other", kind: "individual", displayName: "X" },
        { ref: "e-y", divisionRef: "d-other", kind: "individual", displayName: "Y" },
      );
      const streams = p.streams as Record<string, unknown>[];
      streams.push({
        divisionRef: "d-other",
        fixtureExtKey: "rr-r1-c1",
        provenance: "real",
        events: [{ type: "generic.result", payload: { p1Score: 1, p2Score: 0 } }],
      });
      const expected = p.expected as Record<string, unknown>;
      (expected.matches as unknown[]).push({
        divisionRef: "d-other",
        fixtureExtKey: "rr-r1-c1",
        outcome: { kind: "win", winner: "e-x", loser: "e-y" },
      });
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });

  it("provenance is required — a stream without it is refused", () => {
    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        delete (streams[0] as Record<string, unknown>).provenance;
      }),
      ["streams", 0, "provenance"],
      /./,
    );
  });

  it("a pack event carries no seq — the write paths mint it", () => {
    const result = PackSchema.safeParse(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        const events = (streams[0] as Record<string, unknown>).events as Record<string, unknown>[];
        (events[0] as Record<string, unknown>).seq = 1;
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (i) => i.code === "unrecognized_keys" && JSON.stringify(i.path) === JSON.stringify(["streams", 0, "events", 0]),
      ),
    ).toBe(true);
  });

  it("core.void may not be imported — a pack is authored history, not a live undo", () => {
    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        const events = (streams[0] as Record<string, unknown>).events as Record<string, unknown>[];
        events.push({ type: "core.void" });
      }),
      ["streams", 0, "events", 2, "type"],
      /core\.void/i,
    );
  });

  it("an @-prefixed payload string must resolve to a declared ref", () => {
    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        const events = (streams[0] as Record<string, unknown>).events as Record<string, unknown>[];
        events.push({ type: "core.forfeit", payload: { by: "@e-ghost", reason: "retired" } });
      }),
      ["streams", 0, "events", 2, "payload"],
      /unknown pack ref "@e-ghost"/i,
    );
  });

  it("an @-prefixed payload ref resolving to an entrant of the stream's division is accepted", () => {
    const ok = pack((p) => {
      const streams = p.streams as Record<string, unknown>[];
      const events = (streams[0] as Record<string, unknown>).events as Record<string, unknown>[];
      events.splice(1, 1, { type: "core.forfeit", payload: { by: "@e-bravo", reason: "retired hurt" } });
      const expected = p.expected as Record<string, unknown>;
      (expected.matches as Record<string, unknown>[])[0] = {
        divisionRef: "d-main",
        fixtureExtKey: "rr-r1-c1",
        outcome: { kind: "award", winner: "e-alpha" },
      };
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });

  it("a reconstruction seed on a REAL-provenance stream is refused", () => {
    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        (streams[0] as Record<string, unknown>).reconstruction = { seed: 42 };
      }),
      ["streams", 0, "reconstruction"],
      /reconstructed/i,
    );
  });

  it("every stream must carry an expected match — a stream with no oracle is vacuous", () => {
    expectIssue(
      pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.matches = [];
      }),
      ["expected", "matches"],
      /no expected match/i,
    );
  });
});

describe("PackSchema — the expected block", () => {
  it("a table's rows carry rank = position + 1, so array order IS the tie order", () => {
    expectIssue(
      pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.tables = [
          {
            divisionRef: "d-main",
            stageRef: "s-league",
            rows: [
              { entrant: "e-alpha", rank: 1, played: 1, won: 1, drawn: 0, lost: 0, points: 3 },
              { entrant: "e-bravo", rank: 1, played: 1, won: 0, drawn: 0, lost: 1, points: 0 },
            ],
          },
        ];
      }),
      ["expected", "tables", 0, "rows", 1, "rank"],
      /rank must be 2/i,
    );
  });

  it("a well-formed table with an exact tie order parses", () => {
    const ok = pack((p) => {
      const expected = p.expected as Record<string, unknown>;
      expected.tables = [
        {
          divisionRef: "d-main",
          stageRef: "s-league",
          rows: [
            { entrant: "e-alpha", rank: 1, played: 1, won: 1, drawn: 0, lost: 0, points: 3 },
            { entrant: "e-bravo", rank: 2, played: 1, won: 0, drawn: 0, lost: 1, points: 0 },
          ],
        },
      ];
      expected.champions = [{ divisionRef: "d-main", entrant: "e-alpha" }];
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });

  it("an expected match may not name an entrant from another division", () => {
    expectIssue(
      pack((p) => {
        const divisions = p.divisions as Record<string, unknown>[];
        divisions.push({
          ref: "d-other",
          name: "Other",
          sportKey: "generic",
          variantKey: "score",
          moduleVersion: "1.0.0",
          stages: [{ ref: "s-other", seq: 1, kind: "league", name: "L" }],
        });
        (p.entrants as unknown[]).push(
          { ref: "e-x", divisionRef: "d-other", kind: "individual", displayName: "X" },
          { ref: "e-y", divisionRef: "d-other", kind: "individual", displayName: "Y" },
        );
        const expected = p.expected as Record<string, unknown>;
        const first = (expected.matches as Record<string, unknown>[])[0] as Record<string, unknown>;
        first.outcome = { kind: "win", winner: "e-x", loser: "e-bravo" };
      }),
      ["expected", "matches", 0, "outcome", "winner"],
      /unknown entrant ref/i,
    );
  });

  it("a leaderboard entry carries the real person AND the real count", () => {
    const ok = pack((p) => {
      const expected = p.expected as Record<string, unknown>;
      expected.leaderboards = [
        {
          divisionRef: "d-main",
          metricKey: "points",
          entries: [{ person: "p-ana", name: "Ana Alvarez", count: 3 }],
        },
      ];
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });

  it("a suspension names the person AND the fixture they miss", () => {
    expectIssue(
      pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.suspensions = [
          { divisionRef: "d-main", person: "p-ana", missesFixtureExtKeys: ["rr-r9-c9"] },
        ];
      }),
      ["expected", "suspensions", 0, "missesFixtureExtKeys", 0],
      /no stream/i,
    );
  });

  it("a special is a claim about the FOLDED outcome or state, never 'this event type appears'", () => {
    const ok = pack((p) => {
      const expected = p.expected as Record<string, unknown>;
      expected.specials = [
        {
          kind: "ot_gws",
          divisionRef: "d-main",
          fixtureExtKey: "rr-r1-c1",
          note: "decided in overtime",
          claims: [
            { on: "outcome", kind: "win", winner: "e-alpha", method: "extra_time" },
            { on: "state", path: "phase", equals: "done" },
            { on: "standings", entrant: "e-alpha", field: "points", equals: 3 },
          ],
        },
      ];
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });

  it("a special with an empty claims array is refused — it asserts nothing", () => {
    expectIssue(
      pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.specials = [
          { kind: "expedite", divisionRef: "d-main", fixtureExtKey: "rr-r1-c1", claims: [] },
        ];
      }),
      ["expected", "specials", 0, "claims"],
      /./,
    );
  });

  it("all nine special kinds are expressible", () => {
    const kinds = [
      "super_over",
      "dls_revise",
      "shootout",
      "ot_gws",
      "final_set_tb",
      "expedite",
      "retirement",
      "concussion_sub",
      "draw_half_points",
    ];
    const ok = pack((p) => {
      const expected = p.expected as Record<string, unknown>;
      expected.specials = kinds.map((kind) => ({
        kind,
        divisionRef: "d-main",
        fixtureExtKey: "rr-r1-c1",
        claims: [{ on: "state", path: "phase", equals: "done" }],
      }));
    });
    const p = parsed(ok);
    expect(p.expected.specials.map((s) => s.kind)).toEqual(kinds);
  });
});

describe("PackSchema — meta", () => {
  it("an adaptation entry needs both what and why — an empty note is not human-readable", () => {
    expectIssue(
      pack((p) => {
        const meta = p.meta as Record<string, unknown>;
        meta.adaptations = [{ what: "Third-place seeding done by hand" }];
      }),
      ["meta", "adaptations", 0, "why"],
      /./,
    );
  });

  it("a well-formed adaptation entry parses", () => {
    const ok = pack((p) => {
      const meta = p.meta as Record<string, unknown>;
      meta.adaptations = [
        {
          what: "Third-place cross-group R16 seeding done by the bench-as-organiser",
          why: "The product has no best-thirds seeding rule; the real bracket is applied by hand.",
          where: "divisions[0].stages[1]",
        },
      ];
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });

  it("a non-synthetic pack must cite at least one source", () => {
    expectIssue(
      pack((p) => {
        const meta = p.meta as Record<string, unknown>;
        meta.synthetic = false;
      }),
      ["meta", "sources"],
      /at least one source/i,
    );
  });

  it("a real pack with a cited source parses", () => {
    const ok = pack((p) => {
      const meta = p.meta as Record<string, unknown>;
      meta.synthetic = false;
      meta.sources = [
        { url: "https://www.uefa.com/euro2024/", label: "UEFA Euro 2024 official site", retrievedOn: "2026-08-12" },
      ];
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });
});

describe("packs/_tiny.json", () => {
  const raw: unknown = JSON.parse(readFileSync(TINY_PACK_PATH, "utf8"));

  it("parses green against PackSchema", () => {
    const result = PackSchema.safeParse(raw);
    expect(
      result.success,
      result.success ? "" : JSON.stringify(result.error.issues, null, 2),
    ).toBe(true);
  });

  it("is one division, two entrants, three streams, exactly one reconstructed", () => {
    const p = parsed(raw);
    expect(p.divisions).toHaveLength(1);
    expect(p.entrants).toHaveLength(2);
    expect(p.streams).toHaveLength(3);
    expect(p.streams.filter((s) => s.provenance === "reconstructed")).toHaveLength(1);
  });

  it("its fixture ext_keys are the ones the real round-robin generator emits", () => {
    // packages/engine/src/scheduling/roundrobin.ts:140 — `rr-r{round}-c{court}`,
    // three rounds because the stage config asks for three legs
    // (usecases/stages.ts:755-758). If this drifts, B03 will seed fixtures the
    // streams cannot bind to.
    const p = parsed(raw);
    expect(p.streams.map((s) => s.fixtureExtKey)).toEqual(["rr-r1-c1", "rr-r2-c1", "rr-r3-c1"]);
    expect(p.divisions[0]?.stages[0]?.config).toEqual({ legs: 3 });
  });
});
