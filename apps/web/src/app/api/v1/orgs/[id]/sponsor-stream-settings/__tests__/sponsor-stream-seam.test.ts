// R4 sponsors on stream, S12 - the SEAM (AGENTS.md class 1): what the On stream tab writes is what the overlay then does.
//
// Nothing here sets a table row by hand to make the rotation true. The settings go in through the REAL routes - the tick
// (`PATCH /sponsors/{id}`, which creates the org's row on the first one: R12) and the dial (`PUT /sponsor-stream-settings`) - and
// come out as the overlay answer's `sponsorPlan` from the REAL loader (`loadOverlayLiveData`) over a REAL ledger (`appendEvent`):
// the fold's replay opens the break (the sport's own `opensAt`), `resolveStreamSettings` picks the row in force, S4's planner
// decides, and the assignment rows are written. If the tab wrote a shape the overlay does not read, or the overlay read a scope
// the tab does not write, this file is where it shows.
//
// The sequence on ONE volleyball match (a timeout is a MINOR break, volleyball "indoor"), each step reading the plan the page gets:
//   1. the first tick           -> org row, enabled, Normal: the cards are served, the first timeout is NOT every-3rd: no airing
//   2. dial -> Light            -> still no airing (a minor is never on Light)
//   3. dial -> Busy             -> the timeout airs, one assignment row, a lower third
//   4. dial -> Light again      -> the timeout stays assigned: a dial move never un-airs a frozen break
//   5. a competition row off    -> the plan is null although the org row is on (the competition's row WINS: S5's resolver)
//   6. the competition row on   -> back, and the competition's dial rules
// then a second sport (hockey, FIH: a quarter end is a MAJOR) to show the dial position changes the answer by the sport's own
// break sizes, not by a rule restated here.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
const authState = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: async () => ({ id: authState.userId }),
    getCurrentUser: async () => ({ id: authState.userId }),
    getActiveOrgId: async () => null,
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { sql } from "@/lib/db";
import { builtinModules } from "@seazn/engine/sports";
import { SPONSOR_STYLE_BY_SIZE, sponsorMomentId, type SponsorFrequency, type SponsorPlan } from "@/lib/sponsor-plan";
import { appendEvent } from "@/server/engine-db/append-event";
import { loadOverlayLiveData } from "@/server/overlay/load";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createSponsor } from "@/server/usecases/sponsors";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { PATCH } from "../../sponsors/[sponsorId]/route";
import { PUT } from "../route";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const tick = (orgId: string, sponsorId: string, on_stream: boolean) =>
  PATCH(new Request(`http://localhost/api/v1/orgs/${orgId}/sponsors/${sponsorId}`, json("PATCH", { on_stream })), { params: Promise.resolve({ id: orgId, sponsorId }) });
const dial = (orgId: string, body: { competitionId: string | null; enabled: boolean; frequency: SponsorFrequency }) =>
  PUT(new Request(`http://localhost/api/v1/orgs/${orgId}/sponsor-stream-settings`, json("PUT", body)), { params: Promise.resolve({ id: orgId }) });

const sizeOf = (sportKey: string, kind: string) => {
  const k = builtinModules.find((m) => m.key === sportKey)?.naturalBreaks?.kinds.find((d) => d.kind === kind);
  if (k === undefined) throw new Error(`${sportKey} declares no "${kind}"`);
  return k.size;
};

interface Seeded {
  auth: Awaited<ReturnType<typeof seedOrg>>["auth"];
  orgId: string;
  competitionId: string;
  fixtureId: string;
  home: string;
  tip: number;
}
async function seed(sportKey: "hockey" | "volleyball", variantKey: string): Promise<Seeded> {
  const { auth } = await seedOrg("pro");
  authState.userId = auth.userId!;
  const competition = await createCompetition(auth, { ends_on: "2030-12-31", name: "Seam Cup", visibility: "public", branding: {} });
  const division = await createDivision(auth, competition.id, { name: "Open", sport_key: sportKey, variant_key: variantKey, config: {} });
  await createEntrants(auth, division.id, ["Harbour", "Ridge"].map((name, i) => ({ kind: "team" as const, display_name: name, seed: i + 1, members: [] })));
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  const fx = fixtures[0]! as { id: string; home_entrant_id: string };
  return { auth, orgId: auth.orgId, competitionId: competition.id, fixtureId: fx.id, home: fx.home_entrant_id, tip: 0 };
}
async function append(s: Seeded, type: string, payload: unknown) {
  const r = await appendEvent(s.orgId, s.fixtureId, s.tip, { type, payload });
  s.tip = r.seq;
  return r;
}
/** A real, UNTICKED sponsor (a created sponsor starts off the stream), as the Sponsors tab makes one. */
async function newSponsor(s: Seeded, name: string): Promise<string> {
  const row = await createSponsor(s.auth, { name, url: `https://example.com/${encodeURIComponent(name)}`, tier: "partner", status: "active" } as never);
  expect(row.on_stream, "premise: a created sponsor starts off the stream").toBe(false);
  return row.id;
}
const airedBy = (plan: SponsorPlan | undefined) => Object.fromEntries((plan?.airings ?? []).map((a) => [a.momentId, plan!.cards.find((c) => c.id === a.cardId)?.sponsorId ?? "?"]));
const planOf = async (s: Seeded) => (await loadOverlayLiveData(s.fixtureId)).sponsorPlan;
const assignmentRows = (s: Seeded) => sql<{ moment_id: string; sponsor_id: string | null; style: string }[]>`
  select moment_id, sponsor_id, style from sponsor_assignments where fixture_id = ${s.fixtureId} order by seq`;
const settingsRows = (orgId: string) => sql<{ competition_id: string | null; enabled: boolean; frequency: string }[]>`
  select competition_id, enabled, frequency from sponsor_stream_settings where org_id = ${orgId} order by competition_id nulls first`;

describe.skipIf(!HAS_DB)("S12 seam: the tab's writes, through the real routes, decide what the overlay airs", () => {
  it("volleyball (a timeout is a MINOR): tick -> Normal -> Light -> Busy -> Light, then a competition row off and on - read as the overlay's sponsorPlan at every step", async () => {
    const s = await seed("volleyball", "indoor");
    expect(sizeOf("volleyball", "timeout"), "premise: a volleyball timeout is a minor break").toBe("minor");
    const a = await newSponsor(s, "Acme Physio");
    expect(await planOf(s), "premise: no settings row, so the rotation is off").toBeNull();
    await append(s, "core.start", {});
    const timeout = await append(s, "volleyball.timeout", { by: s.home });
    const moment = sponsorMomentId(timeout.seq, "timeout");

    // 1. The first tick: the org row appears (R12), and the rotation is on at Normal.
    expect((await tick(s.orgId, a, true)).status).toBe(200);
    expect(await settingsRows(s.orgId)).toEqual([{ competition_id: null, enabled: true, frequency: "normal" }]);
    const normal = await planOf(s);
    expect(normal, "enabled: the plan is served").not.toBeNull();
    expect(normal!.cards.map((c) => c.sponsorId), "the ticked sponsor is the card").toEqual([a]);
    expect(normal!.airings, "Normal airs every 3rd minor: the first timeout is not one").toEqual([]);
    expect(await assignmentRows(s)).toEqual([]);

    // 2. Light never airs a minor.
    expect((await dial(s.orgId, { competitionId: null, enabled: true, frequency: "light" })).status).toBe(200);
    expect((await planOf(s))!.airings).toEqual([]);

    // 3. Busy airs every break: the timeout gets the card, as a lower third, and the assignment is written.
    expect((await dial(s.orgId, { competitionId: null, enabled: true, frequency: "busy" })).status).toBe(200);
    const busy = await planOf(s);
    expect(airedBy(busy)).toEqual({ [moment]: a });
    expect(busy!.airings[0]).toMatchObject({ style: SPONSOR_STYLE_BY_SIZE.minor.style, holdMs: SPONSOR_STYLE_BY_SIZE.minor.holdMs });
    expect(await assignmentRows(s)).toEqual([{ moment_id: moment, sponsor_id: a, style: SPONSOR_STYLE_BY_SIZE.minor.style }]);

    // 4. Back to Light: the break already has its card (frozen), so a dial move does not take it away.
    expect((await dial(s.orgId, { competitionId: null, enabled: true, frequency: "light" })).status).toBe(200);
    expect(airedBy(await planOf(s)), "a frozen assignment survives the dial").toEqual({ [moment]: a });
    expect(await assignmentRows(s)).toHaveLength(1);

    // 5. A competition's own row, OFF, wins over the org's ON row for this competition's fixture.
    expect((await dial(s.orgId, { competitionId: s.competitionId, enabled: false, frequency: "busy" })).status).toBe(200);
    expect(await planOf(s), "the competition's row is the one in force").toBeNull();
    expect(await settingsRows(s.orgId)).toEqual([
      { competition_id: null, enabled: true, frequency: "light" },
      { competition_id: s.competitionId, enabled: false, frequency: "busy" },
    ]);

    // 6. The same row switched on: back, and it is the COMPETITION's dial (Busy) that rules, not the org's (Light).
    expect((await dial(s.orgId, { competitionId: s.competitionId, enabled: true, frequency: "busy" })).status).toBe(200);
    expect(airedBy(await planOf(s))).toEqual({ [moment]: a });
    expect(await settingsRows(s.orgId), "still two rows: the second save updated the competition's").toHaveLength(2);
  });

  it("an UNticked sponsor is never a card; unticking every sponsor leaves the settings row and serves no plan (the planner's rule: nothing to air); ticking one brings it back (sequence)", async () => {
    const s = await seed("volleyball", "indoor");
    const a = await newSponsor(s, "Acme Physio");
    const b = await newSponsor(s, "Beta Bakery");
    await tick(s.orgId, a, true);
    expect((await planOf(s))!.cards.map((c) => c.sponsorId), "only the ticked one").toEqual([a]);
    await tick(s.orgId, b, true);
    expect((await planOf(s))!.cards.map((c) => c.sponsorId).sort()).toEqual([a, b].sort());
    await tick(s.orgId, a, false);
    await tick(s.orgId, b, false);
    expect(await settingsRows(s.orgId), "unticking never removes the row (R12)").toEqual([{ competition_id: null, enabled: true, frequency: "normal" }]);
    expect(await planOf(s), "no ticked sponsor and nothing assigned: the planner serves no plan").toBeNull();
    await tick(s.orgId, b, true);
    expect((await planOf(s))!.cards.map((c) => c.sponsorId), "ticking one brings the rotation back").toEqual([b]);
    expect(await settingsRows(s.orgId), "still the one row, never a second").toHaveLength(1);
  });

  it("hockey (FIH: a quarter end is a MAJOR): the first tick's Normal airs it, Light airs it, and switching the rotation off serves nothing - the dial acts through the sport's own sizes", async () => {
    const s = await seed("hockey", "fih-shootout");
    expect(sizeOf("hockey", "quarter_end"), "premise: a hockey quarter end is a major").toBe("major");
    const a = await newSponsor(s, "Harbourside Timber");
    await append(s, "core.start", {});
    const q2 = await append(s, "hockey.period.advance", { to: "Q2" });
    const moment = sponsorMomentId(q2.seq, "quarter_end");

    await tick(s.orgId, a, true);
    expect(airedBy(await planOf(s)), "Normal airs a major").toEqual({ [moment]: a });
    expect((await planOf(s))!.airings[0]).toMatchObject({ style: SPONSOR_STYLE_BY_SIZE.major.style, holdMs: SPONSOR_STYLE_BY_SIZE.major.holdMs });

    await dial(s.orgId, { competitionId: null, enabled: true, frequency: "light" });
    expect(airedBy(await planOf(s)), "Light airs a major too").toEqual({ [moment]: a });

    await dial(s.orgId, { competitionId: null, enabled: false, frequency: "light" });
    expect(await planOf(s), "switched off: the overlay serves no plan at all").toBeNull();
    expect(await settingsRows(s.orgId)).toEqual([{ competition_id: null, enabled: false, frequency: "light" }]);
  });
});
