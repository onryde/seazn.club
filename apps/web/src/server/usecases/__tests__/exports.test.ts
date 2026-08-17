// Integration tests for PROMPT-26 (Jul3/06): DocModel assembly from live
// data, per-pitch breaks, empty-spot rows, branding gate, renderer bytes.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { patchFixture } from "../fixtures";
import { createVenue, createCourt } from "../venues";
import {
  buildDivisionDocModel,
  buildCompetitionTimetable,
  buildOfficialsRotaDoc,
  buildAdmitTicketsDoc,
  buildMyRotaDoc,
} from "../exports";
import { docModelToPdf, docModelToXlsx } from "@/server/doc-render";
import { msgFor } from "@/lib/messages-i18n";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};
const PRINTED = "2026-07-20T09:00:00.000Z";

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Exp " + suffix}, ${"exp-" + suffix})
    returning id`;
  if (plan !== "community") {
    await setOrgPlan(orgId, plan);
  }
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
  };
}

async function seedDivision(auth: AuthCtx) {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Print Cup",
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
    eligibility: [],
  });
  const entrants = await createEntrants(
    auth,
    division.id,
    ["A", "B", "Empty Spot 3", "D"].map((name, i) => ({
      kind: "individual" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { comp, division, stage: stage!, fixtures, entrants };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("rich exports (Jul3/06)", () => {
  it("timetable model carries title + stage headings; renders to PDF and XLSX bytes", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    // P9 pass 3a: court_id is the only writable court identity (PatchFixture
    // is .strict() — a court_label key 400s).
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: "2026-07-20T09:00:00.000Z",
      court_id: court1.id,
    });
    const model = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(model.title).toBe("Print Cup — Open");
    expect(model.meta.printedAt).toBe(PRINTED);
    expect(model.sections[0]!.subheading).toBe("League");

    const pdf = await docModelToPdf(model);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const xlsx = await docModelToXlsx(model);
    expect(xlsx.length).toBeGreaterThan(500);
  });

  // P9 pass-3a-FIX flag (NOT fixed here — exports.ts is pass 3c's file, out
  // of this pass's scope): `PatchFixture` is `.strict()` now, so `court_id`
  // is the only writable court identity — but `exports.ts`'s `groupByCourt`
  // and this doc's rendered subheading both still read `fixtures.court_label`
  // RAW (grep-verified: no `court_id`/`courtNamesById` reference anywhere in
  // exports.ts), and nothing writes that column any more since pass 3a's
  // FULL cutover. This test's whole premise — group by court, one page break
  // per court change — has no way to reach a non-null `court_label` through
  // any usecase, so it is expected to go RED at runtime (not just at the
  // type level) until pass 3c converts exports.ts to resolve court_id the
  // way schedule.ts's courtNamesById already does. Converted to court_id
  // below only so the file compiles; the assertions are not expected to
  // hold until that follow-up lands.
  it("scoresheets pageBreaks=per_pitch: one stack per court, one break between them", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    // Two courts, interleaved exactly as a real round robin comes back: R1 on
    // both courts, then R2 on both. This is the shape the old code got wrong —
    // it broke a page every time the court changed *in round order*, so it
    // produced three breaks here and grouped nothing.
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const court2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: "2026-07-20T09:00:00.000Z",
      court_id: court1.id,
    });
    await patchFixture(auth, fixtures[1]!.id, {
      scheduled_at: "2026-07-20T09:00:00.000Z",
      court_id: court2.id,
    });
    await patchFixture(auth, fixtures[2]!.id, {
      scheduled_at: "2026-07-20T09:30:00.000Z",
      court_id: court1.id,
    });
    await patchFixture(auth, fixtures[3]!.id, {
      scheduled_at: "2026-07-20T09:30:00.000Z",
      court_id: court2.id,
    });
    const model = await buildDivisionDocModel(auth, division.id, "scoresheet", {
      printedAt: PRINTED,
      pageBreaks: "per_pitch",
    });

    // seedDivision is a 4-entrant round robin (6 fixtures), so the two left
    // without a court form a third group that sorts last. Three groups → two
    // boundaries, never in front of the first sheet. The old code broke on
    // every court change in round order and produced far more.
    const breaks = model.sections.filter((s) => s.pageBreakBefore === true);
    expect(breaks).toHaveLength(2);
    expect(model.sections[0]!.pageBreakBefore).not.toBe(true);

    // Every Court 1 sheet precedes every Court 2 sheet, and unassigned sheets
    // come last — that is the point of the option: one pile per official.
    const courtOf = (sub?: string) =>
      sub?.includes("Court 1") ? 1 : sub?.includes("Court 2") ? 2 : 3;
    const order = model.sections.map((s) => courtOf(s.subheading));
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // generic sport falls back to the result form with signatures
    expect(model.sections[0]!.signatures).toContain("Referee");
  });

  it("participants export keeps Empty-Spot rows; roster lists teams", async () => {
    const { auth } = await seedOrg();
    const { division } = await seedDivision(auth);
    const participants = await buildDivisionDocModel(auth, division.id, "participants", {
      printedAt: PRINTED,
    });
    const flat = JSON.stringify(participants.sections);
    expect(flat).toContain("Empty Spot 3");
    const roster = await buildDivisionDocModel(auth, division.id, "roster", {
      printedAt: PRINTED,
    });
    expect(roster.sections.map((s) => s.heading)).toContain("Empty Spot 3");
  });

  it("branding is Pro (`exports.branded`): Pro branded; community exports render plain (V285)", async () => {
    const { auth } = await seedOrg("pro");
    const { division, comp } = await seedDivision(auth);
    await sql`update competitions set branding = ${sql.json({ primary_color: "#123456", logo_path: "orgs/x/logo.png" } as never)}
              where id = ${comp.id}`;
    const branded = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(branded.branding).toMatchObject({
      colors: { primary: "#123456" },
      logos: ["orgs/x/logo.png"],
    });
    expect(branded.branding?.orgName).toBeTruthy();

    // drop to a plan without exports.branded via override
    await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value)
              values (${auth.orgId}, 'exports.branded', false)
              on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(auth.orgId);
    const unbranded = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(unbranded.branding).toBeUndefined();

    // Community can export now (V285) but plain — exports.branded stays Pro.
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv } = await seedDivision(freeAuth);
    const freeModel = await buildDivisionDocModel(freeAuth, freeDiv.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(freeModel.branding).toBeUndefined();
  });

  it("brandingFor: Pro model carries orgName + tiered sponsors from the sponsors table", async () => {
    const { auth } = await seedOrg("pro");
    const { division, comp } = await seedDivision(auth);
    await sql`insert into sponsors (org_id, competition_id, name, tier, status, display_order)
              values (${auth.orgId}, ${comp.id}, 'Acme', 'title', 'active', 0)`;
    const model = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(model.branding?.orgName).toBeTruthy();
    expect(model.branding?.sponsors).toContainEqual({
      name: "Acme",
      tier: "title",
    });
  });

  it("competition-wide timetable groups per division", async () => {
    const { auth } = await seedOrg();
    const { comp } = await seedDivision(auth);
    const model = await buildCompetitionTimetable(auth, comp.id, {
      printedAt: PRINTED,
    });
    expect(model.title).toBe("Print Cup");
    expect(model.pageBreaks).toBe("per_division");
    expect(model.sections.some((s) => s.heading === "Open")).toBe(true);
  });

  it("buildCompetitionTimetable carries branding for a Pro org", async () => {
    const { auth } = await seedOrg("pro");
    const { comp } = await seedDivision(auth);
    const model = await buildCompetitionTimetable(auth, comp.id, {
      printedAt: PRINTED,
    });
    expect(model.branding?.orgName).toBeTruthy();
  });

  it("division timetable sets a description", async () => {
    const { auth } = await seedOrg("pro");
    const { division } = await seedDivision(auth);
    const model = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(model.description).toMatch(/fixtures/i);
  });

  it("live-page QR (Task 16): public competition's timetable carries meta.liveUrl to /shared/...; private carries none", async () => {
    const { auth } = await seedOrg("pro");
    const { division, comp } = await seedDivision(auth);
    const [{ slug: orgSlug }] = await sql<{ slug: string }[]>`
      select slug from organizations where id = ${auth.orgId}`;

    // seedDivision creates the competition as visibility: "private" — its
    // /shared/... page 404s, so no QR belongs on it.
    const privateModel = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(privateModel.meta.liveUrl).toBeUndefined();

    // The origin is no longer threaded from the request: a QR is scanned by a
    // phone that has to reach the public site, so it comes from siteOrigin()
    // and visibility is the only thing that decides whether one is drawn.
    await sql`update competitions set visibility = 'public' where id = ${comp.id}`;
    const model = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(model.meta.liveUrl).toBe(
      `https://seazn.club/shared/${orgSlug}/${comp.slug}/${division.slug}`,
    );
  });

  it("officials rota (v12/Task 13): lists an official's duties with response", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedDivision(auth);
    const [{ id: officialId }] = await sql<{ id: string }[]>`
      insert into officials (org_id, display_name) values (${auth.orgId}, 'Sam Ref')
      returning id`;
    await sql`
      insert into fixture_officials (fixture_id, official_id, role_key, response)
      values (${fixtures[0]!.id}, ${officialId}, 'referee', 'accepted')`;

    const model = await buildOfficialsRotaDoc(auth, division.id, {
      printedAt: PRINTED,
    });
    expect(model.kind).toBe("officials_rota");
    const section = model.sections.find((s) => s.heading === "Sam Ref");
    expect(section).toBeTruthy();
    const rows = section!.table!.rows;
    expect(rows.some((r) => r.includes("referee") && r.includes("Accepted"))).toBe(true);
  });

  it("admit tickets (v12/Task 13): masked names + /r/[ref] QR URLs", async () => {
    const { auth } = await seedOrg("pro");
    const { division, comp } = await seedDivision(auth);
    await sql`update divisions set player_name_display = 'first_initial' where id = ${division.id}`;
    const suffix = randomUUID().slice(0, 8);
    // Contact/ref_code envelope lives on the cart (registration_groups) now.
    const [{ id: groupId, ref_code }] = await sql<{ id: string; ref_code: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, ref_code, currency)
      values
        (${comp.id}, 'Jamie Doe', ${"jamie+" + suffix + "@example.com"},
         ${randomUUID()}, ${"TIX-" + suffix}, 'gbp')
      returning id, ref_code`;
    await sql`insert into registrations (division_id, group_id, status, display_name)
      values (${division.id}, ${groupId}, 'confirmed', 'Jamie Doe')`;

    const model = await buildAdmitTicketsDoc(auth, comp.id, {
      printedAt: PRINTED,
    });
    expect(model.kind).toBe("admit_ticket");
    const ticket = model.sections[0]!.ticket!;
    expect(ticket.maskedName).toBeTruthy();
    expect(ticket.maskedName).not.toBe("Jamie Doe"); // youth-default division masks
    expect(ticket.qrUrl).toContain(`/r/${ref_code}`);
  });

  it("buildMyRotaDoc: SEAZN-neutral — no org branding", async () => {
    const model = await buildMyRotaDoc(randomUUID(), { printedAt: PRINTED });
    expect(model.kind).toBe("officials_rota");
    expect(model.branding).toBeUndefined();
  });

  it("Task 14: officials rota + admit tickets export plain for Community (V285), branded for Pro", async () => {
    const { auth: freeAuth } = await seedOrg("community");
    const { division: freeDiv, comp: freeComp } = await seedDivision(freeAuth);
    const freeRota = await buildOfficialsRotaDoc(freeAuth, freeDiv.id, {
      printedAt: PRINTED,
    });
    expect(freeRota.branding).toBeUndefined();
    const freeTickets = await buildAdmitTicketsDoc(freeAuth, freeComp.id, {
      printedAt: PRINTED,
    });
    expect(freeTickets.branding).toBeUndefined();

    const { auth: proAuth } = await seedOrg("pro");
    const { division: proDiv, comp: proComp } = await seedDivision(proAuth);
    await expect(
      buildOfficialsRotaDoc(proAuth, proDiv.id, { printedAt: PRINTED }),
    ).resolves.toBeTruthy();
    await expect(
      buildAdmitTicketsDoc(proAuth, proComp.id, { printedAt: PRINTED }),
    ).resolves.toBeTruthy();
  });

  // P9 pass-3a-FIX flag (NOT fixed here, same gap as the scoresheets test
  // above): the `flat.toContain("Court 1")` / `not.toContain("Court 2")`
  // assertions below read `buildMyRotaDoc`'s rendered `court`, which
  // `exports.ts` still sources from `fixtures.court_label` — a column
  // nothing writes any more. Converted to court_id only so the file
  // compiles; expected RED at runtime until pass 3c converts exports.ts.
  it("Task 14: buildMyRotaDoc is scoped to the caller — never leaks another official's assignments", async () => {
    const { auth } = await seedOrg("pro");
    const { fixtures } = await seedDivision(auth);
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court1 = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const court2 = await createCourt(auth, venue.id, { name: "Court 2", sort: 1, tags: [] });
    await patchFixture(auth, fixtures[0]!.id, {
      scheduled_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      court_id: court1.id,
    });
    await patchFixture(auth, fixtures[1]!.id, {
      scheduled_at: new Date(Date.now() + 8 * 86_400_000).toISOString(),
      court_id: court2.id,
    });

    async function makeLinkedOfficial(name: string, fixtureId: string) {
      const suffix = randomUUID().slice(0, 8);
      const [{ id: userId }] = await sql<{ id: string }[]>`
        insert into users (email, display_name, email_verified)
        values (${`${name}-${suffix}@test.local`}, ${name}, true)
        returning id`;
      const [{ id: personId }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name, user_id)
        values (${auth.orgId}, ${name}, ${userId}) returning id`;
      const [{ id: officialId }] = await sql<{ id: string }[]>`
        insert into officials (org_id, person_id, display_name)
        values (${auth.orgId}, ${personId}, ${name}) returning id`;
      await sql`
        insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
        values (${auth.orgId}, ${fixtureId}, ${officialId}, 'referee', 'accepted')`;
      return { userId, officialId };
    }

    const a = await makeLinkedOfficial("Rota User A", fixtures[0]!.id); // Court 1
    await makeLinkedOfficial("Rota User B", fixtures[1]!.id); // Court 2

    const model = await buildMyRotaDoc(a.userId, { printedAt: PRINTED });
    const flat = JSON.stringify(model.sections);
    // A's own duty (Court 1) shows; B's fixture (Court 2) never leaks in.
    expect(flat).toContain("Court 1");
    expect(flat).not.toContain("Court 2");
  });

  // F1 Task 4: buildBracket's round names now come from an injected
  // callback (exports.ts wires roundRole()/roundRoleLabel() through it) --
  // nothing else in this file exercises the "bracket" doc kind, so a
  // mutation that broke that wiring (e.g. swapped it for a callback that
  // always throws) survived every other test here unnoticed. Proves the
  // real usecase-level wiring, not just buildBracket's own unit test.
  it("bracket export names rounds via the injected roundRole wiring", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Print Cup",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 8 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "knockout",
      name: "KO",
      config: {},
    });
    await generateStageFixtures(auth, stage!.id);
    const model = await buildDivisionDocModel(auth, division.id, "bracket", {
      printedAt: PRINTED,
    });
    expect(model.bracket!.roundLabels).toEqual(["Quarter-finals", "Semi-finals", "Final"]);
  });

  // F4/Task 1: the exported draw used to coalesce unfilled slots to the SQL
  // literal 'TBD' and never selected home_slot_label/away_slot_label, so a
  // printed day-one timetable said "TBD vs TBD" while every HTML surface
  // already said "Winner of Group A" for the identical fixture.
  it("a placeholder fixture exports its slot label, not TBD", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    // Force an unfilled, labeled slot directly (same pattern as
    // public-slot-labels.test.ts) — how it got there in production is P5's
    // stage-seeding.ts, which is out of scope here; this proves the export
    // READ path resolves whatever it finds.
    await sql`
      update fixtures
      set home_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })},
          away_slot_label = ${sql.json({ key: "slot.runner_up_group", params: { g: "B" } })},
          home_entrant_id = null, away_entrant_id = null
      where id = ${fixtures[0]!.id}`;
    const model = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    const text = JSON.stringify(model);
    expect(text).toContain("Winner of Group A");
    expect(text).toContain("Runner-up of Group B");
    // Regression, fixed round 1 (reviewer): `home`/`away` serialize as
    // separate table cells for the "timetable" kind (fixtureRows() in
    // engine/exports/build.ts never joins them into one "X vs Y" string —
    // that only happens for the officials-rota/my-rota "opponents" field),
    // so a substring probe for "TBD vs TBD" is vacuous here: that exact
    // shape can never appear in this doc kind's JSON even when the fallback
    // is completely broken. Assert on the actual row instead — BOTH cells
    // of the placeholder fixture's row must carry the resolved label, not
    // the literal TBD text a half-applied fix would leave on one side.
    // Cells are [time, court, home, result-or-"vs", away, stage] (see
    // TIMETABLE_COLUMNS/fixtureRows() in engine/exports/build.ts) — scoped
    // to indices 2/4 specifically, NOT the whole row: this fixture has no
    // scheduled_at, so cell 0 (time) legitimately reads "TBD" too, via
    // timeOf()'s own unrelated fallback, and would false-positive a
    // whole-row check.
    const row = model.sections
      .flatMap((s) => s.table?.rows ?? [])
      .find((r) => r.includes("Winner of Group A") || r.includes("Runner-up of Group B"));
    expect(row).toEqual(expect.arrayContaining(["Winner of Group A", "Runner-up of Group B"]));
    expect(row?.[2]).not.toBe(msgFor("en", "schedule.tbd"));
    expect(row?.[4]).not.toBe(msgFor("en", "schedule.tbd"));
  });

  it("a filled fixture still exports entrant names", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    const [names] = await sql<{ home_label: string | null; away_label: string | null }[]>`
      select he.display_name as home_label, ae.display_name as away_label
      from fixtures f
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
      where f.id = ${fixtures[0]!.id}`;
    // A league's round-1 fixtures are filled from creation — sanity-check the
    // arrangement actually gives this test real entrant names to look for.
    expect(names?.home_label).toBeTruthy();
    expect(names?.away_label).toBeTruthy();
    const model = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    const text = JSON.stringify(model);
    expect(text).toContain(names!.home_label!);
    expect(text).toContain(names!.away_label!);
  });

  it("a fixture with neither entrant nor label falls back to localized TBD", async () => {
    const { auth } = await seedOrg();
    // org.default_locale = 'fr' for this org; fr's schedule.tbd is not the
    // English literal, which is what proves the lookup is wired to the org.
    await sql`update organizations set default_locale = 'fr' where id = ${auth.orgId}`;
    const { division, fixtures } = await seedDivision(auth);
    await sql`
      update fixtures
      set home_entrant_id = null, home_slot_label = null,
          away_entrant_id = null, away_slot_label = null
      where id = ${fixtures[0]!.id}`;
    const model = await buildDivisionDocModel(auth, division.id, "timetable", {
      printedAt: PRINTED,
    });
    expect(JSON.stringify(model)).toContain(msgFor("fr", "schedule.tbd"));
  });

  // Fix round 1 (reviewer, Important): the "scoresheet" case arm's own
  // resolveSlotLabel fallback (exports.ts, forced by Task 1's FixtureExportRow
  // nullability change — the generic sport has no exportTemplates.scoresheet,
  // so this exercises the `heading`/`signatures` fallback path directly) had
  // zero coverage. scoresheet-per-pitch.test.ts only ever exercises filled
  // fixtures — tsc-clean plus that suite staying green was never evidence the
  // branch actually resolves.
  it("a placeholder fixture's scoresheet shows its slot label in the heading and signatures", async () => {
    const { auth } = await seedOrg();
    const { division, fixtures } = await seedDivision(auth);
    await sql`
      update fixtures
      set home_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })},
          away_slot_label = ${sql.json({ key: "slot.runner_up_group", params: { g: "B" } })},
          home_entrant_id = null, away_entrant_id = null
      where id = ${fixtures[0]!.id}`;
    const model = await buildDivisionDocModel(auth, division.id, "scoresheet", {
      printedAt: PRINTED,
    });
    const section = model.sections.find((s) => s.heading?.includes("Winner of Group A"));
    expect(section).toBeTruthy();
    expect(section!.heading).toBe("Winner of Group A vs Runner-up of Group B");
    expect(section!.signatures).toEqual(
      expect.arrayContaining(["Captain — Winner of Group A", "Captain — Runner-up of Group B"]),
    );
  });

  // F4/Task 2: officialDutyRows joined entrants only, and the rota assembly
  // loop applied `?? "TBD"` in TypeScript — an official handed a rota for a
  // knockout day saw "TBD vs TBD" for every unfilled match.
  it("the officials rota shows slot labels for unfilled fixtures", async () => {
    const { auth } = await seedOrg("pro");
    const { division, fixtures } = await seedDivision(auth);
    await sql`
      update fixtures
      set home_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })},
          away_slot_label = ${sql.json({ key: "slot.runner_up_group", params: { g: "B" } })},
          home_entrant_id = null, away_entrant_id = null,
          status = 'scheduled'
      where id = ${fixtures[0]!.id}`;
    const [{ id: officialId }] = await sql<{ id: string }[]>`
      insert into officials (org_id, display_name) values (${auth.orgId}, 'Sam Ref')
      returning id`;
    await sql`
      insert into fixture_officials (fixture_id, official_id, role_key, response)
      values (${fixtures[0]!.id}, ${officialId}, 'referee', 'accepted')`;

    const model = await buildOfficialsRotaDoc(auth, division.id, {
      printedAt: PRINTED,
    });
    const text = JSON.stringify(model);
    expect(text).toContain("Winner of Group A vs Runner-up of Group B");
    expect(text).not.toContain("TBD vs TBD");
  });

  // F4/Task 3: buildMyRotaDoc reads getMyOfficiating(userId), which selected
  // entrant names only — cross-org and SEAZN-neutral, so there is no single
  // org locale and each row must carry its own.
  //
  // Fix-wave finding 4: this test used to assert only the ENGLISH slot-label
  // string, which stays byte-identical whether buildMyRotaDoc's per-duty
  // lookup is exportLookup(a.org_default_locale) (correct) or a
  // mutated exportLookup("en") (the headline bug this test exists to catch)
  // — a French-locale org is the only way "localized per owning org" is
  // actually exercised, mirroring the fr bracket tests elsewhere in this
  // file (e.g. "bracket export names knockout rounds in French…" above).
  it("my rota shows slot labels, localized per owning org", async () => {
    const { auth } = await seedOrg("pro");
    await sql`update organizations set default_locale = 'fr' where id = ${auth.orgId}`;
    const { fixtures } = await seedDivision(auth);
    await sql`
      update fixtures
      set home_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })},
          away_slot_label = ${sql.json({ key: "slot.runner_up_group", params: { g: "B" } })},
          home_entrant_id = null, away_entrant_id = null,
          status = 'scheduled'
      where id = ${fixtures[0]!.id}`;

    // Linked official (same pattern as "Task 14: buildMyRotaDoc is scoped to
    // the caller" above): a real users/persons/officials chain so
    // getMyOfficiating(userId) can find the assignment cross-org.
    const suffix = randomUUID().slice(0, 8);
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`rota-${suffix}@test.local`}, 'Rota Official', true)
      returning id`;
    const [{ id: personId }] = await sql<{ id: string }[]>`
      insert into persons (org_id, full_name, user_id)
      values (${auth.orgId}, 'Rota Official', ${userId}) returning id`;
    const [{ id: officialId }] = await sql<{ id: string }[]>`
      insert into officials (org_id, person_id, display_name)
      values (${auth.orgId}, ${personId}, 'Rota Official') returning id`;
    await sql`
      insert into fixture_officials (org_id, fixture_id, official_id, role_key, response)
      values (${auth.orgId}, ${fixtures[0]!.id}, ${officialId}, 'referee', 'accepted')`;

    const model = await buildMyRotaDoc(userId, { printedAt: PRINTED });
    const text = JSON.stringify(model);
    // fr's own translated strings (dictionaries/fr/ui.json) — "Vainqueur du
    // Groupe A vs Deuxième du Groupe B" — not the English literal. Old code
    // (exportLookup("en")) can only ever produce the English string here,
    // regardless of the org's default_locale, so this fails against it.
    expect(text).toContain(
      `${msgFor("fr", "slot.winner_group", { g: "A" })} vs ${msgFor("fr", "slot.runner_up_group", { g: "B" })}`,
    );
    expect(text).not.toContain("Winner of Group A vs Runner-up of Group B");
    expect(text).not.toContain("TBD vs TBD");
  });

  // NEW SCOPE (owner-approved): the bracket poster arm runs its OWN fixture
  // query and never went through exportFixtures, which is why wave A missed
  // it. For a knockout division the bracket poster IS the day-one printed
  // draw — the single most valuable artifact this whole session exists to
  // produce.
  it("a placeholder slot in the bracket poster resolves its label, not a blank", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Bracket Poster Cup",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 8 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "knockout",
      name: "KO",
      config: {},
    });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);
    // Force one slot into an unfilled, labeled state directly (same pattern
    // as Task 1/2/3) — proves the READ path resolves whatever it finds,
    // independent of how a real knockout naturally seeds later rounds.
    await sql`
      update fixtures
      set home_slot_label = ${sql.json({ key: "slot.winner_group", params: { g: "A" } })},
          away_slot_label = ${sql.json({ key: "slot.runner_up_group", params: { g: "B" } })},
          home_entrant_id = null, away_entrant_id = null
      where id = ${fixtures[0]!.id}`;
    const model = await buildDivisionDocModel(auth, division.id, "bracket", {
      printedAt: PRINTED,
    });
    const text = JSON.stringify(model);
    expect(text).toContain("Winner of Group A");
    expect(text).toContain("Runner-up of Group B");
  });

  it("bracket poster chrome is localized for a French org, not the English literal", async () => {
    const { auth } = await seedOrg("pro"); // formats.double_elim is Pro-gated
    await sql`update organizations set default_locale = 'fr' where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Bracket Poster Cup FR",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 8 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "double_elim",
      name: "DE",
      config: { bracketReset: true },
    });
    await generateStageFixtures(auth, stage!.id);
    const model = await buildDivisionDocModel(auth, division.id, "bracket", {
      printedAt: PRINTED,
    });
    const text = JSON.stringify(model);
    // "Tableau principal" is fr's bracket.winners (bracket-panel.tsx and
    // public-site/bracket.tsx already render it for the live HTML lane
    // header) — proves the poster's chrome is wired to the org's own
    // locale via a real, already-translated key, not English left in.
    expect(text).toContain("Tableau principal");
    expect(text).not.toContain("Winners bracket");
  });

  // F4 wave-A re-review, Gap 1 (exports.ts:569): the knockout round-name
  // callback moved from the client-safe English-default `msg` (@/lib/messages)
  // onto the org-locale `slotLookup`. Every existing buildBracket-reaching
  // test — including "bracket export names rounds via the injected roundRole
  // wiring" above — runs against a DEFAULT ENGLISH org, where old `msg` and
  // new `slotLookup` resolve to byte-identical strings (both ultimately read
  // en/ui.json for an English org), so the wiring change was code-correct but
  // test-unproven: it could have been silently reverted to `msg` and nothing
  // here would fail. The double_elim French test directly above only reaches
  // buildBracketDe's laneLabels — this one reaches buildBracket/
  // roundRoleLabel, the knockout-only path the F1 Task 4 comment describes.
  // Old code (msg, English-only regardless of locale) could only ever have
  // produced ["Quarter-finals", "Semi-finals", "Final"] here — verified by
  // temporarily reverting the callsite by hand (report has the red-run
  // evidence) — so this assertion fails against it and passes against the
  // current slotLookup wiring.
  it("bracket export names knockout rounds in French for a French-locale org", async () => {
    const { auth } = await seedOrg();
    await sql`update organizations set default_locale = 'fr' where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Print Cup FR KO",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 8 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "knockout",
      name: "KO",
      config: {},
    });
    await generateStageFixtures(auth, stage!.id);
    const model = await buildDivisionDocModel(auth, division.id, "bracket", {
      printedAt: PRINTED,
    });
    // fr's bracket.round.quarter/semi/final — dictionaries/fr/ui.json:3947-3949.
    expect(model.bracket!.roundLabels).toEqual(["Quarts de finale", "Demi-finales", "Finale"]);
  });

  // F4 wave-A re-review, Gap 2 (exports.ts:532-541): the page_playoff arm
  // moved from hardcoded English literals ("Qualifier 1"/"Eliminator"/
  // "Qualifier 2"/"Final", never routed through msg() at all per e3a322e5a's
  // commit message) to slotLookup, and no test built a bracket doc for a
  // page_playoff stage at all — zero prior coverage, English or otherwise.
  // en's bracket.round.qualifier1/eliminator/qualifier2/final are
  // byte-identical to those old hardcoded literals (dictionaries/en/ui.json:
  // 3956-3959), so an English-org test would pass unchanged against the
  // pre-Wave-A code and prove nothing about the slotLookup wiring — French is
  // what makes this assertion capable of failing against the old code.
  it("bracket export names page-playoff rounds in French for a French-locale org", async () => {
    const { auth } = await seedOrg("pro"); // shares double_elim's Pro gate — stageNeedsDoubleElimGate(page_playoff) === true
    await sql`update organizations set default_locale = 'fr' where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Print Cup FR PP",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    // generatePagePlayoff (packages/engine/src/scheduling/bracket.ts) throws
    // CONFIG_INVALID unless entrants.length === 4 — the format is a fixed
    // 4-team IPL-style shape (Q1/Eliminator/Q2/Final), not parametric.
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "page_playoff",
      name: "Playoffs",
      config: {},
    });
    await generateStageFixtures(auth, stage!.id);
    const model = await buildDivisionDocModel(auth, division.id, "bracket", {
      printedAt: PRINTED,
    });
    expect(model.pagePlayoff!.slotLabels).toEqual({
      q1: "Qualification 1",
      eliminator: "Éliminateur",
      q2: "Qualification 2",
      final: "Finale",
    });
  });

  // F4 wave-A re-review, Gap 2 (exports.ts:543-552): same story as
  // page_playoff above — the stepladder arm moved from a hardcoded
  // `` `Rung ${i + 1}` ``/"Final" template (never through msg()) to
  // slotLookup, with zero prior coverage of a stepladder bracket doc. en's
  // bracket.round.rung/final are again byte-identical to the old hardcoded
  // strings, so French is what makes this assertion capable of failing
  // against the old code.
  it("bracket export names stepladder rungs in French for a French-locale org", async () => {
    const { auth } = await seedOrg(); // stepladder is NOT gated (format-gates.test.ts)
    await sql`update organizations set default_locale = 'fr' where id = ${auth.orgId}`;
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Print Cup FR SL",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    // generateStepladder (packages/engine/src/scheduling/bracket.ts) accepts
    // any k >= 2 entrants; 4 gives 3 rungs (two climb games + a final), enough
    // to prove both the `rung` and `final` labels in one doc.
    await createEntrants(
      auth,
      division.id,
      Array.from({ length: 4 }, (_, i) => ({
        kind: "individual" as const,
        display_name: `E${i + 1}`,
        seed: i + 1,
        members: [],
      })),
    );
    const [stage] = await createStages(auth, division.id, {
      seq: 1,
      kind: "stepladder",
      name: "Stepladder",
      config: {},
    });
    await generateStageFixtures(auth, stage!.id);
    const model = await buildDivisionDocModel(auth, division.id, "bracket", {
      printedAt: PRINTED,
    });
    expect(model.ladder!.rungs.map((r) => r.label)).toEqual([
      "Échelon 1",
      "Échelon 2",
      "Finale",
    ]);
  });
});
