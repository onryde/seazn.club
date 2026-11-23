// W5 follow-ups C: the org desk's folded-round loader (`../route.ts`). One round's rows (a run-sheet bar opened), or - review I2 sweep -
// `round=all`, every line of the stage (the Add match form's round planner over a windowed stage). Auth and the page's own read are
// stubbed: what is pinned is the route's filter and its refusals, over rows written here.
import { describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/server/api-v1/auth", () => ({
  requireResourceAuth: vi.fn(async (...args: unknown[]) => {
    auth.calls.push(args);
    return { orgId: "o1" };
  }),
}));
/** Full desk rows carry far more than the planner reads (a court, officials, an outcome...). */
const row = (id: string, stage_id: string, round_no: number) => ({
  id, stage_id, round_no, seq_in_round: 1, home_entrant_id: `h-${id}`, away_entrant_id: `a-${id}`, status: "scheduled", expunged: false,
  court_name: "Court 1", officials: [{ name: "Ref" }], outcome: null, scheduled_at: "2026-11-23T10:00:00Z",
});
const ROWS = [row("a1", "s1", 1), row("a2", "s1", 2), row("a3", "s1", 2), row("b1", "s2", 1)];
vi.mock("@/server/usecases/fixtures", () => ({ listDivisionFixtures: vi.fn(async () => ROWS) }));

import { GET } from "../route";

const get = async (qs: string) => {
  const res = await GET(new Request(`http://x/o/org/c/comp/d/div/rounds?${qs}`));
  const body = (await res.json()) as { data?: Record<string, unknown>[] };
  return {
    status: res.status,
    ids: body.data?.map((r) => (r.id ?? `${r.home_entrant_id}`.slice(2)) as string),
    cache: res.headers.get("cache-control"),
    rows: body.data,
  };
};

describe("the org desk's rounds loader", () => {
  it("one round: that stage's round only, never cached, after a read check on the division", async () => {
    auth.calls.length = 0;
    const r = await get("division=d1&stage=s1&round=2");
    expect({ status: r.status, ids: r.ids, cache: r.cache }).toEqual({ status: 200, ids: ["a2", "a3"], cache: "private, no-store" });
    expect(r.rows![0], "one round: the desk's whole row, as the bar draws it").toEqual(ROWS[1]);
    expect(auth.calls).toEqual([[expect.any(Request), "division", "d1", "read"]]);
  });

  it("round=all: every line of the stage, no other stage's - and only the five fields the round planner reads (review minor)", async () => {
    const all = await get("division=d1&stage=s1&round=all");
    expect(all.ids).toEqual(["a1", "a2", "a3"]);
    expect((await get("division=d1&stage=s2&round=all")).ids).toEqual(["b1"]);
    expect(all.rows![0]).toEqual({ round_no: 1, home_entrant_id: "h-a1", away_entrant_id: "a-a1", status: "scheduled", expunged: false });
    let checked = 0;
    for (const r of all.rows!) {
      expect(Object.keys(r).sort()).toEqual(["away_entrant_id", "expunged", "home_entrant_id", "round_no", "status"]);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("refusals: no round, a blank, zero or a word other than all; an unknown stage or round", async () => {
    let checked = 0;
    for (const qs of ["division=d1&stage=s1", "division=d1&stage=s1&round=", "division=d1&stage=s1&round=0", "division=d1&stage=s1&round=every", "stage=s1&round=all"]) {
      expect((await get(qs)).status, qs).toBe(400);
      checked += 1;
    }
    expect((await get("division=d1&stage=s9&round=all")).status).toBe(404);
    expect((await get("division=d1&stage=s1&round=7")).status).toBe(404);
    expect(checked).toBe(5);
  });
});
