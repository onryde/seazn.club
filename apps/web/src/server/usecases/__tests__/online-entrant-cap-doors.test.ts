// The online chess entrant cap, driven through every REAL door that grows a division's entrant count or turns online play on
// (owner ruling 2026-11-21): a division that plays online holds at most min(the plan's per-division cap, 128) entrants, on every
// plan; over-the-board chess and every other sport keep the plan's cap alone. A CAPACITY limit, not an upsell - so the plan's own 402
// answers when the plan is what binds, and a 422 with its own code answers when the online cap is (and says nothing about plans).
//
// The doors (each its own describe): createEntrants (the organiser adds), the public sign-up (submit waitlists at the cap, as it does at
// the plan's), the public places-left count, the organiser's Promote / Confirm / Waive room check, the registration capacity a save may
// promise, and the one door that makes a division online (patchDivision). The expected answers are the ruling's table typed by hand
// below, with the plan caps read back from the entitlement resolver as premises - never taken from the cap module under test.
//
// ONE count answers the cap at every door (fix round 1, review C1): live entrants (not withdrawn / disqualified) + sign-ups let in
// (pending / paid, no entrant yet). The fix-round blocks at the end drive the doors against each other (direct adds + sign-ups, pending
// sign-ups + the online switch, Reinstate), the lock each door takes (a held `division:` lock blocks it), and two adds racing for
// the last place on two connections.
//
// Real Postgres required (skipped without DATABASE_URL). Another sport: badminton and generic stand for "every other sport" at the
// doors; the registry-wide sweep over every sport is in external-play/__tests__/online-entrant-cap.test.ts.
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import { log } from "@/server/logger";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import {
  ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION,
  ONLINE_DIVISION_FULL,
  ONLINE_PLAY_TOO_MANY_ENTRANTS,
} from "@/lib/online-chess";
import { PROMOTE_PLAN_LIMIT_CODE } from "@/lib/registration-promote";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateEntrant } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants, patchEntrant } from "../entrants";
import { publicRegistrationInfo } from "../registrations/settings";
import { confirmRegistration, confirmRegistrationWaived, putRegistrationSettings, sweepRegistrations } from "../registrations";
import { promoteFromWaitlist, rejectRegistration, withdrawRegistration } from "../registration-approval";
import { submitRegistrationGroup } from "../registration-submit";
import { SETTINGS_BASE, seedRegistration } from "./_registration-fixtures";
import { seedOwner, seedPlayer, type SeedPlayer } from "./_external-play-seed";

const HAS_DB = !!process.env.DATABASE_URL;
const MAX = ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION;
const PLAN_KEY = "entrants.per_division.max";
const BADMINTON = builtinModules.find((m) => m.key === "badminton")!;
const FEES = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

afterAll(async () => {
  if (HAS_DB) await sql.end({ timeout: 2 }).catch(() => undefined);
});

// ─── The rig ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The plan sizes of the ruling, each made real the way production makes them: Community and Pro are the catalogue's own rows, and the
 *  two the catalogue has no plan for here (a plan of exactly 128 - an Event Pass's size - and an unlimited plan) are an override row, the
 *  production shape of "the plan allows this many" (a staff cap, a size pack). `cap` is what `getLimit` must read back: the premise. */
type PlanName = "community" | "size-pack-96" | "event-pass-sized" | "pro" | "unlimited";
const PLANS: Record<PlanName, { plan: "community" | "pro"; override?: number | null; cap: number | null }> = {
  community: { plan: "community", cap: 64 },
  "size-pack-96": { plan: "pro", override: 96, cap: 96 }, // a plan BELOW the online cap that is not Community: a size pack, a staff cap
  "event-pass-sized": { plan: "pro", override: 128, cap: 128 },
  pro: { plan: "pro", cap: 256 },
  unlimited: { plan: "pro", override: null, cap: null },
};

type Kind = "online" | "otb" | "badminton";

/** An organisation on the plan `name`, with its per-division cap read back through the resolver and asserted as the premise. */
async function orgOn(name: PlanName, competitionId?: string): Promise<{ auth: AuthCtx; setCompetition(id: string): Promise<void> }> {
  const spec = PLANS[name];
  const auth = await seedOwner(); // a Pro organisation with the boardgame sport seeded
  if (spec.plan === "community") await setOrgPlan(auth.orgId, "community");
  if ("override" in spec) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${auth.orgId}, ${PLAN_KEY}, ${spec.override ?? null}, 'test - online entrant cap doors')`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  const check = async (id: string): Promise<void> => {
    expect(await getLimit(auth.orgId, PLAN_KEY, id), `premise: ${name} reads back its per-division cap`).toBe(spec.cap);
  };
  if (competitionId) await check(competitionId);
  return { auth, setCompetition: check };
}

const CLOCK = { base: 600, increment: 5 };

async function divisionOf(auth: AuthCtx, kind: Kind, visibility: "private" | "public" = "private") {
  const competition = await createCompetition(auth, {
    name: "Cap Cup " + randomUUID().slice(0, 6),
    visibility,
    branding: {},
    starts_on: "2030-11-01",
    ends_on: "2030-11-02",
  });
  if (kind === "badminton") {
    const variant = Object.keys(BADMINTON.variants)[0]!;
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('badminton', 'Badminton', ${BADMINTON.version}, ${sql.json(BADMINTON.positions as never)})
      on conflict (key) do nothing`;
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('badminton', ${variant}, ${variant}, ${sql.json((BADMINTON.variants[variant] ?? {}) as never)}, true)
      on conflict do nothing`;
    const division = await createDivision(auth, competition.id, {
      name: "Open", slug: "open", sport_key: "badminton", variant_key: variant, config: BADMINTON.variants[variant] ?? {},
    } as never);
    return { competition, division };
  }
  const division = await createDivision(auth, competition.id, {
    name: kind === "online" ? "Online" : "Over the board",
    sport_key: "boardgame",
    variant_key: "classical",
    config: { variant: "classical", ...(kind === "online" ? { onlinePlay: "lichess" } : {}), clock: CLOCK },
  });
  return { competition, division };
}

/** `n` spot-holding entrants, inserted directly (the cap's subject is the ONE entrant added on top, not 128 round trips). */
async function fillEntrants(divisionId: string, n: number): Promise<void> {
  if (n <= 0) return;
  await sql`
    insert into entrants (division_id, kind, display_name, status)
    select ${divisionId}, 'individual', 'Seed ' || g, 'confirmed' from generate_series(1, ${n}) g`;
}
const entrantCount = async (divisionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`)[0]!.n;

const linkedPlayer = (auth: AuthCtx): Promise<SeedPlayer> =>
  seedPlayer(auth.orgId, "Player " + randomUUID().slice(0, 6), `s-${randomUUID().replaceAll("-", "").slice(0, 12)}`, true);

/** One entrant added through the real door: an online division's roster must be a linked person; every other division takes a new one. */
async function addOne(auth: AuthCtx, kind: Kind, divisionId: string): Promise<unknown> {
  const name = "Added " + randomUUID().slice(0, 6);
  const entry: CreateEntrant =
    kind === "online"
      ? { display_name: name, kind: "individual", members: [{ person_id: (await linkedPlayer(auth)).personId, is_captain: false, roles: [] }] }
      : { display_name: name, kind: "individual", members: [{ new_person: { full_name: name }, is_captain: false, roles: [] }] };
  return createEntrants(auth, divisionId, [entry]);
}

type Verdict = "ok" | "plan" | "online" | "too_many";
/** What a door's refusal IS: the plan's own 402, the online cap's own 422, the switch's own 422 - or no refusal at all. */
async function verdictOf(run: () => Promise<unknown>): Promise<Verdict> {
  try {
    await run();
    return "ok";
  } catch (err) {
    if (err instanceof PaymentRequiredError) return "plan";
    const e = err as { status?: number; code?: string };
    if (e.code === ONLINE_DIVISION_FULL) {
      expect(e.status, "the online cap is never the plan-limit 402").toBe(422);
      return "online";
    }
    if (e.code === ONLINE_PLAY_TOO_MANY_ENTRANTS) return "too_many";
    throw err;
  }
}

// ─── Door 1: createEntrants - the organiser adds ─────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("door: createEntrants (the organiser adds an entrant)", () => {
  // [plan, division kind, the last entrant count that is allowed, what the next one is refused with (null = nothing refuses it)]
  const ROWS: [PlanName, Kind, number, Exclude<Verdict, "ok" | "too_many"> | null][] = [
    ["community", "online", 64, "plan"], // the min: Community's 64 binds, with the plan's own message
    ["community", "otb", 64, "plan"],
    ["community", "badminton", 64, "plan"],
    ["event-pass-sized", "online", 128, "online"], // the tie: 128 either way, and no upgrade changes it - the online cap answers
    ["event-pass-sized", "otb", 128, "plan"],
    ["event-pass-sized", "badminton", 128, "plan"],
    ["pro", "online", 128, "online"], // the 128th ok, the 129th refused with its own code
    ["pro", "otb", 256, "plan"], // over the board keeps the plan's 256 - the 129th is fine
    ["pro", "badminton", 256, "plan"],
    ["unlimited", "online", 128, "online"], // an unlimited plan is still capped at 128 online
    ["unlimited", "otb", 129, null], // ...and nothing caps the rest
    ["unlimited", "badminton", 129, null],
  ];

  it("every plan x division kind: the last allowed entrant is admitted and the next is refused as the ruling says (the plan's 402 where the plan binds, ONLINE_DIVISION_FULL where the online cap does)", async () => {
    const seen = new Set<Verdict>();
    let checked = 0;
    for (const [plan, kind, lastOk, refused] of ROWS) {
      const { auth, setCompetition } = await orgOn(plan);
      const { competition, division } = await divisionOf(auth, kind);
      await setCompetition(competition.id);
      await fillEntrants(division.id, lastOk - 1);
      const label = `${plan} / ${kind}`;
      expect(await verdictOf(() => addOne(auth, kind, division.id)), `${label}: entrant #${lastOk} is the last allowed`).toBe("ok");
      expect(await entrantCount(division.id), `${label}: it was written`).toBe(lastOk);
      if (refused === null) {
        expect(await verdictOf(() => addOne(auth, kind, division.id)), `${label}: nothing caps #${lastOk + 1}`).toBe("ok");
        expect(await entrantCount(division.id)).toBe(lastOk + 1);
      } else {
        expect(await verdictOf(() => addOne(auth, kind, division.id)), `${label}: entrant #${lastOk + 1}`).toBe(refused);
        expect(await entrantCount(division.id), `${label}: the refused entrant was not written`).toBe(lastOk);
        seen.add(refused);
      }
      seen.add("ok");
      checked += 1;
    }
    expect(checked, "rows driven").toBe(ROWS.length);
    expect([...seen].sort(), "anti-vacuity: all three answers were reached").toEqual(["ok", "online", "plan"]);
  });

  it("the online refusal says the cap, with `limit`, and nothing about plans, upgrading or Pro", async () => {
    const { auth } = await orgOn("pro");
    const { division } = await divisionOf(auth, "online");
    await fillEntrants(division.id, MAX);
    const err = await addOne(auth, "online", division.id).catch((e) => e as { status: number; code: string; message: string; extra?: unknown });
    expect(err).toMatchObject({ status: 422, code: ONLINE_DIVISION_FULL, extra: { limit: MAX } });
    const message = String((err as { message: string }).message);
    expect(message).toContain(String(MAX));
    expect(message, "a capacity limit: no upsell").not.toMatch(/upgrade|plan|raise|pro\b/i);
  });

  it("a batch is judged whole: 127 held + two refused with nothing written, + one admitted - and a Community org's batch past 64 is the plan's 402", async () => {
    const pro = await orgOn("pro");
    const { division } = await divisionOf(pro.auth, "online");
    await fillEntrants(division.id, MAX - 1);
    const two = [await linkedPlayer(pro.auth), await linkedPlayer(pro.auth)].map(
      (p, i): CreateEntrant => ({ display_name: `Batch ${i}`, kind: "individual", members: [{ person_id: p.personId, is_captain: false, roles: [] }] }),
    );
    expect(await verdictOf(() => createEntrants(pro.auth, division.id, two)), "127 + 2 = 129").toBe("online");
    expect(await entrantCount(division.id), "nobody written").toBe(MAX - 1);
    expect(await verdictOf(() => createEntrants(pro.auth, division.id, [two[0]!])), "127 + 1 = 128").toBe("ok");
    expect(await entrantCount(division.id)).toBe(MAX);

    const community = await orgOn("community");
    const small = await divisionOf(community.auth, "online");
    await fillEntrants(small.division.id, 63);
    const duo = [await linkedPlayer(community.auth), await linkedPlayer(community.auth)].map(
      (p, i): CreateEntrant => ({ display_name: `Duo ${i}`, kind: "individual", members: [{ person_id: p.personId, is_captain: false, roles: [] }] }),
    );
    expect(await verdictOf(() => createEntrants(community.auth, small.division.id, duo)), "63 + 2 = 65 on Community").toBe("plan");
    expect(await entrantCount(small.division.id)).toBe(63);
  });

  it("a division already past the cap (it held more before the cap existed) takes no more; a withdrawn entrant holds no place, so a withdrawal frees exactly one and the next add refills it", async () => {
    const { auth } = await orgOn("pro");
    const { division } = await divisionOf(auth, "online");
    await fillEntrants(division.id, MAX + 2); // 130, stored before the ruling
    expect(await verdictOf(() => addOne(auth, "online", division.id)), "130 held: the 131st").toBe("online");
    expect(await entrantCount(division.id)).toBe(MAX + 2);
    // Withdraw three: 127 live of 130 rows. The count the door reads is the LIVE one (the withdrawn rows stay in the table).
    await sql`update entrants set status = 'withdrawn' where id in (select id from entrants where division_id = ${division.id} order by id limit 3)`;
    expect(await verdictOf(() => addOne(auth, "online", division.id)), "127 live: the 128th is admitted").toBe("ok");
    expect(await verdictOf(() => addOne(auth, "online", division.id)), "128 live: the 129th is refused again").toBe("online");
    expect(await entrantCount(division.id), "rows: 130 + the one admitted; the withdrawn three are still rows").toBe(MAX + 3);
    // ...and a disqualified entrant holds no place either (the other departed status).
    await sql`update entrants set status = 'disqualified' where id = (select id from entrants where division_id = ${division.id} and status = 'confirmed' limit 1)`;
    expect(await verdictOf(() => addOne(auth, "online", division.id)), "127 live after a disqualification").toBe("ok");
  });
});

// ─── The registration rig (doors 2 - 5) ──────────────────────────────────────────────────────────────────────

async function regRig(plan: PlanName, kind: Kind, approval: "auto" | "manual") {
  const { auth, setCompetition } = await orgOn(plan);
  const { competition, division } = await divisionOf(auth, kind, "public");
  await setCompetition(competition.id);
  await putRegistrationSettings(auth, division.id, {
    ...SETTINGS_BASE,
    payment_method: "offline",
    fee_cents: 0,
    capacity: null,
    approval,
    allow_free_agents: false,
  } as never);
  const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const holders = async (n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { registration } = await seedRegistration(competition.id, division.id, FEES, { status: "confirmed", displayName: `Holder ${i + 1}` });
      // A confirmed registration IS an entrant (materialise sets entrant_id): the online cap's count reads the entrant, so the seed has one.
      const [entrant] = await sql<{ id: string }[]>`
        insert into entrants (division_id, kind, display_name, status)
        values (${division.id}, 'individual', ${`Holder ${i + 1}`}, 'confirmed') returning id`;
      await sql`update registrations set entrant_id = ${entrant!.id} where id = ${registration.id}`;
      ids.push(registration.id);
    }
    return ids;
  };
  /** `n` sign-ups let in and not yet entrants (pending, no entrant): on a manual-approval division they wait there for the organiser. */
  const pendingSignUps = async (n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { registration } = await seedRegistration(competition.id, division.id, FEES, { status: "pending", displayName: `Pending ${i + 1}` });
      ids.push(registration.id);
    }
    return ids;
  };
  /** A registration leaves the division the way the product does it before Start: the sign-up is withdrawn and so is its entrant. */
  const withdrawHolder = async (registrationId: string): Promise<void> => {
    await sql`update entrants set status = 'withdrawn' where id = (select entrant_id from registrations where id = ${registrationId})`;
    await sql`update registrations set status = 'withdrawn' where id = ${registrationId}`;
  };
  /** A waitlisted entry. On an online division it names a player who can play: the seat gate (a Lichess link that plays) is asked of any
   *  seat, and it answers BEFORE the room check - an entry with nobody linked would never reach the cap this file is about. */
  const waiting = async (): Promise<string> => {
    const { registration } = await seedRegistration(competition.id, division.id, FEES, {
      status: "waitlisted",
      displayName: "Waiting " + randomUUID().slice(0, 6),
    });
    if (kind === "online") {
      const p = await linkedPlayer(auth);
      await sql`
        insert into registration_players (registration_id, full_name, user_id, source)
        values (${registration.id}, 'Player', ${p.userId}, 'captain_entered')`;
    }
    return registration.id;
  };
  const statusOf = async (id: string): Promise<string> => (await sql<{ status: string }[]>`select status from registrations where id = ${id}`)[0]!.status;
  return { auth, competition, division, orgSlug: org!.slug, holders, pendingSignUps, withdrawHolder, waiting, statusOf };
}

async function signUp(r: Awaited<ReturnType<typeof regRig>>, kind: Kind): Promise<string> {
  const person = kind === "online" ? await linkedPlayer(r.auth) : null;
  const res = await submitRegistrationGroup(
    { orgSlug: r.orgSlug, compSlug: r.competition.slug, ...(person ? { sessionUserId: person.userId } : {}) },
    {
      contact: { name: "Alex Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` },
      privacy_consent: true,
      entries: [{ division_id: r.division.id, entrant_kind: "individual", registering_self: true, players: [{ full_name: "Solo Player" }], answers: {} }],
    } as never,
  );
  return res.entries[0]!.status;
}

// ─── Door 2: the public sign-up waitlists at the cap ─────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("door: the public sign-up (submit) waitlists at the cap, as it does at the plan's", () => {
  it("Pro, online: 127 held, the 128th is confirmed and the 129th is waitlisted; after a place frees, the next is confirmed again", async () => {
    const r = await regRig("pro", "online", "auto");
    const held = await r.holders(MAX - 1);
    expect(await signUp(r, "online"), "the 128th").toBe("confirmed");
    expect(await signUp(r, "online"), "the 129th").toBe("waitlisted");
    // The sequence: a held place is withdrawn, so the division is no longer full.
    await r.withdrawHolder(held[0]!);
    expect(await signUp(r, "online"), "after a withdrawal frees a place").toBe("confirmed");
    expect(await signUp(r, "online"), "and it is full again").toBe("waitlisted");
  });

  it("the same plan over the board keeps its 256: the 129th is confirmed, not waitlisted", async () => {
    const r = await regRig("pro", "otb", "auto");
    await r.holders(MAX);
    expect(await signUp(r, "otb")).toBe("confirmed");
  });

  it("unlimited plan, online: still waitlisted at 128; over the board it is not", async () => {
    const online = await regRig("unlimited", "online", "auto");
    await online.holders(MAX);
    expect(await signUp(online, "online"), "online, 129th").toBe("waitlisted");
    const otb = await regRig("unlimited", "otb", "auto");
    await otb.holders(MAX);
    expect(await signUp(otb, "otb"), "over the board, 129th").toBe("confirmed");
  });

  it("a plan below the cap still decides (the min): Community's 64 waitlists the 65th online, exactly as it did", async () => {
    const r = await regRig("community", "online", "auto");
    await r.holders(PLANS.community.cap! - 1);
    expect(await signUp(r, "online"), "the 64th").toBe("confirmed");
    expect(await signUp(r, "online"), "the 65th").toBe("waitlisted");
  });
});

// ─── Door 3: the public places-left count ────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("door: the public register panel's places left agrees with the cap submit enforces", () => {
  const placesOf = async (r: Awaited<ReturnType<typeof regRig>>) =>
    (await publicRegistrationInfo(r.orgSlug, r.competition.slug)).divisions.find((d) => d.division_id === r.division.id)!;

  it("online: 100 held leaves 28 (128 - 100), full at 128 with the reason `full`; over the board the same 100 leave 156 of Pro's 256", async () => {
    const online = await regRig("pro", "online", "auto");
    await online.holders(100);
    expect((await placesOf(online)).remaining, "online, 100 held").toBe(MAX - 100);
    const otb = await regRig("pro", "otb", "auto");
    await otb.holders(100);
    expect((await placesOf(otb)).remaining, "over the board, 100 held").toBe(PLANS.pro.cap! - 100);

    await online.holders(MAX - 100);
    const full = await placesOf(online);
    expect(full.remaining, "128 held").toBe(0);
    expect(full.closed_reason, "still open - joins the waitlist").toBe("full");
  });

  it("an unlimited plan with no capacity: online says 128 - held, over the board says no count at all", async () => {
    const online = await regRig("unlimited", "online", "auto");
    await online.holders(5);
    expect((await placesOf(online)).remaining).toBe(MAX - 5);
    const otb = await regRig("unlimited", "otb", "auto");
    await otb.holders(5);
    expect((await placesOf(otb)).remaining, "no cap: null, not 0").toBeNull();
  });
});

// ─── Door 4: the organiser's Promote / Confirm / Waive ───────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("door: the organiser's Promote, Confirm and Waive check the room", () => {
  it("Promote, online on Pro: the 128th place is promoted; with 128 held the promotion is refused ONLINE_DIVISION_FULL, even confirmed over capacity, and nothing is written", async () => {
    const r = await regRig("pro", "online", "manual");
    await r.holders(MAX - 1);
    const a = await r.waiting();
    const promoted = await promoteFromWaitlist(r.auth, r.division.id, { registrationId: a });
    expect(promoted!.status, "the 128th").toBe("pending");
    const b = await r.waiting();
    for (const confirmOverCapacity of [false, true]) {
      await expect(promoteFromWaitlist(r.auth, r.division.id, { registrationId: b, confirmOverCapacity })).rejects.toMatchObject({
        status: 422,
        code: ONLINE_DIVISION_FULL,
        extra: { limit: MAX },
      });
    }
    expect(await r.statusOf(b), "still waitlisted").toBe("waitlisted");
  });

  it("Promote without naming one (the oldest) refuses the same way; an EMPTY queue on a full online division is still 'nobody to promote'", async () => {
    const r = await regRig("pro", "online", "manual");
    await r.holders(MAX);
    expect(await promoteFromWaitlist(r.auth, r.division.id, {}), "empty queue: null, not a refusal").toBeNull();
    const w = await r.waiting();
    await expect(promoteFromWaitlist(r.auth, r.division.id, {})).rejects.toMatchObject({ status: 422, code: ONLINE_DIVISION_FULL });
    expect(await r.statusOf(w)).toBe("waitlisted");
  });

  it("over the board on Pro the same 128 held promote fine (the plan's 256); an unlimited plan online is capped, the Event-Pass-sized tie is the online cap's, Community's 64 is the plan's own refusal", async () => {
    const otb = await regRig("pro", "otb", "manual");
    await otb.holders(MAX);
    expect((await promoteFromWaitlist(otb.auth, otb.division.id, { registrationId: await otb.waiting() }))!.status).toBe("pending");

    const unlimited = await regRig("unlimited", "online", "manual");
    await unlimited.holders(MAX);
    await expect(promoteFromWaitlist(unlimited.auth, unlimited.division.id, { registrationId: await unlimited.waiting() })).rejects.toMatchObject({
      code: ONLINE_DIVISION_FULL,
    });

    const tie = await regRig("event-pass-sized", "online", "manual");
    await tie.holders(MAX);
    await expect(promoteFromWaitlist(tie.auth, tie.division.id, { registrationId: await tie.waiting() })).rejects.toMatchObject({
      status: 422,
      code: ONLINE_DIVISION_FULL,
    });

    const community = await regRig("community", "online", "manual");
    await community.holders(PLANS.community.cap!);
    await expect(promoteFromWaitlist(community.auth, community.division.id, { registrationId: await community.waiting() })).rejects.toMatchObject({
      status: 422,
      code: PROMOTE_PLAN_LIMIT_CODE,
    });
  });

  it("Confirm and Waive seat a waitlisted entry too, and are refused at the cap by the same sentence", async () => {
    const r = await regRig("pro", "online", "manual");
    const held = await r.holders(MAX);
    const w1 = await r.waiting();
    await expect(confirmRegistration(r.auth, w1)).rejects.toMatchObject({ status: 422, code: ONLINE_DIVISION_FULL });
    const w2 = await r.waiting();
    await expect(confirmRegistrationWaived(r.auth, w2)).rejects.toMatchObject({ status: 422, code: ONLINE_DIVISION_FULL });
    expect(await r.statusOf(w1)).toBe("waitlisted");
    expect(await r.statusOf(w2)).toBe("waitlisted");
    expect(held.length, "premise: the division was full").toBe(MAX);
  });
});

// ─── Door 5: the registration capacity a save may promise ────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("door: registration capacity cannot promise more than the division may hold", () => {
  const save = (r: Awaited<ReturnType<typeof regRig>>, capacity: number | null) =>
    putRegistrationSettings(r.auth, r.division.id, { ...SETTINGS_BASE, payment_method: "offline", fee_cents: 0, capacity, approval: "auto", allow_free_agents: false } as never);

  it("online: a capacity of 128 saves and 129 is refused ONLINE_DIVISION_FULL; over the board 129 saves; no capacity saves everywhere", async () => {
    const online = await regRig("pro", "online", "auto");
    await expect(save(online, MAX)).resolves.toBeTruthy();
    await expect(save(online, MAX + 1)).rejects.toMatchObject({ status: 422, code: ONLINE_DIVISION_FULL });
    await expect(save(online, null)).resolves.toBeTruthy();
    const otb = await regRig("pro", "otb", "auto");
    await expect(save(otb, MAX + 1), "over the board keeps the plan's 256").resolves.toBeTruthy();
  });

  it("an unlimited plan online refuses 129 as well; Community's own message answers past 64 (the min)", async () => {
    const unlimited = await regRig("unlimited", "online", "auto");
    await expect(save(unlimited, MAX + 1)).rejects.toMatchObject({ code: ONLINE_DIVISION_FULL });
    const community = await regRig("community", "online", "auto");
    const err = await save(community, PLANS.community.cap! + 1).catch((e) => e as { status: number; code?: string; message: string });
    expect(err).toMatchObject({ status: 422 });
    expect((err as { code?: string }).code, "the plan's own refusal, not the online cap's").not.toBe(ONLINE_DIVISION_FULL);
    expect(String((err as { message: string }).message)).toContain(String(PLANS.community.cap));
  });
});

// ─── Door 6: turning online play on ──────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("door: turning online play on (patchDivision)", () => {
  const turnOn = (auth: AuthCtx, division: { id: string; config: unknown }) =>
    patchDivision(auth, division.id, { config: { ...(division.config as Record<string, unknown>), onlinePlay: "lichess" } });
  const storedOnline = async (divisionId: string): Promise<string | null> =>
    ((await sql<{ config: { onlinePlay?: string } }[]>`select config from divisions where id = ${divisionId}`)[0]!.config.onlinePlay ?? null);

  it("an empty division, then 128 entrants: both can go online; 129 is refused ONLINE_PLAY_TOO_MANY_ENTRANTS with both numbers, and stays over the board", async () => {
    const { auth } = await orgOn("pro");
    let checked = 0;
    for (const [n, want] of [[0, "ok"], [MAX, "ok"], [MAX + 1, "too_many"]] as const) {
      const { division } = await divisionOf(auth, "otb");
      await fillEntrants(division.id, n);
      expect(await verdictOf(() => turnOn(auth, division)), `${n} entrants`).toBe(want);
      expect(await storedOnline(division.id), `${n} entrants: what is stored`).toBe(want === "ok" ? "lichess" : null);
      checked += 1;
    }
    expect(checked).toBe(3);
    const { division } = await divisionOf(auth, "otb");
    await fillEntrants(division.id, MAX + 1);
    await expect(turnOn(auth, division)).rejects.toMatchObject({
      status: 422,
      code: ONLINE_PLAY_TOO_MANY_ENTRANTS,
      extra: { limit: MAX, entrants: MAX + 1 },
    });
  });

  it("the other direction: a division ALREADY online with more than 128 (stored before the cap) re-saves its whole config untouched, and turning online OFF is never gated", async () => {
    const { auth } = await orgOn("pro");
    const { division } = await divisionOf(auth, "online");
    await fillEntrants(division.id, MAX + 2);
    await expect(patchDivision(auth, division.id, { config: { ...(division.config as Record<string, unknown>) } }), "a re-send of the stored 'lichess'").resolves.toBeTruthy();
    expect(await storedOnline(division.id)).toBe("lichess");
    await expect(patchDivision(auth, division.id, { config: { ...(division.config as Record<string, unknown>), onlinePlay: "off" } })).resolves.toBeTruthy();
    expect(await storedOnline(division.id), "turned off").toBeNull();
    // ...and now that it is over the board with 130 entrants, turning it back on is the refused transition.
    await expect(turnOn(auth, { id: division.id, config: { ...(division.config as Record<string, unknown>) } })).rejects.toMatchObject({
      code: ONLINE_PLAY_TOO_MANY_ENTRANTS,
    });
  });

  it("creating a division online is never over the cap: it starts empty (no entrant can precede it)", async () => {
    const { auth } = await orgOn("pro");
    const { division } = await divisionOf(auth, "online");
    expect(await entrantCount(division.id)).toBe(0);
  });
});

// ─── Fix round 1 (review C1, I1, I2, I3, I5): one count, every door, under one lock ─────────────────────────────

const idsOf = async (divisionId: string): Promise<string[]> =>
  (await sql<{ id: string }[]>`select id from entrants where division_id = ${divisionId} and status not in ('withdrawn', 'disqualified') order by id`).map((r) => r.id);
const heldOf = async (divisionId: string): Promise<number> => {
  // The count a person would make by hand from the tables: live entrants + sign-ups let in that are not entrants yet.
  const [{ n }] = await sql<{ n: number }[]>`
    select ((select count(*) from entrants where division_id = ${divisionId} and status not in ('withdrawn', 'disqualified'))
          + (select count(*) from registrations where division_id = ${divisionId} and status in ('pending', 'paid') and entrant_id is null and free_agent = false))::int as n`;
  return n;
};

describe.skipIf(!HAS_DB)("one count at every door: direct adds and sign-ups are the same places (review C1)", () => {
  it("the empty division first: the first add and the first sign-up are both admitted, and the count reads 2", async () => {
    const r = await regRig("pro", "online", "auto");
    expect(await heldOf(r.division.id), "premise: empty").toBe(0);
    expect(await verdictOf(() => addOne(r.auth, "online", r.division.id)), "the first add").toBe("ok");
    expect(await signUp(r, "online"), "the first sign-up").toBe("confirmed");
    expect(await heldOf(r.division.id)).toBe(2);
  });

  it("direct adds THEN sign-ups: 100 added + 27 signed up = 127; the 128th sign-up is confirmed, the 129th waitlisted, and one more add is refused", async () => {
    const r = await regRig("pro", "online", "auto");
    await fillEntrants(r.division.id, 100);
    await r.holders(MAX - 100 - 1);
    expect(await heldOf(r.division.id), "premise: 127").toBe(MAX - 1);
    expect(await signUp(r, "online"), "the 128th").toBe("confirmed");
    expect(await signUp(r, "online"), "the 129th: the sign-up door sees the direct adds too").toBe("waitlisted");
    expect(await verdictOf(() => addOne(r.auth, "online", r.division.id)), "and the add door sees the sign-ups").toBe("online");
    expect(await heldOf(r.division.id), "never past the cap").toBe(MAX);
  });

  it("sign-ups let in THEN direct adds: 100 pending (no entrant yet) + 27 added = 127; one more add is admitted, the next refused, and a sign-up waits", async () => {
    const r = await regRig("pro", "online", "manual");
    await r.pendingSignUps(100);
    await fillEntrants(r.division.id, MAX - 100 - 1);
    expect(await heldOf(r.division.id), "premise: 127, of which 100 are not entrants").toBe(MAX - 1);
    expect(await entrantCount(r.division.id), "premise: only 27 entrants - the old count would have said 27").toBe(MAX - 100 - 1);
    expect(await verdictOf(() => addOne(r.auth, "online", r.division.id)), "the 128th").toBe("ok");
    expect(await verdictOf(() => addOne(r.auth, "online", r.division.id)), "the 129th add: refused though only 28 rows exist").toBe("online");
    expect(await signUp(r, "online"), "a sign-up now waits").toBe("waitlisted");
    expect(await heldOf(r.division.id)).toBe(MAX);
  });

  it("over the board the same mix is the plan's: 128 pending + 100 added is not refused on Pro's 256", async () => {
    const r = await regRig("pro", "otb", "manual");
    await r.pendingSignUps(MAX);
    await fillEntrants(r.division.id, 100);
    expect(await verdictOf(() => addOne(r.auth, "otb", r.division.id)), "228 of 256, over the board").toBe("ok");
  });

  it("a free agent waiting for a team holds no place, and a paid sign-up that already has its entrant is counted once", async () => {
    const r = await regRig("pro", "online", "manual");
    const placesOf = async () =>
      (await publicRegistrationInfo(r.orgSlug, r.competition.slug)).divisions.find((d) => d.division_id === r.division.id)!.remaining;
    expect(await placesOf(), "the empty division first").toBe(MAX);
    const pending = await r.pendingSignUps(6);
    await sql`update registrations set free_agent = true where id in ${sql(pending.slice(0, 4))}`;
    expect(await placesOf(), "6 pending, 4 of them free agents: 2 places held").toBe(MAX - 2);
    const held = await r.holders(3);
    await sql`update registrations set status = 'paid' where id in ${sql(held)}`; // paid AND already entrants: one place each, not two
    expect(await placesOf(), "2 sign-ups + 3 entrants (their paid registrations are the same places)").toBe(MAX - 5);
    // Every status that holds a spot (SPOT_HOLDERS) holds a place while it has no entrant: pending, paid, and a confirmed one whose
    // entrant link is missing (an anomaly the count must not lose). The four free agents still hold nothing.
    await sql`update registrations set status = 'paid' where id = ${pending[4]!}`;
    await sql`update registrations set status = 'confirmed' where id = ${pending[5]!}`;
    expect(await placesOf(), "still 2 sign-ups (one paid, one confirmed without an entrant) + 3 entrants").toBe(MAX - 5);
    await sql`update registrations set status = 'waitlisted' where id in ${sql([pending[4]!, pending[5]!])}`;
    expect(await placesOf(), "waitlisted sign-ups hold nothing: the 3 entrants remain").toBe(MAX - 3);
  });

  it("places left counts the same: 100 added + 10 pending sign-ups leaves 18, not the 28 or 246 either half alone would say", async () => {
    const r = await regRig("pro", "online", "manual");
    await fillEntrants(r.division.id, 100);
    await r.pendingSignUps(10);
    const placesOf = async () =>
      (await publicRegistrationInfo(r.orgSlug, r.competition.slug)).divisions.find((d) => d.division_id === r.division.id)!.remaining;
    expect(await placesOf(), "128 - 110").toBe(MAX - 110);
    await r.pendingSignUps(MAX - 110);
    expect(await placesOf(), "full").toBe(0);
  });
});

describe.skipIf(!HAS_DB)("a withdrawn entrant holds no place, and Reinstate is a door (review I1)", () => {
  const reinstate = (auth: AuthCtx, entrantId: string) => patchEntrant(auth, entrantId, { status: "confirmed" });
  const statusOfEntrant = async (id: string): Promise<string> => (await sql<{ status: string }[]>`select status from entrants where id = ${id}`)[0]!.status;

  it("with room (the empty case): a withdrawn entrant is reinstated into a division holding 100; at 127 held it still fits the 128th", async () => {
    const r = await regRig("pro", "online", "manual");
    await fillEntrants(r.division.id, 100);
    const [gone] = await idsOf(r.division.id);
    await sql`update entrants set status = 'withdrawn' where id = ${gone!}`;
    await expect(reinstate(r.auth, gone!)).resolves.toBeTruthy();
    expect(await statusOfEntrant(gone!)).toBe("confirmed");
    await fillEntrants(r.division.id, MAX - 101); // 127 live
    const [second] = await idsOf(r.division.id);
    await sql`update entrants set status = 'withdrawn' where id = ${second!}`; // 126 live
    await r.pendingSignUps(1); // 127 held
    await expect(reinstate(r.auth, second!), "the 128th place").resolves.toBeTruthy();
  });

  it("withdraw, the waitlist promotes into the freed place, then Reinstate: refused ONLINE_DIVISION_FULL, still withdrawn, nothing written", async () => {
    const r = await regRig("pro", "online", "manual");
    await fillEntrants(r.division.id, MAX);
    const [leaver] = await idsOf(r.division.id);
    await sql`update entrants set status = 'withdrawn' where id = ${leaver!}`;
    const w = await r.waiting();
    expect((await promoteFromWaitlist(r.auth, r.division.id, { registrationId: w }))!.status, "the freed place goes to the waitlist").toBe("pending");
    expect(await heldOf(r.division.id), "premise: full again").toBe(MAX);
    await expect(reinstate(r.auth, leaver!)).rejects.toMatchObject({ status: 422, code: ONLINE_DIVISION_FULL, extra: { limit: MAX } });
    expect(await statusOfEntrant(leaver!), "still withdrawn").toBe("withdrawn");
  });

  it("a disqualified entrant is a departed one too: reinstated with room, refused at the cap; over the board a Reinstate is never capped", async () => {
    const r = await regRig("pro", "online", "manual");
    await fillEntrants(r.division.id, MAX);
    const [dq] = await idsOf(r.division.id);
    await sql`update entrants set status = 'disqualified' where id = ${dq!}`;
    await fillEntrants(r.division.id, 1); // the freed place is taken
    await expect(reinstate(r.auth, dq!)).rejects.toMatchObject({ code: ONLINE_DIVISION_FULL });
    const otb = await regRig("pro", "otb", "manual");
    await fillEntrants(otb.division.id, MAX + 1);
    const [gone] = await idsOf(otb.division.id);
    await sql`update entrants set status = 'withdrawn' where id = ${gone!}`;
    await expect(reinstate(otb.auth, gone!), "129 over the board, on Pro's 256").resolves.toBeTruthy();
  });

  it("a status patch that is not a Reinstate (a rename, a re-send of the same status) is never gated at the cap", async () => {
    const r = await regRig("pro", "online", "manual");
    await fillEntrants(r.division.id, MAX);
    const [one] = await idsOf(r.division.id);
    await expect(patchEntrant(r.auth, one!, { display_name: "Renamed" } as never)).resolves.toBeTruthy();
    await expect(patchEntrant(r.auth, one!, { status: "confirmed" })).resolves.toBeTruthy();
  });
});

describe.skipIf(!HAS_DB)("the online switch counts the sign-ups already let in (review C1)", () => {
  const turnOn = (auth: AuthCtx, division: { id: string; config: unknown }) =>
    patchDivision(auth, division.id, { config: { ...(division.config as Record<string, unknown>), onlinePlay: "lichess" } });

  it("an empty division goes online; 128 pending sign-ups and no entrant go online; 129 do not - and the refusal names both numbers", async () => {
    let checked = 0;
    for (const [pending, want] of [[0, "ok"], [MAX, "ok"], [MAX + 1, "too_many"]] as const) {
      const r = await regRig("pro", "otb", "manual");
      await r.pendingSignUps(pending);
      expect(await entrantCount(r.division.id), "premise: no entrant exists - the old count read 0").toBe(0);
      expect(await verdictOf(() => turnOn(r.auth, r.division)), `${pending} pending sign-ups`).toBe(want);
      checked += 1;
    }
    expect(checked).toBe(3);
    const r = await regRig("pro", "otb", "manual");
    await r.pendingSignUps(60);
    await fillEntrants(r.division.id, 69);
    await expect(turnOn(r.auth, r.division), "60 pending + 69 entrants").rejects.toMatchObject({
      status: 422,
      code: ONLINE_PLAY_TOO_MANY_ENTRANTS,
      extra: { limit: MAX, entrants: 129 },
    });
  });

  it("withdrawn entrants and waitlisted sign-ups do not count: 128 live + 30 withdrawn + 30 waitlisted still goes online", async () => {
    const r = await regRig("pro", "otb", "manual");
    await fillEntrants(r.division.id, MAX + 30);
    await sql`update entrants set status = 'withdrawn' where id in (select id from entrants where division_id = ${r.division.id} order by id limit 30)`;
    for (let i = 0; i < 3; i++) await r.waiting();
    await expect(turnOn(r.auth, r.division)).resolves.toBeTruthy();
  });
});

/** Hold the division's advisory lock from another connection, run `door`, and report whether it WAITED on that very lock (an ungranted
 *  advisory lock on the same key appears in pg_locks) and had not finished while it was held. The holder is then released and the door's
 *  own outcome returned. A door that never takes the lock finishes straight away, and `waited` is false. */
async function holdingDivisionLock<T>(
  divisionId: string,
  door: () => Promise<T>,
  whileWaiting?: () => Promise<void>,
): Promise<{ waited: boolean; outcome: PromiseSettledResult<T> }> {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let held!: () => void;
  const holding = new Promise<void>((r) => (held = r));
  let key: { classid: string; objid: string } | undefined;
  const holder = sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [k] = await tx<{ classid: string; objid: string }[]>`
      select classid::bigint::text as classid, objid::bigint::text as objid from pg_locks
      where locktype = 'advisory' and pid = pg_backend_pid() and granted limit 1`;
    key = k;
    held();
    await released;
  });
  await holding;
  expect(key, "premise: the holder's own advisory lock was read back").toBeDefined();
  let settled = false;
  const run = door().then(
    (value): PromiseSettledResult<T> => ((settled = true), { status: "fulfilled", value }),
    (reason): PromiseSettledResult<T> => ((settled = true), { status: "rejected", reason }),
  );
  let waited = false;
  for (let i = 0; i < 120 && !waited && !settled; i++) {
    const [w] = await sql<{ x: number }[]>`
      select 1 as x from pg_locks
      where locktype = 'advisory' and not granted and classid::bigint = ${key!.classid}::bigint and objid::bigint = ${key!.objid}::bigint limit 1`;
    waited = w !== undefined;
    if (!waited) await new Promise((r) => setTimeout(r, 50));
  }
  const finishedWhileHeld = settled;
  if (waited && !settled && whileWaiting) await whileWaiting(); // the world changes while the door is queued
  release();
  await holder;
  return { waited: waited && !finishedWhileHeld, outcome: await run };
}

describe.skipIf(!HAS_DB)("every door takes the division's lock before it counts (review I2)", () => {
  it("createEntrants waits for a held `division:` lock, then runs", async () => {
    const r = await regRig("pro", "online", "manual");
    const { waited, outcome } = await holdingDivisionLock(r.division.id, () => addOne(r.auth, "online", r.division.id));
    expect(waited, "createEntrants queued behind the lock").toBe(true);
    expect(outcome.status).toBe("fulfilled");
    expect(await entrantCount(r.division.id)).toBe(1);
  });

  it("the public sign-up waits for it", async () => {
    const r = await regRig("pro", "online", "auto");
    const { waited, outcome } = await holdingDivisionLock(r.division.id, () => signUp(r, "online"));
    expect(waited, "submit queued behind the lock").toBe(true);
    expect(outcome).toMatchObject({ status: "fulfilled", value: "confirmed" });
  });

  it("an organiser's Promote waits for it", async () => {
    const r = await regRig("pro", "online", "manual");
    const w = await r.waiting();
    const { waited, outcome } = await holdingDivisionLock(r.division.id, () => promoteFromWaitlist(r.auth, r.division.id, { registrationId: w }));
    expect(waited, "promote queued behind the lock").toBe(true);
    expect(outcome.status).toBe("fulfilled");
  });

  it("a Reinstate waits for it", async () => {
    const r = await regRig("pro", "online", "manual");
    await fillEntrants(r.division.id, 3);
    const [gone] = await idsOf(r.division.id);
    await sql`update entrants set status = 'withdrawn' where id = ${gone!}`;
    const { waited, outcome } = await holdingDivisionLock(r.division.id, () => patchEntrant(r.auth, gone!, { status: "confirmed" }));
    expect(waited, "the Reinstate queued behind the lock").toBe(true);
    expect(outcome.status).toBe("fulfilled");
  });

  it("a Reinstate COUNTS under the lock (review I2): the division fills while it queues, and it is refused; with no fill it is admitted", async () => {
    const attempt = async (fillWhileQueued: boolean) => {
      const r = await regRig("pro", "online", "manual");
      await fillEntrants(r.division.id, 3);
      const [gone] = await idsOf(r.division.id);
      await sql`update entrants set status = 'withdrawn' where id = ${gone!}`; // 2 live
      return holdingDivisionLock(
        r.division.id,
        () => patchEntrant(r.auth, gone!, { status: "confirmed" }),
        fillWhileQueued ? () => fillEntrants(r.division.id, MAX - 2) : undefined, // 128 live while it waits: it would be the 129th
      );
    };
    const control = await attempt(false);
    expect(control.waited, "premise: it queued").toBe(true);
    expect(control.outcome.status, "control: with room it is admitted").toBe("fulfilled");
    const filled = await attempt(true);
    expect(filled.waited, "premise: it queued").toBe(true);
    expect(filled.outcome).toMatchObject({ status: "rejected", reason: { status: 422, code: ONLINE_DIVISION_FULL } });
  });

  it("the online switch waits for it", async () => {
    const r = await regRig("pro", "otb", "manual");
    const { waited, outcome } = await holdingDivisionLock(r.division.id, () =>
      patchDivision(r.auth, r.division.id, { config: { ...(r.division.config as Record<string, unknown>), onlinePlay: "lichess" } }),
    );
    expect(waited, "patchDivision queued behind the lock").toBe(true);
    expect(outcome.status).toBe("fulfilled");
  });

  it("the public sign-up reads whether the division plays online UNDER the lock (review M2): switched online while it queues, a full division waitlists it", async () => {
    // Control first: the same sequence with no switch confirms - the division is over the board, 128 held of Pro's 256.
    const control = await regRig("pro", "otb", "auto");
    await control.holders(MAX);
    const plain = await holdingDivisionLock(control.division.id, () => signUp(control, "otb"));
    expect(plain.waited, "premise: the sign-up queued").toBe(true);
    expect(plain.outcome, "control: an over-the-board division at 128 still admits").toMatchObject({ status: "fulfilled", value: "confirmed" });
    // The switch lands while the sign-up waits for the lock; a read taken before the lock would still see over-the-board.
    const r = await regRig("pro", "otb", "auto");
    await r.holders(MAX);
    const { waited, outcome } = await holdingDivisionLock(
      r.division.id,
      () => signUp(r, "otb"),
      async () => {
        await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${r.division.id}`;
      },
    );
    expect(waited, "premise: it queued behind the lock").toBe(true);
    expect(outcome, "it saw the division online once it had the lock").toMatchObject({ status: "fulfilled", value: "waitlisted" });
  });

  it("the check itself: a lock held on ANOTHER division blocks nothing (the helper does not report a wait that is not there)", async () => {
    const r = await regRig("pro", "online", "manual");
    const other = await regRig("pro", "online", "manual");
    const { waited, outcome } = await holdingDivisionLock(other.division.id, () => addOne(r.auth, "online", r.division.id));
    expect(waited, "no wait on a different key").toBe(false);
    expect(outcome.status).toBe("fulfilled");
  });
});

describe.skipIf(!HAS_DB)("two doors racing for the last place: exactly one wins (review I2, I5)", () => {
  const entry = async (auth: AuthCtx, name: string): Promise<CreateEntrant> => ({
    display_name: name,
    kind: "individual",
    members: [{ person_id: (await linkedPlayer(auth)).personId, is_captain: false, roles: [] }],
  });

  it("two adds at 127 held, on two connections: one is admitted, one refused ONLINE_DIVISION_FULL, and the division ends at 128 (five rounds)", async () => {
    let rounds = 0;
    for (let i = 0; i < 5; i++) {
      const { auth } = await orgOn("pro");
      const { division } = await divisionOf(auth, "online");
      await fillEntrants(division.id, MAX - 1);
      const [a, b] = [await entry(auth, `Race A${i}`), await entry(auth, `Race B${i}`)];
      const settled = await Promise.allSettled([createEntrants(auth, division.id, [a]), createEntrants(auth, division.id, [b])]);
      const ok = settled.filter((x) => x.status === "fulfilled").length;
      const full = settled.filter((x) => x.status === "rejected" && (x.reason as { code?: string }).code === ONLINE_DIVISION_FULL).length;
      expect([ok, full], `round ${i}: one wins, one is refused (and nothing else went wrong)`).toEqual([1, 1]);
      expect(await heldOf(division.id), `round ${i}`).toBe(MAX);
      rounds += 1;
    }
    expect(rounds, "anti-vacuity: five rounds ran").toBe(5);
  });

  it("an add, a public sign-up and an organiser's Promote at 127 held: exactly one gets the place, none deadlocks, the count ends at 128 (three rounds)", async () => {
    let rounds = 0;
    for (let i = 0; i < 3; i++) {
      const r = await regRig("pro", "online", "auto");
      await fillEntrants(r.division.id, MAX - 1);
      const waiting = await r.waiting();
      const added = await entry(r.auth, `Race add ${i}`);
      const settled = await Promise.allSettled([
        createEntrants(r.auth, r.division.id, [added]),
        signUp(r, "online"),
        promoteFromWaitlist(r.auth, r.division.id, { registrationId: waiting }),
      ]);
      for (const x of settled) {
        if (x.status === "rejected") {
          const code = (x.reason as { code?: string }).code;
          expect(code, `round ${i}: a refusal is the cap's own, never a deadlock (${String((x.reason as Error).message).slice(0, 80)})`).toBe(ONLINE_DIVISION_FULL);
        }
      }
      const won = settled.filter((x) => x.status === "fulfilled" && x.value !== "waitlisted").length;
      expect(won, `round ${i}: exactly one of the three took the last place`).toBe(1);
      expect(await heldOf(r.division.id), `round ${i}: the division never passed its cap`).toBe(MAX);
      rounds += 1;
    }
    expect(rounds).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("materialise never throws on the cap; a breach is a log line (review I3)", () => {
  it("a confirmation into a division that is NOT over the cap logs nothing; one that is (a state no door produces) still confirms, and says so in the log", async () => {
    const r = await regRig("pro", "online", "manual");
    await r.holders(MAX - 1);
    const paid = async (): Promise<string> => {
      const id = await r.waiting();
      await sql`update registrations set status = 'paid' where id = ${id}`;
      return id;
    };
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      const first = await paid(); // 127 + 1 paid, no entrant yet = 128 held
      expect(await heldOf(r.division.id), "premise: exactly at the cap").toBe(MAX);
      await expect(confirmRegistration(r.auth, first), "a paid sign-up holds its place already: confirming it grows nothing").resolves.toBeTruthy();
      expect(await heldOf(r.division.id), "its place moved from the sign-up term to the entrant term").toBe(MAX);
      expect(error.mock.calls.filter(([, msg]) => /over its entrant cap/.test(String(msg))), "at the cap exactly: no breach line").toHaveLength(0);
      // Breach: a paid sign-up that no door admitted (the seed bypasses them) pushes the division to 129 before it is confirmed.
      const stray = await paid();
      expect(await heldOf(r.division.id), "premise: 129 held - past the cap").toBe(MAX + 1);
      await expect(confirmRegistration(r.auth, stray), "confirming never throws on the cap").resolves.toBeTruthy();
      const lines = error.mock.calls.filter(([, msg]) => /over its entrant cap/.test(String(msg)));
      expect(lines, "one breach line").toHaveLength(1);
      expect(lines[0]![0], "it names the division and the numbers").toMatchObject({ divisionId: r.division.id, held: MAX + 1, limit: MAX });
    } finally {
      error.mockRestore();
    }
  });
});

// ─── Fix round 2 (re-review N1, N2): the cap holds through promotion and through a plan below it ───────────────────

const statusOfReg = async (id: string): Promise<string> => (await sql<{ status: string }[]>`select status from registrations where id = ${id}`)[0]!.status;

describe.skipIf(!HAS_DB)("a plan below 128 holds the mixed count too (re-review N2)", () => {
  const placesOf = async (r: Awaited<ReturnType<typeof regRig>>): Promise<number | null> =>
    (await publicRegistrationInfo(r.orgSlug, r.competition.slug)).divisions.find((d) => d.division_id === r.division.id)!.remaining;

  it("plan 96, online: the empty division first, then 48 added + 47 sign-ups = 95: the 96th place is taken, the 97th is refused at every door", async () => {
    const r = await regRig("size-pack-96", "online", "manual");
    expect(await placesOf(r), "the empty division: the plan's 96").toBe(96);
    expect(await signUp(r, "online"), "with room a manual-approval sign-up waits for the organiser").toBe("pending");
    await fillEntrants(r.division.id, 48);
    await r.pendingSignUps(46);
    expect(await heldOf(r.division.id), "premise: 48 entrants + 47 sign-ups let in").toBe(95);
    expect(await entrantCount(r.division.id), "premise: only 48 entrants rows - neither count alone is near 96").toBe(48);
    expect(await placesOf(r), "places left: 96 - 95").toBe(1);
    expect(await verdictOf(() => addOne(r.auth, "online", r.division.id)), "the 96th place").toBe("ok");
    expect(await placesOf(r), "full").toBe(0);
    expect(await verdictOf(() => addOne(r.auth, "online", r.division.id)), "the 97th add is the PLAN's refusal (a plan raises it)").toBe("plan");
    expect(await signUp(r, "online"), "the 97th sign-up waits").toBe("waitlisted");
    expect(await heldOf(r.division.id), "never past the plan").toBe(96);
  });

  it("plan 96, online: the organiser's promote is the plan's 422 once the mixed count is full; over the board the same plan counts rows only", async () => {
    const r = await regRig("size-pack-96", "online", "manual");
    const w = await r.waiting();
    expect((await promoteFromWaitlist(r.auth, r.division.id, { registrationId: w }))!.status, "empty division: promoted").toBe("pending");
    await fillEntrants(r.division.id, 60);
    await r.pendingSignUps(35); // 60 + 35 + the promoted one = 96
    expect(await heldOf(r.division.id), "premise: full at the plan's 96").toBe(96);
    const w2 = await r.waiting();
    await expect(promoteFromWaitlist(r.auth, r.division.id, { registrationId: w2 })).rejects.toMatchObject({ status: 422, code: PROMOTE_PLAN_LIMIT_CODE });
    // Over the board the sign-ups and the added entrants are different counts, as they always were.
    const otb = await regRig("size-pack-96", "otb", "manual");
    await otb.pendingSignUps(50);
    await fillEntrants(otb.division.id, 60);
    expect(await verdictOf(() => addOne(otb.auth, "otb", otb.division.id)), "110 held over the board on a plan of 96: rows (60) decide").toBe("ok");
  });
});

describe.skipIf(!HAS_DB)("auto-promotion never takes an online division past its cap (re-review N1)", () => {
  /** An online manual-approval division holding `live` entrants and waiting one registrant, W (waitlisted). */
  const rigWith = async (live: number) => {
    const r = await regRig("pro", "online", "manual");
    await fillEntrants(r.division.id, live);
    return { r, w: await r.waiting() };
  };
  const heldNow = (r: { division: { id: string } }) => heldOf(r.division.id);

  it("a legitimate withdrawal at the cap frees ONE place and promotes ONE registrant (the empty case: nothing was freed twice)", async () => {
    const r = await regRig("pro", "online", "manual");
    const [holder] = await r.holders(1);
    await fillEntrants(r.division.id, MAX - 1);
    const w = await r.waiting();
    expect(await heldNow(r), "premise: full").toBe(MAX);
    await withdrawRegistration(r.auth, holder!);
    expect(await statusOfReg(w), "the freed place went to the waitlist").toBe("pending");
    expect(await heldNow(r), "full again, never past").toBe(MAX);
  });

  it("an organiser frees a place from the TABLE (withdraws the entrant), fills it, and then the registrant withdraws: the place is not freed twice", async () => {
    const r = await regRig("pro", "online", "manual");
    const [holder] = await r.holders(1);
    await fillEntrants(r.division.id, MAX - 1);
    const w = await r.waiting();
    const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string }[]>`select entrant_id from registrations where id = ${holder!}`;
    await patchEntrant(r.auth, entrantId, { status: "withdrawn" }); // the organiser withdraws E: the registration is untouched
    expect(await heldNow(r), "premise: 127").toBe(MAX - 1);
    await addOne(r.auth, "online", r.division.id); // N takes the place
    expect(await heldNow(r), "premise: 128 again").toBe(MAX);
    await withdrawRegistration(r.auth, holder!); // the registrant of E's row now withdraws too
    expect(await statusOfReg(holder!), "premise: the registration did withdraw").toBe("withdrawn");
    expect(await statusOfReg(w), "no place was freed: the waitlisted one stays waitlisted").toBe("waitlisted");
    expect(await heldNow(r), "the division stays at its cap").toBe(MAX);
  });

  it("the same sequence over the board promotes (the cap is the online division's)", async () => {
    const r = await regRig("pro", "otb", "manual");
    const [holder] = await r.holders(1);
    await fillEntrants(r.division.id, MAX - 1);
    const w = await r.waiting();
    const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string }[]>`select entrant_id from registrations where id = ${holder!}`;
    await patchEntrant(r.auth, entrantId, { status: "withdrawn" });
    await addOne(r.auth, "otb", r.division.id);
    await withdrawRegistration(r.auth, holder!);
    expect(await statusOfReg(w), "Pro's 256 has room: the waitlist is served").toBe("pending");
  });

  it("an expiry frees a place: with room the waitlist is served; with the division already full it is not", async () => {
    const lapsedCard = async (r: Awaited<ReturnType<typeof regRig>>): Promise<string> => {
      const { registration } = await seedRegistration(
        r.competition.id,
        r.division.id,
        { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
        { status: "pending", displayName: "Lapsed card" },
      );
      await sql`update registration_groups set expires_at = now() - interval '1 hour' where id = ${registration.group_id}`;
      return registration.id;
    };
    const room = await rigWith(MAX - 2); // 127 held with the expiring one: 126 after it
    const roomHolder = await lapsedCard(room.r);
    await sweepRegistrations("https://example.test");
    expect(await statusOfReg(roomHolder), "premise: the sweep expired it").toBe("expired");
    expect(await statusOfReg(room.w), "room: served").toBe("pending");
    const full = await rigWith(MAX); // 128 live + the expiring one = 129 held: 128 after it
    const fullHolder = await lapsedCard(full.r);
    expect(await heldNow(full.r), "premise: stored past the cap").toBe(MAX + 1);
    await sweepRegistrations("https://example.test");
    expect(await statusOfReg(fullHolder), "premise: the sweep expired it").toBe("expired");
    expect(await statusOfReg(full.w), "full: the waitlist is NOT served").toBe("waitlisted");
    expect(await heldNow(full.r)).toBe(MAX);
  });

  it("a lapsed promotion window re-offers its place: served with room, held back when the division is full", async () => {
    const lapsing = async (r: Awaited<ReturnType<typeof regRig>>): Promise<string> => {
      const { registration } = await seedRegistration(r.competition.id, r.division.id, FEES, { status: "pending", displayName: "Lapsing" });
      await sql`update registrations set promoted_at = now() - interval '2 hours', promotion_expires_at = now() - interval '1 hour' where id = ${registration.id}`;
      return registration.id;
    };
    const room = await rigWith(MAX - 2);
    const roomLapsed = await lapsing(room.r);
    await sweepRegistrations("https://example.test");
    expect(await statusOfReg(roomLapsed), "premise: the lapsing pass put it back").toBe("waitlisted");
    expect(await statusOfReg(room.w), "room: the next in line is served").toBe("pending");
    const full = await rigWith(MAX);
    const fullLapsed = await lapsing(full.r);
    await sweepRegistrations("https://example.test");
    expect(await statusOfReg(fullLapsed), "premise: the lapsing pass put it back").toBe("waitlisted");
    expect(await statusOfReg(full.w), "full: nobody is served").toBe("waitlisted");
    expect(await heldNow(full.r)).toBe(MAX);
  });

  it("a rejection frees a place: served with room, held back when the division is full", async () => {
    const room = await rigWith(MAX - 2);
    const [roomPending] = await room.r.pendingSignUps(1);
    await rejectRegistration(room.r.auth, roomPending!);
    expect(await statusOfReg(room.w), "room: served").toBe("pending");
    const full = await rigWith(MAX);
    const [fullPending] = await full.r.pendingSignUps(1);
    expect(await heldNow(full.r), "premise: stored past the cap").toBe(MAX + 1);
    await rejectRegistration(full.r.auth, fullPending!);
    expect(await statusOfReg(fullPending!)).toBe("rejected");
    expect(await statusOfReg(full.w), "full: not served").toBe("waitlisted");
    expect(await heldNow(full.r)).toBe(MAX);
  });
});

describe.skipIf(!HAS_DB)("a division of a sport that cannot play online never queues on the division lock (re-review minor)", () => {
  it("the public sign-up and an organiser's promote on a badminton division finish while the lock is held; on a chess division both wait (the control)", async () => {
    const chess = await regRig("pro", "otb", "auto");
    const chessSignUp = await holdingDivisionLock(chess.division.id, () => signUp(chess, "otb"));
    expect(chessSignUp.waited, "control: a chess division's sign-up queues").toBe(true);
    const chessManual = await regRig("pro", "otb", "manual");
    const chessW = await chessManual.waiting();
    const chessPromote = await holdingDivisionLock(chessManual.division.id, () => promoteFromWaitlist(chessManual.auth, chessManual.division.id, { registrationId: chessW }));
    expect(chessPromote.waited, "control: a chess division's promote queues").toBe(true);

    const bad = await regRig("pro", "badminton", "auto");
    const sign = await holdingDivisionLock(bad.division.id, () => signUp(bad, "badminton"));
    expect(sign.waited, "a badminton sign-up never waited on the division lock").toBe(false);
    expect(sign.outcome, "and it was served").toMatchObject({ status: "fulfilled", value: "confirmed" });
    const badManual = await regRig("pro", "badminton", "manual");
    const badW = await badManual.waiting();
    const promote = await holdingDivisionLock(badManual.division.id, () => promoteFromWaitlist(badManual.auth, badManual.division.id, { registrationId: badW }));
    expect(promote.waited, "a badminton promote never waited on the division lock").toBe(false);
    expect(promote.outcome.status).toBe("fulfilled");
  });
});

describe.skipIf(!HAS_DB)("auto-promotion honours a plan below the online cap too (re-review N1 with N2)", () => {
  it("plan 96: the double-freed place is not served once 96 are held; the same sequence with room is", async () => {
    const run = async (extra: number) => {
      const r = await regRig("size-pack-96", "online", "manual");
      const [holder] = await r.holders(1);
      await fillEntrants(r.division.id, 94 + extra); // 95 (+ extra) live with the holder's entrant
      const w = await r.waiting();
      const [{ entrant_id: entrantId }] = await sql<{ entrant_id: string }[]>`select entrant_id from registrations where id = ${holder!}`;
      await patchEntrant(r.auth, entrantId, { status: "withdrawn" });
      await r.pendingSignUps(1); // takes the freed place as a sign-up (an add would be one row too many for the plan's own row count)
      await withdrawRegistration(r.auth, holder!);
      return { status: await statusOfReg(w), held: await heldOf(r.division.id) };
    };
    expect(await run(0), "95 held when the registrant withdraws: the waitlist is served, to 96").toEqual({ status: "pending", held: 96 });
    expect(await run(1), "96 held when the registrant withdraws: a place that is not there is not served").toEqual({ status: "waitlisted", held: 96 });
  });
});
