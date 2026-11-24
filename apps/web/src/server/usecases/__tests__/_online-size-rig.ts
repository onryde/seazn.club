// Shared rig of the two Task 7 suites (the size as the entrant cap: online-entrant-size-doors.test.ts, the waitlist promotion into a
// bigger size: online-package/__tests__/promote-into-room.test.ts). An organisation, a public competition and an online chess division
// made through the REAL doors (`createCompetition`, `createDivision`: the unpaid package at the size asked is the door's own, never
// seeded), registration settings through the real save, and the helpers every door driver needs: places held counted by hand, entrants
// and holders seeded straight into the tables (the cap's subject is the ONE place added on top, not 256 round trips), a sign-up through
// `submitRegistrationGroup`, a waitlisted registrant a seat gate can seat, and a held `division:` lock to prove a door counts after it.
// Expected numbers never come from here: each suite types its own from the spec (§5.2, §7.6, P17, P18).
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { PaymentRequiredError } from "@/lib/errors";
import type { OnlineSize } from "@/lib/online-chess-package";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateEntrant } from "@/server/api-v1/schemas";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import { submitRegistrationGroup } from "@/server/usecases/registration-submit";
import { SETTINGS_BASE, seedRegistration } from "./_registration-fixtures";
import { seedOwner, seedPlayer, type SeedPlayer } from "./_external-play-seed";

const BADMINTON = builtinModules.find((m) => m.key === "badminton")!;
const FEES = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
const CLOCK = { base: 600, increment: 5 };

export type Approval = "auto" | "manual";
/** The org's per-division entrant plan cap: left alone (Pro's 256), or an override row (a number, or null for unlimited). */
export type PlanCap = undefined | number | null | "community";

export interface SizeRigOpts {
  /** The package size chosen at creation; `null` = a division that does NOT play online (over the board). */
  size?: OnlineSize | null;
  approval?: Approval;
  plan?: PlanCap;
  /** "badminton": another sport altogether (never online). */
  sport?: "boardgame" | "badminton";
}

export async function linkedPlayer(auth: AuthCtx): Promise<SeedPlayer> {
  return seedPlayer(auth.orgId, "Player " + randomUUID().slice(0, 6), `s-${randomUUID().replaceAll("-", "").slice(0, 12)}`, true);
}

/** The count a person would make by hand from the tables: live entrants + sign-ups let in that are not entrants yet. */
export const heldOf = async (divisionId: string): Promise<number> => {
  const [{ n }] = await sql<{ n: number }[]>`
    select ((select count(*) from entrants where division_id = ${divisionId} and status not in ('withdrawn', 'disqualified'))
          + (select count(*) from registrations where division_id = ${divisionId} and status in ('pending', 'paid') and entrant_id is null and free_agent = false))::int as n`;
  return n;
};

export const entrantRows = async (divisionId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from entrants where division_id = ${divisionId}`)[0]!.n;

/** `n` spot-holding entrants, inserted directly. */
export async function fillEntrants(divisionId: string, n: number): Promise<void> {
  if (n <= 0) return;
  await sql`
    insert into entrants (division_id, kind, display_name, status)
    select ${divisionId}, 'individual', 'Seed ' || g, 'confirmed' from generate_series(1, ${n}) g`;
}

export const idsOf = async (divisionId: string): Promise<string[]> =>
  (await sql<{ id: string }[]>`select id from entrants where division_id = ${divisionId} and status = 'confirmed' order by id`).map((r) => r.id);

export async function sizeRig(opts: SizeRigOpts = {}) {
  const size = opts.size === undefined ? 16 : opts.size;
  const approval = opts.approval ?? "auto";
  const sport = opts.sport ?? "boardgame";
  const auth = await seedOwner(); // a Pro organisation (session auth) with the boardgame sport seeded
  if (opts.plan === "community") await setOrgPlan(auth.orgId, "community");
  if (typeof opts.plan === "number" || opts.plan === null) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${auth.orgId}, 'entrants.per_division.max', ${opts.plan}, 'test - online entrant size doors')`;
  }
  await invalidateOrgEntitlements(auth.orgId);
  const competition = await createCompetition(auth, {
    name: "Size Cup " + randomUUID().slice(0, 6),
    visibility: "public",
    branding: {},
    starts_on: "2030-11-01",
    ends_on: "2030-11-02",
  });
  if (opts.plan !== undefined) {
    // Premise: the plan cap the case names is the one the entitlement resolver reads back (Community's own is the catalogue's 64).
    const want = opts.plan === "community" ? 64 : opts.plan;
    expect(await getLimit(auth.orgId, "entrants.per_division.max", competition.id), `premise: the plan reads back as ${String(want)}`).toBe(want);
  }
  let division;
  if (sport === "badminton") {
    const variant = Object.keys(BADMINTON.variants)[0]!;
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('badminton', 'Badminton', ${BADMINTON.version}, ${sql.json(BADMINTON.positions as never)})
      on conflict (key) do nothing`;
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('badminton', ${variant}, ${variant}, ${sql.json((BADMINTON.variants[variant] ?? {}) as never)}, true)
      on conflict do nothing`;
    division = await createDivision(auth, competition.id, {
      name: "Open", slug: "open", sport_key: "badminton", variant_key: variant, config: BADMINTON.variants[variant] ?? {},
    } as never);
  } else {
    division = await createDivision(auth, competition.id, {
      name: size === null ? "Over the board" : "Online",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", clock: CLOCK, ...(size === null ? {} : { onlinePlay: "lichess" }) },
      ...(size === null ? {} : { online_size: size }),
    });
  }
  if (size !== null && sport === "boardgame") {
    // Premise: the door made the division's one live package, unpaid, at the size asked.
    const [pkg] = await sql<{ size: number; paid_at: Date | null }[]>`
      select size, paid_at from division_online_packages where division_id = ${division.id} and refunded_at is null`;
    expect(pkg, "premise: createDivision opened the live package").toBeDefined();
    expect(pkg!.size, "premise: at the size asked").toBe(size);
    expect(pkg!.paid_at, "premise: unpaid").toBeNull();
  }
  await putRegistrationSettings(auth, division.id, {
    ...SETTINGS_BASE,
    payment_method: "offline",
    fee_cents: 0,
    capacity: null,
    approval,
    allow_free_agents: false,
  } as never);
  const [org] = await sql<{ slug: string }[]>`select slug from organizations where id = ${auth.orgId}`;
  const online = size !== null && sport === "boardgame";

  /** `n` confirmed sign-ups, each with its entrant (what a confirmed registration IS once materialised). */
  const holders = async (n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { registration } = await seedRegistration(competition.id, division.id, FEES, { status: "confirmed", displayName: `Holder ${i + 1}` });
      const [entrant] = await sql<{ id: string }[]>`
        insert into entrants (division_id, kind, display_name, status)
        values (${division.id}, 'individual', ${`Holder ${i + 1}`}, 'confirmed') returning id`;
      await sql`update registrations set entrant_id = ${entrant!.id} where id = ${registration.id}`;
      ids.push(registration.id);
    }
    return ids;
  };
  /** A waitlisted entry. On an online division it names a player who can play (a linked Lichess account): the seat gate asks of any seat
   *  and answers before the room check; `linked: false` is a registrant it turns away. */
  const waiting = async (linked = true): Promise<string> => {
    const { registration } = await seedRegistration(competition.id, division.id, FEES, {
      status: "waitlisted",
      displayName: "Waiting " + randomUUID().slice(0, 6),
    });
    if (online && linked) {
      const p = await linkedPlayer(auth);
      await sql`
        insert into registration_players (registration_id, full_name, user_id, source)
        values (${registration.id}, 'Player', ${p.userId}, 'captain_entered')`;
    }
    return registration.id;
  };
  /** A registration leaves the way the product does it before Start: the sign-up is withdrawn and so is its entrant. */
  const withdrawHolder = async (registrationId: string): Promise<void> => {
    await sql`update entrants set status = 'withdrawn' where id = (select entrant_id from registrations where id = ${registrationId})`;
    await sql`update registrations set status = 'withdrawn' where id = ${registrationId}`;
  };
  const statusOf = async (id: string): Promise<string> => (await sql<{ status: string }[]>`select status from registrations where id = ${id}`)[0]!.status;
  const sizeNow = async (): Promise<number | null> =>
    (await sql<{ size: number }[]>`select size from division_online_packages where division_id = ${division.id} and refunded_at is null`)[0]?.size ?? null;
  return { auth, orgId: auth.orgId, orgSlug: org!.slug, competition, division, online, holders, waiting, withdrawHolder, statusOf, sizeNow };
}
export type SizeRig = Awaited<ReturnType<typeof sizeRig>>;

/** One entrant added through the real door: an online division's roster must be a linked person; every other division takes a new one. */
export async function addOne(r: Pick<SizeRig, "auth" | "division" | "online">): Promise<unknown> {
  const name = "Added " + randomUUID().slice(0, 6);
  const entry: CreateEntrant = r.online
    ? { display_name: name, kind: "individual", members: [{ person_id: (await linkedPlayer(r.auth)).personId, is_captain: false, roles: [] }] }
    : { display_name: name, kind: "individual", members: [{ new_person: { full_name: name }, is_captain: false, roles: [] }] };
  return createEntrants(r.auth, r.division.id, [entry]);
}

/** A batch of `n` entrants through the same door. */
export async function addMany(r: Pick<SizeRig, "auth" | "division" | "online">, n: number): Promise<unknown> {
  const entries: CreateEntrant[] = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      display_name: `Batch ${i} ${randomUUID().slice(0, 4)}`,
      kind: "individual",
      members: [{ person_id: (await linkedPlayer(r.auth)).personId, is_captain: false, roles: [] }],
    });
  }
  return createEntrants(r.auth, r.division.id, entries);
}

/** A public sign-up of one linked player into the division: the status the registrant is told ("confirmed" / "waitlisted" / ...). */
export async function signUp(r: Pick<SizeRig, "auth" | "orgSlug" | "competition" | "division" | "online">): Promise<{ status: string; response: unknown }> {
  const person = r.online ? await linkedPlayer(r.auth) : null;
  const res = await submitRegistrationGroup(
    { orgSlug: r.orgSlug, compSlug: r.competition.slug, ...(person ? { sessionUserId: person.userId } : {}) },
    {
      contact: { name: "Alex Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` },
      privacy_consent: true,
      entries: [{ division_id: r.division.id, entrant_kind: "individual", registering_self: true, players: [{ full_name: "Solo Player" }], answers: {} }],
    } as never,
  );
  return { status: res.entries[0]!.status, response: res };
}

export type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "plan" } // the plan's own 402
  | { kind: "refused"; status: number; code: string | undefined; extra: Record<string, unknown> | undefined };
/** What a door did: its value, the plan's 402, or any other refusal with its code and the fields it carries. */
export async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: "ok", value: await run() };
  } catch (err) {
    if (err instanceof PaymentRequiredError) return { kind: "plan" };
    const e = err as { status?: number; code?: string; extra?: Record<string, unknown> };
    if (typeof e.status !== "number") throw err;
    return { kind: "refused", status: e.status, code: e.code, extra: e.extra };
  }
}

/** Hold the division's advisory lock on another connection, start `door`, change the world while it is queued, release, and answer
 *  what the door did: the proof that a door reads (the size too) only AFTER taking the `division:` lock. */
export async function holdingDivisionLock<T>(
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
