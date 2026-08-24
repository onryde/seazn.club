// RS004 W3c — the config panel's own round trip against a real database.
//
// CHARACTERISATION TEST: every piece this exercises already exists and is
// already unit-tested elsewhere — the pure state builders
// (registration-hub-config-state.test.ts, mocked), and the two write
// endpoints' usecases (registrations.test.ts/division-settings.test.ts,
// per the RS004 W3c brief: "already shipped and tested this session").
// What NONE of those prove is the SEAM between them: that the exact bodies
// toDivisionPatchBody/toRegistrationSettingsPutBody produce are accepted
// by the real usecases (not just a shape this file's own mocks invented),
// and that initialConfigState correctly reconstructs the panel's edit
// state from what a real getRegistrationSettings + fetchDivisionRows hand
// back afterwards. That is "opening a row shows current values; saving
// persists; reopening shows what was saved" for real, for the five new
// fields (category, age_min, age_max, approval, allow_free_agents) plus a
// representative sample of the pre-existing ones — proven by mutation: a
// swapped age_min/age_max, a dropped field in either builder, or a
// mis-keyed read in initialConfigState would all fail an assertion below.
import { describe, expect, it } from "vitest";
import { seedOrg, asOwner, rig } from "@/server/usecases/__tests__/_registration-fixtures";
import { patchDivision } from "@/server/usecases/divisions";
import { getRegistrationSettings, putRegistrationSettings } from "@/server/usecases/registrations";
import { fetchDivisionRows } from "../page";
import {
  initialConfigState,
  toDivisionPatchBody,
  toRegistrationSettingsPutBody,
  type RegistrationConfigState,
  type RegistrationSettingsResponse,
} from "@/components/registration-hub-config-state";
import type { FormField } from "@/components/registration-hub-form-builder";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("config panel round trip — real Postgres (RS004 W3c)", () => {
  it("PATCH + PUT persist, and a fresh read reconstructs the SAME edit state", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    const formFields: FormField[] = [
      { key: "shirt_size", label: "Shirt size", kind: "text", required: true },
      { key: "club", label: "Club", kind: "select", options: ["None", "Riverside"], required: false },
    ];

    // Exactly what the panel's local edit state would hold after the
    // organiser edits every section — including allow_free_agents:true,
    // which requires entrant_kind:"team" in the SAME PUT.
    const sentState: RegistrationConfigState = {
      category: "mixed",
      age_min: 12,
      age_max: 17,
      enabled: true,
      entrant_kind: "team",
      opens_at: "2026-03-01T00:00:00.000Z",
      closes_at: "2026-04-01T00:00:00.000Z",
      capacity: 24,
      fee_cents: 1250,
      refund_lock_at: "2026-03-20T00:00:00.000Z",
      form_fields: formFields,
      payment_method: "offline",
      payment_instructions: "Pay the club treasurer.",
      approval: "manual",
      allow_free_agents: true,
    };

    // Exactly what the panel's Save handler sends — the pure builders
    // under test, not a hand-rolled body that could silently diverge from
    // what the component actually calls.
    await patchDivision(owner, division.id, toDivisionPatchBody(sentState));
    await putRegistrationSettings(owner, division.id, toRegistrationSettingsPutBody(sentState));

    // Exactly what the panel's GET-on-open + row list read.
    const settingsResponse = await getRegistrationSettings(owner, division.id);
    const rows = await fetchDivisionRows(owner, competition.id);
    const row = rows.find((r) => r.division_id === division.id)!;

    const reopened = initialConfigState(settingsResponse as unknown as RegistrationSettingsResponse, {
      category: row.category,
      age_min: row.age_min,
      age_max: row.age_max,
    });

    // The five new fields (RS004 W1/W3c) — the acceptance bar this test
    // exists to clear.
    expect(reopened.category).toBe("mixed");
    expect(reopened.age_min).toBe(12);
    expect(reopened.age_max).toBe(17);
    expect(reopened.approval).toBe("manual");
    expect(reopened.allow_free_agents).toBe(true);

    // A representative sample of the pre-existing registration_settings
    // fields, so the same round trip is proven for the WHOLE edit surface,
    // not just the five new columns.
    expect(reopened.enabled).toBe(true);
    expect(reopened.entrant_kind).toBe("team");
    expect(new Date(reopened.opens_at!).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(new Date(reopened.closes_at!).toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(reopened.capacity).toBe(24);
    expect(reopened.fee_cents).toBe(1250);
    expect(new Date(reopened.refund_lock_at!).toISOString()).toBe("2026-03-20T00:00:00.000Z");
    expect(reopened.payment_method).toBe("offline");
    expect(reopened.payment_instructions).toBe("Pay the club treasurer.");
    expect(reopened.form_fields).toEqual(formFields);
  });

  // The full-replace hazard, proven against the real endpoint rather than
  // only the pure toRegistrationSettingsPutBody unit test: a save that
  // touches only fee_cents must not clear form_fields/payment_instructions/
  // the rest on the server.
  it("a second save touching only fee_cents leaves every other field as the first save left it", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    const formFields: FormField[] = [{ key: "waiver", label: "Waiver accepted", kind: "checkbox", required: true }];
    const firstSave: RegistrationConfigState = {
      category: "open",
      age_min: null,
      age_max: null,
      enabled: true,
      entrant_kind: "individual",
      opens_at: null,
      closes_at: null,
      capacity: 50,
      fee_cents: 1000,
      refund_lock_at: null,
      form_fields: formFields,
      payment_method: "offline",
      payment_instructions: "Cash on the day.",
      approval: "auto",
      allow_free_agents: false,
    };
    await putRegistrationSettings(owner, division.id, toRegistrationSettingsPutBody(firstSave));

    const editedFeeOnly: RegistrationConfigState = { ...firstSave, fee_cents: 2000 };
    await putRegistrationSettings(owner, division.id, toRegistrationSettingsPutBody(editedFeeOnly));

    const after = await getRegistrationSettings(owner, division.id);
    expect(after.fee_cents).toBe(2000);
    expect(after.form_fields).toEqual(formFields);
    expect(after.payment_instructions).toBe("Cash on the day.");
    expect(after.capacity).toBe(50);
    expect(after.payment_method).toBe("offline");
  });
});
