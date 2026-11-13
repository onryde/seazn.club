import "server-only";
// Match Day codes (capture S4 design 2026-11-07 §3, §9; MD-1 Task 1): an organiser-minted, one-day QR that lets the
// Seazn Club app list a competition's matches and open their scoring links. Mint, list and withdraw are session-editor
// acts on the desk; resolving a token is the md_ routes' own door (they never go through api-v1/auth.ts, which refuses
// an md_ bearer everywhere else).
//
// Modelled on device-links.ts (the token, its hash and its sealed envelope under DEVICE_LINK_KEK) and stream-codes.ts
// (V430's RLS: the V509 tables are FORCE RLS with no policy, so every read and write here is on the non-tenant `sql`,
// with the org a WHERE the code writes — from the competition on a mint, from the code row on a resolve).
//
// The token never leaves this module except inside the URL a session editor is shown, and it is never logged.
import { createHash, randomBytes } from "node:crypto";
import { dayKeyInTz, ymdAddDays, zonedTimeToUtc } from "@seazn/engine/scheduling";
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { siteOrigin } from "@/lib/site-origin";
import { resolveVenueTz } from "@/lib/tz";
import { isEditorRole } from "@/lib/types";
import { assertUuid, type AuthCtx } from "@/server/api-v1/auth";
import { hasValidKek, openWith, sealWith } from "@/server/relay/crypto";
import { log } from "@/server/logger";

export const MATCH_DAY_CODE_PREFIX = "md_";

export type MatchDayScope =
  | { kind: "competition" }
  | { kind: "venue"; venueId: string }
  | { kind: "courts"; courtIds: string[] };

export type MatchDayCodeRow = {
  id: string;
  orgId: string;
  competitionId: string;
  scope: MatchDayScope;
  canApprove: boolean;
  /** "Call matches to courts" (Task 8e, owner 2026-11-13): the code may call a match in its scope onto a court in its scope,
   *  and Undo the call. Off unless ticked at mint. */
  canCall: boolean;
  /** YYYY-MM-DD, the day the organiser picked, in `tz`. */
  day: string;
  tz: string;
  opensAt: Date;
  expiresAt: Date;
  issuedBy: string;
  revokedAt: Date | null;
};

export type MatchDayRefusal = "MD_UNKNOWN" | "MD_WITHDRAWN" | "MD_ENDED" | "MD_NOT_OPEN";

export type MatchDayUse =
  | { kind: "open"; fixtureId: string }
  | { kind: "approve"; stageId: string; approval: "swiss" | "draw" }
  | { kind: "call" | "undo_call"; fixtureId: string };

const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
const mintToken = (): string => MATCH_DAY_CODE_PREFIX + randomBytes(32).toString("base64url");
const urlOf = (token: string): string => `${siteOrigin()}/day/${token}`;

/** Owner ruling Q1 (device links, 2026-09-23), same key: a server without DEVICE_LINK_KEK fails CLOSED with a
 *  configuration error, never a bare 500 and never an unsealed code. */
const KEK_MISSING = "Match Day codes are not configured on this server (DEVICE_LINK_KEK missing or malformed)";

function sealToken(token: string): Buffer {
  try {
    return sealWith("DEVICE_LINK_KEK", token);
  } catch {
    throw new HttpError(503, KEK_MISSING, "DEVICE_LINK_KEK_MISSING");
  }
}

function openToken(enc: Uint8Array): string {
  if (!hasValidKek("DEVICE_LINK_KEK")) throw new HttpError(503, KEK_MISSING, "DEVICE_LINK_KEK_MISSING");
  return openWith("DEVICE_LINK_KEK", enc); // a tamper/wrong-key failure is a plain Error, never this 503
}

/** Editors only, session only: an API key, a device link and a Match Day code never manage Match Day codes. */
function requireSessionEditor(auth: AuthCtx): void {
  if (auth.via !== "session" || !auth.userId) {
    throw new HttpError(403, "Match Day codes can only be managed with a session login");
  }
  if (!isEditorRole(auth.role)) throw new HttpError(403, "Insufficient permissions");
}

type DbRow = {
  id: string;
  org_id: string;
  competition_id: string;
  scope_kind: "competition" | "venue" | "courts";
  venue_id: string | null;
  court_ids: string[] | null;
  can_approve: boolean;
  can_call: boolean;
  day: string;
  tz: string;
  opens_at: Date;
  expires_at: Date;
  issued_by: string;
  revoked_at: Date | null;
};

// `day::text`: a bare `date` comes back as a JS Date at local midnight, which is not the organiser's YYYY-MM-DD. A function,
// not a module-level fragment: a fragment would bind to whichever client existed at import.
const cols = () => sql`id, org_id, competition_id, scope_kind, venue_id, court_ids, can_approve, can_call, day::text as day, tz,
                       opens_at, expires_at, issued_by, revoked_at`;

function scopeOf(r: DbRow): MatchDayScope {
  if (r.scope_kind === "venue") return { kind: "venue", venueId: r.venue_id! };
  if (r.scope_kind === "courts") return { kind: "courts", courtIds: [...r.court_ids!] };
  return { kind: "competition" };
}

function toRow(r: DbRow): MatchDayCodeRow {
  return {
    id: r.id,
    orgId: r.org_id,
    competitionId: r.competition_id,
    scope: scopeOf(r),
    canApprove: r.can_approve,
    canCall: r.can_call,
    day: r.day,
    tz: r.tz,
    opensAt: r.opens_at,
    expiresAt: r.expires_at,
    issuedBy: r.issued_by,
    revokedAt: r.revoked_at,
  };
}

/** The competition and its org's zone; another org's competition reads exactly like a missing one. */
async function competitionZone(auth: AuthCtx, competitionId: string): Promise<string> {
  const [row] = await sql<{ org_id: string; timezone: string | null }[]>`
    select c.org_id, o.timezone from competitions c join organizations o on o.id = c.org_id
     where c.id = ${competitionId}`;
  if (!row || row.org_id !== auth.orgId) throw new HttpError(404, "competition not found");
  // Plan decision (MD-1 globals): one zone per code, the competition's — the org's venue zone. A competition whose
  // divisions sit in different zones is not handled in v1.
  return resolveVenueTz(null, row.timezone);
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** The day's bounds in `tz`: 00:00 and 24:00 of `day`. A malformed or impossible date (2026-02-30) is a 422. */
function dayBounds(day: string, tz: string): { opensAt: Date; expiresAt: Date } {
  const [y, m, d] = day.split("-").map(Number);
  const probe = new Date(Date.UTC(y!, m! - 1, d!));
  if (!YMD.test(day) || probe.toISOString().slice(0, 10) !== day) throw new HttpError(422, "day must be a real date, YYYY-MM-DD");
  return {
    opensAt: new Date(zonedTimeToUtc(day, "00:00", tz)),
    expiresAt: new Date(zonedTimeToUtc(ymdAddDays(day, 1), "00:00", tz)),
  };
}

/** The scope as stored: a venue or every court must be the org's own (and not archived); courts are de-duplicated. */
async function checkedScope(auth: AuthCtx, scope: MatchDayScope): Promise<{ venueId: string | null; courtIds: string[] | null }> {
  if (scope.kind === "competition") return { venueId: null, courtIds: null };
  if (scope.kind === "venue") {
    const [v] = await sql`select 1 from venues where id = ${scope.venueId} and org_id = ${auth.orgId} and archived_at is null`;
    if (!v) throw new HttpError(422, "venue is not one of this organisation's venues");
    return { venueId: scope.venueId, courtIds: null };
  }
  const courtIds = [...new Set(scope.courtIds)];
  if (courtIds.length === 0) throw new HttpError(422, "a courts code needs at least one court");
  const [found] = await sql<{ n: number }[]>`
    select count(*)::int as n from courts where id in ${sql(courtIds)} and org_id = ${auth.orgId} and archived_at is null`;
  if (found!.n !== courtIds.length) throw new HttpError(422, "every court must be one of this organisation's courts");
  return { venueId: null, courtIds };
}

/**
 * Mint a Match Day code (§3): its scope, its day (default: today in the competition's zone), the "can approve
 * draws" tick and the "Call matches to courts" tick (Task 8e; off when not given). The token is sealed BEFORE the write, so a missing DEVICE_LINK_KEK writes nothing. A day already over
 * is refused: such a code could never open.
 */
export async function mintMatchDayCode(
  auth: AuthCtx,
  competitionId: string,
  input: { scope: MatchDayScope; day?: string; canApprove: boolean; canCall?: boolean },
): Promise<{ row: MatchDayCodeRow; url: string }> {
  requireSessionEditor(auth);
  const tz = await competitionZone(auth, competitionId);
  const now = new Date();
  const day = input.day ?? dayKeyInTz(now.getTime(), tz);
  const { opensAt, expiresAt } = dayBounds(day, tz);
  if (expiresAt.getTime() <= now.getTime()) throw new HttpError(422, "that day is already over");
  const { venueId, courtIds } = await checkedScope(auth, input.scope);
  const token = mintToken();
  const sealed = sealToken(token);
  const [created] = await sql<DbRow[]>`
    insert into match_day_codes (org_id, competition_id, scope_kind, venue_id, court_ids, can_approve, can_call, day, tz,
                                 opens_at, expires_at, tok_hash, token_enc, issued_by)
    values (${auth.orgId}, ${competitionId}, ${input.scope.kind}, ${venueId}, ${courtIds}::uuid[], ${input.canApprove},
            ${input.canCall ?? false}, ${day}::date, ${tz},
            ${opensAt}, ${expiresAt}, ${hashToken(token)}, ${sealed}, ${auth.userId})
    returning ${cols()}`;
  return { row: toRow(created!), url: urlOf(token) };
}

/** The competition's codes that can still open — live and not yet open — each with its URL re-opened from the
 *  envelope, so the desk can show the same QR again. Soonest day first, then oldest mint. A code whose envelope will not
 *  open (or opens to another token) is still listed, with `url: null`: its printed QR keeps working (the door resolves
 *  by `tok_hash`), so the desk must keep its Withdraw (the controller's ruling on the MD-1 final review's I3). */
export async function listMatchDayCodes(
  auth: AuthCtx,
  competitionId: string,
): Promise<Array<MatchDayCodeRow & { url: string | null }>> {
  requireSessionEditor(auth);
  await competitionZone(auth, competitionId);
  const rows = await sql<(DbRow & { token_enc: Uint8Array; tok_hash: string })[]>`
    select ${cols()}, token_enc, tok_hash from match_day_codes
     where competition_id = ${competitionId} and org_id = ${auth.orgId}
       and revoked_at is null and expires_at > ${new Date()}
     order by opens_at, created_at, id`;
  return rows.map(({ token_enc, tok_hash, ...r }) => {
    const token = verifiedToken(token_enc, tok_hash, { codeId: r.id, competitionId });
    return { ...toRow(r), url: token === null ? null : urlOf(token) };
  });
}

/**
 * The token a row's envelope opens to, only when it hashes to the row's own `tok_hash` (MD-1 review I2; the
 * device-links.ts re-show precedent). The envelope has no AAD, so a swapped or restored `token_enc` would otherwise
 * show the desk another code's working QR under this row's scope and day. A row that will not open, or opens to
 * another token, has no QR to show (null) and is logged without the token, so one bad row never fails the whole list.
 * A missing KEK is not a bad row: it stays the 503 `openToken` throws.
 */
function verifiedToken(enc: Uint8Array, tokHash: string, ids: { codeId: string; competitionId: string }): string | null {
  let token: string;
  try {
    token = openToken(enc);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    log.warn(ids, "match day code: sealed token will not open; listed without its QR");
    return null;
  }
  if (hashToken(token) === tokHash) return token;
  log.warn(ids, "match day code: sealed token does not match the row's token hash; listed without its QR");
  return null;
}

/** The org a code belongs to, for the withdraw route's door (404 when there is no such code). */
export async function matchDayCodeOrg(codeId: string): Promise<string> {
  assertUuid(codeId, "match day code");
  const [row] = await sql<{ org_id: string }[]>`select org_id from match_day_codes where id = ${codeId}`;
  if (!row) throw new HttpError(404, "match day code not found");
  return row.org_id;
}

/** Withdraw a code (§3 "Revocable on the web at any time"). Idempotent: a second withdraw keeps the first instant.
 *  Links the code already opened are NOT touched — the scoring links outlive the code (§3). */
export async function revokeMatchDayCode(auth: AuthCtx, codeId: string): Promise<void> {
  requireSessionEditor(auth);
  assertUuid(codeId, "match day code");
  const [row] = await sql`
    update match_day_codes set revoked_at = coalesce(revoked_at, now())
     where id = ${codeId} and org_id = ${auth.orgId}
     returning id`;
  if (!row) throw new HttpError(404, "match day code not found");
}

/**
 * Resolve a scanned token at `now`. Withdrawn wins over ended (the organiser's act is the truer answer); a code whose
 * day has not started is MD_NOT_OPEN with its `opensAt`, never MD_ENDED (Review Focus 1). `expires_at` itself belongs
 * to the next day.
 */
export async function resolveMatchDayCode(
  token: string,
  now: Date,
): Promise<{ ok: true; code: MatchDayCodeRow } | { ok: false; refusal: MatchDayRefusal; opensAt?: Date }> {
  if (!token.startsWith(MATCH_DAY_CODE_PREFIX)) return { ok: false, refusal: "MD_UNKNOWN" };
  const [r] = await sql<DbRow[]>`select ${cols()} from match_day_codes where tok_hash = ${hashToken(token)}`;
  if (!r) return { ok: false, refusal: "MD_UNKNOWN" };
  const code = toRow(r);
  if (code.revokedAt !== null) return { ok: false, refusal: "MD_WITHDRAWN" };
  if (now.getTime() >= code.expiresAt.getTime()) return { ok: false, refusal: "MD_ENDED" };
  if (now.getTime() < code.opensAt.getTime()) return { ok: false, refusal: "MD_NOT_OPEN", opensAt: code.opensAt };
  return { ok: true, code };
}

/** The actor a code acts as: the issuing organiser vouches for it (the device-link attribution rule), with no role,
 *  so no organiser gate passes on it. */
export function matchDayActor(code: MatchDayCodeRow): AuthCtx {
  return { orgId: code.orgId, via: "match_day_code", userId: code.issuedBy, role: null, keyId: null };
}

/** Log a match opened, an approval made, or a call or its Undo (Task 8e) against the code that did it (§3). On the pooled client, or on `db`: a
 *  transaction holding the pool's own role (the table is sealed: `withTenant`'s epilogue, used by the open alone), so the row commits
 *  or rolls back with the write it logs (MD-1 fix M4). */
export async function logMatchDayUse(codeId: string, use: MatchDayUse, db?: Tx): Promise<void> {
  const q = db ?? sql;
  if (use.kind !== "approve") {
    await q`insert into match_day_code_uses (code_id, kind, fixture_id) values (${codeId}, ${use.kind}, ${use.fixtureId})`;
    return;
  }
  await q`
    insert into match_day_code_uses (code_id, kind, stage_id, approval)
    values (${codeId}, 'approve', ${use.stageId}, ${use.approval})`;
}
