// B8 review I-1 (controller ruling, spec §17.13): what the organiser sees is what streams. ONE default-target resolver
// answers the fixture's destination, and its three server readers must agree on every row of THE table
// (`lib/__tests__/_stream-target-table.ts`, whose answers are the rule text's):
//  - the panel's read model (`streamPhone().destination`) — what the picker shows;
//  - the phone's descriptor (`getCode().destinationName`) — what the phone says it would start;
//  - the phone's own start (`postStart`) — the `target_id` the session opens on, or 409 no_destination when the row's
//    answer is none.
// And reading writes nothing: the settings row is byte-for-byte the same after the read model and the descriptor.
//
// DB-backed through the REAL rig (ensureStreamCode, the REAL claim beat, saveStreamSettings, startBroadcast on FAKE
// drivers). One sport only: no sport input reaches the destination (the fixture's sport picks overlay themes alone).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { CaptureRefusalError, captureRefusal } from "@/server/api-v1/capture-http";
import { CaptureBeat, CaptureStartOk } from "@/server/api-v1/capture-schemas";
import { StreamPhone } from "@/server/api-v1/schemas";
import { constructible, rowName, STREAM_TARGET_TABLE, STREAM_TARGET_TABLE_ROWS, type TargetName, type TargetRow } from "@/lib/__tests__/_stream-target-table";
import { getCode, postBeat, postStart } from "../capture-phone";
import { fixtureStreamTarget, saveStreamSettings } from "../stream-codes";
import { streamPhone } from "../stream-phone";
import { createStreamTarget } from "../stream-targets";
import { captureRig, phoneId, type CaptureRig } from "./_capture-rig";
import { seedOrg } from "./_rig";

const HAS_DB = !!process.env.DATABASE_URL;

const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "OAUTH_BASE_URL", "NEXT_PUBLIC_BASE_URL", "STREAM_INGEST_HOST", "STREAM_PLAYBACK_HOST", "STREAM_SRT_ENABLED", "RELAY_DRIVERS"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEK = randomBytes(32).toString("hex");
function baseEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = KEK;
  process.env.AUTH_SECRET = "stream-target-agreement-secret";
}
beforeAll(baseEnv);
beforeEach(baseEnv);
afterAll(() => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

const LABEL: Record<TargetName, string> = { A: "Alpha Feed", B: "Bravo Feed" };

async function claim(r: CaptureRig, phone: string) {
  return postBeat(r.code, r.tok, CaptureBeat.parse({
    code: r.code, slot: 0, phone, claim: "new", device: null, sid: null, at: r.now().toISOString(), state: "paired",
    cause: null, notReady: null, startFailed: null, stopped: null, mode: "operator", transport: null, bitrateKbps: null,
    delivery: "unknown", deliveredLagS: null, audioOk: null, battery: null, thermal: null, dataUsedMB: null,
    appVersion: "capture-test/1",
  }), r.deps, r.now());
}

/**
 * The row's world. The ages are pinned, never left to the clock, and against insertion order: with two live
 * destinations the rig's own (created FIRST) is B, the newer, and A is created after it but dated an hour earlier — so
 * "the oldest" can only be read off `created_at`.
 */
async function world(row: TargetRow) {
  const r = await captureRig({ targetLabel: row.live.length === 2 ? LABEL.B : LABEL.A });
  const ids: Partial<Record<TargetName, string>> = {};
  if (row.live.length === 0) {
    await sql`update org_stream_targets set archived_at = now() where id = ${r.target.id}`;
  } else if (row.live.length === 1) {
    ids.A = r.target.id;
  } else {
    ids.B = r.target.id;
    const a = await createStreamTarget(r.auth, r.auth.orgId, { kind: "twitch", label: LABEL.A, streamKey: `tw-${randomUUID()}` });
    ids.A = a.id;
    await sql`update org_stream_targets set created_at = now() - interval '2 hours' where id = ${ids.B}`;
    await sql`update org_stream_targets set created_at = now() - interval '3 hours' where id = ${ids.A}`;
  }
  switch (row.saved) {
    case "none":
      break;
    case "cleared":
      await saveStreamSettings(r.auth, r.fixtureId, { targetId: null });
      break;
    case "live":
      await saveStreamSettings(r.auth, r.fixtureId, { targetId: ids[row.live[row.live.length - 1]!]! });
      break;
    case "archived": {
      const z = await createStreamTarget(r.auth, r.auth.orgId, { kind: "youtube", label: "Zulu Feed", streamKey: `yt-${randomUUID()}` });
      await saveStreamSettings(r.auth, r.fixtureId, { targetId: z.id });
      await sql`update org_stream_targets set archived_at = now() where id = ${z.id}`;
      break;
    }
    case "unknown": {
      // Another club's destination: the writer refuses it (404), so only a raw row can hold it.
      const other = await seedOrg();
      const theirs = await createStreamTarget(other.auth, other.auth.orgId, { kind: "youtube", label: "Theirs", streamKey: `yt-${randomUUID()}` });
      await sql`insert into fixture_stream_settings (fixture_id, org_id, target_id) values (${r.fixtureId}, ${r.auth.orgId}, ${theirs.id})`;
      break;
    }
  }
  return { r, ids };
}

const settingsRow = async (fixtureId: string) =>
  (await sql<{ target_id: string | null; updated_by: string | null; updated_at: string }[]>`
    select target_id, updated_by, updated_at::text from fixture_stream_settings where fixture_id = ${fixtureId}`)[0] ?? null;

describe.skipIf(!HAS_DB)("§17.13: the panel's destination, the phone's descriptor and the phone's start agree on every row", () => {
  it("every constructible row of THE table: the read model, the descriptor and the start name the row's answer — or all name none and the start is 409 no_destination; nothing is written by reading", async () => {
    let checked = 0;
    let started = 0;
    let refused = 0;
    const skipped: string[] = [];
    for (const row of STREAM_TARGET_TABLE) {
      if (!constructible(row)) { skipped.push(rowName(row)); continue; }
      const name = rowName(row);
      const { r, ids } = await world(row);
      const want = row.expect === null ? null : { id: ids[row.expect.pick]!, label: LABEL[row.expect.pick], source: row.expect.source };

      const before = await settingsRow(r.fixtureId);
      expect(await fixtureStreamTarget(sql, { orgId: r.auth.orgId, fixtureId: r.fixtureId }), `${name}: the reader`).toEqual(want);
      const model = await streamPhone(r.auth, r.fixtureId, { now: r.now });
      expect(StreamPhone.parse(model)).toEqual(model);
      expect(model.destination, `${name}: the panel's read model`).toEqual(want);
      const descriptor = await getCode(r.code, r.tok, { slot: 0, phone: null }, r.deps, r.now());
      expect((descriptor as { destinationName: string | null }).destinationName, `${name}: the descriptor`).toBe(want?.label ?? null);
      expect(await settingsRow(r.fixtureId), `${name}: reading wrote nothing`).toEqual(before);

      const A = phoneId("a");
      await claim(r, A);
      const got = await postStart(r.code, r.tok, { phone: A }, r.deps, r.now()).then(
        (ok) => ({ ok: CaptureStartOk.parse(ok) }),
        (e: unknown) => ({ err: e }),
      );
      if (want === null) {
        expect("err" in got && got.err, `${name}: refused`).toBeInstanceOf(CaptureRefusalError);
        const res = captureRefusal((got as { err: CaptureRefusalError }).err);
        expect([res.status, ((await res.json()) as { code: string }).code], name).toEqual([409, "no_destination"]);
        expect(await sql`select 1 from fixture_stream_sessions where fixture_id = ${r.fixtureId}`, `${name}: no session`).toHaveLength(0);
        refused++;
      } else {
        expect("ok" in got, `${name}: started (${"err" in got ? String(got.err) : ""})`).toBe(true);
        const [s] = await sql<{ target_id: string }[]>`select target_id from fixture_stream_sessions where id = ${(got as { ok: { sid: string } }).ok.sid}`;
        expect(s!.target_id, `${name}: the start opened on the panel's destination`).toBe(want.id);
        started++;
      }
      checked++;
    }
    expect(skipped, "the one row the DB cannot hold: a saved live choice with nothing live").toEqual(["saved live, live []"]);
    expect(checked).toBe(STREAM_TARGET_TABLE_ROWS - 1);
    // Both outcomes are witnessed: 4 rows stream (the default and the saved choice, at one and at two destinations); the
    // other 10 refuse.
    expect({ started, refused }).toEqual({ started: 4, refused: 10 });
  });

  it("§17.13's own repro: no saved row and two destinations — the panel shows the OLDEST, and the phone's Start streams to it (no 409)", async () => {
    const { r, ids } = await world({ saved: "none", live: ["A", "B"], expect: { pick: "A", source: "default" } });
    expect((await streamPhone(r.auth, r.fixtureId, { now: r.now })).destination).toEqual({ id: ids.A, label: LABEL.A, source: "default" });
    const A = phoneId("a");
    await claim(r, A);
    const { sid } = CaptureStartOk.parse(await postStart(r.code, r.tok, { phone: A }, r.deps, r.now()));
    const [s] = await sql<{ target_id: string }[]>`select target_id from fixture_stream_sessions where id = ${sid}`;
    expect(s!.target_id).toBe(ids.A);
    expect(await settingsRow(r.fixtureId), "the phone's start saves no choice for the organiser").toBeNull();
  });

  it("a second read is the same answer, and a pick moves all three readers together", async () => {
    const { r, ids } = await world({ saved: "none", live: ["A", "B"], expect: { pick: "A", source: "default" } });
    const first = (await streamPhone(r.auth, r.fixtureId, { now: r.now })).destination;
    expect((await streamPhone(r.auth, r.fixtureId, { now: r.now })).destination, "a second read").toEqual(first);
    await saveStreamSettings(r.auth, r.fixtureId, { targetId: ids.B! });
    const picked = { id: ids.B, label: LABEL.B, source: "saved" };
    expect((await streamPhone(r.auth, r.fixtureId, { now: r.now })).destination).toEqual(picked);
    expect((await getCode(r.code, r.tok, { slot: 0, phone: null }, r.deps, r.now()) as { destinationName: string | null }).destinationName).toBe(LABEL.B);
    // …and the pick ARCHIVED in Directory is none for all three — never A in its place (n1).
    await sql`update org_stream_targets set archived_at = now() where id = ${ids.B!}`;
    expect((await streamPhone(r.auth, r.fixtureId, { now: r.now })).destination).toBeNull();
    expect((await getCode(r.code, r.tok, { slot: 0, phone: null }, r.deps, r.now()) as { destinationName: string | null }).destinationName).toBeNull();
    const A = phoneId("a");
    await claim(r, A);
    const err = await postStart(r.code, r.tok, { phone: A }, r.deps, r.now()).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureRefusalError);
    expect(((await captureRefusal(err as CaptureRefusalError).json()) as { code: string }).code).toBe("no_destination");
  });
});
