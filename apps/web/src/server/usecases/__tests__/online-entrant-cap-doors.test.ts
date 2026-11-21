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
// Real Postgres required (skipped without DATABASE_URL). Another sport: badminton and generic stand for "every other sport" at the
// doors; the registry-wide sweep over every sport is in external-play/__tests__/online-entrant-cap.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
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
import { createEntrants } from "../entrants";
import { publicRegistrationInfo } from "../registrations/settings";
import { confirmRegistration, confirmRegistrationWaived, putRegistrationSettings } from "../registrations";
import { promoteFromWaitlist } from "../registration-approval";
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
type PlanName = "community" | "event-pass-sized" | "pro" | "unlimited";
const PLANS: Record<PlanName, { plan: "community" | "pro"; override?: number | null; cap: number | null }> = {
  community: { plan: "community", cap: 64 },
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

  it("a division already past the cap (it held more before the cap existed) takes no more, and a withdrawal does not make the count lie", async () => {
    const { auth } = await orgOn("pro");
    const { division } = await divisionOf(auth, "online");
    await fillEntrants(division.id, MAX + 2); // 130, stored before the ruling
    expect(await verdictOf(() => addOne(auth, "online", division.id)), "130 held: the 131st").toBe("online");
    expect(await entrantCount(division.id)).toBe(MAX + 2);
  });
});

// ─── The registration rig (doors 2 - 5) ──────────────────────────────────────────────────────────────────────

async function regRig(plan: PlanName, kind: Exclude<Kind, "badminton">, approval: "auto" | "manual") {
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
      ids.push(registration.id);
    }
    return ids;
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
  return { auth, competition, division, orgSlug: org!.slug, holders, waiting, statusOf };
}

// ─── Door 2: the public sign-up waitlists at the cap ─────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("door: the public sign-up (submit) waitlists at the cap, as it does at the plan's", () => {
  async function signUp(r: Awaited<ReturnType<typeof regRig>>, kind: "online" | "otb"): Promise<string> {
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

  it("Pro, online: 127 held, the 128th is confirmed and the 129th is waitlisted; after a place frees, the next is confirmed again", async () => {
    const r = await regRig("pro", "online", "auto");
    const held = await r.holders(MAX - 1);
    expect(await signUp(r, "online"), "the 128th").toBe("confirmed");
    expect(await signUp(r, "online"), "the 129th").toBe("waitlisted");
    // The sequence: a held place is withdrawn, so the division is no longer full.
    await sql`update registrations set status = 'withdrawn' where id = ${held[0]!}`;
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
