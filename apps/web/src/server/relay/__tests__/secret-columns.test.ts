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
//  5. (Task 9) a destination is written ONCE, sealed, by `insertStreamTarget` — the row carries exactly the org, kind,
//     label and watch link it was given (`rtmp_enc` is NOT NULL, so there is no unsealed row to update later);
//     `readFirstInput` reads the LOWEST slot of THIS session, or null — never a literal slot 0.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Tx } from "@/lib/db";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { fingerprintDestination, seal } from "../crypto";
import { StreamTargetVanishedError, insertStreamTarget, readFirstInput, readInputBySlot, readTargetSecret, storeInputCredentials } from "../secret-columns";

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
  // The destination is sealed at insert — the one writer (`rtmp_enc` is NOT NULL, so no placeholder row exists).
  const target = destination();
  const targetId = await sql.begin((tx) =>
    insertStreamTarget(tx, { orgId: auth.orgId, kind: "youtube", label: "x", watchUrl: null, rtmp: target }),
  ).then((t) => t.id);
  // seedOrg's AuthCtx carries `userId: null` (_rig.ts) and created_by is NOT NULL with no FK — a fresh uuid is a creator.
  const [s] = await sql<{ id: string }[]>`
    insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override)
    select f.id, ${auth.orgId}, 'passthrough', 'requested', ${targetId}, ${randomUUID()}, d.sport_key, d.competition_id, f.division_id, true
      from fixtures f join divisions d on d.id = f.division_id
     where f.id = ${fixtureId}
    returning id`;
  const [input] = await sql<{ id: string }[]>`insert into fixture_stream_inputs (session_id, slot) values (${s!.id}, 0) returning id`;
  return { orgId: auth.orgId, sessionId: s!.id, inputId: input!.id, targetId, target };
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

  it("a destination's RTMP url and stream key round-trip; insertStreamTarget writes exactly the org, kind, label and watch link it was given", async () => {
    const r = await rig();
    expect(await sql.begin((tx) => readTargetSecret(tx, r.orgId, r.targetId))).toEqual(r.target);
    // Pin the VALUES on a row whose every field differs from the rig's (kind, label, a non-null watch link).
    const target = destination();
    const id = await sql.begin((tx) =>
      insertStreamTarget(tx, { orgId: r.orgId, kind: "custom_rtmp", label: "Club RTMP", watchUrl: "https://kick.com/club", rtmp: target }),
    ).then((t) => t.id);
    expect(id).not.toBe(r.targetId);
    const rows = await sql<{ org_id: string; kind: string; label: string; watch_url: string | null }[]>`
      select org_id, kind, label, watch_url from org_stream_targets where id = ${id}`;
    expect(rows).toEqual([{ org_id: r.orgId, kind: "custom_rtmp", label: "Club RTMP", watch_url: "https://kick.com/club" }]);
    expect(await sql.begin((tx) => readTargetSecret(tx, r.orgId, id))).toEqual(target);
    // …and the rig's own row, written with watchUrl null, stored null — not "" and not the string "null".
    const [rigRow] = await sql<{ watch_url: string | null }[]>`select watch_url from org_stream_targets where id = ${r.targetId}`;
    expect(rigRow!.watch_url).toBeNull();
  });

  // A19 + A19b (owner 2026-09-28): the writer is also the fingerprint's ONLY writer, and a repeat of one destination in
  // one org is the FIRST row, not a second one and not a throw. The state transitions: first write (row + fingerprint),
  // second write of the same destination spelled with its default port (no row, first id back, first row untouched),
  // and a write of a different key (a new row).
  it("A19: insertStreamTarget stores the destination's fingerprint; the same destination again — even spelled with its default port — returns the FIRST id and changes nothing; another key is another row", async () => {
    const r = await rig();
    const [first] = await sql<{ dest_fingerprint: string | null }[]>`
      select dest_fingerprint from org_stream_targets where id = ${r.targetId}`;
    expect(first!.dest_fingerprint).toBe(fingerprintDestination(r.target.url, r.target.streamKey));
    const again = await sql.begin((tx) =>
      insertStreamTarget(tx, {
        orgId: r.orgId, kind: "custom_rtmp", label: "renamed", watchUrl: "https://youtube.com/@club",
        rtmp: { url: "rtmps://a.rtmp.youtube.com:443/live2", streamKey: r.target.streamKey },
      }),
    );
    expect(again.id).toBe(r.targetId);
    expect(again).toMatchObject({ kind: "youtube", label: "x", watchUrl: null });   // the STORED row answers, not the arguments
    const rows = await sql<{ id: string; kind: string; label: string; watch_url: string | null }[]>`
      select id, kind, label, watch_url from org_stream_targets where org_id = ${r.orgId}`;
    expect(rows).toEqual([{ id: r.targetId, kind: "youtube", label: "x", watch_url: null }]);
    expect(await sql.begin((tx) => readTargetSecret(tx, r.orgId, r.targetId))).toEqual(r.target);   // first spelling kept
    const other = await sql.begin((tx) =>
      insertStreamTarget(tx, { orgId: r.orgId, kind: "youtube", label: "x", watchUrl: null, rtmp: destination() }),
    );
    expect(other.id).not.toBe(r.targetId);
  });

  // The guard's reach: the insert CONFLICTED (no row returned) and the read-back found nothing — the row was deleted
  // between the two statements. No production path deletes a target today, so a real database cannot reach this
  // window on demand; a scripted transaction answers both statements with nothing, which is exactly that window.
  it("A19 guard: a destination that conflicts and then cannot be read back is refused BY NAME — never an undefined row handed to the caller", async () => {
    const statements: string[] = [];
    const vanished = ((strings: TemplateStringsArray) => {
      statements.push(strings.join("?").replace(/\s+/g, " ").trim());
      return Promise.resolve([]);
    }) as unknown as Tx;
    const err = await insertStreamTarget(vanished, { orgId: randomUUID(), kind: "youtube", label: "x", watchUrl: null, rtmp: destination() })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StreamTargetVanishedError);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^insert into org_stream_targets .* on conflict \(org_id, dest_fingerprint\) where dest_fingerprint is not null do nothing/);
    expect(statements[1]).toMatch(/^select id, kind, label, watch_url, created_at from org_stream_targets where org_id = \? and dest_fingerprint = \?$/);
  });

  it("A19: an undialable destination is refused BEFORE anything is written — no fingerprint means no row", async () => {
    const r = await rig();
    const before = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${r.orgId}`;
    await expect(sql.begin((tx) =>
      insertStreamTarget(tx, { orgId: r.orgId, kind: "custom_rtmp", label: "x", watchUrl: null, rtmp: { url: "rtmps://127.0.0.1/app", streamKey: secret65() } }),
    )).rejects.toThrow();
    const after = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${r.orgId}`;
    expect(before[0]!.n).toBe(1);
    expect(after[0]!.n).toBe(1);
  });

  // Whole-branch review I5 (auth). `org_stream_targets` is under FORCE RLS with ZERO policies and is reached only by
  // the superuser client, so RLS constrains nothing here by design — the org scope in the query is the WHOLE tenancy
  // check on a live destination credential. BOTH directions, because a scope that refuses everything would pass the
  // negative row alone, and a scope that is absent would pass the positive one alone.
  it("I5: the destination credential is scoped to its ORG — the owning org reads it; another org gets nothing, on the very same target id, and learns nothing about it beyond 'not found'", async () => {
    const mine = await rig();
    const theirs = await rig();
    expect(theirs.orgId).not.toBe(mine.orgId);                      // two real orgs, or the refusal below is vacuous
    const target = mine.target;
    // The row exists and holds an openable envelope: the ONLY thing that can refuse the next line is the org scope.
    expect(await sql.begin((tx) => readTargetSecret(tx, mine.orgId, mine.targetId))).toEqual(target);
    const err = await sql.begin((tx) => readTargetSecret(tx, theirs.orgId, mine.targetId)).then(() => null, (e: unknown) => e as Error);
    expect(err, "a cross-org read of a destination credential must not resolve").toBeInstanceOf(Error);
    expect(err!.message).toMatch(/not found/);
    expect(err!.message).not.toContain(target.streamKey);           // and the refusal is not an oracle
    expect(err!.message).not.toContain(theirs.orgId);
    // …and the owning org's own target is unaffected by the neighbour existing at all.
    const theirTarget = theirs.target;
    expect(theirTarget.streamKey).not.toBe(target.streamKey);       // two distinct secrets, or the reads cannot differ
    expect(await sql.begin((tx) => readTargetSecret(tx, theirs.orgId, theirs.targetId))).toEqual(theirTarget);
    await expect(sql.begin((tx) => readTargetSecret(tx, mine.orgId, theirs.targetId))).rejects.toThrow(/not found/);
  });

  it("the RAW row: no *_enc bytes hold the passphrase, streamId or a stream key; the url columns hold the bare urls", async () => {
    const r = await rig();
    const { uid, creds } = observed();
    const target = r.target;
    await sql.begin((tx) => storeInputCredentials(tx, r.inputId, uid, creds));
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
    await expect(sql.begin((tx) => readTargetSecret(tx, r.orgId, randomUUID()))).rejects.toThrow(/not found/);
    expect(await sql.begin((tx) => readTargetSecret(tx, r.orgId, r.targetId))).toEqual(r.target);
  });

  it("readFirstInput: null with no input row (even while another session has a slot 0); otherwise THIS session's LOWEST slot, whatever the write order and whether or not a slot 0 exists", async () => {
    const r = await rig();
    const other = await rig();                                       // a neighbour session that DOES have slot 0
    await sql`delete from fixture_stream_inputs where id = ${r.inputId}`;
    expect(await sql.begin((tx) => readFirstInput(tx, r.sessionId))).toBeNull();
    // Written out of order and with no slot 0: the right answer (slot 1) is neither the first row written nor a literal 0.
    const [two] = await sql<{ id: string }[]>`insert into fixture_stream_inputs (session_id, slot) values (${r.sessionId}, 2) returning id`;
    const [one] = await sql<{ id: string }[]>`insert into fixture_stream_inputs (session_id, slot) values (${r.sessionId}, 1) returning id`;
    const { uid, creds } = observed();
    await sql.begin((tx) => storeInputCredentials(tx, one!.id, uid, creds));
    expect(await sql.begin((tx) => readFirstInput(tx, r.sessionId)))
      .toEqual({ id: one!.id, slot: 1, ingestInputId: uid, srt: creds.srt, rtmps: creds.rtmps });
    expect(two!.id).not.toBe(one!.id);
    // A slot 0 arriving later becomes the first input — the read follows the data, not the history.
    const [zero] = await sql<{ id: string }[]>`insert into fixture_stream_inputs (session_id, slot) values (${r.sessionId}, 0) returning id`;
    expect(await sql.begin((tx) => readFirstInput(tx, r.sessionId)))
      .toEqual({ id: zero!.id, slot: 0, ingestInputId: null, srt: null, rtmps: null });
    // The neighbour's first input is its own.
    expect((await sql.begin((tx) => readFirstInput(tx, other.sessionId)))!.id).toBe(other.inputId);
  });

  it("one flipped byte in a stored envelope makes the read throw, echoing none of the plaintext; the untouched read opens", async () => {
    const r = await rig();
    const { uid, creds } = observed();
    const target = r.target;
    await sql.begin((tx) => storeInputCredentials(tx, r.inputId, uid, creds));
    const read = () => sql.begin((tx) => readInputBySlot(tx, r.sessionId, 0));
    expect(await read()).toEqual({ id: r.inputId, slot: 0, ingestInputId: uid, srt: creds.srt, rtmps: creds.rtmps });
    expect(await sql.begin((tx) => readTargetSecret(tx, r.orgId, r.targetId))).toEqual(target);

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
    const targetMessage = await messageOf(sql.begin((tx) => readTargetSecret(tx, r.orgId, r.targetId)));
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
