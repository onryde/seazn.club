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
const ROWS = [
  { id: "a1", stage_id: "s1", round_no: 1 },
  { id: "a2", stage_id: "s1", round_no: 2 },
  { id: "a3", stage_id: "s1", round_no: 2 },
  { id: "b1", stage_id: "s2", round_no: 1 },
];
vi.mock("@/server/usecases/fixtures", () => ({ listDivisionFixtures: vi.fn(async () => ROWS) }));

import { GET } from "../route";

const get = async (qs: string) => {
  const res = await GET(new Request(`http://x/o/org/c/comp/d/div/rounds?${qs}`));
  const body = (await res.json()) as { data?: { id: string }[] };
  return { status: res.status, ids: body.data?.map((r) => r.id), cache: res.headers.get("cache-control") };
};

describe("the org desk's rounds loader", () => {
  it("one round: that stage's round only, never cached, after a read check on the division", async () => {
    auth.calls.length = 0;
    const r = await get("division=d1&stage=s1&round=2");
    expect(r).toEqual({ status: 200, ids: ["a2", "a3"], cache: "private, no-store" });
    expect(auth.calls).toEqual([[expect.any(Request), "division", "d1", "read"]]);
  });

  it("round=all: every line of the stage, no other stage's", async () => {
    expect((await get("division=d1&stage=s1&round=all")).ids).toEqual(["a1", "a2", "a3"]);
    expect((await get("division=d1&stage=s2&round=all")).ids).toEqual(["b1"]);
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
