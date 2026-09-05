// `dashboard.public.max` — the cap on LIVE public dashboards, after V395
// (entitlements v18 W2 T15, owner rulings 2026-09-03).
//
// Two rulings land on one function. The cap counts **active** public
// dashboards only, and a **passed** competition does not count against it.
// `assertPublicQuota` had neither clause: it was a flat
//
//     select count(*) from competitions where visibility = 'public'
//
// so a club that had run three seasons carried three public dashboards for
// ever and was refused a fourth while nothing at all was running. That is not
// a policy gap, it is a leak — the cap counted HISTORY rather than live
// surfaces, which is why 3 felt tight and the ruled-down 2 would have felt
// broken. `assertActiveQuota` twenty lines above had solved both halves
// already, and its own comment says why ("a competition past that boundary was
// keeping a free slot for ever"); the predicate is now shared rather than
// copied, so there is no fourth place for it to drift.
//
// Every number here is READ FROM THE MATRIX, never typed: the cap moved 1 -> 3
// -> 2 across three migrations, and a test carrying a literal would have had
// to be edited each time (and would have been wrong in between).
//
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` is a Next server-runtime API with no incrementalCache
// outside a real request, so the public readers below throw an Invariant under
// vitest. Passthrough only — everything else in `next/cache` stays REAL, so the
// revalidation `createCompetition` fires still runs its own try/catch rather
// than being silently stubbed out. Same double as
// server/__tests__/entitlements-v18-theme.test.ts and
// public-site/__tests__/consent.test.ts, for the identical reason.
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { publicDashboardsReason } from "@/lib/feature-copy";
import type { AuthCtx } from "@/server/api-v1/auth";
import { getPublicCompetition, getPublicOrg } from "@/server/public-site/data";
import { publicCompetition } from "../public";
import { createCompetition, patchCompetition } from "../competitions";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: "community" | "pro"): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pub " + suffix}, ${"pub-" + suffix})
    returning id`;
  if (plan !== "community") {
    await sql`
      with _owner as (
        insert into users (email, display_name, email_verified)
        values ('pubowner-' || gen_random_uuid() || '@test.local', 'Pub Owner', true)
        returning id
      ),
      _seed_sub as (
        insert into subscriptions (owner_user_id, plan_key, status)
        select coalesce(o.created_by, (select id from _owner)), ${plan}, 'active'
        from organizations o where o.id = ${orgId}
        returning id
      )
      update organizations set subscription_id = (select id from _seed_sub) where id = ${orgId}`;
  }
  // The ACTIVE-competition cap would fire first and mask everything here, so
  // lift that one axis for this org only. Same isolation the sibling probe in
  // entitlements-v2.test.ts uses.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'public-quota test')`;
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

const make = (
  auth: AuthCtx,
  name: string,
  visibility: "public" | "unlisted" | "private" = "public",
) => createCompetition(auth, { ends_on: "2030-12-31", name, visibility, branding: {} });

const orgSlugOf = async (auth: AuthCtx): Promise<string> => {
  const [row] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${auth.orgId}`;
  return row!.slug;
};

/** The cap the plan actually resolves — never a literal. */
const publicCap = async (auth: AuthCtx): Promise<number> => {
  const limit = await getLimit(auth.orgId, "dashboard.public.max");
  expect(limit, "dashboard.public.max must be a finite cap for this test to mean anything").not.toBeNull();
  return limit!;
};

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("assertPublicQuota counts LIVE public dashboards", () => {
  it("archived seasons do not hold a slot for ever", async () => {
    // THE REGRESSION THIS EXISTS FOR. Fill to one under the cap with live
    // competitions, then archive three more public ones — under the old flat
    // count those three still occupied slots and the next create was refused
    // (or, since the degrade below, silently turned private).
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i < cap; i += 1) await make(auth, `Live ${i}`);
    for (let i = 1; i <= 3; i += 1) {
      const past = await make(auth, `Season ${i}`);
      await sql`update competitions set status = 'archived' where id = ${past.id}`;
    }
    const next = await make(auth, "This season");
    expect(next.visibility).toBe("public");
  });

  it("still refuses once the LIVE public dashboards reach the cap", async () => {
    // The other direction, so the clause above cannot be satisfied by simply
    // deleting the cap. Enforced on the PATCH path, which still 402s — only
    // the CREATE path degrades (T15/F: never block a create).
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Live ${i}`);
    const extra = await make(auth, "One too many", "private");
    await expect(patchCompetition(auth, extra.id, { visibility: "public" } as never)).rejects.toMatchObject({
      status: 402,
      featureKey: "dashboard.public.max",
    });
  });

  it("a passed competition's public dashboard does not count against the cap", async () => {
    // v3/07 §3: an Event Pass buys its competition out of the quota, exactly as
    // `competitions.max_active` already treated it — for as long as the pass
    // APPLIES (V343's pass_applies), which is the shared predicate.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) {
      const comp = await make(auth, `Live ${i}`);
      if (i === 1) {
        await sql`
          insert into competition_passes (competition_id, org_id, pass_key)
          values (${comp.id}, ${auth.orgId}, 'event_pass')`;
      }
    }
    await invalidateOrgEntitlements(auth.orgId);
    // The org sits AT the cap by raw row count; one of those rows is passed, so
    // the live count is cap - 1 and there is room.
    const next = await make(auth, "Room because of the pass");
    expect(next.visibility).toBe("public");
  });

  it("a create at the cap is NEVER refused — it degrades to private", async () => {
    // T15/F, owner ruling 2026-09-03. Free is 3 active competitions against 2
    // public dashboards and competitions are public BY DEFAULT, so without
    // this the third create would fail by default on the plan whose one-line
    // sell is "run a club night". The competition must exist, and the caller
    // must be able to tell from the row it gets back that it is not public.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Live ${i}`);
    const degraded = await make(auth, "One over the cap");
    expect(degraded.id).toBeTruthy();
    expect(degraded.visibility).toBe("private");
  });

  it("the degrade is SIGNALLED in the response, never merely implied by the row", async () => {
    // T20 finding 1 (reviewer pass 3, 2026-09-03). A 201 that quietly returns
    // something other than what was asked for is wrong for EVERY consumer, not
    // just the one client that happens to diff the row it gets back. So the
    // response NAMES what happened and why, and — like the 402 the PATCH path
    // still raises — the cap travels WITH the note rather than being restated
    // in copy that goes stale the next time the number moves.
    //
    // `reason` is asserted through `publicDashboardsReason`, the same function
    // that builds the 402's, so a change to the sentence moves this test with
    // it instead of leaving it pinning yesterday's wording.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Live ${i}`);
    const degraded = await make(auth, "Signalled over the cap");
    expect(degraded.visibility).toBe("private");
    expect(degraded.public_quota_degraded).toEqual({
      feature_key: "dashboard.public.max",
      requested_visibility: "public",
      applied_visibility: "private",
      limit: cap,
      reason: publicDashboardsReason(cap),
    });
  });

  it("a create INSIDE the cap carries NO degrade note", async () => {
    // The other direction, so the assertion above cannot be satisfied by a
    // note that is simply always attached — which would train every consumer
    // to ignore it.
    const auth = await seedOrg("community");
    const inside = await make(auth, "Room to spare");
    expect(inside.visibility).toBe("public");
    expect(inside.public_quota_degraded).toBeUndefined();
  });

  it("the degrade drops the showcase opt-in with the visibility", async () => {
    // `discoverable` is hard-coupled to public visibility everywhere else in
    // this file (a 422 on the PATCH path, and on create for a caller that asks
    // for private + showcase). A degraded competition is a private one, so it
    // must not be left showcased on seazn.club.
    const auth = await seedOrg("community");
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${auth.orgId}, 'discovery.listed', true, 'public-quota test')`;
    await invalidateOrgEntitlements(auth.orgId);
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Live ${i}`);
    const degraded = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Showcased over the cap",
      visibility: "public",
      discoverable: true,
      branding: {},
    });
    expect(degraded.visibility).toBe("private");
    expect(degraded.discoverable).toBe(false);
  });

  it("Pro's cap is finite and larger than Free's (V395 retired 'unlimited public dashboards')", async () => {
    // Read from the matrix on both sides — the point is the ORDERING and the
    // finiteness, which is what the Pro card's old "unlimited" claim broke.
    const free = await seedOrg("community");
    const pro = await seedOrg("pro");
    const freeCap = await publicCap(free);
    const proCap = await publicCap(pro);
    expect(proCap).toBeGreaterThan(freeCap);
  });
});

// ── WHAT `unlisted` ACTUALLY EXPOSES ────────────────────────────────────────
//
// The premise the cap change rests on, established against the real anonymous
// read path rather than asserted. `public_competitions_v` — the ONLY relation
// the unauthenticated readers select from — is
//
//     ... from competitions where visibility = any (array['public','unlisted'])
//
// (pg_get_viewdef, 2026-09-05), and neither `getPublicCompetition` (the RSC
// dashboard) nor `publicCompetition` (/api/v1/public) adds a visibility filter
// of its own. The one reader that does is `getPublicOrg`, the org LANDING
// LIST. So `unlisted` withholds discoverability and nothing else: the dashboard
// itself is served, in full, to anyone holding the link.
//
// That is why the cap counts it — see PUBLICLY_READABLE_VISIBILITIES in
// ../competitions.ts. This test is the evidence for that comment, and it is
// deliberately independent of the cap: it would still hold if the cap were
// deleted tomorrow.
describe.skipIf(!HAS_DB)("`unlisted` is the public dashboard, minus the listing", () => {
  it("serves an anonymous reader the SAME dashboard it serves for a public one", async () => {
    const auth = await seedOrg("community");
    const listed = await make(auth, "Listed season");
    const linkOnly = await make(auth, "Link-only season", "unlisted");
    const orgSlug = await orgSlugOf(auth);

    // No AuthCtx, no withTenant, no session: this is the call the public page
    // and the public API make for a visitor who was handed a URL.
    const listedPage = await getPublicCompetition(orgSlug, listed.slug);
    const linkOnlyPage = await getPublicCompetition(orgSlug, linkOnly.slug);
    expect(listedPage, "the public competition renders").not.toBeNull();
    expect(linkOnlyPage, "so does the unlisted one").not.toBeNull();
    expect(linkOnlyPage!.competition.name).toBe("Link-only season");
    // Not merely "it renders": the reader is handed the same FIELDS. A
    // non-null assertion alone would pass against a stub that returned a name
    // and nothing else.
    expect(Object.keys(linkOnlyPage!.competition).sort()).toEqual(
      Object.keys(listedPage!.competition).sort(),
    );
    // …and the JSON API serves it too, so this is not one route's oversight.
    await expect(publicCompetition(orgSlug, linkOnly.slug)).resolves.toBeTruthy();

    // THE ONLY DIFFERENCE. `getPublicOrg` filters `visibility = 'public'`, so
    // the unlisted competition is absent from the org landing page — which is
    // discoverability, not readability.
    const landing = await getPublicOrg(orgSlug);
    const onLanding = landing!.competitions.map((c) => c.slug);
    expect(onLanding).toContain(listed.slug);
    expect(onLanding).not.toContain(linkOnly.slug);
  });

  it("still withholds a PRIVATE competition from the same anonymous reader", async () => {
    // The negative pair. Without it the assertion above is satisfied by a read
    // path that serves everything, and "unlisted is readable" would say nothing
    // about where the line actually falls.
    const auth = await seedOrg("community");
    const hidden = await make(auth, "Nobody's business", "private");
    const orgSlug = await orgSlugOf(auth);
    expect(await getPublicCompetition(orgSlug, hidden.slug)).toBeNull();
    await expect(publicCompetition(orgSlug, hidden.slug)).rejects.toMatchObject({ status: 404 });
  });
});

// ── THE CAP COUNTS WHAT IS PUBLICLY READABLE ────────────────────────────────
//
// Owner ruling 2026-09-05. The thing `dashboard.public.max` sells is a public
// dashboard — a URL an organiser hands to entrants and parents. Discoverability
// in the org listing is a nice-to-have on top of it. So a cap that counted only
// `visibility = 'public'` had a one-word bypass beside it, and Free carried
// unlimited public dashboards; a cap with a bypass is not a cap.
describe.skipIf(!HAS_DB)("`unlisted` counts against dashboard.public.max", () => {
  it("unlisted dashboards FILL the cap — the public create that follows degrades", async () => {
    // THE BYPASS, CLOSED. Before this the whole cap could be sidestepped by
    // typing one different word into the create form.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Link-only ${i}`, "unlisted");
    const degraded = await make(auth, "One over the cap");
    expect(degraded.visibility).toBe("private");
    expect(degraded.public_quota_degraded?.limit).toBe(cap);
  });

  it("a create that ASKS for unlisted at the cap degrades too, and names what it asked for", async () => {
    // The other half of the same bypass: asking for `unlisted` directly must
    // not be a way past the cap either. The note pins the REQUESTED value, not
    // just that a note exists — a note that always said "public" would tell the
    // caller something untrue about their own request.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Live ${i}`);
    const degraded = await make(auth, "Link-only over the cap", "unlisted");
    expect(degraded.visibility).toBe("private");
    expect(degraded.public_quota_degraded).toEqual({
      feature_key: "dashboard.public.max",
      requested_visibility: "unlisted",
      applied_visibility: "private",
      limit: cap,
      reason: publicDashboardsReason(cap),
    });
  });

  it("an unlisted create INSIDE the cap is created UNLISTED — never promoted to public", async () => {
    // The trap in the fix itself. `resolveCreateVisibility` returned a hardcoded
    // "public" on the happy path, which was harmless while only `public` ever
    // reached it; routing `unlisted` through the same branch would have
    // published a competition the organiser asked to keep off the listing.
    const auth = await seedOrg("community");
    const inside = await make(auth, "Room to spare, link-only", "unlisted");
    expect(inside.visibility).toBe("unlisted");
    expect(inside.public_quota_degraded).toBeUndefined();
  });

  it("a PRIVATE competition still holds no slot", async () => {
    // The negative pair for the clause above: the cap meters what is READABLE,
    // not what exists. Without this, `visibility in ('public','unlisted')` is
    // indistinguishable from dropping the filter altogether.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Hidden ${i}`, "private");
    const next = await make(auth, "Still room");
    expect(next.visibility).toBe("public");
  });

  it("switching an existing competition to unlisted at the cap is REFUSED", async () => {
    // The later transition. The PATCH path still 402s (only creates degrade),
    // and it guarded `=== "public"` alone — so a competition could be moved
    // into a publicly readable state over the cap with no answer at all.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    for (let i = 1; i <= cap; i += 1) await make(auth, `Live ${i}`);
    const extra = await make(auth, "Private for now", "private");
    await expect(
      patchCompetition(auth, extra.id, { visibility: "unlisted" } as never),
    ).rejects.toMatchObject({ status: 402, featureKey: "dashboard.public.max" });
  });

  it("public -> unlisted -> public neither frees a slot nor double-counts one", async () => {
    // BOTH DIRECTIONS. An idempotency-shaped guard that skips a legitimate
    // arrival is a failure this repo has shipped, so the lateral move must stay
    // possible (the org's readable count is unchanged by it) while not handing
    // the org a slot it can refill.
    const auth = await seedOrg("community");
    const cap = await publicCap(auth);
    const first = await make(auth, "Live 1");
    for (let i = 2; i <= cap; i += 1) await make(auth, `Live ${i}`);

    const sideways = await patchCompetition(auth, first.id, { visibility: "unlisted" } as never);
    expect(sideways.visibility, "a lateral move is not a new dashboard").toBe("unlisted");

    const filler = await make(auth, "Trying to take the freed slot");
    expect(filler.visibility, "the slot was never freed").toBe("private");

    const back = await patchCompetition(auth, first.id, { visibility: "public" } as never);
    expect(back.visibility, "and it can come back — excludeId, not a double count").toBe("public");
  });
});
