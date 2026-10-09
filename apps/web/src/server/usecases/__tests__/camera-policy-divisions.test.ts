// T6 — camera policy end to end: the three-level reader against real
// competition / division / stage rows, the D12 round-open stamp, and the
// division write path (create, patch, the downgrade-only gate, the audit row).
// Single-sport by construction for the readers: only a boardgame division can
// carry online play, so a chess fixture is the only thing they are ever asked
// about. The write path sweeps another sport separately (see below).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import { anyRoundOpened, roundOpenFor } from "@/server/external-play/round-open";
import {
  CAMERA_POLICIES,
  competitionCameraPolicy,
  effectivePolicy,
  fixtureCameraPolicy,
  type CameraPolicy,
} from "@/server/external-play/camera-policy";
import { createCompetition } from "../competitions";
import { createDivision, getDivision, patchDivision } from "../divisions";
import { seedOnlineChessFixture, seedOwner } from "./_external-play-seed";

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

// What the division settings screen shows as INHERITED when the division sets
// nothing: the competition's own column, the floor of the chain.
describe.skipIf(!HAS_DB)("competitionCameraPolicy — the inherited value the settings screen shows", () => {
  it("empty case: a competition nobody configured reads its column default, off", async () => {
    const s = await seedOnlineChessFixture(base);
    const [row] = await sql<{ c: string }[]>`select camera_policy as c from competitions where id = ${s.competitionId}`;
    expect(row?.c, "premise: the column default").toBe("off");
    expect(await competitionCameraPolicy(s.competitionId)).toBe("off");
  });

  it("reads each stored value, and a second change is read back too", async () => {
    const s = await seedOnlineChessFixture(base);
    let checked = 0;
    for (const p of [...CAMERA_POLICIES].reverse()) {
      await sql`update competitions set camera_policy = ${p} where id = ${s.competitionId}`;
      expect(await competitionCameraPolicy(s.competitionId), p).toBe(p);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every declared policy, in sequence").toBe(CAMERA_POLICIES.length);
  });

  it("a competition id that does not exist reads off, not a throw", async () => {
    expect(await competitionCameraPolicy("00000000-0000-0000-0000-000000000000")).toBe("off");
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

// ---------------------------------------------------------------------------
// The division write path (D9, rulings Q1=D / Q2).

const AUDIT_TYPE = "chess.camera_policy_changed";

const authFor = (s: { orgId: string; ownerUserId: string }): AuthCtx =>
  ({ orgId: s.orgId, via: "session", userId: s.ownerUserId, role: "owner", keyId: null }) as AuthCtx;

async function storedPolicy(divisionId: string): Promise<string | null> {
  const [row] = await sql<{ camera_policy: string | null }[]>`
    select camera_policy from divisions where id = ${divisionId}`;
  if (!row) throw new Error(`no division ${divisionId}`);
  return row.camera_policy;
}

async function auditRows(competitionId: string) {
  return sql<{ payload: Record<string, unknown>; actor_id: string | null; org_id: string }[]>`
    select payload, actor_id, org_id from competition_events
     where competition_id = ${competitionId} and type = ${AUDIT_TYPE}
     order by created_at, id`;
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

/** A division with NO stages and NO fixtures — what `seedOnlineChessFixture`
 *  cannot produce (it always creates one fixture). */
async function bareDivision(over: { sport_key?: string; variant_key?: string; camera_policy?: unknown } = {}) {
  const owner = await seedOwner();
  if (!owner.userId) throw new Error("seedOwner returned no userId");
  const competition = await createCompetition(owner, {
    name: "Camera Cup",
    visibility: "private",
    branding: {},
    starts_on: "2026-10-01",
    ends_on: "2026-10-02",
  });
  const sport_key = over.sport_key ?? "boardgame";
  const division = await createDivision(owner, competition.id, {
    name: "Open",
    sport_key,
    variant_key: over.variant_key ?? "classical",
    config: sport_key === "boardgame" ? { variant: "classical" } : {},
    ...(over.camera_policy !== undefined ? { camera_policy: over.camera_policy as CameraPolicy } : {}),
  });
  return { owner, orgId: owner.orgId, ownerUserId: owner.userId, competitionId: competition.id, division };
}

describe.skipIf(!HAS_DB)("camera_policy through createDivision", () => {
  it("empty case: a division created without the field inherits — its own value is null", async () => {
    const b = await bareDivision();
    expect(b.division.camera_policy, "returned row").toBeNull();
    expect(await storedPolicy(b.division.id), "stored row").toBeNull();
  });

  it("create stores each value the organiser can choose, and reports how many it checked", async () => {
    let checked = 0;
    for (const p of CAMERA_POLICIES) {
      const b = await bareDivision({ camera_policy: p });
      expect(b.division.camera_policy, `returned ${p}`).toBe(p);
      expect(await storedPolicy(b.division.id), `stored ${p}`).toBe(p);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(3);
  });

  it("create refuses a value outside the vocabulary — 422 CAMERA_POLICY_INVALID", async () => {
    expect(await refusal(bareDivision({ camera_policy: "mandatory" }))).toEqual({
      status: 422,
      code: "CAMERA_POLICY_INVALID",
    });
  });

  it("another sport: a tennis division refuses a camera requirement but accepts off", async () => {
    // Camera policy exists only for online chess; mirrors onlinePlay's own
    // ONLINE_PLAY_SPORT refusal rather than storing a value nothing reads.
    expect(await refusal(bareDivision({ sport_key: "tennis", variant_key: "tour", camera_policy: "required" })))
      .toEqual({ status: 422, code: "CAMERA_POLICY_SPORT" });
    const ok = await bareDivision({ sport_key: "tennis", variant_key: "tour", camera_policy: "off" });
    expect(await storedPolicy(ok.division.id)).toBe("off");
  });
});

describe.skipIf(!HAS_DB)("camera_policy through patchDivision — downgrade-only once a round is open", () => {
  it("a patch that does not NAME camera_policy leaves the stored value alone, and audits nothing", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "required", roundOpenedAt: OPENED });
    await patchDivision(authFor(s), s.divisionId, { name: "Renamed Open" });
    expect((await getDivision(authFor(s), s.divisionId)).camera_policy).toBe("required");
    expect(await auditRows(s.competitionId)).toHaveLength(0);
  });

  it("empty case: a division with NO fixtures — a tightening is allowed, and audited", async () => {
    // No fixtures ⇒ no round can have been opened ⇒ nothing is locked yet.
    const b = await bareDivision();
    const auth = authFor(b);
    const out = await patchDivision(auth, b.division.id, { camera_policy: "required" });
    expect(out.camera_policy).toBe("required");
    const rows = await auditRows(b.competitionId);
    expect(rows, "exactly one audit row").toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      divisionId: b.division.id,
      stageId: null,
      from: null,
      to: "required",
      effectiveFrom: "off",
      effectiveTo: "required",
      roundOpened: false,
    });
    expect(rows[0]?.actor_id).toBe(b.ownerUserId);
    expect(rows[0]?.org_id).toBe(b.orgId);
  });

  it("fixtures exist but no round is open — a tightening is allowed, and audited", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "off" });
    await patchDivision(authFor(s), s.divisionId, { camera_policy: "required" });
    expect(await storedPolicy(s.divisionId)).toBe("required");
    const rows = await auditRows(s.competitionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ from: "off", to: "required", roundOpened: false });
    expect(rows[0]?.actor_id).toBe(s.ownerUserId);
  });

  it("once a round is OPEN, a tightening is refused 409 POLICY_LOCKED, and nothing is written", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "off", roundOpenedAt: OPENED });
    expect(await refusal(patchDivision(authFor(s), s.divisionId, { camera_policy: "required" }))).toEqual({
      status: 409,
      code: "POLICY_LOCKED",
    });
    expect(await storedPolicy(s.divisionId), "the refused value was not written").toBe("off");
    expect(await auditRows(s.competitionId), "a refused change writes no audit row").toHaveLength(0);
  });

  it("once a round is OPEN, a relaxing patch goes through and is audited", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "required", roundOpenedAt: OPENED });
    await patchDivision(authFor(s), s.divisionId, { camera_policy: "off" });
    expect(await storedPolicy(s.divisionId)).toBe("off");
    const rows = await auditRows(s.competitionId);
    expect(rows, "relaxing after the open is allowed, and audited (D9)").toHaveLength(1);
    expect(rows[0]?.payload).toEqual({
      divisionId: s.divisionId,
      stageId: null,
      from: "required",
      to: "off",
      effectiveFrom: "required",
      effectiveTo: "off",
      roundOpened: true,
    });
  });

  it("the SEQUENCE after the open: two relaxations each audited, then a re-tighten refused", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "required", roundOpenedAt: OPENED });
    const auth = authFor(s);
    await patchDivision(auth, s.divisionId, { camera_policy: "optional" });
    await patchDivision(auth, s.divisionId, { camera_policy: "off" });
    expect(await refusal(patchDivision(auth, s.divisionId, { camera_policy: "optional" }))).toEqual({
      status: 409,
      code: "POLICY_LOCKED",
    });
    expect(await storedPolicy(s.divisionId)).toBe("off");
    const rows = await auditRows(s.competitionId);
    expect(rows.map((r) => [r.payload.from, r.payload.to])).toEqual([
      ["required", "optional"],
      ["optional", "off"],
    ]);
  });

  it("re-sending the SAME value after the open is a no-op — not a 409, and no audit row", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "required", roundOpenedAt: OPENED });
    await patchDivision(authFor(s), s.divisionId, { camera_policy: "required" });
    expect(await storedPolicy(s.divisionId)).toBe("required");
    expect(await auditRows(s.competitionId)).toHaveLength(0);
  });

  it("the gate judges the EFFECTIVE policy: clearing to inherit a stricter competition is an upgrade", async () => {
    // Differential: the stored values go 'off' → null, which a stored-rank
    // comparison cannot even rank; what players get goes off → required.
    const s = await seedOnlineChessFixture({
      ...base,
      competitionCameraPolicy: "required",
      cameraPolicy: "off",
      roundOpenedAt: OPENED,
    });
    expect(await refusal(patchDivision(authFor(s), s.divisionId, { camera_policy: null }))).toEqual({
      status: 409,
      code: "POLICY_LOCKED",
    });
    expect(await storedPolicy(s.divisionId)).toBe("off");
  });

  it("…and clearing to inherit a LAXER competition is a relaxation, audited with both views", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "required", roundOpenedAt: OPENED });
    await patchDivision(authFor(s), s.divisionId, { camera_policy: null });
    expect(await storedPolicy(s.divisionId)).toBeNull();
    const [row] = await auditRows(s.competitionId);
    expect(row?.payload).toMatchObject({
      from: "required",
      to: null,
      effectiveFrom: "required",
      effectiveTo: effectivePolicy({ stage: null, division: null, competition: "off" }),
    });
  });

  it("a division WITH fixtures can change its policy alongside a re-sent config (not a format change)", async () => {
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "off" });
    const [{ locked }] = await sql<{ locked: boolean }[]>`
      select exists(
        select 1 from fixtures f join stages st on st.id = f.stage_id
         where st.division_id = ${s.divisionId}
      ) as locked`;
    expect(locked, "premise: this division is format-locked").toBe(true);
    // Re-send the STORED config, clock included: the patch path merges the
    // variant preset with what it is sent, so a config without the stored
    // clock would be a format change and 409 FORMAT_LOCKED for the wrong reason.
    const before = await getDivision(authFor(s), s.divisionId);
    const out = await patchDivision(authFor(s), s.divisionId, {
      config: before.config as Record<string, unknown>,
      camera_policy: "optional",
    });
    expect(out.camera_policy).toBe("optional");
    expect(out.config, "the config round-tripped unchanged").toEqual(before.config);
  });

  it("another org's owner cannot change it: 404, nothing written, no audit row", async () => {
    // The round-open read runs on the privileged client before the tenant
    // transaction; this proves the tenant read still decides visibility.
    const s = await seedOnlineChessFixture({ ...base, cameraPolicy: "required", roundOpenedAt: OPENED });
    const stranger = await bareDivision();
    expect(await refusal(patchDivision(authFor(stranger), s.divisionId, { camera_policy: "off" }))).toEqual({
      status: 404,
      code: undefined,
    });
    expect(await storedPolicy(s.divisionId)).toBe("required");
    expect(await auditRows(s.competitionId)).toHaveLength(0);
  });

  it("a junk value is refused 422 CAMERA_POLICY_INVALID before anything is read", async () => {
    const s = await seedOnlineChessFixture(base);
    expect(
      await refusal(patchDivision(authFor(s), s.divisionId, { camera_policy: "mandatory" as CameraPolicy })),
    ).toEqual({ status: 422, code: "CAMERA_POLICY_INVALID" });
  });

  it("another sport: patching a tennis division to a camera requirement is refused 422 CAMERA_POLICY_SPORT", async () => {
    const b = await bareDivision({ sport_key: "tennis", variant_key: "tour" });
    expect(await refusal(patchDivision(authFor(b), b.division.id, { camera_policy: "optional" }))).toEqual({
      status: 422,
      code: "CAMERA_POLICY_SPORT",
    });
    expect(await storedPolicy(b.division.id)).toBeNull();
  });
});

// Fix round (controller, M-4): the settings select now offers "Use the
// competition setting", which saves null. A pinned division must be able to go
// back to inheriting; the move is audited like any other change and judged by
// the EFFECTIVE policy it produces. Expected values are typed from the seeded
// levels, never read from effectivePolicy.
describe.skipIf(!HAS_DB)("M-4: a pinned division returns to inherit (camera_policy null)", () => {
  it("the SEQUENCE: pinned → inherit (audited, readers now give the competition's value) → re-send null is a no-op → pinned again", async () => {
    const s = await seedOnlineChessFixture({ ...base, competitionCameraPolicy: "optional", cameraPolicy: "required" });
    // Premise: the pin is what players get, and it differs from the competition's.
    expect(await fixtureCameraPolicy(s.fixtureId), "premise: the pin wins").toBe("required");
    expect(await competitionCameraPolicy(s.competitionId), "premise: the competition says optional").toBe("optional");

    await patchDivision(authFor(s), s.divisionId, { camera_policy: null });
    expect(await storedPolicy(s.divisionId), "stored row: inherit").toBeNull();
    expect((await getDivision(authFor(s), s.divisionId)).camera_policy, "returned row: inherit").toBeNull();
    expect(await fixtureCameraPolicy(s.fixtureId), "the effective reader now gives the competition's value").toBe("optional");
    const one = await auditRows(s.competitionId);
    expect(one).toHaveLength(1);
    expect(one[0]?.payload).toMatchObject({
      divisionId: s.divisionId,
      from: "required",
      to: null,
      effectiveFrom: "required",
      effectiveTo: "optional",
      roundOpened: false,
    });
    expect(one[0]?.actor_id).toBe(s.ownerUserId);

    // A second inherit save changes nothing: no row, no error.
    await patchDivision(authFor(s), s.divisionId, { camera_policy: null });
    expect(await auditRows(s.competitionId), "re-sending null is a no-op").toHaveLength(1);

    // And it can be pinned again from there.
    await patchDivision(authFor(s), s.divisionId, { camera_policy: "off" });
    expect(await storedPolicy(s.divisionId)).toBe("off");
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("off");
    const two = await auditRows(s.competitionId);
    expect(two).toHaveLength(2);
    expect(two[1]?.payload).toMatchObject({ from: null, to: "off", effectiveFrom: "optional", effectiveTo: "off" });
  });

  it("after a round opens, inherit that leaves what players get UNCHANGED is allowed and audited", async () => {
    // Pinned 'required' under a 'required' competition: clearing the pin is
    // not a tightening (required → required), so the downgrade-only rule does
    // not refuse it — the stored value changes, the effective one does not.
    const s = await seedOnlineChessFixture({
      ...base,
      competitionCameraPolicy: "required",
      cameraPolicy: "required",
      roundOpenedAt: OPENED,
    });
    await patchDivision(authFor(s), s.divisionId, { camera_policy: null });
    expect(await storedPolicy(s.divisionId)).toBeNull();
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("required");
    const [row] = await auditRows(s.competitionId);
    expect(row?.payload).toMatchObject({
      from: "required",
      to: null,
      effectiveFrom: "required",
      effectiveTo: "required",
      roundOpened: true,
    });
  });

  it("after a round opens, inherit that TIGHTENS what players get is refused 409 and leaves no row", async () => {
    // Pinned 'optional' under a 'required' competition (the existing case
    // covers 'off'): inheriting would raise optional → required.
    const s = await seedOnlineChessFixture({
      ...base,
      competitionCameraPolicy: "required",
      cameraPolicy: "optional",
      roundOpenedAt: OPENED,
    });
    expect(await refusal(patchDivision(authFor(s), s.divisionId, { camera_policy: null }))).toEqual({
      status: 409,
      code: "POLICY_LOCKED",
    });
    expect(await storedPolicy(s.divisionId)).toBe("optional");
    expect(await fixtureCameraPolicy(s.fixtureId)).toBe("optional");
    expect(await auditRows(s.competitionId)).toHaveLength(0);
  });
});
