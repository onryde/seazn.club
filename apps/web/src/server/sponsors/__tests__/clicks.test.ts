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
//   another COMPETITION's fixture on a competition-scoped sponsor's link ........ "competition" (fix round 1, m3)
//   the write failing ......................................................... "failure" (fix round 1, m4)
// Single-sport on purpose: neither half reads a sport — a fixture is only an id and an org here.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const sentry = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureError: sentry.captureError }));

import { sql, statementCount } from "@/lib/db";
import { classifySponsorLink, parseClickTag } from "@/lib/sponsor-clicks";
import { SPONSOR_SHORT_CODE_MAX_LENGTH, SPONSOR_SHORT_CODE_MIN_LENGTH } from "@/lib/sponsor-short-code";
import { log } from "@/server/logger";
import { drawShortCode, mintShortCode } from "../short-codes";
import { CLICK_BOT_UA, clientIpDigest, countsAsClick, recordClick, recordClickOnce, resolveSponsorLink } from "../clicks";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const GENERIC_DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

interface Rig {
  orgId: string;
  compId: string;
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
  return { orgId, compId, fixtureIds: [fx[0]!.id, fx[1]!.id] };
}

/** A second competition of the SAME org, with one fixture: the m3 case (same org, another competition). */
async function otherCompetitionFixture(orgId: string): Promise<{ compId: string; fixtureId: string }> {
  const s = uniq();
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status) values (${orgId}, ${`S10 Other ${s}`}, ${`s10-other-${s}`}, 'public', 'live') returning id`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${`open-${s}`}, 'generic', 'score', 'active', ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`
    insert into stages (org_id, division_id, kind, name, seq) values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round)
    values (${orgId}, ${divisionId}, ${stageId}, 1, 1, 1) returning id`;
  return { compId, fixtureId };
}

async function sponsor(
  orgId: string,
  o: { url?: string | null; status?: string; competitionId?: string | null } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, competition_id, name, url, status)
    values (${orgId}, ${o.competitionId ?? null}, ${`Sponsor ${uniq()}`},
            ${o.url === undefined ? "https://sponsor.example/offer" : o.url}, ${o.status ?? "active"})
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

// `redirectTarget` moved to lib/sponsor-clicks.ts in fix round 1 (m1: the boards and the write schemas read it too);
// its refusal list is pinned in lib/__tests__/sponsor-clicks.test.ts, and the route's own 404s for those urls below.

describe.skipIf(!HAS_DB)("resolveSponsorLink — one route, two shapes (S10, R7)", () => {
  it("dispatch: a sponsor uuid reads that sponsor (ONE statement) and keeps the link's own tag", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const query = q({ f: r.fixtureIds[0], src: "match" });
    const { statements, value } = await counted(() => resolveSponsorLink(id, query));
    expect(value).toEqual({ sponsorId: id, key: id, url: "https://sponsor.example/offer", tag: { fixtureId: r.fixtureIds[0], source: "match" } });
    expect(statements, "one read, no code lookup").toBe(1);
  });

  it("I1 (R7 \"a\"): a sponsor uuid claiming `stream` resolves as `unknown` — it still redirects, and still counts", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const link = await resolveSponsorLink(id, q({ f: r.fixtureIds[0], src: "stream" }));
    expect(link?.url, "it still redirects").toBe("https://sponsor.example/offer");
    expect(link?.tag).toEqual({ fixtureId: r.fixtureIds[0], source: "unknown" });
    await recordClick(link!.sponsorId, link!.tag);
    expect((await clicksOf(id)).map((c) => [c.fixture_id, c.source])).toEqual([[r.fixtureIds[0], "unknown"]]);
  });

  it("dispatch: a short code reads its (sponsor, fixture) in ONE statement, as `stream`; its query is ignored", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const code = await mintShortCode({ orgId: r.orgId, sponsorId: id, fixtureId: r.fixtureIds[0] });
    expect(code, "premise: S5 minted a code for a sponsor with a url").not.toBeNull();
    // A query that tries to re-tag the click: another fixture, another source. The code is the whole tag.
    const { statements, value } = await counted(() => resolveSponsorLink(code!, q({ f: r.fixtureIds[1], src: "site" })));
    expect(value).toEqual({ sponsorId: id, key: code, url: "https://sponsor.example/offer", tag: { fixtureId: r.fixtureIds[0], source: "stream" } });
    expect(statements, "one read, no sponsor-id lookup").toBe(1);
  });

  it("I2: the code typed in lowercase resolves to it — one statement, the stored (uppercase) code as its key", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    // Drawn until it has a letter, so lowercasing it changes it (a digits-only code has nothing to fold).
    let code: string | null = null;
    const draw = (len: number) => {
      let c = drawShortCode(len);
      while (c.toLowerCase() === c) c = drawShortCode(len);
      return c;
    };
    code = await mintShortCode({ orgId: r.orgId, sponsorId: id, fixtureId: r.fixtureIds[0] }, draw);
    expect(code!.toLowerCase(), "premise: the code has a letter").not.toBe(code);
    const { statements, value } = await counted(() => resolveSponsorLink(code!.toLowerCase(), q()));
    expect(value).toEqual({ sponsorId: id, key: code, url: "https://sponsor.example/offer", tag: { fixtureId: r.fixtureIds[0], source: "stream" } });
    expect(statements).toBe(1);
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
    // Each is one edit away from a live key: a misread letter (`o` folds to O, outside the alphabet), a non-ASCII
    // ligature that UPPERCASES into the code's letters, the uuid with a character more, the code with one.
    const keys = [`o${code.slice(1)}`, `\uFB00${code.slice(1)}`, `${id}x`, `${code}${"2".repeat(SPONSOR_SHORT_CODE_MAX_LENGTH)}`, "not-a-uuid", ""];
    for (const key of keys) {
      const { statements, value } = await counted(() => resolveSponsorLink(key, q()));
      expect(value, JSON.stringify(key)).toBeNull();
      expect(statements, `${JSON.stringify(key)}: no lookup`).toBe(0);
    }
    expect(keys.length).toBe(6);
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

describe.skipIf(!HAS_DB)("competition: a competition-scoped sponsor's `f` must be that competition's (fix round 1, m3)", () => {
  it("its own competition's fixture is kept; the same org's OTHER competition's is fixture null, `unknown`; still counted", async () => {
    const r = await rig();
    const other = await otherCompetitionFixture(r.orgId);
    const scoped = await sponsor(r.orgId, { competitionId: r.compId });
    await recordClick(scoped, { fixtureId: r.fixtureIds[0], source: "match" });
    await recordClick(scoped, { fixtureId: other.fixtureId, source: "match" });
    expect((await clicksOf(scoped)).map((c) => [c.fixture_id, c.source])).toEqual([
      [r.fixtureIds[0], "match"],
      [null, "unknown"],
    ]);
    expect(await countOf(scoped)).toBe(2);
  });

  it("an ORG-WIDE sponsor (no competition) keeps a fixture of any of its org's competitions", async () => {
    const r = await rig();
    const other = await otherCompetitionFixture(r.orgId);
    const orgWide = await sponsor(r.orgId);
    await recordClick(orgWide, { fixtureId: r.fixtureIds[0], source: "match" });
    await recordClick(orgWide, { fixtureId: other.fixtureId, source: "site" });
    expect((await clicksOf(orgWide)).map((c) => [c.fixture_id, c.source])).toEqual([
      [r.fixtureIds[0], "match"],
      [other.fixtureId, "site"],
    ]);
  });

  it("still one statement", async () => {
    const r = await rig();
    const scoped = await sponsor(r.orgId, { competitionId: r.compId });
    const { statements } = await counted(() => recordClick(scoped, { fixtureId: r.fixtureIds[1], source: "match" }));
    expect(statements).toBe(1);
  });
});

describe("which requests count as a click (fix round 1, I3)", () => {
  const req = (method: string, ua?: string) =>
    new Request("https://seazn.club/s/ABCD", { method, headers: ua === undefined ? {} : { "user-agent": ua } });
  const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  it("a person's GET counts — a browser's UA, or none at all", () => {
    expect(countsAsClick(req("GET", BROWSER))).toBe(true);
    expect(countsAsClick(req("GET"))).toBe(true);
  });

  it("HEAD (Next answers it from GET) and any other method never count", () => {
    for (const method of ["HEAD", "POST", "OPTIONS"]) expect(countsAsClick(req(method, BROWSER)), method).toBe(false);
  });

  it("a link unfurler, a crawler or a preview bot never counts — one per family the pattern names (count reported)", () => {
    const bots = [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; YandexBot/3.0)",
      "ia_archiver crawler",
      "Mozilla/5.0 (compatible; SemrushSpider)",
      "Mozilla/5.0 (Macintosh) LinkPreview/1.0",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "WhatsApp/2.23.20.0 A",
      "Slack-ImgProxy (+https://api.slack.com/robots)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "TelegramBot (like TwitterBot)",
      "Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)",
      "Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5",
    ];
    for (const ua of bots) expect(countsAsClick(req("GET", ua)), ua).toBe(false);
    // Every alternative the pattern names is exercised by at least one UA above — a new alternative needs a row.
    const alternatives = CLICK_BOT_UA.source.split("|");
    for (const alt of alternatives) expect(bots.some((ua) => new RegExp(alt, "i").test(ua)), alt).toBe(true);
    expect(alternatives.length, "alternatives checked").toBe(11);
    expect(CLICK_BOT_UA.flags).toContain("i");
  });

  it("the IP is never kept: its digest is sha256 hex, and the raw address is in no part of it", () => {
    for (const ip of ["203.0.113.7", "2001:db8::1", "unknown"]) {
      const digest = clientIpDigest(ip);
      expect(digest).toBe(createHash("sha256").update(ip).digest("hex"));
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(digest.includes(ip)).toBe(false);
    }
  });
});

describe.skipIf(!HAS_DB)("failure: a click write that fails is logged at error level and sent to Sentry (fix round 1, m4)", () => {
  afterEach(() => {
    sentry.captureError.mockClear();
    vi.restoreAllMocks();
  });

  it("the write throws (a fixture id the uuid column refuses): error log + captureError, and the caller never sees it", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const errors = vi.spyOn(log, "error");
    // `parseClickTag` never lets a non-uuid `f` through, so only a hand-built tag reaches the database with one.
    await expect(
      recordClickOnce({ sponsorId: id, key: id, url: "https://sponsor.example/offer", tag: { fixtureId: "not-a-uuid", source: "match" } }, "203.0.113.7"),
    ).resolves.toBeUndefined();
    expect(sentry.captureError).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls[0]), "the log line never carries the IP").not.toContain("203.0.113.7");
    expect(await clicksOf(id)).toEqual([]);
  });

  it("positive pair: a write that succeeds reports nothing, and lands its row", async () => {
    const r = await rig();
    const id = await sponsor(r.orgId);
    const errors = vi.spyOn(log, "error");
    await recordClickOnce({ sponsorId: id, key: id, url: "https://sponsor.example/offer", tag: { fixtureId: r.fixtureIds[0], source: "match" } }, "203.0.113.7");
    expect(sentry.captureError).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    expect(await clicksOf(id)).toEqual([{ org_id: r.orgId, fixture_id: r.fixtureIds[0], source: "match" }]);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const orgId of orgs) await sql`delete from organizations where id = ${orgId}`;
  await sql.end();
});
