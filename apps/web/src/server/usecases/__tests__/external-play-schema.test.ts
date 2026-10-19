// apps/web/src/server/usecases/__tests__/external-play-schema.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import { NEEDS_REASONS } from "@/server/external-play/types";
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

describe.skipIf(!process.env.DATABASE_URL)("external play schema (V451/V452)", () => {
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

  it("user_external_accounts carries the sealed token, scopes and consent (V451)", async () => {
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
          values (${`v433-${randomUUID()}@test.local`}, 'V451', true) returning id`;
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
  // state every already-linked player is in — must stay legal, or V451 cannot
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

  it("fixture_external_play has exactly the design §3 + D12 columns (V451, V453, V454, V465)", async () => {
    // D12 adds round_open_id ONLY: the invite stamps are the pre-existing
    // per-seat white_emailed_at / black_emailed_at — no second invite column.
    // V453 drops url_white / url_black: under D3 there is no per-colour
    // lichess.org link to hand a player. V453 also adds create_sent_at, T9's
    // durable "a create was sent" marker (fix round 1, I2). V454 adds T10's
    // move ledger: the seven columns of the plan's §3.4 contract plus the two
    // per-side offer plies lila's 20-ply re-offer rule needs, and (T11 fix
    // round 1, ruling M7) the seat a token_revoked hold froze, (T13,
    // carry M4) the sweep's count of consecutive reads that told it nothing,
    // and (T13 fix round 1) the game's first-read end (I1) and the move T10
    // is submitting (I4). V465 adds the arbiter's check-in extension (spec §3.2.2): the milliseconds
    // added to the board's deadline and the number of presses that made them.
    expect(await columns("fixture_external_play")).toEqual([
      "black_draw_offer_ply", "black_emailed_at", "black_lichess_id", "black_ms",
      "challenge_id", "checkin_extensions", "checkin_extra_ms", "clock_increment_s", "create_sent_at", "created_at",
      "draw_offer_by", "expires_at", "finished_at", "fixture_id", "game_over_at", "last_error",
      "last_move_at", "last_polled_at", "mint_claimed_at", "move_count", "moves_uci",
      "needs_reason", "org_id", "pending_move_at", "pending_move_ply", "pending_move_uci",
      "provider", "revoked_seat", "round_open_id",
      "scheduled_at_basis", "started_at", "status", "sweep_no_truth_reads", "updated_at",
      "video_override_at", "white_draw_offer_ply", "white_emailed_at", "white_lichess_id",
      "white_ms", "white_side",
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
  // written by T12, so the vocabulary has to admit them here. `not_started`
  // is T13's (controller ruling C2): both players came, no game was made.
  it.each(["token_revoked", "double_walkover_blocked", "not_started"])(
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

  // ---------------------------------------------------------------------------
  // V454 — T10's move ledger. One named CHECK per guarded fact; each refusal
  // below asserts SQLSTATE + constraint name and is paired with an accepted
  // row that differs from it in the one guarded value.
  const LEDGER_CHECK = "fixture_external_play_move_ledger_check";
  const DRAW_BY_CHECK = "fixture_external_play_draw_offer_by_check";
  const CLOCK_CHECK = "fixture_external_play_clock_check";
  const OFFER_PLY_CHECK = "fixture_external_play_draw_offer_ply_check";

  type LedgerRow = {
    moves_uci: unknown;
    move_count: number;
    draw_offer_by: string | null;
    white_ms: number | null;
    black_ms: number | null;
  };
  type LedgerOutcome =
    | { accepted: true; row: LedgerRow }
    | { accepted: false; code: string | undefined; constraint: string | undefined };

  /** A pending bridge row on the shared real fixture, carrying the given
   *  ledger columns (`moves` as jsonb; omitted columns take their defaults),
   *  read back and rolled back. */
  async function tryLedger(cols: {
    moves?: unknown;
    move_count?: number;
    draw_offer_by?: string | null;
    white_ms?: number | null;
    black_ms?: number | null;
    clock_increment_s?: number | null;
    white_draw_offer_ply?: number | null;
    black_draw_offer_ply?: number | null;
  }): Promise<LedgerOutcome> {
    const rollback = new Error("rollback");
    let row: LedgerRow | undefined;
    const { moves, ...rest } = cols;
    const values: Record<string, unknown> = {
      fixture_id: fixtureId, org_id: orgId, status: "pending", scheduled_at_basis: new Date(), ...rest,
    };
    if (moves !== undefined) values.moves_uci = sql.json(moves as never);
    try {
      await sql.begin(async (tx) => {
        await tx`insert into fixture_external_play ${tx(values as never)}`;
        [row] = await tx<LedgerRow[]>`
          select moves_uci, move_count, draw_offer_by, white_ms, black_ms
            from fixture_external_play where fixture_id = ${fixtureId}`;
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && row) return { accepted: true, row };
      const e = err as { code?: string; constraint_name?: string };
      return { accepted: false, code: e.code, constraint: e.constraint_name };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }
  const refusedBy = (constraint: string) => ({ accepted: false, code: CHECK_VIOLATION, constraint });

  it("V454: a row that says nothing about moves is an EMPTY ledger (every existing row stays valid)", async () => {
    expect(await tryLedger({})).toEqual({
      accepted: true,
      row: { moves_uci: [], move_count: 0, draw_offer_by: null, white_ms: null, black_ms: null },
    });
  });

  it("V454: a ledger whose count equals its length is accepted", async () => {
    expect(await tryLedger({ moves: ["e2e4", "e7e5"], move_count: 2 })).toMatchObject({
      accepted: true, row: { moves_uci: ["e2e4", "e7e5"], move_count: 2 },
    });
  });

  it("V454: a count LONGER than the ledger is refused", async () => {
    expect(await tryLedger({ moves: ["e2e4"], move_count: 2 })).toEqual(refusedBy(LEDGER_CHECK));
  });

  it("V454: a count SHORTER than the ledger is refused (the other direction of the equality)", async () => {
    expect(await tryLedger({ moves: ["e2e4", "e7e5"], move_count: 1 })).toEqual(refusedBy(LEDGER_CHECK));
  });

  it("V454: a ledger that is not a JSON array is refused by the ledger CHECK, not a 22023", async () => {
    expect(await tryLedger({ moves: { e2: "e4" }, move_count: 0 })).toEqual(refusedBy(LEDGER_CHECK));
  });

  it("V454: draw_offer_by takes exactly white or black", async () => {
    let checked = 0;
    const two = { moves: ["e2e4", "e7e5"], move_count: 2 };
    for (const side of ["white", "black"]) {
      expect(await tryLedger({ ...two, draw_offer_by: side }), side).toMatchObject({ accepted: true });
      checked++;
    }
    expect(await tryLedger({ ...two, draw_offer_by: "home" })).toEqual(refusedBy(DRAW_BY_CHECK));
    expect(checked, "anti-vacuity: accepted colours").toBe(2);
  });

  it("V454: no offer STANDS before ply 2, from either side — lila registers none earlier (Game.scala playerCanOfferDraw)", async () => {
    // The guard play.ts's draw broadcast relies on: every one is at ply >= 2,
    // where the clock runs (review m2).
    let checked = 0;
    for (const side of ["white", "black"]) {
      for (const [moves, move_count] of [[["e2e4"], 1], [[], 0]] as const) {
        expect(await tryLedger({ moves: [...moves], move_count, draw_offer_by: side }), `${side} at ${move_count}`)
          .toEqual(refusedBy(DRAW_BY_CHECK));
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 sides × plies 1 and 0").toBe(4);
  });

  it("V454: a zero clock is a clock; a NEGATIVE one is refused, on each of the three columns", async () => {
    expect(await tryLedger({ white_ms: 0, black_ms: 0, clock_increment_s: 0 })).toMatchObject({ accepted: true });
    let checked = 0;
    for (const col of ["white_ms", "black_ms", "clock_increment_s"] as const) {
      expect(await tryLedger({ [col]: -1 }), col).toEqual(refusedBy(CLOCK_CHECK));
      checked++;
    }
    expect(checked, "anti-vacuity: clock columns").toBe(3);
  });

  it("V454: an offer ply within [2, move_count] is accepted, on each side", async () => {
    let checked = 0;
    const three = ["e2e4", "e7e5", "g1f3"];
    for (const col of ["white_draw_offer_ply", "black_draw_offer_ply"] as const) {
      expect(await tryLedger({ moves: three, move_count: 3, [col]: 2 }), `${col}=2`).toMatchObject({ accepted: true });
      expect(await tryLedger({ moves: three, move_count: 3, [col]: 3 }), `${col}=3`).toMatchObject({ accepted: true });
      checked++;
    }
    expect(checked, "anti-vacuity: offer-ply columns").toBe(2);
  });

  it("V454: an offer ply BELOW 2 is refused, on each side — lila registers no offer before ply 2 (Game.scala playerCanOfferDraw)", async () => {
    let checked = 0;
    const three = ["e2e4", "e7e5", "g1f3"];
    for (const col of ["white_draw_offer_ply", "black_draw_offer_ply"] as const) {
      for (const ply of [1, 0]) {
        expect(await tryLedger({ moves: three, move_count: 3, [col]: ply }), `${col}=${ply}`)
          .toEqual(refusedBy(OFFER_PLY_CHECK));
        checked++;
      }
    }
    expect(checked, "anti-vacuity: 2 columns × 2 plies").toBe(4);
  });

  it("V454: an offer ply BEYOND the ledger, or negative, is refused, on each side", async () => {
    let checked = 0;
    for (const col of ["white_draw_offer_ply", "black_draw_offer_ply"] as const) {
      expect(await tryLedger({ moves: ["e2e4", "e7e5"], move_count: 2, [col]: 3 }), `${col}=3`)
        .toEqual(refusedBy(OFFER_PLY_CHECK));
      expect(await tryLedger({ [col]: -1 }), `${col}=-1`).toEqual(refusedBy(OFFER_PLY_CHECK));
      checked++;
    }
    expect(checked, "anti-vacuity: offer-ply columns").toBe(2);
  });

  // ---------------------------------------------------------------------------
  // V454, T11 fix round 1 (ruling M7): the seat a token_revoked hold froze.
  const SEAT_CHECK = "fixture_external_play_revoked_seat_check";
  type SeatOutcome =
    | { accepted: true; row: { needs_reason: string | null; revoked_seat: string | null } }
    | { accepted: false; code: string | undefined; constraint: string | undefined };
  async function trySeat(cols: { status: string; needs_reason: string | null; revoked_seat: string | null }): Promise<SeatOutcome> {
    const rollback = new Error("rollback");
    let row: { needs_reason: string | null; revoked_seat: string | null } | undefined;
    try {
      await sql.begin(async (tx) => {
        await tx`insert into fixture_external_play ${tx({ fixture_id: fixtureId, org_id: orgId, scheduled_at_basis: new Date(), ...cols } as never)}`;
        [row] = await tx<{ needs_reason: string | null; revoked_seat: string | null }[]>`
          select needs_reason, revoked_seat from fixture_external_play where fixture_id = ${fixtureId}`;
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && row) return { accepted: true, row };
      const e = err as { code?: string; constraint_name?: string };
      return { accepted: false, code: e.code, constraint: e.constraint_name };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }
  const seatRefused = { accepted: false, code: CHECK_VIOLATION, constraint: SEAT_CHECK };

  // The rulings: M7 (token_revoked) and the final re-review's P11 (1) (account_changed).
  const SEAT_HOLDS: readonly string[] = ["token_revoked", "account_changed"];

  it("V454 (M7, P11 (1)): a seat hold — token_revoked or account_changed — records white, black, both, or no seat (unknown: both frozen)", async () => {
    let checked = 0;
    for (const reason of SEAT_HOLDS) {
      for (const seat of ["white", "black", "both", null]) {
        expect(await trySeat({ status: "needs_organiser", needs_reason: reason, revoked_seat: seat }), `${reason} ${String(seat)}`)
          .toEqual({ accepted: true, row: { needs_reason: reason, revoked_seat: seat } });
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two reasons × three seats and none").toBe(8);
  });

  it("V454 (M7): a seat on ANY other reason is refused — counted over NEEDS_REASONS", async () => {
    const others = NEEDS_REASONS.filter((r) => !SEAT_HOLDS.includes(r));
    let checked = 0;
    for (const reason of others) {
      expect(await trySeat({ status: "needs_organiser", needs_reason: reason, revoked_seat: "white" }), reason).toEqual(seatRefused);
      checked++;
    }
    expect(checked, "anti-vacuity: every other reason").toBe(NEEDS_REASONS.length - SEAT_HOLDS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("V454 (M7): a seat on a row that is not held — no reason at all — is refused (a NULL reason must not pass)", async () => {
    let checked = 0;
    for (const status of ["pending", "ready", "live", "finished"]) {
      expect(await trySeat({ status, needs_reason: null, revoked_seat: "black" }), status).toEqual(seatRefused);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("V454 (M7): a seat outside white/black/both is refused", async () => {
    expect(await trySeat({ status: "needs_organiser", needs_reason: "token_revoked", revoked_seat: "home" })).toEqual(seatRefused);
  });

  // ---------------------------------------------------------------------------
  // V454, T13 (carry M4): the sweep's count of consecutive no-truth reads.
  const NO_TRUTH_CHECK = "fixture_external_play_sweep_no_truth_reads_check";
  async function tryNoTruth(reads: number | undefined): Promise<
    { accepted: true; reads: number } | { accepted: false; code: string | undefined; constraint: string | undefined }
  > {
    const rollback = new Error("rollback");
    let got: number | undefined;
    try {
      await sql.begin(async (tx) => {
        const values: Record<string, unknown> = { fixture_id: fixtureId, org_id: orgId, status: "live", scheduled_at_basis: new Date() };
        if (reads !== undefined) values.sweep_no_truth_reads = reads;
        await tx`insert into fixture_external_play ${tx(values as never)}`;
        [{ sweep_no_truth_reads: got }] = await tx<{ sweep_no_truth_reads: number }[]>`
          select sweep_no_truth_reads from fixture_external_play where fixture_id = ${fixtureId}`;
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && got !== undefined) return { accepted: true, reads: got };
      const e = err as { code?: string; constraint_name?: string };
      return { accepted: false, code: e.code, constraint: e.constraint_name };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }

  it("V454 (T13 M4): a new row has read nothing yet — zero, never null — and zero and up are counts", async () => {
    expect(await tryNoTruth(undefined), "the default").toEqual({ accepted: true, reads: 0 });
    let checked = 0;
    for (const n of [0, 1, 3, 40]) {
      expect(await tryNoTruth(n), String(n)).toEqual({ accepted: true, reads: n });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("V454 (T13 M4): a NEGATIVE count is refused by its own CHECK; NULL by NOT NULL", async () => {
    expect(await tryNoTruth(-1)).toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: NO_TRUTH_CHECK });
    expect(await tryNoTruth(null as never)).toMatchObject({ accepted: false, code: "23502" });
  });

  // ---------------------------------------------------------------------------
  // V454, T13 fix round 1. I1: when a read first found the GAME over, held or
  // not (the camera evidence ends there, never at the room's end). I4: the
  // move T10 is submitting, recorded BEFORE Lichess hears it, so a read
  // landing between Lichess's 200 and the append adopts it without a flag.
  const GAME_OVER_CHECK = "fixture_external_play_game_over_check";
  const PENDING_MOVE_CHECK = "fixture_external_play_pending_move_check";
  type BridgeOutcome =
    | { accepted: true; row: Record<string, unknown> }
    | { accepted: false; code: string | undefined; constraint: string | undefined };
  /** A bridge row with `cols` (a game on file unless `challenge_id: null`),
   *  the named columns read back, rolled back. */
  async function tryBridge(cols: Record<string, unknown>, read: readonly string[]): Promise<BridgeOutcome> {
    const rollback = new Error("rollback");
    let row: Record<string, unknown> | undefined;
    try {
      await sql.begin(async (tx) => {
        const values = {
          fixture_id: fixtureId, org_id: orgId, status: "live", scheduled_at_basis: new Date(),
          challenge_id: `ch-${randomUUID().slice(0, 12)}`, ...cols,
        };
        await tx`insert into fixture_external_play ${tx(values as never)}`;
        [row] = await tx<Record<string, unknown>[]>`
          select ${tx(read as string[])} from fixture_external_play where fixture_id = ${fixtureId}`;
        throw rollback;
      });
    } catch (err) {
      if (err === rollback && row) return { accepted: true, row };
      const e = err as { code?: string; constraint_name?: string };
      return { accepted: false, code: e.code, constraint: e.constraint_name };
    }
    throw new Error("transaction committed — the rollback sentinel never fired");
  }
  const AT = new Date("2026-10-11T10:00:00.000Z");

  it("V454 (T13 I1): a new row has seen no game end; a game on file records one", async () => {
    expect(await tryBridge({}, ["game_over_at"])).toEqual({ accepted: true, row: { game_over_at: null } });
    expect(await tryBridge({ game_over_at: AT }, ["game_over_at"])).toEqual({ accepted: true, row: { game_over_at: AT } });
  });

  it("V454 (T13 I1): a game end with NO game on file is refused by its own CHECK", async () => {
    expect(await tryBridge({ status: "pending", challenge_id: null, game_over_at: AT }, ["game_over_at"]))
      .toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: GAME_OVER_CHECK });
  });

  const PENDING = ["pending_move_ply", "pending_move_uci", "pending_move_at"] as const;
  /** A ledger of `n` plies (the CHECK reads its length, not its moves). */
  const ledgerOf = (n: number) => ({ moves_uci: sql.json(Array.from({ length: n }, () => "e2e4")), move_count: n });
  it("V454 (T13 I4): no submission by default; a whole one — ply, canonical UCI, time — is accepted (counted)", async () => {
    expect(await tryBridge({}, PENDING)).toEqual({
      accepted: true, row: { pending_move_ply: null, pending_move_uci: null, pending_move_at: null },
    });
    let checked = 0;
    for (const [ply, uci] of [[0, "e2e4"], [1, "e7e5"], [57, "e7e8q"], [80, "a2a1n"]] as const) {
      expect(await tryBridge({ ...ledgerOf(ply), pending_move_ply: ply, pending_move_uci: uci, pending_move_at: AT }, PENDING), uci).toEqual({
        accepted: true, row: { pending_move_ply: ply, pending_move_uci: uci, pending_move_at: AT },
      });
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("V454 (T13 I4): a submission is for the NEXT ply only — one at a ply the ledger has passed, or not reached, is refused (counted)", async () => {
    // T10 sends at ply = the ledger's length; every ledger write spends the
    // submission it passes. So reconcile's write needs no ply condition, and
    // an excuse can only ever be read at the ply it was sent for.
    const refused = { accepted: false, code: CHECK_VIOLATION, constraint: PENDING_MOVE_CHECK };
    let checked = 0;
    for (const [ledger, ply] of [[1, 0], [4, 3], [4, 5], [0, 1]] as const) {
      expect(await tryBridge({ ...ledgerOf(ledger), pending_move_ply: ply, pending_move_uci: "g1f3", pending_move_at: AT }, PENDING),
        `ledger ${ledger}, ply ${ply}`).toEqual(refused);
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("V454 (T13 I4): HALF a submission is refused — each of the three missing in turn (counted)", async () => {
    const whole = { ...ledgerOf(4), pending_move_ply: 4, pending_move_uci: "g1f3", pending_move_at: AT };
    let checked = 0;
    for (const missing of PENDING) {
      expect(await tryBridge({ ...whole, [missing]: null }, PENDING), missing)
        .toEqual({ accepted: false, code: CHECK_VIOLATION, constraint: PENDING_MOVE_CHECK });
      checked++;
    }
    expect(checked).toBe(PENDING.length);
  });

  it("V454 (T13 I4): a negative ply, a move that is not UCI, or a submission with no game on file is refused (counted)", async () => {
    const refused = { accepted: false, code: CHECK_VIOLATION, constraint: PENDING_MOVE_CHECK };
    let checked = 0;
    for (const cols of [
      { pending_move_ply: -1, pending_move_uci: "e2e4" },
      { pending_move_ply: 0, pending_move_uci: "e2e9" },
      { pending_move_ply: 0, pending_move_uci: "E2E4" },
      { pending_move_ply: 0, pending_move_uci: "e2e4k" },
      { pending_move_ply: 0, pending_move_uci: "e2e4 " },
      { pending_move_ply: 0, pending_move_uci: "" },
      { pending_move_ply: 0, pending_move_uci: "e2e4", status: "pending", challenge_id: null },
    ]) {
      expect(await tryBridge({ pending_move_at: AT, ...cols }, PENDING), JSON.stringify(cols)).toEqual(refused);
      checked++;
    }
    expect(checked).toBe(7);
  });
});
