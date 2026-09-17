// Privacy hotfix (2026-09-16) — the division's youth / name-display policy is
// the ONE name authority, and two public readers in this file ignored it:
//
//  - `getPublicPlayer` read `public_players_v.name` (= `persons.full_name`,
//    V350) gated only by public-name consent. RS007 grants that consent by
//    default, so a youth player's FULL name reached the card's h1, <title> and
//    meta description, and their photo reached the card when photo consent
//    was given. The division page masks the same person ("Arun K.") and linked
//    straight to that card.
//  - `readPublicLineups` decided `masked` as `name !== full_name`. A ONE-WORD
//    name masks to itself, so a one-word youth (or opted-out) player read as
//    unmasked, and the match centre publishes an unmasked person's REAL id
//    (a masked one gets a surrogate — `makePersonOf`).
//  - `maskPublicEntrantNames`, when its fresh roster read and the view's
//    `members` array disagreed in length (a roster edit landing between the
//    two reads), kept the VIEW's member names — `public_person_name()`, which
//    has no youth axis at all.
//
// DB-backed against the real readers; `unstable_cache` is a pass-through.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { sql } from "@/lib/db";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { readPublicLineups } from "@/server/public-site/public-lineups";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import {
  getPublicPlayer,
  maskPublicEntrantNames,
  type PublicEntrant,
} from "@/server/public-site/data";
import {
  closeSql,
  OPEN_FULL,
  seedYouthNameScene,
  YOUTH_FULL,
  YOUTH_MASKED,
  type YouthNameScene,
} from "./_youth-name-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await closeSql();
});

describe.skipIf(!HAS_DB)("getPublicPlayer — the card applies the division name policy", () => {
  let s: YouthNameScene;
  beforeAll(async () => {
    s = await seedYouthNameScene();
  });

  it("youth division: the card's name is the masked name, its photo is withheld, and the full name is nowhere in the payload", async () => {
    const data = await getPublicPlayer(s.orgSlug, s.compSlug, s.youth.personId);
    expect(data, "precondition: the consented youth player has a card").not.toBeNull();
    expect(data!.player.name).toBe(YOUTH_MASKED);
    expect(data!.player.photo).toBeNull();
    // The membership line names the player's own INDIVIDUAL entrant, whose
    // display name is the player's full name — the h1 alone is not enough.
    expect(data!.memberships.map((m) => m.entrant_name)).toEqual([YOUTH_MASKED]);
    expect(JSON.stringify(data)).not.toContain("Kumar");
    expect(JSON.stringify(data)).not.toContain(s.youth.photo);
  });

  it("open division (positive pair): the card keeps the full name, the consented photo and the full entrant name", async () => {
    const data = await getPublicPlayer(s.orgSlug, s.compSlug, s.open.personId);
    expect(data).not.toBeNull();
    expect(data!.player.name).toBe(OPEN_FULL);
    expect(data!.player.photo).toBe(s.open.photo);
    expect(data!.memberships.map((m) => m.entrant_name)).toEqual([OPEN_FULL]);
  });

  it("a youth player's card reached under ANOTHER competition of the org (no roster there) is masked too", async () => {
    // A person id is not a secret — lineups and other public documents carry
    // it — and the card resolves the person by org, not by competition. The
    // policy therefore has to follow the PERSON's rosters, not the URL's
    // competition, or any sibling competition's URL shows the full name.
    const data = await getPublicPlayer(s.orgSlug, s.otherCompSlug, s.youth.personId);
    expect(data, "precondition: the card resolves under the sibling competition").not.toBeNull();
    expect(data!.memberships).toEqual([]);
    expect(data!.player.name).toBe(YOUTH_MASKED);
    expect(data!.player.photo).toBeNull();
  });

  it("a youth player ALSO rostered in an open division: the strictest policy wins, for the card and for every membership line", async () => {
    const t = await seedYouthNameScene();
    // Arun gets a second, individual entrant in the OPEN division of the same
    // competition. The open division's own policy is "full"; the youth one is
    // not. One roster asking to mask is enough.
    const [{ id: entrantId }] = await sql<{ id: string }[]>`
      insert into entrants (division_id, org_id, kind, display_name, seed)
      values (${t.open.divisionId}, ${t.orgId}, 'individual', ${YOUTH_FULL}, 2)
      returning id`;
    await sql`
      insert into entrant_members (entrant_id, person_id, org_id)
      values (${entrantId}, ${t.youth.personId}, ${t.orgId})`;

    const data = await getPublicPlayer(t.orgSlug, t.compSlug, t.youth.personId);
    expect(data).not.toBeNull();
    expect(data!.memberships, "precondition: both memberships are listed").toHaveLength(2);
    expect(data!.player.name).toBe(YOUTH_MASKED);
    expect(data!.player.photo).toBeNull();
    expect(data!.memberships.map((m) => m.entrant_name)).toEqual([YOUTH_MASKED, YOUTH_MASKED]);
    expect(JSON.stringify(data)).not.toContain("Kumar");
  });

  it("open player under the sibling competition (positive pair): still the full name", async () => {
    const data = await getPublicPlayer(s.orgSlug, s.otherCompSlug, s.open.personId);
    expect(data).not.toBeNull();
    expect(data!.player.name).toBe(OPEN_FULL);
    expect(data!.player.photo).toBe(s.open.photo);
  });
});

describe.skipIf(!HAS_DB)("maskPublicEntrantNames — a roster that moved between the two reads", () => {
  /** The view row as `getPublicDivision` reads it, then a member added to the
   *  same entrant BEFORE the mask runs — the race that makes the view's
   *  `members` and the fresh roster read disagree in length. */
  async function raceRows(s: YouthNameScene, divisionId: string, entrantId: string): Promise<PublicEntrant[]> {
    const raw = await sql<PublicEntrant[]>`
      select id, division_id, kind, display_name, seed, status, members, team_display, badge_url
      from public_entrants_v where division_id = ${divisionId}`;
    expect(raw[0]!.members, "precondition: the view read one member").toHaveLength(1);
    const [{ id: late }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${s.orgId}, 'Late Arrival', ${sql.json({ public_name: true })})
      returning id`;
    await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantId}, ${late}, ${s.orgId})`;
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from entrant_members where entrant_id = ${entrantId}`;
    expect(n, "precondition: the fresh roster now disagrees with the view read").toBe(2);
    return raw;
  }

  it("youth division: every member falls back to the policy mask and loses its person_id and photo — never the view's full name", async () => {
    const s = await seedYouthNameScene();
    const raw = await raceRows(s, s.youth.divisionId, s.youth.entrantId);
    expect(raw[0]!.members[0]!.name, "precondition: the view itself carries the full name").toBe(YOUTH_FULL);

    const [out] = await maskPublicEntrantNames(raw, { youth: true, player_name_display: null });
    expect(out!.members.map((m) => m.name)).toEqual([YOUTH_MASKED]);
    expect(out!.members[0]!.person_id).toBeNull();
    expect(out!.members[0]!.photo).toBeNull();
    expect(JSON.stringify(out)).not.toContain("Kumar");
  });

  it("open division (positive pair): the fallback keeps the view's consented full name, person_id and photo", async () => {
    const s = await seedYouthNameScene();
    const raw = await raceRows(s, s.open.divisionId, s.open.entrantId);

    const [out] = await maskPublicEntrantNames(raw, { youth: false, player_name_display: null });
    expect(out!.members.map((m) => m.name)).toEqual([OPEN_FULL]);
    expect(out!.members[0]!.person_id).toBe(s.open.personId);
    expect(out!.members[0]!.photo).toBe(s.open.photo);
  });
});

describe.skipIf(!HAS_DB)("readPublicLineups — `masked` is the policy's decision, not a string comparison", () => {
  let fixtureId: string;
  let entrantId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const s = await seedYouthNameScene();
    const comp = await createCompetition(s.auth, {
      ends_on: "2030-12-31",
      name: "Lineups Cup " + s.orgSlug,
      visibility: "public",
      branding: {},
    });
    const division = await createDivision(s.auth, comp.id, {
      name: "Lineups",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    // One-word names mask to THEMSELVES ("Arun" -> "Arun"), which is exactly
    // what a string comparison cannot see.
    for (const [key, fullName, consent] of [
      ["arun", "Arun", { public_name: true }],
      ["cher", "Cher", { public_name: false }],
      ["dev", OPEN_FULL, { public_name: true }],
    ] as const) {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name, consent) values (${s.orgId}, ${fullName}, ${sql.json(consent)})
        returning id`;
      ids[key] = id;
    }
    const [home] = await createEntrants(s.auth, division.id, [
      {
        kind: "team",
        display_name: "Home Side",
        seed: 1,
        members: Object.values(ids).map((person_id, i) => ({
          person_id,
          squad_number: i + 1,
          default_position_key: null,
          is_captain: i === 0,
          roles: [],
        })),
      },
      { kind: "team", display_name: "Away Side", seed: 2, members: [] },
    ]);
    entrantId = home!.id;
    const [stage] = await createStages(s.auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(s.auth, stage!.id);
    fixtureId = fixtures[0]!.id;
    let order = 1;
    for (const personId of Object.values(ids)) {
      await sql`
        insert into lineups (fixture_id, entrant_id, person_id, slot, position_key, order_no, roles, role, pair_order)
        values (${fixtureId}, ${entrantId}, ${personId}, 'starting', null, ${order++}, ${sql.json([])}, 'player', null)`;
    }
  });

  const flags = async (division: { youth: boolean; player_name_display: string | null }) => {
    const lineups = await readPublicLineups(sql, fixtureId, division);
    const byId = new Map((lineups[entrantId] ?? []).map((p) => [p.personId, p]));
    expect(byId.size, "precondition: all three lineup rows read").toBe(3);
    return (key: string) => byId.get(ids[key]!)!;
  };

  it("youth division: a consented ONE-WORD name is flagged masked (the flag `makePersonOf` surrogates the id on)", async () => {
    const person = await flags({ youth: true, player_name_display: null });
    expect(person("arun").name).toBe("Arun");
    expect(person("arun").masked).toBe(true);
    expect(person("dev").masked).toBe(true);
    expect(person("dev").name).toBe("Dev P.");
  });

  it("open division: an explicitly opted-out ONE-WORD name is masked", async () => {
    const person = await flags({ youth: false, player_name_display: null });
    expect(person("cher").masked).toBe(true);
  });

  it("open division (positive pair): consented names — one word or two — stay unmasked under their full name", async () => {
    const person = await flags({ youth: false, player_name_display: null });
    expect(person("arun")).toMatchObject({ name: "Arun", masked: false });
    expect(person("dev")).toMatchObject({ name: OPEN_FULL, masked: false });
  });
});

describe.skipIf(!HAS_DB)("competition hub leader boards — a masked row carries a stand-in id, never the person's real one", () => {
  let s: YouthNameScene;
  let quinnId: string;

  /** `readLeaderRows` READS `player_stat_snapshots` and never recomputes, so a
   *  snapshot row is the real input to the board, not a shortcut past it. */
  const snapshot = (divisionId: string, personId: string, points: number) => sql`
    insert into player_stat_snapshots (division_id, person_id, sport_key, stats, computed_through_seq)
    values (${divisionId}, ${personId}, 'generic', ${sql.json({ points })}, 1)`;

  beforeAll(async () => {
    s = await seedYouthNameScene();
    // A second consented youth player, so the board has two masked rows —
    // their stand-ins must differ (they are the list's React keys).
    [{ id: quinnId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, consent)
      values (${s.orgId}, 'Quinn Cole', ${sql.json({ public_name: true })})
      returning id`;
    await createEntrants(s.auth, s.youth.divisionId, [
      {
        kind: "individual",
        display_name: "Quinn Cole",
        seed: 2,
        members: [{ person_id: quinnId, squad_number: 9, default_position_key: null, is_captain: true, roles: [] }],
      },
    ]);
    await snapshot(s.youth.divisionId, s.youth.personId, 5);
    await snapshot(s.youth.divisionId, quinnId, 3);
    await snapshot(s.open.divisionId, s.open.personId, 4);
  });

  const boardsFor = async (divisionId: string) => {
    const doc = await loadCompetitionHub(s.orgSlug, s.compSlug);
    expect(doc, "precondition: the hub document loads").not.toBeNull();
    const boards = doc!.leaders.filter((b) => b.divisionId === divisionId);
    expect(boards.length, `precondition: the division has a board — ${JSON.stringify(doc!.leaders)}`).toBeGreaterThan(0);
    return { doc: doc!, rows: boards.flatMap((b) => b.rows) };
  };

  it("youth division: masked rows name no real person id anywhere in the hub document, and two people get two stand-ins", async () => {
    const { doc, rows } = await boardsFor(s.youth.divisionId);
    const points = rows.filter((r) => r.person.name === YOUTH_MASKED || r.person.name === "Quinn C.");
    expect(points.map((r) => r.person.masked)).toEqual([true, true]);
    expect(points.map((r) => r.personHref)).toEqual([null, null]);
    const ids = points.map((r) => r.person.personId);
    expect(new Set(ids).size, `stand-ins: ${JSON.stringify(ids)}`).toBe(2);
    const json = JSON.stringify(doc);
    expect(json, "the youth player's real id is in the hub document").not.toContain(s.youth.personId);
    expect(json, "the second youth player's real id is in the hub document").not.toContain(quinnId);
  });

  it("open division (positive pair): a consented adult keeps their real id and the player-card link", async () => {
    const { rows } = await boardsFor(s.open.divisionId);
    const row = rows.find((r) => r.person.name === OPEN_FULL);
    expect(row, `rows: ${JSON.stringify(rows)}`).toBeDefined();
    expect(row!.person).toEqual({ personId: s.open.personId, name: OPEN_FULL, masked: false });
    expect(row!.personHref).toBe(`/shared/${s.orgSlug}/${s.compSlug}/players/${s.open.personId}`);
  });
});
