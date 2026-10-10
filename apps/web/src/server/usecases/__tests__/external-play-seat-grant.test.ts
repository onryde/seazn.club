// T9 fix round 2 (controller ruling): the seat asks T2's play gate and maps
// ONLY its two 422 refusals to seat reasons. Anything else the gate throws —
// a 503 LICHESS_TOKEN_UNAVAILABLE, a database error — is not a consent
// refusal and must propagate, never be swallowed as "re-link".
//
// A file of its own because it replaces the gate with a double: the double
// passes through to the REAL gate unless a case arms a failure, and the
// refusal paths themselves are tested against the real gate in
// external-play-preflight.test.ts. Single sport, deliberately: online play
// exists only for boardgame (ONLINE_PLAY_SPORT).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("../external-accounts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../external-accounts")>();
  return {
    ...real,
    assertLichessConsentForPlay: vi.fn(async (userId: string | null) => {
      if (gate.fail) throw gate.fail;
      return real.assertLichessConsentForPlay(userId);
    }),
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { seatPlayer } from "../external-play/preflight";
import { assertLichessConsentForPlay } from "../external-accounts";
import { seedOnlineChessFixture } from "./_external-play-seed";

const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const NOW = new Date("2026-10-01T12:05:00.000Z");

beforeEach(() => {
  gate.fail = null;
  vi.mocked(assertLichessConsentForPlay).mockClear();
});
afterAll(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!process.env.DATABASE_URL)("the seat's grant check propagates what is not a consent refusal", () => {
  const seed = () =>
    seedOnlineChessFixture({
      onlinePlay: "lichess", divisionStarted: true, scheduledAt: T, linked: true,
      roundOpenedAt: OPENED, cameraPolicy: "off",
    });

  it("premise: with nothing armed the real gate answers, and the seat asks it for the caller", async () => {
    const s = await seed();
    expect(await seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW }))
      .toEqual({ seated: true, participant: null });
    expect(assertLichessConsentForPlay).toHaveBeenCalledWith(s.home.userId);
  });

  it("a 503 LICHESS_TOKEN_UNAVAILABLE and a plain error both PROPAGATE — swept and counted", async () => {
    const failures: Error[] = [
      new HttpError(503, "Lichess token cannot be opened", "LICHESS_TOKEN_UNAVAILABLE"),
      new HttpError(422, "some other refusal", "SOMETHING_ELSE"),
      new Error("database is down"),
    ];
    let checked = 0;
    for (const err of failures) {
      const s = await seed();
      gate.fail = err;
      await expect(seatPlayer({ fixtureId: s.fixtureId, personId: s.home.personId }, { now: NOW }), err.message)
        .rejects.toBe(err);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});
