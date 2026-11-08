import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson } from "./helpers";

// Swiss auto-advance (spec docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md), plan Task 4: the two per-stage
// switches through the production-shaped server — `PUT /api/v1/stages/{id}/auto-advance` and the division's read,
// `GET /api/v1/divisions/{id}/auto-advance`. API-only here; the Format tool's switches and the fixtures tab's banner are
// later tasks' (15, 13), and they extend this file. Run only by the CI dispatch (`e2e.yml`) and judged as a WHOLE file,
// never with `-g`; serial mode is per describe, never file-wide (AGENTS.md class 21).
//
// Expected values are the spec's, typed here: both switches are off by default (§2); `autoPair` lives on a Swiss stage
// only (422 AUTO_PAIR_NOT_SWISS), `autoConfirmHandoff` on a stage fed with `timing: "setup"` only (422
// AUTO_CONFIRM_NO_HANDOFF); turning one off is never refused; a switch that MOVES is one `stage_auto_advance_switched`
// entry in the division's history, naming the person; the same value again is none.

const P_SETUP = {
  sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }],
  placement: "rank_order",
  timing: "setup",
};

type Switches = { autoPair: boolean; autoConfirmHandoff: boolean; actions: unknown[] };
type HistoryOut = { events: { type: string; actor_id: string | null }[] };
type StageOut = { id: string; seq: number; config: Record<string, unknown> };

/** A badminton Swiss of three rounds (seq 1) feeding a knockout of its top four at setup (seq 2), four players. */
async function rig(request: APIRequestContext, label: string) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Auto-advance ${label} ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, "competition").toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "badminton",
    variant_key: "bwf",
    config: {},
  });
  expect(div.status, "division").toBeLessThan(300);
  const divisionId = div.data!.id;
  const added = await addEntrantsViaApi(request, divisionId, ["A1", "A2", "A3", "A4"]);
  expect(added.ids, "four players").toHaveLength(4);
  const swiss = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 1,
    kind: "swiss",
    name: "Swiss",
    config: { rounds: 3 },
  });
  expect(swiss.status, "Swiss stage").toBeLessThan(300);
  const ko = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", {
    seq: 2,
    kind: "knockout",
    name: "Cup",
    config: {},
    progression: P_SETUP,
  });
  expect(ko.status, "knockout stage").toBeLessThan(300);
  return { divisionId, swissId: swiss.data!.id, koId: ko.data!.id };
}

const put = (request: APIRequestContext, stageId: string, body: unknown) =>
  apiJson<Switches>(request, `/api/v1/stages/${stageId}/auto-advance`, "PUT", body);

async function switched(request: APIRequestContext, divisionId: string) {
  const h = await apiJson<HistoryOut>(request, `/api/v1/divisions/${divisionId}/history`);
  expect(h.status, "history").toBe(200);
  return h.data!.events.filter((e) => e.type === "stage_auto_advance_switched");
}

async function storedConfig(request: APIRequestContext, divisionId: string, stageId: string) {
  const s = await apiJson<StageOut[]>(request, `/api/v1/divisions/${divisionId}/stages`);
  expect(s.status, "stages").toBe(200);
  const stage = s.data!.find((x) => x.id === stageId);
  expect(stage, "the stage is listed").toBeDefined();
  return stage!.config;
}

test.describe("Swiss auto-advance T4: the stage switches and the division read", () => {
  test.describe.configure({ mode: "serial" });

  test("switch defaults off and turns on through the API", async ({ request }) => {
    const r = await rig(request, "switches");
    // The empty case first: nothing stored, nothing in the history.
    expect(await storedConfig(request, r.divisionId, r.swissId)).not.toHaveProperty("autoPair");
    expect(await storedConfig(request, r.divisionId, r.koId)).not.toHaveProperty("autoConfirmHandoff");
    expect(await switched(request, r.divisionId)).toEqual([]);

    // On, and the same value again: stored once, one history entry, which names a person (this is a session's write).
    const on = await put(request, r.swissId, { autoPair: true });
    expect(on.status).toBe(200);
    expect(on.data).toEqual({ autoPair: true, autoConfirmHandoff: false, actions: [] });
    expect((await put(request, r.swissId, { autoPair: true })).status, "the same value again").toBe(200);
    expect((await storedConfig(request, r.divisionId, r.swissId)).autoPair).toBe(true);
    const once = await switched(request, r.divisionId);
    expect(once, "one entry for one move").toHaveLength(1);
    expect(once[0]!.actor_id, "the person who flipped it").not.toBeNull();

    // Refused by name where the switch can never act; the positive pair goes through on the stage it belongs to.
    const pairOnKo = await put(request, r.koId, { autoPair: true });
    expect([pairOnKo.status, pairOnKo.error?.code]).toEqual([422, "AUTO_PAIR_NOT_SWISS"]);
    const confirmOnSwiss = await put(request, r.swissId, { autoConfirmHandoff: true });
    expect([confirmOnSwiss.status, confirmOnSwiss.error?.code]).toEqual([422, "AUTO_CONFIRM_NO_HANDOFF"]);
    const confirmOnKo = await put(request, r.koId, { autoConfirmHandoff: true });
    expect(confirmOnKo.status).toBe(200);
    expect(confirmOnKo.data).toEqual({ autoPair: false, autoConfirmHandoff: true, actions: [] });

    // A body with no switch, or one it does not know, is a 400 and writes nothing.
    expect((await put(request, r.swissId, {})).status).toBe(400);
    expect((await put(request, r.swissId, { autoPair: true, autoPairs: true })).status).toBe(400);

    // The switches flip after the division starts and round 1 is paired: that is why they have their own door.
    expect((await apiJson(request, `/api/v1/divisions/${r.divisionId}/start`, "POST")).status, "Start").toBeLessThan(300);
    expect((await apiJson(request, `/api/v1/stages/${r.swissId}/generate`, "POST")).status, "Pair round 1").toBe(200);
    const off = await put(request, r.swissId, { autoPair: false });
    expect(off.status).toBe(200);
    expect(off.data).toMatchObject({ autoPair: false });
    expect((await storedConfig(request, r.divisionId, r.swissId)).autoPair).toBe(false);
    // Three moves in all: Swiss on, knockout's confirm on, Swiss off. Refusals, repeats and 400s wrote none.
    expect(await switched(request, r.divisionId)).toHaveLength(3);
  });

  test("GET auto-advance lists live rows", async ({ request }) => {
    // Nothing arms a row before Task 5, so the list is empty here; the shape is pinned now and Task 5 extends this case
    // with the row the switch arms.
    const r = await rig(request, "read");
    const read = await apiJson<{ actions: unknown[] }>(request, `/api/v1/divisions/${r.divisionId}/auto-advance`);
    expect(read.status).toBe(200);
    expect(read.data).toEqual({ actions: [] });
    expect((await put(request, r.swissId, { autoPair: true })).status).toBe(200);
    const after = await apiJson<{ actions: unknown[] }>(request, `/api/v1/divisions/${r.divisionId}/auto-advance`);
    expect(after.status).toBe(200);
    expect(Array.isArray(after.data!.actions), "actions is a list").toBe(true);
    // An unknown division is a 404, never an empty list.
    const unknown = await apiJson(request, `/api/v1/divisions/00000000-0000-4000-8000-000000000000/auto-advance`);
    expect(unknown.status).toBe(404);
  });
});
