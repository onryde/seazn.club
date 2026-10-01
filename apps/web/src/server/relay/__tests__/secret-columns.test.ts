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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { STREAM_PLATFORMS, STREAM_PLATFORM_PRESETS, checkDestination } from "@/lib/stream-destinations";
import { seedOrg, startedDivisionWithFixture } from "@/server/usecases/__tests__/_rig";
import { log } from "@/server/logger";
import { fingerprintDestination, seal } from "../crypto";
import {
  KEY_HINT_CHARS, KEY_HINT_MIN_LENGTH, StreamTargetVanishedError, TargetSecretUnreadableError, archiveStreamTarget, insertStreamTarget, keyHintOf,
  lockStreamTarget, readFirstInput, readInputBySlot, readKeyHints, readTargetSecret, replaceTargetKey, storeInputCredentials,
} from "../secret-columns";

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

  // The guard's reach: an ACTIVE read and an ARCHIVED read that both find nothing, then an insert that CONFLICTS (no row
  // returned) — the conflicting row was archived or deleted between the statements. No production path makes that
  // window on demand, so a scripted transaction answers every statement with nothing, which is exactly that window.
  //
  // m6 (lane C final review): the refusal used to be the END — nothing mapped it, so a lost race was a 500, and the comment
  // promised a retry nobody made. The retry is now made HERE, once, in the same transaction: under READ COMMITTED each
  // round's statements are new statements with new snapshots, so the second round sees the conflicting row gone and its
  // insert lands. Only a second lost round in a row is still refused by name. D2 (V427) made each round THREE
  // statements: the active read, the archived read, the insert.
  const INSERT_SQL = /^insert into org_stream_targets .* on conflict \(org_id, dest_fingerprint\) where dest_fingerprint is not null and archived_at is null do nothing/;
  const SELECT_SQL = /^select id, kind, label, watch_url, created_at from org_stream_targets where org_id = \? and dest_fingerprint = \? and archived_at is null$/;
  const ARCHIVED_SQL = /^select id from org_stream_targets where org_id = \? and dest_fingerprint = \? and archived_at is not null order by archived_at desc, created_at desc limit 1$/;
  const kindOf = (s: string) => INSERT_SQL.test(s) ? "insert" : SELECT_SQL.test(s) ? "active" : ARCHIVED_SQL.test(s) ? "archived" : s;
  const scripted = (answers: unknown[][]) => {
    const statements: string[] = [];
    const tx = ((strings: TemplateStringsArray) => {
      statements.push(strings.join("?").replace(/\s+/g, " ").trim());
      return Promise.resolve(answers[statements.length - 1] ?? []);
    }) as unknown as Tx;
    return { tx, statements };
  };

  it("A19 guard + m6: a destination that conflicts and cannot be read back is RETRIED once in the same transaction, and the retry's insert lands — the caller gets the new row, never a 500 (mutant: no retry → StreamTargetVanishedError)", async () => {
    const landed = { id: randomUUID(), kind: "youtube", label: "x", watch_url: null, created_at: new Date() };
    // round 1: no active, no archived, the insert conflicts; round 2: no active, no archived, the insert returns the row
    const { tx, statements } = scripted([[], [], [], [], [], [landed]]);
    const out = await insertStreamTarget(tx, { orgId: randomUUID(), kind: "youtube", label: "x", watchUrl: null, rtmp: destination() });
    expect(out).toMatchObject({ id: landed.id, kind: "youtube", label: "x", watchUrl: null });
    expect(statements).toHaveLength(6);
    expect(statements.map(kindOf)).toEqual(["active", "archived", "insert", "active", "archived", "insert"]);
  });

  it("A19 guard: a destination that vanishes on the retry TOO is refused BY NAME — never an undefined row handed to the caller, and never a third attempt (mutant: retry forever / no refusal)", async () => {
    const { tx, statements } = scripted([]);                   // every statement answers nothing: lost twice
    const err = await insertStreamTarget(tx, { orgId: randomUUID(), kind: "youtube", label: "x", watchUrl: null, rtmp: destination() })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StreamTargetVanishedError);
    expect(err, "M4: a 409 retry over the v1 envelope, never a 500").toMatchObject({ status: 409 });
    expect(statements).toHaveLength(6);                        // six, not more: never a third round
    expect(statements.map(kindOf)).toEqual(["active", "archived", "insert", "active", "archived", "insert"]);
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

  /** A destination that dials: the rig's own youtube url with a fresh 65-char key. */
  const dest = (streamKey = secret65()) => ({ url: "rtmps://a.rtmps.youtube.com/live2", streamKey });
  const put = (orgId: string, rtmp: { url: string; streamKey: string }, label = "L", watchUrl: string | null = null) =>
    sql.begin((tx) => insertStreamTarget(tx, { orgId, kind: "youtube", label, watchUrl, rtmp }));

  it("D2 create order 1/3: an ACTIVE duplicate is returned as 'existing' and writes nothing — not its label, not its watch link", async () => {
    const { orgId } = await rig();
    const d = dest();
    const first = await put(orgId, d, "First", "https://youtu.be/one");
    const again = await put(orgId, d, "Second", "https://youtu.be/two");
    expect(first.outcome).toBe("inserted");
    expect(again).toMatchObject({ id: first.id, outcome: "existing", label: "First", watchUrl: "https://youtu.be/one" });
  });

  it("D2 create order 2/3: an ARCHIVED duplicate is RESTORED — same id, the SUBMITTED label and watch link, archived_at cleared", async () => {
    const { orgId } = await rig();
    const d = dest();
    const first = await put(orgId, d, "Old name", null);
    expect(await sql.begin((tx) => archiveStreamTarget(tx, orgId, first.id))).toBe(true);
    const back = await put(orgId, d, "New name", "https://youtu.be/new");
    expect(back).toMatchObject({ id: first.id, outcome: "restored", label: "New name", watchUrl: "https://youtu.be/new" });
    const [row] = await sql<{ archived_at: Date | null }[]>`select archived_at from org_stream_targets where id = ${first.id}`;
    expect(row!.archived_at).toBeNull();
  });

  it("D2 create order 2/3: of TWO archived rows of one destination, the MOST RECENTLY archived is the one restored", async () => {
    const { orgId } = await rig();
    const d = dest();
    const fp = fingerprintDestination(d.url, d.streamKey);
    const raw = (label: string, archivedAt: string) => sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc, dest_fingerprint, archived_at)
      values (${orgId}, 'youtube', ${label}, ${seal(JSON.stringify(d))}, ${fp}, ${archivedAt}) returning id`;
    const [older] = await raw("older", "2026-09-01T00:00:00Z");
    const [newer] = await raw("newer", "2026-09-20T00:00:00Z");
    const back = await put(orgId, d, "again");
    expect(back.id).toBe(newer!.id);      // differential: the wrong ORDER BY returns `older`
    expect(back.id).not.toBe(older!.id);
  });

  it("D2 create order 3/3: no row of this destination (active or archived) inserts a new one", async () => {
    const { orgId } = await rig();
    const made = await put(orgId, dest());
    expect(made.outcome).toBe("inserted");
  });

  it("archiveStreamTarget: true once, false on the second call, false for ANOTHER org's id; an archived row reads as absent to lockStreamTarget", async () => {
    const a = await rig();
    const b = await rig();
    const t = await put(a.orgId, dest());
    expect(await sql.begin((tx) => archiveStreamTarget(tx, b.orgId, t.id))).toBe(false);
    expect(await sql.begin((tx) => lockStreamTarget(tx, a.orgId, t.id))).toBe(true);
    expect(await sql.begin((tx) => archiveStreamTarget(tx, a.orgId, t.id))).toBe(true);
    expect(await sql.begin((tx) => archiveStreamTarget(tx, a.orgId, t.id))).toBe(false);
    expect(await sql.begin((tx) => lockStreamTarget(tx, a.orgId, t.id))).toBe(false);
  });

  it("keyHintOf: null below KEY_HINT_MIN_LENGTH, the last KEY_HINT_CHARS characters at and above it", () => {
    const short = "x".repeat(KEY_HINT_MIN_LENGTH - 1);
    const exact = `${"y".repeat(KEY_HINT_MIN_LENGTH - KEY_HINT_CHARS)}abc`;
    expect(keyHintOf(short)).toBeNull();
    expect(keyHintOf(exact)).toBe(exact.slice(-KEY_HINT_CHARS));
    expect(keyHintOf(exact)).toHaveLength(KEY_HINT_CHARS);
  });

  it("readKeyHints (Review Focus 1): each ACTIVE row's hint; an UNOPENABLE envelope reads null and never throws; archived rows are absent", async () => {
    const { orgId } = await rig();
    const good = await put(orgId, dest("abcd-1234-efgh-5678-ijkl"));
    const gone = await put(orgId, dest());
    await sql.begin((tx) => archiveStreamTarget(tx, orgId, gone.id));
    const [bad] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, 'youtube', 'bad', ${Buffer.from("not-a-real-envelope")}) returning id`;
    const hints = await sql.begin((tx) => readKeyHints(tx, orgId));
    expect(hints.get(good.id)).toBe("ijkl".slice(-KEY_HINT_CHARS));
    expect(hints.get(bad!.id)).toBeNull();
    expect(hints.has(gone.id)).toBe(false);
    // rig() seeds one target of its own; it is active and counted.
    expect(hints.size).toBe(3);
  });

  it("replaceTargetKey: re-seals the KEY under the SAME url and re-fingerprints; the same key again is a no-op", async () => {
    const { orgId } = await rig();
    const d = dest();
    const t = await put(orgId, d);
    const next = secret65();
    expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, t.id, next))).toEqual({ ok: true, changed: true });
    expect(await sql.begin((tx) => readTargetSecret(tx, orgId, t.id))).toEqual({ url: d.url, streamKey: next });
    const [row] = await sql<{ dest_fingerprint: string }[]>`select dest_fingerprint from org_stream_targets where id = ${t.id}`;
    expect(row!.dest_fingerprint).toBe(fingerprintDestination(d.url, next));
    expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, t.id, next))).toEqual({ ok: true, changed: false });
  });

  it("replaceTargetKey: an ACTIVE row already holding the new key is 'duplicate' naming it; an ARCHIVED holder and another ORG's holder do not block", async () => {
    const a = await rig();
    const b = await rig();
    const taken = dest();
    const holder = await put(a.orgId, taken, "Holder");
    const mover = await put(a.orgId, dest(), "Mover");
    expect(await sql.begin((tx) => replaceTargetKey(tx, a.orgId, mover.id, taken.streamKey)))
      .toEqual({ ok: false, reason: "duplicate", other: { id: holder.id, label: "Holder" } });
    await sql.begin((tx) => archiveStreamTarget(tx, a.orgId, holder.id));
    expect(await sql.begin((tx) => replaceTargetKey(tx, a.orgId, mover.id, taken.streamKey))).toEqual({ ok: true, changed: true });
    const other = await put(b.orgId, dest(), "B");
    expect(await sql.begin((tx) => replaceTargetKey(tx, b.orgId, other.id, taken.streamKey))).toEqual({ ok: true, changed: true });
  });

  it("replaceTargetKey: an archived or foreign target is 'not_found'; a stored url the allowlist no longer admits is 'undialable' with its rule", async () => {
    const a = await rig();
    const b = await rig();
    const t = await put(a.orgId, dest());
    expect(await sql.begin((tx) => replaceTargetKey(tx, b.orgId, t.id, secret65()))).toEqual({ ok: false, reason: "not_found" });
    await sql.begin((tx) => archiveStreamTarget(tx, a.orgId, t.id));
    expect(await sql.begin((tx) => replaceTargetKey(tx, a.orgId, t.id, secret65()))).toEqual({ ok: false, reason: "not_found" });
    const [legacy] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc)
      values (${a.orgId}, 'custom_rtmp', 'legacy', ${seal(JSON.stringify({ url: "rtmps://media.example.com/live", streamKey: secret65() }))}) returning id`;
    expect(await sql.begin((tx) => replaceTargetKey(tx, a.orgId, legacy!.id, secret65()))).toEqual({ ok: false, reason: "undialable", rule: "host" });
  });

  // I2 (B1 review): after a KEK change a row's envelope will not open — the list shows keyHint null for it (Review Focus
  // 1) and Replace key is its in-place recovery. The stored url is gone with the envelope; a PLATFORM row's url is the
  // platform's preset (D6), so it is re-sealed there; a legacy kind has no preset and is refused by name.
  it("I2: replaceTargetKey on an UNOPENABLE envelope — a platform row is re-sealed on its preset with a fresh fingerprint (every platform); a legacy kind is 'unreadable' and nothing is written", async () => {
    let checked = 0;
    for (const kind of STREAM_PLATFORMS) {
      const { orgId } = await rig();
      const [row] = await sql<{ id: string }[]>`
        insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, ${kind}, 'stale', ${Buffer.from("sealed-under-another-kek")}) returning id`;
      const next = secret65();
      expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, row!.id, next)), kind).toEqual({ ok: true, changed: true });
      const preset = checkDestination(STREAM_PLATFORM_PRESETS[kind]);
      expect(preset.ok, kind).toBe(true);
      const url = preset.ok ? preset.url : "";
      expect(await sql.begin((tx) => readTargetSecret(tx, orgId, row!.id)), kind).toEqual({ url, streamKey: next });
      const [after] = await sql<{ dest_fingerprint: string }[]>`select dest_fingerprint from org_stream_targets where id = ${row!.id}`;
      expect(after!.dest_fingerprint, kind).toBe(fingerprintDestination(url, next));
      checked++;
    }
    expect(checked).toBe(STREAM_PLATFORMS.length);
    const { orgId } = await rig();
    const stale = Buffer.from("sealed-under-another-kek");
    const [legacy] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, 'custom_rtmp', 'legacy', ${stale}) returning id`;
    expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, legacy!.id, secret65()))).toEqual({ ok: false, reason: "unreadable" });
    const [kept] = await sql<{ rtmp_enc: Uint8Array; dest_fingerprint: string | null }[]>`
      select rtmp_enc, dest_fingerprint from org_stream_targets where id = ${legacy!.id}`;
    expect(Buffer.from(kept!.rtmp_enc).equals(stale)).toBe(true);
    expect(kept!.dest_fingerprint).toBeNull();
  });

  // N3 (B1 review): the recovery above was SILENT — an operator could not tell a KEK change from a quiet week. One warn
  // per unopenable envelope, carrying the target id and kind ONLY: never the new key, the preset url, a hint, or bytes.
  it("N3: an unopenable envelope is LOGGED once on Replace key — target id and kind only, for a platform row and a legacy one; an openable row logs nothing", async () => {
    const warns: unknown[][] = [];
    const spy = vi.spyOn(log, "warn").mockImplementation(((...args: unknown[]) => { warns.push(args); }) as never);
    try {
      const stale = Buffer.from("sealed-under-another-kek");
      const { orgId } = await rig();
      const cases: { kind: string; want: string }[] = [{ kind: "youtube", want: "recovered" }, { kind: "custom_rtmp", want: "unreadable" }];
      let checked = 0;
      for (const c of cases) {
        const [row] = await sql<{ id: string }[]>`
          insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${orgId}, ${c.kind}, 'stale', ${stale}) returning id`;
        const next = secret65();
        const before = warns.length;
        const r = await sql.begin((tx) => replaceTargetKey(tx, orgId, row!.id, next));
        expect(r.ok ? "recovered" : (r as { reason: string }).reason, c.kind).toBe(c.want);
        const mine = warns.slice(before);
        expect(mine, `${c.kind}: exactly one warn`).toHaveLength(1);
        expect(mine[0]![0], c.kind).toEqual({ targetId: row!.id, kind: c.kind });
        const text = JSON.stringify(mine[0]);
        for (const leak of [next, next.slice(-3), STREAM_PLATFORM_PRESETS.youtube, "sealed-under-another-kek", stale.toString("hex")]) {
          expect(text, `${c.kind}: the log line carries no secret`).not.toContain(leak);
        }
        checked++;
      }
      expect(checked).toBe(cases.length);
      // The positive pair: a row whose envelope opens is an ordinary replace, and says nothing.
      const preset = checkDestination(STREAM_PLATFORM_PRESETS.twitch);
      const t = await put(orgId, { url: preset.ok ? preset.url : "", streamKey: secret65() });
      const quiet = warns.length;
      expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, t.id, secret65()))).toEqual({ ok: true, changed: true });
      expect(warns.length, "an openable envelope logs nothing").toBe(quiet);
    } finally {
      spy.mockRestore();
    }
  });

  // M3 (B2 review): an envelope that will not open under a VALID KEK is the organiser's to fix (a KEK rotation, a damaged
  // byte: TargetSecretUnreadableError → 422 Replace key). A MISSING or MALFORMED RELAY_KEK is the deployment's fault: it
  // must stay the loud config error it was (a 500 that reaches Sentry), never a warn-level 422 telling every organiser to
  // replace a key that is fine. Both branches, and the same guard on Replace key's recovery.
  describe("M3: a missing or malformed RELAY_KEK is never filed as an unreadable destination", () => {
    const withKek = async <T,>(value: string | undefined, body: () => Promise<T>): Promise<T> => {
      const saved = process.env.RELAY_KEK;
      if (value === undefined) delete process.env.RELAY_KEK;
      else process.env.RELAY_KEK = value;
      try {
        return await body();
      } finally {
        process.env.RELAY_KEK = saved;
      }
    };
    const KEK_FAULTS = [{ name: "unset", value: undefined, says: /RELAY_KEK is not set/ }, { name: "malformed", value: "zz".repeat(32), says: /RELAY_KEK must be exactly 64 hex/ }] as const;

    it("readTargetSecret: an unset or malformed KEK rethrows the KEK's own error — not TargetSecretUnreadableError; a valid KEK on an unopenable envelope IS TargetSecretUnreadableError", async () => {
      const r = await rig();
      let checked = 0;
      for (const f of KEK_FAULTS) {
        const err = await withKek(f.value, () => sql.begin((tx) => readTargetSecret(tx, r.orgId, r.targetId)).then(() => null, (e: unknown) => e));
        expect(err, f.name).toBeInstanceOf(Error);
        expect(err, f.name).not.toBeInstanceOf(TargetSecretUnreadableError);
        expect((err as Error).message, f.name).toMatch(f.says);
        checked++;
      }
      expect(checked).toBe(KEK_FAULTS.length);
      // The other branch, under the valid KEK: an envelope sealed elsewhere is the typed organiser-side error.
      const [row] = await sql<{ id: string }[]>`
        insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${r.orgId}, 'youtube', 'stale', ${Buffer.from("sealed-under-another-kek")}) returning id`;
      const err = await sql.begin((tx) => readTargetSecret(tx, r.orgId, row!.id)).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(TargetSecretUnreadableError);
      expect(err).toMatchObject({ targetId: row!.id, kind: "youtube" });
      // …and the readable row still opens: the KEK was restored.
      expect(await sql.begin((tx) => readTargetSecret(tx, r.orgId, r.targetId))).toEqual(r.target);
    });

    it("replaceTargetKey: an unset or malformed KEK rethrows before the recovery — no 'unopenable envelope' warn, and the row is untouched", async () => {
      const r = await rig();
      const warns: unknown[][] = [];
      const spy = vi.spyOn(log, "warn").mockImplementation(((...args: unknown[]) => { warns.push(args); }) as never);
      try {
        const [before] = await sql<{ rtmp_enc: Uint8Array; dest_fingerprint: string | null }[]>`
          select rtmp_enc, dest_fingerprint from org_stream_targets where id = ${r.targetId}`;
        let checked = 0;
        for (const f of KEK_FAULTS) {
          const err = await withKek(f.value, () => sql.begin((tx) => replaceTargetKey(tx, r.orgId, r.targetId, secret65())).then(() => null, (e: unknown) => e));
          expect((err as Error | null)?.message, f.name).toMatch(f.says);
          checked++;
        }
        expect(checked).toBe(KEK_FAULTS.length);
        expect(warns.filter(([o]) => (o as { targetId?: string }).targetId === r.targetId), "no recovery warn for a KEK fault").toEqual([]);
        const [after] = await sql<{ rtmp_enc: Uint8Array; dest_fingerprint: string | null }[]>`
          select rtmp_enc, dest_fingerprint from org_stream_targets where id = ${r.targetId}`;
        expect(Buffer.from(after!.rtmp_enc).equals(Buffer.from(before!.rtmp_enc))).toBe(true);
        expect(after!.dest_fingerprint).toBe(before!.dest_fingerprint);
      } finally {
        spy.mockRestore();
      }
    });

    it("readKeyHints (N1, B2 re-review): an unset or malformed KEK rejects with the KEK's own error — never a list of null hints; under the valid KEK an unopenable ROW still reads null beside a readable one (Review Focus 1)", async () => {
      const r = await rig();
      const [bad] = await sql<{ id: string }[]>`
        insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${r.orgId}, 'youtube', 'stale', ${Buffer.from("sealed-under-another-kek")}) returning id`;
      // The precondition: there ARE active rows to open, or a KEK fault could never be reached and "rejects" would be vacuous.
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${r.orgId} and archived_at is null`;
      expect(n).toBe(2);
      let checked = 0;
      for (const f of KEK_FAULTS) {
        const err = await withKek(f.value, () => sql.begin((tx) => readKeyHints(tx, r.orgId)).then(() => null, (e: unknown) => e));
        expect(err, f.name).toBeInstanceOf(Error);
        expect((err as Error).message, f.name).toMatch(f.says);
        checked++;
      }
      expect(checked).toBe(KEK_FAULTS.length);
      // The other branch, with the KEK restored: the row's own fault is a null hint, the list still answers.
      const hints = await sql.begin((tx) => readKeyHints(tx, r.orgId));
      expect(hints.get(bad!.id)).toBeNull();
      expect(hints.get(r.targetId)).toBe(keyHintOf(r.target.streamKey));
      expect(hints.get(r.targetId), "the readable row really has a hint, so null above is the row's fault").not.toBeNull();
      expect(hints.size).toBe(2);
    });

    it("the KEK's fault wins over a ROW's fault, whatever order the rows come back in: with ONLY an unopenable row active, an unset or malformed KEK still answers with the KEK's own error — readKeyHints, readTargetSecret and replaceTargetKey (found red in the final-review baseline: heap order decided which error surfaced)", async () => {
      const r = await rig();
      const [bad] = await sql<{ id: string }[]>`
        insert into org_stream_targets (org_id, kind, label, rtmp_enc) values (${r.orgId}, 'youtube', 'stale', ${Buffer.from("sealed-under-another-kek")}) returning id`;
      expect(await sql.begin((tx) => archiveStreamTarget(tx, r.orgId, r.targetId)), "PREMISE: the readable row is gone").toBe(true);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${r.orgId} and archived_at is null`;
      expect(n, "PREMISE: the unopenable row is the only active one").toBe(1);
      let checked = 0;
      for (const f of KEK_FAULTS) {
        const reads: [string, () => Promise<unknown>][] = [
          ["readKeyHints", () => sql.begin((tx) => readKeyHints(tx, r.orgId))],
          ["readTargetSecret", () => sql.begin((tx) => readTargetSecret(tx, r.orgId, bad!.id))],
          ["replaceTargetKey", () => sql.begin((tx) => replaceTargetKey(tx, r.orgId, bad!.id, secret65()))],
        ];
        for (const [name, read] of reads) {
          const err = await withKek(f.value, () => read().then(() => null, (e: unknown) => e));
          expect((err as Error | null)?.message, `${f.name} · ${name}`).toMatch(f.says);
          expect(err, `${f.name} · ${name}`).not.toBeInstanceOf(TargetSecretUnreadableError);
          checked++;
        }
      }
      expect(checked).toBe(KEK_FAULTS.length * 3);
    });
  });

  it("I2: a DAMAGED envelope whose fingerprint still matches (same KEK, same key) is re-sealed by replacing the SAME key — not the no-op an openable row gets (mutant: short-circuit on the fingerprint alone)", async () => {
    const { orgId } = await rig();
    // Stored on the youtube PRESET — the url the recovery re-seals on — so the fingerprint really does match.
    const preset = checkDestination(STREAM_PLATFORM_PRESETS.youtube);
    expect(preset.ok).toBe(true);
    const d = { url: preset.ok ? preset.url : "", streamKey: secret65() };
    const t = await put(orgId, d);
    const [row] = await sql<{ rtmp_enc: Uint8Array; dest_fingerprint: string }[]>`select rtmp_enc, dest_fingerprint from org_stream_targets where id = ${t.id}`;
    expect(row!.dest_fingerprint, "the precondition: the same key fingerprints the same").toBe(fingerprintDestination(d.url, d.streamKey));
    const damaged = Buffer.from(row!.rtmp_enc);
    damaged[damaged.length - 1] ^= 0xff;                        // the auth tag's last byte: the envelope no longer opens
    await sql`update org_stream_targets set rtmp_enc = ${damaged} where id = ${t.id}`;
    await expect(sql.begin((tx) => readTargetSecret(tx, orgId, t.id))).rejects.toThrow();
    expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, t.id, d.streamKey))).toEqual({ ok: true, changed: true });
    expect(await sql.begin((tx) => readTargetSecret(tx, orgId, t.id))).toEqual({ url: d.url, streamKey: d.streamKey });
    // …and once it opens again, the same key IS the no-op.
    expect(await sql.begin((tx) => replaceTargetKey(tx, orgId, t.id, d.streamKey))).toEqual({ ok: true, changed: false });
  });

  // M4 (B1 review): the two race catches — a restore and a key replace that meet a 23505 on the fingerprint index — and
  // the refusal they end in. No production path opens those windows on demand, so a scripted transaction does: its
  // savepoint REJECTS with the index's own 23505, exactly what Postgres raises when a concurrent writer won.
  const conflict = () => Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint_name: "org_stream_targets_org_dest_fingerprint" });
  const racing = (answers: unknown[][], savepointError: () => Error) => {
    const statements: string[] = [];
    const tx = ((strings: TemplateStringsArray) => {
      statements.push(strings.join("?").replace(/\s+/g, " ").trim());
      return Promise.resolve(answers[statements.length - 1] ?? []);
    }) as unknown as Tx & { savepoint: unknown };
    (tx as { savepoint: unknown }).savepoint = () => { statements.push("savepoint"); return Promise.reject(savepointError()); };
    return { tx: tx as unknown as Tx, statements };
  };

  it("M4: a RESTORE that meets the fingerprint index's 23505 (a concurrent writer won) rounds again and returns the winner as 'existing' — never a 500; any OTHER error from the restore propagates (mutant: rethrow the conflict)", async () => {
    const winner = { id: randomUUID(), kind: "youtube", label: "won", watch_url: null, created_at: new Date() };
    // round 1: no active, one archived, its restore conflicts; round 2: the active read finds the winner
    const { tx, statements } = racing([[], [{ id: randomUUID() }], [], [winner]], conflict);
    const out = await insertStreamTarget(tx, { orgId: randomUUID(), kind: "youtube", label: "x", watchUrl: null, rtmp: destination() });
    expect(out).toMatchObject({ id: winner.id, label: "won", outcome: "existing" });
    expect(statements.map(kindOf)).toEqual(["active", "archived", "savepoint", "active"]);
    // The negative pair: a 23505 on ANOTHER constraint is not the race and is not swallowed.
    const other = () => Object.assign(new Error("other"), { code: "23505", constraint_name: "some_other_index" });
    const { tx: tx2 } = racing([[], [{ id: randomUUID() }]], other);
    await expect(insertStreamTarget(tx2, { orgId: randomUUID(), kind: "youtube", label: "x", watchUrl: null, rtmp: destination() }))
      .rejects.toMatchObject({ constraint_name: "some_other_index" });
  });

  it("M4: a key replace whose write meets the fingerprint index's 23505 re-reads the winner and is 'duplicate' naming it; a winner gone by the re-read is StreamTargetVanishedError — a 409 retry, never a 500 (mutant: rethrow the conflict)", async () => {
    const d = dest();
    const current = [{ rtmp_enc: seal(JSON.stringify(d)), dest_fingerprint: "stale-fingerprint", kind: "youtube" }];
    const winner = { id: randomUUID(), label: "Court 2" };
    // the row, no other holder, the write conflicts, the re-read finds the winner
    const won = racing([current, [], [], [winner]], conflict);
    expect(await replaceTargetKey(won.tx, randomUUID(), randomUUID(), secret65())).toEqual({ ok: false, reason: "duplicate", other: winner });
    expect(won.statements).toHaveLength(4);
    expect(won.statements[2]).toBe("savepoint");
    // …and the winner already gone by the re-read.
    const gone = racing([current, [], [], []], conflict);
    const err = await replaceTargetKey(gone.tx, randomUUID(), randomUUID(), secret65()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StreamTargetVanishedError);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409 });
  });
});
