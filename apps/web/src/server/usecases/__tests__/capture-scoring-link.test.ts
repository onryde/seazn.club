// Capture QR v2 §6.3.5 (W27, owner sign-off 2026-10-06) — the phone's Remote scoring link, `postScoringLink`, DB-backed
// through the REAL code (ensureStreamCode), the REAL claim (postBeat), the REAL console paths (ensureDeviceLink,
// createDeviceLink) and the REAL scoring door's resolver (resolveDeviceLinkToken).
//
// The owner's rule, verbatim: "must not remove or replace any existing QR … when phone requests a link/code for qr,
// just provide or create the new one". So every case below that writes asserts what it did NOT touch as well as what it
// wrote, and the sequence is tested, not one call: a second call, the console re-showing the phone's link, the
// console's Revoke & reissue (the ONLY path that changes a fixture's QR) and the phone's next call after it.
//
// Expected values come from the brief and the spec (§6.3.5): the URL pattern is the brief's text, the refusal words and
// statuses are the agreed table — never read back from capture-phone.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { CaptureRefusalError, captureRefusal } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureRefusal, CaptureScoringLinkOk } from "@/server/api-v1/capture-schemas";
import { sealWith } from "@/server/relay/crypto";
import { log } from "@/server/logger";
import { postBeat, postScoringLink } from "../capture-phone";
import {
  createDeviceLink, deviceLinkCoversFixture, ensureDeviceLink, hashDeviceLinkToken, mintDeviceLinkSecret,
  provideDeviceLinkForPhone, resolveDeviceLinkToken,
} from "../device-links";
import { reissueStreamCode, type ResolvedCode } from "../stream-codes";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { captureRig, override, phoneId, type CaptureRig } from "./_capture-rig";

const HAS_DB = !!process.env.DATABASE_URL;

/** The brief's pattern, verbatim — never the schema's constant. */
const URL_PATTERN = /^https:\/\/[^/]+\/score\/dl_[A-Za-z0-9_-]{43}$/;
const ORIGIN = "https://capture-scoring.test";

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS", "DEVICE_LINK_KEK"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
// A throwaway key of this file's own (device-links.test.ts's reasoning): CI's unit job has no DEVICE_LINK_KEK at all.
const DL_KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "capture-scoring-link-test-secret";
  process.env.DEVICE_LINK_KEK = DL_KEK;
  process.env.OAUTH_BASE_URL = ORIGIN;
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

async function claim(r: CaptureRig, phone: string, via: { code: string; tok: string } = r) {
  return postBeat(via.code, via.tok, CaptureBeat.parse({
    code: via.code, slot: 0, phone, claim: "new", device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1",
  }), r.deps, r.now());
}
const link = (r: CaptureRig, phone: string, via: { code: string; tok: string } = r) => postScoringLink(via.code, via.tok, { phone }, r.deps, r.now(), "203.0.113.7");

/** A rig whose phone A is current and whose plan has scoring links — the 200's premise. */
async function ready(opts: Parameters<typeof captureRig>[0] = {}) {
  const r = await captureRig(opts);
  await override(r.auth.orgId, "scoring.device_links", true);
  const A = phoneId("a");
  await claim(r, A);
  return { r, A };
}

type LinkRow = { id: string; token_hash: string; secret_enc: Uint8Array | null; label: string | null; issued_by: string; expires_at: Date | null; revoked_at: Date | null };
const linksOf = (fixtureId: string) => sql<LinkRow[]>`
  select id, token_hash, secret_enc, label, issued_by, expires_at, revoked_at from device_links where fixture_id = ${fixtureId} order by created_at, id`;
const issuerOf = async (r: CaptureRig) => (await sql<{ issued_by: string }[]>`
  select issued_by from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`)[0]!.issued_by;
const secretOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

let refusalsChecked = 0;
/** The refusal's RAW wire body, parsed by the contract's union: `{code, message}` exactly, never extras. */
async function refused(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "the call was refused with a capture refusal").toBeInstanceOf(CaptureRefusalError);
  const res = captureRefusal(err as CaptureRefusalError);
  const body = (await res.json()) as Record<string, unknown>;
  expect(CaptureRefusal.parse(body)).toEqual(body);
  expect(Object.keys(body).sort()).toEqual(["code", "message"]);
  refusalsChecked++;
  return { status: res.status, body };
}

describe.skipIf(!HAS_DB)("postScoringLink — the phone's Remote scoring link (§6.3.5, W27)", () => {
  it("200: the CURRENT phone gets the bare {url} on the agreed pattern, at the server's origin; ONE new sealed row — issued_by the code's issuer, no label, no expiry — and its secret resolves to THIS fixture and no other", async () => {
    const { r, A } = await ready();
    expect(await linksOf(r.fixtureId), "premise: the fixture had no link").toEqual([]);
    const ok = await link(r, A);
    expect(Object.keys(ok)).toEqual(["url"]);
    expect(CaptureScoringLinkOk.parse(ok)).toEqual(ok);
    expect(ok.url).toMatch(URL_PATTERN);
    expect(ok.url.startsWith(`${ORIGIN}/score/`), "the origin is OAUTH_BASE_URL's").toBe(true);
    const rows = await linksOf(r.fixtureId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: null, expires_at: null, revoked_at: null, issued_by: await issuerOf(r) });
    expect(rows[0]!.secret_enc, "sealed: re-showable by the console").not.toBeNull();
    expect(rows[0]!.token_hash).toBe(hashDeviceLinkToken(secretOf(ok.url)));
    const resolved = await resolveDeviceLinkToken(secretOf(ok.url));
    expect(resolved.fixture_id).toBe(r.fixtureId);
    expect(deviceLinkCoversFixture(resolved, r.fixtureId)).toBe(true);
    expect(deviceLinkCoversFixture(resolved, randomUUID()), "the positive pair's negative: another fixture").toBe(false);
  });

  it("a second and a third call return the SAME url and insert nothing", async () => {
    const { r, A } = await ready();
    const first = await link(r, A);
    const second = await link(r, A);
    const third = await link(r, A);
    expect(second.url).toBe(first.url);
    expect(third.url).toBe(first.url);
    expect(await linksOf(r.fixtureId)).toHaveLength(1);
  });

  it("a printed sealed link (the console's ensure) is RETURNED, never replaced: the same secret, still resolving, no new row — and the console's next ensure re-shows the same one", async () => {
    const { r, A } = await ready();
    const printed = await ensureDeviceLink(r.auth, r.fixtureId);
    expect(printed.minted).toBe(true);
    const ok = await link(r, A);
    expect(secretOf(ok.url)).toBe(printed.secret);
    expect(await linksOf(r.fixtureId)).toHaveLength(1);
    await expect(resolveDeviceLinkToken(printed.secret)).resolves.toMatchObject({ fixture_id: r.fixtureId });
    const again = await ensureDeviceLink(r.auth, r.fixtureId);
    expect({ secret: again.secret, minted: again.minted }).toEqual({ secret: printed.secret, minted: false });
  });

  it("sequence: phone link → console re-shows it → console Revoke & reissue (the ONLY path that changes the QR) → the phone's next call returns the console's NEW link, inserting nothing; the old phone URL is dead", async () => {
    const { r, A } = await ready();
    const phoneFirst = await link(r, A);
    const shown = await ensureDeviceLink(r.auth, r.fixtureId);
    expect({ secret: shown.secret, minted: shown.minted }, "the console re-shows the phone's link").toEqual({ secret: secretOf(phoneFirst.url), minted: false });
    const reissued = await createDeviceLink(r.auth, r.fixtureId, null);
    const after = await link(r, A);
    expect(secretOf(after.url)).toBe(reissued.secret);
    expect(await linksOf(r.fixtureId)).toHaveLength(2);
    await expect(resolveDeviceLinkToken(secretOf(phoneFirst.url))).rejects.toMatchObject({ code: "LINK_REVOKED" });
  });

  it("NEVER revokes, and reads ONLY the newest live link (as the console's ensure does): when it is a legacy hash-only link, one whose envelope hashes elsewhere, or one that will not open, ONE new sealed link is inserted and answered; the passed-over row stays exactly as it was and still resolves; the console's next ensure RE-SHOWS the phone's link (minted: false) instead of revoking; a bad envelope is logged by link id, never by secret", async () => {
    let checked = 0;
    for (const kind of ["legacy", "swapped", "tampered"] as const) {
      const { r, A } = await ready();
      const issuer = await issuerOf(r);
      const badSecret = mintDeviceLinkSecret();
      const enc = kind === "legacy" ? null
        // Opens under the KEK, but is ANOTHER secret's envelope (device-links.ts final review M2's case).
        : kind === "swapped" ? sealWith("DEVICE_LINK_KEK", mintDeviceLinkSecret())
        // Will not open at all: random bytes where an envelope belongs.
        : randomBytes(64);
      const bad = (await sql<{ id: string }[]>`
        insert into device_links (org_id, fixture_id, token_hash, secret_enc, label, issued_by, expires_at)
        values (${r.auth.orgId}, ${r.fixtureId}, ${hashDeviceLinkToken(badSecret)}, ${enc}, null, ${issuer}, null) returning id`)[0]!.id;
      const before = await linksOf(r.fixtureId);
      expect(before.map((x) => x.revoked_at), `${kind}: premise, one live link`).toEqual([null]);

      const warn = vi.spyOn(log, "warn");
      let ok: { url: string };
      let warned: unknown[][];
      try {
        ok = await link(r, A);
      } finally {
        warned = [...warn.mock.calls];   // read BEFORE mockRestore, which clears them
        warn.mockRestore();
      }
      const after = await linksOf(r.fixtureId);
      expect(after, kind).toHaveLength(2);
      expect(after.find((x) => x.id === bad), `${kind}: the passed-over link is exactly as it was`).toEqual(before[0]);
      await expect(resolveDeviceLinkToken(badSecret), kind).resolves.toMatchObject({ fixture_id: r.fixtureId });
      const fresh = after.find((x) => x.id !== bad)!;
      expect(fresh.token_hash, kind).toBe(hashDeviceLinkToken(secretOf(ok!.url)));
      expect(fresh.secret_enc, `${kind}: the new link is sealed`).not.toBeNull();
      // The console re-shows the phone's link — the newest — rather than revoking anything.
      const shown = await ensureDeviceLink(r.auth, r.fixtureId);
      expect({ secret: shown.secret, minted: shown.minted }, `${kind}: the console agrees`).toEqual({ secret: secretOf(ok!.url), minted: false });
      expect((await linksOf(r.fixtureId)).map((x) => x.revoked_at), `${kind}: nothing revoked`).toEqual([null, null]);
      // A bad envelope is logged by its link id (a legacy row has none to log) — and no logged argument carries a secret.
      const passedOver = warned.map((c) => (c[0] as { linkId?: string }).linkId).filter(Boolean);
      expect(passedOver, kind).toEqual(kind === "legacy" ? [] : [bad]);
      const logged = JSON.stringify(warned);
      for (const s of [badSecret, secretOf(ok!.url)]) expect(logged, kind).not.toContain(s);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("a NEWER bad link over an OLDER good one: the phone does NOT dig the older one out — a NEW link is inserted and answered, the older good link is NOT revoked (it still resolves), and the console's ensure re-shows the phone's link (minted: false); even when the bad row's created_at is AHEAD of the clock, the new row is stamped past it", async () => {
    const { r, A } = await ready();
    const good = await ensureDeviceLink(r.auth, r.fixtureId);
    const issuer = await issuerOf(r);
    // A newer row whose envelope is another secret's, stamped a minute ahead (a clock stepped back since it was written).
    await sql`
      insert into device_links (org_id, fixture_id, token_hash, secret_enc, label, issued_by, expires_at, created_at)
      values (${r.auth.orgId}, ${r.fixtureId}, ${hashDeviceLinkToken(mintDeviceLinkSecret())}, ${sealWith("DEVICE_LINK_KEK", mintDeviceLinkSecret())},
              null, ${issuer}, null, now() + interval '1 minute')`;
    const ok = await link(r, A);
    expect(secretOf(ok.url)).not.toBe(good.secret);
    expect(await linksOf(r.fixtureId)).toHaveLength(3);
    const shown = await ensureDeviceLink(r.auth, r.fixtureId);
    expect({ secret: shown.secret, minted: shown.minted }, "the console re-shows the phone's link").toEqual({ secret: secretOf(ok.url), minted: false });
    const rows = await linksOf(r.fixtureId);
    expect(rows.map((x) => x.revoked_at), "nothing revoked: the older good link, the bad one, the phone's").toEqual([null, null, null]);
    await expect(resolveDeviceLinkToken(good.secret), "the older good link still scores").resolves.toMatchObject({ fixture_id: r.fixtureId });
    expect((await link(r, A)).url, "a second call: the same link").toBe(ok.url);
    expect(await linksOf(r.fixtureId)).toHaveLength(3);
  });

  it("two GOOD live sealed links (written behind the app's back): the phone returns the NEWEST — the one the console's ensure re-shows — so the two never disagree; nothing inserted", async () => {
    const { r, A } = await ready();
    const issuer = await issuerOf(r);
    const [older, newer] = [mintDeviceLinkSecret(), mintDeviceLinkSecret()];
    for (const [secret, at] of [[older, "1 minute"], [newer, "2 minutes"]] as const) {
      await sql`
        insert into device_links (org_id, fixture_id, token_hash, secret_enc, label, issued_by, expires_at, created_at)
        values (${r.auth.orgId}, ${r.fixtureId}, ${hashDeviceLinkToken(secret)}, ${sealWith("DEVICE_LINK_KEK", secret)},
                null, ${issuer}, null, now() + ${at}::interval)`;
    }
    const ok = await link(r, A);
    expect(secretOf(ok.url)).toBe(newer);
    const shown = await ensureDeviceLink(r.auth, r.fixtureId);
    expect({ secret: shown.secret, minted: shown.minted }, "the console agrees").toEqual({ secret: newer, minted: false });
    expect(await linksOf(r.fixtureId)).toHaveLength(2);
  });

  it("an EXPIRED or REVOKED sealed link is not returned: a new one is inserted, and the old rows are left exactly as they were", async () => {
    const { r, A } = await ready();
    const expired = await ensureDeviceLink(r.auth, r.fixtureId);
    await sql`update device_links set expires_at = now() - interval '1 minute' where token_hash = ${hashDeviceLinkToken(expired.secret)}`;
    const ok1 = await link(r, A);
    expect(secretOf(ok1.url)).not.toBe(expired.secret);
    const revokedAt = (await sql<{ revoked_at: Date }[]>`
      update device_links set revoked_at = now() where token_hash = ${hashDeviceLinkToken(secretOf(ok1.url))} returning revoked_at`)[0]!.revoked_at;
    const ok2 = await link(r, A);
    expect([expired.secret, secretOf(ok1.url)]).not.toContain(secretOf(ok2.url));
    const rows = await linksOf(r.fixtureId);
    expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.token_hash === hashDeviceLinkToken(secretOf(ok1.url)))!.revoked_at).toEqual(revokedAt);
  });

  it("allowed WITH a session: the open session's phone gets its link (and the session is untouched)", async () => {
    const { r, A } = await ready();
    const sid = await r.start(A);
    const ok = await link(r, A);
    expect(ok.url).toMatch(URL_PATTERN);
    const [s] = await sql<{ id: string }[]>`select id from fixture_stream_sessions where fixture_id = ${r.fixtureId}`;
    expect(s!.id).toBe(sid);
  });

  it("not the current phone → 409 replaced (a never-paired phone and a replaced one alike); nothing written", async () => {
    const { r, A } = await ready();
    const stranger = await refused(link(r, phoneId("x")));
    expect({ status: stranger.status, code: stranger.body.code }).toEqual({ status: 409, code: "replaced" });
    const B = phoneId("b");
    await claim(r, B);   // B takes the idle slot: A is replaced
    const replaced = await refused(link(r, A));
    expect({ status: replaced.status, code: replaced.body.code }).toEqual({ status: 409, code: "replaced" });
    expect(await linksOf(r.fixtureId)).toEqual([]);
    // The positive pair: the current phone (B) is served.
    expect((await link(r, B)).url).toMatch(URL_PATTERN);
  });

  it("an ENDED (reissued) code → 401 code_ended, even for its current phone; nothing written — the new code's current phone is served", async () => {
    const { r, A } = await ready();
    const shown = await reissueStreamCode(r.auth, r.fixtureId);
    const ended = await refused(link(r, A));
    expect({ status: ended.status, code: ended.body.code }).toEqual({ status: 401, code: "code_ended" });
    expect(await linksOf(r.fixtureId)).toEqual([]);
    const via = { code: shown.qr.code, tok: shown.qr.tok };
    await claim(r, A, via);
    expect((await link(r, A, via)).url).toMatch(URL_PATTERN);
  });

  it("the code's issuer DELETED (device_links.issued_by's foreign key, review M4) → 401 code_ended, the ONE 401 body, so the phone asks for a new QR rather than retrying a 503; ONE warn carrying the code id and nothing else, no error log; nothing written — the issuer back, the same code is served", async () => {
    const { r, A } = await ready();
    const [{ id: codeId, issued_by: issuer }] = await sql<{ id: string; issued_by: string }[]>`
      select id, issued_by from fixture_stream_codes where fixture_id = ${r.fixtureId} and ended_at is null`;
    // fixture_stream_codes.issued_by has no foreign key, so the code outlives its issuer; the link insert's does.
    const gone = await rigUser();
    await sql`update fixture_stream_codes set issued_by = ${gone} where id = ${codeId}`;
    await sql`delete from users where id = ${gone}`;
    const warn = vi.spyOn(log, "warn");
    const error = vi.spyOn(log, "error");
    let got: Awaited<ReturnType<typeof refused>>;
    let warned: unknown[][], errored: unknown[][];
    try {
      got = await refused(link(r, A));
    } finally {
      warned = [...warn.mock.calls];
      errored = [...error.mock.calls];
      warn.mockRestore();
      error.mockRestore();
    }
    expect({ status: got!.status, code: got!.body.code }).toEqual({ status: 401, code: "code_ended" });
    const wrongTok = await refused(link(r, A, { code: r.code, tok: "wrong-tok" }));
    expect(got!.body, "C1: the ONE 401 sentence, never which kind").toEqual(wrongTok.body);
    expect(warned.map((c) => c[0]), "one warn, carrying the code id only").toEqual([{ codeId }]);
    expect(errored, "not an error: nothing for Sentry").toEqual([]);
    expect(await linksOf(r.fixtureId)).toEqual([]);
    // The positive pair: the code's issuer back, the same code and phone are served.
    await sql`update fixture_stream_codes set issued_by = ${issuer} where id = ${codeId}`;
    expect((await link(r, A)).url).toMatch(URL_PATTERN);
  });

  it("a wrong tok → 401 code_ended; nothing written", async () => {
    const { r, A } = await ready();
    const bad = await refused(link(r, A, { code: r.code, tok: "wrong-tok" }));
    expect({ status: bad.status, code: bad.body.code }).toEqual({ status: 401, code: "code_ended" });
    expect(await linksOf(r.fixtureId)).toEqual([]);
  });

  it("a FINALIZED and a CANCELLED match → 409 match_finished; nothing written, an existing link untouched — a DECIDED one (still voidable) is served (the positive pair)", async () => {
    let checked = 0;
    for (const status of ["finalized", "cancelled"] as const) {
      const { r, A } = await ready();
      await sql`update fixtures set status = ${status} where id = ${r.fixtureId}`;
      const got = await refused(link(r, A));
      expect({ status: got.status, code: got.body.code }, status).toEqual({ status: 409, code: "match_finished" });
      expect(await linksOf(r.fixtureId), status).toEqual([]);
      checked++;
    }
    expect(checked).toBe(2);
    const { r, A } = await ready();
    const printed = await ensureDeviceLink(r.auth, r.fixtureId);
    await sql`update fixtures set status = 'finalized' where id = ${r.fixtureId}`;
    const before = await linksOf(r.fixtureId);
    expect((await refused(link(r, A))).body.code).toBe("match_finished");
    expect(await linksOf(r.fixtureId)).toEqual(before);
    await expect(resolveDeviceLinkToken(printed.secret), "a finished match's link is not revoked by the phone").resolves.toBeDefined();
    const decided = await ready();
    await sql`update fixtures set status = 'decided' where id = ${decided.r.fixtureId}`;
    expect((await link(decided.r, decided.A)).url).toMatch(URL_PATTERN);
  });

  it("the plan gate: no scoring.device_links → 402 not_entitled, nothing written; an Event Pass on THIS fixture's competition lifts it (resolved against the competition, like the console)", async () => {
    const { r, A } = await ready();
    await sql`delete from org_entitlement_overrides where org_id = ${r.auth.orgId} and feature_key = 'scoring.device_links'`;
    await invalidateOrgEntitlements(r.auth.orgId);
    const got = await refused(link(r, A));
    expect({ status: got.status, code: got.body.code }).toEqual({ status: 402, code: "not_entitled" });
    expect(await linksOf(r.fixtureId)).toEqual([]);
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${r.fixtureId}`;
    await sql`insert into competition_passes (competition_id, org_id) values (${competition_id}, ${r.auth.orgId})`;
    await invalidateOrgEntitlements(r.auth.orgId);
    expect((await link(r, A)).url).toMatch(URL_PATTERN);
  });

  it("no DEVICE_LINK_KEK → 503 unavailable, with no link (nothing written) and with a sealed link to re-open (left untouched); a malformed key is the same", async () => {
    let checked = 0;
    for (const kek of [undefined, "abcd"]) {
      const empty = await ready();
      const printed = await ready();
      const shown = await ensureDeviceLink(printed.r.auth, printed.r.fixtureId);
      const before = await linksOf(printed.r.fixtureId);
      if (kek === undefined) delete process.env.DEVICE_LINK_KEK; else process.env.DEVICE_LINK_KEK = kek;
      const warn = vi.spyOn(log, "warn");
      let warned: unknown[][];
      try {
        for (const { r, A } of [empty, printed]) {
          const got = await refused(link(r, A));
          expect({ status: got.status, code: got.body.code }).toEqual({ status: 503, code: "unavailable" });
          checked++;
        }
      } finally {
        warned = [...warn.mock.calls];
        warn.mockRestore();
      }
      // A configuration gap is not a tampered link: the sealed link is never "passed over" for a missing key.
      expect(JSON.stringify(warned), "no link was passed over").not.toContain("passed over");
      expect(await linksOf(empty.r.fixtureId)).toEqual([]);
      expect(await linksOf(printed.r.fixtureId)).toEqual(before);
      process.env.DEVICE_LINK_KEK = DL_KEK;
      expect(secretOf((await link(printed.r, printed.A)).url), "the positive pair: the key back, the same link").toBe(shown.secret);
    }
    expect(checked).toBe(4);
  });

  it("an origin that is not https (no OAUTH_BASE_URL or NEXT_PUBLIC_BASE_URL, an http app url) → 503 unavailable BEFORE any write; NEXT_PUBLIC_BASE_URL alone is used when set", async () => {
    const { r, A } = await ready();
    delete process.env.OAUTH_BASE_URL;
    expect(r.deps.appUrl.startsWith("http://"), "premise: the rig's app url is http").toBe(true);
    const got = await refused(link(r, A));
    expect({ status: got.status, code: got.body.code }).toEqual({ status: 503, code: "unavailable" });
    // review N1: the message says what is wrong — scoring links need https — never "streaming is unavailable", and it
    // keeps the `origin_not_https` token the capture-v2 smoke keys on (so a crash's generic 503 cannot pass there).
    expect(got.body.message).toMatch(/scoring links need https/);
    expect(got.body.message).toContain("origin_not_https");
    expect(got.body.message).not.toMatch(/streaming/);
    expect(await linksOf(r.fixtureId)).toEqual([]);
    process.env.NEXT_PUBLIC_BASE_URL = "https://public-base.test/";
    expect((await link(r, A)).url.startsWith("https://public-base.test/score/dl_")).toBe(true);
  });

  it("concurrent calls on one fixture agree on ONE link — the fixture's link lock, parked deterministically at the insert's FK check", async () => {
    const { r, A } = await ready();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let holderPid = 0;
    const holder = sql.begin(async (tx) => {
      await tx`select id from fixtures where id = ${r.fixtureId} for update`;
      const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      holderPid = pid;   // set only once the row is locked
      await gate;
    });
    while (holderPid === 0) await new Promise((res) => setTimeout(res, 10));
    const calls = [link(r, A), link(r, A)];
    // Both callers parked: one at its insert behind the holder, the other behind it (the lock) or the holder (no lock).
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [{ parked }] = await sql<{ parked: number }[]>`
        with recursive behind(pid) as (
          select pid from pg_stat_activity where ${holderPid}::int = any(pg_blocking_pids(pid))
          union
          select a.pid from pg_stat_activity a join behind b on b.pid = any(pg_blocking_pids(a.pid))
        ) select count(*)::int as parked from behind`;
      if (parked >= 2) break;
      if (Date.now() > deadline) throw new Error(`only ${parked} caller(s) parked behind the fixture row`);
      await new Promise((res) => setTimeout(res, 25));
    }
    release();
    await holder;
    const [one, two] = await Promise.all(calls);
    expect(two.url).toBe(one.url);
    expect(await linksOf(r.fixtureId)).toHaveLength(1);
  });

  it("another sport (cricket): the scoring link reads no sport — the same 200 and row", async () => {
    const { r, A } = await ready({ sport: "cricket" });
    const ok = await link(r, A);
    expect(ok.url).toMatch(URL_PATTERN);
    expect(await linksOf(r.fixtureId)).toHaveLength(1);
  });

  it("review M5: the provider takes ONLY a holder-checked code — a bare ResolvedCode and three loose strings do not compile (tsc checks this file; each directive below fails tsc if its call ever compiles)", () => {
    const unchecked = (resolved: ResolvedCode): void => {
      // @ts-expect-error — a resolved code that has NOT passed the holder check
      void provideDeviceLinkForPhone(resolved);
      // @ts-expect-error — the pre-M5 shape: three loose strings
      void provideDeviceLinkForPhone(resolved.orgId, resolved.fixtureId, resolved.issuedBy);
    };
    expect(unchecked).toBeTypeOf("function");
  });

  it("anti-vacuity: this file asserted raw refusal bodies", () => {
    // replaced ×2, code_ended ×2 + 2 (the deleted issuer and its wrong-tok twin), match_finished ×3, not_entitled ×1,
    // unavailable ×4 + 1.
    expect(refusalsChecked).toBe(15);
  });
});
