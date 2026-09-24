// `restByeSql` (server/fixture-bye-sql.ts) is the SQL spelling of `isRestBye`
// (lib/fixture-bye.ts) for the readers that count in Postgres (#850). Two
// spellings of one rule drift unless something runs both on the same rows —
// this does, over EVERY engine stage kind (derived from `StageKind`, never
// typed) × every row shape the predicate distinguishes, and checks both
// directions: `where frag` picks exactly the TS rest byes, and `where not frag`
// keeps exactly the rest, including the rows whose `outcome` is NULL (the
// ordinary unplayed match — a NULL-unsafe fragment would drop it silently).
// Since the fourth-round ruling (2026-09-24) the rows also vary the MARKER
// (`ext_key`), and NULL keys ride the `not` direction the same way.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { StageKind } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { isRestBye, restByeExtKey } from "@/lib/fixture-bye";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { GENERIC_CONFIG, seedOrg } from "@/server/usecases/__tests__/_seed";
import { restByeSql } from "../fixture-bye-sql";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface Read {
  id: string;
  kind: string;
  shape: string;
  ext_key: string | null;
  outcome: unknown;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  sql_says: boolean;
}

describe.skipIf(!HAS_DB)("restByeSql agrees with isRestBye on real rows", () => {
  it("every stage kind × every row shape, both directions", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Bye SQL " + randomUUID().slice(0, 6),
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
    const [a, b] = await createEntrants(auth, division.id, [
      { kind: "individual" as const, display_name: "A", seed: 1, members: [] },
      { kind: "individual" as const, display_name: "B", seed: 2, members: [] },
    ]);
    const A = a!.id;
    const B = b!.id;

    // Rows: [label, home, away, status, outcome, ext_key]. `outcome` null is SQL
    // NULL; "string" is the double-encoded jsonb scalar the F1 writer used to
    // store. `ext_key` is the MARKER (owner ruling 2026-09-24, fourth round):
    // the generator's bye key, `restByeExtKey` — the row SHAPE alone never
    // decides a rest bye, so every bye shape appears with and without it, and
    // every non-bye shape appears WITH it (the marker alone is not enough).
    const bye = (n: number) => restByeExtKey("", n);
    const shapes: [string, string | null, string | null, string, unknown, string | null][] = [
      ["bye, home seated, marked", A, null, "forfeited", { kind: "award", winner: A }, bye(1)],
      ["bye, away seated, marked (pool key)", null, B, "forfeited", { kind: "award", winner: B }, restByeExtKey("pA-", 2)],
      // The fed league's walkover (`awardSeededByes`): a bye's shape, a MATCH key.
      ["walkover: bye shape, match key", A, null, "forfeited", { kind: "award", winner: A }, "rr-r3-c1"],
      ["bye shape, Swiss bye key", A, null, "forfeited", { kind: "award", winner: A }, "sw-r1-bye"],
      ["bye shape, ad-hoc key", null, B, "forfeited", { kind: "award", winner: B }, "adhoc-4"],
      ["bye shape, no key", A, null, "forfeited", { kind: "award", winner: A }, null],
      ["bye shape, near-miss key (prefix)", A, null, "forfeited", { kind: "award", winner: A }, "xrr-r1-bye"],
      ["bye shape, near-miss key (suffix)", A, null, "forfeited", { kind: "award", winner: A }, "rr-r1-bye-2"],
      ["two-sided walkover, marked", A, B, "forfeited", { kind: "award", winner: B }, bye(4)],
      ["played win, marked", A, B, "decided", { kind: "win", winner: A, loser: B }, bye(5)],
      ["unplayed, no outcome, marked", A, B, "scheduled", null, bye(6)],
      ["one seat, no outcome, marked", A, null, "scheduled", null, bye(7)],
      ["one seat, winner not seated, marked", A, null, "forfeited", { kind: "award", winner: B }, bye(8)],
      ["orphan: both seats gone, marked", null, null, "forfeited", { kind: "award", winner: A }, bye(9)],
      ["award naming no winner, marked", A, null, "forfeited", { kind: "award" }, bye(10)],
      ["double-encoded string, marked", A, null, "forfeited", "string", bye(11)],
      ["unplayed, no outcome, no key", A, B, "scheduled", null, null],
    ];
    const labelOf = (key: string | null, home: string | null, away: string | null, outcome: unknown) =>
      shapes.find(([, h, a, , o, k]) => k === key && h === home && a === away && (o === null) === (outcome === null))![0];

    let seq = 0;
    for (const kind of StageKind.options) {
      const [stage] = await sql<{ id: string }[]>`
        insert into stages (division_id, org_id, seq, kind, name, config)
        values (${division.id}, ${auth.orgId}, ${++seq}, ${kind}, ${kind}, ${sql.json({})})
        returning id`;
      let n = 0;
      for (const [, home, away, status, outcome, extKey] of shapes) {
        const json =
          outcome === null
            ? null
            : outcome === "string"
              ? sql.json(JSON.stringify({ kind: "award", winner: A }))
              : sql.json(outcome as never);
        await sql`
          insert into fixtures (stage_id, division_id, org_id, round_no, seq_in_round,
                                home_entrant_id, away_entrant_id, status, outcome, ext_key)
          values (${stage!.id}, ${division.id}, ${auth.orgId}, 1, ${++n},
                  ${home}, ${away}, ${status}, ${json}, ${extKey})`;
      }
    }

    const rows = (
      await sql<Omit<Read, "shape">[]>`
        select f.id, s.kind, f.ext_key, f.outcome, f.home_entrant_id, f.away_entrant_id,
               ${restByeSql(sql)} as sql_says
        from fixtures f join stages s on s.id = f.stage_id
        where f.division_id = ${division.id}`
    ).map((r) => ({ ...r, shape: labelOf(r.ext_key, r.home_entrant_id, r.away_entrant_id, r.outcome) }));
    expect(rows).toHaveLength(StageKind.options.length * shapes.length);

    for (const r of rows) {
      expect(r.sql_says, `${r.kind} / ${r.shape}`).toBe(isRestBye(r, r.kind));
    }
    // The premise, so the loop above is not agreeing on "false" everywhere:
    // exactly the two MARKED bye shapes, in exactly the round-robin kinds —
    // and never the walkover beside them, whose only difference is its key.
    const yes = rows.filter((r) => r.sql_says).map((r) => `${r.kind} / ${r.shape}`).sort();
    expect(yes).toEqual([
      "group / bye, away seated, marked (pool key)",
      "group / bye, home seated, marked",
      "league / bye, away seated, marked (pool key)",
      "league / bye, home seated, marked",
    ]);

    // Both directions through WHERE, the way every reader uses it.
    const picked = await sql<{ id: string }[]>`
      select f.id from fixtures f where f.division_id = ${division.id} and ${restByeSql(sql)}`;
    const kept = await sql<{ id: string }[]>`
      select f.id from fixtures f where f.division_id = ${division.id} and not ${restByeSql(sql)}`;
    expect(picked.map((r) => r.id).sort()).toEqual(rows.filter((r) => isRestBye(r, r.kind)).map((r) => r.id).sort());
    expect(kept.map((r) => r.id).sort()).toEqual(rows.filter((r) => !isRestBye(r, r.kind)).map((r) => r.id).sort());
    // NULL-safety, stated on its own: every no-outcome row survives `not`.
    const noOutcome = rows.filter((r) => r.outcome === null).map((r) => r.id);
    expect(noOutcome.length).toBeGreaterThan(0);
    for (const id of noOutcome) expect(kept.some((r) => r.id === id)).toBe(true);

    // A caller-chosen alias reads the same rows.
    const aliased = await sql<{ id: string }[]>`
      select fx.id from fixtures fx where fx.division_id = ${division.id} and ${restByeSql(sql, "fx")}`;
    expect(aliased.map((r) => r.id).sort()).toEqual(picked.map((r) => r.id).sort());
  });
});
