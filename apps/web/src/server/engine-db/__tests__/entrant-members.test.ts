// S8/#417 — pure, DB-free half of the entrant-membership loader. The
// DB-backed proof that `loadEntrantMembersForDivision` itself queries the
// right rows is in player-stats.test.ts / org-posts.test.ts (through the
// real recomputePlayerStats / extractScorers call sites, per the owner's
// ruling that an engine unit test is not the acceptance bar here — mirrors
// fixture-cfg.test.ts's split: pure logic here, DB proof at the usecase).
//
// ONE exception (S8/#417 W6 review round 2, fix 2): comparing
// `loadEntrantMembersForFixture` against `loadEntrantMembersForDivision` for
// the SAME fixture is a claim about the two loaders' SQL agreeing with each
// other, which cannot be checked through org-posts.ts's `extractScorers`
// without a second, indirect derivation of "what should this have been" —
// exactly the kind of test that would not catch a wrong-fixture bug (a
// scoped query that silently returned a DIFFERENT fixture's entrants). That
// comparison belongs here, directly against both exports, DB-backed.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "@/lib/db";
import { personsForEntrant } from "@seazn/engine/stats";
import {
  entrantFoldCtx,
  loadEntrantMembersForDivision,
  loadEntrantMembersForFixture,
  type EntrantMembership,
} from "../entrant-members";

type Tx = postgres.TransactionSql;
const HAS_DB = !!process.env.DATABASE_URL;

describe("entrantFoldCtx", () => {
  it("builds ctx.entrants as exactly [home, away] with each one's kind, and wires personsOf", () => {
    const members = new Map<string, EntrantMembership>([
      ["home-1", { kind: "individual", personIds: ["p-home"] }],
      ["away-1", { kind: "pair", personIds: ["p-away-1", "p-away-2"] }],
    ]);
    const ctx = entrantFoldCtx("home-1", "away-1", members, { setTo: 21 });

    // Order matters for the engine's folded fold (setBasedMatchOutcomesFold
    // reads ctx.entrants[0]/[1] as its two synthetic sides) even though which
    // physical side is "first" doesn't change attribution correctness — see
    // that function's own doc comment. What matters here is BOTH are present,
    // exactly once each, with the kind this map recorded.
    expect(ctx.entrants).toEqual([
      { id: "home-1", kind: "individual" },
      { id: "away-1", kind: "pair" },
    ]);
    expect(ctx.personsOf("home-1")).toEqual(["p-home"]);
    expect(ctx.personsOf("away-1")).toEqual(["p-away-1", "p-away-2"]);
    expect(ctx.cfg).toEqual({ setTo: 21 });
  });

  // THE load-bearing property (packages/engine/src/sports/setbased/kernel.ts
  // `setBasedMatchOutcomesFold`): `if (ctx.entrants.length !== 2) return [];`
  // — passing the WHOLE division's entrant roster instead of just this
  // fixture's two sides would silently zero out sets_won/matches for every
  // fixture. A bye/TBD side (null id) must still degrade to fewer than 2
  // entries, never be padded or substituted.
  it("drops a null (bye/TBD) side rather than padding it", () => {
    const members = new Map<string, EntrantMembership>([
      ["home-1", { kind: "individual", personIds: ["p-home"] }],
    ]);
    const ctx = entrantFoldCtx("home-1", null, members, undefined);
    expect(ctx.entrants).toEqual([{ id: "home-1", kind: "individual" }]);
    expect(ctx.entrants).toHaveLength(1); // NOT 2 — the fold's own guard relies on this
  });

  it("both sides null yields an empty entrants list, never a throw", () => {
    const ctx = entrantFoldCtx(null, null, new Map(), undefined);
    expect(ctx.entrants).toEqual([]);
  });

  it("defaults an entrant missing from the membership map to kind 'team' (never throws, never credits)", () => {
    // House rule: no throw on a data-derived condition in the fold path. An
    // entrant id the loader's query somehow didn't return (should not happen
    // under real FK integrity, but this function must never assume it) must
    // degrade safely — "team" is the SAFE default because the engine's own
    // mandatory kind guard then credits nobody, rather than "individual"
    // which would fabricate an attribution out of missing data.
    const ctx = entrantFoldCtx("ghost-1", "home-1", new Map([["home-1", { kind: "individual", personIds: ["p"] }]]), undefined);
    expect(ctx.entrants).toEqual([
      { id: "ghost-1", kind: "team" },
      { id: "home-1", kind: "individual" },
    ]);
    expect(ctx.personsOf("ghost-1")).toEqual([]);
  });

  it("personsOf reads the whole membership map, not just ctx.entrants", () => {
    // Deliberate: the engine only ever calls personsOf for an id it already
    // found in ctx.entrants (resolveMetricPersons looks the id up first), so
    // scoping personsOf to the division-wide map is harmless — and simpler
    // than rebuilding a second, narrower closure per fixture.
    const members = new Map<string, EntrantMembership>([
      ["elsewhere", { kind: "individual", personIds: ["p-elsewhere"] }],
    ]);
    const ctx = entrantFoldCtx(null, null, members, undefined);
    expect(ctx.personsOf("elsewhere")).toEqual(["p-elsewhere"]);
  });
});

// ---------------------------------------------------------------------------
// S8/#417 W6 review round 2, fix 2 — `loadEntrantMembersForFixture` is the
// scoped counterpart to `loadEntrantMembersForDivision`, the way lineups.ts's
// `loadLineupPair` sits beside its own `loadLineupPairsForDivision`.
// `org-posts.ts`'s `extractScorers` folds ONE fixture per call but used to
// call the division-wide loader for it — O(division roster) work repeated on
// every match result where O(1) was what the caller needed.
//
// Raw-SQL seed (mirrors undo-status.test.ts's shape) rather than the usecase
// layer this file has never depended on — this block is proving the SQL
// itself, so the entitlement/usecase machinery above it would only add noise.
// ---------------------------------------------------------------------------
afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

interface FixturePair {
  home: string;
  away: string;
}

/** Fresh org → division → 4 entrants of DIFFERENT kinds and roster sizes →
 *  2 fixtures with disjoint entrant pairs. Different kinds/roster sizes per
 *  entrant means a row-mapping mistake (wrong kind, wrong personIds) is
 *  visible in a `toEqual`, not masked by every entrant looking alike; two
 *  disjoint fixtures is what makes a wrong-fixture bug (the scoped loader
 *  silently answering for the WRONG fixture) something a test can actually
 *  catch, rather than one that only checks "returns something". */
async function seedDivisionWithTwoFixtures(): Promise<{
  divisionId: string;
  fixture0: FixturePair;
  fixture1: FixturePair;
}> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"EM " + suffix}, ${"em-" + suffix})
    returning id`;
  const [{ id: competitionId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility)
    values (${orgId}, ${"Comp " + suffix}, ${"comp-" + suffix}, 'private')
    returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (competition_id, name, slug, sport_key, variant_key, config, module_version, status)
    values (${competitionId}, 'Div', ${"div-" + suffix}, 'generic', 'default',
            ${sql.json({})}, '1.0.0', 'active')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (division_id, seq, kind, name) values (${divisionId}, 1, 'league', 'League')
    returning id`;

  async function makeEntrant(kind: string, name: string, personNames: string[]): Promise<string> {
    const [{ id: entrantId }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, kind, display_name, seed)
      values (${divisionId}, ${kind}, ${name}, 1)
      returning id`;
    for (const personName of personNames) {
      const [{ id: personId }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${orgId}, ${personName}) returning id`;
      await sql`
        insert into entrant_members (entrant_id, person_id, org_id)
        values (${entrantId}, ${personId}, ${orgId})`;
    }
    return entrantId;
  }

  const a = await makeEntrant("individual", "A", ["A One"]);
  const b = await makeEntrant("pair", "B", ["B One", "B Two"]);
  const c = await makeEntrant("team", "C", ["C One", "C Two", "C Three"]);
  const d = await makeEntrant("individual", "D", ["D One"]);

  await sql`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 1, ${a}, ${b})`;
  await sql`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id)
    values (${stageId}, ${divisionId}, 1, 2, ${c}, ${d})`;

  return { divisionId, fixture0: { home: a, away: b }, fixture1: { home: c, away: d } };
}

describe.skipIf(!HAS_DB)("loadEntrantMembersForFixture vs loadEntrantMembersForDivision", () => {
  it("returns exactly this fixture's two entrants, with the SAME kind/personIds the division-wide loader reports for them — and nothing from a sibling fixture", async () => {
    const { divisionId, fixture0, fixture1 } = await seedDivisionWithTwoFixtures();
    const tx = sql as unknown as Tx;

    const divisionWide = await loadEntrantMembersForDivision(tx, divisionId);
    const scoped = await loadEntrantMembersForFixture(tx, fixture0.home, fixture0.away);

    expect(scoped.size).toBe(2);
    for (const id of [fixture0.home, fixture0.away]) {
      expect(scoped.get(id)).toEqual(divisionWide.get(id));
      expect(scoped.get(id)!.personIds.length).toBeGreaterThan(0); // non-vacuous
    }
    // The sibling fixture's entrants must not leak in — a scoped loader that
    // (by bug) ignored its own arguments and answered for the wrong fixture
    // would still pass a test that only checked "returns something"; this is
    // the assertion that would catch it.
    expect(scoped.has(fixture1.home)).toBe(false);
    expect(scoped.has(fixture1.away)).toBe(false);
  });

  it("a bye/TBD side (null entrant id) returns just the one known side, never throws", async () => {
    const { fixture0 } = await seedDivisionWithTwoFixtures();
    const tx = sql as unknown as Tx;
    const scoped = await loadEntrantMembersForFixture(tx, fixture0.home, null);
    expect(scoped.size).toBe(1);
    expect(scoped.has(fixture0.home)).toBe(true);
  });

  it("both sides null returns an empty map without querying", async () => {
    const tx = sql as unknown as Tx;
    const scoped = await loadEntrantMembersForFixture(tx, null, null);
    expect(scoped.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S9/#418 — the `personsOf` credit rule, as a REGRESSION for the career
// rollup: personCareerStats/listMyCareerStats sum whatever rows already sit
// in player_stat_snapshots, and those rows exist only because
// `personsForEntrant` (packages/engine/src/stats/stats.ts, the shared export
// every `folded.fold` implementation credits through) already enforces
// "individual/pair credit their member(s), team credits nobody" at WRITE
// time. This is not new behaviour — S8/#417 shipped it — but the career
// summation's own correctness structurally depends on it never regressing
// (a team-kind entrant that started crediting a phantom row would silently
// inflate every career total built on top of it), so it earns its own
// pinned assertion here rather than being trusted by inference from
// elsewhere. Built through entrantFoldCtx (this file's own constructor),
// matching how recomputePlayerStats actually wires the two together.
// ---------------------------------------------------------------------------
describe("personsForEntrant — the credit rule career rollup depends on", () => {
  it("an individual entrant credits its one member", () => {
    const members = new Map<string, EntrantMembership>([
      ["ind-1", { kind: "individual", personIds: ["p-solo"] }],
    ]);
    const ctx = entrantFoldCtx("ind-1", null, members, undefined);
    expect(personsForEntrant(ctx, "ind-1")).toEqual(["p-solo"]);
  });

  it("a pair entrant credits BOTH members", () => {
    const members = new Map<string, EntrantMembership>([
      ["pair-1", { kind: "pair", personIds: ["p-one", "p-two"] }],
    ]);
    const ctx = entrantFoldCtx("pair-1", null, members, undefined);
    expect(personsForEntrant(ctx, "pair-1")).toEqual(["p-one", "p-two"]);
  });

  // THE regression: a team-kind entrant's roster is real, non-empty data —
  // personsOf(entrantId) would happily return it — but personsForEntrant
  // must still credit NOBODY. Without this guard a career rollup would sum
  // a phantom row for every member of every team-kind entrant a person ever
  // sat on, in every sport, everywhere in the product.
  it("a team entrant credits NOBODY, even though its roster is real and non-empty", () => {
    const members = new Map<string, EntrantMembership>([
      ["team-1", { kind: "team", personIds: ["p-alice", "p-bob", "p-cara"] }],
    ]);
    const ctx = entrantFoldCtx("team-1", null, members, undefined);
    expect(personsForEntrant(ctx, "team-1")).toEqual([]);
  });

  it("an entrant id absent from ctx.entrants credits nobody (never throws)", () => {
    const members = new Map<string, EntrantMembership>([
      ["known-1", { kind: "individual", personIds: ["p-known"] }],
    ]);
    const ctx = entrantFoldCtx("known-1", null, members, undefined);
    expect(personsForEntrant(ctx, "ghost-entrant")).toEqual([]);
  });

  it("an empty-string person id is filtered out of an otherwise real roster", () => {
    const members = new Map<string, EntrantMembership>([
      ["pair-2", { kind: "pair", personIds: ["p-real", ""] }],
    ]);
    const ctx = entrantFoldCtx("pair-2", null, members, undefined);
    expect(personsForEntrant(ctx, "pair-2")).toEqual(["p-real"]);
  });
});
