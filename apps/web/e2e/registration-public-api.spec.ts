// RS003 — the public registration endpoints, driven over HTTP against a real
// prod build. No UI: the register PAGE renders its closed state until RS006,
// but the ENDPOINTS are live now, so these run through `request` exactly as
// payments-hardening.spec.ts already does for its money flows.
//
// Why this exists at all: RS003's prompt deferred e2e to RS006/RS007 on the
// grounds of "no UI yet", but RULES.md is explicit that a backend change still
// owes an e2e — trace forward to the flow it serves. A public, unauthenticated,
// money-touching endpoint with zero e2e is exactly the gap that rule is about.
//
// ── What this file deliberately does NOT test, and why ──────────────────────
// * RATE LIMITS. e2e.yml:130 sets no REDIS_URL on purpose, so `rateLimit` is
//   INERT here (lib/rate-limit.ts: no count from Redis → always allow). A
//   "fire 11 requests, expect 429" spec would pass whether or not the route
//   calls the limiter at all. That assertion lives in the unit suites, where
//   the module is mocked and the exact bucket keys are pinned.
// * A REAL checkout_url. CI runs with STRIPE_SECRET_KEY=sk_test_ci_e2e_dummy
//   and never sets STRIPE_MOCK_HOST, so any mint reaches the real Stripe API
//   and fails. Asserting a live URL here would be asserting the environment,
//   not the code. What that DOES make free to test honestly is the failure
//   path — see "Stripe unreachable" below, which is the production behaviour
//   when an organiser's Connect setup breaks.
import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { apiJson, TAG } from "./helpers";

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
          ? false
          : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function ensureSports(sql: import("postgres").Sql): Promise<string> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    -- Bare, not a column list: the real key is (sport_key, key, org_scope),
    -- so naming (sport_key, key) raises "no unique or exclusion constraint
    -- matching the ON CONFLICT specification".
    on conflict do nothing`;
  const [row] = await sql<{ module_version: string }[]>`
    select module_version from sports where key = 'generic'`;
  return row!.module_version;
}

interface Rig {
  orgSlug: string;
  compSlug: string;
  divisionId: string;
  teamDivisionId: string;
}

/** One org + competition with two divisions: an individual one and a team one
 *  (the latter is what mints a `join_code`, which the join endpoint needs).
 *  `connected` decides whether card intake is even attempted — see the
 *  Stripe-unreachable case. */
async function seedRig(opts: {
  feeCents?: number;
  capacity?: number | null;
  connected?: boolean;
} = {}): Promise<Rig> {
  const tag = randomBytes(5).toString("hex");
  const fee = opts.feeCents ?? 0;
  return withDb(async (sql) => {
    const moduleVersion = await ensureSports(sql);
    const [{ id: ownerId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${`rs003-owner-${TAG}-${tag}@example.com`}, ${"RS003 Owner " + tag}, true)
      returning id`;
    const orgSlug = `rs003-org-${TAG}-${tag}`;
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations
        (name, slug, status, created_by, currency, stripe_charges_enabled, stripe_account_id)
      values (${"RS003 Org " + tag}, ${orgSlug}, 'active', ${ownerId}, 'gbp',
              ${opts.connected ?? false}, ${opts.connected ? `acct_e2e_${tag}` : null})
      returning id`;
    const compSlug = `rs003-cup-${TAG}-${tag}`;
    const [{ id: compId }] = await sql<{ id: string }[]>`
      insert into competitions
        (org_id, name, slug, visibility, branding, starts_on, ends_on, discoverable)
      values (${orgId}, ${"RS003 Cup " + tag}, ${compSlug}, 'public',
              ${sql.json({})}, '2026-09-15', '2026-09-20', false)
      returning id`;

    async function division(name: string, slug: string, kind: "individual" | "team") {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into divisions
          (competition_id, name, slug, sport_key, variant_key, config, module_version,
           eligibility, tiebreakers, youth)
        values (${compId}, ${name}, ${slug}, 'generic', 'score',
                ${sql.json(GENERIC_CONFIG)}, ${moduleVersion}, ${sql.json([])}, null, false)
        returning id`;
      await sql`
        insert into registration_settings
          (division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
           fee_cents, refund_lock_at, form_fields, payment_method,
           payment_instructions, approval, allow_free_agents, updated_at)
        values (${id}, true, ${kind}, null, null, ${opts.capacity ?? null},
                ${fee}, null, ${sql.json([])}, ${fee > 0 ? "stripe" : "offline"},
                null, 'auto', false, now())`;
      return id;
    }

    return {
      orgSlug,
      compSlug,
      divisionId: await division("Open", `open-${tag}`, "individual"),
      teamDivisionId: await division("Teams", `teams-${tag}`, "team"),
    };
  });
}

const registerPath = (r: Rig) =>
  `/api/v1/public/orgs/${r.orgSlug}/competitions/${r.compSlug}/register`;

function individualEntry(divisionId: string, who: string) {
  return {
    division_id: divisionId,
    entrant_kind: "individual",
    players: [{ full_name: who }],
    answers: {},
  };
}

function cart(over: Record<string, unknown> = {}) {
  const who = `E2E Player ${randomBytes(3).toString("hex")}`;
  return {
    contact: {
      name: who,
      email: `${who.toLowerCase().replace(/\W+/g, "-")}@example.com`,
    },
    privacy_consent: true,
    ...over,
  };
}

interface GroupResponse {
  group_id: string;
  ref_code: string | null;
  access_token: string;
  currency: string;
  amount_cents: number;
  checkout_url: string | null;
  entries: { registration_id: string; division_id: string; status: string; join_code: string | null }[];
}

async function submitCart(request: APIRequestContext, rig: Rig, body: unknown) {
  return apiJson<GroupResponse>(request, registerPath(rig), "POST", body);
}

test.describe("RS003 public registration API", () => {
  test("a free cart persists and comes back with a ref, a token and no payment link", async ({
    request,
  }) => {
    const rig = await seedRig();
    const { status, data } = await submitCart(
      request,
      rig,
      cart({ entries: [individualEntry(rig.divisionId, "Solo One")] }),
    );

    expect(status).toBe(201);
    expect(data?.entries).toHaveLength(1);
    expect(data?.entries[0]!.status).toBe("confirmed");
    expect(data?.ref_code).toBeTruthy();
    expect(data?.access_token).toBeTruthy();
    expect(data?.amount_cents).toBe(0);
    // Free cart: nothing to charge, so no session is minted at all.
    expect(data?.checkout_url).toBeNull();

    // The row is really there — a 201 with no persistence would pass every
    // assertion above.
    const rows = await withDb((sql) =>
      sql<{ id: string }[]>`select id from registrations where group_id = ${data!.group_id}`,
    );
    expect(rows).toHaveLength(1);
  });

  // B2 review findings: registrationIcs (usecases/registrations.ts) had ZERO
  // e2e/smoke coverage before this — the DB-integration suite pins the exact
  // VALUE correctness (folding, localized DESCRIPTION), this proves the real
  // route serves it over HTTP with the fix's new CALSCALE/METHOD lines.
  test("the registration confirmation .ics downloads over HTTP with a well-formed VCALENDAR", async ({
    request,
  }) => {
    const rig = await seedRig();
    const { data } = await submitCart(
      request,
      rig,
      cart({ entries: [individualEntry(rig.divisionId, "Cal One")] }),
    );
    expect(data?.access_token, "a real token to fetch the .ics with").toBeTruthy();
    const regId = data!.entries[0]!.registration_id;

    const res = await request.get(
      `/api/v1/public/registrations/${regId}/ics?token=${data!.access_token}`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/calendar");

    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("CALSCALE:GREGORIAN");
    expect(body).toContain("METHOD:PUBLISH");
    expect(body).toContain(`UID:registration-${regId}@seazn.club`);
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  test("one cart spanning two divisions creates one group and two entries", async ({ request }) => {
    const rig = await seedRig();
    const { status, data } = await submitCart(
      request,
      rig,
      cart({
        entries: [
          individualEntry(rig.divisionId, "Cart One"),
          {
            division_id: rig.teamDivisionId,
            entrant_kind: "team",
            team_name: `Aces ${randomBytes(2).toString("hex")}`,
            players: [{ full_name: "Cart One" }, { full_name: "Cart Two" }],
            answers: {},
          },
        ],
      }),
    );

    expect(status).toBe(201);
    expect(data?.entries).toHaveLength(2);
    const groups = await withDb((sql) =>
      sql<{ n: number }[]>`
        select count(distinct group_id)::int as n from registrations
        where group_id = ${data!.group_id}`,
    );
    expect(groups[0]!.n).toBe(1);
    // A team entry mints a join code; the individual one does not.
    const team = data!.entries.find((e) => e.division_id === rig.teamDivisionId);
    expect(team?.join_code).toBeTruthy();
  });

  test("a filled honeypot is refused and writes nothing", async ({ request }) => {
    const rig = await seedRig();
    const { status, error } = await submitCart(
      request,
      rig,
      cart({
        entries: [individualEntry(rig.divisionId, "Bot One")],
        website: "http://spam.example",
      }),
    );

    expect(status).toBe(400);
    expect(error?.message).toBe("Registration failed");
    const rows = await withDb((sql) =>
      sql<{ n: number }[]>`
        select count(*)::int as n from registrations r
        where r.division_id = ${rig.divisionId}`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  test("a cart over the 10-entry cap is refused before anything is written", async ({ request }) => {
    const rig = await seedRig();
    const { status } = await submitCart(
      request,
      rig,
      cart({
        entries: Array.from({ length: 11 }, (_, i) => individualEntry(rig.divisionId, `Over ${i}`)),
      }),
    );

    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    const rows = await withDb((sql) =>
      sql<{ n: number }[]>`
        select count(*)::int as n from registrations where division_id = ${rig.divisionId}`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  // RS006: a registrant may self-link on more than one cart entry (singles +
  // doubles at the same tournament is the common racket-sports pattern) —
  // this used to be refused cart-wide; that cap was a defect, not a rule.
  test("two self-declarations across different entries in one cart both succeed", async ({ request }) => {
    const rig = await seedRig();
    const { status, data } = await submitCart(
      request,
      rig,
      cart({
        contact: {
          name: "Self Twice",
          email: `self-twice-${randomBytes(3).toString("hex")}@example.com`,
          dob: "1990-05-05",
        },
        entries: [
          { ...individualEntry(rig.divisionId, "Self Twice"), registering_self: true, self_player_index: 0 },
          {
            division_id: rig.teamDivisionId,
            entrant_kind: "team",
            team_name: `Self Twice Team ${randomBytes(2).toString("hex")}`,
            players: [{ full_name: "Self Twice" }, { full_name: "Team Mate" }],
            answers: {},
            registering_self: true,
            self_player_index: 0,
          },
        ],
      }),
    );

    expect(status).toBe(201);
    expect(data?.entries).toHaveLength(2);
    expect(data?.entries.every((e) => e.status === "confirmed")).toBe(true);
  });

  test("a full division waitlists the entry at zero and never quotes a payment", async ({
    request,
  }) => {
    const rig = await seedRig({ capacity: 1 });
    const first = await submitCart(
      request,
      rig,
      cart({ entries: [individualEntry(rig.divisionId, "Spot Holder")] }),
    );
    expect(first.status).toBe(201);

    const second = await submitCart(
      request,
      rig,
      cart({ entries: [individualEntry(rig.divisionId, "Waitlisted")] }),
    );
    expect(second.status).toBe(201);
    expect(second.data?.entries[0]!.status).toBe("waitlisted");
    // Owner ruling 7: a waitlisted entry is never charged at submit.
    expect(second.data?.amount_cents).toBe(0);
    expect(second.data?.checkout_url).toBeNull();
  });

  // The production behaviour when an organiser's Connect setup is broken: the
  // cart is already COMMITTED by the time minting runs, so a mint failure must
  // not be reported as a failed registration — the registrant would lose their
  // ref and access token and simply submit again, duplicating the cart.
  // CI's dummy Stripe key makes this the cheapest honest way to prove it.
  test("a paid cart whose checkout cannot be minted still persists, with no payment link", async ({
    request,
  }) => {
    const rig = await seedRig({ feeCents: 500, connected: true });
    const { status, data } = await submitCart(
      request,
      rig,
      cart({ entries: [individualEntry(rig.divisionId, "Payer One")] }),
    );

    expect(status).toBe(201);
    expect(data?.checkout_url).toBeNull();
    expect(data?.ref_code).toBeTruthy();
    expect(data?.access_token).toBeTruthy();
    const rows = await withDb((sql) =>
      sql<{ status: string; amount_cents: number }[]>`
        select status, amount_cents from registrations where group_id = ${data!.group_id}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.amount_cents).toBe(500);
  });

  // The squad cap is `sports.position_catalog.lineup.size + benchMax`, and the
  // seeded `generic` sport declares size 1 / benchMax 0 — so a team entry that
  // already carries a captain is ALREADY FULL and a join correctly 422s. The
  // rep therefore registers the team with no roster and shares the join link,
  // which is the flow design §4 describes ("captain's copy-join-link").
  test("a join code adds a player to the existing team entry", async ({ request }) => {
    const rig = await seedRig();
    const created = await submitCart(
      request,
      rig,
      cart({
        entries: [
          {
            division_id: rig.teamDivisionId,
            entrant_kind: "team",
            team_name: `Joiners ${randomBytes(2).toString("hex")}`,
            players: [],
            answers: {},
          },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const joinCode = created.data!.entries[0]!.join_code;
    expect(joinCode).toBeTruthy();

    const joined = await apiJson<{ registration_id: string; player_id: string }>(
      request,
      `${registerPath(rig)}/join`,
      "POST",
      { join_code: joinCode, player: { full_name: "Late Joiner" } },
    );
    expect(joined.status).toBe(201);
    expect(joined.data?.player_id).toBeTruthy();

    const players = await withDb((sql) =>
      sql<{ full_name: string; source: string }[]>`
        select full_name, source from registration_players
        where registration_id = ${created.data!.entries[0]!.registration_id}
        order by created_at`,
    );
    expect(players.map((p) => p.full_name)).toEqual(["Late Joiner"]);
    expect(players[0]!.source).toBe("self_joined");
  });

  test("an unknown join code 404s", async ({ request }) => {
    const rig = await seedRig();
    const { status } = await apiJson(request, `${registerPath(rig)}/join`, "POST", {
      join_code: `SZJOIN${randomBytes(4).toString("hex").toUpperCase()}`,
      player: { full_name: "Nobody" },
    });
    expect(status).toBe(404);
  });
});
