// Quick match plan 1, Task 8: a guest's scoring link, and a score as activity (spec docs/superpowers/specs/2026-11-03-
// quick-match-design.md §7.4, C1, C4, C18, C23; pre-flight A3, A10, A12, A14, A15, A16, B8, C13, D5).
//   - `ensureGuestDeviceLink(qm, fixtureId)`: the "Score" tap's link. Mints (or reopens) ONE fixture's link, issued by
//     the hidden system user, for a fixture of THIS quick match whose two sides are known; no session editor exists.
//   - D5: a score through that link is activity (C1: "the 7 days run from the last activity, creation or the last
//     score"), so the scoring path re-arms the quick match's clock after the append commits, best-effort, and only for
//     a quick match.
//
// Every score here goes through the REAL door: the guest link POSTs to the events route (`POST /api/v1/fixtures/{id}/
// events`: `requireFixtureActor`, then `scoreEvent`), or, where a whole match is played, the link's own AuthCtx from
// that same door drives `scoreEvent`, the function the route calls. Every quick match is made by the real producer
// (`createQuickMatch`). The events are the engine's own (`firstRallyFor`, `playToDecided`), never hand-typed.
//
// Every case keys on its OWN quick match (A16: one system org shared by every case and every parallel file); nothing
// counts the org's rows. Expected values come from the spec (7 days, C1; the codes plan 2 maps), the shared limiter
// declaration, or the database the write path wrote; never from the code under test.
//
// Real Postgres required; the cases skip without DATABASE_URL.
import { randomBytes as kekBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { forEachSportAsync } from "@seazn/engine/testkit";

import { POST } from "@/app/api/v1/fixtures/[id]/events/route";
import { isChessSport } from "@/lib/chess-individual-only-rule";
import { sql } from "@/lib/db";
import offerJson from "@/lib/quick-match-offer.generated.json";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_SYSTEM_ORG_ID, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";
import { DEVICE_LINK_MINT_LIMIT, __setRateLimitCounterForTests } from "@/lib/rate-limit";
import { requireFixtureActor, type AuthCtx } from "@/server/api-v1/auth";
import type { AppendEventRequest, CreateQuickMatch } from "@/server/api-v1/schemas";
import { declaredVariant, seedBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { log } from "@/server/logger";
import { ensureGuestDeviceLink, resolveDeviceLinkToken } from "../device-links";
import { touchQuickMatchActivityForFixture } from "../quick-match-activity";
import { systemAuth } from "@/lib/quick-match-auth";
import { createQuickMatch, type CreatedQuickMatch } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { findQuickMatchByCompetition, resolveQuickMatchToken, type QuickMatchRow } from "../quick-match-home";
import { listQuickMatchSports } from "../quick-match-sports";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { scoreEvent } from "../scoring";
import { firstRallyFor, playToDecided } from "./_quick-match-probe";
import { makeUser } from "./_seed";

vi.stubEnv("DEVICE_LINK_KEK", kekBytes(32).toString("hex"));   // A15: every create and every mint seals a secret
// The create's one analytics event reaches a mock, never PostHog.
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: vi.fn(),
}));
// The touch, observed: the real function behind a spy, so a case can count its calls (scope, requirement 3) or make
// one fail (best-effort, requirement 2). The scoring path imports this same module, so it calls the spy.
vi.mock("../quick-match-activity", async (orig) => {
  const real = await orig<typeof import("../quick-match-activity")>();
  return { ...real, touchQuickMatchActivityForFixture: vi.fn(real.touchQuickMatchActivityForFixture) };
});
const touchSpy = vi.mocked(touchQuickMatchActivityForFixture);

const HAS_DB = !!process.env.DATABASE_URL;
const DAY_MS = 24 * 3600 * 1000;
/** C1 / §7.2: an unsaved quick match is kept this many days after its last activity. The spec's number, typed here so
 *  the test never reads it back from the code under test. */
const SPEC_EXPIRY_DAYS = 7;
/** The codes plan 2 maps on `body.code` (plan 2 Task 6; pre-flight C13), typed from the plan. */
const SIDES_UNKNOWN = "QUICK_MATCH_SIDES_UNKNOWN";
const EXPIRED = "QUICK_MATCH_EXPIRED";
/** The sweep's budget in its own cost driver (AGENTS.md class 20): one create, one mint and one or two writes per
 *  offered sport. Every other case keeps the repo default (vitest.config.ts: no inline pins). */
const OFFERED_SPORTS = new Set(offerJson.offered.map((o) => o.sport_key)).size;
const SWEEP_TIMEOUT_MS = Math.max(30_000, OFFERED_SPORTS * 30_000);

const uniq = () => `QM link ${randomUUID().slice(0, 8)}`;
const visitor = () => hashVisitorKey(mintVisitorKey());
const SIDES = ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"];
/** Read from the catalog in beforeAll, never typed (as Tasks 5 and 7 do). */
let BADMINTON_V: string;

const league = (over: Partial<CreateQuickMatch> = {}): CreateQuickMatch => ({
  name: uniq(),
  sport_key: "badminton",
  variant_key: BADMINTON_V,
  kind: "pair",   // badminton's entrantModel takes pairs (D2)
  format: "league",
  sides: SIDES,
  plays: 1,
  email: null,
  locale: "en",
  ...over,
});

/** Every competition a case created, hard-deleted in afterAll (the shared DB stays lean). */
const created: string[] = [];
async function create(input: CreateQuickMatch = league()): Promise<{ out: CreatedQuickMatch; row: QuickMatchRow }> {
  const out = await createQuickMatch(input, { visitorHash: visitor(), mailAllowed: async () => true });
  created.push(out.competitionId);
  const row = await resolveQuickMatchToken(out.token);
  if (!row) throw new Error(`precondition: quick match ${out.id} does not resolve`);
  return { out, row };
}

interface Fx {
  id: string;
  round_no: number;
  status: string;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}
/** The competition's fixtures as the generator wrote them, in play order. */
async function fixturesOf(competitionId: string): Promise<Fx[]> {
  const rows = await sql<Fx[]>`
    select f.id, f.round_no, f.status, f.home_entrant_id, f.away_entrant_id
    from fixtures f join divisions d on d.id = f.division_id
    where d.competition_id = ${competitionId}
    order by f.round_no, f.fixture_no`;
  if (rows.length === 0) throw new Error(`precondition: competition ${competitionId} has no fixture`);
  return rows;
}
const seated = (f: Fx) => f.home_entrant_id !== null && f.away_entrant_id !== null;

async function linksOn(fixtureId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from device_links where fixture_id = ${fixtureId}`;
  return r!.n;
}
async function eventsOn(fixtureId: string): Promise<{ type: string; device_link_id: string | null; recorded_by: string | null }[]> {
  return sql`select type, device_link_id, recorded_by from score_events where fixture_id = ${fixtureId} order by seq`;
}
async function activityOf(id: string): Promise<{ last: Date; expires: Date | null }> {
  const [q] = await sql<{ last_activity_at: Date; expires_at: Date | null }[]>`
    select last_activity_at, expires_at from quick_matches where id = ${id}`;
  if (!q) throw new Error(`precondition: quick match ${id} has no row`);
  return { last: q.last_activity_at, expires: q.expires_at };
}
/** Move a quick match's clock into the past, so the next touch is visible. */
async function age(id: string): Promise<void> {
  await sql`update quick_matches
            set last_activity_at = now() - interval '2 days',
                expires_at = case when saved_by_user_id is null then now() + interval '5 days' else null end
            where id = ${id}`;
}

/** The events route itself, one event per request, as the pad posts it. */
const post = (secret: string, fixtureId: string, body: AppendEventRequest) =>
  POST(
    new Request(`http://test.local/api/v1/fixtures/${fixtureId}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: fixtureId }) },
  );
/** The link's AuthCtx from the route's own door (`requireFixtureActor`), for a whole match played through `scoreEvent`. */
const linkAuth = (secret: string, fixtureId: string): Promise<AuthCtx> =>
  requireFixtureActor(new Request("http://test.local/api/v1", { headers: { authorization: `Bearer ${secret}` } }), fixtureId, "score");

const touchesOf = (fixtureId: string) => touchSpy.mock.calls.filter(([id]) => id === fixtureId).length;

beforeAll(async () => {
  if (!HAS_DB) return;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  BADMINTON_V = row.key;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (!HAS_DB) return;
  for (const id of created) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

// ── the mint ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("ensureGuestDeviceLink (§7.4, C4, C18)", () => {
  it("mints a link for a fixture of this quick match, issued by the system user, and reopens it next time", async () => {
    const { row, out } = await create();
    const [f0, f1] = await fixturesOf(out.competitionId);
    const first = await ensureGuestDeviceLink(row, f0!.id);
    expect(first.minted).toBe(true);
    expect(first.secret.startsWith("dl_")).toBe(true);
    const again = await ensureGuestDeviceLink(row, f0!.id);
    expect(again.minted).toBe(false);
    expect(again.secret).toBe(first.secret);
    expect(again.row.id).toBe(first.row.id);
    expect(await linksOn(f0!.id)).toBe(1);   // reopened, not a second row
    const resolved = await resolveDeviceLinkToken(first.secret);
    expect(resolved).toMatchObject({ issued_by: QUICK_MATCH_SYSTEM_USER_ID, org_id: QUICK_MATCH_SYSTEM_ORG_ID, fixture_id: f0!.id });
    // One link covers exactly one fixture (C4): the next fixture gets its own.
    const other = await ensureGuestDeviceLink(row, f1!.id);
    expect(other.minted).toBe(true);
    expect(other.secret).not.toBe(first.secret);
    expect((await resolveDeviceLinkToken(other.secret)).fixture_id).toBe(f1!.id);
  });

  it("a fixture id that is not a uuid, empty or junk, is a 404 before any query (never Postgres's 22P02, a 500)", async () => {
    const { row } = await create();
    const malformed = ["", "not-a-fixture", "00000000-0000-4000-8000-00000000a00", `${randomUUID()}'`];
    let checked = 0;
    for (const id of malformed) {
      await expect(ensureGuestDeviceLink(row, id), JSON.stringify(id)).rejects.toMatchObject({ status: 404 });
      checked++;
    }
    expect(checked).toBe(malformed.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("refuses a fixture of another quick match, or of an ordinary org (404), and writes no link (negative pair)", async () => {
    const a = await create();
    const b = await create();
    const [fb] = await fixturesOf(b.out.competitionId);
    await expect(ensureGuestDeviceLink(a.row, fb!.id)).rejects.toMatchObject({ status: 404 });
    expect(await linksOn(fb!.id)).toBe(0);
    // An ordinary org's fixture: outside the system org, so RLS hides it from the mint's transaction.
    const m = builtinModules.find((x) => x.key === "badminton")!;
    const plain = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", Object.keys(m.variants)[0]!), stageKind: "league", entrants: 2 });
    await expect(ensureGuestDeviceLink(a.row, plain.fixtureIds[0]!)).rejects.toMatchObject({ status: 404 });
    expect(await linksOn(plain.fixtureIds[0]!)).toBe(0);
    // The pair: the same fixture through its OWN quick match mints.
    expect((await ensureGuestDeviceLink(b.row, fb!.id)).minted).toBe(true);
  });

  it("refuses a match whose sides are not yet known (422 SIDES_UNKNOWN), and mints once both are seated (knockout of 3)", async () => {
    const { row, out } = await create(league({ format: "knockout", sides: SIDES.slice(0, 3) }));
    const fixtures = await fixturesOf(out.competitionId);
    const final = fixtures.find((f) => f.round_no === 2)!;
    const bye = fixtures.find((f) => f.round_no === 1 && !seated(f))!;
    const semi = fixtures.find((f) => f.round_no === 1 && seated(f))!;
    expect([final, bye, semi].every(Boolean)).toBe(true);   // §7.3: 3 sides = a bye, a semi-final and a final
    expect(seated(final)).toBe(false);
    for (const waiting of [final, bye]) {
      await expect(ensureGuestDeviceLink(row, waiting.id)).rejects.toMatchObject({ status: 422, code: SIDES_UNKNOWN });
      expect(await linksOn(waiting.id)).toBe(0);
    }
    // The semi-final, scored to its end through its own guest link, seats its winner in the final (§7.10).
    const { secret } = await ensureGuestDeviceLink(row, semi.id);
    expect(await playToDecided(await linkAuth(secret, semi.id), semi.id)).toMatchObject({ kind: "decided" });
    const [finalNow] = await sql<Fx[]>`select id, round_no, status, home_entrant_id, away_entrant_id from fixtures where id = ${final.id}`;
    expect(seated(finalNow!)).toBe(true);
    expect((await ensureGuestDeviceLink(row, final.id)).minted).toBe(true);
  });

  it("in a knockout of 6, every match with an empty seat is refused, whichever seat is empty; every seated one mints", async () => {
    const { row, out } = await create(league({ format: "knockout", sides: [...SIDES, "Kim & Bo", "Ana & Lu"] }));
    const fixtures = await fixturesOf(out.competitionId);
    const waiting = fixtures.filter((f) => !seated(f));
    // Every seat pattern a bracket of 6 leaves (§7.3: seeds 1 and 2 sit out): home known only, away known only, neither.
    // The away-only one is the case a home-only check would let through, and the converse.
    expect(waiting.filter((f) => f.home_entrant_id !== null).length, "home known, away empty").toBeGreaterThan(0);
    expect(waiting.filter((f) => f.away_entrant_id !== null).length, "away known, home empty").toBeGreaterThan(0);
    expect(waiting.filter((f) => f.home_entrant_id === null && f.away_entrant_id === null).length, "both empty").toBeGreaterThan(0);
    let refused = 0;
    for (const f of waiting) {
      await expect(ensureGuestDeviceLink(row, f.id), `round ${f.round_no}`).rejects.toMatchObject({ status: 422, code: SIDES_UNKNOWN });
      expect(await linksOn(f.id)).toBe(0);
      refused++;
    }
    let minted = 0;
    for (const f of fixtures.filter(seated)) {
      expect((await ensureGuestDeviceLink(row, f.id)).minted).toBe(true);
      minted++;
    }
    expect(refused).toBe(waiting.length);
    expect(minted).toBeGreaterThan(0);   // zero checked is a failure, on both sides of the pair
    expect(refused + minted).toBe(fixtures.length);
  });

  it("an expired quick match mints nothing (404 EXPIRED); a saved one, which never expires, mints", async () => {
    const { out } = await create();
    const [f0] = await fixturesOf(out.competitionId);
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day'
              where id = ${out.id}`;
    expect(await resolveQuickMatchToken(out.token)).toBeNull();   // precondition: the home itself refuses it
    const stale = await findQuickMatchByCompetition(out.competitionId);   // the one read that ignores expiry (T9)
    await expect(ensureGuestDeviceLink(stale!, f0!.id)).rejects.toMatchObject({ status: 404, code: EXPIRED });
    // Plan 2 maps every code in QUICK_MATCH_ERRORS and nothing else, so the code the thrower sends must be one of its
    // members (review G2), under the value the plan names.
    expect(QUICK_MATCH_ERRORS.EXPIRED).toBe(EXPIRED);
    expect(await linksOn(f0!.id)).toBe(0);
    // Saved (§7.7): no expiry, alive however old its activity.
    const saver = await makeUser("qm-saver");
    await sql`update quick_matches set saved_by_user_id = ${saver.id}, expires_at = null where id = ${out.id}`;
    const saved = await findQuickMatchByCompetition(out.competitionId);
    expect((await ensureGuestDeviceLink(saved!, f0!.id)).minted).toBe(true);
  });

  it("a decided match reopens its link (the guest may still correct it); a finalized one is refused (422)", async () => {
    const { row, out } = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const first = await ensureGuestDeviceLink(row, f0!.id);
    const played = await playToDecided(await linkAuth(first.secret, f0!.id), f0!.id);
    expect(played).toMatchObject({ kind: "decided" });
    const decided = await ensureGuestDeviceLink(row, f0!.id);
    expect(decided).toMatchObject({ minted: false, secret: first.secret });
    // Finalized (only an organizer account may, never the link): nothing left to score, so no link.
    if (played.kind !== "decided") throw new Error("unreachable");
    await scoreEvent(systemAuth(), f0!.id, { expected_seq: played.lastSeq, type: "core.finalize", payload: {} });
    await expect(ensureGuestDeviceLink(row, f0!.id)).rejects.toMatchObject({ status: 422 });
    expect(await linksOn(f0!.id)).toBe(1);
  });

  it("is rate-limited per quick match: one past the mint limit is 429, while another quick match mints", async () => {
    const a = await create();
    const b = await create();
    const [fa] = await fixturesOf(a.out.competitionId);
    const [fb] = await fixturesOf(b.out.competitionId);
    const counts = new Map<string, number>();
    __setRateLimitCounterForTests(async (key) => {
      if (!key.startsWith("rl:qm-mint:")) return null;   // every other limiter stays inert, as with no Redis
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { count: n, ttlMs: 60_000 };
    });
    try {
      expect(DEVICE_LINK_MINT_LIMIT.max).toBeGreaterThan(0);
      for (let i = 0; i < DEVICE_LINK_MINT_LIMIT.max; i++) await ensureGuestDeviceLink(a.row, fa!.id);
      await expect(ensureGuestDeviceLink(a.row, fa!.id)).rejects.toMatchObject({ status: 429 });
      expect((await ensureGuestDeviceLink(b.row, fb!.id)).minted).toBe(true);   // its own bucket
    } finally {
      __setRateLimitCounterForTests(null);
    }
    expect(counts.get(`rl:qm-mint:${a.row.id}`)).toBe(DEVICE_LINK_MINT_LIMIT.max + 1);
  });
});

// ── a score through the link ────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("a score through the guest link (real producer and consumer; D5)", () => {
  it("a scored rally through the minted link lands in score_events, attributed to the link", async () => {
    const { row, out } = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const link = await ensureGuestDeviceLink(row, f0!.id);
    const rally = await firstRallyFor(f0!.id);   // core.start, then the first play event (A10)
    expect(rally).toHaveLength(2);
    for (const e of rally) {
      const res = await post(link.secret, f0!.id, e);
      expect(res.status, await res.clone().text()).toBe(201);
    }
    // The walk's first event is core.start: only a non-core row proves a rally was scored.
    const events = await eventsOn(f0!.id);
    expect(events.filter((e) => !e.type.startsWith("core.")).length).toBe(1);
    expect(events).toHaveLength(2);
    for (const e of events) expect(e).toMatchObject({ device_link_id: link.row.id, recorded_by: QUICK_MATCH_SYSTEM_USER_ID });
  });

  it("a score through the guest link touches the quick match; a refused write does not (D5)", async () => {
    const { row, out } = await create();
    const [, f1] = await fixturesOf(out.competitionId);
    const { secret } = await ensureGuestDeviceLink(row, f1!.id);
    await age(row.id);
    const before = await activityOf(row.id);
    const [start] = await firstRallyFor(f1!.id);
    const stale = await post(secret, f1!.id, { ...start!, expected_seq: 99 });   // a stale seq: nothing commits
    expect(stale.status, await stale.clone().text()).toBe(409);
    expect(await activityOf(row.id)).toEqual(before);
    const t0 = Date.now();
    const res = await post(secret, f1!.id, start!);
    expect(res.status, await res.clone().text()).toBe(201);
    const after = await activityOf(row.id);
    expect(after.last.getTime()).toBeGreaterThan(before.last.getTime());
    expect(after.last.getTime()).toBeGreaterThanOrEqual(t0 - 1000);   // now, not merely later
    expect(after.expires!.getTime() - after.last.getTime()).toBe(SPEC_EXPIRY_DAYS * DAY_MS);
  });

  it("a score through a link minted before expiry revives an expired, unswept quick match (C1: the last score counts)", async () => {
    const { row, out } = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const { secret } = await ensureGuestDeviceLink(row, f0!.id);
    await sql`update quick_matches set last_activity_at = now() - interval '8 days', expires_at = now() - interval '1 day'
              where id = ${row.id}`;
    expect(await resolveQuickMatchToken(out.token)).toBeNull();   // the home refuses it now
    const [start] = await firstRallyFor(f0!.id);
    const res = await post(secret, f0!.id, start!);   // the pad left open still scores: a link has no clock
    expect(res.status, await res.clone().text()).toBe(201);
    const revived = await resolveQuickMatchToken(out.token);
    expect(revived?.id).toBe(row.id);
    expect(revived!.expiresAt!.getTime() - revived!.lastActivityAt.getTime()).toBe(SPEC_EXPIRY_DAYS * DAY_MS);
  });

  it("a saved quick match's score moves its activity and leaves its expiry null (§7.7)", async () => {
    const { row, out } = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const saver = await makeUser("qm-saver");
    await sql`update quick_matches set saved_by_user_id = ${saver.id}, expires_at = null where id = ${row.id}`;
    await age(row.id);
    const before = await activityOf(row.id);
    expect(before.expires).toBeNull();
    const { secret } = await ensureGuestDeviceLink(row, f0!.id);
    const [start] = await firstRallyFor(f0!.id);
    expect((await post(secret, f0!.id, start!)).status).toBe(201);
    const after = await activityOf(row.id);
    expect(after.last.getTime()).toBeGreaterThan(before.last.getTime());
    expect(after.expires).toBeNull();
  });

  it("the touch is best-effort: a failing touch neither fails nor rolls back the score, and is logged", async () => {
    const { row, out } = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const { secret } = await ensureGuestDeviceLink(row, f0!.id);
    const [start] = await firstRallyFor(f0!.id);
    const logged = vi.spyOn(log, "error");
    touchSpy.mockRejectedValueOnce(new Error("quick_matches unreachable"));   // this one call; the real touch after it
    const res = await post(secret, f0!.id, start!);
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await eventsOn(f0!.id)).map((e) => e.type)).toEqual(["core.start"]);   // the score stands
    expect(touchesOf(f0!.id)).toBe(1);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ fixture: f0!.id }),
      "scoring: quick match activity touch failed (the score stands)",
    );
    logged.mockRestore();
  });

  it("scope: an ordinary org's score never calls the touch; a quick match's calls it once (negative pair)", async () => {
    const m = builtinModules.find((x) => x.key === "badminton")!;
    const plain = await seedBracket({ sport: "badminton", variant: declaredVariant("badminton", Object.keys(m.variants)[0]!), stageKind: "league", entrants: 2 });
    const plainFixture = plain.fixtureIds[0]!;
    expect(plain.auth.orgId).not.toBe(QUICK_MATCH_SYSTEM_ORG_ID);
    await scoreEvent(plain.auth, plainFixture, { expected_seq: 0, type: "core.start", payload: {} });
    expect((await eventsOn(plainFixture)).map((e) => e.type)).toEqual(["core.start"]);   // it committed
    expect(touchesOf(plainFixture)).toBe(0);

    const { row, out } = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const { secret } = await ensureGuestDeviceLink(row, f0!.id);
    const [start] = await firstRallyFor(f0!.id);
    expect((await post(secret, f0!.id, start!)).status).toBe(201);
    expect(touchesOf(f0!.id)).toBe(1);
  });

  it("a guest link may not abandon, forfeit, settle, finalize or undo another's event (403); nothing lands or touches", async () => {
    const { row, out } = await create();
    const [f0] = await fixturesOf(out.competitionId);
    const { secret } = await ensureGuestDeviceLink(row, f0!.id);
    const [start, play] = await firstRallyFor(f0!.id);
    expect((await post(secret, f0!.id, start!)).status).toBe(201);
    // Another actor's event (an organizer account's: the system user's session), for the void case.
    const other = await scoreEvent(systemAuth(), f0!.id, play!);
    const [{ id: otherId }] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${f0!.id} and seq = ${other.seq}`;
    await age(row.id);
    const before = await activityOf(row.id);
    const touches = touchesOf(f0!.id);
    const ledger = (await eventsOn(f0!.id)).length;
    // Spec C23: abandon, forfeit and settle are organizer-only; finalizing needs an account; a link undoes only its own.
    // Each refusal is pinned by its reason, so a 403 for anything else (a foreign link, a scope) cannot pass for it.
    const refused: [AppendEventRequest, string][] = [
      [{ expected_seq: other.seq, type: "core.abandon", payload: {} }, "Only an organiser can abandon a match"],
      [{ expected_seq: other.seq, type: "core.forfeit", payload: {} }, "Only an organiser can record a walkover for a match"],
      [{ expected_seq: other.seq, type: "core.settle", payload: {} }, "Only an organiser can settle a match"],
      [{ expected_seq: other.seq, type: "core.finalize", payload: {} }, "Finalizing needs an organiser or scorer account"],
      [{ expected_seq: other.seq, type: "core.void", payload: { event_id: otherId } }, "A device link can only undo its own events"],
    ];
    let checked = 0;
    for (const [e, reason] of refused) {
      const res = await post(secret, f0!.id, e);
      const body = (await res.json()) as { error?: { message?: string } };
      expect([res.status, body.error?.message], e.type).toEqual([403, reason]);
      checked++;
    }
    expect(checked).toBe(refused.length);
    expect(checked).toBeGreaterThan(0);
    expect((await eventsOn(f0!.id)).length).toBe(ledger);
    expect(touchesOf(f0!.id)).toBe(touches);
    expect(await activityOf(row.id)).toEqual(before);
  });

  it("every offered sport: the first rally through the guest link lands and re-arms the clock; chess scores its first game (sweep)", async () => {
    const offered = new Map((await listQuickMatchSports()).map((s) => [s.sport_key, s]));
    let rallies = 0;
    let chessGames = 0;
    const visited = await forEachSportAsync(async ({ key }) => {
      const sport = offered.get(key);
      if (!sport) return;   // not offered (generic, the lineup sport): no guest can hold a link to it
      const { row, out } = await create(league({
        sport_key: key,
        variant_key: sport.variants[0]!.variant_key,
        kind: sport.kinds.at(-1)!,
        sides: ["Side A", "Side B"],
      }));
      const [f0] = await fixturesOf(out.competitionId);
      const link = await ensureGuestDeviceLink(row, f0!.id);
      await age(row.id);
      const before = await activityOf(row.id);
      const rally = await firstRallyFor(f0!.id).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
      if (rally instanceof Error) {
        // Chess has no rally (pre-flight carry): every move event decides a game, so the engine's `onePlayEvent` finds
        // none that leaves the match open. Any OTHER sport landing here is a failure, never a skip.
        expect(isChessSport(key), `${key}: ${rally.message}`).toBe(true);
        // And only for THAT reason: the probe's own "no play event" refusal, naming this sport. A crash of any other
        // kind (a fold that throws, a fixture the probe cannot read) is not "chess has no rally" and fails here.
        expect(rally.message).toMatch(new RegExp(`^firstRallyFor: ${key} draws no play event after core\\.start on fixture ${f0!.id}$`));
        const played = await playToDecided(await linkAuth(link.secret, f0!.id), f0!.id);
        expect(played, key).toMatchObject({ kind: "decided" });
        chessGames++;
      } else {
        for (const e of rally) {
          const res = await post(link.secret, f0!.id, e);
          expect(res.status, `${key}: ${await res.clone().text()}`).toBe(201);
        }
        rallies++;
      }
      const events = await eventsOn(f0!.id);
      expect(events.some((e) => !e.type.startsWith("core.")), key).toBe(true);
      expect(events.every((e) => e.device_link_id === link.row.id), key).toBe(true);
      const after = await activityOf(row.id);
      expect(after.last.getTime(), key).toBeGreaterThan(before.last.getTime());
      expect(after.expires!.getTime() - after.last.getTime(), key).toBe(SPEC_EXPIRY_DAYS * DAY_MS);
      await hardDeleteQuickMatchCompetition(out.competitionId);
    });
    console.info(`quick match guest-link sweep: ${rallies} sports scored a rally, ${chessGames} chess scored a game, of ${visited} sport modules (${offered.size} offered)`);
    expect(visited).toBeGreaterThan(0);
    expect(rallies).toBeGreaterThan(0);   // zero checked is a failure
    expect(rallies + chessGames).toBe(offered.size);   // every offered sport, once
  }, SWEEP_TIMEOUT_MS);
});
