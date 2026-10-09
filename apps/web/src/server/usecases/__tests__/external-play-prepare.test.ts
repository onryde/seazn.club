/**
 * What survives of the inherited prepareExternalPlayWindow suite (T9
 * rewrite). Its first case — the lobby email, the Ready handshake, the
 * countdown and the re-mint after a missed countdown — tested the
 * lichess.org mode D3 deleted, and is gone with it: the invite is sent when
 * the organiser opens the round (no task owns that yet), and "nothing is
 * created until both players are present" now lives in
 * external-play-create-game.test.ts and its property.
 *
 * Its second case — a DELAY clock is never played online — still holds, but
 * the data it needs can no longer be made through the product:
 * createDivision refuses a delay clock (assertTimeControl, T5/T6). So the
 * clock below is written by SQL after a valid create: PRE-GATE LEGACY DATA,
 * the shape a division saved before that gate would still have. The old
 * expected bridge row (needs_organiser / delay_unsupported) is gone with the
 * mode that wrote it; the guard now treats such a division as simply not
 * online (guard.ts's own declaration), which T9's outcome table answers with
 * `not_ready`.
 *
 * Single-sport by construction: online play exists only for `boardgame`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createGameIfReady } from "../external-play/create-game";
import { seedOnlineChessFixture } from "./_external-play-seed";

const board = vi.hoisted(() => ({ createChallengeToUser: vi.fn(), acceptChallenge: vi.fn() }));
vi.mock("@/server/external-play/lichess/board-api", () => board);

const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");

let GM = "";
beforeEach(() => {
  vi.clearAllMocks();
  GM = `gm-${randomUUID().slice(0, 12)}`;
  board.createChallengeToUser.mockResolvedValue({ ok: true, challengeId: GM });
  board.acceptChallenge.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

/** Opened, started, both linked, camera policy off (the competition
 *  default), so T8's REAL seat lets both players in: the clock is the only
 *  thing that differs between the two cases below. */
const seed = () =>
  seedOnlineChessFixture({
    onlinePlay: "lichess",
    divisionStarted: true,
    scheduledAt: T,
    linked: true,
    roundOpenedAt: OPENED,
    clock: { base: 300, increment: 0 },
  });

describe.skipIf(!process.env.DATABASE_URL)("a legacy delay clock is never played online", () => {
  it("positive control: the same board on its valid 5+0 clock is created", async () => {
    const s = await seed();
    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: true, gameId: GM });
  });

  it("a PRE-GATE delay clock (5 min, 3 s delay) ⇒ not_ready, no Lichess call, no bridge row", async () => {
    const s = await seed();
    // PRE-GATE LEGACY DATA: createDivision would refuse this clock today.
    await sql`
      update divisions
         set config = jsonb_set(config, '{clock}', ${sql.json({ base: 300, delay: 3 } as never)})
       where id = ${s.divisionId}`;
    const [d] = await sql<{ clock: unknown }[]>`select config->'clock' as clock from divisions where id = ${s.divisionId}`;
    expect(d?.clock, "premise: the legacy clock is what the division now holds").toEqual({ base: 300, delay: 3 });

    expect(await createGameIfReady(s.fixtureId, { now: NOW })).toEqual({ created: false, reason: "not_ready" });
    expect(board.createChallengeToUser).not.toHaveBeenCalled();
    expect(board.acceptChallenge).not.toHaveBeenCalled();
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_external_play where fixture_id = ${s.fixtureId}`;
    expect(n, "nothing is recorded for a board that is not online").toBe(0);
  });
});
