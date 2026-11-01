// R4 sponsors on stream, S13 - the shareable report link (`createReportLink` / `revokeReportLink` / `listReportLinks`,
// server/sponsors/report.ts; spec 2026-10-27 §4, §5.2, §7 "Security"). S14 builds the page the link opens.
//
// THE RULEBOOK:
//   - the token is 32 random bytes, base64url (spec §4); only `hashReportToken(token)` (sha256 of its UTF-8, per the brief's
//     interface) is stored; the url (`/r/sponsor/<token>`, spec §5.2) is returned ONCE and the raw token is in no row and no log
//     line (controller addendum 2026-11-01: spy on the logger);
//   - create and revoke are EDITOR-ONLY (R19: owner / admin; a viewer is 403 - there is no "scorer" role);
//   - revoke sets `revoked_at`; a second revoke is a 404 that changes nothing; another org's link is 404;
//   - the link carries inclusive DATES (V483 from_date <= to_date).
// Expected hashes come from node:crypto directly, never from `hashReportToken`.
//
// The transitions (TEST-STRATEGY rule 1) and where each is pinned:
//   create ........................................ "create"
//   a second create ............................... "a second create"
//   create -> revoke -> revoke again (404) ......... "revoke"
//   another org (both doors) ...................... "tenancy"
//   viewer / admin / owner ........................ "R19"
//   bad dates, one-day link ....................... "dates"
//   a deleted sponsor's links ...................... "deleted sponsor"
//   the list: empty, after revoke .................. "listReportLinks"
//   the form's opening dates per period ............ "reportLinkDefaults"
// SINGLE SPORT (none): a link reads no sport.
//
// Killers (one at a time, restore from a cp backup):
//   K7  editor check (create)   drop `assertEditor(auth)` in createReportLink    -> "R19: a viewer is 403 and nothing is written"
//   K8  editor check (revoke)   drop `assertEditor(auth)` in revokeReportLink    -> "R19: ...revoke is 403 and the link stays live"
//   K9  org check on revoke     drop `if (auth.orgId !== orgId)` in revokeReportLink -> "tenancy: org B naming org A"
//   K10 already-revoked guard   drop `and revoked_at is null`                    -> "revoke: a second revoke is 404"
//   K11 hash-only storage       store the token, not its hash                    -> "create: the stored hash is sha256(token)"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { makeUser, seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { deleteSponsor } from "@/server/usecases/sponsors";
import { ENDS_BEFORE_STARTS } from "@/server/api-v1/schemas";
import { createReportLink, hashReportToken, listReportLinks, reportLinkDefaults, revokeReportLink } from "../report";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// Every logger level, observed: the token must appear in none of their arguments.
const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  for (const level of LEVELS) {
    vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never);
  }
});
afterEach(() => vi.restoreAllMocks());

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();
/** The token out of a returned url: the one path segment after /r/sponsor/. */
function tokenOf(url: string): string {
  const m = /^\/r\/sponsor\/([^/?#]+)$/.exec(url);
  if (!m) throw new Error(`not a report link url: ${url}`);
  return m[1]!;
}

type LinkRow = {
  id: string; org_id: string; sponsor_id: string; competition_id: string | null; from_date: string; to_date: string;
  token_hash: Buffer; created_by: string | null; created_at: Date; revoked_at: Date | null;
};
const rowOf = async (id: string) =>
  (await sql<LinkRow[]>`
    select id, org_id, sponsor_id, competition_id, from_date::text as from_date, to_date::text as to_date, token_hash, created_by,
           created_at, revoked_at
      from sponsor_report_links where id = ${id}`)[0];
const linksOf = (orgId: string) => sql<{ id: string }[]>`select id from sponsor_report_links where org_id = ${orgId}`;

/** Every textual spelling a stored column can take - the token must be in none of them. */
function spellings(row: LinkRow): string[] {
  return Object.values(row).flatMap((v) =>
    Buffer.isBuffer(v) ? [v.toString("utf8"), v.toString("hex"), v.toString("base64"), v.toString("base64url")] : [String(v)]);
}

async function organiser() {
  const { auth } = await seedOrg("pro");
  const [sp] = await sql<{ id: string }[]>`insert into sponsors (org_id, name) values (${auth.orgId}, 'Harbour Bank') returning id`;
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Spring Cup", visibility: "public", branding: {} });
  return { auth, orgId: auth.orgId, sponsorId: sp!.id, competitionId: comp.id };
}
async function member(orgId: string, role: "admin" | "viewer"): Promise<AuthCtx> {
  const u = await makeUser(role);
  await sql`insert into org_members (org_id, user_id, role) values (${orgId}, ${u.id}, ${role})`;
  return { orgId, via: "session", userId: u.id, role, keyId: null };
}
const PERIOD = { competitionId: null, from: "2026-01-01", to: "2026-12-31" } as const;

describe("hashReportToken (no DB)", () => {
  it("is sha256 over the token's UTF-8 - the bytes node:crypto gives, as a Buffer", () => {
    let checked = 0;
    for (const token of ["abc", "A".repeat(43), "x-y_z", ""]) {
      const got = hashReportToken(token);
      expect(Buffer.isBuffer(got)).toBe(true);
      expect(got.equals(sha256(token)), token).toBe(true);
      expect(got.length).toBe(32);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

describe.skipIf(!HAS_DB)("S13: report links", () => {
  it("create: returns a url whose token hashes to the stored hash; the raw token is never in the row or any log line", async () => {
    const o = await organiser();
    const out = await createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, ...PERIOD });
    const token = tokenOf(out.url);
    // 32 random bytes, base64url: 43 characters of the url-safe alphabet, decoding back to 32 bytes.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url").length).toBe(32);

    const row = await rowOf(out.id);
    expect(row, "the row exists").toBeDefined();
    expect(row!.token_hash.equals(sha256(token)), "the stored hash is sha256(token)").toBe(true);
    expect(row).toMatchObject({ org_id: o.orgId, sponsor_id: o.sponsorId, competition_id: null, from_date: "2026-01-01", to_date: "2026-12-31",
      created_by: o.auth.userId, revoked_at: null });
    const columns = spellings(row!);
    expect(columns.length).toBeGreaterThan(10);
    for (const s of columns) expect(s.includes(token), `a stored column spells the token: ${s.slice(0, 20)}…`).toBe(false);

    // The logger, every level: nothing was logged that carries the token (and, positively, the spies are live).
    log.info({ probe: true }, "spy probe");
    expect(logged.length, "the spies observe the logger").toBeGreaterThan(0);
    for (const args of logged) expect(JSON.stringify(args).includes(token), JSON.stringify(args).slice(0, 80)).toBe(false);

    // The list never carries it either.
    const listed = await listReportLinks(o.auth, o.orgId);
    expect(JSON.stringify(listed).includes(token)).toBe(false);
  });

  it("a second create gives a different token and a different row, and both are live", async () => {
    const o = await organiser();
    const first = await createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, ...PERIOD });
    const second = await createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, ...PERIOD });
    expect(second.id).not.toBe(first.id);
    expect(tokenOf(second.url)).not.toBe(tokenOf(first.url));
    expect((await rowOf(second.id))!.token_hash.equals((await rowOf(first.id))!.token_hash)).toBe(false);
    expect((await listReportLinks(o.auth, o.orgId)).map((l) => l.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("revoke: create -> revoke sets revoked_at and keeps the hash -> a second revoke is a no-op 404 (the stamp unchanged) -> an unknown id is 404", async () => {
    const o = await organiser();
    const link = await createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, ...PERIOD });
    const hash = (await rowOf(link.id))!.token_hash;
    await revokeReportLink(o.auth, o.orgId, link.id);
    const revoked = await rowOf(link.id);
    expect(revoked!.revoked_at, "revoked").toBeInstanceOf(Date);
    expect(revoked!.token_hash.equals(hash), "the row keeps its hash (an opaque 404 for S14, not a lookup miss)").toBe(true);

    await expect(revokeReportLink(o.auth, o.orgId, link.id)).rejects.toMatchObject({ status: 404, message: "report link not found" });
    expect((await rowOf(link.id))!.revoked_at!.getTime(), "the second revoke changed nothing").toBe(revoked!.revoked_at!.getTime());
    await expect(revokeReportLink(o.auth, o.orgId, "6b7d8f3a-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 404 });
    await expect(revokeReportLink(o.auth, o.orgId, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
  });

  it("tenancy: org B cannot revoke org A's link - through its own org (404) or naming org A (404) - and A's link stays live; org B cannot mint for A's sponsor", async () => {
    const a = await organiser();
    const b = await organiser();
    const link = await createReportLink(a.auth, a.orgId, { sponsorId: a.sponsorId, ...PERIOD });

    await expect(revokeReportLink(b.auth, b.orgId, link.id), "B's own door: the link is not B's").rejects.toMatchObject({ status: 404, message: "report link not found" });
    await expect(revokeReportLink(b.auth, a.orgId, link.id), "B's auth naming A").rejects.toMatchObject({ status: 404, message: "organization not found" });
    expect((await rowOf(link.id))!.revoked_at, "A's link is still live").toBeNull();

    await expect(createReportLink(b.auth, b.orgId, { sponsorId: a.sponsorId, ...PERIOD })).rejects.toMatchObject({ status: 404, message: "sponsor not found" });
    await expect(createReportLink(b.auth, a.orgId, { sponsorId: a.sponsorId, ...PERIOD })).rejects.toMatchObject({ status: 404, message: "organization not found" });
    await expect(createReportLink(b.auth, b.orgId, { sponsorId: b.sponsorId, ...PERIOD, competitionId: a.competitionId })).rejects.toMatchObject({ status: 404, message: "competition not found" });
    expect(await linksOf(b.orgId), "B wrote nothing").toEqual([]);
    expect((await linksOf(a.orgId)).length, "A has its one link").toBe(1);
    await expect(listReportLinks(b.auth, a.orgId)).rejects.toMatchObject({ status: 404 });
    expect(await listReportLinks(b.auth, b.orgId)).toEqual([]);
  });

  it("R19, the granted AND the denied pair: a viewer is 403 on create, revoke and the list, and nothing changes; an admin and an owner pass", async () => {
    const o = await organiser();
    const viewer = await member(o.orgId, "viewer");
    const admin = await member(o.orgId, "admin");

    await expect(createReportLink(viewer, o.orgId, { sponsorId: o.sponsorId, ...PERIOD })).rejects.toMatchObject({ status: 403, message: "Insufficient permissions" });
    expect(await linksOf(o.orgId), "the viewer wrote nothing").toEqual([]);

    let granted = 0;
    const made: string[] = [];
    for (const who of [admin, o.auth]) {
      made.push((await createReportLink(who, o.orgId, { sponsorId: o.sponsorId, ...PERIOD })).id);
      granted++;
    }
    expect(granted).toBe(2);

    await expect(revokeReportLink(viewer, o.orgId, made[0]!)).rejects.toMatchObject({ status: 403, message: "Insufficient permissions" });
    expect((await rowOf(made[0]!))!.revoked_at, "...revoke is 403 and the link stays live").toBeNull();
    await expect(listReportLinks(viewer, o.orgId)).rejects.toMatchObject({ status: 403 });

    await revokeReportLink(admin, o.orgId, made[1]!);
    await revokeReportLink(o.auth, o.orgId, made[0]!);
    expect(await listReportLinks(o.auth, o.orgId)).toEqual([]);

    // An API key resolves role null: never an editor (the routes ban keys anyway, NEVER_KEY_ROUTES).
    const key: AuthCtx = { orgId: o.orgId, via: "api_key", userId: null, role: null, keyId: "k1" };
    await expect(createReportLink(key, o.orgId, { sponsorId: o.sponsorId, ...PERIOD })).rejects.toMatchObject({ status: 403 });
  });

  it("dates: from after to is 400 (the competition form's sentence) and writes nothing; a malformed date is 400; one day (from == to) and a competition-scoped link are fine", async () => {
    const o = await organiser();
    await expect(createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, competitionId: null, from: "2026-06-02", to: "2026-06-01" }))
      .rejects.toMatchObject({ status: 400, message: ENDS_BEFORE_STARTS });
    const malformed = ["2026-6-1", "2026-02-30", "", "2026-06-01T00:00:00Z", "tomorrow"];
    let refused = 0;
    for (const bad of malformed) {
      await expect(createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, competitionId: null, from: bad, to: "2026-12-31" }), `from=${bad}`).rejects.toMatchObject({ status: 400 });
      await expect(createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, competitionId: null, from: "2026-01-01", to: bad }), `to=${bad}`).rejects.toMatchObject({ status: 400 });
      refused += 2;
    }
    expect(refused).toBe(malformed.length * 2);
    expect(await linksOf(o.orgId), "nothing was written").toEqual([]);

    const oneDay = await createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, competitionId: o.competitionId, from: "2026-06-01", to: "2026-06-01" });
    expect(await rowOf(oneDay.id)).toMatchObject({ competition_id: o.competitionId, from_date: "2026-06-01", to_date: "2026-06-01" });
    const [listed] = await listReportLinks(o.auth, o.orgId);
    expect(listed).toEqual({ id: oneDay.id, sponsorId: o.sponsorId, competitionId: o.competitionId, competitionName: "Spring Cup",
      from: "2026-06-01", to: "2026-06-01", createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  });

  it("deleted sponsor: its links go with it (V483 cascade) - the list drops them and revoke is 404", async () => {
    const o = await organiser();
    const link = await createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, ...PERIOD });
    await deleteSponsor(o.auth, o.sponsorId);
    expect(await rowOf(link.id)).toBeUndefined();
    expect(await listReportLinks(o.auth, o.orgId)).toEqual([]);
    await expect(revokeReportLink(o.auth, o.orgId, link.id)).rejects.toMatchObject({ status: 404 });
  });

  it("listReportLinks: empty first; then live links only, newest first; a revoked one drops out", async () => {
    const o = await organiser();
    expect(await listReportLinks(o.auth, o.orgId), "empty").toEqual([]);
    const older = await createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, ...PERIOD });
    await sql`update sponsor_report_links set created_at = created_at - interval '1 hour' where id = ${older.id}`;
    const newer = await createReportLink(o.auth, o.orgId, { sponsorId: o.sponsorId, competitionId: null, from: "2026-03-01", to: "2026-03-31" });
    expect((await listReportLinks(o.auth, o.orgId)).map((l) => l.id)).toEqual([newer.id, older.id]);
    await revokeReportLink(o.auth, o.orgId, newer.id);
    expect((await listReportLinks(o.auth, o.orgId)).map((l) => l.id)).toEqual([older.id]);
  });

  it("reportLinkDefaults: a time period opens at its own whole days; a competition at its start (or creation, if earlier or unset) to its end or today, whichever is later; another org's competition is 404", async () => {
    const o = await organiser();
    const now = new Date("2026-06-15T12:00:00.000Z");
    // The rule's dates, typed by hand: This year = 1 Jan .. 31 Dec; Last 30 days = 17 May .. 15 Jun (half-open window, inclusive dates).
    expect(await reportLinkDefaults(o.auth, o.orgId, { kind: "this_year" }, now)).toEqual({ from: "2026-01-01", to: "2026-12-31", competitionId: null });
    expect(await reportLinkDefaults(o.auth, o.orgId, { kind: "last_30_days" }, now)).toEqual({ from: "2026-05-17", to: "2026-06-15", competitionId: null });

    const cases: { starts: string | null; ends: string; created: string; want: { from: string; to: string } }[] = [
      { starts: "2026-03-01", ends: "2026-04-30", created: "2026-02-10T09:00:00Z", want: { from: "2026-02-10", to: "2026-06-15" } }, // created first; ended before today
      { starts: "2026-03-01", ends: "2030-12-31", created: "2026-05-01T09:00:00Z", want: { from: "2026-03-01", to: "2030-12-31" } }, // starts first; ends after today
      { starts: null, ends: "2026-04-30", created: "2026-01-20T23:30:00Z", want: { from: "2026-01-20", to: "2026-06-15" } },          // no start date: its creation (UTC day)
    ];
    let checked = 0;
    for (const c of cases) {
      await sql`update competitions set starts_on = ${c.starts}, ends_on = ${c.ends}, created_at = ${new Date(c.created)} where id = ${o.competitionId}`;
      expect(await reportLinkDefaults(o.auth, o.orgId, { kind: "competition", competitionId: o.competitionId }, now), JSON.stringify(c))
        .toEqual({ ...c.want, competitionId: o.competitionId });
      checked++;
    }
    expect(checked).toBe(cases.length);

    const b = await organiser();
    await expect(reportLinkDefaults(o.auth, o.orgId, { kind: "competition", competitionId: b.competitionId }, now)).rejects.toMatchObject({ status: 404, message: "competition not found" });
    await expect(reportLinkDefaults(b.auth, o.orgId, { kind: "this_year" }, now)).rejects.toMatchObject({ status: 404, message: "organization not found" });
  });
});
