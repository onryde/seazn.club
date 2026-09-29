// The stream overlay's seed, shared by `stream-overlay.spec.ts` and the visual
// gate's `overlay-fixture` seed kind (`e2e/visual/seeds.ts`). ONE authority for
// the recipe, because both callers need exactly the same three things and a
// second copy would drift the moment the engine's card vocabulary moves.
//
// WHY A FRESH ORG, AND NOT THE SHARED PRO ONE (AUTH_STATE).
// Since V426 (Task 14b, owner ruling 2026-09-29) EVERY plan grants
// `streaming.overlay` and `streaming.relay` — V402 had set both false on every
// plan, a dark rollout — so a rig's org reaches the overlay route on its plan
// alone, and nothing here grants it. What still needs an org of its own is the
// NEGATIVE: the only way left to 404 the route is an `org_entitlement_overrides`
// row with `bool_value = false` (`denyOverlay` below), and that override is
// ORG-WIDE — `resolve()` overlays it before the competition-pass arm ever runs
// (`lib/entitlements.ts`). Written on the shared Pro org it would 404 every
// overlay and take the stream toggle off every division fixtures tab in the
// same Playwright job (`d/[divSlug]/page.tsx`: `streamOffered = tab ===
// "fixtures" && editable`), where `run-sheet`/`competition-desk` are asserting
// on those rows — the hazard the T1 visual pass recorded when it deleted its
// own nine override rows, now pointing the other way.
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
  /** The people this rig can NAME on air, in the order its own seed states.
   *  Hockey: the three offenders, one per class, in `HOCKEY_CARD_TONES` order.
   *  Cricket: striker, incoming, bowler. Football: the penalty taker. */
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
 * The org is on `pro`, which grants `streaming.overlay` since V426 — so the
 * route answers 200 for this fixture from the moment the seed returns, with no
 * override row. A caller that needs the 404 writes one (`denyOverlay`) and
 * takes it away again (`clearStreamingOverride`); not entitled ⇒ `notFound()`.
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

/**
 * A LIVE CRICKET fixture with a real over on the ledger (stream overlay W2
 * Task 3) — the state the bar's SECOND BAND needs, and the only sport that has
 * one: cricket carries no serving side, no strength and no discipline list, so
 * before W2 its detail band never rendered at all.
 *
 * Rostered, NOT `skipLineups`: the crease band names people, and a name on air
 * comes from the fixture line-up through the consent resolver. A rosterless
 * cricket fixture would render the band with nobody on it, which is a different
 * (and also correct) state — see the `liveFromScorecard` tests.
 *
 * The over is written as a real one: a single, a four, a wide, then a wicket.
 * That is deliberate rather than decorative — it exercises the striker rotating
 * on the single, a boundary glyph, an extra, and the incoming batter taking
 * strike, which between them cover every branch of the band's first line.
 */
export async function seedCricketOverlayFixture(page: Page): Promise<OverlayRig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+ovlc-${tag}@resend.dev`;
  const orgSlug = `ovlc-org-${tag}`;

  const { orgId } = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"Overlay Cricket Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"Overlay Cricket Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return { orgId: newOrgId };
  });

  await signInAs(page, ownerEmail);
  const request = page.request;

  // Eleven a side: cricket's position catalog wants a full XI, and the bowling
  // card needs an opposition player to credit.
  const home = Array.from({ length: 11 }, (_, i) => ({ fullName: `Bat ${i + 1} ${tag}` }));
  const away = Array.from({ length: 11 }, (_, i) => ({ fullName: `Bowl ${i + 1} ${tag}` }));
  const seeded = await seedRosteredFixture(request, {
    label: `Overlay Cricket ${tag}`,
    sportKey: "cricket",
    variantKey: "t20",
    home,
    away,
    entrantKind: "team",
  });

  const person = (name: string): string => {
    const id = seeded.personIds[name];
    if (id === undefined) throw new Error(`cricket seed: no person for "${name}"`);
    return id;
  };
  const striker = person(`Bat 1 ${tag}`);
  const nonStriker = person(`Bat 2 ${tag}`);
  const incoming = person(`Bat 3 ${tag}`);
  const bowler = person(`Bowl 11 ${tag}`);

  // `cricket.toss` MUST precede `core.start` (cricket.ts: "toss must precede
  // core.start").
  await sendEvent(request, seeded.fixtureId, "cricket.toss", {
    wonBy: seeded.homeEntrantId,
    elected: "bat",
  });
  await sendEvent(request, seeded.fixtureId, "core.start", {});

  const ball = (over: number, ballInOver: number, s: string, ns: string, extra: object) =>
    sendEvent(request, seeded.fixtureId, "cricket.ball", {
      over,
      ballInOver,
      striker: s,
      nonStriker: ns,
      bowler,
      ...extra,
    });
  await ball(0, 1, striker, nonStriker, { runs: { bat: 1 } });
  await ball(0, 2, nonStriker, striker, { runs: { bat: 4 }, boundary: 4 });
  await ball(0, 3, nonStriker, striker, { runs: { bat: 0, extras: { kind: "wide", runs: 1 } } });
  await ball(0, 3, nonStriker, striker, {
    runs: { bat: 0 },
    wicket: { kind: "bowled", out: nonStriker, bowlerCredited: true, incoming },
  });

  const comp = await apiJson<{ slug: string }>(
    request,
    `/api/v1/competitions/${seeded.competitionId}`,
  );
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${seeded.divisionId}`);
  if (!comp.data?.slug || !div.data?.slug) {
    throw new Error(`cricket seed: slugs missing (comp ${comp.status}, div ${div.status})`);
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
    offenderIds: [striker, incoming, bowler],
  };
}

/**
 * Cricket overlay at toss+start with an empty over — for end-of-over e2e that
 * bowls a full over while the browser is watching. The crease-band seed above
 * ends mid-over after a wicket; continuing from its `offenderIds` fails the
 * ledger's striker check.
 */
export async function seedCricketOverlayFreshOver(page: Page): Promise<{
  rig: OverlayRig;
  striker: string;
  nonStriker: string;
  bowler: string;
}> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+ovleoo-${tag}@resend.dev`;
  const orgSlug = `ovleoo-org-${tag}`;

  const { orgId } = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${"Overlay EOO Owner " + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${"Overlay EOO Org " + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return { orgId: newOrgId };
  });

  await signInAs(page, ownerEmail);
  const request = page.request;
  const home = Array.from({ length: 11 }, (_, i) => ({ fullName: `EOO Bat ${i + 1} ${tag}` }));
  const away = Array.from({ length: 11 }, (_, i) => ({ fullName: `EOO Bowl ${i + 1} ${tag}` }));
  const seeded = await seedRosteredFixture(request, {
    label: `Overlay EOO ${tag}`,
    sportKey: "cricket",
    variantKey: "t20",
    home,
    away,
    entrantKind: "team",
  });
  const person = (name: string): string => {
    const id = seeded.personIds[name];
    if (id === undefined) throw new Error(`EOO seed: no person for "${name}"`);
    return id;
  };
  const striker = person(`EOO Bat 1 ${tag}`);
  const nonStriker = person(`EOO Bat 2 ${tag}`);
  const bowler = person(`EOO Bowl 11 ${tag}`);
  await sendEvent(request, seeded.fixtureId, "cricket.toss", {
    wonBy: seeded.homeEntrantId,
    elected: "bat",
  });
  await sendEvent(request, seeded.fixtureId, "core.start", {});

  const comp = await apiJson<{ slug: string }>(
    request,
    `/api/v1/competitions/${seeded.competitionId}`,
  );
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${seeded.divisionId}`);
  if (!comp.data?.slug || !div.data?.slug) {
    throw new Error(`EOO seed: slugs missing (comp ${comp.status}, div ${div.status})`);
  }

  return {
    rig: {
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
      offenderIds: [striker, nonStriker, bowler],
    },
    striker,
    nonStriker,
    bowler,
  };
}

/**
 * A LIVE ROSTERED fixture with nothing on the ledger but `core.start` — the
 * shared body behind the two rigs below (stream overlay W2, rulings 28 and 31).
 *
 * It exists for ONE state the hockey and cricket rigs cannot reach: a goal that
 * says HOW it was scored, with the scorer NAMED. Football expresses that as
 * `penalty: true`; the period kernel's `PeriodGoal` has no `penalty` field at
 * all and expresses a stroke, a penalty corner, a power play or a penalty shot
 * through `kind`, validated against `cfg.goalKinds`. Both now reach the same
 * slab (`GOAL_KIND_KEYS`), so both need a rostered rig — hence ONE body and two
 * named entry points below.
 *
 * ROSTERED, not `skipLineups`: the whole point is that the line carries the
 * taker's NAME, and a name on air comes from the fixture line-up through the
 * public-site consent resolver (`readPublicLineups`). A rosterless seed would
 * photograph a line with nobody on it and prove the opposite of what it was
 * shot for — which is exactly why `seedOverlayFixture`'s hockey cards are
 * nameless and cannot stand in for this.
 *
 * The goal itself is NOT seeded here. A moment fires on arrival, and the
 * overlay deliberately replays nothing on mount — so the caller opens the page
 * first and sends the goal while it is watching.
 */
async function seedRosteredOverlayRig(
  page: Page,
  spec: { sportKey: string; variantKey: string; prefix: string; label: string; squad: number },
): Promise<OverlayRig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const ownerEmail = `delivered+${spec.prefix}-${tag}@resend.dev`;
  const orgSlug = `${spec.prefix}-org-${tag}`;

  const { orgId } = await withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified)
      values (${ownerEmail}, ${`Overlay ${spec.label} Owner ` + tag}, true) returning id`;
    const [{ id: newOrgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status, created_by)
      values (${`Overlay ${spec.label} Org ` + tag}, ${orgSlug}, 'active', ${userId}) returning id`;
    await sql`insert into org_members (org_id, user_id, role) values (${newOrgId}, ${userId}, 'owner')`;
    const [{ id: subId }] = await sql<{ id: string }[]>`
      insert into subscriptions (owner_user_id, plan_key, status)
      values (${userId}, 'pro', 'active') returning id`;
    await sql`update organizations set subscription_id = ${subId} where id = ${newOrgId}`;
    return { orgId: newOrgId };
  });

  await signInAs(page, ownerEmail);
  const request = page.request;

  // A FULL side: a variant inherits its sport's position catalog, and a short
  // roster cannot hold a legal line-up.
  const home = Array.from({ length: spec.squad }, (_, i) => ({ fullName: `Home ${i + 1} ${tag}` }));
  const away = Array.from({ length: spec.squad }, (_, i) => ({ fullName: `Away ${i + 1} ${tag}` }));
  const seeded = await seedRosteredFixture(request, {
    label: `Overlay ${spec.label} ${tag}`,
    sportKey: spec.sportKey,
    variantKey: spec.variantKey,
    home,
    away,
    entrantKind: "team",
  });

  const takerName = `Home 9 ${tag}`;
  const taker = seeded.personIds[takerName];
  if (taker === undefined) throw new Error(`${spec.prefix} seed: no person for "${takerName}"`);

  await sendEvent(request, seeded.fixtureId, "core.start", {});

  const comp = await apiJson<{ slug: string }>(
    request,
    `/api/v1/competitions/${seeded.competitionId}`,
  );
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${seeded.divisionId}`);
  if (!comp.data?.slug || !div.data?.slug) {
    throw new Error(`${spec.prefix} seed: slugs missing (comp ${comp.status}, div ${div.status})`);
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
    offenderIds: [taker],
  };
}

/** A LIVE ROSTERED FOOTBALL fixture — `offenderIds[0]` is the penalty taker. */
export async function seedFootballOverlayFixture(page: Page): Promise<OverlayRig> {
  return seedRosteredOverlayRig(page, {
    sportKey: "football",
    variantKey: "11-a-side",
    prefix: "ovlf",
    label: "Football",
    squad: 11,
  });
}

/**
 * A LIVE ROSTERED FIELD HOCKEY fixture — `offenderIds[0]` takes the stroke
 * (ruling 31, 2026-09-11).
 *
 * Distinct from `seedOverlayFixture`, which is also hockey: that one is
 * `skipLineups` on purpose (the pad's rosterless case) and therefore can never
 * put a NAME on air, which is the half of the stroke line this rig exists to
 * photograph.
 */
export async function seedHockeyGoalOverlayFixture(page: Page): Promise<OverlayRig> {
  return seedRosteredOverlayRig(page, {
    sportKey: "hockey",
    variantKey: "fih-outdoor",
    prefix: "ovlh",
    label: "Hockey",
    squad: 11,
  });
}

/** Switch `streaming.overlay` OFF for this rig's org — the one way left to
 *  reach the route's 404 now that every plan grants it (V426). An org-wide
 *  override, which is why it is only ever written on a rig's own fresh org. A
 *  caller that has already resolved the key for this org must follow it with
 *  `invalidateOrgEntitlements` (the documented drop; a cheap no-op where there
 *  is no Redis). */
export async function denyOverlay(orgId: string): Promise<void> {
  await setBoolEntitlementOverrideSql(orgId, "streaming.overlay", false);
}

/** Remove this org's override row for a streaming key, so the key resolves
 *  from the PLAN again — the differential half of `denyOverlay`: the 200 that
 *  follows is the plan's own V426 row reaching the route, not another
 *  override. Same invalidation obligation. Throws when there was no row, so a
 *  "cleared" that removed nothing cannot pass for a differential. */
export async function clearStreamingOverride(
  orgId: string,
  featureKey: "streaming.overlay" | "streaming.relay",
): Promise<void> {
  const removed = await withDb(
    (sql) => sql`delete from org_entitlement_overrides where org_id = ${orgId} and feature_key = ${featureKey} returning 1`,
  );
  if (removed.length !== 1) {
    throw new Error(`clearStreamingOverride: no ${featureKey} override on org ${orgId} (removed ${removed.length})`);
  }
}

/** Give this rig's org `n` BOUGHT-bucket match credits — one 'grant' row in the
 *  never-expiring 'pack' bucket, the shape a staff grant writes (V426) — so a
 *  test can reach the Phone tab's split line, which shows only while BOTH the
 *  free monthly and the bought bucket hold credits (Task 14b review M2).
 *  `balance_after` is the org total after the row, as every ledger writer keeps
 *  it. Returns that total. */
export async function grantRigPackCredits(orgId: string, n: number): Promise<number> {
  return withDb(async (sql) => {
    const [row] = await sql<{ total: number }[]>`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
      select ${orgId}, ${n}, 'grant', 'pack', coalesce(sum(delta), 0)::int + ${n}, 'e2e: bought credits for the split line'
        from org_stream_credits where org_id = ${orgId}
      returning balance_after as total`;
    return row!.total;
  });
}

/** Put a stream session on this rig's fixture in `live` — the "is being broadcast" precondition of the overlay's
 *  realtime bypass (Task 14b addendum RT), seeded as a row rather than driven through the relay: the seam under test
 *  is the overlay page's own token request, not how a session goes live (stream-sessions.test.ts owns that). A target
 *  row of its own (its envelope is never read here), and every derived column from the fixture's division, as the
 *  usecase writes them. Returns the session id for `endRigStreamSession` / `deleteRigStreamSession`. */
export async function openRigStreamSession(rig: OverlayRig): Promise<string> {
  return withDb(async (sql) => {
    const [target] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc)
      values (${rig.orgId}, 'youtube', 'e2e overlay realtime', '\\x00'::bytea) returning id`;
    const [row] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, started_at, target_id, created_by,
                                           sport_key, competition_id, division_id, entitlement_via_override)
      select f.id, ${rig.orgId}, 'passthrough', 'live', now(), ${target!.id}, gen_random_uuid(),
             d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${rig.fixtureId}
      returning id`;
    if (!row) throw new Error(`openRigStreamSession: fixture ${rig.fixtureId} not found`);
    return row.id;
  });
}

/** End a session `openRigStreamSession` made: `completed`, a terminal state — no longer being broadcast. */
export async function endRigStreamSession(sessionId: string): Promise<void> {
  const ended = await withDb((sql) => sql`
    update fixture_stream_sessions set state = 'completed', end_reason = 'stopped', ended_at = now() where id = ${sessionId} returning 1`);
  if (ended.length !== 1) throw new Error(`endRigStreamSession: no session ${sessionId}`);
}

/** Remove a session `openRigStreamSession` made, and its target, so no later test on the rig meets it. */
export async function deleteRigStreamSession(sessionId: string): Promise<void> {
  await withDb(async (sql) => {
    const [row] = await sql<{ target_id: string }[]>`delete from fixture_stream_sessions where id = ${sessionId} returning target_id`;
    if (row) await sql`delete from org_stream_targets where id = ${row.target_id}`;
  });
}

/** Move this rig's org onto `planKey` — the SQL-flip convention the kit's own
 *  seed uses (`subscriptions.plan_key`), for a caller that needs the fixture
 *  seeded on `pro` and then viewed on another plan. Same invalidation
 *  obligation. Returns the plan's monthly free match credits, read from
 *  `plan_entitlements` (V426's row), never typed: the expected value of every
 *  assertion that follows. */
export async function setRigPlan(orgId: string, planKey: string): Promise<{ monthlyMatchCredits: number }> {
  return withDb(async (sql) => {
    const moved = await sql`
      update subscriptions set plan_key = ${planKey}
       where id = (select subscription_id from organizations where id = ${orgId}) returning 1`;
    if (moved.length !== 1) throw new Error(`setRigPlan: org ${orgId} has no subscription to move`);
    const [row] = await sql<{ n: number | null }[]>`
      select int_value as n from plan_entitlements
       where plan_key = ${planKey} and feature_key = 'streaming.credits.monthly'`;
    if (row?.n === null || row?.n === undefined) {
      throw new Error(`setRigPlan: plan ${planKey} declares no streaming.credits.monthly (V426)`);
    }
    return { monthlyMatchCredits: row.n };
  });
}
