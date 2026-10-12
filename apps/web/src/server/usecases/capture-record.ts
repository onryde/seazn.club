// Capture record upload (spec docs/superpowers/specs/2026-10-12-capture-record-upload-design.md, approved by the owner
// 2026-10-12): `POST /api/v1/capture/codes/{code}/records`, the operator's "Send record to Seazn".
//
// §5's order, after the route's rate limit: auth (401/404, `resolveStreamCode` with the `record` call and NO phone —
// R4), then the body (413 over a limit; 422 only for a body that cannot be read as lines, or has none — P10), then
// each line's screen (the allow-list, then the secret-shaped values), attribution (§6), storage (§9) and the 201. A
// stranger's body is never read: the tok is checked before a byte of it.
//
// Owner ruling RL (2026-10-12): a BAD line is dropped, never the body refused — `keptLines` holds that policy. It is
// counted in `dropped` and, apart, in `invalid_lines` for staff. A dropped line is counted and nothing more — never
// stored (not even hashed), logged, quoted or echoed. The log line here carries ids and counts only.
import { randomInt } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import type { CaptureRecordOk } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { CAPTURE_RECORD_RETENTION_DAYS } from "@/server/relay/config";
import { keptLines, screenRecordLine, tokenTag } from "@/server/relay/domain/capture-record";
import { readRecordBody } from "@/server/relay/record-body";
import { resolveStreamCode, SLOT } from "./stream-codes";

/** P9: Crockford base32, upper-case (no I, L, O or U) — the contract's ok.ref alphabet. */
const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REF_LENGTH = 4;
/** P9: on a unique-index collision the server draws again, as `mintLocked` does. */
const REF_RETRIES = 5;
/** P6: 30 days of 24 h, computed here — a Postgres `interval '30 days'` on a timestamptz is CALENDAR days in the
 *  session's zone, and across a DST change that is 719 or 721 hours. */
const RETENTION_MS = CAPTURE_RECORD_RETENTION_DAYS * 24 * 3_600_000;
const drawRefDefault = (): string => `R-${Array.from({ length: REF_LENGTH }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join("")}`;

function isRefCollision(err: unknown): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === "23505" && e.constraint_name === "capture_records_ref_key";
}

const MASK = "***";
/** The session ids a line set names (a uuid sid, lower-cased): the mask names none. */
const sidsOf = (lines: readonly { sid?: string | null }[]): string[] =>
  [...new Set(lines.flatMap((l) => (typeof l.sid === "string" && l.sid !== MASK ? [l.sid.toLowerCase()] : [])))];

/** `drawRef` is the test seam for P9's redraw; production draws at random. */
export type RecordDeps = { drawRef?: () => string };

export async function postCaptureRecord(
  rawCode: string, tok: string, req: Request, now: Date, deps: RecordDeps = {},
): Promise<CaptureRecordOk> {
  const code = await resolveStreamCode(rawCode, tok, "record", null, now);

  const body = await readRecordBody(req);
  if (!body.ok) throw new CaptureRefusalError(body.code === "too_large" ? 413 : 422, body.code, body.message);
  // P10: no non-empty line is a body with nothing in it — the one 422 a readable body can still earn.
  if (body.lines.length === 0) throw new CaptureRefusalError(422, "invalid", "the record has no lines");
  const screened = body.lines.map((text) => screenRecordLine(text, tok));
  const good = screened.flatMap((s) => (s.ok ? [s.line] : []));

  // §6 A1 (Q9): the sessions a pairing of THIS code joined, read now — only among the sessions the good lines name
  // (a bad line is dropped whatever its sid, so its sid is never looked up).
  const named = sidsOf(good);
  const ofCode = named.length === 0 ? [] : await sql<{ id: string }[]>`
    select s.id from fixture_stream_sessions s join fixture_stream_pairings p on p.id = s.pairing_id
     where p.code_id = ${code.codeId} and s.id = any(${named}::uuid[])`;
  const sessionsOfCode = new Set(ofCode.map((r) => r.id));
  // §6 A2: T(code) is every tok issued for the code — one today, the Bearer that sent the record (§0.1).
  const keep = keptLines(screened, { sessionsOfCode, tagsOfCode: new Set([tokenTag(tok)]) });
  // keptLines keeps only an `ok` verdict, which is only ever read from a decoded line; the filter restates both in the
  // safe direction, so no reading of `keep` can ever store a bad line.
  const keptPairs = screened.flatMap((s, i) => {
    const text = body.lines[i];
    return keep[i] && s.ok && typeof text === "string" ? [{ text, line: s.line }] : [];
  });
  const keptTexts = keptPairs.map((p) => p.text);
  const linked = sidsOf(keptPairs.map((p) => p.line));
  // A1 kept a uuid-sid line only when its session is the code's, so every link is one A1 read above.
  if (linked.some((id) => !sessionsOfCode.has(id))) throw new RangeError("postCaptureRecord: a kept sid outside the code's sessions");
  const received = body.lines.length;
  const kept = keptTexts.length;
  const dropped = received - kept;
  const invalid = screened.filter((s) => !s.ok).length;

  const drawRef = deps.drawRef ?? drawRefDefault;
  const stored = await sql.begin(async (tx) => {
    const [fixture] = await tx<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${code.fixtureId}`;
    // The code row's FK cascades from its fixture, so a resolved code always has one.
    if (!fixture) throw new RangeError("postCaptureRecord: the code's fixture is gone");
    const { id, ref } = await insertRecord(tx, drawRef, {
      orgId: code.orgId, competitionId: fixture.competition_id, fixtureId: code.fixtureId, codeId: code.codeId,
      received, kept, dropped, invalid, bodyBytes: body.bodyBytes, lines: keptTexts.join("\n"), now,
    });
    for (const sessionId of linked) await tx`insert into capture_record_sessions (record_id, session_id) values (${id}, ${sessionId})`;
    return { id, ref };
  });
  log.info({ codeId: code.codeId, fixtureId: code.fixtureId, recordId: stored.id, ref: stored.ref, received, kept, dropped, invalid }, "capture record stored");
  return { ref: stored.ref, kept, dropped };
}

async function insertRecord(tx: Tx, drawRef: () => string, r: {
  orgId: string; competitionId: string; fixtureId: string; codeId: string; received: number; kept: number; dropped: number;
  invalid: number; bodyBytes: number; lines: string; now: Date;
}): Promise<{ id: string; ref: string }> {
  for (let attempt = 0; ; attempt++) {
    const ref = drawRef();
    try {
      const [row] = await tx.savepoint((sp) => sp<{ id: string }[]>`
        insert into capture_records (org_id, competition_id, fixture_id, code_id, slot, ref, received_lines, kept_lines,
                                     dropped_lines, invalid_lines, body_bytes, lines, created_at, expires_at)
        values (${r.orgId}, ${r.competitionId}, ${r.fixtureId}, ${r.codeId}, ${SLOT}, ${ref}, ${r.received}, ${r.kept},
                ${r.dropped}, ${r.invalid}, ${r.bodyBytes}, ${r.lines}, ${r.now},
                ${new Date(r.now.getTime() + RETENTION_MS)})
        returning id`);
      return { id: row!.id, ref };
    } catch (err) {
      if (isRefCollision(err) && attempt < REF_RETRIES) continue;
      throw err;
    }
  }
}
