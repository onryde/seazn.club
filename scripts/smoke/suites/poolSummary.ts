import postgres from "postgres";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/**
 * RS012 — the solo sign-up pool, made visible in the demo per this repo's
 * standing rule that every new feature updates the smoke script.
 *
 * NOT plan-gated: RS012 shipped no new entitlement (checked —
 * registration-submit.ts's pool refusal and registrations.ts's
 * soloPoolIsFull carry no requireFeature/requirePlan beyond the
 * "registration.enabled" every division already needs), so this is ONE
 * suite on a single org rather than the pro-then-downgrade-to-community
 * pattern registrationPaidLoopSuite's siblings use for a gated feature —
 * there is no gate to prove holds on one plan and not the other
 * (eligibilityGateSuite just above this file's RS011 section makes the
 * identical call for the same reason).
 *
 * Uses the dev DB's REAL "generic"/"score" sport variant, never a
 * synthetic test-only sport with a hand-picked roster shape — pinning the
 * derived pool-bound arithmetic (capacity × roster_cap − seated) precisely
 * is the vitest/e2e layer's job (fetch-pool-summary.test.ts,
 * registration-submit.test.ts's regression case, and the walkthrough at
 * e2e/walkthrough/rs012-solo-signup-pool.spec.ts). This suite's only job is
 * proving the feature is REACHABLE and VISIBLE in the demo: a solo
 * sign-up submits, reads its own "waiting" status, and the organiser's
 * Registrants tab shows the pool summary banner for it.
 */
export async function poolSummarySuite(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+pool_${tag}@resend.dev`);
  const orgId = who.org_id;
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === orgId)!.slug;

  const genericConfig = {
    resultMode: "score",
    allowDraws: true,
    points: { w: 3, d: 1, l: 0 },
    progressScore: false,
  };

  // Defensive sports seed (same fallback v1Suite/registrationPaidLoopSuite
  // already use): CI runs sync:sports, so this only matters for a local run
  // against a DB that hasn't, and only ever adds rows nothing else owns.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl);
    const db = postgres(dbUrl, {
      connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
      ssl: process.env.DATABASE_SSL === "disable" ? false : isLocal ? false : "require",
      prepare: !dbUrl.includes(":6543"),
      max: 1,
    });
    try {
      await db`insert into sports (key, name, module_version, position_catalog)
               values ('generic', 'Generic', '1.0.0', ${db.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
               on conflict (key) do nothing`;
      await db`insert into sport_variants (sport_key, key, name, config, is_system)
               values ('generic', 'score', 'Score', ${db.json(genericConfig)}, true)
               on conflict do nothing`;
    } finally {
      await db.end();
    }
  }

  const comp = v1data<{ id: string; slug: string }>(
    await v1(owner, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Pool Cup ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(owner, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Pool Teams",
      sport_key: "generic",
      variant_key: "score",
      config: genericConfig,
    }),
  );
  const settingsRes = await v1(owner, `/api/v1/divisions/${div.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "team",
    capacity: 5,
    fee_cents: 0,
    form_fields: [],
    allow_free_agents: true,
  });
  check("pool: division accepts solo sign-ups (allow_free_agents on)", settingsRes.status === 200);

  const soloName = `Pool Solo ${tag}`;
  const submitted = await v1(
    newSession(),
    `/api/v1/public/orgs/${orgSlug}/competitions/${comp.slug}/register`,
    "POST",
    {
      contact: { name: soloName, email: `delivered+pool_solo_${tag}@resend.dev` },
      privacy_consent: true,
      entries: [
        {
          division_id: div.id,
          entrant_kind: "team",
          free_agent: true,
          players: [{ full_name: soloName }],
          answers: {},
        },
      ],
    },
  );
  type SubmitOut = { group_id: string; access_token: string };
  const out = v1data<SubmitOut>(submitted);
  check("pool: a solo sign-up submits (RS012 ruling 1 — never refused for lack of a team slot)", submitted.status === 201);

  // The registrant's OWN status page — a plain HTML page, no /api/v1 route
  // for it (buildGroupStatusView is a server-component read) — same `html()`
  // convention this file already uses for every other rendered-page check.
  const statusPage = await html(
    newSession(),
    `/shared/${orgSlug}/${comp.slug}/register/status?rid=${out.group_id}&token=${out.access_token}`,
  );
  check(
    "pool: the unassigned solo sign-up's status page says it's waiting for a team",
    statusPage.status === 200 && statusPage.body.includes("Waiting for a team"),
  );

  // The organiser's Registrants tab — the pool summary banner
  // (registration-hub-registrants-panel.tsx) renders only when some
  // division actually has someone waiting.
  const registrantsPage = await html(owner, `/o/${orgSlug}/c/${comp.slug}/registration?tab=registrants`);
  check(
    "pool: the Registrants tab surfaces the pool summary banner for the waiting solo sign-up",
    registrantsPage.status === 200 && registrantsPage.body.includes("Solo sign-ups waiting for a team"),
  );
}
