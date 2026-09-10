// B06a Task 6 — the people layer's missing half: invites are ACCEPTED, not
// only minted.
//
// B03 §5 drew the line ("the accept flow is B05's, seeding only mints
// invites") and no later wave crossed it, so `seed.ts` has been proving a
// `person_claims` row exists while nothing has ever proven a human can get
// into the profile it points at. That gap is invisible from the suite's own
// assertions, because the thing they check — `claimed_at === null` — is
// exactly what an unusable invite also looks like.
//
// Three route facts decide the shape of this file, and each one corrects the
// plan that commissioned it:
//
//   1. The token is shown ONCE, on the mint response's `claim_url`
//      (`app/api/v1/persons/[id]/claim-invites/route.ts:24-25`). The read-back
//      `GET .../claim-invites` deliberately omits the secret, which is why
//      `seed.ts` could not accept what it had just minted and why this task
//      also had to teach the seeding step to keep the mint response.
//   2. `POST /api/claims/{token}/accept` takes NO body, REQUIRES a session
//      (`requireUser()`, `app/api/claims/[token]/accept/route.ts:11`), and the
//      signed-in email must equal the invited one or the product answers 403
//      CLAIM_EMAIL_MISMATCH (`usecases/person-claims.ts:299-307`). An
//      acceptance is therefore a whole sign-in per invitee — the seeding
//      session cannot accept on anyone's behalf, and a bench that tried would
//      be testing a path no customer walks.
//   3. `/api/claims/*` is NOT the v1 envelope. `lib/http.ts:113-121` returns
//      `{ ok: false, error: <message> }` and DROPS the `code`, so an HTTP
//      client never sees the string `CLAIM_INVALID` at all. Every refusal
//      assertion here is on STATUS; asserting the documented code would have
//      been an assertion that could never fail.
import { newSession, type RawResult, type Session } from "./http.ts";

/**
 * The two primitives an acceptance needs, declared fresh rather than imported
 * from `dls-gate.ts`'s `ProbeTransport` — `schedule.ts:1269-1276` sets that
 * precedent for exactly this reason, and here it also breaks a real cycle:
 * `seed.ts` consumes `MintedInvite` below, and `ProbeTransport` is defined in
 * a file that imports `seed.ts`. Every real `ProbeTransport` satisfies this
 * structurally, so the runner passes its own transport unchanged.
 */
export interface ClaimTransport {
  signIn(base: string, s: Session, email: string): Promise<{ has_org: boolean; org_id: string; redirect: string }>;
  raw(base: string, s: Session, path: string, method?: string, body?: unknown): Promise<RawResult>;
}

/**
 * An invite whose one-time secret was captured at mint time. `token` is the
 * last path segment of the mint response's `claim_url`
 * (`routes.claim(secret)` = `/claim/{secret}`, `lib/routes.ts:77`), which is
 * the only moment it is ever readable.
 */
export interface MintedInvite {
  /** The pack's own ref (player invites) or the official's ref. */
  readonly ref: string;
  readonly kind: "player" | "official";
  readonly personId: string;
  readonly email: string;
  readonly token: string;
}

export interface ClaimRejection {
  readonly person: string;
  readonly status: number;
  readonly detail: string;
}

export interface ClaimAcceptanceResult {
  /** Invites this run actually sent an acceptance for — `min(invites, limit)`. */
  readonly attempted: number;
  readonly accepted: number;
  /** In acceptance order, for the claimed-profile stats oracle downstream. */
  readonly acceptedPersonIds: readonly string[];
  readonly rejected: readonly ClaimRejection[];
  /** Invites deliberately left alone so a suite can still prove an UNCLAIMED
   *  one exists after this step. Untouched means untouched: their tokens are
   *  never sent. */
  readonly skipped: number;
  /**
   * The deliberate negative case. True only when a tampered token drew a 401
   * ON A SESSION THIS RUN PROVED WORKS — one that had already accepted a real
   * invite. `requireUser()` refuses before the token is ever resolved, so a 401
   * on any other session is the missing login rather than token validation, and
   * reporting it as proof would be exactly the vacuous pass this case exists to
   * prevent. The probe still RUNS on an unproven session, so
   * `invalidTokenStatus` can say what happened; it just is not evidence.
   */
  readonly invalidTokenRefused: boolean;
  /** What the tampered token actually drew, so a report can show it. `null`
   *  only when no attempt was made at all — a pack that declares no invites. */
  readonly invalidTokenStatus: number | null;
}

/**
 * Same prefix, same length, same alphabet, different value — a token the
 * product refuses on LOOKUP rather than one a length or prefix check would
 * have thrown out first, which is a different guard than the one being
 * proven. `mintClaimSecret` is `"pc_" + base64url(32)`
 * (`usecases/person-claims.ts:31-33`) and `resolveClaimToken` (`:255-266`)
 * validates nothing but the sha256, so the prefix is preserved for shape and
 * every character after it is rotated.
 *
 * EVERY character, not one: rotating a single trailing character turned a
 * fixture's `pc_token1` into its sibling `pc_token2` and drew a 409 instead
 * of the 401 the negative case asserts. Real secrets would not have collided,
 * which is precisely why the fixture caught it and a live run would not have.
 */
export function tamperToken(token: string): string {
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const prefix = token.startsWith("pc_") ? "pc_" : "";
  const body = token.slice(prefix.length);
  const rotated = [...body]
    .map((ch) => {
      const i = ALPHA.indexOf(ch);
      return i === -1 ? ch : ALPHA[(i + 1) % ALPHA.length];
    })
    .join("");
  return `${prefix}${rotated}`;
}

function isAccepted(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Accept the first `limit` invites, each as the invited person, then attempt
 * one deliberately invalid token and record that it was refused.
 *
 * Never throws on a refusal: a rejected acceptance is a FINDING (the product
 * would not let a real invitee in), and a run that aborted on the first one
 * would report nothing about the invites behind it.
 */
export async function acceptClaimInvites(args: {
  readonly base: string;
  readonly invites: readonly MintedInvite[];
  readonly limit: number;
  readonly transport: ClaimTransport;
}): Promise<ClaimAcceptanceResult> {
  const { base, invites, limit, transport } = args;
  const targets = invites.slice(0, Math.max(0, limit));
  const acceptedPersonIds: string[] = [];
  const rejected: ClaimRejection[] = [];
  // Two sessions, and the distinction IS the negative case. `probeSession` is
  // latched only from an acceptance that SUCCEEDED, so it is a login this run
  // proved works; `fallbackSession` is merely the first one it signed in with.
  // The tampered probe prefers the proven session and falls back to the other
  // so the report can still say what a never-minted token drew — but only a
  // probe sent on the PROVEN session counts as evidence, because
  // `requireUser()` refuses before the token is ever resolved and a 401 on an
  // unauthenticated session says nothing about token validation.
  let probeSession: Session | undefined;
  let fallbackSession: Session | undefined;

  for (const inv of targets) {
    // A fresh session per invitee — the product matches the SIGNED-IN email
    // against the invite, so reusing one session would accept the first invite
    // and draw a 403 on every other one. That is a real product behaviour and
    // this loop must not paper over it.
    const s = newSession();
    await transport.signIn(base, s, inv.email);
    fallbackSession ??= s;
    const res = await transport.raw(base, s, `/api/claims/${inv.token}/accept`, "POST");
    if (isAccepted(res.status)) {
      probeSession ??= s;
      const data = res.json.data as { person_id?: string } | undefined;
      acceptedPersonIds.push(data?.person_id ?? inv.personId);
    } else {
      rejected.push({
        person: inv.ref,
        status: res.status,
        detail: typeof res.json.error === "string" ? res.json.error : `HTTP ${res.status}`,
      });
    }
  }

  let invalidTokenStatus: number | null = null;
  const probeOn = probeSession ?? fallbackSession;
  if (targets.length > 0 && probeOn !== undefined) {
    const res = await transport.raw(
      base,
      probeOn,
      `/api/claims/${tamperToken(targets[0].token)}/accept`,
      "POST",
    );
    invalidTokenStatus = res.status;
  }

  return {
    attempted: targets.length,
    accepted: acceptedPersonIds.length,
    acceptedPersonIds,
    rejected,
    skipped: invites.length - targets.length,
    invalidTokenRefused: invalidTokenStatus === 401 && probeSession !== undefined,
    invalidTokenStatus,
  };
}

// ---------------------------------------------------------------------------
// B06a Task 7 — news drafts and publication
// ---------------------------------------------------------------------------
//
// `report.news` (`report.ts:673`) has been declared since B01 with no writer,
// and the reason is not neglect: nothing in the bench had ever turned drafting
// ON, so there was never anything to write. Drafting is a side effect of
// FOLDING (`refreshNews`, `scoring.ts:132` / `event-import.ts:435`), gated on
// five conditions in order — the event decides or voids (`scoring.ts:129`),
// `divisions.auto_posts` is true (`:353-356`, re-read `org-posts.ts:479`), the
// org holds `news.auto` (`:480`), and the fixture's status is decided,
// finalized or forfeited (`:483-485`). Miss any one and the call returns `[]`,
// which is indistinguishable from a broken step unless the run says which
// precondition it failed to meet.
//
// That is why `enableAutoPosts` is a separate export that must run BEFORE the
// folds: `PATCH /divisions/{id}` itself refuses `auto_posts: true` without
// `news.auto` (`usecases/divisions.ts:652-654`), and once the events are
// folded there is no second chance to draft them.

/** `GET /orgs/{id}/posts` rows (`api-v1/posts.ts#toApiPost`). No fixture id on
 *  the wire — `auto_source` carries it (`org-posts.ts:509-510`), which is the
 *  only reason publishing NAMED fixtures is possible at all. */
export interface NewsPost {
  readonly id: string;
  readonly status: string;
  readonly competition_id: string | null;
  readonly division_id: string | null;
  readonly published_at: string | null;
  readonly auto_source: { trigger?: string; fixture_id?: string; stale?: boolean } | null;
}

export interface NewsEnableResult {
  readonly requested: number;
  readonly enabled: number;
  readonly refused: readonly { readonly divisionId: string; readonly status: number; readonly detail: string }[];
}

export interface NewsStepResult {
  readonly drafted: number;
  readonly published: number;
  readonly stillDraft: number;
  /** Fixtures this run asked to publish that had no draft — named, never
   *  silently absorbed into a smaller `published` count. */
  readonly requestedButNotDrafted: readonly string[];
  /** Whether the republish proxy actually RAN. A run that published nothing
   *  has not tested the fire-once predicate, and `republishWasInert` must not
   *  be read as evidence without this. */
  readonly republishProbed: boolean;
  /**
   * The fire-once predicate, asserted by proxy. `shouldFirePostPublished`
   * (`org-posts.ts:317`) fires a PostHog `captureServer` call and NOTHING else
   * — no row, no outbox, no webhook — so "observed exactly once" is not
   * observable over HTTP at all. What is observable is what the predicate
   * protects: `published_at` is assigned only when it was null (`:276,282`),
   * so a second publish must leave it where it is.
   */
  readonly republishWasInert: boolean;
}

/** Turn drafting on. Runs BEFORE any fold — see this section's header. */
export async function enableAutoPosts(args: {
  readonly base: string;
  readonly session: Session;
  readonly divisionIds: readonly string[];
  readonly transport: ClaimTransport;
}): Promise<NewsEnableResult> {
  const { base, session, divisionIds, transport } = args;
  const refused: { divisionId: string; status: number; detail: string }[] = [];
  let enabled = 0;
  for (const divisionId of divisionIds) {
    const res = await transport.raw(base, session, `/api/v1/divisions/${divisionId}`, "PATCH", {
      auto_posts: true,
    });
    if (isAccepted(res.status)) enabled += 1;
    else {
      refused.push({
        divisionId,
        status: res.status,
        detail: typeof res.json.error === "string" ? res.json.error : `HTTP ${res.status}`,
      });
    }
  }
  return { requested: divisionIds.length, enabled, refused };
}

/** Every draft this run's competition owns, read through the product.
 *
 *  Each row's OWN `status` is checked rather than trusting the query string:
 *  `GET /orgs/{id}/posts` silently IGNORES an unrecognised `status`
 *  (`route.ts:19`) instead of answering 400, so a typo returns every post and
 *  a caller that trusted the filter would count published rows as drafts. */
async function fetchDrafts(args: {
  readonly base: string;
  readonly session: Session;
  readonly orgId: string;
  readonly competitionId: string;
  readonly transport: ClaimTransport;
}): Promise<readonly NewsPost[]> {
  const res = await args.transport.raw(
    args.base,
    args.session,
    `/api/v1/orgs/${args.orgId}/posts?status=draft`,
    "GET",
  );
  const rows = (res.json.data ?? []) as readonly NewsPost[];
  // The route carries no competition filter at all (`org-posts.ts:163-167`),
  // so a shared org's other competitions would inflate every number here.
  return rows.filter((p) => p.status === "draft" && p.competition_id === args.competitionId);
}

export async function runNewsStep(args: {
  readonly base: string;
  readonly session: Session;
  readonly orgId: string;
  readonly competitionId: string;
  /** Fixture ids whose auto-drafted posts this run publishes. Deliberately a
   *  SUBSET: what stays draft is half of what this step proves. */
  readonly publishFixtureIds: readonly string[];
  readonly transport: ClaimTransport;
}): Promise<NewsStepResult> {
  const { base, session, orgId, competitionId, publishFixtureIds, transport } = args;
  const before = await fetchDrafts({ base, session, orgId, competitionId, transport });

  const byFixture = new Map<string, NewsPost>();
  for (const p of before) {
    const fixtureId = p.auto_source?.fixture_id;
    if (fixtureId !== undefined && !byFixture.has(fixtureId)) byFixture.set(fixtureId, p);
  }

  const requestedButNotDrafted: string[] = [];
  const publishedIds: string[] = [];
  let firstPublishedAt: string | null = null;
  for (const fixtureId of publishFixtureIds) {
    const target = byFixture.get(fixtureId);
    if (target === undefined) {
      requestedButNotDrafted.push(fixtureId);
      continue;
    }
    const res = await transport.raw(base, session, `/api/v1/posts/${target.id}`, "PATCH", { action: "publish" });
    if (!isAccepted(res.status)) continue;
    const row = res.json.data as NewsPost | undefined;
    publishedIds.push(target.id);
    if (firstPublishedAt === null) firstPublishedAt = row?.published_at ?? null;
  }

  const after = await fetchDrafts({ base, session, orgId, competitionId, transport });

  // The fire-once proxy. Only meaningful against a post this run actually
  // published — hence `republishProbed`, so an upstream oracle can report NO
  // SUBJECT rather than a pass it did not earn.
  let republishProbed = false;
  let republishWasInert = false;
  const probeId = publishedIds[0];
  if (probeId !== undefined && firstPublishedAt !== null) {
    const again = await transport.raw(base, session, `/api/v1/posts/${probeId}`, "PATCH", { action: "publish" });
    if (isAccepted(again.status)) {
      republishProbed = true;
      republishWasInert = (again.json.data as NewsPost | undefined)?.published_at === firstPublishedAt;
    }
  }

  return {
    drafted: before.length,
    published: publishedIds.length,
    stillDraft: after.length,
    requestedButNotDrafted,
    republishProbed,
    republishWasInert,
  };
}
