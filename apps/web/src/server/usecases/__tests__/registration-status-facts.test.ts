// Registration redesign B4 T14 (spec §5.2, §5.3; false premises FP1, FP11): the two derivations behind the status page's
// "what happens next" venue line and its money line, tested pure. The DB-backed half (the real settle paths writing the events
// these read, real fixtures carrying venues) is registration-status-read.test.ts, "dates, venue and how each entry settled".
//
// The expected values come from the WRITERS, never from the functions: each payload below is the exact shape one settle path
// writes to competition_events, cited by file, and the answer is what that path did with the money.
//
//   registration.confirmed {registration_id, entrant_id, paid: true, amount_cents}  checkout-completion.ts  the card webhook, auto division
//   registration.paid_awaiting_approval {registration_id, amount_cents}               checkout-completion.ts  the card webhook, manual division
//   registration.offline_paid {registration_id, amount_cents[, awaiting_approval]}    organiser-actions.ts    Mark paid
//   registration.fee_waived {registration_id, fee_cents}                              organiser-actions.ts    Confirm without payment
//   registration.confirmed {registration_id, paid}                                    organiser-actions.ts    the organiser's Confirm: an
//     approval, never a payment. `paid: true` there means an EARLIER event took the money (a card payment or Mark paid on a manual
//     division), so reading it as "card" would turn a cash payment into a card one the moment the organiser approves it.
//
// Another sport: N/A — registration money and venues are sport-agnostic.
import { describe, expect, it } from "vitest";
import { onlyVenue, settledBy, type SettledBy, type SettlementEvent } from "../registrations/status-facts";

const REG = "11111111-1111-4111-8111-111111111111";

const webhookConfirmed: SettlementEvent = {
  type: "registration.confirmed",
  payload: { registration_id: REG, entrant_id: "e-1", paid: true, amount_cents: 1500 },
};
const webhookAwaitingApproval: SettlementEvent = {
  type: "registration.paid_awaiting_approval",
  payload: { registration_id: REG, amount_cents: 1500 },
};
const markPaid: SettlementEvent = { type: "registration.offline_paid", payload: { registration_id: REG, amount_cents: 1500 } };
const markPaidAwaitingApproval: SettlementEvent = {
  type: "registration.offline_paid",
  payload: { registration_id: REG, amount_cents: 1500, awaiting_approval: true },
};
const waived: SettlementEvent = { type: "registration.fee_waived", payload: { registration_id: REG, fee_cents: 1500 } };
const organiserConfirmPaid: SettlementEvent = { type: "registration.confirmed", payload: { registration_id: REG, paid: true } };
const organiserConfirmFree: SettlementEvent = { type: "registration.confirmed", payload: { registration_id: REG, paid: false } };

type Row = [label: string, events: SettlementEvent[], want: SettledBy | null];

const ROWS: Row[] = [
  // The empty case first: an entry nothing has settled.
  ["no events: nothing settled", [], null],
  ["the card webhook's confirmation (auto division)", [webhookConfirmed], "card"],
  ["the card webhook on a manual division (paid, awaiting approval)", [webhookAwaitingApproval], "card"],
  ["Mark paid", [markPaid], "offline"],
  ["Mark paid on a manual division (awaiting approval)", [markPaidAwaitingApproval], "offline"],
  ["Confirm without payment", [waived], "waived"],
  // The organiser's Confirm on its own: a free entry, or a waitlist override. Nothing was paid or waived.
  ["the organiser's Confirm of a free entry", [organiserConfirmFree], null],
  ["the organiser's Confirm (paid: true) is an approval, not a payment", [organiserConfirmPaid], null],
  // The trap the brief's "latest event among PAID_EVENT_TYPES" walks into: the approval comes LAST.
  ["Mark paid, then the organiser approves it: still offline", [markPaidAwaitingApproval, organiserConfirmPaid], "offline"],
  ["a card payment awaiting approval, then the organiser approves it: still card", [webhookAwaitingApproval, organiserConfirmPaid], "card"],
  // Latest settling event wins, in the order the events were written.
  ["Mark paid, then waived: waived", [markPaid, waived], "waived"],
  ["waived, then Mark paid: offline", [waived, markPaid], "offline"],
  // An event outside the family never settles anything.
  ["an approval event of another type", [{ type: "registration.approved", payload: { registration_id: REG } }], null],
];

describe("settledBy — how an entry's fee was settled, from the events its settle paths write (B4 T14)", () => {
  it("answers each writer's own meaning; the organiser's Confirm never reads as a payment", () => {
    let checked = 0;
    for (const [label, events, want] of ROWS) {
      expect(settledBy(events), label).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(ROWS.length);
    expect(ROWS.length).toBeGreaterThan(0);
  });

  it("covers every settle path's event type at least once (one row per writer)", () => {
    const types = new Set(ROWS.flatMap(([, events]) => events.map((e) => e.type)));
    for (const t of [
      "registration.confirmed",
      "registration.paid_awaiting_approval",
      "registration.offline_paid",
      "registration.fee_waived",
    ]) {
      expect(types.has(t), t).toBe(true);
    }
  });
});

describe("onlyVenue — a venue line only when exactly one venue is named (spec §5.2, FP1)", () => {
  it("null for none, the name for one, null for two", () => {
    const rows: [string, string[], string | null][] = [
      // The empty case first: no fixture carries a venue.
      ["no venue", [], null],
      ["one venue", ["Riverside Sports Hall"], "Riverside Sports Hall"],
      ["two venues (the read stops at two)", ["Riverside Sports Hall", "Beta Arena"], null],
    ];
    let checked = 0;
    for (const [label, names, want] of rows) {
      expect(onlyVenue(names), label).toBe(want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: rows checked").toBe(3);
  });
});
