// F14 — a qualifier who departs BEFORE the bracket is generated.
//
// Owner ruling (2026-09-21): WALKOVER. A departed qualifier's slot becomes a
// walkover for their opponent; the draw is preserved and NOBODY is promoted.
// The rationale is parity: once the bracket EXISTS, `withdrawEntrantCascade`
// already advances the opponent by walkover (spec 05 §5 `bracket_walkover`),
// so doing anything else before Generate would give the same real-world event
// two different outcomes depending on when a button was pressed.
//
// What it replaced: `generateStageFixtures` read `stage.config.qualified`
// (the frozen, ordered qualification list an `on_complete` progression writes)
// and re-seeded it POSITIONALLY —
//
//     entrants = qualified.filter(active).map((id, i) => ({ id, seed: i + 1 }))
//
// — so dropping one qualifier slid every later qualifier UP a seed. That is a
// silent promotion: a 4th seed became the 3rd, inherited the 3rd's half of the
// draw and met a different opponent, and the entrant who actually stood
// opposite the departed qualifier lost their walkover and was handed a live
// match instead.
//
// The renumber is INVISIBLE to any test that counts entrants or asserts
// bracket size: 8 qualifiers minus 1 is 7 either way, and the bracket is 8
// slots either way. Only the PAIRINGS move. So every expectation below is
// derived by running the engine's own `generateSingleElim` over the full,
// undisturbed qualification list — never a table typed into this file — and
// the fixtures are compared against that draw seat by seat.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { generateSingleElim } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures, rebuildStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { undoDivision } from "../history";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface FixtureRow {
  ext_key: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: { kind?: string; winner?: string } | null;
}

async function fixturesOf(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select ext_key, round_no, seq_in_round, home_entrant_id, away_entrant_id, status, outcome
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  /** Entrant ids in qualification order — `config.qualified` verbatim. */
  qualified: string[];
  /** "E1"… → entrant id, for readable assertions. */
  idOf: (name: string) => string;
  nameOf: (id: string | null) => string | null;
}

/** A division of `field` entrants whose single `kind` stage draws from a
 *  frozen `config.qualified` list — the persisted shape `seedNextStage`
 *  writes when an `on_complete` progression resolves (stages.ts ~line 3504),
 *  written directly here so the test drives the generation branch under
 *  change rather than a league play-out that only reaches it incidentally. */
async function seedQualifiedStage(field: number, kind: "knockout" | "league"): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Departed " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    Array.from({ length: field }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, [
    { seq: 1, kind, name: kind === "knockout" ? "Finals" : "Super league", config: {} },
  ]);
  const qualified = entrants.map((e) => e.id);
  await sql`
    update stages set config = ${sql.json({ qualified } as never)}
    where id = ${stage!.id}`;
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const byId = new Map(entrants.map((e) => [e.id, e.display_name]));
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    qualified,
    idOf: (name) => byName.get(name)!,
    nameOf: (id) => (id === null ? null : (byId.get(id) ?? id)),
  };
}

/** The round-0 pairings the ENGINE produces for the full, undisturbed
 *  qualification list, keyed by the fixture id that becomes `ext_key`. This is
 *  the draw that must survive a departure — computed here from
 *  `generateSingleElim` so a change to the seed fold moves this expectation
 *  with it instead of leaving a hand-typed table asserting yesterday's draw. */
function engineDraw(qualified: string[]): Map<string, { home: string | null; away: string | null }> {
  const bracket = generateSingleElim({
    entrants: qualified,
    seeds: new Map(qualified.map((id, i) => [id, i + 1])),
  });
  const draw = new Map<string, { home: string | null; away: string | null }>();
  for (const f of bracket.fixtures) {
    if (f.round !== 0) continue;
    draw.set(f.id, { home: f.home ?? f.award ?? null, away: f.away ?? null });
  }
  return draw;
}

describe.runIf(HAS_DB)("a qualifier who departs before Generate — walkover, not promotion", () => {
  it("preserves the draw: every surviving qualifier keeps the opponent the full draw gave them", async () => {
    const rig = await seedQualifiedStage(8, "knockout");
    const draw = engineDraw(rig.qualified);
    await withdrawEntrantCascade(rig.auth, rig.idOf("E3"));

    await generateStageFixtures(rig.auth, rig.stageId);
    const rows = (await fixturesOf(rig.stageId)).filter((r) => r.round_no === 1);
    expect(rows, "a bracket of 8 opens with four round-one lines").toHaveLength(4);

    // Seat-by-seat against the engine's own draw. Under the positional
    // renumber this fails on three of the four lines at once.
    for (const row of rows) {
      const expected = draw.get(row.ext_key!);
      expect(expected, `no engine line for ${row.ext_key}`).toBeDefined();
      expect(
        { home: rig.nameOf(row.home_entrant_id), away: rig.nameOf(row.away_entrant_id) },
        `line ${row.ext_key} drifted from the published draw`,
      ).toEqual({ home: rig.nameOf(expected!.home), away: rig.nameOf(expected!.away) });
    }

    // Spelled out for the three seats the brief names, so a future reader sees
    // WHICH pairings the renumber moved. The opponents are read out of the
    // engine's draw, not asserted as constants.
    const opponentOf = (name: string): string | null => {
      const id = rig.idOf(name);
      for (const line of draw.values()) {
        if (line.home === id) return rig.nameOf(line.away);
        if (line.away === id) return rig.nameOf(line.home);
      }
      return null;
    };
    for (const name of ["E5", "E6", "E8"]) {
      const row = rows.find(
        (r) => r.home_entrant_id === rig.idOf(name) || r.away_entrant_id === rig.idOf(name),
      );
      const got =
        row!.home_entrant_id === rig.idOf(name)
          ? rig.nameOf(row!.away_entrant_id)
          : rig.nameOf(row!.home_entrant_id);
      expect(got, `${name} was handed a different opponent by the reseed`).toBe(opponentOf(name));
    }
  });

  it("the departed qualifier's line is a walkover, and their opponent advances", async () => {
    const rig = await seedQualifiedStage(8, "knockout");
    const draw = engineDraw(rig.qualified);
    const departed = rig.idOf("E3");
    const line = [...draw.entries()].find(([, l]) => l.home === departed || l.away === departed)!;
    const survivor = line[1].home === departed ? line[1].away! : line[1].home!;
    // The differential the brief asks for: the survivor here is NOT the
    // entrant the positional renumber would have put in this line, and is not
    // a constant either — it falls out of the engine's fold.
    expect(rig.nameOf(survivor), "the engine's draw put someone else opposite E3").toBe("E6");

    await withdrawEntrantCascade(rig.auth, departed);
    await generateStageFixtures(rig.auth, rig.stageId);
    const rows = await fixturesOf(rig.stageId);

    const walkover = rows.find((r) => r.ext_key === line[0])!;
    expect(walkover.status, "a departed qualifier's line is settled at generation").toBe("forfeited");
    expect(walkover.outcome, "the opponent is awarded the match").toMatchObject({
      kind: "award",
      winner: survivor,
    });
    // Both seats stay filled — this is a two-sided walkover (the shape
    // `core.forfeit` produces post-generation), not a one-sided BYE, which is
    // what `isOneSidedAwardBye` separates and what the rebuild guard protects.
    expect(walkover.home_entrant_id, "the departed qualifier keeps their drawn seat").not.toBeNull();
    expect(walkover.away_entrant_id).not.toBeNull();
    expect([walkover.home_entrant_id, walkover.away_entrant_id]).toContain(departed);

    // …and the survivor is standing in round two.
    const roundTwo = rows.filter((r) => r.round_no === 2);
    const advanced = roundTwo.some(
      (r) => r.home_entrant_id === survivor || r.away_entrant_id === survivor,
    );
    expect(advanced, "the walkover did not advance the survivor").toBe(true);
  });

  // Review 3 of #857, N2 (owner ruling): a walkover counts as a result only
  // with evidence. The generator's F14 walkover has none — nobody played it —
  // and counting it refused Undo of the generation and Rebuild, both with
  // "started or finished" copy that was false.
  it("an F14 walkover is not a result: Undo of the generation completes, and Rebuild is allowed", async () => {
    const rig = await seedQualifiedStage(8, "knockout");
    await withdrawEntrantCascade(rig.auth, rig.idOf("E3"));
    const walkovers = async () =>
      (await fixturesOf(rig.stageId)).filter(
        (r) => r.status === "forfeited" && r.home_entrant_id !== null && r.away_entrant_id !== null,
      );

    await generateStageFixtures(rig.auth, rig.stageId);
    expect(await walkovers()).toHaveLength(1);
    expect((await undoDivision(rig.auth, rig.divisionId)).applied.type).toBe("fixtures_cleared");
    expect(await fixturesOf(rig.stageId)).toEqual([]);

    await generateStageFixtures(rig.auth, rig.stageId);
    expect(await walkovers()).toHaveLength(1);
    const rebuilt = await rebuildStageFixtures(rig.auth, rig.stageId);
    expect(rebuilt.removed).toBeGreaterThan(0);
    expect(await walkovers()).toHaveLength(1);
  });

  it("promotes nobody: no qualifier inherits another's seed", async () => {
    const rig = await seedQualifiedStage(8, "knockout");
    const draw = engineDraw(rig.qualified);
    await withdrawEntrantCascade(rig.auth, rig.idOf("E3"));
    await generateStageFixtures(rig.auth, rig.stageId);

    const rows = (await fixturesOf(rig.stageId)).filter((r) => r.round_no === 1);
    const seated = new Set(
      rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]).filter((x): x is string => x !== null),
    );
    const drawn = new Set(
      [...draw.values()].flatMap((l) => [l.home, l.away]).filter((x): x is string => x !== null),
    );
    expect([...seated].sort(), "the round-one field is not the published draw's field").toEqual(
      [...drawn].sort(),
    );
  });

  it("a pairing whose BOTH qualifiers departed advances nobody", async () => {
    const rig = await seedQualifiedStage(8, "knockout");
    const draw = engineDraw(rig.qualified);
    const line = [...draw.entries()].find(
      ([, l]) => l.home === rig.idOf("E3") || l.away === rig.idOf("E3"),
    )!;
    const other = line[1].home === rig.idOf("E3") ? line[1].away! : line[1].home!;
    await withdrawEntrantCascade(rig.auth, rig.idOf("E3"));
    await withdrawEntrantCascade(rig.auth, other);

    await generateStageFixtures(rig.auth, rig.stageId);
    const rows = await fixturesOf(rig.stageId);
    const dead = rows.find((r) => r.ext_key === line[0])!;
    // The cascade's own rule for this shape: a walkover with no one to
    // receive it is voided, never awarded. Nobody advances out of this line.
    expect(dead.outcome, "a line with no survivor must award nobody").toBeNull();
    for (const r of rows.filter((x) => x.round_no === 2)) {
      expect([r.home_entrant_id, r.away_entrant_id]).not.toContain(rig.idOf("E3"));
      expect([r.home_entrant_id, r.away_entrant_id]).not.toContain(other);
    }
  });

  it("a departed qualifier holding a BYE is not advanced into round two", async () => {
    // 5 qualifiers into a bracket of 8: the top three seeds take the bye
    // lines. Preserving the draw means the departed top seed keeps their bye
    // row — but nothing may carry them into the next round.
    const rig = await seedQualifiedStage(5, "knockout");
    const byeHolder = rig.idOf("E1");
    await withdrawEntrantCascade(rig.auth, byeHolder);
    await generateStageFixtures(rig.auth, rig.stageId);

    const rows = await fixturesOf(rig.stageId);
    for (const r of rows.filter((x) => x.round_no >= 2)) {
      expect(
        [r.home_entrant_id, r.away_entrant_id],
        `a withdrawn entrant was seated in round ${r.round_no}`,
      ).not.toContain(byeHolder);
    }
  });

  it("a TABLE stage drawing from the same list still drops the departed entrant", async () => {
    // Spec 05 §5 splits on stage kind, and so must this: a league/group has no
    // draw to preserve and no opponent to walk over to — nothing has been
    // played, so the engine's policy is EXPUNGE. The walkover rule is for
    // brackets only, and this is the boundary case that proves it.
    const rig = await seedQualifiedStage(4, "league");
    const departed = rig.idOf("E2");
    await withdrawEntrantCascade(rig.auth, departed);
    await generateStageFixtures(rig.auth, rig.stageId);

    const rows = await fixturesOf(rig.stageId);
    expect(rows.length, "three survivors play a single round robin").toBe(3);
    for (const r of rows) {
      expect([r.home_entrant_id, r.away_entrant_id]).not.toContain(departed);
    }
  });
});
