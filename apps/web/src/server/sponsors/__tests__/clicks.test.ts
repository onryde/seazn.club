// R4 sponsors on stream, S10 — click attribution (spec 2026-10-27 §3.7; owner rulings D15 and R7; the controller's
// 2026-10-31 addenda). Two halves, both against real Postgres:
//   • `resolveSponsorLink` — what `/s/[key]` redirects to. One route, two shapes told apart by SHAPE (a sponsor uuid
//     with `?f=&src=`, or an R7 short code that IS its tag), and the target is only ever the sponsor row's stored
//     http(s) url.
//   • `recordClick` — the tail write: `click_count + 1` and one `sponsor_clicks` row, in ONE statement, with `f` kept
//     only when it is a fixture of the sponsor's own org.
//
// Where the expected values come from: the short-code alphabet and lengths from lib/sponsor-short-code.ts and the codes
// S5's own `drawShortCode` draws; the tag grammar from §3.7 (`f` must be the sponsor's org's, `src` an enum, else
// `unknown`); the redirect rule (http(s) only, an active sponsor only) from the addenda. Never from the code under test.
//
// The transitions (TEST-STRATEGY rule 1), and where each is pinned:
//   empty: no tag at all; a key of neither shape; a code nobody minted ......... "empty", "dispatch"
//   a second click (same tag, same code) ...................................... "twice"
//   withdrawal: a sponsor deactivated, then reactivated (both directions) ...... "active"
//   the stored url changed, or never http(s) ................................... "target"
//   another org's fixture on a sponsor's link; a forged code row ............... "org"
// Single-sport on purpose: neither half reads a sport — a fixture is only an id and an org here.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, statementCount } from "@/lib/db";
import { classifySponsorLink, parseClickTag } from "@/lib/sponsor-clicks";
import { SPONSOR_SHORT_CODE_MAX_LENGTH, SPONSOR_SHORT_CODE_MIN_LENGTH } from "@/lib/sponsor-short-code";
import { drawShortCode, mintShortCode } from "../short-codes";
import { recordClick, redirectTarget, resolveSponsorLink } from "../clicks";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const GENERIC_DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Rig {
  orgId: string;
  fixtureIds: [string, string];
}
const orgs: string[] = [];

/** An org with two fixtures (one division, one stage). Nothing else: clicks read no sport and no roster. */
async function rig(): Promise<Rig> {
  const s = uniq();
  await sql`insert into sports (key, name, module_version, position_catalog) values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${`S10 Org ${s}`}, ${`s10-org-${s}`}) returning id`;
  orgs.push(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status) values (${orgId}, ${`S10 ${s}`}, ${`s10-${s}`}, 'public', 'live') returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${`open-${s}`}, 'generic', 'score', 'active', ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq) values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const fx = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${orgId}, ${divisionId}, ${stageId}, 1, 1, 1), (${orgId}, ${divisionId}, ${stageId}, 2, 1, 2) returning id`;
  return { orgId, fixtureIds: [fx[0]!.id, fx[1]!.id] };
}

async function sponsor(orgId: string, o: { url?: string | null; status?: string } = {}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, url, status)
    values (${orgId}, ${`Sponsor ${uniq()}`}, ${o.url === undefined ? "https://sponsor.example/offer" : o.url}, ${o.status ?? "active"})
    returning id`;
  return row!.id;
}

const clicksOf = (sponsorId: string) => sql<{ org_id: string; fixture_id: string | null; source: string }[]>`
  select org_id, fixture_id, source from sponsor_clicks where sponsor_id = ${sponsorId} order by at, id`;
const countOf = async (sponsorId: string) =>
  (await sql<{ click_count: number }[]>`select click_count from sponsors where id = ${sponsorId}`)[0]!.click_count;

/** The statements `fn` sends, and its result. Nothing else runs in this file meanwhile (no deferred work here). */
async function counted<T>(fn: () => Promise<T>): Promise<{ statements: number; value: T }> {
  const before = statementCount();
  const value = await fn();
  return { statements: statementCount() - before, value };
}

const q = (o: Record<string, string> = {}) => new URLSearchParams(o);

describe("redirectTarget — the stored url, http(s) only (addendum: no open redirect)", () => {
  it("http and https pass, normalised by the URL parser", () => {
    expect(redirectTarget("https://sponsor.example/offer?x=1")).toBe("https://sponsor.example/offer?x=1");
    expect(redirectTarget("http://sponsor.example")).toBe("http://sponsor.example/");
    expect(redirectTarget("HTTPS://Sponsor.Example/Offer")).toBe("https://sponsor.example/Offer");
  });

  it("every other scheme, a relative or protocol-relative url, and no url at all are refused (count reported)", () => {
    const refused = [
      "javascript:alert(1)", "JavaScript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)", "ftp://sponsor.example/file", "mailto:hello@sponsor.example", "file:///etc/passwd",
      "//evil.example/x", "/s/elsewhere", "sponsor.example", "", "   ", null,
    ];
    for (const url of refused) expect(redirectTarget(url), JSON.stringify(url)).toBeNull();
    expect(refused.length, "refusals checked").toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("resolveSponsorLink — one route, two shapes (S10, R7)", () => {
  it("dispatch: a sponsor uuid reads that sponsor (ONE statement) and keeps the link's own tag", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const query = q({ f: r.fixtureIds[0], src: "match" });
    const { statements, value } = await counted(() => resolveSponsorLink(id, query));
    expect(value).toEqual({ sponsorId: id, url: "https://sponsor.example/offer", tag: parseClickTag(query) });
    expect(statements, "one read, no code lookup").toBe(1);
  });

  it("dispatch: a short code reads its (sponsor, fixture) in ONE statement, as `stream`; its query is ignored", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const code = await mintShortCode({ orgId: r.orgId, sponsorId: id, fixtureId: r.fixtureIds[0] });
    expect(code, "premise: S5 minted a code for a sponsor with a url").not.toBeNull();
    // A query that tries to re-tag the click: another fixture, another source. The code is the whole tag.
    const { statements, value } = await counted(() => resolveSponsorLink(code!, q({ f: r.fixtureIds[1], src: "site" })));
    expect(value).toEqual({ sponsorId: id, url: "https://sponsor.example/offer", tag: { fixtureId: r.fixtureIds[0], source: "stream" } });
    expect(statements, "one read, no sponsor-id lookup").toBe(1);
  });

  it("dispatch: S5's own draws classify as codes at every declared length (count reported)", () => {
    let checked = 0;
    for (let len = SPONSOR_SHORT_CODE_MIN_LENGTH; len <= SPONSOR_SHORT_CODE_MAX_LENGTH; len++) {
      for (let k = 0; k < 50; k++) {
        const code = drawShortCode(len);
        expect(classifySponsorLink(code), code).toEqual({ kind: "code", code });
        checked++;
      }
    }
    expect(checked).toBe((SPONSOR_SHORT_CODE_MAX_LENGTH - SPONSOR_SHORT_CODE_MIN_LENGTH + 1) * 50);
  });

  it("empty: a key of neither shape is null WITHOUT a query — never both lookups tried (count reported)", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const code = (await mintShortCode({ orgId: r.orgId, sponsorId: id, fixtureId: r.fixtureIds[0] }))!;
    // Each is one edit away from a live key: the code lowercased, the uuid with a character more, the code with one.
    const keys = [code.toLowerCase(), `${id}x`, `${code}${"2".repeat(SPONSOR_SHORT_CODE_MAX_LENGTH)}`, "not-a-uuid", ""];
    for (const key of keys) {
      const { statements, value } = await counted(() => resolveSponsorLink(key, q()));
      expect(value, JSON.stringify(key)).toBeNull();
      expect(statements, `${JSON.stringify(key)}: no lookup`).toBe(0);
    }
    expect(keys.length).toBe(5);
  });

  it("empty: a code-shaped key nobody minted, and a uuid that is no sponsor, are null", async () => {
    expect(await resolveSponsorLink(drawShortCode(SPONSOR_SHORT_CODE_MAX_LENGTH), q())).toBeNull();
    expect(await resolveSponsorLink(randomUUID(), q())).toBeNull();
  });

  it("active: a pending or inactive sponsor is null on both shapes; reactivated, both resolve again", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const code = (await mintShortCode({ orgId: r.orgId, sponsorId: id, fixtureId: r.fixtureIds[0] }))!;
    for (const status of ["inactive", "pending"]) {
      await sql`update sponsors set status = ${status} where id = ${id}`;
      expect(await resolveSponsorLink(id, q()), `${status}: uuid`).toBeNull();
      expect(await resolveSponsorLink(code, q()), `${status}: code`).toBeNull();
    }
    // The other direction: a withdrawal undone is a live link again, the same code included.
    await sql`update sponsors set status = 'active' where id = ${id}`;
    expect((await resolveSponsorLink(id, q()))?.sponsorId).toBe(id);
    expect((await resolveSponsorLink(code, q()))?.sponsorId).toBe(id);
  });

  it("active: a deleted sponsor's code is gone with it (the code row cascades)", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const code = (await mintShortCode({ orgId: r.orgId, sponsorId: id, fixtureId: r.fixtureIds[0] }))!;
    await sql`delete from sponsors where id = ${id}`;
    expect(await resolveSponsorLink(code, q())).toBeNull();
  });

  it("target: the redirect follows the STORED url as it is now, and nothing the request carries", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const code = (await mintShortCode({ orgId: r.orgId, sponsorId: id, fixtureId: r.fixtureIds[0] }))!;
    const hostile = q({ url: "https://evil.example", next: "https://evil.example", redirect: "//evil.example", to: "javascript:alert(1)" });
    expect((await resolveSponsorLink(id, hostile))?.url).toBe("https://sponsor.example/offer");
    await sql`update sponsors set url = 'https://moved.example/new' where id = ${id}`;
    expect((await resolveSponsorLink(id, hostile))?.url).toBe("https://moved.example/new");
    expect((await resolveSponsorLink(code, hostile))?.url, "the code follows the edit too").toBe("https://moved.example/new");
  });

  it("target: a stored url that is not http(s) is null on both shapes; no url at all is null", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const code = (await mintShortCode({ orgId: r.orgId, sponsorId: id, fixtureId: r.fixtureIds[0] }))!;
    for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      await sql`update sponsors set url = ${url} where id = ${id}`;
      expect(await resolveSponsorLink(id, q()), `${url}: uuid`).toBeNull();
      expect(await resolveSponsorLink(code, q()), `${url}: code`).toBeNull();
    }
    await sql`update sponsors set url = null where id = ${id}`;
    expect(await resolveSponsorLink(id, q())).toBeNull();
    expect(await resolveSponsorLink(code, q())).toBeNull();
  });

  it("org: a code row whose sponsor is another org's is null (the mint refuses it; the read still checks)", async () => {
    const mine = await rig();
    const theirs = await rig();
    const theirSponsor = await sponsor(theirs.orgId);
    const forged = drawShortCode(SPONSOR_SHORT_CODE_MAX_LENGTH);
    // The DB has no composite FK, so only a direct write can make this row — which is exactly why the read checks.
    await sql`insert into sponsor_short_codes (code, org_id, sponsor_id, fixture_id) values (${forged}, ${mine.orgId}, ${theirSponsor}, ${mine.fixtureIds[0]})`;
    expect(await resolveSponsorLink(forged, q())).toBeNull();
    // Positive pair: the same sponsor's own code resolves.
    const own = (await mintShortCode({ orgId: theirs.orgId, sponsorId: theirSponsor, fixtureId: theirs.fixtureIds[0] }))!;
    expect((await resolveSponsorLink(own, q()))?.sponsorId).toBe(theirSponsor);
  });
});

describe.skipIf(!HAS_DB)("recordClick — click_count + 1 and one row, in ONE statement (S10)", () => {
  it("an own-org fixture: the row keeps it and the source; the count moves by one; one statement", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const { statements } = await counted(() => recordClick(id, { fixtureId: r.fixtureIds[0], source: "match" }));
    expect(statements, "one round trip").toBe(1);
    expect(await clicksOf(id)).toEqual([{ org_id: r.orgId, fixture_id: r.fixtureIds[0], source: "match" }]);
    expect(await countOf(id)).toBe(1);
  });

  it("org: another org's fixture is dropped AND the claim with it — fixture null, source `unknown`; still counted", async () => {
    const mine = await rig();
    const theirs = await rig();
    const id = await sponsor(mine.orgId);
    await recordClick(id, { fixtureId: theirs.fixtureIds[0], source: "match" });
    // The row is the SPONSOR's org's (the tenant whose report reads it), never the fixture's.
    expect(await clicksOf(id)).toEqual([{ org_id: mine.orgId, fixture_id: null, source: "unknown" }]);
    expect(await countOf(id)).toBe(1);
    // A uuid that is no fixture at all reads the same way.
    await recordClick(id, { fixtureId: randomUUID(), source: "stream" });
    expect((await clicksOf(id)).map((c) => [c.fixture_id, c.source])).toEqual([[null, "unknown"], [null, "unknown"]]);
  });

  it("empty: no fixture keeps the source it claimed (`site`); no tag at all is `unknown`", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    await recordClick(id, parseClickTag(q({ src: "site" })));
    await recordClick(id, parseClickTag(q()));
    await recordClick(id, parseClickTag(q({ f: r.fixtureIds[0], src: "bogus" })));
    expect((await clicksOf(id)).map((c) => [c.fixture_id, c.source])).toEqual([
      [null, "site"],
      [null, "unknown"],
      [r.fixtureIds[0], "unknown"],
    ]);
    expect(await countOf(id)).toBe(3);
  });

  it("twice: the same tag twice is two rows and two counts — clicks are events, not a set", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const tag = { fixtureId: r.fixtureIds[1], source: "stream" } as const;
    await recordClick(id, tag);
    await recordClick(id, tag);
    expect((await clicksOf(id)).map((c) => [c.fixture_id, c.source])).toEqual([
      [r.fixtureIds[1], "stream"],
      [r.fixtureIds[1], "stream"],
    ]);
    expect(await countOf(id)).toBe(2);
  });

  it("active: a sponsor deactivated before the tail write runs writes nothing — no row, no count; reactivated, it counts", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId, { status: "inactive" });
    await recordClick(id, { fixtureId: r.fixtureIds[0], source: "match" });
    expect(await clicksOf(id)).toEqual([]);
    expect(await countOf(id)).toBe(0);
    await sql`update sponsors set status = 'active' where id = ${id}`;
    await recordClick(id, { fixtureId: r.fixtureIds[0], source: "match" });
    expect(await clicksOf(id)).toHaveLength(1);
    expect(await countOf(id)).toBe(1);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const orgId of orgs) await sql`delete from organizations where id = ${orgId}`;
  await sql.end();
});
