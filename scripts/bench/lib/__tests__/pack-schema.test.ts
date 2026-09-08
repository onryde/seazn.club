// Unit coverage for PackSchema (lib/pack-schema.ts) and the template-subset
// strip function (lib/pack-template.ts). Pure: no DB, no HTTP, no env — the
// only I/O is reading two committed files off disk (packs/_tiny.json, and
// apps/web's template schema as TEXT). Runs in CI's DB-free job.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StandingsDelta } from "@seazn/engine/core";
import { describe, expect, it } from "vitest";
import {
  entrantsOfDivision,
  PackProvenance,
  PackRef,
  PackSchema,
  roundRobinFixtureCount,
  SEED_LEGAL_BY_PROVENANCE,
  STANDINGS_SCALAR_FIELDS,
  fixtureKey,
  seedRefusalMessage,
  type Pack,
} from "../pack-schema.ts";
import { packToTemplateSkeleton } from "../pack-template.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TINY_PACK_PATH = path.join(REPO_ROOT, "scripts/bench/packs/_tiny.json");
const TEMPLATE_SCHEMA_PATH = path.join(REPO_ROOT, "apps/web/src/server/templates/schema.ts");

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
        home: "e-alpha",
        away: "e-bravo",
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

describe("PackSchema — a stream may name its stage", () => {
  // Additive, landed before the B06 freeze. Optional, so every v1 pack is
  // unchanged — `_tiny` declares none and still parses (asserted in the
  // packs/_tiny.json block below, which parses the committed file).
  it("accepts a stageRef naming a stage of the stream's own division, and KEEPS it", () => {
    const out = parsed(
      pack((p) => {
        (p.streams as Record<string, unknown>[])[0]!["stageRef"] = "s-league";
      }),
    );
    // The PARSED value, not merely that parsing succeeded: a field the schema
    // strips is a field the fold can never consult.
    expect(out.streams[0]?.stageRef).toBe("s-league");
  });

  it("is absent by default rather than defaulted to the sole stage", () => {
    // Absence means "the division's only stage" TO A CONSUMER; the schema must
    // not decide that for it, because the consumer is also what reports the
    // multi-stage case it cannot resolve.
    expect(parsed(basePack()).streams[0]?.stageRef).toBeUndefined();
  });

  it("refuses a stageRef that names no stage at all", () => {
    expectIssue(
      pack((p) => {
        (p.streams as Record<string, unknown>[])[0]!["stageRef"] = "s-nope";
      }),
      ["streams", 0, "stageRef"],
      /unknown stage ref "s-nope" for division "d-main"/,
    );
  });

  it("refuses a stageRef that names ANOTHER division's stage", () => {
    // The realistic mistake, and the one a global check would wave through:
    // stage refs are only unique within a division, so "s-other" exists — just
    // not here. Binding to it would fold this fixture under the wrong points
    // rule, pool and decider overlay.
    expectIssue(
      pack((p) => {
        (p.divisions as Record<string, unknown>[]).push({
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
        (p.streams as Record<string, unknown>[])[0]!["stageRef"] = "s-other";
      }),
      ["streams", 0, "stageRef"],
      /unknown stage ref "s-other" for division "d-main"/,
    );
  });
});

describe("PackSchema — an award outcome cannot claim a method", () => {
  // The engine's `award` variant is `{kind, winner, score?}` — no `method`
  // (core/types.ts). A pack that could write one would parse and then be
  // UNSATISFIABLE against every possible fold.
  it("refuses `method` on an award", () => {
    expectIssue(
      pack((p) => {
        const matches = (p.expected as Record<string, unknown>)["matches"] as Record<string, unknown>[];
        (matches[0]!["outcome"] as Record<string, unknown>) = {
          kind: "award",
          winner: "e-alpha",
          method: "walkover",
        };
      }),
      // zod reports an unrecognized key at the OBJECT, not at the key — so
      // this path is what the parse really produces, not what reads naturally.
      ["expected", "matches", 0, "outcome"],
      /unrecognized key: "method"/i,
    );
  });

  it("still accepts `method` on a win, and KEEPS the parsed value", () => {
    // The other half: dropping the field from the wrong variant would look
    // identical to this test if it only checked that the award reds.
    const out = parsed(
      pack((p) => {
        const matches = (p.expected as Record<string, unknown>)["matches"] as Record<string, unknown>[];
        (matches[0]!["outcome"] as Record<string, unknown>)["method"] = "extra_time";
      }),
    );
    expect(out.expected.matches[0]?.outcome).toMatchObject({ kind: "win", method: "extra_time" });
  });

  it("accepts an award with no method at all", () => {
    const out = parsed(
      pack((p) => {
        const matches = (p.expected as Record<string, unknown>)["matches"] as Record<string, unknown>[];
        (matches[0]!["outcome"] as Record<string, unknown>) = { kind: "award", winner: "e-alpha" };
      }),
    );
    expect(out.expected.matches[0]?.outcome).toEqual({ kind: "award", winner: "e-alpha" });
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
        home: "e-x",
        away: "e-y",
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

describe("PackSchema — one ref namespace for everything the @ sigil resolves", () => {
  // Review round 2, critical. The sigil carries no kind: a payload @-ref
  // resolves against entrants union persons, a scheduleConfig @-ref against
  // courts union venues, and the seeding layer rewrites every @-prefixed
  // string in ONE pass. With per-kind uniqueness only, an entrant "c1" and a
  // court "c1" both parsed clean and the rewriter would hand the scheduler an
  // entrant UUID as a court, with nothing red at any layer.

  function withPlaces(mutate: (p: Record<string, unknown>) => void): Record<string, unknown> {
    return pack((p) => {
      (p.persons as unknown[]).push({ ref: "p-ref", fullName: "Ref Eree", lane: "official" });
      p.venues = [{ ref: "v-main", name: "Arena", courts: [{ ref: "c-1", name: "Court 1" }] }];
      p.officials = [{ ref: "o-ref", person: "p-ref", displayName: "Ref Eree" }];
      mutate(p);
    });
  }

  it("a court may not take a ref an entrant already uses", () => {
    // THE collision the round-2 review found. Both sides parsed before.
    expectIssue(
      withPlaces((p) => {
        const venues = p.venues as Record<string, unknown>[];
        ((venues[0] as Record<string, unknown>).courts as Record<string, unknown>[])[0]!.ref = "e-alpha";
      }),
      ["venues", 0, "courts", 0, "ref"],
      /already used by an entrant.*share ONE/is,
    );
  });

  it("a venue, an official and a person may not collide with each other either", () => {
    expectIssue(
      withPlaces((p) => {
        (p.venues as Record<string, unknown>[])[0]!.ref = "p-ana";
      }),
      ["venues", 0, "ref"],
      /already used by a person/i,
    );
    expectIssue(
      withPlaces((p) => {
        (p.officials as Record<string, unknown>[])[0]!.ref = "c-1";
      }),
      ["officials", 0, "ref"],
      /already used by a court/i,
    );
    // Reported at the SECOND use, which follows the walk order (persons,
    // entrants, venues+courts, officials) — so a person claiming an entrant's
    // ref reds on the ENTRANT, not the person. Asserting the real path rather
    // than the intuitive one is the point: a test that guessed would have been
    // green against a rule that reported nothing at all.
    expectIssue(
      withPlaces((p) => {
        (p.persons as Record<string, unknown>[]).push({
          ref: "e-bravo",
          fullName: "Collides With An Entrant",
          lane: "player",
        });
      }),
      ["entrants", 1, "ref"],
      /already used by a person/i,
    );
  });

  it("a duplicate WITHIN one kind still reads as a duplicate, not a collision", () => {
    // Two different authoring mistakes, two different messages.
    expectIssue(
      withPlaces((p) => {
        (p.persons as Record<string, unknown>[]).push({
          ref: "p-ana",
          fullName: "Ana Again",
          lane: "player",
        });
      }),
      ["persons", 3, "ref"],
      /duplicate person ref/i,
    );
    expectIssue(
      withPlaces((p) => {
        const venues = p.venues as Record<string, unknown>[];
        ((venues[0] as Record<string, unknown>).courts as Record<string, unknown>[]).push({
          ref: "c-1",
          name: "Court 1 again",
        });
      }),
      ["venues", 0, "courts", 1, "ref"],
      /duplicate court ref/i,
    );
  });

  it("a duplicate official ref reads as a duplicate, ONCE", () => {
    // Nothing asserted this message, which is how a second copy of the rule
    // survived in checkReservations and emitted the same issue twice at the
    // same path — contradicting the comment that says "once". The count is
    // the assertion, not just the presence.
    const result = PackSchema.safeParse(
      withPlaces((p) => {
        (p.officials as Record<string, unknown>[]).push({
          ref: "o-ref",
          person: "p-ref",
          displayName: "Ref Eree Again",
        });
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const at = result.error.issues.filter(
      (i) => JSON.stringify(i.path) === JSON.stringify(["officials", 1, "ref"]),
    );
    expect(at.map((i) => i.message)).toEqual(['duplicate official ref "o-ref"']);
  });

  it("a duplicate COURT ref still says why court refs are global", () => {
    // The reason lives in a different file's field (scheduleConfig names
    // courts unqualified), so "duplicate court ref" alone leaves an author
    // with no idea why two venues may not each have a Court 1.
    expectIssue(
      withPlaces((p) => {
        const venues = p.venues as Record<string, unknown>[];
        (venues as Record<string, unknown>[]).push({
          ref: "v-second",
          name: "Second Arena",
          courts: [{ ref: "c-1", name: "Court 1" }],
        });
      }),
      ["venues", 1, "courts", 0, "ref"],
      /duplicate court ref .*unique across ALL venues.*scheduleConfig names them unqualified/is,
    );
  });

  it("divisions and stages keep their own namespace — they are never @-referenced", () => {
    // Deliberately outside the shared namespace: they are addressed only
    // through typed fields (divisionRef, stageRef, registration.byDivision
    // keys). If a future field ever @-references one, it must join.
    const shared = withPlaces((p) => {
      const divisions = p.divisions as Record<string, unknown>[];
      (divisions[0] as Record<string, unknown>).ref = "p-ana";
      (p.entrants as Record<string, unknown>[]).forEach((e) => {
        (e as Record<string, unknown>).divisionRef = "p-ana";
      });
      (p.streams as Record<string, unknown>[])[0]!.divisionRef = "p-ana";
      const expected = p.expected as Record<string, unknown>;
      (expected.matches as Record<string, unknown>[])[0]!.divisionRef = "p-ana";
    });
    expect(PackSchema.safeParse(shared).success).toBe(true);
  });

  it("_tiny.json is refused if one of its own refs is made to collide", () => {
    // The first version of this test parsed _tiny and then asserted its refs
    // were distinct — dead, because `parsed()` throws on a collision, so the
    // Set-size line could never be the thing that red. It asserted a property
    // of a value the parser had already guaranteed.
    //
    // Driving it the other way is what has teeth: take the real fixture two
    // later tasks build on, introduce ONE collision, and require the schema to
    // refuse it. Green today AND still checking tomorrow, when _tiny grows.
    const raw = JSON.parse(readFileSync(TINY_PACK_PATH, "utf8")) as Record<string, unknown>;
    expect(PackSchema.safeParse(raw).success).toBe(true);

    const collided = structuredClone(raw);
    const persons = collided.persons as Record<string, unknown>[];
    const entrants = collided.entrants as Record<string, unknown>[];
    // `persons` has NO minimum in the schema, so an empty _tiny would make the
    // collision below a no-op and this test vacuous — a real guard. `entrants`
    // needs none: PackSchema declares `.min(2)`, so asserting it here would
    // restate the schema.
    expect(persons.length, "_tiny declares no persons to collide").toBeGreaterThan(0);
    persons[0]!.ref = entrants[0]!.ref;
    const result = PackSchema.safeParse(collided);
    expect(result.success, "a collided _tiny still parsed").toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => /share ONE ref namespace/.test(i.message))).toBe(true);
  });
});

describe("PackSchema — @-refs inside the OTHER opaque blocks", () => {
  // The gap hunt. `cfgOverrides`, `stages[].config` and `stages[].progression`
  // are carried verbatim, so nothing type-checks them — and nothing scanned
  // them for @-refs either. A typo'd ref went straight through to the seeding
  // layer, which would fail to rewrite it and hand the engine a literal
  // "@e-alpah" string. Same class as the cross-kind collision: a sigil that
  // resolves to nothing, with nothing red.

  const opaque: { label: string; at: (string | number)[]; put: (p: Record<string, unknown>, v: unknown) => void }[] = [
    {
      label: "cfgOverrides",
      at: ["divisions", 0, "cfgOverrides"],
      put: (p, v) => {
        const d = (p.divisions as Record<string, unknown>[])[0] as Record<string, unknown>;
        d.cfgOverrides = { resultMode: "score", allowDraws: true, nominatedFor: v };
      },
    },
    {
      label: "a stage's config",
      at: ["divisions", 0, "stages", 0, "config"],
      put: (p, v) => {
        const st = ((p.divisions as Record<string, unknown>[])[0] as Record<string, unknown>)
          .stages as Record<string, unknown>[];
        (st[0] as Record<string, unknown>).config = { legs: 1, pinnedTo: v };
      },
    },
    {
      label: "a stage's progression",
      at: ["divisions", 0, "stages", 0, "progression"],
      put: (p, v) => {
        const st = ((p.divisions as Record<string, unknown>[])[0] as Record<string, unknown>)
          .stages as Record<string, unknown>[];
        (st[0] as Record<string, unknown>).progression = { sources: [{ stage: "previous", carry: v }] };
      },
    },
  ];

  for (const block of opaque) {
    it(`an unresolvable @-ref in ${block.label} is refused`, () => {
      expectIssue(
        pack((p) => block.put(p, "@e-alpah")),
        block.at,
        /unknown pack ref "@e-alpah"/i,
      );
    });

    it(`a RESOLVABLE @-ref in ${block.label} is accepted`, () => {
      // The other direction, so the rule is a resolver and not a blanket ban
      // on the "@" character inside an opaque block.
      const ok = pack((p) => block.put(p, "@e-alpha"));
      const result = PackSchema.safeParse(ok);
      expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
    });
  }

  it("the refusal tells the author what to DO, not only what is wrong", () => {
    // Header note 6 rules a literal leading "@" an owner escalation with no
    // escape hatch. Stating the requirement without the remedy leaves an
    // author stuck at exactly the moment the schema is least negotiable.
    expectIssue(
      pack((p) => {
        const d = (p.divisions as Record<string, unknown>[])[0] as Record<string, unknown>;
        d.cfgOverrides = { resultMode: "score", allowDraws: true, nominatedFor: "@e-alpah" };
      }),
      ["divisions", 0, "cfgOverrides"],
      /owner escalation, not something to work around/i,
    );
  });

  it("scheduleConfig stays NARROW while the cfg blocks stay broad — both from one walk", () => {
    // The narrowing is a filter over `collectSigilRefs`, not a second
    // membership. A person is declared, so the broad scan accepts it; a
    // scheduleConfig ref is a PLACE, so the narrow resolver must not.
    const inCfg = pack((p) => {
      const d = (p.divisions as Record<string, unknown>[])[0] as Record<string, unknown>;
      d.cfgOverrides = { resultMode: "score", allowDraws: true, scorer: "@p-ana" };
    });
    expect(PackSchema.safeParse(inCfg).success, "a declared person was refused in cfgOverrides").toBe(true);

    expectIssue(
      pack((p) => {
        p.venues = [{ ref: "v-main", name: "Arena", courts: [{ ref: "c-1", name: "Court 1" }] }];
        const d = (p.divisions as Record<string, unknown>[])[0] as Record<string, unknown>;
        d.scheduleConfig = { matchMinutes: 30, courts: ["@c-1", "@p-ana"] };
      }),
      ["divisions", 0, "scheduleConfig"],
      /unknown pack ref "@p-ana".*declared venue or court/is,
    );
  });

  it("it resolves against the WHOLE shared namespace, not just entrants", () => {
    // Deliberately broad: no authored source says what a cfg blob may
    // reference, so the honest rule is "must resolve to something declared".
    const ok = pack((p) => {
      (p.persons as unknown[]).push({ ref: "p-ref", fullName: "Ref Eree", lane: "official" });
      p.venues = [{ ref: "v-main", name: "Arena", courts: [{ ref: "c-1", name: "Court 1" }] }];
      const d = (p.divisions as Record<string, unknown>[])[0] as Record<string, unknown>;
      d.cfgOverrides = { resultMode: "score", allowDraws: true, homeCourt: "@c-1", scorer: "@p-ref" };
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
  });
});

describe("PackSchema — a generated stream records its seed", () => {
  // Review round 2: the round-1 additive pass added `synthetic` but left the
  // seed rule pinned to `reconstructed` alone, so a synthetic stream — which
  // the customer-journey suite GENERATES — could not record what produced it.
  const withSeed = (provenance: string): Record<string, unknown> =>
    pack((p) => {
      const stream = (p.streams as Record<string, unknown>[])[0] as Record<string, unknown>;
      stream.provenance = provenance;
      stream.reconstruction = { seed: 20260902, note: "folds to the real 21-19, 21-17" };
    });

  it("a reconstructed stream may carry one", () => {
    expect(PackSchema.safeParse(withSeed("reconstructed")).success).toBe(true);
  });

  it("a synthetic stream may carry one — it is generated too, and reproducibility is the point", () => {
    const result = PackSchema.safeParse(withSeed("synthetic"));
    expect(
      result.success,
      result.success ? "" : JSON.stringify(result.error.issues),
    ).toBe(true);
    expect(parsed(withSeed("synthetic")).streams[0]?.reconstruction?.seed).toBe(20260902);
  });

  it("every declared provenance has a decided seed answer, and the schema obeys it", () => {
    // The map is exhaustive at compile time (a fourth PackProvenance value
    // fails tsc with a missing property). This is the runtime half: the table
    // and the behaviour agree, for every value the enum actually holds — so a
    // hand-edit of one entry reds here rather than silently changing what a
    // pack may declare.
    // `options.length > 0` and "the key set matches the enum" are both
    // already guaranteed — a zod enum cannot be empty, and the table is typed
    // `Record<PackProvenance, boolean>`, so tsc rejects a missing or extra key
    // (mutant M79 proves it). Asserting them here restated the compiler.
    // What is NOT guaranteed is that the table's ANSWERS match the schema's
    // behaviour, which is what this loop checks.
    for (const provenance of PackProvenance.options) {
      const withSeedFor = pack((p) => {
        const stream = (p.streams as Record<string, unknown>[])[0] as Record<string, unknown>;
        stream.provenance = provenance;
        stream.reconstruction = { seed: 7 };
      });
      expect(
        PackSchema.safeParse(withSeedFor).success,
        `provenance "${provenance}" disagrees with SEED_LEGAL_BY_PROVENANCE`,
      ).toBe(SEED_LEGAL_BY_PROVENANCE[provenance]);
    }
  });

  it("a reconstruction block without a seed is refused — the seed IS the block's purpose", () => {
    // Making `seed` optional survived a sweep: nothing asserted that a
    // reconstruction block must actually carry one, so the field could have
    // become decoration and the reproducibility claim with it.
    const result = PackSchema.safeParse(
      pack((p) => {
        const stream = (p.streams as Record<string, unknown>[])[0] as Record<string, unknown>;
        stream.provenance = "reconstructed";
        stream.reconstruction = { note: "generated, but from what?" };
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const at = result.error.issues.filter(
      (i) => JSON.stringify(i.path) === JSON.stringify(["streams", 0, "reconstruction", "seed"]),
    );
    expect(at.length, `issues were ${JSON.stringify(result.error.issues)}`).toBeGreaterThan(0);
    expect(at.some((i) => i.code === "invalid_type")).toBe(true);
  });

  it("a real stream may NOT, and the refusal names the STREAM's provenance", () => {
    // Nothing asserted the message before, so it could — and did — hardcode
    // `provenance "real"` and enumerate the three current values. A fourth
    // value would then have told an author their stream was "real" when it
    // was not. Both halves of the message are derived; this pins both.
    expectIssue(
      withSeed("real"),
      ["streams", 0, "reconstruction"],
      /a stream with provenance "real" may not carry a reconstruction seed/i,
    );
    expectIssue(
      withSeed("real"),
      ["streams", 0, "reconstruction"],
      /generated provenances are "reconstructed" or "synthetic"/i,
    );
  });

  it("the refusal names the OFFENDING provenance, proven on a table the enum does not yet hold", () => {
    // The teeth for the interpolation. While "real" is the only forbidden
    // value, a hardcoded `provenance "real"` and an interpolated
    // `${s.provenance}` produce identical output for every pack that can be
    // built — so driving the schema cannot tell them apart. Handing the pure
    // builder a FOUR-value table can: this is the exact case the message
    // exists for, where an author of an "estimated" stream must not be told
    // their stream is "real".
    const future = { real: false, estimated: false, reconstructed: true, synthetic: true };
    const message = seedRefusalMessage("estimated", future);
    expect(message).toContain('provenance "estimated"');
    expect(message).not.toContain('provenance "real"');
    expect(message).toContain('"reconstructed" or "synthetic"');
    // And the permitted list is the table's, not a literal: neither forbidden
    // value may appear in it.
    expect(message.split("generated provenances are")[1]).not.toContain('"real"');
    expect(message.split("generated provenances are")[1]).not.toContain('"estimated"');

    // A SECOND table, whose permitted set is deliberately NOT
    // {reconstructed, synthetic}. The table above cannot catch a filter that
    // hardcodes today's two permitted values, because it happens to permit
    // exactly those two — a fixture that agrees with the bug it is meant to
    // find. This one disagrees: a hardcoded filter says "reconstructed or
    // synthetic" where the table says "estimated or reconstructed".
    const reshuffled = { real: false, estimated: true, reconstructed: true, synthetic: false };
    const other = seedRefusalMessage("synthetic", reshuffled);
    expect(other).toContain('provenance "synthetic"');
    expect(other).toContain('"estimated" or "reconstructed"');
    expect(other.split("generated provenances are")[1]).not.toContain('"synthetic"');
  });

  it("the refusal's permitted list is read from the table, not typed into the message", () => {
    // Drive it from the table rather than from a literal: every provenance the
    // table permits must appear in the message, and every one it forbids must
    // not. A hardcoded list passes the test above and fails this one.
    const forbidden = PackProvenance.options.filter((v) => !SEED_LEGAL_BY_PROVENANCE[v]);
    const permitted = PackProvenance.options.filter((v) => SEED_LEGAL_BY_PROVENANCE[v]);
    expect(forbidden.length, "no provenance forbids a seed — the test asserts nothing").toBeGreaterThan(0);
    expect(permitted.length, "no provenance permits a seed — the test asserts nothing").toBeGreaterThan(0);

    const result = PackSchema.safeParse(withSeed(forbidden[0] as string));
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues
      .filter((i) => JSON.stringify(i.path) === JSON.stringify(["streams", 0, "reconstruction"]))
      .map((i) => i.message)
      .join(" ");
    expect(message).not.toBe("");
    for (const value of permitted) expect(message).toContain(`"${value}"`);
    for (const value of forbidden.slice(1)) expect(message).not.toContain(`"${value}"`);
  });
});

describe("PackSchema — a stream declares who played", () => {
  // Review round 1, C1. foldMatch takes LineupPair as a REQUIRED argument
  // (core/events.ts:445-451) and stage-0 folds in process, so a stream that
  // named only its ext_key would have its sides re-derived from the
  // scheduling generator — an undeclared dependency that silently decides
  // oracles, because generic.result maps p1Score to HOME (generic.ts:113-114)
  // and a multi-leg round robin mirrors home/away on even legs.

  it("home and away are REQUIRED — not merely refined once present", () => {
    // The issue CODE is the assertion, not just the path. Making these
    // `.optional()` still produces an issue at the same path (the cross-field
    // rule then reports `undefined` as an unknown entrant ref), so a test that
    // only checked the path passed for both shapes — it survived a mutation
    // sweep exactly that way. `invalid_type` is what "the key is missing"
    // looks like; `custom` is what the refinement looks like.
    for (const side of ["home", "away"] as const) {
      const result = PackSchema.safeParse(
        pack((p) => {
          const streams = p.streams as Record<string, unknown>[];
          delete (streams[0] as Record<string, unknown>)[side];
        }),
      );
      expect(result.success, `a stream without ${side} parsed`).toBe(false);
      if (result.success) continue;
      const at = result.error.issues.filter(
        (i) => JSON.stringify(i.path) === JSON.stringify(["streams", 0, side]),
      );
      expect(at.length, `no issue at streams[0].${side}`).toBeGreaterThan(0);
      expect(
        at.some((i) => i.code === "invalid_type"),
        `streams[0].${side} was reported as ${JSON.stringify(at.map((i) => i.code))}, not a missing required key`,
      ).toBe(true);
    }
  });

  it("a lineup slot refuses an unknown key — including the engine's own `personId` spelling", () => {
    // The likeliest authoring mistake in this whole block: the engine's
    // LineupSlot calls it `personId` (core/types.ts:180) and the pack calls it
    // `person`, because a pack ref is not a UUID. Non-strict, that typo would
    // be SILENTLY STRIPPED and the slot would parse with no person at all.
    const result = PackSchema.safeParse(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        (streams[0] as Record<string, unknown>).lineups = {
          home: [{ person: "p-ana", personId: "p-ana" }],
          away: [{ person: "p-bo" }],
        };
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (i) =>
          i.code === "unrecognized_keys" &&
          JSON.stringify(i.path) === JSON.stringify(["streams", 0, "lineups", "home", 0]),
      ),
      `expected an unrecognized_keys issue on the slot; got ${JSON.stringify(result.error.issues)}`,
    ).toBe(true);
  });

  it("a side must be an entrant of the stream's own division", () => {
    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        (streams[0] as Record<string, unknown>).home = "e-ghost";
      }),
      ["streams", 0, "home"],
      /unknown entrant ref/i,
    );
  });

  it("one entrant cannot be on both sides", () => {
    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        (streams[0] as Record<string, unknown>).away = "e-alpha";
      }),
      ["streams", 0, "away"],
      /both sides/i,
    );
  });

  it("an expected perSide line may not name an entrant that did not play this fixture", () => {
    // Reachable in a real pack: entrant refs are division-scoped, so a
    // copy-paste from the neighbouring fixture resolves fine and asserts
    // nothing true. Only the declared sides make this catchable at all.
    expectIssue(
      pack((p) => {
        (p.entrants as unknown[]).push({
          ref: "e-charlie",
          divisionRef: "d-main",
          kind: "individual",
          displayName: "Cy Chen",
        });
        (p.persons as unknown[]).push({ ref: "p-cy", fullName: "Cy Chen", lane: "player" });
        const expected = p.expected as Record<string, unknown>;
        const first = (expected.matches as Record<string, unknown>[])[0] as Record<string, unknown>;
        first.perSide = [
          { entrant: "e-alpha", line: "3" },
          { entrant: "e-charlie", line: "1" },
        ];
      }),
      ["expected", "matches", 0, "perSide", 1, "entrant"],
      /did not play fixture/i,
    );
  });

  it("perSide is [home, away] — a flipped stream then contradicts its own score lines", () => {
    // The second place a fixture's orientation is written down. Without it,
    // swapping a stream's home/away (the even-leg mirror) parses clean and
    // silently reassigns the winner — which is precisely how the pre-C1 pack
    // depended on the scheduling generator.
    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        const first = streams[0] as Record<string, unknown>;
        first.home = "e-bravo";
        first.away = "e-alpha";
        const expected = p.expected as Record<string, unknown>;
        const m = (expected.matches as Record<string, unknown>[])[0] as Record<string, unknown>;
        m.perSide = [
          { entrant: "e-alpha", line: "3" },
          { entrant: "e-bravo", line: "1" },
        ];
      }),
      ["expected", "matches", 0, "perSide"],
      /perSide is \[home, away\]/i,
    );
  });

  it("per-fixture lineups parse, and slot/orderNo carry their documented defaults", () => {
    const p = parsed(
      pack((draft) => {
        const streams = draft.streams as Record<string, unknown>[];
        (streams[0] as Record<string, unknown>).lineups = {
          home: [{ person: "p-ana", squadNumber: 1, roles: ["captain"] }],
          away: [{ person: "p-bo", slot: "bench", orderNo: 4, role: "coach", pairOrder: 1 }],
        };
      }),
    );
    const lineups = p.streams[0]?.lineups;
    expect(lineups?.home[0]?.slot).toBe("starting");
    expect(lineups?.home[0]?.orderNo).toBeUndefined();
    expect(lineups?.away[0]?.slot).toBe("bench");
    expect(lineups?.away[0]?.role).toBe("coach");
    expect(lineups?.away[0]?.pairOrder).toBe(1);
  });

  it("a lineup may name a person who was never rostered, but never one the pack did not declare", () => {
    // The product allows exactly this (api-v1 CreateEntrant/PutLineup's
    // eligibility_override: "a lineup can name a person who was never gated
    // at roster time"), so the rule is DECLARED, not rostered.
    const neverRostered = pack((p) => {
      (p.persons as unknown[]).push({ ref: "p-late", fullName: "Late Arrival", lane: "player" });
      const streams = p.streams as Record<string, unknown>[];
      (streams[0] as Record<string, unknown>).lineups = {
        home: [{ person: "p-late" }],
        away: [{ person: "p-bo" }],
      };
    });
    expect(PackSchema.safeParse(neverRostered).success).toBe(true);

    expectIssue(
      pack((p) => {
        const streams = p.streams as Record<string, unknown>[];
        (streams[0] as Record<string, unknown>).lineups = {
          home: [{ person: "p-ghost" }],
          away: [{ person: "p-bo" }],
        };
      }),
      ["streams", 0, "lineups", "home", 0, "person"],
      /unknown person ref/i,
    );
  });

  it("a team sheet may not name one person twice, or reuse a squad number or orderNo", () => {
    const dup = (
      home: Record<string, unknown>[],
      at: (string | number)[],
      message: RegExp,
    ): void =>
      expectIssue(
        pack((p) => {
          (p.persons as unknown[]).push({ ref: "p-cy", fullName: "Cy Chen", lane: "player" });
          const streams = p.streams as Record<string, unknown>[];
          (streams[0] as Record<string, unknown>).lineups = { home, away: [{ person: "p-bo" }] };
        }),
        at,
        message,
      );
    dup(
      [{ person: "p-ana" }, { person: "p-ana" }],
      ["streams", 0, "lineups", "home", 1, "person"],
      /twice on the home sheet/i,
    );
    dup(
      [{ person: "p-ana", squadNumber: 7 }, { person: "p-cy", squadNumber: 7 }],
      ["streams", 0, "lineups", "home", 1, "squadNumber"],
      /duplicate squad number/i,
    );
    dup(
      [{ person: "p-ana", orderNo: 1 }, { person: "p-cy", orderNo: 1 }],
      ["streams", 0, "lineups", "home", 1, "orderNo"],
      /duplicate orderNo/i,
    );
  });
});

describe("PackSchema — the registration block (declared for B03r, unpopulated in v1)", () => {
  // Review round 1, I4: ~120 lines of contract shipped with no test and no
  // mutant is the inert-seam failure this programme keeps repeating. The block
  // stays (B03r needs it); the coverage is what was missing.
  function withRegistration(mutate: (block: Record<string, unknown>) => void): Record<string, unknown> {
    return pack((p) => {
      (p.persons as unknown[]).push(
        { ref: "p-cap", fullName: "Cap Tain", lane: "player" },
        { ref: "p-joiner", fullName: "Joe Iner", lane: "player" },
      );
      const block: Record<string, unknown> = {
        category: "open",
        entrantKind: "team",
        feeCents: 0,
        approval: "manual",
        entries: [
          { extKey: "entry-1", captain: "p-cap", roster: ["p-ana"], pay: false, expect: "entrant" },
        ],
        joins: [{ entry: "entry-1", person: "p-joiner", consent: "granted" }],
        organiser: [{ action: "approve", target: "entry-1" }],
        expect: { entrants: 1, waitlisted: 0, rejected: 0, paidCents: 0 },
      };
      mutate(block);
      p.registration = { byDivision: { "d-main": block } };
    });
  }

  it("a well-formed registration block parses", () => {
    const p = parsed(withRegistration(() => {}));
    expect(Object.keys(p.registration?.byDivision ?? {})).toEqual(["d-main"]);
    expect(p.registration?.byDivision["d-main"]?.entries[0]?.expect).toBe("entrant");
  });

  // Job 1 (B03r): currency moved OFF the division block and onto the org,
  // because V365__org_currency.sql dropped `registration_settings.currency`
  // outright — see `PackOrg.currency`'s and `PackRegistrationBlock`'s own
  // doc comments for the full "why". Two witnesses below: the new home
  // parses, and the OLD shape (currency back on the division block) is now
  // a `strictObject` rejection — without this second test the move is
  // unwitnessed (a currency key silently vanishing would parse just as
  // cleanly as one silently accepted).
  it("currency lives on org, lower-case ISO-4217, and defaults to absent", () => {
    const p = parsed(withRegistration(() => {}));
    expect(p.org.currency).toBeUndefined();
    const withCurrency = pack((draft) => {
      (draft.org as Record<string, unknown>).currency = "usd";
    });
    expect(parsed(withCurrency).org.currency).toBe("usd");
  });

  it("an upper-case or non-3-letter org currency is rejected", () => {
    expectIssue(
      pack((draft) => {
        (draft.org as Record<string, unknown>).currency = "USD";
      }),
      ["org", "currency"],
      /lower-case ISO-4217/i,
    );
    expectIssue(
      pack((draft) => {
        (draft.org as Record<string, unknown>).currency = "usdollar";
      }),
      ["org", "currency"],
      /lower-case ISO-4217/i,
    );
  });

  it("the OLD per-division currency shape is now rejected — the move is witnessed", () => {
    expectIssue(
      withRegistration((b) => {
        b.currency = "gbp";
      }),
      ["registration", "byDivision", "d-main"],
      /Unrecognized key.*currency/i,
    );
  });

  it("byDivision is keyed by a DECLARED division ref", () => {
    const bad = pack((p) => {
      (p.persons as unknown[]).push({ ref: "p-cap", fullName: "Cap Tain", lane: "player" });
      p.registration = {
        byDivision: {
          "d-ghost": {
            category: "open",
            entrantKind: "team",
            feeCents: 0,
            approval: "auto",
            expect: { entrants: 0, waitlisted: 0, rejected: 0, paidCents: 0 },
          },
        },
      };
    });
    expectIssue(bad, ["registration", "byDivision", "d-ghost"], /unknown division ref/i);
  });

  it("an entry's captain must be a declared person", () => {
    expectIssue(
      withRegistration((b) => {
        (b.entries as Record<string, unknown>[])[0]!.captain = "p-ghost";
      }),
      ["registration", "byDivision", "d-main", "entries", 0, "captain"],
      /unknown person ref/i,
    );
  });

  it("an entry's submitted roster must be declared people", () => {
    expectIssue(
      withRegistration((b) => {
        (b.entries as Record<string, unknown>[])[0]!.roster = ["p-ana", "p-ghost"];
      }),
      ["registration", "byDivision", "d-main", "entries", 0, "roster", 1],
      /unknown person ref/i,
    );
  });

  it("a join must target a declared entry, by a declared person", () => {
    expectIssue(
      withRegistration((b) => {
        (b.joins as Record<string, unknown>[])[0]!.entry = "entry-nope";
      }),
      ["registration", "byDivision", "d-main", "joins", 0, "entry"],
      /unknown registration entry/i,
    );
    expectIssue(
      withRegistration((b) => {
        (b.joins as Record<string, unknown>[])[0]!.person = "p-ghost";
      }),
      ["registration", "byDivision", "d-main", "joins", 0, "person"],
      /unknown person ref/i,
    );
  });

  it("an organiser action must target a declared entry", () => {
    expectIssue(
      withRegistration((b) => {
        (b.organiser as Record<string, unknown>[])[0]!.target = "entry-nope";
      }),
      ["registration", "byDivision", "d-main", "organiser", 0, "target"],
      /unknown registration entry/i,
    );
  });

  // Gap 1 (B03r-repins-2026-09-03.md, owner ruling 2026-09-04): a
  // non-1-January eligibility cutoff. `ageCutoffMonth`/`ageCutoffDay`
  // mirror `divisions.age_cutoff_month`/`age_cutoff_day` (V364/V380).
  it("ageCutoffMonth/ageCutoffDay parse, independently, and default to absent", () => {
    const p = parsed(
      withRegistration((b) => {
        b.ageCutoffMonth = 9;
        b.ageCutoffDay = 1;
      }),
    );
    expect(p.registration?.byDivision["d-main"]?.ageCutoffMonth).toBe(9);
    expect(p.registration?.byDivision["d-main"]?.ageCutoffDay).toBe(1);
    // Absent by default, same as ageMin/ageMax — an existing pack that never
    // sets a cutoff parses unchanged.
    const bare = parsed(withRegistration(() => {}));
    expect(bare.registration?.byDivision["d-main"]?.ageCutoffMonth).toBeUndefined();
    expect(bare.registration?.byDivision["d-main"]?.ageCutoffDay).toBeUndefined();
  });

  it("an out-of-range ageCutoffMonth/ageCutoffDay is rejected", () => {
    expectIssue(
      withRegistration((b) => {
        b.ageCutoffMonth = 13;
      }),
      ["registration", "byDivision", "d-main", "ageCutoffMonth"],
      /.*/,
    );
    expectIssue(
      withRegistration((b) => {
        b.ageCutoffMonth = 0;
      }),
      ["registration", "byDivision", "d-main", "ageCutoffMonth"],
      /.*/,
    );
    expectIssue(
      withRegistration((b) => {
        b.ageCutoffDay = 32;
      }),
      ["registration", "byDivision", "d-main", "ageCutoffDay"],
      /.*/,
    );
    expectIssue(
      withRegistration((b) => {
        b.ageCutoffDay = 0;
      }),
      ["registration", "byDivision", "d-main", "ageCutoffDay"],
      /.*/,
    );
  });

  // Gap 2 (B03r-repins-2026-09-03.md, owner ruling 2026-09-04):
  // `PackPerson.gender` now admits `"x"`, matching the product's "x never
  // blocks" category exemption (registration-rules.ts ~:177-178).
  it("a person's gender may be declared 'x'", () => {
    const p = parsed(
      pack((draft) => {
        const persons = draft.persons as Record<string, unknown>[];
        (persons[0] as Record<string, unknown>).gender = "x";
      }),
    );
    expect(p.persons[0]?.gender).toBe("x");
  });

  it("a gender value other than m/f/x is still rejected", () => {
    expectIssue(
      pack((draft) => {
        const persons = draft.persons as Record<string, unknown>[];
        (persons[0] as Record<string, unknown>).gender = "nonbinary";
      }),
      ["persons", 0, "gender"],
      /.*/,
    );
  });
});

describe("PackSchema — pre-freeze reservations (venues, officials, claim invites)", () => {
  function withReservations(mutate: (p: Record<string, unknown>) => void): Record<string, unknown> {
    return pack((p) => {
      (p.persons as unknown[]).push({ ref: "p-ref", fullName: "Ref Eree", lane: "official" });
      p.venues = [
        {
          ref: "v-main",
          name: "Bench Arena",
          address: "1 Bench Way",
          courts: [
            { ref: "c-1", name: "Court 1", tags: ["indoor"] },
            { ref: "c-2", name: "Court 2" },
          ],
        },
      ];
      p.officials = [
        {
          ref: "o-ref",
          person: "p-ref",
          displayName: "Ref Eree",
          roleKeys: ["referee", "umpire"],
          maxPerDay: 3,
          unavailable: [{ date: "2099-01-02", note: "travelling" }],
          assignments: [{ divisionRef: "d-main", fixtureExtKey: "rr-r1-c1", roleKey: "referee" }],
        },
      ];
      p.claimInvites = [{ person: "p-ana", email: "ana@example.com" }];
      const divisions = p.divisions as Record<string, unknown>[];
      (divisions[0] as Record<string, unknown>).scheduleConfig = {
        matchMinutes: 30,
        gapMinutes: 0,
        courts: ["@c-1", "@c-2"],
      };
      mutate(p);
    });
  }

  it("a fully-populated reservation set parses", () => {
    const p = parsed(withReservations(() => {}));
    expect(p.venues?.[0]?.courts.map((c) => c.ref)).toEqual(["c-1", "c-2"]);
    expect(p.venues?.[0]?.courts[1]?.tags).toEqual([]);
    expect(p.officials?.[0]?.roleKeys).toEqual(["referee", "umpire"]);
    expect(p.claimInvites?.[0]?.email).toBe("ana@example.com");
  });

  it("court refs are unique across ALL venues, because scheduleConfig names them unqualified", () => {
    expectIssue(
      withReservations((p) => {
        (p.venues as Record<string, unknown>[]).push({
          ref: "v-second",
          name: "Second Arena",
          courts: [{ ref: "c-1", name: "Court 1" }],
        });
      }),
      ["venues", 1, "courts", 0, "ref"],
      /duplicate court ref/i,
    );
  });

  it("an @-ref inside the opaque scheduleConfig must name a declared court or venue", () => {
    expectIssue(
      withReservations((p) => {
        const divisions = p.divisions as Record<string, unknown>[];
        const cfg = (divisions[0] as Record<string, unknown>).scheduleConfig as Record<string, unknown>;
        cfg.courts = ["@c-1", "@c-ghost"];
      }),
      ["divisions", 0, "scheduleConfig"],
      /unknown pack ref "@c-ghost"/i,
    );
  });

  it("an official must be a person in the OFFICIAL lane", () => {
    // Bench design §9 P1 seeds officials as lane=official; persons.lane admits
    // it (V348, widened by V356). A player-lane person here would seed an
    // official the product's own lane split says is not one.
    expectIssue(
      withReservations((p) => {
        (p.officials as Record<string, unknown>[])[0]!.person = "p-ana";
      }),
      ["officials", 0, "person"],
      /lane "player".*must be a person in the "official" lane/i,
    );
  });

  it("an official's assignment must name a fixture the pack declares", () => {
    expectIssue(
      withReservations((p) => {
        const a = ((p.officials as Record<string, unknown>[])[0]!.assignments as Record<string, unknown>[])[0]!;
        a.fixtureExtKey = "rr-r9-c9";
      }),
      ["officials", 0, "assignments", 0, "fixtureExtKey"],
      /no stream declares fixture/i,
    );
  });

  it("an official cannot be assigned a role they do not declare", () => {
    expectIssue(
      withReservations((p) => {
        const a = ((p.officials as Record<string, unknown>[])[0]!.assignments as Record<string, unknown>[])[0]!;
        a.roleKey = "timekeeper";
      }),
      ["officials", 0, "assignments", 0, "roleKey"],
      /not declared for role/i,
    );
  });

  it("an official may not declare the same blackout date twice (mirrors V284's unique(official_id, date))", () => {
    expectIssue(
      withReservations((p) => {
        (p.officials as Record<string, unknown>[])[0]!.unavailable = [
          { date: "2099-01-02" },
          { date: "2099-01-02", note: "again" },
        ];
      }),
      ["officials", 0, "unavailable", 1, "date"],
      /unavailable twice/i,
    );
  });

  it("a claim invite names a declared person, once, at a unique address", () => {
    expectIssue(
      withReservations((p) => {
        (p.claimInvites as Record<string, unknown>[])[0]!.person = "p-ghost";
      }),
      ["claimInvites", 0, "person"],
      /unknown person ref/i,
    );
    expectIssue(
      withReservations((p) => {
        (p.claimInvites as Record<string, unknown>[]).push({ person: "p-ana", email: "other@example.com" });
      }),
      ["claimInvites", 1, "person"],
      /already has a claim invite/i,
    );
    expectIssue(
      withReservations((p) => {
        (p.claimInvites as Record<string, unknown>[]).push({ person: "p-bo", email: "ANA@example.com" });
      }),
      ["claimInvites", 1, "email"],
      /invited twice/i,
    );
  });

  it("persons carry the B03r dob/gender reservation; divisions default entry to admin", () => {
    const p = parsed(
      pack((draft) => {
        const persons = draft.persons as Record<string, unknown>[];
        (persons[0] as Record<string, unknown>).dob = "1998-04-11";
        (persons[0] as Record<string, unknown>).gender = "f";
      }),
    );
    expect(p.persons[0]?.dob).toBe("1998-04-11");
    expect(p.persons[0]?.gender).toBe("f");
    // Default, not absence: "no entry mode declared" and "admin" must not be
    // two different shapes for B03r's mode resolver.
    expect(p.divisions[0]?.entry).toBe("admin");
  });

  it("provenance admits the B03r 'synthetic' value, and still refuses anything else", () => {
    const ok = pack((p) => {
      const streams = p.streams as Record<string, unknown>[];
      (streams[0] as Record<string, unknown>).provenance = "synthetic";
    });
    expect(PackSchema.safeParse(ok).success).toBe(true);
    const bad = pack((p) => {
      const streams = p.streams as Record<string, unknown>[];
      (streams[0] as Record<string, unknown>).provenance = "made-up";
    });
    expect(PackSchema.safeParse(bad).success).toBe(false);
  });

  it("org.timezone is required — there is no UTC default to silently shift a certificate", () => {
    const result = PackSchema.safeParse(
      pack((p) => {
        delete (p.org as Record<string, unknown>).timezone;
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) => JSON.stringify(i.path) === JSON.stringify(["org", "timezone"])),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B04 T7 — a court's own calendar
//
// The checker's court-hours rule (`checker.ts`'s rule 2, third operand)
// recomputes containment from the RAW `court_hours` / `court_exceptions` rows
// on `BoardCourt`, deliberately without the engine's `usableWindows`. Until
// this block existed, `PackCourt` carried no hours field at all, so no pack
// could author a court whose hours a fixture could fall outside and the rule
// could not fire on any pack that could ever exist — the design's own
// flagship justification for the independent recomputation, unreachable.
//
// The shape is the PRODUCT'S, not a bench dialect: `CourtHourRangeInput` /
// `CourtExceptionInput` (`apps/web/src/server/usecases/venues.ts:132-169`) on
// the way in, `CourtWithCalendar` (`api-v1/schemas.ts:4514-4518`) on the way
// back out of `GET /orgs/{id}/venues`. Only the key CASE differs — the pack
// dialect is camelCase throughout and there is not one snake_case key in
// `PackSchema` — and the camelCase spelling here is the engine's OWN
// (`CourtHoursRow` / `CourtExceptionRow`, `court-windows.ts:59,68`), which is
// exactly what `BoardCourt` carries. `seed.ts` renames once, at the wire.
// ---------------------------------------------------------------------------

describe("PackSchema — a court's own calendar (B04 T7)", () => {
  function withCalendar(
    hours: unknown,
    exceptions?: unknown,
  ): Record<string, unknown> {
    return pack((p) => {
      p.venues = [
        {
          ref: "v-main",
          name: "Bench Arena",
          courts: [
            {
              ref: "c-1",
              name: "Court 1",
              hours,
              ...(exceptions === undefined ? {} : { exceptions }),
            },
          ],
        },
      ];
    });
  }

  it("a court may declare weekly hours and dated exceptions, and they round-trip verbatim", () => {
    const p = parsed(
      withCalendar(
        [
          { weekday: 1, openMin: 480, closeMin: 720 },
          { weekday: 1, openMin: 780, closeMin: 1200 },
          { weekday: 2, openMin: 480, closeMin: 1200 },
        ],
        [
          { date: "2099-01-02", closed: true },
          { date: "2099-01-03", closed: false, openMin: 600, closeMin: 660 },
        ],
      ),
    );
    const court = p.venues?.[0]?.courts[0];
    expect(court?.hours).toEqual([
      { weekday: 1, openMin: 480, closeMin: 720 },
      { weekday: 1, openMin: 780, closeMin: 1200 },
      { weekday: 2, openMin: 480, closeMin: 1200 },
    ]);
    expect(court?.exceptions).toEqual([
      { date: "2099-01-02", closed: true },
      { date: "2099-01-03", closed: false, openMin: 600, closeMin: 660 },
    ]);
  });

  it("a court that declares NO calendar defaults both lists to empty — which is the product's 'open all day'", () => {
    // `court-windows.ts`'s note 1, restated in `checker.ts`'s header: ZERO
    // `court_hours` rows is a property of the COURT and means open all day,
    // every day. So the default has to be `[]` and never a synthesised
    // 00:00-24:00 row, which would be a different fact wearing the same shape.
    const p = parsed(
      pack((p2) => {
        p2.venues = [
          { ref: "v-main", name: "Bench Arena", courts: [{ ref: "c-1", name: "Court 1" }] },
        ];
      }),
    );
    expect(p.venues?.[0]?.courts[0]?.hours).toEqual([]);
    expect(p.venues?.[0]?.courts[0]?.exceptions).toEqual([]);
  });

  it("a weekly range must open BEFORE it closes — the product's own refine, not a bench invention", () => {
    expectIssue(
      withCalendar([{ weekday: 1, openMin: 720, closeMin: 720 }]),
      ["venues", 0, "courts", 0, "hours", 0, "closeMin"],
      /openMin must be before closeMin/i,
    );
  });

  it("weekday is 0..6 with 0 = Sunday, matching CourtHoursRow's own convention", () => {
    expectIssue(
      withCalendar([{ weekday: 7, openMin: 480, closeMin: 1200 }]),
      ["venues", 0, "courts", 0, "hours", 0, "weekday"],
      /less than or equal to 6|<=\s*6|too big/i,
    );
  });

  it("a CLOSED exception may not also carry a range — the table's CHECK constraint makes them exclusive", () => {
    expectIssue(
      withCalendar([], [{ date: "2099-01-02", closed: true, openMin: 600, closeMin: 660 }]),
      ["venues", 0, "courts", 0, "exceptions", 0],
      /closed exception must omit/i,
    );
  });

  it("an OPEN exception must carry both bounds — a half-declared range would read as a closure", () => {
    expectIssue(
      withCalendar([], [{ date: "2099-01-02", closed: false, openMin: 600 }]),
      ["venues", 0, "courts", 0, "exceptions", 0],
      /open exception needs both/i,
    );
  });

  it("two ranges that OVERLAP on one weekday are refused here, not left to the route's 422", () => {
    // `assertNoHoursOverlap` (usecases/venues.ts:200) is a 422
    // COURT_HOURS_OVERLAP at seed time, which would abort a live run with an
    // opaque HTTP error long after stage 0 called the pack clean.
    expectIssue(
      withCalendar([
        { weekday: 3, openMin: 480, closeMin: 720 },
        { weekday: 3, openMin: 700, closeMin: 1200 },
      ]),
      ["venues", 0, "courts", 0, "hours", 1],
      /overlaps/i,
    );
  });

  it("BACK-TO-BACK ranges on one weekday are legal — close_min == the next open_min is not an overlap", () => {
    // The positive pair for the rule above: a guard that refused everything
    // would pass that test and this one is what stops it.
    const p = parsed(
      withCalendar([
        { weekday: 3, openMin: 480, closeMin: 720 },
        { weekday: 3, openMin: 720, closeMin: 1200 },
      ]),
    );
    expect(p.venues?.[0]?.courts[0]?.hours).toHaveLength(2);
  });

  it("two ranges on DIFFERENT weekdays never overlap, however they are ordered", () => {
    const p = parsed(
      withCalendar([
        { weekday: 3, openMin: 480, closeMin: 1200 },
        { weekday: 4, openMin: 480, closeMin: 1200 },
      ]),
    );
    expect(p.venues?.[0]?.courts[0]?.hours).toHaveLength(2);
  });

  it("two exceptions on ONE date are refused — the table's primary key admits exactly one", () => {
    // `assertNoDuplicateExceptionDates` is the other 422 on this route, and
    // `checker.ts`'s `courtRangesOn` reads `exceptions.find(...)`, so a second
    // row for the same date would be silently unreachable.
    expectIssue(
      withCalendar(
        [],
        [
          { date: "2099-01-02", closed: true },
          { date: "2099-01-02", closed: false, openMin: 600, closeMin: 660 },
        ],
      ),
      ["venues", 0, "courts", 0, "exceptions", 1],
      /duplicate exception date/i,
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

  it("a standings claim's field vocabulary IS the engine's StandingsDelta scalars", () => {
    // Runtime half of the compile-time pin (STANDINGS_FIELDS_ARE_* in
    // pack-schema.ts). tsc catches a drift in the LIST; this catches a claim
    // reaching for a field that is not a scalar at all — `metrics` is a
    // Record and `entrantId` a string, so neither is comparable with `equals`.
    //
    // The positive loop is DERIVED FROM THE ENGINE, not from
    // STANDINGS_SCALAR_FIELDS. Iterating the enum's own source could not fail
    // whatever that list held: dropping two entries left this green, and it
    // was typecheck and the _tiny tests that caught it. `StandingsDelta` ships
    // as a runtime zod object, so its scalar fields are recoverable
    // behaviourally — a number field accepts 0, a string field and a record
    // do not — which gives the test a path to the truth the schema does not
    // sit on.
    const engineScalars = Object.entries(StandingsDelta.shape)
      .filter(([, member]) => (member as z.ZodTypeAny).safeParse(0).success)
      .map(([key]) => key);
    // Non-vacuity: a derivation that matched nothing would make the loop below
    // assert nothing at all.
    expect(engineScalars.length).toBeGreaterThan(0);
    // Sorted: a cosmetic field reorder in core/types.ts must not red the
    // bench. The SET is the contract; the order is the engine's business.
    expect([...engineScalars].sort()).toEqual([...STANDINGS_SCALAR_FIELDS].sort());
    for (const field of engineScalars) {
      const ok = pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.specials = [
          {
            kind: "draw_half_points",
            divisionRef: "d-main",
            fixtureExtKey: "rr-r1-c1",
            claims: [{ on: "standings", entrant: "e-alpha", field, equals: 1 }],
          },
        ];
      });
      expect(PackSchema.safeParse(ok).success, `field "${field}" was refused`).toBe(true);
    }
    for (const field of ["metrics", "entrantId", "goalDifference"]) {
      const bad = pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.specials = [
          {
            kind: "draw_half_points",
            divisionRef: "d-main",
            fixtureExtKey: "rr-r1-c1",
            claims: [{ on: "standings", entrant: "e-alpha", field, equals: 1 }],
          },
        ];
      });
      expect(PackSchema.safeParse(bad).success, `field "${field}" was accepted`).toBe(false);
    }
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

  // -------------------------------------------------------------------------
  // The nine specials, each with a REALISTIC claim derived from the engine
  // site that actually represents it.
  //
  // The previous version of this test gave all nine the identical placeholder
  // claim `{on:"state", path:"phase", equals:"done"}` and asserted the enum
  // round-tripped — which proved the list had nine members and nothing about
  // whether any of them could be expressed. That is exactly how the
  // concussion-substitute gap (no claim branch reached SquadState.exemptUsed)
  // survived a full mutation sweep. Review round 1, I2.
  //
  // `on` is pinned per kind on purpose: it is the assertion that would have
  // caught that gap, because `concussion_sub` is the one row that CANNOT be
  // an `outcome`, a `state` or a `standings` claim.
  // -------------------------------------------------------------------------
  const NINE_SPECIALS: {
    kind: string;
    on: string;
    claim: Record<string, unknown>;
    /** The engine site this representation comes from. */
    from: string;
  }[] = [
    {
      kind: "super_over",
      on: "outcome",
      // MatchOutcome.method's own comment lists 'super_over' (core/types.ts).
      claim: { on: "outcome", kind: "win", winner: "e-alpha", method: "super_over" },
      from: "core/types.ts MatchOutcome.method; cricket.ts:365 cricket.superover.ball",
    },
    {
      kind: "dls_revise",
      on: "state",
      // CricketState.revisedTarget / targetSource, cricket.ts:465-466.
      claim: { on: "state", path: "revisedTarget", equals: 231 },
      from: "cricket.ts:465-466",
    },
    {
      kind: "shootout",
      on: "outcome",
      // period/kernel.ts:1433 winPoints(cfg, "shootout"); :2284 reads
      // outcome.method !== "shootout".
      claim: { on: "outcome", kind: "win", winner: "e-alpha", method: "shootout" },
      from: "period/kernel.ts:1433, :2284",
    },
    {
      kind: "ot_gws",
      on: "outcome",
      // period/kernel.ts:1009 / :1109 decideWin(..., "extra_time").
      claim: { on: "outcome", kind: "win", winner: "e-alpha", method: "extra_time" },
      from: "period/kernel.ts:1009, :1109",
    },
    {
      kind: "final_set_tb",
      on: "state",
      // ClosedSet.mtb — 'non-null = the set IS a match tie-break'
      // (nested/kernel.ts SetRules/rulesFor, ClosedSet.mtb?: boolean).
      claim: { on: "state", path: "sets.2.mtb", equals: true },
      from: "nested/kernel.ts ClosedSet.mtb, rulesFor():853",
    },
    {
      kind: "expedite",
      on: "state",
      // SetBasedState.expedite?: boolean, setbased/kernel.ts:346.
      claim: { on: "state", path: "expedite", equals: true },
      from: "setbased/kernel.ts:346",
    },
    {
      kind: "retirement",
      on: "outcome",
      // core.forfeit is a CORE type; generic folds it to {kind:"award"}
      // (generic.ts:555-562) and _tiny proves that end to end.
      claim: { on: "outcome", kind: "award", winner: "e-alpha" },
      from: "core/events.ts CoreForfeit; generic.ts:555-562",
    },
    {
      kind: "concussion_sub",
      // THE ROW THAT FORCED THE `squads` BRANCH. No event type; the charge is
      // only observable in SquadState.exemptUsed (core/lineup.ts:100), which
      // foldMatchWithStoppage returns SEPARATELY from the module state
      // (core/events.ts:464) — so no outcome/state/standings claim reaches it.
      on: "squads",
      claim: { on: "squads", entrant: "e-alpha", field: "exemptUsed", exemption: "concussion", equals: 1 },
      from: "core/lineup.ts:100 exemptUsed; core/events.ts:464; cricket.ts:103 cap",
    },
    {
      kind: "draw_half_points",
      on: "standings",
      // Half-points are the SCORING MODEL, points stored doubled: win 2,
      // draw 1, loss 0 (boardgame.ts:38-44). A draw is worth 1, not 0.5.
      claim: { on: "standings", entrant: "e-alpha", field: "points", equals: 1 },
      from: "boardgame.ts:38-44",
    },
  ];

  it("all nine special kinds are expressible, each with its real representation", () => {
    const ok = pack((p) => {
      const expected = p.expected as Record<string, unknown>;
      expected.specials = NINE_SPECIALS.map((row) => ({
        kind: row.kind,
        divisionRef: "d-main",
        fixtureExtKey: "rr-r1-c1",
        note: row.from,
        claims: [row.claim],
      }));
    });
    const p = parsed(ok);
    expect(p.expected.specials).toHaveLength(9);
    // Each kind keeps the claim SHAPE its engine representation requires.
    // Asserting `on` per kind is what makes this test able to fail: a claim
    // union that lost a branch would stop parsing exactly one row.
    expect(p.expected.specials.map((sp) => [sp.kind, sp.claims[0]?.on])).toEqual(
      NINE_SPECIALS.map((row) => [row.kind, row.on]),
    );
  });

  it("each of the nine parses on its own — a red names ONE kind, not the batch", () => {
    for (const row of NINE_SPECIALS) {
      const one = pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.specials = [
          { kind: row.kind, divisionRef: "d-main", fixtureExtKey: "rr-r1-c1", claims: [row.claim] },
        ];
      });
      const result = PackSchema.safeParse(one);
      expect(
        result.success,
        `special "${row.kind}" (${row.from}) did not parse: ${
          result.success ? "" : JSON.stringify(result.error.issues)
        }`,
      ).toBe(true);
    }
  });

  it("concussion_sub needs the squads branch — no state path can reach exemptUsed", () => {
    // The gap I2 exposed, pinned. `foldMatchWithStoppage` returns
    // `{ state, stoppage, squads }` (core/events.ts:464): `squads` is a
    // SIBLING of the module state, so a `{on:"state"}` path rooted at the
    // module state cannot address it however it is spelled.
    //
    // This test PARSES the claim. Its first version only read the test file's
    // own NINE_SPECIALS constant and asserted its fields — so deleting the
    // `squads` branch from PackClaim left it green, and the one test named for
    // I1's fix proved nothing about it (review round 2, minor 1).
    const claim = NINE_SPECIALS.find((r) => r.kind === "concussion_sub")?.claim;
    expect(claim).toBeDefined();

    const result = PackSchema.safeParse(
      pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.specials = [
          {
            kind: "concussion_sub",
            divisionRef: "d-main",
            fixtureExtKey: "rr-r1-c1",
            claims: [claim],
          },
        ];
      }),
    );
    expect(
      result.success,
      `the concussion claim did not parse: ${result.success ? "" : JSON.stringify(result.error.issues)}`,
    ).toBe(true);
    if (!result.success) return;

    // And it survives the parse as a squads claim naming the exemption — a
    // union that silently matched some OTHER branch would fail here.
    const parsedClaim = result.data.expected.specials[0]?.claims[0];
    expect(parsedClaim?.on).toBe("squads");
    if (parsedClaim?.on !== "squads") return;
    expect(parsedClaim.field).toBe("exemptUsed");
    expect(parsedClaim.exemption).toBe("concussion");
    expect(parsedClaim.equals).toBe(1);
  });

  it("a squads claim on exemptUsed MUST name the exemption key", () => {
    expectIssue(
      pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.specials = [
          {
            kind: "concussion_sub",
            divisionRef: "d-main",
            fixtureExtKey: "rr-r1-c1",
            claims: [{ on: "squads", entrant: "e-alpha", field: "exemptUsed", equals: 1 }],
          },
        ];
      }),
      ["expected", "specials", 0, "claims", 0, "exemption"],
      /must name the exemption key/i,
    );
  });

  it("a squads claim on subsUsed must NOT name an exemption key", () => {
    // The other direction. subsUsed is a single scalar; an exemption key on it
    // reads as a claim about a channel it does not describe — and the two are
    // deliberately separate (core/lineup.ts:93-96).
    expectIssue(
      pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.specials = [
          {
            kind: "concussion_sub",
            divisionRef: "d-main",
            fixtureExtKey: "rr-r1-c1",
            claims: [
              { on: "squads", entrant: "e-alpha", field: "subsUsed", exemption: "concussion", equals: 3 },
            ],
          },
        ];
      }),
      ["expected", "specials", 0, "claims", 0, "exemption"],
      /must not/i,
    );
  });

  it("a squads claim names an entrant of the special's own division", () => {
    expectIssue(
      pack((p) => {
        const expected = p.expected as Record<string, unknown>;
        expected.specials = [
          {
            kind: "concussion_sub",
            divisionRef: "d-main",
            fixtureExtKey: "rr-r1-c1",
            claims: [{ on: "squads", entrant: "e-ghost", field: "subsUsed", equals: 1 }],
          },
        ];
      }),
      ["expected", "specials", 0, "claims", 0, "entrant"],
      /unknown entrant ref/i,
    );
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

  it("is three divisions, six entrants, five streams, exactly two reconstructed", () => {
    // B03 T5 added `d-badminton` alongside `d-tiny` — the pack's first real
    // exercise of the multi-division generalisation `tinyPlan`'s
    // `divisions.length !== 1` refusal used to block (deleted in T4). B03r
    // tasks 9+10 added `d-registration` (registration-ui smoke floor) — it
    // declares TWO more entrants (the "shadow" rows a live run never seeds,
    // build-packs/_tiny.ts's own comment) but NO streams of its own. B05 T3
    // added d-tiny's own playoff final (`se-r0-i0`, provenance "real"), which
    // is why the stream count moved to five while "reconstructed" did not.
    const p = parsed(raw);
    expect(p.divisions).toHaveLength(3);
    expect(p.entrants).toHaveLength(6);
    expect(p.streams).toHaveLength(5);
    expect(p.streams.filter((s) => s.provenance === "reconstructed")).toHaveLength(2);
  });

  it("its fixture ext_keys are the ones the real round-robin generator emits, per division", () => {
    // packages/engine/src/scheduling/roundrobin.ts:140 — `rr-r{round}-c{court}`,
    // three rounds because d-tiny's stage config asks for three legs
    // (usecases/stages.ts:755-758). If this drifts, B03 will seed fixtures the
    // streams cannot bind to. d-badminton declares one leg (2 entrants), hence
    // ONE fixture — "rr-r1-c1" again, the SAME text as d-tiny's first fixture,
    // because the generator's id is `rr-r{round}-c{court}` regardless of
    // sport; it is legal here only because an ext_key is unique per DIVISION,
    // never globally (pack-schema.ts's own `checkStreams` comment).
    const p = parsed(raw);
    const tinyDivision = p.divisions.find((d) => d.ref === "d-tiny");
    const badmintonDivision = p.divisions.find((d) => d.ref === "d-badminton");
    // B05 T3: "se-r0-i0" is `buildSingleElim`'s own id for d-tiny's second
    // stage, s-playoff — a 2-slot single-elim bracket, not a round-robin
    // fixture, so it does not follow the `rr-r{round}-c{court}` pattern this
    // test's own name describes; it is asserted here anyway because it is
    // still a d-tiny stream.
    expect(
      p.streams.filter((s) => s.divisionRef === "d-tiny").map((s) => s.fixtureExtKey),
    ).toEqual(["rr-r1-c1", "rr-r2-c1", "rr-r3-c1", "se-r0-i0"]);
    expect(tinyDivision?.stages[0]?.config).toEqual({ legs: 3 });
    expect(
      p.streams.filter((s) => s.divisionRef === "d-badminton").map((s) => s.fixtureExtKey),
    ).toEqual(["rr-r1-c1"]);
    expect(badmintonDivision?.stages[0]?.config).toEqual({ legs: 1 });
  });
});

// ---------------------------------------------------------------------------
// The template-subset proof. The product schema is `server-only` and reaches
// @grpc/grpc-js, and tsconfig.scripts.json cannot resolve its `@/` aliases —
// so it is read as TEXT and its declared key list extracted. An extraction
// that silently matches nothing would pass vacuously, which is why every
// guard below exists.
// ---------------------------------------------------------------------------

/** One key as the product schema declares it. `optional` is read from the
 *  declaration text, so a key that becomes required (or stops being) moves
 *  this test with it instead of leaving it asserting yesterday's shape. */
export interface DeclaredKey {
  name: string;
  optional: boolean;
}

/** Pulls the top-level keys out of one `export const <name> = z.object({…})`
 *  declaration. Throws — never returns empty — when the anchor is missing, so
 *  a RENAME of the product symbol reds this suite instead of quietly yielding
 *  []. Also reports whether the object literal closes with `.strict()`, since
 *  that is what makes a STRAY key a hard failure rather than a silent strip. */
export function declaredKeys(
  source: string,
  symbol: string,
): { keys: DeclaredKey[]; strict: boolean } {
  const anchor = `export const ${symbol} = z.object({`;
  const start = source.indexOf(anchor);
  if (start < 0) {
    throw new Error(
      `templates/schema.ts declares no "${anchor}" — the product symbol was renamed or reshaped; ` +
        `this extraction (and the subset proof built on it) is stale.`,
    );
  }
  const body = source.slice(start + anchor.length);
  const end = body.indexOf("\n})");
  if (end < 0) throw new Error(`could not find the end of ${symbol}'s object literal`);
  const strict = body.slice(end, end + 20).startsWith("\n}).strict()");
  const withoutComments = body
    .slice(0, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const lines = withoutComments.split("\n");
  const hits: { name: string; line: number }[] = [];
  lines.forEach((line, i) => {
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (m?.[1]) hits.push({ name: m[1], line: i });
  });
  const keys = hits.map((hit, i) => {
    // A declaration may wrap, so read to the START of the next key (or the
    // end of the literal) rather than assuming one line per key.
    const until = hits[i + 1]?.line ?? lines.length;
    const declaration = lines.slice(hit.line, until).join("\n");
    return { name: hit.name, optional: /\.(optional|nullish)\(\)/.test(declaration) };
  });
  return { keys, strict };
}

const keyNames = (source: string, symbol: string): string[] =>
  declaredKeys(source, symbol).keys.map((k) => k.name);

describe("packToTemplateSkeleton — the pack schema is a superset of the template schema", () => {
  const source = readFileSync(TEMPLATE_SCHEMA_PATH, "utf8");

  it("the extraction is not vacuous — it finds real keys, and throws on a rename", () => {
    const compKeys = keyNames(source, "CompetitionTemplate");
    const divKeys = keyNames(source, "TemplateDivision");
    const stageKeys = keyNames(source, "TemplateStage");
    // The zero-key trap this test exists to make impossible.
    expect(compKeys.length).toBeGreaterThan(0);
    expect(divKeys.length).toBeGreaterThan(0);
    expect(stageKeys.length).toBeGreaterThan(0);
    // Sentinels: an extraction that returned garbage (comment prose, say)
    // would still have a non-zero length, so pin one load-bearing key each.
    expect(compKeys).toContain("divisions");
    expect(divKeys).toContain("sportKey");
    expect(stageKeys).toContain("kind");
    expect(() => declaredKeys(source, "ThisSymbolDoesNotExist")).toThrow(/renamed or reshaped/);
  });

  it("the optionality read is not vacuous — TemplateStage has both required and optional keys", () => {
    // Without this, a broken optionality parse that marked everything optional
    // would make the required-key check below assert nothing at all.
    const { keys } = declaredKeys(source, "TemplateStage");
    expect(keys.filter((k) => k.optional).length).toBeGreaterThan(0);
    expect(keys.filter((k) => !k.optional).length).toBeGreaterThan(0);
  });

  it("every declared CompetitionTemplate key is produced by the skeleton", () => {
    const skeleton = packToTemplateSkeleton(parsed(basePack()));
    for (const key of keyNames(source, "CompetitionTemplate")) {
      expect(Object.keys(skeleton), `skeleton is missing CompetitionTemplate key "${key}"`).toContain(key);
    }
  });

  it("every declared TemplateDivision key is produced by the skeleton", () => {
    const skeleton = packToTemplateSkeleton(parsed(basePack()));
    const division = skeleton.divisions[0];
    expect(division).toBeDefined();
    for (const key of keyNames(source, "TemplateDivision")) {
      expect(Object.keys(division ?? {}), `skeleton division is missing TemplateDivision key "${key}"`).toContain(key);
    }
  });

  it("every REQUIRED TemplateStage key is produced by the skeleton's stages", () => {
    // Review round 1, minor item. The stage objects were proven against
    // nothing. Only the required keys are asserted here: `size`, `groups`,
    // `points` and `scheduleDefaults` are catalog sugar a pack carries no data
    // for, and the template declares all four optional — emitting them empty
    // would be inventing values, not carrying them.
    const skeleton = packToTemplateSkeleton(parsed(basePack()));
    const required = declaredKeys(source, "TemplateStage").keys.filter((k) => !k.optional);
    expect(required.length).toBeGreaterThan(0);
    for (const stage of skeleton.divisions[0]?.stages ?? []) {
      for (const key of required) {
        expect(Object.keys(stage), `skeleton stage is missing required TemplateStage key "${key.name}"`).toContain(key.name);
      }
    }
  });

  it("TemplateStage is .strict(), so a stray skeleton key would be REFUSED — assert there are none", () => {
    // This is the direction that actually bites for a strict schema: a missing
    // optional key is fine, an extra key is a hard parse failure. Asserting
    // `.strict()` itself means the day the product drops it, this test says so
    // rather than silently guarding nothing.
    const { keys, strict } = declaredKeys(source, "TemplateStage");
    expect(strict, "TemplateStage is no longer .strict() — re-read why this check exists").toBe(true);
    const declared = new Set(keys.map((k) => k.name));
    const skeleton = packToTemplateSkeleton(parsed(basePack()));
    for (const stage of skeleton.divisions[0]?.stages ?? []) {
      for (const key of Object.keys(stage)) {
        expect(declared, `skeleton stage emits "${key}", which TemplateStage does not declare`).toContain(key);
      }
    }
  });

  it("the skeleton emits no key the root or division schemas do not declare", () => {
    const skeleton = packToTemplateSkeleton(parsed(basePack()));
    const rootDeclared = new Set(keyNames(source, "CompetitionTemplate"));
    for (const key of Object.keys(skeleton)) {
      expect(rootDeclared, `skeleton emits root key "${key}", undeclared by CompetitionTemplate`).toContain(key);
    }
    const divDeclared = new Set(keyNames(source, "TemplateDivision"));
    for (const division of skeleton.divisions) {
      for (const key of Object.keys(division)) {
        expect(divDeclared, `skeleton emits division key "${key}", undeclared by TemplateDivision`).toContain(key);
      }
    }
  });

  it("entrantKind and entrantCount are DERIVED from the entrant list, never stored on the pack", () => {
    const skeleton = packToTemplateSkeleton(parsed(basePack()));
    expect(skeleton.divisions[0]?.entrantKind).toBe("individual");
    expect(skeleton.divisions[0]?.entrantCount).toBe(2);
  });

  it("i18n keys are MINTED — a pack carries a real English tournament name, a template carries a key", () => {
    const skeleton = packToTemplateSkeleton(parsed(basePack()));
    expect(skeleton.i18n.nameKey).toMatch(/^bench\.pack\._unit\./);
    expect(skeleton.divisions[0]?.i18nNameKey).toMatch(/^bench\.pack\._unit\.division\.d-main\./);
  });

  it("carries every stage in order, with the pack's own stage kind", () => {
    const skeleton = packToTemplateSkeleton(parsed(basePack()));
    expect(skeleton.divisions[0]?.stages.map((s) => s.kind)).toEqual(["league"]);
  });
});

describe("entrantsOfDivision — the ONE division selector", () => {
  // The review found four hand-rolled copies of this filter, and a mutation
  // spot-check found the thinnest of them held by exactly one test. It is one
  // exported function now, so this is the whole family's guard.
  const many = (): Pack =>
    parsed(
      pack((p) => {
        (p["divisions"] as Record<string, unknown>[]).push({
          ref: "d-other",
          name: "Other",
          sportKey: "generic",
          variantKey: "score",
          moduleVersion: "1.0.0",
          stages: [{ ref: "s-other", seq: 1, kind: "league", name: "L" }],
        });
        (p["entrants"] as Record<string, unknown>[]).push(
          { ref: "e-charlie", divisionRef: "d-other", kind: "individual", displayName: "Charlie" },
          { ref: "e-delta", divisionRef: "d-other", kind: "individual", displayName: "Delta" },
          { ref: "e-echo", divisionRef: "d-other", kind: "individual", displayName: "Echo" },
        );
      }),
    );

  it("returns only that division's entrants, in pack order", () => {
    // Two divisions with DIFFERENT counts, so a selector that ignored the ref
    // cannot agree with the right answer on either of them.
    expect(entrantsOfDivision(many().entrants, "d-main").map((e) => e.ref)).toEqual([
      "e-alpha",
      "e-bravo",
    ]);
    expect(entrantsOfDivision(many().entrants, "d-other").map((e) => e.ref)).toEqual([
      "e-charlie",
      "e-delta",
      "e-echo",
    ]);
  });

  it("is empty, not everything, for a division nobody entered", () => {
    expect(entrantsOfDivision(many().entrants, "d-ghost")).toEqual([]);
  });
});

describe("roundRobinFixtureCount — the ONE round-robin arithmetic", () => {
  it("is every pair once per leg", () => {
    // Enumerated rather than sampled: n(n-1)/2 and n*legs agree at n=2,legs=1
    // and at n=3,legs=1, so a single case cannot tell the two apart.
    expect(roundRobinFixtureCount(2, 1)).toBe(1);
    expect(roundRobinFixtureCount(2, 3)).toBe(3);
    expect(roundRobinFixtureCount(3, 1)).toBe(3);
    expect(roundRobinFixtureCount(4, 1)).toBe(6);
    expect(roundRobinFixtureCount(4, 2)).toBe(12);
    // An odd field's bye is not a fixture — 5 entrants still meet 10 times.
    expect(roundRobinFixtureCount(5, 1)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// The two blocks the whole-branch review found missing, landed before the B06
// freeze because an additive change after it is an owner escalation.
// ---------------------------------------------------------------------------

describe("expected.finalRanks — a stage's placement order", () => {
  /** The block under test, on the base pack. */
  const withRanks = (
    order: string[],
    stageRef = "s-league",
    mutate: (p: Record<string, unknown>) => void = () => {},
  ): Record<string, unknown> =>
    pack((p) => {
      (p["expected"] as Record<string, unknown>)["finalRanks"] = [
        { divisionRef: "d-main", stageRef, order },
      ];
      mutate(p);
    });

  it("parses, and is the ONLY block that can order a bracket's placings", () => {
    const out = parsed(withRanks(["e-alpha", "e-bravo"]));
    expect(out.expected.finalRanks).toEqual([
      { divisionRef: "d-main", stageRef: "s-league", order: ["e-alpha", "e-bravo"] },
    ]);
    // The gap it closes: expected.tables is a HARD ERROR on a bracket stage,
    // so before this block a knockout's 2nd place was unassertable.
    expect(out.expected.tables).toEqual([]);
  });

  it("refuses an entrant of another division", () => {
    expectIssue(
      withRanks(["e-alpha", "e-outsider"], "s-league", (p) => {
        (p["divisions"] as Record<string, unknown>[]).push({
          ref: "d-other",
          name: "Other",
          sportKey: "generic",
          variantKey: "score",
          moduleVersion: "1.0.0",
          stages: [{ ref: "s-other", seq: 1, kind: "league", name: "L" }],
        });
        (p["entrants"] as Record<string, unknown>[]).push(
          { ref: "e-outsider", divisionRef: "d-other", kind: "individual", displayName: "Outsider" },
          { ref: "e-second", divisionRef: "d-other", kind: "individual", displayName: "Second" },
        );
      }),
      ["expected", "finalRanks", 0, "order", 1],
      /unknown entrant ref "e-outsider" for division "d-main"/,
    );
  });

  it("refuses a stage of another division", () => {
    expectIssue(
      withRanks(["e-alpha", "e-bravo"], "s-nope"),
      ["expected", "finalRanks", 0, "stageRef"],
      /unknown stage ref "s-nope" for division "d-main"/,
    );
  });

  it("refuses the same entrant placed twice", () => {
    expectIssue(
      withRanks(["e-alpha", "e-alpha"]),
      ["expected", "finalRanks", 0, "order", 1],
      /entrant "e-alpha" is placed twice/,
    );
  });

  it("refuses two final orders for one stage", () => {
    expectIssue(
      pack((p) => {
        (p["expected"] as Record<string, unknown>)["finalRanks"] = [
          { divisionRef: "d-main", stageRef: "s-league", order: ["e-alpha", "e-bravo"] },
          { divisionRef: "d-main", stageRef: "s-league", order: ["e-bravo", "e-alpha"] },
        ];
      }),
      ["expected", "finalRanks", 1],
      /declares more than one final order/,
    );
  });

  it("refuses an order of one — that is a champion, which champions already says", () => {
    expectIssue(
      withRanks(["e-alpha"]),
      ["expected", "finalRanks", 0, "order"],
      /at least 2|too small|>=2/i,
    );
  });

  it("refuses a final order whose FIRST place is not the stage's own champion", () => {
    // The pair that always coexists on a bracket. `expected.tables` is a hard
    // error on bracket kinds, so the table rule below guards a pair that can
    // never occur there — while `champions` + `finalRanks` with no table is
    // exactly B06's shape. Before this rule the pack could say e-alpha won and,
    // two lines later, that e-bravo finished first, and parse clean.
    expectIssue(
      withRanks(["e-bravo", "e-alpha"], "s-league", (p) => {
        (p["expected"] as Record<string, unknown>)["champions"] = [
          { divisionRef: "d-main", stageRef: "s-league", entrant: "e-alpha" },
        ];
      }),
      ["expected", "finalRanks", 0, "order", 0],
      /crowns "e-alpha" but its final order starts with "e-bravo"/,
    );
  });

  it("ACCEPTS a final order whose first place IS the stage's champion", () => {
    const out = parsed(
      withRanks(["e-alpha", "e-bravo"], "s-league", (p) => {
        (p["expected"] as Record<string, unknown>)["champions"] = [
          { divisionRef: "d-main", stageRef: "s-league", entrant: "e-alpha" },
        ];
      }),
    );
    expect(out.expected.finalRanks[0]?.order[0]).toBe("e-alpha");
  });

  it("leaves a DIVISION-scoped champion alone — it is the overall winner, not a stage's first place", () => {
    // Deliberately NOT compared. In a multi-stage division the unscoped
    // champion is who won the whole thing, which need not top any particular
    // stage's order; refusing that would be the over-refusal the pool-table
    // exclusion was careful to avoid. A group-stage order topped by someone
    // who did not go on to win must stay expressible.
    const out = parsed(
      withRanks(["e-bravo", "e-alpha"], "s-league", (p) => {
        (p["expected"] as Record<string, unknown>)["champions"] = [
          { divisionRef: "d-main", entrant: "e-alpha" },
        ];
      }),
    );
    expect(out.expected.finalRanks[0]?.order).toEqual(["e-bravo", "e-alpha"]);
  });

  it("refuses a final order that CONTRADICTS the stage's own expected table", () => {
    // Anti-contradiction, not an oracle: a pack must not state one fact in two
    // blocks and have them disagree, exactly as `rank` must equal its row's
    // position. The message names both orders so an author can see which they
    // meant.
    expectIssue(
      withRanks(["e-bravo", "e-alpha"], "s-league", (p) => {
        (p["expected"] as Record<string, unknown>)["tables"] = [
          {
            divisionRef: "d-main",
            stageRef: "s-league",
            rows: [
              { entrant: "e-alpha", rank: 1, played: 1, won: 1, drawn: 0, lost: 0, points: 3 },
              { entrant: "e-bravo", rank: 2, played: 1, won: 0, drawn: 0, lost: 1, points: 0 },
            ],
          },
        ];
      }),
      ["expected", "finalRanks", 0, "order"],
      /the table ranks \[e-alpha, e-bravo\], this order says \[e-bravo, e-alpha\]/,
    );
  });

  it("ACCEPTS a final order that agrees with the stage's table", () => {
    const out = parsed(
      withRanks(["e-alpha", "e-bravo"], "s-league", (p) => {
        (p["expected"] as Record<string, unknown>)["tables"] = [
          {
            divisionRef: "d-main",
            stageRef: "s-league",
            rows: [
              { entrant: "e-alpha", rank: 1, played: 1, won: 1, drawn: 0, lost: 0, points: 3 },
              { entrant: "e-bravo", rank: 2, played: 1, won: 0, drawn: 0, lost: 1, points: 0 },
            ],
          },
        ];
      }),
    );
    expect(out.expected.finalRanks[0]?.order).toEqual(["e-alpha", "e-bravo"]);
  });
});

describe("expected.champions — now stage-scopable", () => {
  it("accepts a champion per STAGE, so a group winner and a knockout winner are two claims", () => {
    const out = parsed(
      pack((p) => {
        (p["divisions"] as Record<string, unknown>[])[0]!["stages"] = [
          { ref: "s-league", seq: 1, kind: "league", name: "League", config: { legs: 1 } },
          { ref: "s-ko", seq: 2, kind: "knockout", name: "Knockout" },
        ];
        (p["expected"] as Record<string, unknown>)["champions"] = [
          { divisionRef: "d-main", stageRef: "s-league", entrant: "e-alpha" },
          { divisionRef: "d-main", stageRef: "s-ko", entrant: "e-bravo" },
        ];
      }),
    );
    expect(out.expected.champions.map((c) => c.stageRef)).toEqual(["s-league", "s-ko"]);
  });

  it("still refuses two UNSCOPED champions for one division", () => {
    expectIssue(
      pack((p) => {
        (p["expected"] as Record<string, unknown>)["champions"] = [
          { divisionRef: "d-main", entrant: "e-alpha" },
          { divisionRef: "d-main", entrant: "e-bravo" },
        ];
      }),
      ["expected", "champions", 1, "divisionRef"],
      /declares more than one champion/,
    );
  });

  it("refuses two champions for the SAME stage", () => {
    expectIssue(
      pack((p) => {
        (p["expected"] as Record<string, unknown>)["champions"] = [
          { divisionRef: "d-main", stageRef: "s-league", entrant: "e-alpha" },
          { divisionRef: "d-main", stageRef: "s-league", entrant: "e-bravo" },
        ];
      }),
      ["expected", "champions", 1, "divisionRef"],
      /more than one champion for stage "s-league"/,
    );
  });

  it("refuses a stage of another division", () => {
    expectIssue(
      pack((p) => {
        (p["expected"] as Record<string, unknown>)["champions"] = [
          { divisionRef: "d-main", stageRef: "s-nope", entrant: "e-alpha" },
        ];
      }),
      ["expected", "champions", 0, "stageRef"],
      /unknown stage ref "s-nope"/,
    );
  });
});

describe("expected.careers — the cross-division person rollup", () => {
  it("parses, and is PACK-scoped: it names no division at all", () => {
    const out = parsed(
      pack((p) => {
        (p["expected"] as Record<string, unknown>)["careers"] = [
          { person: "p-ana", name: "Ana Alvarez", metricKey: "points", count: 42 },
        ];
      }),
    );
    expect(out.expected.careers).toEqual([
      { person: "p-ana", name: "Ana Alvarez", metricKey: "points", count: 42 },
    ]);
    // A leaderboard entry cannot express this: its own block REQUIRES a
    // divisionRef, which is the whole gap.
    expect(Object.keys(out.expected.careers[0] ?? {})).not.toContain("divisionRef");
  });

  it("refuses an undeclared person", () => {
    expectIssue(
      pack((p) => {
        (p["expected"] as Record<string, unknown>)["careers"] = [
          { person: "p-ghost", name: "Ghost", metricKey: "points", count: 1 },
        ];
      }),
      ["expected", "careers", 0, "person"],
      /unknown person ref "p-ghost"/,
    );
  });

  it("refuses one person claiming the same metric twice", () => {
    expectIssue(
      pack((p) => {
        (p["expected"] as Record<string, unknown>)["careers"] = [
          { person: "p-ana", name: "Ana Alvarez", metricKey: "points", count: 42 },
          { person: "p-ana", name: "Ana Alvarez", metricKey: "points", count: 43 },
        ];
      }),
      ["expected", "careers", 1],
      /declares metric "points" twice/,
    );
  });

  it("ACCEPTS one person across two DIFFERENT metrics", () => {
    const out = parsed(
      pack((p) => {
        (p["expected"] as Record<string, unknown>)["careers"] = [
          { person: "p-ana", name: "Ana Alvarez", metricKey: "points", count: 42 },
          { person: "p-ana", name: "Ana Alvarez", metricKey: "serves", count: 99 },
        ];
      }),
    );
    expect(out.expected.careers).toHaveLength(2);
  });
});
