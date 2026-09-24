// The one pool-order authority (`lib/pool-order.ts`). Every scene below gives
// the pools ids that sort OPPOSITE to their names, so an id sort — what the
// division page and the hub used to do — reads B above A and reds here.
import { describe, expect, it } from "vitest";
import { byPoolOrder, comparePools, type PoolOrderRef } from "../pool-order";

// "f…" sorts after "0…": Pool A's id is the LATER one.
const A: PoolOrderRef = { id: "ffffffff-0000-4000-8000-000000000001", key: "A", name: "Pool A" };
const B: PoolOrderRef = { id: "00000000-0000-4000-8000-000000000002", key: "B", name: "Pool B" };

describe("comparePools", () => {
  it("premise: the ids sort opposite to the names", () => {
    expect([A.id, B.id].sort()).toEqual([B.id, A.id]);
  });

  it("Pool A before Pool B, whatever their ids", () => {
    expect([B, A].sort(comparePools).map((p) => p.name)).toEqual(["Pool A", "Pool B"]);
    expect([A, B].sort(comparePools).map((p) => p.name)).toEqual(["Pool A", "Pool B"]);
  });

  it("the key is the position: it outranks the name", () => {
    // A key and a name that disagree — the key (the generator's letter) wins.
    const first = { id: "z", key: "A", name: "Zebra group" };
    const second = { id: "a", key: "B", name: "Alpha group" };
    expect([second, first].sort(comparePools)).toEqual([first, second]);
  });

  it("natural order: Pool 2 before Pool 10, by key and by name", () => {
    const byKey = [{ id: "1", key: "10" }, { id: "2", key: "2" }];
    expect(byKey.sort(comparePools).map((p) => p.key)).toEqual(["2", "10"]);
    const byName = [{ id: "1", name: "Pool 10" }, { id: "2", name: "Pool 2" }];
    expect(byName.sort(comparePools).map((p) => p.name)).toEqual(["Pool 2", "Pool 10"]);
  });

  it("no key: the name decides; nothing to tell them apart: the id", () => {
    const named = [{ id: "0", name: "Pool B" }, { id: "f", name: "Pool A" }];
    expect(named.sort(comparePools).map((p) => p.name)).toEqual(["Pool A", "Pool B"]);
    const twins = [{ id: "f", name: "Pool" }, { id: "0", name: "Pool" }];
    expect(twins.sort(comparePools).map((p) => p.id)).toEqual(["0", "f"]);
  });
});

describe("byPoolOrder (standings snapshots)", () => {
  const snap = (pool_id: string | null) => ({ pool_id, label: pool_id === null ? "overall" : pool_id === A.id ? "A" : pool_id === B.id ? "B" : pool_id });

  it("A before B, in either arrival order", () => {
    expect([snap(B.id), snap(A.id)].sort(byPoolOrder([A, B])).map((s) => s.label)).toEqual(["A", "B"]);
    expect([snap(A.id), snap(B.id)].sort(byPoolOrder([B, A])).map((s) => s.label)).toEqual(["A", "B"]);
  });

  it("the stage-wide table reads first, as it always did", () => {
    expect([snap(B.id), snap(null), snap(A.id)].sort(byPoolOrder([A, B])).map((s) => s.label)).toEqual(["overall", "A", "B"]);
  });

  it("a pool the list does not name reads after every named one", () => {
    expect([snap("0-unlisted"), snap(B.id), snap(A.id)].sort(byPoolOrder([A, B])).map((s) => s.label)).toEqual([
      "A",
      "B",
      "0-unlisted",
    ]);
  });

  it("empty pool list: every snapshot keeps a stable id order, stage-wide first", () => {
    expect([snap("b"), snap(null), snap("a")].sort(byPoolOrder([])).map((s) => s.label)).toEqual(["overall", "a", "b"]);
  });
});
