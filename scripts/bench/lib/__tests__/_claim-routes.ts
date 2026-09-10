// B06a Task 6 — the claim rail, shared by every suite-level fake.
//
// Three routes moved here because all four fakes already carried BYTE-
// IDENTICAL copies of two of them (the officials invite and the person
// claim-invite mint/read-back), and Task 6 adds a third that all four now
// need. Four hand-rolled copies of a flow whose whole point is that a token
// must MATCH would sooner or later disagree about what matching means.
//
// This is deliberately NOT an echo world. `echoExpectedBoard` and
// `echoSpecialSubjects` beside it satisfy whatever they are handed and say so
// in their own doc comments; this one decides refusals from its own state:
//
//   - a token it never minted is 401, exactly as `resolveClaimToken`
//     (`usecases/person-claims.ts:255-266`) has no row to find;
//   - a token it already accepted is 409, as `settleClaimRow` (`:235`);
//   - an accepted invite stops reading back at all, because the read-back is
//     `getOpenClaim` (`:200-208`) whose WHERE clause carries
//     `claimed_at is null` — the absence IS the read-back proof.
//
// What it deliberately does NOT model is the strict email match
// (403 CLAIM_EMAIL_MISMATCH, `:299-307`). These four files ignore the email
// on `signIn` entirely, so modelling it would mean teaching four fakes to
// track sessions for one assertion that `people.test.ts` already proves
// directly against a world built for it.
//
// NOT a `.test.ts`, so vitest never collects it — same convention as
// `_oracle-routes.ts` / `_advance-routes.ts` / `_division-phase.ts`.
import type { RawResult } from "../http.ts";

/** The `person_claims` row as `getOpenClaim` returns it. */
export interface FakeClaimRow {
  readonly id: string;
  readonly person_id: string;
  readonly email: string;
  readonly expires_at: string;
  readonly claimed_at: string | null;
  readonly revoked_at: string | null;
}

export interface FakeMintedClaim {
  readonly personId: string;
  readonly email: string;
  readonly token: string;
}

/** `handleRequest` must be able to answer `null` (an open claim that is not
 *  there) distinctly from "this route is not mine". */
export interface HandledValue {
  readonly value: unknown;
}

export interface ClaimRoutesWorld {
  /** The `request()` side: both mint POSTs and the read-back GET. */
  handleRequest(method: string, routePath: string, body: unknown): HandledValue | undefined;
  /** The `raw()` side: `POST /api/claims/{token}/accept`. */
  handle(method: string, path: string): RawResult | undefined;
  /** Every invite this world minted, in mint order. */
  minted(): readonly FakeMintedClaim[];
  /** Tokens this world has accepted, for a test that wants to assert directly. */
  acceptedTokens(): readonly string[];
}

export interface ClaimRoutesOptions {
  /**
   * Accept ANY token, including one that was never minted — the mutant the
   * negative case exists to catch, made reachable so a wiring test can prove
   * the runner actually reds on it. A run against this world must report
   * `invalidTokenRefused: false`.
   */
  readonly acceptAnyToken?: boolean;
  /** Refuse every acceptance with this status instead of accepting. */
  readonly refuseWith?: number;
  /**
   * On any successful acceptance, close EVERY minted claim — the over-broad
   * accept (AGENTS.md failure class 13's mirror image: a guard that catches
   * more than it was asked to). A run against this world must red the
   * "invites past the limit stay unclaimed" oracle, and nothing else can
   * witness that oracle actually re-reads the invites it left alone.
   */
  readonly closeUntouched?: boolean;
}

/** Mirrors `mintClaimSecret` (`person-claims.ts:31-33`): a `pc_` prefix and a
 *  base64url-safe body. Collision with a sibling is impossible regardless of
 *  length — `tamperToken` (`people.ts`) rotates EVERY character after the
 *  prefix and is injective, so two distinct secrets cannot tamper to the same
 *  string. Length here is realism, not safety. */
function secretFor(personId: string, n: number): string {
  return `pc_${personId.replace(/[^A-Za-z0-9]/g, "")}claimsecret${n}`;
}

export function makeClaimRoutesWorld(opts: ClaimRoutesOptions = {}): ClaimRoutesWorld {
  const rowByPerson = new Map<string, FakeClaimRow>();
  const byToken = new Map<string, FakeClaimRow>();
  const mintedList: FakeMintedClaim[] = [];
  const accepted = new Set<string>();
  let counter = 0;

  const mint = (personId: string, email: string): { person_id: string; claim_url: string } => {
    const token = secretFor(personId, ++counter);
    const row: FakeClaimRow = {
      id: `claim-${counter}`,
      person_id: personId,
      email,
      expires_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
      claimed_at: null,
      revoked_at: null,
    };
    rowByPerson.set(personId, row);
    byToken.set(token, row);
    mintedList.push({ personId, email, token });
    // The real route builds this from `routes.claim(secret)` — `/claim/{secret}`
    // (`lib/routes.ts:77`) — off an absolute `baseUrl(req)`.
    return { person_id: personId, claim_url: `http://bench.example/claim/${token}` };
  };

  return {
    handleRequest(method, routePath, body) {
      const inviteMatch = /^\/api\/v1\/officials\/([^/]+)\/invite$/.exec(routePath);
      if (method === "POST" && inviteMatch !== null) {
        // Same `invited-{officialId}` person id all four fakes derived before
        // this file existed — `inviteOfficial` mints a BRAND NEW person, so
        // the id is not any pack person's.
        return { value: mint(`invited-${inviteMatch[1]}`, String((body as { email?: string }).email ?? "")) };
      }
      const personMatch = /^\/api\/v1\/persons\/([^/]+)\/claim-invites$/.exec(routePath);
      if (personMatch === null) return undefined;
      const personId = personMatch[1];
      if (method === "POST") {
        return { value: mint(personId, String((body as { email?: string }).email ?? "")) };
      }
      if (method === "GET") {
        const row = rowByPerson.get(personId);
        // `getOpenClaim`'s own WHERE clause: an accepted or revoked invite is
        // simply not returned.
        return { value: row === undefined || row.claimed_at !== null ? null : row };
      }
      return undefined;
    },

    handle(method, path) {
      const m = /^\/api\/claims\/([^/]+)\/accept$/.exec(path);
      if (m === null || method !== "POST") return undefined;
      const token = m[1];
      if (opts.refuseWith !== undefined) {
        return { status: opts.refuseWith, json: { ok: false, error: "refused by the fake" } };
      }
      const row = byToken.get(token);
      if (row === undefined && opts.acceptAnyToken !== true) {
        return { status: 401, json: { ok: false, error: "This claim link is not valid" } };
      }
      if (row !== undefined && accepted.has(token)) {
        return { status: 409, json: { ok: false, error: "This profile has already been claimed" } };
      }
      if (row !== undefined) {
        accepted.add(token);
        const now = new Date().toISOString();
        rowByPerson.set(row.person_id, { ...row, claimed_at: now });
        if (opts.closeUntouched === true) {
          for (const [personId, other] of rowByPerson) {
            rowByPerson.set(personId, { ...other, claimed_at: other.claimed_at ?? now });
          }
        }
      }
      return {
        status: 200,
        json: {
          ok: true,
          data: { person_id: row?.person_id ?? "unminted-person", person_name: "Claimed", org_name: "Bench Org" },
        },
      };
    },

    minted: () => mintedList,
    acceptedTokens: () => [...accepted],
  };
}
