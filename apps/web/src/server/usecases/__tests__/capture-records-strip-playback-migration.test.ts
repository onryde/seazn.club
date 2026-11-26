// Owner ruling 2026-11-26 ("fix it"): the migration `V*__capture_records_strip_playback.sql` (its number is assigned at
// merge, so it is found by glob and never named here) strips a playback address from the capture records already stored.
// Its OWN `do $$ … end $$` block, read from the file, runs against seeded rows inside a transaction that is always rolled
// back (the competition-freeze-backfill pattern), on the capture rig's real org, fixture and code.
//
// The expected side is never the SQL under test: the hand-written lines below carry their own expectations, and every
// seeded line is also compared with the INGEST's twin — the line screen's key strip plus `scrubPlaybackValues`, the TypeScript
// rule the server applies to a new record — so the backfill and the ingest agree on one rule, in two implementations.
// ONE SPORT, on purpose: not applicable — the capture surface reads no sport (spec §13.2 "Another sport").
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectionOptions } from "@/lib/db";
import { screenRecordLine } from "@/server/relay/domain/capture-record";
import { scrubPlaybackValues } from "@/server/relay/record-playback-scrub";
import { captureRig } from "./_capture-rig";
import { sql } from "@/lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const DELTAS = resolve(__dirname, "../../../../../../db/migration/deltas");
const NAME = /^V\d+__capture_records_strip_playback\.sql$/;
const files = readdirSync(DELTAS).filter((f) => NAME.test(f));
const migration = files.length === 1 ? readFileSync(resolve(DELTAS, files[0]!), "utf8") : "";
const BLOCK = /do \$\$[\s\S]*?end\s*\$\$;/.exec(migration.replace(/--.*$/gm, ""))?.[0];
const NOTICE = /^V\d+ capture records: playback addresses stripped: rows=(\d+) lines=(\d+)$/;

// The capture rig starts a real stream session, which seals a credential: the same two settings capture-record.test.ts gives it.
const ENV_KEYS = ["RELAY_KEK", "AUTH_SECRET", "RELAY_DRIVERS", "STREAM_PLAYBACK_HOST"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.AUTH_SECRET = "capture-records-strip-playback-test-secret";
});
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const AT = "2026-10-11T21:19:03.123Z";
const HOST = "customer-k7q2.cloudflarestream.com";
const SIGNED = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1aWQxMjMiLCJleHAiOjE3OTk5OTk5OTl9.c2lnbmF0dXJlX2J5dGVzX2hlcmU";
const UNSIGNED = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const addr = (seg: string) => `https://${HOST}/${seg}/manifest/video.m3u8`;
const J = (o: object) => JSON.stringify(o);
const SID = "5f2c8a1e-3b4d-4e6f-8a9b-0c1d2e3f4a5b";

/** Each line, the way the OLD ingest stored it, with what the backfill must leave (hand-written, key order the sender's). */
const DIRTY: { name: string; before: string; after: string }[] = [
  { name: "playbackUrl in the middle", before: J({ at: AT, kind: "armed", sid: SID, playbackUrl: addr(SIGNED), stalledMs: 12000 }), after: J({ at: AT, kind: "armed", sid: SID, stalledMs: 12000 }) },
  { name: "playbackUrl as the FIRST key", before: J({ playbackUrl: addr(UNSIGNED), at: AT, kind: "armed" }), after: J({ at: AT, kind: "armed" }) },
  { name: "playbackUrl as the LAST key", before: J({ at: AT, kind: "armed", playbackUrl: addr(UNSIGNED) }), after: J({ at: AT, kind: "armed" }) },
  { name: "a signed address under url", before: J({ at: AT, kind: "armed", url: addr(SIGNED), ms: 1 }), after: J({ at: AT, kind: "armed", ms: 1 }) },
  { name: "an unsigned address under overlayUrl, first key", before: J({ overlayUrl: addr(UNSIGNED), at: AT, kind: "armed" }), after: J({ at: AT, kind: "armed" }) },
  { name: "url first and overlayUrl second, both addresses", before: J({ url: addr(SIGNED), overlayUrl: addr(UNSIGNED), at: AT, kind: "armed" }), after: J({ at: AT, kind: "armed" }) },
  { name: "a signed address under url as the LAST key", before: J({ at: AT, kind: "armed", url: addr(SIGNED) }), after: J({ at: AT, kind: "armed" }) },
  { name: "an unsigned address under overlayUrl as the LAST key", before: J({ at: AT, kind: "armed", overlayUrl: addr(UNSIGNED) }), after: J({ at: AT, kind: "armed" }) },
  { name: "an ENCODED address under url, mid-line (a playback address carried inside another path)", before: J({ at: AT, kind: "armed", url: `https://example.test/next/${encodeURIComponent(addr(UNSIGNED))}`, ms: 2 }), after: J({ at: AT, kind: "armed", ms: 2 }) },
  { name: "an ENCODED address under url as the LAST key", before: J({ at: AT, kind: "armed", url: `https://example.test/next/${encodeURIComponent(addr(SIGNED))}` }), after: J({ at: AT, kind: "armed" }) },
  { name: "an ENCODED address under overlayUrl as the FIRST key", before: J({ overlayUrl: `https://example.test/next/${encodeURIComponent(addr(UNSIGNED))}`, at: AT, kind: "armed" }), after: J({ at: AT, kind: "armed" }) },
  { name: "an address in message", before: J({ at: AT, kind: "armed", message: `stalled on ${addr(SIGNED)} after 12s` }), after: J({ at: AT, kind: "armed", message: `stalled on https://${HOST}/***/manifest/video.m3u8 after 12s` }) },
  { name: "an encoded address in problems", before: J({ at: AT, kind: "armed", problems: `next=${encodeURIComponent(addr(UNSIGNED))}` }), after: J({ at: AT, kind: "armed", problems: `next=${encodeURIComponent(addr("***"))}` }) },
];
const CLEAN: { name: string; line: string }[] = [
  { name: "a normal public url", line: J({ at: AT, kind: "armed", url: "https://example.test/a/b", message: "thermal" }) },
  { name: "the key's NAME as a value", line: J({ at: AT, kind: "armed", message: "set playbackUrl later" }) },
  { name: "an escaped look-alike key inside a string", line: J({ at: AT, kind: "armed", message: 'a,"playbackUrl":"b' }) },
  { name: "the host named, no path segment", line: J({ at: AT, kind: "armed", message: "see cloudflarestream.com docs" }) },
  { name: "a plain line", line: J({ at: AT, kind: "pair", claim: "new", slot: 0 }) },
  { name: "a masked url", line: J({ at: AT, kind: "armed", url: "***" }) },
];

const ROLLBACK = new Error("rollback");
type Row = { ref: string; lines: string; received_lines: number; kept_lines: number; dropped_lines: number; invalid_lines: number; body_bytes: number };
type Seed = { orgId: string; competitionId: string; fixtureId: string; codeId: string };

async function seedAndRun(seed: Seed, rows: { ref: string; lines: string[] }[], runs: number): Promise<{ afterEach: Row[][]; notices: { rows: number; lines: number }[] }> {
  const url = process.env.DATABASE_URL!;
  const announced: string[] = [];
  const client = postgres(url, { max: 1, ssl: connectionOptions(url).ssl, connection: { search_path: connectionOptions(url).schema }, onnotice: (n) => announced.push(String(n.message)) });
  const out: { afterEach: Row[][]; notices: { rows: number; lines: number }[] } = { afterEach: [], notices: [] };
  const read = async (tx: postgres.TransactionSql): Promise<Row[]> => (await tx<Row[]>`
    select ref, lines, received_lines, kept_lines, dropped_lines, invalid_lines, body_bytes from capture_records where ref = any(${rows.map((r) => r.ref)}) order by ref`);
  try {
    await client.begin(async (tx) => {
      // Rows the shared DB already holds (an earlier run's) are cleaned first and not counted: what is announced below is the seeded rows'.
      await tx.unsafe(BLOCK!);
      for (const r of rows) {
        const text = r.lines.join("\n");
        await tx`insert into capture_records (org_id, competition_id, fixture_id, code_id, slot, ref, received_lines, kept_lines, dropped_lines, invalid_lines, body_bytes, lines, expires_at)
                 values (${seed.orgId}, ${seed.competitionId}, ${seed.fixtureId}, ${seed.codeId}, 0, ${r.ref}, ${r.lines.length}, ${r.lines.length}, 0, 0, ${Buffer.byteLength(text)}, ${text}, now() + interval '30 days')`;
      }
      for (let i = 0; i < runs; i++) {
        announced.length = 0;
        await tx.unsafe(BLOCK!);
        const m = announced.map((x) => NOTICE.exec(x)).find((x) => x !== null);
        if (!m) throw new Error(`the block announced nothing: ${JSON.stringify(announced)}`);
        out.notices.push({ rows: Number(m[1]), lines: Number(m[2]) });
        out.afterEach.push(await read(tx));
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  } finally {
    await client.end();
  }
  return out;
}

describe.skipIf(!HAS_DB)("the strip-playback migration, against seeded capture_records (owner ruling 2026-11-26)", () => {
  it("premise: the delta is found by glob and its block read", () => {
    expect(files).toHaveLength(1);
    expect(BLOCK, "the do-block").toBeTruthy();
  });

  it("a row with the field is stripped, a row without it is byte-identical, the counts are untouched, it says what it changed — and a SECOND run is a no-op", async () => {
    const rig = await captureRig();
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${rig.fixtureId}`;
    const [{ id: codeId }] = await sql<{ id: string }[]>`select id from fixture_stream_codes where code = ${rig.code}`;
    const seed: Seed = { orgId: rig.auth.orgId, competitionId: competition_id, fixtureId: rig.fixtureId, codeId };
    const tag = randomUUID().replace(/[^0-9A-HJKMNP-TV-Z]/gi, "").toUpperCase().replace(/[ILOU]/g, "7");
    const mkRef = (n: number) => `R-${tag.slice(0, 3)}${n}`;
    // Row A: every dirty line among clean ones; row B: only clean lines; row C: ONE dirty line alone.
    const A = { ref: mkRef(1), lines: [CLEAN[4]!.line, ...DIRTY.map((d) => d.before), CLEAN[0]!.line] };
    const B = { ref: mkRef(2), lines: CLEAN.map((c) => c.line) };
    const C = { ref: mkRef(3), lines: [DIRTY[3]!.before] };
    const { afterEach, notices } = await seedAndRun(seed, [A, B, C], 2);

    // Loud: rows A and C changed, nine lines in all (the eight dirty ones of A and the one of C). The second run: none.
    expect(notices).toEqual([{ rows: 2, lines: DIRTY.length + 1 }, { rows: 0, lines: 0 }]);
    const [first, second] = afterEach as [Row[], Row[]];
    const by = (rows: Row[], ref: string) => rows.find((r) => r.ref === ref)!;

    // Hand-written expectations, line for line, in the sender's order.
    expect(by(first, A.ref).lines.split("\n")).toEqual([CLEAN[4]!.line, ...DIRTY.map((d) => d.after), CLEAN[0]!.line]);
    expect(by(first, C.ref).lines).toBe(DIRTY[3]!.after);
    // The row with nothing to strip is byte-identical, even where a clean line names the host, the key's name or a look-alike.
    expect(by(first, B.ref).lines).toBe(B.lines.join("\n"));
    // Counts and the body size are not written.
    for (const r of [A, B, C]) {
      const row = by(first, r.ref);
      expect([row.received_lines, row.kept_lines, row.dropped_lines, row.invalid_lines, row.body_bytes]).toEqual([r.lines.length, r.lines.length, 0, 0, Buffer.byteLength(r.lines.join("\n"))]);
    }
    // No credential segment is left in any stored row, and every line is still one JSON object with a kind.
    let checked = 0;
    for (const row of first) {
      expect(row.lines.includes(SIGNED) || row.lines.includes(UNSIGNED) || row.lines.includes("playbackUrl\":")).toBe(false);
      for (const line of row.lines.split("\n")) {
        expect((JSON.parse(line) as { kind?: string }).kind).toBeTypeOf("string");
        checked++;
      }
    }
    expect(checked).toBe(A.lines.length + B.lines.length + C.lines.length);
    // Idempotent: the second run left every row exactly as the first did.
    expect(second).toEqual(first);
  });

  it("the backfill and the ingest are ONE rule: every seeded line, through the ingest's screen and value rule, is what the SQL left", async () => {
    const rig = await captureRig();
    const [{ competition_id }] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${rig.fixtureId}`;
    const [{ id: codeId }] = await sql<{ id: string }[]>`select id from fixture_stream_codes where code = ${rig.code}`;
    const lines = [...DIRTY.map((d) => d.before), ...CLEAN.map((c) => c.line)];
    const ref = `R-${randomUUID().replace(/[^0-9A-HJKMNP-TV-Z]/gi, "").toUpperCase().replace(/[ILOU]/g, "7").slice(0, 4)}`;
    const { afterEach } = await seedAndRun({ orgId: rig.auth.orgId, competitionId: competition_id, fixtureId: rig.fixtureId, codeId }, [{ ref, lines }], 1);
    const stored = afterEach[0]![0]!.lines.split("\n");
    let checked = 0;
    for (const [i, line] of lines.entries()) {
      const v = screenRecordLine(line, "Zq9rT4mW2xK7pL1vN8cB3d");
      if (!v.ok) throw new Error(`premise: line ${i} must screen ok`);
      expect(stored[i], `line ${i}`).toBe(scrubPlaybackValues(v.text));
      checked++;
    }
    expect(checked).toBe(DIRTY.length + CLEAN.length);
    expect(stored).toHaveLength(lines.length);
  });
});
