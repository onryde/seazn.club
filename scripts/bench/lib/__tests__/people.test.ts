// B06a Task 6 — claim acceptance. The bench has minted claim invites since
// B03 and never accepted one, so every "the people layer works" claim the
// programme has made so far rests on a row being CREATED, never on a human
// getting into their own profile.
//
// Three route facts, re-pinned 2026-09-10, decide the shape of everything
// below and each corrects the plan:
//
//   1. `POST /api/claims/{token}/accept` takes NO body and REQUIRES a session
//      (`route.ts:11`, `requireUser()`), and the signed-in email must equal
//      the invited email or `assertClaimEmail` throws 403 CLAIM_EMAIL_MISMATCH
//      (`person-claims.ts:299-307`). So an acceptance is a full sign-in per
//      invitee, not a call the seeding session can make on their behalf.
//   2. The token is shown ONCE, on the mint response's `claim_url`
//      (`persons/[id]/claim-invites/route.ts:24-25`). `GET .../claim-invites`
//      deliberately omits it, which is why `seed.ts` had no way to accept what
//      it minted and why this task had to capture the mint response.
//   3. `/api/claims/*` runs on the NON-v1 envelope (`lib/http.ts:113-121`),
//      which returns `{ ok: false, error: <message> }` and DROPS the `code`.
//      An HTTP client never sees the string `CLAIM_INVALID`. The refusal
//      assertions below are therefore on STATUS, and asserting the code would
//      have been an assertion that could never fail.
import { describe, expect, it } from "vitest";
import { acceptClaimInvites, type MintedInvite } from "../people.ts";
import type { RawJson, RawResult, Session } from "../http.ts";
// `ProbeTransport`, not `people.ts`'s own narrower `ClaimTransport` — the
// runner passes a real one, so the fakes here must satisfy the same shape the
// production caller does.
import type { ProbeTransport } from "../dls-gate.ts";

const BASE = "http://bench.example";

function invite(n: number, kind: MintedInvite["kind"] = "player"): MintedInvite {
  return {
    ref: `p-${n}`,
    kind,
    personId: `person-${n}`,
    email: `claimant${n}@example.com`,
    token: `pc_token${n}`,
  };
}

const THREE = [invite(1), invite(2), invite(3)];

/**
 * A claim world that behaves the way the product does on the three facts
 * above: the token must be one it minted, the signed-in email must match, and
 * a second acceptance of the same token is a 409.
 *
 * Deliberately NOT an echo: it decides refusals from its OWN state, so a test
 * that hands it a wrong token or a wrong session gets a refusal it did not
 * ask for. That is the whole reason this file can prove anything.
 */
function claimWorld(
  opts: {
    readonly known?: readonly MintedInvite[];
    readonly acceptStatus?: number;
    /** Sign-in silently produces NO session for these addresses — the shape a
     *  failed magic-link round trip takes on the wire, and the one that makes
     *  `requireUser()`'s 401 indistinguishable from a token refusal. */
    readonly signInFailsFor?: readonly string[];
    /** The claim surface waves through any token a signed-in caller sends. */
    readonly acceptAnyToken?: boolean;
  } = {},
): {
  transport: ProbeTransport;
  calls: string[];
} {
  const known = new Map((opts.known ?? THREE).map((i) => [i.token, i]));
  const claimed = new Set<string>();
  const emailBySession = new WeakMap<Session, string>();
  const calls: string[] = [];
  const transport: ProbeTransport = {
    async signIn(_base, s, email) {
      if (opts.signInFailsFor?.includes(email) !== true) emailBySession.set(s, email);
      calls.push(`SIGNIN ${email}`);
      return { has_org: false, org_id: "org-claimant", redirect: "/" };
    },
    async request<T>(): Promise<T> {
      throw new Error("claimWorld: request() is never used by the claim flow");
    },
    async raw(_base, s, path, method = "GET"): Promise<RawResult> {
      calls.push(`${method} ${path}`);
      const m = /^\/api\/claims\/([^/]+)\/accept$/.exec(path);
      if (m === null || method !== "POST") throw new Error(`claimWorld: unhandled ${method} ${path}`);
      const token = m[1]!;
      const signedInAs = emailBySession.get(s);
      // `requireUser()` runs BEFORE the token is resolved, so an unauthenticated
      // call is a 401 for a reason that has nothing to do with the token —
      // exactly the confusion the negative case must not be satisfied by.
      if (signedInAs === undefined) return refuse(401, "not signed in");
      const found = known.get(token);
      if (found === undefined) {
        if (opts.acceptAnyToken !== true) return refuse(401, "This claim link is not valid");
        return {
          status: 200,
          json: { ok: true, data: { person_id: "unminted-person" } } as RawJson,
        };
      }
      if (claimed.has(token)) return refuse(409, "This profile has already been claimed");
      if (found.email.toLowerCase() !== signedInAs.toLowerCase()) {
        return refuse(403, `This invite was sent to ${found.email}`);
      }
      claimed.add(token);
      const status = opts.acceptStatus ?? 200;
      return {
        status,
        json: { ok: true, data: { person_id: found.personId, person_name: found.ref, org_name: "Bench Org" } } as RawJson,
      };
    },
  };
  return { transport, calls };
}

function refuse(status: number, error: string): RawResult {
  return { status, json: { ok: false, error } as RawJson };
}

/** Refuses every acceptance with one status — the "record it, never throw" case. */
function refusingWorld(status: number): ProbeTransport {
  return {
    async signIn() {
      return { has_org: false, org_id: "o", redirect: "/" };
    },
    async request<T>(): Promise<T> {
      throw new Error("unused");
    },
    async raw(): Promise<RawResult> {
      return refuse(status, "nope");
    },
  };
}

describe("acceptClaimInvites", () => {
  it("accepts exactly `limit` invites and reports the count", async () => {
    const { transport } = claimWorld();
    const r = await acceptClaimInvites({ base: BASE, invites: THREE, limit: 3, transport });
    expect(r).toMatchObject({ attempted: 3, accepted: 3, rejected: [], skipped: 0 });
    expect(r.acceptedPersonIds).toEqual(["person-1", "person-2", "person-3"]);
  });

  it("leaves invites past `limit` untouched, so a suite can still prove an unclaimed one", async () => {
    const { transport, calls } = claimWorld();
    const r = await acceptClaimInvites({ base: BASE, invites: THREE, limit: 2, transport });
    expect(r).toMatchObject({ attempted: 2, accepted: 2, skipped: 1 });
    // The third invite's token must never have been sent — "skipped" has to
    // mean untouched, not attempted-and-ignored.
    expect(calls.some((c) => c.includes("pc_token3"))).toBe(false);
  });

  it("signs in as the INVITED address, not as whoever seeded the invite", async () => {
    const { transport, calls } = claimWorld();
    await acceptClaimInvites({ base: BASE, invites: [invite(1)], limit: 1, transport });
    expect(calls).toContain("SIGNIN claimant1@example.com");
  });

  it("reds when the acceptance is attempted from the wrong session", async () => {
    // The product's own strict email match (403 CLAIM_EMAIL_MISMATCH). A run
    // that signed in once and accepted everything would look identical to a
    // correct one here — this is what tells them apart.
    const { transport } = claimWorld();
    const wrongEmail = [{ ...invite(1), email: "claimant1@example.com" }, { ...invite(2), email: "claimant1@example.com" }];
    const r = await acceptClaimInvites({ base: BASE, invites: wrongEmail, limit: 2, transport });
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([{ person: "p-2", status: 403, detail: expect.stringContaining("sent to") }]);
  });

  it("records a refusal with its status rather than throwing", async () => {
    const r = await acceptClaimInvites({ base: BASE, invites: THREE, limit: 3, transport: refusingWorld(409) });
    expect(r.accepted).toBe(0);
    expect(r.rejected).toHaveLength(3);
    expect(r.rejected[0]).toMatchObject({ person: "p-1", status: 409 });
  });

  it("proves an invalid token is refused, and says with what status", async () => {
    const { transport } = claimWorld();
    const r = await acceptClaimInvites({ base: BASE, invites: THREE, limit: 3, transport });
    expect(r).toMatchObject({ invalidTokenRefused: true, invalidTokenStatus: 401 });
  });

  it("does NOT count a 401 as proof when nothing was accepted — that 401 is the missing session", async () => {
    // `requireUser()` refuses before the token is read. A run where every
    // acceptance failed proves nothing about token validation, and reporting
    // `invalidTokenRefused: true` there would be the vacuous pass this whole
    // negative case exists to avoid.
    const r = await acceptClaimInvites({ base: BASE, invites: THREE, limit: 3, transport: refusingWorld(401) });
    expect(r).toMatchObject({ accepted: 0, invalidTokenRefused: false });
  });

  it("probes with a session it PROVED works, not merely the first one it opened", async () => {
    // The review scenario, and the one a naive latch gets wrong: invitee 1's
    // sign-in silently produces no session, invitee 2's works. The claim
    // surface here waves through ANY token from a signed-in caller, so the
    // honest answer is `invalidTokenRefused: false`.
    //
    // A run that latched the probe session before knowing the acceptance
    // result would send the tampered token on invitee 1's UNAUTHENTICATED
    // session, draw `requireUser()`'s 401, and — with invitee 2's success
    // satisfying an `accepted > 0` guard — report the negative case as PROVEN.
    // That is the vacuous pass arriving by the back door.
    const { transport } = claimWorld({
      signInFailsFor: ["claimant1@example.com"],
      acceptAnyToken: true,
    });
    const r = await acceptClaimInvites({ base: BASE, invites: [invite(1), invite(2)], limit: 2, transport });
    expect(r.accepted).toBe(1);
    expect(r.acceptedPersonIds).toEqual(["person-2"]);
    expect(r.rejected[0]).toMatchObject({ person: "p-1", status: 401 });
    expect(r).toMatchObject({ invalidTokenRefused: false, invalidTokenStatus: 200 });
  });

  it("still REPORTS what a tampered token drew when nothing was accepted, without calling it proof", async () => {
    // The probe falls back to an unproven session so the report is not blank,
    // but `invalidTokenRefused` stays false: a refusal on a session this run
    // never proved says nothing about whether the token was checked.
    const r = await acceptClaimInvites({ base: BASE, invites: THREE, limit: 3, transport: refusingWorld(409) });
    expect(r).toMatchObject({ accepted: 0, invalidTokenStatus: 409, invalidTokenRefused: false });
  });

  it("reds when a tampered token is ACCEPTED", async () => {
    // The mutant this test exists for: a world that accepts anything.
    const anything: ProbeTransport = {
      async signIn() {
        return { has_org: false, org_id: "o", redirect: "/" };
      },
      async request<T>(): Promise<T> {
        throw new Error("unused");
      },
      async raw(): Promise<RawResult> {
        return { status: 200, json: { ok: true, data: { person_id: "whatever" } } as RawJson };
      },
    };
    const r = await acceptClaimInvites({ base: BASE, invites: THREE, limit: 3, transport: anything });
    expect(r.accepted).toBe(3);
    expect(r).toMatchObject({ invalidTokenRefused: false, invalidTokenStatus: 200 });
  });

  it("sends a tampered token that is the same SHAPE as a real one", async () => {
    // A token the product would reject on length or prefix would draw its
    // refusal from a validator rather than from the claim lookup, which is a
    // different guard than the one being proven.
    const { transport, calls } = claimWorld();
    await acceptClaimInvites({ base: BASE, invites: [invite(1)], limit: 1, transport });
    const tampered = calls.filter((c) => c.startsWith("POST /api/claims/")).map((c) => c.split("/")[3]!);
    expect(tampered).toHaveLength(2);
    expect(tampered[1]).not.toBe("pc_token1");
    expect(tampered[1]!.length).toBe("pc_token1".length);
    expect(tampered[1]!.startsWith("pc_")).toBe(true);
    // Every character after the prefix moves. One-character tampering turned
    // this very fixture into its own sibling token and drew a 409.
    expect(tampered[1]).toBe("pc_uplfo2");
  });

  it("reports nothing attempted, and no proof, for a pack that declares no invites", async () => {
    const { transport, calls } = claimWorld();
    const r = await acceptClaimInvites({ base: BASE, invites: [], limit: 3, transport });
    expect(r).toMatchObject({ attempted: 0, accepted: 0, invalidTokenRefused: false, invalidTokenStatus: null });
    expect(calls).toEqual([]);
  });
});
