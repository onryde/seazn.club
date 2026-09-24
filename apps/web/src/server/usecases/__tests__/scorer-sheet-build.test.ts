// Scorer sheets §4.4 — the builder: a day's printable fixtures, their live
// scoring links and the organiser's language, as the renderer's model. Real
// use-cases end to end (the rig). Its own file because `ensureDeviceLinks` is
// wrapped by a pass-through mock (vi.mock hoists to the top of its FILE): the
// link-verification cases interpose between the links being ensured and the
// sheet being built — the revoke, the short answer — that no real request can
// time on purpose.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { msgFor } from "@/lib/messages-i18n";
import type { SlotLabelLookup } from "@/lib/slot-label";
import { seedOrg } from "./_seed";
import { fixturesOf, seedStage } from "./_sheets-rig";
import { createCourt, createVenue } from "../venues";
import { patchFixture } from "../fixtures";

vi.mock("../device-links", async (orig) => {
  const real = await orig<typeof import("../device-links")>();
  return { ...real, ensureDeviceLinks: vi.fn(real.ensureDeviceLinks) };
});

import { ensureDeviceLinks, hashDeviceLinkToken } from "../device-links";
import { buildScorerSheet, loadSheetCandidates } from "../scorer-sheets";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const DAY = "2026-09-23";
const fr: SlotLabelLookup = (k, v) => msgFor("fr", k, v);
const en: SlotLabelLookup = (k, v) => msgFor("en", k, v);
const realEnsure = (await vi.importActual<typeof import("../device-links")>("../device-links")).ensureDeviceLinks;

afterAll(async () => {
  // The rig stubs DEVICE_LINK_KEK once, at import: unstub in afterAll ONLY.
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function schedule(ids: string[], iso = `${DAY}T09:00:00Z`): Promise<void> {
  await sql`update fixtures set scheduled_at = ${iso}::timestamptz where id = any(${ids})`;
}

const tokenOf = (url: string) => url.split("/score/")[1]!;
const cards = (m: Awaited<ReturnType<typeof buildScorerSheet>>) => m.pages.flatMap((p) => p.rows);

describe.skipIf(!HAS_DB)("buildScorerSheet (scorer sheets §4.4)", () => {
  it("empty day → 422 NO_FIXTURES_ON_DAY, and nothing is minted", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    await schedule((await fixturesOf(stage.id)).map((f) => f.id)); // premise: another day HAS fixtures
    vi.mocked(ensureDeviceLinks).mockClear();
    await expect(buildScorerSheet(auth, competition.id, "2026-10-01", ORIGIN, "en", { printedAt: "x" })).rejects.toMatchObject({
      status: 422,
      code: "NO_FIXTURES_ON_DAY",
    });
    // Refused before the print path takes a single link lock.
    expect(vi.mocked(ensureDeviceLinks)).not.toHaveBeenCalled();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from device_links where org_id = ${auth.orgId}`;
    expect(n).toBe(0);
  });

  it("one card per printable fixture, each URL a live link of THAT fixture, named as the board names it, in the organiser's language and clock", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "knockout", ["A", "B", "C", "D"]);
    const fx = await fixturesOf(stage.id);
    await schedule(fx.map((f) => f.id));
    // 09:00Z is 11:00 in Paris on 23 September (CEST): the org clock, not UTC.
    await sql`update organizations set timezone = 'Europe/Paris' where id = ${auth.orgId}`;
    const m = await buildScorerSheet(auth, competition.id, DAY, ORIGIN, "fr", { printedAt: "2026-09-23 08:00" });
    const rows = cards(m);
    expect(rows.map((r) => r.fixtureId).sort()).toEqual(fx.map((f) => f.id).sort());

    expect(m.header).toMatchObject({ kind: "scoresheet", title: competition.name, meta: { printedAt: "2026-09-23 08:00" } });
    expect(m.header.description).toContain("23 septembre");
    expect(m.labels).toEqual({ eyebrow: msgFor("fr", "sheets.pdf.eyebrow"), checkNames: msgFor("fr", "sheets.pdf.checkNames") });
    expect(m.pages.map((p) => p.heading)).toEqual([
      msgFor("fr", "sheets.pdf.courtPage", { court: msgFor("fr", "sheets.pdf.noCourt"), n: 1, of: 1 }),
    ]);

    // Every printed name is the loader's (the board's namer): the code, the
    // division, a person or — for the final — "Vainqueur de …".
    const candidates = new Map((await loadSheetCandidates(auth, competition.id, fr, DAY)).map((c) => [c.id, c]));
    for (const r of rows) {
      const c = candidates.get(r.fixtureId)!;
      expect(r).toMatchObject({
        time: "11:00",
        matchRef: c.match_ref,
        division: c.division_name,
        home: c.home?.name ?? c.home_tbd,
        away: c.away?.name ?? c.away_tbd,
        homeTbd: c.home === null,
        awayTbd: c.away === null,
        homePair: [],
        awayPair: [],
      });
    }
    const final = rows.find((r) => r.fixtureId === fx.find((f) => f.round_no === 2)!.id)!;
    expect([final.homeTbd, final.awayTbd]).toEqual([true, true]);
    expect(final.home).not.toBe((await loadSheetCandidates(auth, competition.id, en, DAY)).find((c) => c.id === final.fixtureId)!.home_tbd);

    for (const r of rows) {
      expect(r.url.startsWith(`${ORIGIN}/score/`)).toBe(true);
      const [link] = await sql<{ fixture_id: string; revoked_at: string | null }[]>`
        select fixture_id, revoked_at from device_links where token_hash = ${hashDeviceLinkToken(tokenOf(r.url))}`;
      expect([link?.fixture_id, link?.revoked_at]).toEqual([r.fixtureId, null]);
    }
  });

  it("a second build carries the SAME urls (a sheet on court stays alive)", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    await schedule((await fixturesOf(stage.id)).map((f) => f.id));
    const urls = async () =>
      cards(await buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" }))
        .map((r) => r.url)
        .sort();
    expect(await urls()).toEqual(await urls());
  });

  it("a court's tenth match spills to its own second page: 9 + 1, headed page 1 of 2 and page 2 of 2", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D", "E"]);
    const fx = await fixturesOf(stage.id);
    expect(fx).toHaveLength(10); // premise: a five-entrant league is ten matches
    const hall = await createVenue(auth, { name: "Hall", sort: 0 });
    const court = await createCourt(auth, hall.id, { name: "Court 1", sort: 0, tags: [] });
    for (const [i, f] of fx.entries()) {
      await patchFixture(auth, f.id, { court_id: court.id });
      await schedule([f.id], new Date(Date.UTC(2026, 8, 23, 8, i * 20)).toISOString());
    }
    const m = await buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" });
    const court1 = (await loadSheetCandidates(auth, competition.id, en, DAY))[0]!.court_name!;
    expect(m.pages.map((p) => [p.heading, p.rows.length])).toEqual([
      [msgFor("en", "sheets.pdf.courtPage", { court: court1, n: 1, of: 2 }), 9],
      [msgFor("en", "sheets.pdf.courtPage", { court: court1, n: 2, of: 2 }), 1],
    ]);
  });

  it("a pair prints its two members, one per line; a team prints its name alone", async () => {
    const { auth } = await seedOrg("pro");
    const pairs = await seedStage(auth, "league", ["P1", "P2"], {}, {
      entrantKind: "pair",
      members: (n) => [`${n} Ana`, `${n} Ben`],
    });
    const teams = await seedStage(auth, "league", ["T1", "T2"], {}, {
      entrantKind: "team",
      members: (n) => [`${n} Zed`, `${n} Ann`, `${n} Bob`],
    });
    await schedule((await fixturesOf(pairs.stage.id)).map((f) => f.id));
    await schedule((await fixturesOf(teams.stage.id)).map((f) => f.id));
    const [pair] = cards(await buildScorerSheet(auth, pairs.competition.id, DAY, ORIGIN, "en", { printedAt: "x" }));
    const [team] = cards(await buildScorerSheet(auth, teams.competition.id, DAY, ORIGIN, "en", { printedAt: "x" }));
    const members = (side: string) => [`${side} Ana`, `${side} Ben`];
    expect([pair!.homePair, pair!.awayPair].map((p) => [...p].sort())).toEqual(
      [pair!.home.includes("P1") ? members("P1") : members("P2"), pair!.away.includes("P1") ? members("P1") : members("P2")].map((p) => [...p].sort()),
    );
    expect(pair!.home).toBe(pair!.homePair.join(" / ")); // the same order the name uses
    expect([team!.homePair, team!.awayPair]).toEqual([[], []]);
    expect([team!.home, team!.away].sort()).toEqual(["T1", "T2"]);
  });

  it("a fixture finished between choosing the rows and ensuring the links is left off — the rest still print, no 422", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const fx = await fixturesOf(stage.id);
    await schedule(fx.map((f) => f.id));
    const gone = fx[0]!.id;
    vi.mocked(ensureDeviceLinks).mockImplementationOnce(async (a, c, ids) => {
      expect(ids).toContain(gone); // premise: it WAS chosen
      await sql`update fixtures set status = 'finalized' where id = ${gone}`;
      return realEnsure(a, c, ids);
    });
    const rows = cards(await buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" }));
    expect(rows.map((r) => r.fixtureId).sort()).toEqual(fx.slice(1).map((f) => f.id).sort());
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${gone}`;
    expect(n).toBe(0);
  });

  it("every chosen fixture finished before its link was ensured → 422 NO_FIXTURES_ON_DAY, never an empty sheet", async () => {
    const { auth } = await seedOrg("pro");
    const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
    const fx = await fixturesOf(stage.id);
    await schedule(fx.map((f) => f.id));
    vi.mocked(ensureDeviceLinks).mockImplementationOnce(async (a, c, ids) => {
      expect([...ids].sort()).toEqual(fx.map((f) => f.id).sort()); // premise: all WERE chosen
      await sql`update fixtures set status = 'finalized' where id = any(${[...ids]})`;
      return realEnsure(a, c, ids);
    });
    await expect(buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" })).rejects.toMatchObject({
      status: 422,
      code: "NO_FIXTURES_ON_DAY",
    });
  });

  describe("every card's link is checked before anything is printed — any miss refuses the whole sheet", () => {
    const refusal = (locale: "en" | "fr") => ({
      status: 500,
      code: "SHEET_LINKS_INCOMPLETE",
      message: msgFor(locale, "sheets.error.linksIncomplete"),
    });

    async function rig() {
      const { auth } = await seedOrg("pro");
      const { competition, stage } = await seedStage(auth, "league", ["A", "B", "C", "D"]);
      const fx = await fixturesOf(stage.id);
      await schedule(fx.map((f) => f.id));
      return { auth, competition, fx };
    }

    it("control: the same rig, untouched, prints every card", async () => {
      const { auth, competition, fx } = await rig();
      const rows = cards(await buildScorerSheet(auth, competition.id, DAY, ORIGIN, "fr", { printedAt: "x" }));
      expect(rows).toHaveLength(fx.length);
    });

    it("a link revoked after it was ensured → 500 SHEET_LINKS_INCOMPLETE, in the organiser's language", async () => {
      const { auth, competition, fx } = await rig();
      vi.mocked(ensureDeviceLinks).mockImplementationOnce(async (a, c, ids) => {
        const links = await realEnsure(a, c, ids);
        await sql`update device_links set revoked_at = now() where fixture_id = ${fx[1]!.id} and revoked_at is null`;
        return links;
      });
      await expect(buildScorerSheet(auth, competition.id, DAY, ORIGIN, "fr", { printedAt: "x" })).rejects.toMatchObject(refusal("fr"));
    });

    it("a link that expired after it was ensured → 500 (the scoring door would refuse it)", async () => {
      const { auth, competition, fx } = await rig();
      vi.mocked(ensureDeviceLinks).mockImplementationOnce(async (a, c, ids) => {
        const links = await realEnsure(a, c, ids);
        await sql`
          update device_links set expires_at = now() - interval '1 minute'
          where fixture_id = ${fx[1]!.id} and revoked_at is null`;
        return links;
      });
      await expect(buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" })).rejects.toMatchObject(refusal("en"));
    });

    it("a fixture deleted after its link was ensured → 500 (no card for a match that is gone)", async () => {
      const { auth, competition, fx } = await rig();
      vi.mocked(ensureDeviceLinks).mockImplementationOnce(async (a, c, ids) => {
        const links = await realEnsure(a, c, ids);
        await sql`delete from fixtures where id = ${fx[1]!.id}`;
        return links;
      });
      await expect(buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" })).rejects.toMatchObject(refusal("en"));
    });

    it("links ensured one short, for a fixture still in play → 500 (never a card without a code)", async () => {
      const { auth, competition, fx } = await rig();
      vi.mocked(ensureDeviceLinks).mockImplementationOnce(async (a, c, ids) => {
        const links = await realEnsure(a, c, ids);
        links.delete(fx[2]!.id);
        return links;
      });
      await expect(buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" })).rejects.toMatchObject(refusal("en"));
    });

    it("a secret that is not its own fixture's live link → 500 (a QR must open the match it is printed on)", async () => {
      const { auth, competition, fx } = await rig();
      vi.mocked(ensureDeviceLinks).mockImplementationOnce(async (a, c, ids) => {
        const links = await realEnsure(a, c, ids);
        const [x, y] = [links.get(fx[0]!.id)!, links.get(fx[1]!.id)!];
        links.set(fx[0]!.id, { ...x, secret: y.secret });
        links.set(fx[1]!.id, { ...y, secret: x.secret });
        return links;
      });
      await expect(buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" })).rejects.toMatchObject(refusal("en"));
    });

    it("two live links on one fixture → 500 (which one the QR opens would be a guess)", async () => {
      const { auth, competition, fx } = await rig();
      vi.mocked(ensureDeviceLinks).mockImplementationOnce(async (a, c, ids) => {
        const links = await realEnsure(a, c, ids);
        await sql`
          insert into device_links (org_id, fixture_id, token_hash, label, issued_by, expires_at)
          values (${auth.orgId}, ${fx[3]!.id}, ${hashDeviceLinkToken(`dl_extra_${randomUUID()}`)}, null, ${auth.userId}, null)`;
        return links;
      });
      await expect(buildScorerSheet(auth, competition.id, DAY, ORIGIN, "en", { printedAt: "x" })).rejects.toMatchObject(refusal("en"));
    });
  });
});
