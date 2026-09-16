// secret-columns.ts is the only SQL over a *_enc column. enc-boundary.test.ts proves WHERE that SQL lives; this
// proves WHAT it does, against real Postgres, each refusal beside its accepted twin:
//  1. store → read round-trips both ingest legs and a destination, on Cloudflare's OBSERVED create shape (design
//     2026-09-07 "Observed: … srt.url is srt://live.cloudflare.com:778 with streamId = the input uid and a 65-char
//     passphrase"): a BARE url, streamId and passphrase as separate fields. The streamId therefore exists nowhere
//     but the envelope — it comes back from there, never from the url (which would read "").
//  2. the RAW row holds no plaintext: no *_enc byte range contains the passphrase, the streamId or a stream key,
//     and a url column never keeps a query or fragment.
//  3. a missing slot is null; an unknown target throws.
//  4. a flipped envelope byte, or an envelope in any other shape, throws — and echoes none of its plaintext.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { seal } from "../crypto";
import { readInputBySlot, readTargetSecret, storeInputCredentials, storeTargetSecret } from "../secret-columns";

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own. The developer's (from .env.local) is put back afterwards, or removed when there was none
// — never assigned `undefined`, which Node stores as the string "undefined". It is never printed.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(() => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
});

/** 65 chars: the observed length of both the SRT passphrase and the RTMPS stream key. */
const secret65 = (): string => randomBytes(33).toString("hex").slice(0, 65);

async function rig() {
  const { auth } = await seedOrg();
  const { fixtureId } = await startedDivisionWithFixture(auth);
  const [t] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc)
    values (${auth.orgId}, 'youtube', 'x', ${Buffer.from("placeholder")}) returning id`;
  // seedOrg's AuthCtx carries `userId: null` (_rig.ts) and created_by is NOT NULL with no FK — a fresh uuid is a creator.
  const [s] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override)
    select f.id, ${auth.orgId}, 'passthrough', 'requested', ${t!.id}, ${randomUUID()}, d.sport_key, d.competition_id, f.division_id, true
      from fixtures f join divisions d on d.id = f.division_id
     where f.id = ${fixtureId}
    returning id`;
  const [input] = await sql<{ id: string }[]>`insert into fixture_stream_inputs (session_id, slot) values (${s!.id}, 0) returning id`;
  return { sessionId: s!.id, inputId: input!.id, targetId: t!.id };
}

/** Cloudflare's observed `liveInputs.create()` ingest legs: bare urls, credentials as separate fields, streamId = uid. */
function observed() {
  const uid = randomBytes(16).toString("hex");
  return {
    uid,
    creds: {
      srt: { url: "srt://live.cloudflare.com:778", streamId: uid, passphrase: secret65() },
      rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: secret65() },
    },
  };
}

const destination = () => ({ url: "rtmps://a.rtmp.youtube.com/live2", streamKey: secret65() });

const holds = (bytes: Uint8Array, plain: string): boolean => Buffer.from(bytes).includes(Buffer.from(plain, "utf8"));

/** The rejection message of a read that must throw (so the test can say what the message does NOT carry). */
async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the read to throw, and it returned");
}

describe.skipIf(!HAS_DB)("secret-columns — the *_enc columns, sealed and opened", () => {
  it("an input's SRT and RTMPS legs round-trip on the observed shape; streamId comes from the envelope, not the bare url", async () => {
    const r = await rig();
    const { uid, creds } = observed();
    await sql.begin((tx) => storeInputCredentials(tx, r.inputId, uid, creds));
    const back = await sql.begin((tx) => readInputBySlot(tx, r.sessionId, 0));
    expect(back).toEqual({ id: r.inputId, slot: 0, ingestInputId: uid, srt: creds.srt, rtmps: creds.rtmps });
    // The QR contract requires a non-empty streamId; the bare url has none to give.
    expect(back!.srt!.streamId).toBe(uid);
  });

  it("a destination's RTMP url and stream key round-trip", async () => {
    const r = await rig();
    const target = destination();
    await sql.begin((tx) => storeTargetSecret(tx, r.targetId, target));
    expect(await sql.begin((tx) => readTargetSecret(tx, r.targetId))).toEqual(target);
  });

  it("the RAW row: no *_enc bytes hold the passphrase, streamId or a stream key; the url columns hold the bare urls", async () => {
    const r = await rig();
    const { uid, creds } = observed();
    const target = destination();
    await sql.begin(async (tx) => {
      await storeInputCredentials(tx, r.inputId, uid, creds);
      await storeTargetSecret(tx, r.targetId, target);
    });
    const [row] = await sql<{ srt_enc: Uint8Array; rtmps_enc: Uint8Array; srt_url: string; rtmps_url: string }[]>`
      select ingest_srt_key_enc as srt_enc, ingest_rtmps_key_enc as rtmps_enc,
             ingest_srt_url as srt_url, ingest_rtmps_url as rtmps_url
        from fixture_stream_inputs where id = ${r.inputId}`;
    const [trow] = await sql<{ rtmp_enc: Uint8Array }[]>`select rtmp_enc from org_stream_targets where id = ${r.targetId}`;
    const plaintexts = {
      passphrase: creds.srt.passphrase, streamId: creds.srt.streamId,
      rtmpsStreamKey: creds.rtmps.streamKey, destinationStreamKey: target.streamKey,
    };
    const columns = [["ingest_srt_key_enc", row!.srt_enc], ["ingest_rtmps_key_enc", row!.rtmps_enc], ["rtmp_enc", trow!.rtmp_enc]] as const;
    for (const [column, bytes] of columns) {
      // The positive pair: the column holds a written envelope (header 89 bytes + body) — null or empty passes any scan.
      expect(Buffer.from(bytes).length, column).toBeGreaterThan(89);
      for (const [name, plain] of Object.entries(plaintexts)) expect(holds(bytes, plain), `${column} holds the ${name}`).toBe(false);
    }
    expect({ srt: row!.srt_url, rtmps: row!.rtmps_url }).toEqual({ srt: creds.srt.url, rtmps: creds.rtmps.url });
    // bytea renders as \x-hex under ::text, so this row scan guards the TEXT columns; the byte scan above guards the envelopes.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixture_stream_inputs t
       where t.id = ${r.inputId}
         and (t::text like ${"%" + creds.srt.passphrase + "%"} or t::text like ${"%" + creds.rtmps.streamKey + "%"})`;
    expect(n).toBe(0);
  });

  it("a url that arrives with a query or a fragment is stored without it (SRT: both; RTMPS: fragment only)", async () => {
    const r = await rig();
    const { uid, creds } = observed();
    const marker = "probe" + randomBytes(12).toString("hex");
    const arriving = {
      srt: { ...creds.srt, url: `${creds.srt.url}?probe=${marker}#${marker}` },
      rtmps: { ...creds.rtmps, url: `${creds.rtmps.url}#${marker}` },
    };
    await sql.begin((tx) => storeInputCredentials(tx, r.inputId, uid, arriving));
    const [row] = await sql<{ ingest_srt_url: string; ingest_rtmps_url: string }[]>`
      select ingest_srt_url, ingest_rtmps_url from fixture_stream_inputs where id = ${r.inputId}`;
    expect(row).toEqual({ ingest_srt_url: creds.srt.url, ingest_rtmps_url: creds.rtmps.url });
    for (const url of [row!.ingest_srt_url, row!.ingest_rtmps_url]) {
      expect(url).not.toContain("?");
      expect(url).not.toContain("#");
    }
    // And the credentials still round-trip beside the stripped urls.
    const back = await sql.begin((tx) => readInputBySlot(tx, r.sessionId, 0));
    expect(back!.srt).toEqual(creds.srt);
    expect(back!.rtmps).toEqual(creds.rtmps);
  });

  it("a missing slot reads null beside the present one; an unknown target throws beside the known one", async () => {
    const r = await rig();
    expect(await sql.begin((tx) => readInputBySlot(tx, r.sessionId, 1))).toBeNull();
    // The accepted twin: slot 0 exists and, before any credentials are stored, reads its row with both legs null.
    expect(await sql.begin((tx) => readInputBySlot(tx, r.sessionId, 0)))
      .toEqual({ id: r.inputId, slot: 0, ingestInputId: null, srt: null, rtmps: null });
    await expect(sql.begin((tx) => readTargetSecret(tx, randomUUID()))).rejects.toThrow(/not found/);
    const target = destination();
    await sql.begin((tx) => storeTargetSecret(tx, r.targetId, target));
    expect(await sql.begin((tx) => readTargetSecret(tx, r.targetId))).toEqual(target);
  });

  it("one flipped byte in a stored envelope makes the read throw, echoing none of the plaintext; the untouched read opens", async () => {
    const r = await rig();
    const { uid, creds } = observed();
    const target = destination();
    await sql.begin(async (tx) => {
      await storeInputCredentials(tx, r.inputId, uid, creds);
      await storeTargetSecret(tx, r.targetId, target);
    });
    const read = () => sql.begin((tx) => readInputBySlot(tx, r.sessionId, 0));
    expect(await read()).toEqual({ id: r.inputId, slot: 0, ingestInputId: uid, srt: creds.srt, rtmps: creds.rtmps });
    expect(await sql.begin((tx) => readTargetSecret(tx, r.targetId))).toEqual(target);

    // The flip lands at length - 3: inside the ciphertext body of a real envelope, and inside a STRING VALUE of any
    // envelope that is really plaintext. Flipping the LAST byte instead was passed by an identity seal/open mutant —
    // it broke the JSON's closing brace, so JSON.parse threw and GCM was never asked. XOR-ing the same byte twice
    // restores it, which gives each flip its accepted twin on the same row.
    const flipSrt = () => sql`
      update fixture_stream_inputs
         set ingest_srt_key_enc = set_byte(ingest_srt_key_enc, length(ingest_srt_key_enc) - 3,
                                           get_byte(ingest_srt_key_enc, length(ingest_srt_key_enc) - 3) # 1)
       where id = ${r.inputId}`;
    await flipSrt();
    const srtMessage = await messageOf(read());
    expect(srtMessage).not.toContain(creds.srt.passphrase.slice(0, 8));
    await flipSrt();
    expect((await read())!.srt).toEqual(creds.srt);

    // The RTMPS envelope holds a bare stream key — no JSON at all, so only authentication can refuse it.
    await sql`
      update fixture_stream_inputs
         set ingest_rtmps_key_enc = set_byte(ingest_rtmps_key_enc, length(ingest_rtmps_key_enc) - 3,
                                             get_byte(ingest_rtmps_key_enc, length(ingest_rtmps_key_enc) - 3) # 1)
       where id = ${r.inputId}`;
    const rtmpsMessage = await messageOf(read());
    expect(rtmpsMessage).not.toContain(creds.rtmps.streamKey.slice(0, 8));

    await sql`
      update org_stream_targets
         set rtmp_enc = set_byte(rtmp_enc, length(rtmp_enc) - 3, get_byte(rtmp_enc, length(rtmp_enc) - 3) # 1)
       where id = ${r.targetId}`;
    const targetMessage = await messageOf(sql.begin((tx) => readTargetSecret(tx, r.targetId)));
    expect(targetMessage).not.toContain(target.streamKey.slice(0, 8));
  });

  it("an SRT envelope in any other shape (the pre-fix bare passphrase; JSON without streamId) throws without echoing it; the well-formed twin opens", async () => {
    const r = await rig();
    const { uid, creds } = observed();
    await sql.begin((tx) => storeInputCredentials(tx, r.inputId, uid, creds));
    expect((await sql.begin((tx) => readInputBySlot(tx, r.sessionId, 0)))!.srt).toEqual(creds.srt);

    // The pre-fix format sealed the passphrase alone. V8's JSON.parse error quotes the start of its input — but only
    // when that input starts with a letter ("Unexpected token 'l', \"legacy3f9a\"…"); a digit-led one reads
    // "Unexpected non-whitespace character … at position 1" and quotes nothing (Node 26, checked). A random hex
    // passphrase would witness the guard in 6 runs of 16, so this one is letter-led on purpose.
    const legacy = "legacy" + secret65().slice(6);
    await sql`update fixture_stream_inputs set ingest_srt_key_enc = ${seal(legacy)} where id = ${r.inputId}`;
    const bare = await messageOf(sql.begin((tx) => readInputBySlot(tx, r.sessionId, 0)));
    expect(bare).not.toContain(legacy.slice(0, 8));

    await sql`update fixture_stream_inputs set ingest_srt_key_enc = ${seal(JSON.stringify({ passphrase: creds.srt.passphrase }))} where id = ${r.inputId}`;
    const partial = await messageOf(sql.begin((tx) => readInputBySlot(tx, r.sessionId, 0)));
    expect(partial).toMatch(/streamId/);
    expect(partial).not.toContain(creds.srt.passphrase.slice(0, 8));
  });
});
