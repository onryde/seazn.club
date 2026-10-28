// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, insertEntitlementOverride, v1, v1data } from "../harness.ts";

/**
 * T20 — `dashboard.public.max` DEGRADES a create; it never refuses one, and it
 * is never silent about it.
 *
 * V396 made competitions public by default and (T15/F, owner ruling
 * 2026-09-03) made a create at the cap come back PRIVATE rather than 402 —
 * Free is 3 active competitions against 2 public dashboards, so under the old
 * refusal the third create on the plan whose one-line sell is "run a club
 * night" would have failed by default, with no wrong choice made by the
 * organiser. What was missing was the other half: the 201 said nothing, so a
 * caller had to diff the row it got against the row it asked for to notice,
 * and `public_fixtures_v` (`visibility = any('{public,unlisted}')`) then 404s
 * the link the organiser shares.
 *
 * Both create paths are asserted, because the TEMPLATE path is the one
 * `/competitions/new` opens on — it carried no visibility at all until T20 and
 * redirected straight into the silently private competition.
 *
 * Own fresh community org, so this cannot be satisfied by ambient state; the
 * cap is READ from the org's own entitlements rather than typed, because it
 * has been 1, 3 and 2 across three migrations and a literal here would have
 * been wrong in between. `competitions.max_active` (3 on community) is lifted
 * for this org only — it would fire first and mask the axis under test, the
 * same isolation `public-dashboard-quota.test.ts` documents. Keyless-safe.
 */
export async function publicQuotaDegradeSuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+pubquota_${tag}@resend.dev`);
  const orgId = who.org_id;
  await insertEntitlementOverride(owner, orgId, "competitions.max_active", 50);

  const ent = (await call(owner, `/api/orgs/${orgId}/entitlements`)) as {
    entitlements: Record<string, { limit?: number | null }>;
  };
  const cap = ent.entitlements["dashboard.public.max"]?.limit;
  check(
    "public quota: community resolves a FINITE public-dashboard cap to fill",
    typeof cap === "number" && cap >= 1,
  );
  const capN = typeof cap === "number" ? cap : 0;

  // Fill to the cap. Aggregated into one check so the check COUNT does not
  // move when the cap does.
  //
  // Each filler is PUBLISHED, because the cap meters `PUBLIC_DASHBOARD_STATUSES`
  // (published/live) — a draft shows the world nothing, so it holds no
  // public-dashboard slot. Filling with bare creates fills the cap with ZERO and
  // every check below it (the degrade, the note, the template path, the 402)
  // silently stops testing anything. The publishes themselves are all within the
  // cap, so the publish guard never fires here; it is proven in
  // `public-dashboard-quota.test.ts`.
  let fillClean = capN >= 1;
  for (let i = 1; i <= capN; i += 1) {
    const res = await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Quota Fill ${i} ${tag}`,
      visibility: "public",
    });
    const row = v1data<{ id: string; visibility: string; public_quota_degraded?: unknown }>(res);
    const published = await v1(owner, `/api/v1/competitions/${row.id}`, "PATCH", {
      status: "published",
    });
    fillClean &&=
      res.status === 201 &&
      row.visibility === "public" &&
      row.public_quota_degraded === undefined &&
      published.status === 200;
  }
  check(
    `public quota: all ${capN} creates up to the cap are public and carry NO note`,
    fillClean,
  );

  const over = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Quota Over ${tag}`,
    visibility: "public",
  });
  const overRow = v1data<{
    id: string;
    visibility: string;
    public_quota_degraded?: {
      feature_key?: string;
      requested_visibility?: string;
      applied_visibility?: string;
      limit?: number | null;
      reason?: string;
    };
  }>(over);
  check("public quota: the create AT the cap is 201, never 402", over.status === 201);
  check("public quota: and it comes back PRIVATE, not public", overRow.visibility === "private");
  const note = overRow.public_quota_degraded;
  check(
    "public quota: the 201 SAYS SO — feature key, both visibilities, and the LIVE cap in the reason",
    !!note &&
      note.feature_key === "dashboard.public.max" &&
      note.requested_visibility === "public" &&
      note.applied_visibility === "private" &&
      note.limit === capN &&
      typeof note.reason === "string" &&
      note.reason.includes(String(capN)),
  );

  // The DEFAULT create path. `visibility` is deliberately omitted, which is
  // both what the gallery sends and the case whose guard used to key on
  // `=== "public"` while its value keyed on `?? "public"` — skipping the quota
  // check entirely and creating a PUBLIC competition over the cap.
  const tmpl = await v1(owner, "/api/v1/competitions/from-template", "POST", {
    template_key: "slam128",
    name: `Quota Template ${tag}`,
    ends_on: "2030-12-31",
  });
  const tmplRow = v1data<{
    visibility: string;
    public_quota_degraded?: { feature_key?: string; applied_visibility?: string };
  }>(tmpl);
  check(
    "public quota: the TEMPLATE path degrades identically and carries the SAME note",
    tmpl.status === 201 &&
      tmplRow.visibility === "private" &&
      tmplRow.public_quota_degraded?.feature_key === "dashboard.public.max" &&
      tmplRow.public_quota_degraded?.applied_visibility === "private",
  );

  // The other direction, so "never refuses" cannot be satisfied by deleting
  // the cap: flipping an EXISTING competition to public is a deliberate act
  // with a wrong answer available, and still 402s.
  const patched = await v1(owner, `/api/v1/competitions/${overRow.id}`, "PATCH", {
    visibility: "public",
  });
  check(
    "public quota: the PATCH path still 402s — only a CREATE degrades",
    patched.status === 402 &&
      (patched.json.error as { feature_key?: string } | undefined)?.feature_key ===
        "dashboard.public.max",
  );
}
