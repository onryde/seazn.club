// The Registration page's demo model. Its rules are the help pages' (content/help/registration/*.md): a capacity that
// never overfills, an unpaid card entry that holds its spot, a waitlist that pays nothing while it waits, and a
// withdrawal that refunds and promotes the first in line.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REG_DEMO, enter, openingList, payHeld, totals, withdraw, type RegList } from "../registration-demo";

const HERE = dirname(fileURLToPath(import.meta.url));
const statuses = (s: RegList) => s.entries.map((e) => e.status);
const fill = (s: RegList): RegList => {
  let out = s;
  let guard = 0;
  while (totals(out).spotsLeft > 0 && guard++ < 50) out = enter(out, "card");
  return out;
};

describe("registration demo", () => {
  it("opens with spots left, someone paid and someone still to pay — every tile has something to show", () => {
    const o = totals(openingList());
    expect(o.spotsLeft).toBeGreaterThan(0);
    expect(o.paid).toBeGreaterThan(0);
    expect(o.held).toBeGreaterThan(0);
    expect(o.waiting).toBe(0);
    expect(o.collectedMinor).toBe(o.paid * REG_DEMO.feeMinor);
  });

  it("paying by card confirms the entry and moves the money; leaving unpaid holds the spot and moves none", () => {
    const start = openingList();
    const paid = enter(start, "card");
    expect(statuses(paid).at(-1)).toBe("paid");
    expect(totals(paid).collectedMinor).toBe(totals(start).collectedMinor + REG_DEMO.feeMinor);
    expect(paid.last).toEqual({ type: "paid", name: paid.entries.at(-1)!.name });
    const held = enter(start, "leave");
    expect(statuses(held).at(-1)).toBe("held");
    expect(totals(held).collectedMinor).toBe(totals(start).collectedMinor);
    // Both take the spot: a held entry is not a free place.
    expect(totals(paid).spotsLeft).toBe(totals(start).spotsLeft - 1);
    expect(totals(held).spotsLeft).toBe(totals(start).spotsLeft - 1);
  });

  it("a full division never overfills: the next entry waits, and pays nothing, however they tried to enter", () => {
    const full = fill(openingList());
    expect(totals(full).spotsLeft).toBe(0);
    for (const how of ["card", "leave"] as const) {
      const next = enter(full, how);
      expect(statuses(next).at(-1), how).toBe("waitlisted");
      expect(totals(next).collectedMinor, how).toBe(totals(full).collectedMinor);
      expect(totals(next).spotsLeft, how).toBe(0);
      expect(totals(next).waiting, how).toBe(1);
      expect(next.last?.type, how).toBe("waitlisted");
    }
  });

  it("a held entry that pays is confirmed; paying a row that is not held changes nothing", () => {
    const start = openingList();
    const i = start.entries.findIndex((e) => e.status === "held");
    const after = payHeld(start, i);
    expect(after.entries[i]!.status).toBe("paid");
    expect(totals(after).collectedMinor).toBe(totals(start).collectedMinor + REG_DEMO.feeMinor);
    const paidRow = start.entries.findIndex((e) => e.status === "paid");
    expect(payHeld(start, paidRow)).toBe(start);
    expect(payHeld(start, 99)).toBe(start);
  });

  it("a withdrawal refunds in full and offers the place to the FIRST in line, who has not paid yet", () => {
    let s = enter(enter(fill(openingList()), "card"), "card");
    expect(totals(s).waiting).toBe(2);
    const firstWaiting = s.entries.findIndex((e) => e.status === "waitlisted");
    const before = totals(s);
    const i = s.entries.findIndex((e) => e.status === "paid");
    s = withdraw(s, i);
    expect(s.entries[i]!.status).toBe("refunded");
    expect(s.entries[firstWaiting]!.status).toBe("held");
    const after = totals(s);
    expect(after.collectedMinor).toBe(before.collectedMinor - REG_DEMO.feeMinor);
    expect(after.waiting).toBe(1);
    expect(after.spotsLeft).toBe(0);
    expect(s.last).toEqual({ type: "promoted", name: s.entries[firstWaiting]!.name });
    // With nobody waiting, the place simply opens.
    const open = withdraw(openingList(), openingList().entries.findIndex((e) => e.status === "paid"));
    expect(totals(open).spotsLeft).toBe(totals(openingList()).spotsLeft + 1);
    expect(open.last?.type).toBe("refunded");
    // Only a paid entry withdraws here.
    const heldRow = openingList().entries.findIndex((e) => e.status === "held");
    const same = openingList();
    expect(withdraw(same, heldRow)).toBe(same);
  });

  it("the demo runs out of players rather than inventing them, and never mutates the list it was given", () => {
    const start = openingList();
    const frozen = JSON.stringify(start);
    let s = start;
    for (let n = 0; n < 40; n++) s = enter(s, "card");
    expect(s.entries.length).toBe(start.entries.length + REG_DEMO.queue.length);
    expect(new Set(s.entries.map((e) => e.name)).size).toBe(s.entries.length);
    expect(enter(s, "card")).toBe(s);
    expect(JSON.stringify(start)).toBe(frozen);
  });

  it("the hold the demo quotes is the product's own: the 48-hour pay window the checkout writes", () => {
    const sql = readFileSync(join(HERE, "../../../server/usecases/registration-submit.ts"), "utf8");
    const hours = [...sql.matchAll(/interval '(\d+) hours'/g)].map((m) => Number(m[1]));
    expect(hours.length).toBeGreaterThan(0);
    expect(hours).toContain(REG_DEMO.holdHours);
  });
});
