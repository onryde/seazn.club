// The tracked sponsor redirect `/s/[key]` (v10 PROMPT-56; R4 S10, spec 2026-10-27 §3.7, owner rulings D15 and R7, the
// controller's 2026-10-31 addenda). One route, two shapes: a sponsor uuid (the public boards, `?f=&src=`) and an R7
// short code (the stream). It 302s to the sponsor's stored url and DEFERS the click write, so the redirect never waits
// on it.
//
// The tail is captured rather than run fire-and-forget: `deferred()` outside a request scope runs the work inline and
// SWALLOWS its errors, so a broken write would only ever read as "the row never came". Captured, a test can say both
// "the response went out before the write" (no row yet, one task queued) and "a 404 queued no write at all" — the
// absence is a fact, not a timeout.
//
// The seam (TEST-STRATEGY, failure class 1): a code minted by S5's real `mintShortCode`, read back the way the overlay
// card reads it (`shortCodesFor`), printed the way S7's card prints it (`sponsorShortLinkText`), then typed into this
// route — and the `sponsor_clicks` row read back. Real Postgres throughout; skipped without DATABASE_URL.
//
// Single-sport on purpose: the route reads no sport, only ids, codes and orgs.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Held, not started: a task runs only when `flush()` says so.
const tail = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("@/lib/deferred", () => ({
  deferred: (fn: () => unknown) => {
    tail.tasks.push(fn);
  },
}));

import { sql, statementCount } from "@/lib/db";
import { sponsorShortLinkText, SPONSOR_LINK_HOST } from "@/lib/sponsor-clicks";
import { SPONSOR_SHORT_CODE_MAX_LENGTH } from "@/lib/sponsor-short-code";
import { drawShortCode, mintShortCode, shortCodesFor } from "@/server/sponsors/short-codes";
import { GET } from "../[key]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const GENERIC_DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

const orgs: string[] = [];
beforeEach(() => {
  tail.tasks.length = 0;
});

/** Runs every queued tail write to completion — and rethrows, unlike the real `deferred()`. */
async function flush(): Promise<number> {
  const held = tail.tasks.splice(0);
  for (const fn of held) await fn();
  return held.length;
}

async function rig(): Promise<{ orgId: string; fixtureIds: [string, string] }> {
  const s = uniq();
  await sql`insert into sports (key, name, module_version, position_catalog) values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${`Clk ${s}`}, ${`clk-${s}`}) returning id`;
  orgs.push(orgId);
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status) values (${orgId}, ${`Clk ${s}`}, ${`clk-${s}`}, 'public', 'live') returning id`;
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

async function seedSponsor(orgId: string, url: string | null = "https://clicky.example/offer", status = "active"): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into sponsors (org_id, name, url, status) values (${orgId}, ${`Clicky ${uniq()}`}, ${url}, ${status}) returning id`;
  return id;
}

/** GET `/s/<key><search>`, the way a visitor's browser asks for it. */
const click = (key: string, search = "") =>
  GET(new Request(`https://seazn.club/s/${key}${search}`), { params: Promise.resolve({ key }) });

const rowsOf = (sponsorId: string) => sql<{ org_id: string; fixture_id: string | null; source: string }[]>`
  select org_id, fixture_id, source from sponsor_clicks where sponsor_id = ${sponsorId} order by at, id`;
const countOf = async (sponsorId: string) =>
  (await sql<{ click_count: number }[]>`select click_count from sponsors where id = ${sponsorId}`)[0]!.click_count;

describe.skipIf(!HAS_DB)("GET /s/[key] — a sponsor uuid (the boards' links)", () => {
  it("302s to the stored url BEFORE the write: one read, one queued tail write; then one row and click_count 1", async () => {
    const r = await rig();
    const id = await seedSponsor(r.orgId);
    const before = statementCount();
    const res = await click(id, `?f=${r.fixtureIds[0]}&src=match`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://clicky.example/offer");
    expect(statementCount() - before, "the response waited on one read only").toBe(1);
    expect(await rowsOf(id), "no row yet: the write is tail work").toEqual([]);
    expect(await flush(), "one tail write queued").toBe(1);
    expect(await rowsOf(id)).toEqual([{ org_id: r.orgId, fixture_id: r.fixtureIds[0], source: "match" }]);
    expect(await countOf(id)).toBe(1);
  });

  it("each tagged source with an own-org fixture records {fixture, source} (count reported)", async () => {
    const r = await rig();
    const id = await seedSponsor(r.orgId);
    const sources = ["match", "site", "stream"] as const;
    for (const src of sources) {
      expect((await click(id, `?f=${r.fixtureIds[1]}&src=${src}`)).status).toBe(302);
    }
    expect(await flush()).toBe(sources.length);
    expect((await rowsOf(id)).map((c) => [c.fixture_id, c.source])).toEqual(sources.map((s) => [r.fixtureIds[1], s]));
    expect(await countOf(id)).toBe(sources.length);
  });

  it("another org's sponsor still redirects to THAT sponsor; an `f` from a different org records fixture null, `unknown`", async () => {
    const a = await rig();
    const b = await rig();
    const theirs = await seedSponsor(b.orgId, "https://theirs.example/");
    const res = await click(theirs, `?f=${a.fixtureIds[0]}&src=match`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://theirs.example/");
    await flush();
    expect(await rowsOf(theirs)).toEqual([{ org_id: b.orgId, fixture_id: null, source: "unknown" }]);
    expect(await countOf(theirs), "still counted").toBe(1);
  });

  it("src=bogus is `unknown` (fixture kept); no query at all is `unknown`, fixture null", async () => {
    const r = await rig();
    const id = await seedSponsor(r.orgId);
    await click(id, `?f=${r.fixtureIds[0]}&src=bogus`);
    await click(id);
    await flush();
    expect((await rowsOf(id)).map((c) => [c.fixture_id, c.source])).toEqual([
      [r.fixtureIds[0], "unknown"],
      [null, "unknown"],
    ]);
  });

  it("404s — and queues no write — for an unknown id, a url-less, an inactive and a pending sponsor, and a non-http(s) url", async () => {
    const r = await rig();
    const cases: Array<[string, string]> = [
      ["unknown uuid", randomUUID()],
      ["no url", await seedSponsor(r.orgId, null)],
      ["inactive", await seedSponsor(r.orgId, "https://gone.example", "inactive")],
      ["pending", await seedSponsor(r.orgId, "https://later.example", "pending")],
      ["javascript: url", await seedSponsor(r.orgId, "javascript:alert(document.cookie)")],
      ["data: url", await seedSponsor(r.orgId, "data:text/html,<script>alert(1)</script>")],
    ];
    for (const [name, key] of cases) {
      const res = await click(key, `?f=${r.fixtureIds[0]}&src=match`);
      expect(res.status, name).toBe(404);
      expect(res.headers.get("location"), name).toBeNull();
    }
    expect(tail.tasks.length, "no write queued for any 404").toBe(0);
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from sponsor_clicks where sponsor_id = any(${cases.map((c) => c[1])}::uuid[])`;
    expect(rows[0]!.n).toBe(0);
    expect(cases.length).toBe(6);
  });

  it("a key of neither shape 404s without touching the database", async () => {
    for (const key of ["not-a-uuid", "abcd", "ABCD!", `${randomUUID()}0`]) {
      const before = statementCount();
      expect((await click(key)).status, key).toBe(404);
      expect(statementCount() - before, `${key}: no lookup`).toBe(0);
    }
    expect(tail.tasks.length).toBe(0);
  });

  it("nothing in the request can choose the target: `?url=` / `?next=` are ignored", async () => {
    const r = await rig();
    const id = await seedSponsor(r.orgId);
    const res = await click(id, "?url=https%3A%2F%2Fevil.example&next=https%3A%2F%2Fevil.example&src=site");
    expect(res.headers.get("location")).toBe("https://clicky.example/offer");
    await flush();
  });
});

describe.skipIf(!HAS_DB)("GET /s/[key] — an R7 short code (the stream)", () => {
  /** The code exactly as the overlay card prints it: minted by S5, read back as the card reads it, printed by S7. */
  async function printedCode(orgId: string, sponsorId: string, fixtureId: string): Promise<string> {
    await mintShortCode({ orgId, sponsorId, fixtureId });
    const { codes } = await shortCodesFor(sql, { orgId, fixtureId, sponsorIds: [sponsorId] });
    const printed = sponsorShortLinkText(codes.get(sponsorId));
    expect(printed, "premise: the card prints a link").not.toBeNull();
    const prefix = `${SPONSOR_LINK_HOST}/s/`;
    expect(printed!.startsWith(prefix)).toBe(true);
    return printed!.slice(prefix.length);
  }

  it("SEAM: S5's mint → the card's text → this route → a {fixture, `stream`} row; clicked twice, two rows", async () => {
    const r = await rig();
    const id = await seedSponsor(r.orgId, "https://stream-sponsor.example/deal");
    const code = await printedCode(r.orgId, id, r.fixtureIds[0]);
    for (let i = 0; i < 2; i++) {
      const res = await click(code);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://stream-sponsor.example/deal");
    }
    expect(await flush()).toBe(2);
    expect(await rowsOf(id)).toEqual([
      { org_id: r.orgId, fixture_id: r.fixtureIds[0], source: "stream" },
      { org_id: r.orgId, fixture_id: r.fixtureIds[0], source: "stream" },
    ]);
    expect(await countOf(id)).toBe(2);
  });

  it("a query on a code is ignored: the code is the whole tag", async () => {
    const r = await rig();
    const id = await seedSponsor(r.orgId);
    const code = await printedCode(r.orgId, id, r.fixtureIds[0]);
    await click(code, `?f=${r.fixtureIds[1]}&src=site&url=https%3A%2F%2Fevil.example`);
    await flush();
    expect((await rowsOf(id)).map((c) => [c.fixture_id, c.source])).toEqual([[r.fixtureIds[0], "stream"]]);
  });

  it("a code whose sponsor has since been deactivated 404s and writes nothing; reactivated, it counts again", async () => {
    const r = await rig();
    const id = await seedSponsor(r.orgId);
    const code = await printedCode(r.orgId, id, r.fixtureIds[0]);
    await sql`update sponsors set status = 'inactive' where id = ${id}`;
    expect((await click(code)).status).toBe(404);
    expect(tail.tasks.length).toBe(0);
    expect(await rowsOf(id)).toEqual([]);
    await sql`update sponsors set status = 'active' where id = ${id}`;
    expect((await click(code)).status).toBe(302);
    await flush();
    expect(await rowsOf(id)).toHaveLength(1);
  });

  it("an unknown code 404s (the right shape, minted by nobody)", async () => {
    expect((await click(drawShortCode(SPONSOR_SHORT_CODE_MAX_LENGTH))).status).toBe(404);
    expect(tail.tasks.length).toBe(0);
  });

  it("a code whose fixture was deleted still counts, as a `stream` click with no fixture", async () => {
    const r = await rig();
    const id = await seedSponsor(r.orgId);
    const code = await printedCode(r.orgId, id, r.fixtureIds[1]);
    await sql`delete from fixtures where id = ${r.fixtureIds[1]}`;
    expect((await click(code)).status).toBe(302);
    await flush();
    expect(await rowsOf(id)).toEqual([{ org_id: r.orgId, fixture_id: null, source: "stream" }]);
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const orgId of orgs) await sql`delete from organizations where id = ${orgId}`;
  await sql.end();
});
