// RS005 W1a: the widened registrations read model (listRegistrations's new
// RegistrationListRow — division name/slug, entrant_kind, roster_count/cap,
// consent_pending_count, waitlist_position, sort) and the per-player CSV
// exporter that replaces the old division-only, entry-flat one. Real
// Postgres required; skipped without DATABASE_URL — same convention as
// registrations.test.ts, which owns the pre-existing coverage this file
// does not duplicate.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { PaymentRequiredError } from "@/lib/errors";
import {
  listRegistrations,
  exportRegistrationsCsv,
  promoteOldestWaitlisted,
  putRegistrationSettings,
} from "../registrations";
import { createDivision } from "../divisions";
import { seedOrg, asOwner, rig, seedRegistration, SETTINGS_BASE } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

/** seedOrg + asOwner + rig + putRegistrationSettings — the combination every
 *  test below needs at minimum. `overrides` layers onto SETTINGS_BASE the
 *  same way individual tests already hand-write it elsewhere in this suite. */
async function baseRig(overrides: Record<string, unknown> = {}) {
  const { orgId, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    fee_cents: 0,
    ...overrides,
  });
  return { orgId, owner, competition, division, settings };
}

/** A second division under the SAME competition, sport_key repointed at a
 *  freshly-seeded sport whose position_catalog declares NO `lineup` key at
 *  all — the "unlimited roster" case `rosterCapExpr` must resolve to NULL.
 *  Direct SQL, not createDivision's own sport wiring: divisions.sport_key is
 *  a bare FK (V209, no variant-consistency constraint), so seeding the sports
 *  row first and repointing after creation is safe and matches this suite's
 *  established seed-then-mutate pattern (see seedRegistration). */
async function noLineupDivision(owner: ReturnType<typeof asOwner>, competitionId: string) {
  const division = await createDivision(owner, competitionId, {
    name: "No Lineup " + Math.random().toString(36).slice(2, 8),
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
  });
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('rs005_no_lineup', 'RS005 No Lineup', '1.0.0', ${sql.json({ groups: [] })})
    on conflict (key) do nothing`;
  await sql`update divisions set sport_key = 'rs005_no_lineup' where id = ${division.id}`;
  return division;
}

describe.skipIf(!HAS_DB)("RS005 W1a: listRegistrations widened read model", () => {
  it("waitlist_position matches promoteOldestWaitlisted's own pick, including the id tiebreak on a tied created_at", async () => {
    const { owner, competition, division, settings } = await baseRig();
    const a = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted",
      displayName: "A",
    });
    const b = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted",
      displayName: "B",
    });
    const c = await seedRegistration(competition.id, division.id, settings, {
      status: "waitlisted",
      displayName: "C",
    });
    // A and B tie EXACTLY on created_at; C is strictly later. Forces the id
    // tiebreak between A/B — the exact case a `created_at`-only comparison
    // (no tuple/id tiebreak) gets wrong.
    const tie = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-01-02T00:00:00Z");
    await sql`update registrations set created_at = ${tie} where id = ${a.registration.id}`;
    await sql`update registrations set created_at = ${tie} where id = ${b.registration.id}`;
    await sql`update registrations set created_at = ${later} where id = ${c.registration.id}`;

    const before = await listRegistrations(owner, division.id, "waitlisted");
    const first = before.find((r) => r.waitlist_position === 1);
    const second = before.find((r) => r.waitlist_position === 2);
    const third = before.find((r) => r.waitlist_position === 3);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third?.id).toBe(c.registration.id); // strictly later: always last
    expect([a.registration.id, b.registration.id]).toContain(first!.id);
    expect([a.registration.id, b.registration.id]).toContain(second!.id);
    expect(first!.id).not.toBe(second!.id);

    // The REAL function, not a re-derivation of its ordering: whichever of
    // A/B it actually promotes must be exactly the row this read model
    // ranked position 1 — read BEFORE this mutates the winner away from
    // 'waitlisted'.
    const promoted = await sql.begin((tx) => promoteOldestWaitlisted(tx, division.id, settings));
    expect(promoted).toBeTruthy();
    expect(promoted!.id).toBe(first!.id);
  });

  it("waitlist_position is null off the waitlist, and ranks independently per division", async () => {
    const { owner, competition, division: divA, settings: settingsA } = await baseRig();
    const divB = await createDivision(owner, competition.id, {
      name: "Division B " + Math.random().toString(36).slice(2, 8),
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    const settingsB = await putRegistrationSettings(owner, divB.id, { ...SETTINGS_BASE, fee_cents: 0 });

    const pending = await seedRegistration(competition.id, divA.id, settingsA, { status: "pending" });
    const waitA = await seedRegistration(competition.id, divA.id, settingsA, { status: "waitlisted" });
    const waitB = await seedRegistration(competition.id, divB.id, settingsB, { status: "waitlisted" });

    const rowsA = await listRegistrations(owner, divA.id, null);
    const rowsB = await listRegistrations(owner, divB.id, null);

    expect(rowsA.find((r) => r.id === pending.registration.id)?.waitlist_position).toBeNull();
    expect(rowsA.find((r) => r.id === waitA.registration.id)?.waitlist_position).toBe(1);
    expect(rowsB.find((r) => r.id === waitB.registration.id)?.waitlist_position).toBe(1);
  });

  it("roster_cap reads sports.position_catalog.lineup.size+benchMax; null when the sport declares no lineup", async () => {
    const { owner, competition, division: divGeneric, settings: settingsGeneric } = await baseRig();
    const divNoLineup = await noLineupDivision(owner, competition.id);
    const settingsNoLineup = await putRegistrationSettings(owner, divNoLineup.id, { ...SETTINGS_BASE, fee_cents: 0 });

    // generic's seeded lineup is { size: 1, benchMax: 0 } -> cap 1 (same
    // fixture every other suite relies on — see _registration-fixtures.ts).
    const capped = await seedRegistration(competition.id, divGeneric.id, settingsGeneric);
    const uncapped = await seedRegistration(competition.id, divNoLineup.id, settingsNoLineup);

    const rowsGeneric = await listRegistrations(owner, divGeneric.id, null);
    const rowsNoLineup = await listRegistrations(owner, divNoLineup.id, null);
    expect(rowsGeneric.find((r) => r.id === capped.registration.id)?.roster_cap).toBe(1);
    expect(rowsNoLineup.find((r) => r.id === uncapped.registration.id)?.roster_cap).toBeNull();
  });

  it("roster_count and consent_pending_count are per entry, correct with mixed consent states", async () => {
    const { owner, competition, division, settings } = await baseRig({ entrant_kind: "team" });
    const reg = await seedRegistration(competition.id, division.id, settings, {
      players: [{ name: "P1" }, { name: "P2" }, { name: "P3" }],
    });
    const players = await sql<{ id: string }[]>`
      select id from registration_players where registration_id = ${reg.registration.id} order by created_at`;
    expect(players).toHaveLength(3);
    // P1 -> granted; P2/P3 stay at the DB default 'pending'.
    await sql`update registration_players set consent_status = 'granted' where id = ${players[0]!.id}`;

    const rows = await listRegistrations(owner, division.id, null);
    const row = rows.find((r) => r.id === reg.registration.id)!;
    expect(row.roster_count).toBe(3);
    expect(row.consent_pending_count).toBe(2);
  });

  it("filters.sort: default stays oldest-first (unchanged order); 'newest' reverses it", async () => {
    const { owner, competition, division, settings } = await baseRig();
    const first = await seedRegistration(competition.id, division.id, settings, { displayName: "First" });
    const second = await seedRegistration(competition.id, division.id, settings, { displayName: "Second" });
    const third = await seedRegistration(competition.id, division.id, settings, { displayName: "Third" });
    await sql`update registrations set created_at = '2026-01-01T00:00:00Z' where id = ${first.registration.id}`;
    await sql`update registrations set created_at = '2026-01-02T00:00:00Z' where id = ${second.registration.id}`;
    await sql`update registrations set created_at = '2026-01-03T00:00:00Z' where id = ${third.registration.id}`;

    const oldestFirst = await listRegistrations(owner, division.id, null);
    expect(oldestFirst.map((r) => r.id)).toEqual([
      first.registration.id,
      second.registration.id,
      third.registration.id,
    ]);

    const newestFirst = await listRegistrations(owner, division.id, null, { sort: "newest" });
    expect(newestFirst.map((r) => r.id)).toEqual([
      third.registration.id,
      second.registration.id,
      first.registration.id,
    ]);
  });

  it("never returns access_token_hash on the list surface", async () => {
    const { owner, competition, division, settings } = await baseRig();
    await seedRegistration(competition.id, division.id, settings);
    const rows = await listRegistrations(owner, division.id, null);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, "access_token_hash")).toBe(false);
    }
  });
});

describe.skipIf(!HAS_DB)("RS005 W1a: exportRegistrationsCsv (per-player)", () => {
  it("emits one row per player; a zero-player entry emits one row with blank player columns", async () => {
    const { owner, competition, division, settings } = await baseRig({ entrant_kind: "team" });
    const withPlayers = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Team Alpha",
      players: [{ name: "Alice" }, { name: "Bob" }],
    });
    const noPlayers = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Team Beta",
    });

    const csv = await exportRegistrationsCsv(owner, { divisionId: division.id });
    const lines = csv.trimEnd().split("\n");
    const header = lines[0]!.split(",");
    const idIdx = header.indexOf("registration_id");
    const nameIdx = header.indexOf("player_name");
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeGreaterThanOrEqual(0);

    const alphaLines = lines.slice(1).filter((l) => l.split(",")[idIdx] === withPlayers.registration.id);
    expect(alphaLines).toHaveLength(2);
    expect(alphaLines.map((l) => l.split(",")[nameIdx]).sort()).toEqual(["Alice", "Bob"]);

    const betaLines = lines.slice(1).filter((l) => l.split(",")[idIdx] === noPlayers.registration.id);
    expect(betaLines).toHaveLength(1);
    expect(betaLines[0]!.split(",")[nameIdx]).toBe("");
  });

  it("escapes a value containing both a comma and a double quote byte-exact", async () => {
    const { owner, competition, division, settings } = await baseRig();
    const reg = await seedRegistration(competition.id, division.id, settings, {
      displayName: 'Jane "JJ", Doe',
    });

    const csv = await exportRegistrationsCsv(owner, { divisionId: division.id });
    const dataLine = csv.split("\n").find((l) => l.startsWith(reg.registration.id));
    expect(dataLine).toBeDefined();
    // display_name and contact_name (seedRegistration sets both to the same
    // value) sit back-to-back in the column order — the doubled interior
    // quotes AND the still-intact field-separating comma between the two
    // occurrences prove the escaper closed each quoted field correctly
    // rather than leaking into its neighbour.
    expect(dataLine).toContain('"Jane ""JJ"", Doe","Jane ""JJ"", Doe"');
    // The raw, unescaped source string never appears unescaped anywhere.
    expect(dataLine).not.toContain(',Jane "JJ", Doe,');
  });

  it("competition-wide export unions every in-scope division's form_fields keys, stable-sorted", async () => {
    const { owner, competition, division: divA } = await baseRig({
      form_fields: [{ key: "shirt_size", label: "Shirt size", kind: "text", required: false }],
    });
    const divB = await createDivision(owner, competition.id, {
      name: "Division B " + Math.random().toString(36).slice(2, 8),
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    const settingsB = await putRegistrationSettings(owner, divB.id, {
      ...SETTINGS_BASE,
      fee_cents: 0,
      form_fields: [{ key: "dietary", label: "Dietary needs", kind: "text", required: false }],
    });
    const settingsA = await putRegistrationSettings(owner, divA.id, {
      ...SETTINGS_BASE,
      fee_cents: 0,
      form_fields: [{ key: "shirt_size", label: "Shirt size", kind: "text", required: false }],
    });
    await seedRegistration(competition.id, divA.id, settingsA, { answers: { shirt_size: "M" } });
    await seedRegistration(competition.id, divB.id, settingsB, { answers: { dietary: "Vegetarian" } });

    const csv = await exportRegistrationsCsv(owner, { competitionId: competition.id });
    const header = csv.split("\n")[0]!.split(",");
    expect(header).toContain("shirt_size");
    expect(header).toContain("dietary");
    // stable (alphabetically) sorted, not division/insertion order.
    expect(header.indexOf("dietary")).toBeLessThan(header.indexOf("shirt_size"));
  });

  it("still refuses without the exports entitlement (explicit deny — plain `exports` reaches every plan by V285, so a denial can only be an org override, never a plan tier)", async () => {
    const { owner, orgId, division } = await baseRig();
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, 'exports', false)
      on conflict (org_id, feature_key) do update set bool_value = false`;
    await invalidateOrgEntitlements(orgId);
    await expect(exportRegistrationsCsv(owner, { divisionId: division.id })).rejects.toThrow(PaymentRequiredError);
  });
});

describe.skipIf(!HAS_DB)("RS005 W1b review BLOCKER: division_id must belong to the named competition", () => {
  // The guard exists for the API-key competition pin, which is the boundary
  // that actually breaks: `apiKeyAuth` resolves the pin from the URL PATH
  // resource only (api-v1/auth.ts, `resolvePinCompetition`) and never reads
  // query parameters. A key pinned to competition A therefore satisfied its
  // pin on A's path and then read B's rows, because `listRegistrations`
  // derived the competition from `division_id` and discarded the caller's
  // `competition_id` entirely. Same org both times — `withTenant` was never
  // the thing being bypassed.
  it("404s a division from another competition instead of returning its rows", async () => {
    const { owner, competition: compA } = await baseRig();
    const { competition: compB, division: divB } = await rig(owner);
    const settingsB = await putRegistrationSettings(owner, divB.id, { ...SETTINGS_BASE, fee_cents: 0 });
    const { registration: leaked } = await seedRegistration(compB.id, divB.id, settingsB, {
      displayName: "Should Not Appear",
      contactEmail: "b@example.test",
    });

    // Sanity: the row IS readable through its OWN competition, so a 404 below
    // is the guard firing and not an empty fixture.
    const ownScope = await listRegistrations(owner, divB.id, null, { competition_id: compB.id });
    expect(ownScope.map((r) => r.id)).toContain(leaked.id);

    await expect(
      listRegistrations(owner, divB.id, null, { competition_id: compA.id }),
    ).rejects.toThrow(/division not found/);
  });

  it("404s the CSV export the same way — the bulk path is the one that moves bytes", async () => {
    const { owner, competition: compA } = await baseRig();
    const { competition: compB, division: divB } = await rig(owner);
    const settingsB = await putRegistrationSettings(owner, divB.id, { ...SETTINGS_BASE, fee_cents: 0 });
    await seedRegistration(compB.id, divB.id, settingsB, {
      displayName: "Should Not Appear",
      contactEmail: "b@example.test",
    });

    await expect(
      exportRegistrationsCsv(owner, { competitionId: compA.id, divisionId: divB.id }),
    ).rejects.toThrow(/division not found/);
  });

  it("still allows the two when they agree, and when only one is given", async () => {
    const { owner, competition, division, settings } = await baseRig();
    const { registration: own } = await seedRegistration(competition.id, division.id, settings, {
      displayName: "In Scope",
      contactEmail: "a@example.test",
    });

    const agreeing = await listRegistrations(owner, division.id, null, { competition_id: competition.id });
    expect(agreeing.map((r) => r.id)).toContain(own.id);

    // The live /api/v1/divisions/[id]/registrations route passes no filters at
    // all — the guard must not turn that into a 404.
    const divisionOnly = await listRegistrations(owner, division.id, null, {});
    expect(divisionOnly.map((r) => r.id)).toContain(own.id);
  });
});

describe.skipIf(!HAS_DB)("RS005: archiving a division does not hide its registrants", () => {
  // CHARACTERISATION, and a deliberate one — this pins a behaviour that is
  // correct today and that nothing else would notice losing.
  //
  // `listRegistrations` joins `divisions` with NO `archived_at` guard, unlike
  // the Settings tab's own query (`registration/data.ts`, `where ... and
  // d.archived_at is null`) and unlike the filter-dropdown query beside it.
  // Those two SHOULD exclude archived divisions: one configures them, the
  // other offers them as a filter. This one must not.
  //
  // The cost of getting it wrong is silent and lands on the worst day:
  // archiving a division is exactly what an organiser does when a competition
  // wraps, and the registrants are the people they still have to refund,
  // export for their federation, or answer questions about. Copying that
  // one-line predicate up here — an obvious-looking consistency fix, and the
  // two queries sit ~200 lines apart in sibling files — would vanish every
  // one of them, with no error, no empty-state distinction, and nothing red.
  it("still lists (and exports) entries whose division has been archived", async () => {
    const { owner, competition, division, settings } = await baseRig();
    const { registration } = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Archived Division Entry",
      contactEmail: "archived@example.test",
    });

    const before = await listRegistrations(owner, null, null, { competition_id: competition.id });
    expect(before.map((r) => r.id)).toContain(registration.id);

    await sql`update divisions set archived_at = now() where id = ${division.id}`;

    const after = await listRegistrations(owner, null, null, { competition_id: competition.id });
    expect(
      after.map((r) => r.id),
      "archiving a division must not hide the people who registered for it",
    ).toContain(registration.id);
    // The row still carries its division's identity — an organiser looking at
    // a wrapped competition needs to know WHICH division each person is in.
    expect(after.find((r) => r.id === registration.id)?.division_name).toBe(division.name);

    const csv = await exportRegistrationsCsv(owner, { competitionId: competition.id });
    expect(csv, "the CSV is how a federation report gets produced after wrap-up").toContain(
      "Archived Division Entry",
    );
  });
});

describe.skipIf(!HAS_DB)("RS005 W3 prep: the row carries its DIVISION's approval mode", () => {
  // approve/reject may only be OFFERED on a manual-approval division —
  // `approveRegistration` refuses an auto division with a 422, so rendering
  // the control there hands an organiser a button that cannot work and an
  // error that reads as a bug. The mode lives on the division, not the entry,
  // and `registration_settings` is already LEFT JOINed here, so this costs no
  // extra query and no second source of truth for the UI to drift from.
  it("reports 'manual' for a manual division and 'auto' when a division has no settings row at all", async () => {
    const { owner, competition, division, settings } = await baseRig();
    const { registration: autoReg } = await seedRegistration(competition.id, division.id, settings, {
      displayName: "Auto Division Entry",
    });

    const manualDiv = await createDivision(owner, competition.id, {
      name: "Manual " + Math.random().toString(36).slice(2, 7),
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    });
    const manualSettings = await putRegistrationSettings(owner, manualDiv.id, {
      ...SETTINGS_BASE,
      fee_cents: 0,
      approval: "manual",
    });
    const { registration: manualReg } = await seedRegistration(
      competition.id,
      manualDiv.id,
      manualSettings,
      { displayName: "Manual Division Entry" },
    );

    const rows = await listRegistrations(owner, null, null, { competition_id: competition.id });
    expect(rows.find((r) => r.id === manualReg.id)?.approval).toBe("manual");
    expect(rows.find((r) => r.id === autoReg.id)?.approval).toBe("auto");
  });
});
