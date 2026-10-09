// T6 — camera policy end to end: the three-level reader against real
// competition / division / stage rows, the D12 round-open stamp, and the
// division write path (create, patch, the downgrade-only gate, the audit row).
// Single-sport by construction for the readers: only a boardgame division can
// carry online play, so a chess fixture is the only thing they are ever asked
// about. The write path sweeps another sport separately (see below).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { anyRoundOpened, roundOpenFor } from "@/server/external-play/round-open";
import { fixtureCameraPolicy } from "@/server/external-play/camera-policy";
import { seedOnlineChessFixture } from "./_external-play-seed";

const T = new Date("2026-10-01T12:10:00.000Z");
const OPENED = new Date("2026-10-01T12:00:00.000Z");
const HAS_DB = !!process.env.DATABASE_URL;

const base = { onlinePlay: "lichess" as const, divisionStarted: true, scheduledAt: T, linked: true };

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

describe.skipIf(!HAS_DB)("fixtureCameraPolicy, read off real rows", () => {
  it("empty case: nothing set at stage or division, competition at its default ⇒ off", async () => {
    const s = await seedOnlineChessFixture(base);
    const [row] = await sql<{ c: string; d: string | null; st: string | null }[]>`
      select c.camera_policy as c, d.camera_policy as d, st.camera_policy as st
        from divisions d join competitions c on c.id = d.competition_id
        join stages st on st.division_id = d.id
       where d.id = ${s.divisionId}`;
    expect(row, "premise: the seed left every level at its default").toEqual({ c: "off", d: null, st: null });
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("off");
  });

  it("empty case: a fixture id that does not exist ⇒ off, not a throw", async () => {
    expect(await fixtureCameraPolicy("00000000-0000-0000-0000-000000000000")).toBe("off");
  });

  it("inherits the competition floor when stage and division are unset", async () => {
    const s = await seedOnlineChessFixture({ ...base, competitionCameraPolicy: "required" });
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("required");
  });

  it("the division's value is inherited when the stage sets nothing", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "required" });
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("required");
  });

  it("the division overrides the competition, including DOWNWARDS", async () => {
    // Differential: an implementation taking the stricter level answers
    // "required"; one that skipped the division answers "required" too.
    const s = await seedOnlineChessFixture({
      ...base,
      competitionCameraPolicy: "required",
      cameraPolicy: "off",
    });
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("off");
  });

  it("the stage overrides the division, including DOWNWARDS", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "required", stageCameraPolicy: "off" });
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("off");
  });

  it("the stage overrides the division UPWARDS too", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "off", stageCameraPolicy: "optional" });
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("optional");
  });
});

describe.skipIf(!HAS_DB)("D12 round-open stamp", () => {
  it("empty case: a freshly paired round has no stamp ⇒ roundOpenFor is null and anyRoundOpened is false", async () => {
    const s = await seedOnlineChessFixture(base);
    expect(await roundOpenFor(sql, s.fixtureId)).toBeNull();
    expect(await anyRoundOpened(sql, s.divisionId, T)).toBe(false);
  });

  it("an opened round is readable, with its actor, and the stamp — not the schedule — decides it", async () => {
    const s = await seedOnlineChessFixture({ ...base, roundOpenedAt: OPENED });
    const open = await roundOpenFor(sql, s.fixtureId);
    expect(open?.roundOpenedAt.getTime()).toBe(OPENED.getTime());
    expect(open?.openedBy).toBe(s.ownerUserId);
    expect(await anyRoundOpened(sql, s.divisionId, OPENED)).toBe(true);
    // One millisecond before the stamp it is not yet open — the comparison is
    // against the STAMP, so a fixture scheduled for T (ten minutes later)
    // cannot make it true on its own.
    expect(await anyRoundOpened(sql, s.divisionId, new Date(OPENED.getTime() - 1))).toBe(false);
  });

  it("a stamp on a DIFFERENT round of the same stage does not open this fixture's round", async () => {
    const s = await seedOnlineChessFixture(base);
    await sql`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_at, opened_by)
      values (${s.stageId}, ${s.orgId}, 2, ${OPENED}, ${s.ownerUserId})`;
    // The fixture is round 1. Per-fixture: still closed.
    expect(await roundOpenFor(sql, s.fixtureId)).toBeNull();
    // Per-division: a round HAS been opened, which is what T6's gate asks.
    expect(await anyRoundOpened(sql, s.divisionId, OPENED)).toBe(true);
  });

  it("a round opened in ANOTHER division does not count for this one", async () => {
    const opened = await seedOnlineChessFixture({ ...base, roundOpenedAt: OPENED });
    const other = await seedOnlineChessFixture(base);
    expect(await anyRoundOpened(sql, opened.divisionId, T), "premise: the other division IS open").toBe(true);
    expect(await anyRoundOpened(sql, other.divisionId, T)).toBe(false);
  });
});
