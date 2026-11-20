// The Sponsoring page's demo walks a table of deal states built from the PRODUCT's own deal rules (lib/sponsor-deals.ts).
// Expected paths here are the ones the help page promises (content/help/sharing/sponsor-deals.md), never read back
// from the builder under test.
import { describe, expect, it } from "vitest";
import { buildDealTable, type DemoNode, type DemoStep } from "../sponsor-deal-table";

const T = buildDealTable();
const walk = (key: string, steps: DemoStep[]): DemoNode => {
  const flow = T.flows[key]!;
  return steps.reduce<DemoNode>((node, step) => {
    const next = flow.edges[node]?.[step];
    if (!next) throw new Error(`${key}: "${step}" is not offered at ${node}`);
    return next;
  }, flow.start);
};
const statusOf = (n: DemoNode) => n.split("|")[0];

describe("sponsor deal table", () => {
  it("covers every payment method with the go-live rules the product offers it", () => {
    expect(T.methods).toEqual(["online", "offline", "complimentary"]);
    expect(T.rules.online).toEqual(["on_payment", "immediate", "on_approval"]);
    expect(T.rules.offline).toEqual(["on_payment", "immediate", "on_approval"]);
    // "When paid" is not offered for a deal with no payment.
    expect(T.rules.complimentary).toEqual(["immediate", "on_approval"]);
    expect(Object.keys(T.flows).sort()).toEqual(T.methods.flatMap((m) => T.rules[m].map((r) => `${m}|${r}`)).sort());
    expect(Object.keys(T.flows)).toHaveLength(8);
  });

  it("online invoice, live when paid: the invoice goes out, the sponsor pays, the deal is live", () => {
    expect(statusOf(T.flows["online|on_payment"]!.start)).toBe("draft");
    expect(statusOf(walk("online|on_payment", ["send_invoice"]))).toBe("awaiting_payment");
    expect(walk("online|on_payment", ["send_invoice", "pay"])).toBe("live|paid");
    // No paying before the invoice exists.
    expect(() => walk("online|on_payment", ["pay"])).toThrow(/not offered/);
  });

  it("offline, live when paid: it waits for the club to mark it paid", () => {
    expect(T.flows["offline|on_payment"]!.start).toBe("awaiting_payment|due");
    expect(walk("offline|on_payment", ["pay"])).toBe("live|paid");
    expect(() => walk("offline|on_payment", ["approve"])).toThrow(/not offered/);
  });

  it("after I approve: payment alone never puts the sponsor live", () => {
    let checked = 0;
    for (const [key, toPaid] of [["online|on_approval", ["send_invoice", "pay"]], ["offline|on_approval", ["pay"]]] as const) {
      const paid = walk(key, [...toPaid]);
      expect(paid, key).toBe("awaiting_approval|paid");
      expect(walk(key, [...toPaid, "approve"]), key).toBe("live|paid");
      checked++;
    }
    expect(checked).toBe(2);
    expect(T.flows["complimentary|on_approval"]!.start).toBe("awaiting_approval|free");
    expect(walk("complimentary|on_approval", ["approve"])).toBe("live|free");
  });

  it("straight away: live from the start on every method, and an unpaid one can still be paid without leaving live", () => {
    expect(T.flows["online|immediate"]!.start).toBe("live|due");
    expect(T.flows["offline|immediate"]!.start).toBe("live|due");
    expect(T.flows["complimentary|immediate"]!.start).toBe("live|free");
    expect(walk("offline|immediate", ["pay"])).toBe("live|paid");
    expect(() => walk("complimentary|immediate", ["pay"])).toThrow(/not offered/);
  });

  it("every state before the end can be ended, the end offers nothing, and every edge lands on a known state", () => {
    let nodes = 0;
    for (const [key, flow] of Object.entries(T.flows)) {
      const known = new Set(Object.keys(flow.edges));
      expect(known.has(flow.start), key).toBe(true);
      for (const [node, steps] of Object.entries(flow.edges)) {
        nodes++;
        if (statusOf(node as DemoNode) === "ended") expect(steps, `${key} ${node}`).toEqual({});
        else expect(statusOf(steps.end!), `${key} ${node}`).toBe("ended");
        for (const to of Object.values(steps)) expect(known.has(to!), `${key} ${node} -> ${to}`).toBe(true);
      }
      // Reachable: some path through the offered steps reaches live.
      expect([...known].some((n) => statusOf(n as DemoNode) === "live"), key).toBe(true);
    }
    expect(nodes).toBeGreaterThanOrEqual(8 * 2);
  });
});
