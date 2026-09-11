// The stream overlay's seed, shared by `stream-overlay.spec.ts` and the visual
// gate's `overlay-fixture` seed kind (`e2e/visual/seeds.ts`). ONE authority for
// the recipe, because both callers need exactly the same three things and a
// second copy would drift the moment the engine's card vocabulary moves.
//
// WHY A FRESH ORG, AND NOT THE SHARED PRO ONE (AUTH_STATE).
// `streaming.overlay` is granted by NO plan (V402 inserts a row for every plan
// with `bool_value = false`; `lib/feature-copy.ts` calls it a dark rollout), so
// the only way to reach the overlay route is an `org_entitlement_overrides`
// row. That override is ORG-WIDE — `resolve()` overlays it before the
// competition-pass arm ever runs (`lib/entitlements.ts`) — so granting it on
// the shared Pro org would put the OBS panel on every division fixtures tab in
// the same Playwright job (`d/[divSlug]/page.tsx`: `streamOffered = tab ===
// "fixtures" && editable`), where `run-sheet`/`competition-desk` are asserting
// on those rows. It would also make an "unentitled ⇒ 404" assertion vacuous
// for every later wave, which is the exact hazard the T1 visual pass recorded
// when it deleted its own nine override rows.
//
// A fresh org costs four INSERTs and is completely inert to every other spec.
// The rig shape is `enterprise-gate.spec.ts`'s `seedOrgOnPlan`, which is the
// repo's precedent for "a plan-scoped org that never touches AUTH_STATE".
import type { APIRequestContext, Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import {
  TAG,
  apiJson,
  mintLoginPathBySql,
  seedRosteredFixture,
  setBoolEntitlementOverrideSql,
} from "./helpers";

/** `_THEMES.md` §2a / `lib/overlay-model.ts`'s `DISCIPLINE_CLASS_TONE`: hockey
 *  is the ONLY sport that reaches all three chip tones, and it reaches each
 *  exactly once. Ordered as the detail band renders them (append order), so a
 *  caller can index the chips against the tone they must paint.
 *
 *  Football is not a period-kernel sport, so its three entries in that table
 *  are unreachable by construction (`football.ts:509`) — a football seed
 *  renders NO chip at all, which is why this kit is hockey. */
/** The broadcast link the seed saves on the fixture. A real-looking absolute
 *  URL, because `PutFixtureStream` validates one. */
export const STREAM_URL = "https://www.youtube.com/watch?v=seazn-overlay-w1";

export const HOCKEY_CARD_TONES = [
  { classKey: "green", tone: "advisory" },
  { classKey: "yellow", tone: "caution" },
  { classKey: "red", tone: "dismissal" },
] as const;

export interface OverlayRig {
  orgId: string;
  orgSlug: string;
  ownerEmail: string;
  competitionId: string;
  compSlug: string;
  divisionId: string;
  divSlug: string;
  fixtureId: string;
  homeEntrantId: string;
  awayEntrantId: string;
  /** The three offenders, one per class, in `HOCKEY_CARD_TONES` order. */
  offenderIds: string[];
}

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

/** Append one event through the real server reducer, on the fixture's current
 *  sequence, retrying the optimistic-concurrency 409 — `v6-sports.spec.ts`'s
 *  own `sendEvent` (:103-120), the call site the F9a recipe names. Throws on
 *  any other refusal: a silently-dropped card is a seed that photographs a
 *  state the assertions never asked for. */
export async function sendEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const state = await apiJson<{ last_seq: number }>(
      request,
      `/api/v1/fixtures/${fixtureId}/state`,
    );
    if (state.status !== 200 || !state.data) {
      throw new Error(`overlay seed: GET state before ${type} -> ${state.status}`);
    }
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: state.data.last_seq,
      type,
      payload,
    });
    if (res.status === 201) return;
    if (res.status === 409 && attempt < 3) continue;
    throw new Error(`overlay seed: ${type} -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

/** Sign `page` in as a seeded owner. Mints the login token in the DB rather
 *  than posting the magic-link route, so a prod target (`E2E_PROD_TARGET=1`)
 *  takes the same path a dev one does. Every API call afterwards MUST use
 *  `page.request` — the bare `request` fixture carries the project's
 *  `storageState` (the shared Pro org) and would act as a different org. */
export async function signInAs(page: Page, email: string): Promise<void> {
  await page.goto(await mintLoginPathBySql(email));
  await page.waitForURL(
    (u) => !u.pathname.startsWith("/magic-link") && !u.pathname.startsWith("/login"),
    { timeout: 30_000 },
  );
}

/**
 * A LIVE hockey fixture in a public competition, in an org of its own, with one
 * card of every class on the ledger — the state the overlay's three chip tones
 * and its live dot need, and the first thing in this repo ever to render them.
 *
 * `page` is left SIGNED IN as the rig's owner. The overlay route itself is
 * anonymous, so every assertion should open its own context; the sign-in is
 * only how the seed reaches the write API as this org.
 *
 * The entitlement is NOT granted here — `grantOverlay` below is a separate
 * step so a caller can photograph the 404 first. Not entitled ⇒ `notFound()`,
 * and a spec that granted in the same breath would be asserting against a 404
 * page without noticing.
 */
export async function seedOverlayFixture(page: Page): Promise<OverlayRig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+ovl-${tag}@resend.dev`;
  const orgSlug = `ovl-org-${tag}`;

  const { orgId } = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"Overlay Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"Overlay Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return { orgId: newOrgId };
  });

  await signInAs(page, ownerEmail);
  const request = page.request;

  // Three named offenders, one per class. NOT one person carrying all three:
  // FIH progressive escalation reads the card log per person
  // (`sports/period/suspensions.ts:273`), and a scoresheet that shows the same
  // player greened, yellowed and sent off is not the ordinary state the chips
  // are being photographed in.
  const away = HOCKEY_CARD_TONES.map((c) => ({ fullName: `Card ${c.classKey} ${tag}` }));
  const seeded = await seedRosteredFixture(request, {
    label: `Overlay ${tag}`,
    sportKey: "hockey",
    variantKey: "fih-outdoor",
    home: [{ fullName: `Home Keeper ${tag}` }],
    away,
    entrantKind: "team",
    // The pad's rosterless case — `v6-sports.spec.ts:585-591` seeds the same
    // FIH fixture with no lineups and its suspensions are accepted, so a
    // position rule cannot refuse this seed either.
    skipLineups: true,
  });

  await sendEvent(request, seeded.fixtureId, "core.start", {});
  const offenderIds: string[] = [];
  for (const { classKey } of HOCKEY_CARD_TONES) {
    const person = seeded.personIds[`Card ${classKey} ${tag}`];
    if (person === undefined) throw new Error(`overlay seed: no person for ${classKey}`);
    offenderIds.push(person);
    await sendEvent(request, seeded.fixtureId, "hockey.suspension.start", {
      by: seeded.awayEntrantId,
      person,
      class: classKey,
    });
  }

  // The club's own broadcast link, saved BEFORE anything reads the public row.
  // `getPublicFixture` is `unstable_cache`-wrapped at 30 s (Task 0/9) and the
  // public match page, the overlay route and this write all share that one
  // cached row — so a `stream_url` written after the first read is invisible
  // for up to half a minute, which is how this seed first failed.
  const stream = await apiJson(request, `/api/v1/fixtures/${seeded.fixtureId}/stream`, "PUT", {
    streamUrl: STREAM_URL,
  });
  if (stream.status !== 200) {
    throw new Error(`overlay seed: PUT /stream -> ${stream.status} ${JSON.stringify(stream.error)}`);
  }

  const comp = await apiJson<{ slug: string }>(
    request,
    `/api/v1/competitions/${seeded.competitionId}`,
  );
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${seeded.divisionId}`);
  if (!comp.data?.slug || !div.data?.slug) {
    throw new Error(`overlay seed: slugs missing (comp ${comp.status}, div ${div.status})`);
  }

  return {
    orgId,
    orgSlug,
    ownerEmail,
    competitionId: seeded.competitionId,
    compSlug: comp.data.slug,
    divisionId: seeded.divisionId,
    divSlug: div.data.slug,
    fixtureId: seeded.fixtureId,
    homeEntrantId: seeded.homeEntrantId,
    awayEntrantId: seeded.awayEntrantId,
    offenderIds,
  };
}

/** Lift `streaming.overlay` for this rig's org. No cache invalidation is
 *  needed on a first grant, but a caller that has already resolved the key for
 *  this org (by fetching the route and getting its 404) must pass `request` —
 *  `invalidateOrgEntitlements` is the documented drop and is a cheap no-op
 *  where there is no Redis. */
export async function grantOverlay(orgId: string): Promise<void> {
  await setBoolEntitlementOverrideSql(orgId, "streaming.overlay", true);
}
