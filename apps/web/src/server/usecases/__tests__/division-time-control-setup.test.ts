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
/** Owner ruling 2026-10-09: 10+0 and 15+0 join the ship-1 list. Typed from the
 *  ruling (minutes x 60, no increment), not read from the catalogue. */
const TEN_PLUS_ZERO: Clock = { base: 600, increment: 0 };
const FIFTEEN_PLUS_ZERO: Clock = { base: 900, increment: 0 };
/** Passes both measured rules (1200s >= 180, a multiple of 60) and is NOT on
 *  the list: the off-list clock the legacy cases below stand on. 15+0 played
 *  that part until the 2026-10-09 ruling made it legal. */
const TWENTY_PLUS_ZERO: Clock = { base: 1200, increment: 0 };

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

  it("10+0 and 15+0 with online play are accepted and stored (owner ruling 2026-10-09); 1+0 still is not", async () => {
    let checked = 0;
    for (const clock of [TEN_PLUS_ZERO, FIFTEEN_PLUS_ZERO]) {
      const { division } = await createBoardgame("lichess", clock);
      expect((division.config as { clock?: Clock }).clock, JSON.stringify(clock)).toEqual(clock);
      checked += 1;
    }
    expect(checked, "anti-vacuity: both ruled-in controls").toBe(2);
    // The pair: widening the list did not widen it to sudden-death bullet.
    expect(await refusal(createBoardgame("lichess", ONE_PLUS_ZERO))).toEqual({
      status: 400,
      code: "INVALID_TIME_CONTROL",
    });
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

  it("the SEQUENCE: an online division moves to 10+0, then a 1+0 save is refused and 10+0 stays", async () => {
    const { owner, division } = await createBoardgame("lichess", THREE_PLUS_ZERO);
    const moved = await patchDivision(owner, division.id, {
      config: { variant: "classical", onlinePlay: "lichess", clock: TEN_PLUS_ZERO },
    });
    expect(moved.config).toMatchObject({ onlinePlay: "lichess", clock: TEN_PLUS_ZERO });
    expect(
      await refusal(
        patchDivision(owner, division.id, {
          config: { variant: "classical", onlinePlay: "lichess", clock: ONE_PLUS_ZERO },
        }),
      ),
    ).toEqual({ status: 400, code: "INVALID_TIME_CONTROL" });
    const after = await getDivision(owner, division.id);
    expect((after.config as { clock?: Clock }).clock, "nothing was written").toEqual(TEN_PLUS_ZERO);
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

// T6 fix round 1 (review I-1). The gate judges a CHANGE of the clock or of
// online play, never a save that merely carries the stored ones. Otherwise a
// locked division saved before the gate existed could never save its entrants
// again: the Entrants save re-sends the whole stored config (the format lock's
// one exception door), and the only repair, changing the clock, is itself 409.
describe.skipIf(!HAS_DB)("the clock gate judges a change, not a re-send", () => {
  // PRE-GATE LEGACY DATA. Each clock below is one the division save path now
  // refuses for online play, so the product can no longer CREATE such a row —
  // it is written by SQL onto an already-locked division to model one saved
  // before the gate existed: an off-list 20+0, a 1+0, a delay clock, and no
  // clock at all. (The old seed default 15+0 stood first here until the owner
  // ruled it onto the list, 2026-10-09; it is no longer refused.)
  const PRE_GATE: { label: string; clock: Clock | null }[] = [
    { label: "20+0 (passes both measured rules, off the list)", clock: TWENTY_PLUS_ZERO },
    { label: "1+0", clock: ONE_PLUS_ZERO },
    { label: "a delay clock", clock: { base: 900, increment: 0, delay: 5 } },
    { label: "no clock at all", clock: null },
  ];

  async function lockedPreGateDivision(clock: Clock | null) {
    const s = await seedOnlineChessFixture({
      onlinePlay: "lichess",
      divisionStarted: true,
      scheduledAt: new Date("2026-10-01T12:10:00.000Z"),
      linked: true,
    });
    if (clock) {
      await sql`
        update divisions set config = jsonb_set(config, '{clock}', ${sql.json(clock)})
         where id = ${s.divisionId}`;
    } else {
      await sql`update divisions set config = config - 'clock' where id = ${s.divisionId}`;
    }
    const auth = { orgId: s.orgId, via: "session", userId: s.ownerUserId, role: "owner", keyId: null } as AuthCtx;
    const [{ locked }] = await sql<{ locked: boolean }[]>`
      select exists(select 1 from fixtures f join stages st on st.id = f.stage_id
                     where st.division_id = ${s.divisionId}) as locked`;
    expect(locked, "premise: the division is format-locked (it has a fixture)").toBe(true);
    const before = await getDivision(auth, s.divisionId);
    expect((before.config as { clock?: unknown }).clock ?? null, "premise: the legacy clock is stored").toEqual(clock);
    expect((before.config as { onlinePlay?: string }).onlinePlay, "premise: online play is on").toBe("lichess");
    return { auth, divisionId: s.divisionId, before: before.config as Record<string, unknown> };
  }

  it("a locked division with a pre-gate clock can still save its entrants, for every legacy clock", async () => {
    let checked = 0;
    for (const { label, clock } of PRE_GATE) {
      const { auth, divisionId, before } = await lockedPreGateDivision(clock);
      const entrants = { kinds: ["individual"], defaultKind: "individual" };
      const out = await patchDivision(auth, divisionId, { config: { ...before, entrants } });
      expect((out.config as { entrants?: unknown }).entrants, label).toEqual(entrants);
      expect((out.config as { clock?: unknown }).clock ?? null, `${label}: the clock is untouched`).toEqual(clock);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every pre-gate clock").toBe(PRE_GATE.length);
    expect(checked, "premise: the legacy set is not empty").toBeGreaterThan(0);
  });

  it("the positive pair: on that locked division a clock CHANGE is still refused", async () => {
    const { auth, divisionId, before } = await lockedPreGateDivision(TWENTY_PLUS_ZERO);
    expect(
      await refusal(patchDivision(auth, divisionId, { config: { ...before, clock: ONE_PLUS_ZERO } })),
    ).toEqual({ status: 409, code: "FORMAT_LOCKED" });
  });

  it("a LOCKED division turning online play ON over a pre-gate clock is refused, and nothing is written", async () => {
    // The format lock's SECOND door (re-review N-1): withoutDivisionMetaKeys
    // strips onlinePlay as well as entrants, so a division with fixtures may
    // still switch online play on. An over-the-board division mid-season on
    // an off-list 20+0 must not reach Lichess that way. A gate keyed on
    // `!locked` would let it through; the change predicate's onlinePlay arm
    // must not.
    const { auth, divisionId } = await lockedPreGateDivision(TWENTY_PLUS_ZERO);
    // PRE-GATE LEGACY DATA, continued: the same division saved over the board.
    await sql`update divisions set config = config - 'onlinePlay' where id = ${divisionId}`;
    const before = (await getDivision(auth, divisionId)).config as Record<string, unknown>;
    expect(before.onlinePlay, "premise: online play is off (absent)").toBeUndefined();
    expect(
      await refusal(patchDivision(auth, divisionId, { config: { ...before, onlinePlay: "lichess" } })),
    ).toEqual({ status: 400, code: "INVALID_TIME_CONTROL" });
    const after = (await getDivision(auth, divisionId)).config as Record<string, unknown>;
    expect(after.onlinePlay, "nothing was written").toBeUndefined();
  });

  it("an unlocked online division changing ONLY its clock to an unplayable one is still refused", async () => {
    // Online play is already on and stays on, so only the clock arm of the
    // "did it change" predicate can fire here.
    const { owner, division } = await createBoardgame("lichess", THREE_PLUS_ZERO);
    expect(
      await refusal(
        patchDivision(owner, division.id, {
          config: { variant: "classical", onlinePlay: "lichess", clock: ONE_PLUS_ZERO },
        }),
      ),
    ).toEqual({ status: 400, code: "INVALID_TIME_CONTROL" });
    const after = await getDivision(owner, division.id);
    expect((after.config as { clock?: Clock }).clock, "nothing was written").toEqual(THREE_PLUS_ZERO);
  });
});
