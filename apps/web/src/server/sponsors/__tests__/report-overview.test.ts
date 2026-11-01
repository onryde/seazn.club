// R4 sponsors on stream, S13 - the Sponsors hub's Overview numbers (`sponsorOverview`, server/sponsors/report.ts; spec 2026-10-27
// §5.1). These are the numbers a club shows its sponsors, so every expected value below is INDEPENDENT ARITHMETIC over the rows
// this file seeds (the seeded start/end instants, summed here in JS), never a figure read back from `sponsorOverview`.
//
// THE RULEBOOK (controller addenda 2026-11-01; spec §5.1):
//   - Times shown  = count of airings in the period, scene airings included, OPEN ones (ended_at null) included.
//   - On screen    = Σ (ended_at − started_at) over CLOSED airings; an open airing adds nothing. S14 reads the same rule.
//   - Link clicks  = count(*) of `sponsor_clicks` in the period, every source (stream, match, site, unknown). Never
//                    `sponsors.click_count`.
//   - Viewer impressions / peak viewers = null in PR A (Y1 fills them).
//   - Periods are half-open [from, to) in UTC; "Last 30 days" is relative to `now` (lib/sponsor-report.ts's rule, restated
//     in lib/__tests__/sponsor-report.test.ts). "One competition" has no time bound: the airings and clicks whose FIXTURE is in
//     it, so a click with no fixture is excluded.
//   - A deleted sponsor's airings survive on `sponsor_name` (R16, Review Focus 4): its row has no sponsor id (no live link);
//     its clicks went with it (V483 cascade), so its link clicks are UNKNOWN (null, shown as a dash), not zero.
//
// The transitions (TEST-STRATEGY rule 1) and where each is pinned:
//   seeded period sums ................................ "sums"
//   both period bounds, both tables ................... "the bounds"
//   relative to `now` ................................. "now, not the clock"
//   an open airing ..................................... "open airings"
//   an end before its start (no writer makes one) ...... "an inverted row"
//   a deleted sponsor .................................. "Review Focus 4"
//   one competition ................................... "competition"
//   empty org, sponsors with no airings, a second call .. "empty"
//   another org, another org's competition ............. "tenancy"
//   a viewer (R19: the Overview is read-only for viewers, not refused) ... "R19"
//   the REAL S10 click writer + the REAL S8 airing writer ................ "the seam"
// SINGLE SPORT, on purpose: the overview reads no sport (an airing row carries none); the seam's generic carousel is S8's own
// path for a break-less sport, and airings.test.ts covers the break path per sport.
//
// Killers (one at a time, restore from a cp backup):
//   K1  lower bound   `${col} >= ${from}` -> `${col} > ${from}`            -> "the bounds: a row exactly at `from` counts"
//   K2  upper bound   `${col} < ${to}`    -> `${col} <= ${to}`             -> "the bounds: a row exactly at `to` does not"
//   K3  no lower bound  drop `${col} >= ${from} and`                       -> "sums" (the day-before click and airing)
//   K4  open airing   `a.ended_at` -> `coalesce(a.ended_at, ${now})`       -> "open airings"
//   K5  clamp         drop `greatest(…, 0)`                                 -> "an inverted row"
//   K6  org check     drop `if (auth.orgId !== orgId)`                     -> "tenancy: another org's auth"
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { RelayAiring } from "@/server/api-v1/schemas";
import { SIGNAL_SPONSOR_END, SIGNAL_SPONSOR_START } from "@/lib/overlay-compositor";
import { CAROUSEL_INITIAL, carouselLines, carouselStep } from "@/components/overlay/sponsor-card";
import { SPONSOR_CAROUSEL_SCENES } from "@/components/overlay/overlay-scenes";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { streamRig } from "@/server/relay/__tests__/_session-rig";
import { deleteSponsor } from "@/server/usecases/sponsors";
import { recordAirings } from "../airings";
import { recordClick, resolveSponsorLink } from "../clicks";
import { mintShortCode } from "../short-codes";
import { sponsorOverview, type SponsorOverviewRow, type SponsorPeriod } from "../report";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const SEC = 1000;
const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);
/** Review Focus 5's realistic sponsor name: 43 characters. */
const LONG_NAME = "Harbourside Building Supplies and Timber Co";
const LAST_30: SponsorPeriod = { kind: "last_30_days" };
const THIS_YEAR: SponsorPeriod = { kind: "this_year" };

// The rulebook's windows for the fixed `now` the period tests use, typed from the rule (half-open, whole UTC days), never
// computed by the module under test.
const NOW = at("2026-06-15T12:00:00.000Z");
const L30_FROM = at("2026-05-17T00:00:00.000Z");
const L30_TO = at("2026-06-16T00:00:00.000Z");
const YEAR_FROM = at("2026-01-01T00:00:00.000Z");
const YEAR_TO = at("2027-01-01T00:00:00.000Z");

// ---------------------------------------------------------------------------------------------------------------
// Seeding: the privileged client, the way the writers' own tables are filled (app_user may only READ them).
// ---------------------------------------------------------------------------------------------------------------
async function sponsorRow(orgId: string, name: string, o: { tier?: string; order?: number; competitionId?: string | null } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, tier, display_order, competition_id)
    values (${orgId}, ${name}, ${o.tier ?? "partner"}, ${o.order ?? 0}, ${o.competitionId ?? null}) returning id`;
  return row!.id;
}
interface SeededAiring { sponsorId: string | null; name: string; fixtureId?: string | null; start: Date; end: Date | null; source?: "rotation" | "scene" | "operator" }
async function airing(orgId: string, a: SeededAiring): Promise<void> {
  const source = a.source ?? "rotation";
  await sql`
    insert into sponsor_airings (org_id, sponsor_id, sponsor_name, fixture_id, session_id, moment_id, source, break_kind, style,
                                 started_at, ended_at)
    values (${orgId}, ${a.sponsorId}, ${a.name}, ${a.fixtureId ?? null}, ${null}, ${`m-${randomUUID()}`}, ${source},
            ${source === "scene" ? null : "over_end"}, ${source === "scene" ? "banner" : "lower_third"}, ${a.start}, ${a.end})`;
}
interface SeededClick { sponsorId: string; fixtureId?: string | null; source?: "stream" | "match" | "site" | "unknown"; at: Date }
async function click(orgId: string, c: SeededClick): Promise<void> {
  await sql`
    insert into sponsor_clicks (org_id, sponsor_id, fixture_id, source, at)
    values (${orgId}, ${c.sponsorId}, ${c.fixtureId ?? null}, ${c.source ?? "stream"}, ${c.at})`;
}

/** The rulebook's own sums over what was seeded, by plain arithmetic. */
function expectedFor(airings: SeededAiring[], clicks: SeededClick[], inPeriod: (a: { at: Date; fixtureId: string | null }) => boolean) {
  const aired = airings.filter((a) => inPeriod({ at: a.start, fixtureId: a.fixtureId ?? null }));
  return {
    timesShown: aired.length,
    onScreenMs: aired.reduce((sum, a) => sum + (a.end === null ? 0 : Math.max(0, a.end.getTime() - a.start.getTime())), 0),
    linkClicks: clicks.filter((c) => inPeriod({ at: c.at, fixtureId: c.fixtureId ?? null })).length,
  };
}
const inWindow = (from: Date, to: Date) => (r: { at: Date }) => r.at.getTime() >= from.getTime() && r.at.getTime() < to.getTime();

const byId = (rows: SponsorOverviewRow[], id: string) => {
  const row = rows.find((r) => r.sponsorId === id);
  if (!row) throw new Error(`no overview row for sponsor ${id}`);
  return row;
};
const numbersOf = (r: SponsorOverviewRow) => ({ timesShown: r.timesShown, onScreenMs: r.onScreenMs, linkClicks: r.linkClicks });

async function org(): Promise<AuthCtx> {
  return (await seedOrg("pro")).auth;
}
/** One competition with one fixture, through the real organiser path (the competition is the fixture's division's). */
async function competitionWithFixture(auth: AuthCtx): Promise<{ competitionId: string; fixtureId: string }> {
  const rig = await divisionRig(auth, { entrants: 2 });
  const fixtureId = rig.fixtureIds[0]!;
  const [row] = await sql<{ competition_id: string }[]>`
    select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
  return { competitionId: row!.competition_id, fixtureId };
}

describe.skipIf(!HAS_DB)("S13: the Overview's numbers", () => {
  it("sums: overview sums seeded airings - count, Σ duration, clicks in period only (a click a day before the period excluded)", async () => {
    const auth = await org();
    const harbour = await sponsorRow(auth.orgId, LONG_NAME, { tier: "title" });
    const ridge = await sponsorRow(auth.orgId, "Ridge Cycles", { tier: "gold" });
    const airings: SeededAiring[] = [
      // Inside the window: three closed break cards and a scene showing, at uneven lengths so a swapped field shows.
      { sponsorId: harbour, name: LONG_NAME, start: at("2026-05-20T14:00:00.000Z"), end: at("2026-05-20T14:00:08.000Z") },
      { sponsorId: harbour, name: LONG_NAME, start: at("2026-06-01T09:30:00.000Z"), end: at("2026-06-01T09:30:15.000Z") },
      { sponsorId: harbour, name: LONG_NAME, start: at("2026-06-15T11:59:00.000Z"), end: at("2026-06-15T11:59:03.250Z") },
      { sponsorId: harbour, name: LONG_NAME, source: "scene", start: at("2026-06-10T18:00:00.000Z"), end: at("2026-06-10T18:00:10.000Z") },
      // A day before the window opens: excluded.
      { sponsorId: harbour, name: LONG_NAME, start: new Date(L30_FROM.getTime() - DAY), end: new Date(L30_FROM.getTime() - DAY + 8 * SEC) },
      // Ridge: one closed card in the window.
      { sponsorId: ridge, name: "Ridge Cycles", start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:15.000Z") },
    ];
    const clicks: SeededClick[] = [
      // Every source counts (the addendum: all sources, never "visitors").
      { sponsorId: harbour, source: "stream", at: at("2026-05-18T10:00:00.000Z") },
      { sponsorId: harbour, source: "match", at: at("2026-06-01T10:00:00.000Z") },
      { sponsorId: harbour, source: "site", at: at("2026-06-11T10:00:00.000Z") },
      { sponsorId: harbour, source: "unknown", at: at("2026-06-15T11:00:00.000Z") },
      // A day before the window: excluded.
      { sponsorId: harbour, source: "stream", at: new Date(L30_FROM.getTime() - DAY) },
      // After it closes (tomorrow): excluded.
      { sponsorId: harbour, source: "stream", at: new Date(L30_TO.getTime() + 60 * SEC) },
    ];
    for (const a of airings) await airing(auth.orgId, a);
    for (const c of clicks) await click(auth.orgId, c);

    const rows = await sponsorOverview(auth, auth.orgId, LAST_30, NOW);
    const wantHarbour = expectedFor(airings.filter((a) => a.sponsorId === harbour), clicks.filter((c) => c.sponsorId === harbour), inWindow(L30_FROM, L30_TO));
    const wantRidge = expectedFor(airings.filter((a) => a.sponsorId === ridge), clicks.filter((c) => c.sponsorId === ridge), inWindow(L30_FROM, L30_TO));
    // Premises, so the sums below are not vacuous: something was excluded on each side, and something was kept.
    expect(wantHarbour.timesShown, "premise: four Harbour airings are in the window").toBe(4);
    expect(wantHarbour.onScreenMs, "premise: 8 + 15 + 3.25 + 10 seconds").toBe(36_250);
    expect(wantHarbour.linkClicks, "premise: four clicks, one of each source, are in the window").toBe(4);
    expect(numbersOf(byId(rows, harbour))).toEqual(wantHarbour);
    expect(numbersOf(byId(rows, ridge))).toEqual(wantRidge);
    expect(byId(rows, harbour).name).toBe(LONG_NAME);

    // `sponsors.click_count` is NOT where link clicks come from: a bump with no click row changes nothing.
    await sql`update sponsors set click_count = click_count + 100 where id = ${harbour}`;
    expect(byId(await sponsorOverview(auth, auth.orgId, LAST_30, NOW), harbour).linkClicks).toBe(wantHarbour.linkClicks);

    // This year sees the day-before rows too (they are in 2026), and the after-window click.
    const year = await sponsorOverview(auth, auth.orgId, THIS_YEAR, NOW);
    expect(numbersOf(byId(year, harbour))).toEqual(expectedFor(airings.filter((a) => a.sponsorId === harbour), clicks.filter((c) => c.sponsorId === harbour), inWindow(YEAR_FROM, YEAR_TO)));
    expect(byId(year, harbour).timesShown, "premise: the year adds the day-before airing").toBe(5);
  });

  it("the bounds: half-open [from, to) in both tables - a row exactly at `from` counts, one exactly at `to` does not (Last 30 days AND This year)", async () => {
    const auth = await org();
    const sponsorId = await sponsorRow(auth.orgId, "Edge Ltd");
    const cases: { period: SponsorPeriod; from: Date; to: Date }[] = [
      { period: LAST_30, from: L30_FROM, to: L30_TO },
      { period: THIS_YEAR, from: YEAR_FROM, to: YEAR_TO },
    ];
    let checked = 0;
    for (const c of cases) {
      const before = byId(await sponsorOverview(auth, auth.orgId, c.period, NOW), sponsorId);
      // Exactly at `from`: in.
      await airing(auth.orgId, { sponsorId, name: "Edge Ltd", start: c.from, end: new Date(c.from.getTime() + 8 * SEC) });
      await click(auth.orgId, { sponsorId, at: c.from });
      // Exactly at `to`: out. One millisecond before `to`: in.
      await airing(auth.orgId, { sponsorId, name: "Edge Ltd", start: c.to, end: new Date(c.to.getTime() + 15 * SEC) });
      await click(auth.orgId, { sponsorId, at: c.to });
      await airing(auth.orgId, { sponsorId, name: "Edge Ltd", start: new Date(c.to.getTime() - 1), end: new Date(c.to.getTime() - 1 + 4 * SEC) });
      await click(auth.orgId, { sponsorId, at: new Date(c.to.getTime() - 1) });
      const after = byId(await sponsorOverview(auth, auth.orgId, c.period, NOW), sponsorId);
      expect(after.timesShown - before.timesShown, `${c.period.kind}: the from-row and the just-before-to row`).toBe(2);
      expect(after.onScreenMs - before.onScreenMs, `${c.period.kind}: 8 s + 4 s, never the to-row's 15 s`).toBe(12_000);
      expect(after.linkClicks! - before.linkClicks!, `${c.period.kind}: two clicks`).toBe(2);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("now, not the clock: Last 30 days is relative to the `now` argument - the same rows read in and out as `now` moves", async () => {
    const auth = await org();
    const sponsorId = await sponsorRow(auth.orgId, "Moving Ltd");
    // 2026-06-15 is far from the wall clock this suite runs on; a Date.now() inside would see none of it.
    await airing(auth.orgId, { sponsorId, name: "Moving Ltd", start: at("2026-06-15T09:00:00.000Z"), end: at("2026-06-15T09:00:08.000Z") });
    await click(auth.orgId, { sponsorId, at: at("2026-06-15T09:00:01.000Z") });
    const read = async (now: string) => numbersOf(byId(await sponsorOverview(auth, auth.orgId, LAST_30, at(now)), sponsorId));
    expect(await read("2026-06-15T12:00:00.000Z"), "today").toEqual({ timesShown: 1, onScreenMs: 8_000, linkClicks: 1 });
    expect(await read("2026-07-14T23:59:59.999Z"), "29 days later: the window still opens on 15 June").toEqual({ timesShown: 1, onScreenMs: 8_000, linkClicks: 1 });
    expect(await read("2026-07-15T00:00:00.000Z"), "30 days later: it has left the window").toEqual({ timesShown: 0, onScreenMs: 0, linkClicks: 0 });
    expect(await read("2026-06-14T23:59:59.999Z"), "the day before: not yet in it").toEqual({ timesShown: 0, onScreenMs: 0, linkClicks: 0 });
  });

  it("open airings: an airing with no end counts in Times shown and adds NOTHING to On screen (S14's rule too)", async () => {
    const auth = await org();
    const sponsorId = await sponsorRow(auth.orgId, "Open Ltd");
    const closed: SeededAiring = { sponsorId, name: "Open Ltd", start: at("2026-06-10T10:00:00.000Z"), end: at("2026-06-10T10:00:15.000Z") };
    const open: SeededAiring = { sponsorId, name: "Open Ltd", start: at("2026-06-10T11:00:00.000Z"), end: null };
    await airing(auth.orgId, closed);
    await airing(auth.orgId, open);
    const row = byId(await sponsorOverview(auth, auth.orgId, LAST_30, NOW), sponsorId);
    expect(row.timesShown, "both are showings").toBe(2);
    expect(row.onScreenMs, "only the closed one's 15 s").toBe(15_000);
  });

  it("an inverted row: an end before its start (no writer makes one; the table has no check) adds nothing, and never subtracts", async () => {
    const auth = await org();
    const sponsorId = await sponsorRow(auth.orgId, "Inverted Ltd");
    await airing(auth.orgId, { sponsorId, name: "Inverted Ltd", start: at("2026-06-10T10:00:00.000Z"), end: at("2026-06-10T10:00:08.000Z") });
    await airing(auth.orgId, { sponsorId, name: "Inverted Ltd", start: at("2026-06-11T10:00:30.000Z"), end: at("2026-06-11T10:00:00.000Z") });
    const row = byId(await sponsorOverview(auth, auth.orgId, LAST_30, NOW), sponsorId);
    expect(row.timesShown).toBe(2);
    expect(row.onScreenMs, "8 s, not 8 s − 30 s").toBe(8_000);
  });

  it("viewer impressions and peak viewers are null in PR A for every row, aired or not - the card shows a dash, never 0", async () => {
    const auth = await org();
    const aired = await sponsorRow(auth.orgId, "Aired Ltd");
    await sponsorRow(auth.orgId, "Quiet Ltd");
    await airing(auth.orgId, { sponsorId: aired, name: "Aired Ltd", start: at("2026-06-10T10:00:00.000Z"), end: at("2026-06-10T10:00:08.000Z") });
    const rows = await sponsorOverview(auth, auth.orgId, LAST_30, NOW);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.viewerImpressions, r.name).toBeNull();
      expect(r.peakViewers, r.name).toBeNull();
    }
  });

  it("Review Focus 4: a deleted sponsor's airings still appear under sponsor_name - no sponsor id (no live link), its clicks unknown (null), a live sponsor keeps its CURRENT name", async () => {
    const auth = await org();
    const gone = await sponsorRow(auth.orgId, "Gone Bakery", { tier: "title" });
    const kept = await sponsorRow(auth.orgId, "Kept Motors", { tier: "partner" });
    const goneAirings: SeededAiring[] = [
      { sponsorId: gone, name: "Gone Bakery", start: at("2026-06-01T10:00:00.000Z"), end: at("2026-06-01T10:00:08.000Z") },
      { sponsorId: gone, name: "Gone Bakery", source: "scene", start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:10.000Z") },
    ];
    for (const a of goneAirings) await airing(auth.orgId, a);
    await click(auth.orgId, { sponsorId: gone, at: at("2026-06-01T10:00:05.000Z") });
    // The kept sponsor aired under an OLD name, then was renamed: the live row reads the sponsor's name now.
    await airing(auth.orgId, { sponsorId: kept, name: "Kept Motors (old name)", start: at("2026-06-03T10:00:00.000Z"), end: at("2026-06-03T10:00:15.000Z") });

    await deleteSponsor(auth, gone);
    const [still] = await sql<{ n: number }[]>`select count(*)::int as n from sponsor_airings where org_id = ${auth.orgId} and sponsor_id is null`;
    expect(still!.n, "premise (R16): the airings survived the delete, sponsor id set null").toBe(2);

    const rows = await sponsorOverview(auth, auth.orgId, LAST_30, NOW);
    const goneRow = rows.find((r) => r.sponsorId === null);
    expect(goneRow, "the deleted sponsor still has a row").toBeDefined();
    expect(goneRow).toEqual({
      sponsorId: null, name: "Gone Bakery", viewerImpressions: null, peakViewers: null, linkClicks: null,
      ...(({ timesShown, onScreenMs }) => ({ timesShown, onScreenMs }))(expectedFor(goneAirings, [], inWindow(L30_FROM, L30_TO))),
    });
    expect(byId(rows, kept)).toMatchObject({ name: "Kept Motors", timesShown: 1, onScreenMs: 15_000, linkClicks: 0 });
    // Live sponsors lead, a deleted one follows - even a deleted Title sponsor under a live Partner.
    expect(rows.map((r) => r.sponsorId)).toEqual([kept, null]);

    // Two deleted sponsors are two rows, by their own names.
    const alsoGone = await sponsorRow(auth.orgId, "Also Gone Ltd");
    await airing(auth.orgId, { sponsorId: alsoGone, name: "Also Gone Ltd", start: at("2026-06-04T10:00:00.000Z"), end: at("2026-06-04T10:00:05.000Z") });
    await deleteSponsor(auth, alsoGone);
    const again = await sponsorOverview(auth, auth.orgId, LAST_30, NOW);
    expect(again.filter((r) => r.sponsorId === null).map((r) => [r.name, r.timesShown, r.onScreenMs])).toEqual([
      ["Also Gone Ltd", 1, 5_000],
      ["Gone Bakery", 2, 18_000],
    ]);
  });

  it("competition: only airings and clicks whose fixture is in THAT competition, with no time bound; a null-fixture click and the other competition's are excluded; its sponsor list is org-wide + its own", async () => {
    const auth = await org();
    const a = await competitionWithFixture(auth);
    const b = await competitionWithFixture(auth);
    expect(a.competitionId, "premise: two competitions").not.toBe(b.competitionId);
    const wide = await sponsorRow(auth.orgId, "Org Wide Ltd");
    const ownA = await sponsorRow(auth.orgId, "Cup A Printers", { competitionId: a.competitionId });
    const ownB = await sponsorRow(auth.orgId, "Cup B Printers", { competitionId: b.competitionId });
    const airings: SeededAiring[] = [
      { sponsorId: wide, name: "Org Wide Ltd", fixtureId: a.fixtureId, start: at("2024-03-01T10:00:00.000Z"), end: at("2024-03-01T10:00:08.000Z") }, // two years back: no time bound
      { sponsorId: wide, name: "Org Wide Ltd", fixtureId: a.fixtureId, start: at("2026-06-01T10:00:00.000Z"), end: at("2026-06-01T10:00:15.000Z") },
      { sponsorId: wide, name: "Org Wide Ltd", fixtureId: b.fixtureId, start: at("2026-06-01T11:00:00.000Z"), end: at("2026-06-01T11:00:15.000Z") },
      { sponsorId: wide, name: "Org Wide Ltd", fixtureId: null, start: at("2026-06-01T12:00:00.000Z"), end: at("2026-06-01T12:00:15.000Z") },
      { sponsorId: ownA, name: "Cup A Printers", fixtureId: a.fixtureId, start: at("2026-06-02T10:00:00.000Z"), end: at("2026-06-02T10:00:10.000Z") },
    ];
    const clicks: SeededClick[] = [
      { sponsorId: wide, fixtureId: a.fixtureId, source: "match", at: at("2025-01-01T10:00:00.000Z") },
      { sponsorId: wide, fixtureId: a.fixtureId, source: "stream", at: at("2026-06-01T10:00:00.000Z") },
      { sponsorId: wide, fixtureId: b.fixtureId, source: "stream", at: at("2026-06-01T10:00:00.000Z") },
      { sponsorId: wide, fixtureId: null, source: "site", at: at("2026-06-01T10:00:00.000Z") },
    ];
    for (const x of airings) await airing(auth.orgId, x);
    for (const c of clicks) await click(auth.orgId, c);
    const inA = (r: { fixtureId: string | null }) => r.fixtureId === a.fixtureId;

    const rows = await sponsorOverview(auth, auth.orgId, { kind: "competition", competitionId: a.competitionId }, NOW);
    expect(numbersOf(byId(rows, wide))).toEqual(expectedFor(airings.filter((x) => x.sponsorId === wide), clicks.filter((c) => c.sponsorId === wide), inA));
    expect(numbersOf(byId(rows, wide)), "premise: two airings (8 s + 15 s) and two clicks, one from two years back").toEqual({ timesShown: 2, onScreenMs: 23_000, linkClicks: 2 });
    expect(numbersOf(byId(rows, ownA))).toEqual({ timesShown: 1, onScreenMs: 10_000, linkClicks: 0 });
    expect(rows.map((r) => r.sponsorId).sort(), "the other competition's own sponsor is not listed").toEqual([wide, ownA].sort());
    expect(rows.some((r) => r.sponsorId === ownB)).toBe(false);

    // And the other way round: competition B sees its own.
    const rowsB = await sponsorOverview(auth, auth.orgId, { kind: "competition", competitionId: b.competitionId }, NOW);
    expect(numbersOf(byId(rowsB, wide))).toEqual({ timesShown: 1, onScreenMs: 15_000, linkClicks: 1 });
    expect(rowsB.map((r) => r.sponsorId).sort()).toEqual([wide, ownB].sort());
  });

  it("empty: no sponsor => []; sponsors with no airings => every row reads zeros (viewers null); a second call reads the same", async () => {
    const auth = await org();
    expect(await sponsorOverview(auth, auth.orgId, THIS_YEAR, NOW), "no sponsor at all").toEqual([]);
    const s1 = await sponsorRow(auth.orgId, "First Ltd", { tier: "gold", order: 1 });
    const s2 = await sponsorRow(auth.orgId, "Second Ltd", { tier: "title", order: 5 });
    const s3 = await sponsorRow(auth.orgId, "Third Ltd", { tier: "gold", order: 0 });
    let checked = 0;
    for (const p of [THIS_YEAR, LAST_30]) {
      const rows = await sponsorOverview(auth, auth.orgId, p, NOW);
      // Tier-ranked, then display order - the order every sponsor list here uses (listSponsorRows).
      expect(rows.map((r) => r.sponsorId), p.kind).toEqual([s2, s3, s1]);
      for (const r of rows) {
        expect(r, `${p.kind} ${r.name}`).toEqual({ sponsorId: r.sponsorId, name: r.name, timesShown: 0, onScreenMs: 0, viewerImpressions: null, peakViewers: null, linkClicks: 0 });
        checked++;
      }
      expect(await sponsorOverview(auth, auth.orgId, p, NOW), `${p.kind}: a second call`).toEqual(rows);
    }
    expect(checked).toBe(6);
  });

  it("tenancy: another org's auth naming this org is 404; this org's overview never shows another org's rows; another org's competition is 404", async () => {
    const a = await org();
    const b = await org();
    const sa = await sponsorRow(a.orgId, "A Sponsor");
    const sb = await sponsorRow(b.orgId, "B Sponsor");
    await airing(a.orgId, { sponsorId: sa, name: "A Sponsor", start: at("2026-06-01T10:00:00.000Z"), end: at("2026-06-01T10:00:08.000Z") });
    await airing(b.orgId, { sponsorId: sb, name: "B Sponsor", start: at("2026-06-01T10:00:00.000Z"), end: at("2026-06-01T10:00:15.000Z") });
    await click(b.orgId, { sponsorId: sb, at: at("2026-06-01T10:00:01.000Z") });

    await expect(sponsorOverview(b, a.orgId, LAST_30, NOW)).rejects.toMatchObject({ status: 404, message: "organization not found" });
    const rowsA = await sponsorOverview(a, a.orgId, LAST_30, NOW);
    expect(rowsA.map((r) => r.sponsorId)).toEqual([sa]);
    expect(numbersOf(rowsA[0]!)).toEqual({ timesShown: 1, onScreenMs: 8_000, linkClicks: 0 });

    const bComp = await competitionWithFixture(b);
    const refused = sponsorOverview(a, a.orgId, { kind: "competition", competitionId: bComp.competitionId }, NOW);
    await expect(refused).rejects.toBeInstanceOf(HttpError);
    await expect(sponsorOverview(a, a.orgId, { kind: "competition", competitionId: bComp.competitionId }, NOW)).rejects.toMatchObject({ status: 404, message: "competition not found" });
  });

  it("R19: a viewer reads the Overview (read-only, never refused) - the same rows an owner reads", async () => {
    const owner = await org();
    const sponsorId = await sponsorRow(owner.orgId, "Read Only Ltd");
    await airing(owner.orgId, { sponsorId, name: "Read Only Ltd", start: at("2026-06-01T10:00:00.000Z"), end: at("2026-06-01T10:00:08.000Z") });
    const viewer: AuthCtx = { ...owner, role: "viewer" };
    const asViewer = await sponsorOverview(viewer, owner.orgId, LAST_30, NOW);
    expect(asViewer).toEqual(await sponsorOverview(owner, owner.orgId, LAST_30, NOW));
    expect(asViewer.length).toBe(1);
  });

  it("the seam: a REAL S10 stream click (minted code -> resolveSponsorLink -> recordClick) and a REAL S8 airing (the carousel's own lines -> RelayAiring -> recordAirings, start then end) are what the Overview reads", async () => {
    const rig = await streamRig();
    const auth: AuthCtx = { orgId: rig.orgId, via: "session", userId: rig.createdBy, role: "owner", keyId: null };
    const fixtureId = rig.fixtureIds[0]!;
    const sessionId = await rig.session(fixtureId, "live");
    const [sp] = await sql<{ id: string }[]>`
      insert into sponsors (org_id, name, url, on_stream) values (${rig.orgId}, ${LONG_NAME}, 'https://harbourside.example', true) returning id`;
    const sponsorId = sp!.id;

    // S10: the code the stream prints, resolved the way /s/<code> resolves it, then the click writer.
    const code = await mintShortCode({ orgId: rig.orgId, sponsorId, fixtureId });
    expect(code, "premise: a sponsor with a url gets a code").not.toBeNull();
    const link = await resolveSponsorLink(code!, new URLSearchParams());
    expect(link?.tag, "premise: a code is a stream click for its fixture").toEqual({ fixtureId, source: "stream" });
    await recordClick(link!.sponsorId, link!.tag);

    // S8: the carousel's start and end lines, as the page logs them and SC1 forwards them, through the writer.
    const itemOf = (line: string): RelayAiring => {
      const space = line.indexOf(" ");
      const signal = line.slice(0, space);
      expect([SIGNAL_SPONSOR_START, SIGNAL_SPONSOR_END]).toContain(signal);
      return RelayAiring.parse({ kind: signal === SIGNAL_SPONSOR_START ? "start" : "end", ...(JSON.parse(line.slice(space + 1)) as object) });
    };
    const scene = SPONSOR_CAROUSEL_SCENES[0]!;
    const t0 = Date.now() - 60 * SEC;
    const showing = carouselStep(CAROUSEL_INITIAL, { now: t0, order: [sponsorId], yielding: false, scene });
    const on = carouselLines(null, showing, new Date(t0).toISOString());
    const t1 = t0 + 10 * SEC;
    const next = carouselStep(showing, { now: t1, order: [sponsorId], yielding: true, scene });
    const off = carouselLines(on.onAir, next, new Date(t1).toISOString());
    const session = { sessionId, orgId: rig.orgId, fixtureId };
    const wrote = await sql.begin((tx: Tx) => recordAirings(tx, session, [...on.lines, ...off.lines].map(itemOf), new Date(t1)));
    expect(wrote, "premise: the start and its end were both written").toMatchObject({ written: 2, refused: 0 });

    const [comp] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${fixtureId}`;
    let checked = 0;
    for (const p of [THIS_YEAR, LAST_30, { kind: "competition", competitionId: comp!.competition_id }] as SponsorPeriod[]) {
      const row = byId(await sponsorOverview(auth, rig.orgId, p, new Date()), sponsorId);
      expect(numbersOf(row), p.kind).toEqual({ timesShown: 1, onScreenMs: t1 - t0, linkClicks: 1 });
      expect(row.name).toBe(LONG_NAME);
      checked++;
    }
    expect(checked).toBe(3);
  });
});
