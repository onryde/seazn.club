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
// B3 T11: the plan entrant limit is the REAL resolver, wrapped so a test can count its calls (asked once per competition).
vi.mock("@/lib/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/entitlements")>();
  return { ...actual, getLimit: vi.fn(actual.getLimit) };
});
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { getLimit, invalidateOrgEntitlements } from "@/lib/entitlements";
import { isServerFeatureEnabled } from "@/lib/posthog-server";
import { PublicRegistrationInfo } from "@/server/api-v1/schemas";
import { forgetOnlineChessFlagCache } from "../external-play/online-chess-flag";
import { publicRegistrationInfo, putRegistrationSettings, withdrawRegistrationOrganiser } from "../registrations";
import { submitRegistrationGroup } from "../registration-submit";
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

// Registration redesign B3 T11 (spec §4.1, false premise FP3). The panel's "places left" counted the division's capacity
// alone, while submit waitlists a TEAM entry once `taken >= min(capacity, planLimit)` (registration-submit.ts, under the
// settings lock). A division under its capacity but at its plan limit read "places left" and then waitlisted the entry.
// Every expected count below comes from the plan rule — `getLimit` on the fixture org, capacity as saved, entries as
// submitted — and the walk test holds the panel to SUBMIT's own verdict at every step, not to a number typed here.
// Entries go through the real producer (`submitRegistrationGroup`), so `active` counts rows submit actually wrote.
// Another sport: N/A — registration capacity is sport-agnostic (one generic division per test).
const PLAN_KEY = "entrants.per_division.max";

describe.skipIf(!HAS_DB)("publicRegistrationInfo — places left uses submit's cap (B3 T11)", () => {
  /** The per-division entrant limit lowered (or lifted) AFTER capacity was saved: the production shape of "plan tighter
   *  than capacity" — `putRegistrationSettings` refuses a capacity above the limit at save time, so the limit only falls
   *  under it later (a downgrade, an expired pass, a staff cap). `null` = unlimited (lib/entitlements.ts `overrideRow`). */
  async function setPlanLimit(orgId: string, intValue: number | null) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
      values (${orgId}, ${PLAN_KEY}, ${intValue}, 'test — B3 T11 places left')`;
    await invalidateOrgEntitlements(orgId);
  }

  async function setup(o: { capacity: number | null; kind?: "individual" | "team"; allowFreeAgents?: boolean }) {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division } = await rig(owner);
    await putRegistrationSettings(owner, division.id, {
      enabled: true,
      entrant_kind: o.kind ?? "individual",
      fee_cents: 0,
      payment_method: "offline",
      capacity: o.capacity,
      allow_free_agents: o.allowFreeAgents ?? false,
      form_fields: [],
    });
    const read = async () => {
      const info = await publicRegistrationInfo(orgSlug, competition.slug);
      return info.divisions.find((d) => d.division_id === division.id)!;
    };
    const enter = async (n: number, opts: { team?: boolean; freeAgent?: boolean } = {}) =>
      (
        await submitRegistrationGroup(
          { orgSlug, compSlug: competition.slug },
          {
            contact: { name: "Rae Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` },
            privacy_consent: true,
            entries: Array.from({ length: n }, (_, i) =>
              opts.freeAgent
                ? { division_id: division.id, entrant_kind: "team" as const, free_agent: true, players: [{ full_name: `Solo ${i + 1}` }], answers: {} }
                : opts.team
                  ? { division_id: division.id, entrant_kind: "team" as const, team_name: `Team ${randomUUID().slice(0, 6)}`, players: [{ full_name: `Captain ${i + 1}` }], answers: {} }
                  : { division_id: division.id, entrant_kind: "individual" as const, players: [{ full_name: `Player ${i + 1}` }], answers: {} },
            ),
          },
        )
      ).entries;
    const planLimit = () => getLimit(orgId, PLAN_KEY, competition.id);
    return { orgId, orgSlug, owner, competition, division, read, enter, planLimit };
  }

  it("the empty case first: no capacity and an unlimited plan — remaining stays null however many have entered", async () => {
    const t = await setup({ capacity: null });
    await setPlanLimit(t.orgId, null);
    expect(await t.planLimit(), "premise: the plan limit is unlimited").toBeNull();
    const before = await t.read();
    expect([before.remaining, before.closed_reason, before.taken]).toEqual([null, null, 0]);
    const entered = await t.enter(2);
    expect(entered.map((e) => e.status), "premise: nothing caps them").not.toContain("waitlisted");
    const after = await t.read();
    expect([after.remaining, after.closed_reason, after.taken, after.open]).toEqual([null, null, 2, true]);
  });

  it("no capacity under a finite plan is not unlimited: remaining counts down from the plan limit", async () => {
    const t = await setup({ capacity: null });
    const limit = await t.planLimit();
    expect(limit, "premise: the fixture plan has a finite per-division limit").not.toBeNull();
    await t.enter(1);
    const d = await t.read();
    expect(d.capacity).toBeNull();
    expect(d.remaining).toBe(limit! - 1);
  });

  it("remaining honours the plan limit when it is tighter than capacity", async () => {
    const t = await setup({ capacity: 32 });
    await setPlanLimit(t.orgId, 4);
    const limit = (await t.planLimit())!;
    expect(limit, "premise: the plan limit binds under the capacity").toBeLessThan(32);
    const entered = await t.enter(limit);
    expect(entered.map((e) => e.status), "premise: every entry up to the limit holds a place").not.toContain("waitlisted");
    const d = await t.read();
    expect([d.capacity, d.taken, d.remaining, d.closed_reason, d.open]).toEqual([32, limit, 0, "full", true]);
  });

  it("capacity binds when it is tighter than the plan limit", async () => {
    const t = await setup({ capacity: 2 });
    const limit = (await t.planLimit())!;
    expect(limit, "premise: the plan limit is looser than the capacity").toBeGreaterThan(2);
    await t.enter(1);
    expect((await t.read()).remaining).toBe(2 - 1);
  });

  it("the panel and submit agree at every step, from empty to past the plan limit", async () => {
    // At each step: read the panel, then submit one entry. "Places left" must mean submit seats it; 0 must mean submit
    // waitlists it — the defect FP3 names is exactly a panel step reading > 0 that submit then waitlists.
    const t = await setup({ capacity: 32 });
    await setPlanLimit(t.orgId, 4);
    const limit = (await t.planLimit())!;
    let seated = 0;
    let queued = 0;
    for (let k = 0; k <= limit + 1; k += 1) {
      const d = await t.read();
      expect(d.remaining, `step ${k}: places left`).toBe(Math.max(0, limit - k));
      expect(d.closed_reason, `step ${k}: closed_reason`).toBe(k >= limit ? "full" : null);
      const [entry] = await t.enter(1);
      expect(entry!.status === "waitlisted", `step ${k}: submit waitlists exactly when the panel says 0 left`).toBe(d.remaining === 0);
      if (entry!.status === "waitlisted") queued += 1;
      else seated += 1;
    }
    expect([seated, queued], "anti-vacuity: both verdicts were reached").toEqual([limit, 2]);
    expect((await t.read()).waitlisted).toBe(2);
  });

  it("a withdrawal frees a place the panel shows again, on every later read", async () => {
    const t = await setup({ capacity: 32 });
    await setPlanLimit(t.orgId, 4);
    const limit = (await t.planLimit())!;
    const entered = await t.enter(limit);
    expect((await t.read()).remaining).toBe(0);
    await withdrawRegistrationOrganiser(t.owner, entered[0]!.registration_id);
    const first = await t.read();
    const second = await t.read();
    expect([first.remaining, first.closed_reason, first.taken]).toEqual([1, null, limit - 1]);
    expect([second.remaining, second.closed_reason], "second call").toEqual([first.remaining, first.closed_reason]);
  });

  it("a withdrawal with someone waiting promotes them: still full, one fewer waiting", async () => {
    const t = await setup({ capacity: 32 });
    await setPlanLimit(t.orgId, 4);
    const limit = (await t.planLimit())!;
    const entered = await t.enter(limit);
    const [late] = await t.enter(1);
    expect(late!.status, "premise: one past the plan limit waits").toBe("waitlisted");
    expect([(await t.read()).remaining, (await t.read()).waitlisted]).toEqual([0, 1]);
    await withdrawRegistrationOrganiser(t.owner, entered[0]!.registration_id);
    const [{ status }] = await sql<{ status: string }[]>`select status from registrations where id = ${late!.registration_id}`;
    expect(status, "premise: the freed place went to the one waiting").not.toBe("waitlisted");
    const d = await t.read();
    expect([d.remaining, d.closed_reason, d.waitlisted, d.taken]).toEqual([0, "full", 0, limit]);
  });

  it("a solo sign-up does not reduce remaining (RS012), under the plan limit too", async () => {
    const t = await setup({ capacity: 32, kind: "team", allowFreeAgents: true });
    await setPlanLimit(t.orgId, 4);
    const limit = (await t.planLimit())!;
    await t.enter(limit - 1, { team: true });
    expect((await t.read()).remaining).toBe(1);
    const [solo] = await t.enter(1, { freeAgent: true });
    expect([solo!.free_agent, solo!.status === "waitlisted"], "premise: the solo sign-up landed, not queued").toEqual([true, false]);
    expect((await t.read()).remaining, "a solo sign-up takes no team place").toBe(1);
    // ...and that one place was real: the next team entry is seated, and only then is the division full.
    const [team] = await t.enter(1, { team: true });
    expect(team!.status).not.toBe("waitlisted");
    expect([(await t.read()).remaining, (await t.read()).closed_reason]).toEqual([0, "full"]);
  });

  it("the plan limit is asked once per competition, scoped to it, however many divisions", async () => {
    const t = await setup({ capacity: null });
    const second = await createDivision(t.owner, t.competition.id, {
      name: "Masters",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await putRegistrationSettings(t.owner, second.id, { enabled: true, entrant_kind: "individual", fee_cents: 0, payment_method: "offline", form_fields: [] });
    vi.mocked(getLimit).mockClear();
    const info = await publicRegistrationInfo(t.orgSlug, t.competition.slug);
    expect(info.divisions, "premise: two divisions on the panel").toHaveLength(2);
    const asked = vi.mocked(getLimit).mock.calls.filter(([, key]) => key === PLAN_KEY);
    expect(asked).toEqual([[t.orgId, PLAN_KEY, t.competition.id]]);
  });

  it("waitlisted count reaches the wire (parsed through the public Zod contract), 0 when nobody waits", async () => {
    const t = await setup({ capacity: 1 });
    const entered = await t.enter(3);
    const waiting = entered.filter((e) => e.status === "waitlisted").length;
    expect(waiting, "premise: capacity 1, three entries — two wait").toBe(2);
    const wire = PublicRegistrationInfo.parse(await publicRegistrationInfo(t.orgSlug, t.competition.slug));
    expect(wire.divisions[0]!.waitlisted).toBe(waiting);
    // The empty case: a division nobody waits on carries 0, never an absent field.
    const empty = await setup({ capacity: null });
    const emptyWire = PublicRegistrationInfo.parse(await publicRegistrationInfo(empty.orgSlug, empty.competition.slug));
    expect(emptyWire.divisions[0]!.waitlisted).toBe(0);
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
