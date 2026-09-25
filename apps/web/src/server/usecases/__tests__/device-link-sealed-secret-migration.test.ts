// V417 (scorer sheets §4.1): device_links gains `secret_enc` and loses NOT NULL on
// `expires_at`. Both changes are only real if a row uses them (AGENTS.md class 3),
// so one row carries BOTH — a sealed secret and no expiry — and a legacy
// hash-only row with an end-of-day expiry is its twin in the same `it`. On the
// pre-V417 schema the first insert refuses (42703 on the missing column, 23502 on
// the NULL expiry), so this cannot pass on the old shape.
//
// The stored value is a real sealWith envelope and it is read back through
// openWith: the column is proven to carry the envelope byte-for-byte through
// postgres.js (Buffer in, bytea out), not merely to accept some bytes.
//
// Real Postgres required; skipped without DATABASE_URL like every suite here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { openWith, sealWith } from "@/server/relay/crypto";
import { seedOrg, startedDivisionWithFixture } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

// The developer's key (from .env.local) is put back afterwards, or removed when there was none. Never printed.
const savedDl = process.env.DEVICE_LINK_KEK;
beforeAll(() => { process.env.DEVICE_LINK_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedDl === undefined) delete process.env.DEVICE_LINK_KEK;
  else process.env.DEVICE_LINK_KEK = savedDl;
});

describe.skipIf(!HAS_DB)("V417 — device_links carries a sealed secret and may have no expiry", () => {
  it("a sealed, expiry-less link stores and reopens its secret; a legacy hash-only link still inserts beside it", async () => {
    const { auth } = await seedOrg();
    const { fixtureId } = await startedDivisionWithFixture(auth);
    const [{ id: issuer }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`v417-${randomUUID().slice(0, 8)}@test.local`}, 'V417 issuer', true)
      returning id`;

    const secret = "dl_" + randomBytes(32).toString("base64url");
    const [sealed] = await sql<{ secret_enc: Uint8Array | null; expires_at: Date | null }[]>`
      insert into device_links (org_id, fixture_id, token_hash, label, issued_by, expires_at, secret_enc)
      values (${auth.orgId}, ${fixtureId}, ${"hash-" + randomUUID()}, 'Court 1 sheet', ${issuer}, null,
              ${sealWith("DEVICE_LINK_KEK", secret)})
      returning secret_enc, expires_at`;
    expect(sealed!.expires_at).toBeNull();
    expect(sealed!.secret_enc).not.toBeNull();
    expect(openWith("DEVICE_LINK_KEK", sealed!.secret_enc!)).toBe(secret);

    // The twin: the pre-V417 shape (hash only, end-of-day expiry) is still a valid row.
    const [legacy] = await sql<{ secret_enc: Uint8Array | null; expires_at: Date | null }[]>`
      insert into device_links (org_id, fixture_id, token_hash, label, issued_by, expires_at)
      values (${auth.orgId}, ${fixtureId}, ${"hash-" + randomUUID()}, 'Court 1 phone', ${issuer},
              now() + interval '1 day')
      returning secret_enc, expires_at`;
    expect(legacy!.secret_enc).toBeNull();
    expect(legacy!.expires_at).toBeInstanceOf(Date);
  });
});
