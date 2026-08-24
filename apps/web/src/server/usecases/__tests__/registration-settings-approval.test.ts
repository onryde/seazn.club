// RS004: organiser-facing API for registration_settings.approval and
// .allow_free_agents (V364 columns added by RS001/RS002). Until this wave,
// nothing on the PUT surface could set either column — new rows took the
// DB default ('auto' / false) and an existing row's values were unreachable
// forever, since `putRegistrationSettings`'s own upsert never mentioned
// them. `registration-approval.ts`/`registration-submit.ts` already READ
// both columns (loadApprovalSettings / loadSubmitSettings) — this wave only
// closes the write side. Real Postgres; skipped without DATABASE_URL (same
// convention as registrations.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { getRegistrationSettings, putRegistrationSettings } from "../registrations";
import { asOwner, rig, seedOrg, SETTINGS_BASE } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (HAS_DB) await sql.end();
});

describe.skipIf(!HAS_DB)("registration_settings.approval / allow_free_agents (RS004)", () => {
  it("defaults to auto/false when omitted", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    const saved = await putRegistrationSettings(owner, division.id, { ...SETTINGS_BASE });
    expect(saved.approval).toBe("auto");
    expect(saved.allow_free_agents).toBe(false);

    const fetched = await getRegistrationSettings(owner, division.id);
    expect(fetched.approval).toBe("auto");
    expect(fetched.allow_free_agents).toBe(false);
  });

  it("round-trips approval:'manual' and allow_free_agents:true on a team division", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    const saved = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "team",
      approval: "manual",
      allow_free_agents: true,
    });
    expect(saved.approval).toBe("manual");
    expect(saved.allow_free_agents).toBe(true);

    const fetched = await getRegistrationSettings(owner, division.id);
    expect(fetched.approval).toBe("manual");
    expect(fetched.allow_free_agents).toBe(true);
  });

  it("a later PUT can turn allow_free_agents back off on the same team division", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "team",
      allow_free_agents: true,
    });
    const off = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "team",
      allow_free_agents: false,
    });
    expect(off.allow_free_agents).toBe(false);
  });

  // allow_free_agents rule (RS004 decision — see the usecase comment at the
  // guard itself): meaningful only where there IS a roster to join later.
  // registration-submit.ts's own submit-time guard already refuses a
  // free-agent entry outside entrant_kind 'team' (`entry.entrant_kind !==
  // "team" || !settings.allow_free_agents`); this rejects the SETTING at
  // save time instead of silently persisting a toggle that can never take
  // effect on an individual/pair division.
  it("rejects allow_free_agents:true on a non-team (individual) division", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    await expect(
      putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE,
        entrant_kind: "individual",
        allow_free_agents: true,
      }),
    ).rejects.toThrow(/allow_free_agents/);
  });

  it("rejects allow_free_agents:true on a non-team (pair) division", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    await expect(
      putRegistrationSettings(owner, division.id, {
        ...SETTINGS_BASE,
        entrant_kind: "pair",
        allow_free_agents: true,
      }),
    ).rejects.toThrow(/allow_free_agents/);
  });

  // RS004 review finding 2 — CHARACTERISATION, not a bug fix. Passes before
  // and after this review pass; added for coverage of an untested path, not
  // because it caught a regression. PUT is a full replace: the guard at
  // putRegistrationSettings (registrations.ts, ~1006) only ever sees THIS
  // call's own recomputed allowFreeAgents/entrantKind, and allow_free_agents
  // defaults back to false whenever a PUT omits it — so a later PUT that
  // switches entrant_kind away from 'team' can never combine with a
  // leftover allow_free_agents:true from a PRIOR PUT to produce an invalid
  // stored state.
  it("a later PUT to entrant_kind:'individual' resets allow_free_agents to false rather than 422ing (characterisation)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { division } = await rig(owner);

    await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "team",
      allow_free_agents: true,
    });

    const switched = await putRegistrationSettings(owner, division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "individual",
    });
    expect(switched.entrant_kind).toBe("individual");
    expect(switched.allow_free_agents).toBe(false);
  });
});
