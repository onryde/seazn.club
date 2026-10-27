// YouTube Connect T2: token-store.ts is the ONLY file that names `refresh_token_enc` (enc-boundary.test.ts holds every
// other file to it), so every statement that writes or reads a refresh token is exercised here, against real Postgres,
// each refusal beside its accepted twin.
//
// What these tests are for, and the ruling behind them (controller R1): V479's CHECKs say `revoked <=> no token` and
// `revoked <=> revoked_at`, IMMEDIATE. So a half-revoke is refused by the database, not stored — and that is only a
// safety net if every writer of those three columns is ONE statement. The revoke test below counts statements.
//
// Expected values are literals typed here (the spec's statuses, a token string, `null`), never read back from the code
// under test. A token is a string this file invents; nothing here prints one.
//
// Skipped without DATABASE_URL like every suite in server/usecases/__tests__. The new tables are reached through the
// privileged `sql` client: RLS is FORCEd with zero policies and no grant (rls-static.test.ts), the stream pattern.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, statementCount } from "@/lib/db";
import { fingerprintYoutubeChannel, openWith, seal } from "@/server/relay/crypto";
import { seedOrg } from "@/server/usecases/__tests__/_rig";
import {
  YoutubeTokenUnreadableError, insertConnectionWithToken, openToken, replaceConnectionToken, revokeConnection, sealPendingToken,
  takePendingToken,
} from "../token-store";

const HAS_DB = !!process.env.DATABASE_URL;

// This file's own KEKs; the developer's / CI's are put back afterwards, or removed when there were none — never assigned
// `undefined`, which Node stores as the string "undefined". Never printed.
const KEYS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEYS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const SCOPE = "https://www.googleapis.com/auth/youtube";
const newToken = () => `1//rt-${randomBytes(24).toString("base64url")}`;

/** Run `body` with YOUTUBE_TOKEN_KEK unset or set to `value`, restoring it even when `body` throws. */
async function withYtKek<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const keep = process.env.YOUTUBE_TOKEN_KEK;
  if (value === undefined) delete process.env.YOUTUBE_TOKEN_KEK;
  else process.env.YOUTUBE_TOKEN_KEK = value;
  try {
    return await body();
  } finally {
    if (keep === undefined) delete process.env.YOUTUBE_TOKEN_KEK;
    else process.env.YOUTUBE_TOKEN_KEK = keep;
  }
}
const KEK_FAULTS = [
  { name: "unset", value: undefined, says: /YOUTUBE_TOKEN_KEK is not set/ },
  { name: "malformed", value: "zz".repeat(32), says: /YOUTUBE_TOKEN_KEK must be exactly 64 hex/ },
] as const;

/** The failure of an async call that must throw (so a test can say what the error does NOT carry). */
async function failureOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("expected the call to throw, and it returned");
}

async function newUser(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into users (email, display_name) values (${`ts-${randomUUID()}@example.test`}, 'Token Tester') returning id`;
  return row!.id;
}

type ConnInput = Parameters<typeof insertConnectionWithToken>[1];
async function rig() {
  const { auth } = await seedOrg();
  const userId = await newUser();
  const input = (over: Partial<ConnInput> = {}): ConnInput => ({
    orgId: auth.orgId, channelId: `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`, channelTitle: "Token FC", googleSub: null,
    grantedScope: SCOPE, defaultPrivacy: "unlisted", madeForKids: false, consentBy: userId, consentAt: new Date(), consentVersion: 1,
    createdBy: userId, refreshToken: newToken(), ...over,
  });
  const connect = async (over: Partial<ConnInput> = {}) => {
    const a = input(over);
    const { connectionId } = await sql.begin((tx) => insertConnectionWithToken(tx, a));
    return { connectionId, input: a };
  };
  return { orgId: auth.orgId, userId, input, connect };
}

type ConnRow = {
  status: string; revoked_at: Date | null; status_since: Date; last_error_code: string | null; refresh_token_enc: Uint8Array | null;
};
const rowOf = async (id: string): Promise<ConnRow> =>
  (await sql<ConnRow[]>`select status, revoked_at, status_since, last_error_code, refresh_token_enc from org_youtube_connections where id = ${id}`)[0]!;

/** What a revoke leaves in place of the channel's name on the destination row (global-constraints / DP III.E.4). A literal
 *  typed here, not imported: the test must fail if the code's constant drifts. */
const DISCONNECTED_LABEL = "YouTube channel (disconnected)";

type ChannelRow = { channel_id: string | null; channel_title: string | null };
const channelOf = async (id: string): Promise<ChannelRow> =>
  (await sql<ChannelRow[]>`select channel_id, channel_title from org_youtube_connections where id = ${id}`)[0]!;

type TargetRow = { archived_at: Date | null; label: string; dest_fingerprint: string | null; youtube_connection_id: string | null };
const targetOf = async (id: string): Promise<TargetRow> =>
  (await sql<TargetRow[]>`select archived_at, label, dest_fingerprint, youtube_connection_id from org_stream_targets where id = ${id}`)[0]!;
/** The ACTIVE destination rows of an org for one channel fingerprint (the partial unique index's own population). */
const activeTargetsFor = async (orgId: string, fingerprint: string): Promise<string[]> =>
  (await sql<{ id: string }[]>`
    select id from org_stream_targets where org_id = ${orgId} and dest_fingerprint = ${fingerprint} and archived_at is null order by id`).map((r) => r.id);

/** The destination row a connect leaves behind (spec §5.2): kind youtube, the channel's title as its label, the channel's
 *  keyed fingerprint, and NO key of its own. T8 writes it for real; this is the same shape, written raw. */
async function targetFor(orgId: string, connectionId: string, channelId: string, label: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, youtube_connection_id, dest_fingerprint)
    values (${orgId}, 'youtube', ${label}, ${connectionId}, ${fingerprintYoutubeChannel(channelId)}) returning id`;
  return row!.id;
}

const NO_SUCH_ORG = () => randomUUID();

describe.skipIf(!HAS_DB)("token-store — the connection's refresh token, sealed under YOUTUBE_TOKEN_KEK", () => {
  it("a sealed token opens under YOUTUBE_TOKEN_KEK and NOT under RELAY_KEK; the raw column holds no plaintext", async () => {
    const r = await rig();
    const { connectionId, input } = await r.connect();
    const raw = (await rowOf(connectionId)).refresh_token_enc!;
    expect(raw).not.toBeNull();
    expect(openWith("YOUTUBE_TOKEN_KEK", raw)).toBe(input.refreshToken);
    expect(() => openWith("RELAY_KEK", raw), "the stream-key KEK must not open a YouTube token").toThrow();
    expect(Buffer.from(raw).includes(Buffer.from(input.refreshToken, "utf8")), "not stored in the clear").toBe(false);
    expect(await openToken(sql, r.orgId, connectionId)).toBe(input.refreshToken);
  });

  it("insertConnectionWithToken writes a CONNECTED row carrying exactly what it was given, whose token opens", async () => {
    const r = await rig();
    // every field differs from the column's default: public, not the default unlisted; kids true; a Google sub; consent v3
    const consentAt = new Date("2026-10-01T08:30:00.000Z");
    const { connectionId, input } = await r.connect({ defaultPrivacy: "public", madeForKids: true, googleSub: "sub-1234", consentVersion: 3, consentAt, channelTitle: "Club TV" });
    const [row] = await sql<{
      org_id: string; channel_id: string; channel_title: string; google_sub: string | null; granted_scope: string; default_privacy: string;
      made_for_kids: boolean; consent_by: string; consent_at: Date; consent_version: number; created_by: string; status: string;
      revoked_at: Date | null; last_error_code: string | null; last_health_at: Date | null;
    }[]>`select * from org_youtube_connections where id = ${connectionId}`;
    expect({
      org_id: row!.org_id, channel_id: row!.channel_id, channel_title: row!.channel_title, google_sub: row!.google_sub, granted_scope: row!.granted_scope,
      default_privacy: row!.default_privacy, made_for_kids: row!.made_for_kids, consent_by: row!.consent_by, consent_version: row!.consent_version,
      created_by: row!.created_by, status: row!.status, revoked_at: row!.revoked_at, last_error_code: row!.last_error_code, last_health_at: row!.last_health_at,
    }).toEqual({
      org_id: r.orgId, channel_id: input.channelId, channel_title: "Club TV", google_sub: "sub-1234", granted_scope: SCOPE,
      default_privacy: "public", made_for_kids: true, consent_by: r.userId, consent_version: 3,
      created_by: r.userId, status: "connected", revoked_at: null, last_error_code: null, last_health_at: null,
    });
    expect(row!.consent_at.toISOString()).toBe("2026-10-01T08:30:00.000Z");
    expect(await openToken(sql, r.orgId, connectionId)).toBe(input.refreshToken);
    // the other branch of the nullable argument: no Google sub stays NULL, not the string "null"
    const bare = await r.connect({ googleSub: null });
    const [g] = await sql<{ google_sub: string | null }[]>`select google_sub from org_youtube_connections where id = ${bare.connectionId}`;
    expect(g!.google_sub).toBeNull();
  });

  it("a channel is live in ONE org: the second connect meets 23505 org_youtube_connections_one_live_channel (T8 matches on the NAME); after a revoke the same channel connects again", async () => {
    const a = await rig();
    const b = await rig();
    const first = await a.connect();
    const err = await failureOf(sql.begin((tx) => insertConnectionWithToken(tx, b.input({ channelId: first.input.channelId }))));
    expect(err).toMatchObject({ code: "23505", constraint_name: "org_youtube_connections_one_live_channel" });
    expect(await revokeConnection(sql, a.orgId, first.connectionId)).toBe(true);
    const again = await b.connect({ channelId: first.input.channelId });
    expect(again.connectionId).not.toBe(first.connectionId);
    expect(await openToken(sql, b.orgId, again.connectionId)).toBe(again.input.refreshToken);
  });

  it("insertConnectionWithToken refuses an empty token by name and writes no row; a missing or malformed YOUTUBE_TOKEN_KEK writes no row and says so in the KEK's own sentence, which holds no token", async () => {
    const r = await rig();
    const channelId = `UC${randomUUID().replace(/-/g, "").slice(0, 22)}`;
    const rows = async () => (await sql<{ n: number }[]>`select count(*)::int as n from org_youtube_connections where channel_id = ${channelId}`)[0]!.n;
    expect((await failureOf(sql.begin((tx) => insertConnectionWithToken(tx, r.input({ channelId, refreshToken: "" }))))).message).toMatch(/empty/);
    let faults = 0;
    const token = newToken();
    for (const f of KEK_FAULTS) {
      const err = await withYtKek(f.value, () => failureOf(sql.begin((tx) => insertConnectionWithToken(tx, r.input({ channelId, refreshToken: token })))));
      expect(err.message, f.name).toMatch(f.says);
      expect(err.message, f.name).not.toContain(token);
      expect(err.message, f.name).not.toContain("RELAY_KEK");
      faults++;
    }
    expect(faults).toBe(KEK_FAULTS.length);
    expect(await rows(), "no refusal wrote a row").toBe(0);
    await sql.begin((tx) => insertConnectionWithToken(tx, r.input({ channelId, refreshToken: token })));
    expect(await rows(), "the accepted twin writes").toBe(1);
  });

  it("openToken returns null for another org's id, exactly as for a missing id and for a revoked row — and the owner still gets the token", async () => {
    const a = await rig();
    const b = await rig();
    const mine = await a.connect();
    const revoked = await a.connect();
    expect(await revokeConnection(sql, a.orgId, revoked.connectionId)).toBe(true);
    // the positive pair FIRST: the token is there, so each null below is a refusal and not an empty table
    expect(await openToken(sql, a.orgId, mine.connectionId)).toBe(mine.input.refreshToken);
    const cases: [string, Promise<string | null>][] = [
      ["another org's id", openToken(sql, b.orgId, mine.connectionId)],
      ["a missing id", openToken(sql, a.orgId, randomUUID())],
      ["a revoked row", openToken(sql, a.orgId, revoked.connectionId)],
      ["an unknown org with a real id", openToken(sql, NO_SUCH_ORG(), mine.connectionId)],
    ];
    let checked = 0;
    for (const [name, p] of cases) {
      expect(await p, name).toBeNull();
      checked++;
    }
    expect(checked).toBe(cases.length);
    // also through a transaction handle — the executor is either a Tx or the pooled client
    expect(await sql.begin((tx) => openToken(tx, a.orgId, mine.connectionId))).toBe(mine.input.refreshToken);
    expect(await sql.begin((tx) => openToken(tx, b.orgId, mine.connectionId))).toBeNull();
  });

  it("openToken opens a RECONNECT_NEEDED row's token (only a revoked row has none) — the status is not what hides it", async () => {
    const r = await rig();
    const c = await r.connect();
    await sql`update org_youtube_connections set status = 'reconnect_needed', last_error_code = 'invalid_grant' where id = ${c.connectionId}`;
    expect(await openToken(sql, r.orgId, c.connectionId)).toBe(c.input.refreshToken);
  });

  it("an unset or malformed YOUTUBE_TOKEN_KEK throws the KEK's own sentence — no token, no envelope bytes, not RELAY_KEK's — and a missing row is still null", async () => {
    const r = await rig();
    const c = await r.connect();
    const hex = Buffer.from((await rowOf(c.connectionId)).refresh_token_enc!).toString("hex");
    let checked = 0;
    for (const f of KEK_FAULTS) {
      const err = await withYtKek(f.value, () => failureOf(openToken(sql, r.orgId, c.connectionId)));
      expect(err.message, f.name).toMatch(f.says);
      expect(err.message, f.name).not.toContain(c.input.refreshToken);
      expect(err.message, f.name).not.toContain(hex);
      expect(err.message, f.name).not.toContain("RELAY_KEK");
      expect(err, f.name).not.toBeInstanceOf(YoutubeTokenUnreadableError);
      // nothing to open → nothing to fail: absence is not a KEK fault
      expect(await withYtKek(f.value, () => openToken(sql, r.orgId, randomUUID())), `${f.name}: missing row`).toBeNull();
      checked++;
    }
    expect(checked).toBe(KEK_FAULTS.length);
    expect(await openToken(sql, r.orgId, c.connectionId), "the KEK restored").toBe(c.input.refreshToken);
  });

  it("an envelope that will not open under a VALID key is YoutubeTokenUnreadableError{id} — damaged, sealed under RELAY_KEK, not even an envelope — naming no token; under a KEK fault the KEK's sentence wins", async () => {
    const r = await rig();
    const c = await r.connect();
    const good = (await rowOf(c.connectionId)).refresh_token_enc!;
    const flipped = Buffer.from(good);
    flipped[flipped.length - 1] ^= 0x01;
    const damages: [string, Buffer][] = [
      ["a flipped body byte", flipped],
      ["sealed under RELAY_KEK", seal(c.input.refreshToken)],
      ["bytes that are no envelope", Buffer.from("not-an-envelope")],
    ];
    let checked = 0;
    for (const [name, bytes] of damages) {
      await sql`update org_youtube_connections set refresh_token_enc = ${bytes} where id = ${c.connectionId}`;
      const err = await failureOf(openToken(sql, r.orgId, c.connectionId));
      expect(err, name).toBeInstanceOf(YoutubeTokenUnreadableError);
      expect(err, name).toMatchObject({ id: c.connectionId });
      expect(err.message, name).not.toContain(c.input.refreshToken);
      // a damaged row read under a missing KEK says the KEK is missing, never "envelope too short" (crypto.ts assertKek)
      const kek = await withYtKek(undefined, () => failureOf(openToken(sql, r.orgId, c.connectionId)));
      expect(kek, name).not.toBeInstanceOf(YoutubeTokenUnreadableError);
      expect(kek.message, name).toMatch(/YOUTUBE_TOKEN_KEK is not set/);
      checked++;
    }
    expect(checked).toBe(damages.length);
    await sql`update org_youtube_connections set refresh_token_enc = ${good} where id = ${c.connectionId}`;
    expect(await openToken(sql, r.orgId, c.connectionId), "restored, it opens again").toBe(c.input.refreshToken);
  });

  it("revokeConnection nulls the token and sets revoked + revoked_at in ONE statement (V479's checks never fire); a second call returns false and the first cause and time stand", async () => {
    const r = await rig();
    const c = await r.connect();
    // The premise the one-statement count rests on: V479's immediate checks DO refuse a half-revoke. Without them, "one
    // statement" would be a style choice rather than a requirement.
    await expect(sql`update org_youtube_connections set refresh_token_enc = null where id = ${c.connectionId}`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "org_youtube_connections_revoked_no_token" });
    await expect(sql`update org_youtube_connections set status = 'revoked' where id = ${c.connectionId}`)
      .rejects.toMatchObject({ code: "23514" });
    expect((await rowOf(c.connectionId)).status, "the refused halves wrote nothing").toBe("connected");

    const issued = await sql.begin(async (tx) => {
      const before = statementCount();
      const ok = await revokeConnection(tx, r.orgId, c.connectionId);
      return { ok, statements: statementCount() - before };
    });
    expect(issued).toEqual({ ok: true, statements: 1 });
    const after = await rowOf(c.connectionId);
    expect(after.status).toBe("revoked");
    expect(after.refresh_token_enc).toBeNull();
    expect(after.revoked_at).toBeInstanceOf(Date);
    expect(after.status_since.getTime(), "status_since moves with the status").toBe(after.revoked_at!.getTime());

    expect(await revokeConnection(sql, r.orgId, c.connectionId), "already revoked").toBe(false);
    const again = await rowOf(c.connectionId);
    expect(again.revoked_at!.getTime(), "the first revoke's time stands").toBe(after.revoked_at!.getTime());
    expect(again.refresh_token_enc).toBeNull();
  });

  it("revokeConnection is org-scoped (another org's, a missing id: false, row untouched) and revokes a RECONNECT_NEEDED row, keeping its error code", async () => {
    const a = await rig();
    const b = await rig();
    const c = await a.connect();
    expect(await revokeConnection(sql, b.orgId, c.connectionId), "another org").toBe(false);
    expect(await revokeConnection(sql, a.orgId, randomUUID()), "a missing id").toBe(false);
    expect((await rowOf(c.connectionId)).status, "the foreign attempt changed nothing").toBe("connected");
    expect(await openToken(sql, a.orgId, c.connectionId), "and the token still opens").toBe(c.input.refreshToken);
    expect(await channelOf(c.connectionId), "and the channel is still named").toEqual({ channel_id: c.input.channelId, channel_title: "Token FC" });
    await sql`update org_youtube_connections set status = 'reconnect_needed', last_error_code = 'invalid_grant' where id = ${c.connectionId}`;
    expect(await revokeConnection(sql, a.orgId, c.connectionId)).toBe(true);
    const row = await rowOf(c.connectionId);
    expect({ status: row.status, last_error_code: row.last_error_code, token: row.refresh_token_enc }).toEqual({ status: "revoked", last_error_code: "invalid_grant", token: null });
    expect(await channelOf(c.connectionId), "a reconnect_needed row's channel is scrubbed too").toEqual({ channel_id: null, channel_title: null });
  });

  it("revokeConnection ARCHIVES the destination row and scrubs the channel's id and title in the same statement: label becomes the fixed constant, the fingerprint (history) is kept", async () => {
    const r = await rig();
    const c = await r.connect({ channelTitle: "Forest Rovers TV" });
    const t = await targetFor(r.orgId, c.connectionId, c.input.channelId, "Forest Rovers TV");
    const fp = fingerprintYoutubeChannel(c.input.channelId);
    // a second row of the same connection, archived long ago under the channel's name: it must be scrubbed too, but its archive time stands
    const [old] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, youtube_connection_id, archived_at)
      values (${r.orgId}, 'youtube', 'Forest Rovers TV (old)', ${c.connectionId}, '2026-01-01T00:00:00.000Z') returning id`;
    // the positive pair FIRST: before the revoke the destination is live and names the channel, so every change below is the revoke's
    expect(await channelOf(c.connectionId)).toEqual({ channel_id: c.input.channelId, channel_title: "Forest Rovers TV" });
    expect(await targetOf(t)).toEqual({ archived_at: null, label: "Forest Rovers TV", dest_fingerprint: fp, youtube_connection_id: c.connectionId });

    expect(await revokeConnection(sql, r.orgId, c.connectionId)).toBe(true);

    expect(await channelOf(c.connectionId), "the channel's id and title do not outlive the revoke").toEqual({ channel_id: null, channel_title: null });
    const conn = await rowOf(c.connectionId);
    expect({ status: conn.status, token: conn.refresh_token_enc }).toEqual({ status: "revoked", token: null });
    const target = await targetOf(t);
    expect(target.archived_at, "the destination is archived").toBeInstanceOf(Date);
    expect(target.archived_at!.getTime(), "in the same statement as the revoke (one transaction timestamp)").toBe(conn.revoked_at!.getTime());
    expect(target.label).toBe(DISCONNECTED_LABEL);
    expect(target.dest_fingerprint, "the keyed fingerprint stays: it identifies no one and history keys on it").toBe(fp);
    expect(target.youtube_connection_id).toBe(c.connectionId);
    const earlier = await targetOf(old!.id);
    expect(earlier.archived_at!.toISOString(), "an already-archived row keeps its own archive time").toBe("2026-01-01T00:00:00.000Z");
    expect(earlier.label, "and is scrubbed as well").toBe(DISCONNECTED_LABEL);
    // the raw rows hold no trace of the name (the label was the only other copy of it on these two tables)
    const left = await sql<{ n: number }[]>`
      select (select count(*) from org_youtube_connections where id = ${c.connectionId} and (channel_title ilike '%Forest%' or channel_id = ${c.input.channelId}))::int
           + (select count(*) from org_stream_targets where org_id = ${r.orgId} and label ilike '%Forest%')::int as n`;
    expect(left[0]!.n).toBe(0);
  });

  it("SEQUENCE: connect channel X, revoke, connect X again in the same org — the second destination is inserted (no 23505) and is the only ACTIVE one; revoking the OLD id again leaves it alone", async () => {
    const r = await rig();
    const first = await r.connect({ channelTitle: "Forest Rovers TV" });
    const t1 = await targetFor(r.orgId, first.connectionId, first.input.channelId, "Forest Rovers TV");
    const fp = fingerprintYoutubeChannel(first.input.channelId);
    // the premise the archive exists for: while the first destination is live, a second one for the channel IS refused, by name
    await expect(targetFor(r.orgId, first.connectionId, first.input.channelId, "again")).rejects.toMatchObject({
      code: "23505", constraint_name: "org_stream_targets_org_dest_fingerprint",
    });
    expect(await activeTargetsFor(r.orgId, fp)).toEqual([t1]);

    expect(await revokeConnection(sql, r.orgId, first.connectionId)).toBe(true);
    const again = await r.connect({ channelId: first.input.channelId, channelTitle: "Forest Rovers TV" });
    const t2 = await targetFor(r.orgId, again.connectionId, first.input.channelId, "Forest Rovers TV");
    expect(t2).not.toBe(t1);
    expect(await activeTargetsFor(r.orgId, fp), "the new destination is the only active one for the channel").toEqual([t2]);
    expect((await targetOf(t1)).archived_at, "the old one stays archived").toBeInstanceOf(Date);

    // revoking the OLD connection a second time reaches neither the new connection nor its destination
    expect(await revokeConnection(sql, r.orgId, first.connectionId)).toBe(false);
    expect(await activeTargetsFor(r.orgId, fp)).toEqual([t2]);
    expect(await targetOf(t2)).toMatchObject({ archived_at: null, label: "Forest Rovers TV" });
    expect(await channelOf(again.connectionId)).toEqual({ channel_id: first.input.channelId, channel_title: "Forest Rovers TV" });
    expect(await openToken(sql, r.orgId, again.connectionId)).toBe(again.input.refreshToken);
  });

  it("a SECOND revoke returns false and writes nothing: the archived destination keeps its time and constant label, the connection its first revoke", async () => {
    const r = await rig();
    const c = await r.connect({ channelTitle: "Forest Rovers TV" });
    const t = await targetFor(r.orgId, c.connectionId, c.input.channelId, "Forest Rovers TV");
    expect(await revokeConnection(sql, r.orgId, c.connectionId)).toBe(true);
    // backdate: the second call's now() could not be told from the first's at millisecond resolution, so move both marks far from "now"
    await sql`update org_stream_targets set archived_at = '2026-02-02T02:02:02.000Z' where id = ${t}`;
    await sql`update org_youtube_connections set revoked_at = '2026-02-02T02:02:02.000Z', status_since = '2026-02-02T02:02:02.000Z' where id = ${c.connectionId}`;

    expect(await revokeConnection(sql, r.orgId, c.connectionId)).toBe(false);

    expect((await targetOf(t)).archived_at!.toISOString()).toBe("2026-02-02T02:02:02.000Z");
    expect((await targetOf(t)).label).toBe(DISCONNECTED_LABEL);
    expect((await rowOf(c.connectionId)).revoked_at!.toISOString()).toBe("2026-02-02T02:02:02.000Z");
    expect(await channelOf(c.connectionId)).toEqual({ channel_id: null, channel_title: null });
  });

  it("org A's revoke never touches org B's row for the same channel — and a wrong-org revoke of B's connection changes nothing", async () => {
    const a = await rig();
    const b = await rig();
    const ca = await a.connect({ channelTitle: "Forest Rovers TV" });
    const ta = await targetFor(a.orgId, ca.connectionId, ca.input.channelId, "Forest Rovers TV");
    expect(await revokeConnection(sql, a.orgId, ca.connectionId)).toBe(true);
    // org A let go of the channel, so org B may take it: the same channel id, the same fingerprint input, the same title
    const cb = await b.connect({ channelId: ca.input.channelId, channelTitle: "Forest Rovers TV" });
    const tb = await targetFor(b.orgId, cb.connectionId, ca.input.channelId, "Forest Rovers TV");
    const bBefore = { channel: await channelOf(cb.connectionId), target: await targetOf(tb) };
    expect(bBefore.channel).toEqual({ channel_id: ca.input.channelId, channel_title: "Forest Rovers TV" });
    expect(bBefore.target.archived_at).toBeNull();

    // A's second revoke, and A naming B's connection id: both are refused (false) and B's rows are byte-for-byte what they were
    expect(await revokeConnection(sql, a.orgId, ca.connectionId), "A's own, again").toBe(false);
    expect(await revokeConnection(sql, a.orgId, cb.connectionId), "A naming B's connection").toBe(false);
    expect({ channel: await channelOf(cb.connectionId), target: await targetOf(tb) }).toEqual(bBefore);
    expect((await rowOf(cb.connectionId)).status).toBe("connected");
    expect(await openToken(sql, b.orgId, cb.connectionId)).toBe(cb.input.refreshToken);
    // and A's archived row is still archived under the constant (the positive pair: the refusals above were not an empty table)
    expect(await targetOf(ta)).toMatchObject({ label: DISCONNECTED_LABEL });
    expect((await targetOf(ta)).archived_at).toBeInstanceOf(Date);
  });

  it("the archive leg is org-scoped on its own: a destination row of ANOTHER org that names this connection is not archived or relabelled (FKs do not tie a target's org to its connection's)", async () => {
    const a = await rig();
    const b = await rig();
    const ca = await a.connect({ channelTitle: "Forest Rovers TV" });
    const ta = await targetFor(a.orgId, ca.connectionId, ca.input.channelId, "Forest Rovers TV");
    // a mis-tenanted row: org B's destination pointing at org A's connection (nothing in the schema forbids it)
    const [stray] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, youtube_connection_id)
      values (${b.orgId}, 'youtube', 'B destination', ${ca.connectionId}) returning id`;
    expect(await revokeConnection(sql, a.orgId, ca.connectionId)).toBe(true);
    expect((await targetOf(ta)).archived_at, "A's own destination is archived").toBeInstanceOf(Date);
    expect(await targetOf(stray!.id), "B's row is untouched").toMatchObject({ archived_at: null, label: "B destination" });
  });

  it("replaceConnectionToken on a reconnect_needed row: the NEW token opens (the old does not), status connected, status_since moves, last_error_code cleared; a second replace wins again", async () => {
    const r = await rig();
    const c = await r.connect();
    await sql`update org_youtube_connections
                 set status = 'reconnect_needed', last_error_code = 'invalid_grant', status_since = now() - interval '2 days'
               where id = ${c.connectionId}`;
    const before = await rowOf(c.connectionId);
    const next = newToken();
    expect(await replaceConnectionToken(sql, r.orgId, c.connectionId, next)).toBe(true);
    const row = await rowOf(c.connectionId);
    expect(row.status).toBe("connected");
    expect(row.last_error_code).toBeNull();
    expect(row.revoked_at).toBeNull();
    expect(row.status_since.getTime(), "status_since is now, not two days ago").toBeGreaterThan(before.status_since.getTime() + 24 * 3600 * 1000);
    expect(await openToken(sql, r.orgId, c.connectionId)).toBe(next);
    expect(next).not.toBe(c.input.refreshToken);
    const third = newToken();
    expect(await replaceConnectionToken(sql, r.orgId, c.connectionId, third)).toBe(true);
    expect(await openToken(sql, r.orgId, c.connectionId), "the latest replace wins").toBe(third);
  });

  it("replaceConnectionToken on a REVOKED row returns false and writes nothing; another org's and a missing id are the same false; an empty token or a KEK fault writes nothing", async () => {
    const a = await rig();
    const b = await rig();
    const dead = await a.connect();
    expect(await revokeConnection(sql, a.orgId, dead.connectionId)).toBe(true);
    const frozen = await rowOf(dead.connectionId);
    expect(await replaceConnectionToken(sql, a.orgId, dead.connectionId, newToken()), "revoked").toBe(false);
    const after = await rowOf(dead.connectionId);
    expect({ status: after.status, token: after.refresh_token_enc, revoked_at: after.revoked_at?.getTime() })
      .toEqual({ status: "revoked", token: null, revoked_at: frozen.revoked_at!.getTime() });

    const live = await a.connect();
    expect(await replaceConnectionToken(sql, b.orgId, live.connectionId, newToken()), "another org").toBe(false);
    expect(await replaceConnectionToken(sql, a.orgId, randomUUID(), newToken()), "a missing id").toBe(false);
    expect(await openToken(sql, a.orgId, live.connectionId), "the foreign attempt left the token").toBe(live.input.refreshToken);

    expect((await failureOf(replaceConnectionToken(sql, a.orgId, live.connectionId, ""))).message).toMatch(/empty/);
    let faults = 0;
    for (const f of KEK_FAULTS) {
      const err = await withYtKek(f.value, () => failureOf(replaceConnectionToken(sql, a.orgId, live.connectionId, newToken())));
      expect(err.message, f.name).toMatch(f.says);
      faults++;
    }
    expect(faults).toBe(KEK_FAULTS.length);
    expect(await openToken(sql, a.orgId, live.connectionId), "no refusal replaced the token").toBe(live.input.refreshToken);
    // the accepted twin
    const ok = newToken();
    expect(await replaceConnectionToken(sql, a.orgId, live.connectionId, ok)).toBe(true);
    expect(await openToken(sql, a.orgId, live.connectionId)).toBe(ok);
  });
});

// The OAuth round-trip's intent row holds the sealed token between the callback and the channel pick (V479 §2).
describe.skipIf(!HAS_DB)("token-store — the pending grant's token: seal once, take once", () => {
  async function pending(orgId: string, userId: string, expiresInMinutes = 10): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into youtube_connect_pending (state_hash, org_id, user_id, default_privacy, made_for_kids, consent_version, consent_at, expires_at)
      values (${randomBytes(32).toString("hex")}, ${orgId}, ${userId}, 'unlisted', false, 1, now(), now() + ${`${expiresInMinutes} minutes`}::interval)
      returning id`;
    return row!.id;
  }
  const pendingRaw = async (id: string) =>
    (await sql<{ refresh_token_enc: Uint8Array | null }[]>`select refresh_token_enc from youtube_connect_pending where id = ${id}`)[0]!.refresh_token_enc;

  it("sealPendingToken seals under YOUTUBE_TOKEN_KEK (not RELAY_KEK, not in the clear); takePendingToken returns it ONCE — the column is null after, and a second take is null", async () => {
    const r = await rig();
    const id = await pending(r.orgId, r.userId);
    expect(await pendingRaw(id), "PREMISE: nothing sealed yet").toBeNull();
    const token = newToken();
    await sql.begin((tx) => sealPendingToken(tx, id, token));
    const raw = (await pendingRaw(id))!;
    expect(openWith("YOUTUBE_TOKEN_KEK", raw)).toBe(token);
    expect(() => openWith("RELAY_KEK", raw)).toThrow();
    expect(Buffer.from(raw).includes(Buffer.from(token, "utf8"))).toBe(false);
    expect(await sql.begin((tx) => takePendingToken(tx, r.orgId, id)), "first take").toBe(token);
    expect(await pendingRaw(id), "consumed: the sealed token no longer sits in the row").toBeNull();
    expect(await sql.begin((tx) => takePendingToken(tx, r.orgId, id)), "second take").toBeNull();
  });

  it("takePendingToken: another org's pending id, a missing id and a never-sealed row are null — and a refused take does NOT consume the token", async () => {
    const a = await rig();
    const b = await rig();
    const id = await pending(a.orgId, a.userId);
    const token = newToken();
    await sql.begin((tx) => sealPendingToken(tx, id, token));
    expect(await sql.begin((tx) => takePendingToken(tx, b.orgId, id)), "another org").toBeNull();
    expect(await sql.begin((tx) => takePendingToken(tx, a.orgId, randomUUID())), "a missing id").toBeNull();
    expect(await pendingRaw(id), "the foreign take left the token in place").not.toBeNull();
    const unsealed = await pending(a.orgId, a.userId);
    expect(await sql.begin((tx) => takePendingToken(tx, a.orgId, unsealed)), "never sealed").toBeNull();
    expect(await sql.begin((tx) => takePendingToken(tx, a.orgId, id)), "the owner still gets it").toBe(token);
  });

  it("two concurrent takes of one sealed grant: exactly one gets the token, the other null (a replayed callback cannot mint twice)", async () => {
    const r = await rig();
    const id = await pending(r.orgId, r.userId);
    const token = newToken();
    await sql.begin((tx) => sealPendingToken(tx, id, token));
    const [x, y] = await Promise.all([
      sql.begin((tx) => takePendingToken(tx, r.orgId, id)),
      sql.begin((tx) => takePendingToken(tx, r.orgId, id)),
    ]);
    expect([x, y].sort((p, q) => String(p).localeCompare(String(q)))).toEqual([token, null].sort((p, q) => String(p).localeCompare(String(q))));
    expect(await pendingRaw(id)).toBeNull();
  });

  it("a KEK fault on take throws the KEK's sentence and does NOT consume the token; sealPendingToken under a fault, with an empty token, or on a vanished row writes nothing and throws", async () => {
    const r = await rig();
    const id = await pending(r.orgId, r.userId);
    const token = newToken();
    await sql.begin((tx) => sealPendingToken(tx, id, token));
    let checked = 0;
    for (const f of KEK_FAULTS) {
      const err = await withYtKek(f.value, () => failureOf(sql.begin((tx) => takePendingToken(tx, r.orgId, id))));
      expect(err.message, f.name).toMatch(f.says);
      expect(err.message, f.name).not.toContain(token);
      // A caller that CATCHES the fault inside its transaction and commits must still find the token: the take opens the
      // token BEFORE it clears the column, so no rollback is needed to keep it (a rollback would hide the wrong order).
      const swallowed = await withYtKek(f.value, () =>
        sql.begin(async (tx) => {
          try { await takePendingToken(tx, r.orgId, id); return "returned"; } catch { return "threw"; }
        }),
      );
      expect(swallowed, `${f.name}: the take threw, and the transaction committed`).toBe("threw");
      checked++;
    }
    expect(checked).toBe(KEK_FAULTS.length);
    expect(await pendingRaw(id), "a failed take consumed nothing — not even in a transaction that committed").not.toBeNull();
    expect(await sql.begin((tx) => takePendingToken(tx, r.orgId, id)), "the KEK restored").toBe(token);

    const fresh = await pending(r.orgId, r.userId);
    for (const f of KEK_FAULTS) {
      const err = await withYtKek(f.value, () => failureOf(sql.begin((tx) => sealPendingToken(tx, fresh, token))));
      expect(err.message, f.name).toMatch(f.says);
    }
    expect((await failureOf(sql.begin((tx) => sealPendingToken(tx, fresh, "")))).message).toMatch(/empty/);
    expect(await pendingRaw(fresh), "no refusal sealed anything").toBeNull();
    // a vanished pending row is a loud failure, not a silent loss of the grant's token
    expect((await failureOf(sql.begin((tx) => sealPendingToken(tx, randomUUID(), token)))).message).toMatch(/not found/);
  });

  it("a pending token that will not open under a valid key is YoutubeTokenUnreadableError{id}, left in place (not consumed), naming no token", async () => {
    const r = await rig();
    const id = await pending(r.orgId, r.userId);
    await sql`update youtube_connect_pending set refresh_token_enc = ${seal("1//sealed-under-relay-kek")} where id = ${id}`;
    const err = await failureOf(sql.begin((tx) => takePendingToken(tx, r.orgId, id)));
    expect(err).toBeInstanceOf(YoutubeTokenUnreadableError);
    expect(err).toMatchObject({ id });
    expect(err.message).not.toContain("1//sealed");
    expect(await pendingRaw(id), "an unreadable grant is left for the expiry sweep").not.toBeNull();
  });
});
