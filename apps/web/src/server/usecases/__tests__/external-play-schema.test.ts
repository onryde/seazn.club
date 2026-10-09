// apps/web/src/server/usecases/__tests__/external-play-schema.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import { seedFutureDivision, seedOrg } from "./_seed";

/** Postgres names a column CHECK `<table>_<column>_check` and a table CHECK
 *  `<table>_check`. Asserting the name is what stops an FK error, or the
 *  other CHECK, from satisfying a rejection test. */
const VOCABULARY_CHECK = "fixture_external_play_needs_reason_check";
const COUPLING_CHECK = "fixture_external_play_check";
const CONSENT_TOKEN_CHECK = "user_external_accounts_consent_token_check";
const CONSENT_SCOPES_CHECK = "user_external_accounts_consent_scopes_check";
const INVITE_CHECK = "fixture_external_play_invite_needs_open_round_check";
const ROUND_OPEN_FK = "fixture_external_play_round_open_id_fkey";
/** The constraint trigger raises under this name, with one message per
 *  refusal — the messages are the trigger's declaration, typed here. */
const ROUND_BINDING = "fixture_external_play_round_open_binding";
const BINDING_OTHER_ORG = "round_open_id names a round opened in another organisation";
const BINDING_OTHER_STAGE = "round_open_id names a round of another stage";
const BINDING_OTHER_ROUND = "round_open_id names another round of this stage";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

type Outcome =
  | { accepted: true; row: { status: string; needs_reason: string | null } }
  | { accepted: false; code: string | undefined; constraint: string | undefined };

describe.skipIf(!process.env.DATABASE_URL)("external play schema (V432/V433)", () => {
  let orgId = "";
  let fixtureId = "";
  // D12 binding rig: the fixture's own (stage, round), a SECOND stage in the
  // same org, and a stage in a FOREIGN org — each with an owner to open it.
  let fixtureStageId = "";
  let fixtureRoundNo = 0;
  let ownerId = "";
  let otherStageId = "";
  let foreignOrgId = "";
  let foreignStageId = "";
  let foreignOwnerId = "";

  async function ownerOf(org: string): Promise<string> {
    const [m] = await sql<{ user_id: string }[]>`
      select user_id from org_members where org_id = ${org} and role = 'owner' limit 1`;
    if (!m) throw new Error(`org ${org} has no owner`);
    return m.user_id;
  }

  beforeAll(async () => {
    const { auth } = await seedOrg();
    const { fixtures } = await seedFutureDivision(auth);
    const [first] = fixtures;
    if (!first) throw new Error("seedFutureDivision produced no fixtures");
    orgId = auth.orgId;
    fixtureId = first.id;
    const [f] = await sql<{ stage_id: string; round_no: number }[]>`
      select stage_id, round_no from fixtures where id = ${fixtureId}`;
    fixtureStageId = f!.stage_id;
    fixtureRoundNo = f!.round_no;
    ownerId = await ownerOf(orgId);

    const second = await seedFutureDivision(auth);
    const [s2] = await sql<{ stage_id: string }[]>`
      select stage_id from fixtures where id = ${second.fixtures[0]!.id}`;
    otherStageId = s2!.stage_id;

    const { auth: foreign } = await seedOrg();
    const third = await seedFutureDivision(foreign);
    const [s3] = await sql<{ stage_id: string }[]>`
      select stage_id from fixtures where id = ${third.fixtures[0]!.id}`;
    foreignOrgId = foreign.orgId;
    foreignStageId = s3!.stage_id;
    foreignOwnerId = await ownerOf(foreignOrgId);

    // Premises, not decoration: each binding case is only meaningful if the
    // thing it calls "other" really is other.
    if (otherStageId === fixtureStageId) throw new Error("second stage is the fixture's stage");
    if (foreignOrgId === orgId) throw new Error("foreign org is the fixture's org");
  });

  afterAll(async () => {
    await sql.end();
  });

  async function columns(table: string): Promise<string[]> {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = ${table}
       order by column_name`;
    return rows.map((r) => r.column_name);
  }

  /** Insert one bridge row against a REAL org + fixture (so no FK can fire),
   *  read it back, and roll back — every case reuses the same fixture. */
  async function tryInsert(status: string, needsReason: string | null): Promise<Outcome> {
    const rollback = new Error("rollback");
    let row: { status: string; needs_reason: string | null } | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`
          insert into fixture_external_play (fixture_id, org_id, status, scheduled_at_basis, needs_reason)
          values (${fixtureId}, ${orgId}, ${status}, now(), ${needsReason})`;
        [row] = await tx<{ status: string; needs_reason: string | null }[]>`
          select status, needs_reason from fixture_external_play where fixture_id = ${fixtureId}`;
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && row) return { accepted: true, row };
      const e = err as { code?: string; constraint_name?: string };
      return { accepted: false, code: e.code, constraint: e.constraint_name };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }

  it("user_external_accounts carries the sealed token, scopes and consent (V432)", async () => {
    expect(await columns("user_external_accounts")).toEqual([
      "access_token_enc", "consented_at", "created_at", "external_user_id",
      "id", "provider", "scopes", "updated_at", "user_id", "username",
    ]);
  });

  /** One account row against a REAL user (so no FK can fire), read back, rolled back. */
  async function tryAccount(a: {
    token: Buffer | null;
    scopes: string[];
    consentedAt: Date | null;
  }): Promise<Outcome> {
    const rollback = new Error("rollback");
    let row: { status: string; needs_reason: string | null } | undefined;
    try {
      await sql.begin(async (tx) => {
        const [u] = await tx<{ id: string }[]>`
          insert into users (email, display_name, email_verified)
          values (${`v432-${randomUUID()}@test.local`}, 'V432', true) returning id`;
        await tx`
          insert into user_external_accounts
            (user_id, provider, external_user_id, username, access_token_enc, scopes, consented_at)
          values (${u!.id}, 'lichess', ${`lid-${randomUUID().slice(0, 8)}`}, 'Player',
                  ${a.token}, ${a.scopes}, ${a.consentedAt})`;
        row = { status: "accepted", needs_reason: null };
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && row) return { accepted: true, row };
      const e = err as { code?: string; constraint_name?: string };
      return { accepted: false, code: e.code, constraint: e.constraint_name };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }

  it("refuses a stored token with no consent timestamp", async () => {
    expect(await tryAccount({
      token: Buffer.from("sealed"), scopes: ["board:play"], consentedAt: null,
    })).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: CONSENT_TOKEN_CHECK });
  });

  it("refuses a consent timestamp with no stored token", async () => {
    expect(await tryAccount({
      token: null, scopes: ["board:play"], consentedAt: new Date(),
    })).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: CONSENT_TOKEN_CHECK });
  });

  it("refuses consent with an empty scope list", async () => {
    expect(await tryAccount({
      token: Buffer.from("sealed"), scopes: [], consentedAt: new Date(),
    })).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: CONSENT_SCOPES_CHECK });
  });

  // The EMPTY case, stated first in spirit: a legacy identity-only row — the
  // state every already-linked player is in — must stay legal, or V432 cannot
  // be applied to a database that has one.
  it("accepts a legacy identity-only row: no token, no scopes, no consent", async () => {
    expect(await tryAccount({ token: null, scopes: [], consentedAt: null }))
      .toEqual({ accepted: true, row: { status: "accepted", needs_reason: null } });
  });

  it("accepts a sealed token with scopes and consent", async () => {
    expect(await tryAccount({
      token: Buffer.from("sealed"), scopes: ["board:play", "challenge:write"],
      consentedAt: new Date(),
    })).toEqual({ accepted: true, row: { status: "accepted", needs_reason: null } });
  });

  it("fixture_external_play has exactly the design §3 + D12 columns (V432, V434)", async () => {
    // D12 adds round_open_id ONLY: the invite stamps are the pre-existing
    // per-seat white_emailed_at / black_emailed_at — no second invite column.
    // V434 drops url_white / url_black: under D3 there is no per-colour
    // lichess.org link to hand a player. V434 also adds create_sent_at, T9's
    // durable "a create was sent" marker (fix round 1, I2).
    expect(await columns("fixture_external_play")).toEqual([
      "black_emailed_at", "black_lichess_id", "challenge_id", "create_sent_at", "created_at", "expires_at",
      "finished_at", "fixture_id", "last_error", "last_polled_at",
      "mint_claimed_at", "needs_reason", "org_id", "provider", "round_open_id",
      "scheduled_at_basis", "started_at", "status", "updated_at",
      "video_override_at", "white_emailed_at", "white_lichess_id", "white_side",
    ]);
  });

  type OpenRef = "none" | "dangling" | "own" | "other-stage" | "other-round" | "other-org";
  type InviteOutcome =
    | { accepted: true }
    | { accepted: false; code: string | undefined; constraint: string | undefined; message: string };

  /** Create (inside `tx`, so it rolls back) the open row `ref` describes and
   *  return its id. "own" is the fixture's stage + round; every "other-*"
   *  differs from it in exactly the named way and nothing else that the
   *  composite FK allows (a foreign org's row is necessarily a foreign
   *  stage's, at the fixture's round number). */
  async function openRow(tx: Tx, ref: OpenRef): Promise<string | null> {
    if (ref === "none") return null;
    if (ref === "dangling") return randomUUID();
    const target = {
      own: { stage: fixtureStageId, org: orgId, round: fixtureRoundNo, by: ownerId },
      "other-stage": { stage: otherStageId, org: orgId, round: fixtureRoundNo, by: ownerId },
      "other-round": { stage: fixtureStageId, org: orgId, round: fixtureRoundNo + 1, by: ownerId },
      "other-org": { stage: foreignStageId, org: foreignOrgId, round: fixtureRoundNo, by: foreignOwnerId },
    }[ref];
    const [open] = await tx<{ id: string }[]>`
      insert into stage_round_opens (stage_id, org_id, round_no, opened_by)
      values (${target.stage}, ${target.org}, ${target.round}, ${target.by})
      returning id`;
    return open!.id;
  }

  /** One bridge row carrying (or not) the per-seat invite stamps and a round
   *  open reference, against the SAME real org + fixture every other case
   *  uses, rolled back. `then`, when given, re-points round_open_id with an
   *  UPDATE after the insert — the trigger's second entry point. */
  async function tryInvite(a: {
    white?: Date | null;
    black?: Date | null;
    roundOpen: OpenRef;
    then?: OpenRef;
  }): Promise<InviteOutcome> {
    const rollback = new Error("rollback");
    let reached = false;
    try {
      await sql.begin(async (tx) => {
        const openId = await openRow(tx, a.roundOpen);
        await tx`
          insert into fixture_external_play
            (fixture_id, org_id, status, scheduled_at_basis, round_open_id,
             white_emailed_at, black_emailed_at)
          values (${fixtureId}, ${orgId}, 'pending', now(), ${openId},
                  ${a.white ?? null}, ${a.black ?? null})`;
        if (a.then) {
          const nextId = await openRow(tx, a.then);
          await tx`
            update fixture_external_play set round_open_id = ${nextId}
             where fixture_id = ${fixtureId}`;
        }
        reached = true;
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && reached) return { accepted: true };
      const e = err as { code?: string; constraint_name?: string; message?: string };
      return {
        accepted: false, code: e.code, constraint: e.constraint_name, message: e.message ?? "",
      };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }

  // D12, the invariant that matters: a fixture cannot be marked invited before
  // its round is opened. The wrong answer differs from the right one by having
  // sent a real email on a round that had not started. One refusal PER SEAT,
  // so each disjunct of the CHECK is killable on its own.
  it("refuses a WHITE seat stamp with no opened round", async () => {
    expect(await tryInvite({ white: new Date(), roundOpen: "none" })).toMatchObject({
      accepted: false, code: CHECK_VIOLATION, constraint: INVITE_CHECK,
    });
  });

  it("refuses a BLACK seat stamp with no opened round", async () => {
    expect(await tryInvite({ black: new Date(), roundOpen: "none" })).toMatchObject({
      accepted: false, code: CHECK_VIOLATION, constraint: INVITE_CHECK,
    });
  });

  it("refuses a seat stamp naming a round open that does not exist", async () => {
    expect(await tryInvite({ white: new Date(), roundOpen: "dangling" })).toMatchObject({
      accepted: false, code: FK_VIOLATION, constraint: ROUND_OPEN_FK,
    });
  });

  // The positive pair for every refusal below: the fixture's OWN round, open,
  // carrying both seat stamps.
  it("accepts both seat stamps once THIS fixture's round is opened", async () => {
    expect(await tryInvite({ white: new Date(), black: new Date(), roundOpen: "own" }))
      .toEqual({ accepted: true });
  });

  // The empty case: the state every fixture is in before the organiser presses
  // Open round. Neither column set, and that must stay legal.
  it("accepts a bridge row with neither an open round nor a seat stamp", async () => {
    expect(await tryInvite({ roundOpen: "none" })).toEqual({ accepted: true });
  });

  // And the other direction: a round opened but nobody invited yet is the state
  // between the press and the send. An over-tight CHECK would refuse it.
  it("accepts an opened round with no seat stamp yet", async () => {
    expect(await tryInvite({ roundOpen: "own" })).toEqual({ accepted: true });
  });

  // The binding (reviewer probe, 2026-10-09): CHECK + FK alone accepted a
  // fixture whose own round had NO open row, by naming another round's row.
  // In each case below the fixture's own (stage, round) is never opened.
  it("refuses a round_open_id naming another STAGE's open row", async () => {
    expect(await tryInvite({ white: new Date(), roundOpen: "other-stage" })).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: ROUND_BINDING,
      message: BINDING_OTHER_STAGE,
    });
  });

  it("refuses a round_open_id naming another ROUND of the same stage", async () => {
    expect(await tryInvite({ white: new Date(), roundOpen: "other-round" })).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: ROUND_BINDING,
      message: BINDING_OTHER_ROUND,
    });
  });

  it("refuses a round_open_id naming another ORGANISATION's open row", async () => {
    expect(await tryInvite({ white: new Date(), roundOpen: "other-org" })).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: ROUND_BINDING,
      message: BINDING_OTHER_ORG,
    });
  });

  // Second call: the binding holds on UPDATE too — a row legally bound to its
  // own round cannot be re-pointed at another round afterwards.
  it("refuses re-pointing a bound row at another round by UPDATE", async () => {
    expect(await tryInvite({ roundOpen: "own", then: "other-round" })).toEqual({
      accepted: false, code: CHECK_VIOLATION, constraint: ROUND_BINDING,
      message: BINDING_OTHER_ROUND,
    });
  });

  // ...and its positive pair: an UPDATE from no round to THIS fixture's round
  // is the write T19 makes when the organiser presses Open round.
  it("accepts binding an unbound row to its own round by UPDATE", async () => {
    expect(await tryInvite({ roundOpen: "none", then: "own" })).toEqual({ accepted: true });
  });

  // Design §3.6: a token revoked mid-match is NOT a no-show and must not be
  // recorded as one; a blocked double walkover is its own state. Both are
  // written by T12, so the vocabulary has to admit them here.
  it.each(["token_revoked", "double_walkover_blocked"])(
    "accepts needs_reason %s",
    async (reason) => {
      expect(await tryInsert("needs_organiser", reason)).toEqual({
        accepted: true,
        row: { status: "needs_organiser", needs_reason: reason },
      });
    },
  );

  it("rejects a needs_reason outside the vocabulary", async () => {
    expect(await tryInsert("needs_organiser", "no_show_grace_elapsed")).toEqual({
      accepted: false,
      code: CHECK_VIOLATION,
      constraint: VOCABULARY_CHECK,
    });
  });

  it("rejects needs_organiser without a needs_reason", async () => {
    expect(await tryInsert("needs_organiser", null)).toEqual({
      accepted: false,
      code: CHECK_VIOLATION,
      constraint: COUPLING_CHECK,
    });
  });

  it("rejects a needs_reason on a row that is not needs_organiser", async () => {
    expect(await tryInsert("pending", "aborted")).toEqual({
      accepted: false,
      code: CHECK_VIOLATION,
      constraint: COUPLING_CHECK,
    });
  });

  it("accepts needs_organiser with a vocabulary reason", async () => {
    expect(await tryInsert("needs_organiser", "no_show_black")).toEqual({
      accepted: true,
      row: { status: "needs_organiser", needs_reason: "no_show_black" },
    });
  });

  it("accepts pending with no needs_reason", async () => {
    expect(await tryInsert("pending", null)).toEqual({
      accepted: true,
      row: { status: "pending", needs_reason: null },
    });
  });
});
