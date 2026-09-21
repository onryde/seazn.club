// Re-review C2 (owner ruling 2026-09-21) — graduated from the reviewer's
// probes 1, 2 and 3.
//
// F14 preserves the published draw when a qualifier departs before the bracket
// is generated, and walks her pairing over to the survivor. The ruling being
// enforced here is the OTHER half of that: **a walkover requires a live
// recipient.** Where there is none — both sides of the pairing departed, the
// bye-holder departed, every qualifier departed — the line is VOID, and a void
// line advances nobody. Generation used to leave those lines `scheduled` with
// withdrawn entrants seated in them, i.e. matches an organiser could put on a
// court, and in the bye-holder shape it recorded a withdrawn entrant as the
// WINNER.
//
// `void` is the ENGINE's word for the verdict. In the fixtures table the value
// is `abandoned` — there is no `void` status (check constraint: scheduled,
// in_play, decided, finalized, abandoned, forfeited, cancelled), and
// `abandoned` is exactly what the withdrawal cascade's own void branch reaches
// by posting `core.abandon`. The two paths therefore land in the same place,
// which is the whole point of F14.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  generateDoubleElim,
  generateSingleElim,
  generateStepladder,
} from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { BRACKET_WALKOVER_KINDS, createStages, generateStageFixtures } from "../stages";
import { withdrawEntrantCascade } from "../withdrawal";
import { GENERIC_CONFIG, seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

/** The statuses an organiser can still put on a court. Anything holding a
 *  departed entrant in one of these is the defect. */
const PENDING = new Set(["scheduled", "in_play"]);

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
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
    from fixtures where stage_id = ${stageId} order by round_no, seq_in_round`;
}

interface Rig {
  auth: AuthCtx;
  divisionId: string;
  stageId: string;
  qualified: string[];
  idOf: (name: string) => string;
}

/** A bracket stage whose `config.qualified` is a published draw of `field`
 *  entrants — the shape a `timing: "on_complete"` progression leaves behind,
 *  and the one `generateStageFixtures` re-seeds from. */
async function seedQualifiedStage(field: number, kind: string): Promise<Rig> {
  const { auth } = await seedOrg("pro");
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "C2 " + randomUUID().slice(0, 6),
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
    { seq: 1, kind: kind as "knockout", name: "Finals", config: {} },
  ]);
  const qualified = entrants.map((e) => e.id);
  await sql`update stages set config = ${sql.json({ qualified } as never)} where id = ${stage!.id}`;
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  return {
    auth,
    divisionId: division.id,
    stageId: stage!.id,
    qualified,
    idOf: (n) => byName.get(n)!,
  };
}

/** The other half of `entrantId`'s first-round pairing, per the ENGINE's own
 *  draw for this qualified list — never a hand-typed seed number. */
function pairedWith(qualified: string[], entrantId: string): string {
  const bracket = generateSingleElim({
    entrants: qualified,
    seeds: new Map(qualified.map((id, i) => [id, i + 1])),
  });
  for (const f of bracket.fixtures) {
    if (f.round !== 0) continue;
    if (f.home === entrantId && f.away) return f.away;
    if (f.away === entrantId && f.home) return f.home;
  }
  throw new Error("entrant has no first-round opponent in the engine's draw");
}

/** A pairing that this KIND's own generator actually draws — the lowest two
 *  rungs of a stepladder are not the 4v5 of a single-elim draw, and asserting
 *  on a hand-picked pair would test a pairing that does not exist. */
function pairingIn(kind: string, qualified: string[]): [string, string] {
  const seeds = new Map(qualified.map((id, i) => [id, i + 1]));
  const opts = { entrants: qualified, seeds };
  const bracket =
    kind === "double_elim"
      ? generateDoubleElim(opts)
      : kind === "stepladder"
        ? generateStepladder(opts)
        : generateSingleElim(opts);
  const f = bracket.fixtures.find((x) => x.home && x.away);
  if (!f) throw new Error(`the ${kind} draw has no fixture with two entrants`);
  return [f.home!, f.away!];
}

async function departedIds(divisionId: string): Promise<Set<string>> {
  const rows = await sql<{ id: string }[]>`
    select id from entrants
    where division_id = ${divisionId} and status not in ('registered', 'confirmed')`;
  return new Set(rows.map((r) => r.id));
}

/** THE invariant. Holds for every bracket kind and every departure shape. */
async function expectNoDepartedInPendingFixture(rig: Rig): Promise<FixtureRow[]> {
  const rows = await fixturesOf(rig.stageId);
  const departed = await departedIds(rig.divisionId);
  const offending = rows.filter(
    (r) =>
      PENDING.has(r.status) &&
      ((r.home_entrant_id !== null && departed.has(r.home_entrant_id)) ||
        (r.away_entrant_id !== null && departed.has(r.away_entrant_id))),
  );
  expect(
    offending.map((r) => `${r.ext_key}@${r.status}`),
    "a departed entrant is seated in a fixture an organiser can still play",
  ).toEqual([]);
  return rows;
}

/** No fixture may record a departed entrant as its winner. */
async function expectNoDepartedWinner(rig: Rig, rows: FixtureRow[]): Promise<void> {
  const departed = await departedIds(rig.divisionId);
  const bad = rows.filter((r) => r.outcome?.winner && departed.has(r.outcome.winner));
  expect(bad.map((r) => `${r.ext_key}=${r.status}`), "a departed entrant is a winner").toEqual([]);
}

// Field sizes chosen so each shape is REACHABLE for the kind: an odd field is
// what gives single-elim a structural bye to hand to a departing top seed.
const KINDS = ["knockout", "double_elim", "stepladder"] as const;

describe.skipIf(!HAS_DB)("no departed qualifier is seated in a playable fixture", () => {
  for (const kind of KINDS) {
    it(`${kind}: one qualifier departs`, async () => {
      const rig = await seedQualifiedStage(8, kind);
      await withdrawEntrantCascade(rig.auth, rig.idOf("E5"));
      await generateStageFixtures(rig.auth, rig.stageId);
      const rows = await expectNoDepartedInPendingFixture(rig);
      await expectNoDepartedWinner(rig, rows);
      // ...and her line was SETTLED rather than left half-alive: walked over
      // where she had a live opponent, voided where the other seat was a TBD
      // feed she could not concede to.
      expect(rows.some((r) => r.status === "forfeited" || r.status === "abandoned")).toBe(true);
    });

    it(`${kind}: both sides of a pairing depart — the line is void, not scheduled`, async () => {
      const rig = await seedQualifiedStage(8, kind);
      const [victim, partner] = pairingIn(kind, rig.qualified);
      await withdrawEntrantCascade(rig.auth, victim);
      await withdrawEntrantCascade(rig.auth, partner);
      await generateStageFixtures(rig.auth, rig.stageId);
      const rows = await expectNoDepartedInPendingFixture(rig);
      await expectNoDepartedWinner(rig, rows);
      // The void materialises as `abandoned` — the cascade's own landing spot.
      expect(rows.some((r) => r.status === "abandoned")).toBe(true);
    });

    it(`${kind}: every qualifier departs — generation refuses`, async () => {
      const rig = await seedQualifiedStage(4, kind);
      for (const n of ["E1", "E2", "E3", "E4"]) await withdrawEntrantCascade(rig.auth, rig.idOf(n));
      await expect(generateStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject({
        code: "STAGE_NOT_READY",
      });
      expect(await fixturesOf(rig.stageId)).toEqual([]);
    });

    it(`${kind}: all but one qualifier departs — generation refuses`, async () => {
      const rig = await seedQualifiedStage(4, kind);
      for (const n of ["E2", "E3", "E4"]) await withdrawEntrantCascade(rig.auth, rig.idOf(n));
      await expect(generateStageFixtures(rig.auth, rig.stageId)).rejects.toMatchObject({
        code: "STAGE_NOT_READY",
      });
    });
  }

  it("knockout: the holder of a structural BYE departs — nobody wins her bye", async () => {
    // 5 into an 8-slot draw: seeds 1, 2 and 3 get first-round byes, so the top
    // seed's line is an award the engine baked before anyone withdrew.
    const rig = await seedQualifiedStage(5, "knockout");
    await withdrawEntrantCascade(rig.auth, rig.idOf("E1"));
    await generateStageFixtures(rig.auth, rig.stageId);
    const rows = await expectNoDepartedInPendingFixture(rig);
    await expectNoDepartedWinner(rig, rows);
    expect(rows.some((r) => r.status === "abandoned")).toBe(true);
    // The other two byes are untouched — voiding is per line, not per round.
    expect(rows.filter((r) => r.outcome?.kind === "award")).not.toEqual([]);
  });

  it("BOUNDARY — page_playoff is not a walkover kind: it re-seeds the survivors instead", async () => {
    // `BRACKET_WALKOVER_KINDS` deliberately excludes page_playoff (the cascade
    // voids its remaining games as an open format). So this kind takes the
    // other branch entirely: the departed qualifier is filtered OUT of the
    // field, no draw is preserved, and no walkover or void line is written.
    expect(BRACKET_WALKOVER_KINDS.has("page_playoff")).toBe(false);
    const rig = await seedQualifiedStage(5, "page_playoff");
    await withdrawEntrantCascade(rig.auth, rig.idOf("E5"));
    await generateStageFixtures(rig.auth, rig.stageId);
    const rows = await expectNoDepartedInPendingFixture(rig);
    expect(rows).not.toEqual([]);
    expect(rows.every((r) => r.status === "scheduled")).toBe(true);
    const seated = new Set(
      rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]).filter((x): x is string => !!x),
    );
    expect(seated.has(rig.idOf("E5"))).toBe(false);
  });

  it("stepladder is a walkover kind — the list is not knockout-only", async () => {
    // Pins the membership N13 drops. Without "stepladder" in the set, the
    // withdrawn top seed stays seated in a `scheduled` final.
    expect(BRACKET_WALKOVER_KINDS.has("stepladder")).toBe(true);
    const rig = await seedQualifiedStage(4, "stepladder");
    await withdrawEntrantCascade(rig.auth, rig.idOf("E1"));
    await generateStageFixtures(rig.auth, rig.stageId);
    const rows = await expectNoDepartedInPendingFixture(rig);
    await expectNoDepartedWinner(rig, rows);
  });
});

describe.skipIf(!HAS_DB)("withdraw-then-generate agrees with generate-then-withdraw", () => {
  it("a single departure settles the same line, to the same winner, either way", async () => {
    const before = await seedQualifiedStage(8, "knockout");
    const opponent = pairedWith(before.qualified, before.idOf("E5"));
    await withdrawEntrantCascade(before.auth, before.idOf("E5"));
    await generateStageFixtures(before.auth, before.stageId);
    const beforeRows = await fixturesOf(before.stageId);

    const after = await seedQualifiedStage(8, "knockout");
    // The cascade only settles fixtures on a LIVE division — otherwise a
    // withdrawal is the plain status flip, because generation will redraw.
    await sql`update divisions set status = 'active' where id = ${after.divisionId}`;
    await generateStageFixtures(after.auth, after.stageId);
    await withdrawEntrantCascade(after.auth, after.idOf("E5"));
    const afterRows = await fixturesOf(after.stageId);

    // Same ext_key, same settled status, same winner (translated through each
    // rig's own ids, since the two divisions have different entrants).
    const pick = (rows: FixtureRow[], victim: string, opp: string) => {
      const row = rows.find(
        (r) =>
          r.home_entrant_id === victim ||
          r.away_entrant_id === victim ||
          r.home_entrant_id === opp ||
          r.away_entrant_id === opp,
      )!;
      return { ext: row.ext_key, status: row.status, winnerIsOpponent: row.outcome?.winner === opp };
    };
    const b = pick(beforeRows, before.idOf("E5"), opponent);
    const a = pick(afterRows, after.idOf("E5"), pairedWith(after.qualified, after.idOf("E5")));
    expect(b.status).toBe("forfeited");
    expect(b.winnerIsOpponent).toBe(true);
    expect(a).toEqual(b);
  });
});
