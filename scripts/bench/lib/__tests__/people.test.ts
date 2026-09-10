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

// ---------------------------------------------------------------------------
// B06a Task 7 — news drafts and publication
// ---------------------------------------------------------------------------
//
// Five route facts, re-pinned 2026-09-10, and every one of them corrects the
// plan:
//
//  1. Drafting is NOT two preconditions, it is five, in order: the event must
//     decide or void (`scoring.ts:129`), `divisions.auto_posts` must be true
//     (`:353-356`, re-read at `org-posts.ts:479`), the org must hold
//     `news.auto` (`:480`), and the fixture's status must be one of
//     decided/finalized/forfeited (`:483-485`). Miss any and the call returns
//     `[]` — a legitimate zero, indistinguishable from a broken step.
//  2. `auto_posts` IS settable over the API (`PATCH /api/v1/divisions/{id}`,
//     `schemas.ts:429`), but setting it TRUE itself requires `news.auto`
//     (`usecases/divisions.ts:652-654`). So the plan has to be provisioned
//     before drafting can even be turned on — and because drafting is a side
//     effect of FOLDING, there is no later moment at which a run could notice
//     and recover.
//  3. `GET /orgs/{id}/posts?status=` SILENTLY IGNORES an unrecognised status
//     (`route.ts:19`) rather than answering 400 — so a typo returns every
//     post and a caller that trusted the filter would count published rows as
//     drafts. Every row's own `status` is checked here.
//  4. There is no competition or division filter on that route
//     (`org-posts.ts:163-167`); a caller filters client-side.
//  5. A post carries no fixture id on the wire, but `auto_source` does
//     (`org-posts.ts:509-510`: `trigger` and `fixture_id`), which is what
//     makes publishing NAMED fixtures possible at all.
//
// And the fact that changes an assertion: `shouldFirePostPublished`
// (`org-posts.ts:317-318`) fires a PostHog `captureServer` call and nothing
// else — no row, no outbox, no webhook. "Observed exactly once" is therefore
// not observable over HTTP. What IS observable is the thing the predicate
// protects: `published_at` is assigned only when it was null
// (`org-posts.ts:276,282`), so a second publish must not move it.
import { enableAutoPosts, runNewsStep, type NewsPost } from "../people.ts";

function post(n: number, over: Partial<NewsPost> = {}): NewsPost {
  return {
    id: `post-${n}`,
    status: "draft",
    competition_id: "comp-1",
    division_id: "div-1",
    published_at: null,
    auto_source: { trigger: "result", fixture_id: `fx-${n}` },
    ...over,
  };
}

/** A news world that behaves the way the product does on the five facts
 *  above. Not an echo: it refuses `auto_posts: true` without the entitlement,
 *  ignores an unrecognised `status` filter exactly as the route does, and
 *  leaves `published_at` alone on a republish. */
function newsWorld(
  opts: {
    readonly posts?: readonly NewsPost[];
    readonly newsAutoGranted?: boolean;
    /** The mutant made reachable: a republish that DOES move `published_at`. */
    readonly republishBumpsTimestamp?: boolean;
    /**
     * Answer EVERY post whatever `status` was asked for — the route's real
     * behaviour when the value is not one it recognises (`route.ts:19` ignores
     * it rather than answering 400). Without this the world honours the filter
     * itself, the per-row status check downstream is never load-bearing, and a
     * mutant that deletes it survives. It did, on the first sweep.
     */
    readonly ignoreStatusFilter?: boolean;
  } = {},
): { transport: ProbeTransport; calls: string[]; rows: Map<string, NewsPost> } {
  const rows = new Map((opts.posts ?? [post(1), post(2), post(3), post(4)]).map((p) => [p.id, p]));
  const calls: string[] = [];
  let clock = 0;
  const transport: ProbeTransport = {
    async signIn() {
      return { has_org: true, org_id: "org-1", redirect: "/" };
    },
    async request<T>(): Promise<T> {
      throw new Error("newsWorld: request() is never used by the news flow");
    },
    async raw(_base, _s, path, method = "GET", body): Promise<RawResult> {
      calls.push(`${method} ${path}`);
      if (method === "PATCH" && /^\/api\/v1\/divisions\/[^/]+$/.test(path)) {
        // `divisions.ts:652-654` — turning it ON needs the entitlement;
        // turning it off is always allowed.
        const wants = (body as { auto_posts?: boolean }).auto_posts === true;
        if (wants && opts.newsAutoGranted === false) {
          return { status: 402, json: { ok: false, error: "news.auto required" } as RawJson };
        }
        return { status: 200, json: { ok: true, data: { auto_posts: wants } } as RawJson };
      }
      const list = /^\/api\/v1\/orgs\/([^/]+)\/posts(\?.*)?$/.exec(path);
      if (method === "GET" && list !== null) {
        const q = new URLSearchParams((list[2] ?? "").replace(/^\?/, ""));
        const status = q.get("status");
        const all = [...rows.values()];
        // The route's own behaviour: an UNRECOGNISED status is ignored, not
        // rejected. Modelling that is what lets a caller that trusted the
        // filter be caught here rather than on a live run.
        const known =
          opts.ignoreStatusFilter !== true &&
          (status === "draft" || status === "published" || status === "archived");
        return {
          status: 200,
          json: { ok: true, data: known ? all.filter((p) => p.status === status) : all } as RawJson,
        };
      }
      const patch = /^\/api\/v1\/posts\/([^/]+)$/.exec(path);
      if (method === "PATCH" && patch !== null) {
        const row = rows.get(patch[1]!);
        if (row === undefined) return { status: 404, json: { ok: false, error: "no such post" } as RawJson };
        const action = (body as { action?: string }).action;
        if (action !== "publish") return { status: 400, json: { ok: false, error: "unsupported action" } as RawJson };
        const neverPublished = row.published_at === null;
        const next: NewsPost = {
          ...row,
          status: "published",
          published_at:
            neverPublished || opts.republishBumpsTimestamp === true
              ? `2026-09-10T00:00:${String(++clock).padStart(2, "0")}Z`
              : row.published_at,
        };
        rows.set(next.id, next);
        return { status: 200, json: { ok: true, data: next } as RawJson };
      }
      throw new Error(`newsWorld: unhandled ${method} ${path}`);
    },
  };
  return { transport, calls, rows };
}

describe("enableAutoPosts", () => {
  it("turns drafting on for every division and reports the count", async () => {
    const { transport, calls } = newsWorld();
    const r = await enableAutoPosts({ base: BASE, divisionIds: ["div-1", "div-2"], transport, session: {} as Session });
    expect(r).toMatchObject({ requested: 2, enabled: 2, refused: [] });
    expect(calls).toEqual(["PATCH /api/v1/divisions/div-1", "PATCH /api/v1/divisions/div-2"]);
  });

  it("records the 402 rather than throwing when the org cannot buy news.auto", async () => {
    // The outcome that decides whether the whole news step has a subject.
    // Drafting is a side effect of folding, so a run that swallowed this
    // would discover an empty draft list much later and have no way to tell
    // it from a product defect.
    const { transport } = newsWorld({ newsAutoGranted: false });
    const r = await enableAutoPosts({ base: BASE, divisionIds: ["div-1"], transport, session: {} as Session });
    expect(r).toMatchObject({ requested: 1, enabled: 0 });
    expect(r.refused[0]).toMatchObject({ divisionId: "div-1", status: 402 });
  });
});

describe("runNewsStep", () => {
  const args = (transport: ProbeTransport, publishFixtureIds: readonly string[]) => ({
    base: BASE,
    session: {} as Session,
    orgId: "org-1",
    competitionId: "comp-1",
    publishFixtureIds,
    transport,
  });

  it("publishes exactly the named fixtures' posts and leaves the rest draft", async () => {
    const { transport } = newsWorld();
    const r = await runNewsStep(args(transport, ["fx-1", "fx-3"]));
    expect(r).toMatchObject({ drafted: 4, published: 2, stillDraft: 2, requestedButNotDrafted: [] });
  });

  it("names a requested fixture that has no draft rather than quietly publishing fewer", async () => {
    const { transport } = newsWorld();
    const r = await runNewsStep(args(transport, ["fx-1", "fx-99"]));
    expect(r).toMatchObject({ published: 1, requestedButNotDrafted: ["fx-99"] });
  });

  it("counts only posts belonging to THIS run's competition", async () => {
    // The route carries no competition filter, so a shared org's other
    // competitions would inflate every number here.
    const { transport } = newsWorld({
      posts: [post(1), post(2, { competition_id: "comp-other" }), post(3, { competition_id: null })],
    });
    const r = await runNewsStep(args(transport, ["fx-1"]));
    expect(r).toMatchObject({ drafted: 1, published: 1, stillDraft: 0 });
  });

  it("does not trust the status filter — it checks each row's own status", async () => {
    // `route.ts:19` ignores an unrecognised status instead of answering 400,
    // so a caller that trusted the query string would count a published post
    // as a draft. `ignoreStatusFilter` makes this world behave that way, which
    // is the whole point: with the world honouring the filter itself, the
    // per-row check downstream is never load-bearing and a mutant that deletes
    // it SURVIVES. It did, on the first sweep.
    const { transport } = newsWorld({
      ignoreStatusFilter: true,
      posts: [post(1), post(2, { status: "published", published_at: "2026-09-01T00:00:00Z" })],
    });
    const r = await runNewsStep(args(transport, ["fx-1"]));
    expect(r.drafted).toBe(1);
    // …and the published row is not republished by accident either: only the
    // draft this run published is probed.
    expect(r).toMatchObject({ published: 1, republishProbed: true });
  });

  it("a second publish of the same post does not move published_at", async () => {
    const { transport } = newsWorld();
    const r = await runNewsStep(args(transport, ["fx-1"]));
    expect(r).toMatchObject({ republishProbed: true, republishWasInert: true });
  });

  it("reds when a republish DOES move published_at", async () => {
    const { transport } = newsWorld({ republishBumpsTimestamp: true });
    const r = await runNewsStep(args(transport, ["fx-1"]));
    expect(r).toMatchObject({ republishProbed: true, republishWasInert: false });
  });

  it("reports zero drafted, and probes nothing, when no fixture drafted a post", async () => {
    // The legitimate-zero case the five preconditions make reachable. It must
    // report NO SUBJECT upstream, never a pass on an empty set — and it must
    // not claim the fire-once proxy was tested when there was nothing to
    // publish.
    const { transport } = newsWorld({ posts: [] });
    const r = await runNewsStep(args(transport, ["fx-1"]));
    expect(r).toMatchObject({
      drafted: 0,
      published: 0,
      stillDraft: 0,
      republishProbed: false,
      republishWasInert: false,
    });
  });

  it("publishes nothing when asked for nothing, and says the drafts are still there", async () => {
    const { transport } = newsWorld();
    const r = await runNewsStep(args(transport, []));
    expect(r).toMatchObject({ drafted: 4, published: 0, stillDraft: 4, republishProbed: false });
  });
});
