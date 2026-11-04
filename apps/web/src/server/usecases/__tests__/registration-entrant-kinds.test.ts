// FU1 (match-day follow-ups): registration only offers and accepts the entrant kinds its DIVISION allows.
//
// A division's allowed kinds are the engine's effective entrant model (the sport module's declaration, narrowed by the
// division's `config.entrants` override). Registration keeps its own `registration_settings.entrant_kind`; before this
// change nothing compared the two, so a teams-only division could take an individual entrant through registration.
// Every door is driven here against divisions of each shape: settings save (PUT), the public panel, submit, and every
// door that materialises an entry into an entrant (organiser confirm / mark paid / waive / approve / promote, and the
// card-payment webhook), plus a division narrowed AFTER registration opened. Expected kinds come from the engine's own
// `effectiveEntrantModel`, never a table typed here. Real Postgres; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createDivision, patchDivision } from "../divisions";
import {
  confirmRegistration,
  confirmRegistrationWaived,
  getRegistrationSettings,
  handleRegistrationCheckoutCompleted,
  markRegistrationPaidOffline,
  publicRegistrationInfo,
  putRegistrationSettings,
  withdrawRegistrationOrganiser,
} from "../registrations";
import { approveRegistration, promoteFromWaitlist } from "../registration-approval";
import { submitRegistrationGroup, type SubmitGroupEntryInput } from "../registration-submit";
import { asOwner, fakeSession, loadWithGroup, rig, seedOrg, seedRegistration, SETTINGS_BASE } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const REFUSAL = { status: 422, code: "ENTRANT_KIND_NOT_ALLOWED" };

/** The engine's "every kind" - a division with no model and no override takes all of them. */
const ALL_KINDS: readonly EntrantKind[] = effectiveEntrantModel(null).kinds;

/** The four division shapes the brief names. Their allowed kinds are what the ENGINE makes of each override. */
const SHAPES: readonly { name: string; entrants: { kinds: EntrantKind[] } | null }[] = [
  { name: "teams-only", entrants: { kinds: ["team"] } },
  { name: "pairs-only", entrants: { kinds: ["pair"] } },
  { name: "individual-only", entrants: { kinds: ["individual"] } },
  { name: "all-kinds", entrants: null },
];
const allowedOf = (entrants: { kinds: EntrantKind[] } | null): readonly EntrantKind[] =>
  effectiveEntrantModel(null, entrants ? { entrants } : {}).kinds;

const GENERIC_CONFIG = { points: { w: 3, d: 1, l: 0 }, progressScore: false };

afterAll(async () => {
  if (HAS_DB) await sql.end();
});

async function generic(owner: AuthCtx, competitionId: string, entrants: { kinds: EntrantKind[] } | null) {
  return createDivision(owner, competitionId, {
    name: "Div " + randomUUID().slice(0, 6),
    sport_key: "generic",
    variant_key: "score",
    config: { ...GENERIC_CONFIG, ...(entrants ? { entrants } : {}) },
  } as never);
}

/** A stored settings row written straight to the table - the state an EXISTING row (or a later narrowing) leaves behind,
 *  which the save door can no longer produce. */
async function storeSettings(
  divisionId: string,
  kind: EntrantKind,
  over: Partial<{ fee_cents: number; payment_method: "offline" | "stripe"; approval: "auto" | "manual"; capacity: number | null }> = {},
) {
  await sql`
    insert into registration_settings (division_id, enabled, entrant_kind, fee_cents, payment_method, approval, capacity)
    values (${divisionId}, true, ${kind}, ${over.fee_cents ?? 0}, ${over.payment_method ?? "offline"},
            ${over.approval ?? "auto"}, ${over.capacity ?? null})
    on conflict (division_id) do update set
      enabled = true, entrant_kind = excluded.entrant_kind, fee_cents = excluded.fee_cents,
      payment_method = excluded.payment_method, approval = excluded.approval, capacity = excluded.capacity`;
}

/** Narrow (or widen) a division's kinds through the REAL door: the Entrants tab's PATCH of `config.entrants`. */
async function setKinds(owner: AuthCtx, divisionId: string, kinds: EntrantKind[]) {
  const [d] = await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${divisionId}`;
  await patchDivision(owner, divisionId, { config: { ...d!.config, entrants: { kinds, defaultKind: kinds[0] } } } as never);
}

/** Narrow a division's kinds straight in the table. Since fix round 1 (I1) the real door refuses to take a kind out from
 *  under live registrations, so a door that must MEET such a division - one narrowed before the guard, the m5 legacy
 *  rows - reaches that state here, as the seat-gate fixtures do. */
async function narrowBySql(divisionId: string, kinds: EntrantKind[]) {
  const entrants = { kinds, defaultKind: kinds[0] };
  await sql`update divisions set config = config || ${sql.json({ entrants } as never)} where id = ${divisionId}`;
}

const configOf = async (divisionId: string) =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from divisions where id = ${divisionId}`)[0]!.config;

/** The narrowing refusal (I1), with the facts the Entrants tab says it from. */
const KIND_IN_USE = (kind: EntrantKind, count: number) => ({
  status: 422,
  code: "REGISTRATION_KIND_IN_USE",
  extra: { kind, count },
});

const entrantsOf = (divisionId: string) =>
  sql<{ kind: string }[]>`select kind from entrants where division_id = ${divisionId}`;

function entryFor(divisionId: string, kind: EntrantKind): SubmitGroupEntryInput {
  if (kind === "individual") return { division_id: divisionId, entrant_kind: kind, players: [{ full_name: "Ines Solo" }], answers: {} };
  if (kind === "pair") {
    return { division_id: divisionId, entrant_kind: kind, players: [{ full_name: "Pia One" }, { full_name: "Pia Two" }], answers: {} };
  }
  return { division_id: divisionId, entrant_kind: kind, team_name: "Tide FC", players: [{ full_name: "Tom Cap" }], answers: {} };
}

// One sport for the refusal sweeps (save, public, submit, the doors, the webhook, the narrowing guard): `generic` with a
// `config.entrants` override, because the override is the only narrowing door there is (PatchDivision cannot change
// sport_key or module_version) and a module's own declaration reaches every door through the same
// `effectiveEntrantModel` call; the module path itself is swept over the registry by the default test and, for the
// narrowing guard, by the multi-kind sweep below (review m7).
describe.skipIf(!HAS_DB)("FU1 registration takes only the division's allowed entrant kinds", () => {
  it("settings save: every kind on every division shape is taken iff the division allows it, refused 422 ENTRANT_KIND_NOT_ALLOWED otherwise", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    let accepted = 0;
    let refused = 0;
    for (const shape of SHAPES) {
      const allowed = allowedOf(shape.entrants);
      const division = await generic(owner, competition.id, shape.entrants);
      for (const kind of ALL_KINDS) {
        const before = await sql<{ entrant_kind: string }[]>`
          select entrant_kind from registration_settings where division_id = ${division.id}`;
        if (allowed.includes(kind)) {
          const saved = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, entrant_kind: kind });
          expect(saved.entrant_kind, `${shape.name} saves ${kind}`).toBe(kind);
          accepted++;
        } else {
          await expect(
            putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, entrant_kind: kind }),
            `${shape.name} refuses ${kind}`,
          ).rejects.toMatchObject(REFUSAL);
          // Nothing written: the row is exactly as it was before the refused save.
          const after = await sql<{ entrant_kind: string }[]>`
            select entrant_kind from registration_settings where division_id = ${division.id}`;
          expect(after).toEqual(before);
          refused++;
        }
      }
    }
    expect(accepted + refused).toBe(SHAPES.length * ALL_KINDS.length);
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("settings save, a SECOND call: a refused kind stays refused, and is taken once the division allows it", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const division = await generic(owner, competition.id, { kinds: ["individual"] });
    for (let call = 0; call < 2; call++) {
      await expect(putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, entrant_kind: "team" })).rejects.toMatchObject(REFUSAL);
    }
    await setKinds(owner, division.id, ["team", "individual"]);
    const saved = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE, entrant_kind: "team" });
    expect(saved.entrant_kind).toBe("team");
  });

  it("default: with no stored row, and on a save that omits the kind, registration uses the division's own default kind - swept over the sport registry", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    let checked = 0;
    let notIndividual = 0;
    for (const mod of builtinModules) {
      const expected = effectiveEntrantModel(mod.entrantModel ?? null).defaultKind;
      // The sports catalog row the division points at: present after sync:sports, inserted here when a DB lacks it.
      await sql`
        insert into sports (key, name, module_version, position_catalog)
        values (${mod.key}, ${mod.key}, ${mod.version}, ${sql.json((mod.positions ?? { groups: [] }) as never)})
        on conflict (key) do nothing`;
      const [division] = await sql<{ id: string }[]>`
        insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
        values (${competition.id}, ${orgId}, ${mod.key}, ${"d-" + mod.key + "-" + randomUUID().slice(0, 6)},
                ${mod.key}, ${Object.keys(mod.variants)[0] ?? "default"}, '{}'::jsonb, ${mod.version})
        returning id`;
      const fetched = await getRegistrationSettings(owner, division!.id);
      expect(fetched.entrant_kind, `${mod.key} default`).toBe(expected);
      // A save that names no kind lands on the same default (chess: individual, the only shape it takes).
      const withoutKind: Partial<typeof SETTINGS_BASE> = { ...SETTINGS_BASE };
      delete withoutKind.entrant_kind;
      const saved = await putRegistrationSettings(owner, division!.id, withoutKind as never);
      expect(saved.entrant_kind, `${mod.key} save default`).toBe(expected);
      checked++;
      if (expected !== "individual") notIndividual++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(checked).toBeGreaterThan(0);
    // The case where the right answer differs from the old constant ('individual') - without it this test cannot see the defect.
    expect(notIndividual).toBeGreaterThan(0);

    // A division its organiser narrowed to ONE kind (config.entrants) registers that kind - pairs-only has no sport that
    // declares it, so only the override reaches it.
    // Its own org: the registry rows above already fill this competition past the plan's division cap.
    const second = await seedOrg();
    const owner2 = asOwner(second.orgId, second.ownerId);
    const { competition: comp2 } = await rig(owner2);
    let narrowed = 0;
    for (const shape of SHAPES.filter((sh) => allowedOf(sh.entrants).length === 1)) {
      const [only] = allowedOf(shape.entrants);
      const division = await generic(owner2, comp2.id, shape.entrants);
      expect((await getRegistrationSettings(owner2, division.id)).entrant_kind, shape.name).toBe(only);
      const withoutKind: Partial<typeof SETTINGS_BASE> = { ...SETTINGS_BASE };
      delete withoutKind.entrant_kind;
      expect((await putRegistrationSettings(owner2, division.id, withoutKind as never)).entrant_kind, shape.name).toBe(only);
      narrowed++;
    }
    expect(narrowed).toBe(3);
  });

  it("public panel: a stored kind the division refuses does not open (closed_reason entry_kind_unavailable); an allowed one opens", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    let open = 0;
    let closed = 0;
    for (const shape of SHAPES) {
      const allowed = allowedOf(shape.entrants);
      const division = await generic(owner, competition.id, shape.entrants);
      for (const kind of ALL_KINDS) {
        await storeSettings(division.id, kind);
        const info = await publicRegistrationInfo(orgSlug, competition.slug);
        const row = info.divisions.find((d) => d.division_id === division.id);
        expect(row, `${shape.name}/${kind} listed`).toBeDefined();
        if (allowed.includes(kind)) {
          expect(row!.open, `${shape.name}/${kind}`).toBe(true);
          expect(row!.closed_reason).toBeNull();
          open++;
        } else {
          expect(row!.open, `${shape.name}/${kind}`).toBe(false);
          expect(row!.closed_reason).toBe("entry_kind_unavailable");
          closed++;
        }
      }
    }
    expect(open + closed).toBe(SHAPES.length * ALL_KINDS.length);
    expect(open).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(0);
  });

  // Both approval modes: "auto" seats the entry inside the submit (so materialise would refuse too), while "manual" leaves
  // it pending with NO materialise - there only submit's own check stands between a refused kind and a stored entry.
  it("submit: an entry of a kind the division refuses is 422 ENTRANT_KIND_NOT_ALLOWED and writes nothing; an allowed kind is taken (seated on auto, pending on manual)", async () => {
    let seated = 0;
    let pending = 0;
    let refused = 0;
    for (const approval of ["auto", "manual"] as const) for (const shape of SHAPES) {
      // An org per mode and shape: twelve divisions in one competition would trip the plan's per-competition cap.
      const { orgId, orgSlug, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition } = await rig(owner);
      const allowed = allowedOf(shape.entrants);
      for (const kind of ALL_KINDS) {
        // A fresh division per kind: a seated entrant would otherwise block nothing, but keeps each count readable.
        const division = await generic(owner, competition.id, shape.entrants);
        await storeSettings(division.id, kind, { approval });
        const submit = () =>
          submitRegistrationGroup(
            { orgSlug, compSlug: competition.slug },
            {
              contact: { name: "Rae Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` },
              privacy_consent: true,
              entries: [entryFor(division.id, kind)],
            },
          );
        const label = `${approval}/${shape.name}/${kind}`;
        if (allowed.includes(kind)) {
          const res = await submit();
          if (approval === "auto") {
            expect(res.entries[0]!.status, label).toBe("confirmed");
            expect((await entrantsOf(division.id)).map((e) => e.kind), label).toEqual([kind]);
            seated++;
          } else {
            expect(res.entries[0]!.status, label).toBe("pending");
            expect(await entrantsOf(division.id), label).toEqual([]);
            pending++;
          }
        } else {
          await expect(submit(), label).rejects.toMatchObject(REFUSAL);
          const [{ n }] = await sql<{ n: number }[]>`
            select count(*)::int as n from registrations where division_id = ${division.id}`;
          expect(n, label).toBe(0);
          expect(await entrantsOf(division.id), label).toEqual([]);
          refused++;
        }
      }
    }
    expect(seated + pending + refused).toBe(2 * SHAPES.length * ALL_KINDS.length);
    // Each mode takes exactly the allowed pairs and refuses the rest: summed over the four shapes, 1+1+1+3 allowed.
    const allowedPairs = SHAPES.reduce((n, sh) => n + allowedOf(sh.entrants).length, 0);
    expect({ seated, pending, refused }).toEqual({
      seated: allowedPairs,
      pending: allowedPairs,
      refused: 2 * (SHAPES.length * ALL_KINDS.length - allowedPairs),
    });
  });

  // A division narrowed AFTER registration opened: the entry was submitted as a team, then the organiser took team out of
  // Entrant kinds. Every door that materialises it refuses with the named code and inserts nothing; widening the kinds
  // back lets the SAME door seat it (the positive pair - the refusal is the kind and nothing else).
  const DOORS: {
    name: string;
    settings: Partial<{ fee_cents: number; payment_method: "offline" | "stripe"; approval: "auto" | "manual" }>;
    status: "pending" | "waitlisted";
    run: (owner: AuthCtx, divisionId: string, regId: string) => Promise<unknown>;
  }[] = [
    { name: "confirm", settings: {}, status: "pending", run: (o, _d, r) => confirmRegistration(o, r) },
    {
      name: "mark paid offline",
      settings: { fee_cents: 800, payment_method: "offline" },
      status: "pending",
      run: (o, _d, r) => markRegistrationPaidOffline(o, r),
    },
    { name: "confirm waived", settings: { fee_cents: 800 }, status: "pending", run: (o, _d, r) => confirmRegistrationWaived(o, r) },
    { name: "approve", settings: { approval: "manual" }, status: "pending", run: (o, _d, r) => approveRegistration(o, r) },
    {
      name: "promote (explicit)",
      settings: {},
      status: "waitlisted",
      run: (o, d, r) => promoteFromWaitlist(o, d, { registrationId: r }),
    },
  ];

  it("materialise, organiser doors: a division narrowed after registration opened refuses to seat the entry and inserts nothing", async () => {
    let checked = 0;
    for (const door of DOORS) {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition } = await rig(owner);
      const division = await generic(owner, competition.id, null);
      await storeSettings(division.id, "team", door.settings);
      const { registration } = await seedRegistration(
        competition.id,
        division.id,
        { fee_cents: door.settings.fee_cents ?? 0, currency: "gbp", payment_method: door.settings.payment_method ?? "offline" },
        { status: door.status, displayName: "Tide FC", players: [{ name: "Tom Cap" }] },
      );
      // By SQL: the real door refuses this narrowing while the live entry holds team (I1, tested below).
      await narrowBySql(division.id, ["individual"]);

      // The refusal names the kind (fix round 1 m2): the hub says it in the organiser's language from that, not the English.
      await expect(door.run(owner, division.id, registration.id), door.name).rejects.toMatchObject({
        ...REFUSAL,
        extra: { kind: "team" },
      });
      expect(await entrantsOf(division.id), door.name).toEqual([]);
      const after = await loadWithGroup(registration.id);
      expect(after.entrant_id, door.name).toBeNull();
      expect(after.status, door.name).toBe(door.status);

      await setKinds(owner, division.id, ["team", "individual"]);
      await door.run(owner, division.id, registration.id);
      expect((await entrantsOf(division.id)).map((e) => e.kind), door.name).toEqual(["team"]);
      checked++;
    }
    expect(checked).toBe(DOORS.length);
  });

  it("materialise, card-payment webhook: a paid entry refused at materialise rolls back to pending (no charge recorded, no entrant), and confirms once the division takes its kind", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    await sql`update organizations set stripe_charges_enabled = true, stripe_account_id = ${"acct_" + randomUUID().slice(0, 8)}
              where id = ${orgId}`;
    const { competition } = await rig(owner);
    const division = await generic(owner, competition.id, null);
    await storeSettings(division.id, "team", { fee_cents: 500, payment_method: "stripe" });
    const { registration } = await seedRegistration(
      competition.id,
      division.id,
      { fee_cents: 500, currency: "gbp", payment_method: "stripe" },
      { displayName: "Tide FC", players: [{ name: "Tom Cap" }] },
    );
    // By SQL: the real door refuses this narrowing while the pending entry holds team (I1, tested below).
    await narrowBySql(division.id, ["individual"]);

    // The webhook handler throws, so billing_events.processed_at stays null and Stripe redelivers (report: FU1).
    for (let delivery = 0; delivery < 2; delivery++) {
      await expect(handleRegistrationCheckoutCompleted(fakeSession(registration.id, 500))).rejects.toMatchObject(REFUSAL);
      const after = await loadWithGroup(registration.id);
      expect(after.status).toBe("pending");
      expect(after.charged_at).toBeNull();
      expect(after.entrant_id).toBeNull();
      expect(await entrantsOf(division.id)).toEqual([]);
    }

    await setKinds(owner, division.id, ["team"]);
    await handleRegistrationCheckoutCompleted(fakeSession(registration.id, 500));
    const confirmed = await loadWithGroup(registration.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.charged_at).not.toBeNull();
    expect((await entrantsOf(division.id)).map((e) => e.kind)).toEqual(["team"]);
  });

  it("after a withdrawal: the freed spot is not handed to a waitlisted entry the division can no longer seat, and the withdrawal still succeeds", async () => {
    let checked = 0;
    for (const narrowed of [true, false]) {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition } = await rig(owner);
      const division = await generic(owner, competition.id, null);
      // Free + auto approval: a promotion here SEATS the next in line at once.
      await storeSettings(division.id, "team", { capacity: 1 });
      const money = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
      const holder = await seedRegistration(competition.id, division.id, money, { displayName: "Holder FC", players: [{ name: "Hal" }] });
      const queued = await seedRegistration(competition.id, division.id, money, {
        status: "waitlisted",
        displayName: "Queue FC",
        players: [{ name: "Quin" }],
      });
      // By SQL: the real door refuses this narrowing while the queued entry holds team (I1, tested below).
      if (narrowed) await narrowBySql(division.id, ["individual"]);

      const withdrawn = await withdrawRegistrationOrganiser(owner, holder.registration.id);
      expect(withdrawn.status).toBe("withdrawn");
      const next = await loadWithGroup(queued.registration.id);
      if (narrowed) {
        expect(next.status).toBe("waitlisted");
        expect(await entrantsOf(division.id)).toEqual([]);
      } else {
        // The positive pair: with team still allowed the same withdrawal promotes and seats the queued team.
        expect(next.status).toBe("confirmed");
        expect((await entrantsOf(division.id)).map((e) => e.kind)).toEqual(["team"]);
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  // ---- Fix round 1 -------------------------------------------------------------------------------------------------

  // I1 (owner 2026-11-04): a division save may not take out the kind its registration takes while LIVE registrations of it
  // exist. Live = pending, paid or waitlisted, or confirmed with no entrant yet (a solo sign-up) - the owner's list, not
  // the guard's. Terminal statuses, and a confirmed entry already seated, hold nothing for this guard (a seated entry's
  // ENTRANT is the entrants guard's business, so its entrant here is withdrawn to keep that guard out of the way).
  const HOLDERS: { name: string; seed: { status: "pending" | "paid" | "waitlisted" | "confirmed" | "withdrawn" | "rejected" | "expired"; seated?: true }[]; live: number }[] = [
    { name: "pending", seed: [{ status: "pending" }], live: 1 },
    { name: "paid", seed: [{ status: "paid" }], live: 1 },
    { name: "waitlisted", seed: [{ status: "waitlisted" }], live: 1 },
    { name: "confirmed solo sign-up (no entrant yet)", seed: [{ status: "confirmed" }], live: 1 },
    { name: "two live (pending + waitlisted)", seed: [{ status: "pending" }, { status: "waitlisted" }], live: 2 },
    { name: "withdrawn", seed: [{ status: "withdrawn" }], live: 0 },
    { name: "rejected", seed: [{ status: "rejected" }], live: 0 },
    { name: "expired", seed: [{ status: "expired" }], live: 0 },
    { name: "confirmed and seated (its entrant since withdrawn)", seed: [{ status: "confirmed", seated: true }], live: 0 },
  ];

  it("narrowing (I1): taking out the registration's kind while live registrations hold it is 422 REGISTRATION_KIND_IN_USE with their count and writes nothing - twice; terminal and seated entries do not hold it; once the live ones are withdrawn the same save lands", async () => {
    let refused = 0;
    let landed = 0;
    for (const holder of HOLDERS) {
      const { orgId, ownerId } = await seedOrg();
      const owner = asOwner(orgId, ownerId);
      const { competition } = await rig(owner);
      const division = await generic(owner, competition.id, null);
      await storeSettings(division.id, "team");
      const money = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
      const regIds: string[] = [];
      for (const [i, seed] of holder.seed.entries()) {
        const { registration } = await seedRegistration(competition.id, division.id, money, {
          status: seed.status,
          displayName: `Tide ${i} FC`,
          players: [{ name: `Tom ${i}` }],
        });
        regIds.push(registration.id);
        if (seed.seated) {
          const [entrant] = await sql<{ id: string }[]>`
            insert into entrants (division_id, kind, display_name, status)
            values (${division.id}, 'team', ${`Tide ${i} FC`}, 'withdrawn') returning id`;
          await sql`update registrations set entrant_id = ${entrant!.id} where id = ${registration.id}`;
        }
      }
      const before = await configOf(division.id);
      if (holder.live > 0) {
        for (let call = 0; call < 2; call++) {
          await expect(setKinds(owner, division.id, ["individual"]), `${holder.name} call ${call}`).rejects.toMatchObject(
            KIND_IN_USE("team", holder.live),
          );
          expect(await configOf(division.id), holder.name).toEqual(before);
        }
        // The organiser does what the refusal says - withdraws them (latest first, so no queued entry is promoted into
        // the freed spot) - and the same save lands.
        for (const id of [...regIds].reverse()) await withdrawRegistrationOrganiser(owner, id);
        refused++;
      }
      await setKinds(owner, division.id, ["individual"]);
      expect((await configOf(division.id)).entrants, holder.name).toEqual({ kinds: ["individual"], defaultKind: "individual" });
      landed++;
    }
    expect(refused).toBe(HOLDERS.filter((h) => h.live > 0).length);
    expect(refused).toBeGreaterThan(0);
    expect(landed).toBe(HOLDERS.length);
    expect(landed - refused).toBeGreaterThan(0);
  });

  it("narrowing (I1): only a kind the save TAKES OUT is asked - widening, a narrowing that keeps the registration's kind, and an unrelated save on a division already holding a mismatched kind all land under live registrations", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const money = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };

    // A legacy mismatch (m5): registration stores team, the division already takes individuals only. Every Entrants and
    // format save re-sends the whole config, so refusing here would lock the organiser out of an unrelated change.
    const legacy = await generic(owner, competition.id, { kinds: ["individual"] });
    await storeSettings(legacy.id, "team");
    await seedRegistration(competition.id, legacy.id, money, { displayName: "Tide FC", players: [{ name: "Tom Cap" }] });
    const cfg = await configOf(legacy.id);
    await patchDivision(owner, legacy.id, { config: { ...cfg, points: { w: 2, d: 1, l: 0 } } } as never);
    expect((await configOf(legacy.id)).points).toEqual({ w: 2, d: 1, l: 0 });
    // Widening to take team back lands; a narrowing that KEEPS team lands; taking team out again is refused.
    await setKinds(owner, legacy.id, ["individual", "team"]);
    await setKinds(owner, legacy.id, ["team"]);
    expect(((await configOf(legacy.id)).entrants as { kinds: string[] }).kinds).toEqual(["team"]);
    await expect(setKinds(owner, legacy.id, ["individual"])).rejects.toMatchObject(KIND_IN_USE("team", 1));
  });

  it("narrowing (I1), swept over every sport that declares more than one kind: an override that takes out the registered kind is refused while a pending entry holds it, and lands once it is withdrawn", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const money = { fee_cents: 0, currency: "gbp", payment_method: "offline" as const };
    let checked = 0;
    for (const mod of builtinModules) {
      const declared = effectiveEntrantModel(mod.entrantModel ?? null).kinds;
      if (mod.entrantModel == null || declared.length < 2) continue;
      const removed = declared[declared.length - 1]!;
      const kept = declared.filter((k) => k !== removed);
      await sql`
        insert into sports (key, name, module_version, position_catalog)
        values (${mod.key}, ${mod.key}, ${mod.version}, ${sql.json((mod.positions ?? { groups: [] }) as never)})
        on conflict (key) do nothing`;
      // Raw insert, as the default sweep does: the plan caps divisions per competition and this sweep needs one per sport.
      const [division] = await sql<{ id: string }[]>`
        insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
        values (${competition.id}, ${orgId}, ${mod.key}, ${"n-" + mod.key + "-" + randomUUID().slice(0, 6)},
                ${mod.key}, ${Object.keys(mod.variants)[0] ?? "default"}, '{}'::jsonb, ${mod.version})
        returning id`;
      await storeSettings(division!.id, removed);
      const { registration } = await seedRegistration(competition.id, division!.id, money, {
        displayName: `${mod.key} entry`,
        players: [{ name: "Ada One" }, { name: "Ben Two" }],
      });
      await expect(setKinds(owner, division!.id, kept), mod.key).rejects.toMatchObject(KIND_IN_USE(removed, 1));
      await withdrawRegistrationOrganiser(owner, registration.id);
      await setKinds(owner, division!.id, kept);
      expect(((await configOf(division!.id)).entrants as { kinds: string[] }).kinds, mod.key).toEqual(kept);
      checked++;
    }
    expect(checked).toBe(builtinModules.filter((m) => m.entrantModel != null && m.entrantModel.kinds.length > 1).length);
    expect(checked).toBeGreaterThan(0);
  });

  // m4: a chess division carrying a legacy `config.entrants` override whose defaultKind is team. Chess takes individuals
  // only (owner ruling 2026-10-26), so its registration default is individual whatever the override says.
  it("chess default (m4): a legacy override that defaults to team still registers individual - GET reports it and a save that names no kind lands on it, never 422", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const chess = builtinModules.find((m) => m.key === "boardgame")!;
    const override = { kinds: ["individual", "team"] as EntrantKind[], defaultKind: "team" as EntrantKind };
    // The precondition that makes this case bite: the engine's own default for the division IS team.
    expect(effectiveEntrantModel(chess.entrantModel ?? null, { entrants: override }).defaultKind).toBe("team");
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values (${chess.key}, ${chess.key}, ${chess.version}, ${sql.json((chess.positions ?? { groups: [] }) as never)})
      on conflict (key) do nothing`;
    const [division] = await sql<{ id: string }[]>`
      insert into divisions (competition_id, org_id, name, slug, sport_key, variant_key, config, module_version)
      values (${competition.id}, ${orgId}, 'Chess legacy', ${"c-" + randomUUID().slice(0, 8)}, ${chess.key},
              ${Object.keys(chess.variants)[0] ?? "default"}, ${sql.json({ entrants: override } as never)}, ${chess.version})
      returning id`;
    expect((await getRegistrationSettings(owner, division!.id)).entrant_kind).toBe("individual");
    const withoutKind: Partial<typeof SETTINGS_BASE> = { ...SETTINGS_BASE };
    delete withoutKind.entrant_kind;
    for (let call = 0; call < 2; call++) {
      const saved = await putRegistrationSettings(owner, division!.id, withoutKind as never);
      expect(saved.entrant_kind, `call ${call}`).toBe("individual");
    }
  });
});
