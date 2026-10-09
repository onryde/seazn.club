// T6 (carrying T5-I1): the curated time-control gate runs AT SETUP — on the
// division create and patch paths — so an organiser who picks a clock the
// Board API will not play (M12: 1+0 is created, then every move is refused)
// learns it while editing the division, not at round open.
// Single-sport by construction: only a boardgame division can carry
// onlinePlay 'lichess' (ONLINE_PLAY_SPORT), and the gate applies only there.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { SHIP1_TIME_CONTROLS } from "@/server/external-play/time-controls";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { seedOnlineChessFixture, seedOwner } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

type Clock = { base: number; increment?: number; delay?: number };

async function freshCompetition() {
  const owner = await seedOwner();
  const competition = await createCompetition(owner, {
    name: "Clock Cup",
    visibility: "private",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  return { owner, competitionId: competition.id };
}

async function createBoardgame(onlinePlay: "off" | "lichess", clock?: Clock) {
  const { owner, competitionId } = await freshCompetition();
  return createDivision(owner, competitionId, {
    name: "Open",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", onlinePlay, ...(clock ? { clock } : {}) },
  }).then((division) => ({ owner, division }));
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string | undefined }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("expected a refusal, the call succeeded");
}

const ONE_PLUS_ZERO: Clock = { base: 60, increment: 0 };
const THREE_PLUS_ZERO: Clock = { base: 180, increment: 0 };

describe.skipIf(!HAS_DB)("createDivision refuses an unplayable online clock", () => {
  it("1+0 with online play is refused 400 INVALID_TIME_CONTROL", async () => {
    expect(await refusal(createBoardgame("lichess", ONE_PLUS_ZERO))).toEqual({
      status: 400,
      code: "INVALID_TIME_CONTROL",
    });
  });

  it("the refusal carries the catalogue keys, so the settings screen can list them in any locale", async () => {
    let caught: unknown;
    try {
      await createBoardgame("lichess", ONE_PLUS_ZERO);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).extra).toEqual({ controls: SHIP1_TIME_CONTROLS.map((t) => t.key) });
  });

  it("3+0 with online play is accepted and stored", async () => {
    const { division } = await createBoardgame("lichess", THREE_PLUS_ZERO);
    expect((division.config as { clock?: Clock }).clock).toEqual(THREE_PLUS_ZERO);
  });

  it("every curated control is accepted, and the sweep reports how many it checked", async () => {
    let checked = 0;
    for (const tc of SHIP1_TIME_CONTROLS) {
      const clock = { base: tc.limitSeconds, increment: tc.incrementSeconds };
      const { division } = await createBoardgame("lichess", clock);
      expect((division.config as { clock?: Clock }).clock, tc.key).toEqual(clock);
      checked += 1;
    }
    expect(checked, "anti-vacuity: the whole ship-1 catalogue").toBe(SHIP1_TIME_CONTROLS.length);
    expect(checked, "premise: the catalogue is not empty").toBeGreaterThan(0);
  });

  it("empty case: online play with NO clock is refused — there is nothing to play", async () => {
    expect(await refusal(createBoardgame("lichess"))).toEqual({ status: 400, code: "INVALID_TIME_CONTROL" });
  });

  it("a delay clock with online play is refused (Lichess has no delay)", async () => {
    expect(await refusal(createBoardgame("lichess", { base: 180, increment: 0, delay: 2 }))).toEqual({
      status: 400,
      code: "INVALID_TIME_CONTROL",
    });
  });

  it("over-the-board chess is untouched: 1+0 and no clock are both fine with online play off", async () => {
    const a = await createBoardgame("off", ONE_PLUS_ZERO);
    expect((a.division.config as { clock?: Clock }).clock).toEqual(ONE_PLUS_ZERO);
    const b = await createBoardgame("off");
    expect((b.division.config as { clock?: Clock }).clock).toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("patchDivision refuses an unplayable online clock", () => {
  it("the SEQUENCE on an unlocked division: 1+0 refused and not written, then 3+0 accepted", async () => {
    const { owner, division } = await createBoardgame("off", THREE_PLUS_ZERO);
    expect(
      await refusal(
        patchDivision(owner, division.id, {
          config: { variant: "classical", onlinePlay: "lichess", clock: ONE_PLUS_ZERO },
        }),
      ),
    ).toEqual({ status: 400, code: "INVALID_TIME_CONTROL" });
    const after = await getDivision(owner, division.id);
    expect((after.config as { onlinePlay?: string }).onlinePlay, "nothing was written").toBeUndefined();
    const ok = await patchDivision(owner, division.id, {
      config: { variant: "classical", onlinePlay: "lichess", clock: THREE_PLUS_ZERO },
    });
    expect(ok.config).toMatchObject({ onlinePlay: "lichess", clock: THREE_PLUS_ZERO });
  });

  it("turning online play ON over a stored unplayable clock is refused", async () => {
    const { owner, division } = await createBoardgame("off", ONE_PLUS_ZERO);
    expect(
      await refusal(
        patchDivision(owner, division.id, {
          config: { variant: "classical", onlinePlay: "lichess", clock: ONE_PLUS_ZERO },
        }),
      ),
    ).toEqual({ status: 400, code: "INVALID_TIME_CONTROL" });
  });

  it("turning online play OFF is never blocked by the clock", async () => {
    const { owner, division } = await createBoardgame("lichess", THREE_PLUS_ZERO);
    const out = await patchDivision(owner, division.id, {
      config: { variant: "classical", onlinePlay: "off", clock: ONE_PLUS_ZERO },
    });
    expect((out.config as { onlinePlay?: string }).onlinePlay).toBeUndefined();
  });

  it("a format-locked division keeps the lock's precedence: a clock change is 409, never 400", async () => {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
      linked: true,
    });
    const auth = { orgId: s.orgId, via: "session", userId: s.ownerUserId, role: "owner", keyId: null } as AuthCtx;
    const before = await getDivision(auth, s.divisionId);
    expect(
      await refusal(
        patchDivision(auth, s.divisionId, {
          config: { ...(before.config as Record<string, unknown>), clock: ONE_PLUS_ZERO },
        }),
      ),
    ).toEqual({ status: 409, code: "FORMAT_LOCKED" });
  });
});
