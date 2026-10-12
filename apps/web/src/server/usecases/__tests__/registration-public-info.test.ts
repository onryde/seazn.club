// RS006 (public stepper) entry condition: the public register panel
// (`publicRegistrationInfo` / `PublicDivisionInfo`) did not expose
// `category`/`age_min`/`age_max`/`allow_free_agents`/`requires_gender` even
// though the columns backing them have existed since V364 and RS004's org
// hub already reads/writes them (`app/o/.../registration/data.ts`). Step 2
// (ENTRIES) needs category/age badges and the free-agent option — without
// these fields the client would have had to re-derive eligibility rules
// itself, which is exactly the client/server fork `_RULES.md` and the RS006
// prompt both forbid. Widened additively; no migration (columns pre-exist).
// Real Postgres, skipped without DATABASE_URL (repo convention).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "@/lib/db";

// T16: whether the club is offered online chess is asked of PostHog through the real helper; doubled at its boundary.
const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock("@/lib/posthog-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/posthog-server")>();
  return { ...actual, isServerFeatureEnabled: vi.fn(async (_f: string, _id: string, o: { orgId: string }) => flags.on.has(o.orgId)) };
});
import { builtinModules } from "@seazn/engine/sports";
import { isServerFeatureEnabled } from "@/lib/posthog-server";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { publicRegistrationInfo, putRegistrationSettings } from "../registrations";
import { createDivision } from "../divisions";
import { asOwner, rig, seedOrg } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("publicRegistrationInfo — RS006 eligibility/free-agent fields", () => {
  it("returns category/age_min/age_max/allow_free_agents/requires_gender for a configured team division", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await sql`update divisions set category = 'womens', age_min = 16, age_max = 35 where id = ${division.id}`;
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "team",
      fee_cents: 1500,
      capacity: 10,
      payment_method: "offline",
      allow_free_agents: true,
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions).toHaveLength(1);
    const d = info.divisions[0]!;
    expect(d.category).toBe("womens");
    expect(d.age_min).toBe(16);
    expect(d.age_max).toBe(35);
    expect(d.allow_free_agents).toBe(true);
    // womens ⇒ gender is needed to tell a self-registering contact apart —
    // same rule requiresGender's own unit tests pin, proven here end to end
    // through the real query rather than only against a hand-built object.
    expect(d.requires_gender).toBe(true);
  });

  it("defaults: open/null category, unset age band, free agents off, gender not required", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    const d = info.divisions[0]!;
    expect(d.category).toBeNull();
    expect(d.age_min).toBeNull();
    expect(d.age_max).toBeNull();
    expect(d.allow_free_agents).toBe(false);
    expect(d.requires_gender).toBe(false);
    expect(d.eligibility_note).toBeNull();
  });

  // RS007/V380 defect #3: the wizard's custom rule was written and shown
  // NOWHERE. eligibility_note is now a first-class column on the SAME
  // publicRegistrationInfo read model as category/age_min/age_max above —
  // this is that column's own entry condition proof.
  it("returns eligibility_note for a division that has one set", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await sql`update divisions set eligibility_note = 'School-registered students only' where id = ${division.id}`;
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions[0]!.eligibility_note).toBe("School-registered students only");
  });

  // RS007/V380 — publicRegistrationInfo never selected age_cutoff_month/
  // age_cutoff_day, so the ENTRIES step's client-side self-check
  // (ageBandEligibilityIssues) always used the 1-January default and would
  // disagree with the server for any division with a real cutoff. This is
  // that column pair's own entry condition proof, alongside category/
  // age_min/age_max above.
  it("returns age_cutoff_month/age_cutoff_day for a division that has a real cutoff set", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await sql`
      update divisions set age_max = 15, age_cutoff_month = 9, age_cutoff_day = 1
      where id = ${division.id}`;
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions[0]!.age_cutoff_month).toBe(9);
    expect(info.divisions[0]!.age_cutoff_day).toBe(1);
  });

  it("age_cutoff_month/age_cutoff_day are null by default (no cutoff configured)", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions[0]!.age_cutoff_month).toBeNull();
    expect(info.divisions[0]!.age_cutoff_day).toBeNull();
  });

  it("a mixed category requires gender (roster-composition signal) even with no age band", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);

    await sql`update divisions set category = 'mixed' where id = ${division.id}`;
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "team",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });

    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    expect(info.divisions[0]!.requires_gender).toBe(true);
  });
});

// T16 (spec §5.4, controller addendum 3): registration states that a division plays online, and its camera
// requirement, BEFORE signup. The wire carries both; the camera follows online play (no online play ⇒ no camera to
// require — camera-policy.ts), and online play is stated only while the club is offered online chess — the same
// condition under which submit demands the Lichess link (registration-submit.ts), so the page never promises a
// requirement the submit does not enforce, or the reverse. Single-sport by construction: only `boardgame` plays online.
describe.skipIf(!HAS_DB)("publicRegistrationInfo — online play and the camera requirement (T16)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    forgetOnlineChessFlagCache();
    flags.on.clear();
  });

  async function division(o: { online: boolean; division: string | null; competition: string; offered: boolean }) {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    // Labelled SQL: the chess division's own settings writes are division-settings' suites; this read is the subject.
    await sql`
      update divisions
         set sport_key = 'boardgame',
             config = config || ${sql.json({ onlinePlay: o.online ? "lichess" : "off" })},
             camera_policy = ${o.division}
       where id = ${division.id}`;
    await sql`update competitions set camera_policy = ${o.competition} where id = ${competition.id}`;
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: 0,
      payment_method: "offline",
      form_fields: [],
    });
    if (o.offered) flags.on.add(orgId);
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    forgetOnlineChessFlagCache();
    const info = await publicRegistrationInfo(orgSlug, competition.slug);
    return info.divisions[0]!;
  }

  it("the empty case first: a division of another sport plays nothing online and requires no camera", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, { enabled: true, entrant_kind: "individual", fee_cents: 0, payment_method: "offline", form_fields: [] });
    const d = (await publicRegistrationInfo(orgSlug, competition.slug)).divisions[0]!;
    expect([d.sport_key, d.online_play, d.camera_policy]).toEqual(["generic", false, "off"]);
  });

  it("another sport: every registered sport but boardgame plays nothing online, whatever its stored config says (registry sweep)", async () => {
    // A non-boardgame division cannot SAVE onlinePlay 'lichess' (the API refuses it), so the stored state is forced by
    // labelled SQL: the answer must come from the sport check, not from the config. A boardgame division that DOES play
    // online sits beside it, so the club is offered and asked — the sport check is the only thing left to answer.
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    const chess = await createDivision(owner, competition.id, {
      name: "Chess",
      sport_key: "boardgame",
      variant_key: "classical",
      config: { variant: "classical", onlinePlay: "lichess", clock: { base: 900, increment: 10 } },
    });
    for (const id of [division.id, chess.id]) {
      await putRegistrationSettings(owner, id, { enabled: true, entrant_kind: "individual", fee_cents: 0, payment_method: "offline", form_fields: [] });
    }
    await sql`update competitions set camera_policy = 'required' where id = ${competition.id}`;
    flags.on.add(orgId);
    const byId = async () => {
      vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
      forgetOnlineChessFlagCache();
      const info = await publicRegistrationInfo(orgSlug, competition.slug);
      return new Map(info.divisions.map((d) => [d.division_id, d]));
    };
    let checked = 0;
    for (const mod of builtinModules) {
      if (mod.key === "boardgame") continue;
      await sql`
        update divisions set sport_key = ${mod.key}, camera_policy = 'required',
               config = config || ${sql.json({ onlinePlay: "lichess" })}
         where id = ${division.id}`;
      const got = await byId();
      expect([got.get(division.id)!.online_play, got.get(division.id)!.camera_policy], mod.key).toEqual([false, "off"]);
      expect(got.get(chess.id)!.online_play, `${mod.key}: premise — the club is offered, the chess division plays online`).toBe(true);
      checked += 1;
    }
    expect(checked, "anti-vacuity: sports swept").toBe(builtinModules.length - 1);
    expect(checked).toBeGreaterThan(0);
  });

  it("a club with no division that could play online asks PostHog nothing", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg();
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, { enabled: true, entrant_kind: "individual", fee_cents: 0, payment_method: "offline", form_fields: [] });
    vi.stubEnv("ONLINE_CHESS_ALWAYS", undefined);
    forgetOnlineChessFlagCache();
    vi.mocked(isServerFeatureEnabled).mockClear();
    expect((await publicRegistrationInfo(orgSlug, competition.slug)).divisions[0]!.online_play).toBe(false);
    expect(isServerFeatureEnabled).not.toHaveBeenCalled();
    // The positive pair: the same club with an online chess division asks, once.
    await sql`update divisions set sport_key = 'boardgame', config = config || ${sql.json({ onlinePlay: "lichess" })} where id = ${division.id}`;
    forgetOnlineChessFlagCache();
    await publicRegistrationInfo(orgSlug, competition.slug);
    expect(isServerFeatureEnabled).toHaveBeenCalledTimes(1);
  });

  it("the nearest camera setting wins — the division's own, else the competition's — while the division plays online", async () => {
    // Typed from the rule (camera-policy.ts: division ?? competition), cases where the two levels DISAGREE.
    const cells: [string, string | null, string, string][] = [
      ["division required over competition off", "required", "off", "required"],
      ["division off over competition required", "off", "required", "off"],
      ["unset division inherits competition optional", null, "optional", "optional"],
    ];
    let checked = 0;
    for (const [label, div, comp, want] of cells) {
      const d = await division({ online: true, division: div, competition: comp, offered: true });
      expect([d.online_play, d.camera_policy], label).toEqual([true, want]);
      checked += 1;
    }
    expect(checked).toBe(cells.length);
  });

  it("over the board, or a club not offered online chess: not online, and no camera to require — whatever is stored", async () => {
    const otb = await division({ online: false, division: "required", competition: "required", offered: true });
    expect([otb.online_play, otb.camera_policy], "over the board").toEqual([false, "off"]);
    const dark = await division({ online: true, division: "required", competition: "off", offered: false });
    expect([dark.online_play, dark.camera_policy], "flag off").toEqual([false, "off"]);
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
