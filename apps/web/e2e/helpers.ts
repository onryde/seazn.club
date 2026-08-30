import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
// Type-only, so nothing from the app is pulled into the Playwright runtime —
// the same import event-pass.spec.ts already makes. Naming the rung union here
// rather than re-declaring it is what keeps a new rung from needing a sixth
// hand-maintained list.
import type { PassKey } from "../src/lib/currency";

/**
 * v3/02 §4 viewport gate: the page-level rule is "no horizontal scroll,
 * ever" — anything wide must scroll inside its OWN container (pattern 4,
 * `.scroll-x` = `overflow-x-auto`; see globals.css:367 and the table note at
 * globals.css:278).
 *
 * Measures GEOMETRY, not a scroll metric — but the real one, not a per-element
 * brute-force scan. `globals.css:63` sets `overflow-x: clip` on `html, body`,
 * which pins `document.documentElement.scrollWidth` to the viewport width no
 * matter how far a child overflows — the previous implementation compared
 * exactly `scrollWidth` to `clientWidth` and therefore could not fail (#325).
 *
 * The fix is NOT "walk every element and flag whichever has the widest
 * `getBoundingClientRect().right`": every page with a sanctioned `.scroll-x`
 * table (pricing's comparison table, the help-article tables at
 * globals.css:278) has descendants that are legitimately wider than the
 * viewport — that is the *point* of `overflow-x-auto`, and a scan blind to
 * containment flags them as page overflow when they are not (confirmed
 * empirically against /pricing: the comparison table's own cells report
 * `rect.right` at 648px against a 375px viewport, yet the page's real
 * `scrollWidth` — clip disabled — is exactly 375, because the `.scroll-x`
 * ancestor clips/scrolls it internally and it never reaches the document).
 *
 * So this temporarily lifts the `clip` (both `html` and `body` carry it) and
 * reads the browser's own `scrollWidth`, which already accounts for nested
 * scroll containers correctly — a naked 900px probe on `body` (no scrolling
 * ancestor) reports 900 against a 375px viewport; the pricing table reports
 * 375. Only when a REAL overflow is found does it walk the DOM for a culprit,
 * skipping anything contained by its own `overflow-x: auto|scroll|hidden`
 * ancestor, so the failure message still names something actionable.
 *
 * `allowancePx` exists for sub-pixel rounding on transformed/scaled elements
 * only. It is NOT a place to park a real overflow — raise it and you are
 * turning the check back off.
 */
export async function expectNoHorizontalScroll(
  page: Page,
  opts: { allowancePx?: number } = {},
): Promise<void> {
  const allowance = opts.allowancePx ?? 1;
  const worst = await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const vw = html.clientWidth;

    const htmlPrev = html.style.overflowX;
    const bodyPrev = body.style.overflowX;
    html.style.overflowX = "visible";
    body.style.overflowX = "visible";
    const scrollWidth = html.scrollWidth;
    html.style.overflowX = htmlPrev;
    body.style.overflowX = bodyPrev;

    const overflowPx = Math.max(0, scrollWidth - vw);
    let culprit = "";
    if (overflowPx > 0) {
      // Find a human-readable offender: the widest element NOT contained by
      // its own scrolling ancestor (a `.scroll-x` table is allowed to be wider
      // than the viewport; only an un-contained element actually causes the
      // page-level overflow measured above).
      let widestRight = vw;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        let contained = false;
        for (let node = el.parentElement; node && node !== body; node = node.parentElement) {
          const ox = getComputedStyle(node).overflowX;
          if (ox === "auto" || ox === "scroll" || ox === "hidden") {
            contained = true;
            break;
          }
        }
        if (contained) continue;
        if (rect.right > widestRight) {
          widestRight = rect.right;
          culprit = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${
            el.className && typeof el.className === "string"
              ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
              : ""
          }`;
        }
      }
    }
    return { overflowPx, culprit, vw };
  });
  expect(
    worst.overflowPx,
    `page overflows horizontally by ${worst.overflowPx}px past the ${worst.vw}px viewport — widest offender: ${worst.culprit || "(unknown — no un-contained element found; check nested scroll containers)"}`,
  ).toBeLessThanOrEqual(allowance);
}

/**
 * Native dialogs are banned (v3/03 §3). Arm this before any delete-ish click:
 * a window.confirm/alert firing anywhere fails the test.
 */
export function failOnNativeDialog(page: Page): void {
  page.on("dialog", (dialog) => {
    void dialog.dismiss();
    throw new Error(`native ${dialog.type}() fired — use the ConfirmDialog provider`);
  });
}

// Shared test tag so parallel/rerun state never collides.
export const TAG = Date.now().toString(36);
export const proEmail = () => `e2e-pro-${TAG}@example.com`;
export const communityEmail = () => `e2e-community-${TAG}@example.com`;

// True when the server under test is a production build (e.g. staging): it
// never dev-exposes login/claim links, so auth helpers mint tokens straight in
// the DB and the specs that assert dev exposure skip themselves.
export const PROD_TARGET = !!process.env.E2E_PROD_TARGET;

// Thin JSON helpers over the app's own endpoints — used to set up heavy state
// (scoring, entrants) fast so specs assert on UI, not on data entry speed.
export async function apiJson<T = unknown>(
  request: APIRequestContext,
  path: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<{ status: number; data?: T; error?: { code?: string; message?: string } }> {
  const res = await request.fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { data: body } : {}),
  });
  const json = (await res.json().catch(() => ({ ok: false }))) as {
    ok: boolean;
    data?: T;
    error?: { code?: string; message?: string };
  };
  return { status: res.status(), data: json.data, error: json.error };
}

/**
 * Mint a passwordless sign-in path directly in the DB — the production-target
 * fallback for servers that won't dev-expose `login_url`. Mirrors the route's
 * inert-user creation (resolveOrCreateUser) plus lib/login-link.ts
 * createLoginLink; tokens are stored plaintext with a 15-minute TTL.
 */
export async function mintLoginPathBySql(email: string): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  await withDb(async (sql) => {
    const displayName = email.split("@")[0].replace(/[._-]+/g, " ").trim() || "Member";
    await sql`
      insert into users (email, display_name, email_verified)
      values (${email}, ${displayName}, false)
      on conflict (email) do nothing`;
    const users = await sql<{ id: string }[]>`
      select id from users where email = ${email} and deleted_at is null limit 1`;
    if (!users[0]) throw new Error(`mintLoginPathBySql: no user row for ${email}`);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await sql`
      insert into login_links (user_id, token, expires_at)
      values (${users[0].id}, ${token}, ${expiresAt})`;
  });
  return `/magic-link?token=${token}`;
}

/**
 * Passwordless UI login on a fresh page (specs that need their own context).
 * Requests a magic link and opens the dev-exposed URL to establish the session;
 * an unknown email auto-creates the account. Production targets skip the route
 * (it would email a real — bouncing — address) and mint the token in the DB.
 *
 * `next` is the post-login redirect, and it is not cosmetic: a bare login runs
 * the org-resolution branch, which auto-provisions "My organization" for a user
 * who belongs to none. Every real entry point that logs someone in on their way
 * somewhere (claim, join, invite pages) carries one, so a spec that skips it
 * quietly turns its player into an organiser.
 */
export async function loginUi(page: Page, email: string, next?: string): Promise<void> {
  let loginUrl: string | undefined;
  if (PROD_TARGET) {
    // mintLoginPathBySql writes the token row only; the route appends `next`
    // to the URL it emails, so do the same here.
    loginUrl = await mintLoginPathBySql(email);
    if (next) loginUrl += `&next=${encodeURIComponent(next)}`;
  } else {
    const res = await page.request.post("/api/auth/magic-link", {
      data: next ? { email, next } : { email },
    });
    loginUrl = ((await res.json()) as { data?: { login_url?: string } }).data?.login_url;
  }
  if (!loginUrl) throw new Error("magic-link login_url missing — dev server required");
  await page.goto(loginUrl);
  await page.waitForURL(
    (u) => !u.pathname.startsWith("/login") && !u.pathname.startsWith("/magic-link"),
    { timeout: 20_000 },
  );
}

/** One-shot SQL client against the app's schema (DATABASE_URL must point at
 *  the same DB the dev server under test uses). */
async function withDb<T>(
  fn: (sql: import("postgres").Sql) => Promise<T>,
): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    // The app lives in a dedicated schema — unqualified table names resolve
    // only when the search_path points there.
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

/**
 * The billing group an org bills through, or a loud failure.
 *
 * Every fixture below writes the GROUP, so a missing link has to throw rather
 * than update zero rows. A no-op fixture is the worst kind: the spec runs
 * against whatever state the row already held and reports on the wrong thing,
 * which is how the pre-V314 version of these helpers survived a schema change
 * that had already made them impossible.
 */
async function requireGroupId(sql: import("postgres").Sql, orgId: string): Promise<string> {
  const rows = await sql<{ subscription_id: string | null }[]>`
    select subscription_id from organizations where id = ${orgId}`;
  if (rows.length === 0) throw new Error(`no organization ${orgId}`);
  const groupId = rows[0].subscription_id;
  if (!groupId) throw new Error(`organization ${orgId} has no billing group (subscription_id)`);
  return groupId;
}

/**
 * An integer limit straight from the live `plan_entitlements` matrix.
 *
 * For specs whose SETUP depends on where a ceiling currently sits — how many
 * competitions to create before one is over quota, how many entrants fill a
 * division. The packaging has moved repeatedly inside this line of work (most
 * recently V319 took `competitions.max_active` to 10 and
 * `entrants.per_division.max` to 64), and a hardcoded rig silently stops testing
 * the thing it names: an earlier freeze test created "one over the community
 * ceiling", which after a repackaging no longer overshot anything — so nothing
 * froze and its 402 came back 201. Read the number, derive the rig from it.
 *
 * Assertions about the VALUE still belong on the value (pricing-v3.spec.ts pins
 * 64 / 128 / 256 literally). Reading the matrix on both sides of one of those
 * would assert nothing at all.
 */
export async function communityLimit(featureKey: string): Promise<number> {
  return withDb(async (sql) => {
    const [row] = await sql<{ int_value: number | null }[]>`
      select int_value from plan_entitlements
      where plan_key = 'community' and feature_key = ${featureKey}`;
    if (row?.int_value == null) {
      throw new Error(`communityLimit: no int_value for community/${featureKey}`);
    }
    return row.int_value;
  });
}

/**
 * Set an org's plan directly in the DB (same trick auth.setup.ts uses for the
 * Pro account). Targets by org id or by owner email.
 *
 * Writes the org's billing GROUP, because V314 moved the plan there and dropped
 * `subscriptions.org_id`. Two consequences worth knowing before you call it:
 *
 *  - It UPDATES, never inserts. Post-V314 every org points at a group from the
 *    moment it is created (lib/auth.ts createOrgForUser), so an insert here
 *    would mint a second, orphaned group that nothing reads.
 *  - The plan is a property of the group, so on a SHARED group this moves every
 *    org on the bill, not just the one named. That is the product's actual
 *    behaviour, not a limitation of the fixture — a spec that wants one org
 *    changed must put it in a group of its own first.
 */
export async function setOrgPlanBySql(
  target: { orgId?: string; email?: string },
  plan: "pro" | "community" | "pro_plus",
): Promise<void> {
  await withDb(async (sql) => {
    if (target.orgId) {
      const groupId = await requireGroupId(sql, target.orgId);
      await sql`update subscriptions set plan_key = ${plan}, status = 'active'
                 where id = ${groupId}`;
    } else if (target.email) {
      const res = await sql`
        update subscriptions set plan_key = ${plan}, status = 'active'
         where id = (
           select o.subscription_id from organizations o
             join org_members m on m.org_id = o.id
             join users u on u.id = m.user_id
            where u.email = ${target.email} and o.subscription_id is not null
            limit 1)`;
      // auth.setup.ts flips the SHARED Pro account this way, and every project
      // in the run reads the storageState it produces. Silently matching
      // nothing would hand all of them a community account and fail somewhere
      // far from here.
      if (res.count === 0) throw new Error(`no billing group for owner ${target.email}`);
    } else {
      throw new Error("setOrgPlanBySql: pass orgId or email");
    }
  });
}

/** Lift an org-level entitlement via override (v3/08 admin tool analogue).
 *  auth.setup.ts uses it to keep the shared Pro user's 5-org e2e budget now
 *  that the v3 pro cap is 3 — the creation check honours overrides. */
export async function setEntitlementOverrideSql(
  orgId: string,
  featureKey: string,
  intValue: number,
): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${orgId}, ${featureKey}, ${intValue}, 'e2e budget')
      on conflict (org_id, feature_key) do update set int_value = ${intValue}`;
  });
}

/** Lift an org-level BOOLEAN entitlement via override — the `bool_value`
 *  sibling of {@link setEntitlementOverrideSql} above (which only ever
 *  writes `int_value`; `org_entitlement_overrides` carries both columns, and
 *  a boolean feature key reads `bool_value` — see `hasFeature`,
 *  src/lib/entitlements.ts). Same direct-SQL upsert idiom, same caller
 *  obligation: call {@link invalidateOrgEntitlements} afterward when the org
 *  has already resolved entitlements this run (that function's own doc —
 *  required against staging's cache; a cheap no-op locally/CI). */
export async function setBoolEntitlementOverrideSql(
  orgId: string,
  featureKey: string,
  value: boolean,
): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${orgId}, ${featureKey}, ${value}, 'e2e')
      on conflict (org_id, feature_key) do update set bool_value = ${value}`;
  });
}

/** Flip Stripe Connect readiness (spec 2026-07-12) — Express onboarding can't
 *  run in e2e, same SQL-flip convention as plans. A fake acct id satisfies
 *  the account-exists checks; checkout itself is never driven here. */
export async function setOrgConnectSql(
  orgId: string,
  chargesEnabled: boolean,
): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      update organizations
      set stripe_charges_enabled = ${chargesEnabled},
          stripe_account_id = coalesce(stripe_account_id, ${"acct_e2e_" + orgId.slice(0, 8)})
      where id = ${orgId}`;
  });
}

/**
 * Give a user a claimed player profile — a `persons` row with `user_id` set
 * — directly in the DB (#516). This is the exact precondition nav.tsx's
 * `isPlayer` reads (hasClaimedProfile: `persons.user_id = X`, no org
 * filter), which renders a 4th "Player home" nav link for an organiser who
 * is ALSO a claimed player. Driving the real invite→claim flow to reach this
 * state is player-accounts.spec.ts's job, not this one's — this helper only
 * sets up the precondition. Scoped to the user's own first org membership so
 * the FK is satisfiable regardless of which org a test is looking at.
 */
export async function claimProfileBySql(email: string): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      insert into persons (org_id, full_name, user_id, lane)
      select m.org_id, u.display_name, u.id, 'player'
      from users u
      join org_members m on m.user_id = u.id
      where u.email = ${email}
      limit 1`;
    if (res.count === 0) throw new Error(`claimProfileBySql: no org membership for ${email}`);
  });
}

/**
 * Attach an EXISTING roster person to a user account (S9/#418). Unlike
 * `claimProfileBySql`, which mints a fresh empty person, this claims one that
 * already carries entrant memberships and scored events — the only way to
 * reach /me's Career section, which reads `player_stat_snapshots` joined on
 * `persons.user_id`. A brand-new person has no snapshots, so the section it is
 * meant to exercise would render its empty state and the test would assert
 * nothing.
 *
 * Takes the user's ID (from `GET /api/users/me`), never a reconstructed
 * email: `TAG` is evaluated per PROCESS, so `proEmail()` called from a spec
 * worker does not name the account `auth.setup.ts` provisioned in its own
 * worker. The first version of this helper resolved the user with a
 * `(select id from users where email = …)` subquery, which returns NULL for a
 * wrong address — so it set `user_id = NULL`, updated one row, reported
 * success, and the spec then asserted against a /me page belonging to nobody.
 * Both lookups below fail loudly instead.
 */
export async function linkPersonToUserBySql(personId: string, userId: string): Promise<void> {
  await withDb(async (sql) => {
    const [user] = await sql`select id from users where id = ${userId} and deleted_at is null`;
    if (!user) throw new Error(`linkPersonToUserBySql: no live user ${userId}`);
    const res = await sql`
      update persons set user_id = ${userId}
      where id = ${personId} and merged_into is null`;
    if (res.count === 0) throw new Error(`linkPersonToUserBySql: no person ${personId}`);
  });
}

/**
 * Seed N prior AI-generation ledger rows for a division (v4 Task 17 quota path).
 * Mirrors the exact shape schedule-ai.ts counts against the per-division run cap:
 * competition_events of type 'schedule.ai_generated' whose payload.division_id
 * matches. Inserted as the superuser (RLS-bypassing) with an explicit org_id.
 */
export async function seedAiGeneratedRuns(
  competitionId: string,
  orgId: string,
  divisionId: string,
  count: number,
): Promise<void> {
  await withDb(async (sql) => {
    for (let i = 0; i < count; i++) {
      await sql`
        insert into competition_events (competition_id, org_id, type, payload)
        values (${competitionId}, ${orgId}, 'schedule.ai_generated', ${sql.json({ division_id: divisionId })})`;
    }
  });
}

/** Zero an org's AI-credit wallet (v17): delete its ledger rows so the next
 *  run's reserve refuses with 402 ai.credits. Wallet id = coalesce(
 *  subscription_id, id) per SPEC-2 §11.1. Superuser (RLS-bypassing). */
export async function drainAiCredits(orgId: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`delete from ai_credit_ledger where wallet_id =
      (select coalesce(subscription_id, id)::text from organizations where id = ${orgId})`;
  });
}

/**
 * An org's AI-credit balance — the ledger summed, which is what
 * `lib/credits.ts` treats as authoritative (`balance_after` is a per-row
 * snapshot and the oversell guard, not the balance).
 *
 * The ONLY observable that proves what a run was actually charged. The plan
 * response's `credits` is rendered nowhere on the board, so a UI assertion can
 * only ever show that the CARD agreed with itself; the wallet is where the
 * organiser's money went.
 */
export async function aiCreditBalance(orgId: string): Promise<number> {
  return withDb(async (sql) => {
    const [row] = await sql<{ bal: string | null }[]>`
      select coalesce(sum(delta), 0)::text as bal
        from ai_credit_ledger
       where wallet_id = (
         select coalesce(subscription_id, id)::text from organizations where id = ${orgId}
       )`;
    return Number(row?.bal ?? 0);
  });
}

/** The most recent AI-sourced schedule apply audit for a division (v4 Task 17):
 *  the division_events 'schedule_applied' row with payload.source = 'ai'. */
export async function getAiScheduleApply(
  divisionId: string,
): Promise<{ source: string; instruction: string | null } | null> {
  return withDb(async (sql) => {
    const rows = await sql<
      { payload: { source?: string; ai?: { instruction?: string } } }[]
    >`
      select payload from division_events
      where division_id = ${divisionId}
        and type = 'schedule_applied'
        and payload->>'source' = 'ai'
      order by seq desc limit 1`;
    if (!rows[0]) return null;
    return { source: rows[0].payload.source ?? "", instruction: rows[0].payload.ai?.instruction ?? null };
  });
}

/** Each fixture's persisted schedule provenance + slot for a division (v4 Task
 *  17 asserts applied fixtures carry schedule_source = 'ai'). */
export async function getFixtureScheduleSources(
  divisionId: string,
): Promise<{ schedule_source: string | null; scheduled_at: string | null }[]> {
  return withDb(async (sql) => {
    const rows = await sql<{ schedule_source: string | null; scheduled_at: Date | null }[]>`
      select schedule_source, scheduled_at from fixtures where division_id = ${divisionId}`;
    return rows.map((r) => ({
      schedule_source: r.schedule_source,
      scheduled_at: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null,
    }));
  });
}

/** Force a fixture's status directly (SPEC-3 marks/reports e2e). The mark +
 *  report windows only read `fixtures.status`; a SQL flip to 'decided' skips
 *  the sport-specific full-time scoring dance and keeps the setup terse. */
export async function setFixtureStatusSql(fixtureId: string, status: string): Promise<void> {
  await withDb(async (sql) => {
    await sql`update fixtures set status = ${status} where id = ${fixtureId}`;
  });
}

/**
 * Archive a court directly, bypassing `archiveCourt`'s own guard (P10
 * stranded-fixture e2e).
 *
 * `POST /api/v1/orgs/{id}/courts/{courtId}/archive` throws 409 COURT_IN_USE
 * whenever `anyCourtHasUnplayedFixture` sees a `scheduled`/`in_play` fixture
 * still on the court (`venues.ts`) — confirmed read-only before writing this
 * helper. That guard exists precisely to stop an organiser from creating the
 * state P10's `stranded_fixture` conflict has to prove is non-blocking, so
 * the normal write API can never reach it. Same bypass the server-side unit
 * test uses for the identical reason
 * (`server/usecases/stranded-courts.test.ts`: `tx\`update courts set
 * archived_at = now()...\``) — a direct SQL flip standing in for whatever
 * real-world path (an ops fix, a completed-then-undone fixture) leaves a
 * court archived out from under a fixture the app itself would never place
 * there today.
 */
export async function archiveCourtBySql(courtId: string): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`update courts set archived_at = now() where id = ${courtId}`;
    if (res.count === 0) throw new Error(`archiveCourtBySql: no court ${courtId}`);
  });
}

/**
 * Rewrite a division's sport config behind the app's back (V347 config-snapshot
 * e2e).
 *
 * Deliberately SQL rather than the divisions PATCH route: the point of the spec
 * is what happens to an ALREADY SCORED fixture when the config moves, and the
 * route's own validation is a separate concern that would only make the rig
 * fragile. Fails loudly on zero rows — a no-op fixture would leave the spec
 * asserting that nothing changed when nothing was changed.
 */
/** Writes a division config STRAIGHT TO THE DB, bypassing `patchDivision`'s
 *  `sportModule.configSchema.safeParse` (usecases/divisions.ts:640) — which is
 *  the only thing that would have rejected it. A config that cannot parse
 *  renders NO PAD AT ALL rather than an error, so the symptom of a bad object
 *  here is a missing scoring surface, not a config complaint. Cricket bites
 *  hardest: `ballsPerInnings` is refined against BOTH `maxOversPerBowler` and
 *  `minOversForResult`, so shortening a match means lowering all three. */
export async function setDivisionConfigSql(divisionId: string, config: unknown): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      update divisions set config = ${sql.json(config as never)} where id = ${divisionId}`;
    if (res.count === 0) throw new Error(`no division ${divisionId}`);
  });
}

/** A fixture's frozen config snapshot (V347), or null before its first event. */
export async function fixtureConfigSnapshotSql(fixtureId: string): Promise<unknown> {
  return withDb(async (sql) => {
    const rows = await sql<{ config_snapshot: unknown }[]>`
      select config_snapshot from fixtures where id = ${fixtureId}`;
    if (rows.length === 0) throw new Error(`no fixture ${fixtureId}`);
    return rows[0].config_snapshot;
  });
}

/**
 * organizations.timezone, read directly — no API surface returns it (the org
 * settings page reads it off its own server-component props). RS004's org-tz
 * window spec mutates this SHARED, org-wide column via `PATCH /api/orgs/{id}`
 * and must restore the ORIGINAL value in a `finally`, the same convention
 * setOwnerStaffSql documents above: this is not scoped to the competition/
 * division the spec otherwise isolates by creating its own.
 */
export async function orgTimezoneSql(orgId: string): Promise<string | null> {
  return withDb(async (sql) => {
    const rows = await sql<{ timezone: string | null }[]>`
      select timezone from organizations where id = ${orgId}`;
    if (rows.length === 0) throw new Error(`no organization ${orgId}`);
    return rows[0]!.timezone;
  });
}

/**
 * Force a division's registration_settings into (entrant_kind, allow_free_
 * agents) combo the app itself refuses to write — registrations.ts's
 * putRegistrationSettings 422s "allow_free_agents requires entrant_kind
 * 'team'" (RS004 decision 1), and the config panel's own entrant_kind
 * <select> onChange clears allow_free_agents the instant it leaves "team",
 * so nothing reachable through the UI can ever PRODUCE this state. This is
 * the only way to get a division INTO it, so a spec can prove the panel's
 * own re-save surfaces that SAME 422 against the field. Requires an existing
 * registration_settings row — PUT one via the real API first with a VALID
 * combo (e.g. entrant_kind:"team", allow_free_agents:true), then call this
 * to desync it; fails loudly on zero rows, matching setDivisionConfigSql's
 * convention above.
 */
export async function forceFreeAgentsTeamMismatchSql(divisionId: string): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`
      update registration_settings
      set entrant_kind = 'individual', allow_free_agents = true
      where division_id = ${divisionId}`;
    if (res.count === 0) throw new Error(`no registration_settings row for division ${divisionId}`);
  });
}

/**
 * RS005: insert ONE registration directly — registration_groups ->
 * registrations, bypassing registration_settings entirely (the V363/V364
 * shape, mirroring usecases/__tests__/_registration-fixtures.ts's own
 * seedRegistration, which listRegistrations' doc comment names as the
 * precedent for exactly this scenario: "some rows in this table predate any
 * registration_settings row for their division existing at all — direct-SQL
 * test fixtures"). The API cannot express this: registration-submit.ts's
 * loadSubmitSettings returns null for a division with no settings row at
 * all, and submission is refused before anything is written — so a division
 * an organiser has never configured can only be reached by writing under
 * the API, the same way forceFreeAgentsTeamMismatchSql above does for its
 * own unreachable-via-UI state.
 */
export async function seedBareRegistrationSql(
  competitionId: string,
  divisionId: string,
  opts: {
    displayName?: string;
    contactEmail?: string;
    status?: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" | "expired" | "rejected";
    amountCents?: number;
    currency?: string;
  } = {},
): Promise<{ registrationId: string; groupId: string; displayName: string }> {
  const { randomBytes } = await import("node:crypto");
  const suffix = Math.random().toString(36).slice(2, 8);
  const displayName = opts.displayName ?? `Bare Entry ${suffix}`;
  const contactEmail = opts.contactEmail ?? `bare-${suffix}@example.com`;
  const status = opts.status ?? "pending";
  const amountCents = opts.amountCents ?? 0;
  const currency = opts.currency ?? "usd";
  const tokenHash = randomBytes(32).toString("hex");
  return withDb(async (sql) => {
    const [group] = await sql<{ id: string }[]>`
      insert into registration_groups
        (competition_id, contact_name, contact_email, access_token_hash, amount_cents, currency)
      values (${competitionId}, ${displayName}, ${contactEmail}, ${tokenHash}, ${amountCents}, ${currency})
      returning id`;
    if (!group) throw new Error(`seedBareRegistrationSql: group insert failed for competition ${competitionId}`);
    const [reg] = await sql<{ id: string }[]>`
      insert into registrations (group_id, division_id, display_name, status, amount_cents)
      values (${group.id}, ${divisionId}, ${displayName}, ${status}, ${amountCents})
      returning id`;
    if (!reg) throw new Error(`seedBareRegistrationSql: registration insert failed for division ${divisionId}`);
    return { registrationId: reg.id, groupId: group.id, displayName };
  });
}

/**
 * Drop an org's server-side entitlement cache (`ent:{org}:*`). SQL-flip
 * helpers mutate entitlement state behind the app's back; on a Redis-backed
 * target (staging) a limit resolved BEFORE the flip stays cached for up to
 * 300s, so the flip never lands inside the test. Local/CI have no Redis —
 * the cache layer is inert there and this is a cheap no-op round-trip.
 *
 * There is no public invalidation endpoint, so this rides the superadmin
 * entitlement-override route (upsert and delete both invalidate): the calling
 * session's user is flipped to superadmin for the two calls, then restored.
 */
export async function invalidateOrgEntitlements(
  request: APIRequestContext,
  orgId: string,
): Promise<void> {
  // Flip the org's owner (== the calling session in every e2e spec). NEVER
  // key on the *Email() helpers here — TAG is per-process, so a spec worker
  // computes a different tag than the setup worker that minted the account.
  const setStaff = (on: boolean) => setOwnerStaffSql(orgId, on);
  const KEY = "e2e.cache.bust";
  await setStaff(true);
  try {
    await request.fetch(`/api/admin/orgs/${orgId}/entitlement-override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: { feature_key: KEY, reason: "e2e: drop cached entitlements after SQL flip" },
    });
    await request.fetch(`/api/admin/orgs/${orgId}/entitlement-override`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      data: { feature_key: KEY },
    });
  } finally {
    await setStaff(false);
  }
}

/** Grant an Event Pass (v3/07 §3) directly — the one-time Stripe checkout
 *  can't run in e2e, same SQL-flip convention as plans. Pass `request` when
 *  the org has already resolved entitlements this run (see
 *  invalidateOrgEntitlements — required against staging).
 *
 *  `passKey` is REQUIRED, and that is the whole point of it. This INSERT used
 *  to omit the column; `competition_passes.pass_key` is `not null default
 *  'event_pass'` (V271:9), so a seed meaning L filed silently as M — no FK
 *  error, no failing test, and every ceiling this helper exists to lift set to
 *  the wrong rung's numbers. That landmine has now been closed five times in
 *  this wave (passPrice, recordPassPurchase, fetchPassCheckoutClientSecret,
 *  smoke's grantPass, and here); a required parameter is what stops a sixth. */
export async function grantCompetitionPassSql(
  orgId: string,
  competitionId: string,
  passKey: PassKey,
  request?: APIRequestContext,
): Promise<void> {
  await withDb(async (sql) => {
    await sql`
      insert into competition_passes (competition_id, org_id, pass_key)
      values (${competitionId}, ${orgId}, ${passKey})
      on conflict (competition_id) do nothing`;
  });
  if (request) await invalidateOrgEntitlements(request, orgId);
}

/** Force a subscription lifecycle state (trialing / past_due / …) for banner
 *  and CTA assertions — states Stripe would otherwise own.
 *
 *  `trial_used_at` is the V277 "this org has already had Pro" stamp: pass it
 *  explicitly (a date to burn the trial, null to hand it back) — omitting it
 *  leaves whatever the row already holds, since the app itself only ever
 *  coalesces that column and never clears it as a side effect. */
export async function setOrgSubscriptionSql(
  orgId: string,
  fields: {
    plan_key: string;
    status: string;
    trial_end?: string | null;
    trial_used_at?: string | null;
    // Optional so callers testing liveness (id present + status) can force a
    // "departed" org — a cancelled sub that keeps its dead Stripe id forever.
    // Omitting it leaves whatever the row already holds.
    stripe_subscription_id?: string | null;
  },
): Promise<void> {
  const burn = "trial_used_at" in fields;
  const used = fields.trial_used_at ?? null;
  const setId = "stripe_subscription_id" in fields;
  await withDb(async (sql) => {
    // The org's billing GROUP — V314 moved every one of these columns onto it
    // and dropped subscriptions.org_id. See setOrgPlanBySql for why this
    // updates rather than inserts, and for the shared-group blast radius.
    const groupId = await requireGroupId(sql, orgId);
    await sql`
      update subscriptions
         set plan_key = ${fields.plan_key}, status = ${fields.status},
             trial_end = ${fields.trial_end ?? null}
       where id = ${groupId}`;
    // Still separate statements, and still keyed off presence rather than
    // value: the app only ever coalesces these two columns, so a fixture that
    // wrote them unconditionally would hand back a trial the product cannot.
    if (burn) {
      await sql`update subscriptions set trial_used_at = ${used} where id = ${groupId}`;
    }
    if (setId) {
      await sql`update subscriptions set stripe_subscription_id = ${fields.stripe_subscription_id ?? null} where id = ${groupId}`;
    }
  });
}

/** The billing group an org bills through. */
export async function orgGroupIdSql(orgId: string): Promise<string> {
  return withDb((sql) => requireGroupId(sql, orgId));
}

/**
 * Put `orgId` onto `groupId`, the way a real attach would — without Stripe.
 *
 * `POST /api/billing/group/attach` is the product path and it prices the move,
 * which means a live group would have it call Stripe. e2e must never do that,
 * so a spec that needs a group of two builds it here and asserts on what the
 * PANEL does with it. The pricing itself is covered where Stripe is mocked
 * (server/usecases/__tests__/billing-group-move.test.ts).
 *
 * Drops the org's previous group if that leaves it empty, mirroring
 * dropEmptyGroup — an abandoned group still belongs to the payer and would
 * otherwise show up in `GET /api/billing/groups` as a phantom.
 */
export async function joinOrgToGroupSql(orgId: string, groupId: string): Promise<void> {
  await withDb(async (sql) => {
    const previous = await requireGroupId(sql, orgId);
    if (previous === groupId) return;
    await sql`update organizations set subscription_id = ${groupId} where id = ${orgId}`;
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from organizations
       where subscription_id = ${previous} and deleted_at is null`;
    if (count === 0) await sql`delete from subscriptions where id = ${previous}`;
  });
}

/**
 * Give `orgId` a billing group of ITS OWN, and return the new group's id.
 *
 * The inverse of joinOrgToGroupSql, and the fixture V309 made necessary: a new
 * org joins its creator's EXISTING group (lib/auth.ts createOrgForUser), so
 * three orgs minted by one e2e user are three orgs on ONE bill, not three
 * groups. A spec that wants to watch orgs move between groups has to break them
 * apart first, or every "join" it performs is a no-op against a group that
 * already holds everything.
 *
 * Mirrors what a detach leaves behind — a fresh community group owned by the
 * org's owner — and drops the old group if this emptied it, like dropEmptyGroup.
 */
export async function splitOrgIntoOwnGroupSql(orgId: string): Promise<string> {
  return withDb(async (sql) => {
    const previous = await requireGroupId(sql, orgId);
    const [owner] = await sql<{ user_id: string }[]>`
      select user_id from org_members
       where org_id = ${orgId} and role = 'owner' limit 1`;
    if (!owner) throw new Error(`organization ${orgId} has no owner member`);
    const [group] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
      values (${owner.user_id}, 'community', 'active', 1)
      returning id`;
    await sql`update organizations set subscription_id = ${group.id} where id = ${orgId}`;
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from organizations
       where subscription_id = ${previous} and deleted_at is null`;
    if (count === 0) await sql`delete from subscriptions where id = ${previous}`;
    return group.id;
  });
}

/**
 * Force `quantity_paid` — the seats Stripe has already been billed for.
 *
 * Deliberately settable independently of the org count, because the two
 * differing IS the state worth testing: a freed slot stays paid until renewal,
 * so a group can hold fewer orgs than it has seats and the next move is free.
 * Nothing in the app writes this without Stripe confirming first, so a spec
 * cannot reach the state any other way.
 */
export async function setGroupSeatsPaidSql(groupId: string, seats: number): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`update subscriptions set quantity_paid = ${seats} where id = ${groupId}`;
    if (res.count === 0) throw new Error(`no billing group ${groupId}`);
  });
}

/**
 * Moderation state. V314 §2b moved suspension off `subscriptions.status` and
 * onto the ORG, precisely so suspending one org cannot stop billing for the
 * siblings that merely share its payer — so this writes the org and nothing
 * else.
 */
export async function setOrgStatusSql(orgId: string, status: "active" | "suspended"): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`update organizations set status = ${status} where id = ${orgId}`;
    if (res.count === 0) throw new Error(`no organization ${orgId}`);
  });
}

/**
 * Set an org's spectator-facing locale (v5 i18n §4, `organizations.default_
 * locale`) directly — the API has no PATCH for it, same SQL-flip convention
 * as plans/status. Public/embed pages resolve slot-label copy from this
 * column (never resolveLocale(): those routes are ISR/have no per-viewer
 * request scope), so this is the only way an e2e spec can prove a non-
 * English org actually gets non-English copy on its public surfaces.
 */
export async function setOrgLocaleSql(orgId: string, locale: "en" | "fr" | "es" | "nl"): Promise<void> {
  await withDb(async (sql) => {
    const res = await sql`update organizations set default_locale = ${locale} where id = ${orgId}`;
    if (res.count === 0) throw new Error(`no organization ${orgId}`);
  });
}

/** Flip the org owner's staff bit (the calling session in every e2e spec) so a
 *  test can drive the superadmin surfaces. ALWAYS restore it in a finally —
 *  the shared Pro user outlives the test that borrowed the privilege. */
export async function setOwnerStaffSql(orgId: string, on: boolean): Promise<void> {
  await withDb((sql) =>
    on
      ? sql`update users set is_staff = true, staff_role = 'superadmin'
          where id in (select user_id from org_members where org_id = ${orgId} and role = 'owner')`
      : sql`update users set is_staff = false, staff_role = null
          where id in (select user_id from org_members where org_id = ${orgId} and role = 'owner')`,
  );
}

export interface OrgInfo {
  id: string;
  slug: string;
  name: string;
  role: string;
}

/** The signed-in user's active org (id from the seazn_org cookie, joined with
 *  the membership list for slug/name — needed to build public /shared URLs). */
export async function activeOrg(page: Page): Promise<OrgInfo> {
  const { data: orgs } = await apiJson<OrgInfo[]>(page.request, "/api/orgs");
  if (!orgs?.length) throw new Error("no org memberships for the current user");
  const cookies = await page.context().cookies();
  const activeId = cookies.find((c) => c.name === "seazn_org")?.value;
  return orgs.find((o) => o.id === activeId) ?? orgs[0]!;
}

/** Same lookup as {@link activeOrg}, for a helper that only has an
 *  `APIRequestContext` (no `Page` to read cookies off of) — an
 *  `APIRequestContext` shares the browser context's cookie jar, readable via
 *  `storageState()` instead of `page.context().cookies()`. Exported for a
 *  spec that needs the raw org id itself (e.g. to create a court carrying
 *  specific tags — {@link seedVenueWithCourts} has no per-court tags param). */
export async function activeOrgIdFromRequest(request: APIRequestContext): Promise<string> {
  const { data: orgs } = await apiJson<OrgInfo[]>(request, "/api/orgs");
  if (!orgs?.length) throw new Error("no org memberships for the current user");
  const state = await request.storageState();
  const activeId = state.cookies.find((c) => c.name === "seazn_org")?.value;
  return orgs.find((o) => o.id === activeId)?.id ?? orgs[0]!.id;
}

/**
 * P9: create a venue with N named courts via the real API and return their
 * ids. Every e2e org starts with ZERO venues/courts, so anything that seeds
 * a schedule by `court_id` — `PATCH /fixtures/{id}`, `ScheduleConfig.courts`,
 * `POST /stages/{id}/schedule/apply` assignments — must create at least one
 * court first; `court_label` free text is gone from every one of those wire
 * shapes (a `.strict()` schema 400s a client still sending it).
 *
 * `opts.orgId` is optional — omit it to resolve the caller's own active org
 * the same way {@link activeOrg} does, so a plain `seedVenueWithCourts(request,
 * ["Court 1", "Court 2"])` right after `loginUi` just works.
 */
export async function seedVenueWithCourts(
  request: APIRequestContext,
  names: string[] = ["Court 1"],
  opts: { orgId?: string; venueName?: string } = {},
): Promise<{ venueId: string; courts: { id: string; name: string }[] }> {
  const orgId = opts.orgId ?? (await activeOrgIdFromRequest(request));
  const venueName =
    opts.venueName ?? `E2E Venue ${TAG}-${Math.random().toString(36).slice(2, 6)}`;
  const venue = await apiJson<{ id: string }>(request, `/api/v1/orgs/${orgId}/venues`, "POST", {
    name: venueName,
  });
  const venueId = venue.data!.id;
  const courts: { id: string; name: string }[] = [];
  for (const name of names) {
    const court = await apiJson<{ id: string }>(
      request,
      `/api/v1/orgs/${orgId}/venues/${venueId}/courts`,
      "POST",
      { name },
    );
    courts.push({ id: court.data!.id, name });
  }
  return { venueId, courts };
}

/* ------------------------------------------------------------------ *
 * Slug-chain paths for a resource a test only holds the id of.
 *
 * The console has exactly one address for a competition, division or
 * fixture: `/o/{org}/c/{comp}/d/{div}/f/{no}` (`src/lib/routes.ts`). Until
 * 2026-08-06 the id forms `/competitions/{id}`, `/divisions/{id}` and
 * `/fixtures/{id}` also answered, as permanent-redirect shims, and specs
 * navigated those because the id is what the API hands back when a test
 * creates something. The shims are gone, so the chain has to be resolved.
 *
 * Deliberately NOT cached. A rename rewrites a slug mid-run (that is what
 * `slug_history` exists for), and a memoised chain would then navigate the
 * OLD address — which still 200s via slug history, so the staleness would be
 * invisible rather than loud. These are one or two localhost GETs.
 *
 * The org slug comes from the resource's own `org_id` joined against the
 * caller's membership list, NOT from the `seazn_org` cookie: `request` and
 * `page` have separate cookie jars, so the active org is not reliably the
 * org that owns the thing being navigated to.
 * ------------------------------------------------------------------ */

async function orgSlugFor(request: APIRequestContext, orgId: string): Promise<string> {
  const { data: orgs } = await apiJson<OrgInfo[]>(request, "/api/orgs");
  const org = orgs?.find((o) => o.id === orgId);
  if (!org) {
    throw new Error(
      `no membership of org ${orgId} for this request context — cannot build its slug path`,
    );
  }
  return org.slug;
}

/** `/o/{org}/c/{comp}` + tail, e.g. `competitionPath(request, id, "/settings")`. */
export async function competitionPath(
  request: APIRequestContext,
  competitionId: string,
  tail = "",
): Promise<string> {
  const { status, data } = await apiJson<{ org_id: string; slug: string }>(
    request,
    `/api/v1/competitions/${competitionId}`,
  );
  if (status !== 200 || !data) {
    throw new Error(`competitionPath: GET /api/v1/competitions/${competitionId} → ${status}`);
  }
  return `/o/${await orgSlugFor(request, data.org_id)}/c/${data.slug}${tail}`;
}

/** `/o/{org}/c/{comp}/d/{div}` + tail, e.g. `divisionPath(request, id, "/schedule?tab=board")`. */
export async function divisionPath(
  request: APIRequestContext,
  divisionId: string,
  tail = "",
): Promise<string> {
  const { status, data } = await apiJson<{ competition_id: string; slug: string }>(
    request,
    `/api/v1/divisions/${divisionId}`,
  );
  if (status !== 200 || !data) {
    throw new Error(`divisionPath: GET /api/v1/divisions/${divisionId} → ${status}`);
  }
  return `${await competitionPath(request, data.competition_id)}/d/${data.slug}${tail}`;
}

/** `/o/{org}/c/{comp}/d/{div}/f/{no}` — fixtures are addressed by per-division
 *  ordinal, so this is the one chain that is not a slug the whole way down. */
export async function fixturePath(
  request: APIRequestContext,
  fixtureId: string,
  tail = "",
): Promise<string> {
  const { status, data } = await apiJson<{ division_id: string; fixture_no: number | null }>(
    request,
    `/api/v1/fixtures/${fixtureId}`,
  );
  if (status !== 200 || !data) {
    throw new Error(`fixturePath: GET /api/v1/fixtures/${fixtureId} → ${status}`);
  }
  if (data.fixture_no === null) {
    throw new Error(`fixture ${fixtureId} has no fixture_no — it has no console address`);
  }
  return `${await divisionPath(request, data.division_id)}/f/${data.fixture_no}${tail}`;
}

/** Bulk-add ad-hoc entrants through the API (same shape seedScoredDivision uses). */
export async function addEntrantsViaApi(
  request: APIRequestContext,
  divisionId: string,
  names: string[],
  kind: "individual" | "team" | "pair" = "individual",
  seedOffset = 0,
): Promise<{ status: number; ids: string[] }> {
  const res = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    names.map((n, i) => ({ kind, display_name: n, seed: seedOffset + i + 1 })),
  );
  return { status: res.status, ids: (res.data ?? []).map((e) => e.id) };
}

/** Create a stage and generate its fixtures; returns stage + fixture ids. */
export async function createStageAndGenerate(
  request: APIRequestContext,
  divisionId: string,
  stage: { kind: string; name: string; config?: Record<string, unknown> } = {
    kind: "league",
    name: "League",
  },
): Promise<{ stageId: string; fixtureIds: string[] }> {
  const created = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, ...stage },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${created.data!.id}/generate`,
    "POST",
  );
  return { stageId: created.data!.id, fixtureIds: (gen.data?.fixtures ?? []).map((f) => f.id) };
}

/** One entrant's real roster: the persons behind it and the lineup slot each
 *  one starts in. `positionKey` is optional because most sports' catalogs do
 *  not require one — football's does (GK), cricket's does not. */
export interface RosterSlotSpec {
  fullName: string;
  positionKey?: string;
  /** S13/#422 — omit for the (default) starting XI; "bench" seeds a real
   *  bench member so a `football.sub`/`core.lineup.substitution` flow has
   *  someone to bring ON. Matches the API's own `slot` enum
   *  (`server/api-v1/schemas.ts`'s `z.enum(["starting","bench"])`) — every
   *  existing caller omits this and keeps seeding an all-starting XI,
   *  byte-identical to before this field existed. */
  slot?: "starting" | "bench";
  /** R4/#tennis — the doubles serve order, `LineupSlot.pairOrder`. Which
   *  partner of THIS pair was named first, which is a DECLARATION and cannot
   *  be derived from `order_no` (a five-pair table-tennis tie has five
   *  first-named players — `sports/squad-state.ts:95-104`).
   *
   *  Omit it for a singles or team fixture. Without it `expectedDoublesServer`
   *  correctly answers `null` for the side, and any assertion about WHICH
   *  PLAYER is serving is then vacuous — which is exactly what every doubles
   *  fixture in this file and in `gallery.capture.ts` was before R4. Spread-
   *  omitted below rather than sent as an explicit `null`, so every existing
   *  caller keeps declaring nothing and stays byte-identical. */
  pairOrder?: number;
  /** Squad ROLES this slot declares — FIVB 19.1's libero is the only one any
   *  sport reads today (`roles: ["libero"]`). Additive: the seeder used to
   *  hardcode `roles: []` for every slot with no way to override it, so no
   *  seeded fixture could ever name a libero and volleyball's libero swap —
   *  R5/C3's headline feature — had no reachable e2e at all. Declaring it here
   *  matches the domain: FIVB designates the libero on the match roster BEFORE
   *  the match, and `core/lineup.ts`'s `bringOn` deliberately does not carry
   *  `slot.roles` onto a member already on the sheet, so a mid-match
   *  replacement cannot invent one. Spread-omitted below, so every existing
   *  caller keeps sending `[]` and stays byte-identical. */
  roles?: readonly string[];
}

export interface RosteredFixture {
  competitionId: string;
  divisionId: string;
  fixtureId: string;
  homeEntrantId: string;
  awayEntrantId: string;
  /** `fullName` → `person_id`, for both sides. The pad's person pickers render
   *  these names, so a spec asserts on the NAME a scorer would actually tap
   *  and gets the id for the payload from the same map. */
  personIds: Record<string, string>;
}

/**
 * Seed a started fixture whose two entrants have REAL person members and REAL
 * saved lineups — the thing no existing helper produced.
 *
 * Why this exists rather than another `addEntrantsViaApi` call: that helper
 * creates display-name-only entrants, which is enough for the sports whose
 * events attribute to a SIDE, and useless for the ones that attribute to a
 * PERSON. Every `cricket.ball` carries striker/nonStriker/bowler and
 * `football.goal` carries scorer/assist; the server folds those against the
 * fixture's real lineup (`server/engine-db/lineups.ts`) and 422s on a person
 * it cannot find on the pitch. S11 could not drive either flow in a browser
 * for exactly this reason — the harness route's lineups are synthetic — so
 * the two headline pads in the product had no browser coverage at all.
 *
 * Both sides always get a lineup, never just the one under test: football's
 * `applyGoal` rejects a scorer who is not on the pitch, so a one-sided lineup
 * fails at the event rather than at the setup, which reads as a pad bug.
 */
export async function seedRosteredFixture(
  request: APIRequestContext,
  spec: {
    label: string;
    sportKey: string;
    variantKey: string;
    home: RosterSlotSpec[];
    away: RosterSlotSpec[];
    entrantKind?: "individual" | "team" | "pair";
    /** Leave false to stop after `start` — a spec that wants to drive the pad
     *  through `pre → live` itself must NOT have `core.start` already folded. */
    emitCoreStart?: boolean;
    /** Seed the entrants and their MEMBERS, but declare no fixture LINEUP.
     *  This is the pad's "rosterless" case and it is a real, common one — a
     *  club scorer starts a match off two entrant names and never opens the
     *  lineup editor. `PadHostView.squads` is `initSquads(lineups)`
     *  (`v3/types.ts`), so no lineup means no on-field players, which is the
     *  precondition of tennis's own `rosterlessServerSide` fallback. Nothing
     *  else in the seeded fixture changes. */
    skipLineups?: boolean;
  },
): Promise<RosteredFixture> {
  const kind = spec.entrantKind ?? "team";
  const personIds: Record<string, string> = {};
  for (const slot of [...spec.home, ...spec.away]) {
    const person = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
      full_name: slot.fullName,
      consent: { public_name: true },
    });
    if (!person.data) {
      throw new Error(`seedRosteredFixture: person "${slot.fullName}" → ${person.status}`);
    }
    personIds[slot.fullName] = person.data.id;
  }

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: spec.label,
    visibility: "public",
  });
  // Surface the API's own refusal rather than dereferencing `data!` and
  // throwing `Cannot read properties of undefined (reading 'id')`, which names
  // the helper instead of the cause and sent one debugging pass down the wrong
  // path in this session.
  if (comp.status >= 300 || !comp.data) {
    throw new Error(
      `seedRosteredFixture: POST /api/v1/competitions -> ${comp.status} ${JSON.stringify(comp.error)}`,
    );
  }
  const competitionId = comp.data.id;
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    { name: spec.label.slice(0, 40), sport_key: spec.sportKey, variant_key: spec.variantKey },
  );
  if (!div.data) {
    throw new Error(
      `seedRosteredFixture: division ${spec.sportKey}/${spec.variantKey} → ${div.status} ${JSON.stringify(div.error)}`,
    );
  }
  const divisionId = div.data.id;

  const ents = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      {
        kind,
        display_name: `Home ${spec.label}`,
        seed: 1,
        members: spec.home.map((s) => ({ person_id: personIds[s.fullName] })),
      },
      {
        kind,
        display_name: `Away ${spec.label}`,
        seed: 2,
        members: spec.away.map((s) => ({ person_id: personIds[s.fullName] })),
      },
    ],
  );
  if (ents.status >= 300 || !ents.data || ents.data.length < 2) {
    throw new Error(
      `seedRosteredFixture: POST entrants -> ${ents.status} ${JSON.stringify(ents.error)}`,
    );
  }
  const homeEntrantId = ents.data[0]!.id;
  const awayEntrantId = ents.data[1]!.id;

  const { fixtureIds } = await createStageAndGenerate(request, divisionId);
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  for (const [entrantId, roster] of spec.skipLineups
    ? []
    : ([
        [homeEntrantId, spec.home],
        [awayEntrantId, spec.away],
      ] as const)) {
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/lineups/${entrantId}`, "PUT", {
      slots: roster.map((s, i) => ({
        person_id: personIds[s.fullName],
        slot: s.slot ?? "starting",
        order_no: i + 1,
        roles: s.roles === undefined ? [] : [...s.roles],
        ...(s.positionKey ? { position_key: s.positionKey } : {}),
        ...(s.pairOrder === undefined ? {} : { pair_order: s.pairOrder }),
      })),
    });
    if (res.status >= 300) {
      throw new Error(
        `seedRosteredFixture: lineup for ${entrantId} → ${res.status} ${JSON.stringify(res.error)}`,
      );
    }
  }

  if (spec.emitCoreStart) {
    const started = await apiJson<{ seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/events`,
      "POST",
      { expected_seq: 0, type: "core.start", payload: {} },
    );
    if (started.status >= 300) {
      throw new Error(`seedRosteredFixture: core.start → ${started.status}`);
    }
  }

  return { competitionId, divisionId, fixtureId, homeEntrantId, awayEntrantId, personIds };
}

/** Record a generic.result for one fixture (reads last_seq for optimistic concurrency). */
export async function scoreFixture(
  request: APIRequestContext,
  fixtureId: string,
  p1Score: number,
  p2Score: number,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type: "generic.result",
    payload: { p1Score, p2Score },
  });
  if (res.status >= 400) {
    throw new Error(`scoreFixture(${fixtureId}) failed: ${res.status} ${res.error?.message}`);
  }
}

/** Score every still-undecided fixture in a list via the API. */
export async function scoreRemainingFixtures(
  request: APIRequestContext,
  fixtureIds: string[],
  skip: Set<string> = new Set(),
): Promise<void> {
  for (const id of fixtureIds) {
    if (skip.has(id)) continue;
    const state = await apiJson<{ status: string; last_seq: number }>(
      request,
      `/api/v1/fixtures/${id}/state`,
    );
    if (state.data && ["decided", "finalized"].includes(state.data.status)) continue;
    const res = await apiJson(request, `/api/v1/fixtures/${id}/events`, "POST", {
      expected_seq: state.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    // A fixture scored moments ago through the UI can reject with "outcome
    // already decided" before its status column reflects it — that's success.
    if (res.status >= 400 && !/already decided/i.test(res.error?.message ?? "")) {
      throw new Error(`scoreRemainingFixtures(${id}) failed: ${res.status} ${res.error?.message}`);
    }
  }
}

/** Create a competition through the wizard UI; returns its id (parsed from the URL). */
/** P4/D1a put a template gallery in front of the wizard: `/c/new` now renders
 *  step 0 (five named formats plus "Start from blank"), and the name field
 *  does not exist in the DOM until one of them is chosen. Every journey that
 *  drives the BLANK wizard has to make that choice first — without this, three
 *  specs sat in `locator.fill` until the 60-second test timeout and reported a
 *  wizard regression when the real cause was an unmade choice one step earlier.
 *
 *  Deliberately NOT tolerant of a missing gallery. It is ungated —
 *  app/o/[orgSlug]/c/new/page.tsx renders it on every plan — so an
 *  `if (visible)` click would silently no-op the day it stops rendering and
 *  leave these journeys green against a step nobody can reach. */
export async function startBlankCompetition(page: Page): Promise<void> {
  await expect(page.getByTestId("template-gallery")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("template-start-blank").click();
  // Wait for the form, not the click: the gallery swaps to the blank wizard in
  // client state, so the very next `fill` can otherwise race the re-render.
  await expect(page.getByPlaceholder("Summer Championship 2026")).toBeVisible({ timeout: 10_000 });
}

export async function createCompetitionViaUi(
  page: Page,
  name: string,
  visibility: "public" | "private" | "unlisted" = "public",
): Promise<string> {
  await page.goto("/competitions/new");
  await startBlankCompetition(page);
  await page.getByPlaceholder("Summer Championship 2026").fill(name);
  // #376: the end date is mandatory and the wizard refuses to submit without
  // one, so this journey has to fill it like an organiser would. A date well
  // ahead of now — everything created here has to stay a RUNNING competition,
  // or the Event Pass surfaces under test would render their locked state.
  await page.getByLabel(/^Ends on/i).fill("2030-12-31");
  // Visibility is a radio-card group; the wizard defaults to PRIVATE, so
  // always select explicitly. The input hides behind the styled card, so
  // click the wrapping label and verify the radio took.
  const radio = page.getByRole("radio", { name: new RegExp(`^${visibility}`, "i") });
  await page.locator("label").filter({ has: radio }).click();
  await expect(radio).toBeChecked();
  await page.getByRole("button", { name: /create/i }).click();
  // PROMPT-30: the wizard lands on the slug URL — resolve the id via the API.
  await page.waitForURL(/\/o\/[^/]+\/c\/(?!new$)[^/?]+$/, { timeout: 20_000 });
  const slug = page.url().match(/\/c\/([^/?]+)$/)![1]!;
  const list = await apiJson<{ items: { id: string; slug: string }[] }>(
    page.request,
    "/api/v1/competitions?limit=100",
  );
  const match = list.data!.items.find((c) => c.slug === slug);
  if (!match) throw new Error(`created competition '${slug}' not in list`);
  return match.id;
}

/**
 * Create a division through the tabbed builder UI (basics → scheduling →
 * Create). Uses the builder's defaults for sport/format; returns the division
 * id parsed from the post-create URL.
 */
export async function createDivisionViaUi(
  page: Page,
  competitionId: string,
  name: string,
): Promise<string> {
  await page.goto(await competitionPath(page.request, competitionId, "/d/new"));
  // The name field is the first textbox on the Basics tab (see formats.spec.ts).
  await page.getByRole("textbox").first().fill(name);
  // Creation is guarded to the last tab.
  await page.getByRole("button", { name: "Scheduling", exact: true }).click();
  await page.getByRole("button", { name: /create division/i }).click();
  // PROMPT-30: builder lands on the division slug URL — resolve id via API.
  await page.waitForURL(/\/o\/[^/]+\/c\/[^/]+\/d\/(?!new(?:$|[/?]))[^/?]+/, { timeout: 20_000 });
  const slug = page.url().match(/\/d\/([^/?]+)/)![1]!;
  const list = await apiJson<{ id: string; slug: string }[]>(
    page.request,
    `/api/v1/competitions/${competitionId}/divisions`,
  );
  const match = list.data!.find((d) => d.slug === slug);
  if (!match) throw new Error(`created division '${slug}' not in list`);
  return match.id;
}

/** Create a scored generic-league division via the API and return ids. */
export async function seedScoredDivision(
  request: APIRequestContext,
  names: string[] = ["A", "B", "C", "D"],
  opts: { decide?: boolean } = {},
): Promise<{ competitionId: string; divisionId: string; stageId: string }> {
  const { decide = true } = opts;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `E2E ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
  });
  const competitionId = comp.data!.id;
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    names.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const stageId = stage.data!.id;
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stageId}/generate`,
    "POST",
  );
  // For the officials path (decide:false) give every fixture a kick-off time +
  // court — auto-assign only sees timed, undecided fixtures. Scored callers are
  // left untouched (no schedule events) so their assertions are unchanged.
  if (!decide) {
    const { courts } = await seedVenueWithCourts(request, ["Court 1", "Court 2"]);
    const base = Date.UTC(2026, 8, 15, 9, 0, 0); // 2026-09-15 09:00Z
    for (let i = 0; i < gen.data!.fixtures.length; i++) {
      const at = new Date(base + i * 90 * 60_000).toISOString();
      await apiJson(request, `/api/v1/fixtures/${gen.data!.fixtures[i]!.id}`, "PATCH", {
        scheduled_at: at,
        court_id: courts[i % 2]!.id,
      });
    }
  }
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  // Officials auto-assign only sees UNDECIDED timed fixtures — callers that
  // exercise that path pass { decide: false }.
  if (decide) {
    for (const f of gen.data!.fixtures) {
      const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${f.id}/state`);
      await apiJson(request, `/api/v1/fixtures/${f.id}/events`, "POST", {
        expected_seq: state.data!.last_seq,
        type: "generic.result",
        payload: { p1Score: 2, p2Score: 0 },
      });
    }
  }
  void entrants;
  return { competitionId, divisionId, stageId };
}

/**
 * Fill a `kind="datetime-local"` `DateTimeField` pair — a native
 * `<input type="date">` beside a native `<select>` of times (quarter hours,
 * or a division's board slots), joined by the component into the
 * "YYYY-MM-DDTHH:MM" string every caller already passes/receives. See
 * docs/superpowers/specs/2026-08-10-quarter-hour-time-select-design.md:
 * Chrome's clock POPUP ignores `step` even though its own validity engine
 * honours it, so `fill()` on a bare `input[type="datetime-local"]` no
 * longer has an element to land on.
 *
 * `scope` must resolve to exactly one such pair — the select's accessible
 * name is always "Time" (`datetime.timeLabel`, all 4 dictionaries;
 * `aria-label` wins over the pair's own — hidden — visible label), so two
 * pairs in one scope (e.g. two datetime-local fields on the same page) are
 * ambiguous here and must be driven directly instead.
 */
export async function setDateTime(scope: Page | Locator, value: string): Promise<void> {
  const [date, time] = value.split("T");
  if (!date || !time) {
    throw new Error(`setDateTime: expected "YYYY-MM-DDTHH:MM", got ${JSON.stringify(value)}`);
  }
  await scope.locator('input[type="date"]').first().fill(date);
  // `exact` is load-bearing: getByLabel substring-matches, and the split
  // control's own date half is labelled "Start date & time" on several
  // surfaces — so a bare "Time" resolves to both halves (plus any radio whose
  // label happens to contain the word) and throws a strict-mode violation.
  await scope.getByLabel("Time", { exact: true }).selectOption(time);
}
