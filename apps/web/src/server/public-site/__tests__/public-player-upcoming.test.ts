// Player profile — upcoming matches across the org
// (docs/superpowers/specs/2026-09-23-player-profile-upcoming-matches-design.md,
//  plan docs/superpowers/plans/2026-09-23-player-profile-upcoming-matches.md).
//
// DB-only: seeds ONE scene in beforeAll and asks `readPlayerUpcoming` about it.
// Every exclusion test states its PREMISE first — the fixture exists, has Ada on
// a side, carries the status the test is about — so an absent row is about the
// rule under test, never about a fixture the query could not see anyway.
// Expected strings are derived from the dictionaries and the one masking
// function, never typed as a table.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>) => fn,
  revalidateTag: vi.fn(),
}));

import enPublic from "@/dictionaries/en/public.json";
import enUi from "@/dictionaries/en/ui.json";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { resolveSlotLabel } from "@/lib/slot-label";
import { resolveVenueTz } from "@/lib/tz";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent } from "@/server/engine-db/append-event";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { patchFixture } from "@/server/usecases/fixtures";
import { startDivision } from "@/server/usecases/schedule";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { createCourt, createVenue } from "@/server/usecases/venues";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { getPublicPlayerUpcoming, maskPublicEntrantNames, playerCardNameMask, publicPlayerGate } from "../data";
import { readPlayerUpcoming, UPCOMING_STALE_AFTER_MS, type PlayerUpcomingRow } from "../public-player-matches";

const HAS_DB = !!process.env.DATABASE_URL;
const HOUR = 60 * 60 * 1000;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

type FixtureRow = { id: string; home_entrant_id: string | null; away_entrant_id: string | null };
type Side = { kind: "individual" | "pair"; name: string; members: string[] };
interface League {
  divisionId: string;
  slug: string;
  entrantIds: string[];
  fixtures: FixtureRow[];
}
interface Comp {
  id: string;
  slug: string;
  name: string;
}

interface Scene {
  orgId: string;
  orgSlug: string;
  now: Date;
  ada: string;
  cur: Comp;
  sib: Comp;
  unl: Comp;
  prv: Comp;
  ko: Comp;
  /** Public but still a DRAFT — unlisted until published (owner decision 2026-09-27). */
  drf: Comp;
  slugs: { singles: string; sib: string };
  doublesDivisionId: string;
  pairOpponent: { id: string; raw: string };
  /** A player whose card is name-masked (a youth division), and her youth-division opponent. */
  yara: string;
  yaraOpponent: { id: string; raw: string; divisionId: string };
  f: Record<
    | "di" | "bo" | "cy" | "hal" | "ian" | "jo" | "pair" | "seatNamed" | "seatTbd" | "setup"
    | "withdrawn" | "doneDivision" | "ned" | "archived" | "oli" | "pat" | "oldComp" | "foreign"
    | "koFinal" | "koBye" | "koFlipBye" | "koFlipFinal" | "archivedComp" | "yaraCur" | "yaraSib" | "drf",
    string
  >;
}

let scene: Scene;

const member = (personId: string) => ({
  person_id: personId,
  squad_number: null,
  default_position_key: null,
  is_captain: false,
  roles: [] as string[],
});

async function seedPerson(orgId: string, fullName: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name, dob, gender, consent)
    values (${orgId}, ${fullName}, '2000-04-03', 'f', ${sql.json({ public_name: true })})
    returning id`;
  return id;
}

async function openOrg(label: string): Promise<{ orgId: string; orgSlug: string; auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `pup-${label}-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${`PUP ${label} ${suffix}`}, ${orgSlug}) returning id`;
  await setOrgPlan(orgId);
  // No caps: a create over a cap silently comes back PRIVATE, which would make
  // every visibility test pass for the wrong reason (premise asserted in seed()).
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test'),
           (${orgId}, 'dashboard.public.max', 50, 'test')`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, orgSlug, auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

async function league(
  auth: AuthCtx,
  competitionId: string,
  slug: string,
  sides: Side[],
  start = true,
  kind: "league" | "knockout" = "league",
): Promise<League> {
  const division = await createDivision(auth, competitionId, {
    name: slug,
    slug,
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  const created = (await createEntrants(
    auth,
    division.id,
    sides.map((s, i) => ({ kind: s.kind, display_name: s.name, seed: i + 1, members: s.members.map(member) })) as never,
  )) as { id: string }[];
  const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: slug, config: {} });
  await generateStageFixtures(auth, stage!.id);
  if (start) await startDivision(auth, division.id);
  const [{ slug: stored }] = await sql<{ slug: string }[]>`select slug from divisions where id = ${division.id}`;
  const fixtures = await sql<FixtureRow[]>`
    select id, home_entrant_id, away_entrant_id from fixtures where division_id = ${division.id}`;
  return { divisionId: division.id, slug: stored, entrantIds: created.map((e) => e.id), fixtures };
}

function vs(l: League, a: number, b: number): string {
  const [x, y] = [l.entrantIds[a]!, l.entrantIds[b]!];
  const row = l.fixtures.find(
    (f) => (f.home_entrant_id === x && f.away_entrant_id === y) || (f.home_entrant_id === y && f.away_entrant_id === x),
  );
  if (!row) throw new Error(`seed: no fixture between entrants ${a} and ${b} in ${l.slug}`);
  return row.id;
}

const at = (fixtureId: string, when: Date) =>
  sql`update fixtures set scheduled_at = ${when.toISOString()} where id = ${fixtureId}`;

/** The real write path: core.start puts a fixture in play; a result decides it. */
async function play(orgId: string, fixtureId: string, finish: boolean): Promise<void> {
  await appendEvent(orgId, fixtureId, 0, { type: "core.start", payload: {}, recordedBy: null });
  if (finish) {
    await appendEvent(orgId, fixtureId, 1, { type: "generic.result", payload: { p1Score: 2, p2Score: 1 }, recordedBy: null });
  }
}

async function seed(): Promise<Scene> {
  const now = new Date();
  const inHours = (h: number) => new Date(now.getTime() + h * HOUR);
  const { orgId, orgSlug, auth } = await openOrg("main");
  await sql`update organizations set timezone = 'Europe/London' where id = ${orgId}`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;

  const ada = await seedPerson(orgId, "Ada Quill");
  const adaSide = (): Side => ({ kind: "individual", name: "Ada Quill", members: [ada] });
  const opponent = async (name: string): Promise<Side> => ({ kind: "individual", name, members: [await seedPerson(orgId, name)] });
  const comp = async (name: string, visibility: "public" | "unlisted" | "private"): Promise<Comp> => {
    const c = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: `${name} ${randomUUID().slice(0, 6)}`,
      visibility,
      branding: {},
    });
    // PUBLISHED: a competition is created as a draft, and a draft is unlisted
    // until published (owner decision 2026-09-27) — so another competition's
    // card would never show it. The org's competitions here are the ones its
    // organiser has published; the draft case is `drf` below.
    await sql`update competitions set status = 'published' where id = ${c.id}`;
    return { id: c.id, slug: c.slug, name: c.name };
  };
  const cur = await comp("Current Cup", "public");
  const sib = await comp("Sibling League", "public");
  const unl = await comp("Unlisted Open", "unlisted");
  const prv = await comp("Private Friendly", "private");
  const old = await comp("Old Cup", "public");
  const landed = await sql<{ id: string; visibility: string }[]>`
    select id, visibility from competitions where id in ${sql([cur.id, sib.id, unl.id, prv.id, old.id])}`;
  const vis = Object.fromEntries(landed.map((r) => [r.id, r.visibility]));
  // Premise: nothing degraded to private under a cap.
  expect([vis[cur.id], vis[sib.id], vis[unl.id], vis[prv.id], vis[old.id]]).toEqual([
    "public", "public", "unlisted", "private", "public",
  ]);

  // ---- The org's venue and courts, made the way the organiser makes them --------
  const hall = await createVenue(auth, { name: "Riverside Hall", sort: 0 });
  const court3 = await createCourt(auth, hall.id, { name: "Court 3", sort: 0, tags: [] });
  const court9 = await createCourt(auth, hall.id, { name: "Court 9", sort: 1, tags: [] });

  // ---- CUR singles: Ada v six opponents, one per rule --------------------------
  const singles = await league(auth, cur.id, "singles", [
    adaSide(),
    ...(await Promise.all(["Bo Birch", "Cy Cole", "Di Dunn", "Hal Hart", "Ian Ives", "Jo Jay"].map(opponent))),
  ]);
  const [bo, cy, di, hal, ian, jo] = [1, 2, 3, 4, 5, 6].map((n) => vs(singles, 0, n)) as [string, string, string, string, string, string];
  await at(bo, inHours(48));
  // P9: a court is assigned by id through the organiser's PATCH /fixtures/{id}
  // (`patchFixture`), which also stamps the court's venue. The legacy
  // `court_label`/`venue` text stays NULL, as it does for every fixture since.
  await patchFixture(auth, bo, { court_id: court3.id });
  // Ada AWAY here. Every other listed row of hers seats her at HOME (measured: a
  // home-only membership mutant survived the suite without this swap), so this
  // is the one row that proves her side is read per fixture.
  await sql`update fixtures set home_entrant_id = ${singles.entrantIds[1]!}, away_entrant_id = ${singles.entrantIds[0]!}
            where id = ${bo}`;
  await at(cy, inHours(24));
  await play(orgId, cy, false); // in_play
  await at(di, inHours(-2)); // inside the 3h grace
  await at(hal, inHours(-4)); // stale
  await at(ian, inHours(30));
  await play(orgId, ian, true); // decided
  await at(jo, inHours(36));
  await sql`update fixtures set status = 'cancelled' where id = ${jo}`;
  await sql`
    insert into schedule_settings (division_id, org_id, tz) values (${singles.divisionId}, ${orgId}, 'America/New_York')
    on conflict (division_id) do update set tz = excluded.tz`;

  // ---- CUR doubles: a PAIR membership, in an ADULT division ---------------------
  // Adult on purpose: a youth (name-masking) division would put Ada's own card
  // under the masked-name policy, which lists the card's competition only
  // (owner ruling 2026-09-23, Yara below). The opponent pair is masked by the
  // CONSENT axis instead: Fiona opted out of public naming.
  const [ed, fi, gus] = [await seedPerson(orgId, "Ed Ennis"), await seedPerson(orgId, "Fiona Grant"), await seedPerson(orgId, "Gus Hale")];
  await sql`update persons set consent = ${sql.json({ public_name: false })} where id = ${fi}`;
  const pairRaw = "Fiona Grant & Gus Hale";
  const doubles = await league(auth, cur.id, "doubles", [
    { kind: "pair", name: "Ada Quill & Ed Ennis", members: [ada, ed] },
    { kind: "pair", name: pairRaw, members: [fi, gus] },
  ]);
  const pair = vs(doubles, 0, 1);
  await at(pair, inHours(72));

  // ---- CUR seats: Ada HOME, the away seat empty — labelled once, bare once -----
  const seats = await league(auth, cur.id, "seats", [adaSide(), await opponent("Lu Lane"), await opponent("Mo Moss")]);
  const seatNamed = vs(seats, 0, 1);
  const seatTbd = vs(seats, 0, 2);
  for (const id of [seatNamed, seatTbd]) {
    await sql`update fixtures set home_entrant_id = ${seats.entrantIds[0]!}, away_entrant_id = null where id = ${id}`;
  }
  await sql`update fixtures set away_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })}
            where id = ${seatNamed}`;
  await at(seatNamed, inHours(144));
  await at(seatTbd, inHours(168));

  // ---- CUR setup: generated, never started — the view withholds time/court ------
  const setupL = await league(auth, cur.id, "setup", [adaSide(), await opponent("Quin Rowe")], false);
  const setup = vs(setupL, 0, 1);
  await at(setup, inHours(12));
  await patchFixture(auth, setup, { court_id: court9.id });

  // ---- CUR withdrawn: Ada's entrant withdrew, the fixture was left scheduled ----
  const wd = await league(auth, cur.id, "withdrawn", [adaSide(), await opponent("Kim Knox")]);
  const withdrawn = vs(wd, 0, 1);
  await at(withdrawn, inHours(20));
  await sql`update entrants set status = 'withdrawn' where id = ${wd.entrantIds[0]!}`;

  // ---- CUR completed division, undated leftover (Review Focus 1) ----------------
  const done = await league(auth, cur.id, "done", [adaSide(), await opponent("Sy Stone")]);
  const doneDivision = vs(done, 0, 1);
  await sql`update divisions set status = 'completed' where id = ${done.divisionId}`;

  // ---- SIB: public sibling, own venue zone; plus an ARCHIVED division ------------
  const sibL = await league(auth, sib.id, "sib-open", [adaSide(), await opponent("Ned North")]);
  const ned = vs(sibL, 0, 1);
  await at(ned, inHours(26));
  // A pre-P9 row: the retired free-text location, and no court/venue ids.
  await sql`update fixtures set court_label = 'Old Court 1', venue = 'Old Pavilion' where id = ${ned}`;
  // A CONFIRMED entrant: every other entrant keeps the 'registered' default.
  await sql`update entrants set status = 'confirmed' where id = ${sibL.entrantIds[0]!}`;
  await sql`
    insert into schedule_settings (division_id, org_id, tz) values (${sibL.divisionId}, ${orgId}, 'Asia/Kolkata')
    on conflict (division_id) do update set tz = excluded.tz`;
  const arch = await league(auth, sib.id, "sib-archived", [adaSide(), await opponent("Tia Todd")]);
  const archived = vs(arch, 0, 1);
  await at(archived, inHours(28));
  await sql`update divisions set archived_at = now() where id = ${arch.divisionId}`;

  // ---- UNL / PRV / OLD ------------------------------------------------------------
  const unlL = await league(auth, unl.id, "unl-open", [adaSide(), await opponent("Oli Otter")]);
  const oli = vs(unlL, 0, 1);
  await at(oli, inHours(1));
  const prvL = await league(auth, prv.id, "prv-open", [adaSide(), await opponent("Pat Pike")]);
  const pat = vs(prvL, 0, 1);
  await at(pat, inHours(1));
  const oldL = await league(auth, old.id, "old-open", [adaSide(), await opponent("Rae Reed")]);
  const oldComp = vs(oldL, 0, 1); // undated leftover
  await sql`update competitions set status = 'completed' where id = ${old.id}`;
  // A PUBLIC competition still in DRAFT, with a dated fixture that would
  // otherwise be upcoming — listed only on its own card (the direct link).
  const drf = await comp("Draft League", "public");
  const drfL = await league(auth, drf.id, "drf-open", [adaSide(), await opponent("Dee Draft")]);
  const drfFixture = vs(drfL, 0, 1);
  await at(drfFixture, inHours(29));
  await sql`update competitions set status = 'draft' where id = ${drf.id}`;
  // An ARCHIVED public competition, with a dated fixture that would otherwise be upcoming.
  const arc = await comp("Archived Cup", "public");
  const arcL = await league(auth, arc.id, "arc-open", [adaSide(), await opponent("Abe Ash")]);
  const archivedComp = vs(arcL, 0, 1);
  await at(archivedComp, inHours(30));
  await sql`update competitions set status = 'archived' where id = ${arc.id}`;

  // ---- YARA: a player whose CARD is name-masked (a youth division in CUR), who
  // also plays in the public sibling competition (an adult division there). The
  // owner's rule: a masked card lists the card's own competition only.
  const yara = await seedPerson(orgId, "Yara Young");
  const yaraSide = (): Side => ({ kind: "individual", name: "Yara Young", members: [yara] });
  const youthL = await league(auth, cur.id, "youth-open", [yaraSide(), await opponent("Zed Quinn")]);
  await sql`update divisions set youth = true where id = ${youthL.divisionId}`;
  const yaraCur = vs(youthL, 0, 1);
  await at(yaraCur, inHours(50));
  const yaraSibL = await league(auth, sib.id, "sib-yara", [yaraSide(), await opponent("Pip Rook")]);
  const yaraSib = vs(yaraSibL, 0, 1);
  await at(yaraSib, inHours(27));

  // ---- KO: a knockout in its OWN unlisted competition, read as that card, so no
  // other card's list moves. Three entrants in a four-draw (match-centre-load-
  // feeder-read.test.ts' shape): Ada, seed 1, draws the bye and goes straight
  // into the final, which waits on the other semi-final.
  const ko = await comp("Knockout Cup", "unlisted");
  const [{ visibility: koVisibility }] = await sql<{ visibility: string }[]>`
    select visibility from competitions where id = ${ko.id}`;
  expect(koVisibility).toBe("unlisted"); // premise: not degraded to private
  const koL = await league(auth, ko.id, "ko", [adaSide(), await opponent("Uma Vale"), await opponent("Vic Wren")], true, "knockout");
  const adaKo = koL.entrantIds[0]!;
  const half = await sql<{ id: string; round_no: number }[]>`
    select id, round_no from fixtures
    where division_id = ${koL.divisionId}
      and ((home_entrant_id = ${adaKo} and away_entrant_id is null)
        or (away_entrant_id = ${adaKo} and home_entrant_id is null))
    order by round_no`;
  const koBye = half.find((r) => r.round_no === 1)?.id;
  const koFinal = half.find((r) => r.round_no > 1)?.id;
  if (!koBye || !koFinal) throw new Error(`seed: no bye line + half-filled final for Ada: ${JSON.stringify(half)}`);
  // The bye line back in its pre-2026-09-17 shape: left scheduled, no outcome.
  await sql`update fixtures set status = 'scheduled', outcome = null where id = ${koBye}`;

  // ---- KO-FLIP: the same draw again, mirrored where the first one cannot reach.
  //  - its bye line with the bye on the HOME seat (Ada away), legacy shape;
  //  - its final with the bye label beside ADA's filled seat (an entrant is never
  //    a bye, whatever label rides beside it — `hubByeSides`), and the waiting
  //    seat's stored label gone, so its name can only come from the FEED EDGES.
  const koFlipL = await league(
    auth, ko.id, "ko-flip", [adaSide(), await opponent("Wes Yale"), await opponent("Xia Zorn")], true, "knockout",
  );
  const adaFlip = koFlipL.entrantIds[0]!;
  const flipHalf = await sql<{ id: string; round_no: number; ada_home: boolean }[]>`
    select id, round_no, home_entrant_id = ${adaFlip} as ada_home from fixtures
    where division_id = ${koFlipL.divisionId}
      and ((home_entrant_id = ${adaFlip} and away_entrant_id is null)
        or (away_entrant_id = ${adaFlip} and home_entrant_id is null))
    order by round_no`;
  const flipBye = flipHalf.find((r) => r.round_no === 1);
  const flipFinal = flipHalf.find((r) => r.round_no > 1);
  if (!flipBye || !flipFinal) throw new Error(`seed: no bye line + half-filled final for Ada: ${JSON.stringify(flipHalf)}`);
  await sql`
    update fixtures set home_entrant_id = away_entrant_id, away_entrant_id = home_entrant_id,
                        home_slot_label = away_slot_label, away_slot_label = home_slot_label,
                        status = 'scheduled', outcome = null
    where id = ${flipBye.id}`;
  const byeLabel = sql.json({ key: "bracket.slot.bye", params: {} });
  if (flipFinal.ada_home) {
    await sql`update fixtures set home_slot_label = ${byeLabel}, away_slot_label = null where id = ${flipFinal.id}`;
  } else {
    await sql`update fixtures set away_slot_label = ${byeLabel}, home_slot_label = null where id = ${flipFinal.id}`;
  }

  // ---- ANOTHER ORG, with Ada on one of its rosters -------------------------------
  const other = await openOrg("other");
  const otherComp = await createCompetition(other.auth, {
    ends_on: "2030-12-31",
    name: `Elsewhere ${randomUUID().slice(0, 6)}`,
    visibility: "public",
    branding: {},
  });
  const foreignL = await league(other.auth, otherComp.id, "foreign", [
    { kind: "individual", name: "Xen Yu", members: [await seedPerson(other.orgId, "Xen Yu")] },
    { kind: "individual", name: "Yul Zed", members: [await seedPerson(other.orgId, "Yul Zed")] },
  ]);
  const foreign = foreignL.fixtures[0]!.id;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${foreignL.entrantIds[0]!}, ${ada}, ${other.orgId})`;
  await at(foreign, inHours(4));

  return {
    orgId,
    orgSlug,
    now,
    ada,
    cur,
    sib,
    unl,
    prv,
    ko,
    drf,
    slugs: { singles: singles.slug, sib: sibL.slug },
    doublesDivisionId: doubles.divisionId,
    pairOpponent: { id: doubles.entrantIds[1]!, raw: pairRaw },
    yara,
    yaraOpponent: { id: youthL.entrantIds[1]!, raw: "Zed Quinn", divisionId: youthL.divisionId },
    f: {
      di, bo, cy, hal, ian, jo, pair, seatNamed, seatTbd, setup, withdrawn, doneDivision, ned, archived, oli, pat, oldComp, foreign,
      koFinal, koBye, koFlipBye: flipBye.id, koFlipFinal: flipFinal.id, archivedComp, yaraCur, yaraSib,
      drf: drfFixture,
    },
  };
}

const read = (current: string, over: { personId?: string; now?: Date } = {}) =>
  readPlayerUpcoming(sql, {
    orgId: scene.orgId,
    orgSlug: scene.orgSlug,
    personId: over.personId ?? scene.ada,
    currentCompetitionId: current,
    locale: "en",
    now: over.now ?? scene.now,
  });
const ids = (rows: PlayerUpcomingRow[]) => rows.map((r) => r.fixtureId);
const byId = (rows: PlayerUpcomingRow[], id: string) => {
  const row = rows.find((r) => r.fixtureId === id);
  if (!row) throw new Error(`row ${id} missing`);
  return row;
};

/** Premise: the fixture exists, has Ada on a side, and carries its status. */
async function premise(fixtureId: string) {
  const [row] = await sql<{ status: string; scheduled_at: Date | null; ada_side: boolean }[]>`
    select f.status, f.scheduled_at,
           exists (select 1 from entrant_members em
                   where em.person_id = ${scene.ada}
                     and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)) as ada_side
    from fixtures f where f.id = ${fixtureId}`;
  if (!row) throw new Error(`premise: fixture ${fixtureId} not found`);
  return row;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 180_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("readPlayerUpcoming against real Postgres", () => {
  it("EMPTY: a person with no fixtures has no upcoming rows", async () => {
    expect(await read(scene.cur.id, { personId: randomUUID() })).toEqual([]);
  });

  it("lists Ada's scheduled fixtures across the org — ONE merged sort, dated ascending, then undated", async () => {
    const f = scene.f;
    // Ned (another competition) sits BETWEEN two of the card's own rows: the
    // list is one sort, not the card's competition first.
    expect(ids(await read(scene.cur.id))).toEqual([f.di, f.ned, f.bo, f.pair, f.seatNamed, f.seatTbd, f.setup]);
  });

  it("flags ONLY the other competition's row, and links every row under its OWN competition's slug", async () => {
    const rows = await read(scene.cur.id);
    expect(rows.filter((r) => r.isOtherCompetition).map((r) => r.fixtureId)).toEqual([scene.f.ned]);
    expect(byId(rows, scene.f.ned)).toMatchObject({
      href: `/shared/${scene.orgSlug}/${scene.sib.slug}/${scene.slugs.sib}/fixtures/${scene.f.ned}`,
      competitionSlug: scene.sib.slug,
      competitionName: scene.sib.name,
      divisionSlug: scene.slugs.sib,
    });
    expect(byId(rows, scene.f.bo)).toMatchObject({
      href: `/shared/${scene.orgSlug}/${scene.cur.slug}/${scene.slugs.singles}/fixtures/${scene.f.bo}`,
      isOtherCompetition: false,
      courtLabel: "Court 3",
      venue: "Riverside Hall",
    });
  });

  it("R2: an UNLISTED sibling never reaches another competition's card", async () => {
    expect(await premise(scene.f.oli)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.oli);
  });

  it("R2: …but its OWN card lists it, beside the org's public rows flagged as other events (the positive pair)", async () => {
    const rows = await read(scene.unl.id);
    expect(byId(rows, scene.f.oli).isOtherCompetition).toBe(false);
    expect(byId(rows, scene.f.bo).isOtherCompetition).toBe(true);
    expect(byId(rows, scene.f.ned).isOtherCompetition).toBe(true);
  });

  it("a DRAFT sibling — public, but not yet published — never reaches another competition's card", async () => {
    expect(await premise(scene.f.drf)).toMatchObject({ status: "scheduled", ada_side: true });
    const [c] = await sql<{ status: string; visibility: string }[]>`
      select status, visibility from competitions where id = ${scene.drf.id}`;
    expect(c, "premise: public, and a draft").toEqual({ status: "draft", visibility: "public" });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.drf);
    expect(ids(await read(scene.unl.id))).not.toContain(scene.f.drf);
  });

  it("…but the draft's OWN card lists it — the direct link — beside the org's listed rows (the positive pair)", async () => {
    const rows = await read(scene.drf.id);
    expect(byId(rows, scene.f.drf).isOtherCompetition).toBe(false);
    expect(byId(rows, scene.f.ned).isOtherCompetition).toBe(true);
  });

  it("R2: a PRIVATE competition never appears, even named as the card's own", async () => {
    expect(await premise(scene.f.pat)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.pat);
    expect(ids(await read(scene.prv.id))).not.toContain(scene.f.pat);
  });

  it("R3: in-play, decided and cancelled fixtures are excluded — only 'scheduled' is upcoming", async () => {
    expect((await premise(scene.f.cy)).status).toBe("in_play");
    expect((await premise(scene.f.ian)).status).toBe("decided");
    expect((await premise(scene.f.jo)).status).toBe("cancelled");
    const got = ids(await read(scene.cur.id));
    for (const id of [scene.f.cy, scene.f.ian, scene.f.jo]) expect(got).not.toContain(id);
  });

  it("staleness: a slot 2h past is still upcoming, one 4h past is not — and the window moves with `now`", async () => {
    expect(UPCOMING_STALE_AFTER_MS).toBe(3 * HOUR); // the spec's value
    const got = ids(await read(scene.cur.id));
    expect(got).toContain(scene.f.di);
    expect(got).not.toContain(scene.f.hal);
    const later = new Date(scene.now.getTime() + 2 * HOUR);
    expect(ids(await read(scene.cur.id, { now: later }))).not.toContain(scene.f.di);
  });

  /** The base row's location columns: the P9 ids, and the frozen text beside them. */
  async function location(fixtureId: string) {
    const [row] = await sql<
      { court_id: string | null; venue_id: string | null; court_label: string | null; venue: string | null }[]
    >`select court_id, venue_id, court_label, venue from fixtures where id = ${fixtureId}`;
    if (!row) throw new Error(`fixture ${fixtureId} not found`);
    return row;
  }

  it("court and venue are the NAMES behind the fixture's court_id / venue_id (P9), never the frozen text columns", async () => {
    // Premise: the organiser's PATCH set the ids (the court's venue with it) and
    // left the retired text columns empty.
    const [court] = await sql<{ id: string; name: string; venue_id: string; venue_name: string }[]>`
      select c.id, c.name, c.venue_id, v.name as venue_name
      from courts c join venues v on v.id = c.venue_id
      where c.id = (select court_id from fixtures where id = ${scene.f.bo})`;
    expect(court, "premise: bo has a court").toBeDefined();
    expect(await location(scene.f.bo)).toEqual({
      court_id: court!.id,
      venue_id: court!.venue_id,
      court_label: null,
      venue: null,
    });
    const rows = await read(scene.cur.id);
    expect(byId(rows, scene.f.bo)).toMatchObject({ courtLabel: court!.name, venue: court!.venue_name });
    // A pre-P9 row: frozen text, no ids. Every public surface shows nothing for
    // it (the hub, the match centre, the calendar), so the card does not either.
    expect(await location(scene.f.ned)).toMatchObject({ court_id: null, venue_id: null, court_label: "Old Court 1", venue: "Old Pavilion" });
    expect(byId(rows, scene.f.ned)).toMatchObject({ courtLabel: null, venue: null });
  });

  it("a division still in SETUP: time and court withheld, and the row sorts after every dated one", async () => {
    const p = await premise(scene.f.setup);
    expect(p.scheduled_at).not.toBeNull(); // the BASE row is dated; the view withholds it
    // …and has a real court (and so a venue), withheld the same way.
    const where = await location(scene.f.setup);
    expect(where.court_id).not.toBeNull();
    expect(where.venue_id).not.toBeNull();
    const rows = await read(scene.cur.id);
    expect(byId(rows, scene.f.setup)).toMatchObject({ scheduledAt: null, courtLabel: null, venue: null });
    expect(rows.at(-1)!.fixtureId).toBe(scene.f.setup);
    // Its base time (+12h) is EARLIER than Bo's (+48h): last place is NULLS LAST, not its time.
    expect(p.scheduled_at!.getTime()).toBeLessThan(Date.parse(byId(rows, scene.f.bo).scheduledAt!));
  });

  it("membership: a WITHDRAWN entrant's fixture is gone", async () => {
    expect(await premise(scene.f.withdrawn)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.withdrawn);
  });

  it("membership reads EACH fixture's side: Ada AWAY is found and faces the home side; a CONFIRMED entrant counts like a registered one", async () => {
    // Premises: the only away seat and the only confirmed entrant in the scene.
    const [bo] = await sql<{ ada_away: boolean }[]>`
      select exists (select 1 from entrant_members em
                     where em.person_id = ${scene.ada} and em.entrant_id = f.away_entrant_id) as ada_away
      from fixtures f where f.id = ${scene.f.bo}`;
    expect(bo!.ada_away).toBe(true);
    const [ned] = await sql<{ status: string }[]>`
      select e.status from fixtures f
      join entrant_members em on em.entrant_id in (f.home_entrant_id, f.away_entrant_id)
      join entrants e on e.id = em.entrant_id
      where f.id = ${scene.f.ned} and em.person_id = ${scene.ada}`;
    expect(ned!.status).toBe("confirmed");
    const rows = await read(scene.cur.id);
    expect(byId(rows, scene.f.bo).opponentLabel).toBe("Bo Birch");
    expect(ids(rows)).toContain(scene.f.ned);
  });

  it("R1: another org's fixture never appears, even with Ada on its roster", async () => {
    expect(await premise(scene.f.foreign)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(ids(await read(scene.cur.id))).not.toContain(scene.f.foreign);
  });

  it("a NAME-MASKED card (the card's own youth rule) lists its own competition only; an adult card is unchanged", async () => {
    // Premises: Yara has a dated, scheduled fixture in CUR and another in the
    // PUBLIC sibling, and the card's own decision masks her (a youth division).
    const where = await sql<{ id: string; status: string; competition_id: string; visibility: string; mine: boolean }[]>`
      select f.id, f.status, c.id as competition_id, c.visibility,
             exists (select 1 from entrant_members em
                     where em.person_id = ${scene.yara}
                       and em.entrant_id in (f.home_entrant_id, f.away_entrant_id)) as mine
      from fixtures f join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
      where f.id in ${sql([scene.f.yaraCur, scene.f.yaraSib])}`;
    const cur = where.find((r) => r.id === scene.f.yaraCur)!;
    const sib = where.find((r) => r.id === scene.f.yaraSib)!;
    expect(cur).toMatchObject({ status: "scheduled", competition_id: scene.cur.id, mine: true });
    expect(sib).toMatchObject({ status: "scheduled", competition_id: scene.sib.id, visibility: "public", mine: true });
    expect(await playerCardNameMask(scene.yara, scene.orgId), "premise: Yara's card is masked").not.toBeNull();
    expect(await playerCardNameMask(scene.ada, scene.orgId), "premise: Ada's card is not").toBeNull();

    // From CUR's card: CUR's row only.
    expect(ids(await read(scene.cur.id, { personId: scene.yara }))).toEqual([scene.f.yaraCur]);
    // From SIB's card: SIB's row only — the rule follows the CARD, not a fixed competition.
    expect(ids(await read(scene.sib.id, { personId: scene.yara }))).toEqual([scene.f.yaraSib]);
    // Her opponent in the youth division reads masked, as on the division page.
    const [youthPolicy] = await sql<{ youth: boolean; player_name_display: string | null }[]>`
      select youth, player_name_display from divisions where id = ${scene.yaraOpponent.divisionId}`;
    const [zed] = await maskPublicEntrantNames(
      [{ id: scene.yaraOpponent.id, kind: "individual", display_name: scene.yaraOpponent.raw }],
      youthPolicy!,
    );
    expect(zed!.display_name, "premise: the youth policy changes the name").not.toBe(scene.yaraOpponent.raw);
    expect(byId(await read(scene.cur.id, { personId: scene.yara }), scene.f.yaraCur).opponentLabel).toBe(zed!.display_name);

    // Adult control: Ada's card on CUR still lists SIB's public row.
    const ada = await read(scene.cur.id);
    expect(byId(ada, scene.f.ned)).toMatchObject({ isOtherCompetition: true });
  });

  it("finished and archived places are not upcoming: an archived division, a completed division, a completed competition, an ARCHIVED public competition", async () => {
    const gone = [scene.f.archived, scene.f.doneDivision, scene.f.oldComp, scene.f.archivedComp];
    const [arc] = await sql<{ status: string; visibility: string; scheduled_at: Date | null }[]>`
      select c.status, c.visibility, f.scheduled_at from fixtures f
      join divisions d on d.id = f.division_id join competitions c on c.id = d.competition_id
      where f.id = ${scene.f.archivedComp}`;
    // Premise: public, archived, and dated in the window — only its status keeps it out.
    expect(arc).toMatchObject({ status: "archived", visibility: "public" });
    expect(arc!.scheduled_at!.getTime()).toBeGreaterThan(scene.now.getTime());
    for (const id of gone) expect(await premise(id), id).toMatchObject({ status: "scheduled", ada_side: true });
    const got = ids(await read(scene.cur.id));
    for (const id of gone) expect(got, id).not.toContain(id);
  });

  it("opponent: the masked entrant name, else the seat's public label, else the localised TBD", async () => {
    const rows = await read(scene.cur.id);
    expect(byId(rows, scene.f.bo).opponentLabel).toBe("Bo Birch");
    // The pair's division is ADULT; a member's opted-out consent is what masks it.
    const [policy] = await sql<{ youth: boolean; player_name_display: string | null }[]>`
      select youth, player_name_display from divisions where id = ${scene.doublesDivisionId}`;
    expect(policy!.youth, "premise: an adult division").toBe(false);
    const [masked] = await maskPublicEntrantNames(
      [{ id: scene.pairOpponent.id, kind: "pair", display_name: scene.pairOpponent.raw }],
      policy!,
    );
    expect(masked!.display_name, "premise: a member's consent changes the name").not.toBe(scene.pairOpponent.raw);
    expect(byId(rows, scene.f.pair).opponentLabel).toBe(masked!.display_name);
    expect(byId(rows, scene.f.seatNamed).opponentLabel).toBe(enUi["slot.winner_group"].replace("{g}", "A"));
    expect(byId(rows, scene.f.seatTbd).opponentLabel).toBe(enUi["schedule.tbd"]);
  });

  /** A fixture's two seats as stored, and the empty seat's label. */
  async function seats(fixtureId: string) {
    const [row] = await sql<
      {
        outcome: unknown;
        home_entrant_id: string | null;
        away_entrant_id: string | null;
        home_slot_label: SlotLabel | null;
        away_slot_label: SlotLabel | null;
      }[]
    >`select outcome, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label from fixtures where id = ${fixtureId}`;
    if (!row) throw new Error(`fixture ${fixtureId} not found`);
    return { ...row, empty: row.home_entrant_id === null ? row.home_slot_label : row.away_slot_label };
  }

  it("opponent, KNOCKOUT: a seat waiting on a match names that match's ROUND (the match centre's namer), never the board's R·code", async () => {
    // Premise: the final is scheduled, Ada holds one seat, and the other waits on
    // a feeder MATCH of a round that holds two (the bye line and the other semi).
    expect(await premise(scene.f.koFinal)).toMatchObject({ status: "scheduled", ada_side: true });
    const { empty } = await seats(scene.f.koFinal);
    expect(empty?.key).toBe("slot.winner_match");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures
      where stage_id = (select stage_id from fixtures where id = ${scene.f.koFinal}) and round_no = ${Number(empty!.params.round)}`;
    expect(n).toBe(2);

    const expected = enPublic["knockout.feederWinner"]
      .replace("{round}", enUi["bracket.round.semi"])
      .replace("{seq}", String(empty!.params.seq));
    const ui = (key: MessageKey, vars?: Record<string, string | number>) => msgFor("en", key, vars);
    const row = byId(await read(scene.ko.id), scene.f.koFinal);
    expect(row.opponentLabel).toBe(expected);
    expect(row.opponentLabel, "not the organiser board's short code").not.toBe(resolveSlotLabel(empty, ui, "schedule.tbd"));
  });

  it("a BYE is not an upcoming match: a legacy scheduled bye line is left out on EITHER seat, the final it fed is not", async () => {
    // Premise: the pre-2026-09-17 shape — scheduled, no outcome, Ada on one seat
    // and the bye label on the empty one — once with the bye AWAY, once HOME.
    for (const id of [scene.f.koBye, scene.f.koFlipBye]) {
      expect(await premise(id), id).toMatchObject({ status: "scheduled", ada_side: true });
      const bye = await seats(id);
      expect(bye.outcome, id).toBeNull();
      expect(bye.empty?.key, id).toBe("bracket.slot.bye");
    }
    expect((await seats(scene.f.koBye)).away_entrant_id, "bye on the AWAY seat").toBeNull();
    expect((await seats(scene.f.koFlipBye)).home_entrant_id, "bye on the HOME seat").toBeNull();
    const got = ids(await read(scene.ko.id));
    expect(got).not.toContain(scene.f.koBye);
    expect(got).not.toContain(scene.f.koFlipBye);
    expect(got, "the positive pair: the same card still lists Ada's final").toContain(scene.f.koFinal);
  });

  it("a FILLED seat is never a bye, whatever label rides beside it: Ada's final carrying the bye label on HER seat is still listed", async () => {
    const final = await seats(scene.f.koFlipFinal);
    const adaSeatLabel = final.home_entrant_id === null ? final.away_slot_label : final.home_slot_label;
    // Premise: Ada's (filled) seat carries the bye key; the other seat is empty.
    expect(await premise(scene.f.koFlipFinal)).toMatchObject({ status: "scheduled", ada_side: true });
    expect(adaSeatLabel?.key).toBe("bracket.slot.bye");
    expect(final.home_entrant_id === null || final.away_entrant_id === null).toBe(true);
    expect(ids(await read(scene.ko.id))).toContain(scene.f.koFlipFinal);
  });

  it("opponent, KNOCKOUT: a waiting seat with NO stored label is named from the FEED EDGES", async () => {
    const { empty } = await seats(scene.f.koFlipFinal);
    // Premise: nothing stored on the waiting seat, so only the feeder can name it.
    expect(empty).toBeNull();
    const [feeder] = await sql<{ round_no: number; seq_in_round: number }[]>`
      select round_no, seq_in_round from fixtures
      where winner_to_fixture = ${scene.f.koFlipFinal} and id <> ${scene.f.koFlipBye}`;
    expect(feeder, "premise: the other semi-final feeds the final").toBeDefined();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures
      where stage_id = (select stage_id from fixtures where id = ${scene.f.koFlipFinal}) and round_no = ${feeder!.round_no}`;
    expect(n).toBe(2);
    const expected = enPublic["knockout.feederWinner"]
      .replace("{round}", enUi["bracket.round.semi"])
      .replace("{seq}", String(feeder!.seq_in_round));
    expect(byId(await read(scene.ko.id), scene.f.koFlipFinal).opponentLabel).toBe(expected);
  });

  it("each row carries ITS division's venue zone", async () => {
    const rows = await read(scene.cur.id);
    expect(byId(rows, scene.f.bo).tz).toBe("America/New_York");
    expect(byId(rows, scene.f.ned).tz).toBe("Asia/Kolkata");
    const [ss] = await sql<{ tz: string }[]>`select tz from schedule_settings where division_id = ${scene.doublesDivisionId}`;
    expect(byId(rows, scene.f.pair).tz).toBe(resolveVenueTz(ss?.tz ?? null, "Europe/London"));
  });

  it("getPublicPlayerUpcoming reads for the GATE's org, competition and player", async () => {
    // A real gate result: the wrapper takes nothing else, so it cannot be
    // called for a person or a competition the gate has not passed.
    const gate = await publicPlayerGate(scene.orgSlug, scene.sib.slug, scene.ada);
    expect(gate, "premise: Ada passes SIB's gate").not.toBeNull();
    const onSib = await getPublicPlayerUpcoming(gate!, { now: scene.now });
    // From SIB's card, Ned is home and the CUR rows are the other events.
    expect(byId(onSib, scene.f.ned).isOtherCompetition).toBe(false);
    expect(byId(onSib, scene.f.bo).isOtherCompetition).toBe(true);
    expect(ids(onSib)).toEqual(ids(await read(scene.sib.id)));
  });
});
