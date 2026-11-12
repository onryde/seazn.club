// Quick match: `quick_match_deleted` (controller ruling 2026-11-12, for /admin/quick-matches). A hard delete leaves no row, so
// the admin page cannot tell "deleted by its saver" from "expired"; this one PostHog event can. Fired by the two deletes of a
// quick match a guest made: the saver's Delete (`deleteSavedQuickMatch`, via "saver") and the sweep's expiry
// (`sweepQuickMatches`, via "expiry"). Carries { via, sport_key, kind } and nothing else: no token, no address, no user id
// beyond the distinct id `captureServer` attaches.
//
// Each path fires it ONCE; a refused delete fires nothing: a second Delete, someone else's Delete, a sweep that keeps a match a
// score revived, a second sweep, and the create's own compensation (a create that failed, which no guest ever had).
//
// Every match is made by the real create, saved by the real Save, scored by the real write path, swept by the real sweep. The
// UPDATEs are the clock (an expiry moved into the past). The event's name and properties are the ruling's, typed here.
//
// Sports: badminton and football (the team sport offered: a different kind), since `sport_key` and `kind` are the payload.
//
// Real Postgres required; skipped without DATABASE_URL.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn<(args: unknown) => Promise<void>>(async () => undefined));
vi.mock("@/lib/posthog-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/posthog-server")>()),
  captureServer: capture,
}));

vi.stubEnv("DEVICE_LINK_KEK", randomBytes(32).toString("hex")); // every create seals a home token

import { sql } from "@/lib/db";
import { QUICK_MATCH_ERRORS, QUICK_MATCH_SYSTEM_ORG_ID, QUICK_MATCH_SYSTEM_USER_ID } from "@/lib/quick-match-constants";
import { createQuickMatch, systemAuth, type CreatedQuickMatch } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { deleteSavedQuickMatch } from "../quick-match-owner";
import { saveQuickMatchForUser } from "../quick-match-save";
import { listQuickMatchSports } from "../quick-match-sports";
import { sweepQuickMatches } from "../quick-match-sweep";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";
import { scoreEvent } from "../scoring";
import { firstRallyFor } from "./_quick-match-probe";
import { makeUser } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const HOUR_MS = 3600 * 1000;
/** The ruling's event name, typed (a rename in analytics-events.ts reds this). */
const EVENT = "quick_match_deleted";
const SPORTS = ["badminton", "football"] as const;

const competitions: string[] = [];
const users: string[] = [];

async function create(sportKey: string, over: { fail?: () => void } = {}): Promise<CreatedQuickMatch & { kind: string }> {
  const sport = (await listQuickMatchSports()).find((s) => s.sport_key === sportKey);
  if (!sport) throw new Error(`premise: ${sportKey} is offered for quick matches`);
  const kind = sport.kinds.at(-1)!;
  const out = await createQuickMatch(
    {
      name: `QM deleted ${randomUUID().slice(0, 8)}`,
      sport_key: sportKey,
      variant_key: sport.variants[0]!.variant_key,
      kind,
      format: "league",
      sides: ["Side A", "Side B"],
      plays: 1,
      email: null,
      locale: "en",
    },
    {
      visitorHash: hashVisitorKey(mintVisitorKey()),
      baseUrl: "https://qm-deleted.test",
      mailAllowed: async () => true,
      _failBeforeGenerateForTests: over.fail,
    },
  );
  competitions.push(out.competitionId);
  return { ...out, kind };
}

async function saver(): Promise<string> {
  const u = await makeUser("qm-deleted-saver");
  users.push(u.id);
  return u.id;
}

/** The deleted events captured so far. */
const deletedEvents = () =>
  capture.mock.calls.map((c) => c[0] as { event: string; distinctId: string; orgId?: string; properties?: unknown }).filter((a) => a.event === EVENT);

beforeEach(() => {
  capture.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  for (const id of competitions) await hardDeleteQuickMatchCompetition(id).catch(() => undefined);
  if (users.length > 0) await sql`delete from users where id = any(${users}::uuid[])`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("quick_match_deleted: the saver's Delete", () => {
  it.each(SPORTS)("%s: fires once with { via: saver, sport_key, kind }; a second Delete and a stranger's Delete fire nothing", async (sportKey) => {
    const m = await create(sportKey);
    const owner = await saver();
    expect(await saveQuickMatchForUser(owner, m.id), "premise: the real Save kept it").toBe("saved");
    const stranger = await saver();
    capture.mockClear();

    // Someone else's Delete: refused, nothing deleted, nothing sent.
    await expect(deleteSavedQuickMatch(stranger, m.id)).rejects.toMatchObject({ status: 404, code: QUICK_MATCH_ERRORS.NOT_IN_ACCOUNT });
    expect(deletedEvents()).toEqual([]);

    await deleteSavedQuickMatch(owner, m.id);
    expect(deletedEvents()).toEqual([
      { event: EVENT, distinctId: owner, orgId: QUICK_MATCH_SYSTEM_ORG_ID, properties: { via: "saver", sport_key: sportKey, kind: m.kind } },
    ]);

    // The second Delete: refused, and still the one event.
    await expect(deleteSavedQuickMatch(owner, m.id)).rejects.toMatchObject({ status: 404, code: QUICK_MATCH_ERRORS.NOT_IN_ACCOUNT });
    expect(deletedEvents().length).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("quick_match_deleted: the sweep's expiry", () => {
  it.each(SPORTS)("%s: fires once with { via: expiry, sport_key, kind }; a second sweep fires nothing", async (sportKey) => {
    const m = await create(sportKey);
    const now = new Date();
    await sql`update quick_matches set expires_at = ${new Date(now.getTime() - HOUR_MS)},
                last_activity_at = ${new Date(now.getTime() - 8 * 24 * HOUR_MS)} where id = ${m.id}`;
    capture.mockClear();

    expect(await sweepQuickMatches({ baseUrl: "https://qm-deleted.test", now, onlyIds: [m.id] })).toMatchObject({ expired: 1, failed: 0 });
    expect(deletedEvents()).toEqual([
      { event: EVENT, distinctId: QUICK_MATCH_SYSTEM_USER_ID, orgId: QUICK_MATCH_SYSTEM_ORG_ID, properties: { via: "expiry", sport_key: sportKey, kind: m.kind } },
    ]);

    expect(await sweepQuickMatches({ baseUrl: "https://qm-deleted.test", now, onlyIds: [m.id] })).toMatchObject({ expired: 0 });
    expect(deletedEvents().length).toBe(1);
  });

  it("a match past its expiry that a recent score keeps (the delete's own re-check refuses) fires nothing", async () => {
    const m = await create("badminton");
    const [f] = await sql<{ id: string }[]>`
      select f.id from fixtures f join divisions d on d.id = f.division_id where d.competition_id = ${m.competitionId}
       order by f.round_no, f.fixture_no limit 1`;
    for (const req of await firstRallyFor(f!.id)) await scoreEvent(systemAuth(), f!.id, req);
    const now = new Date();
    // The clock: the expiry moved into the past while the score stays recent (a touch that was lost).
    await sql`update quick_matches set expires_at = ${new Date(now.getTime() - HOUR_MS)} where id = ${m.id}`;
    capture.mockClear();

    const report = await sweepQuickMatches({ baseUrl: "https://qm-deleted.test", now, onlyIds: [m.id] });
    expect(report, "premise: the delete kept it").toMatchObject({ expired: 0, deferred: 1 });
    expect(deletedEvents()).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("quick_match_deleted: what is not a deleted quick match", () => {
  it("the create's compensation (a create that failed, which no guest ever had) fires nothing", async () => {
    capture.mockClear();
    await expect(create("badminton", { fail: () => { throw new Error("armed: the create fails (test)"); } })).rejects.toThrow("armed");
    expect(deletedEvents()).toEqual([]);
    // Anti-vacuity: a create that fails sends no created event either, so the mock saw the whole attempt.
    expect(capture.mock.calls.filter((c) => (c[0] as { event: string }).event === "quick_match_created")).toEqual([]);
  });
});
