import "server-only";
// Linked external board accounts (Lichess first). The row carries the
// player's OAuth TOKEN AT REST (chess design §3.1, V451) — this reverses the
// identity-only decision V405 shipped under, because our server submits both
// players' moves with their own tokens. The token is sealed by
// external-play/secrets.ts; `access_token_enc` is named HERE and nowhere else
// (enc-boundary.test.ts holds every other file to that). Touched only via
// privileged `sql` (FORCE RLS with no app_user policy).
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { LICHESS_OAUTH_SCOPES, LICHESS_TOKEN_URL } from "@/lib/oauth";
import { LICHESS_TIMEOUT_MS } from "@/server/external-play/window";
import { openPlayerToken, sealPlayerToken } from "@/server/external-play/secrets";
import { log } from "@/server/logger";
import { hasValidKek } from "@/server/relay/crypto";

/** V451's second unique constraint — a Lichess account can only ever be
 *  linked to ONE Seazn user. */
const ALREADY_LINKED_CONSTRAINT = "user_external_accounts_provider_external_user_id_key";

/** The grant design §3.1 asks for: submit moves (`board:play`), create the
 *  challenge (`challenge:write`) and list White's challenges when recovering a
 *  crashed create (`challenge:read`). Any linked row that does not carry EVERY
 *  one of these owes a re-consent, whatever else it carries.
 *
 *  DERIVED from `lib/oauth.ts`'s `LICHESS_OAUTH_SCOPES`, which is the string
 *  the OAuth start actually sends, so the two cannot drift. The dependency
 *  runs this way round on purpose: this module already imports `lib/oauth`
 *  for `LICHESS_TOKEN_URL`, and having `oauth.ts` import PLAY_SCOPES back
 *  would close an import CYCLE whose top-level `.join(" ")` evaluates before
 *  this module finishes initialising, depending on which side loads first. */
export const PLAY_SCOPES: readonly string[] = LICHESS_OAUTH_SCOPES.split(" ");

export type LichessLink = {
  externalUserId: string;
  username: string;
  scopes: string[];
  /** null => linked under the identity-only flow; re-consent owed before play. */
  consentedAt: Date | null;
};

export async function getLichessLink(userId: string): Promise<LichessLink | null> {
  const rows = await sql<
    { external_user_id: string; username: string; scopes: string[]; consented_at: Date | null }[]
  >`
    select external_user_id, username, scopes, consented_at
      from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
  const row = rows[0];
  if (!row) return null;
  return {
    externalUserId: row.external_user_id,
    username: row.username,
    scopes: row.scopes,
    consentedAt: row.consented_at,
  };
}

/** Why a STORED token could not be opened. A classification an operator can
 *  act on — never the token, never the ciphertext, never the crypto error's
 *  text: `key_unavailable` is LICHESS_TOKEN_KEK unset or malformed;
 *  `decrypt_failed` is a valid key that does not open this row (rotated,
 *  wrong, or the ciphertext was damaged). */
type TokenOpenFailure = "key_unavailable" | "decrypt_failed";

/** The stored token, opened. `null` means there is NO token — no link, or a
 *  legacy identity-only row — and is the only "absent" answer. A row that
 *  HOLDS a token we cannot open is a different fact (review T2-I2: unlink's
 *  old `.catch(() => null)` made a missing or rotated key look like "nothing
 *  stored"), so it comes back as a failure each caller must handle. */
async function readStoredToken(
  userId: string,
): Promise<{ token: string } | { failure: TokenOpenFailure } | null> {
  const rows = await sql<{ access_token_enc: Uint8Array | null }[]>`
    select access_token_enc from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
  return openSealed(rows[0]?.access_token_enc ?? null);
}

async function openSealed(enc: Uint8Array | null): Promise<{ token: string } | { failure: TokenOpenFailure } | null> {
  if (!enc) return null;
  try {
    return { token: await openPlayerToken(Buffer.from(enc).toString("base64")) };
  } catch {
    return { failure: hasValidKek("LICHESS_TOKEN_KEK") ? "decrypt_failed" : "key_unavailable" };
  }
}

/** The plaintext token, or null when there is none (no link, or a legacy
 *  identity-only row). Every caller treats null as "cannot play yet", never
 *  as "play without a token".
 *
 *  A token that is stored but cannot be opened fails CLOSED with its own
 *  code, LICHESS_TOKEN_UNAVAILABLE — NOT a re-consent prompt: re-linking
 *  cannot fix an operator's key, and sending a player round an OAuth trip
 *  for it would mint a fresh grant we then could not open either. */
export async function getLichessAccessToken(userId: string): Promise<string | null> {
  const stored = await readStoredToken(userId);
  if (stored === null) return null;
  if ("failure" in stored) {
    log.error(
      { userId, reason: stored.failure },
      "lichess: the player's stored token cannot be opened — online play refused",
    );
    throw new HttpError(
      503,
      "Online play is unavailable right now because of a problem on Seazn's side. Please try again later.",
      "LICHESS_TOKEN_UNAVAILABLE",
    );
  }
  return stored.token;
}

/** Lichess's `/api/token`, on the same base the Board API uses (LICHESS_BASE_URL, read per call; lichess.org when
 *  unset — the same URL as `LICHESS_TOKEN_URL`), so a revoke reaches the e2e's Lichess fixture as every other call
 *  does. */
function lichessTokenUrl(): string {
  const base = process.env.LICHESS_BASE_URL;
  return base ? `${base.replace(/\/$/, "")}/api/token` : LICHESS_TOKEN_URL;
}

/** Best-effort `DELETE /api/token`: null when Lichess accepted it, else why
 *  not — a classification, so a caller can report a grant left live without
 *  ever handling the token. */
async function revokeAtLichess(
  token: string,
): Promise<null | { reason: "revoke_rejected"; status: number } | { reason: "revoke_unreachable" }> {
  try {
    const res = await fetch(lichessTokenUrl(), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(LICHESS_TIMEOUT_MS),
    });
    return res.ok ? null : { reason: "revoke_rejected", status: res.status };
  } catch {
    return { reason: "revoke_unreachable" };
  }
}

/** Upsert on `(user_id, provider)`. V451's second unique constraint,
 *  `(provider, external_user_id)`, means a given Lichess account links to ONE
 *  Seazn user; a different user claiming an already-linked account trips it,
 *  and it is surfaced as a typed 409 rather than a raw 23505. Writing the
 *  token also writes `consented_at = now()`: V451's
 *  `user_external_accounts_consent_token_check` refuses one without the
 *  other, so the two cannot drift apart. */
export async function upsertLichessLink(
  userId: string,
  link: { externalUserId: string; username: string; scopes: string[]; token: string },
): Promise<void> {
  const sealed = Buffer.from(await sealPlayerToken(link.token), "base64");
  // M-2: the token this write replaces, read under the row's lock so a concurrent re-link cannot slip between — and
  // (P11) the Lichess account it replaces.
  let replaced: Uint8Array | null = null;
  let replacedAccount: string | null = null;
  try {
    await sql.begin(async (tx) => {
      const [prior] = await tx<{ access_token_enc: Uint8Array | null; external_user_id: string }[]>`
        select access_token_enc, external_user_id from user_external_accounts
         where user_id = ${userId} and provider = 'lichess'
           for update`;
      replaced = prior?.access_token_enc ?? null;
      replacedAccount = prior?.external_user_id ?? null;
      await tx`
        insert into user_external_accounts (
          user_id, provider, external_user_id, username,
          access_token_enc, scopes, consented_at, updated_at
        ) values (
          ${userId}, 'lichess', ${link.externalUserId}, ${link.username},
          ${sealed}, ${link.scopes}, now(), now()
        )
        on conflict (user_id, provider) do update set
          external_user_id = excluded.external_user_id,
          username         = excluded.username,
          access_token_enc = excluded.access_token_enc,
          scopes           = excluded.scopes,
          consented_at     = excluded.consented_at,
          updated_at       = now()`;
    });
  } catch (err) {
    const pg = err as { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === ALREADY_LINKED_CONSTRAINT) {
      throw new HttpError(
        409,
        "That Lichess account is already linked to a different Seazn account.",
        "LICHESS_ALREADY_LINKED",
      );
    }
    throw err;
  }
  // Final review P11: a DIFFERENT account leaves every live or mid-create board of this player recorded for an account
  // that is no longer theirs — held for the organiser, BEFORE the old grant is revoked, so the organiser's reason is
  // the account change rather than the revoked token the next move would meet. The same account changes nothing. A
  // dynamic import: the hold pulls the result writer, which the link's other importers never need.
  if (replacedAccount !== null && replacedAccount !== link.externalUserId) {
    const { holdBoardsOnAccountChange } = await import("./external-play/account-changed");
    await holdBoardsOnAccountChange(userId, { from: replacedAccount, to: link.externalUserId });
  }
  await revokeReplacedGrant(userId, replaced, link.token);
}

/** M-2: the grant a committed re-link replaced, revoked at Lichess — best effort, like unlink, and never silent: a token
 *  we cannot open and a revoke that fails both leave a move-capable grant live, reported by user id and reason, never
 *  the token. The same token stored again is the grant we keep, and is never sent. */
async function revokeReplacedGrant(userId: string, replaced: Uint8Array | null, current: string): Promise<void> {
  const old = await openSealed(replaced);
  if (old === null) return;
  if ("failure" in old) {
    log.error(
      { userId, reason: old.failure },
      "lichess: re-link could not open the replaced token — the old grant was NOT revoked at Lichess and stays live until the player revokes it there",
    );
    return;
  }
  if (old.token === current) return;
  const failure = await revokeAtLichess(old.token);
  if (failure) {
    log.error(
      { userId, ...failure },
      "lichess: re-link could not revoke the replaced grant at Lichess — it stays live until the player revokes it there",
    );
  }
}

/** Revoke at Lichess, THEN delete. Best-effort revoke: a failure leaves an
 *  orphaned grant on Lichess's side, which is not a reason to keep a token we
 *  were told to forget. A legacy row has no token, so nothing is sent.
 *
 *  Never SILENT, though (review T2-I2): a token we cannot open, a revoke
 *  Lichess refuses, and a revoke that never arrives all leave a move-capable
 *  grant live, so each is reported to the error channel with the user id and
 *  a reason — never the token — and the row is deleted anyway. */
export async function unlinkLichess(userId: string): Promise<void> {
  // Final re-review P11 (4): a game live or mid-create on this player's account can no longer be moved from Seazn
  // once the link goes — held for the organiser (token_revoked, their seat) BEFORE the grant is revoked, exactly as
  // a re-link holds (upsertLichessLink). Best effort: the hold logs and never throws, so it never blocks the unlink.
  const [linked] = await sql<{ external_user_id: string }[]>`
    select external_user_id from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
  if (linked) {
    const { holdBoardsOnAccountChange } = await import("./external-play/account-changed");
    await holdBoardsOnAccountChange(userId, { from: linked.external_user_id, to: null });
  }
  const stored = await readStoredToken(userId);
  if (stored !== null && "failure" in stored) {
    log.error(
      { userId, reason: stored.failure },
      "lichess: unlink could not open the stored token — the grant was NOT revoked at Lichess and stays live until the player revokes it there",
    );
  } else if (stored !== null) {
    const failure = await revokeAtLichess(stored.token);
    if (failure) {
      log.error(
        { userId, ...failure },
        "lichess: unlink could not revoke the grant at Lichess — it stays live until the player revokes it there",
      );
    }
  }
  await sql`
    delete from user_external_accounts
     where user_id = ${userId} and provider = 'lichess'`;
}

/** REGISTRATION gate — a link is required to enter an online division.
 *  Deliberately NOT a consent gate: a player registers long before consent is
 *  needed, and §3.1 owes re-consent "before their first online fixture", not
 *  before signup. The consent gate is assertLichessConsentForPlay. */
export async function assertUserHasLichessForOnlinePlay(userId: string | null): Promise<void> {
  if (!userId) {
    throw new HttpError(
      422,
      "Sign in and link your Lichess account to register for online play",
      "LICHESS_LINK_REQUIRED",
    );
  }
  if (!(await getLichessLink(userId))) {
    throw new HttpError(
      422,
      "Link your Lichess account in Settings before registering for online play",
      "LICHESS_LINK_REQUIRED",
    );
  }
}

/** The org's persons whose Seazn user holds a Lichess account row, and what that row stores about playing (a "linked"
 *  person is a row here, whatever it stores) - the query behind `lichessLinkStatesByPerson`. Optionally only among
 *  `personIds`, when the caller knows up front which people it will ask about. `undefined` reads every such person in the org; a list reads just those (an empty list reads no one).
 *
 *  `user_external_accounts` is sealed from `app_user` (V451: FORCE RLS, no grant), so this can only run BEFORE a tenant
 *  transaction's role drop: pass it as `withTenant`'s `privilegedPrelude`, which runs on the transaction's own
 *  connection. Called from inside the callback it fails with `42501`; reaching for the pooled `sql` instead would be a
 *  second connection while the first is held (see lib/db.ts). Always scoped to `orgId` by `persons.org_id` - a named id
 *  of another org's person is not answered for - which is also what RLS scoped the roster's persons to. */
async function lichessLinkRows(
  tx: Tx,
  orgId: string,
  personIds?: readonly string[],
): Promise<{ id: string; consented_at: Date | null; scopes: string[] }[]> {
  return tx<{ id: string; consented_at: Date | null; scopes: string[] }[]>`
    select p.id, a.consented_at, a.scopes
      from persons p
      join user_external_accounts a on a.user_id = p.user_id and a.provider = 'lichess'
     where p.org_id = ${orgId}
     ${personIds === undefined ? tx`` : tx`and p.id = any(${[...personIds]})`}`;
}

/** What a person's stored Lichess row lets them do: `plays` (the seat gate lets them in) or `reconnect` (a row is there,
 *  but the gate would refuse it with `lichess_reconsent_required`: identity-only, or a grant short of a play scope).
 *  A person with NO row is absent from the map - that is `lichess_link_required`, a different gap. */
export type LichessLinkState = "plays" | "reconnect";

/** The people with a Lichess row, each with the state of their link. The verdict is `lichessGrantPlays` - the very
 *  function the seat gate (`assertLichessConsentForPlay`) refuses by - never a second definition of "can play". Same
 *  connection rule, same scoping (see `lichessLinkRows`). The ONE reader: the organiser's registration gate
 *  (`assertPersonIdsLinkedForOnlinePlay`) and the online-switch warning (`listLichessLinkGaps`) both ask it. */
export async function lichessLinkStatesByPerson(
  tx: Tx,
  orgId: string,
  personIds?: readonly string[],
): Promise<Map<string, LichessLinkState>> {
  const rows = await lichessLinkRows(tx, orgId, personIds);
  return new Map(
    rows.map((r): [string, LichessLinkState] => [
      r.id,
      lichessGrantPlays({ consentedAt: r.consented_at, scopes: r.scopes }) ? "plays" : "reconnect",
    ]),
  );
}

/** The organiser-side REGISTRATION gate for an online division: every rostered person must hold a Lichess link that
 *  PLAYS - the same bar the seat gate holds them to (owner 2026-10-25), so a player is told to reconnect when they
 *  register, not when they are turned away at the board.
 *
 *  `states` is `lichessLinkStatesByPerson`'s answer for the org (or for the people the caller named). Two refusals, in
 *  the order the player would have to act: a person with NO link is `LICHESS_LINK_REQUIRED` (you cannot reconnect what
 *  was never linked), else a person whose link does not play is `LICHESS_RECONSENT_REQUIRED`. Each carries
 *  `extra.person_ids`: exactly the people that reason is true of, once each, in roster order. `null` is "never read for
 *  this transaction" (the division turned online after the prelude looked) - no answer, so it REFUSES as not linked,
 *  like an unasked flag does. */
export function assertPersonIdsLinkedForOnlinePlay(
  states: ReadonlyMap<string, LichessLinkState> | null,
  personIds: readonly string[],
): void {
  const rostered = [...new Set(personIds)];
  const unlinked = rostered.filter((personId) => states?.get(personId) === undefined);
  if (unlinked.length > 0) {
    throw new HttpError(
      422,
      "Every player must link a Lichess account before entering online play",
      "LICHESS_LINK_REQUIRED",
      { person_ids: unlinked },
    );
  }
  const reconnect = rostered.filter((personId) => states?.get(personId) === "reconnect");
  if (reconnect.length > 0) {
    throw new HttpError(
      422,
      "Every player must reconnect their Lichess account so Seazn can submit their moves before entering online play",
      "LICHESS_RECONSENT_REQUIRED",
      { person_ids: reconnect },
    );
  }
}

/** Whether a stored grant is enough to PLAY: a consent timestamp AND every scope in PLAY_SCOPES. The one authority —
 *  the play gate below refuses exactly when this answers false, and `/me` asks for re-consent on the same answer. */
export function lichessGrantPlays(link: Pick<LichessLink, "consentedAt" | "scopes">): boolean {
  return link.consentedAt !== null && scopesPlay(link.scopes);
}

/** Every scope in PLAY_SCOPES is among `scopes` — the scope half of `lichessGrantPlays`, which Lichess's own answer
 *  (`lichessGrantDowngraded`) is held to as well. */
function scopesPlay(scopes: readonly string[]): boolean {
  return PLAY_SCOPES.every((s) => scopes.includes(s));
}

/** Final re-review N-3: how long the match room page waits on Lichess's word, as it renders. Its answer is ignored
 *  when it does not come (the first act learns the truth), so a slow lichess.org costs every room load this much
 *  at most — never LICHESS_TIMEOUT_MS (10 s), which bounds the calls whose answer is needed. */
export const LICHESS_TOKEN_TEST_TIMEOUT_MS = 2_000;

/** Lichess's word on one token: `POST /api/token/test` (lila OAuth.testTokens, read from source 2026-10-14) — NO
 *  auth, the body the token itself (lila takes several, comma-separated), answered `{<token>: null}` for a token it
 *  does not hold (revoked, expired, never issued) or `{<token>: {userId, scopes: "a,b", expires}}`. `unknown` is
 *  every answer that is neither — unreachable, a non-200 (lila rate-limits this per IP), a body without the token. */
async function testAtLichess(
  token: string,
): Promise<{ kind: "gone" } | { kind: "scopes"; scopes: string[] } | { kind: "unknown"; reason: string }> {
  // One cap over the whole exchange, headers AND body (N-3).
  const signal = AbortSignal.timeout(LICHESS_TOKEN_TEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${lichessTokenUrl()}/test`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: token,
      signal,
    });
  } catch {
    return { kind: "unknown", reason: signal.aborted ? "timeout" : "unreachable" };
  }
  if (res.status !== 200) return { kind: "unknown", reason: `status_${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unknown", reason: signal.aborted ? "timeout" : "not_json" };
  }
  if (typeof body !== "object" || body === null || !Object.hasOwn(body, token)) return { kind: "unknown", reason: "no_entry" };
  const entry = (body as Record<string, unknown>)[token];
  if (entry === null) return { kind: "gone" };
  const scopes = (entry as { scopes?: unknown }).scopes;
  if (typeof scopes !== "string") return { kind: "unknown", reason: "no_scopes" };
  return { kind: "scopes", scopes: scopes.split(",").map((x) => x.trim()).filter((x) => x.length > 0) };
}

/**
 * Final review P10: whether a grant OUR row says plays has been narrowed or revoked at lichess.org since — the
 * player removed a scope, or revoked Seazn's token, there. Our row cannot know until an act spends the token and
 * Lichess refuses it, so the match room asks Lichess once per page load and shows the re-link screen at once.
 *
 * True only on Lichess's own answer: the token is gone, or it lacks a play scope (the same PLAY_SCOPES the row is
 * held to). False everywhere else, and Lichess is not asked when our row already refuses (no user, no link, a
 * grant short of a scope — the seat and the act refuse those by name) or the stored token cannot be opened (Seazn's
 * fault, already reported, never the player's). A Lichess that does not answer is logged and reads false: a hiccup
 * is never a re-link screen — an act still learns the truth.
 */
export async function lichessGrantDowngraded(userId: string | null): Promise<boolean> {
  if (userId === null) return false;
  const link = await getLichessLink(userId);
  if (link === null || !lichessGrantPlays(link)) return false;
  let token: string | null;
  try {
    token = await getLichessAccessToken(userId);
  } catch {
    return false; // LICHESS_TOKEN_UNAVAILABLE: getLichessAccessToken reported it
  }
  if (token === null) return false;
  const said = await testAtLichess(token);
  if (said.kind === "unknown") {
    log.warn({ userId, reason: said.reason }, "lichess: the token test did not answer — the room shows no re-link screen on it");
    return false;
  }
  return said.kind === "gone" || !scopesPlay(said.scopes);
}

/** PLAY gate (§3.1). A link is not enough: the row must carry a consent
 *  timestamp AND every scope in PLAY_SCOPES, because a grant from the
 *  identity-only flow cannot submit a move and would 401 mid-game, one
 *  without `challenge:write` cannot create White's challenge, and one without
 *  `challenge:read` cannot be recovered after a crashed create.
 *
 *  Production callers, both through preflight.ts `playGrantRefusal`, which maps
 *  the two 422s to the reasons `lichess_link_required` /
 *  `lichess_reconsent_required` and lets anything else propagate:
 *  - T8's `seatPlayer`, after its identity, board and window checks and
 *    before any participant token is minted (fix round 2);
 *  - T9's `createGameIfReady`, as defence before the seats, answering the
 *    same two reasons.
 *  T14 renders the re-link screen on those reasons. */
export async function assertLichessConsentForPlay(userId: string | null): Promise<void> {
  if (!userId) {
    throw new HttpError(
      422,
      "Sign in and link your Lichess account to play online",
      "LICHESS_LINK_REQUIRED",
    );
  }
  const link = await getLichessLink(userId);
  if (!link) {
    throw new HttpError(
      422,
      "Link your Lichess account in Settings before playing online",
      "LICHESS_LINK_REQUIRED",
    );
  }
  // EVERY scope the design asks for (review T2-I3) — one authority for "the
  // grant that is enough to play", so a PLAY_SCOPES that grows demands
  // re-consent from everyone whose grant predates it.
  if (!lichessGrantPlays(link)) {
    throw new HttpError(
      422,
      "Re-link your Lichess account so Seazn can submit your moves",
      "LICHESS_RECONSENT_REQUIRED",
    );
  }
}
