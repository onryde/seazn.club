// Capture record upload (spec docs/superpowers/specs/2026-10-12-capture-record-upload-design.md, approved by the owner
// 2026-10-12): `POST /api/v1/capture/codes/{code}/records`, the operator's "Send record to Seazn".
//
// §5's order, after the route's rate limit: auth (401/404, `resolveStreamCode` with the `record` call and NO phone —
// R4), then size (413), then shape and the allow-list (422), then the secret-shaped values (422), then attribution
// (§6), storage (§9) and the 201. A stranger's body is never read: the tok is checked before a byte of it.
//
// A dropped line is counted and nothing more — never stored (not even hashed), logged, quoted or echoed. The log line
// here carries ids and counts only.
import { randomInt } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import { CaptureRefusalError } from "@/server/api-v1/capture-http";
import type { CaptureRecordOk } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";
import { CAPTURE_RECORD_RETENTION_DAYS } from "@/server/relay/config";
import { attributeLines, tokenTag, validateRecordLines } from "@/server/relay/domain/capture-record";
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
  const valid = validateRecordLines(body.lines, tok);
  if (!valid.ok) throw new CaptureRefusalError(422, "invalid", valid.message);

  // §6 A1 (Q9): the sessions a pairing of THIS code joined, read now — only among the sessions the lines name.
  const named = sidsOf(valid.lines);
  const ofCode = named.length === 0 ? [] : await sql<{ id: string }[]>`
    select s.id from fixture_stream_sessions s join fixture_stream_pairings p on p.id = s.pairing_id
     where p.code_id = ${code.codeId} and s.id = any(${named}::uuid[])`;
  const sessionsOfCode = new Set(ofCode.map((r) => r.id));
  // §6 A2: T(code) is every tok issued for the code — one today, the Bearer that sent the record (§0.1).
  const keep = attributeLines(valid.lines, { sessionsOfCode, tagsOfCode: new Set([tokenTag(tok)]) });
  const keptTexts = body.lines.filter((_, i) => keep[i]);
  const linked = sidsOf(valid.lines.filter((_, i) => keep[i]));
  // A1 kept a uuid-sid line only when its session is the code's, so every link is one A1 read above.
  if (linked.some((id) => !sessionsOfCode.has(id))) throw new RangeError("postCaptureRecord: a kept sid outside the code's sessions");
  const received = body.lines.length;
  const kept = keptTexts.length;
  const dropped = received - kept;

  const drawRef = deps.drawRef ?? drawRefDefault;
  const stored = await sql.begin(async (tx) => {
    const [fixture] = await tx<{ competition_id: string }[]>`
      select d.competition_id from fixtures f join divisions d on d.id = f.division_id where f.id = ${code.fixtureId}`;
    // The code row's FK cascades from its fixture, so a resolved code always has one.
    if (!fixture) throw new RangeError("postCaptureRecord: the code's fixture is gone");
    const { id, ref } = await insertRecord(tx, drawRef, {
      orgId: code.orgId, competitionId: fixture.competition_id, fixtureId: code.fixtureId, codeId: code.codeId,
      received, kept, dropped, bodyBytes: body.bodyBytes, lines: keptTexts.join("\n"), now,
    });
    for (const sessionId of linked) await tx`insert into capture_record_sessions (record_id, session_id) values (${id}, ${sessionId})`;
    return { id, ref };
  });
  log.info({ codeId: code.codeId, fixtureId: code.fixtureId, recordId: stored.id, ref: stored.ref, received, kept, dropped }, "capture record stored");
  return { ref: stored.ref, kept, dropped };
}

async function insertRecord(tx: Tx, drawRef: () => string, r: {
  orgId: string; competitionId: string; fixtureId: string; codeId: string; received: number; kept: number; dropped: number;
  bodyBytes: number; lines: string; now: Date;
}): Promise<{ id: string; ref: string }> {
  for (let attempt = 0; ; attempt++) {
    const ref = drawRef();
    try {
      const [row] = await tx.savepoint((sp) => sp<{ id: string }[]>`
        insert into capture_records (org_id, competition_id, fixture_id, code_id, slot, ref, received_lines, kept_lines,
                                     dropped_lines, body_bytes, lines, created_at, expires_at)
        values (${r.orgId}, ${r.competitionId}, ${r.fixtureId}, ${r.codeId}, ${SLOT}, ${ref}, ${r.received}, ${r.kept},
                ${r.dropped}, ${r.bodyBytes}, ${r.lines}, ${r.now},
                ${new Date(r.now.getTime() + RETENTION_MS)})
        returning id`);
      return { id: row!.id, ref };
    } catch (err) {
      if (isRefCollision(err) && attempt < REF_RETRIES) continue;
      throw err;
    }
  }
}
