// Match Day codes (capture S4 design 2026-11-07 §3; MD-1 Task 1): mint, list, revoke, resolve, the actor a code acts
// as, and the use log. Plus Review Focus 1 (a code minted for tomorrow, read tonight, is MD_NOT_OPEN with its opens_at —
// never MD_ENDED) and Review Focus 5 (an md_ bearer on an organiser route is 403, not a fall-through to the session).
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  listMatchDayCodes,
  logMatchDayUse,
  matchDayActor,
  mintMatchDayCode,
  resolveMatchDayCode,
  revokeMatchDayCode,
} from "../match-day-codes";
import { seedDay, T0, type Day } from "./_match-day-seed";
import { makeUser } from "./_seed";
import { POST as generatePost } from "@/app/api/v1/stages/[id]/generate/route";

// Every mint seals (DEVICE_LINK_KEK). A throwaway key of this file's own, never the developer's .env.local one: CI's
// unit job has no DEVICE_LINK_KEK at all. Never printed; restored in afterAll.
vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex"));
// The URL is built on the site origin; pinned here so a developer's http://localhost .env.local does not decide it.
vi.stubEnv("OAUTH_BASE_URL", "https://md.test.seazn.club");

const HAS_DB = !!process.env.DATABASE_URL;
const URL_RE = /^https:\/\/[^/]+\/day\/md_[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const tokenOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
  return 0;
}

describe.skipIf(!HAS_DB)("match day codes", () => {
  let day: Day;
  beforeEach(async () => {
    day = await seedDay();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mint returns a /day/md_ URL and stores only the hash", async () => {
    const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: false });
    expect(url).toMatch(URL_RE);
    const token = tokenOf(url);
    const [stored] = await sql<{ tok_hash: string; token_enc: Uint8Array }[]>`
      select tok_hash, token_enc from match_day_codes where id = ${row.id}`;
    expect(stored!.tok_hash).toBe(sha256(token));
    // The envelope is sealed: the plaintext token appears nowhere in it.
    expect(Buffer.from(stored!.token_enc).includes(Buffer.from(token))).toBe(false);
    expect(row).toMatchObject({ orgId: day.orgId, competitionId: day.comp.id, scope: { kind: "competition" }, canApprove: false, revokedAt: null });
    expect(row.issuedBy).toBe(day.auth.userId);
  });

  it("mint defaults day to the competition's today and bounds it in that zone", async () => {
    await sql`update organizations set timezone = 'Europe/London' where id = ${day.orgId}`;
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
    const { row } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: false });
    expect(row.day).toBe("2026-11-07");
    expect(row.tz).toBe("Europe/London");
    expect(row.opensAt.toISOString()).toBe("2026-11-07T00:00:00.000Z");
    expect(row.expiresAt.toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });

  it("the zone decides which day is today, and where it starts and ends (Amsterdam, late on the 7th UTC)", async () => {
    // seedDay's org is Europe/Amsterdam (UTC+1 in November): 23:30 UTC on the 7th is already the 8th there.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-07T23:30:00.000Z") });
    const { row } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: false });
    expect(row.day).toBe("2026-11-08");
    expect(row.tz).toBe("Europe/Amsterdam");
    expect(row.opensAt.toISOString()).toBe("2026-11-07T23:00:00.000Z");
    expect(row.expiresAt.toISOString()).toBe("2026-11-08T23:00:00.000Z");
  });

  it("resolve before opens_at is MD_NOT_OPEN with opensAt (Review Focus 1)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
    const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, day: "2026-11-08", canApprove: false });
    vi.useRealTimers();
    // Tonight, in Amsterdam: 22:00 local on the 7th.
    const tonight = new Date("2026-11-07T21:00:00.000Z");
    const got = await resolveMatchDayCode(tokenOf(url), tonight);
    expect(got).toEqual({ ok: false, refusal: "MD_NOT_OPEN", opensAt: row.opensAt });
    expect(row.opensAt.toISOString()).toBe("2026-11-07T23:00:00.000Z");
    // One minute past its midnight it is open.
    const open = await resolveMatchDayCode(tokenOf(url), new Date("2026-11-07T23:01:00.000Z"));
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.code.id).toBe(row.id);
  });

  it("resolve after expires_at is MD_ENDED, after revoke MD_WITHDRAWN, of a random md_ MD_UNKNOWN", async () => {
    const { row, url } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: true });
    const token = tokenOf(url);
    const during = new Date(row.opensAt.getTime() + 60_000);
    expect((await resolveMatchDayCode(token, during)).ok).toBe(true);
    // The instant it expires is past its day (24:00 belongs to the next).
    expect(await resolveMatchDayCode(token, row.expiresAt)).toEqual({ ok: false, refusal: "MD_ENDED" });
    await revokeMatchDayCode(day.auth, row.id);
    expect(await resolveMatchDayCode(token, during)).toEqual({ ok: false, refusal: "MD_WITHDRAWN" });
    // Withdrawn wins over ended: the organiser's act is the truer answer.
    expect(await resolveMatchDayCode(token, row.expiresAt)).toEqual({ ok: false, refusal: "MD_WITHDRAWN" });
    expect(await resolveMatchDayCode("md_" + randomBytes(32).toString("base64url"), during)).toEqual({ ok: false, refusal: "MD_UNKNOWN" });
    expect(await resolveMatchDayCode("dl_" + randomBytes(32).toString("base64url"), during)).toEqual({ ok: false, refusal: "MD_UNKNOWN" });
    expect(await resolveMatchDayCode("", during)).toEqual({ ok: false, refusal: "MD_UNKNOWN" });
  });

  it("mint refuses a non-editor (403) and an api key", async () => {
    const viewer = await makeUser("viewer");
    await sql`insert into org_members (org_id, user_id, role) values (${day.orgId}, ${viewer.id}, 'viewer')`;
    const asViewer: AuthCtx = { orgId: day.orgId, via: "session", userId: viewer.id, role: "viewer", keyId: null };
    const asKey: AuthCtx = { orgId: day.orgId, via: "api_key", userId: null, role: null, keyId: "k", keyScopes: ["manage"] };
    const input = { scope: { kind: "competition" } as const, canApprove: false };
    expect(await statusOf(mintMatchDayCode(asViewer, day.comp.id, input))).toBe(403);
    expect(await statusOf(mintMatchDayCode(asKey, day.comp.id, input))).toBe(403);
    expect(await statusOf(listMatchDayCodes(asViewer, day.comp.id))).toBe(403);
    const { row } = await mintMatchDayCode(day.auth, day.comp.id, input);
    expect(await statusOf(revokeMatchDayCode(asViewer, row.id))).toBe(403);
    expect(await statusOf(revokeMatchDayCode(asKey, row.id))).toBe(403);
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from match_day_codes where competition_id = ${day.comp.id}`;
    expect(count!.n).toBe(1);
  });

  it("mint refuses another org's competition, venue or court, an empty courts list and a day already over", async () => {
    const other = await seedDay();
    expect(await statusOf(mintMatchDayCode(day.auth, other.comp.id, { scope: { kind: "competition" }, canApprove: false }))).toBe(404);
    expect(
      await statusOf(mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "venue", venueId: other.venues.hallA }, canApprove: false })),
    ).toBe(422);
    expect(
      await statusOf(
        mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "courts", courtIds: [day.courts.c1, other.courts.c1] }, canApprove: false }),
      ),
    ).toBe(422);
    expect(await statusOf(mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "courts", courtIds: [] }, canApprove: false }))).toBe(422);
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
    expect(await statusOf(mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, day: "2026-11-06", canApprove: false }))).toBe(422);
    expect(await statusOf(mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, day: "2026-02-30", canApprove: false }))).toBe(422);
  });

  it("a venue code and a courts code keep their scope", async () => {
    const venue = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "venue", venueId: day.venues.hallB }, canApprove: false });
    expect(venue.row.scope).toEqual({ kind: "venue", venueId: day.venues.hallB });
    const courts = await mintMatchDayCode(day.auth, day.comp.id, {
      scope: { kind: "courts", courtIds: [day.courts.c2, day.courts.c1, day.courts.c2] },
      canApprove: false,
    });
    expect(courts.row.scope.kind).toBe("courts");
    if (courts.row.scope.kind === "courts") expect([...courts.row.scope.courtIds].sort()).toEqual([day.courts.c1, day.courts.c2].sort());
  });

  it("revoke twice is fine", async () => {
    const { row } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: false });
    await revokeMatchDayCode(day.auth, row.id);
    const [first] = await sql<{ revoked_at: Date }[]>`select revoked_at from match_day_codes where id = ${row.id}`;
    await revokeMatchDayCode(day.auth, row.id);
    const [second] = await sql<{ revoked_at: Date }[]>`select revoked_at from match_day_codes where id = ${row.id}`;
    expect(first!.revoked_at).not.toBeNull();
    expect(second!.revoked_at.toISOString()).toBe(first!.revoked_at.toISOString());
    // Another org's editor cannot reach it.
    const other = await seedDay();
    expect(await statusOf(revokeMatchDayCode(other.auth, row.id))).toBe(404);
  });

  it("list re-shows the same URL", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(T0) });
    const today = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: false });
    const tomorrow = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, day: "2026-11-08", canApprove: true });
    const withdrawn = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: false });
    await revokeMatchDayCode(day.auth, withdrawn.row.id);
    const listed = await listMatchDayCodes(day.auth, day.comp.id);
    expect(listed.map((c) => c.id)).toEqual([today.row.id, tomorrow.row.id]);
    expect(listed[0]!.url).toBe(today.url);
    expect(listed[1]!.url).toBe(tomorrow.url);
    expect(listed[1]!.canApprove).toBe(true);
    // A code whose day is over leaves the list.
    vi.setSystemTime(new Date("2026-11-08T23:00:00.000Z"));
    expect(await listMatchDayCodes(day.auth, day.comp.id)).toEqual([]);
  });

  it("matchDayActor acts as the issuer, by the code, with no role", async () => {
    const { row } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: false });
    expect(matchDayActor(row)).toEqual({ orgId: day.orgId, via: "match_day_code", userId: day.auth.userId, role: null, keyId: null });
  });

  it("logMatchDayUse records an open and an approval against the code", async () => {
    const { row } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: true });
    const fixtureId = day.comp.fixtures[0]!.id;
    await logMatchDayUse(row.id, { kind: "open", fixtureId });
    await logMatchDayUse(row.id, { kind: "approve", stageId: day.comp.stageId, approval: "swiss" });
    const uses = await sql<{ kind: string; fixture_id: string | null; stage_id: string | null; approval: string | null }[]>`
      select kind, fixture_id, stage_id, approval from match_day_code_uses where code_id = ${row.id} order by id`;
    expect(uses).toEqual([
      { kind: "open", fixture_id: fixtureId, stage_id: null, approval: null },
      { kind: "approve", fixture_id: null, stage_id: day.comp.stageId, approval: "swiss" },
    ]);
  });

  it("an md_ bearer on POST /stages/{id}/generate is 403 (Review Focus 5)", async () => {
    const { url } = await mintMatchDayCode(day.auth, day.comp.id, { scope: { kind: "competition" }, canApprove: true });
    const res = await generatePost(
      new Request(`https://test.local/api/v1/stages/${day.comp.stageId}/generate`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenOf(url)}`, "content-type": "application/json" },
        body: "{}",
      }),
      { params: Promise.resolve({ id: day.comp.stageId }) },
    );
    expect(res.status).toBe(403);
  });
});
