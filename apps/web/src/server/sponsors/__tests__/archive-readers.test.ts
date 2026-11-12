// Archive a sponsor, Task 4 (plan docs/superpowers/plans/2026-11-11-sponsor-archive.md; spec
// docs/superpowers/specs/2026-11-11-sponsor-archive-design.md §11, D15, D27, D28): every reader of the `sponsors` table that
// decides what the public, the stream or the `/s/` redirect sees leaves an ARCHIVED sponsor out, and the two records that must
// outlive an archive (the Overview's numbers, a report link) keep answering.
//
// The rig, per case (no case shares state with another): a Pro org, a competition with one fixture, and
//   T  "the archived one": active, tier `title`, scoped to the competition, ticked `on_stream`, a URL, a logo and a poster;
//   C  a control: active, org-wide, `partner`, on_stream, a URL. Never archived, so every "T is gone" is read beside "C is still
//      here" (an empty answer would pass an absence check on its own).
// T is archived and unarchived through the REAL usecases (`archiveSponsor`, `unarchiveSponsor`). Every case reads T's ABSENCE
// after the archive and its PRESENCE again after the unarchive (the positive pair), except the two records, which must answer the
// same in all three states.
//
// Expected values come from the spec (§11's table: who filters; D15: the Overview lists an archived sponsor only with airings or
// clicks in the period; D28: the archive filter runs before the name dedupe) and from the rows seeded here (the Overview's sums
// are plain arithmetic over them, report-overview.test.ts's rulebook), never from the readers under test.
//
// Anti-vacuity: the last case asserts that all TEN reader cases ran (`checked`), by name.
// Sport-agnostic: no sport sweep (a sponsor's visibility reads no sport; the fixture is only an id here).
import { afterAll, describe, expect, it, vi } from "vitest";

// A report's frames are signed through storage; none is seeded here, so nothing may reach a provider.
vi.mock("@/lib/supabase-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase-storage")>();
  return { ...actual, signedReadUrls: vi.fn(async (_orgId: string, paths: readonly string[]) => paths.map(() => null)) };
});

import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { cleanUp, rigOrg, uniq, type RigOrg } from "./_invoice-rig";
import { archiveSponsor, resolveSponsors, unarchiveSponsor } from "@/server/usecases/sponsors";
import { orgBranding } from "@/server/usecases/exports";
import { activeSponsorCards, sponsorsTableCardSource } from "../card-source";
import { assignmentsFor } from "../assign";
import { recordClick, resolveSponsorLink } from "../clicks";
import { mintShortCode } from "../short-codes";
import { createReportLink, sponsorOverview, sponsorReport, type SponsorPeriod } from "../report";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await cleanUp();
});

const GENERIC_DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };
const T_URL = "https://title.example/offer";
const C_URL = "https://control.example/offer";
const T_LOGO = "https://cdn.title.example/logo.png";
// The 4:5 poster (V501) is an http(s) url, like the logo.
const T_POSTER = "https://cdn.title.example/poster.png";

interface Rig {
  o: RigOrg;
  compId: string;
  fixtureId: string;
  /** The sponsor this file archives. */
  t: { id: string; name: string };
  /** The control: never archived. */
  c: { id: string; name: string };
}

/** A Pro org, a public competition with one fixture, T and C (see the header). */
async function rig(): Promise<Rig> {
  const o = await rigOrg({ plan: "pro" });
  const s = uniq();
  await sql`insert into sports (key, name, module_version, position_catalog) values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status)
    values (${o.orgId}, ${`Archive Cup ${s}`}, ${`archive-cup-${s}`}, 'public', 'live') returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${o.orgId}, ${compId}, 'Open', ${`open-${s}`}, 'generic', 'score', 'active', ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq) values (${o.orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${o.orgId}, ${divisionId}, ${stageId}, 1, 1, 1) returning id`;
  const tName = `Harbour Title ${s}`;
  const [{ id: tId }] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, url, tier, status, on_stream, logo_path, poster_path)
    values (${o.orgId}, ${compId}, ${tName}, ${T_URL}, 'title', 'active', true, ${T_LOGO}, ${T_POSTER})
    returning id`;
  const cName = `Keel Control ${s}`;
  const [{ id: cId }] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, url, tier, status, on_stream)
    values (${o.orgId}, null, ${cName}, ${C_URL}, 'partner', 'active', true) returning id`;
  return { o, compId, fixtureId, t: { id: tId, name: tName }, c: { id: cId, name: cName } };
}

const archive = (r: Rig, id = r.t.id) => archiveSponsor(r.o.auth, id);
const unarchive = (r: Rig, id = r.t.id) => unarchiveSponsor(r.o.auth, id);
/** The stored `archived_at` is set (premise of every "after archive" read). */
const isArchived = async (id: string): Promise<boolean> =>
  (await sql<{ archived: boolean }[]>`select archived_at is not null as archived from sponsors where id = ${id}`)[0]!.archived;

const clickRows = async (id: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sponsor_clicks where sponsor_id = ${id}`)[0]!.n;
const clickCount = async (id: string): Promise<number> =>
  (await sql<{ click_count: number }[]>`select click_count from sponsors where id = ${id}`)[0]!.click_count;

async function seedAiring(orgId: string, sponsor: { id: string; name: string }, start: Date, end: Date, fixtureId: string | null = null): Promise<void> {
  await sql`
    insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, session_id, moment_id, source, break_kind, style,
                                 started_at, ended_at)
    values (${orgId}, ${sponsor.id}, ${sponsor.name}, ${fixtureId}, ${null}, ${`m-${randomUUID()}`}, 'rotation', 'over_end',
            'lower_third', ${start}, ${end})`;
}
async function seedClick(orgId: string, sponsorId: string, at: Date, fixtureId: string | null): Promise<void> {
  await sql`insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source, at) values (${orgId}, ${sponsorId}, ${fixtureId}, 'stream', ${at})`;
}

/** The ten reader cases that ran to the end, by name (the last case counts them). */
const checked = new Set<string>();

describe.skipIf(!HAS_DB)("an archived sponsor leaves every reader of spec §11, and comes back on unarchive", () => {
  it("resolveSponsors (tiered) — competition page, hero title, poster", async () => {
    const r = await rig();
    const read = async () => (await resolveSponsors(r.o.orgId, r.compId)).map((s) => ({ id: s.id, tier: s.tier, poster: s.poster }));
    const tRow = { id: r.t.id, tier: "title", poster: T_POSTER };
    const cRow = { id: r.c.id, tier: "partner", poster: null };
    expect(await read(), "premise: T is the competition's title sponsor, with its poster").toEqual([tRow, cRow]);
    await archive(r);
    expect(await isArchived(r.t.id), "premise: archived").toBe(true);
    expect(await read(), "archived: T is gone, C stays").toEqual([cRow]);
    await unarchive(r);
    expect(await read(), "unarchived: T is back, first again").toEqual([tRow, cRow]);
    checked.add("resolveSponsors tiered");
  });

  it("resolveSponsors (tiered:false) — the free strip, slideshows, embed-data, orgBranding", async () => {
    const r = await rig();
    const read = async () => (await resolveSponsors(r.o.orgId, r.compId, { tiered: false })).map((s) => ({ id: s.id, tier: s.tier }));
    // The free strip collapses every tier to `partner` (resolveSponsors' rule for an org without `sponsors.tiers`).
    expect(await read(), "premise: both, un-tiered").toEqual([{ id: r.t.id, tier: "partner" }, { id: r.c.id, tier: "partner" }]);
    await archive(r);
    expect(await read(), "archived").toEqual([{ id: r.c.id, tier: "partner" }]);
    await unarchive(r);
    expect(await read(), "unarchived").toEqual([{ id: r.t.id, tier: "partner" }, { id: r.c.id, tier: "partner" }]);
    checked.add("resolveSponsors untiered");
  });

  it("resolveSponsors (onStream:true) — sponsorsTableCardSource.cardsFor, the rotation", async () => {
    const r = await rig();
    const read = async () => (await sponsorsTableCardSource.cardsFor(r.o.orgId, { competitionId: r.compId })).map((card) => card.sponsorId);
    expect(await read(), "premise: both ticked cards").toEqual([r.t.id, r.c.id]);
    await archive(r);
    expect(await read(), "archived: T leaves the rotation").toEqual([r.c.id]);
    await unarchive(r);
    expect(await read(), "unarchived").toEqual([r.t.id, r.c.id]);
    checked.add("cardsFor onStream");
  });

  it("activeSponsorCards — an assigned break airs nothing", async () => {
    const r = await rig();
    // A break already assigned to T (and one to C): the frozen assignment, as `writeAssignments` stores an operator's pick.
    for (const [moment, sp] of [["m-t", r.t], ["m-c", r.c]] as const) {
      await sql`
        insert into sponsor_assignments (fixture_id, moment_id, org_id, seq, sponsor_id, sponsor_name, position, source, break_kind, style,
                                         hold_ms, operator_choice_at)
        values (${r.fixtureId}, ${moment}, ${r.o.orgId}, ${moment === "m-t" ? 1 : 2}, ${sp.id}, ${sp.name}, null, 'operator', 'over_end',
                'lower_third', 8000, now())`;
    }
    const read = async () => {
      const stored = await assignmentsFor(sql, r.fixtureId, r.o.orgId);
      expect(stored.map((a) => a.sponsorId), "premise: both breaks stay assigned throughout").toEqual([r.t.id, r.c.id]);
      const cards = await activeSponsorCards(sql, r.o.orgId, stored.map((a) => a.sponsorId!), true);
      return cards.map((card) => card.sponsorId).sort();
    };
    expect(await read(), "premise: both assigned cards").toEqual([r.t.id, r.c.id].sort());
    await archive(r);
    expect(await read(), "archived: T's assigned break has no card").toEqual([r.c.id]);
    await unarchive(r);
    expect(await read(), "unarchived").toEqual([r.t.id, r.c.id].sort());
    checked.add("activeSponsorCards");
  });

  it("resolveSponsorLink by uuid → null; recordClick writes no click and click_count is unchanged", async () => {
    const r = await rig();
    const tag = { fixtureId: r.fixtureId, source: "match" as const };
    const query = new URLSearchParams({ f: r.fixtureId, src: "match" });
    expect(await resolveSponsorLink(r.t.id, query), "premise: T's link redirects").toMatchObject({ sponsorId: r.t.id, url: T_URL });
    await recordClick(r.t.id, tag);
    expect([await clickRows(r.t.id), await clickCount(r.t.id)], "premise: a click counts").toEqual([1, 1]);

    await archive(r);
    expect(await resolveSponsorLink(r.t.id, query), "archived: the redirect is a 404").toBeNull();
    expect(await resolveSponsorLink(r.c.id, query), "C still redirects").toMatchObject({ sponsorId: r.c.id, url: C_URL });
    await recordClick(r.t.id, tag);
    expect([await clickRows(r.t.id), await clickCount(r.t.id)], "archived: no click row, click_count unchanged").toEqual([1, 1]);

    await unarchive(r);
    expect(await resolveSponsorLink(r.t.id, query), "unarchived: redirects again").toMatchObject({ sponsorId: r.t.id, url: T_URL });
    await recordClick(r.t.id, tag);
    expect([await clickRows(r.t.id), await clickCount(r.t.id)], "unarchived: the click counts again").toEqual([2, 2]);
    checked.add("resolveSponsorLink uuid + recordClick");
  });

  it("resolveSponsorLink by short code → null", async () => {
    const r = await rig();
    const tCode = await mintShortCode({ orgId: r.o.orgId, sponsorId: r.t.id, fixtureId: r.fixtureId });
    const cCode = await mintShortCode({ orgId: r.o.orgId, sponsorId: r.c.id, fixtureId: r.fixtureId });
    expect(tCode, "premise: T has a code").toEqual(expect.any(String));
    const read = (code: string) => resolveSponsorLink(code, new URLSearchParams());
    expect(await read(tCode!), "premise: T's code redirects").toMatchObject({ sponsorId: r.t.id, url: T_URL, tag: { fixtureId: r.fixtureId, source: "stream" } });
    await archive(r);
    expect(await read(tCode!), "archived: T's code is a 404").toBeNull();
    expect(await read(cCode!), "C's code still redirects").toMatchObject({ sponsorId: r.c.id, url: C_URL });
    await unarchive(r);
    expect(await read(tCode!), "unarchived: the same code redirects again").toMatchObject({ sponsorId: r.t.id, url: T_URL });
    checked.add("resolveSponsorLink code");
  });

  it("orgBranding(…) carries no sponsor T", async () => {
    const r = await rig();
    const read = async () => (await orgBranding(r.o.orgId, r.o.name, r.compId))?.sponsors?.map((s) => s.name);
    expect(await read(), "premise: a Pro org's branded export names both").toEqual([r.t.name, r.c.name]);
    await archive(r);
    expect(await read(), "archived").toEqual([r.c.name]);
    await unarchive(r);
    expect(await read(), "unarchived").toEqual([r.t.name, r.c.name]);
    checked.add("orgBranding");
  });

  it("sponsorOverview lists T archived:true while it has numbers in the period, and not in an empty period", async () => {
    const r = await rig();
    // One 8 s airing on 15 June with no fixture (so no competition snapshot), and one click on 10 January on the competition's
    // fixture. With `now` 15 June 2026 the periods split them: Last 30 days holds the airing only, the competition holds the click
    // only, This year holds both, and This year read in 2027 holds nothing.
    await seedAiring(r.o.orgId, r.t, new Date("2026-06-15T10:00:00.000Z"), new Date("2026-06-15T10:00:08.000Z"));
    await seedClick(r.o.orgId, r.t.id, new Date("2026-01-10T09:00:00.000Z"), r.fixtureId);
    const NOW = new Date("2026-06-15T12:00:00.000Z");
    const NEXT_YEAR = new Date("2027-06-15T12:00:00.000Z");
    const periods: { label: string; p: SponsorPeriod; now: Date; numbers: { timesShown: number; onScreenMs: number; linkClicks: number } }[] = [
      { label: "last 30 days (the airing)", p: { kind: "last_30_days" }, now: NOW, numbers: { timesShown: 1, onScreenMs: 8_000, linkClicks: 0 } },
      { label: "the competition (the click)", p: { kind: "competition", competitionId: r.compId }, now: NOW, numbers: { timesShown: 0, onScreenMs: 0, linkClicks: 1 } },
      { label: "this year (both)", p: { kind: "this_year" }, now: NOW, numbers: { timesShown: 1, onScreenMs: 8_000, linkClicks: 1 } },
    ];
    const EMPTY = { p: { kind: "this_year" } as SponsorPeriod, now: NEXT_YEAR };
    const tRow = async (p: SponsorPeriod, now: Date) => {
      const rows = await sponsorOverview(r.o.auth, r.o.orgId, p, now);
      expect(rows.some((x) => x.sponsorId === r.c.id), "C, never archived, is listed in every period").toBe(true);
      const t = rows.find((x) => x.sponsorId === r.t.id);
      return t === undefined ? undefined : { archived: t.archived, timesShown: t.timesShown, onScreenMs: t.onScreenMs, linkClicks: t.linkClicks };
    };

    for (const x of periods) expect(await tRow(x.p, x.now), `premise, ${x.label}`).toEqual({ archived: false, ...x.numbers });
    expect(await tRow(EMPTY.p, EMPTY.now), "premise: a live sponsor is listed in an empty period, at zero").toEqual({
      archived: false, timesShown: 0, onScreenMs: 0, linkClicks: 0,
    });

    await archive(r);
    for (const x of periods) expect(await tRow(x.p, x.now), `archived, ${x.label}: its numbers still add up`).toEqual({ archived: true, ...x.numbers });
    expect(await tRow(EMPTY.p, EMPTY.now), "archived, an empty period: not listed (D15)").toBeUndefined();

    await unarchive(r);
    for (const x of periods) expect(await tRow(x.p, x.now), `unarchived, ${x.label}`).toEqual({ archived: false, ...x.numbers });
    expect(await tRow(EMPTY.p, EMPTY.now), "unarchived: listed again in the empty period").toEqual({
      archived: false, timesShown: 0, onScreenMs: 0, linkClicks: 0,
    });
    checked.add("sponsorOverview");
  });

  it("sponsorReport(token) still answers T's report after archive", async () => {
    const r = await rig();
    await seedAiring(r.o.orgId, r.t, new Date("2026-06-15T10:00:00.000Z"), new Date("2026-06-15T10:00:08.000Z"), r.fixtureId);
    const made = await createReportLink(r.o.auth, r.o.orgId, { sponsorId: r.t.id, competitionId: null, from: "2026-01-01", to: "2026-12-31" });
    const token = /^\/r\/sponsor\/([A-Za-z0-9_-]{43})$/.exec(made.url)?.[1];
    expect(token, `premise: the link's url shape, got ${made.url}`).toBeDefined();
    const NOW = new Date("2026-06-20T12:00:00.000Z");
    const read = async () => {
      const rep = await sponsorReport(token!, NOW);
      return rep === null ? null : { sponsor: rep.sponsor.name, timesShown: rep.timesShown, onScreenMs: rep.onScreenMs };
    };
    const want = { sponsor: r.t.name, timesShown: 1, onScreenMs: 8_000 };
    expect(await read(), "premise: the report answers").toEqual(want);
    await archive(r);
    expect(await read(), "archived: a report link is a record, it still opens (D15)").toEqual(want);
    await unarchive(r);
    expect(await read(), "unarchived").toEqual(want);
    checked.add("sponsorReport");
  });

  it("name dedupe: an archived 'Acme' (older, competition-scoped) never hides a new active 'Acme'; the new id resolves", async () => {
    const r = await rig();
    const acme = `Acme ${uniq()}`;
    // The older row is competition-scoped, so the resolver orders it FIRST and its name dedupe keeps it over the newer org-wide row.
    const [{ id: oldId }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, url, tier, status, created_at)
      values (${r.o.orgId}, ${r.compId}, ${acme}, ${T_URL}, 'partner', 'active', now() - interval '1 hour') returning id`;
    await archive(r, oldId);
    const [{ id: newId }] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, competition_id, name, url, tier, status) values (${r.o.orgId}, null, ${acme}, ${C_URL}, 'partner', 'active')
      returning id`;
    const acmes = async () => (await resolveSponsors(r.o.orgId, r.compId)).filter((s) => s.name === acme).map((s) => s.id);
    expect(await acmes(), "archived old Acme: the new Acme resolves (D28: filter before dedupe)").toEqual([newId]);
    await unarchive(r, oldId);
    expect(await acmes(), "premise: unarchived, the competition-scoped old Acme wins the dedupe again").toEqual([oldId]);
    await archive(r, oldId);
    expect(await acmes(), "archived again: the new one is back").toEqual([newId]);
    checked.add("name dedupe");
  });

  it("anti-vacuity: all ten reader cases ran", () => {
    expect([...checked].sort()).toEqual(
      [
        "activeSponsorCards",
        "cardsFor onStream",
        "name dedupe",
        "orgBranding",
        "resolveSponsorLink code",
        "resolveSponsorLink uuid + recordClick",
        "resolveSponsors tiered",
        "resolveSponsors untiered",
        "sponsorOverview",
        "sponsorReport",
      ].sort(),
    );
    expect(checked.size, "checked").toBe(10);
  });
});
