// apps/web/src/server/usecases/__tests__/external-play-schema.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { seedFutureDivision, seedOrg } from "./_seed";

/** Postgres names a column CHECK `<table>_<column>_check` and a table CHECK
 *  `<table>_check`. Asserting the name is what stops an FK error, or the
 *  other CHECK, from satisfying a rejection test. */
const VOCABULARY_CHECK = "fixture_external_play_needs_reason_check";
const COUPLING_CHECK = "fixture_external_play_check";
const CONSENT_TOKEN_CHECK = "user_external_accounts_consent_token_check";
const CONSENT_SCOPES_CHECK = "user_external_accounts_consent_scopes_check";
const CHECK_VIOLATION = "23514";

type Outcome =
  | { accepted: true; row: { status: string; needs_reason: string | null } }
  | { accepted: false; code: string | undefined; constraint: string | undefined };

describe.skipIf(!process.env.DATABASE_URL)("external play schema (V405/V407)", () => {
  let orgId = "";
  let fixtureId = "";

  beforeAll(async () => {
    const { auth } = await seedOrg();
    const { fixtures } = await seedFutureDivision(auth);
    const [first] = fixtures;
    if (!first) throw new Error("seedFutureDivision produced no fixtures");
    orgId = auth.orgId;
    fixtureId = first.id;
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

  it("fixture_external_play has exactly the spec §7.2 columns", async () => {
    expect(await columns("fixture_external_play")).toEqual([
      "black_emailed_at", "black_lichess_id", "challenge_id", "created_at", "expires_at",
      "finished_at", "fixture_id", "last_error", "last_polled_at", "mint_claimed_at",
      "needs_reason", "org_id", "provider", "scheduled_at_basis", "started_at", "status",
      "updated_at", "url_black", "url_white", "white_emailed_at", "white_lichess_id", "white_side",
    ]);
  });

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
