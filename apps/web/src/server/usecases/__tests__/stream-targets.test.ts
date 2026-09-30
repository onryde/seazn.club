// Destinations (design §6.1 org_stream_targets). The list NEVER carries the
// key; readTargetSecret (server/relay/secret-columns.ts) returns it decrypted,
// for its own org only (lane C ruling A4: three arguments), for the one request
// that hands it to the ingest port. The stored envelope is not the plaintext
// and does not contain it (smoke repeats this over HTTP). That byte read goes
// through _session-rig.ts's `targetEnvelope`: this file may not name the sealed
// column (ruling A9 — enc-boundary.test.ts keeps NO `__tests__` exemption).
//
// Sport-agnostic on purpose (TEST-STRATEGY rule 6): a destination is an ORG row
// with no sport, division or fixture; seedOrg's `generic` sport is never read
// here, so a registry sweep would run identical tests. The "another sport"
// question becomes "another destination KIND", swept below over STREAM_PLATFORMS (the kinds a NEW destination may
// name, D6) and, for listing, over every stored StreamTargetKind.
//
// D6 (owner 2026-09-30, spec §5.4): create takes NO url — the server fills it from the platform's preset. The A18
// rtmpUrl refusals this file used to drive through createStreamTarget are unreachable through create now; each URL is
// pinned per rule by lib/__tests__/stream-destinations.test.ts (the refusal table, plus the cases moved there in T2a).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The route test drives the REAL handler over the REAL session door: only
// `requireUser` (who is signed in) is faked; `requireOrgAuth`'s own role lookup
// runs against a real `org_members` row (event-import-route.test.ts harness).
const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import {
  DESTINATION_LABEL_EMPTY, STREAM_KEY_EMPTY, STREAM_PLATFORMS, STREAM_PLATFORM_PRESETS, TARGET_UNREADABLE, checkDestination,
} from "@/lib/stream-destinations";
import { CreateStreamTarget, PatchStreamTarget, StreamTarget, StreamTargetKind } from "@/server/api-v1/schemas";
import { ACTIVE_STATES, TERMINAL_STATES, holdStateOf } from "@/server/relay/domain/session";
import { archiveStreamTarget, lockStreamTarget, readTargetSecret } from "@/server/relay/secret-columns";
import { holdRig, rigTarget, sessionOnTarget, targetEnvelope } from "@/server/relay/__tests__/_session-rig";
import { GET, POST } from "@/app/api/v1/orgs/[id]/stream-targets/route";
import { createApiKey } from "../api-keys";
import { seedOrg } from "./_rig";
import { makeUser, seedOrg as seedSignedInOrg } from "./_seed";
import { createStreamTarget, listStreamTargets, patchStreamTarget, removeStreamTarget } from "../stream-targets";

const HAS_DB = !!process.env.DATABASE_URL;

// A KEK of this file's own (secret-columns.test.ts precedent): the developer's is put back afterwards, or removed
// when there was none — never assigned `undefined`, which Node stores as the string "undefined". Never printed.
const savedKek = process.env.RELAY_KEK;
beforeAll(() => { process.env.RELAY_KEK = randomBytes(32).toString("hex"); });
afterAll(async () => {
  if (savedKek === undefined) delete process.env.RELAY_KEK;
  else process.env.RELAY_KEK = savedKek;
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** A stream key nobody else holds, so a substring scan cannot match by accident. */
const key = (): string => "sk-" + randomBytes(24).toString("hex");

/** crypto.ts's envelope header (1 + IV + wrapped DEK + tag + IV + tag = 89 bytes): anything not longer than it
 *  carries no ciphertext at all, and an empty envelope "holds no plaintext" vacuously. */
const ENVELOPE_HEADER = 89;

describe.skipIf(!HAS_DB)("stream targets — the usecase", () => {
  it("create → list shows kind/label/watchUrl and never the key; the secret reads back decrypted for its org; the stored envelope holds neither the key nor the url", async () => {
    const { auth } = await seedOrg();
    const streamKey = key();
    const rtmpUrl = STREAM_PLATFORM_PRESETS.youtube;   // D6: the server fills the url; the organiser never types one
    const made = await createStreamTarget(auth, auth.orgId, {
      kind: "youtube", label: "Club channel", streamKey,
      watchUrl: "https://www.youtube.com/watch?v=abc123",
    });
    expect(made).toMatchObject({ kind: "youtube", label: "Club channel", watchUrl: "https://www.youtube.com/watch?v=abc123" });
    // Exactly the wire shape (the schema's own keys) — there is no field a key could ride in, not merely an absent value.
    expect(Object.keys(made).sort()).toEqual(Object.keys(StreamTarget.shape).sort());
    expect(StreamTarget.parse(made)).toEqual(made);
    expect(JSON.stringify(made)).not.toContain(streamKey);
    const list = await listStreamTargets(auth, auth.orgId);
    expect(list.map((t) => t.id)).toEqual([made.id]);
    expect(JSON.stringify(list)).not.toContain(streamKey);
    // At rest FIRST — before any decrypting read, so a plaintext write reds HERE and not on the read's own throw.
    const envelope = await targetEnvelope(made.id);
    expect(envelope.length).toBeGreaterThan(ENVELOPE_HEADER);
    expect(envelope.includes(Buffer.from(streamKey, "utf8")), "the envelope holds the stream key").toBe(false);
    expect(envelope.includes(Buffer.from(rtmpUrl, "utf8")), "the envelope holds the ingest url").toBe(false);
    // The negative's positive pair: the key IS stored — the one reader hands it back.
    const secret = await sql.begin((tx) => readTargetSecret(tx, auth.orgId, made.id));
    expect(secret).toEqual({ url: rtmpUrl, streamKey });
    // createdAt is the row's own timestamp, not the clock of the caller.
    const [row] = await sql<{ created_at: Date }[]>`select created_at from org_stream_targets where id = ${made.id}`;
    expect(made.createdAt).toBe(row!.created_at.toISOString());
  });

  it("a watchUrl off the R16 allowlist is refused (422) and writes nothing; omitted and blank both store null — the VALIDATED value, never the raw one", async () => {
    const { auth } = await seedOrg();
    const base = { kind: "youtube" as const, label: "x", streamKey: "k" };
    await expect(createStreamTarget(auth, auth.orgId, { ...base, watchUrl: "https://evil.example/watch" }))
      .rejects.toMatchObject({ status: 422 });
    // A lookalike that CONTAINS an allowed host is not one (exact-host rule, lib/stream-url.ts).
    await expect(createStreamTarget(auth, auth.orgId, { ...base, watchUrl: "https://www.youtube.com.evil.example/watch" }))
      .rejects.toMatchObject({ status: 422 });
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    // Two DIFFERENT stream keys: since A19 (V421) one url + key is ONE destination and a repeat returns the
    // first row, so the two rows this test compares must be two destinations.
    const omitted = await createStreamTarget(auth, auth.orgId, { ...base, label: "omitted", streamKey: "k-omitted" });
    expect(omitted.watchUrl).toBeNull();
    // "" is what the allowlist NORMALISES to null. Storing the raw "" instead would break V410's
    // `watch_url like 'https://%'` — so this case differs between the validated and the raw value.
    const blank = await createStreamTarget(auth, auth.orgId, { ...base, label: "blank", watchUrl: "", streamKey: "k-blank" });
    expect(blank.watchUrl).toBeNull();
    const stored = await sql<{ id: string; watch_url: string | null }[]>`
      select id, watch_url from org_stream_targets where org_id = ${auth.orgId} order by created_at`;
    expect(stored).toEqual([{ id: omitted.id, watch_url: null }, { id: blank.id, watch_url: null }]);
  });

  it("D6 guard: a platform PRESET the allowlist stopped admitting is refused 422 DESTINATION_NOT_ALLOWED with its rule — by rule, never silently, before anything is written; the real preset then lands", async () => {
    // The guard createStreamTarget keeps over its own preset (spec §5.4 "checkDestination still runs as a guard"). No
    // shipped preset reaches it (stream-destinations.test.ts pins each one as accepted), so the test swaps one in place
    // for the length of one call — the state an allowlist SHRINK would leave behind — and puts it back.
    const { auth } = await seedOrg();
    const streamKey = key();
    const presets = STREAM_PLATFORM_PRESETS as Record<string, string>;
    const saved = presets.youtube!;
    presets.youtube = "rtmp://localhost/live";   // refused for `host` (the refusal table's first row)
    let err: { status?: number; code?: string; extra?: Record<string, unknown>; message?: string } | null;
    try {
      err = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "refused", streamKey }).then(
        () => null,
        (e: unknown) => e as { status?: number; code?: string; extra?: Record<string, unknown>; message?: string },
      );
    } finally {
      presets.youtube = saved;
    }
    expect(err).toMatchObject({ status: 422, code: "DESTINATION_NOT_ALLOWED", extra: { rule: "host" } });
    expect(err!.message).not.toContain("localhost");    // a sentence about the rule — never the url, never the key
    expect(err!.message).not.toContain(streamKey);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    // The positive pair: the same org, key and door with the real preset in place.
    const made = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "ok", streamKey });
    expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.id)).toEqual([made.id]);
  });

  it("pasted SURROUNDING whitespace is trimmed from streamKey (Task 9 review minor 7): the sealed pair is the clean one, and the same destination as the clean paste; a whitespace-only key is refused 422 and writes nothing", async () => {
    const { auth } = await seedOrg();
    const url = STREAM_PLATFORM_PRESETS.youtube;
    // Each pad is a paste artifact from a platform dashboard: a leading space, a trailing newline, a CRLF, a tab.
    const pads: [string, string][] = [[" ", "\n"], ["\t", " "], ["", "\r\n"], ["  ", "\t\n"]];
    let checked = 0;
    for (const [before, after] of pads) {
      const streamKey = key();
      const made = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "pasted", streamKey: `${before}${streamKey}${after}` });
      expect(await sql.begin((tx) => readTargetSecret(tx, auth.orgId, made.id)), JSON.stringify([before, after])).toEqual({ url, streamKey });
      // The same destination: the clean paste of the same pair is THIS row (A19 dedupes on what was sealed).
      expect((await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "clean", streamKey })).id).toBe(made.id);
      checked++;
    }
    expect(checked).toBe(pads.length);
    expect(await listStreamTargets(auth, auth.orgId)).toHaveLength(pads.length);
    // A key that is ONLY whitespace passes the schema's min(1) and is nothing once trimmed: refused, nothing sealed.
    let refused = 0;
    for (const blank of [" ", "\n", " \t\r\n "]) {
      await expect(createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "blank", streamKey: blank }), JSON.stringify(blank))
        .rejects.toMatchObject({ status: 422, code: STREAM_KEY_EMPTY, message: "The stream key is empty" });
      refused++;
    }
    expect(refused).toBe(3);
    expect(await listStreamTargets(auth, auth.orgId)).toHaveLength(pads.length);
  });

  it("tenancy: B's list never shows A's target, and a caller authenticated for B cannot list or create under A's id (404, nothing written anywhere)", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    expect(b.auth.orgId).not.toBe(a.auth.orgId);
    const made = await createStreamTarget(a.auth, a.auth.orgId, { kind: "twitch", label: "A", streamKey: key() });
    expect((await listStreamTargets(a.auth, a.auth.orgId)).map((t) => t.id)).toEqual([made.id]);   // the positive pair
    expect(await listStreamTargets(b.auth, b.auth.orgId)).toEqual([]);
    await expect(listStreamTargets(b.auth, a.auth.orgId)).rejects.toMatchObject({ status: 404 });
    await expect(
      createStreamTarget(b.auth, a.auth.orgId, { kind: "twitch", label: "B into A", streamKey: key() }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await listStreamTargets(a.auth, a.auth.orgId)).map((t) => t.id)).toEqual([made.id]);
    expect(await listStreamTargets(b.auth, b.auth.orgId)).toEqual([]);
  });

  it("second call: a second create is a second destination — both listed in creation order, each secret reads back its OWN key", async () => {
    const { auth } = await seedOrg();
    const [k1, k2] = [key(), key()];
    const same = { kind: "youtube" as const, label: "Main" };
    const first = await createStreamTarget(auth, auth.orgId, { ...same, streamKey: k1 });
    const second = await createStreamTarget(auth, auth.orgId, { ...same, streamKey: k2 });
    expect(second.id).not.toBe(first.id);
    // The list projection is exactly what create returned, in creation order.
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([first, second]);
    const keys = await sql.begin(async (tx) => [
      (await readTargetSecret(tx, auth.orgId, first.id)).streamKey,
      (await readTargetSecret(tx, auth.orgId, second.id)).streamKey,
    ]);
    expect(keys).toEqual([k1, k2]);
  });

  it("empty first, then every platform: a fresh org lists []; each STREAM_PLATFORMS member is created and round-trips; a stored row of EVERY other StreamTargetKind still lists beside them (spec §5.4)", async () => {
    const { auth } = await seedOrg();
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    let checked = 0;
    for (const kind of STREAM_PLATFORMS) {
      const t = await createStreamTarget(auth, auth.orgId, { kind, label: `dest ${kind}`, streamKey: key() });
      expect(t.kind).toBe(kind);
      checked++;
    }
    expect(checked, "platforms checked").toBeGreaterThan(0);
    expect(checked).toBe(STREAM_PLATFORMS.length);
    // Legacy kinds are no longer CREATABLE (D6), but a stored one keeps listing until removed: seeded raw, in enum order.
    const legacy = StreamTargetKind.options.filter((k) => !(STREAM_PLATFORMS as readonly string[]).includes(k));
    expect(legacy.length, "legacy kinds").toBeGreaterThan(0);
    for (const kind of legacy) await rigTarget(auth.orgId, `stored ${kind}`, kind);
    expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.kind)).toEqual([...STREAM_PLATFORMS, ...legacy]);
    expect(STREAM_PLATFORMS.length + legacy.length).toBe(StreamTargetKind.options.length);
  });

  // A19 + A19b (owner 2026-09-28). One destination — one url (in its identity form) + one stream key — is ONE row
  // per org, so V421's one-live-session-per-target index holds per DESTINATION rather than per row a user happened
  // to add twice. The repeat is idempotent: the EXISTING target comes back and no second sealed copy is written.
  // A19b's default-port spelling is unreachable through create since D6 (the url is the preset); it is pinned at the
  // writer (secret-columns.test.ts "even spelled with its default port") and in destinationIdentity's own tests.
  it("A19: the SAME destination twice is ONE row — the repeat returns the stored target (its label, not the new body's) and seals nothing new", async () => {
    const { auth } = await seedOrg();
    const [kTw, kYt] = [key(), key()];
    const tw = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "Twitch", streamKey: kTw });
    const twAgain = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "Twitch again", streamKey: kTw });
    expect(twAgain).toEqual(tw);
    const yt = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "YouTube", streamKey: kYt });
    const ytAgain = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "YouTube again", streamKey: kYt });
    expect(ytAgain).toEqual(yt);
    expect(yt.id).not.toBe(tw.id);
    // The FIRST envelope is the one kept: the platform's preset url and the first key.
    expect(await sql.begin((tx) => readTargetSecret(tx, auth.orgId, tw.id))).toEqual({ url: STREAM_PLATFORM_PRESETS.twitch, streamKey: kTw });
    const rows = await sql<{ id: string; fp: string | null }[]>`
      select id, dest_fingerprint as fp from org_stream_targets where org_id = ${auth.orgId} order by created_at`;
    expect(rows.map((r) => r.id)).toEqual([tw.id, yt.id]);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.fp ?? ""))).toBe(true);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([tw, yt]);
  });

  it("A19: a different KEY on the same platform, another PLATFORM with the same key, or ANOTHER ORG with the same platform + key is a new row (the dedupe never crosses an org)", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const k = key();
    const same = { kind: "twitch" as const, label: "Twitch", streamKey: k };
    const inA = await createStreamTarget(a.auth, a.auth.orgId, same);
    const otherKey = await createStreamTarget(a.auth, a.auth.orgId, { ...same, streamKey: key() });
    const otherPlatform = await createStreamTarget(a.auth, a.auth.orgId, { ...same, kind: "youtube" });
    const inB = await createStreamTarget(b.auth, b.auth.orgId, same);
    expect(new Set([inA.id, otherKey.id, otherPlatform.id, inB.id]).size).toBe(4);
    expect((await listStreamTargets(a.auth, a.auth.orgId)).map((t) => t.id)).toEqual([inA.id, otherKey.id, otherPlatform.id]);
    expect((await listStreamTargets(b.auth, b.auth.orgId)).map((t) => t.id)).toEqual([inB.id]);
    // Same destination in two orgs: the SAME fingerprint (one identity), two rows — the index is per org.
    const fps = await sql<{ fp: string }[]>`
      select dest_fingerprint as fp from org_stream_targets where id in ${sql([inA.id, inB.id])}`;
    expect(fps).toHaveLength(2);
    expect(fps[0]!.fp).toBe(fps[1]!.fp);
  });

  it("A19: a RACE — two creates of one destination at once → one row, and BOTH callers get its id (the unique index is the backstop, answered as the existing target, never a raw 23505)", async () => {
    const { auth } = await seedOrg();
    const body = { kind: "twitch" as const, label: "Twitch", streamKey: key() };
    let rounds = 0;
    for (let i = 0; i < 3; i++) {
      const settled = await Promise.allSettled([
        createStreamTarget(auth, auth.orgId, body),
        createStreamTarget(auth, auth.orgId, body),
      ]);
      const ids = settled.map((s) => (s.status === "fulfilled" ? s.value.id : `rejected: ${String((s as PromiseRejectedResult).reason)}`));
      expect(ids[0]).toBe(ids[1]);
      rounds++;
    }
    expect(rounds).toBe(3);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from org_stream_targets where org_id = ${auth.orgId}`;
    expect(n).toBe(1);
  });

  it("D6: create fills the url from the PLATFORM's preset — every platform, the stored url is the preset's canonical form", async () => {
    let checked = 0;
    for (const kind of STREAM_PLATFORMS) {
      const { auth } = await seedOrg();
      const made = await createStreamTarget(auth, auth.orgId, { kind, label: kind, streamKey: `k-${kind}-0123456789` });
      const stored = await sql.begin((tx) => readTargetSecret(tx, auth.orgId, made.id));
      const canonical = checkDestination(STREAM_PLATFORM_PRESETS[kind]);
      expect(canonical.ok, kind).toBe(true);
      expect(stored.url).toBe(canonical.ok ? canonical.url : "");
      checked++;
    }
    expect(checked).toBe(STREAM_PLATFORMS.length);
  });

  it("D6: the create schema refuses every kind outside STREAM_PLATFORMS and an rtmpUrl field; a stored legacy kind still LISTS", async () => {
    const legacy = StreamTargetKind.options.filter((k) => !(STREAM_PLATFORMS as readonly string[]).includes(k));
    expect(legacy.length).toBeGreaterThan(0);
    for (const kind of legacy) {
      expect(CreateStreamTarget.safeParse({ kind, label: "x", streamKey: "k" }).success, kind).toBe(false);
    }
    expect(CreateStreamTarget.safeParse({ kind: "youtube", label: "x", streamKey: "k", rtmpUrl: "rtmp://a.rtmp.youtube.com/live2" }).success).toBe(false);
    // …and the positive pair: every platform body parses.
    for (const kind of STREAM_PLATFORMS) {
      expect(CreateStreamTarget.safeParse({ kind, label: "x", streamKey: "k" }).success, kind).toBe(true);
    }
    const { auth } = await seedOrg();
    // A raw legacy row through the boundary's rig (this file may not name the sealed column: enc-boundary claim 2).
    await rigTarget(auth.orgId, "Old FB", "facebook");
    expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.kind)).toContain("facebook");
  });

  it("the list excludes ARCHIVED rows and carries keyHint + inUse:null for an idle row", async () => {
    const { auth } = await seedOrg();
    const keep = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Keep", streamKey: "abcd-1234-efgh-5678-ijkl" });
    const drop = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "Drop", streamKey: "live_123_abcdefghijklmnopqrstuvwxyz" });
    await sql.begin((tx) => archiveStreamTarget(tx, auth.orgId, drop.id));
    const list = await listStreamTargets(auth, auth.orgId);
    expect(list.map((t) => t.id)).toEqual([keep.id]);
    expect(list[0]).toMatchObject({ keyHint: "ijkl".slice(-3), inUse: null });
  });

  it("Review Focus 1: a row whose envelope will not open lists with keyHint null — the list still answers", async () => {
    const { auth } = await seedOrg();
    // rigTarget writes a fake envelope that will not open (the boundary's own rig; this file may not name the column).
    await rigTarget(auth.orgId, "Unreadable");
    const list = await listStreamTargets(auth, auth.orgId);
    expect(list.find((t) => t.label === "Unreadable")).toMatchObject({ keyHint: null });
  });
});

// ---------------------------------------------------------------------------
// T2b — Rename, Replace key, Remove (spec §5.2, D2): held = an ACTIVE session references the target (holderRows).
// Every state list is the domain's own ACTIVE_STATES / TERMINAL_STATES; every expected hold state is holdStateOf's.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("rename, replace key, remove (spec §5.2, D2)", () => {
  /** holdRig's org and fixture, with a REAL sealed youtube target (a fresh key each call). */
  const realTarget = async () => {
    const r = await holdRig();
    const t = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Real", streamKey: `k-${randomUUID()}` });
    return { ...r, targetId: t.id };
  };

  it("rename: allowed at ANY time — idle, waiting and live; the reply is the list's own row", async () => {
    let checked = 0;
    for (const state of [null, ...ACTIVE_STATES] as const) {
      const r = await realTarget();
      const targetId = r.targetId;
      if (state) await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, state);
      const got = await patchStreamTarget(r.auth, r.auth.orgId, targetId, { label: `Renamed ${state ?? "idle"}` });
      expect(got).toMatchObject({ id: targetId, label: `Renamed ${state ?? "idle"}` });
      checked++;
    }
    expect(checked).toBe(ACTIVE_STATES.length + 1);
  });

  it("replace key and remove are REFUSED 409 TARGET_IN_USE in EVERY active state, naming the holder; allowed in every terminal one", async () => {
    let checked = 0;
    for (const state of [...ACTIVE_STATES, ...TERMINAL_STATES]) {
      for (const op of ["replace", "remove"] as const) {
        const r = await realTarget();
        const targetId = r.targetId;
        await sessionOnTarget(r.auth.orgId, r.fixtureId, targetId, state);
        const call = op === "replace"
          ? patchStreamTarget(r.auth, r.auth.orgId, targetId, { streamKey: `k-${randomUUID()}` })
          : removeStreamTarget(r.auth, r.auth.orgId, targetId);
        if (holdStateOf(state) === null) {
          await expect(call, `${op} ${state}`).resolves.toBeTruthy();
        } else {
          await expect(call, `${op} ${state}`).rejects.toMatchObject({
            status: 409, code: "TARGET_IN_USE",
            extra: { holder: expect.objectContaining({ fixtureId: r.fixtureId, state: holdStateOf(state) }) },
          });
        }
        checked++;
      }
    }
    expect(checked).toBe(2 * (ACTIVE_STATES.length + TERMINAL_STATES.length));
  });

  it("replace key onto a key ANOTHER active destination holds is 409 DESTINATION_DUPLICATE naming it; nothing is re-sealed", async () => {
    const { auth } = await seedOrg();
    const a = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "A", streamKey: "aaaa-1111-bbbb-2222-cccc" });
    const b = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "B", streamKey: "dddd-3333-eeee-4444-ffff" });
    await expect(patchStreamTarget(auth, auth.orgId, b.id, { streamKey: "aaaa-1111-bbbb-2222-cccc" }))
      .rejects.toMatchObject({ status: 409, code: "DESTINATION_DUPLICATE", extra: { other: { id: a.id, label: "A" } } });
    expect((await sql.begin((tx) => readTargetSecret(tx, auth.orgId, b.id))).streamKey).toBe("dddd-3333-eeee-4444-ffff");
  });

  it("Review Focus 2: replace key TRIMS surrounding whitespace and newlines (same fingerprint as create); whitespace-only is 422", async () => {
    const { auth } = await seedOrg();
    const t = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "T", streamKey: "aaaa-1111-bbbb-2222-cccc" });
    await patchStreamTarget(auth, auth.orgId, t.id, { streamKey: "  abcd-1234-efgh-5678-ijkl\n" });
    expect((await sql.begin((tx) => readTargetSecret(tx, auth.orgId, t.id))).streamKey).toBe("abcd-1234-efgh-5678-ijkl");
    await expect(patchStreamTarget(auth, auth.orgId, t.id, { streamKey: "   " })).rejects.toMatchObject({ status: 422, code: STREAM_KEY_EMPTY });
  });

  it("I2: replace key on a PLATFORM row whose envelope will not open (a KEK change) RECOVERS it in place — re-sealed on the platform's preset under the current KEK, a real keyHint, and the same destination a create of that key finds; every platform", async () => {
    let checked = 0;
    for (const kind of STREAM_PLATFORMS) {
      const { auth } = await seedOrg();
      // rigTarget writes an envelope that will not open (the boundary's own rig; this file may not name the column).
      const targetId = await rigTarget(auth.orgId, `Unreadable ${kind}`, kind);
      expect((await listStreamTargets(auth, auth.orgId)).find((t) => t.id === targetId), kind).toMatchObject({ keyHint: null });
      const streamKey = `k-${randomUUID()}`;
      const got = await patchStreamTarget(auth, auth.orgId, targetId, { streamKey });
      expect(got, kind).toMatchObject({ id: targetId, kind, label: `Unreadable ${kind}`, keyHint: streamKey.slice(-3) });
      const canonical = checkDestination(STREAM_PLATFORM_PRESETS[kind]);
      expect(canonical.ok, kind).toBe(true);
      expect(await sql.begin((tx) => readTargetSecret(tx, auth.orgId, targetId)), kind).toEqual({ url: canonical.ok ? canonical.url : "", streamKey });
      // The fingerprint is the CURRENT KEK's: a create of the same key is this row, not a second destination.
      expect((await createStreamTarget(auth, auth.orgId, { kind, label: "again", streamKey })).id, kind).toBe(targetId);
      expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.id), kind).toEqual([targetId]);
      checked++;
    }
    expect(checked).toBe(STREAM_PLATFORMS.length);
  });

  it("I2: replace key on a LEGACY-kind row whose envelope will not open is a 422 telling the organiser to remove it (M4: never to add it again) — never a 500 — and nothing is re-sealed; every legacy kind", async () => {
    const legacy = StreamTargetKind.options.filter((k) => !(STREAM_PLATFORMS as readonly string[]).includes(k));
    expect(legacy.length).toBeGreaterThan(0);
    let checked = 0;
    for (const kind of legacy) {
      const { auth } = await seedOrg();
      const targetId = await rigTarget(auth.orgId, `Old ${kind}`, kind);
      const err = await patchStreamTarget(auth, auth.orgId, targetId, { streamKey: `k-${randomUUID()}` }).then(() => null, (e: unknown) => e);
      expect(err, kind).toMatchObject({ status: 422, code: TARGET_UNREADABLE });
      expect((err as Error).message, kind).toMatch(/remove it/i);
      expect((err as Error).message, `${kind}: M4 — create admits only YouTube and Twitch`).not.toMatch(/add it again|re-?add/i);
      await expect(sql.begin((tx) => readTargetSecret(tx, auth.orgId, targetId)), `${kind}: still the unopenable envelope`).rejects.toThrow();
      expect((await listStreamTargets(auth, auth.orgId)).find((t) => t.id === targetId), kind).toMatchObject({ keyHint: null });
      checked++;
    }
    expect(checked).toBe(legacy.length);
  });

  it("M5: rename TRIMS the label (as the key is trimmed); a whitespace-only label is 422 and changes nothing", async () => {
    const { auth } = await seedOrg();
    const t = await createStreamTarget(auth, auth.orgId, { kind: "youtube", label: "Court 1", streamKey: `k-${randomUUID()}` });
    expect(await patchStreamTarget(auth, auth.orgId, t.id, { label: "  Court 9 (main)\n" })).toMatchObject({ id: t.id, label: "Court 9 (main)" });
    await expect(patchStreamTarget(auth, auth.orgId, t.id, { label: " \t\n " })).rejects.toMatchObject({ status: 422, code: DESTINATION_LABEL_EMPTY });
    expect((await listStreamTargets(auth, auth.orgId)).map((x) => x.label)).toEqual(["Court 9 (main)"]);
  });

  it("M5: create TRIMS the label; a whitespace-only label is 422 and writes nothing — and a RESTORE takes the trimmed label too", async () => {
    const { auth } = await seedOrg();
    const streamKey = `k-${randomUUID()}`;
    await expect(createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "   ", streamKey })).rejects.toMatchObject({ status: 422, code: DESTINATION_LABEL_EMPTY });
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    const made = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "\t Main court ", streamKey });
    expect(made.label).toBe("Main court");
    await removeStreamTarget(auth, auth.orgId, made.id);
    const back = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "  Back again  ", streamKey });
    expect(back).toMatchObject({ id: made.id, label: "Back again" });
  });

  it("remove archives: gone from the list, 404 the second time, and re-adding the same key RESTORES the same id (sequence)", async () => {
    const { auth } = await seedOrg();
    const t = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "Tw", streamKey: "live_42_abcdefghijklmnopqrstu" });
    await removeStreamTarget(auth, auth.orgId, t.id);
    expect((await listStreamTargets(auth, auth.orgId)).map((x) => x.id)).not.toContain(t.id);
    await expect(removeStreamTarget(auth, auth.orgId, t.id)).rejects.toMatchObject({ status: 404 });
    await expect(patchStreamTarget(auth, auth.orgId, t.id, { label: "x" })).rejects.toMatchObject({ status: 404 });
    const back = await createStreamTarget(auth, auth.orgId, { kind: "twitch", label: "Tw again", streamKey: "live_42_abcdefghijklmnopqrstu" });
    expect(back).toMatchObject({ id: t.id, label: "Tw again" });
  });

  it("another org's target is 404 for rename, replace and remove — never a 409 that confirms it exists", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const t = await createStreamTarget(a.auth, a.auth.orgId, { kind: "youtube", label: "A", streamKey: "aaaa-1111-bbbb-2222-cccc" });
    let checked = 0;
    for (const call of [
      () => patchStreamTarget(b.auth, b.auth.orgId, t.id, { label: "x" }),
      () => patchStreamTarget(b.auth, b.auth.orgId, t.id, { streamKey: "k-0123456789ab" }),
      () => removeStreamTarget(b.auth, b.auth.orgId, t.id),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the ROW LOCK, Remove's side and Replace key's side: each WAITS on a Go live holding the target, then refuses 409 once that Go live's session commits", async () => {
    let checked = 0;
    for (const op of ["remove", "replace"] as const) {
      const r = await realTarget();
      let release!: () => void;
      const held = new Promise<void>((res) => { release = res; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((res) => { locked = res; });
      // Transaction A plays createSession's admission: lock the target, write a `requested` session on it, hold.
      const goLive = sql.begin(async (tx) => {
        expect(await lockStreamTarget(tx, r.auth.orgId, r.targetId)).toBe(true);
        await sessionOnTarget(r.auth.orgId, r.fixtureId, r.targetId, "requested", tx);
        locked();
        await held;
      });
      try {
        await lockTaken;
        let settled = false;
        const write = (op === "remove"
          ? removeStreamTarget(r.auth, r.auth.orgId, r.targetId)
          : patchStreamTarget(r.auth, r.auth.orgId, r.targetId, { streamKey: `k-${randomUUID()}` })
        ).finally(() => { settled = true; });
        write.catch(() => {});                                 // observed below; no unhandled rejection meanwhile
        await new Promise((res) => setTimeout(res, 300));
        expect(settled, `${op} did not wait on the target row lock`).toBe(false);
        release();
        await goLive;
        // Under READ COMMITTED the waiter re-reads after A commits: the session A wrote is now the holder.
        await expect(write, op).rejects.toMatchObject({ status: 409, code: "TARGET_IN_USE" });
        checked++;
      } finally {
        release();                                             // a red above must not leave tx A holding the lock
        await goLive.catch(() => {});                          // …or its pooled connection, until teardown times out
      }
    }
    expect(checked).toBe(2);
  });

  it("PatchStreamTarget: exactly one of label / streamKey", () => {
    expect(PatchStreamTarget.safeParse({ label: "x" }).success).toBe(true);
    expect(PatchStreamTarget.safeParse({ streamKey: "k" }).success).toBe(true);
    expect(PatchStreamTarget.safeParse({}).success).toBe(false);
    expect(PatchStreamTarget.safeParse({ label: "x", streamKey: "k" }).success).toBe(false);
    expect(PatchStreamTarget.safeParse({ label: "x", rtmpUrl: "rtmp://a.rtmp.youtube.com/live2" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The route: parse → authorize → delegate, over the real handler.
// ---------------------------------------------------------------------------

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (orgId: string, body: unknown, headers: HeadersInit = {}) =>
  POST(
    new Request(`http://localhost/api/v1/orgs/${orgId}/stream-targets`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ctx(orgId),
  );
const get = (orgId: string, headers: HeadersInit = {}) =>
  GET(new Request(`http://localhost/api/v1/orgs/${orgId}/stream-targets`, { headers }), ctx(orgId));

/** A signed-in owner of a fresh org (real users + org_members rows). */
async function organiser() {
  const { auth } = await seedSignedInOrg("pro");
  authState.userId = auth.userId!;
  return auth;
}

describe.skipIf(!HAS_DB)("/api/v1/orgs/{id}/stream-targets — the route", () => {
  it("a signed-in organiser POSTs (201, the wire shape, no key) and GETs it back; a bad body is 400 and writes nothing", async () => {
    const auth = await organiser();
    const streamKey = key();
    const bad = await post(auth.orgId, { kind: "youtube", label: "x", streamKey: 42 });
    expect(bad.status).toBe(400);
    const unknownField = await post(auth.orgId, { kind: "youtube", label: "x", streamKey, stream_key: streamKey });
    expect(unknownField.status).toBe(400);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);

    const res = await post(auth.orgId, { kind: "youtube", label: "Club", streamKey, watchUrl: "https://youtu.be/abc" });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(streamKey);
    const created = StreamTarget.parse(JSON.parse(text).data);
    expect(created).toMatchObject({ kind: "youtube", label: "Club", watchUrl: "https://youtu.be/abc" });

    const listed = await get(auth.orgId);
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect(listText).not.toContain(streamKey);
    expect(JSON.parse(listText).data).toEqual([created]);
  });

  it("D6 over the real route: a legacy kind or an rtmpUrl field is 400 VALIDATION and writes nothing — the reply echoes neither the url nor the key; a platform body then lands", async () => {
    // The A18 url refusals this case used to drive are unreachable over the wire since D6 (create takes no url); their
    // URLs moved to stream-destinations.test.ts. What the wire now refuses is the SHAPE: a kind outside STREAM_PLATFORMS
    // and any url field at all (strict).
    const auth = await organiser();
    const streamKey = key();
    const url = "rtmps://a.rtmps.youtube.com.evil.io/live2";
    const bodies: [string, unknown][] = [
      ["legacy kind", { kind: "custom_rtmp", label: "x", streamKey }],
      ["legacy kind", { kind: "facebook", label: "x", streamKey }],
      ["rtmpUrl field", { kind: "youtube", label: "x", rtmpUrl: url, streamKey }],
    ];
    let checked = 0;
    for (const [what, body] of bodies) {
      const res = await post(auth.orgId, body);
      expect(res.status, what).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text).error, what).toMatchObject({ code: "VALIDATION" });
      expect(text).not.toContain(url);
      expect(text).not.toContain(streamKey);
      checked++;
    }
    expect(checked).toBe(3);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    // The positive pair on the same org and door: a platform body is created.
    const ok = await post(auth.orgId, { kind: "twitch", label: "Twitch", streamKey });
    expect(ok.status).toBe(201);
    expect((await listStreamTargets(auth, auth.orgId)).map((t) => t.label)).toEqual(["Twitch"]);
  });

  it("roles: a viewer (READ_ROLES, not EDITOR_ROLES) lists the destinations but cannot add one (403, nothing written)", async () => {
    const owner = await organiser();
    const made = await createStreamTarget(owner, owner.orgId, { kind: "youtube", label: "YT", streamKey: key() });
    const viewer = await makeUser("viewer");
    await sql`insert into org_members (org_id, user_id, role) values (${owner.orgId}, ${viewer.id}, 'viewer')`;
    authState.userId = viewer.id;
    const listed = await get(owner.orgId);
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.map((t: { id: string }) => t.id)).toEqual([made.id]);
    const refused = await post(owner.orgId, { kind: "youtube", label: "viewer's", streamKey: key() });
    expect(refused.status).toBe(403);
    expect((await listStreamTargets(owner, owner.orgId)).map((t) => t.id)).toEqual([made.id]);
  });

  // What this proves is the DOOR: no key reaches either handler. Which list refuses it (default-deny vs the explicit
  // NEVER_KEY_ROUTES entry) is proved by key-scopes.test.ts's classification walk and stream-contract.test.ts.
  it("an API key — even a manage-scoped one — is refused at BOTH doors (403) and writes nothing", async () => {
    const auth = await organiser();
    // Unblock the key surface itself, so the ONLY thing left to refuse is the route ban.
    for (const feature of ["api.access", "api.write"]) {
      await sql`
        insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
        values (${auth.orgId}, ${feature}, true, 'test')
        on conflict (org_id, feature_key) do update set bool_value = true`;
    }
    const { secret } = await createApiKey(auth, { name: "integration", scopes: ["manage"] });
    const bearer = { authorization: `Bearer ${secret}` };
    const keyedPost = await post(auth.orgId, { kind: "twitch", label: "k", streamKey: key() }, bearer);
    expect(keyedPost.status).toBe(403);
    const keyedGet = await get(auth.orgId, bearer);
    expect(keyedGet.status).toBe(403);
    // WHICH refusal (Task 9 review minor 4): apiKeyAuth has four 403 exits (auth.ts); the route ban is the one that
    // says a key cannot use this endpoint at all — never the scope refusal a manage key would otherwise meet.
    let doors = 0;
    for (const [door, res] of [["POST", keyedPost], ["GET", keyedGet]] as const) {
      const message = (await res.json()).error?.message as string;
      expect(message, door).toMatch(/^API keys cannot access this endpoint/);
      expect(message, door).not.toMatch(/scope/);
      doors++;
    }
    expect(doors).toBe(2);
    // The accepted twin: the same org's session reaches the same doors.
    expect((await get(auth.orgId)).status).toBe(200);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
  });

  // Task 9 review minor 1: `assertUuid` is the route's first guard, and nothing reached it. Without it a malformed id
  // reaches the membership lookup's uuid compare. Each door is asked by a SIGNED-IN organiser (so authentication is not
  // what refuses) with a body that would otherwise be created (so validation is not what refuses).
  it("a malformed org id is 404 'organization not found' at BOTH doors, before auth or the body are read — and writes nothing", async () => {
    const auth = await organiser();
    const good = { kind: "youtube", label: "Club", streamKey: key() };
    let checked = 0;
    for (const badId of ["not-a-uuid", `${auth.orgId}x`, ""]) {
      for (const [door, res] of [["GET", await get(badId)], ["POST", await post(badId, good)]] as const) {
        expect(res.status, `${door} ${JSON.stringify(badId)}`).toBe(404);
        expect((await res.json()).error?.message, `${door} ${JSON.stringify(badId)}`).toBe("organization not found");
        checked++;
      }
    }
    expect(checked).toBe(6);
    expect(await listStreamTargets(auth, auth.orgId)).toEqual([]);
    // The accepted twin: the same organiser, body and doors on the WELL-FORMED id.
    expect((await post(auth.orgId, good)).status).toBe(201);
    expect((await get(auth.orgId)).status).toBe(200);
  });
});
