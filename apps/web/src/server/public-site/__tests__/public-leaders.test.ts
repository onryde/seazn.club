// Spectator surface W2, Task 3 — the public leader-row reader.
//
// Two halves, deliberately:
//
//  * The STUB half runs everywhere. `readLeaderRows`'s own logic — the empty
//    short-circuit, the division ids it asks for, the entrant grouping, and
//    the hand-off to the pure fold — is exercised against a fake `sql` tag.
//    `maskPublicEntrantNames` issues NO query for a `team` entrant (a team's
//    own declared name takes no personal-consent axis), so the real masking
//    pass is on the path here rather than mocked out.
//  * The DB half needs real Postgres (views, RLS, `player_stat_snapshots`) and
//    skips without DATABASE_URL, same convention as `public-lineups.test.ts`
//    beside this file. Only a real database can prove the SQL itself — the
//    joins, the visibility gate, and the masking of a NON-team entrant.
//
// The consent fold these rows feed is proven exhaustively and without a
// database in `leaders.test.ts` (`toLeaderInputRows`).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// unstable_cache is a Next server-runtime API with no incrementalCache outside
// a real request — passthrough under vitest, the same double consent.test.ts
// uses, and needed here because this module imports `./data` for the shared
// entrant-name masking pass.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

// `maskPublicEntrantNames` wrapped in a PASSTHROUGH spy: the DB half below
// still exercises the real implementation, while the wiring test in the stub
// half can substitute a recognisable return for a single call. Without that,
// nothing outside a database proved the reader uses the masking pass's OUTPUT
// — every stub row here is a `team` entrant, whose name the pass returns
// unchanged, so an implementation that ignored the pass and published the raw
// `entrant_name` column was indistinguishable (mutation sweep, M33).
const maskSpy = vi.hoisted(() => vi.fn());
vi.mock("../data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data")>();
  maskSpy.mockImplementation(actual.maskPublicEntrantNames);
  return { ...actual, maskPublicEntrantNames: maskSpy };
});

import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { readLeaderRows, type Sql } from "../public-leaders";

const HAS_DB = !!process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Stub half — no database
// ---------------------------------------------------------------------------

type StubRow = Record<string, unknown>;

/** A `sql` double: callable as a tagged template (returns the canned rows) and
 *  as a plain function (the `sql(ids)` array helper the `in ${...}` clause
 *  uses). Records every template call so the test can assert what was asked
 *  for. */
function stubSql(rows: StubRow[]): { sql: Sql; calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  const fn = (first: unknown, ...values: unknown[]): unknown => {
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, "raw")) {
      calls.push({ text: (first as unknown as string[]).join("?"), values });
      return Promise.resolve(rows);
    }
    // `sql(array)` — the helper that expands into an IN list. The stub only
    // needs to hand back something the template can hold.
    return { expanded: first };
  };
  return { sql: fn as unknown as Sql, calls };
}

const OPEN = { id: "d1", youth: false, player_name_display: null };

const dbRow = (over: StubRow = {}): StubRow => ({
  division_id: "d1",
  person_id: "p1",
  stats: { runs: 34, wickets: 1 },
  full_name: "Arun Kumar",
  consent: { public_name: true },
  entrant_id: "e1",
  entrant_kind: "team",
  entrant_name: "Blazers",
  badge_url: null,
  team_logo_path: null,
  public_profile: true,
  ...over,
});

describe("readLeaderRows — shape and wiring (no database)", () => {
  it("EMPTY: no divisions → no rows, and NO query is issued", async () => {
    const { sql: stub, calls } = stubSql([dbRow()]);
    expect(await readLeaderRows(stub, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("EMPTY: divisions with no snapshots → no rows", async () => {
    const { sql: stub } = stubSql([]);
    expect(await readLeaderRows(stub, [OPEN])).toEqual([]);
  });

  it("asks for exactly the division ids it was given", async () => {
    const { sql: stub, calls } = stubSql([]);
    await readLeaderRows(stub, [OPEN, { id: "d2" }]);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]!.values)).toContain("d1");
    expect(JSON.stringify(calls[0]!.values)).toContain("d2");
  });

  it("reads the snapshot table WITHOUT recomputing it", async () => {
    // The hub must never re-fold a division's score events on a page render.
    // `recomputePlayerStats` is the only thing that would, and this reader
    // does not import it — asserted on the query text, which selects from the
    // snapshot table directly. The visibility gate is NOT asserted here: it
    // has its own test below, anchored on the join, because a `toContain`
    // check on the table name passes on its own inversion (`left join`).
    const { sql: stub, calls } = stubSql([]);
    await readLeaderRows(stub, [OPEN]);
    expect(calls[0]!.text).toContain("player_stat_snapshots");
  });

  it("gates visibility with an INNER join on public_divisions_v", async () => {
    // Anchored, not a substring. `toContain("public_divisions_v")` passes on
    // its own inversion: weakening this to a LEFT join removes the gate
    // entirely — every snapshot row comes back, with the division columns
    // null — while the substring is still present. That mutant survived the
    // whole suite in review. The gate is an INNER join or it is not a gate.
    //
    // This is a string assertion standing in for a behavioural one. The real
    // proof is the private-competition test in the DB half below; this exists
    // so the boundary is not left completely unguarded on a run without a
    // database, which is every local run and every non-`smoke-db` CI job.
    const { sql: stub, calls } = stubSql([]);
    await readLeaderRows(stub, [OPEN]);
    expect(calls[0]!.text).toMatch(/\n\s*join public_divisions_v d on d\.id = ps\.division_id/);
    expect(calls[0]!.text).not.toMatch(/(left|right|full|cross)\s+join\s+public_divisions_v/i);
  });

  it("folds a row end to end, with the entrant name through the shared masking pass", async () => {
    const { sql: stub } = stubSql([dbRow()]);
    const [row] = await readLeaderRows(stub, [OPEN]);
    expect(row).toEqual({
      divisionId: "d1",
      personId: "p1",
      name: "Arun Kumar",
      masked: false,
      publicProfile: true,
      entrantName: "Blazers",
      badgeUrl: null,
      stats: { runs: 34, wickets: 1 },
    });
  });

  it("CONSENT: an opted-out person is masked, never blank and never dropped", async () => {
    const { sql: stub } = stubSql([dbRow({ consent: { public_name: false } })]);
    const [row] = await readLeaderRows(stub, [OPEN]);
    expect(row!.masked).toBe(true);
    expect(row!.name).not.toBe("");
    expect(row!.name).not.toBe("Arun Kumar");
  });

  it("groups entrants per division — a second division's entrant is not lost", async () => {
    const { sql: stub } = stubSql([
      dbRow(),
      dbRow({ division_id: "d2", person_id: "p2", entrant_id: "e2", entrant_name: "Rovers" }),
    ]);
    const rows = await readLeaderRows(stub, [OPEN, { id: "d2" }]);
    expect(rows.map((r) => [r.divisionId, r.entrantName])).toEqual([
      ["d1", "Blazers"],
      ["d2", "Rovers"],
    ]);
  });

  it("publishes the masking pass's OUTPUT, never the raw entrant_name column", async () => {
    // One call only (mockImplementationOnce self-clears), so the passthrough
    // is restored for every other test in this file.
    maskSpy.mockImplementationOnce(
      async (entrants: { id: string; display_name: string }[]) =>
        entrants.map((e) => ({ ...e, opted_out: true, display_name: `masked:${e.display_name}` })),
    );
    const { sql: stub } = stubSql([dbRow()]);
    const [row] = await readLeaderRows(stub, [OPEN]);
    expect(row!.entrantName).toBe("masked:Blazers");
  });

  it("hands the masking pass this division's entrants and its own consent policy", async () => {
    maskSpy.mockClear();
    const youth = { id: "d1", youth: true, player_name_display: "first_initial" };
    const { sql: stub } = stubSql([dbRow()]);
    await readLeaderRows(stub, [youth]);
    expect(maskSpy).toHaveBeenCalledTimes(1);
    expect(maskSpy.mock.calls[0]![0]).toEqual([
      { id: "e1", kind: "team", display_name: "Blazers" },
    ]);
    expect(maskSpy.mock.calls[0]![1]).toEqual(youth);
  });

  it("masks each division's entrants under THAT division's policy, not a shared one", async () => {
    // Two divisions with opposite youth settings. The spy stamps the policy it
    // was handed onto the name, which is the only way to see the difference
    // here: the real pass leaves a `team` name untouched under either policy,
    // so an implementation that masked every division's entrants under one
    // division's policy would otherwise be invisible without a database.
    // Queued per call (one per division) rather than set globally:
    // `mockImplementationOnce` self-clears, so the passthrough is intact for
    // every later test in this file.
    const stamp = async (
      entrants: { id: string; display_name: string }[],
      division: { youth?: boolean },
    ) =>
      entrants.map((e) => ({
        ...e,
        opted_out: false,
        display_name: `${division.youth ? "Y" : "N"}:${e.display_name}`,
      }));
    maskSpy.mockImplementationOnce(stamp).mockImplementationOnce(stamp);

    const { sql: stub } = stubSql([
      dbRow(),
      dbRow({ division_id: "d2", person_id: "p2", entrant_id: "e2", entrant_name: "Rovers" }),
    ]);
    const rows = await readLeaderRows(stub, [
      { id: "d1", youth: false, player_name_display: null },
      { id: "d2", youth: true, player_name_display: null },
    ]);
    expect(rows.map((r) => r.entrantName)).toEqual(["N:Blazers", "Y:Rovers"]);
  });

  it("two people in one entrant resolve to the same entrant name", async () => {
    const { sql: stub } = stubSql([dbRow(), dbRow({ person_id: "p2", full_name: "Dev Patel" })]);
    const rows = await readLeaderRows(stub, [OPEN]);
    expect(rows.map((r) => r.entrantName)).toEqual(["Blazers", "Blazers"]);
  });

  it("a person with no entrant still yields a row", async () => {
    const { sql: stub } = stubSql([
      dbRow({ entrant_id: null, entrant_kind: null, entrant_name: null }),
    ]);
    const [row] = await readLeaderRows(stub, [OPEN]);
    expect(row!.personId).toBe("p1");
    expect(row!.entrantName).toBeNull();
  });

  it("resolves the badge through the shared resolver", async () => {
    const { sql: stub } = stubSql([dbRow({ badge_url: "https://cdn/b.png" })]);
    const [row] = await readLeaderRows(stub, [OPEN]);
    expect(row!.badgeUrl).toBe("https://cdn/b.png");
  });
});

// ---------------------------------------------------------------------------
// DB half — the SQL itself
// ---------------------------------------------------------------------------

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx; orgId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null }, orgId };
}

async function seedPerson(orgId: string, fullName: string, consent: Record<string, boolean>): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, photo_path, consent)
    values (${orgId}, ${fullName}, '2000-04-03', 'f', ${"photos/" + fullName}, ${sql.json(consent)})
    returning id`;
  return id;
}

async function seedSnapshot(divisionId: string, personId: string, stats: Record<string, number>): Promise<void> {
  await sql`
    insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
    values (${divisionId}, ${personId}, 'generic', ${sql.json(stats)}, 1)`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("readLeaderRows against real Postgres", () => {
  it("joins snapshot → person (consent-resolved) → entrant, and flags the public profile", async () => {
    const { auth, orgId } = await seedOrg();
    const publicFullName = "Alice Wonder";
    const privateFullName = "Bob Private";
    const publicPersonId = await seedPerson(orgId, publicFullName, { public_name: true });
    const privatePersonId = await seedPerson(orgId, privateFullName, { public_name: false });

    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Leaders Cup",
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    await createEntrants(auth, division.id, [
      {
        kind: "team",
        display_name: "Blazers",
        seed: 1,
        members: [
          { person_id: publicPersonId, squad_number: 7, default_position_key: null, is_captain: true, roles: [] },
          { person_id: privatePersonId, squad_number: 9, default_position_key: null, is_captain: false, roles: [] },
        ],
      },
    ]);
    await seedSnapshot(division.id, publicPersonId, { runs: 34, wickets: 1 });
    await seedSnapshot(division.id, privatePersonId, { runs: 12 });

    const rows = await readLeaderRows(sql, [{ id: division.id, youth: false, player_name_display: null }]);
    expect(rows).toHaveLength(2);

    const open = rows.find((r) => r.personId === publicPersonId)!;
    expect(open).toMatchObject({
      name: publicFullName,
      masked: false,
      publicProfile: true,
      entrantName: "Blazers",
      stats: { runs: 34, wickets: 1 },
    });

    const priv = rows.find((r) => r.personId === privatePersonId)!;
    expect(priv.masked).toBe(true);
    expect(priv.name).not.toBe("");
    expect(priv.name).not.toBe(privateFullName);
    // A person who opted out is absent from public_players_v — no profile to
    // link to, but the ROW still exists.
    expect(priv.publicProfile).toBe(false);
    expect(priv.stats).toEqual({ runs: 12 });
    // A TEAM's own declared name carries no personal consent, so it survives
    // the masking pass untouched even though a member opted out.
    expect(priv.entrantName).toBe("Blazers");
  });

  it("VISIBILITY: a private competition's snapshots are not readable", async () => {
    const { auth, orgId } = await seedOrg();
    const personId = await seedPerson(orgId, "Hidden Player", { public_name: true });
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Private Cup",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    await seedSnapshot(division.id, personId, { runs: 99 });

    // The visibility gate is the public_divisions_v join, not RLS — this read
    // runs on the RLS-bypassing connection, so the join is the only thing
    // standing between a private competition and a spectator.
    expect(await readLeaderRows(sql, [{ id: division.id }])).toEqual([]);
  });

  it("CONSENT: a NON-team entrant's display name is masked by the shared pass", async () => {
    const { auth, orgId } = await seedOrg();
    const personId = await seedPerson(orgId, "Chandra Bose", { public_name: false });
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Singles Cup",
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: "Chandra Bose",
        seed: 1,
        members: [
          { person_id: personId, squad_number: null, default_position_key: null, is_captain: true, roles: [] },
        ],
      },
    ]);
    await seedSnapshot(division.id, personId, { runs: 5 });

    const [row] = await readLeaderRows(sql, [{ id: division.id, youth: false, player_name_display: null }]);
    expect(row!.entrantName).not.toBe("Chandra Bose");
    expect(row!.entrantName).not.toBe("");
    expect(row!.entrantName).toBe("Chandra B.");
  });

  it("a youth division masks every name, consent notwithstanding", async () => {
    const { auth, orgId } = await seedOrg();
    const personId = await seedPerson(orgId, "Priya Sharma", { public_name: true });
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Youth Cup",
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "U12",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    // The entrant membership is REQUIRED for `publicProfile` below, not
    // decoration. The live `public_players_v` (V350:54-70, which supersedes
    // the V307 the brief cited) gates on three things, not one: public_name
    // consent, `merged_into is null`, AND an entrant_members row reaching a
    // public/unlisted competition through an entrant whose status is
    // registered or confirmed. Without this seed the person is absent from
    // the view and the assertion below is false by construction.
    await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: "Priya Sharma",
        seed: 1,
        members: [
          { person_id: personId, squad_number: null, default_position_key: null, is_captain: true, roles: [] },
        ],
      },
    ]);
    await seedSnapshot(division.id, personId, { runs: 21 });

    const [row] = await readLeaderRows(sql, [{ id: division.id, youth: true, player_name_display: null }]);
    expect(row!.masked).toBe(true);
    expect(row!.name).toBe("Priya S.");
    // Still in public_players_v — a profile exists; the LINK decision belongs
    // to buildLeaderBoards, which withholds it for a masked person.
    expect(row!.publicProfile).toBe(true);
  });

  it("SAFEGUARDING: a single-token youth name is masked, so no player-page link is offered", async () => {
    // The one-token case against the REAL view and the REAL resolver: the
    // rendered name is identical either way (masking a single token returns
    // it unchanged), so only the `masked` flag — and the link it gates —
    // can carry the safeguarding decision.
    const { auth, orgId } = await seedOrg();
    const personId = await seedPerson(orgId, "Ronaldinho", { public_name: true });
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Youth Cup Single",
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "U12",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    await createEntrants(auth, division.id, [
      {
        kind: "individual",
        display_name: "Ronaldinho",
        seed: 1,
        members: [
          { person_id: personId, squad_number: null, default_position_key: null, is_captain: true, roles: [] },
        ],
      },
    ]);
    await seedSnapshot(division.id, personId, { runs: 7 });

    const [row] = await readLeaderRows(sql, [{ id: division.id, youth: true, player_name_display: null }]);
    expect(row!.name).toBe("Ronaldinho");
    expect(row!.publicProfile).toBe(true);
    expect(row!.masked).toBe(true);
  });
});
