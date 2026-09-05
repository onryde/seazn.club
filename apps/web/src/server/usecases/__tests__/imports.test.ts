// Integration tests for PROMPT-21 (Jul3/01): import plan → commit → re-plan
// no-op, entitlement caps, clubs CRUD + display fallback. Real Postgres
// required (RLS, triggers, hash chains); skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { football } from "@seazn/engine/sports/football";
import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createImport, getImport, commitImport } from "../imports";
import { listClubs, participantRows } from "../clubs";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(
  plan: "community" | "pro" = "pro",
): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Imp " + suffix}, ${"imp-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('football', 'Football', ${football.version}, ${sql.json(football.positions as never)})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('football', 'default', 'Default', ${sql.json({})}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

async function seedDivision(auth: AuthCtx, slug = "u12") {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Import Cup",
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: slug.toUpperCase(),
    slug,
    sport_key: "football",
    variant_key: "default",
    config: {},
  });
  return { comp, division };
}

const GK = football.positions.groups[0]!.key;

function csvUpload(csv: string) {
  return {
    filename: "import.csv",
    contentType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  };
}

const GOLDEN_CSV = [
  "Club,Team,Player,DOB,Number,Position,Captain,Division",
  `Acme SC,Acme U12,Ada One,2014-01-01,1,${GK},y,u12`,
  "Acme SC,Acme U12,Bo Two,2014-01-02,2,,,u12",
  "Acme SC,Acme U12,Cy Three,2014-01-03,3,,,u12",
  "Borough FC,Borough U12,Di Four,2014-01-04,4,,,u12",
  "Borough FC,Borough U12,Ed Five,2014-01-05,5,,,u12",
  "City Rovers,City U12,Fi Six,2014-01-06,6,,,u12",
].join("\r\n");

// End AND uncache the shared client: with isolate:false another DB test file
// may run in this worker afterwards and must get a fresh connection.
afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("bulk import (Jul3/01)", () => {
  it("plans, commits, and re-planning the same file is a no-op", async () => {
    const { auth } = await seedOrg();
    await seedDivision(auth);

    const preview = await createImport(auth, csvUpload(GOLDEN_CSV));
    expect(preview.plan.issues).toEqual([]);
    expect(preview.plan.stats).toEqual({
      clubs: 3,
      teams: 3,
      persons: 6,
      entrants: 3,
      rosters: 6,
    });
    expect(preview.mapping).toMatchObject({
      Club: "clubName",
      Player: "playerFullName",
    });

    const result = await commitImport(auth, preview.importId, "key-1");
    expect(result.stats).toEqual(preview.plan.stats);
    expect(result.divisionIds).toHaveLength(1);

    // committed rows all present, with club parentage
    const clubs = await listClubs(auth);
    expect(clubs.map((c) => c.name).sort()).toEqual([
      "Acme SC",
      "Borough FC",
      "City Rovers",
    ]);
    const [counts] = await sql<
      { teams: number; persons: number; members: number }[]
    >`
      select (select count(*)::int from teams where org_id = ${auth.orgId} and club_id is not null) as teams,
             (select count(*)::int from persons where org_id = ${auth.orgId}) as persons,
             (select count(*)::int from entrant_members em join entrants e on e.id = em.entrant_id
              where e.org_id = ${auth.orgId}) as members`;
    expect(counts).toEqual({ teams: 3, persons: 6, members: 6 });

    // ledger row + intact hash chain
    const [ev] = await sql<{ type: string; broken: string | null }[]>`
      select de.type, verify_division_events_chain(de.division_id)::text as broken
      from division_events de
      where de.division_id = ${result.divisionIds[0]!} and de.type = 'participants_imported'`;
    expect(ev).toMatchObject({ type: "participants_imported", broken: null });

    // re-upload the same file ⇒ zero ops; committing it adds zero rows
    const again = await createImport(auth, csvUpload(GOLDEN_CSV));
    expect(again.plan.ops).toEqual([]);
    await commitImport(auth, again.importId, null);
    const [counts2] = await sql<{ persons: number }[]>`
      select count(*)::int as persons from persons where org_id = ${auth.orgId}`;
    expect(counts2!.persons).toBe(6);

    // Idempotency-Key replay returns the recorded result without re-running
    const replay = await commitImport(auth, preview.importId, "key-1");
    expect(replay).toEqual(result);
  });

  it("blocks commit on seeded error issues, then commits after the fix (preview → fix → commit)", async () => {
    const { auth } = await seedOrg();
    await seedDivision(auth);
    const bad = [
      "Team,Player,Position,Division",
      "Acme U12,Ada One,striker,u12", // bad position for football
    ].join("\n");
    const preview = await createImport(auth, csvUpload(bad));
    expect(preview.plan.issues).toEqual([
      expect.objectContaining({ code: "BAD_POSITION", severity: "error" }),
    ]);
    await expect(commitImport(auth, preview.importId, null)).rejects.toThrow(
      /BAD_POSITION/,
    );

    const fixed = bad.replace("striker", GK);
    const preview2 = await createImport(auth, csvUpload(fixed));
    expect(preview2.plan.issues).toEqual([]);
    const result = await commitImport(auth, preview2.importId, null);
    expect(result.stats.rosters).toBe(1);
  });

  it("unknown division stays an error through the API surface", async () => {
    const { auth } = await seedOrg();
    await seedDivision(auth);
    const preview = await createImport(
      auth,
      csvUpload("Team,Division\nGhosts,not-a-division"),
    );
    expect(preview.plan.issues).toEqual([
      expect.objectContaining({
        code: "DIVISION_NOT_FOUND",
        severity: "error",
      }),
    ]);
  });

  it("Community org is blocked at row 51 with a 402 carrying import.bulk", async () => {
    const { auth } = await seedOrg("community");
    await seedDivision(auth);
    const rows = Array.from({ length: 51 }, (_, i) => `Team ${i}`);
    const csv = ["Team", ...rows].join("\n");
    await expect(createImport(auth, csvUpload(csv))).rejects.toThrow(
      PaymentRequiredError,
    );
    await expect(createImport(auth, csvUpload(csv))).rejects.toMatchObject({
      featureKey: "import.bulk",
    });
    // 50 rows fit (V319 raised import.bulk 20 → 50), but clubs stay Pro-only at commit
    const under = await createImport(
      auth,
      csvUpload(["Team", ...rows.slice(0, 50)].join("\n")),
    );
    expect(under.rowCount).toBe(50);
  });

  it("Community commit with club columns succeeds under the clubs cap (hierarchy opened, V292)", async () => {
    const { auth } = await seedOrg("community");
    await seedDivision(auth);
    const preview = await createImport(
      auth,
      csvUpload("Club,Team,Division\nAcme SC,Acme U12,u12"),
    );
    // clubs.hierarchy is granted to community/event_pass (V292); the cap is the
    // brake now, and 1 club/1 team is under the community 5/8 limits (V319).
    const result = await commitImport(auth, preview.importId, null);
    expect(result.stats.clubs).toBe(1);
    const clubs = await listClubs(auth);
    expect(clubs.map((c) => c.name)).toEqual(["Acme SC"]);
  });

  /**
   * The cap sweep: which key refuses, across sizes, and in what ORDER.
   *
   * Every other cap test in this file sits on ONE boundary: one cap, one
   * sample. A single sample cannot see a precedence bug — when two caps bind
   * at once, only the ORDER of the gates decides which key the organiser is
   * shown, and that order is load-bearing product behaviour (an organiser told
   * "clubs" buys clubs; told "rows" they split the file).
   *
   * No cap VALUES appear in this comment on purpose. `imports.ts` carries a
   * note recording that a hand-typed cap in a comment ("Community capped at 20
   * rows/file") outlived the fact and was later quoted back as truth; V319 is
   * the authority, and every number below is read from the catalog at run time.
   *
   * `commitImport` gates in this order:
   *   the `assertWithinLimit(bulkCap, …)` gate, before anything is planned
   *     -> the `clubs.hierarchy` gate
   *     -> the `plannedClubs` gate
   *     -> the `plannedTeams` gate
   *
   * These rows pin TWO of those orderings: bulk before clubs (F), and clubs
   * before teams (E). `clubs.hierarchy` is named for POSITION only and is
   * exercised by no row, because no plan denies it — every plan carries it
   * true, so that gate is currently unreachable through the product and only
   * an entitlement override could bind it.
   *
   * Caps are READ from the live catalog rather than typed, so a re-valuation
   * moves these tests with it instead of leaving them asserting yesterday's
   * numbers. Row A is the control: without a case that COMMITS, an
   * all-refusing mutant satisfies every other row.
   *
   * One `it()` per row, so a red in one row cannot hide the other five.
   */
  describe("the cap sweep: which key refuses at each size, and which wins when two bind", () => {
    let clubCap: number;
    let teamCap: number;
    let bulkCap: number;

    beforeAll(async () => {
      const { auth } = await seedOrg("community");
      const clubs = await getLimit(auth.orgId, "clubs.max");
      const teams = await getLimit(auth.orgId, "teams.max");
      const bulk = await getLimit(auth.orgId, "import.bulk");
      // Derived, not assumed: a null (unlimited) cap would make every row
      // below vacuous, and the sweep would pass by refusing nothing.
      expect(
        clubs,
        "community clubs.max is unlimited — the sweep cannot bind",
      ).not.toBeNull();
      expect(
        teams,
        "community teams.max is unlimited — the sweep cannot bind",
      ).not.toBeNull();
      expect(
        bulk,
        "community import.bulk is unlimited — the sweep cannot bind",
      ).not.toBeNull();
      clubCap = clubs!;
      teamCap = teams!;
      bulkCap = bulk!;
    });

    /** Seed `n` existing clubs so the NEXT import crosses `clubs.max`. */
    const fillClubs = async (orgId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await sql`insert into clubs (org_id, name) values (${orgId}, ${`Fill C${i} ${randomUUID().slice(0, 6)}`})`;
      }
    };
    const fillTeams = async (orgId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await sql`insert into teams (org_id, name) values (${orgId}, ${`Fill T${i} ${randomUUID().slice(0, 6)}`})`;
      }
    };
    /** One club + one team per row, so club count == team count == row count. */
    const clubCsv = (n: number, prefix: string) =>
      [
        "Club,Team",
        ...Array.from(
          { length: n },
          (_, i) => `${prefix} C${i},${prefix} T${i}`,
        ),
      ].join("\n");

    it("A. under every cap: it COMMITS (the control)", async () => {
      const { auth: a } = await seedOrg("community");
      await seedDivision(a);
      const preview = await createImport(a, csvUpload(clubCsv(1, "A")));
      const result = await commitImport(a, preview.importId, null);
      expect(result.stats.clubs, "a file under every cap must commit").toBe(1);
    });

    it("B. rows over import.bulk: refused at CREATE, before a plan exists", async () => {
      const { auth: b } = await seedOrg("community");
      await seedDivision(b);
      await expect(
        createImport(b, csvUpload(clubCsv(bulkCap + 1, "B"))),
        "a file over the row cap must be refused at upload",
      ).rejects.toMatchObject({ featureKey: "import.bulk" });
    });

    it("C. clubs over clubs.max, rows fine: clubs.max at COMMIT", async () => {
      const { auth: c } = await seedOrg("community");
      await seedDivision(c);
      await fillClubs(c.orgId, clubCap);
      const preview = await createImport(c, csvUpload(clubCsv(1, "C")));
      await expect(
        commitImport(c, preview.importId, null),
        "clubs alone over their cap must be refused for CLUBS",
      ).rejects.toMatchObject({ featureKey: "clubs.max" });
    });

    // Clubs deliberately left well under their cap, so the ONLY thing this row
    // can be refused for is teams — otherwise it would pass on C's answer.
    it("D. teams over teams.max, clubs fine: teams.max at COMMIT", async () => {
      const { auth: d } = await seedOrg("community");
      await seedDivision(d);
      await fillTeams(d.orgId, teamCap);
      const preview = await createImport(d, csvUpload(clubCsv(1, "D")));
      await expect(
        commitImport(d, preview.importId, null),
        "teams alone over their cap must be refused for TEAMS",
      ).rejects.toMatchObject({ featureKey: "teams.max" });
    });

    // The order-differential case. Swap the `plannedClubs` and `plannedTeams`
    // gates and this row reports teams.max while C and D both stay green —
    // exactly the bug a one-sample-per-cap suite cannot see.
    it("E. BOTH clubs and teams over: clubs.max wins, it is gated first", async () => {
      const { auth: e } = await seedOrg("community");
      await seedDivision(e);
      await fillClubs(e.orgId, clubCap);
      await fillTeams(e.orgId, teamCap);
      const preview = await createImport(e, csvUpload(clubCsv(1, "E")));
      await expect(
        commitImport(e, preview.importId, null),
        "with both caps breached the organiser must be told CLUBS — clubs.max is gated first",
      ).rejects.toMatchObject({ featureKey: "clubs.max" });
    });

    // Reached only by planning under a bigger allowance and lapsing, since the
    // row cap would otherwise refuse at upload. Pins that the row gate sits
    // ahead of the club gate: the file is refused for its SIZE before anything
    // is planned, so the organiser is told to split rather than to buy clubs.
    it("F. rows AND clubs both over at commit: import.bulk wins", async () => {
      const { auth: f } = await seedOrg("pro");
      await seedDivision(f);
      const preview = await createImport(
        f,
        csvUpload(clubCsv(bulkCap + 1, "F")),
      );
      await fillClubs(f.orgId, clubCap);
      await setOrgPlan(f.orgId, "community");
      await invalidateOrgEntitlements(f.orgId);
      await expect(
        commitImport(f, preview.importId, null),
        "with rows and clubs both over, the refusal must name the row cap — it is gated first",
      ).rejects.toMatchObject({ featureKey: "import.bulk" });
    });
  });

  it("a plan made under a bigger allowance is re-gated on import.bulk at COMMIT", async () => {
    // `imports` rows carry only planned/committed and have no expiry, so a plan
    // built while the org could afford it stays committable indefinitely. The
    // client cannot be the control here: a second tab, a bfcache restore, or a
    // single request carrying the importId bypasses it entirely.
    const { auth } = await seedOrg("pro");
    await seedDivision(auth);
    const rows = Array.from({ length: 51 }, (_, i) => `Team ${i}`);
    const preview = await createImport(
      auth,
      csvUpload(["Team", ...rows].join("\n")),
    );
    // Accepted on Pro: `import.bulk` is dual-valued and Pro's row carries a null
    // int_value, which `getLimit` resolves to null = unlimited.
    expect(preview.rowCount).toBe(51);

    // ...and then the subscription lapses, between plan and commit.
    await setOrgPlan(auth.orgId, "community");
    await invalidateOrgEntitlements(auth.orgId);

    // `import.bulk`, NOT `teams.max`. That distinction is the whole test: 51
    // team rows also breach community's teams.max of 8, so without the
    // commit-time row gate this commit still fails — just later, for a
    // different reason, after the plan has been built. Asserting the KEY pins
    // that the file is refused for its SIZE, before anything is planned.
    await expect(
      commitImport(auth, preview.importId, null),
    ).rejects.toMatchObject({
      featureKey: "import.bulk",
    });

    // Refused before a single write.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from teams where org_id = ${auth.orgId}`;
    expect(n).toBe(0);
  });

  it("Community import over clubs.max is rejected with featureKey clubs.max at commit", async () => {
    const { auth } = await seedOrg("community");
    await seedDivision(auth);
    // seed the org at the community clubs cap (5 clubs, V319)
    await sql`insert into clubs (org_id, name) values
      (${auth.orgId}, 'Existing One'), (${auth.orgId}, 'Existing Two'),
      (${auth.orgId}, 'Existing Three'), (${auth.orgId}, 'Existing Four'),
      (${auth.orgId}, 'Existing Five')`;
    const preview = await createImport(auth, csvUpload("Club\nDelta SC"));
    expect(preview.plan.issues).toEqual([]);
    expect(preview.plan.stats.clubs).toBe(1);
    await expect(
      commitImport(auth, preview.importId, null),
    ).rejects.toMatchObject({
      featureKey: "clubs.max",
    });
    // rejected before any write — still exactly 5 clubs
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from clubs where org_id = ${auth.orgId}`;
    expect(n).toBe(5);
  });

  it("Community import over teams.max is rejected with featureKey teams.max at commit", async () => {
    const { auth } = await seedOrg("community");
    await seedDivision(auth);
    // seed the org at the community teams cap (8 teams, V319)
    await sql`insert into teams (org_id, name) values
      (${auth.orgId}, 'Team One'), (${auth.orgId}, 'Team Two'),
      (${auth.orgId}, 'Team Three'), (${auth.orgId}, 'Team Four'),
      (${auth.orgId}, 'Team Five'), (${auth.orgId}, 'Team Six'),
      (${auth.orgId}, 'Team Seven'), (${auth.orgId}, 'Team Eight')`;
    const preview = await createImport(auth, csvUpload("Team\nDelta United"));
    expect(preview.plan.issues).toEqual([]);
    expect(preview.plan.stats.teams).toBe(1);
    await expect(
      commitImport(auth, preview.importId, null),
    ).rejects.toMatchObject({
      featureKey: "teams.max",
    });
  });

  it("parses XLSX to the same plan as CSV (golden workbook)", async () => {
    const { auth } = await seedOrg();
    await seedDivision(auth);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Roster");
    sheet.addRow(["Club", "Team", "Player", "DOB", "Number", "Division"]);
    sheet.addRow([
      "Acme SC",
      "Acme U12",
      "Ada One",
      new Date(Date.UTC(2014, 0, 1)),
      1,
      "u12",
    ]);
    sheet.addRow(["Acme SC", "Acme U12", "Bo Two", "2014-01-02", 2, "u12"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const preview = await createImport(auth, {
      filename: "roster.xlsx",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
    });
    expect(preview.plan.issues).toEqual([]);
    expect(preview.plan.stats).toEqual({
      clubs: 1,
      teams: 1,
      persons: 2,
      entrants: 1,
      rosters: 2,
    });
    const person = preview.plan.ops.find((o) => o.kind === "person.create");
    expect(person).toMatchObject({ after: { dob: "2014-01-01" } });
  });

  it("club badge cascades to teams via team_display_v; export keeps club column + empty-spot rows", async () => {
    const { auth } = await seedOrg();
    await seedDivision(auth);
    const csv = [
      "Club,Team,Player,DOB,Division",
      "Acme SC,Acme U12,Ada One,2014-01-01,u12",
      "Acme SC,Acme Empty,,,u12", // empty-spot team: no players
    ].join("\n");
    const preview = await createImport(auth, csvUpload(csv));
    expect(preview.plan.issues).toEqual([]);
    await commitImport(auth, preview.importId, null);

    // badge upload once per club → every child team resolves it (Jul3/01 §2)
    await sql`update clubs set logo_path = 'orgs/x/clubs/badge.png'
              where org_id = ${auth.orgId} and name = 'Acme SC'`;
    const displays = await sql<{ name: string; logo_path: string | null }[]>`
      select name, logo_path from team_display_v
      where org_id = ${auth.orgId} order by name`;
    expect(displays).toEqual([
      { name: "Acme Empty", logo_path: "orgs/x/clubs/badge.png" },
      { name: "Acme U12", logo_path: "orgs/x/clubs/badge.png" },
    ]);

    // export: club column present, the playerless entrant still gets a row
    const rows = await participantRows(auth, {});
    expect(rows).toEqual([
      expect.objectContaining({
        club: "Acme SC",
        team: "Acme Empty",
        player: "",
      }),
      expect.objectContaining({
        club: "Acme SC",
        team: "Acme U12",
        player: "Ada One",
      }),
    ]);
  });

  it("re-previews a stored import against current state", async () => {
    const { auth } = await seedOrg();
    await seedDivision(auth);
    const preview = await createImport(
      auth,
      csvUpload("Team,Division\nGhosts,u12"),
    );
    expect(preview.plan.stats.teams).toBe(1);
    await commitImport(auth, preview.importId, null);
    // a fresh upload of the same content now diffs to nothing
    const preview2 = await createImport(
      auth,
      csvUpload("Team,Division\nGhosts,u12"),
    );
    const re = await getImport(auth, preview2.importId);
    expect(re.plan.ops).toEqual([]);
  });
});
