import "server-only";
// Device links (doc 13 §7, PROMPT-21; scorer sheets §4): account-less,
// fixture-scoped scoring tokens. Ensure (re-show the fixture's sealed link, or
// mint one), Revoke & reissue, and revoke are session-editor actions; the
// token's own auth path lives in api-v1/auth.ts (requireFixtureActor).
// Capabilities are strictly ⊂ scorer: append + void-own-link-events
// pre-finalize, read fixture state/events, realtime token — nothing else.
import { createHash, randomBytes } from "node:crypto";
import { sql, withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { hasValidKek, openWith, sealWith } from "@/server/relay/crypto";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";

export const DEVICE_LINK_PREFIX = "dl_";

export function hashDeviceLinkToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mint a new device-link secret. Stored twice: its sha256 (the lookup key
 *  the scoring door resolves by) and its sealed envelope (`secret_enc`, which
 *  ensure re-opens so a printed QR can be shown again). */
export function mintDeviceLinkSecret(): string {
  return DEVICE_LINK_PREFIX + randomBytes(32).toString("base64url");
}

export interface DeviceLinkRow {
  id: string;
  fixture_id: string;
  label: string | null;
  issued_by: string;
  /** null = no clock: a sealed link lives until its fixture is over (V417). */
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const COLS = ["id", "fixture_id", "label", "issued_by", "expires_at", "revoked_at", "created_at"] as const;

/**
 * End of the CURRENT day in the fixture's venue timezone (doc 13 §7:
 * V305 venue lane: division override → org timezone → UTC). The self-check-in
 * QR (checkin-token.ts) dies here. Device links no longer do: a sealed link
 * has no clock and lives until its fixture is over (scorer sheets §4.1).
 */
export function endOfLocalDay(now: Date, tz: string): Date {
  let parts: { year: number; month: number; day: number };
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const [year, month, day] = fmt.format(now).split("-").map(Number);
    parts = { year, month, day };
  } catch {
    // Unknown tz string → UTC fallback.
    parts = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }
  // Next local midnight: take local date, add one day, find the UTC instant
  // of that local 00:00 by probing the tz offset at an approximate instant.
  const approxNextMidnightUtc = Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0);
  const offsetMinutes = tzOffsetMinutes(new Date(approxNextMidnightUtc), tz);
  return new Date(approxNextMidnightUtc - offsetMinutes * 60_000);
}

/** Offset (minutes east of UTC) of `tz` at `instant`. */
function tzOffsetMinutes(instant: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second),
    );
    return Math.round((asUtc - instant.getTime()) / 60_000);
  } catch {
    return 0;
  }
}

function requireSessionEditor(auth: AuthCtx): void {
  // Editors only, session only — a device link must not mint device links,
  // and neither may an API key (api_keys pattern).
  if (auth.via !== "session" || !auth.userId) {
    throw new HttpError(403, "Device links can only be managed with a session login");
  }
}

/** The competition an Event-Pass-lifted gate must be resolved against.
 *
 *  lib/entitlements.ts only consults `competition_passes` when a competition is
 *  in scope, so a gate on a key V393 lifts (`scoring.device_links`) that omits it makes the
 *  pass INVISIBLE — the org pays $29 and is refused on the competition it
 *  bought. Same shape as usecases/officials.ts's `competitionForDivision` (T6).
 *
 *  Pooled `sql`, and deliberately OUTSIDE the `withTenant` callback below:
 *  `resolve` queries the pooled proxy, and issuing that from inside a pinned
 *  tenant transaction asks the pool for a second connection while the first is
 *  still held — the self-deadlock lib/db.ts guards against.
 *
 *  A missing row yields `undefined`, which resolves the gate org-wide (the
 *  pre-V393 behaviour) and the 404 is raised inside the transaction as before. */
async function competitionForFixture(fixtureId: string): Promise<string | undefined> {
  const [row] = await sql<{ competition_id: string }[]>`
    select d.competition_id from fixtures f
    join divisions d on d.id = f.division_id
    where f.id = ${fixtureId}`;
  return row?.competition_id;
}

/** A link is live until its expiry; a sealed link (V417) has none — it lives
 *  until the fixture is over, which the SCORING path enforces (scorer sheets
 *  §4.3), not this clock. `new Date(null)` is the epoch, which is why this is
 *  a function and not an inline comparison (P1). */
export function isLiveExpiry(expiresAt: string | null, now: number = Date.now()): boolean {
  return expiresAt === null || new Date(expiresAt).getTime() > now;
}

/** Serialise every mint/ensure on one fixture. Without it two organisers
 *  printing at once both see "no live link", both mint, and the second revoke
 *  kills the first sheet before it leaves the printer. */
async function lockFixtureLinks(tx: Tx, fixtureId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"device_link:" + fixtureId}))`;
}

/** A finalized or cancelled match has nothing left to score, so no link. */
export const isFinishedFixtureStatus = (status: string): boolean => status === "finalized" || status === "cancelled";

/** The fixture's status; 404 when it is not in `competitionId` (or anywhere
 *  this tenant can see). */
async function linkableStatus(tx: Tx, fixtureId: string, competitionId?: string): Promise<string> {
  const [fixture] = await tx<{ status: string; competition_id: string }[]>`
    select f.status, d.competition_id from fixtures f
    join divisions d on d.id = f.division_id
    where f.id = ${fixtureId}`;
  if (!fixture || (competitionId !== undefined && fixture.competition_id !== competitionId)) {
    throw new HttpError(404, "fixture not found");
  }
  return fixture.status;
}

async function loadLinkableFixture(tx: Tx, fixtureId: string, competitionId?: string): Promise<void> {
  const status = await linkableStatus(tx, fixtureId, competitionId);
  if (isFinishedFixtureStatus(status)) {
    throw new HttpError(422, `fixture is ${status} — nothing left to score`);
  }
}

/** Owner ruling Q1 (2026-09-23): the key is always set, and a server without
 *  it fails CLOSED with a configuration error the organiser can report. It
 *  must not surface as a bare 500 or, worse, as an unsealed link. Only the
 *  paths that need the key go through these; resolving a link by hash does not. */
const KEK_MISSING = "Scoring links are not configured on this server (DEVICE_LINK_KEK missing or malformed)";

function sealSecret(secret: string): Buffer {
  try {
    return sealWith("DEVICE_LINK_KEK", secret);
  } catch {
    throw new HttpError(503, KEK_MISSING, "DEVICE_LINK_KEK_MISSING");
  }
}

function openSecret(enc: Uint8Array): string {
  if (!hasValidKek("DEVICE_LINK_KEK")) {
    throw new HttpError(503, KEK_MISSING, "DEVICE_LINK_KEK_MISSING");
  }
  return openWith("DEVICE_LINK_KEK", enc); // a tamper/wrong-key failure stays a 500 — it is not a config gap
}

/** Revoke every live link on the fixture and mint a sealed, unexpiring one.
 *  Sealed BEFORE any write: a missing DEVICE_LINK_KEK throws with nothing revoked. */
async function mintInTx(
  tx: Tx,
  auth: AuthCtx,
  fixtureId: string,
  label: string | null,
): Promise<DeviceLinkRow & { secret: string }> {
  const secret = mintDeviceLinkSecret();
  const sealed = sealSecret(secret);
  await tx`
    update device_links set revoked_at = now()
    where fixture_id = ${fixtureId} and revoked_at is null`;
  const [created] = await tx<DeviceLinkRow[]>`
    insert into device_links (org_id, fixture_id, token_hash, secret_enc, label, issued_by, expires_at)
    values (${auth.orgId}, ${fixtureId}, ${hashDeviceLinkToken(secret)}, ${sealed},
            ${label}, ${auth.userId}, null)
    returning ${tx(COLS)}`;
  return { ...created, secret };
}

/**
 * Revoke & reissue (scorer sheets §4.2): kill every live link for the fixture
 * — a lost sheet, a phone that walked off — and mint a fresh sealed one. The
 * ONLY path that changes a fixture's QR. Secret returned; re-showable later
 * through ensureDeviceLink.
 */
export async function createDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
  label: string | null,
): Promise<DeviceLinkRow & { secret: string }> {
  requireSessionEditor(auth);
  // 402 for Community, unless an Event Pass covers this fixture's competition.
  await requireFeature(auth.orgId, "scoring.device_links", await competitionForFixture(fixtureId));
  return withTenant(auth.orgId, async (tx) => {
    await lockFixtureLinks(tx, fixtureId);
    await loadLinkableFixture(tx, fixtureId);
    return mintInTx(tx, auth, fixtureId, label);
  });
}

export interface EnsuredDeviceLink {
  row: DeviceLinkRow;
  secret: string;
  /** false = an existing sealed link was re-opened (no write). */
  minted: boolean;
}

async function ensureInTx(
  tx: Tx,
  auth: AuthCtx,
  fixtureId: string,
  label: string | null,
  competitionId?: string,
): Promise<EnsuredDeviceLink> {
  await lockFixtureLinks(tx, fixtureId);
  await loadLinkableFixture(tx, fixtureId, competitionId);
  return ensureLocked(tx, auth, fixtureId, label);
}

/** Re-open the fixture's live sealed link, or mint one. The caller holds the
 *  fixture's link lock and has checked the fixture is linkable. */
async function ensureLocked(tx: Tx, auth: AuthCtx, fixtureId: string, label: string | null): Promise<EnsuredDeviceLink> {
  const [live] = await tx<(DeviceLinkRow & { secret_enc: Uint8Array | null; token_hash: string })[]>`
    select ${tx(COLS)}, secret_enc, token_hash from device_links
    where fixture_id = ${fixtureId} and revoked_at is null
      and (expires_at is null or expires_at > now())
    order by created_at desc limit 1`;
  if (live && live.secret_enc) {
    const { secret_enc, token_hash, ...row } = live;
    const secret = openSecret(secret_enc);
    // Re-shown only if the envelope IS this row's secret (final review M2): one
    // that opens under the KEK but hashes elsewhere — swapped from another row,
    // or written behind the app's back — would print a QR the row does not
    // resolve, or one that scores another match. It falls through to the
    // reissue below, exactly like a missing envelope, and is never returned.
    if (hashDeviceLinkToken(secret) === token_hash) return { row, secret, minted: false };
    log.warn(
      { linkId: row.id, fixtureId },
      "device link: sealed secret does not match the row's token hash; revoking and reissuing",
    );
  }
  // None, a legacy hash-only link (its secret is unrecoverable), or an envelope
  // that is not this row's secret: replace it.
  const { secret, ...row } = await mintInTx(tx, auth, fixtureId, label);
  return { row, secret, minted: true };
}

/**
 * The fixture's scoring link, re-shown if it exists (scorer sheets §4.2). A
 * console hand-over and a reprinted sheet both call this, so neither ever
 * kills a QR already on a court. TBD sides are allowed (D2).
 */
export async function ensureDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
  label: string | null = null,
): Promise<EnsuredDeviceLink> {
  requireSessionEditor(auth);
  await requireFeature(auth.orgId, "scoring.device_links", await competitionForFixture(fixtureId));
  return withTenant(auth.orgId, (tx) => ensureInTx(tx, auth, fixtureId, label));
}

/**
 * The print path: one gate for the competition, one transaction, every
 * fixture's link. Ids are locked in SORTED order so two overlapping prints
 * cannot deadlock on each other's advisory locks. A fixture outside
 * `competitionId` is a 404, never a silent mint. A fixture finished (or
 * cancelled) since the sheet chose it is LEFT OUT of the map rather than
 * refusing the batch — one match finalized mid-print must not cost the
 * organiser every other sheet (controller ruling, scorer sheets T8).
 */
export async function ensureDeviceLinks(
  auth: AuthCtx,
  competitionId: string,
  fixtureIds: readonly string[],
): Promise<Map<string, EnsuredDeviceLink>> {
  requireSessionEditor(auth);
  await requireFeature(auth.orgId, "scoring.device_links", competitionId);
  const out = new Map<string, EnsuredDeviceLink>();
  await withTenant(auth.orgId, async (tx) => {
    for (const id of [...new Set(fixtureIds)].sort()) {
      await lockFixtureLinks(tx, id);
      if (isFinishedFixtureStatus(await linkableStatus(tx, id, competitionId))) continue;
      out.set(id, await ensureLocked(tx, auth, id, null));
    }
  });
  return out;
}

/** Revoke one link (immediate 401 for the holder). */
export async function revokeDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
  linkId: string,
): Promise<DeviceLinkRow> {
  requireSessionEditor(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<DeviceLinkRow[]>`
      update device_links set revoked_at = coalesce(revoked_at, now())
      where id = ${linkId} and fixture_id = ${fixtureId}
      returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "device link not found");
    return row;
  });
}

/** The fixture's active link, if any (organiser console; no secret). */
export async function getActiveDeviceLink(
  auth: AuthCtx,
  fixtureId: string,
): Promise<DeviceLinkRow | null> {
  requireSessionEditor(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<DeviceLinkRow[]>`
      select ${tx(COLS)} from device_links
      where fixture_id = ${fixtureId} and revoked_at is null and (expires_at is null or expires_at > now())
      order by created_at desc limit 1`;
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// Token resolution (the auth path; superuser read like api_keys — RLS-bounded
// reads happen in the use-cases proper once the org is pinned).
// ---------------------------------------------------------------------------

export interface ResolvedDeviceLink {
  id: string;
  org_id: string;
  fixture_id: string;
  issued_by: string;
}

/**
 * THE device-link fixture-ownership predicate (doc 13 §7) — one copy, two
 * askers. `requireFixtureActor` turns a false into 403 "This device link is
 * for a different fixture"; the public realtime-token route turns it into
 * "this caller is not an official of this fixture". Both used to spell it out
 * for themselves, so a change to one was not a change to the other.
 */
export function deviceLinkCoversFixture(
  link: Pick<ResolvedDeviceLink, "fixture_id">,
  fixtureId: string,
): boolean {
  return link.fixture_id === fixtureId;
}

/**
 * Request-level form of {@link deviceLinkCoversFixture} for the caller that
 * needs a boolean and must NOT throw: the public realtime-token route, where
 * an absent/expired/foreign link just means "not eligible this way" and the
 * request falls through to the plan check. Never let it widen — a `true` here
 * mints a subscriber token for a fixture that may be in a private
 * competition.
 */
export async function requestDeviceLinkCoversFixture(
  req: Request,
  fixtureId: string,
): Promise<boolean> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith(`Bearer ${DEVICE_LINK_PREFIX}`)) return false;
  try {
    const link = await resolveDeviceLinkToken(header.slice("Bearer ".length).trim());
    return deviceLinkCoversFixture(link, fixtureId);
  } catch {
    return false;
  }
}

/**
 * Resolve a dl_ bearer token. Expired/revoked → 401 with a DISTINCT code the
 * pad renders as "link expired, ask the organiser" (doc 13 §7).
 */
export async function resolveDeviceLinkToken(token: string): Promise<ResolvedDeviceLink> {
  const [link] = await sql<
    (ResolvedDeviceLink & { expires_at: string | null; revoked_at: string | null })[]
  >`
    select id, org_id, fixture_id, issued_by, expires_at, revoked_at
    from device_links where token_hash = ${hashDeviceLinkToken(token)} limit 1`;
  if (!link) throw new HttpError(401, "Invalid device link", "LINK_INVALID");
  if (link.revoked_at) {
    throw new HttpError(401, "This device link was revoked — ask the organiser", "LINK_REVOKED");
  }
  if (!isLiveExpiry(link.expires_at)) {
    throw new HttpError(401, "This device link has expired — ask the organiser", "LINK_EXPIRED");
  }
  return { id: link.id, org_id: link.org_id, fixture_id: link.fixture_id, issued_by: link.issued_by };
}
