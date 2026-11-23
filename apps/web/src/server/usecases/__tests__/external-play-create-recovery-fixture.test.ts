// T17 L1 (controller ruling 2026-10-13) — crash recovery driven through the
// REAL path: createGameIfReady → the real Board API adapter (board-api.ts,
// which reads LICHESS_BASE_URL at import exactly as production does) → HTTP →
// the Lichess fixture server, whose GET /api/challenge serves the LIVE entry
// (NO createdAt, and the ~30 s listing; lichess-fixture-contract.test.ts holds
// it to the recorded bodies). Nothing on the Lichess path is mocked, so this
// cannot pass on a field Lichess never sends.
//
// Only RealtimeKit's seat is stubbed (preflight.seatPlayer): the camera room
// is not the seam under test, and the real one needs the RealtimeKit fixture.
// Chess only: online play exists for the boardgame sport alone.
//
// The ruling: adopt on a UNIQUE match (challenger + Black + clock + rated +
// variant) inside our create window; cancel a matching stray before
// re-creating; hold only when the match is ambiguous. Every expected value is
// the ruling's or the probe's (t17-live-lichess.md §1), never create-game's.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Before ANY import can load board-api: its default client binds the base URL
// at import. A fixed port, because the binding happens before a server could
// report an ephemeral one. 4321 is the e2e fixture's; this suite's is its own.
const FX = vi.hoisted(() => {
  const port = 4333;
  process.env.LICHESS_BASE_URL = `http://127.0.0.1:${port}`;
  return { port };
});

import { sql } from "@/lib/db";
import { __resetCreationQueue } from "@/server/external-play/creation-queue";
import { MINT_CLAIM_STALE_MS } from "@/server/external-play/window";
import { createBoardApi } from "@/server/external-play/lichess/board-api";
import {
  startLichessFixtureServer,
  type LichessFixtureServer,
} from "../../../../e2e/lichess-fixture-server";
import { createGameIfReady } from "../external-play/create-game";
import { sweepExternalPlay } from "../external-play/sweep";
import { NO_PRUNE, NO_WINDOW, seedOnlineChessFixture } from "./_external-play-seed";

const preflight = vi.hoisted(() => ({ seatPlayer: vi.fn() }));
vi.mock("../external-play/preflight", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../external-play/preflight")>()),
  seatPlayer: preflight.seatPlayer,
}));

const HAS_DB = !!process.env.DATABASE_URL;
const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");
/** t17-live-lichess.md §1, MEASURED: listed at +2 s, gone from the list by
 *  +36 s. LICHESS_TIMEOUT_MS (10 s) is how late our send can land after the
 *  marker. Past marker + 46 s a listed challenge cannot be our send. */
const PAST_WINDOW_MS = 5 * 60_000;

let fx: LichessFixtureServer;
let lichess: ReturnType<typeof createBoardApi>;

beforeAll(async () => {
  if (!HAS_DB) return;
  fx = await startLichessFixtureServer(FX.port);
  lichess = createBoardApi({ baseUrl: fx.url });
});
afterAll(async () => {
  await fx?.close();
  await sql.end({ timeout: 2 }).catch(() => undefined);
});
beforeEach(() => {
  vi.clearAllMocks();
  __resetCreationQueue();
  fx?.reset();
  preflight.seatPlayer.mockResolvedValue({ seated: true, participant: null });
});

type Seeded = Awaited<ReturnType<typeof seedOnlineChessFixture>>;
/** A seeded 5+3 board (in SHIP1_TIME_CONTROLS), round open, both linked —
 *  and both players' sealed seed tokens known to the fixture. */
async function seed(): Promise<Seeded & { whiteToken: string; blackToken: string }> {
  const s = await seedOnlineChessFixture({
    onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true, roundOpenedAt: OPENED,
    clock: { base: 300, increment: 3 },
  });
  const whiteToken = `lio_seed_${s.home.lichessId}`;
  const blackToken = `lio_seed_${s.away.lichessId}`;
  fx.registerToken(whiteToken, s.home.lichessId);
  fx.registerToken(blackToken, s.away.lichessId);
  return { ...s, whiteToken, blackToken };
}

/** What the crashed minter's send left at Lichess: White's challenge to
 *  Black, made by the same adapter call production makes. */
async function sendLikeTheCrashedMinter(s: { whiteToken: string; away: { lichessId: string } }, limitSeconds = 300, incrementSeconds = 3): Promise<string> {
  const made = await lichess.createChallengeToUser({ whiteToken: s.whiteToken, blackUsername: s.away.lichessId, limitSeconds, incrementSeconds });
  if (!made.ok) throw new Error(`fixture refused the create: ${made.code} ${made.raw}`);
  return made.challengeId;
}

/** The crashed minter's row: claimed, marked sent `ageMs` before this moment, never
 *  committed. The default age is the earliest takeover (just past stale).
 *  On the WALL clock: T9 dates the marker and its claim on the wall clock at the
 *  write (create-game), and the recovery reads the listing against the wall clock -
 *  the fixture server's own clock is the wall too. NOW (passed as `now` below)
 *  judges the board's window only. */
async function crashedAfterSend(s: Seeded, ageMs = MINT_CLAIM_STALE_MS + 1): Promise<void> {
  const at = new Date(Date.now() - ageMs);
  await sql`
    insert into fixture_external_play (fixture_id, org_id, scheduled_at_basis, mint_claimed_at, create_sent_at)
    values (${s.fixtureId}, ${s.orgId}, ${T}, ${at}, ${at})`;
}

const row = async (fixtureId: string) =>
  (await sql<{ status: string; challenge_id: string | null; needs_reason: string | null; create_sent_at: Date | null; last_error: string | null }[]>`
    select status, challenge_id, needs_reason, create_sent_at, last_error from fixture_external_play where fixture_id = ${fixtureId}`)[0];

/** The fixture's own record of what OUR server did, after the crashed send. */
const callsSince = (n: number) => fx.calls.slice(n).map((c) => `${c.method} ${c.path}`);
const creates = (n: number) => fx.calls.slice(n).filter((c) => c.method === "POST" && /^\/api\/challenge\/[^/]+$/.test(c.path));

describe.skipIf(!HAS_DB)("L1 — a lost create is recovered through the real adapter against the live-shaped fixture", () => {
  it("premise: the fixture's listing carries no createdAt — the field the old matcher waited for", async () => {
    const s = await seed();
    const id = await sendLikeTheCrashedMinter(s);
    const body = (await (await fetch(`${fx.url}/api/challenge`, { headers: { Authorization: `Bearer ${s.whiteToken}` } })).json()) as { out: Record<string, unknown>[] };
    expect(body.out.map((c) => c.id)).toEqual([id]);
    expect(body.out[0]).not.toHaveProperty("createdAt");
  });

  it("UNIQUE: one matching challenge listed inside the window is ADOPTED — Black's token accepts it, no second create; a second call answers already", async () => {
    const s = await seed();
    const sent = await sendLikeTheCrashedMinter(s);
    await crashedAfterSend(s);
    const mark = fx.calls.length;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: sent });
    expect(fx.game(sent)?.status, "the crashed send became the game").toBe("started");
    expect(creates(mark), "no second challenge").toEqual([]);
    const accept = fx.calls.slice(mark).filter((c) => c.path === `/api/challenge/${sent}/accept`);
    expect(accept.map((c) => c.token), "accepted once, by Black").toEqual([s.blackToken]);
    expect(await row(s.fixtureId)).toMatchObject({ status: "ready", challenge_id: sent, create_sent_at: null });
    expect(fx.games().filter((g) => g.status === "started"), "exactly one game").toHaveLength(1);

    const again = fx.calls.length;
    expect(await createGameIfReady(s.fixtureId, { now: NOW }), "sequence: the second call").toEqual({ created: false, reason: "already" });
    expect(callsSince(again), "and it touches Lichess not at all").toEqual([]);
  });

  it("AMBIGUOUS: two matching challenges inside the window ⇒ held for the organiser; neither accepted nor cancelled, nothing sent — and a retry stays held", async () => {
    const s = await seed();
    const [a, b] = [await sendLikeTheCrashedMinter(s), await sendLikeTheCrashedMinter(s)];
    await crashedAfterSend(s);
    const mark = fx.calls.length;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "provider_error" });
    const r = await row(s.fixtureId);
    expect(r).toMatchObject({ status: "needs_organiser", needs_reason: "create_outcome_unknown", challenge_id: null });
    expect(r?.last_error).toContain("ambiguous");
    expect(r?.create_sent_at, "the outcome is still unknown").not.toBeNull();
    expect(fx.game(a)?.status).toBe("created");
    expect(fx.game(b)?.status).toBe("created");
    expect(callsSince(mark).every((c) => c.startsWith("GET ")), `only the lookups: ${callsSince(mark).join(", ")}`).toBe(true);
    expect(callsSince(mark).length, "anti-vacuity: the lookups ran").toBeGreaterThan(0);

    const retry = fx.calls.length;
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(callsSince(retry), "a hold is a status: nothing is looked up or sent").toEqual([]);
  });

  it("NONE (empty case): nothing of the crashed send at Lichess ⇒ re-created — one new challenge, accepted, recorded", async () => {
    const s = await seed();
    await crashedAfterSend(s);
    const mark = fx.calls.length;
    const out = await createGameIfReady(s.fixtureId, { now: NOW });
    expect(out.created, JSON.stringify(out)).toBe(true);
    const made = creates(mark);
    expect(made.map((c) => c.token), "one re-create, White's token").toEqual([s.whiteToken]);
    const id = out.created ? out.gameId : "";
    expect(fx.game(id)?.status).toBe("started");
    expect(await row(s.fixtureId)).toMatchObject({ status: "ready", challenge_id: id, create_sent_at: null });
  });

  it("NONE, the live way: the crashed send has gone OFFLINE (unlisted after ~30 s, measured) ⇒ re-created; exactly one game is started and it is the recorded one", async () => {
    const s = await seed();
    const old = await sendLikeTheCrashedMinter(s);
    await crashedAfterSend(s);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 36_000); // the fixture's clock only; `now` below is the test's
      const out = await createGameIfReady(s.fixtureId, { now: NOW });
      expect(out.created, JSON.stringify(out)).toBe(true);
      const id = out.created ? out.gameId : "";
      expect(id, "a NEW game, not the unlisted one").not.toBe(old);
      const started = fx.games().filter((g) => g.status === "started").map((g) => g.id);
      expect(started, "exactly one game, ours").toEqual([id]);
      expect((await row(s.fixtureId))?.challenge_id).toBe(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("STRAY: past the window a matching listed challenge cannot be our send — it is CANCELLED with White's token before the re-create; a listed challenge that does not match is left alone", async () => {
    const s = await seed();
    const stray = await sendLikeTheCrashedMinter(s);
    const theirs = await sendLikeTheCrashedMinter(s, 180, 2); // White's own 3+2 to Black: not ours
    await crashedAfterSend(s, PAST_WINDOW_MS);
    const mark = fx.calls.length;
    const out = await createGameIfReady(s.fixtureId, { now: NOW });
    expect(out.created, JSON.stringify(out)).toBe(true);
    const id = out.created ? out.gameId : "";
    expect(fx.game(stray)?.status, "the matching stray is cancelled").toBe("canceled");
    expect(fx.game(theirs)?.status, "a non-matching challenge is not ours to touch").toBe("created");
    const order = callsSince(mark);
    const cancelAt = order.indexOf(`POST /api/challenge/${stray}/cancel`);
    const createAt = order.indexOf(`POST /api/challenge/${s.away.lichessId}`);
    expect(cancelAt, order.join(", ")).toBeGreaterThanOrEqual(0);
    expect(cancelAt, "cancelled BEFORE the re-create").toBeLessThan(createAt);
    expect(fx.calls.find((c) => c.path === `/api/challenge/${stray}/cancel`)?.token).toBe(s.whiteToken);
    expect(fx.game(id)?.status).toBe("started");
    expect(fx.games().filter((g) => g.status === "started").map((g) => g.id), "exactly one game").toEqual([id]);
  });
});

// rcs fix round 1, ruling I1: the closed-board cleanup (the sweep's `close_strays`) driven through the REAL adapter against the
// fixture, whose listing drops an unaccepted challenge at 30 s - inside the measured bracket (+32 s offline, gone by +36 s).
// The sweep reaches a closed board only once T9's last claim is stale (30 s after the marker), so by then our own challenge is
// off the list: the board is stamped `not_listed`, nothing is cancelled, and the challenge is STILL acceptable at Lichess. This
// is the residual the ruling accepts (recording the id the moment the create answers closes it), witnessed rather than assumed.
describe.skipIf(!HAS_DB)("I1 — close_strays through the real adapter: our own challenge has left the list before the job can look", () => {
  it("a void 1 s after the send: at +29 s the claim is live and nothing is read; at +31 s one listing (White's token), nothing listed, nothing cancelled - stamped not_listed, the challenge still acceptable", async () => {
    const s = await seed();
    // The send, then the marker and its claim a moment later. T9 writes the marker first, but the fixture lists for 30 s from
    // its OWN stamp of the send, so the marker must not precede it by an unknown seeding delay: with this order, at
    // marker + 31 s the challenge is at least 31 s old - off the list whatever the machine's load.
    const ours = await sendLikeTheCrashedMinter(s);
    await crashedAfterSend(s, 0);
    const [row] = await sql<{ sent: Date }[]>`select create_sent_at as sent from fixture_external_play where fixture_id = ${s.fixtureId}`;
    // LABELLED SQL: the organiser voids the board (a cancelled fixture) right after the send.
    await sql`update fixtures set status = 'cancelled' where id = ${s.fixtureId}`;
    const sweepAt = async (afterMs: number) => {
      vi.setSystemTime(row!.sent.getTime() + afterMs); // the fixture's clock and the sweep's, together
      return sweepExternalPlay({
        ...NO_PRUNE, ...NO_WINDOW, now: new Date(), orgIds: [s.orgId], serialise: false,
        reconcile: async () => null, endMeeting: async () => {},
      });
    };
    const strays = async () =>
      (await sql<{ reason: string | null }[]>`select strays_closed_reason as reason from fixture_external_play where fixture_id = ${s.fixtureId}`)[0]?.reason ?? null;
    const lookups = (n: number) => fx.calls.slice(n).filter((c) => c.method === "GET" && c.path === "/api/challenge");
    const cancels = (n: number) => fx.calls.slice(n).filter((c) => /\/cancel$/.test(c.path));

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const mark = fx.calls.length;
      const early = await sweepAt(MINT_CLAIM_STALE_MS - 1_000);
      expect(early.failures).toEqual([]);
      expect(early.bridgesClosed, "premise: job 0 closed the bridge").toBe(1);
      expect(lookups(mark), "+29 s: the claim is live, the board is not read").toEqual([]);
      expect(await strays()).toBeNull();

      const late = await sweepAt(MINT_CLAIM_STALE_MS + 1_000);
      expect(late.failures).toEqual([]);
      expect(lookups(mark).map((c) => c.token), "+31 s: one listing, with White's token").toEqual([s.whiteToken]);
      expect(cancels(mark), "nothing listed, so nothing cancelled").toEqual([]);
      expect(late.straysCancelled).toBe(0);
      expect(await strays()).toBe("not_listed");
      expect(fx.game(ours)?.status, "THE RESIDUAL: our challenge is unlisted but still acceptable").toBe("created");
    } finally {
      vi.useRealTimers();
    }
  });
});
