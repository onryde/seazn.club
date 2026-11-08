import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson } from "./helpers";
import { resolveSettleMs } from "../src/server/auto-advance/settle";

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
type Action = {
  id: string;
  stageId: string;
  kind: string;
  state: string;
  targetRound: number | null;
  dueAt: string | null;
  updatedAt: string;
  detail: unknown;
};
type Board = { id: string; stage_id: string; round_no: number; seq_in_round: number; home_entrant_id: string | null; away_entrant_id: string | null };

/** A generic division decides a board with one `generic.result`, the cheapest played result there is. */
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

/** A Swiss of three rounds (seq 1) feeding a knockout of its top four at setup (seq 2), four players. Badminton unless
 *  told otherwise. */
async function rig(request: APIRequestContext, label: string, sport: "badminton" | "generic" = "badminton") {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Auto-advance ${label} ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, "competition").toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    ...(sport === "generic"
      ? { sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG }
      : { sport_key: "badminton", variant_key: "bwf", config: {} }),
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

async function liveRows(request: APIRequestContext, divisionId: string): Promise<Action[]> {
  const read = await apiJson<{ actions: Action[] }>(request, `/api/v1/divisions/${divisionId}/auto-advance`);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data!.actions;
}

/** One scorer event at the fixture's tip; answers the appended event's id (what a `core.void` names). */
async function post(request: APIRequestContext, fixtureId: string, type: string, payload: Record<string, unknown> = {}): Promise<string> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  expect(state.status, JSON.stringify(state.error)).toBe(200);
  const res = await apiJson<{ event_id: string }>(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data!.last_seq,
    type,
    payload,
  });
  expect(res.status, `${type}: ${JSON.stringify(res.error)}`).toBe(201);
  return res.data!.event_id;
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
    // Task 5: the row is armed by the product, never written by hand. Results are decided through the scorer's events
    // route, and the read is what the fixtures tab's banner will poll (Task 13).
    const r = await rig(request, "read", "generic");
    // The empty case first: nothing generated, so the switch arms nothing.
    expect(await liveRows(request, r.divisionId)).toEqual([]);
    const on = await put(request, r.swissId, { autoPair: true });
    expect(on.status).toBe(200);
    expect(on.data!.actions, "no fixtures: nothing to arm").toEqual([]);
    expect((await apiJson(request, `/api/v1/divisions/${r.divisionId}/start`, "POST")).status, "Start").toBeLessThan(300);
    expect((await apiJson(request, `/api/v1/stages/${r.swissId}/generate`, "POST")).status, "Pair round 1").toBe(200);

    const all = await apiJson<Board[]>(request, `/api/v1/divisions/${r.divisionId}/fixtures`);
    expect(all.status, JSON.stringify(all.error)).toBe(200);
    const boards = all
      .data!.filter((f) => f.stage_id === r.swissId && f.round_no === 1 && f.home_entrant_id !== null && f.away_entrant_id !== null)
      .sort((a, b) => a.seq_in_round - b.seq_in_round);
    expect(boards, "four players: two boards in round 1").toHaveLength(2);
    const [b1, b2] = boards as [Board, Board];

    // One board decided: round 2 waits, naming the open board.
    await post(request, b1.id, "generic.result", { p1Score: 2, p2Score: 0 });
    const waiting = await liveRows(request, r.divisionId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      stageId: r.swissId,
      kind: "pair_round",
      state: "waiting",
      targetRound: 2,
      dueAt: null,
      detail: { openBoards: [{ fixtureId: b2.id, round: 1, board: b2.seq_in_round }] },
    });

    // The last board decided: the same row counts down, due one settle window after it was armed. The window is read from
    // the environment this run and its server share (the CI-only override, or the spec's 60 s).
    const lastResult = await post(request, b2.id, "generic.result", { p1Score: 2, p2Score: 0 });
    const [armed] = await liveRows(request, r.divisionId);
    expect(armed).toMatchObject({ id: waiting[0]!.id, kind: "pair_round", state: "pending", targetRound: 2, detail: null });
    const settle = resolveSettleMs(process.env);
    expect(Date.parse(armed!.dueAt!) - Date.parse(armed!.updatedAt), "due one settle window after it armed").toBe(settle);

    // A correction (the result voided, then decided the other way) restarts the clock: due later than before.
    await post(request, b2.id, "core.void", { event_id: lastResult });
    expect((await liveRows(request, r.divisionId))[0], "the void reopened the round").toMatchObject({ id: armed!.id, state: "waiting" });
    await post(request, b2.id, "generic.result", { p1Score: 0, p2Score: 2 });
    const [rearmed] = await liveRows(request, r.divisionId);
    expect(rearmed).toMatchObject({ id: armed!.id, state: "pending" });
    expect(Date.parse(rearmed!.dueAt!), "the clock restarted").toBeGreaterThan(Date.parse(armed!.dueAt!));
    expect(Date.parse(rearmed!.dueAt!) - Date.parse(rearmed!.updatedAt)).toBe(settle);

    // Switched off: the row is cancelled, so nothing is live (a cancelled row is history, never on the banner).
    expect((await put(request, r.swissId, { autoPair: false })).data!.actions).toEqual([]);
    expect(await liveRows(request, r.divisionId)).toEqual([]);

    // An unknown division is a 404, never an empty list.
    const unknown = await apiJson(request, `/api/v1/divisions/00000000-0000-4000-8000-000000000000/auto-advance`);
    expect(unknown.status).toBe(404);
  });

  test("Pair next inside the window pairs once and the banner row retires; Skip this time is sticky and refuses twice by name", async ({ request }) => {
    // Task 6 (§4.2, §4.6, §5.4, §5.13, D22): a person's Pair inside the countdown retires the row as done by a person (the
    // banner shows it done) and the next round waits; a second press pairs nothing more. Then Skip: the row is cancelled
    // for its round and stays so; a second Skip is 409 AUTO_ADVANCE_NOTHING_TO_SKIP, and confirm is never skippable (422
    // AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE). Expected values are the spec's, typed here.
    const r = await rig(request, "manual", "generic");
    expect((await put(request, r.swissId, { autoPair: true })).status).toBe(200);
    expect((await apiJson(request, `/api/v1/divisions/${r.divisionId}/start`, "POST")).status, "Start").toBeLessThan(300);
    expect((await apiJson(request, `/api/v1/stages/${r.swissId}/generate`, "POST")).status, "Pair round 1").toBe(200);
    const roundBoards = async (round: number) => {
      const all = await apiJson<Board[]>(request, `/api/v1/divisions/${r.divisionId}/fixtures`);
      expect(all.status, JSON.stringify(all.error)).toBe(200);
      return all
        .data!.filter((f) => f.stage_id === r.swissId && f.round_no === round && f.home_entrant_id !== null && f.away_entrant_id !== null)
        .sort((a, b) => a.seq_in_round - b.seq_in_round);
    };
    const r1 = await roundBoards(1);
    expect(r1, "four players: two boards in round 1").toHaveLength(2);
    for (const b of r1) await post(request, b.id, "generic.result", { p1Score: 2, p2Score: 0 });
    const [two] = await liveRows(request, r.divisionId);
    expect(two, "round 1 decided: round 2 counts down").toMatchObject({ kind: "pair_round", state: "pending", targetRound: 2 });

    // Pair next by hand inside the window: paired once, and the row retires as done by a person.
    expect((await apiJson(request, `/api/v1/stages/${r.swissId}/generate`, "POST")).status, "Pair next").toBe(200);
    const seated = (await roundBoards(2)).length;
    expect(seated, "four players: two boards in round 2").toBe(2);
    const afterPair = await liveRows(request, r.divisionId);
    expect(afterPair.find((a) => a.id === two!.id), "the banner row retired").toMatchObject({ state: "done", result: { by: "person" } });
    expect(afterPair.filter((a) => a.state !== "done"), "round 3 waits on round 2").toEqual([
      expect.objectContaining({ kind: "pair_round", state: "waiting", targetRound: 3 }),
    ]);
    // A second press while round 2 plays pairs nothing more.
    await apiJson(request, `/api/v1/stages/${r.swissId}/generate`, "POST");
    expect((await roundBoards(2)).length, "round 2 paired once").toBe(seated);
    expect(await roundBoards(3), "round 3 not paired").toEqual([]);

    // Skip this time: round 2 decided, round 3 counts down, and the skip cancels it for good.
    for (const b of await roundBoards(2)) await post(request, b.id, "generic.result", { p1Score: 2, p2Score: 0 });
    const three = (await liveRows(request, r.divisionId)).find((a) => a.state === "pending");
    expect(three, "round 2 decided: round 3 counts down").toMatchObject({ kind: "pair_round", targetRound: 3 });
    const skip = (kind: string) => apiJson<Action & { result: unknown }>(request, `/api/v1/stages/${r.swissId}/auto-advance/skip`, "POST", { kind });
    const skipped = await skip("pair_round");
    expect(skipped.status, JSON.stringify(skipped.error)).toBe(200);
    expect(skipped.data).toMatchObject({ id: three!.id, state: "cancelled", targetRound: 3, result: { reason: "skip", by: "person" } });
    expect((await liveRows(request, r.divisionId)).filter((a) => a.state !== "done"), "nothing live after the skip").toEqual([]);
    const twice = await skip("pair_round");
    expect([twice.status, twice.error?.code], "the second skip").toEqual([409, "AUTO_ADVANCE_NOTHING_TO_SKIP"]);
    const confirm = await skip("confirm_handoff");
    expect([confirm.status, confirm.error?.code], "confirm is never skipped").toEqual([422, "AUTO_ADVANCE_CONFIRM_NOT_SKIPPABLE"]);
  });
});
