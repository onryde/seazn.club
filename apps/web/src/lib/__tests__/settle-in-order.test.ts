// `settleEach` / `valuesInOrder` (lib/settle-in-order.ts): run one read per id at once, then answer as a serial loop over the ids
// would have. The register submit (registration-submit.ts, B1 T4) leans on this to keep its refusal precedence while its
// per-division reads run together; this file pins the contract without a database.
//
// The rule (from the submit's serial loop, which these helpers replace): the caller is told the failure of the EARLIEST id in the
// order given, never whichever read happened to fail first in time. Every expected value below is that rule applied by hand to the
// inputs, never read back out of the helpers.
import { describe, expect, it } from "vitest";
import { settleEach, valuesInOrder } from "@/lib/settle-in-order";

/** A read whose outcome the test releases by hand, so settle order is chosen by the test, not by timers. */
function held<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("settleEach + valuesInOrder", () => {
  it("the empty case first: no ids, no reads, an empty map", async () => {
    let reads = 0;
    const pairs = await settleEach([], async () => {
      reads++;
      return 1;
    });
    expect(pairs).toEqual([]);
    expect(reads).toBe(0);
    expect(valuesInOrder(pairs).size).toBe(0);
  });

  it("all fulfilled: every value, keyed by its own id, in the order given (not settle order)", async () => {
    const ids = ["c", "a", "b"];
    const hold = new Map(ids.map((id) => [id, held<string>()]));
    const out = settleEach(ids, (id) => hold.get(id)!.promise);
    // Released in reverse of the given order.
    for (const id of [...ids].reverse()) hold.get(id)!.resolve(`value-${id}`);
    const pairs = await out;
    expect(pairs.map(([id]) => id), "pairs follow the ids, not the settle order").toEqual(ids);
    const values = valuesInOrder(pairs);
    expect([...values.entries()]).toEqual([
      ["c", "value-c"],
      ["a", "value-a"],
      ["b", "value-b"],
    ]);
  });

  it("every read starts before any settles (they run together, not one after another)", async () => {
    const ids = ["x", "y", "z"];
    const started: string[] = [];
    const hold = new Map(ids.map((id) => [id, held<number>()]));
    const out = settleEach(ids, (id) => {
      started.push(id);
      return hold.get(id)!.promise;
    });
    expect(started, "all three reads started while none has settled").toEqual(ids);
    for (const h of hold.values()) h.resolve(0);
    expect(await out).toHaveLength(3);
  });

  it("the earliest rejection in the GIVEN order wins, even when a later id's read fails first", async () => {
    const ids = ["first", "second", "third"];
    const hold = new Map(ids.map((id) => [id, held<number>()]));
    const out = settleEach(ids, (id) => hold.get(id)!.promise);
    const earlyInTime = new Error("third failed first in time");
    const earlyInOrder = new Error("second failed later in time");
    hold.get("third")!.reject(earlyInTime);
    await Promise.resolve();
    hold.get("first")!.resolve(1);
    hold.get("second")!.reject(earlyInOrder);
    const pairs = await out;
    expect(pairs.map(([, r]) => r.status), "every outcome is kept, none is left unhandled").toEqual(["fulfilled", "rejected", "rejected"]);
    expect(() => valuesInOrder(pairs)).toThrow(earlyInOrder);
  });

  it("a second walk over the same pairs answers the same way (no state carried between calls)", async () => {
    const pairs = await settleEach(["p", "q"], async (id) => {
      if (id === "q") throw new Error("q refused");
      return id;
    });
    expect(() => valuesInOrder(pairs)).toThrow("q refused");
    expect(() => valuesInOrder(pairs)).toThrow("q refused");
  });
});
