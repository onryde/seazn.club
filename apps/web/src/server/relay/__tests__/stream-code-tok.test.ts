// Capture QR v2 §6.1 (T5, A5): every assertion that has to NAME the stream code's sealed tok column lives here, inside
// the boundary — enc-boundary claim 2 forbids `tok_enc` in every file outside server/relay/**, the usecase tests
// included, and claim 3 exempts this directory. What it proves, each case beside its accepted twin:
//  1. at rest the tok is SEALED: `tok_enc` opens under RELAY_KEK to exactly the QR's tok, and no byte range of the
//     envelope holds the tok's plaintext;
//  2. the device-links M2 rule (§6.1 "re-checking that sha256(open(tok_enc)) = tok_hash"): an envelope that opens to
//     ANOTHER tok, or does not open at all, is never re-shown — the ensure reissues, ending the old row, and logs;
//  3. `tok_enc` is NULL on every ENDED code — reissued and expired alike (V430's `ended_at is null or tok_enc is null`);
//  4. the three secret-columns functions directly: open of an ended or unknown code is null; a wipe of an already-ended
//     code changes nothing; a KEK fault on open is the KEK's own error (M3), never the envelope's.
// ONE SPORT (TEST-STRATEGY rule 6): the sealed tok never reads the sport.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { log } from "@/server/logger";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { ensureStreamCode, reissueStreamCode, resolveStreamCode } from "@/server/usecases/stream-codes";
import { openWith, sealWith } from "../crypto";
import { insertStreamCode, openStreamCodeTok, wipeStreamCodeTok } from "../secret-columns";

const HAS_DB = !!process.env.DATABASE_URL;

const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const tok22 = () => randomBytes(16).toString("base64url");

async function rig() {
  const { auth } = await seedOrg("pro");
  const d = await startedDivisionWithFixture(auth);
  await sql`insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason) values (${auth.orgId}, 'streaming.relay', true, 'tok')
            on conflict (org_id, feature_key) do update set bool_value = true`;
  await invalidateOrgEntitlements(auth.orgId);
  return { auth, fixtureId: d.fixtureId };
}

interface SealedRow { id: string; code: string; tok_hash: string; tok_enc: Uint8Array | null; ended_at: Date | null; end_cause: string | null }
const rows = (fixtureId: string) => sql<SealedRow[]>`
  select id, code, tok_hash, tok_enc, ended_at, end_cause from fixture_stream_codes where fixture_id = ${fixtureId} order by created_at, id`;

describe.skipIf(!HAS_DB)("the stream code's sealed tok (§6.1)", () => {
  it("at rest: the minted row's tok_enc opens to exactly the QR's tok, and the envelope holds no plaintext copy of it", async () => {
    const r = await rig();
    const { qr } = await ensureStreamCode(r.auth, r.fixtureId);
    const [row] = await rows(r.fixtureId);
    expect(row!.tok_enc).not.toBeNull();
    expect(openWith("RELAY_KEK", row!.tok_enc!)).toBe(qr.tok);
    expect(Buffer.from(row!.tok_enc!).includes(Buffer.from(qr.tok, "utf8"))).toBe(false);
    expect(Buffer.from(row!.tok_enc!).includes(Buffer.from(qr.tok, "base64url"))).toBe(false);
  });

  it("M2: an envelope forced to ANOTHER tok (opens, hashes elsewhere) and one that will NOT open are never re-shown — each ensure ends the row as reissued, mints a fresh code, and logs the mismatch", async () => {
    const warn = vi.spyOn(log, "warn");
    let checked = 0;
    try {
      for (const forced of ["another tok", "garbage"] as const) {
        const r = await rig();
        const first = await ensureStreamCode(r.auth, r.fixtureId);
        const [before] = await rows(r.fixtureId);
        const envelope = forced === "another tok" ? sealWith("RELAY_KEK", tok22()) : Buffer.from("not-a-real-envelope");
        await sql`update fixture_stream_codes set tok_enc = ${envelope} where id = ${before!.id}`;
        warn.mockClear();
        const again = await ensureStreamCode(r.auth, r.fixtureId);
        expect(again.qr.code, forced).not.toBe(first.qr.code);
        expect(again.qr.tok, forced).not.toBe(first.qr.tok);
        const after = await rows(r.fixtureId);
        expect(after.map((c) => [c.code, c.end_cause, c.tok_enc === null]), forced).toEqual([
          [first.qr.code, "reissued", true],
          [again.qr.code, null, false],
        ]);
        expect(after[1]!.tok_hash).toBe(sha256Hex(again.qr.tok));
        expect(warn.mock.calls.some(([obj]) => (obj as { codeId?: string })?.codeId === before!.id), forced).toBe(true);
        // The old QR is dead on the wire; the new one answers.
        expect(await resolveStreamCode(first.qr.code, first.qr.tok, "get", null, new Date()).catch((e) => e)).toMatchObject({ status: 401 });
        expect(await resolveStreamCode(again.qr.code, again.qr.tok, "get", null, new Date())).toMatchObject({ status: "active" });
        checked++;
      }
    } finally {
      warn.mockRestore();
    }
    expect(checked).toBe(2);
  });

  it("the accepted twin: an untouched envelope is re-shown and nothing is logged", async () => {
    const r = await rig();
    const first = await ensureStreamCode(r.auth, r.fixtureId);
    const warn = vi.spyOn(log, "warn");
    try {
      expect((await ensureStreamCode(r.auth, r.fixtureId)).qr).toEqual(first.qr);
      expect(warn.mock.calls.filter(([, msg]) => typeof msg === "string" && msg.startsWith("stream code"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("tok_enc is NULL on every ENDED code — reissued (twice over) and expired — and set on the one active code", async () => {
    const r = await rig();
    await ensureStreamCode(r.auth, r.fixtureId);
    await reissueStreamCode(r.auth, r.fixtureId);
    const last = await reissueStreamCode(r.auth, r.fixtureId);
    let all = await rows(r.fixtureId);
    expect(all.map((c) => [c.end_cause, c.tok_enc === null])).toEqual([["reissued", true], ["reissued", true], [null, false]]);
    // Expired: finished long ago with no open session; the first resolve that finds it due writes the end.
    await sql`update fixtures set status = 'cancelled' where id = ${r.fixtureId}`;
    await sql`update fixtures set finished_at = now() - interval '1 day' where id = ${r.fixtureId}`;
    await resolveStreamCode(last.qr.code, last.qr.tok, "get", null, new Date()).catch(() => null);
    all = await rows(r.fixtureId);
    expect(all.map((c) => [c.end_cause, c.tok_enc === null])).toEqual([["reissued", true], ["reissued", true], ["expired", true]]);
  });
});

describe.skipIf(!HAS_DB)("secret-columns — the stream code functions", () => {
  it("insert → open round-trips; open of an ENDED code and of an unknown id is null; a second wipe changes nothing", async () => {
    const r = await rig();
    const tok = tok22();
    const code = Array.from({ length: 12 }, () => "0123456789abcdefghjkmnpqrstvwxyz"[Math.floor(Math.random() * 32)]).join("");
    const { id } = await sql.begin((tx) => insertStreamCode(tx, {
      orgId: r.auth.orgId, fixtureId: r.fixtureId, code, tokHash: sha256Hex(tok), tokEnc: sealWith("RELAY_KEK", tok), issuedBy: r.auth.userId!,
    }));
    expect(await sql.begin((tx) => openStreamCodeTok(tx, id))).toBe(tok);
    await sql.begin((tx) => wipeStreamCodeTok(tx, id, "reissued", r.auth.userId));
    let [row] = await rows(r.fixtureId);
    expect(row).toMatchObject({ end_cause: "reissued", tok_enc: null });
    const endedAt = row!.ended_at;
    expect(await sql.begin((tx) => openStreamCodeTok(tx, id))).toBeNull();
    await sql.begin((tx) => wipeStreamCodeTok(tx, id, "expired", null));
    [row] = await rows(r.fixtureId);
    expect(row).toMatchObject({ end_cause: "reissued", ended_at: endedAt });
    expect(await sql.begin((tx) => openStreamCodeTok(tx, "00000000-0000-4000-8000-000000000000"))).toBeNull();
  });

  it("M3: under a missing KEK the open throws the KEK's own error, never the envelope's; under a valid KEK a damaged envelope reads as null", async () => {
    const r = await rig();
    await ensureStreamCode(r.auth, r.fixtureId);
    const [row] = await rows(r.fixtureId);
    const saved = process.env.RELAY_KEK;
    try {
      delete process.env.RELAY_KEK;
      await expect(sql.begin((tx) => openStreamCodeTok(tx, row!.id))).rejects.toThrow(/RELAY_KEK is not set/);
    } finally {
      process.env.RELAY_KEK = saved;
    }
    await sql`update fixture_stream_codes set tok_enc = ${Buffer.from("damaged")} where id = ${row!.id}`;
    const warn = vi.spyOn(log, "warn").mockImplementation((() => undefined) as never);
    try {
      expect(await sql.begin((tx) => openStreamCodeTok(tx, row!.id))).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
