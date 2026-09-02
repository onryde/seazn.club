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
  PackProvenance,
  PackRef,
  PackSchema,
  SEED_LEGAL_BY_PROVENANCE,
  STANDINGS_SCALAR_FIELDS,
  fixtureKey,
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
    expect(persons.length, "_tiny declares no persons to collide").toBeGreaterThan(0);
    expect(entrants.length, "_tiny declares no entrants to collide").toBeGreaterThan(0);
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
    const values = PackProvenance.options;
    expect(values.length).toBeGreaterThan(0);
    expect(Object.keys(SEED_LEGAL_BY_PROVENANCE).sort()).toEqual([...values].sort());
    for (const provenance of values) {
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

  it("a real stream may NOT — nothing generated the historical record", () => {
    expectIssue(withSeed("real"), ["streams", 0, "reconstruction"], /nothing generated it/i);
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
        currency: "GBP",
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

  it("byDivision is keyed by a DECLARED division ref", () => {
    const bad = pack((p) => {
      (p.persons as unknown[]).push({ ref: "p-cap", fullName: "Cap Tain", lane: "player" });
      p.registration = {
        byDivision: {
          "d-ghost": {
            category: "open",
            entrantKind: "team",
            feeCents: 0,
            currency: "GBP",
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
    expect(engineScalars).toEqual([...STANDINGS_SCALAR_FIELDS]);
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
